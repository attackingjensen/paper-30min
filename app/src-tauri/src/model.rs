//! 模型流式调用：OpenAI 兼容端点规范化、HTTP 客户端、SSE 解析与连接测试。
//! 语义移植自浏览器端 public/js/api.js（endpoint / readError / chat / testConnection），
//! 只移植语义，不搬运 JS 代码结构。

use reqwest::blocking::{Client, Response};
use reqwest::Url;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

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
/// 供 net.rs 等非模型路径使用；模型调用走 [`shared_http_client`] 以便跨轮复用连接。
pub(crate) fn http_client(total_timeout: Duration) -> Result<Client, BridgeError> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total_timeout)
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|err| BridgeError::internal(format!("HTTP 客户端初始化失败: {err}")))
}

/// 进程级共享客户端：无总超时（按请求设置 600/15/20 s），跨协议轮与 chat/test 复用连接。
pub(crate) fn shared_http_client() -> Result<&'static Client, BridgeError> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .pool_max_idle_per_host(4)
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|err| BridgeError::internal(format!("HTTP 客户端初始化失败: {err}")))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// 一轮 chat 的 usage；端点不返回的字段保持缺省。
#[derive(Debug, Clone, Default)]
pub(crate) struct TokenUsage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

impl TokenUsage {
    fn from_value(value: &Value) -> Self {
        let Some(usage) = value.get("usage") else {
            return Self::default();
        };
        Self {
            prompt_tokens: int_field(usage, "prompt_tokens"),
            completion_tokens: int_field(usage, "completion_tokens"),
            cached_tokens: usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(json_u64),
            reasoning_tokens: usage
                .pointer("/completion_tokens_details/reasoning_tokens")
                .and_then(json_u64),
        }
    }

    fn merge(&mut self, other: Self) {
        if other.prompt_tokens.is_some() {
            self.prompt_tokens = other.prompt_tokens;
        }
        if other.completion_tokens.is_some() {
            self.completion_tokens = other.completion_tokens;
        }
        if other.cached_tokens.is_some() {
            self.cached_tokens = other.cached_tokens;
        }
        if other.reasoning_tokens.is_some() {
            self.reasoning_tokens = other.reasoning_tokens;
        }
    }

    fn is_empty(&self) -> bool {
        self.prompt_tokens.is_none()
            && self.completion_tokens.is_none()
            && self.cached_tokens.is_none()
            && self.reasoning_tokens.is_none()
    }

    pub(crate) fn to_json(&self) -> Option<Value> {
        if self.is_empty() {
            return None;
        }
        let mut map = Map::new();
        if let Some(value) = self.prompt_tokens {
            map.insert("promptTokens".into(), json!(value));
        }
        if let Some(value) = self.completion_tokens {
            map.insert("completionTokens".into(), json!(value));
        }
        if let Some(value) = self.cached_tokens {
            map.insert("cachedTokens".into(), json!(value));
        }
        if let Some(value) = self.reasoning_tokens {
            map.insert("reasoningTokens".into(), json!(value));
        }
        Some(Value::Object(map))
    }
}

fn int_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(json_u64)
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_f64().and_then(|n| (n >= 0.0).then_some(n as u64)))
}

/// 一轮 chat/completions 的收集结果（协议轮与 model.chat 共用）。
#[derive(Debug, Clone)]
pub(crate) struct ChatCompletion {
    pub text: String,
    pub finish_reason: Option<String>,
    pub usage: TokenUsage,
    pub ttft_ms: u64,
    pub elapsed_ms: u64,
    pub reasoning_ms: Option<u64>,
}

impl ChatCompletion {
    pub(crate) fn to_chat_result(&self) -> Value {
        let mut map = Map::new();
        map.insert("ttftMs".into(), json!(self.ttft_ms));
        map.insert("elapsedMs".into(), json!(self.elapsed_ms));
        if let Some(ms) = self.reasoning_ms {
            map.insert("reasoningMs".into(), json!(ms));
        }
        if let Some(usage) = self.usage.to_json() {
            map.insert("usage".into(), usage);
        }
        Value::Object(map)
    }
}

