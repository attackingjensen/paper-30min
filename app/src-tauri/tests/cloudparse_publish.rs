mod common;
use base64::{engine::general_purpose::STANDARD, Engine};
use paper30min_lib::{files::AttachmentWrite, library::PaperDto, parsebatch::ParseBatchManifest};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn local_candidate(
    library: &paper30min_lib::library::Library,
    batch: &str,
    text: &str,
) -> paper30min_lib::parsebatch::ParseBatchSnapshot {
    let pdf = include_bytes!("fixtures/regression/corpus/1412.6980.pdf");
    let sha = format!("{:x}", Sha256::digest(pdf));
    let pages: serde_json::Map<String, serde_json::Value> = (1..=15)
        .map(|page| {
            (
                page.to_string(),
                json!({"page_no":page,"size":{"width":612,"height":792}}),
            )
        })
        .collect();
    let raw = json!({"schema_name":"DoclingDocument","origin":{"mimetype":"application/pdf","binary_hash":u64::from_str_radix(&sha[48..],16).unwrap()},"name":"fixture","body":{"children":[{"$ref":"#/texts/0"},{"$ref":"#/texts/1"}]},"furniture":{"children":[]},"groups":[],"pictures":[],"tables":[],"texts":[{"self_ref":"#/texts/0","label":"section_header","text":"1 Introduction","content_layer":"body","prov":[{"page_no":1,"bbox":{"l":10,"r":100,"t":20,"b":30,"coord_origin":"TOPLEFT"}}]},{"self_ref":"#/texts/1","label":"text","text":text,"content_layer":"body","prov":[{"page_no":1,"bbox":{"l":10,"r":100,"t":40,"b":50,"coord_origin":"TOPLEFT"}}]}],"pages":pages});
    let mapped = paper30min_lib::pdfmap::map_docling_json_str(&raw.to_string()).unwrap();
    let model = serde_json::to_vec(&mapped).unwrap();
    let model_sha = format!("{:x}", Sha256::digest(&model));
    let source = serde_json::to_vec(&raw).unwrap();
    let webp = STANDARD
        .decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
        .unwrap();
    let mut resources: BTreeMap<String, Vec<u8>> = BTreeMap::from([
        ("pdf".into(), pdf.to_vec()),
        ("blockmodel.json".into(), model),
        ("docling-source.json".into(), source.clone()),
    ]);
    let mut visuals = serde_json::Map::new();
    for page in 1..=15 {
        let id = format!("pageimg-{page:04}");
        visuals.insert(id.clone(),json!({"sha256":format!("{:x}",Sha256::digest(&webp)),"bytes":webp.len(),"width":1,"height":1}));
        resources.insert(id, webp.clone());
    }
    resources.insert("local-visual-assets.json".into(),serde_json::to_vec(&json!({"schemaVersion":1,"batchId":batch,"pdfSha256":sha,"blockModelSha256":model_sha,"resources":visuals})).unwrap());
    let attachments = resources
        .iter()
        .map(|(id, bytes)| {
            (
                id.clone(),
                paper30min_lib::parsebatch::ParseBatchAttachment {
                    attachment_id: id.clone(),
                    sha256: format!("{:x}", Sha256::digest(bytes)),
                    size: bytes.len() as u64,
                    content_type: if id == "pdf" {
                        "application/pdf"
                    } else if id.starts_with("pageimg-") {
                        "image/webp"
                    } else {
                        "application/json"
                    }
                    .into(),
                },
            )
        })
        .collect();
    library
        .write_parse_batch(
            ParseBatchManifest {
                schema_version: 1,
                paper_id: "p".into(),
                batch_id: batch.into(),
                pdf_sha256: sha,
                provider: "docling".into(),
                model: "local".into(),
                options: json!({"parseGeneration":batch}),
                raw_sha256: format!("{:x}", Sha256::digest(&source)),
                attachments,
            },
            resources,
        )
        .unwrap();
    library.pin_parse_batch("p", Some(batch)).unwrap()
}

