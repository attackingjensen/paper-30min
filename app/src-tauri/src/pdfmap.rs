//! DoclingDocument → 块模型映射层（Issue #58，规格 #48 §实施决策 6–12）。
//!
//! 纯函数：输入侧车产出的 DoclingDocument 无损 JSON（pdfparse.convert@1 的
//! docling.json），输出 MD 块模型 + 三清单（图/表/参考文献）。地址空间与出处
//! 语法以 #41 决议为准：节 `sec_{n}_{slug}`、节内块从 1 编号、`fig_`/`tbl_`
//! ID 从图注编号派生（漏检不漂移）、`ref_` 按条目顺序补号；prov 统一换算为
//! pdf.js 视口坐标（左上原点，scale=2，与 144dpi 页图逐像素一致）。
//!
//! 实测前提（#46 验证报告与固化 fixture 核对）：
//! - 阅读顺序 = body 树 DFS；groups 递归展开，picture/table 不展开 children
//!   （图内文字碎片与图注挂在图表节点下，展开会污染正文流；表格单元格碎片
//!   同理由 tables 集合优先替代 —— 决策 8）。
//! - 附录区误判标题（如 "Attention Visualizations Input-Input Layer5"）实测为
//!   picture children 或未挂树孤儿，上述遍历天然过滤；流内残留误判
//!   （如 BERT "· Batch size : 16, 32"）按列表符号开头规则降级为段落。
//! - Docling 2.126 的 section_header.level 恒为 1 不可用；层级由编号模式
//!   （阿拉伯/罗马体系）+ 白名单 + 字高回退判定（Science 式无编号论文）。
//! - 参考文献条目的 [n] 前缀在 text 中被吞、orig 中保留；编号引用制按顺序
//!   补号，无编号文献表不建 ref 条目（诚实档）。

use crate::error::BridgeError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 映射输出契约版本（形状变更时递增）。
pub const PDFMAP_SCHEMA_VERSION: u32 = 1;

/// pdf.js 视口缩放：块坐标 = PDF pt × 2（144dpi 页图逐像素一致）。
const VIEWPORT_SCALE: f64 = 2.0;

