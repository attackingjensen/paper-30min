//! 应用设置：模型连接参数与技能覆盖存储在书库 settings 表（key-value）。
//! 设置（含 API Key）永远不进 PaperDto、浏览器迁移或任何导出 DTO——与 migration.rs
//! 的既有约束一致：API Key 与应用设置不离开本机书库，也不随导出文件传播。

use serde_json::{json, Map, Value};

use crate::bridge::BRIDGE_SCHEMA_VERSION;
use crate::error::BridgeError;
use crate::library::Library;

/// settings 表中模型设置（JSON 对象）与技能覆盖（JSON 对象）的键名。
const MODEL_KEY: &str = "model";
const SKILLS_OVERRIDES_KEY: &str = "skills.overrides";
/// Docling 侧车设置（JSON 对象）：hfEndpoint 为模型下载端点覆盖（规格 #48 决策 3）；
/// tableMode 为表格结构识别模式（规格 #74 A2 / Issue #78）；warmStart 为常驻侧车
/// 启动预热开关、idleShutdownMinutes 为空闲释放分钟数（规格 #74 A3 / Issue #84）。
const PDFPARSE_KEY: &str = "pdfparse";

/// UI 偏好设置（JSON 对象）：welcomeSeeded = 内置「使用说明」已播种标记（发布版首启）。
const UI_KEY: &str = "ui";
/// 协议编排设置（JSON 对象）：concurrency 为节薄摘要 / 批量深挖的有界并发上限（#79 / #83）。
const PROTOCOL_KEY: &str = "protocol";

pub(crate) const DEFAULT_PROTOCOL_CONCURRENCY: u64 = 3;
pub(crate) const MIN_PROTOCOL_CONCURRENCY: u64 = 1;
pub(crate) const MAX_PROTOCOL_CONCURRENCY: u64 = 6;

/// 常驻侧车空闲释放分钟数（Issue #84）：默认 10，允许 1–240。
pub(crate) const DEFAULT_IDLE_SHUTDOWN_MINUTES: u64 = 10;
pub(crate) const MIN_IDLE_SHUTDOWN_MINUTES: u64 = 1;
pub(crate) const MAX_IDLE_SHUTDOWN_MINUTES: u64 = 240;

/// maxTokens 设置上限：settings 校验与协议任务的 stage 下限提升共用同一上限
/// （协议任务把配置值抬到阶段下限时也不越过此上限）。
pub(crate) const MAX_TOKENS_LIMIT: u64 = 200_000;

fn default_model() -> Map<String, Value> {
    json!({
        "baseUrl": "",
        "apiKey": "",
        "model": "",
        "temperature": 0.3,
        "maxTokens": 4096,
        "maxChars": 16000,
        "stageModels": {},
        "extraBody": {},
        "stageExtraBody": {},
    })
    .as_object()
    .expect("默认模型设置是对象")
    .clone()
}

fn default_pdfparse() -> Map<String, Value> {
    json!({
        "hfEndpoint": "",
        "tableMode": "fast",
        "warmStart": true,
        "idleShutdownMinutes": DEFAULT_IDLE_SHUTDOWN_MINUTES,
    })
    .as_object()
    .expect("默认侧车设置是对象")
    .clone()
}

fn default_ui() -> Map<String, Value> {
    json!({
        "welcomeSeeded": false,
    })
    .as_object()
    .expect("默认 UI 设置是对象")
    .clone()
}

fn default_protocol() -> Map<String, Value> {
    json!({
        "concurrency": DEFAULT_PROTOCOL_CONCURRENCY,
    })
    .as_object()
    .expect("默认协议设置是对象")
    .clone()
}

/// 读取存储的 JSON 对象并与缺省值合并；从未写入或内容损坏时按缺省处理。
fn load_object(library: &Library, key: &str, defaults: Map<String, Value>) -> Result<Map<String, Value>, BridgeError> {
    let mut merged = defaults;
    if let Some(text) = library.get_setting(key)? {
        if let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(&text) {
            for (field, value) in stored {
                merged.insert(field, value);
            }
        }
    }
    Ok(merged)
}