/// 可按阶段覆盖的模型调用阶段（设置键与 `model.chat@1` 的 `stage` 共用）。
pub(crate) const MODEL_STAGES: [&str; 5] = ["map-l2", "map-l1", "deep-dive", "synthesize", "qa"];
const PROTECTED_BODY_KEYS: [&str; 3] = ["model", "messages", "stream"];
const THINKING_HEARTBEAT: Duration = Duration::from_secs(1);

/// 组装 chat 请求体。流式时附 `stream_options.include_usage`（OpenAI 兼容端点在
/// `stream: false` 时拒收该字段，故非流式不加）。temperature 为 None 时不携带该键
///（#86：留空 = 用端点默认）。随后按
/// 内建阶段默认 → extraBody → stageExtraBody[stage] 浅合并；`null` 删键。
#[allow(clippy::too_many_arguments)]
pub(crate) fn chat_request_body(
    model: &str,
    messages: &[Value],
    temperature: Option<f64>,
    max_tokens: u64,
    stream: bool,
    stage: Option<&str>,
    extra_body: &Map<String, Value>,
    stage_extra_body: &Map<String, Value>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": stream,
    });
    if let Some(temperature) = temperature {
        body["temperature"] = json!(temperature);
    }
    if stream {
        body["stream_options"] = json!({ "include_usage": true });
    }
    apply_stage_extras(
        &mut body,
        stage,
        extra_body,
        stage.and_then(|key| stage_extra_body.get(key)).and_then(Value::as_object),
    );
    body
}

fn builtin_stage_extra(stage: Option<&str>) -> Map<String, Value> {
    let mut extra = Map::new();
    match stage {
        Some("map-l2" | "map-l1" | "deep-dive" | "synthesize") => {
            extra.insert("enable_thinking".into(), json!(false));
        }
        Some("qa") => {
            extra.insert("enable_thinking".into(), json!(true));
        }
        _ => {}
    }
    extra
}