// ============================================================================
// 输出契约（#41 地址空间 + #55 工具消费形状；JSON 一律 camelCase）
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MappedPaper {
    pub schema_version: u32,
    /// 论文题目（首页首个标题块；识别不到为 None 并记 warning）。
    pub title: Option<String>,
    /// DoclingDocument 的 name（来源文件名，溯源用）。
    pub source_name: Option<String>,
    pub page_count: u32,
    pub sections: Vec<Section>,
    /// 首节标题之前的正文块（作者行、机构等）：保留可追回，不进地址空间。
    pub frontmatter: Vec<Block>,
    /// furniture 桶：页眉页脚剔除但保留（决策 6）。
    pub furniture: Vec<FurnitureItem>,
    /// 三清单：图 / 表 / 参考文献。
    pub figures: Vec<AssetEntry>,
    pub tables: Vec<AssetEntry>,
    pub references: Vec<ReferenceEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub ordinal: u32,
    pub title: String,
    /// 节编号（"3" / "A"），无编号为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub role: SectionRole,
    pub page_start: u32,
    pub page_end: u32,
    pub blocks: Vec<Block>,
    /// 小节索引（提示性元数据，错漏不污染地址空间）。
    pub subsections: Vec<Subsection>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SectionRole {
    Abstract,
    Body,
    References,
    Acknowledgments,
    Appendix,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    /// 节内块编号，从 1 开始（出处语法 L{n} 的 n）。
    pub id: u32,
    pub kind: BlockKind,
    /// MD 形态：段落原文 / 小节标题 / `[图 fig_n]` / 表格 MD / `[公式]` / 脚注。
    pub text: String,
    /// 首页页码（跨页块记首页）。
    pub page: u32,
    /// 首页 bbox 顶边的 pdf.js 视口 y（scale=2）。
    pub y: f64,
    /// 图/表/公式块的页内 bbox [x, y, w, h]（pdf.js 视口坐标，供裁切）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
    /// 小节标题块的层级（2 起）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u32>,
    /// 图表块关联的清单 ID（fig_3 / tbl_2；无编号不进清单则为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// 图注/表注全文（CAPTION 并入所属块，不独立成块）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// 公式 LaTeX（仅 enrichment 开启时存在；以裁切图为准）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latex: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    Paragraph,
    Heading,
    Figure,
    Table,
    Formula,
    Footnote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subsection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub title: String,
    pub level: u32,
    pub block_start: u32,
    pub block_end: u32,
    pub page_start: u32,
    pub page_end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    /// fig_{n} / tbl_{n}，编号从图注派生。
    pub id: String,
    pub number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    pub page: u32,
    /// 页内 bbox（pdf.js 视口坐标），裁切图依据。
    pub bbox: [f64; 4],
    /// 归属节（最近前驱节标题）；首节之前出现为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// 正文引用处（"Figure 3" 形态扫描）。
    pub references: Vec<Citation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceEntry {
    /// ref_{n}，n = 条目在文献表中的顺序（编号引用制下顺序即编号）。
    pub id: String,
    pub number: u32,
    /// 条目文本（含补回的 [n] 前缀）。
    pub text: String,
    /// 正文被引用处（[n] 形态扫描）。
    pub cited_at: Vec<Citation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub sec_id: String,
    pub block_id: u32,
    pub page: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FurnitureItem {
    pub label: String,
    pub text: String,
    pub page: u32,
}

// ============================================================================
// 入口
// ============================================================================

pub fn map_docling_json_str(text: &str) -> Result<MappedPaper, BridgeError> {
    let doc: Value = serde_json::from_str(text).map_err(|err| {
        BridgeError::new(
            "docling_json_invalid",
            format!("DoclingDocument JSON 解析失败: {err}"),
            false,
        )
    })?;
    map_docling_document(&doc)
}

pub fn map_docling_json_file(path: &Path) -> Result<MappedPaper, BridgeError> {
    let text = std::fs::read_to_string(path).map_err(|err| {
        BridgeError::new(
            "docling_json_invalid",
            format!("DoclingDocument 读取失败 {}: {err}", path.display()),
            false,
        )
    })?;
    map_docling_json_str(&text)
}

pub fn map_docling_document(doc: &Value) -> Result<MappedPaper, BridgeError> {
    if doc.get("schema_name").and_then(Value::as_str) != Some("DoclingDocument") {
        return Err(BridgeError::new(
            "docling_json_invalid",
            "不是 DoclingDocument JSON（schema_name 缺失或不匹配）",
            false,
        ));
    }
    let collections = Collections::parse(doc)?;
    let mut stream = collect_stream(doc, &collections);
    let fragment_count = mark_fragments(&mut stream);
    let headings = classify_headings(&stream);
    let (asset_captions, claimed_captions) = resolve_captions(&collections, &stream);

    let mut warnings = Vec::new();
    if fragment_count > 0 {
        warnings.push(format!("figure_text_fragments_dropped:{fragment_count}"));
    }
    let mut title: Option<String> = None;
    let mut frontmatter: Vec<PendingBlock> = Vec::new();
    let mut furniture: Vec<FurnitureItem> = Vec::new();
    let mut sections: Vec<SectionBuilt> = Vec::new();
    let mut figures: Vec<AssetEntry> = Vec::new();
    let mut tables: Vec<AssetEntry> = Vec::new();
    let mut references: Vec<ReferenceEntry> = Vec::new();

    for (idx, item) in stream.iter().enumerate() {
        if item.is_fragment {
            // 图内/表内文字碎片：不进块流（图表区域已由图/表块代表）。
            continue;
        }
        if item.is_furniture {
            furniture.push(FurnitureItem {
                label: item.label.clone(),
                text: item.text.trim().to_string(),
                page: item.page.unwrap_or(0),
            });
            continue;
        }
        // 被回退聚类认领的游离 caption 并入所属图/表块，不独立成块（决策 6）。
        if let StreamSource::Text(text_idx) = item.source {
            if item.label == "caption" && claimed_captions.contains(&text_idx) {
                continue;
            }
        }
        if let Some(verdict) = &headings[idx] {
            if verdict.is_title {
                title = Some(item.text.trim().to_string());
                continue;
            }
            if !verdict.demoted && verdict.level == 1 {
                sections.push(SectionBuilt {
                    id: String::new(), // 节序确定后回填
                    ordinal: 0,
                    title: item.text.trim().to_string(),
                    number: verdict.number.clone(),
                    role: verdict.role,
                    page_start: item.page.unwrap_or(0),
                    page_end: item.page.unwrap_or(0),
                    blocks: Vec::new(),
                });
                continue;
            }
        }
        let Some(pending) = make_block(
            &collections,
            idx,
            item,
            headings[idx].as_ref(),
            &asset_captions,
        ) else {
            continue;
        };
        // 决策 13：LaTeX 必附裁切图（bbox 缺失时 latex 失去校验依据，记 warning）。
        if pending.block.kind == BlockKind::Formula
            && pending.block.latex.is_some()
            && pending.block.bbox.is_none()
        {
            warnings.push("formula_latex_without_bbox".to_string());
        }
        match sections.last_mut() {
            Some(section) => {
                if let Some(page) = item.page {
                    if section.page_start == 0 {
                        section.page_start = page;
                    }
                    section.page_end = page;
                }
                section.blocks.push(pending);
            }
            None => frontmatter.push(pending),
        }
    }

    // 防御：全文无一级节（极端版式）时以单一兜底节承载，不留空块模型。
    if sections.is_empty() && !frontmatter.is_empty() {
        let blocks = std::mem::take(&mut frontmatter);
        let page_start = blocks.first().map(|b| b.block.page).unwrap_or(0);
        let page_end = blocks.last().map(|b| b.block.page).unwrap_or(0);
        sections.push(SectionBuilt {
            id: String::new(),
            ordinal: 0,
            title: "Full Text".to_string(),
            number: None,
            role: SectionRole::Body,
            page_start,
            page_end,
            blocks,
        });
        warnings.push("no_sections_fallback".to_string());
        // 兜底节形成后 frontmatter 已空。
    }
    if title.is_none() {
        warnings.push("title_not_detected".to_string());
    }

    // 节 ID 与块编号确定（清单阶段仍需 PendingBlock 的来源信息，暂不退化为 Block）。
    for (i, section) in sections.iter_mut().enumerate() {
        section.ordinal = (i + 1) as u32;
        section.id = format!("sec_{}_{}", section.ordinal, slugify(&section.title));
        for (j, pending) in section.blocks.iter_mut().enumerate() {
            pending.block.id = (j + 1) as u32;
        }
    }
    // frontmatter 块独立编号（不进地址空间，仅供稳定引用）。
    for (j, pending) in frontmatter.iter_mut().enumerate() {
        pending.block.id = (j + 1) as u32;
    }
    build_asset_lists(
        &mut frontmatter,
        &mut sections,
        &mut figures,
        &mut tables,
        &mut warnings,
    );
    build_reference_list(&mut sections, &mut references, &mut warnings);
    scan_asset_mentions(&sections, &mut figures, &mut tables);

    // 小节索引与最终 Block 退化（丢弃 source 信息）。
    let mut out_sections: Vec<Section> = Vec::with_capacity(sections.len());
    for section in sections {
        let mut subsections: Vec<Subsection> = Vec::new();
        for pending in &section.blocks {
            if pending.block.kind == BlockKind::Heading {
                subsections.push(Subsection {
                    number: pending.sub_number.clone(),
                    title: pending.block.text.clone(),
                    level: pending.block.level.unwrap_or(2),
                    block_start: pending.block.id,
                    block_end: pending.block.id,
                    page_start: pending.block.page,
                    page_end: pending.block.page,
                });
            }
        }
        // 小节区间 = 标题块 → 下一小节标题前（平铺，层级在 level 字段）。
        let starts: Vec<u32> = subsections.iter().map(|s| s.block_start).collect();
        for (k, sub) in subsections.iter_mut().enumerate() {
            let next = starts
                .get(k + 1)
                .copied()
                .unwrap_or(section.blocks.len() as u32 + 1);
            sub.block_end = next - 1;
            if sub.block_end >= 1 {
                if let Some(last) = section.blocks.get((sub.block_end - 1) as usize) {
                    sub.page_end = last.block.page;
                }
            }
        }
        out_sections.push(Section {
            id: section.id,
            ordinal: section.ordinal,
            title: section.title,
            number: section.number,
            role: section.role,
            page_start: section.page_start,
            page_end: section.page_end,
            blocks: section.blocks.into_iter().map(|p| p.block).collect(),
            subsections,
        });
    }

    Ok(MappedPaper {
        schema_version: PDFMAP_SCHEMA_VERSION,
        title,
        source_name: doc.get("name").and_then(Value::as_str).map(str::to_string),
        page_count: collections.pages.len() as u32,
        sections: out_sections,
        frontmatter: frontmatter.into_iter().map(|p| p.block).collect(),
        furniture,
        figures,
        tables,
        references,
        warnings,
    })
}

// ============================================================================
// 集合与流式展开
// ============================================================================

struct Collections<'a> {
    texts: &'a [Value],
    tables: &'a [Value],
    pictures: &'a [Value],
    groups: &'a [Value],
    /// page_no → (width, height)，PDF pt。
    pages: HashMap<u32, (f64, f64)>,
}

impl<'a> Collections<'a> {
    fn parse(doc: &'a Value) -> Result<Self, BridgeError> {
        let array = |key: &str| -> Result<&'a [Value], BridgeError> {
            doc.get(key)
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .ok_or_else(|| {
                    BridgeError::new(
                        "docling_json_invalid",
                        format!("DoclingDocument 缺少 {key} 数组"),
                        false,
                    )
                })
        };
        let mut pages = HashMap::new();
        if let Some(map) = doc.get("pages").and_then(Value::as_object) {
            for (key, page) in map {
                let Ok(page_no) = key.parse::<u32>() else {
                    continue;
                };
                let Some(size) = page.get("size") else {
                    continue;
                };
                let (Some(w), Some(h)) = (
                    size.get("width").and_then(Value::as_f64),
                    size.get("height").and_then(Value::as_f64),
                ) else {
                    continue;
                };
                pages.insert(page_no, (w, h));
            }
        }
        Ok(Self {
            texts: array("texts")?,
            tables: array("tables")?,
            pictures: array("pictures")?,
            groups: array("groups")?,
            pages,
        })
    }

    fn page_height(&self, page: u32) -> Option<f64> {
        self.pages.get(&page).map(|(_, h)| *h)
    }
}

/// `$ref` 解析：`#/texts/12` → ("texts", 12)。
fn parse_ref(reference: &str) -> Option<(&str, usize)> {
    let rest = reference.strip_prefix("#/")?;
    let (coll, idx) = rest.split_once('/')?;
    Some((coll, idx.parse().ok()?))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamSource {
    Text(usize),
    Table(usize),
    Picture(usize),
}

/// 阅读顺序流中的一个节点。
#[derive(Debug, Clone)]
struct StreamItem {
    source: StreamSource,
    label: String,
    text: String,
    /// orig 字段：参考文献 [n] 前缀在 text 被吞、orig 保留（决策 9）。
    orig: String,
    is_furniture: bool,
    /// 图内/表内文字碎片（bbox 中心落在图表区域内的游离文本块，决策 8 推广）。
    is_fragment: bool,
    /// 首页 prov（跨页块记首页）。
    page: Option<u32>,
    /// 首页 bbox，BOTTOMLEFT 原点，存 [l, b, r, t]。
    bbox_pt: Option<[f64; 4]>,
    /// picture/table 的 captions $ref 解析出的 texts 下标。
    caption_texts: Vec<usize>,
}

fn prov_first(node: &Value) -> Option<(u32, [f64; 4])> {
    let prov = node.get("prov")?.as_array()?.first()?;
    let page = prov.get("page_no")?.as_u64()? as u32;
    let bbox = prov.get("bbox")?;
    let get = |k: &str| bbox.get(k).and_then(Value::as_f64);
    let (l, t, r, b) = (get("l")?, get("t")?, get("r")?, get("b")?);
    Some((page, [l, b, r, t]))
}

fn value_text(node: &Value) -> String {
    node.get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn value_label(node: &Value) -> String {
    node.get("label")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 阅读顺序展开：body 树 DFS，groups 递归；picture/table 不展开 children
///（图内文字碎片与图注挂在其下 —— 决策 8/11 的结构前提）。
fn collect_stream(doc: &Value, collections: &Collections) -> Vec<StreamItem> {
    let mut out = Vec::new();
    let Some(children) = doc
        .get("body")
        .and_then(|b| b.get("children"))
        .and_then(Value::as_array)
    else {
        return out;
    };
    for child in children {
        expand_ref(child, collections, &mut out, 0);
    }
    out
}

const MAX_EXPAND_DEPTH: usize = 16;

fn expand_ref(node: &Value, collections: &Collections, out: &mut Vec<StreamItem>, depth: usize) {
    if depth > MAX_EXPAND_DEPTH {
        return;
    }
    let Some(reference) = node.get("$ref").and_then(Value::as_str) else {
        return;
    };
    let Some((coll, idx)) = parse_ref(reference) else {
        return;
    };
    match coll {
        "groups" => {
            if let Some(group) = collections.groups.get(idx) {
                if let Some(children) = group.get("children").and_then(Value::as_array) {
                    for child in children {
                        expand_ref(child, collections, out, depth + 1);
                    }
                }
            }
        }
        "texts" => {
            if let Some(node) = collections.texts.get(idx) {
                let label = value_label(node);
                let content_layer = node
                    .get("content_layer")
                    .and_then(Value::as_str)
                    .unwrap_or("body");
                let (page, bbox_pt) = prov_first(node)
                    .map(|(p, b)| (Some(p), Some(b)))
                    .unwrap_or((None, None));
                out.push(StreamItem {
                    source: StreamSource::Text(idx),
                    is_furniture: content_layer == "furniture"
                        || label == "page_header"
                        || label == "page_footer",
                    is_fragment: false,
                    label,
                    text: value_text(node),
                    orig: node
                        .get("orig")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    page,
                    bbox_pt,
                    caption_texts: Vec::new(),
                });
            }
        }
        "tables" | "pictures" => {
            let (source, node) = if coll == "tables" {
                (StreamSource::Table(idx), collections.tables.get(idx))
            } else {
                (StreamSource::Picture(idx), collections.pictures.get(idx))
            };
            let Some(node) = node else { return };
            let (page, bbox_pt) = prov_first(node)
                .map(|(p, b)| (Some(p), Some(b)))
                .unwrap_or((None, None));
            let caption_texts = node
                .get("captions")
                .and_then(Value::as_array)
                .map(|refs| {
                    refs.iter()
                        .filter_map(|r| r.get("$ref").and_then(Value::as_str))
                        .filter_map(parse_ref)
                        .filter(|(c, _)| *c == "texts")
                        .map(|(_, i)| i)
                        .collect()
                })
                .unwrap_or_default();
            out.push(StreamItem {
                source,
                label: value_label(node),
                text: String::new(),
                orig: String::new(),
                is_furniture: false,
                is_fragment: false,
                page,
                bbox_pt,
                caption_texts,
            });
        }
        _ => {}
    }
}

/// 图内/表内碎片标记：body 级文本块（text/paragraph/list_item）的 bbox 中心
/// 落在同页某 picture/table bbox 内 → 图表区域内容（坐标轴文字、单元格碎片），
/// 不进入正文块流。返回标记数量（进 warning，诚实可追回）。
fn mark_fragments(stream: &mut [StreamItem]) -> u32 {
    let regions: Vec<(u32, [f64; 4])> = stream
        .iter()
        .filter(|i| matches!(i.source, StreamSource::Table(_) | StreamSource::Picture(_)))
        .filter_map(|i| i.page.zip(i.bbox_pt))
        .collect();
    let mut count = 0;
    for item in stream.iter_mut() {
        if item.is_furniture || !matches!(item.label.as_str(), "text" | "paragraph" | "list_item") {
            continue;
        }
        let (Some(page), Some(bbox)) = (item.page, item.bbox_pt) else {
            continue;
        };
        let (cx, cy) = ((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0);
        let inside = regions
            .iter()
            .any(|(p, rb)| *p == page && rb[0] <= cx && cx <= rb[2] && rb[1] <= cy && cy <= rb[3]);
        if inside {
            item.is_fragment = true;
            count += 1;
        }
    }
    count
}

// ============================================================================
// 标题判定（编号体系状态机 + 白名单 + 字高回退）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Numbering {
    Arabic,
    Roman,
}

#[derive(Debug, Clone)]
struct HeadingVerdict {
    /// 论文题目（进元数据，不开节）。
    is_title: bool,
    /// 误判降级为段落（列表符号开头、附录区图题行）。
    demoted: bool,
    /// 1 = 一级节（开新节）；≥2 = 小节标题块。
    level: u32,
    number: Option<String>,
    role: SectionRole,
}

impl HeadingVerdict {
    fn title() -> Self {
        Self {
            is_title: true,
            demoted: false,
            level: 0,
            number: None,
            role: SectionRole::Body,
        }
    }

    fn demoted() -> Self {
        Self {
            is_title: false,
            demoted: true,
            level: 0,
            number: None,
            role: SectionRole::Body,
        }
    }

    /// 一级节判定。
    fn section(number: Option<String>, role: SectionRole) -> Self {
        Self {
            is_title: false,
            demoted: false,
            level: 1,
            number,
            role,
        }
    }

    /// 小节标题块判定（level ≥ 2）。
    fn subsection(level: u32, number: Option<String>, role: SectionRole) -> Self {
        Self {
            is_title: false,
            demoted: false,
            level,
            number,
            role,
        }
    }
}

/// 无编号一级节白名单（标题全文小写精确匹配）。
const LEVEL1_WHITELIST: &[&str] = &[
    "abstract",
    "references",
    "reference",
    "bibliography",
    "acknowledgments",
    "acknowledgements",
    "acknowledgment",
    "methods",
    "materials and methods",
    "supplementary material",
    "supplementary materials",
];

/// 列表符号开头的"标题"是误判（BERT 附录 "· Batch size : 16, 32"）。
fn starts_with_list_marker(text: &str) -> bool {
    text.trim_start()
        .chars()
        .next()
        .map(|c| matches!(c, '·' | '•' | '∙' | '◦' | '*' | '†' | '‡' | '–' | '—'))
        .unwrap_or(false)
}

/// 阿拉伯多级编号前缀：`3.1 Encoder` → Some(("3.1", 2 段))。
fn parse_arabic_number(text: &str) -> Option<(String, u32)> {
    let bytes = text.as_bytes();
    let mut parts = 0_u32;
    let mut len = 0_usize;
    loop {
        let start = len;
        while len < bytes.len() && bytes[len].is_ascii_digit() {
            len += 1;
        }
        if len == start {
            return None;
        }
        parts += 1;
        if len < bytes.len() && bytes[len] == b'.' {
            if len + 1 < bytes.len() && bytes[len + 1].is_ascii_digit() {
                len += 1;
                continue;
            }
            len += 1; // 尾句点（"1." 形态）
            break;
        }
        break;
    }
    if len < text.len() && !text[len..].starts_with(char::is_whitespace) {
        return None;
    }
    let number = text[..len].trim_end_matches('.').to_string();
    Some((number, parts))
}

/// 罗马数字前缀：`I. INTRODUCTION` / `IV. CONCLUSIONS` → Some("IV")。
fn parse_roman_number(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut len = 0_usize;
    while len < bytes.len() && matches!(bytes[len], b'I' | b'V' | b'X') {
        len += 1;
    }
    if len == 0 || len > 4 {
        return None;
    }
    let candidate = &text[..len];
    if !valid_roman(candidate) {
        return None;
    }
    let rest = &text[len..];
    if rest.starts_with('.') {
        return Some(candidate.to_string());
    }
    // 无句点形态（"II EXPRESSIBILITY"）要求多字母，避免单字母 "I ..." 误判。
    if len > 1 && rest.starts_with(char::is_whitespace) {
        return Some(candidate.to_string());
    }
    None
}

fn valid_roman(s: &str) -> bool {
    matches!(
        s,
        "I" | "II" | "III" | "IV" | "V" | "VI" | "VII" | "VIII" | "IX" | "X"
    )
}

/// 单字母前缀：`A. WEIGHTED QUANTILE SKETCH` / `A LARGE LANGUAGE MODELS`。
/// 排除罗马字 I/V/X（罗马判定优先）。
fn parse_letter_number(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let c = chars.next()?;
    if !c.is_ascii_uppercase() || matches!(c, 'I' | 'V' | 'X') {
        return None;
    }
    match chars.next() {
        Some('.') => Some(c),
        Some(c2) if c2.is_whitespace() => Some(c),
        _ => None,
    }
}

/// 附录关键词：`Appendix A: ...` / `Appendix for ...` / `APPENDIX`。
/// 返回附录字母（"Appendix A:" → Some('A')；无字母 → None）。
fn parse_appendix_keyword(text: &str) -> Option<Option<char>> {
    if text.len() < 8 || !text[..8].eq_ignore_ascii_case("appendix") {
        return None;
    }
    let rest = text[8..].trim_start_matches(|c: char| c.is_whitespace() || c == '.' || c == ':');
    let mut chars = rest.chars();
    if let Some(c) = chars.next() {
        let next_is_word = chars
            .next()
            .map(|c2| c2.is_ascii_lowercase())
            .unwrap_or(false);
        if c.is_ascii_uppercase() && !next_is_word {
            return Some(Some(c));
        }
    }
    Some(None)
}

/// 附录内字母-数字小节：`A.1 Illustration` / `D.3 GPT-2` → Some(('A', "1"))。
fn parse_letter_arabic(text: &str) -> Option<(char, String)> {
    let mut chars = text.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_uppercase() || matches!(letter, 'I' | 'V' | 'X') {
        return None;
    }
    if chars.next()? != '.' {
        return None;
    }
    let rest: String = chars.collect();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let after = &rest[digits.len()..];
    if !after.is_empty() && !after.starts_with(char::is_whitespace) {
        return None;
    }
    Some((letter, digits))
}

fn whitelist_role(lower_title: &str) -> Option<SectionRole> {
    match lower_title {
        "abstract" => Some(SectionRole::Abstract),
        "references" | "reference" | "bibliography" => Some(SectionRole::References),
        "acknowledgments" | "acknowledgements" | "acknowledgment" => {
            Some(SectionRole::Acknowledgments)
        }
        other if LEVEL1_WHITELIST.contains(&other) => Some(SectionRole::Body),
        _ => None,
    }
}

fn heading_height(item: &StreamItem) -> f64 {
    item.bbox_pt.map(|b| b[3] - b[1]).unwrap_or(0.0)
}

/// 决策 10 上下文判定：标题的流内前后邻居（跳过 furniture/碎片）均为
/// picture/table → 附录大图的图题行被误判为节标题（"Attention Visualizations
/// Input-Input Layer5" / "Input-Input Layer5" 实测形态）。
fn heading_sandwiched_by_assets(stream: &[StreamItem], idx: usize) -> bool {
    let is_asset = |item: &StreamItem| {
        matches!(
            item.source,
            StreamSource::Picture(_) | StreamSource::Table(_)
        )
    };
    let skippable = |item: &StreamItem| item.is_furniture || item.is_fragment;
    let prev = (0..idx)
        .rev()
        .map(|i| &stream[i])
        .find(|item| !skippable(item));
    let next = (idx + 1..stream.len())
        .map(|i| &stream[i])
        .find(|item| !skippable(item));
    prev.map(is_asset).unwrap_or(false) && next.map(is_asset).unwrap_or(false)
}

/// 第一遍：流内全部 section_header 候选 → 判定表（与 stream 等长）。
fn classify_headings(stream: &[StreamItem]) -> Vec<Option<HeadingVerdict>> {
    let mut verdicts: Vec<Option<HeadingVerdict>> = vec![None; stream.len()];
    let mut numbering: Option<Numbering> = None;
    let mut in_appendix = false;
    let mut seen_references = false;
    let mut title_assigned = false;
    let mut deferred: Vec<usize> = Vec::new(); // 无编号候选，待字高回退
    let mut level1_heights: Vec<f64> = Vec::new();

    for (idx, item) in stream.iter().enumerate() {
        if item.is_furniture || item.label != "section_header" {
            continue;
        }
        let text = item.text.trim();
        let lower = text.to_lowercase();

        // 规则 b1：列表符号开头 → 误判降级为段落。
        if starts_with_list_marker(text) {
            verdicts[idx] = Some(HeadingVerdict::demoted());
            continue;
        }

        // 题目：流内首个标题、位于首页、不匹配任何节模式。
        if !title_assigned {
            title_assigned = true;
            let looks_like_section = whitelist_role(&lower).is_some()
                || parse_appendix_keyword(text).is_some()
                || parse_roman_number(text).is_some()
                || parse_arabic_number(text).is_some();
            if !looks_like_section && item.page == Some(1) {
                verdicts[idx] = Some(HeadingVerdict::title());
                continue;
            }
        }

        // 附录关键词：任何位置都是附录节，并进入附录区。
        if let Some(letter) = parse_appendix_keyword(text) {
            in_appendix = true;
            level1_heights.push(heading_height(item));
            verdicts[idx] = Some(HeadingVerdict::section(
                letter.map(|c| c.to_string()),
                SectionRole::Appendix,
            ));
            continue;
        }

        // 白名单一级节（Abstract/References/Acknowledgments/Methods…）。
        if let Some(role) = whitelist_role(&lower) {
            if role == SectionRole::References {
                seen_references = true;
                // References 之后字母模式标题按附录节处理（LoRA 式"A LARGE..."）。
                in_appendix = true;
            }
            level1_heights.push(heading_height(item));
            verdicts[idx] = Some(HeadingVerdict::section(None, role));
            continue;
        }

        // 附录内字母-数字小节（A.1 / D.3）先于单字母判定。
        if in_appendix {
            if let Some((letter, sub)) = parse_letter_arabic(text) {
                verdicts[idx] = Some(HeadingVerdict::subsection(
                    2,
                    Some(format!("{letter}.{sub}")),
                    SectionRole::Appendix,
                ));
                continue;
            }
        }

        // 罗马数字：正文区一级节并锁定罗马体系。
        if let Some(roman) = parse_roman_number(text) {
            if !in_appendix {
                numbering.get_or_insert(Numbering::Roman);
                level1_heights.push(heading_height(item));
                verdicts[idx] = Some(HeadingVerdict::section(Some(roman), SectionRole::Body));
                continue;
            }
        }

        // 单字母：附录区/References 后 → 附录节；正文区 → 二级小节（罗马体系 A.-H.）。
        if let Some(letter) = parse_letter_number(text) {
            if in_appendix || seen_references {
                level1_heights.push(heading_height(item));
                verdicts[idx] = Some(HeadingVerdict::section(
                    Some(letter.to_string()),
                    SectionRole::Appendix,
                ));
            } else {
                verdicts[idx] = Some(HeadingVerdict::subsection(
                    2,
                    Some(letter.to_string()),
                    SectionRole::Body,
                ));
            }
            continue;
        }

        // 阿拉伯编号。
        if let Some((number, parts)) = parse_arabic_number(text) {
            let level = if in_appendix {
                // 附录区阿拉伯编号 = 附录内小节（"1. Proof that..."）。
                parts + 1
            } else {
                match numbering {
                    // 罗马体系内阿拉伯数字降两级（"1. Continuous input..."）。
                    Some(Numbering::Roman) => parts + 2,
                    _ => parts,
                }
            };
            if !in_appendix && level == 1 {
                numbering.get_or_insert(Numbering::Arabic);
                level1_heights.push(heading_height(item));
            }
            let role = if in_appendix {
                SectionRole::Appendix
            } else {
                SectionRole::Body
            };
            verdicts[idx] = Some(if level == 1 {
                HeadingVerdict::section(Some(number), role)
            } else {
                HeadingVerdict::subsection(level, Some(number), role)
            });
            continue;
        }

        // 无编号标题。附录区图题误判（决策 10，如 "Input-Input Layer5"）：
        // 前后邻居（跳过 furniture/碎片）均为 picture/table → 图题行，降级段落。
        if in_appendix && heading_sandwiched_by_assets(stream, idx) {
            verdicts[idx] = Some(HeadingVerdict::demoted());
            continue;
        }

        // 其余无编号：延后字高回退。
        deferred.push(idx);
    }

    // 字高回退：基准 = 已确定一级节标题的中位字高；候选字高 ≥ 基准×0.85 →
    // 一级节，否则小节（Science 式无编号论文：References/Methods 白名单提供
    // 基准 15.5pt，Methods 小节 12.9pt 正确分流）。
    if !deferred.is_empty() {
        let baseline = if level1_heights.is_empty() {
            None
        } else {
            let mut sorted = level1_heights.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            Some(sorted[sorted.len() / 2])
        };
        for idx in deferred {
            let height = heading_height(&stream[idx]);
            let level = match baseline {
                Some(base) if base > 0.0 && height >= base * 0.85 => 1,
                _ => 2,
            };
            verdicts[idx] = Some(if level == 1 {
                HeadingVerdict::section(None, SectionRole::Body)
            } else {
                HeadingVerdict::subsection(level, None, SectionRole::Body)
            });
        }
    }
    verdicts
}

// ============================================================================
// 块生成
// ============================================================================

/// 节构建中间结构：块带来源信息（清单阶段消费）。
struct PendingBlock {
    block: Block,
    source_label: String,
    orig: String,
    /// 小节编号（heading 块）。
    sub_number: Option<String>,
}

struct SectionBuilt {
    id: String,
    ordinal: u32,
    title: String,
    number: Option<String>,
    role: SectionRole,
    page_start: u32,
    page_end: u32,
    blocks: Vec<PendingBlock>,
}

/// 流内节点 → 块。图/表块的图注取自预计算表（resolve_captions）。
fn make_block(
    collections: &Collections,
    stream_idx: usize,
    item: &StreamItem,
    verdict: Option<&HeadingVerdict>,
    asset_captions: &HashMap<usize, String>,
) -> Option<PendingBlock> {
    let viewport = item
        .page
        .zip(item.bbox_pt)
        .and_then(|(page, bbox)| collections.page_height(page).map(|h| to_viewport(bbox, h)));
    let (page, y) = (
        item.page.unwrap_or(0),
        viewport.map(|b| b[1]).unwrap_or(0.0),
    );
    let base = Block {
        id: 0,
        kind: BlockKind::Paragraph,
        text: String::new(),
        page,
        y,
        bbox: None,
        level: None,
        asset_id: None,
        caption: None,
        latex: None,
    };
    match item.source {
        StreamSource::Picture(_) => Some(PendingBlock {
            block: Block {
                kind: BlockKind::Figure,
                // 占位行（#41）：编号派生成功后回填为 `[图 fig_n]`。
                text: "[图]".to_string(),
                bbox: viewport,
                caption: asset_captions.get(&stream_idx).cloned(),
                ..base
            },
            source_label: item.label.clone(),
            orig: String::new(),
            sub_number: None,
        }),
        StreamSource::Table(idx) => {
            // 表格以 tables 集合的 TableFormer 结构化输出转 MD（决策 8）；
            // 结构缺失时占位（宁可占位不可编造）。
            let text = collections
                .tables
                .get(idx)
                .and_then(|t| t.get("data"))
                .and_then(grid_to_markdown)
                .unwrap_or_else(|| "[表]".to_string());
            Some(PendingBlock {
                block: Block {
                    kind: BlockKind::Table,
                    text,
                    bbox: viewport,
                    caption: asset_captions.get(&stream_idx).cloned(),
                    ..base
                },
                source_label: item.label.clone(),
                orig: String::new(),
                sub_number: None,
            })
        }
        StreamSource::Text(_) => {
            let mut block = base;
            match item.label.as_str() {
                "section_header" => match verdict {
                    Some(v) if v.demoted => {
                        block.kind = BlockKind::Paragraph;
                        block.text = item.text.trim().to_string();
                    }
                    Some(v) => {
                        block.kind = BlockKind::Heading;
                        block.text = item.text.trim().to_string();
                        block.level = Some(v.level);
                    }
                    None => return None,
                },
                "footnote" => {
                    block.kind = BlockKind::Footnote;
                    block.text = item.text.trim().to_string();
                }
                "formula" => {
                    block.kind = BlockKind::Formula;
                    block.text = "[公式]".to_string();
                    let latex = item.text.trim();
                    if !latex.is_empty() {
                        block.latex = Some(latex.to_string());
                    }
                    block.bbox = viewport;
                }
                "caption" => {
                    // 流内游离 caption（未被任何图表关联或认领）：降级段落保留文本。
                    block.kind = BlockKind::Paragraph;
                    block.text = item.text.trim().to_string();
                }
                // text / paragraph / list_item 及其余未知标签一律自然段。
                _ => {
                    block.kind = BlockKind::Paragraph;
                    block.text = item.text.trim().to_string();
                }
            }
            Some(PendingBlock {
                block,
                source_label: item.label.clone(),
                orig: item.orig.clone(),
                sub_number: match item.label.as_str() {
                    "section_header" => verdict.and_then(|v| v.number.clone()),
                    _ => None,
                },
            })
        }
    }
}

/// 图/表图注预计算（决策 11 聚类）：主路径 = Docling captions $ref 关联；
/// 回退 = 同页未被关联的最近 caption 块（(kind, 页内 y) 邻近）。
/// 返回 (流内图表下标 → 图注文本, 被回退认领的 texts 下标集合)；
/// 被认领的游离 caption 不再独立成块（决策 6：并入所属图/表块）。
fn resolve_captions(
    collections: &Collections,
    stream: &[StreamItem],
) -> (HashMap<usize, String>, HashSet<usize>) {
    // $ref 主路径已关联的 caption 集合（回退配对排除）。
    let mut linked: HashSet<usize> = HashSet::new();
    for item in stream {
        if !matches!(item.source, StreamSource::Text(_)) {
            linked.extend(item.caption_texts.iter().copied());
        }
    }
    let mut captions = HashMap::new();
    let mut claimed = HashSet::new();
    for (idx, item) in stream.iter().enumerate() {
        if matches!(item.source, StreamSource::Text(_)) {
            continue;
        }
        // 主路径：$ref 关联。
        if let Some(&text_idx) = item.caption_texts.first() {
            if let Some(node) = collections.texts.get(text_idx) {
                let text = value_text(node);
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    captions.insert(idx, trimmed.to_string());
                    continue;
                }
            }
        }
        // 回退：同页最近未被关联的 caption。度量用边距（图注通常贴图底边、
        // 表注贴上边；中心距会随图高失真），阈值约两行高防跨栏错配。
        let (Some(page), Some(bbox)) = (item.page, item.bbox_pt) else {
            continue;
        };
        let mut best: Option<(f64, usize, String)> = None;
        for other in stream {
            let StreamSource::Text(text_idx) = other.source else {
                continue;
            };
            if other.label != "caption" || other.page != Some(page) || linked.contains(&text_idx) {
                continue;
            }
            let Some(ob) = other.bbox_pt else { continue };
            // bbox_pt = [l, b, r, t]（BOTTOMLEFT）；边距 = 两框垂直间隙。
            let distance = (bbox[1] - ob[3]).abs().min((bbox[3] - ob[1]).abs());
            if distance > 60.0 {
                continue;
            }
            let text = value_text(&collections.texts[text_idx]);
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                continue;
            }
            if best.as_ref().map(|(d, _, _)| distance < *d).unwrap_or(true) {
                best = Some((distance, text_idx, trimmed));
            }
        }
        if let Some((_, text_idx, text)) = best {
            captions.insert(idx, text);
            claimed.insert(text_idx);
        }
    }
    (captions, claimed)
}

/// prov 换算：BOTTOMLEFT pt → pdf.js 视口 [x, y, w, h]（左上原点，scale=2）。
fn to_viewport(bbox_pt: [f64; 4], page_height: f64) -> [f64; 4] {
    let [l, b, r, t] = bbox_pt;
    let round = |v: f64| (v * 100.0).round() / 100.0;
    [
        round(l * VIEWPORT_SCALE),
        round((page_height - t) * VIEWPORT_SCALE),
        round((r - l) * VIEWPORT_SCALE),
        round((t - b) * VIEWPORT_SCALE),
    ]
}

fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in title.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    if out.len() > 40 {
        out.truncate(40);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        "section".to_string()
    } else {
        out
    }
}

/// 表格 grid → MD 管道表（决策 6：结构以 tables 集合 TableFormer 输出为准）。
/// 首行含 column_header 时作表头；无表头标记时首行充当表头（MD 语法要求）。
/// 合并单元格按展开后的 grid 逐格输出（MD 无 span，诚实重复）。
fn grid_to_markdown(data: &Value) -> Option<String> {
    let grid = data.get("grid")?.as_array()?;
    if grid.is_empty() {
        return None;
    }
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(grid.len());
    for row in grid {
        let cells = row.as_array()?;
        rows.push(
            cells
                .iter()
                .map(|cell| {
                    cell.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .replace('|', "\\|")
                        .replace(['\n', '\r'], " ")
                        .trim()
                        .to_string()
                })
                .collect(),
        );
    }
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    if cols == 0 {
        return None;
    }
    for row in &mut rows {
        row.resize(cols, String::new());
    }
    let mut out = String::new();
    out.push_str(&format!("| {} |\n", rows[0].join(" | ")));
    out.push_str(&format!("|{}|\n", vec!["---"; cols].join("|")));
    for row in &rows[1..] {
        out.push_str(&format!("| {} |\n", row.join(" | ")));
    }
    Some(out.trim_end().to_string())
}

// ============================================================================
// 图表清单（决策 11：聚类、ID 从图注编号派生、归属节；决策 15：诚实档）
// ============================================================================

/// 从串首解析图表编号：可选大写字母前缀 + 数字（"3" / "A1"）。
/// 图注派生与正文提及扫描共用。
fn leading_asset_number(text: &str) -> Option<String> {
    let mut chars = text.chars();
    let mut number = String::new();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() || c.is_ascii_digit() => number.push(c),
        _ => return None,
    }
    number.extend(chars.take_while(|c| c.is_ascii_digit()));
    if number.chars().any(|c| c.is_ascii_digit()) {
        Some(number)
    } else {
        None
    }
}