fn load_model(library: &Library) -> Result<Map<String, Value>, BridgeError> {
    load_object(library, MODEL_KEY, default_model())
}

fn load_skills_overrides(library: &Library) -> Result<Map<String, Value>, BridgeError> {
    load_object(library, SKILLS_OVERRIDES_KEY, Map::new())
}

fn load_pdfparse(library: &Library) -> Result<Map<String, Value>, BridgeError> {
    load_object(library, PDFPARSE_KEY, default_pdfparse())
}

fn load_ui(library: &Library) -> Result<Map<String, Value>, BridgeError> {
    load_object(library, UI_KEY, default_ui())
}

fn load_protocol(library: &Library) -> Result<Map<String, Value>, BridgeError> {
    load_object(library, PROTOCOL_KEY, default_protocol())
}

/// pdfparse 任务的表格结构模式：仅 `fast` / `accurate`；其余（含损坏存储）回落 fast。
pub(crate) fn pdfparse_table_mode(library: &Library) -> &'static str {
    match load_pdfparse(library)
        .ok()
        .as_ref()
        .and_then(|merged| merged.get("tableMode"))
        .and_then(Value::as_str)
        .map(str::trim)
    {
        Some("accurate") => "accurate",
        _ => "fast",
    }
}

/// pdfparse 任务的 HF 端点覆盖：空串/缺省/损坏都归为 None（默认官方源+镜像回退）。
pub(crate) fn pdfparse_hf_endpoint(library: &Library) -> Option<String> {
    let merged = load_pdfparse(library).ok()?;
    merged
        .get("hfEndpoint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 常驻侧车启动预热开关（Issue #84）：缺省/损坏都按开处理。
pub(crate) fn pdfparse_warm_start(library: &Library) -> bool {
    load_pdfparse(library)
        .ok()
        .as_ref()
        .and_then(|merged| merged.get("warmStart"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// 常驻侧车空闲释放阈值：默认 10 分钟，设置可配 1–240 分钟；
/// 环境变量 PAPER30MIN_PDFPARSE_IDLE_SECS 提供秒级覆盖（契约测试钩子）。
pub(crate) fn pdfparse_idle_shutdown(library: &Library) -> std::time::Duration {
    if let Ok(raw) = std::env::var(crate::pdfpool::IDLE_SECS_ENV) {
        if let Ok(secs) = raw.trim().parse::<u64>() {
            if secs > 0 {
                return std::time::Duration::from_secs(secs);
            }
        }
    }
    let minutes = load_pdfparse(library)
        .ok()
        .as_ref()
        .and_then(|merged| merged.get("idleShutdownMinutes"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_IDLE_SHUTDOWN_MINUTES)
        .clamp(MIN_IDLE_SHUTDOWN_MINUTES, MAX_IDLE_SHUTDOWN_MINUTES);
    std::time::Duration::from_secs(minutes * 60)
}

pub fn get(library: &Library) -> Result<Value, BridgeError> {
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "model": Value::Object(load_model(library)?),
        "skillsOverrides": Value::Object(load_skills_overrides(library)?),
        "pdfparse": Value::Object(load_pdfparse(library)?),
        "ui": Value::Object(load_ui(library)?),
        "protocol": Value::Object(load_protocol(library)?),
    }))
}

/// 协议有界并发上限：损坏或越界存储回落缺省 3，并钳制在 1–6。
pub(crate) fn protocol_concurrency(library: &Library) -> u32 {
    load_protocol(library)
        .ok()
        .as_ref()
        .and_then(|merged| merged.get("concurrency"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PROTOCOL_CONCURRENCY)
        .clamp(MIN_PROTOCOL_CONCURRENCY, MAX_PROTOCOL_CONCURRENCY) as u32
}

/// 局部更新模型设置：只校验并覆盖出现的字段，缺省字段沿用已存值。
pub fn put_model(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    let settings = input
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| BridgeError::invalid_input("settings.putModel@1 需要对象参数 settings"))?;
    let mut merged = load_model(library)?;
    for (field, value) in settings {
        match field.as_str() {
            "baseUrl" | "apiKey" | "model" => {
                if !value.is_string() {
                    return Err(BridgeError::invalid_input(format!("{field} 必须是字符串")));
                }
            }
            "temperature" => {
                let number = value
                    .as_f64()
                    .ok_or_else(|| BridgeError::invalid_input("temperature 必须是数值"))?;
                if !(0.0..=2.0).contains(&number) {
                    return Err(BridgeError::invalid_input("temperature 必须在 0..=2 之间"));
                }
            }
            "maxTokens" | "maxChars" => {
                let number = value.as_u64().ok_or_else(|| {
                    BridgeError::invalid_input(format!("{field} 必须是正整数"))
                })?;
                let (min, max) = if field == "maxTokens" { (1, MAX_TOKENS_LIMIT) } else { (1_000, MAX_TOKENS_LIMIT) };
                if number < min || number > max {
                    return Err(BridgeError::invalid_input(format!("{field} 必须在 {min}..={max} 之间")));
                }
            }
            "stageModels" => {
                merged.insert(field.clone(), crate::model::validate_stage_models(value)?);
                continue;
            }
            "extraBody" => {
                merged.insert(field.clone(), crate::model::validate_extra_body(value)?);
                continue;
            }
            "stageExtraBody" => {
                merged.insert(field.clone(), crate::model::validate_stage_extra_body(value)?);
                continue;
            }
            // 未知字段忽略，不写入存储，避免污染设置对象。
            _ => continue,
        }
        merged.insert(field.clone(), value.clone());
    }
    let text = serde_json::to_string(&Value::Object(merged.clone()))
        .map_err(|err| BridgeError::internal(format!("设置 JSON 编码失败: {err}")))?;
    library.put_setting(MODEL_KEY, &text)?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "settings": Value::Object(merged),
    }))
}

