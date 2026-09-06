//! 浏览器整库 JSON 预检与提交。Rust 读取导出文件、签发预检令牌、按论文 ID 合并；
//! 不把 API Key 或应用设置写入书库，也不改写用户持有的原导出文件。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::error::BridgeError;
use crate::files::{
    attachment_path, insert_attachment_row, require_safe_segment, sha256_hex, write_atomic,
    AttachmentDto,
};
use crate::library::{
    normalize_paper, upsert_paper, AnalysisDto, ChatMessageDto, Library, PartDto, PaperDto,
    RecallCardDto, SectionDto, TranslationDto, LIBRARY_SCHEMA_VERSION,
};

pub const SUPPORTED_EXPORT_VERSION: i64 = 1;
pub const LIBRARY_FORMAT: &str = "paper-30min-library";
pub const MAX_EXPORT_BYTES: u64 = 512 * 1024 * 1024;
pub const DEFAULT_TTL_SECS: u64 = 15 * 60;

static TOKEN_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct InspectToken {
    source_path: PathBuf,
    sha256: String,
    expires_at: SystemTime,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectReport {
    schema_version: u32,
    format: String,
    format_version: i64,
    paper_count: usize,
    conflicts: Conflicts,
    errors: Vec<InspectIssue>,
    token: String,
    expires_at: String,
    api_key_stripped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Conflicts {
    new: usize,
    existing: usize,
    invalid: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectIssue {
    #[serde(skip_serializing_if = "Option::is_none")]
    paper_id: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitReport {
    schema_version: u32,
    added: usize,
    skipped: usize,
    attachments: usize,
}

struct PendingAttachment {
    id: String,
    name: String,
    content_type: String,
    bytes: Vec<u8>,
}

enum PreparedPaper {
    Invalid {
        paper_id: Option<String>,
        message: String,
    },
    Ready {
        paper: PaperDto,
        attachment: Option<PendingAttachment>,
    },
}

fn epoch_iso() -> String {
    "1970-01-01T00:00:00Z".to_string()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| epoch_iso())
}

fn system_time_to_iso(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    match OffsetDateTime::from_unix_timestamp(duration.as_secs() as i64) {
        Ok(dt) => dt
            .replace_nanosecond(duration.subsec_nanos())
            .ok()
            .and_then(|dt| dt.format(&Rfc3339).ok())
            .unwrap_or_else(epoch_iso),
        Err(_) => epoch_iso(),
    }
}

fn millis_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let Ok(dt) = OffsetDateTime::from_unix_timestamp(secs) else {
        return epoch_iso();
    };
    if millis == 0 {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            dt.year(),
            u8::from(dt.month()),
            dt.day(),
            dt.hour(),
            dt.minute(),
            dt.second()
        )
    } else {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            dt.year(),
            u8::from(dt.month()),
            dt.day(),
            dt.hour(),
            dt.minute(),
            dt.second(),
            millis
        )
    }
}

fn timestamp_to_iso(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return if text.is_empty() {
            String::new()
        } else {
            text.to_string()
        };
    }
    if let Some(ms) = value.as_i64() {
        return millis_to_iso(ms);
    }
    if let Some(ms) = value.as_f64() {
        return millis_to_iso(ms as i64);
    }
    String::new()
}

fn optional_timestamp(value: Option<&Value>) -> String {
    match value {
        Some(item) => {
            let converted = timestamp_to_iso(item);
            if converted.is_empty() {
                epoch_iso()
            } else {
                converted
            }
        }
        None => epoch_iso(),
    }
}

fn new_token_id() -> String {
    format!("mig-{:016x}", TOKEN_SEQ.fetch_add(1, Ordering::Relaxed))
}

