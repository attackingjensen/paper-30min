//! 模型流式调用：OpenAI 兼容端点规范化、HTTP 客户端、SSE 解析与连接测试。
//! 语义移植自浏览器端 public/js/api.js（endpoint / readError / chat / testConnection），
//! 只移植语义，不搬运 JS 代码结构。

use reqwest::blocking::{Client, Response};
use reqwest::Url;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::error::BridgeError;
use crate::library::Library;
use crate::tasks::{run_with_retry_while, Progress, RunContext};

/// 浏览器 UA：与 server.py 转发时使用的字符串一致，
/// 部分中转站按 UA/TLS 指纹拦截非浏览器客户端。
pub(crate) const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 连接超时（各任务共用）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// chat 请求总超时。reqwest blocking 没有按读超时（read timeout），只能给整个请求
/// 一个总超时：慢速但持续输出的流不会被中途掐断，只能靠取消终止。
const CHAT_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
/// testConnection 第一段 /models 的总超时。
const TEST_MODELS_TIMEOUT: Duration = Duration::from_secs(15);
/// testConnection 退路 chat/completions 的总超时。
const TEST_CHAT_TIMEOUT: Duration = Duration::from_secs(20);

/// 流式读缓冲块大小；块间做取消检查。
pub(crate) const READ_CHUNK: usize = 8 * 1024;

/// 移植 api.js endpoint()：裸域名补 /v1；结尾是 /chat/completions 或 /models 时剥掉该段；
/// dashscope 系列域名（含 dashscope-intl、dashscope-cn-beijing 等多段区域域名）且路径
/// 不以 /compatible-mode 开头时改写为 /compatible-mode/v1。
pub fn normalize_endpoint(base_url: &str, path: &str) -> Result<String, BridgeError> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return Err(BridgeError::invalid_input("API Base URL 不能为空"));
    }
    let mut url = Url::parse(raw).map_err(|_| {
        BridgeError::invalid_input("API Base URL 格式无效，请填写以 http:// 或 https:// 开头的完整地址")
    })?;

    // 阿里云百炼（DashScope）的 OpenAI 兼容接口在 /compatible-mode/v1，裸域名或
    // 文档里的原生 API 地址都走不通，统一改写以便用户直接粘贴控制台地址。
    if is_dashscope_host(url.host_str().unwrap_or(""))
        && !path_starts_with_compatible_mode(url.path())
    {
        url.set_path("/compatible-mode/v1");
    }

    let target = path.trim_start_matches('/');
    let mut pathname = url.path().trim_end_matches('/').to_string();

    // 兼容中转站常见的三种写法：域名、/v1、完整 chat/completions 地址。
    let lower = pathname.to_ascii_lowercase();
    if lower.ends_with("/chat/completions") {
        pathname.truncate(pathname.len() - "/chat/completions".len());
    } else if lower.ends_with("/models") {
        pathname.truncate(pathname.len() - "/models".len());
    } else if pathname.is_empty() {
        pathname = "/v1".to_string();
    }

    let joined = collapse_slashes(&format!("{pathname}/{target}"));
    url.set_path(&joined);
    Ok(url.to_string())
}

/// 对应 api.js 的 /^dashscope(-[\w-]+)?\.aliyuncs\.com$/i。
fn is_dashscope_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let Some(rest) = host.strip_suffix(".aliyuncs.com") else {
        return false;
    };
    if rest == "dashscope" {
        return true;
    }
    let Some(suffix) = rest.strip_prefix("dashscope-") else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// 对应 api.js 的 /^\/compatible-mode(\/|$)/i。
fn path_starts_with_compatible_mode(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("/compatible-mode") else {
        return false;
    };
    rest.is_empty() || rest.starts_with('/')
}

/// 压缩重复斜杠，对应 api.js 的 replace(/\/{2,}/g, '/')。
fn collapse_slashes(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev_slash = false;
    for ch in value.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push(ch);
            }
            prev_slash = true;
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    out
}

/// 构造带浏览器 UA 的阻塞客户端；连接超时 20s，总超时由调用方按任务给出。
pub(crate) fn http_client(total_timeout: Duration) -> Result<Client, BridgeError> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total_timeout)
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|err| BridgeError::internal(format!("HTTP 客户端初始化失败: {err}")))
}

/// 从 settings 表读取的模型连接配置。
/// temperature/maxTokens 不在此承载：它们的优先级解析（任务输入 > settings 存储 >
/// 内置缺省 0.3/4096）在 tasks.rs 的 plan_model_chat 完成，chat 请求体直接用解析结果。
pub(crate) struct ModelConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 读取模型设置；baseUrl/apiKey/model 任一缺失视为未配置（Ok(None)）。
pub(crate) fn load_model_config(library: &Library) -> Result<Option<ModelConfig>, BridgeError> {
    let Some(text) = library.get_setting("model")? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let (base_url, api_key, model) = (string("baseUrl"), string("apiKey"), string("model"));
    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Ok(None);
    }
    Ok(Some(ModelConfig {
        base_url,
        api_key,
        model,
    }))
}

