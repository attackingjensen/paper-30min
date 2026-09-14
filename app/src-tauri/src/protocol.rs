//! 三阶段协议任务（Issue #65，规格 #55 §任务种类与编排 / §四件工具契约 / §建图编排）：
//! `paper.build-map@1`（块模型门禁 → 调用① L2 全覆盖 → 调用② L1 合成）、
//! `paper.deep-dive@1`（页图/裁切图齐备检查 + 配方打底 + 文本协议工具循环，单节与批量同构 partIds[]）、
//! `paper.synthesize@1`（L1 + 全部 L2 + 已有深挖 → 复述稿）。
//!
//! 关键语义（规格 #55 决策 1–5、10–15、20–21）：
//! - 工具调用走文本协议：模型输出中的 ```tool 围栏块（一个 JSON 对象 {name, args}），
//!   Rust 解析、执行（四件工具皆为纯数据读：块模型 JSON / 清单 / 附件），结果作为新一轮
//!   上下文续上；无工具调用块即完成。步数上限 12，连续 2 次解析失败按失败收尾。
//! - 取消 = 当前步完成后停止（轮边界检查点，不中断在途模型轮）；已产出内容按中断部分
//!   结果语义落库：深挖逐节完成即落库（完整结果计 analysis 打卡），建图在调用①后、
//!   调用②前/中被取消时，已完成的 L2 分片以 `partial: true` 标记落库并计 partial 打卡。
//! - 重跑覆盖须 overwriteConfirmed=true，否则以 already_exists 错误即指令拒绝；深挖/综合
//!   在未建图（无 map 产物）时以 map_required 错误即指令拒绝。
//! - 超长护栏：调用①装配估算超 ~20 万 token 时按节分片多次调用再确定性合并；任一调用
//!   装配后超 983,616 输入 token 即报错拒绝（不截断）。token 为保守估算（CJK≈1、ASCII≈1/4），
//!   页图按 #38 实测 1902 token/页、裁切图按 1024 token/张计预算。
//! - 工具轨迹与逐节子进度经任务事件流（event="tool" / "stage"，载荷在 detail）可回看；
//!   每轮模型调用另发 event="round"（时延与 usage）；中间轮不产生对外 chunk（决策 4）。
//!
//! 精读部分 ↔ 块模型节的对应约定：abstract ↔ role=Abstract 节；part-N ↔ 第 N 个内容节
//! （role ∈ Body/Appendix，按阅读顺序）。两来源分属导入解析与 Docling 映射两条管线，
//! 节数不一致时建图仍覆盖全部内容节，无法落键的部分记入 result.warnings 提示。

use serde_json::{json, Map, Value};
use std::collections::HashMap;

use crate::error::BridgeError;
use crate::library::{ActivityDayDto, Library, PaperDto, ProductDto};
use crate::model;
use crate::pdfassets;
use crate::pdfmap::{MappedPaper, Section, SectionRole};
use crate::settings;
use crate::tasks::{self, run_with_retry, Progress, RunContext};

pub const TASK_BUILD_MAP: &str = "paper.build-map@1";
pub const TASK_DEEP_DIVE: &str = "paper.deep-dive@1";
pub const TASK_SYNTHESIZE: &str = "paper.synthesize@1";

/// 深挖工具循环的步数上限（一次工具调用 = 一步）。契约测试锚定，保持 pub。
pub const MAX_TOOL_STEPS: u32 = 12;
/// 文本协议解析失败的连续容忍次数（工具调用块解析 / 阶段输出校验共用）。
pub(crate) const MAX_PARSE_FAILURES: u32 = 2;
/// 调用①装配估算的分片阈值（~20 万 token）。
pub(crate) const DEFAULT_SHARD_TOKEN_THRESHOLD: u64 = 200_000;
/// 任一调用装配后的输入 token 硬顶（#38 实测，不截断、报错拒绝）。
pub(crate) const DEFAULT_INPUT_TOKEN_HARD_TOP: u64 = 983_616;
/// read_section 单窗字符上限（约 8KB）。
pub(crate) const READ_SECTION_CHAR_CAP: usize = 8_000;
/// read_section limit 参数的取值上限。
pub(crate) const READ_SECTION_MAX_LIMIT: u32 = 100;
/// search_paper 命中上限；超帽按节轮转采样并置 truncated。
pub(crate) const SEARCH_HIT_CAP: usize = 50;
/// 页图 token 预算（#38 实测 1224×1584 @scale=2）；裁切图也按页图预算计（保守高估）。
pub(crate) const PAGE_IMAGE_TOKEN_BUDGET: u64 = 1_902;

/// 章节类型受控词表（建图调用①打标取值域，与 skills/section-focus.json 键一致）。
pub(crate) const SECTION_TYPES: [&str; 5] = ["abstract", "introduction", "method", "experiments", "part"];

const STAGE_MAP_L2: &str = "map-l2";
const STAGE_MAP_L1: &str = "map-l1";
const STAGE_DEEP_DIVE: &str = "deep-dive";
const STAGE_SYNTHESIZE: &str = "synthesize";

const TOOL_READ_SECTION: &str = "read_section";
const TOOL_SEARCH_PAPER: &str = "search_paper";
const TOOL_GET_FIGURE: &str = "get_figure";
const TOOL_GET_PAGE_IMAGE: &str = "get_page_image";
const TOOL_NAMES: [&str; 4] = [TOOL_READ_SECTION, TOOL_SEARCH_PAPER, TOOL_GET_FIGURE, TOOL_GET_PAGE_IMAGE];

/// 各阶段输出必须包含的固定 Markdown 标题（无工具阶段的完成判据之一）。
const DEEP_DIVE_HEADERS: [&str; 4] = ["## 核心论点", "## 关键细节", "## 与全局的关系", "## 边界与存疑"];
const SYNTHESIZE_HEADERS: [&str; 4] = ["## 问题", "## 方法", "## 证据", "## 边界"];

/// 协议轮次的最小 max_tokens 下限（settings 值更低时抬到该下限，防 JSON/长文截断）。
const MIN_MAX_TOKENS: u64 = 8_192;
const MIN_MAX_TOKENS_LONG: u64 = 16_384;

/// 测试挂钩：经环境变量下调护栏阈值（生产缺省 DEFAULT_*）。
const SHARD_THRESHOLD_ENV: &str = "PAPER30MIN_PROTOCOL_SHARD_TOKENS";
const HARD_TOP_ENV: &str = "PAPER30MIN_PROTOCOL_HARD_TOP";

fn shard_token_threshold() -> u64 {
    std::env::var(SHARD_THRESHOLD_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_SHARD_TOKEN_THRESHOLD)
}

fn input_token_hard_top() -> u64 {
    std::env::var(HARD_TOP_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_INPUT_TOKEN_HARD_TOP)
}

/// 当前 UTC 时间（RFC3339），产物落库的 updatedAt。
fn now_iso() -> String {
    tasks::now_iso()
}

// ============================================================================
// token 估算（与 app/ui/js/protocol.js 的 estimateTextTokens 同式，改动须同步）
// ============================================================================

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x3000..=0x303f | 0xff00..=0xffef)
}

/// 保守文本 token 估算：CJK 字符 ≈ 1 token，其余字符 ≈ 1/4 token（上取整）。
/// 护栏只做"够不够大"的判断，宁可高估也不低估（宁早拒绝不顶穿硬顶）。
pub fn estimate_text_tokens(text: &str) -> u64 {
    let mut quarter_units: u64 = 0;
    for ch in text.chars() {
        quarter_units += if is_cjk(ch) { 4 } else { 1 };
    }
    quarter_units.div_ceil(4)
}

// ============================================================================
// 技能库加载与提示词装配（叠加规则与 app/ui/js/skills.js composePrompt 一致）
// ============================================================================

struct SkillSet {
    /// stage → 提示词正文（frontmatter 已剥离；覆盖值整段替换）。
    prompts: HashMap<String, String>,
    /// 章节类型 → 关注点清单（覆盖整组替换）。
    focus: HashMap<String, Vec<String>>,
    /// 章节类型 → 展示名。
    focus_labels: HashMap<String, String>,
}

fn strip_frontmatter(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    if let Some(rest) = normalized.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            return rest[end + 5..].trim().to_string();
        }
    }
    normalized.trim().to_string()
}

