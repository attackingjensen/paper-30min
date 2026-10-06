mod common;
use base64::{engine::general_purpose::STANDARD, Engine};
use paper30min_lib::{
    bridge,
    files::AttachmentWrite,
    library::Library,
    parsebatch::{ParseBatchManifest, ParseBatchSnapshot},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn setup() -> (std::sync::Arc<Library>, tempfile::TempDir) {
    let (registry, library, dir) = common::env();
    bridge::invoke(
        &registry,
        &library,
        "library.putPaper@1",
        &json!({"paper": {
            "id":"p1", "title":"Paper", "pdfName":"paper.pdf", "rating":0,
            "addedAt":"2026-10-06T00:00:00Z", "updatedAt":"2026-10-06T00:00:00Z"
        }}),
    )
    .unwrap();
    put(&library, "pdf", b"pdf-identity");
    (library, dir)
}

fn put(library: &Library, id: &str, bytes: &[u8]) {
    library
        .put_attachment(
            "p1",
            AttachmentWrite {
                id: id.into(),
                name: id.into(),
                content_type: Some("application/octet-stream".into()),
                content_base64: STANDARD.encode(bytes),
            },
        )
        .unwrap();
}

fn manifest(batch: &str) -> ParseBatchManifest {
    ParseBatchManifest {
        schema_version: 1,
        paper_id: "p1".into(),
        batch_id: batch.into(),
        pdf_sha256: Sha256::digest(b"pdf-identity")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        provider: "baidu-aistudio".into(),
        model: "PaddleOCR-VL-1.6".into(),
        options: json!({"table":true}),
        raw_sha256: "b".repeat(64),
        attachments: BTreeMap::new(),
    }
}

fn resources() -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        ("blockmodel.json".into(), b"new-model".to_vec()),
        ("cloud-source.json".into(), b"source".to_vec()),
        ("pageimg-0001".into(), b"image".to_vec()),
    ])
}

#[test]
fn candidate_is_immutable_and_does_not_replace_legacy_reading() {
    let (library, _dir) = setup();
    put(&library, "blockmodel.json", b"old-model");
    put(&library, "pageimg-0001", b"old-image");
    let old = library.pin_parse_batch("p1", None).unwrap();
    let new = library
        .write_parse_batch(manifest("batch-1"), resources())
        .unwrap();
    assert_eq!(new.attachments.len(), 3);
    assert_eq!(
        library
            .read_parse_batch_attachment(&old, "blockmodel.json")
            .unwrap()
            .1,
        b"old-model"
    );
    assert_eq!(
        library
            .read_parse_batch_attachment(&old, "pageimg-0001")
            .unwrap()
            .1,
        b"old-image"
    );
    let pinned = library.pin_parse_batch("p1", Some("batch-1")).unwrap();
    for (logical, expected) in resources() {
        assert_eq!(
            library
                .read_parse_batch_attachment(&pinned, &logical)
                .unwrap()
                .1,
            expected
        );
    }
    assert_eq!(
        library
            .write_parse_batch(manifest("batch-1"), resources())
            .unwrap_err()
            .code,
        "parse_batch_exists"
    );
    let restored = library
        .pin_parse_batch("p1", Some(&old.manifest.batch_id))
        .unwrap();
    assert_eq!(
        library
            .read_parse_batch_attachment(&restored, "pageimg-0001")
            .unwrap()
            .1,
        b"old-image"
    );
}

