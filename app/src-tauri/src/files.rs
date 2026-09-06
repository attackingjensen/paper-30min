//! 附件与 PDF：按论文分区保存、路径约束、原子写入、完整性校验与范围读取。
//! JavaScript 只看到版本化 DTO，不接触绝对路径。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::error::BridgeError;
use crate::library::Library;

pub const FILES_SCHEMA_VERSION: u32 = 1;
const TEMP_SUFFIX: &str = ".part";
const OLD_SUFFIX: &str = ".old";
const MAX_SEGMENT_LEN: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub paper_id: String,
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size: i64,
    pub sha256: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentWrite {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub content_type: Option<String>,
    pub content_base64: String,
}

fn io_error(err: std::io::Error) -> BridgeError {
    BridgeError::internal(format!("附件文件错误: {err}"))
}

fn sqlite_error(err: rusqlite::Error) -> BridgeError {
    BridgeError::internal(format!("书库数据库错误: {err}"))
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 论文 ID 与附件 ID 只能是单段安全名，不能拼进绝对路径或 `..`。
pub fn require_safe_segment(value: &str, field: &str) -> Result<(), BridgeError> {
    if value.is_empty() {
        return Err(BridgeError::invalid_input(format!("{field} 不能为空")));
    }
    if value.len() > MAX_SEGMENT_LEN {
        return Err(BridgeError::invalid_input(format!("{field} 过长")));
    }
    if value == "."
        || value == ".."
        || value.starts_with('.')
        || value.ends_with(TEMP_SUFFIX)
        || value.ends_with(OLD_SUFFIX)
    {
        return Err(BridgeError::invalid_input(format!("{field} 不是合法标识: {value}")));
    }
    let safe = value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.');
    if !safe {
        return Err(BridgeError::invalid_input(format!("{field} 不是合法标识: {value}")));
    }
    Ok(())
}

fn paper_dir(root: &Path, paper_id: &str) -> Result<PathBuf, BridgeError> {
    require_safe_segment(paper_id, "paperId")?;
    Ok(root.join("attachments").join(paper_id))
}

pub(crate) fn attachment_path(root: &Path, paper_id: &str, attachment_id: &str) -> Result<PathBuf, BridgeError> {
    require_safe_segment(paper_id, "paperId")?;
    require_safe_segment(attachment_id, "attachmentId")?;
    let attachments_root = root.join("attachments");
    let dest = attachments_root.join(paper_id).join(attachment_id);
    ensure_within(&attachments_root, &dest)?;
    Ok(dest)
}

fn ensure_within(root: &Path, candidate: &Path) -> Result<(), BridgeError> {
    let root_canon = fs::canonicalize(root).map_err(io_error)?;
    let mut probe = candidate;
    let mut parents = Vec::new();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if parent != probe => {
                parents.push(parent.to_path_buf());
                probe = parent;
            }
            _ => {
                return Err(BridgeError::invalid_input("附件路径越出应用数据根目录"));
            }
        }
    }
    let probe_canon = fs::canonicalize(probe).map_err(io_error)?;
    if !probe_canon.starts_with(&root_canon) {
        return Err(BridgeError::invalid_input("附件路径越出应用数据根目录"));
    }
    Ok(())
}

pub(crate) fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), BridgeError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| BridgeError::invalid_input("附件文件名无效"))?;
    let temp = dest.with_file_name(format!("{file_name}{TEMP_SUFFIX}"));
    let old = dest.with_file_name(format!("{file_name}{OLD_SUFFIX}"));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
            .map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
    }
    if dest.exists() {
        if old.exists() {
            fs::remove_file(&old).map_err(io_error)?;
        }
        fs::rename(dest, &old).map_err(io_error)?;
    }
    if let Err(error) = fs::rename(&temp, dest) {
        if old.exists() {
            let _ = fs::rename(&old, dest);
        }
        return Err(io_error(error));
    }
    Ok(())
}

