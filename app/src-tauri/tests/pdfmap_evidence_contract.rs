mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use paper30min_lib::{bridge, library::Library, pdfmap, tasks::TaskRegistry};
use serde_json::{json, Value};
use std::{fs, sync::Arc};

const COMMAND: &str = "pdfmap.getSourceRegions@1";
const PDF: &[u8] = b"hello-pdf";
const PDF_LOW_HASH: u64 = 6496204364745181802;

fn put(library: &Library, id: &str, bytes: &[u8]) -> paper30min_lib::files::AttachmentDto {
    library
        .put_attachment(
            "p",
            paper30min_lib::files::AttachmentWrite {
                id: id.into(),
                name: id.into(),
                content_type: Some("application/json".into()),
                content_base64: STANDARD.encode(bytes),
            },
        )
        .unwrap()
}

fn document() -> Value {
    json!({
        "schema_name": "DoclingDocument", "version": "1.10.0", "name": "sample",
        "origin": {"mimetype":"application/pdf", "binary_hash":PDF_LOW_HASH},
        "body":{"children":[{"$ref":"#/texts/0"},{"$ref":"#/texts/1"}]},
        "furniture":{"children":[]}, "groups":[], "pictures":[], "tables":[],
        "texts":[
            {"self_ref":"#/texts/0","label":"section_header","content_layer":"body","text":"1 Introduction","prov":[{"page_no":1,"bbox":{"l":10,"r":100,"t":20,"b":30,"coord_origin":"TOPLEFT"},"charspan":[0,14]}]},
            {"self_ref":"#/texts/1","label":"text","content_layer":"body","text":"A paragraph across two source regions.","prov":[
                {"page_no":1,"bbox":{"l":10,"r":100,"t":40,"b":60,"coord_origin":"TOPLEFT"},"charspan":[0,18]},
                {"page_no":2,"bbox":{"l":20,"r":120,"t":30,"b":50,"coord_origin":"TOPLEFT"},"charspan":[18,38]}
            ]}
        ],
        "pages":{"1":{"page_no":1,"size":{"width":612,"height":792}},"2":{"page_no":2,"size":{"width":612,"height":792}}}
    })
}

fn remove_regions(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("sourceRegions");
            for child in object.values_mut() {
                remove_regions(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                remove_regions(child);
            }
        }
        _ => {}
    }
}

fn seed(registry: &Arc<TaskRegistry>, library: &Library) -> String {
    bridge::invoke(registry, library, "library.putPaper@1", &json!({"paper":{"id":"p","title":"Sample","addedAt":"2026-09-30T00:00:00Z","updatedAt":"2026-09-30T00:00:00Z"}})).unwrap();
    put(library, "pdf", PDF);
    let mapped = pdfmap::map_docling_json_str(&document().to_string()).unwrap();
    let mut legacy = serde_json::to_value(mapped).unwrap();
    remove_regions(&mut legacy);
    legacy["schemaVersion"] = json!(1);
    put(
        library,
        "blockmodel.json",
        &serde_json::to_vec(&legacy).unwrap(),
    )
    .sha256
}

fn cache(root: &std::path::Path, task: &str, doc: &Value) {
    let dir = root.join("pdfparse").join(task);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("docling.json"), doc.to_string()).unwrap();
}

fn request(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    hash: &str,
) -> Result<Value, paper30min_lib::error::BridgeError> {
    bridge::invoke(
        registry,
        library,
        COMMAND,
        &json!({"paperId":"p","blockModelSha256":hash}),
    )
}

