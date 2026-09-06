//! 技能文件服务外部行为契约：`skills.list@1` 与浏览器端 `/api/skills` 形状一致。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::sync::Arc;

fn invoke(registry: &Arc<TaskRegistry>, library: &Library, command: &str, input: Value) -> Value {
    bridge::invoke(registry, library, command, &input).expect(command)
}

#[test]
fn skills_list_returns_five_files_sorted_by_name() {
    let (registry, library, _dir) = common::env();
    let result = invoke(&registry, &library, "skills.list@1", json!({}));
    assert_eq!(result["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    let skills = result["skills"].as_array().expect("skills 数组");
    assert_eq!(skills.len(), 5, "应内嵌五个技能文件");
    let names: Vec<&str> = skills.iter().map(|item| item["file"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec![
            "abstract-translation.md",
            "experiment-analysis.md",
            "introduction-analysis.md",
            "method-deep-dive.md",
            "part-analysis.md"
        ],
        "技能应按文件名排序"
    );
}

#[test]
fn each_skill_text_contains_frontmatter_section() {
    let (registry, library, _dir) = common::env();
    let result = invoke(&registry, &library, "skills.list@1", json!({}));
    for item in result["skills"].as_array().unwrap() {
        let text = item["text"].as_str().expect("text 字段");
        assert!(text.contains("section:"), "{} 缺少 frontmatter section", item["file"]);
    }
}

#[test]
fn app_info_lists_skills_command() {
    let (registry, library, _dir) = common::env();
    let info = invoke(&registry, &library, "app.info@1", json!({}));
    let commands = info["commands"].as_array().unwrap();
    assert!(commands.iter().any(|item| item == "skills.list@1"), "app.info 未列出 skills.list@1");
}