fn read_export(path: &Path) -> Result<(Vec<u8>, String), BridgeError> {
    if !path.is_file() {
        return Err(BridgeError::invalid_input("找不到导出文件"));
    }
    let meta = fs::metadata(path).map_err(|err| {
        BridgeError::invalid_input(format!("无法读取导出文件: {err}"))
    })?;
    if meta.len() > MAX_EXPORT_BYTES {
        return Err(BridgeError::invalid_input(format!(
            "导出文件超过 {} MB 上限",
            MAX_EXPORT_BYTES / (1024 * 1024)
        )));
    }
    let bytes = fs::read(path).map_err(|err| {
        BridgeError::invalid_input(format!("无法读取导出文件: {err}"))
    })?;
    let digest = sha256_hex(&bytes);
    Ok((bytes, digest))
}

fn parse_envelope(bytes: &[u8]) -> Result<Value, BridgeError> {
    serde_json::from_slice(bytes).map_err(|_| BridgeError::invalid_input("文件不是有效的 JSON"))
}

fn require_library_export(payload: &Value) -> Result<i64, BridgeError> {
    let format = payload.get("format").and_then(Value::as_str).unwrap_or("");
    if format != LIBRARY_FORMAT {
        return Err(BridgeError::invalid_input("这不是论文精读书库导出文件"));
    }
    let version = payload
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| BridgeError::invalid_input("导出文件缺少版本"))?;
    if version != SUPPORTED_EXPORT_VERSION {
        return Err(BridgeError::unsupported_export_version(
            version,
            SUPPORTED_EXPORT_VERSION,
        ));
    }
    if !payload.get("papers").map(Value::is_array).unwrap_or(false) {
        return Err(BridgeError::invalid_input("导出文件缺少论文列表"));
    }
    Ok(version)
}

fn api_key_present(payload: &Value) -> bool {
    payload
        .get("settings")
        .and_then(|settings| settings.get("apiKey"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

fn existing_ids(library: &Library) -> Result<HashSet<String>, BridgeError> {
    Ok(library.list_papers()?.into_iter().map(|paper| paper.id).collect())
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn convert_parts(value: Option<&Value>) -> Vec<PartDto> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").trim();
            if id.is_empty() {
                return None;
            }
            Some(PartDto {
                id: id.to_string(),
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|text| text.to_string()),
                heading: item
                    .get("heading")
                    .and_then(Value::as_str)
                    .map(|text| text.to_string()),
                semantic_type: item
                    .get("semanticType")
                    .and_then(Value::as_str)
                    .map(|text| text.to_string()),
                sort_order: item
                    .get("sortOrder")
                    .and_then(Value::as_i64)
                    .unwrap_or(index as i64),
            })
        })
        .collect()
}

fn page_range(pages: Option<&Value>, id: &str) -> (Option<i64>, Option<i64>) {
    let Some(entry) = pages.and_then(|value| value.get(id)) else {
        return (None, None);
    };
    (
        entry.get("start").and_then(Value::as_i64),
        entry.get("end").and_then(Value::as_i64),
    )
}