/// 从图注文本派生编号：`Figure 3:` / `Fig. 2` / `Table 1:` / `Figure A1`。
fn parse_asset_number(caption: &str, kind: BlockKind) -> Option<String> {
    let trimmed = caption.trim_start();
    let lower = trimmed.to_lowercase();
    let prefix_len = match kind {
        BlockKind::Figure if lower.starts_with("figure") => 6,
        BlockKind::Figure if lower.starts_with("fig") => 3,
        BlockKind::Table if lower.starts_with("table") => 5,
        _ => return None,
    };
    let rest = trimmed[prefix_len..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == '.' || c == ':');
    leading_asset_number(rest)
}

/// 图表清单生成：遍历 frontmatter 与节内图/表块，编号派生成功者进清单并
/// 回填块 asset_id 与占位行；无编号不进清单（决策 15），块保留 `[图]`/`[表]`
/// 占位。frontmatter 区图表归属节为 None（首节前无归属）。
fn build_asset_lists(
    frontmatter: &mut [PendingBlock],
    sections: &mut [SectionBuilt],
    figures: &mut Vec<AssetEntry>,
    tables: &mut Vec<AssetEntry>,
    warnings: &mut Vec<String>,
) {
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut unnumbered = [0_u32; 2]; // [图, 表]
                                     // frontmatter（无归属节）+ 各节统一处理。
    let front: Vec<(&mut PendingBlock, Option<String>)> =
        frontmatter.iter_mut().map(|p| (p, None)).collect();
    let body = sections.iter_mut().flat_map(|s| {
        let sec_id = s.id.clone();
        s.blocks.iter_mut().map(move |p| (p, Some(sec_id.clone())))
    });
    for (pending, sec_id) in front.into_iter().chain(body) {
        let (kind, prefix) = match pending.block.kind {
            BlockKind::Figure => (BlockKind::Figure, "fig"),
            BlockKind::Table => (BlockKind::Table, "tbl"),
            _ => continue,
        };
        let caption = pending.block.caption.clone();
        let number = caption.as_deref().and_then(|c| parse_asset_number(c, kind));
        let Some(number) = number else {
            unnumbered[usize::from(kind == BlockKind::Table)] += 1;
            continue;
        };
        let id = format!("{prefix}_{number}");
        if !seen_ids.insert(id.clone()) {
            // 重复图注编号（同号两图）：保留首个，跳过后者（漏检不漂移，重号不覆盖）。
            warnings.push(format!("duplicate_asset_id:{id}"));
            continue;
        }
        // 块回填：图块占位行带 ID；表块保留 MD 文本。
        pending.block.asset_id = Some(id.clone());
        if kind == BlockKind::Figure {
            pending.block.text = format!("[图 {id}]");
        } else if pending.block.text == "[表]" {
            pending.block.text = format!("[表 {id}]");
        }
        // 图/表块 bbox 必在（清单的裁切依据）；缺 bbox 无法裁切则不进清单。
        let Some(bbox) = pending.block.bbox else {
            warnings.push(format!("asset_without_bbox:{id}"));
            continue;
        };
        let entry = AssetEntry {
            id,
            number,
            caption,
            page: pending.block.page,
            bbox,
            section: sec_id,
            references: Vec::new(), // 引用处由 scan_asset_mentions 回填
        };
        match kind {
            BlockKind::Figure => figures.push(entry),
            _ => tables.push(entry),
        }
    }
    if unnumbered[0] > 0 {
        warnings.push(format!("figures_without_number:{}", unnumbered[0]));
    }
    if unnumbered[1] > 0 {
        warnings.push(format!("tables_without_number:{}", unnumbered[1]));
    }
}