fn apply_overlay(target: &mut Map<String, Value>, overlay: &Map<String, Value>) {
    for (key, value) in overlay {
        if PROTECTED_BODY_KEYS.contains(&key.as_str()) {
            continue;
        }
        if value.is_null() {
            target.remove(key);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn apply_stage_extras(
    body: &mut Value,
    stage: Option<&str>,
    extra_body: &Map<String, Value>,
    stage_extra: Option<&Map<String, Value>>,
) {
    let Some(map) = body.as_object_mut() else {
        return;
    };
    apply_overlay(map, &builtin_stage_extra(stage));
    apply_overlay(map, extra_body);
    if let Some(layer) = stage_extra {
        apply_overlay(map, layer);
    }
}

pub(crate) struct RequestExtras {
    pub extra_body: Map<String, Value>,
    pub stage_extra_body: Map<String, Value>,
    pub stage_models: Map<String, Value>,
}

pub(crate) fn load_request_extras(library: &Library) -> RequestExtras {
    let stored = library
        .get_setting("model")
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let object = |key: &str| {
        stored
            .as_ref()
            .and_then(|value| value.get(key))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    RequestExtras {
        extra_body: object("extraBody"),
        stage_extra_body: object("stageExtraBody"),
        stage_models: object("stageModels"),
    }
}

pub(crate) fn model_name_for(
    stage: Option<&str>,
    stage_models: &Map<String, Value>,
    fallback: &str,
) -> String {
    stage
        .and_then(|key| stage_models.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub(crate) fn is_model_stage(value: &str) -> bool {
    MODEL_STAGES.contains(&value)
}

pub(crate) fn parse_chat_stage(value: Option<&Value>) -> Result<Option<String>, BridgeError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(stage)) if is_model_stage(stage) => Ok(Some(stage.clone())),
        _ => Err(BridgeError::invalid_input(
            "stage 必须是 map-l2 / map-l1 / deep-dive / synthesize / qa",
        )),
    }
}

pub(crate) fn validate_stage_models(value: &Value) -> Result<Value, BridgeError> {
    let object = value
        .as_object()
        .ok_or_else(|| BridgeError::invalid_input("stageModels 必须是对象"))?;
    let mut cleaned = Map::new();
    for (key, item) in object {
        if !is_model_stage(key) {
            continue;
        }
        let name = item
            .as_str()
            .map(str::trim)
            .ok_or_else(|| BridgeError::invalid_input("阶段模型名必须是非空字符串"))?;
        if name.is_empty() {
            return Err(BridgeError::invalid_input("阶段模型名必须是非空字符串"));
        }
        cleaned.insert(key.clone(), json!(name));
    }
    Ok(Value::Object(cleaned))
}

pub(crate) fn validate_extra_body(value: &Value) -> Result<Value, BridgeError> {
    if value.as_object().is_none() {
        return Err(BridgeError::invalid_input("extraBody 必须是 JSON 对象"));
    }
    Ok(value.clone())
}

pub(crate) fn validate_stage_extra_body(value: &Value) -> Result<Value, BridgeError> {
    let object = value
        .as_object()
        .ok_or_else(|| BridgeError::invalid_input("stageExtraBody 必须是对象"))?;
    let mut cleaned = Map::new();
    for (key, item) in object {
        if !is_model_stage(key) {
            continue;
        }
        if !item.is_object() {
            return Err(BridgeError::invalid_input(
                "阶段附加参数必须是 JSON 对象",
            ));
        }
        cleaned.insert(key.clone(), item.clone());
    }
    Ok(Value::Object(cleaned))
}

/// POST chat/completions：共享客户端 + 按请求超时；SSE 抽增量与 usage（含 `choices: []`）。
pub(crate) fn chat_completions<D, C, T>(
    api_key: &str,
    endpoint: &str,
    body: &Value,
    timeout: Duration,
    mut on_delta: D,
    between_reads: C,
    on_thinking: T,
) -> Result<ChatCompletion, BridgeError>
where
    D: FnMut(&str) -> Result<(), BridgeError>,
    C: FnMut() -> Result<(), BridgeError>,
    T: FnMut(u64, u64) -> Result<(), BridgeError> + Send,
{
    let started = Instant::now();
    let client = shared_http_client()?;
    let response = client
        .post(endpoint)
        .timeout(timeout)
        .header("Authorization", format!("Bearer {api_key}"))
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
        let bytes = response
            .bytes()
            .map_err(|err| network_error("model_network_error", err))?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|err| {
            BridgeError::new("model_http_error", format!("响应 JSON 解析失败: {err}"), false)
        })?;
        let choice = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first());
        let text = choice
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let finish_reason = choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if !text.is_empty() {
            on_delta(&text)?;
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(ChatCompletion {
            text,
            finish_reason,
            usage: TokenUsage::from_value(&value),
            ttft_ms: elapsed_ms,
            elapsed_ms,
            reasoning_ms: None,
        });
    }
    read_sse_completion(response, started, on_delta, between_reads, on_thinking)
}

// ============================================================================
// 400 自动卸参数（Issue #86，规格 #74 §E3）
// ============================================================================

/// 已知会被部分端点（OpenAI 推理系列、部分中转站）拒收的请求参数名。
const KNOWN_DROP_PARAMS: [&str; 10] = [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "stream_options",
    "enable_thinking",
    "reasoning_effort",
    "thinking_budget",
    "presence_penalty",
    "frequency_penalty",
];

/// 端点参数能力的进程级记忆：确认被拒的参数集 + max_tokens 改名方向。
/// 键 = (baseUrl, model)。不持久化：重启后代价 = 一次 400 往返。
#[derive(Debug, Default)]
struct ParamCaps {
    dropped: Vec<String>,
    /// 该端点要求的长度上限字段名；Unknown = 未改名过。
    max_tokens_style: MaxTokensStyle,
}

/// max_tokens 改名方向（规格 #74 §E3：防互相打转，最多换一次）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum MaxTokensStyle {
    #[default]
    Unknown,
    /// 该端点要 max_completion_tokens（OpenAI 推理系列）。
    Completion,
    /// 该端点要回 max_tokens。
    Plain,
}

