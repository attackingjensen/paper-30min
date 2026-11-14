//! AI Studio raw JSONL to the common block model and independently bound provenance.
use crate::{error::BridgeError, files, pdf_identity::PdfIdentity, pdfmap::*};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct MappingContext {
    pub paper_id: String,
    pub batch_id: String,
    pub pdf_sha256: String,
    pub raw_sha256: String,
    pub model: String,
    pub options: Value,
}
pub struct CloudMapped {
    pub mapped: MappedPaper,
    pub source: Value,
}

pub fn projection_sha256(mapped: &MappedPaper) -> Result<String, BridgeError> {
    let mut copy = mapped.clone();
    for block in copy
        .frontmatter
        .iter_mut()
        .chain(copy.sections.iter_mut().flat_map(|s| s.blocks.iter_mut()))
    {
        block.source_regions.clear();
    }
    Ok(files::sha256_hex(
        &serde_json::to_vec(&copy).map_err(|_| invalid("Model serialization failed"))?,
    ))
}
fn invalid(message: &str) -> BridgeError {
    BridgeError::new("cloudparse_mapping_invalid", message, false)
}

pub fn map_aistudio_jsonl(
    raw: &[u8],
    identity: &PdfIdentity,
    context: &MappingContext,
) -> Result<CloudMapped, BridgeError> {
    if raw.len() > 256 * 1024 * 1024
        || raw.is_empty()
        || context.pdf_sha256 != identity.sha256
        || context.raw_sha256 != files::sha256_hex(raw)
    {
        return Err(invalid("PDF or raw result identity mismatch"));
    }
    crate::files::require_safe_segment(&context.batch_id, "batchId")?;
    crate::files::require_safe_segment(&context.paper_id, "paperId")?;
    let text = std::str::from_utf8(raw).map_err(|_| invalid("Invalid UTF-8 result"))?;
    let mut pages = Vec::new();
    let mut unique = HashSet::new();
    for line in text.lines().filter(|s| !s.trim().is_empty()) {
        let row: Value = serde_json::from_str(line).map_err(|_| invalid("Invalid JSONL result"))?;
        if row.get("errorCode").is_some_and(|v| v.as_i64() != Some(0)) {
            return Err(invalid("Vendor returned failed result"));
        }
        let list = row
            .pointer("/result/layoutParsingResults")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("Missing layout pages"))?;
        let info = row
            .pointer("/result/dataInfo")
            .ok_or_else(|| invalid("Missing batch page metadata"))?;
        if info["type"] != "pdf"
            || info["numPages"].as_u64() != Some(list.len() as u64)
            || info["pages"].as_array().map(Vec::len) != Some(list.len())
        {
            return Err(invalid("Batch page count mismatch"));
        }
        for (index, page) in list.iter().enumerate() {
            let pruned = page
                .get("prunedResult")
                .ok_or_else(|| invalid("Missing pruned page"))?;
            if pruned["width"] != info["pages"][index]["width"]
                || pruned["height"] != info["pages"][index]["height"]
            {
                return Err(invalid("Batch page dimensions mismatch"));
            }
            let digest = files::sha256_hex(
                &serde_json::to_vec(pruned).map_err(|_| invalid("Invalid page"))?,
            );
            if !unique.insert(digest)
                && pruned["parsing_res_list"].as_array().is_some_and(|a| {
                    a.iter().any(|b| {
                        b["block_content"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty())
                    })
                })
            {
                return Err(invalid("Repeated page result"));
            }
            pages.push(pruned.clone());
        }
    }
    if pages.len() != identity.pages.len() || pages.is_empty() {
        return Err(invalid("PDF page completeness mismatch"));
    }
    let mut mapped = MappedPaper {
        schema_version: PDFMAP_SCHEMA_VERSION,
        title: None,
        source_name: None,
        page_count: pages.len() as u32,
        sections: vec![],
        frontmatter: vec![],
        furniture: vec![],
        figures: vec![],
        tables: vec![],
        references: vec![],
        warnings: vec![],
    };
    let mut source_blocks: Vec<Value> = Vec::new();
    for (page_index, pruned) in pages.iter().enumerate() {
        let page_no = page_index as u32 + 1;
        let geometry = &identity.pages[page_index];
        let width = pruned["width"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or_else(|| invalid("Invalid page width"))?;
        let height = pruned["height"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or_else(|| invalid("Invalid page height"))?;
        let calibrated = geometry.trusted_geometry
            && pruned.pointer("/model_settings/use_doc_preprocessor") == Some(&Value::Bool(false))
            && context.options["useDocOrientationClassify"] == false
            && context.options["useDocUnwarping"] == false
            && ((width / height) / (geometry.width / geometry.height) - 1.0).abs() < 0.002;
        let raw_blocks = pruned["parsing_res_list"]
            .as_array()
            .ok_or_else(|| invalid("Missing parsing blocks"))?;
        if raw_blocks.len() > 10000 {
            return Err(invalid("Too many page blocks"));
        }
        let mut groups: Vec<Vec<&Value>> = Vec::new();
        let mut group_ids: HashMap<i64, usize> = HashMap::new();
        let mut orders = HashSet::new();
        let ordered = raw_blocks.iter().collect::<Vec<_>>();
        let mut previous_order = None;
        let mut block_ids = HashSet::new();
        for item in &ordered {
            if !item["block_order"].is_null() && item["block_order"].as_u64().is_none() {
                return Err(invalid("Invalid reading order"));
            }
            let block_id = item["block_id"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid block identifier"))?;
            if !block_ids.insert(block_id) {
                return Err(invalid("Duplicate block identifier"));
            }
            if let Some(order) = item["block_order"].as_u64() {
                if !orders.insert(order) {
                    return Err(invalid("Duplicate reading order"));
                }
                if previous_order.is_some_and(|previous| order <= previous) {
                    return Err(invalid("Non-monotonic reading order"));
                }
                previous_order = Some(order);
            }
        }
        // Vendor visual blocks have null order: retain their array position between ordered text.
        for item in ordered {
            let label = item["block_label"]
                .as_str()
                .ok_or_else(|| invalid("Missing block label"))?;
            if matches!(
                label,
                "header" | "footer" | "number" | "aside_text" | "header_image" | "footer_image"
            ) {
                mapped.furniture.push(FurnitureItem {
                    label: label.into(),
                    text: item["block_content"].as_str().unwrap_or("").into(),
                    page: page_no,
                });
                continue;
            }
            let key = item["group_id"].as_i64().filter(|n| *n >= 0);
            if let Some(index) = key.and_then(|k| group_ids.get(&k).copied()) {
                groups[index].push(item);
            } else {
                if let Some(k) = key {
                    group_ids.insert(k, groups.len());
                }
                groups.push(vec![item]);
            }
        }
        let mut pending_caption: Option<(String, Vec<SourceRegion>)> = None;
        for group in groups {
            let first = group[0];
            let label = first["block_label"].as_str().unwrap();
            if !matches!(label, "image" | "chart" | "table") {
                if let Some(caption) = pending_caption.take() {
                    flush_caption(&mut mapped, &mut source_blocks, caption, page_no);
                }
            }
            if group
                .iter()
                .any(|b| b["block_label"].as_str() != Some(label))
            {
                return Err(invalid("Mixed labels in one group"));
            }
            let content = group
                .iter()
                .filter_map(|b| b["block_content"].as_str())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if content.is_empty() && !matches!(label, "image" | "chart") {
                continue;
            }
            let mut regions = vec![];
            for item in &group {
                if calibrated {
                    if let Some(bbox) = region_bbox(
                        &item["block_bbox"],
                        width,
                        height,
                        geometry.width,
                        geometry.height,
                    ) {
                        regions.push(SourceRegion {
                            page: page_no,
                            bbox,
                            page_size: [geometry.width, geometry.height],
                            charspan: None,
                        });
                    }
                }
            }
            // A partly invalid multi-region group degrades together, rather than dropping its unlocated text.
            if regions.len() != group.len() {
                regions.clear();
                mapped
                    .warnings
                    .push(format!("page {page_no}: {label} geometry degraded to page"));
            }
            if label == "doc_title" && mapped.title.is_none() {
                mapped.title = Some(content.clone());
            }
            if label == "paragraph_title" && is_section(&content) {
                let ordinal = mapped.sections.len() as u32 + 1;
                let number = heading_number(&content).map(|(number, _)| number);
                let role = if number.as_deref().is_some_and(|n| n.len() == 1)
                    && parse_letter_number(&content).is_some()
                {
                    SectionRole::Appendix
                } else {
                    section_role(&content)
                };
                mapped.sections.push(Section {
                    id: format!("sec_{ordinal}_{}", slug(&content)),
                    ordinal,
                    title: content.clone(),
                    number,
                    role,
                    page_start: page_no,
                    page_end: page_no,
                    blocks: vec![],
                    subsections: vec![],
                });
                continue;
            }
            if mapped.sections.is_empty() && matches!(label, "doc_title" | "text") && page_no == 1 {
                let id = mapped.frontmatter.len() as u32 + 1;
                mapped.frontmatter.push(make_block(
                    id,
                    BlockKind::Paragraph,
                    content,
                    page_no,
                    regions,
                ));
                continue;
            }
            if mapped.sections.is_empty() {
                mapped.sections.push(Section {
                    id: "sec_1_body".into(),
                    ordinal: 1,
                    title: "Body".into(),
                    number: None,
                    role: SectionRole::Body,
                    page_start: page_no,
                    page_end: page_no,
                    blocks: vec![],
                    subsections: vec![],
                });
            }
            let kind = match label {
                "image" | "chart" => BlockKind::Figure,
                "table" => BlockKind::Table,
                "display_formula" => BlockKind::Formula,
                "paragraph_title" => BlockKind::Heading,
                "footnote" | "vision_footnote" => BlockKind::Footnote,
                _ => BlockKind::Paragraph,
            };
            if matches!(kind, BlockKind::Figure | BlockKind::Table)
                && pending_caption
                    .as_ref()
                    .is_some_and(|(caption, _)| !caption_matches(caption, kind))
            {
                flush_caption(
                    &mut mapped,
                    &mut source_blocks,
                    pending_caption.take().unwrap(),
                    page_no,
                );
            }
            let section = mapped.sections.last_mut().unwrap();
            section.page_end = page_no;
            let mut block = make_block(
                section.blocks.len() as u32 + 1,
                kind,
                content.clone(),
                page_no,
                regions,
            );
            let mut record = json!({"secId":section.id,"blockId":block.id,"sourceRegions":block.source_regions,"pages":[page_no],"vendorLabel":label});
            if kind == BlockKind::Formula {
                block.latex = Some(content.clone());
            }
            if kind == BlockKind::Heading {
                block.level = Some(
                    heading_number(&content)
                        .map(|(_, level)| level)
                        .unwrap_or(2),
                );
            }
            if kind == BlockKind::Table {
                let table = parse_table(&content)?;
                block.text = table_markdown(&table);
                record["table"] = table;
            }
            if kind == BlockKind::Figure {
                block.text = "[Figure: original PDF region]".into();
            }
            if label == "figure_title" || label == "formula_number" {
                if let Some(previous) = section.blocks.last_mut().filter(|b| {
                    b.page == page_no
                        && if label == "formula_number" {
                            b.kind == BlockKind::Formula
                        } else {
                            matches!(b.kind, BlockKind::Figure | BlockKind::Table)
                                && caption_matches(&content, b.kind)
                                && b.caption.as_deref().is_none_or(|old| {
                                    let number = parse_asset_number(&content, b.kind);
                                    let old_number = parse_asset_number(old, b.kind);
                                    number.is_none() || old_number.is_none() || number == old_number
                                })
                        }
                }) {
                    previous.caption = Some(match previous.caption.take() {
                        Some(old)
                            if label == "figure_title"
                                && parse_asset_number(&old, previous.kind).is_none()
                                && parse_asset_number(&content, previous.kind).is_some() =>
                        {
                            format!("{content}\n{old}")
                        }
                        Some(old) => format!("{old}\n{content}"),
                        None => content.clone(),
                    });
                    previous.source_regions.extend(block.source_regions);
                    if let Some(old) = source_blocks.last_mut() {
                        old["sourceRegions"] = json!(previous.source_regions);
                    }
                    continue;
                }
                if label == "figure_title" {
                    pending_caption = Some((content, block.source_regions));
                    continue;
                }
            }
            if matches!(kind, BlockKind::Figure | BlockKind::Table) {
                if let Some((caption, caption_regions)) = pending_caption.take() {
                    block.caption = Some(caption);
                    block.source_regions.extend(caption_regions);
                    record["sourceRegions"] = json!(block.source_regions);
                }
            } else {
                pending_caption = None;
            }
            if label == "reference_content" {
                if let Some(number) = content
                    .trim_start()
                    .strip_prefix('[')
                    .and_then(|s| s.split(']').next())
                    .and_then(|s| s.parse::<u32>().ok())
                {
                    mapped.references.push(ReferenceEntry {
                        id: format!("ref_{number}"),
                        number,
                        text: content,
                        cited_at: vec![],
                    });
                }
            }
            source_blocks.push(record);
            section.blocks.push(block);
        }
        if let Some(caption) = pending_caption.take() {
            flush_caption(&mut mapped, &mut source_blocks, caption, page_no);
        }
    }
    let mut asset_ids = HashSet::new();
    for section in &mut mapped.sections {
        section.subsections = section
            .blocks
            .iter()
            .filter(|b| b.kind == BlockKind::Heading)
            .map(|b| Subsection {
                number: heading_number(&b.text).map(|(number, _)| number),
                title: b.text.clone(),
                level: b.level.unwrap_or(2),
                block_start: b.id,
                block_end: b.id,
                page_start: b.page,
                page_end: b.page,
            })
            .collect();
        for index in 0..section.subsections.len() {
            let end = section
                .subsections
                .get(index + 1)
                .map(|s| s.block_start - 1)
                .unwrap_or(section.blocks.len() as u32);
            let subsection = &mut section.subsections[index];
            subsection.block_end = end;
            subsection.page_end = section.blocks[(end - 1) as usize].page;
        }
        for block in &mut section.blocks {
            if let Some(number) = block
                .caption
                .as_deref()
                .and_then(|s| crate::pdfmap::parse_asset_number(s, block.kind))
            {
                let id = format!(
                    "{}_{}",
                    if block.kind == BlockKind::Table {
                        "tbl"
                    } else {
                        "fig"
                    },
                    number
                );
                if !asset_ids.insert(id.clone()) {
                    mapped.warnings.push(format!("Duplicate asset number {id}"));
                    continue;
                }
                block.asset_id = Some(id.clone());
                let asset = AssetEntry {
                    id,
                    number,
                    caption: block.caption.clone(),
                    page: block.page,
                    bbox: block.bbox,
                    section: Some(section.id.clone()),
                    references: vec![],
                };
                if block.kind == BlockKind::Table {
                    mapped.tables.push(asset);
                } else {
                    mapped.figures.push(asset);
                }
            }
        }
    }
    for section in &mapped.sections {
        for block in &section.blocks {
            if !matches!(block.kind, BlockKind::Paragraph | BlockKind::Footnote) {
                continue;
            }
            let citation = Citation {
                sec_id: section.id.clone(),
                block_id: block.id,
                page: block.page,
            };
            for (kind, assets) in [
                (BlockKind::Figure, &mut mapped.figures),
                (BlockKind::Table, &mut mapped.tables),
            ] {
                for number in crate::pdfmap::find_asset_mentions(&block.text, kind) {
                    if let Some(asset) = assets
                        .iter_mut()
                        .find(|a| a.number.eq_ignore_ascii_case(&number))
                    {
                        if !asset.references.contains(&citation) {
                            asset.references.push(citation.clone());
                        }
                    }
                }
            }
            for number in crate::pdfmap::scan_bracket_citations(&block.text) {
                if let Some(reference) = mapped.references.iter_mut().find(|r| r.number == number) {
                    if !reference.cited_at.contains(&citation) {
                        reference.cited_at.push(citation.clone());
                    }
                }
            }
        }
    }
    let source = json!({"schemaVersion":1,"provider":"baidu","model":context.model,"options":context.options,"paperId":context.paper_id,"batchId":context.batch_id,"pdfSha256":identity.sha256,"rawSha256":context.raw_sha256,"blockModelSha256":files::sha256_hex(&serde_json::to_vec(&mapped).map_err(|_|invalid("Model serialization failed"))?),"projectionSha256":projection_sha256(&mapped)?,"blocks":source_blocks});
    Ok(CloudMapped { mapped, source })
}
fn make_block(
    id: u32,
    kind: BlockKind,
    text: String,
    page: u32,
    source_regions: Vec<SourceRegion>,
) -> Block {
    let bbox = if matches!(
        kind,
        BlockKind::Figure | BlockKind::Table | BlockKind::Formula
    ) && source_regions.len() == 1
    {
        Some(source_regions[0].bbox)
    } else {
        None
    };
    Block {
        id,
        kind,
        text,
        page,
        y: source_regions.first().map(|r| r.bbox[1]).unwrap_or(0.0),
        source_regions,
        bbox,
        level: None,
        asset_id: None,
        caption: None,
        latex: None,
    }
}
fn flush_caption(
    mapped: &mut MappedPaper,
    sources: &mut Vec<Value>,
    caption: (String, Vec<SourceRegion>),
    page: u32,
) {
    let Some(section) = mapped.sections.last_mut() else {
        return;
    };
    let block = make_block(
        section.blocks.len() as u32 + 1,
        BlockKind::Paragraph,
        caption.0,
        page,
        caption.1,
    );
    sources.push(json!({"secId":section.id,"blockId":block.id,"sourceRegions":block.source_regions,"pages":[page],"vendorLabel":"figure_title"}));
    section.blocks.push(block);
    section.page_end = page;
}
fn region_bbox(v: &Value, w: f64, h: f64, pw: f64, ph: f64) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let n = a.iter().map(Value::as_f64).collect::<Option<Vec<_>>>()?;
    if !n.iter().all(|n| n.is_finite())
        || n[0] < 0.0
        || n[1] < 0.0
        || n[2] <= n[0]
        || n[3] <= n[1]
        || n[2] > w
        || n[3] > h
    {
        return None;
    }
    Some([
        n[0] * pw / w * 2.0,
        n[1] * ph / h * 2.0,
        (n[2] - n[0]) * pw / w * 2.0,
        (n[3] - n[1]) * ph / h * 2.0,
    ])
}
fn slug(s: &str) -> String {
    let slug = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();
    slug.trim_matches('_').chars().take(60).collect()
}
fn section_role(s: &str) -> SectionRole {
    let s = s.to_lowercase();
    if s.contains("abstract") {
        SectionRole::Abstract
    } else if s.contains("references") {
        SectionRole::References
    } else if s.contains("acknowledg") {
        SectionRole::Acknowledgments
    } else if s.contains("appendix") {
        SectionRole::Appendix
    } else {
        SectionRole::Body
    }
}
fn is_section(s: &str) -> bool {
    heading_number(s).is_some_and(|(_, level)| level == 1) || section_role(s) != SectionRole::Body
}

fn heading_number(s: &str) -> Option<(String, u32)> {
    if let Some(number) = parse_arabic_number(s) {
        return Some(number);
    }
    let token = s.split_whitespace().next()?.trim_end_matches('.');
    let mut parts = token.split('.');
    let first = parts.next()?;
    if first.len() == 1 && first.chars().all(|c| c.is_ascii_uppercase()) {
        let tail = parts.collect::<Vec<_>>();
        if !tail.is_empty()
            && tail
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        {
            return Some((token.into(), tail.len() as u32 + 1));
        }
    }
    parse_roman_number(s)
        .or_else(|| {
            (token.len() == 1)
                .then(|| parse_letter_number(s))
                .flatten()
                .map(|c| c.to_string())
        })
        .map(|number| (number, 1))
}

fn caption_matches(caption: &str, kind: BlockKind) -> bool {
    let other = if kind == BlockKind::Figure {
        BlockKind::Table
    } else {
        BlockKind::Figure
    };
    parse_asset_number(caption, other).is_none()
}

fn parse_table(content: &str) -> Result<Value, BridgeError> {
    let html = Html::parse_fragment(content);
    let rows =
        Selector::parse("table > tbody > tr, table > tr, table > thead > tr, table > tfoot > tr")
            .unwrap();
    let cells = Selector::parse("td, th").unwrap();
    let mut output = vec![];
    for row in html.select(&rows).take(1001) {
        let mut result = vec![];
        for cell in row.select(&cells).take(257) {
            if cell
                .select(&Selector::parse("script,style,iframe,object,embed,svg,math,img").unwrap())
                .next()
                .is_some()
            {
                return Err(invalid("Unsafe table content"));
            }
            let span = |name| -> Result<u64, BridgeError> {
                let n = cell
                    .value()
                    .attr(name)
                    .unwrap_or("1")
                    .parse::<u64>()
                    .map_err(|_| invalid("Invalid table span"))?;
                if n == 0 || n > 256 {
                    return Err(invalid("Invalid table span"));
                }
                Ok(n)
            };
            result.push(json!({"text":cell.text().collect::<String>(),"rowspan":span("rowspan")?,"colspan":span("colspan")?,"header":cell.value().name()=="th"}));
        }
        if result.len() > 256 {
            return Err(invalid("Too many table columns"));
        }
        output.push(result);
    }
    if output.is_empty() || output.len() > 1000 {
        return Err(invalid("Missing or oversized structured table"));
    }
    Ok(json!({"rows":output}))
}
fn table_markdown(table: &Value) -> String {
    let rows = table["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "| {} |",
                row.as_array()
                    .unwrap()
                    .iter()
                    .map(|cell| cell["text"]
                        .as_str()
                        .unwrap()
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('|', "\\|")
                        .replace('\n', " "))
                    .collect::<Vec<_>>()
                    .join(" | ")
            )
        })
        .collect::<Vec<_>>();
    let columns = table["rows"][0].as_array().unwrap().len();
    let mut result = vec![
        rows[0].clone(),
        format!("|{}|", vec!["---"; columns].join("|")),
    ];
    result.extend(rows.into_iter().skip(1));
    result.join("\n")
}
