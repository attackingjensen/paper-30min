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

fn default_model() -> Map<String, Value> {
    json!({
        "baseUrl": "",
        "apiKey": "",
        "model": "",
        "temperature": 0.3,
        "maxTokens": 4096,
        "maxChars": 16000,
    })
    .as_object()
    .expect("默认模型设置是对象")
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

pub fn get(library: &Library) -> Result<Value, BridgeError> {
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "model": Value::Object(load_model(library)?),
        "skillsOverrides": Value::Object(load_skills_overrides(library)?),
    }))
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
                let (min, max) = if field == "maxTokens" { (1, 200_000) } else { (1_000, 200_000) };
                if number < min || number > max {
                    return Err(BridgeError::invalid_input(format!("{field} 必须在 {min}..={max} 之间")));
                }
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