pub fn put_skills_overrides(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    let overrides = input
        .get("overrides")
        .and_then(Value::as_object)
        .ok_or_else(|| BridgeError::invalid_input("settings.putSkillsOverrides@1 需要对象参数 overrides"))?;
    let text = serde_json::to_string(&Value::Object(overrides.clone()))
        .map_err(|err| BridgeError::internal(format!("设置 JSON 编码失败: {err}")))?;
    library.put_setting(SKILLS_OVERRIDES_KEY, &text)?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "stored": true,
    }))
}

/// 局部更新侧车设置：hfEndpoint 为空字符串（默认官方源+镜像回退）或 http(s) URL；
/// tableMode 为 `fast`（默认）或 `accurate`；warmStart 为常驻预热开关（默认开）；
/// idleShutdownMinutes 为常驻空闲释放分钟数（默认 10，1–240）（#84）。
pub fn put_pdfparse(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    let settings = input
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| BridgeError::invalid_input("settings.putPdfparse@1 需要对象参数 settings"))?;
    let mut merged = load_pdfparse(library)?;
    for (field, value) in settings {
        match field.as_str() {
            "hfEndpoint" => {
                let text = value
                    .as_str()
                    .ok_or_else(|| BridgeError::invalid_input("hfEndpoint 必须是字符串"))?;
                let trimmed = text.trim();
                if !trimmed.is_empty()
                    && !trimmed.starts_with("http://")
                    && !trimmed.starts_with("https://")
                {
                    return Err(BridgeError::invalid_input(
                        "hfEndpoint 必须是 http/https 地址或空字符串",
                    ));
                }
                merged.insert(field.clone(), Value::String(trimmed.to_string()));
            }
            "tableMode" => {
                let text = value
                    .as_str()
                    .ok_or_else(|| BridgeError::invalid_input("tableMode 必须是 fast 或 accurate"))?;
                let trimmed = text.trim();
                if trimmed != "fast" && trimmed != "accurate" {
                    return Err(BridgeError::invalid_input(
                        "tableMode 必须是 fast 或 accurate",
                    ));
                }
                merged.insert(field.clone(), Value::String(trimmed.to_string()));
            }
            "warmStart" => {
                if !value.is_boolean() {
                    return Err(BridgeError::invalid_input("warmStart 必须是布尔值"));
                }
                merged.insert(field.clone(), value.clone());
            }
            "idleShutdownMinutes" => {
                let number = value.as_u64().ok_or_else(|| {
                    BridgeError::invalid_input("idleShutdownMinutes 必须是正整数")
                })?;
                if !(MIN_IDLE_SHUTDOWN_MINUTES..=MAX_IDLE_SHUTDOWN_MINUTES).contains(&number) {
                    return Err(BridgeError::invalid_input(format!(
                        "idleShutdownMinutes 必须在 {MIN_IDLE_SHUTDOWN_MINUTES}..={MAX_IDLE_SHUTDOWN_MINUTES} 之间"
                    )));
                }
                merged.insert(field.clone(), json!(number));
            }
            // 未知字段忽略，不写入存储，避免污染设置对象。
            _ => continue,
        }
    }
    let text = serde_json::to_string(&Value::Object(merged.clone()))
        .map_err(|err| BridgeError::internal(format!("设置 JSON 编码失败: {err}")))?;
    library.put_setting(PDFPARSE_KEY, &text)?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "settings": Value::Object(merged),
    }))
}