pub(crate) fn model_not_configured() -> BridgeError {
    BridgeError::new(
        "model_not_configured",
        "尚未配置模型：请在设置中填写 API Base URL、API Key 与模型名称。",
        false,
    )
}

/// 移植 api.js readError()：HTTP 状态 → 统一错误。
/// 401/403 → 不可重试（403 且体含 "error code: 1010" 或 cloudflare → Cloudflare 专用文案）；
/// 404 → 不可重试，model 域附 /compatible-mode/v1 提示；408/429/5xx → 可重试；其他 4xx → 不可重试。
/// message 含 HTTP 状态与上游 error.message 摘录（≤300 字符）。
pub(crate) fn http_status_error(code: &str, status: u16, body: &str, model_endpoint_hint: bool) -> BridgeError {
    let detail = extract_upstream_message(body);
    if status == 403 && is_cloudflare_block(&detail) {
        return BridgeError::new(
            code,
            "中转站的 Cloudflare 拒绝了请求（HTTP 403 / 1010）。请重启本应用后重试；\
             若仍失败，需让中转站解除当前 IP 或 API 客户端限制。",
            false,
        )
        .with_details(json!({ "httpStatus": status }));
    }
    let hint = if status == 404 && model_endpoint_hint {
        "（该地址不存在，请检查 Base URL 是否为 OpenAI 兼容端点，阿里云百炼需以 /compatible-mode/v1 结尾）"
    } else {
        ""
    };
    let retryable = matches!(status, 408 | 429) || status >= 500;
    let excerpt = truncate_chars(detail.trim(), 300);
    let message = if excerpt.is_empty() {
        format!("API 请求失败（HTTP {status}）{hint}")
    } else {
        format!("API 请求失败（HTTP {status}）：{excerpt}{hint}")
    };
    BridgeError::new(code, message, retryable).with_details(json!({ "httpStatus": status }))
}

/// 连接失败、超时等网络层错误统一映射为可重试错误。
pub(crate) fn network_error(code: &str, err: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(code, format!("网络请求失败: {err}"), true)
}

/// 读取错误响应体摘录（上限 64KB），只用于错误消息。
pub(crate) fn read_body_snippet(response: Response) -> String {
    let mut limited = response.take(64 * 1024);
    let mut buf = Vec::new();
    let _ = limited.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// 优先取上游 JSON 的 error.message，否则用响应原文。
fn extract_upstream_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return message.to_string();
        }
    }
    body.to_string()
}

/// 对应 api.js 的 /error code:\s*1010|cloudflare/i。
fn is_cloudflare_block(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("cloudflare") {
        return true;
    }
    let mut rest = lower.as_str();
    while let Some(pos) = rest.find("error code:") {
        let after = &rest[pos + "error code:".len()..];
        if after.trim_start().starts_with("1010") {
            return true;
        }
        rest = after;
    }
    false
}

/// 按字符截断（不做字节级切割，避免截断多字节字符）。
fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// model.chat@1：从 settings 读模型配置，POST chat/completions；
/// SSE 增量逐块发 chunk（chunk=增量本身，不累积），非流式发单个 chunk。不带 result。
/// 自动重试只在「尚未发出任何内容 chunk」时允许：一旦已产出 chunk，重发请求会把
/// 已发出的增量再推一遍，前端按到达顺序拼接即出现重复前缀；此后失败直接 failed
///（错误保留 retryable，UI 手动重试是新任务，从干净状态开始）。
pub(crate) fn run_chat(
    ctx: &RunContext,
    messages: &[Value],
    temperature: f64,
    max_tokens: u64,
    stream: bool,
) {
    let config = match load_model_config(&ctx.library) {
        Ok(Some(config)) => config,
        Ok(None) => return ctx.fail(model_not_configured()),
        Err(error) => return ctx.fail(error),
    };
    let endpoint = match normalize_endpoint(&config.base_url, "/chat/completions") {
        Ok(endpoint) => endpoint,
        Err(error) => return ctx.fail(error),
    };
    let body = json!({
        "model": config.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    });
    // 本次任务是否已向事件流发出内容 chunk；跨尝试共享，供重试门槛判断。
    let chunk_emitted = Arc::new(AtomicBool::new(false));
    let emitted = Arc::clone(&chunk_emitted);
    let outcome = run_with_retry_while(
        ctx,
        |ctx| chat_once(ctx, &config, &endpoint, &body, &emitted),
        || !chunk_emitted.load(Ordering::SeqCst),
    );
    if outcome.is_ok() {
        ctx.succeed(None);
    }
}