fn convert_sections(raw: Option<&Value>, parts: &[PartDto], pages: Option<&Value>) -> Vec<SectionDto> {
    match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let id = item.get("id").and_then(Value::as_str).unwrap_or("").trim();
                if id.is_empty() {
                    return None;
                }
                Some(SectionDto {
                    id: id.to_string(),
                    source_text: item
                        .get("sourceText")
                        .or_else(|| item.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    page_start: item.get("pageStart").and_then(Value::as_i64),
                    page_end: item.get("pageEnd").and_then(Value::as_i64),
                })
            })
            .collect(),
        Some(Value::Object(map)) => ordered_section_ids(map, parts)
            .into_iter()
            .filter_map(|id| {
                let text = map.get(&id).and_then(Value::as_str)?;
                let (page_start, page_end) = page_range(pages, &id);
                Some(SectionDto {
                    id,
                    source_text: text.to_string(),
                    page_start,
                    page_end,
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn ordered_section_ids(map: &Map<String, Value>, parts: &[PartDto]) -> Vec<String> {
    let mut ids = Vec::new();
    if map.contains_key("abstract") {
        ids.push("abstract".to_string());
    }
    for part in parts {
        if map.contains_key(&part.id) && !ids.iter().any(|id| id == &part.id) {
            ids.push(part.id.clone());
        }
    }
    for key in map.keys() {
        if !ids.iter().any(|id| id == key) {
            ids.push(key.clone());
        }
    }
    ids
}

fn convert_analyses(raw: Option<&Value>) -> Vec<AnalysisDto> {
    match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let section_id = item
                    .get("sectionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if section_id.is_empty() {
                    return None;
                }
                Some(AnalysisDto {
                    section_id: section_id.to_string(),
                    text: item.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                    updated_at: optional_timestamp(item.get("updatedAt")),
                })
            })
            .collect(),
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(section_id, item)| {
                if section_id.trim().is_empty() {
                    return None;
                }
                Some(AnalysisDto {
                    section_id: section_id.clone(),
                    text: item.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                    updated_at: optional_timestamp(item.get("updatedAt")),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn convert_translations(raw: Option<&Value>) -> Vec<TranslationDto> {
    match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let section_id = item
                    .get("sectionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let language = item
                    .get("language")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if section_id.is_empty() || language.is_empty() {
                    return None;
                }
                Some(TranslationDto {
                    section_id: section_id.to_string(),
                    language: language.to_string(),
                    text: item.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                    source: item
                        .get("source")
                        .and_then(Value::as_str)
                        .map(|text| text.to_string()),
                    updated_at: optional_timestamp(item.get("updatedAt")),
                })
            })
            .collect(),
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(key, item)| {
                let (section_id, language) = key.split_once(':')?;
                if section_id.trim().is_empty() || language.trim().is_empty() {
                    return None;
                }
                Some(TranslationDto {
                    section_id: section_id.to_string(),
                    language: language.to_string(),
                    text: item.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                    source: item
                        .get("source")
                        .and_then(Value::as_str)
                        .map(|text| text.to_string()),
                    updated_at: optional_timestamp(item.get("updatedAt")),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn convert_chat(raw: Option<&Value>) -> Vec<ChatMessageDto> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("").trim();
            if role.is_empty() {
                return None;
            }
            Some(ChatMessageDto {
                role: role.to_string(),
                content: item
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                created_at: item
                    .get("createdAt")
                    .map(timestamp_to_iso)
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn convert_recall_card(raw: Option<&Value>) -> RecallCardDto {
    let Some(value) = raw else {
        return RecallCardDto::default();
    };
    RecallCardDto {
        markdown: value
            .get("markdown")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        images: match value.get("images") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        },
        updated_at: optional_timestamp(value.get("updatedAt")),
    }
}

fn convert_attachment(raw: &Value, paper_id: &str) -> Result<Option<PendingAttachment>, String> {
    let Some(blob) = raw.get("pdfBlob") else {
        return Ok(None);
    };
    if blob.is_null() {
        return Ok(None);
    }
    let base64 = blob
        .get("base64")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let Some(base64) = base64 else {
        return Ok(None);
    };
    if require_safe_segment(paper_id, "paperId").is_err() {
        return Err("论文编号不能用于保存 PDF 附件".to_string());
    }
    let bytes = BASE64
        .decode(base64)
        .map_err(|_| "PDF 附件不是有效的 Base64".to_string())?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let name = raw
        .get("pdfName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("paper.pdf")
        .to_string();
    let content_type = blob
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("application/pdf")
        .to_string();
    Ok(Some(PendingAttachment {
        id: "pdf".to_string(),
        name,
        content_type,
        bytes,
    }))
}

fn convert_paper(raw: &Value) -> PreparedPaper {
    if !raw.is_object() {
        return PreparedPaper::Invalid {
            paper_id: None,
            message: "论文记录无效".to_string(),
        };
    }
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return PreparedPaper::Invalid {
            paper_id: None,
            message: "论文缺少 id".to_string(),
        };
    }
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return PreparedPaper::Invalid {
            paper_id: Some(id),
            message: "论文缺少 title".to_string(),
        };
    }
    let attachment = match convert_attachment(raw, &id) {
        Ok(attachment) => attachment,
        Err(message) => {
            return PreparedPaper::Invalid {
                paper_id: Some(id),
                message,
            };
        }
    };
    let parts = convert_parts(raw.get("parts"));
    let mut paper = PaperDto {
        id,
        title,
        source_type: raw
            .get("sourceType")
            .and_then(Value::as_str)
            .map(|text| text.to_string()),
        arxiv_id: raw
            .get("arxivId")
            .and_then(Value::as_str)
            .map(|text| text.to_string()),
        pdf_name: raw
            .get("pdfName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        num_pages: raw.get("numPages").and_then(Value::as_i64).unwrap_or(0),
        full_text: raw
            .get("fullText")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        rating: raw.get("rating").and_then(Value::as_i64).unwrap_or(0),
        categories: string_list(raw.get("categories")),
        tags: string_list(raw.get("tags")),
        added_at: timestamp_to_iso(raw.get("addedAt").unwrap_or(&Value::Null)),
        updated_at: timestamp_to_iso(raw.get("updatedAt").unwrap_or(&Value::Null)),
        sections: convert_sections(raw.get("sections"), &parts, raw.get("sectionPages")),
        parts,
        analyses: convert_analyses(raw.get("analyses")),
        translations: convert_translations(raw.get("translations")),
        recall_card: convert_recall_card(raw.get("recallCard")),
        chat: convert_chat(raw.get("chat")),
    };
    if let Err(error) = normalize_paper(&mut paper) {
        return PreparedPaper::Invalid {
            paper_id: Some(paper.id),
            message: error.message,
        };
    }
    PreparedPaper::Ready { paper, attachment }
}

fn prepare_papers(payload: &Value) -> Vec<PreparedPaper> {
    payload
        .get("papers")
        .and_then(Value::as_array)
        .map(|papers| papers.iter().map(convert_paper).collect())
        .unwrap_or_default()
}

fn lock_tokens(
    library: &Library,
) -> Result<std::sync::MutexGuard<'_, std::collections::HashMap<String, InspectToken>>, BridgeError>
{
    library
        .inspect_tokens
        .lock()
        .map_err(|_| BridgeError::internal("预检令牌锁定失败"))
}

fn remove_written_files(paths: &[PathBuf]) {
    for dest in paths {
        let _ = fs::remove_file(dest);
        if let Some(name) = dest.file_name().and_then(|name| name.to_str()) {
            let _ = fs::remove_file(dest.with_file_name(format!("{name}.part")));
            let _ = fs::remove_file(dest.with_file_name(format!("{name}.old")));
        }
        if let Some(parent) = dest.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

impl Library {
    pub fn inspect_migration(&self, source_path: &str, ttl_seconds: u64) -> Result<Value, BridgeError> {
        if source_path.trim().is_empty() {
            return Err(BridgeError::invalid_input("migration.inspect@1 需要 sourcePath"));
        }
        let path = PathBuf::from(source_path);
        let (bytes, digest) = read_export(&path)?;
        let payload = parse_envelope(&bytes)?;
        let format_version = require_library_export(&payload)?;
        let papers = prepare_papers(&payload);
        let existing = existing_ids(self)?;
        let mut conflicts = Conflicts {
            new: 0,
            existing: 0,
            invalid: 0,
        };
        let mut errors = Vec::new();
        for paper in &papers {
            match paper {
                PreparedPaper::Invalid { paper_id, message } => {
                    conflicts.invalid += 1;
                    errors.push(InspectIssue {
                        paper_id: paper_id.clone(),
                        message: message.clone(),
                    });
                }
                PreparedPaper::Ready { paper, .. } => {
                    if existing.contains(&paper.id) {
                        conflicts.existing += 1;
                    } else {
                        conflicts.new += 1;
                    }
                }
            }
        }
        let expires_at = if ttl_seconds == 0 {
            UNIX_EPOCH
        } else {
            SystemTime::now() + Duration::from_secs(ttl_seconds)
        };
        let token = new_token_id();
        {
            let mut tokens = lock_tokens(self)?;
            tokens.insert(
                token.clone(),
                InspectToken {
                    source_path: path,
                    sha256: digest,
                    expires_at,
                },
            );
        }
        serde_json::to_value(InspectReport {
            schema_version: LIBRARY_SCHEMA_VERSION,
            format: LIBRARY_FORMAT.to_string(),
            format_version,
            paper_count: papers.len(),
            conflicts,
            errors,
            token,
            expires_at: system_time_to_iso(expires_at),
            api_key_stripped: api_key_present(&payload),
        })
        .map_err(|err| BridgeError::internal(format!("序列化预检结果失败: {err}")))
    }

    pub fn commit_migration(&self, token: &str) -> Result<Value, BridgeError> {
        if token.trim().is_empty() {
            return Err(BridgeError::invalid_input("migration.commit@1 需要 token"));
        }
        let inspect = {
            let tokens = lock_tokens(self)?;
            tokens
                .get(token)
                .cloned()
                .ok_or_else(|| BridgeError::invalid_input("预检令牌无效或已使用"))?
        };
        if inspect.expires_at <= SystemTime::now() {
            let mut tokens = lock_tokens(self)?;
            tokens.remove(token);
            return Err(BridgeError::token_expired());
        }
        let (bytes, digest) = match read_export(&inspect.source_path) {
            Ok(result) => result,
            Err(_) => {
                let mut tokens = lock_tokens(self)?;
                tokens.remove(token);
                return Err(BridgeError::source_changed());
            }
        };
        if digest != inspect.sha256 {
            let mut tokens = lock_tokens(self)?;
            tokens.remove(token);
            return Err(BridgeError::source_changed());
        }
        let payload = parse_envelope(&bytes)?;
        require_library_export(&payload)?;
        let prepared = prepare_papers(&payload);
        let existing = existing_ids(self)?;
        let mut to_add = Vec::new();
        let mut skipped = 0;
        for paper in prepared {
            match paper {
                PreparedPaper::Invalid { .. } => skipped += 1,
                PreparedPaper::Ready { paper, attachment } => {
                    if existing.contains(&paper.id) {
                        skipped += 1;
                    } else {
                        to_add.push((paper, attachment));
                    }
                }
            }
        }

        let mut written = Vec::new();
        let added = to_add.len();
        let mut attachments = 0;
        let commit_result = (|| {
            let mut conn = self.lock_conn()?;
            let tx = conn.transaction().map_err(|err| {
                BridgeError::internal(format!("书库数据库错误: {err}"))
            })?;
            for (paper, attachment) in &to_add {
                upsert_paper(&tx, paper)?;
                if let Some(pending) = attachment {
                    let dest = attachment_path(self.root(), &paper.id, &pending.id)?;
                    write_atomic(&dest, &pending.bytes)?;
                    written.push(dest);
                    let dto = AttachmentDto {
                        paper_id: paper.id.clone(),
                        id: pending.id.clone(),
                        name: pending.name.clone(),
                        content_type: pending.content_type.clone(),
                        size: pending.bytes.len() as i64,
                        sha256: sha256_hex(&pending.bytes),
                        created_at: now_iso(),
                    };
                    insert_attachment_row(&tx, &dto)?;
                    attachments += 1;
                }
            }
            tx.commit()
                .map_err(|err| BridgeError::internal(format!("书库数据库错误: {err}")))?;
            Ok::<(), BridgeError>(())
        })();
        if let Err(error) = commit_result {
            remove_written_files(&written);
            return Err(error);
        }
        {
            let mut tokens = lock_tokens(self)?;
            tokens.remove(token);
        }
        serde_json::to_value(CommitReport {
            schema_version: LIBRARY_SCHEMA_VERSION,
            added,
            skipped,
            attachments,
        })
        .map_err(|err| BridgeError::internal(format!("序列化提交结果失败: {err}")))
    }
}

pub fn inspect_input(input: &Value) -> Result<(&str, u64), BridgeError> {
    let source_path = input
        .get("sourcePath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BridgeError::invalid_input("migration.inspect@1 需要 sourcePath"))?;
    let ttl_seconds = match input.get("ttlSeconds") {
        None => DEFAULT_TTL_SECS,
        Some(Value::Null) => DEFAULT_TTL_SECS,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| BridgeError::invalid_input("ttlSeconds 必须是非负整数"))?,
    };
    Ok((source_path, ttl_seconds))
}
