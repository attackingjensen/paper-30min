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
fn skills_list_returns_ten_files_sorted_by_name() {
    let (registry, library, _dir) = common::env();
    let result = invoke(&registry, &library, "skills.list@1", json!({}));
    assert_eq!(result["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    let skills = result["skills"].as_array().expect("skills 数组");
    // #64：四段协议提示词 + 关注点数据文件 + 留档旧五技能。
    assert_eq!(skills.len(), 10, "应内嵌十个技能库文件");
    let names: Vec<&str> = skills.iter().map(|item| item["file"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec![
            "deep-dive.md",
            "legacy/abstract-translation.md",
            "legacy/experiment-analysis.md",
            "legacy/introduction-analysis.md",
            "legacy/method-deep-dive.md",
            "legacy/part-analysis.md",
            "map-l1.md",
            "map-l2.md",
            "section-focus.json",
            "synthesize.md"
        ],
        "技能库文件应按文件名排序"
    );
}

#[test]
fn each_skill_text_contains_expected_frontmatter_key() {
    let (registry, library, _dir) = common::env();
    let result = invoke(&registry, &library, "skills.list@1", json!({}));
    for item in result["skills"].as_array().unwrap() {
        let file = item["file"].as_str().unwrap();
        let text = item["text"].as_str().expect("text 字段");
        if file == "section-focus.json" {
            assert!(text.contains("\"types\""), "{file} 缺关注点 types 键");
        } else if file.starts_with("legacy/") {
            assert!(text.contains("section:"), "{file} 缺少 frontmatter section");
        } else {
            assert!(text.contains("stage:"), "{file} 缺少 frontmatter stage");
        }
    }
}

#[test]
fn app_info_lists_skills_command() {
    let (registry, library, _dir) = common::env();
    let info = invoke(&registry, &library, "app.info@1", json!({}));
    let commands = info["commands"].as_array().unwrap();
    assert!(commands.iter().any(|item| item == "skills.list@1"), "app.info 未列出 skills.list@1");
}