fn chat_once(
    ctx: &RunContext,
    config: &ModelConfig,
    endpoint: &str,
    body: &Value,
    chunk_emitted: &AtomicBool,
) -> Result<(), BridgeError> {
    ctx.cancel_checkpoint()?;
    let client = http_client(CHAT_TOTAL_TIMEOUT)?;
    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string())
        .send()
        .map_err(|err| network_error("model_network_error", err))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let snippet = read_body_snippet(response);
        return Err(http_status_error("model_http_error", status, &snippet, true));
    }
    let is_event_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|content_type| content_type.contains("event-stream"))
        .unwrap_or(false);
    let stream_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if !stream_requested || !is_event_stream {
        // api.js 回退语义：非流式请求或上游未按 SSE 返回时按整段 JSON 处理。
        let bytes = response
            .bytes()
            .map_err(|err| network_error("model_network_error", err))?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|err| {
            BridgeError::new("model_http_error", format!("响应 JSON 解析失败: {err}"), false)
        })?;
        let text = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("");
        chunk_emitted.store(true, Ordering::SeqCst);
        ctx.push_chunk(Progress { done: 1, total: 1 }, text.to_string());
        return Ok(());
    }
    read_sse(ctx, response, chunk_emitted)
}

/// SSE 流式读取：按 8KB 块读，块间检查取消；按 \n 在字节层切行（UTF-8 安全），
/// 每个非空增量发一个 chunk。finish_reason 非 stop/end_turn 不报错（api.js 只警告）。
/// 发出第一个 chunk 时置 chunk_emitted，此后本次任务失败不再自动重试。
fn read_sse(
    ctx: &RunContext,
    mut response: Response,
    chunk_emitted: &AtomicBool,
) -> Result<(), BridgeError> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk_count: u64 = 0;
    let mut done = false;
    let mut buf = [0_u8; READ_CHUNK];
    while !done {
        ctx.cancel_checkpoint()?;
        let read = response
            .read(&mut buf)
            .map_err(|err| network_error("model_network_error", err))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&buf[..read]);
        // 按 \n 在字节层切行；不完整的最后一行留在缓冲里等下一块。
        while let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(delta) = sse_delta(&line, &mut done) {
                chunk_count += 1;
                chunk_emitted.store(true, Ordering::SeqCst);
                ctx.push_chunk(
                    Progress {
                        done: chunk_count,
                        total: 0,
                    },
                    delta,
                );
            }
            if done {
                break;
            }
        }
    }
    if !done && !buffer.is_empty() {
        // 流结束但缓冲里还有未换行的尾巴，也处理掉（api.js decoder flush 语义）。
        let tail = String::from_utf8_lossy(&buffer).into_owned();
        for line in tail.split('\n') {
            if let Some(delta) = sse_delta(line, &mut done) {
                chunk_count += 1;
                chunk_emitted.store(true, Ordering::SeqCst);
                ctx.push_chunk(
                    Progress {
                        done: chunk_count,
                        total: 0,
                    },
                    delta,
                );
            }
        }
    }
    Ok(())
}

/// 处理一行 SSE：非 data: 行忽略；[DONE] 置结束；JSON 解析失败的行忽略。
/// 增量取 choices[0].delta.content（回退 choices[0].message.content），非空才返回。
fn sse_delta(line: &str, done: &mut bool) -> Option<String> {
    let trimmed = line.trim();
    let payload = trimmed.strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        *done = true;
        return None;
    }
    let value: Value = serde_json::from_str(payload).ok()?;
    let choice = value.get("choices")?.as_array()?.first()?;
    let delta = choice
        .get("delta")
        .and_then(|delta| delta.get("content"))
        .and_then(Value::as_str)
        .or_else(|| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    if delta.is_empty() {
        None
    } else {
        Some(delta.to_string())
    }
}

/// model.test@1：移植 api.js testConnection 两段流程（不重试，单次尝试）。
/// 先 GET /models，任何原因失败则退到最小 chat/completions 请求。
pub(crate) fn run_test(ctx: &RunContext) {
    let config = match load_model_config(&ctx.library) {
        Ok(Some(config)) => config,
        Ok(None) => return ctx.fail(model_not_configured()),
        Err(error) => return ctx.fail(error),
    };
    let models_endpoint = match normalize_endpoint(&config.base_url, "/models") {
        Ok(endpoint) => endpoint,
        Err(error) => return ctx.fail(error),
    };
    if let Ok(message) = test_models(ctx, &config, &models_endpoint) {
        return ctx.succeed(Some(json!({ "message": message })));
    }
    // /models 请求失败（任何原因）→ 退路：发一条最小对话请求。
    if ctx.cancel_checkpoint().is_err() {
        return ctx.cancel_now();
    }
    let chat_endpoint = match normalize_endpoint(&config.base_url, "/chat/completions") {
        Ok(endpoint) => endpoint,
        Err(error) => return ctx.fail(error),
    };
    match test_chat(ctx, &config, &chat_endpoint) {
        Ok(()) => ctx.succeed(Some(json!({ "message": "✅ 连接成功" }))),
        Err(error) => ctx.fail(error),
    }
}