pub(crate) fn insert_attachment_row(
    tx: &rusqlite::Transaction<'_>,
    dto: &AttachmentDto,
) -> Result<(), BridgeError> {
    tx.execute(
        "INSERT INTO attachments(paper_id, attachment_id, name, content_type, byte_size, sha256, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(paper_id, attachment_id) DO UPDATE SET
           name=excluded.name,
           content_type=excluded.content_type,
           byte_size=excluded.byte_size,
           sha256=excluded.sha256",
        params![
            dto.paper_id,
            dto.id,
            dto.name,
            dto.content_type,
            dto.size,
            dto.sha256,
            dto.created_at
        ],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

impl Library {
    pub fn put_attachment(&self, paper_id: &str, write: AttachmentWrite) -> Result<AttachmentDto, BridgeError> {
        require_safe_segment(paper_id, "paperId")?;
        require_safe_segment(&write.id, "attachment.id")?;
        let name = write.name.trim();
        if name.is_empty() {
            return Err(BridgeError::invalid_input("附件需要 name"));
        }
        let bytes = BASE64.decode(write.content_base64.trim()).map_err(|_| {
            BridgeError::invalid_input("附件 contentBase64 无效")
        })?;
        let content_type = write
            .content_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("application/octet-stream")
            .to_string();
        let sha256 = sha256_hex(&bytes);
        let size = bytes.len() as i64;
        let created_at = now_iso();
        let dest = attachment_path(self.root(), paper_id, &write.id)?;
        let dto = AttachmentDto {
            paper_id: paper_id.to_string(),
            id: write.id,
            name: name.to_string(),
            content_type,
            size,
            sha256,
            created_at,
        };

        let mut conn = self.lock_conn()?;
        if !Self::paper_exists(&conn, paper_id)? {
            return Err(BridgeError::paper_not_found(paper_id));
        }
        write_atomic(&dest, &bytes)?;
        let tx = conn.transaction().map_err(sqlite_error)?;
        let sql_result = insert_attachment_row(&tx, &dto)
            .and_then(|_| tx.commit().map_err(sqlite_error));
        if let Err(error) = sql_result {
            let _ = fs::remove_file(&dest);
            let old = dest.with_file_name(format!("{}{OLD_SUFFIX}", dto.id));
            if old.exists() {
                let _ = fs::rename(&old, &dest);
            }
            return Err(error);
        }
        let old = dest.with_file_name(format!("{}{OLD_SUFFIX}", dto.id));
        let _ = fs::remove_file(&old);
        Ok(dto)
    }

    pub fn list_attachments(&self, paper_id: &str) -> Result<Vec<AttachmentDto>, BridgeError> {
        require_safe_segment(paper_id, "paperId")?;
        let conn = self.lock_conn()?;
        if !Self::paper_exists(&conn, paper_id)? {
            return Err(BridgeError::paper_not_found(paper_id));
        }
        let mut stmt = conn
            .prepare(
                "SELECT paper_id, attachment_id, name, content_type, byte_size, sha256, created_at
                 FROM attachments WHERE paper_id = ?1 ORDER BY created_at, attachment_id",
            )
            .map_err(sqlite_error)?;
        let rows = stmt
            .query_map(params![paper_id], |row| {
                Ok(AttachmentDto {
                    paper_id: row.get(0)?,
                    id: row.get(1)?,
                    name: row.get(2)?,
                    content_type: row.get(3)?,
                    size: row.get(4)?,
                    sha256: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(sqlite_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
    }

    pub fn get_attachment(&self, paper_id: &str, attachment_id: &str) -> Result<AttachmentDto, BridgeError> {
        require_safe_segment(paper_id, "paperId")?;
        require_safe_segment(attachment_id, "attachmentId")?;
        let conn = self.lock_conn()?;
        load_attachment(&conn, paper_id, attachment_id)
    }

    pub fn read_range(
        &self,
        paper_id: &str,
        attachment_id: &str,
        offset: u64,
        length: u64,
    ) -> Result<(AttachmentDto, Vec<u8>), BridgeError> {
        let attachment = self.get_attachment(paper_id, attachment_id)?;
        let dest = attachment_path(self.root(), paper_id, attachment_id)?;
        assert_file_present(&dest, &attachment)?;
        if offset > attachment.size as u64 {
            return Err(BridgeError::invalid_input("读取偏移超出附件大小"));
        }
        let available = attachment.size as u64 - offset;
        let take = length.min(available);
        let mut file = File::open(&dest).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut buf = vec![0_u8; take as usize];
        file.read_exact(&mut buf).map_err(io_error)?;
        Ok((attachment, buf))
    }

    pub fn verify_attachment(&self, paper_id: &str, attachment_id: &str) -> Result<AttachmentDto, BridgeError> {
        let attachment = self.get_attachment(paper_id, attachment_id)?;
        let dest = attachment_path(self.root(), paper_id, attachment_id)?;
        verify_file(&dest, &attachment)?;
        Ok(attachment)
    }

    pub fn cleanup_temps(&self) -> Result<u64, BridgeError> {
        let attachments_root = self.root().join("attachments");
        if !attachments_root.exists() {
            return Ok(0);
        }
        let mut removed = 0_u64;
        for entry in fs::read_dir(&attachments_root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if path.is_dir() {
                removed += cleanup_dir_temps(&path)?;
            } else if is_temp_file(&path) {
                fs::remove_file(&path).map_err(io_error)?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn remove_paper_files(&self, paper_id: &str) -> Result<(), BridgeError> {
        if require_safe_segment(paper_id, "paperId").is_err() {
            return Ok(());
        }
        let dir = paper_dir(self.root(), paper_id)?;
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(io_error)?;
        }
        Ok(())
    }
}

fn load_attachment(
    conn: &rusqlite::Connection,
    paper_id: &str,
    attachment_id: &str,
) -> Result<AttachmentDto, BridgeError> {
    conn.query_row(
        "SELECT paper_id, attachment_id, name, content_type, byte_size, sha256, created_at
         FROM attachments WHERE paper_id = ?1 AND attachment_id = ?2",
        params![paper_id, attachment_id],
        |row| {
            Ok(AttachmentDto {
                paper_id: row.get(0)?,
                id: row.get(1)?,
                name: row.get(2)?,
                content_type: row.get(3)?,
                size: row.get(4)?,
                sha256: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(sqlite_error)?
    .ok_or_else(|| BridgeError::attachment_not_found(paper_id, attachment_id))
}

fn assert_file_present(path: &Path, attachment: &AttachmentDto) -> Result<(), BridgeError> {
    if !path.is_file() {
        return Err(BridgeError::integrity_failed(
            &attachment.paper_id,
            &attachment.id,
            "附件文件不存在",
        ));
    }
    let meta = fs::metadata(path).map_err(io_error)?;
    if meta.len() != attachment.size as u64 {
        return Err(BridgeError::integrity_failed(
            &attachment.paper_id,
            &attachment.id,
            "附件大小与记录不一致",
        ));
    }
    Ok(())
}

fn verify_file(path: &Path, attachment: &AttachmentDto) -> Result<(), BridgeError> {
    assert_file_present(path, attachment)?;
    let bytes = fs::read(path).map_err(io_error)?;
    if sha256_hex(&bytes) != attachment.sha256 {
        return Err(BridgeError::integrity_failed(
            &attachment.paper_id,
            &attachment.id,
            "附件完整性校验失败",
        ));
    }
    Ok(())
}

fn is_temp_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(TEMP_SUFFIX) || name.ends_with(OLD_SUFFIX))
}

fn cleanup_dir_temps(dir: &Path) -> Result<u64, BridgeError> {
    let mut removed = 0;
    for entry in fs::read_dir(dir).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if path.is_file() && is_temp_file(&path) {
            fs::remove_file(&path).map_err(io_error)?;
            removed += 1;
        }
    }
    Ok(removed)
}