fn setup_local() -> (
    std::sync::Arc<paper30min_lib::library::Library>,
    tempfile::TempDir,
) {
    let (_, library, dir) = common::env();
    library
        .put_paper(PaperDto {
            id: "p".into(),
            title: "Paper".into(),
            ..Default::default()
        })
        .unwrap();
    library
        .put_attachment(
            "p",
            AttachmentWrite {
                id: "pdf".into(),
                name: "paper.pdf".into(),
                content_type: Some("application/pdf".into()),
                content_base64: STANDARD
                    .encode(include_bytes!("fixtures/regression/corpus/1412.6980.pdf")),
            },
        )
        .unwrap();
    (library, dir)
}

#[test]
fn replacement_fault_rolls_back_and_success_archives_actual_history() {
    let (library, dir) = setup_local();
    let first = local_candidate(&library, "first", "Old paragraph");
    library
        .publish_parse_batch(&first, None, false, false, || Ok(()))
        .unwrap();
    let mut paper = library.get_paper("p").unwrap();
    paper.recall_card.markdown = "Actual user notes".into();
    paper.products.push(paper30min_lib::library::ProductDto {
        kind: "map".into(),
        part_id: String::new(),
        body: json!({"old":true}),
        updated_at: "2026-10-06T00:00:00Z".into(),
    });
    paper.chat.push(serde_json::from_value(json!({"role":"user","content":"Actual question","bindingKind":"fragment","fragmentText":"Actual selected text","cite":{"startSecId":"sec_1_introduction","startBlock":1,"endSecId":"sec_1_introduction","endBlock":1}})).unwrap());
    paper = library.put_paper(paper).unwrap();
    let next = local_candidate(&library, "next", "New paragraph");
    assert_eq!(
        library
            .publish_parse_batch(&next, Some("first"), false, false, || Ok(()))
            .unwrap_err()
            .code,
        "parse_replace_confirmation_required"
    );
    let calls = std::cell::Cell::new(0);
    let error = library
        .publish_parse_batch(&next, Some("first"), true, false, || {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                Err(paper30min_lib::error::BridgeError::new(
                    "injected",
                    "Before commit",
                    false,
                ))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert_eq!(error.code, "injected");
    assert_eq!(library.get_paper("p").unwrap(), paper);
    let current = library
        .publish_parse_batch(&next, Some("first"), true, false, || Ok(()))
        .unwrap();
    assert!(current.chat.is_empty());
    assert!(current.products.is_empty());
    assert_eq!(
        current.parse_history[0]["paper"]["chat"][0]["fragmentText"],
        "Actual selected text"
    );
    assert_eq!(
        current.parse_history[0]["paper"]["recallCard"]["markdown"],
        "Actual user notes"
    );
    assert_eq!(
        current.parse_history[0]["paper"]["products"][0]["body"]["old"],
        true
    );
    assert_eq!(
        library
            .publish_parse_batch(&first, Some("first"), true, false, || Ok(()))
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
    drop(library);
    let reopened = paper30min_lib::library::Library::open(dir.path()).unwrap();
    assert_eq!(
        reopened.current_parse_batch_id("p").unwrap().as_deref(),
        Some("next")
    );
    assert_eq!(reopened.get_paper("p").unwrap().parse_history.len(), 1);
    let old = reopened.pin_parse_batch("p", Some("first")).unwrap();
    let bytes = reopened
        .read_parse_batch_attachment(&old, "blockmodel.json")
        .unwrap()
        .1;
    assert!(String::from_utf8(bytes).unwrap().contains("Old paragraph"));
}

#[test]
fn confirmed_overwrite_skips_archiving_a_corrupt_current_batch() {
    let (library, _dir) = setup_local();
    let first = local_candidate(&library, "first", "Old paragraph");
    library
        .publish_parse_batch(&first, None, false, false, || Ok(()))
        .unwrap();
    let resource = &first.manifest.attachments["pdf"].attachment_id;
    std::fs::write(
        std::path::Path::new(&library.info().data_root)
            .join("attachments/p")
            .join(resource),
        b"corrupted",
    )
    .unwrap();
    assert!(library.pin_parse_batch("p", None).is_err());
    let next = local_candidate(&library, "next", "New paragraph");
    assert!(library
        .publish_parse_batch(&next, Some("first"), false, false, || Ok(()))
        .is_err());
    let current = library
        .publish_parse_batch(&next, Some("first"), true, false, || Ok(()))
        .unwrap();
    assert_eq!(current.parse_batch_id.as_deref(), Some("next"));
    assert!(current.parse_history.is_empty());
    assert_eq!(
        library.current_parse_batch_id("p").unwrap().as_deref(),
        Some("next")
    );
}

#[test]
fn visual_successor_preserves_early_map_but_missing_visual_replacement_cannot_publish() {
    let (library, _dir) = setup_local();
    let parent = local_candidate(&library, "initial-local", "Same text");
    library
        .publish_parse_batch(&parent, None, false, false, || Ok(()))
        .unwrap();
    let mut paper = library.get_paper("p").unwrap();
    paper.products.push(paper30min_lib::library::ProductDto {
        kind: "map".into(),
        part_id: String::new(),
        body: json!({"ready":true}),
        updated_at: "2026-10-06T00:00:00Z".into(),
    });
    library.put_paper(paper).unwrap();
    let mut manifest = parent.manifest.clone();
    manifest.batch_id = "visual-successor".into();
    manifest.options["parentBatchId"] = json!("initial-local");
    let mut resources = BTreeMap::new();
    for id in parent.manifest.attachments.keys() {
        let (_, mut bytes) = library.read_parse_batch_attachment(&parent, id).unwrap();
        if id == "local-visual-assets.json" {
            let mut visual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            visual["batchId"] = json!("visual-successor");
            bytes = serde_json::to_vec(&visual).unwrap();
        }
        resources.insert(id.clone(), bytes);
    }
    manifest.attachments.clear();
    // Preserve media types independently from regenerated resource digests.
    for (id, bytes) in &resources {
        let mut entry = parent.manifest.attachments[id].clone();
        entry.sha256 = format!("{:x}", Sha256::digest(bytes));
        entry.size = bytes.len() as u64;
        manifest.attachments.insert(id.clone(), entry);
    }
    library.write_parse_batch(manifest, resources).unwrap();
    let successor = library
        .pin_parse_batch("p", Some("visual-successor"))
        .unwrap();
    let current = library
        .publish_parse_batch(&successor, Some("initial-local"), false, false, || Ok(()))
        .unwrap();
    assert_eq!(current.products.len(), 1);
    assert!(current.parse_history.is_empty());
    let incomplete = local_candidate(&library, "incomplete", "Replacement text");
    let resource = &incomplete.manifest.attachments["pageimg-0001"].attachment_id;
    std::fs::remove_file(library.info().data_root.clone() + "/attachments/p/" + resource).unwrap();
    assert!(library
        .publish_parse_batch(
            &incomplete,
            Some("visual-successor"),
            true,
            false,
            || Ok(())
        )
        .is_err());
    assert_eq!(
        library.current_parse_batch_id("p").unwrap().as_deref(),
        Some("visual-successor")
    );
}

#[test]
fn freezing_legacy_retains_bytes_after_mutable_attachments_change() {
    let (_, library, _dir) = common::env();
    library
        .put_paper(PaperDto {
            id: "p".into(),
            title: "Paper".into(),
            ..Default::default()
        })
        .unwrap();
    let put = |id: &str, bytes: &[u8]| {
        library
            .put_attachment(
                "p",
                AttachmentWrite {
                    id: id.into(),
                    name: id.into(),
                    content_type: Some("application/octet-stream".into()),
                    content_base64: STANDARD.encode(bytes),
                },
            )
            .unwrap()
    };
    put("pdf", b"original-pdf");
    put("blockmodel.json", b"original-model");
    put("pageimg-0001", b"original-image");
    let snapshot = library.freeze_legacy_parse_batch("p").unwrap();
    put("pdf", b"new-pdf");
    put("blockmodel.json", b"new-model");
    for (id, expected) in [
        ("pdf", b"original-pdf".as_slice()),
        ("blockmodel.json", b"original-model".as_slice()),
        ("pageimg-0001", b"original-image".as_slice()),
    ] {
        assert_eq!(
            library
                .read_parse_batch_attachment(&snapshot, id)
                .unwrap()
                .1,
            expected
        );
    }
}

#[test]
fn new_local_candidate_requires_source_while_frozen_legacy_can_fall_back() {
    let (library,_dir) = setup_local();
    let valid = local_candidate(&library,"with-source","Real paragraph");
    let mut manifest = valid.manifest.clone();
    manifest.batch_id = "without-source".into();
    manifest.attachments.remove("docling-source.json");
    let resources = manifest.attachments.keys().map(|id| (id.clone(),library.read_parse_batch_attachment(&valid,id).unwrap().1)).collect();
    library.write_parse_batch(manifest,resources).unwrap();
    let candidate = library.pin_parse_batch("p",Some("without-source")).unwrap();
    assert_eq!(library.validate_parse_candidate(&candidate,false).unwrap_err().code,"source_identity_mismatch");
    let (_,model) = library.read_parse_batch_attachment(&valid,"blockmodel.json").unwrap();
    library.put_attachment("p",AttachmentWrite { id:"blockmodel.json".into(),name:"blockmodel.json".into(),content_type:Some("application/json".into()),content_base64:STANDARD.encode(model) }).unwrap();
    let frozen = library.freeze_legacy_parse_batch("p").unwrap();
    assert!(library.validate_parse_candidate(&frozen,false).is_ok());
}

#[test]
fn initial_publication_is_durable_and_rejects_stale_paper_updates() {
    let (_, library, dir) = common::env();
    library
        .put_paper(PaperDto {
            id: "p".into(),
            title: "Paper".into(),
            ..Default::default()
        })
        .unwrap();
    let stale = library.get_paper("p").unwrap();
    let pdf = include_bytes!("fixtures/regression/corpus/1412.6980.pdf");
    library
        .put_attachment(
            "p",
            AttachmentWrite {
                id: "pdf".into(),
                name: "paper.pdf".into(),
                content_type: Some("application/pdf".into()),
                content_base64: STANDARD.encode(pdf),
            },
        )
        .unwrap();
    let identity = paper30min_lib::pdf_identity::read_pdf_identity_bytes(pdf).unwrap();
    let raw = include_bytes!("fixtures/aistudio/1412.6980.jsonl");
    let mapped = paper30min_lib::cloudparse_map::map_aistudio_jsonl(
        raw,
        &identity,
        &paper30min_lib::cloudparse_map::MappingContext {
            paper_id: "p".into(),
            batch_id: "initial".into(),
            pdf_sha256: identity.sha256.clone(),
            raw_sha256: format!("{:x}", Sha256::digest(raw)),
            model: "PaddleOCR-VL-1.6".into(),
            options: json!({}),
        },
    )
    .unwrap();
    let resources = BTreeMap::from([
        ("pdf".into(), pdf.to_vec()),
        (
            "blockmodel.json".into(),
            serde_json::to_vec(&mapped.mapped).unwrap(),
        ),
        (
            "cloud-source.json".into(),
            serde_json::to_vec(&mapped.source).unwrap(),
        ),
    ]);
    library
        .write_parse_batch(
            ParseBatchManifest {
                schema_version: 1,
                paper_id: "p".into(),
                batch_id: "initial".into(),
                pdf_sha256: identity.sha256,
                provider: "baidu".into(),
                model: "PaddleOCR-VL-1.6".into(),
                options: json!({}),
                raw_sha256: format!("{:x}", Sha256::digest(raw)),
                attachments: BTreeMap::new(),
            },
            resources,
        )
        .unwrap();
    let snapshot = library.pin_parse_batch("p", Some("initial")).unwrap();
    let current = library
        .publish_parse_batch(&snapshot, None, false, true, || Ok(()))
        .unwrap();
    assert_eq!(current.parse_batch_id.as_deref(), Some("initial"));
    assert_eq!(
        library.put_paper(stale).unwrap_err().code,
        "parse_batch_stale"
    );
    drop(library);
    let reopened = paper30min_lib::library::Library::open(dir.path()).unwrap();
    assert_eq!(
        reopened
            .pin_parse_batch("p", None)
            .unwrap()
            .manifest
            .batch_id,
        "initial"
    );
    let local = local_candidate(&reopened, "local-after-cloud", "Local replacement text");
    let replaced = reopened
        .publish_parse_batch(&local, Some("initial"), true, false, || Ok(()))
        .unwrap();
    assert_eq!(replaced.parse_history[0]["provider"], "baidu");
    assert_eq!(
        reopened
            .pin_parse_batch("p", None)
            .unwrap()
            .manifest
            .provider,
        "docling"
    );
    let cloud = reopened.pin_parse_batch("p", Some("initial")).unwrap();
    assert!(reopened
        .publish_parse_batch(&cloud, Some("local-after-cloud"), true, false, || Ok(()))
        .is_err());
    assert_eq!(
        reopened.current_parse_batch_id("p").unwrap().as_deref(),
        Some("local-after-cloud")
    );
}

#[test]
fn initial_parse_retains_preparse_chat_notes_and_screenshot_cleanup_protects_history() {
    let (library, _dir) = setup_local();
    library
        .put_attachment(
            "p",
            AttachmentWrite {
                id: "pdf-selection-old".into(),
                name: "selection.png".into(),
                content_type: Some("image/png".into()),
                content_base64: STANDARD.encode(b"actual-screenshot"),
            },
        )
        .unwrap();
    let mut paper = library.get_paper("p").unwrap();
    paper.recall_card.markdown = "Notes before parsing".into();
    paper.chat.push(serde_json::from_value(json!({"role":"user","content":"Ask screenshot","bindingKind":"pdf","pdfSelection":{"kind":"area","regions":[{"page":1,"bbox":[10,20,30,40],"pageSize":[612,792]}],"images":[{"attachmentId":"pdf-selection-old","page":1}]}})).unwrap());
    library.put_paper(paper).unwrap();
    let candidate = local_candidate(&library, "first-with-history", "Parsed text");
    let current = library
        .publish_parse_batch(&candidate, None, false, true, || Ok(()))
        .unwrap();
    assert_eq!(current.parse_history.len(), 1);
    assert_eq!(
        current.parse_history[0]["paper"]["chat"][0]["content"],
        "Ask screenshot"
    );
    assert_eq!(
        current.parse_history[0]["paper"]["recallCard"]["markdown"],
        "Notes before parsing"
    );
    let frozen = current.parse_history[0]["batchId"].as_str().unwrap();
    assert!(library
        .validate_parse_candidate(&library.pin_parse_batch("p", Some(frozen)).unwrap(), false)
        .is_ok());
    library
        .cleanup_pdf_selections("p", &["pdf-selection-old".into()])
        .unwrap();
    assert_eq!(
        library
            .get_attachment("p", "pdf-selection-old")
            .unwrap()
            .size,
        17
    );
}

#[test]
fn notes_saved_during_initial_validation_are_archived_at_commit() {
    let (library, _dir) = setup_local();
    let candidate = local_candidate(&library, "initial-race", "Parsed paragraph");
    let checkpoints = std::cell::Cell::new(0);
    let current = library
        .publish_parse_batch(&candidate, None, false, true, || {
            checkpoints.set(checkpoints.get() + 1);
            if checkpoints.get() == 2 {
                let mut paper = library.get_paper("p")?;
                paper.recall_card.markdown = "Notes saved while parsing".into();
                library.put_paper(paper)?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(current.parse_history.len(), 1);
    assert_eq!(
        current.parse_history[0]["paper"]["recallCard"]["markdown"],
        "Notes saved while parsing"
    );
}
