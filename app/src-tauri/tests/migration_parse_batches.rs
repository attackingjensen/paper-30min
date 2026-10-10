mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use paper30min_lib::library::Library;
use paper30min_lib::{
    files::AttachmentWrite,
    library::PaperDto,
    parsebatch::{ParseBatchAttachment, ParseBatchManifest},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn bundle() -> Value {
    let model = b"legacy block model";
    let pdf = b"original pdf";
    let attachments = json!({
        "pdf": {"attachmentId":"pdf","sha256":sha256_hex(pdf),"size":pdf.len(),"contentType":"application/pdf"},
        "blockmodel.json": {"attachmentId":"blockmodel.json","sha256":sha256_hex(model),"size":model.len(),"contentType":"application/json"}
    });
    let batch = format!(
        "legacy-{}",
        sha256_hex(&serde_json::to_vec(&attachments).unwrap())
    );
    let manifest = json!({"schemaVersion":1,"paperId":"p1","batchId":batch,
        "pdfSha256":sha256_hex(pdf),"provider":"docling","model":"legacy","options":null,
        "rawSha256":"","attachments":attachments});
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let manifest_id = format!("parsebatch-{}", sha256_hex(batch.as_bytes()));
    json!({"format":"paper-30min-library","version":2,"papers":[{
        "id":"p1","title":"History","pdfName":"paper.pdf","parseBatchId":batch,
        "parseHistory":[],"parseBatchExport":{"batches":[{"manifest":manifest,"resources":[
            {"id":"pdf","name":"paper.pdf","contentType":"application/pdf","dataBase64":STANDARD.encode(pdf)},
            {"id":"blockmodel.json","name":"blockmodel.json","contentType":"application/json","dataBase64":STANDARD.encode(model)},
            {"id":manifest_id,"name":"parsebatch.json","contentType":"application/json","dataBase64":STANDARD.encode(manifest_bytes)}
        ]}]}
    }]})
}

fn inspect(library: &Library, dir: &std::path::Path, payload: &Value) -> Value {
    let path = dir.join("export.json");
    fs::write(&path, serde_json::to_vec(payload).unwrap()).unwrap();
    library
        .inspect_migration(path.to_str().unwrap(), 900)
        .unwrap()
}

#[test]
fn version_two_import_persists_complete_batch_without_inspect_writes() {
    let (_registry, library, dir) = common::env();
    let payload = bundle();
    let report = inspect(&library, dir.path(), &payload);
    assert_eq!(report["conflicts"]["new"], 1);
    assert!(library.list_papers().unwrap().is_empty());
    assert!(!dir.path().join("papers").join("p1").exists());
    let result = library
        .commit_migration(report["token"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["added"], 1);
    let batch = payload["papers"][0]["parseBatchId"].as_str().unwrap();
    let snapshot = library.pin_parse_batch("p1", Some(batch)).unwrap();
    assert_eq!(
        library
            .read_parse_batch_attachment(&snapshot, "blockmodel.json")
            .unwrap()
            .1,
        b"legacy block model"
    );
    assert_eq!(
        serde_json::to_value(library.get_paper("p1").unwrap()).unwrap()["parseBatchId"],
        batch
    );
    let exported = library.export_parse_batches("p1").unwrap();
    assert_eq!(exported["paper"]["parseBatchId"], batch);
    assert_eq!(exported["batches"].as_array().unwrap().len(), 1);
    assert_eq!(
        exported["batches"][0]["resources"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let model = exported["batches"][0]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "blockmodel.json")
        .unwrap();
    assert_eq!(
        STANDARD
            .decode(model["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"legacy block model"
    );
}

#[test]
fn missing_corrupt_or_forged_batch_resources_reject_the_paper() {
    for mutation in [0, 1, 2, 3] {
        let (_registry, library, dir) = common::env();
        let mut payload = bundle();
        let resources = payload["papers"][0]["parseBatchExport"]["batches"][0]["resources"]
            .as_array_mut()
            .unwrap();
        match mutation {
            0 => {
                resources.remove(1);
            }
            1 => resources[1]["dataBase64"] = json!(STANDARD.encode(b"changed")),
            2 => resources[2]["dataBase64"] = json!(STANDARD.encode(b"{}")),
            _ => {
                payload["papers"][0]["parseBatchId"] = json!("missing-batch");
            }
        }
        let report = inspect(&library, dir.path(), &payload);
        assert_eq!(
            report["conflicts"]["invalid"], 1,
            "mutation {mutation}: {report}"
        );
        assert_eq!(
            library
                .commit_migration(report["token"].as_str().unwrap())
                .unwrap()["added"],
            0
        );
        assert!(library.list_papers().unwrap().is_empty());
    }
}

#[test]
fn unversioned_legacy_export_is_still_readable() {
    let (_registry, library, dir) = common::env();
    let payload = json!({"format":"paper-30min-library","papers":[{"id":"p1","title":"Legacy"}]});
    let report = inspect(&library, dir.path(), &payload);
    assert_eq!(report["conflicts"]["new"], 1);
    assert_eq!(
        library
            .commit_migration(report["token"].as_str().unwrap())
            .unwrap()["added"],
        1
    );
}

#[test]
fn historical_chat_screenshot_is_required_and_survives_import() {
    for include_image in [false, true] {
        let (_registry, library, dir) = common::env();
        let mut payload = bundle();
        let mut archived = payload["papers"][0].clone();
        archived.as_object_mut().unwrap().remove("parseBatchExport");
        archived["chat"] = json!([{"role":"user","content":"old screenshot question","bindingKind":"pdf",
            "pdfSelection":{"kind":"area","regions":[{"page":1,"bbox":[1,1,20,20],"pageSize":[100,100]}],
                "images":[{"attachmentId":"pdf-selection-history"}]}}]);
        let batch = archived["parseBatchId"].clone();
        payload["papers"][0]["parseBatchId"] = Value::Null;
        payload["papers"][0]["parseHistory"] = json!([{"batchId":batch,"paper":archived}]);
        if include_image {
            payload["papers"][0]["selectionAttachments"] = json!([{"id":"pdf-selection-history","name":"selection.png",
                "contentType":"image/png","contentBase64":STANDARD.encode(b"saved screenshot"),
                "size":b"saved screenshot".len(),"sha256":sha256_hex(b"saved screenshot")}]);
        }
        let report = inspect(&library, dir.path(), &payload);
        assert_eq!(
            report["conflicts"][if include_image { "new" } else { "invalid" }],
            1,
            "{report}"
        );
        let result = library
            .commit_migration(report["token"].as_str().unwrap())
            .unwrap();
        if include_image {
            assert_eq!(result["added"], 1);
            let paper = serde_json::to_value(library.get_paper("p1").unwrap()).unwrap();
            assert_eq!(
                paper["parseHistory"][0]["paper"]["chat"][0]["content"],
                "old screenshot question"
            );
            assert_eq!(
                library
                    .read_range("p1", "pdf-selection-history", 0, 1024)
                    .unwrap()
                    .1,
                b"saved screenshot"
            );
        } else {
            assert_eq!(result["added"], 0);
        }
    }
}

#[test]
fn duplicate_papers_and_existing_paper_are_never_replaced() {
    let (_registry, library, dir) = common::env();
    let mut payload = bundle();
    let duplicate = payload["papers"][0].clone();
    payload["papers"].as_array_mut().unwrap().push(duplicate);
    let report = inspect(&library, dir.path(), &payload);
    let result = library
        .commit_migration(report["token"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["added"], 1);
    assert_eq!(result["skipped"], 1);
    let before = library.get_paper("p1").unwrap();
    payload["papers"][0]["title"] = json!("attempted replacement");
    let report = inspect(&library, dir.path(), &payload);
    assert_eq!(
        library
            .commit_migration(report["token"].as_str().unwrap())
            .unwrap()["added"],
        0
    );
    assert_eq!(library.get_paper("p1").unwrap(), before);
}

#[test]
fn current_and_historical_recall_resources_are_required_and_restored() {
    for mutation in 0..4 {
        let (_registry, library, dir) = common::env();
        let mut payload = bundle();
        let mut archived = payload["papers"][0].clone();
        archived.as_object_mut().unwrap().remove("parseBatchExport");
        archived["recallCard"] =
            json!({"markdown":"old notes","images":[{"attachmentId":"recall-old"}]});
        let batch = archived["parseBatchId"].clone();
        payload["papers"][0]["parseBatchId"] = Value::Null;
        payload["papers"][0]["parseHistory"] = json!([{"batchId":batch,"paper":archived}]);
        payload["papers"][0]["recallCard"] =
            json!({"markdown":"new notes","images":[{"attachmentId":"recall-new"}]});
        payload["papers"][0]["recallAttachments"] = json!([
            {"id":"recall-old","name":"old.png","contentType":"image/png","size":b"old image".len(),"sha256":sha256_hex(b"old image"),"contentBase64":STANDARD.encode(b"old image")},
            {"id":"recall-new","name":"new.png","contentType":"image/png","size":b"new image".len(),"sha256":sha256_hex(b"new image"),"contentBase64":STANDARD.encode(b"new image")}
        ]);
        match mutation {
            1 => {
                payload["papers"][0]["recallAttachments"]
                    .as_array_mut()
                    .unwrap()
                    .remove(0);
            }
            2 => {
                payload["papers"][0]["recallAttachments"][0]["contentBase64"] =
                    json!(STANDARD.encode(b"corrupt"))
            }
            3 => payload["papers"][0]["recallAttachments"][0]["size"] = json!(999),
            _ => {}
        }
        let report = inspect(&library, dir.path(), &payload);
        assert_eq!(
            report["conflicts"][if mutation == 0 { "new" } else { "invalid" }],
            1,
            "mutation {mutation}: {report}"
        );
        let result = library
            .commit_migration(report["token"].as_str().unwrap())
            .unwrap();
        assert_eq!(result["added"], if mutation == 0 { 1 } else { 0 });
        if mutation == 0 {
            let paper = library.get_paper("p1").unwrap();
            assert_eq!(paper.recall_card.markdown, "new notes");
            assert_eq!(
                paper.parse_history[0]["paper"]["recallCard"]["markdown"],
                "old notes"
            );
            assert_eq!(
                library.read_range("p1", "recall-old", 0, 1024).unwrap().1,
                b"old image"
            );
            assert_eq!(
                library.read_range("p1", "recall-new", 0, 1024).unwrap().1,
                b"new image"
            );
        } else {
            assert!(library.list_papers().unwrap().is_empty());
        }
    }
}

#[test]
fn version_one_recall_reference_keeps_legacy_missing_attachment_compatibility() {
    let (_registry, library, dir) = common::env();
    let payload = json!({"format":"paper-30min-library","version":1,"papers":[{"id":"p1","title":"Legacy",
        "recallCard":{"markdown":"old note","images":[{"attachmentId":"old-unavailable"}]}}]});
    let report = inspect(&library, dir.path(), &payload);
    assert_eq!(report["conflicts"]["new"], 1);
    assert_eq!(
        library
            .commit_migration(report["token"].as_str().unwrap())
            .unwrap()["added"],
        1
    );
    assert_eq!(
        library.get_paper("p1").unwrap().recall_card.images[0]["attachmentId"],
        "old-unavailable"
    );
}

fn initial_model_candidate(library: &Library) -> paper30min_lib::parsebatch::ParseBatchSnapshot {
    let pdf = include_bytes!("fixtures/regression/corpus/1412.6980.pdf");
    let sha = sha256_hex(pdf);
    let pages: serde_json::Map<String, Value> = (1..=15)
        .map(|page| {
            (
                page.to_string(),
                json!({"page_no":page,"size":{"width":612,"height":792}}),
            )
        })
        .collect();
    let raw = json!({"schema_name":"DoclingDocument","origin":{"mimetype":"application/pdf","binary_hash":u64::from_str_radix(&sha[48..],16).unwrap()},"name":"fixture","body":{"children":[{"$ref":"#/texts/0"},{"$ref":"#/texts/1"}]},"furniture":{"children":[]},"groups":[],"pictures":[],"tables":[],"texts":[{"self_ref":"#/texts/0","label":"section_header","text":"1 Introduction","content_layer":"body","prov":[{"page_no":1,"bbox":{"l":10,"r":100,"t":20,"b":30,"coord_origin":"TOPLEFT"}}]},{"self_ref":"#/texts/1","label":"text","text":"Initial parsed paragraph","content_layer":"body","prov":[{"page_no":1,"bbox":{"l":10,"r":100,"t":40,"b":50,"coord_origin":"TOPLEFT"}}]}],"pages":pages});
    let mapped = paper30min_lib::pdfmap::map_docling_json_str(&raw.to_string()).unwrap();
    let source = serde_json::to_vec(&raw).unwrap();
    let resources: BTreeMap<String, Vec<u8>> = BTreeMap::from([
        ("pdf".into(), pdf.to_vec()),
        (
            "blockmodel.json".into(),
            serde_json::to_vec(&mapped).unwrap(),
        ),
        ("docling-source.json".into(), source.clone()),
    ]);
    let attachments = resources
        .iter()
        .map(|(id, bytes)| {
            (
                id.clone(),
                ParseBatchAttachment {
                    attachment_id: id.clone(),
                    sha256: sha256_hex(bytes),
                    size: bytes.len() as u64,
                    content_type: if id == "pdf" {
                        "application/pdf"
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
                paper_id: "p1".into(),
                batch_id: "initial-model".into(),
                pdf_sha256: sha,
                provider: "docling".into(),
                model: "local".into(),
                // parseGeneration 是旧版写入的遗留字段（现行生产者已不再写），此处模拟存量数据形状。
                options: json!({"parseGeneration":"initial"}),
                raw_sha256: sha256_hex(&source),
                attachments,
            },
            resources,
        )
        .unwrap();
    library
        .pin_parse_batch("p1", Some("initial-model"))
        .unwrap()
}

#[test]
fn model_only_current_with_preparse_notes_history_roundtrips_without_claiming_visual_readiness() {
    let (_registry, library, _dir) = common::env();
    let mut paper = PaperDto {
        id: "p1".into(),
        title: "Initial paper".into(),
        ..Default::default()
    };
    paper.recall_card.markdown = "Notes saved before first parse".into();
    library.put_paper(paper).unwrap();
    let pdf = include_bytes!("fixtures/regression/corpus/1412.6980.pdf");
    library
        .put_attachment(
            "p1",
            AttachmentWrite {
                id: "pdf".into(),
                name: "paper.pdf".into(),
                content_type: Some("application/pdf".into()),
                content_base64: STANDARD.encode(pdf),
            },
        )
        .unwrap();
    let candidate = initial_model_candidate(&library);
    let current = library
        .publish_parse_batch(&candidate, None, false, true, || Ok(()))
        .unwrap();
    assert_eq!(current.parse_history.len(), 1);
    let history_id = current.parse_history[0]["batchId"].as_str().unwrap();
    assert!(!library
        .pin_parse_batch("p1", Some(history_id))
        .unwrap()
        .manifest
        .attachments
        .contains_key("blockmodel.json"));
    let export = library.export_parse_batches("p1").unwrap();
    let mut paper = export["paper"].clone();
    paper["parseBatchExport"] = json!({"batches":export["batches"]});
    paper["pdfBlob"] = json!({"base64":STANDARD.encode(pdf),"type":"application/pdf"});
    let payload = json!({"format":"paper-30min-library","version":2,"papers":[paper]});
    let (_registry, imported, dir) = common::env();
    let report = inspect(&imported, dir.path(), &payload);
    assert_eq!(report["conflicts"]["new"], 1, "{report}");
    assert_eq!(
        imported
            .commit_migration(report["token"].as_str().unwrap())
            .unwrap()["added"],
        1
    );
    let restored = imported.get_paper("p1").unwrap();
    assert_eq!(restored, current);
    assert_eq!(
        restored.parse_history[0]["paper"]["recallCard"]["markdown"],
        "Notes saved before first parse"
    );
    let snapshot = imported
        .pin_parse_batch("p1", Some("initial-model"))
        .unwrap();
    assert!(!snapshot
        .manifest
        .attachments
        .contains_key("local-visual-assets.json"));
    assert!(imported.validate_parse_candidate(&snapshot, false).is_ok());
    assert!(imported.validate_parse_candidate(&snapshot, true).is_err());
}
