use base64::{engine::general_purpose::STANDARD, Engine};
use paper30min_lib::{
    bridge, cloudassets,
    cloudparse_map::{map_aistudio_jsonl, MappingContext},
    files::AttachmentWrite,
    library::Library,
    parsebatch::ParseBatchManifest,
    tasks::{TaskRegistry, TaskStatus},
    testkit,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn visual_commands_reject_unknown_task_identity() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(dir.path()).unwrap());
    let registry = TaskRegistry::new(library.clone());
    for command in ["cloudassets.plan@1", "cloudassets.put@1"] {
        let error = bridge::invoke(
            &registry,
            &library,
            command,
            &json!({"taskId":"absent","attachmentId":"pageimg-0001","contentBase64":""}),
        )
        .unwrap_err();
        assert_eq!(error.code, "not_found");
    }
}

fn candidate() -> (Arc<TaskRegistry>, Arc<Library>, tempfile::TempDir) {
    candidate_with_pages(None)
}
fn candidate_with_pages(
    pages: Option<Vec<u32>>,
) -> (Arc<TaskRegistry>, Arc<Library>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(dir.path()).unwrap());
    let registry = TaskRegistry::new(library.clone());
    bridge::invoke(
        &registry,
        &library,
        "library.putPaper@1",
        &json!({"paper":{"id":"p","title":"Adam"}}),
    )
    .unwrap();
    let pdf = include_bytes!("fixtures/regression/corpus/1412.6980.pdf");
    library
        .put_attachment(
            "p",
            AttachmentWrite {
                id: "pdf".into(),
                name: "adam.pdf".into(),
                content_type: Some("application/pdf".into()),
                content_base64: STANDARD.encode(pdf),
            },
        )
        .unwrap();
    let identity = paper30min_lib::pdf_identity::read_pdf_identity_bytes(pdf).unwrap();
    let raw = include_bytes!("fixtures/aistudio/1412.6980.jsonl");
    let options = json!({});
    let mut mapped = map_aistudio_jsonl(
        raw,
        &identity,
        &MappingContext {
            paper_id: "p".into(),
            batch_id: "parent".into(),
            pdf_sha256: identity.sha256.clone(),
            raw_sha256: sha256_hex(raw),
            model: "PaddleOCR-VL-1.6".into(),
            options: options.clone(),
        },
    )
    .unwrap();
    if let Some(pages) = pages {
        let section = mapped
            .mapped
            .sections
            .iter_mut()
            .find(|s| {
                s.blocks.iter().any(|b| {
                    matches!(
                        b.kind,
                        paper30min_lib::pdfmap::BlockKind::Formula
                            | paper30min_lib::pdfmap::BlockKind::Figure
                            | paper30min_lib::pdfmap::BlockKind::Table
                    )
                })
            })
            .unwrap();
        let block = section
            .blocks
            .iter_mut()
            .find(|b| {
                matches!(
                    b.kind,
                    paper30min_lib::pdfmap::BlockKind::Formula
                        | paper30min_lib::pdfmap::BlockKind::Figure
                        | paper30min_lib::pdfmap::BlockKind::Table
                )
            })
            .unwrap();
        block.source_regions.clear();
        let pages: Vec<_> = pages.into_iter().map(|p| block.page + p - 1).collect();
        let source = mapped.source["blocks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|e| e["secId"] == section.id && e["blockId"] == block.id)
            .unwrap();
        source["sourceRegions"] = json!([]);
        source["pages"] = json!(pages);
        mapped.source["blockModelSha256"] =
            json!(sha256_hex(&serde_json::to_vec(&mapped.mapped).unwrap()));
        mapped.source["projectionSha256"] =
            json!(paper30min_lib::cloudparse_map::projection_sha256(&mapped.mapped).unwrap());
    }
    let manifest = ParseBatchManifest {
        schema_version: 1,
        paper_id: "p".into(),
        batch_id: "parent".into(),
        pdf_sha256: identity.sha256,
        provider: "baidu".into(),
        model: "PaddleOCR-VL-1.6".into(),
        options,
        raw_sha256: sha256_hex(raw),
        attachments: BTreeMap::new(),
    };
    library
        .write_parse_batch(
            manifest,
            BTreeMap::from([
                ("pdf".into(), pdf.to_vec()),
                (
                    "blockmodel.json".into(),
                    serde_json::to_vec(&mapped.mapped).unwrap(),
                ),
                (
                    "cloud-source.json".into(),
                    serde_json::to_vec(&mapped.source).unwrap(),
                ),
            ]),
        )
        .unwrap();
    (registry, library, dir)
}