/// 正文块迭代：非 References 节的 paragraph/footnote/heading 块
/// （图表引用扫描与参考文献 [n] 扫描共用范围）。
fn prose_blocks(sections: &[SectionBuilt]) -> impl Iterator<Item = (&SectionBuilt, &PendingBlock)> {
    sections
        .iter()
        .filter(|s| s.role != SectionRole::References)
        .flat_map(|s| s.blocks.iter().map(move |p| (s, p)))
        .filter(|(_, p)| {
            matches!(
                p.block.kind,
                BlockKind::Paragraph | BlockKind::Footnote | BlockKind::Heading
            )
        })
}

/// 图表正文引用处扫描：`Figure 3` / `Fig. 2` / `Table 1` 形态（大小写不敏感）。
fn scan_asset_mentions(
    sections: &[SectionBuilt],
    figures: &mut [AssetEntry],
    tables: &mut [AssetEntry],
) {
    for (section, pending) in prose_blocks(sections) {
        // 图注形态的块（游离 caption 降级段落）不是正文引用。
        if parse_asset_number(&pending.block.text, BlockKind::Figure).is_some()
            || parse_asset_number(&pending.block.text, BlockKind::Table).is_some()
        {
            continue;
        }
        for (kind, entries) in [
            (BlockKind::Figure, &mut *figures),
            (BlockKind::Table, &mut *tables),
        ] {
            for number in find_asset_mentions(&pending.block.text, kind) {
                if let Some(entry) = entries
                    .iter_mut()
                    .find(|e| e.number.eq_ignore_ascii_case(&number))
                {
                    let citation = Citation {
                        sec_id: section.id.clone(),
                        block_id: pending.block.id,
                        page: pending.block.page,
                    };
                    if !entry.references.contains(&citation) {
                        entry.references.push(citation);
                    }
                }
            }
        }
    }
}

