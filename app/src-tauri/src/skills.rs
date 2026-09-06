//! 技能文件服务：编译期内嵌仓库根 skills/ 下的技能 Markdown，
//! 返回形状与浏览器端 server.py `/api/skills` 一致（按文件名排序的 [{file, text}]）。

use serde_json::{json, Value};

/// 编译期内嵌的技能文件清单；新增技能文件时在仓库根 skills/ 放文件并登记到这里。
const SKILLS: &[(&str, &str)] = &[
    ("abstract-translation.md", include_str!("../../../skills/abstract-translation.md")),
    ("experiment-analysis.md", include_str!("../../../skills/experiment-analysis.md")),
    ("introduction-analysis.md", include_str!("../../../skills/introduction-analysis.md")),
    ("method-deep-dive.md", include_str!("../../../skills/method-deep-dive.md")),
    ("part-analysis.md", include_str!("../../../skills/part-analysis.md")),
];

/// 按文件名排序返回 [{file, text}]，frontmatter 解析由前端完成。
pub fn list_skills() -> Vec<Value> {
    let mut entries: Vec<Value> = SKILLS
        .iter()
        .map(|(file, text)| json!({ "file": file, "text": text }))
        .collect();
    entries.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    entries
}
