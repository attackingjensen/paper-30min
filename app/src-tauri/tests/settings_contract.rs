//! 应用设置外部行为契约：只通过版本化 `settings.*@1` 命令观察，
//! 不读取 SQLite 表结构；设置（含 API Key）不出现在任何论文/导出 DTO 中。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::sync::Arc;

fn invoke(registry: &Arc<TaskRegistry>, library: &Library, command: &str, input: Value) -> Value {
    bridge::invoke(registry, library, command, &input).expect(command)
}

fn invoke_err(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    command: &str,
    input: Value,
) -> BridgeError {
    bridge::invoke(registry, library, command, &input).expect_err(command)
}

#[test]
fn defaults_are_reported_before_any_write() {
    let (registry, library, _dir) = common::env();
    let result = invoke(&registry, &library, "settings.get@1", json!({}));
    assert_eq!(result["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    let model = &result["model"];
    assert_eq!(model["baseUrl"], json!(""));
    assert_eq!(model["apiKey"], json!(""));
    assert_eq!(model["model"], json!(""));
    assert_eq!(model["temperature"], json!(0.3));
    assert_eq!(model["maxTokens"], json!(4096));
    assert_eq!(model["maxChars"], json!(16000));
    assert_eq!(result["skillsOverrides"], json!({}));
}

#[test]
fn put_model_merges_partial_updates_onto_stored_values() {
    let (registry, library, _dir) = common::env();
    let saved = invoke(
        &registry,
        &library,
        "settings.putModel@1",
        json!({ "settings": { "baseUrl": "https://api.example.com", "model": "gpt-x" } }),
    );
    assert_eq!(saved["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    assert_eq!(saved["settings"]["model"], json!("gpt-x"));
    assert_eq!(saved["settings"]["maxTokens"], json!(4096), "未提供字段应沿用缺省值");

    // 第二次局部更新只改 temperature，其余字段沿用已存值。
    let updated = invoke(
        &registry,
        &library,
        "settings.putModel@1",
        json!({ "settings": { "temperature": 1.5, "maxChars": 20000 } }),
    );
    assert_eq!(updated["settings"]["temperature"], json!(1.5));
    assert_eq!(updated["settings"]["maxChars"], json!(20000));
    assert_eq!(updated["settings"]["baseUrl"], json!("https://api.example.com"), "局部更新不应清掉已存字段");
    assert_eq!(updated["settings"]["model"], json!("gpt-x"));

    let loaded = invoke(&registry, &library, "settings.get@1", json!({}));
    assert_eq!(loaded["model"], updated["settings"]);
}

#[test]
fn put_model_rejects_invalid_values() {
    let (registry, library, _dir) = common::env();
    for settings in [
        json!({ "temperature": 2.5 }),
        json!({ "temperature": -0.1 }),
        json!({ "temperature": "high" }),
        json!({ "maxTokens": 0 }),
        json!({ "maxTokens": 200001 }),
        json!({ "maxTokens": 100.5 }),
        json!({ "maxChars": 999 }),
        json!({ "maxChars": 200001 }),
        json!({ "baseUrl": 42 }),
        json!({ "apiKey": true }),
        json!({ "model": ["gpt-x"] }),
    ] {
        let error = invoke_err(
            &registry,
            &library,
            "settings.putModel@1",
            json!({ "settings": settings }),
        );
        assert_eq!(error.code, "invalid_input", "应拒绝非法设置: {settings}");
        assert!(!error.retryable);
    }
    // settings 字段缺失或不是对象同样拒绝。
    for input in [json!({}), json!({ "settings": "text" }), json!({ "settings": [] })] {
        let error = invoke_err(&registry, &library, "settings.putModel@1", input.clone());
        assert_eq!(error.code, "invalid_input", "应拒绝非法输入: {input}");
    }
}

#[test]
fn put_skills_overrides_requires_object_and_round_trips() {
    let (registry, library, _dir) = common::env();
    for input in [
        json!({}),
        json!({ "overrides": [] }),
        json!({ "overrides": "text" }),
        json!({ "overrides": 42 }),
    ] {
        let error = invoke_err(&registry, &library, "settings.putSkillsOverrides@1", input.clone());
        assert_eq!(error.code, "invalid_input", "应拒绝非法输入: {input}");
    }

    let overrides = json!({ "abstract-translation.md": "自定义摘要技能", "part-analysis.md": "自定义部分技能" });
    let stored = invoke(
        &registry,
        &library,
        "settings.putSkillsOverrides@1",
        json!({ "overrides": overrides }),
    );
    assert_eq!(stored["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    assert_eq!(stored["stored"], json!(true));

    let loaded = invoke(&registry, &library, "settings.get@1", json!({}));
    assert_eq!(loaded["skillsOverrides"]["abstract-translation.md"], json!("自定义摘要技能"));
    assert_eq!(loaded["skillsOverrides"]["part-analysis.md"], json!("自定义部分技能"));
}

#[test]
fn settings_do_not_leak_into_paper_dto() {
    let (registry, library, _dir) = common::env();
    invoke(
        &registry,
        &library,
        "settings.putModel@1",
        json!({ "settings": { "apiKey": "sk-secret", "model": "gpt-x" } }),
    );
    invoke(
        &registry,
        &library,
        "library.putPaper@1",
        json!({
            "paper": {
                "id": "paper-a",
                "title": "注意力论文",
                "addedAt": "2026-09-01T08:00:00Z",
                "updatedAt": "2026-09-01T09:00:00Z"
            }
        }),
    );
    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-a" }));
    let paper = &loaded["paper"];
    assert!(paper.get("settings").is_none(), "论文 DTO 不应包含 settings");
    assert!(paper.get("apiKey").is_none(), "论文 DTO 不应包含 apiKey");
    let serialized = serde_json::to_string(paper).unwrap();
    assert!(!serialized.contains("sk-secret"), "论文 DTO 序列化不应含 API Key 值");
}

#[test]
fn settings_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(dir.path()).unwrap());
    let registry = TaskRegistry::new(Arc::clone(&library));
    {
        invoke(
            &registry,
            &library,
            "settings.putModel@1",
            json!({ "settings": { "model": "gpt-x", "temperature": 0.8 } }),
        );
        invoke(
            &registry,
            &library,
            "settings.putSkillsOverrides@1",
            json!({ "overrides": { "part-analysis.md": "覆盖" } }),
        );
    }
    // 另开一条连接只读到已提交数据，验证落盘持久化。
    let library = Library::open(dir.path()).unwrap();
    let loaded = invoke(&registry, &library, "settings.get@1", json!({}));
    assert_eq!(loaded["model"]["model"], json!("gpt-x"));
    assert_eq!(loaded["model"]["temperature"], json!(0.8));
    assert_eq!(loaded["model"]["maxTokens"], json!(4096));
    assert_eq!(loaded["skillsOverrides"]["part-analysis.md"], json!("覆盖"));
}

#[test]
fn app_info_lists_settings_commands() {
    let (registry, library, _dir) = common::env();
    let info = invoke(&registry, &library, "app.info@1", json!({}));
    let commands = info["commands"].as_array().unwrap();
    for name in [
        "settings.get@1",
        "settings.putModel@1",
        "settings.putSkillsOverrides@1",
        "dialog.pickFile@1",
        "dialog.saveFile@1",
    ] {
        assert!(commands.iter().any(|item| item == name), "app.info 未列出 {name}");
    }
}