/// 在文本中找 `Figure 3` / `Fig. A1` / `Table 2` 形态的图表提及，返回编号列表。
/// 手写扫描（避免 regex 依赖）：关键词须词边界起始，编号 = 可选字母 + 数字。
fn find_asset_mentions(text: &str, kind: BlockKind) -> Vec<String> {
    let keywords: &[&str] = match kind {
        BlockKind::Figure => &["figure", "fig"],
        BlockKind::Table => &["table"],
        _ => return Vec::new(),
    };
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut out = Vec::new();
    for keyword in keywords {
        let mut from = 0_usize;
        while let Some(pos) = lower[from..].find(keyword) {
            let start = from + pos;
            // 词边界：关键词前不能是字母（防 "config" 命中 "fig"）。
            if start > 0 && bytes[start - 1].is_ascii_alphabetic() {
                from = start + keyword.len();
                continue;
            }
            let mut i = start + keyword.len();
            // 跳过分隔符（空格/句点/冒号），"Fig.3" "Figure 3" 皆覆盖。
            let sep_start = i;
            while i < bytes.len() && matches!(bytes[i], b' ' | b'.' | b':') {
                i += 1;
            }
            // "fig" 后紧跟字母（"configure"）不是引用。
            if i == sep_start && i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                from = start + keyword.len();
                continue;
            }
            if let Some(number) = leading_asset_number(&text[i..]) {
                out.push(number);
            }
            from = i.max(start + keyword.len());
        }
    }
    out
}

