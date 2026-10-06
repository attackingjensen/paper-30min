//! Complete retained parse dependencies for library export and import inspection.
use crate::{
    error::BridgeError,
    files::{require_safe_segment, sha256_hex},
    library::{Library, PaperDto},
    parsebatch::ParseBatchManifest,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

pub(crate) struct ImportedResource {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

fn manifest_id(batch: &str) -> String {
    format!("parsebatch-{}", sha256_hex(batch.as_bytes()))
}

impl Library {
    pub fn export_parse_batches(&self, paper_id: &str) -> Result<Value, BridgeError> {
        let paper = self.get_paper(paper_id)?;
        let mut ids: BTreeSet<String> = paper
            .parse_history
            .iter()
            .filter_map(|h| h["batchId"].as_str().map(str::to_owned))
            .collect();
        if let Some(id) = &paper.parse_batch_id {
            ids.insert(id.clone());
        } else if self
            .list_attachments(paper_id)?
            .iter()
            .any(|a| a.id == "pdf")
        {
            ids.insert(self.pin_parse_batch(paper_id, None)?.manifest.batch_id);
        }
        let mut batches = Vec::new();
        for id in ids {
            let snapshot = self.pin_parse_batch(paper_id, Some(&id))?;
            let mut resources = Vec::new();
            for logical in snapshot.manifest.attachments.keys() {
                let (dto, bytes) = self.read_parse_batch_attachment(&snapshot, logical)?;
                resources.push(json!({"id":dto.id,"name":dto.name,"contentType":dto.content_type,"dataBase64":BASE64.encode(bytes)}));
            }
            let stored_id = manifest_id(&id);
            let dto = self.get_attachment(paper_id, &stored_id)?;
            let (_, bytes) = self.read_range(paper_id, &stored_id, 0, dto.size as u64)?;
            if sha256_hex(&bytes) != dto.sha256 {
                return Err(BridgeError::invalid_input("批次清单已变化"));
            }
            let stored: ParseBatchManifest = serde_json::from_slice(&bytes)
                .map_err(|_| BridgeError::invalid_input("批次清单无效"))?;
            if stored != snapshot.manifest {
                return Err(BridgeError::invalid_input("批次清单已变化"));
            }
            resources.push(json!({"id":dto.id,"name":dto.name,"contentType":dto.content_type,"dataBase64":BASE64.encode(bytes)}));
            self.verify_parse_batch(&snapshot)?;
            batches.push(json!({"manifest":snapshot.manifest,"resources":resources}));
        }
        if self.get_paper(paper_id)? != paper {
            return Err(BridgeError::new(
                "parse_state_stale",
                "导出期间论文已变化，请重试",
                true,
            ));
        }
        Ok(json!({"paper":paper,"batches":batches}))
    }
}

pub(crate) fn import_parse_batches(
    raw: &Value,
    paper: &PaperDto,
) -> Result<Vec<ImportedResource>, String> {
    let required: BTreeSet<String> = paper
        .parse_batch_id
        .iter()
        .cloned()
        .chain(
            paper
                .parse_history
                .iter()
                .filter_map(|h| h["batchId"].as_str().map(str::to_owned)),
        )
        .collect();
    let Some(export) = raw.get("parseBatchExport") else {
        return if required.is_empty() {
            Ok(Vec::new())
        } else {
            Err("解析批次导出依赖缺失".into())
        };
    };
    let batches = export["batches"].as_array().ok_or("解析批次列表无效")?;
    if batches.len() > 1000 {
        return Err("解析批次过多".into());
    }
    let mut all: BTreeMap<String, ImportedResource> = BTreeMap::new();
    let mut manifests = BTreeMap::new();
    let mut total = 0u64;
    for batch in batches {
        let manifest: ParseBatchManifest =
            serde_json::from_value(batch["manifest"].clone()).map_err(|_| "解析批次清单无效")?;
        if manifest.paper_id != paper.id
            || manifest.schema_version != 1
            || manifests.contains_key(&manifest.batch_id)
        {
            return Err("解析批次身份无效或重复".into());
        }
        require_safe_segment(&manifest.batch_id, "batchId").map_err(|e| e.message)?;
        let legacy = manifest.batch_id.starts_with("legacy-");
        let mut expected = BTreeSet::from([manifest_id(&manifest.batch_id)]);
        for (logical, resource) in &manifest.attachments {
            require_safe_segment(logical, "logicalAttachmentId").map_err(|e| e.message)?;
            let deterministic = format!(
                "parseasset-{}",
                sha256_hex(
                    format!("{}:{logical}:{}", manifest.batch_id, resource.sha256).as_bytes()
                )
            );
            if (!legacy && resource.attachment_id != deterministic)
                || (legacy && resource.attachment_id != *logical)
                || !expected.insert(resource.attachment_id.clone())
            {
                return Err("解析资源物理编号无效或重复".into());
            }
        }
        let resources = batch["resources"]
            .as_array()
            .ok_or("解析批次资源列表无效")?;
        if resources.len() != expected.len() || resources.len() > 10001 {
            return Err("解析批次资源缺失或重复".into());
        }
        let mut seen = BTreeSet::new();
        for item in resources {
            let id = item["id"].as_str().ok_or("解析资源缺少编号")?;
            require_safe_segment(id, "attachmentId").map_err(|e| e.message)?;
            if !expected.contains(id) || !seen.insert(id.to_owned()) {
                return Err("解析资源编号无效或重复".into());
            }
            let encoded = item["dataBase64"].as_str().ok_or("解析资源缺少内容")?;
            let bytes = BASE64.decode(encoded).map_err(|_| "解析资源 Base64 无效")?;
            if bytes.len() > 256 * 1024 * 1024 {
                return Err("解析资源超过大小限制".into());
            }
            let content_type = item["contentType"].as_str().ok_or("解析资源缺少类型")?;
            if id == manifest_id(&manifest.batch_id) {
                if bytes.len() > 1024 * 1024 || content_type != "application/json" {
                    return Err("解析清单附件无效".into());
                }
                let physical: ParseBatchManifest =
                    serde_json::from_slice(&bytes).map_err(|_| "解析清单附件无效")?;
                if physical != manifest {
                    return Err("解析清单附件与声明不一致".into());
                }
            } else {
                let meta = manifest
                    .attachments
                    .values()
                    .find(|r| r.attachment_id == id)
                    .ok_or("解析资源声明缺失")?;
                if meta.size != bytes.len() as u64
                    || meta.sha256 != sha256_hex(&bytes)
                    || meta.content_type != content_type
                {
                    return Err("解析资源摘要、大小或类型不一致".into());
                }
            }
            let resource = ImportedResource {
                id: id.into(),
                name: item["name"].as_str().unwrap_or(id).into(),
                content_type: content_type.into(),
                bytes,
            };
            if let Some(previous) = all.get(id) {
                if previous.bytes != resource.bytes
                    || previous.content_type != resource.content_type
                {
                    return Err("历史解析资源冲突".into());
                }
            } else {
                total = total
                    .checked_add(resource.bytes.len() as u64)
                    .ok_or("解析资源大小无效")?;
                if total > 512 * 1024 * 1024 {
                    return Err("解析批次资源超过大小限制".into());
                }
                all.insert(id.into(), resource);
            }
        }
        manifests.insert(manifest.batch_id.clone(), manifest);
    }
    if !required.iter().all(|id| manifests.contains_key(id)) {
        return Err("当前或历史解析批次缺失".into());
    }
    if !manifests.is_empty() {
        validate_in_isolated_library(paper, &all, &manifests).map_err(|e| e.message)?;
    }
    Ok(all.into_values().collect())
}

static VALIDATION_SEQ: AtomicU64 = AtomicU64::new(1);
struct ValidationDir(PathBuf);
impl Drop for ValidationDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn validate_in_isolated_library(
    paper: &PaperDto,
    resources: &BTreeMap<String, ImportedResource>,
    manifests: &BTreeMap<String, ParseBatchManifest>,
) -> Result<(), BridgeError> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "paper30min-import-{}-{nonce}-{}",
        std::process::id(),
        VALIDATION_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path)
        .map_err(|e| BridgeError::internal(format!("无法创建导入校验目录: {e}")))?;
    let dir = ValidationDir(path);
    let library = Library::open(&dir.0)?;
    let mut initial = paper.clone();
    initial.parse_batch_id = None;
    initial.parse_history.clear();
    library.put_paper(initial)?;
    for resource in resources.values() {
        library.put_attachment_bytes(
            &paper.id,
            &resource.id,
            &resource.name,
            &resource.content_type,
            &resource.bytes,
        )?;
    }
    for manifest in manifests.values() {
        let snapshot = library.pin_parse_batch(&paper.id, Some(&manifest.batch_id))?;
        if !manifest.batch_id.starts_with("legacy-") {
            let has_visual = manifest.attachments.contains_key("visual-assets.json")
                || manifest
                    .attachments
                    .contains_key("local-visual-assets.json");
            let replacing_current = paper.parse_batch_id.as_deref()
                == Some(manifest.batch_id.as_str())
                && paper.parse_history.iter().any(|entry| {
                    entry["batchId"]
                        .as_str()
                        .and_then(|batch| manifests.get(batch))
                        .is_some_and(|old| old.attachments.contains_key("blockmodel.json"))
                });
            // A first import can already expose its block model while visual preparation is pending.
            library.validate_parse_candidate(&snapshot, has_visual || replacing_current)?;
        }
    }
    Ok(())
}