#[test]
fn legacy_change_rejects_whole_snapshot_including_unchanged_image() {
    let (library, _dir) = setup();
    put(&library, "blockmodel.json", b"old-model");
    put(&library, "pageimg-0001", b"old-image");
    let old = library.pin_parse_batch("p1", None).unwrap();
    put(&library, "blockmodel.json", b"new-model");
    assert_eq!(
        library
            .read_parse_batch_attachment(&old, "pageimg-0001")
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
    assert_eq!(
        library
            .pin_parse_batch("p1", Some(&old.manifest.batch_id))
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
}

#[test]
fn forged_snapshot_and_corrupted_resource_are_rejected() {
    let (library, dir) = setup();
    library
        .write_parse_batch(manifest("batch-1"), resources())
        .unwrap();
    let snapshot = library.pin_parse_batch("p1", Some("batch-1")).unwrap();
    let mut encoded = serde_json::to_value(&snapshot).unwrap();
    encoded["manifest"]["provider"] = json!("forged");
    let forged: ParseBatchSnapshot = serde_json::from_value(encoded).unwrap();
    assert_eq!(
        library
            .read_parse_batch_attachment(&forged, "pageimg-0001")
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
    let id = &snapshot.manifest.attachments["pageimg-0001"].attachment_id;
    std::fs::write(dir.path().join("attachments/p1").join(id), b"bad!!").unwrap();
    assert_eq!(
        library
            .read_parse_batch_attachment(&snapshot, "pageimg-0001")
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
}

#[test]
fn illegal_identity_path_digest_and_missing_batch_are_rejected() {
    let (library, _dir) = setup();
    assert_eq!(
        library
            .write_parse_batch(manifest("../escape"), resources())
            .unwrap_err()
            .code,
        "invalid_input"
    );
    let mut bad = manifest("batch-1");
    bad.pdf_sha256 = "bad".into();
    assert_eq!(
        library
            .write_parse_batch(bad, resources())
            .unwrap_err()
            .code,
        "invalid_input"
    );
    let mut paths = resources();
    paths.insert("../image".into(), vec![]);
    assert_eq!(
        library
            .write_parse_batch(manifest("batch-1"), paths)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert_eq!(
        library
            .pin_parse_batch("p1", Some("missing"))
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        library.pin_parse_batch("../p1", None).unwrap_err().code,
        "invalid_input"
    );
}

#[test]
fn pdf_identity_mismatch_cannot_be_written_or_read() {
    let (library, _dir) = setup();
    let mut wrong = manifest("wrong-pdf");
    wrong.pdf_sha256 = "c".repeat(64);
    assert_eq!(
        library
            .write_parse_batch(wrong, resources())
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
    library
        .write_parse_batch(manifest("batch-1"), resources())
        .unwrap();
    let pinned = library.pin_parse_batch("p1", Some("batch-1")).unwrap();
    put(&library, "pdf", b"replacement-pdf");
    assert_eq!(
        library
            .read_parse_batch_attachment(&pinned, "blockmodel.json")
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
}

#[test]
fn retained_pdf_resource_keeps_historical_candidate_readable() {
    let (library, _dir) = setup();
    let mut files = resources();
    files.insert("pdf".into(), b"pdf-identity".to_vec());
    library
        .write_parse_batch(manifest("history"), files)
        .unwrap();
    let pinned = library.pin_parse_batch("p1", Some("history")).unwrap();
    put(&library, "pdf", b"replacement-pdf");
    assert_eq!(
        library
            .read_parse_batch_attachment(&pinned, "pdf")
            .unwrap()
            .1,
        b"pdf-identity"
    );
    assert_eq!(
        library
            .read_parse_batch_attachment(&pinned, "blockmodel.json")
            .unwrap()
            .1,
        b"new-model"
    );
}

#[test]
fn legacy_batch_only_pins_parse_dependencies_not_chat_or_recall_images() {
    let (library, _dir) = setup();
    for id in [
        "blockmodel.json",
        "docling-source.json",
        "cloud-source.json",
        "pageimg-0001",
        "crop-fig_1",
        "crop-fml-sec_1-b2",
    ] {
        put(&library, id, b"parse-resource");
    }
    put(&library, "pdf-selection-message-1", b"chat-screenshot");
    put(&library, "recall-image-1", b"recall-image");
    let snapshot = library.pin_parse_batch("p1", None).unwrap();
    assert_eq!(snapshot.manifest.attachments.len(), 7);
    assert!(!snapshot
        .manifest
        .attachments
        .contains_key("pdf-selection-message-1"));
    assert!(!snapshot.manifest.attachments.contains_key("recall-image-1"));
    put(
        &library,
        "pdf-selection-message-1",
        b"changed-chat-screenshot",
    );
    put(&library, "recall-image-2", b"new-recall-image");
    let after_chat = library.pin_parse_batch("p1", None).unwrap();
    assert_eq!(snapshot.manifest.batch_id, after_chat.manifest.batch_id);
    assert_eq!(
        library
            .read_parse_batch_attachment(&snapshot, "crop-fml-sec_1-b2")
            .unwrap()
            .1,
        b"parse-resource"
    );
    assert_eq!(
        library
            .read_parse_batch_attachment(&snapshot, "pdf-selection-message-1")
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        library
            .get_attachment("p1", "pdf-selection-message-1")
            .unwrap()
            .size,
        23
    );
}

#[test]
fn large_batch_checks_other_resources_when_reading_an_unchanged_model() {
    let (library, _dir) = setup();
    let mut files = resources();
    for page in 1..=128 {
        files.insert(
            format!("pageimg-{page:04}"),
            format!("page-{page}").into_bytes(),
        );
    }
    library.write_parse_batch(manifest("large"), files).unwrap();
    let pinned = library.pin_parse_batch("p1", Some("large")).unwrap();
    for page in [1, 64, 128] {
        assert_eq!(
            library
                .read_parse_batch_attachment(&pinned, &format!("pageimg-{page:04}"))
                .unwrap()
                .1,
            format!("page-{page}").as_bytes()
        );
    }
    let other_id = &pinned.manifest.attachments["pageimg-0128"].attachment_id;
    put(&library, other_id, b"changed-last-page");
    assert_eq!(
        library
            .read_parse_batch_attachment(&pinned, "blockmodel.json")
            .unwrap_err()
            .code,
        "parse_batch_stale"
    );
    assert_eq!(
        library.verify_parse_batch(&pinned).unwrap_err().code,
        "parse_batch_stale"
    );
}
