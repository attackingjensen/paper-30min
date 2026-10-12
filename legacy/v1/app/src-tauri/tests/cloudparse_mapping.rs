use paper30min_lib::{
    cloudparse_map::{map_aistudio_jsonl, MappingContext},
    pdf_identity::read_pdf_identity,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn adam() -> (
    paper30min_lib::pdf_identity::PdfIdentity,
    Vec<serde_json::Value>,
) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    (
        read_pdf_identity(&root.join("tests/fixtures/regression/corpus/1412.6980.pdf")).unwrap(),
        include_str!("fixtures/aistudio/1412.6980.jsonl")
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect(),
    )
}
fn convert(
    identity: &paper30min_lib::pdf_identity::PdfIdentity,
    rows: &[serde_json::Value],
) -> Result<paper30min_lib::cloudparse_map::CloudMapped, paper30min_lib::error::BridgeError> {
    let raw = rows
        .iter()
        .map(|r| serde_json::to_string(r).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes();
    map_aistudio_jsonl(
        &raw,
        identity,
        &MappingContext {
            paper_id: "paper".into(),
            batch_id: "batch".into(),
            pdf_sha256: identity.sha256.clone(),
            raw_sha256: digest(&raw),
            model: "PaddleOCR-VL-1.6".into(),
            options: json!({"useDocOrientationClassify":false,"useDocUnwarping":false}),
        },
    )
}

fn excerpt(
    id: &str,
) -> (
    paper30min_lib::pdf_identity::PdfIdentity,
    Vec<serde_json::Value>,
) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let identity =
        read_pdf_identity(&root.join(format!("tests/fixtures/regression/corpus/{id}.pdf")))
            .unwrap();
    let raw =
        std::fs::read_to_string(root.join(format!("tests/fixtures/aistudio/{id}.jsonl"))).unwrap();
    (
        identity,
        raw.lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect(),
    )
}

#[test]
fn punctuated_main_headings_and_appendices_are_sections() {
    let (identity, rows) = excerpt("1512.03385");
    let mapped = convert(&identity, &rows).unwrap().mapped;
    let body = mapped
        .sections
        .iter()
        .find(|s| s.title == "3. Deep Residual Learning")
        .expect("numbered main section");
    assert_eq!(body.number.as_deref(), Some("3"));
    assert_eq!(body.role, paper30min_lib::pdfmap::SectionRole::Body);
    let appendix = mapped
        .sections
        .iter()
        .find(|s| s.title == "A. Object Detection Baselines")
        .expect("lettered appendix section");
    assert_eq!(appendix.number.as_deref(), Some("A"));
    assert_eq!(appendix.role, paper30min_lib::pdfmap::SectionRole::Appendix);
    assert!(appendix.blocks.iter().any(|b| b.page == 10));
}

#[test]
fn heading_subsections_keep_cross_page_block_ranges() {
    let (identity, rows) = excerpt("1603.02754");
    let mapped = convert(&identity, &rows).unwrap().mapped;
    let section = mapped
        .sections
        .iter()
        .find(|s| s.title == "4. SYSTEM DESIGN")
        .expect("system section");
    let subsection = section
        .subsections
        .iter()
        .find(|s| s.number.as_deref() == Some("4.2"))
        .expect("cache subsection");
    let next = section
        .subsections
        .iter()
        .find(|s| s.number.as_deref() == Some("4.3"))
        .unwrap();
    assert_eq!(subsection.level, 2);
    assert_eq!(subsection.page_start, 6);
    assert_eq!(subsection.block_end + 1, next.block_start);
    assert_eq!(
        section.blocks[(subsection.block_end - 1) as usize].page,
        subsection.page_end
    );
    assert!(subsection.block_end >= subsection.block_start);
    let last = section.subsections.last().unwrap();
    assert_eq!(last.block_end as usize, section.blocks.len());
}

