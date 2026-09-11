//! 技能文件服务：编译期内嵌仓库根 skills/ 下的技能库文件，
//! 返回形状与浏览器端 server.py `/api/skills` 一致（按文件名排序的 [{file, text}]）。
//!
//! 技能库形态（规格 #55 决策 23–25，#64）：四段协议提示词（map-l2 / map-l1 / deep-dive /
//! synthesize）+ 章节关注点数据（section-focus.json）；旧五技能（每类章节一个提示词）迁为
//! 对应类型的关注点覆盖项，原文件留档于 skills/legacy/ 并继续驱动旧精读生成路径（直至该
//! 路径随 #55 决策 26 退役）。前端按文件名路由：legacy/ 前缀 → 旧技能，.json → 关注点数据，
//! 其余 .md → 协议提示词。

use serde_json::{json, Value};

/// 编译期内嵌的技能文件清单；新增技能文件时在仓库根 skills/ 放文件并登记到这里。
const SKILLS: &[(&str, &str)] = &[
    ("deep-dive.md", include_str!("../../../skills/deep-dive.md")),
    ("map-l1.md", include_str!("../../../skills/map-l1.md")),
    ("map-l2.md", include_str!("../../../skills/map-l2.md")),
    ("synthesize.md", include_str!("../../../skills/synthesize.md")),
    ("section-focus.json", include_str!("../../../skills/section-focus.json")),
    ("legacy/abstract-translation.md", include_str!("../../../skills/legacy/abstract-translation.md")),
    ("legacy/experiment-analysis.md", include_str!("../../../skills/legacy/experiment-analysis.md")),
    ("legacy/introduction-analysis.md", include_str!("../../../skills/legacy/introduction-analysis.md")),
    ("legacy/method-deep-dive.md", include_str!("../../../skills/legacy/method-deep-dive.md")),
    ("legacy/part-analysis.md", include_str!("../../../skills/legacy/part-analysis.md")),
];

/// 按文件名排序返回 [{file, text}]，frontmatter / JSON 解析由前端完成。
pub fn list_skills() -> Vec<Value> {
    let mut entries: Vec<Value> = SKILLS
        .iter()
        .map(|(file, text)| json!({ "file": file, "text": text }))
        .collect();
    entries.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    entries
}

/// 取单个内嵌技能文件的原文（协议任务运行时在 Rust 侧组装提示词用，#65）。
pub(crate) fn skill_text(file: &str) -> Option<&'static str> {
    SKILLS
        .iter()
        .find(|(name, _)| *name == file)
        .map(|(_, text)| *text)
}
