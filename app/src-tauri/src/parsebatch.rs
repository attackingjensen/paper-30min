//! Immutable candidate manifests and pinned reads; publication belongs to U6.
use crate::error::BridgeError;
use crate::files::{attachment_path, require_safe_segment, sha256_hex, AttachmentDto};
use crate::library::Library;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::PathBuf;

enum BatchResource {
    Bytes(Vec<u8>),
    Path(PathBuf),
}
impl BatchResource {
    fn read(&self, root: &std::path::Path) -> Result<Vec<u8>, BridgeError> {
        match self {
            Self::Bytes(bytes) => Ok(bytes.clone()),
            Self::Path(path) => {
                if !crate::pdfmap_evidence::safe_path(root, path) {
                    return Err(stale());
                }
                let file = File::open(path).map_err(|_| stale())?;
                if !file.metadata().map_err(|_| stale())?.is_file() {
                    return Err(stale());
                }
                let mut bytes = Vec::new();
                file.take(MAX_RESOURCE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| stale())?;
                if bytes.len() as u64 > MAX_RESOURCE_BYTES {
                    return Err(BridgeError::invalid_input("Batch resource too large"));
                }
                Ok(bytes)
            }
        }
    }
}

pub const PARSE_BATCH_SCHEMA_VERSION: u32 = 1;
const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// 单批次附件数上限：约束清单体积与内存占用；cloudassets 的视觉资源配额由它推导。
pub(crate) const MAX_BATCH_ATTACHMENTS: usize = 10000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseBatchAttachment {
    pub attachment_id: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseBatchManifest {
    pub schema_version: u32,
    pub paper_id: String,
    pub batch_id: String,
    pub pdf_sha256: String,
    pub provider: String,
    pub model: String,
    pub options: Value,
    pub raw_sha256: String,
    pub attachments: BTreeMap<String, ParseBatchAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseBatchSnapshot {
    pub manifest: ParseBatchManifest,
    legacy: bool,
    manifest_sha256: Option<String>,
}

fn stale() -> BridgeError {
    BridgeError::new(
        "parse_batch_stale",
        "解析批次资源已变化，请重新加载论文",
        false,
    )
}

fn digest(value: &str) -> Result<(), BridgeError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(BridgeError::invalid_input("批次 SHA-256 无效"));
    }
    Ok(())
}

fn manifest_id(batch_id: &str) -> String {
    format!("parsebatch-{}", sha256_hex(batch_id.as_bytes()))
}

fn validate(manifest: &ParseBatchManifest, legacy: bool) -> Result<(), BridgeError> {
    require_safe_segment(&manifest.paper_id, "paperId")?;
    require_safe_segment(&manifest.batch_id, "batchId")?;
    if manifest.schema_version != PARSE_BATCH_SCHEMA_VERSION {
        return Err(BridgeError::invalid_input("不支持的批次清单版本"));
    }
    if !legacy {
        if manifest.batch_id.starts_with("legacy-")
            || manifest.provider.trim().is_empty()
            || manifest.model.trim().is_empty()
        {
            return Err(BridgeError::invalid_input("批次身份无效"));
        }
        digest(&manifest.pdf_sha256)?;
        digest(&manifest.raw_sha256)?;
        if manifest
            .attachments
            .get("pdf")
            .is_some_and(|pdf| pdf.sha256 != manifest.pdf_sha256)
        {
            return Err(BridgeError::invalid_input("批次 PDF 资源与原文身份不一致"));
        }
    }
    let mut total = 0u64;
    for (logical, resource) in &manifest.attachments {
        require_safe_segment(logical, "logicalAttachmentId")?;
        require_safe_segment(&resource.attachment_id, "attachmentId")?;
        digest(&resource.sha256)?;
        if resource.size > MAX_RESOURCE_BYTES {
            return Err(BridgeError::invalid_input("批次附件超过大小限制"));
        }
        total = total
            .checked_add(resource.size)
            .ok_or_else(|| BridgeError::invalid_input("批次大小无效"))?;
    }
    if total > MAX_BATCH_BYTES || manifest.attachments.len() > MAX_BATCH_ATTACHMENTS {
        return Err(BridgeError::invalid_input("批次资源超过限制"));
    }
    Ok(())
}