// ============================================================================
// 参考文献规则层（决策 12 + #41：编号引用制、顺序即编号、无编号不建条目）
// ============================================================================

/// 条目 orig 前缀编号：`[25]` / `25.` / `25)` → Some(25)。
/// text 字段的 [n] 已被 Docling 吞掉，编号判定以 orig 为准。
fn parse_ref_number_prefix(orig: &str) -> Option<u32> {
    let trimmed = orig.trim_start();
    if let Some(rest) = trimmed.strip_prefix('[') {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with(']') {
            return digits.parse().ok();
        }
        return None;
    }
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    match trimmed[digits.len()..].chars().next() {
        Some('.') | Some(')') => digits.parse().ok(),
        _ => None,
    }
}

/// 正文 [n] 引用点扫描：`[12]` / `[17, 18]` / `[1-3]` 展开。
/// 只接受纯数字方括号（表格架构记号 "[3×3, 64]" 天然不匹配）。
fn scan_bracket_citations(text: &str) -> Vec<u32> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0_usize;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut numbers: Vec<u32> = Vec::new();
        let mut valid = true;
        let mut expect_number = true;
        while j < bytes.len() && bytes[j] != b']' {
            let c = bytes[j];
            if c.is_ascii_digit() {
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                let Ok(n) = text[start..j].parse::<u32>() else {
                    valid = false;
                    break;
                };
                if !expect_number {
                    valid = false;
                    break;
                }
                numbers.push(n);
                expect_number = false;
                // 范围形态 [1-3]：连字符后续数字展开。
                if j < bytes.len() && (bytes[j] == b'-' || bytes[j] == 0xE2) {
                    // 0xE2 是 en-dash 首字节（–）；粗判即可，范围展开在 ']' 前完成。
                }
                continue;
            }
            if c == b',' || c == b';' || c == b' ' {
                if c != b' ' {
                    if expect_number {
                        valid = false;
                        break;
                    }
                    expect_number = true;
                }
                j += 1;
                continue;
            }
            if c == b'-' || c == 0xE2 {
                // 范围：跳过连字符（– 为 3 字节 E2 80 93），下个数字展开区间。
                let dash_len = if c == 0xE2 { 3 } else { 1 };
                if expect_number {
                    valid = false;
                    break;
                }
                j += dash_len;
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if start == j {
                    valid = false;
                    break;
                }
                let Ok(end) = text[start..j].parse::<u32>() else {
                    valid = false;
                    break;
                };
                let Some(&from) = numbers.last() else {
                    valid = false;
                    break;
                };
                // 防御异常区间（[1-99999] 显然后令不是引用）。
                if end > from && end - from <= 200 {
                    for n in (from + 1)..=end {
                        numbers.push(n);
                    }
                }
                expect_number = false;
                continue;
            }
            valid = false;
            break;
        }
        if valid && j < bytes.len() && bytes[j] == b']' && !numbers.is_empty() && !expect_number {
            out.extend(numbers);
        }
        i = (j + 1).max(i + 1);
    }
    out
}

/// 参考文献清单：References 节定位（含无编号情形，层级判定阶段已打
/// role=References）→ 条目切分（节内 list_item 块）→ 编号制判定（orig 前缀
/// 比例 ≥70%）→ 按序补号 → 正文 [n] 引用点扫描。无编号文献表不建条目。
fn build_reference_list(
    sections: &mut [SectionBuilt],
    references: &mut Vec<ReferenceEntry>,
    warnings: &mut Vec<String>,
) {
    let Some(ref_idx) = sections
        .iter()
        .position(|s| s.role == SectionRole::References)
    else {
        warnings.push("references_section_missing".to_string());
        return;
    };
    // 条目候选：节内 list_item 块；缺 list_item 时回退到带编号前缀的段落块。
    let section = &sections[ref_idx];
    let mut candidate_idx: Vec<usize> = section
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, p)| p.source_label == "list_item")
        .map(|(i, _)| i)
        .collect();
    if candidate_idx.is_empty() {
        candidate_idx = section
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                p.block.kind == BlockKind::Paragraph && parse_ref_number_prefix(&p.orig).is_some()
            })
            .map(|(i, _)| i)
            .collect();
    }
    if candidate_idx.is_empty() {
        warnings.push("references_unnumbered".to_string());
        return;
    }
    let numbered = candidate_idx
        .iter()
        .filter(|&&i| parse_ref_number_prefix(&section.blocks[i].orig).is_some())
        .count();
    // 编号引用制判定：≥70% 条目带编号前缀（决策 12：作者-年份制降级空清单）。
    if numbered * 10 < candidate_idx.len() * 7 {
        warnings.push("references_unnumbered".to_string());
        return;
    }

    for (ordinal, &block_idx) in candidate_idx.iter().enumerate() {
        let number = (ordinal + 1) as u32;
        let pending = &mut sections[ref_idx].blocks[block_idx];
        let text = pending.block.text.trim().to_string();
        let numbered_text = format!("[{number}] {text}");
        pending.block.text = numbered_text.clone();
        references.push(ReferenceEntry {
            id: format!("ref_{number}"),
            number,
            text: numbered_text,
            cited_at: Vec::new(),
        });
    }

    // 正文 [n] 引用点扫描（与图表引用扫描同一正文范围）。
    let ref_count = references.len() as u32;
    for (section, pending) in prose_blocks(sections) {
        for n in scan_bracket_citations(&pending.block.text) {
            if n < 1 || n > ref_count {
                continue;
            }
            let citation = Citation {
                sec_id: section.id.clone(),
                block_id: pending.block.id,
                page: pending.block.page,
            };
            let entry = &mut references[(n - 1) as usize];
            if !entry.cited_at.contains(&citation) {
                entry.cited_at.push(citation);
            }
        }
    }
}