#[test]
fn old_cache_returns_regions_without_rewriting_saved_model() {
    let (registry, library, dir) = common::env();
    let hash = seed(&registry, &library);
    cache(dir.path(), "task-000001", &document());
    let path = dir.path().join("attachments/p/blockmodel.json");
    let before = fs::read(&path).unwrap();
    let result = request(&registry, &library, &hash).unwrap();
    assert_eq!(result["schemaVersion"], json!(1));
    assert_eq!(result["blockModelSha256"], hash);
    assert_eq!(
        result["pdfSha256"],
        "787039b5a469fb8e720be530ac94788a4a85c6b81b786efa5a2727738cfa8a6a"
    );
    let block = &result["blocks"][0];
    assert_eq!(block["blockId"], json!(1));
    assert_eq!(
        block["sourceRegions"],
        json!([
            {"page":1,"bbox":[20.0,80.0,180.0,40.0],"pageSize":[612.0,792.0],"charspan":[0,18]},
            {"page":2,"bbox":[40.0,60.0,200.0,40.0],"pageSize":[612.0,792.0],"charspan":[18,38]}
        ])
    );
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn unrelated_pdf_and_changed_body_are_not_enriched() {
    for change_hash in [true, false] {
        let (registry, library, dir) = common::env();
        let hash = seed(&registry, &library);
        let mut doc = document();
        if change_hash {
            doc["origin"]["binary_hash"] = json!(7);
        } else {
            doc["texts"][1]["text"] = json!("Different content");
        }
        cache(dir.path(), "task-000001", &doc);
        assert_eq!(
            request(&registry, &library, &hash).unwrap()["blocks"],
            json!([])
        );
    }
}

#[test]
fn conflicting_cache_regions_are_rejected() {
    let (registry, library, dir) = common::env();
    let hash = seed(&registry, &library);
    cache(dir.path(), "task-000001", &document());
    let mut conflict = document();
    // Preserve the first provenance and all legacy fields; change the omitted second region.
    conflict["texts"][1]["prov"][1]["bbox"]["l"] = json!(25);
    cache(dir.path(), "task-000002", &conflict);
    assert_eq!(
        request(&registry, &library, &hash).unwrap()["blocks"],
        json!([])
    );
}

#[test]
fn expected_model_hash_and_actual_attachment_integrity_are_enforced() {
    let (registry, library, dir) = common::env();
    let hash = seed(&registry, &library);
    assert_eq!(
        request(&registry, &library, &"0".repeat(64))
            .unwrap_err()
            .code,
        "source_model_changed"
    );
    cache(dir.path(), "task-000001", &document());
    fs::write(dir.path().join("attachments/p/pdf"), b"jello-pdf").unwrap();
    assert_eq!(
        request(&registry, &library, &hash).unwrap_err().code,
        "integrity_failed"
    );
}

#[test]
fn raw_docling_attachment_supplies_regions_without_cache() {
    let (registry, library, _dir) = common::env();
    let hash = seed(&registry, &library);
    put(
        &library,
        "docling-source.json",
        &serde_json::to_vec(&document()).unwrap(),
    );
    assert_eq!(
        request(&registry, &library, &hash).unwrap()["blocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn invalid_and_non_task_cache_files_are_ignored() {
    let (registry, library, dir) = common::env();
    let hash = seed(&registry, &library);
    cache(dir.path(), "unrelated", &document());
    let mut invalid = document();
    invalid["texts"][1]["prov"][1]["bbox"]["l"] = json!(-1);
    cache(dir.path(), "task-000001", &invalid);
    assert_eq!(
        request(&registry, &library, &hash).unwrap()["blocks"],
        json!([])
    );
}

#[test]
fn saved_regions_without_verified_raw_source_are_not_trusted() {
    let (registry, library, _dir) = common::env();
    seed(&registry, &library);
    let mapped = pdfmap::map_docling_json_str(&document().to_string()).unwrap();
    let hash = put(
        &library,
        "blockmodel.json",
        &serde_json::to_vec(&mapped).unwrap(),
    )
    .sha256;
    assert_eq!(
        request(&registry, &library, &hash).unwrap()["blocks"],
        json!([])
    );
}

#[test]
fn same_size_tampered_block_model_and_raw_source_fail_integrity() {
    for attachment_id in ["blockmodel.json", "docling-source.json"] {
        let (registry, library, dir) = common::env();
        let hash = seed(&registry, &library);
        put(
            &library,
            "docling-source.json",
            &serde_json::to_vec(&document()).unwrap(),
        );
        let path = dir.path().join("attachments/p").join(attachment_id);
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] = b'[';
        fs::write(path, bytes).unwrap();
        assert_eq!(
            request(&registry, &library, &hash).unwrap_err().code,
            "integrity_failed"
        );
    }
}

#[test]
fn identical_duplicate_candidates_are_accepted() {
    let (registry, library, dir) = common::env();
    let hash = seed(&registry, &library);
    cache(dir.path(), "task-000001", &document());
    cache(dir.path(), "task-000002", &document());
    assert_eq!(
        request(&registry, &library, &hash).unwrap()["blocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[cfg(windows)]
#[test]
fn cache_directory_junction_to_external_source_is_ignored() {
    let (registry, library, dir) = common::env();
    let hash = seed(&registry, &library);
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("docling.json"), document().to_string()).unwrap();
    let cache_root = dir.path().join("pdfparse");
    fs::create_dir_all(&cache_root).unwrap();
    let junction = cache_root.join("task-000001");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(external.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        request(&registry, &library, &hash).unwrap()["blocks"],
        json!([])
    );
    // Remove the junction itself before TempDir cleanup, preserving its external target.
    fs::remove_dir(junction).unwrap();
    assert!(external.path().join("docling.json").is_file());
}