#[test]
fn page_fallback_preserves_related_pages_and_rejects_unbound_page_lists() {
    let (registry, library, _dir) = candidate_with_pages(Some(vec![1, 2]));
    let task = start(&registry);
    let plan = wait_plan(&registry, &library, &task);
    let snapshot = library.pin_parse_batch("p", Some("parent")).unwrap();
    let (_, bytes) = library
        .read_parse_batch_attachment(&snapshot, "blockmodel.json")
        .unwrap();
    let mapped = serde_json::from_slice(&bytes).unwrap();
    let error = cloudassets::read_visual_assets(&library, &snapshot, &mapped).unwrap_err();
    assert_eq!(error.code, "preflight_missing");
    assert!(error.details.unwrap()["missing"]
        .as_array()
        .unwrap()
        .contains(&json!("pageimg-0002")));
    assert_eq!(plan["state"], "ready");
    registry.request_cancel(&task).unwrap();
    testkit::wait_terminal(&registry, &task, Duration::from_secs(10)).unwrap();
    for pages in [vec![1, 1], vec![1, 16], vec![2]] {
        let (registry, _library, _dir) = candidate_with_pages(Some(pages));
        let task = start(&registry);
        assert_eq!(
            testkit::wait_terminal(&registry, &task, Duration::from_secs(10)).unwrap(),
            TaskStatus::Failed
        );
    }
}
fn start(registry: &Arc<TaskRegistry>) -> String {
    registry
        .start(
            "cloudassets.prepare@1",
            json!({"paperId":"p","batchId":"parent"}),
            testkit::Collector::new(),
        )
        .unwrap()
}
fn wait_plan(registry: &Arc<TaskRegistry>, library: &Library, task: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let plan = bridge::invoke(
            registry,
            library,
            "cloudassets.plan@1",
            &json!({"taskId":task}),
        )
        .unwrap();
        if plan["state"] != "preparing" {
            return plan;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&vec![255; width as usize * height as usize * 4])
            .unwrap();
    }
    bytes
}
fn upload(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    task: &str,
    r: &serde_json::Value,
) -> Result<serde_json::Value, paper30min_lib::error::BridgeError> {
    bridge::invoke(
        registry,
        library,
        "cloudassets.put@1",
        &json!({"taskId":task,"attachmentId":r["attachmentId"],"contentBase64":STANDARD.encode(png(r["width"].as_u64().unwrap() as u32,r["height"].as_u64().unwrap() as u32))}),
    )
}

#[test]
fn cancellation_preserves_verified_images_and_complete_resume_seals_new_batch() {
    let (registry, library, _dir) = candidate();
    let parent = library.pin_parse_batch("p", Some("parent")).unwrap();
    let task = start(&registry);
    let plan = wait_plan(&registry, &library, &task);
    assert_eq!(
        plan["resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["bbox"].is_null())
            .count(),
        15
    );
    let first = &plan["resources"][0];
    upload(&registry, &library, &task, first).unwrap();
    assert_eq!(
        registry
            .start(
                "cloudassets.prepare@1",
                json!({"paperId":"p","batchId":"parent"}),
                testkit::Collector::new()
            )
            .unwrap_err()
            .code,
        "paper_busy"
    );
    registry.request_cancel(&task).unwrap();
    assert_eq!(
        testkit::wait_terminal(&registry, &task, Duration::from_secs(10)).unwrap(),
        TaskStatus::Cancelled
    );
    assert!(upload(&registry, &library, &task, first).is_err());
    let registry = TaskRegistry::new(library.clone());
    let resumed = start(&registry);
    let resume = wait_plan(&registry, &library, &resumed);
    assert_eq!(
        resume["completedAttachmentIds"],
        json!([first["attachmentId"]])
    );
    for r in resume["resources"].as_array().unwrap() {
        if r["attachmentId"] != first["attachmentId"] {
            upload(&registry, &library, &resumed, r).unwrap();
        }
    }
    assert_eq!(
        testkit::wait_terminal(&registry, &resumed, Duration::from_secs(30)).unwrap(),
        TaskStatus::Succeeded,
        "{:?}",
        registry.get(&resumed)
    );
    library.verify_parse_batch(&parent).unwrap();
    assert!(library.get_attachment("p", "blockmodel.json").is_err());
    let snapshot = library
        .pin_parse_batch("p", Some(&cloudassets::output_batch_id("parent")))
        .unwrap();
    let (_, model) = library
        .read_parse_batch_attachment(&snapshot, "blockmodel.json")
        .unwrap();
    let mapped = serde_json::from_slice(&model).unwrap();
    let visual = cloudassets::read_visual_assets(&library, &snapshot, &mapped).unwrap();
    assert_eq!(visual.pages.len(), 15);
    assert!(!visual.assets.is_empty());
    let (_, source) = library
        .read_parse_batch_attachment(&snapshot, "cloud-source.json")
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&source).unwrap()["batchId"],
        snapshot.manifest.batch_id
    );
    assert!(upload(&registry, &library, &resumed, first).is_err());
    let repeated = start(&registry);
    assert_eq!(
        testkit::wait_terminal(&registry, &repeated, Duration::from_secs(15)).unwrap(),
        TaskStatus::Succeeded
    );
    assert_eq!(
        registry.get(&repeated).unwrap().result.unwrap()["batchId"],
        snapshot.manifest.batch_id
    );
}