/// 第一段：GET {endpoint}/models（总超时 15s）。成功时返回给用户的消息。
fn test_models(ctx: &RunContext, config: &ModelConfig, endpoint: &str) -> Result<String, BridgeError> {
    ctx.cancel_checkpoint()?;
    let client = http_client(TEST_MODELS_TIMEOUT)?;
    let response = client
        .get(endpoint)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Accept", "application/json, text/event-stream")
        .send()
        .map_err(|err| network_error("model_network_error", err))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .map_err(|err| network_error("model_network_error", err))?;
    if !(200..300).contains(&status) {
        let snippet = String::from_utf8_lossy(&bytes).into_owned();
        return Err(http_status_error("model_http_error", status, &snippet, true));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|err| {
        BridgeError::new("model_http_error", format!("模型列表 JSON 解析失败: {err}"), false)
    })?;
    let models: Vec<String> = value
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if models.iter().any(|id| id == &config.model) {
        Ok(format!("✅ 连接成功，已找到模型「{}」", config.model))
    } else {
        let available = models
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let available = if available.is_empty() {
            "（空）".to_string()
        } else {
            available
        };
        Ok(format!(
            "⚠️ 连接成功，但模型列表中未找到「{}」。可用模型：{available}",
            config.model
        ))
    }
}

/// 第二段退路：POST chat/completions 最小请求（max_tokens=1，总超时 20s）。
fn test_chat(ctx: &RunContext, config: &ModelConfig, endpoint: &str) -> Result<(), BridgeError> {
    ctx.cancel_checkpoint()?;
    let client = http_client(TEST_CHAT_TIMEOUT)?;
    let body = json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });
    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string())
        .send()
        .map_err(|err| network_error("model_network_error", err))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let snippet = read_body_snippet(response);
        return Err(http_status_error("model_http_error", status, &snippet, true));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(base: &str, path: &str) -> String {
        normalize_endpoint(base, path).expect("端点规范化")
    }

    #[test]
    fn bare_domain_gets_v1_prefix() {
        assert_eq!(
            endpoint("https://api.example.com", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://api.example.com/", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn v1_path_is_kept() {
        assert_eq!(
            endpoint("https://api.example.com/v1", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://api.example.com/v1/", "/models"),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn full_chat_completions_address_is_stripped() {
        assert_eq!(
            endpoint("https://api.example.com/v1/chat/completions", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://api.example.com/v1/chat/completions", "/models"),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn models_suffix_is_stripped() {
        assert_eq!(
            endpoint("https://api.example.com/v1/models", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn dashscope_host_is_rewritten_to_compatible_mode() {
        assert_eq!(
            endpoint("https://dashscope.aliyuncs.com", "/chat/completions"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        // 原生 API 地址也统一改写。
        assert_eq!(
            endpoint("https://dashscope.aliyuncs.com/api/v1", "/chat/completions"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
    }

    #[test]
    fn dashscope_regional_hosts_are_rewritten() {
        for host in [
            "dashscope-intl.aliyuncs.com",
            "dashscope-vpc.aliyuncs.com",
            "dashscope-cn-beijing.aliyuncs.com",
        ] {
            let url = format!("https://{host}");
            assert_eq!(
                endpoint(&url, "/models"),
                format!("https://{host}/compatible-mode/v1/models"),
                "host={host}"
            );
        }
        // 大小写不敏感。
        assert_eq!(
            endpoint("https://DashScope.AliYuncs.com", "/models"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        // 已是 compatible-mode 路径时不重复改写。
        assert_eq!(
            endpoint("https://dashscope.aliyuncs.com/compatible-mode/v1", "/models"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        // 只是前缀相似的域名不改写。
        assert_eq!(
            endpoint("https://dashscope.aliyuncs.com.evil.example.com", "/models"),
            "https://dashscope.aliyuncs.com.evil.example.com/v1/models"
        );
    }

    #[test]
    fn duplicate_slashes_are_collapsed() {
        assert_eq!(
            endpoint("https://api.example.com//v1//", "/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn invalid_base_url_is_invalid_input() {
        let error = normalize_endpoint("not a url", "/chat/completions").unwrap_err();
        assert_eq!(error.code, "invalid_input");
        assert!(!error.retryable);
        let error = normalize_endpoint("  ", "/chat/completions").unwrap_err();
        assert_eq!(error.code, "invalid_input");
    }
}