// ============================================================================
// 单元测试（合成 DoclingDocument；真实论文形态由 tests/pdfmap_fixtures.rs 覆盖）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn prov(page: u32, l: f64, b: f64, r: f64, t: f64) -> Value {
        json!([{ "page_no": page, "bbox": { "l": l, "t": t, "r": r, "b": b, "coord_origin": "BOTTOMLEFT" }, "charspan": [0, 0] }])
    }

    fn text_item(label: &str, text: &str, page: u32, layer: &str) -> Value {
        json!({
            "self_ref": "#/texts/0", "parent": { "$ref": "#/body" }, "children": [],
            "content_layer": layer, "label": label, "prov": prov(page, 72.0, 700.0, 540.0, 712.0),
            "orig": text, "text": text,
        })
    }

    fn text_item_with_orig(label: &str, orig: &str, text: &str, page: u32) -> Value {
        json!({
            "self_ref": "#/texts/0", "parent": { "$ref": "#/body" }, "children": [],
            "content_layer": "body", "label": label, "prov": prov(page, 72.0, 700.0, 540.0, 712.0),
            "orig": orig, "text": text,
        })
    }

    /// 组装最小 DoclingDocument：texts 按顺序挂 body.children。
    fn make_doc(texts: Vec<Value>) -> Value {
        make_doc_full(texts, vec![], vec![])
    }

    fn make_doc_full(texts: Vec<Value>, pictures: Vec<Value>, tables: Vec<Value>) -> Value {
        let mut texts = texts;
        for (i, item) in texts.iter_mut().enumerate() {
            item["self_ref"] = json!(format!("#/texts/{i}"));
        }
        // 被 picture/table captions 关联的 texts 不挂 body.children（真实形态：
        // caption 是图表节点的 children，不在正文流中）。
        let mut captioned: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for asset in pictures.iter().chain(tables.iter()) {
            if let Some(refs) = asset.get("captions").and_then(Value::as_array) {
                for r in refs {
                    if let Some(("texts", idx)) =
                        r.get("$ref").and_then(Value::as_str).and_then(parse_ref)
                    {
                        captioned.insert(idx);
                    }
                }
            }
        }
        let mut children: Vec<Value> = (0..texts.len())
            .filter(|i| !captioned.contains(i))
            .map(|i| json!({ "$ref": format!("#/texts/{i}") }))
            .collect();
        for (i, _) in pictures.iter().enumerate() {
            children.push(json!({ "$ref": format!("#/pictures/{i}") }));
        }
        for (i, _) in tables.iter().enumerate() {
            children.push(json!({ "$ref": format!("#/tables/{i}") }));
        }
        json!({
            "schema_name": "DoclingDocument", "version": "1.10.0", "name": "synthetic.pdf",
            "origin": {}, "furniture": { "self_ref": "#/furniture", "children": [], "content_layer": "furniture", "name": "furniture", "label": "furniture" },
            "body": { "self_ref": "#/body", "children": children, "content_layer": "body", "name": "body", "label": "document" },
            "groups": [], "texts": texts, "pictures": pictures, "tables": tables,
            "key_value_items": [], "form_items": [],
            "pages": { "1": { "size": { "width": 612.0, "height": 792.0 }, "page_no": 1 },
                       "2": { "size": { "width": 612.0, "height": 792.0 }, "page_no": 2 } },
        })
    }

    fn picture(caption_texts: Vec<usize>, page: u32) -> Value {
        json!({
            "self_ref": "#/pictures/0", "parent": { "$ref": "#/body" }, "children": [],
            "content_layer": "body", "label": "picture",
            "prov": prov(page, 100.0, 300.0, 500.0, 600.0),
            "captions": caption_texts.iter().map(|i| json!({ "$ref": format!("#/texts/{i}") })).collect::<Vec<_>>(),
            "references": [], "footnotes": [], "annotations": [],
        })
    }

    // ---------- 纯函数解析器 ----------

    #[test]
    fn parse_arabic_number_variants() {
        assert_eq!(parse_arabic_number("1 Introduction"), Some(("1".into(), 1)));
        assert_eq!(
            parse_arabic_number("1. Introduction"),
            Some(("1".into(), 1))
        );
        assert_eq!(parse_arabic_number("3.1 Encoder"), Some(("3.1".into(), 2)));
        assert_eq!(parse_arabic_number("3.1.4 Sub"), Some(("3.1.4".into(), 3)));
        assert_eq!(parse_arabic_number("Introduction"), None);
        assert_eq!(parse_arabic_number(""), None);
    }

    #[test]
    fn parse_roman_number_variants() {
        assert_eq!(parse_roman_number("I. INTRODUCTION"), Some("I".into()));
        assert_eq!(parse_roman_number("IV. CONCLUSIONS"), Some("IV".into()));
        assert_eq!(parse_roman_number("II EXPRESSIBILITY"), Some("II".into()));
        assert_eq!(parse_roman_number("A. Something"), None);
        // 单字母 I 无句点不判罗马（防普通语句误判）。
        assert_eq!(parse_roman_number("I love this"), None);
    }

    #[test]
    fn parse_letter_and_appendix_variants() {
        assert_eq!(
            parse_letter_number("A. WEIGHTED QUANTILE SKETCH"),
            Some('A')
        );
        assert_eq!(parse_letter_number("A LARGE LANGUAGE MODELS"), Some('A'));
        assert_eq!(parse_letter_number("I. INTRODUCTION"), None); // 罗马优先
        assert_eq!(parse_letter_number("Abstract"), None);
        assert_eq!(
            parse_appendix_keyword("Appendix A: The polynomial"),
            Some(Some('A'))
        );
        assert_eq!(parse_appendix_keyword("Appendix for 'BERT'"), Some(None));
        assert_eq!(parse_appendix_keyword("APPENDIX"), Some(None));
        assert_eq!(parse_appendix_keyword("1 Introduction"), None);
    }

    #[test]
    fn parse_ref_number_prefix_variants() {
        assert_eq!(parse_ref_number_prefix("[25] Mitchell P Marcus"), Some(25));
        assert_eq!(parse_ref_number_prefix("1. Online chess games"), Some(1));
        assert_eq!(parse_ref_number_prefix("12) Some entry"), Some(12));
        assert_eq!(parse_ref_number_prefix("Vaswani et al. 2017"), None);
        assert_eq!(parse_ref_number_prefix(""), None);
    }

    #[test]
    fn parse_asset_number_variants() {
        assert_eq!(
            parse_asset_number("Figure 3: An example", BlockKind::Figure),
            Some("3".into())
        );
        assert_eq!(
            parse_asset_number("Fig. 2. Architecture", BlockKind::Figure),
            Some("2".into())
        );
        assert_eq!(
            parse_asset_number("Table 1: Maximum path", BlockKind::Table),
            Some("1".into())
        );
        assert_eq!(
            parse_asset_number("Figure A1: Appendix fig", BlockKind::Figure),
            Some("A1".into())
        );
        assert_eq!(
            parse_asset_number("An example figure", BlockKind::Figure),
            None
        );
        assert_eq!(
            parse_asset_number("Figure: no number", BlockKind::Figure),
            None
        );
    }

    #[test]
    fn scan_bracket_citations_variants() {
        assert_eq!(scan_bracket_citations("see [12] for details"), vec![12]);
        assert_eq!(scan_bracket_citations("[17, 18] and [3]"), vec![17, 18, 3]);
        assert_eq!(scan_bracket_citations("range [1-3]"), vec![1, 2, 3]);
        // 表格架构记号不是引用。
        assert!(scan_bracket_citations("[3×3, 64] conv").is_empty());
        assert!(scan_bracket_citations("[abc]").is_empty());
        assert!(scan_bracket_citations("no brackets").is_empty());
        // 未闭合与空括号。
        assert!(scan_bracket_citations("[12").is_empty());
        assert!(scan_bracket_citations("[]").is_empty());
    }

    #[test]
    fn find_asset_mentions_variants() {
        let found = find_asset_mentions("As shown in Figure 3 and Fig. 2.", BlockKind::Figure);
        assert!(found.iter().any(|n| n == "3"), "{found:?}");
        assert!(found.iter().any(|n| n == "2"), "{found:?}");
        // 词边界：config 不命中 fig。
        assert!(find_asset_mentions("config 3 is set", BlockKind::Figure).is_empty());
        let tables = find_asset_mentions("Table 2 shows", BlockKind::Table);
        assert_eq!(tables.len(), 1);
    }

    #[test]
    fn grid_to_markdown_renders_pipe_table() {
        let data = json!({
            "table_cells": [], "num_rows": 2, "num_cols": 2, "orientation": "row",
            "grid": [
                [{ "text": "Layer Type", "column_header": true }, { "text": "Complexity" }],
                [{ "text": "Self-Attention" }, { "text": "O(n)" }],
            ],
        });
        let md = grid_to_markdown(&data).expect("应生成 MD");
        assert!(md.contains("| Layer Type | Complexity |"), "{md}");
        assert!(md.contains("|---|---|"), "{md}");
        assert!(md.contains("| Self-Attention | O(n) |"), "{md}");
        // 空 grid → None（占位路径）。
        assert!(grid_to_markdown(&json!({ "grid": [] })).is_none());
        // 管道符转义。
        let escaped = grid_to_markdown(&json!({ "grid": [[{ "text": "a|b" }]] })).unwrap();
        assert!(escaped.contains("a\\|b"), "{escaped}");
    }

    #[test]
    fn slugify_variants() {
        assert_eq!(slugify("1 Introduction"), "1-introduction");
        assert_eq!(slugify("Model Architecture"), "model-architecture");
        assert_eq!(slugify("References"), "references");
        assert_eq!(
            slugify("A. WEIGHTED QUANTILE SKETCH"),
            "a-weighted-quantile-sketch"
        );
        assert_eq!(slugify(""), "section");
        assert_eq!(slugify("!!!"), "section");
    }

    #[test]
    fn to_viewport_converts_bottomleft_pt_to_scale2() {
        // 页高 792pt；bbox l=72 b=700 r=540 t=712（BOTTOMLEFT）。
        let [x, y, w, h] = to_viewport([72.0, 700.0, 540.0, 712.0], 792.0);
        assert_eq!(x, 144.0);
        assert_eq!(y, 160.0); // (792-712)*2
        assert_eq!(w, 936.0);
        assert_eq!(h, 24.0);
    }

    // ---------- 端到端合成文档 ----------

    #[test]
    fn rejects_non_docling_document() {
        let err = map_docling_document(&json!({ "hello": 1 })).unwrap_err();
        assert_eq!(err.code, "docling_json_invalid");
    }

    #[test]
    fn minimal_document_sections_furniture_and_frontmatter() {
        let doc = make_doc(vec![
            text_item("page_header", "arXiv:1234.56789", 1, "furniture"),
            text_item("section_header", "A Great Paper", 1, "body"),
            text_item("text", "Jane Doe, MIT", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("text", "We present a method.", 1, "body"),
            text_item("section_header", "1 Introduction", 1, "body"),
            text_item("text", "Attention is key [1].", 1, "body"),
            text_item("section_header", "References", 2, "body"),
            text_item_with_orig(
                "list_item",
                "[1] Jane Smith. Some work. 2020.",
                "Jane Smith. Some work. 2020.",
                2,
            ),
            text_item("page_footer", "1", 1, "furniture"),
        ]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert_eq!(paper.title.as_deref(), Some("A Great Paper"));
        // frontmatter 收作者行，不进地址空间。
        assert_eq!(paper.frontmatter.len(), 1);
        assert!(paper.frontmatter[0].text.contains("Jane Doe"));
        // furniture 剔除保留。
        assert_eq!(paper.furniture.len(), 2);
        // 节：Abstract + Introduction + References。
        let titles: Vec<&str> = paper.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, vec!["Abstract", "1 Introduction", "References"]);
        assert_eq!(paper.sections[0].role, SectionRole::Abstract);
        assert_eq!(paper.sections[2].role, SectionRole::References);
        assert!(paper.sections[1].id.starts_with("sec_2_"));
        // 参考文献补号 + 引用处。
        assert_eq!(paper.references.len(), 1);
        assert_eq!(paper.references[0].text, "[1] Jane Smith. Some work. 2020.");
        assert_eq!(paper.references[0].cited_at.len(), 1);
        assert_eq!(paper.references[0].cited_at[0].sec_id, paper.sections[1].id);
        // 节内块编号从 1 连续。
        assert_eq!(paper.sections[0].blocks[0].id, 1);
    }

    #[test]
    fn unnumbered_references_degrade_to_empty_list() {
        let doc = make_doc(vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("text", "Body.", 1, "body"),
            text_item("section_header", "References", 2, "body"),
            text_item_with_orig(
                "list_item",
                "Vaswani et al. Attention is all you need. 2017.",
                "Vaswani et al. Attention is all you need. 2017.",
                2,
            ),
            text_item_with_orig(
                "list_item",
                "Author Two. Another work. 2018.",
                "Author Two. Another work. 2018.",
                2,
            ),
        ]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert!(paper.references.is_empty(), "作者-年份制降级空清单");
        assert!(paper
            .warnings
            .contains(&"references_unnumbered".to_string()));
    }

    #[test]
    fn missing_references_section_warns() {
        let doc = make_doc(vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("text", "Body.", 1, "body"),
        ]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert!(paper.references.is_empty());
        assert!(paper
            .warnings
            .contains(&"references_section_missing".to_string()));
    }

    #[test]
    fn figure_id_derives_from_caption_and_survives_gap() {
        // 只有 Figure 3 没有 1/2：ID 仍取 3（漏检不漂移）。
        let texts = vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("caption", "Figure 3: Architecture.", 1, "body"),
        ];
        let pictures = vec![picture(vec![2], 1)];
        let doc = make_doc_full(texts, pictures, vec![]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert_eq!(paper.figures.len(), 1);
        assert_eq!(paper.figures[0].id, "fig_3");
        assert_eq!(
            paper.figures[0].caption.as_deref(),
            Some("Figure 3: Architecture.")
        );
        assert_eq!(paper.figures[0].page, 1);
        // 块占位行回填 [图 fig_3]。
        let fig_block = paper
            .sections
            .iter()
            .flat_map(|s| s.blocks.iter())
            .find(|b| b.kind == BlockKind::Figure)
            .expect("图块存在");
        assert_eq!(fig_block.text, "[图 fig_3]");
        assert_eq!(fig_block.asset_id.as_deref(), Some("fig_3"));
        assert!(fig_block.bbox.is_some());
        // caption 块不独立成块（并入图块）。
        let caption_blocks = paper
            .sections
            .iter()
            .flat_map(|s| s.blocks.iter())
            .filter(|b| b.text == "Figure 3: Architecture.")
            .count();
        assert_eq!(caption_blocks, 0, "caption 不独立成块");
    }

    #[test]
    fn figure_without_numbered_caption_stays_out_of_list() {
        let texts = vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("caption", "A diagram without a number.", 1, "body"),
        ];
        let pictures = vec![picture(vec![2], 1)];
        let doc = make_doc_full(texts, pictures, vec![]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert!(paper.figures.is_empty(), "无编号图不进清单（诚实档）");
        assert!(paper
            .warnings
            .iter()
            .any(|w| w.starts_with("figures_without_number:")));
        // 块仍在（[图] 占位）。
        assert!(paper
            .sections
            .iter()
            .flat_map(|s| s.blocks.iter())
            .any(|b| b.kind == BlockKind::Figure && b.text == "[图]"));
    }

    #[test]
    fn figure_mentions_scanned_from_body_text() {
        let texts = vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("text", "As shown in Figure 1, the method works.", 1, "body"),
            text_item("caption", "Figure 1: Overview.", 1, "body"),
        ];
        let pictures = vec![picture(vec![3], 1)];
        let doc = make_doc_full(texts, pictures, vec![]);
        let paper = map_docling_document(&doc).expect("映射成功");
        let fig1 = &paper.figures[0];
        assert_eq!(fig1.references.len(), 1);
        assert_eq!(fig1.references[0].block_id, 1); // Abstract 节第一块
    }

    #[test]
    fn formula_becomes_placeholder_with_bbox() {
        let doc = make_doc(vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("formula", "", 1, "body"),
        ]);
        let paper = map_docling_document(&doc).expect("映射成功");
        let formula = &paper.sections[0].blocks[0];
        assert_eq!(formula.kind, BlockKind::Formula);
        assert_eq!(formula.text, "[公式]");
        assert!(formula.latex.is_none() && formula.bbox.is_some());
    }

    #[test]
    fn cross_page_block_keeps_first_page() {
        let mut item = text_item("text", "A paragraph spanning pages.", 1, "body");
        item["prov"] = json!([
            { "page_no": 1, "bbox": { "l": 72.0, "t": 712.0, "r": 540.0, "b": 700.0, "coord_origin": "BOTTOMLEFT" }, "charspan": [0, 10] },
            { "page_no": 2, "bbox": { "l": 72.0, "t": 100.0, "r": 540.0, "b": 88.0, "coord_origin": "BOTTOMLEFT" }, "charspan": [10, 20] },
        ]);
        let doc = make_doc(vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            item,
        ]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert_eq!(paper.sections[0].blocks[0].page, 1, "跨页块记首页");
    }

    #[test]
    fn table_without_grid_falls_back_to_placeholder() {
        let texts = vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
        ];
        let tables = vec![json!({
            "self_ref": "#/tables/0", "parent": { "$ref": "#/body" }, "children": [],
            "content_layer": "body", "label": "table", "prov": prov(1, 100.0, 300.0, 500.0, 600.0),
            "captions": [], "references": [], "footnotes": [], "annotations": [],
            "data": { "table_cells": [], "num_rows": 0, "num_cols": 0, "grid": [] },
        })];
        let doc = make_doc_full(texts, vec![], tables);
        let paper = map_docling_document(&doc).expect("映射成功");
        let table_block = &paper.sections[0].blocks[0];
        assert_eq!(table_block.kind, BlockKind::Table);
        assert_eq!(table_block.text, "[表]", "空 grid 占位");
    }

    #[test]
    fn appendix_letter_sections_after_references() {
        let doc = make_doc(vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "1 Introduction", 1, "body"),
            text_item("text", "Body.", 1, "body"),
            text_item("section_header", "References", 1, "body"),
            text_item_with_orig("list_item", "[1] Some work.", "Some work.", 1),
            text_item("section_header", "A WEIGHTED QUANTILE SKETCH", 2, "body"),
            text_item("text", "Appendix body.", 2, "body"),
            text_item("section_header", "A.1 Details", 2, "body"),
            text_item("text", "Sub body.", 2, "body"),
        ]);
        let paper = map_docling_document(&doc).expect("映射成功");
        let titles: Vec<&str> = paper.sections.iter().map(|s| s.title.as_str()).collect();
        assert!(titles.contains(&"A WEIGHTED QUANTILE SKETCH"), "{titles:?}");
        let appendix = paper
            .sections
            .iter()
            .find(|s| s.title == "A WEIGHTED QUANTILE SKETCH")
            .unwrap();
        assert_eq!(appendix.role, SectionRole::Appendix);
        assert_eq!(appendix.number.as_deref(), Some("A"));
        assert!(appendix
            .subsections
            .iter()
            .any(|s| s.number.as_deref() == Some("A.1")));
    }

    #[test]
    fn frontmatter_figure_enters_list_without_section() {
        // 首节前（frontmatter 区）的图也应进清单（决策 11/15：检测到的图不静默丢弃），
        // 归属节为 None。
        let texts = vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("caption", "Figure 1: Teaser.", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            text_item("text", "Body.", 1, "body"),
        ];
        let mut pictures = vec![picture(vec![1], 1)];
        // picture 须在流内：位于题目之后、Abstract 之前 → 需要自定义 children 顺序，
        // make_doc_full 把 pictures 排在 texts 之后，这里改为手动插入位置。
        let mut doc = make_doc_full(texts, pictures.clone(), vec![]);
        // 重排 body.children：[题目, picture, Abstract, Body]
        let children = doc["body"]["children"].as_array().unwrap();
        let mut order: Vec<Value> = vec![children[0].clone()];
        order.push(json!({ "$ref": "#/pictures/0" }));
        order.extend(children.iter().skip(1).take(children.len() - 2).cloned());
        // 去掉原尾部 picture 引用
        doc["body"]["children"] = json!(order);
        let _ = &mut pictures;
        let paper = map_docling_document(&doc).expect("映射成功");
        assert_eq!(paper.figures.len(), 1, "frontmatter 图应进清单");
        assert_eq!(paper.figures[0].id, "fig_1");
        assert_eq!(paper.figures[0].section, None, "首节前无归属节");
        // frontmatter 中的图块占位行同样回填。
        assert!(paper
            .frontmatter
            .iter()
            .any(|b| b.kind == BlockKind::Figure && b.text == "[图 fig_1]"));
    }

    #[test]
    fn fallback_claimed_caption_does_not_double_as_paragraph() {
        // 游离 caption（无 $ref 关联）被邻近聚类回退认领后，并入图块、
        // 不再落成独立段落块（决策 6 并入语义，避免同一文本双重存在）。
        let texts = vec![
            text_item("section_header", "Paper Title", 1, "body"),
            text_item("section_header", "Abstract", 1, "body"),
            // caption 与图同页且贴图底边（图 bbox b=300..t=600，caption 在其下方 18pt）。
            {
                let mut c = text_item("caption", "Figure 2: Nearby caption.", 1, "body");
                c["prov"] = json!([{ "page_no": 1, "bbox": { "l": 120.0, "t": 282.0, "r": 480.0, "b": 270.0, "coord_origin": "BOTTOMLEFT" }, "charspan": [0, 0] }]);
                c
            },
        ];
        // picture 无 captions $ref（空数组）→ 走回退配对。
        let pictures = vec![picture(vec![], 1)];
        let doc = make_doc_full(texts, pictures, vec![]);
        let paper = map_docling_document(&doc).expect("映射成功");
        assert_eq!(paper.figures.len(), 1);
        assert_eq!(
            paper.figures[0].caption.as_deref(),
            Some("Figure 2: Nearby caption.")
        );
        // 被认领的 caption 不成独立段落块。
        assert!(!paper
            .sections
            .iter()
            .flat_map(|s| s.blocks.iter())
            .any(|b| b.text == "Figure 2: Nearby caption."));
    }
}