impl Library {
    /// Writes only candidate attachments. A durable manifest seals their identity.
    pub fn write_parse_batch(
        &self,
        manifest: ParseBatchManifest,
        resources: BTreeMap<String, Vec<u8>>,
    ) -> Result<ParseBatchManifest, BridgeError> {
        self.write_parse_batch_resources(
            manifest,
            resources
                .into_iter()
                .map(|(id, bytes)| (id, BatchResource::Bytes(bytes)))
                .collect(),
            &|| Ok(()),
        )
    }

    /// Seal staged files one at a time; the immutable manifest is still written last.
    pub(crate) fn write_parse_batch_paths_with_checkpoint(
        &self,
        manifest: ParseBatchManifest,
        resources: BTreeMap<String, PathBuf>,
        checkpoint: impl Fn() -> Result<(), BridgeError>,
    ) -> Result<ParseBatchManifest, BridgeError> {
        self.write_parse_batch_resources(
            manifest,
            resources
                .into_iter()
                .map(|(id, path)| (id, BatchResource::Path(path)))
                .collect(),
            &checkpoint,
        )
    }

    fn write_parse_batch_resources(
        &self,
        mut manifest: ParseBatchManifest,
        resources: BTreeMap<String, BatchResource>,
        checkpoint: &dyn Fn() -> Result<(), BridgeError>,
    ) -> Result<ParseBatchManifest, BridgeError> {
        validate(&manifest, false)?;
        let total = resources.values().try_fold(0u64, |total, resource| {
            checkpoint()?;
            let bytes = resource.read(self.root())?;
            let size = bytes.len() as u64;
            if size > MAX_RESOURCE_BYTES {
                return Err(BridgeError::invalid_input("批次附件超过大小限制"));
            }
            total
                .checked_add(size)
                .ok_or_else(|| BridgeError::invalid_input("批次大小无效"))
        })?;
        if total > MAX_BATCH_BYTES || resources.len() > MAX_BATCH_ATTACHMENTS {
            return Err(BridgeError::invalid_input("批次资源超过限制"));
        }
        self.get_paper(&manifest.paper_id)?;
        let pdf = self.get_attachment(&manifest.paper_id, "pdf")?;
        if pdf.size < 0 || pdf.sha256 != manifest.pdf_sha256 {
            return Err(stale());
        }
        self.read_verified_batch_file(
            &manifest.paper_id,
            "pdf",
            &manifest.pdf_sha256,
            pdf.size as u64,
            false,
        )?;
        let id = manifest_id(&manifest.batch_id);
        let lock_path = attachment_path(self.root(), &manifest.paper_id, &format!("{id}.lock"))?;
        if let Some(parent) = lock_path.parent() {
            let probe = if parent.exists() {
                parent
            } else {
                parent.parent().ok_or_else(stale)?
            };
            if !crate::pdfmap_evidence::safe_path(self.root(), probe) {
                return Err(stale());
            }
            std::fs::create_dir_all(parent)
                .map_err(|_| BridgeError::internal("无法创建批次目录"))?;
        }
        if lock_path.exists() && !crate::pdfmap_evidence::safe_path(self.root(), &lock_path) {
            return Err(stale());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| BridgeError::internal("无法锁定批次"))?;
        lock.try_lock()
            .map_err(|_| BridgeError::new("paper_busy", "批次正在写入", true))?;
        if self
            .list_attachments(&manifest.paper_id)?
            .iter()
            .any(|a| a.id == id)
        {
            return Err(BridgeError::new(
                "parse_batch_exists",
                "解析批次已封存",
                false,
            ));
        }
        let declared = manifest.attachments.clone();
        manifest.attachments.clear();
        for (logical, resource) in &resources {
            checkpoint()?;
            let bytes = resource.read(self.root())?;
            require_safe_segment(logical, "logicalAttachmentId")?;
            let sha = sha256_hex(&bytes);
            let resource_id = format!(
                "parseasset-{}",
                sha256_hex(format!("{}:{logical}:{sha}", manifest.batch_id).as_bytes())
            );
            let content_type = declared
                .get(logical)
                .map(|a| a.content_type.clone())
                .unwrap_or_else(|| "application/octet-stream".to_string());
            if let Some(expected) = declared.get(logical) {
                if expected.sha256 != sha || expected.size != bytes.len() as u64 {
                    return Err(BridgeError::invalid_input("候选资源与声明摘要不一致"));
                }
            }
            manifest.attachments.insert(
                logical.clone(),
                ParseBatchAttachment {
                    attachment_id: resource_id,
                    sha256: sha,
                    size: bytes.len() as u64,
                    content_type,
                },
            );
        }
        if !declared.is_empty() && !declared.keys().eq(resources.keys()) {
            return Err(BridgeError::invalid_input("候选资源不完整"));
        }
        validate(&manifest, false)?;
        let encoded = serde_json::to_vec(&manifest)
            .map_err(|_| BridgeError::invalid_input("批次清单无法编码"))?;
        if encoded.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(BridgeError::invalid_input("批次清单过大"));
        }
        for (logical, staged) in resources {
            checkpoint()?;
            let bytes = staged.read(self.root())?;
            let resource = &manifest.attachments[&logical];
            if sha256_hex(&bytes) != resource.sha256 || bytes.len() as u64 != resource.size {
                return Err(stale());
            }
            self.put_attachment_bytes(
                &manifest.paper_id,
                &resource.attachment_id,
                &logical,
                &resource.content_type,
                &bytes,
            )?;
        }
        checkpoint()?;
        self.put_attachment_bytes(
            &manifest.paper_id,
            &id,
            "parsebatch.json",
            "application/json",
            &encoded,
        )?;
        Ok(manifest)
    }

    pub fn pin_parse_batch(
        &self,
        paper_id: &str,
        batch_id: Option<&str>,
    ) -> Result<ParseBatchSnapshot, BridgeError> {
        require_safe_segment(paper_id, "paperId")?;
        let current;
        let batch_id = if batch_id.is_none() {
            current = self.current_parse_batch_id(paper_id)?;
            current.as_deref()
        } else {
            batch_id
        };
        if let Some(batch) = batch_id {
            require_safe_segment(batch, "batchId")?;
            {
                let id = manifest_id(batch);
                let dto = self.get_attachment(paper_id, &id)?;
                if dto.size < 0 || dto.size as u64 > MAX_MANIFEST_BYTES {
                    return Err(BridgeError::invalid_input("批次清单过大"));
                }
                let bytes = self.read_verified_batch_file(
                    paper_id,
                    &id,
                    &dto.sha256,
                    dto.size as u64,
                    true,
                )?;
                let manifest: ParseBatchManifest = serde_json::from_slice(&bytes)
                    .map_err(|_| BridgeError::invalid_input("批次清单无效"))?;
                let legacy = batch.starts_with("legacy-");
                validate(&manifest, legacy)?;
                if manifest.paper_id != paper_id || manifest.batch_id != batch {
                    return Err(stale());
                }
                let snapshot = ParseBatchSnapshot {
                    manifest,
                    legacy,
                    manifest_sha256: Some(dto.sha256),
                };
                self.verify_parse_batch(&snapshot)?;
                return Ok(snapshot);
            }
        }
        let mut attachments = BTreeMap::new();
        for dto in self.list_attachments(paper_id)? {
            if !matches!(
                dto.id.as_str(),
                "pdf" | "blockmodel.json" | "docling-source.json" | "cloud-source.json"
            ) && !dto.id.starts_with(crate::pdfassets::PAGE_ID_PREFIX)
                && !dto.id.starts_with(crate::pdfassets::CROP_ID_PREFIX)
            {
                continue;
            }
            if dto.size < 0 {
                return Err(stale());
            }
            attachments.insert(
                dto.id.clone(),
                ParseBatchAttachment {
                    attachment_id: dto.id,
                    sha256: dto.sha256,
                    size: dto.size as u64,
                    content_type: dto.content_type,
                },
            );
        }
        let encoded = serde_json::to_vec(&attachments)
            .map_err(|_| BridgeError::internal("无法固定旧附件"))?;
        let legacy_id = format!("legacy-{}", sha256_hex(&encoded));
        if batch_id.is_some_and(|id| id != legacy_id) {
            return Err(stale());
        }
        let mut snapshot = ParseBatchSnapshot {
            manifest: ParseBatchManifest {
                schema_version: 1,
                paper_id: paper_id.into(),
                batch_id: legacy_id,
                pdf_sha256: attachments
                    .get("pdf")
                    .map(|a| a.sha256.clone())
                    .unwrap_or_default(),
                provider: "docling".into(),
                model: "legacy".into(),
                options: Value::Null,
                raw_sha256: String::new(),
                attachments,
            },
            legacy: true,
            manifest_sha256: None,
        };
        validate(&snapshot.manifest, true)?;
        let encoded = serde_json::to_vec(&snapshot.manifest)
            .map_err(|_| BridgeError::internal("无法保存兼容批次"))?;
        if encoded.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(BridgeError::invalid_input("批次清单过大"));
        }
        let id = manifest_id(&snapshot.manifest.batch_id);
        let sha = sha256_hex(&encoded);
        match self.get_attachment(paper_id, &id) {
            Ok(dto) if dto.sha256 == sha => {}
            Ok(_) => return Err(stale()),
            Err(e) if e.code == "not_found" => {
                self.put_attachment_bytes(
                    paper_id,
                    &id,
                    "parsebatch.json",
                    "application/json",
                    &encoded,
                )?;
            }
            Err(e) => return Err(e),
        }
        snapshot.manifest_sha256 = Some(sha);
        self.verify_parse_batch(&snapshot)?;
        Ok(snapshot)
    }

    pub fn freeze_legacy_parse_batch(&self, paper_id: &str) -> Result<ParseBatchSnapshot, BridgeError> {
        let old = self.pin_parse_batch(paper_id, None)?;
        if !old.legacy { return Ok(old); }
        let mut manifest = old.manifest.clone();
        manifest.batch_id = format!("frozen-{}", sha256_hex(serde_json::to_vec(&old.manifest).map_err(|_| stale())?.as_slice()));
        manifest.raw_sha256 = manifest.attachments.get("docling-source.json")
            .map(|r| r.sha256.clone()).unwrap_or_else(|| sha256_hex(b"legacy-without-source"));
        if let Ok(existing) = self.pin_parse_batch(paper_id, Some(&manifest.batch_id)) { return Ok(existing); }
        let mut resources = BTreeMap::new();
        for logical in old.manifest.attachments.keys() {
            resources.insert(logical.clone(), self.read_parse_batch_attachment(&old, logical)?.1);
        }
        if let Some(model) = old.manifest.attachments.get("blockmodel.json") {
            if let Ok(evidence) = crate::pdfmap_evidence::get_source_regions(self, paper_id, &model.sha256) {
                if !resources.contains_key("docling-source.json") {
                    if let Some(bytes) = crate::pdfmap_evidence::recover_legacy_source_bytes(self,paper_id,&evidence) {
                        manifest.raw_sha256 = sha256_hex(&bytes);
                        manifest.attachments.insert("docling-source.json".into(),ParseBatchAttachment {
                            attachment_id:"docling-source.json".into(),sha256:sha256_hex(&bytes),size:bytes.len() as u64,content_type:"application/json".into(),
                        });
                        resources.insert("docling-source.json".into(),bytes);
                    }
                }
                let bytes = serde_json::to_vec(&evidence).map_err(|_| stale())?;
                manifest.attachments.insert("local-source-evidence.json".into(), ParseBatchAttachment {
                    attachment_id:"local-source-evidence.json".into(), sha256:sha256_hex(&bytes),size:bytes.len() as u64,content_type:"application/json".into(),
                });
                resources.insert("local-source-evidence.json".into(), bytes);
            }
        }
        self.verify_parse_batch(&old)?;
        self.write_parse_batch(manifest.clone(), resources)?;
        self.pin_parse_batch(paper_id, Some(&manifest.batch_id))
    }

    pub fn verify_parse_batch(&self, snapshot: &ParseBatchSnapshot) -> Result<(), BridgeError> {
        self.check_parse_batch(snapshot, true)
    }

    fn check_parse_batch(
        &self,
        snapshot: &ParseBatchSnapshot,
        verify_bytes: bool,
    ) -> Result<(), BridgeError> {
        validate(&snapshot.manifest, snapshot.legacy)?;
        let attachments: BTreeMap<_, _> = self
            .list_attachments(&snapshot.manifest.paper_id)
            .map_err(|_| stale())?
            .into_iter()
            .map(|dto| (dto.id.clone(), dto))
            .collect();
        if !snapshot.legacy {
            let pdf_id = snapshot
                .manifest
                .attachments
                .get("pdf")
                .map(|pdf| pdf.attachment_id.as_str())
                .unwrap_or("pdf");
            let pdf = attachments.get(pdf_id).ok_or_else(stale)?;
            if pdf.size < 0 || pdf.sha256 != snapshot.manifest.pdf_sha256 {
                return Err(stale());
            }
            if verify_bytes {
                self.read_verified_batch_file(
                    &snapshot.manifest.paper_id,
                    pdf_id,
                    &pdf.sha256,
                    pdf.size as u64,
                    false,
                )?;
            }
        }
        if snapshot.legacy != snapshot.manifest.batch_id.starts_with("legacy-") {
            return Err(stale());
        }
        if let Some(sha) = &snapshot.manifest_sha256 {
            let dto = attachments
                .get(&manifest_id(&snapshot.manifest.batch_id))
                .ok_or_else(stale)?;
            if &dto.sha256 != sha || dto.size < 0 || dto.size as u64 > MAX_MANIFEST_BYTES {
                return Err(stale());
            }
            let bytes = self.read_verified_batch_file(
                &snapshot.manifest.paper_id,
                &dto.id,
                sha,
                dto.size as u64,
                true,
            )?;
            let stored: ParseBatchManifest = serde_json::from_slice(&bytes).map_err(|_| stale())?;
            if stored != snapshot.manifest {
                return Err(stale());
            }
        } else {
            return Err(stale());
        }
        for resource in snapshot.manifest.attachments.values() {
            let dto = attachments.get(&resource.attachment_id).ok_or_else(stale)?;
            if dto.size < 0
                || dto.size as u64 != resource.size
                || dto.sha256 != resource.sha256
                || dto.content_type != resource.content_type
            {
                return Err(stale());
            }
            if verify_bytes {
                self.read_verified_batch_file(
                    &snapshot.manifest.paper_id,
                    &resource.attachment_id,
                    &resource.sha256,
                    resource.size,
                    false,
                )?;
            }
        }
        Ok(())
    }

    pub fn read_parse_batch_attachment(
        &self,
        snapshot: &ParseBatchSnapshot,
        logical_id: &str,
    ) -> Result<(AttachmentDto, Vec<u8>), BridgeError> {
        require_safe_segment(logical_id, "logicalAttachmentId")?;
        self.check_parse_batch(snapshot, false)?;
        let resource = snapshot
            .manifest
            .attachments
            .get(logical_id)
            .ok_or_else(|| {
                BridgeError::attachment_not_found(&snapshot.manifest.paper_id, logical_id)
            })?;
        let bytes = self.read_verified_batch_file(
            &snapshot.manifest.paper_id,
            &resource.attachment_id,
            &resource.sha256,
            resource.size,
            true,
        )?;
        let dto = self.get_attachment(&snapshot.manifest.paper_id, &resource.attachment_id)?;
        if dto.sha256 != resource.sha256 || dto.size as u64 != resource.size {
            return Err(stale());
        }
        Ok((dto, bytes))
    }

    fn read_verified_batch_file(
        &self,
        paper_id: &str,
        id: &str,
        sha: &str,
        size: u64,
        collect: bool,
    ) -> Result<Vec<u8>, BridgeError> {
        if size > MAX_RESOURCE_BYTES {
            return Err(stale());
        }
        let dto = self.get_attachment(paper_id, id).map_err(|_| stale())?;
        if dto.size < 0 || dto.size as u64 != size || dto.sha256 != sha {
            return Err(stale());
        }
        let path = attachment_path(self.root(), paper_id, id)?;
        if !crate::pdfmap_evidence::safe_path(self.root(), &path) {
            return Err(stale());
        }
        let mut file = File::open(path).map_err(|_| stale())?;
        if file.metadata().map_err(|_| stale())?.len() != size {
            return Err(stale());
        }
        let mut hasher = Sha256::new();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 65536];
        let mut read = 0u64;
        loop {
            let count = file.read(&mut buffer).map_err(|_| stale())?;
            if count == 0 {
                break;
            }
            read += count as u64;
            if read > size {
                return Err(stale());
            }
            hasher.update(&buffer[..count]);
            if collect {
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        let actual = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if read != size || actual != sha {
            return Err(stale());
        }
        Ok(bytes)
    }
}