fn param_caps_cache() -> &'static Mutex<HashMap<(String, String), ParamCaps>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), ParamCaps>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 从 model_http_error 识别被拒的已知参数：HTTP 400 且错误体 error.param 命中已知
/// 参数名，或 error.message 按词边界命中（error.code 为 unsupported_parameter /
/// unsupported_value / invalid_request_error 的情形均被这两条覆盖——前两者本来就
/// 靠 param/message 定位参数）。不命中 → None（不卸参数、不重发）。
fn rejected_params_of(error: &BridgeError) -> Option<Vec<String>> {
    if error.code != "model_http_error" {
        return None;
    }
    let details = error.details.as_ref()?;
    if details.get("httpStatus").and_then(Value::as_u64) != Some(400) {
        return None;
    }
    let body = details.get("upstreamBody").and_then(Value::as_str)?;
    detect_rejected_params(body)
}

fn detect_rejected_params(body: &str) -> Option<Vec<String>> {
    let mut found: Vec<String> = Vec::new();
    // 结构化路径：error.param 命中已知参数名。
    let parsed = serde_json::from_str::<Value>(body).ok();
    let error = parsed.as_ref().and_then(|value| value.get("error"));
    if let Some(param) = error.and_then(|error| error.get("param")).and_then(Value::as_str) {
        if KNOWN_DROP_PARAMS.contains(&param) {
            found.push(param.to_string());
        }
    }
    // 词边界路径：error.message；错误体不是 JSON/无 error 对象时退到响应原文
    //（部分中转站 400 返回纯文本）。按非 [A-Za-z0-9_] 切词后整词比对
    //（max_tokens 不误中 max_completion_tokens）。
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(body);
    for token in message.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        if KNOWN_DROP_PARAMS.contains(&token) && !found.iter().any(|p| p == token) {
            found.push(token.to_string());
        }
    }
    if found.is_empty() {
        None
    } else {
        Some(found)
    }
}

/// 一次卸参数动作：删除的参数 + 至多一次 max_tokens ↔ max_completion_tokens 改名。
#[derive(Debug)]
struct DropAction {
    dropped: Vec<String>,
    renamed: Option<(String, String)>,
}

impl DropAction {
    fn describe(&self) -> String {
        let mut parts: Vec<String> = self.dropped.clone();
        if let Some((from, to)) = &self.renamed {
            parts.push(format!("{from}→{to}"));
        }
        parts.join(", ")
    }
}

/// 按被拒参数调整请求体：max_tokens 被拒 → 改名 max_completion_tokens（OpenAI 推理
/// 系列规则）；max_completion_tokens 被拒 → 改回 max_tokens（防互相打转，一次调整
/// 最多换一次）；其余参数直接删除。请求体不含被拒参数（如已被 extraBody 删键）→ None。
fn adjust_body_for_rejected(body: &Value, rejected: &[String]) -> Option<(Value, DropAction)> {
    let mut map = body.as_object()?.clone();
    let mut dropped = Vec::new();
    let mut renamed = None;
    for param in rejected {
        let rename_target = match param.as_str() {
            "max_tokens" if renamed.is_none() && !map.contains_key("max_completion_tokens") => {
                Some("max_completion_tokens")
            }
            "max_completion_tokens" if renamed.is_none() && !map.contains_key("max_tokens") => {
                Some("max_tokens")
            }
            _ => None,
        };
        match rename_target {
            Some(target) if map.contains_key(param.as_str()) => {
                let value = map.remove(param.as_str()).expect("参数在体中");
                map.insert(target.to_string(), value);
                renamed = Some((param.clone(), target.to_string()));
            }
            _ => {
                // 本轮改名目标不再删：错误 message 常含建议写法（"Use max_completion_tokens
                // instead"），词边界会把它一并匹配进来，但它不是被拒参数本身。
                if renamed.as_ref().is_some_and(|(_, to)| to == param) {
                    continue;
                }
                if map.remove(param.as_str()).is_some() {
                    dropped.push(param.clone());
                }
            }
        }
    }
    if dropped.is_empty() && renamed.is_none() {
        return None;
    }
    Some((Value::Object(map), DropAction { dropped, renamed }))
}