/// 局部更新 UI 偏好：只校验并覆盖出现的字段，缺省字段沿用已存值。
pub fn put_ui(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    let settings = input
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| BridgeError::invalid_input("settings.putUi@1 需要对象参数 settings"))?;
    let mut merged = load_ui(library)?;
    for (field, value) in settings {
        match field.as_str() {
            "welcomeSeeded" => {
                if !value.is_boolean() {
                    return Err(BridgeError::invalid_input("welcomeSeeded 必须是布尔值"));
                }
                merged.insert(field.clone(), value.clone());
            }
            // 未知字段忽略，不写入存储，避免污染设置对象。
            _ => continue,
        }
    }
    let text = serde_json::to_string(&Value::Object(merged.clone()))
        .map_err(|err| BridgeError::internal(format!("设置 JSON 编码失败: {err}")))?;
    library.put_setting(UI_KEY, &text)?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "settings": Value::Object(merged),
    }))
}

/// 局部更新协议编排设置：concurrency 为 1–6 的整数，默认 3。
pub fn put_protocol(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    let settings = input
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| BridgeError::invalid_input("settings.putProtocol@1 需要对象参数 settings"))?;
    let mut merged = load_protocol(library)?;
    for (field, value) in settings {
        match field.as_str() {
            "concurrency" => {
                let number = value.as_u64().ok_or_else(|| {
                    BridgeError::invalid_input("concurrency 必须是 1–6 的整数")
                })?;
                if number < MIN_PROTOCOL_CONCURRENCY || number > MAX_PROTOCOL_CONCURRENCY {
                    return Err(BridgeError::invalid_input(format!(
                        "concurrency 必须在 {MIN_PROTOCOL_CONCURRENCY}..={MAX_PROTOCOL_CONCURRENCY} 之间"
                    )));
                }
                merged.insert(field.clone(), json!(number));
            }
            // 未知字段忽略，不写入存储，避免污染设置对象。
            _ => continue,
        }
    }
    let text = serde_json::to_string(&Value::Object(merged.clone()))
        .map_err(|err| BridgeError::internal(format!("设置 JSON 编码失败: {err}")))?;
    library.put_setting(PROTOCOL_KEY, &text)?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "settings": Value::Object(merged),
    }))
}
