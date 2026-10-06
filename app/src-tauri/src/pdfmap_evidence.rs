//! Read-only recovery of provenance, tied to the current PDF and saved block model.

use crate::{error::BridgeError, files, library::Library, pdfmap::MappedPaper};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

// Local cache recovery is bounded; oversized documents keep the existing page/text fallback.
const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHE_CANDIDATES: usize = 256;
const SOURCE_ATTACHMENT: &str = "docling-source.json";

pub(crate) fn get_source_regions(
    library: &Library,
    paper_id: &str,
    expected_model_sha256: &str,
) -> Result<Value, BridgeError> {
    files::require_safe_segment(paper_id, "paperId")?;
    if expected_model_sha256.len() != 64
        || !expected_model_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(BridgeError::invalid_input(
            "blockModelSha256 must be a SHA-256 digest",
        ));
    }
    let model_meta = library.get_attachment(paper_id, "blockmodel.json")?;
    if model_meta.sha256 != expected_model_sha256 {
        return Err(model_changed());
    }
    let model_path = files::attachment_path(library.root(), paper_id, "blockmodel.json")?;
    let model_bytes = read_safe(library.root(), &model_path)
        .ok_or_else(|| BridgeError::invalid_input("Block model is missing, unsafe or oversized"))?;
    if model_bytes.len() as i64 != model_meta.size
        || files::sha256_hex(&model_bytes) != model_meta.sha256
    {
        return Err(BridgeError::integrity_failed(
            paper_id,
            "blockmodel.json",
            "Block model integrity check failed",
        ));
    }
    let saved: MappedPaper = serde_json::from_slice(&model_bytes)
        .map_err(|_| BridgeError::invalid_input("Invalid block model"))?;
    let saved_projection = legacy_projection(&saved)?;
    let pdf_path = files::attachment_path(library.root(), paper_id, "pdf")?;
    if !safe_path(library.root(), &pdf_path) {
        return Err(BridgeError::invalid_input("Unsafe PDF attachment path"));
    }
    let pdf_meta = library.verify_attachment(paper_id, "pdf")?;
    let pdf_hash = u64::from_str_radix(&pdf_meta.sha256[48..], 16)
        .map_err(|_| BridgeError::internal("Invalid stored PDF digest"))?;

    let mut raw_attachment = None;
    if let Ok(meta) = library.get_attachment(paper_id, SOURCE_ATTACHMENT) {
        let path = files::attachment_path(library.root(), paper_id, SOURCE_ATTACHMENT)?;
        if let Some(bytes) = read_safe(library.root(), &path) {
            if bytes.len() as i64 != meta.size || files::sha256_hex(&bytes) != meta.sha256 {
                return Err(BridgeError::integrity_failed(
                    paper_id,
                    SOURCE_ATTACHMENT,
                    "Source attachment integrity check failed",
                ));
            }
            raw_attachment = Some(bytes);
        }
    }
    let cache_root = library.root().join("pdfparse");
    let mut candidates = Vec::new();
    let mut too_many = false;
    if safe_path(library.root(), &cache_root) {
        if let Ok(entries) = fs::read_dir(&cache_root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if !name.to_string_lossy().starts_with("task-") {
                    continue;
                }
                if candidates.len() >= MAX_CACHE_CANDIDATES {
                    too_many = true;
                    break;
                }
                candidates.push(entry.path().join("docling.json"));
            }
        }
    }
    let mut agreed: Option<Value> = None;
    let mut conflict = too_many;
    // Read one bounded candidate at a time instead of retaining the full cache in memory.
    for bytes in raw_attachment.into_iter().chain(
        candidates
            .iter()
            .filter_map(|path| read_safe(library.root(), path)),
    ) {
        let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if raw.pointer("/origin/mimetype").and_then(Value::as_str) != Some("application/pdf")
            || raw.pointer("/origin/binary_hash").and_then(Value::as_u64) != Some(pdf_hash)
        {
            continue;
        }
        let Ok(mapped) = crate::pdfmap::map_docling_json_str(&raw.to_string()) else {
            continue;
        };
        if legacy_projection(&mapped)? != saved_projection {
            continue;
        }
        let blocks = source_blocks(&mapped)?;
        if let Some(previous) = agreed.as_ref() {
            if *previous != blocks {
                conflict = true;
            }
        } else {
            agreed = Some(blocks);
        }
    }
    // The reader may replace either attachment while cache recovery is in flight.
    if library
        .verify_attachment(paper_id, "blockmodel.json")?
        .sha256
        != model_meta.sha256
        || library.verify_attachment(paper_id, "pdf")?.sha256 != pdf_meta.sha256
    {
        return Err(model_changed());
    }
    Ok(json!({
        "schemaVersion": 1,
        "pdfSha256": pdf_meta.sha256,
        "blockModelSha256": model_meta.sha256,
        "blocks": if conflict { json!([]) } else { agreed.unwrap_or_else(|| json!([])) }
    }))
}

fn model_changed() -> BridgeError {
    BridgeError::new(
        "source_model_changed",
        "PDF or block model changed during source lookup",
        false,
    )
}

fn legacy_projection(mapped: &MappedPaper) -> Result<Value, BridgeError> {
    let mut value = serde_json::to_value(mapped)
        .map_err(|_| BridgeError::internal("Block model serialization failed"))?;
    strip_regions(&mut value);
    value["schemaVersion"] = json!(1);
    Ok(value)
}

fn strip_regions(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("sourceRegions");
            for child in object.values_mut() {
                strip_regions(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                strip_regions(child);
            }
        }
        _ => {}
    }
}

fn source_blocks(mapped: &MappedPaper) -> Result<Value, BridgeError> {
    let value = serde_json::to_value(mapped)
        .map_err(|_| BridgeError::internal("Block model serialization failed"))?;
    let mut result = Vec::new();
    for section in value["sections"].as_array().into_iter().flatten() {
        for block in section["blocks"].as_array().into_iter().flatten() {
            if block["sourceRegions"]
                .as_array()
                .is_some_and(|regions| !regions.is_empty())
            {
                result.push(json!({"secId": section["id"], "blockId": block["id"], "sourceRegions": block["sourceRegions"]}));
            }
        }
    }
    Ok(Value::Array(result))
}

fn read_safe(root: &Path, path: &Path) -> Option<Vec<u8>> {
    if !safe_path(root, path) {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_DOCUMENT_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_DOCUMENT_BYTES).then_some(bytes)
}

fn safe_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return false;
        }
        current.push(component);
        let Ok(meta) = fs::symlink_metadata(&current) else {
            return false;
        };
        if meta.file_type().is_symlink() {
            return false;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
    }
    match (fs::canonicalize(root), fs::canonicalize(path)) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}