/// 发送前按缓存的端点能力卸参数（后续轮不再白跑一次 400）。
fn apply_cached_caps(cache_key: &(String, String), body: &Value) -> Value {
    let cache = param_caps_cache().lock().unwrap_or_else(|e| e.into_inner());
    let Some(caps) = cache.get(cache_key) else {
        return body.clone();
    };
    let Some(map) = body.as_object().cloned() else {
        return body.clone();
    };
    let mut map = map;
    for param in &caps.dropped {
        map.remove(param);
    }
    match caps.max_tokens_style {
        MaxTokensStyle::Completion => {
            if let Some(value) = map.remove("max_tokens") {
                map.insert("max_completion_tokens".to_string(), value);
            }
        }
        MaxTokensStyle::Plain => {
            if let Some(value) = map.remove("max_completion_tokens") {
                map.insert("max_tokens".to_string(), value);
            }
        }
        MaxTokensStyle::Unknown => {}
    }
    Value::Object(map)
}

/// 重发成功后记住端点能力（进程级）。
fn remember_caps(cache_key: &(String, String), action: &DropAction) {
    let mut cache = param_caps_cache().lock().unwrap_or_else(|e| e.into_inner());
    let caps = cache.entry(cache_key.clone()).or_default();
    for param in &action.dropped {
        if !caps.dropped.contains(param) {
            caps.dropped.push(param.clone());
        }
    }
    if let Some((_, to)) = &action.renamed {
        caps.max_tokens_style = if to == "max_completion_tokens" {
            MaxTokensStyle::Completion
        } else {
            MaxTokensStyle::Plain
        };
    }
}