#[test]
fn invalid_image_and_unplanned_identity_do_not_complete_resources() {
    let (registry, library, _dir) = candidate();
    let task = start(&registry);
    let plan = wait_plan(&registry, &library, &task);
    let r = &plan["resources"][0];
    for (id, content) in [
        ("../escape".to_string(), STANDARD.encode(png(1, 1))),
        (
            r["attachmentId"].as_str().unwrap().into(),
            STANDARD.encode(b"not PNG"),
        ),
        (
            r["attachmentId"].as_str().unwrap().into(),
            STANDARD.encode(png(1, 1)),
        ),
    ] {
        assert!(bridge::invoke(
            &registry,
            &library,
            "cloudassets.put@1",
            &json!({"taskId":task,"attachmentId":id,"contentBase64":content})
        )
        .is_err());
    }
    assert!(bridge::invoke(&registry,&library,"cloudassets.put@1",&json!({"taskId":task,"attachmentId":r["attachmentId"],"contentBase64":"a".repeat(12*1024*1024)})).is_err());
    let after = wait_plan(&registry, &library, &task);
    assert_eq!(after["completedAttachmentIds"], json!([]));
    assert!(library
        .pin_parse_batch("p", Some(&cloudassets::output_batch_id("parent")))
        .is_err());
    registry.request_cancel(&task).unwrap();
    testkit::wait_terminal(&registry, &task, Duration::from_secs(10)).unwrap();
}

#[test]
fn corrupt_resumed_image_fails_before_rendering() {
    let (registry, library, dir) = candidate();
    let task = start(&registry);
    let plan = wait_plan(&registry, &library, &task);
    let r = &plan["resources"][0];
    upload(&registry, &library, &task, r).unwrap();
    registry.request_cancel(&task).unwrap();
    testkit::wait_terminal(&registry, &task, Duration::from_secs(10)).unwrap();
    std::fs::write(
        dir.path()
            .join("operations/cloudassets/p")
            .join(cloudassets::output_batch_id("parent"))
            .join(r["attachmentId"].as_str().unwrap()),
        b"corrupted",
    )
    .unwrap();
    let resumed = start(&registry);
    assert_eq!(
        testkit::wait_terminal(&registry, &resumed, Duration::from_secs(10)).unwrap(),
        TaskStatus::Failed
    );
    assert!(library
        .pin_parse_batch("p", Some(&cloudassets::output_batch_id("parent")))
        .is_err());
}

#[test]
fn png_decoder_rejects_truncation_and_dimension_limits() {
    let bytes = png(3, 2);
    cloudassets::validate_png(&bytes, 3, 2).unwrap();
    assert!(cloudassets::validate_png(&bytes, 2, 3).is_err());
    assert!(cloudassets::validate_png(&bytes, 1601, 2).is_err());
    assert!(cloudassets::validate_png(&bytes[..bytes.len() - 12], 3, 2).is_err());
}