fn load_skills(library: &Library) -> Result<SkillSet, BridgeError> {
    let mut prompts = HashMap::new();
    for (stage, file) in [
        (STAGE_MAP_L2, "map-l2.md"),
        (STAGE_MAP_L1, "map-l1.md"),
        (STAGE_DEEP_DIVE, "deep-dive.md"),
        (STAGE_SYNTHESIZE, "synthesize.md"),
    ] {
        let text = crate::skills::skill_text(file)
            .ok_or_else(|| BridgeError::internal(format!("内嵌技能文件缺失: {file}")))?;
        prompts.insert(stage.to_string(), strip_frontmatter(text));
    }
    let mut focus: HashMap<String, Vec<String>> = HashMap::new();
    let mut focus_labels: HashMap<String, String> = HashMap::new();
    let focus_text = crate::skills::skill_text("section-focus.json")
        .ok_or_else(|| BridgeError::internal("内嵌关注点数据缺失: section-focus.json"))?;
    let focus_json: Value = serde_json::from_str(focus_text)
        .map_err(|err| BridgeError::internal(format!("关注点数据解析失败: {err}")))?;
    if let Some(types) = focus_json.get("types").and_then(Value::as_object) {
        for (key, entry) in types {
            let items: Vec<String> = entry
                .get("focus")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if items.is_empty() {
                continue;
            }
            let label = entry
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .unwrap_or(key.as_str())
                .to_string();
            focus.insert(key.clone(), items);
            focus_labels.insert(key.clone(), label);
        }
    }
    // 用户覆盖（v2 对象）：prompts 按 stage 整段替换，focus 按类型整组替换；
    // 畸形字段忽略（与 JS migrateSkillsOverrides 的规范化口径一致）。
    if let Some(text) = library.get_setting("skills.overrides")? {
        if let Ok(Value::Object(overrides)) = serde_json::from_str::<Value>(&text) {
            if let Some(map) = overrides.get("prompts").and_then(Value::as_object) {
                for (stage, value) in map {
                    if let Some(text) = value.as_str() {
                        prompts.insert(stage.clone(), strip_frontmatter(text));
                    }
                }
            }
            if let Some(map) = overrides.get("focus").and_then(Value::as_object) {
                for (key, value) in map {
                    let items: Vec<String> = value
                        .as_array()
                        .map(|list| {
                            list.iter()
                                .filter_map(Value::as_str)
                                .map(str::trim)
                                .filter(|item| !item.is_empty())
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    if !items.is_empty() {
                        focus.insert(key.clone(), items);
                    }
                }
            }
        }
    }
    Ok(SkillSet {
        prompts,
        focus,
        focus_labels,
    })
}

impl SkillSet {
    /// 关注点叠加块：map-l2 叠加全表；deep-dive 叠加该节类型（未知类型回退 part）；
    /// map-l1 / synthesize 不叠加。
    fn focus_block(&self, stage: &str, section_type: &str) -> String {
        if stage == STAGE_MAP_L2 {
            return SECTION_TYPES
                .iter()
                .map(|key| {
                    let label = self.focus_labels.get(*key).map(String::as_str).unwrap_or(*key);
                    let items = self.focus.get(*key).cloned().unwrap_or_default();
                    let mut block = format!("{key}（{label}）：");
                    for item in items {
                        block.push_str(&format!("\n- {item}"));
                    }
                    block
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
        if stage == STAGE_DEEP_DIVE {
            let key = if SECTION_TYPES.contains(&section_type) {
                section_type
            } else {
                "part"
            };
            let label = self.focus_labels.get(key).map(String::as_str).unwrap_or(key);
            let mut block = format!("本节类型关注点（{label}）：");
            for item in self.focus.get(key).cloned().unwrap_or_default() {
                block.push_str(&format!("\n- {item}"));
            }
            return block;
        }
        String::new()
    }

    /// 装配协议提示词：打底文本 + 占位符注入 + 关注点叠加。覆盖版提示词丢
    /// {sectionFocus} 占位符时关注点块追加到末尾（叠加规则不允许被覆盖丢掉）。
    fn compose(&self, stage: &str, values: &[(&str, &str)], section_type: &str) -> Result<String, BridgeError> {
        let base = self
            .prompts
            .get(stage)
            .ok_or_else(|| BridgeError::internal(format!("协议提示词缺失: {stage}")))?;
        let focus = self.focus_block(stage, section_type);
        let section_types = format!(
            "[{}]",
            SECTION_TYPES
                .iter()
                .map(|key| format!("\"{key}\""))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut text = base.replace("{sectionTypes}", &section_types);
        for (key, value) in values {
            text = text.replace(&format!("{{{key}}}"), value);
        }
        text = text.replace("{sectionFocus}", &focus);
        if !focus.is_empty() && !base.contains("{sectionFocus}") {
            text = format!("{text}\n\n## 章节关注点\n\n{focus}\n");
        }
        Ok(text)
    }
}

// ============================================================================
// 块模型访问：加载、节/部分映射、文本层渲染
// ============================================================================

fn load_block_model(library: &Library, paper_id: &str) -> Result<MappedPaper, BridgeError> {
    let attachment = library
        .get_attachment(paper_id, pdfassets::BLOCKMODEL_ATTACHMENT_ID)
        .map_err(|_| {
            BridgeError::new(
                "preflight_missing",
                "建图前置产物不齐备：缺少块模型附件 blockmodel.json。\
                 请先完成解析（pdfparse.convert@1）。",
                false,
            )
            .with_details(json!({ "missing": [pdfassets::BLOCKMODEL_ATTACHMENT_ID] }))
        })?;
    let (_, bytes) = library.read_range(
        paper_id,
        pdfassets::BLOCKMODEL_ATTACHMENT_ID,
        0,
        attachment.size as u64,
    )?;
    serde_json::from_slice::<MappedPaper>(&bytes).map_err(|err| {
        BridgeError::new(
            "block_model_invalid",
            format!("块模型附件解析失败: {err}"),
            false,
        )
    })
}

/// 参与 L2 的节：除 References / Acknowledgments 外的全部原文章节（含 Abstract），按阅读顺序。
fn l2_sections(mapped: &MappedPaper) -> Vec<&Section> {
    mapped
        .sections
        .iter()
        .filter(|section| !matches!(section.role, SectionRole::References | SectionRole::Acknowledgments))
        .collect()
}

/// 内容节：part-N 映射的取值域（role ∈ Body/Appendix，按阅读顺序）。
fn content_sections(mapped: &MappedPaper) -> Vec<&Section> {
    mapped
        .sections
        .iter()
        .filter(|section| matches!(section.role, SectionRole::Body | SectionRole::Appendix))
        .collect()
}

/// 节 → 精读部分 id：Abstract → abstract；第 i 个内容节 → part-{i+1}。
fn part_id_for_section(mapped: &MappedPaper, section: &Section) -> Option<String> {
    if section.role == SectionRole::Abstract {
        return Some("abstract".to_string());
    }
    let contents = content_sections(mapped);
    contents
        .iter()
        .position(|entry| entry.id == section.id)
        .map(|index| format!("part-{}", index + 1))
}

/// 精读部分 id → 节：abstract → role=Abstract 节；part-N → 第 N 个内容节。
fn section_for_part<'a>(mapped: &'a MappedPaper, part_id: &str) -> Option<&'a Section> {
    if part_id == "abstract" {
        return mapped.sections.iter().find(|section| section.role == SectionRole::Abstract);
    }
    let index: usize = part_id.strip_prefix("part-")?.parse().ok()?;
    if index == 0 {
        return None;
    }
    content_sections(mapped).get(index - 1).copied()
}

/// 单节文本层渲染：每块 `L{id} (p{page})：{text}`，块间空行（deep-dive 当前节全送、
/// read_section 窗口共用同一形态——模型读到的块号与出处语法一致）。
fn render_section_text(section: &Section) -> String {
    section
        .blocks
        .iter()
        .map(|block| format!("L{} (p{})：{}", block.id, block.page, block.text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// 多节文本层渲染：节标题行 `## {sec_id} {title} (p{start}-{end})` + 节内块（调用①输入）。
fn render_paper_text(sections: &[&Section]) -> String {
    sections
        .iter()
        .map(|section| {
            format!(
                "## {} {} (p{}-{})\n\n{}",
                section.id,
                section.title,
                section.page_start,
                section.page_end,
                render_section_text(section)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// 图表清单渲染（调用②输入）：每件一行，含页码、归属节、图注与正文引用处数。
fn render_asset_list(entries: &[crate::pdfmap::AssetEntry]) -> String {
    if entries.is_empty() {
        return "（空）".to_string();
    }
    entries
        .iter()
        .map(|entry| {
            let caption = entry.caption.as_deref().unwrap_or("（无图注）");
            let section = entry.section.as_deref().unwrap_or("（首节之前）");
            format!(
                "- {}（p{}，属于 {}）：{}（正文引用 {} 处）",
                entry.id,
                entry.page,
                section,
                caption,
                entry.references.len()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// L2 集合的提示词注入形态：JSON 数组（每条含 secId/title/type/gist/points/keyAssets/pages）。
fn render_l2_blob(bodies: &[Value]) -> String {
    serde_json::to_string_pretty(&Value::Array(bodies.to_vec())).unwrap_or_else(|_| "[]".to_string())
}

fn render_map_blob(map_body: &Value) -> String {
    serde_json::to_string_pretty(map_body).unwrap_or_else(|_| "{}".to_string())
}

// ============================================================================
// 产物存取与落库缝（随 putPaper 整记录写入缝；打卡口径 #51/#62）
// ============================================================================

fn product_body<'a>(paper: &'a PaperDto, kind: &str, part_id: &str) -> Option<&'a Value> {
    paper
        .products
        .iter()
        .find(|product| product.kind == kind && product.part_id == part_id)
        .map(|product| &product.body)
}

/// 把一组产物并入论文记录并随整记录写入缝落库；activity 为 Some 时并入当日打卡
/// （同日同 kind 幂等）。覆盖语义：同 (kind, partId) 的旧产物被替换，不留版本。
fn persist_products(
    library: &Library,
    paper_id: &str,
    updates: Vec<(String, String, Value)>,
    activity: Option<&'static str>,
) -> Result<(), BridgeError> {
    let mut paper = library.get_paper(paper_id)?;
    let now = now_iso();
    for (kind, part_id, body) in updates {
        paper
            .products
            .retain(|product| !(product.kind == kind && product.part_id == part_id));
        paper.products.push(ProductDto {
            kind,
            part_id,
            body,
            updated_at: now.clone(),
        });
    }
    if let Some(kind) = activity {
        let day = now[..10].to_string();
        if !paper
            .activity_days
            .iter()
            .any(|entry| entry.day == day && entry.kind == kind)
        {
            paper.activity_days.push(ActivityDayDto {
                day,
                kind: kind.to_string(),
            });
        }
    }
    paper.updated_at = now;
    library.put_paper(paper)?;
    Ok(())
}

// ============================================================================
// 文本协议：工具调用块解析（连续 2 次解析失败按失败收尾；两侧同规则）
// ============================================================================

/// 一轮模型输出的解析结果。
#[derive(Debug, PartialEq)]
enum RoundParse {
    /// 无工具调用块：输出即最终产物文本。
    Final(String),
    /// 合法工具调用。
    ToolCall { name: String, args: Map<String, Value> },
}

/// 提取 ```tool 围栏块内容；无围栏返回 None，围栏未闭合返回 Some(Err)。
fn extract_tool_block(text: &str) -> Option<Result<&str, String>> {
    let start = text.find("```tool")?;
    let after = &text[start + "```tool".len()..];
    // 信息串 "tool" 后允许空白再换行；内容到下一个 ``` 为止。
    let after = after.trim_start_matches([' ', '\t']);
    let after = after.strip_prefix('\n').unwrap_or(after);
    match after.find("```") {
        Some(end) => Some(Ok(after[..end].trim())),
        None => Some(Err("工具调用块围栏未闭合（缺少收尾的 ```）".to_string())),
    }
}

fn validate_tool_args(name: &str, args: &Map<String, Value>) -> Result<(), String> {
    let string_field = |field: &str| {
        args.get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("工具 {name} 需要非空字符串参数 {field}"))
    };
    match name {
        TOOL_READ_SECTION => {
            string_field("sec_id")?;
            for field in ["offset", "limit"] {
                if let Some(value) = args.get(field) {
                    let number = value
                        .as_u64()
                        .ok_or_else(|| format!("工具 {name} 的 {field} 必须是正整数"))?;
                    if number == 0 {
                        return Err(format!("工具 {name} 的 {field} 必须是正整数"));
                    }
                }
            }
        }
        TOOL_SEARCH_PAPER => {
            string_field("pattern")?;
        }
        TOOL_GET_FIGURE => {
            string_field("fig_id")?;
        }
        TOOL_GET_PAGE_IMAGE => {
            let page = args
                .get("page")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("工具 {name} 需要正整数参数 page"))?;
            if page == 0 {
                return Err(format!("工具 {name} 的 page 必须是正整数"));
            }
        }
        _ => unreachable!("工具名已校验"),
    }
    Ok(())
}

/// 解析一轮输出：无 ```tool 围栏 → Final；有围栏则解析为工具调用。
/// 解析失败（围栏未闭合 / JSON 非法 / 缺 name / args 非对象 / 未知工具 / 参数形状非法）
/// 返回 Err(错误观察文案)，由调用方喂回模型并计入连续失败。
fn parse_round_output(text: &str) -> Result<RoundParse, String> {
    let Some(block) = extract_tool_block(text) else {
        return Ok(RoundParse::Final(text.trim().to_string()));
    };
    let content = block?;
    let value: Value = serde_json::from_str(content)
        .map_err(|err| format!("工具调用块 JSON 解析失败: {err}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "工具调用块必须是一个 JSON 对象".to_string())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "工具调用块缺少字符串字段 name".to_string())?;
    if !TOOL_NAMES.contains(&name) {
        return Err(format!(
            "未知工具 {name}（可用：{}）",
            TOOL_NAMES.join(", ")
        ));
    }
    let args = match object.get("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err("工具调用块的 args 必须是对象".to_string()),
    };
    validate_tool_args(name, &args)?;
    Ok(RoundParse::ToolCall {
        name: name.to_string(),
        args,
    })
}

// ============================================================================
// 四件工具（纯数据读：块模型 / 清单 / 附件；无效地址 = 结构化错误观察）
// ============================================================================

/// 工具执行结果：观察文本（JSON）+ 随观察附带的图像字节（get_figure / get_page_image；
/// 附件 id 已含在观察 JSON 的 cropAssetId / assetId 字段中）。
struct ToolOutcome {
    observation: Value,
    images: Vec<Vec<u8>>,
}

fn tool_error_observation(name: &str, code: &str, message: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        observation: json!({
            "tool": name,
            "ok": false,
            "error": { "code": code, "message": message.into() },
        }),
        images: Vec::new(),
    }
}

/// 读取附件字节；缺失 = None（由调用方决定降级或错误观察）。
fn read_attachment_bytes(library: &Library, paper_id: &str, attachment_id: &str) -> Option<Vec<u8>> {
    let attachment = library.get_attachment(paper_id, attachment_id).ok()?;
    let (_, bytes) = library
        .read_range(paper_id, attachment_id, 0, attachment.size as u64)
        .ok()?;
    Some(bytes)
}

fn exec_read_section(mapped: &MappedPaper, args: &Map<String, Value>) -> ToolOutcome {
    let sec_id = args.get("sec_id").and_then(Value::as_str).unwrap_or("");
    let Some(section) = mapped.sections.iter().find(|section| section.id == sec_id) else {
        return tool_error_observation(
            TOOL_READ_SECTION,
            "unknown_section",
            format!("节不存在: {sec_id}（可用节见 L1 地图 structure；不得猜测地址）"),
        );
    };
    let total = section.blocks.len() as u64;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(1);
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(40)
        .min(u64::from(READ_SECTION_MAX_LIMIT));
    if offset > total.max(1) {
        return tool_error_observation(
            TOOL_READ_SECTION,
            "offset_out_of_range",
            format!("offset {offset} 超出节内块数（共 {total} 块）"),
        );
    }
    let mut blocks = Vec::new();
    let mut chars = 0_usize;
    for block in section.blocks.iter().skip((offset - 1) as usize) {
        if blocks.len() as u64 >= limit {
            break;
        }
        // 单窗约 8KB 字符上限；至少装入一块（超长块整块装入，不截断块内文本）。
        if !blocks.is_empty() && chars + block.text.len() > READ_SECTION_CHAR_CAP {
            break;
        }
        chars += block.text.len();
        blocks.push(json!({
            "id": block.id,
            "text": block.text,
            "prov": { "page": block.page },
        }));
    }
    let covered = (offset - 1) + blocks.len() as u64;
    let footer = if covered < total {
        let next_page = section.blocks[covered as usize].page;
        Value::String(format!(
            "已截断：本节共 {total} 块，本窗到 L{covered}；续读用 offset={}，完整内容见第 {next_page} 页页图",
            covered + 1
        ))
    } else {
        Value::Null
    };
    ToolOutcome {
        observation: json!({
            "tool": TOOL_READ_SECTION,
            "ok": true,
            "result": { "blocks": blocks, "total": total, "footer": footer },
        }),
        images: Vec::new(),
    }
}

fn exec_search_paper(mapped: &MappedPaper, args: &Map<String, Value>) -> ToolOutcome {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let mut hits_by_section: Vec<(&Section, Vec<Value>)> = Vec::new();
    let mut total_hits = 0_usize;
    for section in &mapped.sections {
        let mut hits = Vec::new();
        for block in &section.blocks {
            if block.text.to_lowercase().contains(&pattern) {
                let subsection = section
                    .subsections
                    .iter()
                    .find(|sub| sub.block_start <= block.id && block.id <= sub.block_end)
                    .map(|sub| match &sub.number {
                        Some(number) => format!("{number} {}", sub.title),
                        None => sub.title.clone(),
                    });
                // 命中形状 {secId, blockId, page, subsection?}：无所属小节时缺省不携带。
                let mut hit = json!({
                    "secId": section.id,
                    "blockId": block.id,
                    "page": block.page,
                });
                if let Some(subsection) = subsection {
                    hit["subsection"] = json!(subsection);
                }
                hits.push(hit);
            }
        }
        total_hits += hits.len();
        if !hits.is_empty() {
            hits_by_section.push((section, hits));
        }
    }
    let truncated = total_hits > SEARCH_HIT_CAP;
    let hits = if truncated {
        // 超帽按节轮转采样：每轮从各节各取一条，直到凑满上限（覆盖均匀、不偏向首节）。
        let mut sampled = Vec::with_capacity(SEARCH_HIT_CAP);
        let mut round = 0_usize;
        while sampled.len() < SEARCH_HIT_CAP {
            let mut progressed = false;
            for (_, hits) in &hits_by_section {
                if let Some(hit) = hits.get(round) {
                    sampled.push(hit.clone());
                    progressed = true;
                    if sampled.len() >= SEARCH_HIT_CAP {
                        break;
                    }
                }
            }
            if !progressed {
                break;
            }
            round += 1;
        }
        sampled
    } else {
        hits_by_section
            .into_iter()
            .flat_map(|(_, hits)| hits)
            .collect()
    };
    ToolOutcome {
        observation: json!({
            "tool": TOOL_SEARCH_PAPER,
            "ok": true,
            "result": { "hits": hits, "truncated": truncated },
        }),
        images: Vec::new(),
    }
}

fn exec_get_figure(library: &Library, paper_id: &str, mapped: &MappedPaper, args: &Map<String, Value>) -> ToolOutcome {
    let fig_id = args.get("fig_id").and_then(Value::as_str).unwrap_or("");
    let entry = mapped
        .figures
        .iter()
        .map(|entry| (entry, "figure"))
        .chain(mapped.tables.iter().map(|entry| (entry, "table")))
        .find(|(entry, _)| entry.id == fig_id);
    let Some((entry, kind)) = entry else {
        return tool_error_observation(
            TOOL_GET_FIGURE,
            "unknown_figure",
            format!("图/表不存在: {fig_id}（清单见 L1 地图 keyEvidence 与 L2 keyAssets；不得猜测地址）"),
        );
    };
    let crop_asset_id = pdfassets::crop_attachment_id(fig_id);
    let Some(bytes) = read_attachment_bytes(library, paper_id, &crop_asset_id) else {
        return tool_error_observation(
            TOOL_GET_FIGURE,
            "asset_missing",
            format!("裁切图附件缺失: {crop_asset_id}（可改用 get_page_image 看第 {} 页页图）", entry.page),
        );
    };
    let references: Vec<Value> = entry
        .references
        .iter()
        .map(|citation| {
            json!({
                "secId": citation.sec_id,
                "blockId": citation.block_id,
                "page": citation.page,
            })
        })
        .collect();
    ToolOutcome {
        observation: json!({
            "tool": TOOL_GET_FIGURE,
            "ok": true,
            "result": {
                "id": entry.id,
                "kind": kind,
                "caption": entry.caption,
                "page": entry.page,
                "references": references,
                "cropAssetId": crop_asset_id,
            },
        }),
        images: vec![bytes],
    }
}

fn exec_get_page_image(library: &Library, paper_id: &str, mapped: &MappedPaper, args: &Map<String, Value>) -> ToolOutcome {
    let page = args.get("page").and_then(Value::as_u64).unwrap_or(0) as u32;
    if page == 0 || page > mapped.page_count {
        return tool_error_observation(
            TOOL_GET_PAGE_IMAGE,
            "unknown_page",
            format!("页码超出范围: {page}（全文共 {} 页）", mapped.page_count),
        );
    }
    let asset_id = pdfassets::page_attachment_id(page);
    let Some(bytes) = read_attachment_bytes(library, paper_id, &asset_id) else {
        return tool_error_observation(
            TOOL_GET_PAGE_IMAGE,
            "asset_missing",
            format!("页图附件缺失: {asset_id}"),
        );
    };
    ToolOutcome {
        observation: json!({
            "tool": TOOL_GET_PAGE_IMAGE,
            "ok": true,
            "result": { "page": page, "assetId": asset_id },
        }),
        images: vec![bytes],
    }
}

fn execute_tool(
    library: &Library,
    paper_id: &str,
    mapped: &MappedPaper,
    name: &str,
    args: &Map<String, Value>,
) -> ToolOutcome {
    match name {
        TOOL_READ_SECTION => exec_read_section(mapped, args),
        TOOL_SEARCH_PAPER => exec_search_paper(mapped, args),
        TOOL_GET_FIGURE => exec_get_figure(library, paper_id, mapped, args),
        TOOL_GET_PAGE_IMAGE => exec_get_page_image(library, paper_id, mapped, args),
        _ => unreachable!("工具名已校验"),
    }
}

// ============================================================================
// 模型轮：SSE 收集（协议轮不对外发 chunk；取消在轮边界生效——决策 3「当前步完成后停止」）
// ============================================================================

struct RoundOutput {
    text: String,
    finish_reason: Option<String>,
    ttft_ms: u64,
    elapsed_ms: u64,
    usage: model::TokenUsage,
}

struct RoundCtx<'a> {
    stage: &'a str,
    part_id: Option<&'a str>,
    shard: Option<u64>,
}

fn emit_round(ctx: &RunContext, meta: &RoundCtx, round: u32, output: &RoundOutput) {
    let mut detail = json!({
        "stage": meta.stage,
        "round": round,
        "ttftMs": output.ttft_ms,
        "elapsedMs": output.elapsed_ms,
        "receivedChars": output.text.chars().count() as u64,
    });
    if let Some(part_id) = meta.part_id {
        detail["partId"] = json!(part_id);
    }
    if let Some(shard) = meta.shard {
        detail["shard"] = json!(shard);
    }
    if let Some(Value::Object(usage)) = output.usage.to_json() {
        for (key, value) in usage {
            detail[key] = value;
        }
    }
    ctx.emit_detail("round", detail);
}

fn chat_round(
    ctx: &RunContext,
    config: &model::ModelConfig,
    endpoint: &str,
    messages: &[Value],
    temperature: f64,
    max_tokens: u64,
) -> Result<RoundOutput, BridgeError> {
    ctx.cancel_checkpoint()?;
    let body = model::chat_request_body(&config.model, messages, temperature, max_tokens, true);
    let completion = model::chat_completions(
        &config.api_key,
        endpoint,
        &body,
        std::time::Duration::from_secs(600),
        |_| Ok(()),
        || Ok(()),
    )?;
    Ok(RoundOutput {
        text: completion.text,
        finish_reason: completion.finish_reason,
        ttft_ms: completion.ttft_ms,
        elapsed_ms: completion.elapsed_ms,
        usage: completion.usage,
    })
}

/// 单轮模型调用（带统一重试）：retryable 失败按 3 次尝试重试（协议轮不产生对外 chunk，
/// 重发无重复推送问题）。Err(()) 表示终态已由重试机器处理（failed 或 cancelled）。
fn chat_round_retried(
    ctx: &RunContext,
    config: &model::ModelConfig,
    endpoint: &str,
    messages: &[Value],
    temperature: f64,
    max_tokens: u64,
) -> Result<RoundOutput, ()> {
    run_with_retry(ctx, |ctx| {
        chat_round(ctx, config, endpoint, messages, temperature, max_tokens)
    })
}

// ============================================================================
// 阶段输出校验（错误即指令：校验失败 → 错误观察喂回；连续 2 次失败按失败收尾）
// ============================================================================

/// 清洗 refs 数组：只留字符串项，缺省/非数组 → 空。
fn clean_refs(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|refs| refs.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// 从模型输出中提取 JSON 对象：先试整段，再试围栏块，最后试首尾花括号区间。
fn extract_json_object(text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    let candidates = {
        let mut list = vec![trimmed.to_string()];
        // 围栏形态（```json ...``` 或 ``` ...```）。
        if let Some(start) = trimmed.find("```") {
            let after = &trimmed[start + 3..];
            let after = after.strip_prefix("json").unwrap_or(after);
            let after = after.trim_start_matches([' ', '\t', '\n']);
            if let Some(end) = after.find("```") {
                list.push(after[..end].trim().to_string());
            }
        }
        if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
            if start < end {
                list.push(trimmed[start..=end].to_string());
            }
        }
        list
    };
    for candidate in candidates {
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
            if value.is_object() {
                return Ok(value);
            }
        }
    }
    Err("输出不是可解析的 JSON 对象".to_string())
}

/// 校验失败/协议错误的观察消息文本（作为下一轮上下文续上）。
/// 观察码统一为 output_invalid / parse_failed：阶段禁工具、JSON 提取失败、schema 不符
/// 都是同一类「输出未通过校验」语义，区别仅在 message 文案（错误即指令）。
fn error_observation(code: &str, message: impl Into<String>) -> Value {
    json!({
        "tool": Value::Null,
        "ok": false,
        "error": { "code": code, "message": message.into() },
    })
}

/// 用户消息：无图像用纯文本形态，有图像用多模态分段形态（文本段在前，
/// webp data URL，OpenAI 兼容）。配方首条与工具观察共用此构造函数。
fn user_message(text: String, images: Vec<Vec<u8>>) -> Value {
    if images.is_empty() {
        return json!({ "role": "user", "content": text });
    }
    let mut parts = vec![json!({ "type": "text", "text": text })];
    for bytes in images {
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:image/webp;base64,{encoded}") },
        }));
    }
    json!({ "role": "user", "content": parts })
}

/// L2 输出校验与确定性清理：节覆盖必须恰好等于分片节集（缺/重/未知节 → 错误观察
/// 重试）；title/pages 以块模型为准（结构实体取自确定性来源，模型只写论断）；
/// keyAssets 过滤到清单内 id；type 非法回退 part（规格决策 12）。warnings 收集清理痕迹。
fn validate_l2_output(
    value: &Value,
    shard: &[&Section],
    mapped: &MappedPaper,
    warnings: &mut Vec<String>,
) -> Result<Vec<Value>, String> {
    let sections = value
        .get("sections")
        .and_then(Value::as_array)
        .ok_or_else(|| "输出缺少 sections 数组".to_string())?;
    let expected: Vec<&str> = shard.iter().map(|section| section.id.as_str()).collect();
    let mut seen: Vec<&str> = Vec::new();
    let mut entries: Vec<Value> = Vec::new();
    for (index, item) in sections.iter().enumerate() {
        let sec_id = item
            .get("secId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("sections[{index}] 缺少字符串字段 secId"))?;
        if !expected.contains(&sec_id) {
            return Err(format!("sections[{index}] 的 secId「{sec_id}」不在本分片节集内（不得产出分片外的节）"));
        }
        if seen.contains(&sec_id) {
            return Err(format!("节「{sec_id}」出现多次（每节恰好一条薄摘要）"));
        }
        seen.push(sec_id);
        let section = shard.iter().find(|section| section.id == sec_id).expect("已校验在分片内");
        let gist = item
            .get("gist")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|gist| !gist.is_empty())
            .ok_or_else(|| format!("节「{sec_id}」缺少非空 gist"))?;
        let points = item
            .get("points")
            .and_then(Value::as_array)
            .filter(|points| !points.is_empty())
            .ok_or_else(|| format!("节「{sec_id}」需要非空 points 数组"))?;
        let mut clean_points = Vec::new();
        for point in points {
            let text = point.get("text").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if text.is_empty() {
                warnings.push(format!("l2_points_dropped:{sec_id}"));
                continue;
            }
            let refs: Vec<String> = clean_refs(point.get("refs"));
            clean_points.push(json!({ "text": text, "refs": refs }));
        }
        if clean_points.is_empty() {
            return Err(format!("节「{sec_id}」的 points 全部为空"));
        }
        // 规格 #55 决策 16 的字段级约束（要点 3–6 条、gist ≤2 句）按软约束落实：
        // 记 warning 不拒绝——硬性拒绝会在修正轮里逼模型凑数或编造，得不偿失。
        if !(3..=6).contains(&clean_points.len()) {
            warnings.push(format!("l2_points_count:{sec_id}:{}", clean_points.len()));
        }
        let gist_sentences = gist
            .split(['。', '！', '？', '.'])
            .filter(|part| !part.trim().is_empty())
            .count();
        if gist_sentences > 2 {
            warnings.push(format!("l2_gist_long:{sec_id}:{gist_sentences}"));
        }
        let known_assets: Vec<&str> = mapped
            .figures
            .iter()
            .chain(mapped.tables.iter())
            .map(|entry| entry.id.as_str())
            .collect();
        let mut key_assets: Vec<String> = Vec::new();
        for asset in item.get("keyAssets").and_then(Value::as_array).cloned().unwrap_or_default() {
            let Some(asset) = asset.as_str() else { continue };
            if known_assets.contains(&asset) {
                key_assets.push(asset.to_string());
            } else {
                warnings.push(format!("l2_key_asset_unknown:{sec_id}:{asset}"));
            }
        }
        let raw_type = item.get("type").and_then(Value::as_str).unwrap_or("part");
        let section_type = if SECTION_TYPES.contains(&raw_type) {
            raw_type.to_string()
        } else {
            warnings.push(format!("l2_type_fallback:{sec_id}:{raw_type}"));
            "part".to_string()
        };
        entries.push(json!({
            "secId": sec_id,
            "title": section.title,
            "type": section_type,
            "gist": gist,
            "points": clean_points,
            "keyAssets": key_assets,
            "pages": { "start": section.page_start, "end": section.page_end },
        }));
    }
    let missing: Vec<&str> = expected.iter().copied().filter(|id| !seen.contains(id)).collect();
    if !missing.is_empty() {
        return Err(format!(
            "薄摘要覆盖不完整：缺少 {}（每个原文章节恰好一条，References/Acknowledgments 除外）",
            missing.join(", ")
        ));
    }
    // 输出按分片节序重排（模型输出顺序不可信，合并是确定性拼装）。
    entries.sort_by_key(|entry| {
        expected
            .iter()
            .position(|id| *id == entry["secId"].as_str().unwrap_or(""))
            .unwrap_or(usize::MAX)
    });
    Ok(entries)
}

/// L1 输出校验与确定性清理：problem/method 必填 {text, refs[]}；keyEvidence/structure
/// 的实体 id 过滤到清单/节集（决策 20）；glossary/contributions 逐条清理。
fn validate_map_output(value: &Value, mapped: &MappedPaper, warnings: &mut Vec<String>) -> Result<Value, String> {
    let object = value.as_object().ok_or_else(|| "输出必须是 JSON 对象".to_string())?;
    let text_with_refs = |field: &str| -> Result<Value, String> {
        let entry = object
            .get(field)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("输出缺少对象字段 {field}"))?;
        let text = entry
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("{field}.text 必须是非空字符串"))?;
        let refs: Vec<String> = clean_refs(entry.get("refs"));
        Ok(json!({ "text": text, "refs": refs }))
    };
    let clean_list = |field: &str, keep: &mut dyn FnMut(&Value) -> Option<Value>| -> Vec<Value> {
        object
            .get(field)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(&mut *keep).collect())
            .unwrap_or_default()
    };
    let known_assets: Vec<&str> = mapped
        .figures
        .iter()
        .chain(mapped.tables.iter())
        .map(|entry| entry.id.as_str())
        .collect();
    let known_sections: Vec<&str> = mapped.sections.iter().map(|section| section.id.as_str()).collect();

    let contributions = clean_list("contributions", &mut |item| {
        let text = item.get("text").and_then(Value::as_str)?.trim().to_string();
        if text.is_empty() {
            return None;
        }
        let refs: Vec<String> = clean_refs(item.get("refs"));
        Some(json!({ "text": text, "refs": refs }))
    });
    let key_evidence = clean_list("keyEvidence", &mut |item| {
        let asset_id = item.get("assetId").and_then(Value::as_str)?;
        if !known_assets.contains(&asset_id) {
            warnings.push(format!("map_key_evidence_unknown:{asset_id}"));
            return None;
        }
        let note = item.get("note").and_then(Value::as_str).unwrap_or("").to_string();
        let refs: Vec<String> = clean_refs(item.get("refs"));
        Some(json!({ "assetId": asset_id, "note": note, "refs": refs }))
    });
    let glossary = clean_list("glossary", &mut |item| {
        let term = item.get("term").and_then(Value::as_str)?.trim().to_string();
        let def_ref = item.get("defRef").and_then(Value::as_str)?.trim().to_string();
        if term.is_empty() || def_ref.is_empty() {
            return None;
        }
        Some(json!({ "term": term, "defRef": def_ref }))
    });
    let structure = clean_list("structure", &mut |item| {
        let sec_id = item.get("secId").and_then(Value::as_str)?;
        if !known_sections.contains(&sec_id) {
            warnings.push(format!("map_structure_unknown:{sec_id}"));
            return None;
        }
        Some(item.clone())
    });
    Ok(json!({
        "problem": text_with_refs("problem")?,
        "method": text_with_refs("method")?,
        "contributions": contributions,
        "keyEvidence": key_evidence,
        "glossary": glossary,
        "structure": structure,
    }))
}

/// Markdown 阶段输出校验：四个固定标题齐备（缺失 → 错误观察重试）。
fn validate_markdown_headers(text: &str, headers: &[&str]) -> Result<(), String> {
    let missing: Vec<&str> = headers
        .iter()
        .copied()
        .filter(|header| !text.contains(header))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("输出缺少固定标题：{}", missing.join("、")))
    }
}

// ============================================================================
// 任务运行环境
// ============================================================================

struct ProtocolEnv {
    paper: PaperDto,
    mapped: MappedPaper,
    skills: SkillSet,
    config: model::ModelConfig,
    endpoint: String,
    temperature: f64,
    /// settings 的 maxTokens 配置值（读一次，各阶段按下限抬升后使用）。
    max_tokens: u64,
}

impl ProtocolEnv {
    /// 阶段 max_tokens：配置值抬到阶段下限（防 JSON/长文截断），不超过设置上限。
    fn stage_max_tokens(&self, floor: u64) -> u64 {
        self.max_tokens.max(floor).min(settings::MAX_TOKENS_LIMIT)
    }
}

/// 装配估算超硬顶 → input_too_large（错误即指令：不截断、报错拒绝）。
fn check_hard_top(estimated: u64, stage: &str) -> Result<(), BridgeError> {
    let hard_top = input_token_hard_top();
    if estimated > hard_top {
        return Err(BridgeError::new(
            "input_too_large",
            format!(
                "{stage} 装配后估算输入 {estimated} token，超过模型输入硬顶 {hard_top}（不截断）。\
                 请缩小范围（如分批深挖更少节）或等待后续分档支持。"
            ),
            false,
        )
        .with_details(json!({ "estimatedTokens": estimated, "hardTop": hard_top })));
    }
    Ok(())
}

fn load_env(ctx: &RunContext, paper_id: &str) -> Result<ProtocolEnv, BridgeError> {
    let paper = ctx.library.get_paper(paper_id)?;
    let mapped = load_block_model(&ctx.library, paper_id)?;
    let skills = load_skills(&ctx.library)?;
    let config = model::load_model_config(&ctx.library)?.ok_or_else(model::model_not_configured)?;
    let endpoint = model::normalize_endpoint(&config.base_url, "/chat/completions")?;
    let stored = ctx
        .library
        .get_setting("model")?
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let temperature = stored
        .as_ref()
        .and_then(|value| value.get("temperature"))
        .and_then(Value::as_f64)
        .unwrap_or(tasks::DEFAULT_TEMPERATURE);
    let max_tokens = stored
        .as_ref()
        .and_then(|value| value.get("maxTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(tasks::DEFAULT_MAX_TOKENS);
    Ok(ProtocolEnv {
        paper,
        mapped,
        skills,
        config,
        endpoint,
        temperature,
        max_tokens,
    })
}

// ============================================================================
// paper.build-map@1
// ============================================================================

pub(crate) fn run_build_map(ctx: &RunContext, paper_id: &str, overwrite_confirmed: bool) {
    finish_run(ctx, build_map_main(ctx, paper_id, overwrite_confirmed));
}

/// 深挖开工前齐备检查：全部页图 + 图表清单全部裁切图（#74 B1 / #76：从建图迁来）。
/// 缺失即 preflight_missing，details 列出缺失附件。
fn preflight_visual_assets(ctx: &RunContext, paper_id: &str, mapped: &MappedPaper) -> Result<(), BridgeError> {
    let mut missing: Vec<String> = Vec::new();
    for page in 1..=mapped.page_count {
        let asset_id = pdfassets::page_attachment_id(page);
        if ctx.library.get_attachment(paper_id, &asset_id).is_err() {
            missing.push(asset_id);
        }
    }
    for entry in mapped.figures.iter().chain(mapped.tables.iter()) {
        let asset_id = pdfassets::crop_attachment_id(&entry.id);
        if ctx.library.get_attachment(paper_id, &asset_id).is_err() {
            missing.push(asset_id);
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(BridgeError::new(
        "preflight_missing",
        "页图 / 裁切图尚未预渲染完成，请等待预渲染任务结束后重试",
        false,
    )
    .with_details(json!({ "missing": missing })))
}

/// 调用①分片规划：全文装配估算超阈值时按节贪心打包（保持节序），单节超阈值自成一片；
/// 片内装配仍超硬顶由 check_hard_top 拒绝。
fn plan_l2_shards<'a>(sections: &[&'a Section], base_overhead: u64) -> Vec<Vec<&'a Section>> {
    let budget = shard_token_threshold().saturating_sub(base_overhead).max(1);
    let full: u64 = sections
        .iter()
        .map(|section| estimate_text_tokens(&render_section_text(section)))
        .sum();
    if full <= budget {
        return vec![sections.to_vec()];
    }
    let mut shards: Vec<Vec<&Section>> = Vec::new();
    let mut current: Vec<&Section> = Vec::new();
    let mut current_tokens = 0_u64;
    for section in sections {
        let tokens = estimate_text_tokens(&render_section_text(section));
        if !current.is_empty() && current_tokens + tokens > budget {
            shards.push(std::mem::take(&mut current));
            current_tokens = 0;
        }
        current.push(section);
        current_tokens += tokens;
    }
    if !current.is_empty() {
        shards.push(current);
    }
    shards
}

fn build_map_main(ctx: &RunContext, paper_id: &str, overwrite_confirmed: bool) -> Result<Value, Halt> {
    if ctx.cancel_checkpoint().is_err() {
        return Err(Halt::Cancelled);
    }
    ctx.emit_detail("stage", json!({ "stage": "preflight" }));
    let env = load_env(ctx, paper_id)?;
    if !overwrite_confirmed && product_body(&env.paper, "map", "").is_some() {
        return Err(Halt::Failed(BridgeError::new(
            "already_exists",
            "该论文已有阅读地图：重跑将覆盖现有地图与全部节薄摘要。请在前端确认后带 overwriteConfirmed=true 重新发起。",
            false,
        )));
    }
    let title = env.paper.title.clone();
    let sections = l2_sections(&env.mapped);
    let mut warnings: Vec<String> = env.mapped.warnings.clone();

    // ---- 调用①：全文 → 全部节薄摘要（超阈值按节分片，合并为确定性拼装） ----
    let base_prompt = env.skills.compose(
        STAGE_MAP_L2,
        &[("title", title.as_str()), ("paperText", "")],
        "",
    )?;
    let base_overhead = estimate_text_tokens(&base_prompt);
    let shards = plan_l2_shards(&sections, base_overhead);
    let total_shards = shards.len();
    let mut l2_entries: Vec<Value> = Vec::new();
    for (index, shard) in shards.iter().enumerate() {
        if ctx.cancel_checkpoint().is_err() {
            return persist_build_map_partial(ctx, paper_id, &env, l2_entries, &warnings);
        }
        ctx.emit_detail(
            "stage",
            json!({ "stage": STAGE_MAP_L2, "shard": index + 1, "shards": total_shards }),
        );
        let paper_text = render_paper_text(shard);
        let prompt = env.skills.compose(
            STAGE_MAP_L2,
            &[("title", title.as_str()), ("paperText", paper_text.as_str())],
            "",
        )?;
        check_hard_top(estimate_text_tokens(&prompt), "建图调用①").map_err(Halt::Failed)?;
        let shard_sections = shard.clone();
        let entries = match run_json_call(
            ctx,
            &env,
            "建图调用①",
            prompt,
            env.stage_max_tokens(MIN_MAX_TOKENS_LONG),
            RoundCtx {
                stage: STAGE_MAP_L2,
                part_id: None,
                shard: Some(index as u64 + 1),
            },
            |value| validate_l2_output(value, &shard_sections, &env.mapped, &mut warnings),
        ) {
            Ok(entries) => entries,
            Err(Halt::Cancelled) => {
                return persist_build_map_partial(ctx, paper_id, &env, l2_entries, &warnings)
            }
            Err(other) => return Err(other),
        };
        l2_entries.extend(entries);
        ctx.push_progress(Progress {
            done: index as u64 + 1,
            total: total_shards as u64 + 1,
        });
    }

    // 取消点：调用①已完成、调用②未开始 —— 已产出 L2 按中断部分结果落库
    // （partial: true 标记 + partial 打卡），地图不建。
    if ctx.cancel_checkpoint().is_err() {
        return persist_build_map_partial(ctx, paper_id, &env, l2_entries, &warnings);
    }

    // ---- 调用②：全部 L2 + 图表清单 + 摘要 → L1 阅读地图 ----
    ctx.emit_detail("stage", json!({ "stage": STAGE_MAP_L1 }));
    let abstract_text = env
        .mapped
        .sections
        .iter()
        .find(|section| section.role == SectionRole::Abstract)
        .map(render_section_text)
        .unwrap_or_default();
    let l2_blob = render_l2_blob(&l2_entries);
    let figure_list = render_asset_list(&env.mapped.figures);
    let table_list = render_asset_list(&env.mapped.tables);
    let prompt = env.skills.compose(
        STAGE_MAP_L1,
        &[
            ("title", title.as_str()),
            ("abstract", abstract_text.as_str()),
            ("l2Summaries", l2_blob.as_str()),
            ("figureList", figure_list.as_str()),
            ("tableList", table_list.as_str()),
        ],
        "",
    )?;
    check_hard_top(estimate_text_tokens(&prompt), "建图调用②").map_err(Halt::Failed)?;
    let map_body = match run_json_call(
        ctx,
        &env,
        "建图调用②",
        prompt,
        env.stage_max_tokens(MIN_MAX_TOKENS),
        RoundCtx {
            stage: STAGE_MAP_L1,
            part_id: None,
            shard: None,
        },
        |value| validate_map_output(value, &env.mapped, &mut warnings),
    ) {
        Ok(body) => body,
        Err(Halt::Cancelled) => return persist_build_map_partial(ctx, paper_id, &env, l2_entries, &warnings),
        Err(other) => return Err(other),
    };

    // ---- 落库：map + 全部 l2（一次整记录写入） ----
    let mut updates: Vec<(String, String, Value)> = vec![("map".to_string(), String::new(), map_body)];
    let mut unpersisted: Vec<String> = Vec::new();
    for entry in &l2_entries {
        let sec_id = entry["secId"].as_str().unwrap_or("");
        let section = env
            .mapped
            .sections
            .iter()
            .find(|section| section.id == sec_id)
            .expect("L2 条目已校验为已知节");
        match part_id_for_section(&env.mapped, section) {
            Some(part_id) => updates.push(("l2".to_string(), part_id, entry.clone())),
            None => unpersisted.push(sec_id.to_string()),
        }
    }
    if !unpersisted.is_empty() {
        warnings.push(format!("l2_unpersisted:{}", unpersisted.join(",")));
    }
    persist_products(&ctx.library, paper_id, updates, Some("analysis"))?;
    ctx.push_progress(Progress {
        done: total_shards as u64 + 1,
        total: total_shards as u64 + 1,
    });
    Ok(json!({
        "paperId": paper_id,
        "sections": l2_entries.len() as u64,
        "shards": total_shards as u64,
        "warnings": warnings,
    }))
}

/// 建图取消的 L2 中断部分结果落库（partial 标记 + partial 打卡），任务转 Cancelled。
fn persist_build_map_partial(
    ctx: &RunContext,
    paper_id: &str,
    env: &ProtocolEnv,
    l2_entries: Vec<Value>,
    _warnings: &[String],
) -> Result<Value, Halt> {
    let mut updates: Vec<(String, String, Value)> = Vec::new();
    for entry in l2_entries {
        let sec_id = entry["secId"].as_str().unwrap_or("").to_string();
        let Some(section) = env.mapped.sections.iter().find(|section| section.id == sec_id) else {
            continue;
        };
        let Some(part_id) = part_id_for_section(&env.mapped, section) else {
            continue;
        };
        let mut body = entry;
        body["partial"] = json!(true);
        updates.push(("l2".to_string(), part_id, body));
    }
    if !updates.is_empty() {
        persist_products(&ctx.library, paper_id, updates, Some("partial"))?;
    }
    Err(Halt::Cancelled)
}

// ============================================================================
// 流程控制信号：运行器按此切换终态
// ============================================================================

/// 协议任务内部的中断信号。Cancelled = 轮边界取消检查点命中（终态由运行器转 Cancelled，
/// 给调用方机会先做中断部分结果落库）；Handled = 模型轮终态已由统一重试机器处理
/// （failed / cancelled），运行器直接返回不再发事件；Failed = 业务失败。
enum Halt {
    Cancelled,
    Handled,
    Failed(BridgeError),
}

impl From<BridgeError> for Halt {
    fn from(error: BridgeError) -> Self {
        Halt::Failed(error)
    }
}

// ============================================================================
// 通用「校验调用轮」：模型输出 → 校验（JSON 提取 + 阶段校验 / Markdown 标题校验）；
// 失败以错误观察喂回，连续 MAX_PARSE_FAILURES 次失败按 protocol_parse_failed 收尾
// （错误即指令）。无工具阶段输出含工具调用块同样计入失败。
// 取消在轮边界生效：轮前不发起新轮，轮后不消费已完成轮的输出（决策 3）。
// ============================================================================

fn run_validated_call<T>(
    ctx: &RunContext,
    env: &ProtocolEnv,
    stage_label: &str,
    output_hint: &str,
    prompt: String,
    max_tokens: u64,
    meta: RoundCtx<'_>,
    mut validate: impl FnMut(&str) -> Result<T, String>,
) -> Result<T, Halt> {
    let mut messages = vec![json!({ "role": "user", "content": prompt })];
    let mut consecutive_failures = 0_u32;
    let mut round_no = 0_u32;
    loop {
        if ctx.cancel_checkpoint().is_err() {
            return Err(Halt::Cancelled);
        }
        let round = chat_round_retried(
            ctx,
            &env.config,
            &env.endpoint,
            &messages,
            env.temperature,
            max_tokens,
        )
        .map_err(|_| Halt::Handled)?;
        round_no += 1;
        emit_round(ctx, &meta, round_no, &round);
        // 轮后检查点：在途轮完成时已有取消请求 → 停止且不消费本轮输出（决策 3：
        // 取消 = 当前步完成后停止；建图场景由调用方接住并做中断部分结果落库）。
        if ctx.cancel_checkpoint().is_err() {
            return Err(Halt::Cancelled);
        }
        let failure: Option<String> = match extract_tool_block(&round.text) {
            Some(Ok(_)) => Some(format!(
                "{stage_label}阶段不调用任何工具：不要输出工具调用块（```tool 围栏），{output_hint}"
            )),
            Some(Err(detail)) => Some(detail),
            None => match validate(round.text.trim()) {
                Ok(value) => return Ok(value),
                Err(detail) => Some(detail),
            },
        };
        let mut detail = failure.expect("校验失败必有详情");
        if round.finish_reason.as_deref() == Some("length") {
            detail.push_str("（finish_reason=length，输出疑似被 max_tokens 截断，请精简输出）");
        }
        consecutive_failures += 1;
        if consecutive_failures >= MAX_PARSE_FAILURES {
            return Err(Halt::Failed(BridgeError::new(
                "protocol_parse_failed",
                format!("{stage_label}连续 {MAX_PARSE_FAILURES} 次输出未通过校验，按失败收尾。最后一次：{detail}"),
                true,
            )));
        }
        messages.push(json!({ "role": "assistant", "content": round.text }));
        messages.push(user_message(error_observation("output_invalid", detail).to_string(), Vec::new()));
    }
}

/// JSON 输出阶段封装：先提取 JSON 对象，再交给阶段校验器（返回清理后的产物）。
fn run_json_call<T>(
    ctx: &RunContext,
    env: &ProtocolEnv,
    stage_label: &str,
    prompt: String,
    max_tokens: u64,
    meta: RoundCtx<'_>,
    mut validate: impl FnMut(&Value) -> Result<T, String>,
) -> Result<T, Halt> {
    run_validated_call(
        ctx,
        env,
        stage_label,
        "直接按输出格式只输出一个 JSON 对象。",
        prompt,
        max_tokens,
        meta,
        |text| {
            let value = extract_json_object(text)?;
            validate(&value)
        },
    )
}

/// 三个协议任务运行器共用的终态分派。
fn finish_run(ctx: &RunContext, result: Result<Value, Halt>) {
    match result {
        Ok(result) => ctx.succeed(Some(result)),
        Err(Halt::Cancelled) => ctx.cancel_now(),
        Err(Halt::Handled) => {}
        Err(Halt::Failed(error)) => ctx.fail(error),
    }
}

// ============================================================================
// paper.deep-dive@1：配方打底 + 工具越界取证循环（单节与批量同构）
// ============================================================================

pub(crate) fn run_deep_dive(ctx: &RunContext, paper_id: &str, part_ids: &[String]) {
    finish_run(ctx, deep_dive_main(ctx, paper_id, part_ids));
}

/// 消息序列的输入 token 估算：文本部分按 estimate_text_tokens，图像部分按页图预算
/// （裁切图更小，按页图预算是保守高估）。
fn estimate_messages_tokens(messages: &[Value]) -> u64 {
    let mut total = 0_u64;
    for message in messages {
        match message.get("content") {
            Some(Value::String(text)) => total += estimate_text_tokens(text),
            Some(Value::Array(parts)) => {
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            total += part
                                .get("text")
                                .and_then(Value::as_str)
                                .map(estimate_text_tokens)
                                .unwrap_or(0)
                        }
                        Some("image_url") => total += PAGE_IMAGE_TOKEN_BUDGET,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    total
}

/// 工具轨迹事件载荷：step / 调用形态 / ok / 结果摘要（观察全文不进事件流，只进对话上下文）。
fn tool_event_detail(
    step: u32,
    part_id: &str,
    sec_id: &str,
    name: &str,
    args: &Map<String, Value>,
    outcome: &ToolOutcome,
) -> Value {
    let ok = outcome
        .observation
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut detail = json!({
        "step": step,
        "partId": part_id,
        "secId": sec_id,
        "name": name,
        "args": Value::Object(args.clone()),
        "ok": ok,
    });
    if let Some(result) = outcome.observation.get("result") {
        let summary = match name {
            TOOL_READ_SECTION => json!({
                "blocks": result.get("blocks").and_then(Value::as_array).map(Vec::len),
                "total": result.get("total"),
                "truncated": result.get("footer").map(|footer| !footer.is_null()).unwrap_or(false),
            }),
            TOOL_SEARCH_PAPER => json!({
                "hits": result.get("hits").and_then(Value::as_array).map(Vec::len),
                "truncated": result.get("truncated"),
            }),
            TOOL_GET_FIGURE => json!({
                "cropAssetId": result.get("cropAssetId"),
                "page": result.get("page"),
            }),
            TOOL_GET_PAGE_IMAGE => json!({
                "page": result.get("page"),
                "assetId": result.get("assetId"),
            }),
            _ => Value::Null,
        };
        detail["result"] = summary;
    }
    if let Some(error) = outcome.observation.get("error") {
        detail["error"] = error.clone();
    }
    detail
}

/// 单节深挖：初始上下文 = L1 全带 + L2 全带 + 当前节原文全送 + 当前节页图 ±1；
/// 循环至无工具调用块（完成）/ 步数上限 / 连续解析失败 / 取消。
fn dive_section(
    ctx: &RunContext,
    env: &ProtocolEnv,
    part_id: &str,
    section: &Section,
    warnings: &mut Vec<String>,
) -> Result<String, Halt> {
    let l2_bodies: Vec<Value> = env
        .paper
        .products
        .iter()
        .filter(|product| product.kind == "l2")
        .map(|product| product.body.clone())
        .collect();
    let map_body = product_body(&env.paper, "map", "")
        .cloned()
        .ok_or_else(|| Halt::Failed(map_required_error()))?;
    let section_type = product_body(&env.paper, "l2", part_id)
        .and_then(|body| body.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("part")
        .to_string();
    let section_text = render_section_text(section);
    let section_pages = if section.page_start == section.page_end {
        format!("p{}", section.page_start)
    } else {
        format!("p{}-p{}", section.page_start, section.page_end)
    };
    let prompt = env.skills.compose(
        STAGE_DEEP_DIVE,
        &[
            ("title", env.paper.title.as_str()),
            ("map", render_map_blob(&map_body).as_str()),
            ("l2Summaries", render_l2_blob(&l2_bodies).as_str()),
            ("sectionId", section.id.as_str()),
            ("sectionTitle", section.title.as_str()),
            ("sectionType", section_type.as_str()),
            ("sectionText", section_text.as_str()),
            ("sectionPages", section_pages.as_str()),
        ],
        &section_type,
    )?;
    // 当前节页图 ±1 页随消息附图；附件缺失跳过并记 warning（文本层是忠实性构造保证，
    // 页图是补充通道）。
    let mut images: Vec<Vec<u8>> = Vec::new();
    let first = section.page_start.saturating_sub(1).max(1);
    let last = (section.page_end + 1).min(env.mapped.page_count);
    for page in first..=last {
        let asset_id = pdfassets::page_attachment_id(page);
        match read_attachment_bytes(&ctx.library, &env.paper.id, &asset_id) {
            Some(bytes) => images.push(bytes),
            None => warnings.push(format!("page_image_missing:{asset_id}")),
        }
    }
    let estimated = estimate_text_tokens(&prompt) + images.len() as u64 * PAGE_IMAGE_TOKEN_BUDGET;
    check_hard_top(estimated, "深挖初始配方").map_err(Halt::Failed)?;

    let mut messages = vec![user_message(prompt.clone(), images)];
    // 首条消息的 text 段即配方提示词；图像为当前节页图 ±1 页。
    let mut steps = 0_u32;
    let mut consecutive_failures = 0_u32;
    let mut round_no = 0_u32;
    let round_meta = RoundCtx {
        stage: STAGE_DEEP_DIVE,
        part_id: Some(part_id),
        shard: None,
    };
    loop {
        // 轮边界取消检查点（决策 3：取消 = 当前步完成后停止）。
        if ctx.cancel_checkpoint().is_err() {
            return Err(Halt::Cancelled);
        }
        check_hard_top(estimate_messages_tokens(&messages), "深挖工具循环").map_err(Halt::Failed)?;
        let round = chat_round_retried(
            ctx,
            &env.config,
            &env.endpoint,
            &messages,
            env.temperature,
            env.stage_max_tokens(MIN_MAX_TOKENS),
        )
        .map_err(|_| Halt::Handled)?;
        round_no += 1;
        emit_round(ctx, &round_meta, round_no, &round);
        // 轮后检查点：在途轮完成时已有取消请求 → 停止，不执行工具、不消费输出。
        if ctx.cancel_checkpoint().is_err() {
            return Err(Halt::Cancelled);
        }
        match parse_round_output(&round.text) {
            Err(detail) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_PARSE_FAILURES {
                    return Err(Halt::Failed(BridgeError::new(
                        "protocol_parse_failed",
                        format!("深挖连续 {MAX_PARSE_FAILURES} 次工具调用块解析失败，按失败收尾。最后一次：{detail}"),
                        true,
                    )));
                }
                messages.push(json!({ "role": "assistant", "content": round.text }));
                messages.push(user_message(
                    error_observation(
                        "parse_failed",
                        format!("{detail}。请按纪律重新输出：一轮一个 ```tool 围栏块（一个 JSON 对象），或不带工具调用块直接给出四段式深挖结果。"),
                    ).to_string(),
                    Vec::new(),
                ));
            }
            Ok(RoundParse::Final(text)) => {
                match validate_markdown_headers(&text, &DEEP_DIVE_HEADERS) {
                    Ok(()) => return Ok(text),
                    Err(detail) => {
                        consecutive_failures += 1;
                        if consecutive_failures >= MAX_PARSE_FAILURES {
                            return Err(Halt::Failed(BridgeError::new(
                                "protocol_parse_failed",
                                format!("深挖连续 {MAX_PARSE_FAILURES} 次输出未通过校验，按失败收尾。最后一次：{detail}"),
                                true,
                            )));
                        }
                        messages.push(json!({ "role": "assistant", "content": round.text }));
                        messages.push(user_message(
                            error_observation(
                                "output_invalid",
                                format!("{detail}。最终输出为 Markdown，四段标题固定：## 核心论点 / ## 关键细节 / ## 与全局的关系 / ## 边界与存疑。"),
                            ).to_string(),
                            Vec::new(),
                        ));
                    }
                }
            }
            Ok(RoundParse::ToolCall { name, args }) => {
                consecutive_failures = 0;
                if steps >= MAX_TOOL_STEPS {
                    return Err(Halt::Failed(BridgeError::new(
                        "step_limit_exceeded",
                        format!(
                            "深挖工具循环已达步数上限 {MAX_TOOL_STEPS}，按失败收尾；已完成的其它部分结果已保留。\
                             可提高提问针对性后重新发起本节深挖。"
                        ),
                        true,
                    )));
                }
                steps += 1;
                let outcome = execute_tool(&ctx.library, &env.paper.id, &env.mapped, &name, &args);
                ctx.emit_detail("tool", tool_event_detail(steps, part_id, &section.id, &name, &args, &outcome));
                messages.push(json!({ "role": "assistant", "content": round.text }));
                messages.push(user_message(outcome.observation.to_string(), outcome.images));
            }
        }
    }
}

fn map_required_error() -> BridgeError {
    BridgeError::new(
        "map_required",
        "该论文尚未建图：请先运行建图（paper.build-map@1），再发起深挖/综合。",
        false,
    )
}

fn deep_dive_main(ctx: &RunContext, paper_id: &str, part_ids: &[String]) -> Result<Value, Halt> {
    if ctx.cancel_checkpoint().is_err() {
        return Err(Halt::Cancelled);
    }
    let env = load_env(ctx, paper_id)?;
    if product_body(&env.paper, "map", "").is_none() {
        return Err(Halt::Failed(map_required_error()));
    }
    preflight_visual_assets(ctx, paper_id, &env.mapped)?;
    // partIds 校验与节映射：未知部分 / 无法映射 / 缺薄摘要都在开工前拒绝（错误即指令）。
    let mut targets: Vec<(&String, &Section)> = Vec::with_capacity(part_ids.len());
    for part_id in part_ids {
        if !env.paper.parts.iter().any(|part| part.id == *part_id) {
            return Err(Halt::Failed(BridgeError::invalid_input(format!(
                "未知的精读部分: {part_id}"
            ))));
        }
        let section = section_for_part(&env.mapped, part_id).ok_or_else(|| {
            Halt::Failed(BridgeError::invalid_input(format!(
                "精读部分 {part_id} 没有对应的块模型节（部分集合与块模型节数不一致），无法深挖"
            )))
        })?;
        if product_body(&env.paper, "l2", part_id).is_none() {
            return Err(Halt::Failed(BridgeError::new(
                "l2_missing",
                format!("部分 {part_id} 尚无薄摘要（建图可能未完成或被取消）：请先完成建图。"),
                false,
            )));
        }
        targets.push((part_id, section));
    }
    let total = targets.len() as u64;
    let mut completed: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = env.mapped.warnings.clone();
    for (index, (part_id, section)) in targets.iter().enumerate() {
        if ctx.cancel_checkpoint().is_err() {
            // 批量取消：不再推进下一节；已完成节的产物已逐节落库保留。
            return Err(Halt::Cancelled);
        }
        ctx.emit_detail(
            "stage",
            json!({
                "stage": STAGE_DEEP_DIVE,
                "partId": part_id,
                "secId": section.id,
                "title": section.title,
                "index": index as u64 + 1,
                "total": total,
            }),
        );
        let markdown = dive_section(ctx, &env, part_id, section, &mut warnings)?;
        // 逐节完成逐节落库（完整结果计 analysis 打卡）。
        persist_products(
            &ctx.library,
            paper_id,
            vec![("dig".to_string(), (*part_id).clone(), json!(markdown))],
            Some("analysis"),
        )?;
        completed.push((*part_id).clone());
        ctx.push_progress(Progress {
            done: index as u64 + 1,
            total,
        });
    }
    Ok(json!({
        "paperId": paper_id,
        "completed": completed,
        "warnings": warnings,
    }))
}

// ============================================================================
// paper.synthesize@1：L1 + 全部 L2 + 已有深挖 → 复述稿（手动触发）
// ============================================================================

pub(crate) fn run_synthesize(ctx: &RunContext, paper_id: &str, overwrite_confirmed: bool) {
    finish_run(ctx, synthesize_main(ctx, paper_id, overwrite_confirmed));
}

/// 复述稿的深挖材料拼装：按节阅读顺序排列，标注部分身份与节标题。
fn render_dig_blob(paper: &PaperDto, mapped: &MappedPaper) -> String {
    let mut entries: Vec<(usize, String)> = Vec::new();
    for product in paper.products.iter().filter(|product| product.kind == "dig") {
        let order = section_for_part(mapped, &product.part_id)
            .and_then(|section| mapped.sections.iter().position(|s| s.id == section.id))
            .unwrap_or(usize::MAX);
        let title = paper
            .parts
            .iter()
            .find(|part| part.id == product.part_id)
            .and_then(|part| part.title.clone())
            .unwrap_or_default();
        let body = product.body.as_str().unwrap_or_default().to_string();
        entries.push((order, format!("### {}（{}）\n{}", product.part_id, title, body)));
    }
    entries.sort_by_key(|(order, _)| *order);
    if entries.is_empty() {
        return "（尚无深挖结果）".to_string();
    }
    entries
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn synthesize_main(ctx: &RunContext, paper_id: &str, overwrite_confirmed: bool) -> Result<Value, Halt> {
    if ctx.cancel_checkpoint().is_err() {
        return Err(Halt::Cancelled);
    }
    ctx.emit_detail("stage", json!({ "stage": STAGE_SYNTHESIZE }));
    let env = load_env(ctx, paper_id)?;
    let map_body = match product_body(&env.paper, "map", "") {
        Some(body) => body.clone(),
        None => return Err(Halt::Failed(map_required_error())),
    };
    if !overwrite_confirmed && product_body(&env.paper, "retell", "").is_some() {
        return Err(Halt::Failed(BridgeError::new(
            "already_exists",
            "该论文已有复述稿：重跑将覆盖现有复述稿。请在前端确认后带 overwriteConfirmed=true 重新发起。",
            false,
        )));
    }
    // L2 按节阅读顺序排列（产物表按 kind+part_id 字典序，不是阅读顺序）。
    let mut l2_bodies: Vec<Value> = env
        .paper
        .products
        .iter()
        .filter(|product| product.kind == "l2")
        .map(|product| product.body.clone())
        .collect();
    let section_order = |body: &Value| {
        let sec_id = body.get("secId").and_then(Value::as_str).unwrap_or("");
        env.mapped
            .sections
            .iter()
            .position(|section| section.id == sec_id)
            .unwrap_or(usize::MAX)
    };
    l2_bodies.sort_by_key(|body| section_order(body));
    let dig_blob = render_dig_blob(&env.paper, &env.mapped);
    let prompt = env.skills.compose(
        STAGE_SYNTHESIZE,
        &[
            ("title", env.paper.title.as_str()),
            ("map", render_map_blob(&map_body).as_str()),
            ("l2Summaries", render_l2_blob(&l2_bodies).as_str()),
            ("digResults", dig_blob.as_str()),
        ],
        "",
    )?;
    check_hard_top(estimate_text_tokens(&prompt), "复述稿装配").map_err(Halt::Failed)?;

    // 复述稿是 Markdown 输出阶段（不调用工具），校验 = 四个固定标题齐备。
    let markdown = run_validated_call(
        ctx,
        &env,
        "复述稿",
        "直接按「问题 → 方法 → 证据 → 边界」产出复述稿。",
        prompt,
        env.stage_max_tokens(MIN_MAX_TOKENS_LONG),
        RoundCtx {
            stage: STAGE_SYNTHESIZE,
            part_id: None,
            shard: None,
        },
        |text| {
            validate_markdown_headers(text, &SYNTHESIZE_HEADERS).map(|_| text.to_string())
        },
    )?;
    persist_products(
        &ctx.library,
        paper_id,
        vec![("retell".to_string(), String::new(), json!(markdown))],
        Some("analysis"),
    )?;
    Ok(json!({
        "paperId": paper_id,
        "chars": markdown.chars().count() as u64,
    }))
}


// ============================================================================
// 单元测试（纯函数：token 估算、工具块解析、输出校验、分片规划、工具窗口/采样）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfmap::{AssetEntry, Block, BlockKind, ReferenceEntry, Subsection};

    fn block(id: u32, page: u32, text: &str) -> Block {
        Block {
            id,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            page,
            y: 0.0,
            bbox: None,
            level: None,
            asset_id: None,
            caption: None,
            latex: None,
        }
    }

    fn section(id: &str, ordinal: u32, role: SectionRole, page_start: u32, page_end: u32, blocks: Vec<Block>) -> Section {
        Section {
            id: id.to_string(),
            ordinal,
            title: format!("Title of {id}"),
            number: None,
            role,
            page_start,
            page_end,
            blocks,
            subsections: vec![Subsection {
                number: Some(format!("{ordinal}.1")),
                title: "子节".to_string(),
                level: 2,
                block_start: 1,
                block_end: 2,
                page_start,
                page_end,
            }],
        }
    }

    fn sample_mapped() -> MappedPaper {
        MappedPaper {
            schema_version: 1,
            title: Some("样例论文".to_string()),
            source_name: None,
            page_count: 3,
            sections: vec![
                section("sec_1_abstract", 1, SectionRole::Abstract, 1, 1, vec![block(1, 1, "摘要文本")]),
                section(
                    "sec_2_introduction",
                    2,
                    SectionRole::Body,
                    1,
                    2,
                    vec![block(1, 1, "引言第一段"), block(2, 2, "引言第二段 attention"), block(3, 2, "引言第三段")],
                ),
                section(
                    "sec_3_method",
                    3,
                    SectionRole::Body,
                    2,
                    3,
                    vec![block(1, 2, "方法第一段 attention"), block(2, 3, "方法第二段")],
                ),
                section("sec_4_references", 4, SectionRole::References, 3, 3, vec![block(1, 3, "[1] 文献")]),
            ],
            frontmatter: Vec::new(),
            furniture: Vec::new(),
            figures: vec![AssetEntry {
                id: "fig_1".to_string(),
                number: "1".to_string(),
                caption: Some("架构图".to_string()),
                page: 2,
                bbox: [0.0, 0.0, 100.0, 100.0],
                section: Some("sec_2_introduction".to_string()),
                references: vec![crate::pdfmap::Citation { sec_id: "sec_2_introduction".to_string(), block_id: 2, page: 2 }],
            }],
            tables: vec![AssetEntry {
                id: "tbl_1".to_string(),
                number: "1".to_string(),
                caption: Some("结果表".to_string()),
                page: 3,
                bbox: [0.0, 0.0, 100.0, 100.0],
                section: Some("sec_3_method".to_string()),
                references: Vec::new(),
            }],
            references: vec![ReferenceEntry { id: "ref_1".to_string(), number: 1, text: "[1] 文献".to_string(), cited_at: Vec::new() }],
            warnings: Vec::new(),
        }
    }

    #[test]
    fn estimate_text_tokens_counts_cjk_and_ascii() {
        // 4 个 CJK 字符 ≈ 4 token；8 个 ASCII 字符 ≈ 2 token。
        assert_eq!(estimate_text_tokens("深度解读"), 4);
        assert_eq!(estimate_text_tokens("abcdefgh"), 2);
        assert_eq!(estimate_text_tokens("深a度b"), 3);
        assert_eq!(estimate_text_tokens(""), 0);
    }

    #[test]
    fn tool_block_parse_accepts_valid_call() {
        let text = "先取图。\n```tool\n{\"name\": \"get_figure\", \"args\": {\"fig_id\": \"fig_1\"}}\n```\n";
        let parsed = parse_round_output(text).expect("合法调用块");
        match parsed {
            RoundParse::ToolCall { name, args } => {
                assert_eq!(name, "get_figure");
                assert_eq!(args["fig_id"], json!("fig_1"));
            }
            other => panic!("应解析为工具调用: {other:?}"),
        }
    }

    #[test]
    fn tool_block_parse_rejects_bad_shapes() {
        // 围栏未闭合
        assert!(parse_round_output("```tool\n{\"name\": \"get_figure\"").is_err());
        // JSON 非法
        assert!(parse_round_output("```tool\n{not json}\n```").is_err());
        // 未知工具
        assert!(parse_round_output("```tool\n{\"name\": \"hack\", \"args\": {}}\n```").is_err());
        // 缺参数
        assert!(parse_round_output("```tool\n{\"name\": \"get_figure\", \"args\": {}}\n```").is_err());
        // args 非对象
        assert!(parse_round_output("```tool\n{\"name\": \"search_paper\", \"args\": \"x\"}\n```").is_err());
        // read_section offset 非法
        assert!(parse_round_output("```tool\n{\"name\": \"read_section\", \"args\": {\"sec_id\": \"sec_2_introduction\", \"offset\": 0}}\n```").is_err());
    }

    #[test]
    fn no_tool_block_is_final() {
        let parsed = parse_round_output("## 核心论点\n……").expect("无调用块即完成");
        assert!(matches!(parsed, RoundParse::Final(text) if text.starts_with("## 核心论点")));
    }

    #[test]
    fn read_section_window_caps_chars_and_points_to_page_image() {
        let mapped = sample_mapped();
        // 窗口覆盖前两块（offset=1, limit=2）：footer 指向第 3 块所在页。
        let args = json!({"sec_id": "sec_2_introduction", "offset": 1, "limit": 2}).as_object().unwrap().clone();
        let outcome = exec_read_section(&mapped, &args);
        assert_eq!(outcome.observation["ok"], json!(true));
        let result = &outcome.observation["result"];
        assert_eq!(result["total"], json!(3));
        assert_eq!(result["blocks"].as_array().unwrap().len(), 2);
        assert_eq!(result["blocks"][0]["id"], json!(1));
        assert_eq!(result["blocks"][0]["prov"]["page"], json!(1));
        assert!(
            result["footer"].as_str().unwrap_or("").contains("第 2 页页图"),
            "footer 应指向续读页图: {}",
            result["footer"]
        );
        // 无截断时 footer 为 null。
        let args = json!({"sec_id": "sec_2_introduction", "offset": 1, "limit": 40}).as_object().unwrap().clone();
        let outcome = exec_read_section(&mapped, &args);
        assert!(outcome.observation["result"]["footer"].is_null());
        // 无效地址 = 结构化错误观察。
        let args = json!({"sec_id": "sec_9_nope"}).as_object().unwrap().clone();
        let outcome = exec_read_section(&mapped, &args);
        assert_eq!(outcome.observation["ok"], json!(false));
        assert_eq!(outcome.observation["error"]["code"], json!("unknown_section"));
        // offset 越界。
        let args = json!({"sec_id": "sec_2_introduction", "offset": 99}).as_object().unwrap().clone();
        let outcome = exec_read_section(&mapped, &args);
        assert_eq!(outcome.observation["error"]["code"], json!("offset_out_of_range"));
    }

    #[test]
    fn search_paper_returns_pointers_only() {
        let mapped = sample_mapped();
        let args = json!({"pattern": "attention"}).as_object().unwrap().clone();
        let outcome = exec_search_paper(&mapped, &args);
        assert_eq!(outcome.observation["ok"], json!(true));
        let hits = outcome.observation["result"]["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["secId"], json!("sec_2_introduction"));
        assert_eq!(hits[0]["blockId"], json!(2));
        assert_eq!(hits[0]["page"], json!(2));
        assert_eq!(hits[0]["subsection"], json!("2.1 子节"));
        assert_eq!(outcome.observation["result"]["truncated"], json!(false));
        // 命中不存在 → 空清单。
        let args = json!({"pattern": "不存在的词"}).as_object().unwrap().clone();
        let outcome = exec_search_paper(&mapped, &args);
        assert_eq!(outcome.observation["result"]["hits"], json!([]));
    }

    #[test]
    fn part_section_mapping_is_order_based() {
        let mapped = sample_mapped();
        assert_eq!(section_for_part(&mapped, "abstract").map(|s| s.id.as_str()), Some("sec_1_abstract"));
        assert_eq!(section_for_part(&mapped, "part-1").map(|s| s.id.as_str()), Some("sec_2_introduction"));
        assert_eq!(section_for_part(&mapped, "part-2").map(|s| s.id.as_str()), Some("sec_3_method"));
        assert!(section_for_part(&mapped, "part-3").is_none());
        assert!(section_for_part(&mapped, "part-0").is_none());
        let sec2 = &mapped.sections[1];
        assert_eq!(part_id_for_section(&mapped, sec2).as_deref(), Some("part-1"));
        // References 节不进内容节映射。
        let refs = &mapped.sections[3];
        assert!(part_id_for_section(&mapped, refs).is_none());
    }

    #[test]
    fn l2_output_validation_enforces_coverage_and_cleanup() {
        let mapped = sample_mapped();
        let shard: Vec<&Section> = mapped.sections[1..=2].iter().collect();
        let mut warnings = Vec::new();
        let output = json!({
            "sections": [
                { "secId": "sec_3_method", "type": "方法", "gist": "方法节主旨",
                  "points": [{"text": "要点", "refs": ["(p2)"]}], "keyAssets": ["tbl_1", "tbl_9"] },
                { "secId": "sec_2_introduction", "type": "introduction", "gist": "引言主旨",
                  "points": [{"text": "要点", "refs": []}], "keyAssets": ["fig_1"] }
            ]
        });
        let entries = validate_l2_output(&output, &shard, &mapped, &mut warnings).expect("校验通过");
        // 按分片节序重排（输入先 method 后 introduction）。
        assert_eq!(entries[0]["secId"], json!("sec_2_introduction"));
        assert_eq!(entries[1]["secId"], json!("sec_3_method"));
        // type 回退 part；keyAssets 过滤未知 id；title/pages 以块模型为准。
        assert_eq!(entries[1]["type"], json!("part"));
        assert_eq!(entries[1]["keyAssets"], json!(["tbl_1"]));
        assert_eq!(entries[0]["title"], json!("Title of sec_2_introduction"));
        assert_eq!(entries[0]["pages"], json!({"start": 1, "end": 2}));
        assert!(warnings.iter().any(|w| w.starts_with("l2_type_fallback")));
        assert!(warnings.iter().any(|w| w.starts_with("l2_key_asset_unknown")));
        // 覆盖缺口 → 错误。
        let missing = json!({"sections": [output["sections"][0].clone()]});
        assert!(validate_l2_output(&missing, &shard, &mapped, &mut warnings).is_err());
        // 分片外的节 → 错误。
        let foreign = json!({"sections": [
            output["sections"][0].clone(),
            output["sections"][1].clone(),
            { "secId": "sec_1_abstract", "gist": "x", "points": [{"text": "y", "refs": []}] }
        ]});
        assert!(validate_l2_output(&foreign, &shard, &mapped, &mut warnings).is_err());
    }

    #[test]
    fn map_output_validation_drops_unknown_entities() {
        let mapped = sample_mapped();
        let mut warnings = Vec::new();
        let output = json!({
            "problem": {"text": "问题", "refs": ["(p1)"]},
            "method": {"text": "方法", "refs": []},
            "contributions": [{"text": "贡献", "refs": []}],
            "keyEvidence": [{"assetId": "fig_1", "note": "关键", "refs": []}, {"assetId": "fig_9", "note": "假", "refs": []}],
            "glossary": [{"term": "术语", "defRef": "(sec_2:L1-2)"}],
            "structure": [{"secId": "sec_2_introduction"}, {"secId": "sec_9_nope"}]
        });
        let map = validate_map_output(&output, &mapped, &mut warnings).expect("校验通过");
        assert_eq!(map["keyEvidence"].as_array().unwrap().len(), 1);
        assert_eq!(map["structure"].as_array().unwrap().len(), 1);
        assert!(warnings.iter().any(|w| w.starts_with("map_key_evidence_unknown")));
        assert!(warnings.iter().any(|w| w.starts_with("map_structure_unknown")));
        // 缺 problem → 错误。
        let broken = json!({"method": {"text": "x", "refs": []}});
        assert!(validate_map_output(&broken, &mapped, &mut warnings).is_err());
    }

    #[test]
    fn extract_json_object_tolerates_fences_and_prose() {
        let plain = extract_json_object("{\"a\": 1}").unwrap();
        assert_eq!(plain["a"], json!(1));
        let fenced = extract_json_object("前置说明
```json
{\"a\": 2}
```
后置").unwrap();
        assert_eq!(fenced["a"], json!(2));
        let braced = extract_json_object("输出：{\"a\": 3} 以上").unwrap();
        assert_eq!(braced["a"], json!(3));
        assert!(extract_json_object("没有对象").is_err());
    }

    #[test]
    fn markdown_header_validation() {
        let ok = "## 核心论点
a
## 关键细节
b
## 与全局的关系
c
## 边界与存疑
d";
        assert!(validate_markdown_headers(ok, &DEEP_DIVE_HEADERS).is_ok());
        assert!(validate_markdown_headers("## 核心论点
a", &DEEP_DIVE_HEADERS).is_err());
    }

    #[test]
    fn shard_planning_packs_sections_under_budget() {
        let mapped = sample_mapped();
        let sections = l2_sections(&mapped);
        // 预算充足 → 单片。
        let shards = plan_l2_shards(&sections, 0);
        assert_eq!(shards.len(), 1);
        assert_eq!(shards[0].len(), sections.len());
    }
}