/// chat 发送的统一入口（协议轮 chat_round 与 model.chat@1 共用，规格 #74 §E3）：
/// 先按进程级端点能力缓存卸参数；发出后若遇 HTTP 400 且错误体命中已知参数，
/// 调整请求体并立即重发一次（不消耗任务重试额度——400 时尚未产出任何 chunk，
/// 不触碰「已产出 chunk 不再自动重试」门槛）。重发仍失败按现状报错，错误信息附
/// 「已尝试去掉：…」。model.test@1 不走此路径（连接测试如实暴露端点行为）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn chat_completions_compat<D, C, T>(
    ctx: &RunContext,
    config: &ModelConfig,
    endpoint: &str,
    body: &Value,
    timeout: Duration,
    stage: Option<&str>,
    mut on_delta: D,
    mut between_reads: C,
    mut on_thinking: T,
) -> Result<ChatCompletion, BridgeError>
where
    D: FnMut(&str) -> Result<(), BridgeError>,
    C: FnMut() -> Result<(), BridgeError>,
    T: FnMut(u64, u64) -> Result<(), BridgeError> + Send,
{
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&config.model)
        .to_string();
    let cache_key = (config.base_url.clone(), model);
    let body = apply_cached_caps(&cache_key, body);
    let first = chat_completions(
        &config.api_key,
        endpoint,
        &body,
        timeout,
        &mut on_delta,
        &mut between_reads,
        &mut on_thinking,
    );
    let Err(error) = first else {
        return first;
    };
    let Some(rejected) = rejected_params_of(&error) else {
        return Err(error);
    };
    let Some((adjusted, action)) = adjust_body_for_rejected(&body, &rejected) else {
        return Err(error);
    };
    ctx.cancel_checkpoint()?;
    // 首次卸参数：detail 事件进快照日志（任务中心「端点不支持 temperature，已自动
    // 去掉」），任务级警示进快照 warnings。
    let mut detail = json!({
        "kind": "param_dropped",
        "params": action.dropped,
    });
    if let Some(stage) = stage {
        detail["stage"] = json!(stage);
    }
    if let Some((from, to)) = &action.renamed {
        detail["renamed"] = json!({ from: to });
    }
    ctx.emit_detail("param_dropped", detail);
    for param in &action.dropped {
        ctx.push_warning(format!("param_dropped:{param}"));
    }
    if let Some((from, to)) = &action.renamed {
        ctx.push_warning(format!("param_renamed:{from}:{to}"));
    }
    match chat_completions(
        &config.api_key,
        endpoint,
        &adjusted,
        timeout,
        &mut on_delta,
        &mut between_reads,
        &mut on_thinking,
    ) {
        Ok(completion) => {
            remember_caps(&cache_key, &action);
            Ok(completion)
        }
        Err(mut error) => {
            error.message = format!("{}（已尝试去掉：{}）", error.message, action.describe());
            Err(error)
        }
    }
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
    let mut details = json!({ "httpStatus": status });
    if status == 400 {
        // 原始错误体（截断）：#86 的 400 卸参数识别需要 error.param/code/message。
        details["upstreamBody"] = json!(truncate_chars(body.trim(), 2000));
    }
    BridgeError::new(code, message, retryable).with_details(details)
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
/// SSE 增量逐块发 chunk（chunk=增量本身，不累积），非流式发单个 chunk。
/// 成功终态 result 携带 usage 与 ttftMs/elapsedMs（#75）。
/// 可选 `stage` 决定内建思考默认与阶段模型；未传 stage 时只应用 extraBody。
/// temperature 为 None 时请求体不带该键（#86：设置留空 / 输入显式 null = 不发送）。
/// 发送走 chat_completions_compat：400 命中已知参数时自动卸参数重发一次（#86）。
/// 自动重试只在「尚未发出任何内容 chunk」时允许：一旦已产出 chunk，重发请求会把
/// 已发出的增量再推一遍，前端按到达顺序拼接即出现重复前缀；此后失败直接 failed
///（错误保留 retryable，UI 手动重试是新任务，从干净状态开始）。
pub(crate) fn run_chat(
    ctx: &RunContext,
    messages: &[Value],
    temperature: Option<f64>,
    max_tokens: u64,
    stream: bool,
    stage: Option<&str>,
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
    let extras = load_request_extras(&ctx.library);
    let model = model_name_for(stage, &extras.stage_models, &config.model);
    let body = chat_request_body(
        &model,
        messages,
        temperature,
        max_tokens,
        stream,
        stage,
        &extras.extra_body,
        &extras.stage_extra_body,
    );
    // 本次任务是否已向事件流发出内容 chunk；跨尝试共享，供重试门槛判断。
    let chunk_emitted = Arc::new(AtomicBool::new(false));
    let emitted = Arc::clone(&chunk_emitted);
    let stage_owned = stage.map(str::to_string);
    let outcome = run_with_retry_while(
        ctx,
        |ctx| chat_once(ctx, &config, &endpoint, &body, &emitted, stage_owned.as_deref()),
        || !chunk_emitted.load(Ordering::SeqCst),
    );
    if let Ok(completion) = outcome {
        ctx.succeed(Some(completion.to_chat_result()));
    }
}

fn chat_once(
    ctx: &RunContext,
    config: &ModelConfig,
    endpoint: &str,
    body: &Value,
    chunk_emitted: &AtomicBool,
    stage: Option<&str>,
) -> Result<ChatCompletion, BridgeError> {
    ctx.cancel_checkpoint()?;
    let mut chunk_count: u64 = 0;
    chat_completions_compat(
        ctx,
        config,
        endpoint,
        body,
        CHAT_TOTAL_TIMEOUT,
        stage,
        |delta| {
            chunk_count += 1;
            chunk_emitted.store(true, Ordering::SeqCst);
            ctx.push_chunk(
                Progress {
                    done: chunk_count,
                    total: 0,
                },
                delta.to_string(),
            );
            Ok(())
        },
        || ctx.cancel_checkpoint(),
        |elapsed_ms, reasoning_chars| {
            let mut detail = json!({
                "kind": "thinking",
                "elapsedMs": elapsed_ms,
                "reasoningChars": reasoning_chars,
            });
            if let Some(stage) = stage {
                detail["stage"] = json!(stage);
            }
            ctx.emit_detail("thinking", detail);
            Ok(())
        },
    )
}