#[test]
fn adjacent_figure_and_table_titles_keep_their_own_assets() {
    let (identity, mut rows) = adam();
    let block = |id, label, content| json!({"block_id":id,"block_order":null,"group_id":id,"block_label":label,"block_content":content,"block_bbox":[100,100,400,200]});
    rows[0]["result"]["layoutParsingResults"][0]["prunedResult"]["parsing_res_list"] = json!([
        block(0, "paragraph_title", "1. INTRODUCTION"),
        block(1, "chart", ""),
        block(
            2,
            "figure_title",
            "Figure 10: Comparison between XGBoost and pGBRT on Yahoo LTRC dataset."
        ),
        block(
            3,
            "figure_title",
            "Table 4: Comparison of Learning to Rank with 500 trees on Yahoo! LTRC Dataset"
        ),
        block(
            4,
            "table",
            "<table><tr><td>Method</td><td>NDCG@10</td></tr></table>"
        )
    ]);
    let result = convert(&identity, &rows).unwrap();
    let figure = result
        .mapped
        .figures
        .iter()
        .find(|a| a.id == "fig_10")
        .expect("Figure 10");
    let table = result
        .mapped
        .tables
        .iter()
        .find(|a| a.id == "tbl_4")
        .expect("Table 4");
    assert!(figure.caption.as_ref().unwrap().starts_with("Figure 10:"));
    assert!(table.caption.as_ref().unwrap().starts_with("Table 4:"));
    let section = result
        .mapped
        .sections
        .iter()
        .find(|s| s.title == "1. INTRODUCTION")
        .unwrap();
    for asset in ["fig_10", "tbl_4"] {
        let b = section
            .blocks
            .iter()
            .find(|b| b.asset_id.as_deref() == Some(asset))
            .unwrap();
        assert_eq!(b.source_regions.len(), 2);
        assert_eq!(
            result.source["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["secId"] == section.id && r["blockId"] == b.id)
                .unwrap()["sourceRegions"],
            serde_json::to_value(&b.source_regions).unwrap()
        );
    }
}

#[test]
fn grouped_empty_continuation_keeps_both_regions() {
    let (identity, rows) = adam();
    let mapped = convert(&identity, &rows).unwrap().mapped;
    let authors = mapped
        .frontmatter
        .iter()
        .find(|b| b.text.contains("Kingma"))
        .unwrap();
    assert_eq!(authors.source_regions.len(), 2);
    assert!(authors.source_regions.iter().all(|r| r.charspan.is_none()));
}

#[test]
fn coordinates_scale_to_pdf_and_invalid_box_degrades_whole_group() {
    let (identity, mut rows) = adam();
    let result = convert(&identity, &rows).unwrap();
    let author = result
        .mapped
        .frontmatter
        .iter()
        .find(|b| b.text.contains("Kingma"))
        .unwrap();
    let expected = 340.0 * identity.pages[0].width / 1191.0 * 2.0;
    assert!((author.source_regions[0].bbox[0] - expected).abs() < 0.001);
    let blocks = rows[0]["result"]["layoutParsingResults"][0]["prunedResult"]["parsing_res_list"]
        .as_array_mut()
        .unwrap();
    blocks
        .iter_mut()
        .find(|b| b["block_content"] == "" && b["group_id"] == 3)
        .unwrap()["block_bbox"] = json!([-1, 298, 892, 363]);
    let result = convert(&identity, &rows).unwrap();
    assert!(result
        .mapped
        .frontmatter
        .iter()
        .find(|b| b.text.contains("Kingma"))
        .unwrap()
        .source_regions
        .is_empty());
}

#[test]
fn pdf_and_raw_digest_mismatch_fail() {
    let (identity, rows) = adam();
    let raw = rows
        .iter()
        .map(|r| r.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes();
    let mut context = MappingContext {
        paper_id: "paper".into(),
        batch_id: "batch".into(),
        pdf_sha256: identity.sha256.clone(),
        raw_sha256: digest(&raw),
        model: "PaddleOCR-VL-1.6".into(),
        options: json!({"useDocOrientationClassify":false,"useDocUnwarping":false}),
    };
    context.pdf_sha256 = "0".repeat(64);
    assert!(map_aistudio_jsonl(&raw, &identity, &context).is_err());
    context.pdf_sha256 = identity.sha256.clone();
    context.raw_sha256 = "0".repeat(64);
    assert!(map_aistudio_jsonl(&raw, &identity, &context).is_err());
}

#[test]
fn saved_model_float_coordinates_roundtrip_without_changing_projection() {
    let (identity, rows) = adam();
    let result = convert(&identity, &rows).unwrap();
    let decoded = serde_json::from_slice::<paper30min_lib::pdfmap::MappedPaper>(
        &serde_json::to_vec(&result.mapped).unwrap(),
    )
    .unwrap();
    assert_eq!(result.mapped, decoded);
    assert_eq!(
        result.source["projectionSha256"],
        paper30min_lib::cloudparse_map::projection_sha256(&decoded).unwrap()
    );
}

#[test]
fn reversed_ordered_text_is_rejected_instead_of_reordering_visuals() {
    let (identity, mut rows) = adam();
    let blocks = rows[0]["result"]["layoutParsingResults"][0]["prunedResult"]["parsing_res_list"]
        .as_array_mut()
        .unwrap();
    let indices = blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b["block_order"].as_u64().is_some())
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    blocks.swap(indices[0], indices[1]);
    assert!(convert(&identity, &rows).is_err());
}

#[test]
fn incomplete_duplicate_and_error_results_fail() {
    let (identity, rows) = adam();
    let mut changed = rows.clone();
    changed.pop();
    assert!(convert(&identity, &changed).is_err());
    let mut changed = rows.clone();
    changed[0]["result"]["layoutParsingResults"][1] =
        changed[0]["result"]["layoutParsingResults"][0].clone();
    assert!(convert(&identity, &changed).is_err());
    let mut changed = rows;
    changed[0]["errorCode"] = json!(500);
    assert!(convert(&identity, &changed).is_err());
}

#[test]
fn untrusted_geometry_has_page_source_without_precise_regions() {
    let (mut identity, rows) = adam();
    for page in &mut identity.pages {
        page.trusted_geometry = false;
    }
    let mapped = convert(&identity, &rows).unwrap();
    assert!(mapped.source["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|b| b["sourceRegions"].as_array().unwrap().is_empty()
            && !b["pages"].as_array().unwrap().is_empty()));
    assert!(mapped
        .mapped
        .tables
        .iter()
        .chain(mapped.mapped.figures.iter())
        .all(|a| a.bbox.is_none()));
}

#[test]
fn table_retains_spans_and_excludes_executable_markup() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let identity =
        read_pdf_identity(&root.join("tests/fixtures/regression/corpus/1512.03385.pdf")).unwrap();
    let mut rows: Vec<serde_json::Value> = include_str!("fixtures/aistudio/1512.03385.jsonl")
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let mapped = convert(&identity, &rows).unwrap();
    let table = mapped.source["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|b| b.get("table"))
        .unwrap();
    assert!(table["rows"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|r| r.as_array().unwrap())
        .any(|c| c["colspan"].as_u64().unwrap() > 1));
    for row in &mut rows {
        for page in row["result"]["layoutParsingResults"]
            .as_array_mut()
            .unwrap()
        {
            for block in page["prunedResult"]["parsing_res_list"]
                .as_array_mut()
                .unwrap()
            {
                if block["block_label"] == "table" {
                    block["block_content"] =
                        json!("<table><tr><td><script>alert(1)</script>1</td></tr></table>");
                }
            }
        }
    }
    assert!(convert(&identity, &rows).is_err());
}

#[test]
#[ignore = "Requires ignored local real AI Studio pilot results; no network"]
fn maps_all_four_complete_local_results() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for id in ["1412.6980", "1503.02531", "1512.03385", "1603.02754"] {
        let identity =
            read_pdf_identity(&root.join(format!("tests/fixtures/regression/corpus/{id}.pdf")))
                .unwrap();
        let raw = std::fs::read_to_string(root.join(format!(
            "../../../../tmp/aistudio-pilot-20261006/{id}/result.jsonl"
        )))
        .unwrap();
        let rows = raw
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect::<Vec<_>>();
        let mapped = convert(&identity, &rows).unwrap();
        assert_eq!(mapped.mapped.page_count, identity.pages.len() as u32);
        assert!(!mapped.mapped.sections.is_empty());
        if id == "1412.6980" {
            for (number, page, regions) in [("2", 7, 4), ("3", 7, 2), ("4", 8, 4)] {
                let asset_id = format!("fig_{number}");
                let figure = mapped
                    .mapped
                    .figures
                    .iter()
                    .find(|a| a.id == asset_id)
                    .expect("Adam numbered figure");
                assert_eq!(figure.page, page);
                let caption = figure.caption.as_deref().unwrap();
                assert!(caption.starts_with(&format!("Figure {number}:")));
                if number != "3" {
                    assert!(caption.contains("\n(a)"));
                    assert!(caption.contains("\n(b)"));
                }
                let block = mapped
                    .mapped
                    .sections
                    .iter()
                    .flat_map(|s| &s.blocks)
                    .find(|b| b.asset_id.as_deref() == Some(&asset_id))
                    .unwrap();
                assert_eq!(block.source_regions.len(), regions);
            }
        }
        if id == "1603.02754" {
            let figure = mapped
                .mapped
                .figures
                .iter()
                .find(|a| a.id == "fig_10")
                .unwrap();
            let table = mapped
                .mapped
                .tables
                .iter()
                .find(|a| a.id == "tbl_4")
                .unwrap();
            assert_eq!(figure.page, 8);
            assert_eq!(table.page, 8);
            assert!(figure.caption.as_deref().unwrap().starts_with("Figure 10:"));
            assert!(table.caption.as_deref().unwrap().starts_with("Table 4:"));
            let section = mapped
                .mapped
                .sections
                .iter()
                .find(|s| s.number.as_deref() == Some("6"))
                .unwrap();
            assert!(section
                .subsections
                .iter()
                .any(|s| s.number.as_deref() == Some("6.3") && s.page_start == 8));
            let appendix = mapped
                .mapped
                .sections
                .iter()
                .find(|s| s.number.as_deref() == Some("A"))
                .unwrap();
            assert!(appendix
                .subsections
                .iter()
                .any(|s| s.number.as_deref() == Some("A.1")));
        }
    }
}

#[test]
fn maps_four_real_result_excerpts() {
    for (id, count) in [
        ("1412.6980", 15),
        ("1503.02531", 9),
        ("1512.03385", 12),
        ("1603.02754", 13),
    ] {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let pdf = root.join(format!("tests/fixtures/regression/corpus/{id}.pdf"));
        let identity = read_pdf_identity(&pdf).unwrap();
        let raw = std::fs::read(root.join(format!("tests/fixtures/aistudio/{id}.jsonl"))).unwrap();
        let context = MappingContext {
            paper_id: "paper".into(),
            batch_id: "batch".into(),
            pdf_sha256: identity.sha256.clone(),
            raw_sha256: digest(&raw),
            model: "PaddleOCR-VL-1.6".into(),
            options: json!({"useDocOrientationClassify":false,"useDocUnwarping":false}),
        };
        let result = map_aistudio_jsonl(&raw, &identity, &context).unwrap();
        assert_eq!(result.mapped.page_count, count);
        assert!(!result.mapped.sections.is_empty());
        assert_eq!(result.source["pdfSha256"], identity.sha256);
        assert_eq!(
            result.source["blockModelSha256"],
            digest(&serde_json::to_vec(&result.mapped).unwrap())
        );
    }
}