struct ThinkingClock {
    started: Instant,
    active: AtomicBool,
    chars: AtomicU64,
    last_emit: Mutex<Option<Instant>>,
}

impl ThinkingClock {
    fn new(started: Instant) -> Self {
        Self {
            started,
            active: AtomicBool::new(false),
            chars: AtomicU64::new(0),
            last_emit: Mutex::new(None),
        }
    }

    fn note_reasoning(&self, chars: u64) {
        self.chars.store(chars, Ordering::SeqCst);
        self.active.store(true, Ordering::SeqCst);
    }

    fn note_content(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn try_emit(&self) -> Option<(u64, u64)> {
        let mut last = self.last_emit.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.active.load(Ordering::SeqCst) {
            return None;
        }
        let now = Instant::now();
        let due = last
            .map(|at| now.duration_since(at) >= THINKING_HEARTBEAT)
            .unwrap_or(true);
        if !due {
            return None;
        }
        *last = Some(now);
        Some((
            self.started.elapsed().as_millis() as u64,
            self.chars.load(Ordering::SeqCst),
        ))
    }
}

fn emit_thinking<T>(clock: &ThinkingClock, on_thinking: &Mutex<T>) -> Result<(), BridgeError>
where
    T: FnMut(u64, u64) -> Result<(), BridgeError>,
{
    let mut callback = on_thinking
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some((elapsed_ms, reasoning_chars)) = clock.try_emit() else {
        return Ok(());
    };
    callback(elapsed_ms, reasoning_chars)
}

/// SSE 流式读取：按 8KB 块读；按 \n 在字节层切行。抽增量、finish_reason 与 usage。
/// `choices` 为空数组但带 `usage` 的事件要接受。读到 EOF 才结束，以便 keep-alive 排空响应体。
/// 推理增量（`reasoning_content`）不进正文、不触发 chunk；思考进行中每 ≥1s 回调一次，
/// 即使底层 `read` 阻塞也由旁路心跳补发。
fn read_sse_completion<D, C, T>(
    mut response: Response,
    started: Instant,
    mut on_delta: D,
    mut between_reads: C,
    on_thinking: T,
) -> Result<ChatCompletion, BridgeError>
where
    D: FnMut(&str) -> Result<(), BridgeError>,
    C: FnMut() -> Result<(), BridgeError>,
    T: FnMut(u64, u64) -> Result<(), BridgeError> + Send,
{
    let clock = ThinkingClock::new(started);
    let on_thinking = Mutex::new(on_thinking);
    let stop = AtomicBool::new(false);
    thread::scope(|scope| {
        scope.spawn(|| {
            while !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(200));
                let _ = emit_thinking(&clock, &on_thinking);
            }
        });
        let mut buffer: Vec<u8> = Vec::new();
        let mut state = SseReadState::default();
        let mut buf = [0_u8; READ_CHUNK];
        let outcome = (|| {
            loop {
                between_reads()?;
                emit_thinking(&clock, &on_thinking)?;
                let read = response
                    .read(&mut buf)
                    .map_err(|err| network_error("model_network_error", err))?;
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&buf[..read]);
                while let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line);
                    apply_sse_line(&line, &mut state, started, &clock, &on_thinking, &mut on_delta)?;
                }
            }
            if !buffer.is_empty() {
                let tail = String::from_utf8_lossy(&buffer).into_owned();
                for line in tail.split('\n') {
                    apply_sse_line(line, &mut state, started, &clock, &on_thinking, &mut on_delta)?;
                }
            }
            let elapsed_ms = started.elapsed().as_millis() as u64;
            let reasoning_ms = state.reasoning_ms();
            Ok(ChatCompletion {
                text: state.text,
                finish_reason: state.finish_reason,
                usage: state.usage,
                ttft_ms: state.ttft_ms.unwrap_or(elapsed_ms),
                elapsed_ms,
                reasoning_ms,
            })
        })();
        stop.store(true, Ordering::SeqCst);
        outcome
    })
}

#[derive(Default)]
struct SseReadState {
    text: String,
    finish_reason: Option<String>,
    usage: TokenUsage,
    ttft_ms: Option<u64>,
    first_reasoning_ms: Option<u64>,
    first_content_ms: Option<u64>,
    reasoning_chars: u64,
}

impl SseReadState {
    fn mark_first_token(&mut self, started: Instant) {
        if self.ttft_ms.is_none() {
            self.ttft_ms = Some(started.elapsed().as_millis() as u64);
        }
    }

    fn reasoning_ms(&self) -> Option<u64> {
        match (self.first_reasoning_ms, self.first_content_ms) {
            (Some(start), Some(end)) => Some(end.saturating_sub(start)),
            _ => None,
        }
    }
}

fn apply_sse_line<D, T>(
    line: &str,
    state: &mut SseReadState,
    started: Instant,
    clock: &ThinkingClock,
    on_thinking: &Mutex<T>,
    on_delta: &mut D,
) -> Result<(), BridgeError>
where
    D: FnMut(&str) -> Result<(), BridgeError>,
    T: FnMut(u64, u64) -> Result<(), BridgeError>,
{
    let Some(fields) = parse_sse_line(line) else {
        return Ok(());
    };
    state.usage.merge(fields.usage);
    if let Some(reason) = fields.finish_reason {
        state.finish_reason = Some(reason);
    }
    if !fields.reasoning.is_empty() {
        state.mark_first_token(started);
        if state.first_reasoning_ms.is_none() {
            state.first_reasoning_ms = Some(started.elapsed().as_millis() as u64);
        }
        state.reasoning_chars += fields.reasoning.chars().count() as u64;
        clock.note_reasoning(state.reasoning_chars);
        if state.first_content_ms.is_none() {
            emit_thinking(clock, on_thinking)?;
        }
    }
    if !fields.delta.is_empty() {
        state.mark_first_token(started);
        if state.first_content_ms.is_none() {
            state.first_content_ms = Some(started.elapsed().as_millis() as u64);
        }
        {
            // 与心跳线程共用 on_thinking 锁：先关掉 clock，再发正文，避免思考回调排到 content 之后。
            let _guard = on_thinking
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clock.note_content();
        }
        state.text.push_str(&fields.delta);
        on_delta(&fields.delta)?;
    }
    Ok(())
}

struct SseFields {
    delta: String,
    reasoning: String,
    finish_reason: Option<String>,
    usage: TokenUsage,
}

/// 处理一行 SSE：非 data: 行忽略；[DONE] 忽略（靠读到 EOF 结束）；JSON 解析失败忽略。
/// 正文增量取 choices[0].delta.content（回退 message.content）；
/// 推理增量取 delta.reasoning_content（不进正文）。
/// usage 可出现在 choices 为空的事件。
fn parse_sse_line(line: &str) -> Option<SseFields> {
    let trimmed = line.trim();
    let payload = trimmed.strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        return None;
    }
    let value: Value = serde_json::from_str(payload).ok()?;
    let usage = TokenUsage::from_value(&value);
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let field_text = |field: &str| {
        choice
            .and_then(|choice| {
                choice
                    .get("delta")
                    .and_then(|delta| delta.get(field))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        choice
                            .get("message")
                            .and_then(|message| message.get(field))
                            .and_then(Value::as_str)
                    })
            })
            .unwrap_or("")
            .to_string()
    };
    let delta = field_text("content");
    let reasoning = field_text("reasoning_content");
    let finish_reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
        .map(str::to_string);
    Some(SseFields {
        delta,
        reasoning,
        finish_reason,
        usage,
    })
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
    let client = shared_http_client()?;
    let response = client
        .get(endpoint)
        .timeout(TEST_MODELS_TIMEOUT)
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
    let client = shared_http_client()?;
    let body = json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });
    let response = client
        .post(endpoint)
        .timeout(TEST_CHAT_TIMEOUT)
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
