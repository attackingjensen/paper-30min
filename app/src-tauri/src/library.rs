//! 本地书库：应用数据根目录、版本化 SQLite 与论文记录 DTO。
//! JavaScript 只看到版本化命令返回的领域 DTO；表结构不是前端契约。

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::error::BridgeError;

pub const DATABASE_VERSION: i32 = 2;
pub const LIBRARY_SCHEMA_VERSION: u32 = 1;

const PARTITIONS: &[&str] = &["database", "attachments", "operations", "exports"];

/// 打开后的书库：一个数据根目录对应一份 SQLite 连接。
/// 写操作经连接互斥锁串行化，同一论文的相关记录在事务中一次提交。
pub struct Library {
    root: PathBuf,
    conn: Mutex<Connection>,
    pub(crate) inspect_tokens: Mutex<HashMap<String, crate::migration::InspectToken>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperSummary {
    pub id: String,
    pub title: String,
    pub source_type: Option<String>,
    pub arxiv_id: Option<String>,
    pub pdf_name: String,
    pub rating: i64,
    pub added_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionDto {
    pub id: String,
    #[serde(default)]
    pub source_text: String,
    #[serde(default)]
    pub page_start: Option<i64>,
    #[serde(default)]
    pub page_end: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartDto {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub semantic_type: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisDto {
    pub section_id: String,
    pub text: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationDto {
    pub section_id: String,
    pub language: String,
    pub text: String,
    #[serde(default)]
    pub source: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecallCardDto {
    #[serde(default)]
    pub markdown: String,
    #[serde(default)]
    pub images: Vec<Value>,
    #[serde(default = "epoch_iso")]
    pub updated_at: String,
}

impl Default for RecallCardDto {
    fn default() -> Self {
        Self {
            markdown: String::new(),
            images: Vec::new(),
            updated_at: epoch_iso(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperDto {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub pdf_name: String,
    #[serde(default)]
    pub num_pages: i64,
    #[serde(default)]
    pub full_text: String,
    #[serde(default)]
    pub rating: i64,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub added_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub sections: Vec<SectionDto>,
    #[serde(default)]
    pub parts: Vec<PartDto>,
    #[serde(default)]
    pub analyses: Vec<AnalysisDto>,
    #[serde(default)]
    pub translations: Vec<TranslationDto>,
    #[serde(default)]
    pub recall_card: RecallCardDto,
    #[serde(default)]
    pub chat: Vec<ChatMessageDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPositionDto {
    pub paper_id: String,
    pub view: String,
    #[serde(default)]
    pub section_id: Option<String>,
    #[serde(default)]
    pub pdf_page: Option<i64>,
    #[serde(default)]
    pub content_version: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub schema_version: u32,
    pub data_root: String,
    pub database_version: i32,
    pub partitions: Vec<String>,
}

fn epoch_iso() -> String {
    "1970-01-01T00:00:00Z".to_string()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| epoch_iso())
}

fn require_iso(field: &str, value: &str) -> Result<(), BridgeError> {
    let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| {
        BridgeError::invalid_input(format!("{field} 必须是 ISO 8601 UTC 日期"))
    })?;
    if parsed.offset() != time::UtcOffset::UTC {
        return Err(BridgeError::invalid_input(format!(
            "{field} 必须是 ISO 8601 UTC 日期"
        )));
    }
    Ok(())
}

fn sqlite_error(err: rusqlite::Error) -> BridgeError {
    BridgeError::internal(format!("书库数据库错误: {err}"))
}

fn io_error(err: std::io::Error) -> BridgeError {
    BridgeError::internal(format!("书库目录错误: {err}"))
}

fn json_text(value: &impl Serialize) -> Result<String, BridgeError> {
    serde_json::to_string(value).map_err(|err| BridgeError::internal(format!("JSON 编码失败: {err}")))
}

fn parse_string_list(text: &str) -> Result<Vec<String>, BridgeError> {
    serde_json::from_str(text).map_err(|err| BridgeError::internal(format!("JSON 解码失败: {err}")))
}

fn parse_images(text: &str) -> Result<Vec<Value>, BridgeError> {
    serde_json::from_str(text).map_err(|err| BridgeError::internal(format!("JSON 解码失败: {err}")))
}

impl Library {
    /// 打开（或首次创建）数据根目录下的版本化 SQLite 书库。
    pub fn open(root: impl AsRef<Path>) -> Result<Self, BridgeError> {
        let root = root.as_ref().to_path_buf();
        for partition in PARTITIONS {
            fs::create_dir_all(root.join(partition)).map_err(io_error)?;
        }
        let db_path = root.join("database").join("library.sqlite");
        let conn = Connection::open(&db_path).map_err(sqlite_error)?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .map_err(sqlite_error)?;
        conn.pragma_update(None, "foreign_keys", true).map_err(sqlite_error)?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(sqlite_error)?;
        migrate(&conn)?;
        let library = Self {
            root,
            conn: Mutex::new(conn),
            inspect_tokens: Mutex::new(HashMap::new()),
        };
        library.cleanup_temps()?;
        Ok(library)
    }

    pub fn info(&self) -> LibraryInfo {
        LibraryInfo {
            schema_version: LIBRARY_SCHEMA_VERSION,
            data_root: self.root.to_string_lossy().into_owned(),
            database_version: DATABASE_VERSION,
            partitions: PARTITIONS.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    pub fn list_papers(&self) -> Result<Vec<PaperSummary>, BridgeError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, source_type, arxiv_id, pdf_name, rating, added_at, updated_at
                 FROM papers ORDER BY added_at DESC, id DESC",
            )
            .map_err(sqlite_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PaperSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    source_type: row.get(2)?,
                    arxiv_id: row.get(3)?,
                    pdf_name: row.get(4)?,
                    rating: row.get(5)?,
                    added_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(sqlite_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
    }

    pub fn get_paper(&self, paper_id: &str) -> Result<PaperDto, BridgeError> {
        let conn = self.lock_conn()?;
        load_paper(&conn, paper_id)
    }

    pub fn put_paper(&self, mut paper: PaperDto) -> Result<PaperDto, BridgeError> {
        normalize_paper(&mut paper)?;
        let paper_id = paper.id.clone();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(sqlite_error)?;
        upsert_paper(&tx, &paper)?;
        tx.commit().map_err(sqlite_error)?;
        load_paper(&conn, &paper_id)
    }

    pub fn delete_paper(&self, paper_id: &str) -> Result<(), BridgeError> {
        let conn = self.lock_conn()?;
        let changed = conn
            .execute("DELETE FROM papers WHERE id = ?1", params![paper_id])
            .map_err(sqlite_error)?;
        if changed == 0 {
            return Err(BridgeError::paper_not_found(paper_id));
        }
        drop(conn);
        self.remove_paper_files(paper_id)?;
        Ok(())
    }

    pub fn get_reading_position(&self, paper_id: &str) -> Result<Option<ReadingPositionDto>, BridgeError> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT paper_id, view, section_id, pdf_page, content_version, updated_at
             FROM reading_positions WHERE paper_id = ?1",
            params![paper_id],
            |row| {
                Ok(ReadingPositionDto {
                    paper_id: row.get(0)?,
                    view: row.get(1)?,
                    section_id: row.get(2)?,
                    pdf_page: row.get(3)?,
                    content_version: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
    }

    pub fn put_reading_position(&self, mut position: ReadingPositionDto) -> Result<ReadingPositionDto, BridgeError> {
        if position.paper_id.trim().is_empty() {
            return Err(BridgeError::invalid_input("阅读位置需要 paperId"));
        }
        if position.view.trim().is_empty() {
            return Err(BridgeError::invalid_input("阅读位置需要 view"));
        }
        if position.updated_at.is_empty() {
            position.updated_at = now_iso();
        } else {
            require_iso("updatedAt", &position.updated_at)?;
        }
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(sqlite_error)?;
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(1) FROM papers WHERE id = ?1",
                params![position.paper_id],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        if exists == 0 {
            return Err(BridgeError::paper_not_found(&position.paper_id));
        }
        tx.execute(
            "INSERT INTO reading_positions(paper_id, view, section_id, pdf_page, content_version, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(paper_id) DO UPDATE SET
               view=excluded.view,
               section_id=excluded.section_id,
               pdf_page=excluded.pdf_page,
               content_version=excluded.content_version,
               updated_at=excluded.updated_at",
            params![
                position.paper_id,
                position.view,
                position.section_id,
                position.pdf_page,
                position.content_version,
                position.updated_at
            ],
        )
        .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)?;
        Ok(position)
    }

    pub fn delete_reading_position(&self, paper_id: &str) -> Result<bool, BridgeError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(sqlite_error)?;
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(1) FROM papers WHERE id = ?1",
                params![paper_id],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        if exists == 0 {
            return Err(BridgeError::paper_not_found(paper_id));
        }
        let changed = tx
            .execute("DELETE FROM reading_positions WHERE paper_id = ?1", params![paper_id])
            .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)?;
        Ok(changed > 0)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, BridgeError> {
        self.conn
            .lock()
            .map_err(|_| BridgeError::internal("书库连接锁定失败"))
    }

    pub(crate) fn paper_exists(conn: &Connection, paper_id: &str) -> Result<bool, BridgeError> {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM papers WHERE id = ?1",
                params![paper_id],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        Ok(count > 0)
    }
}

fn migrate(conn: &Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version > DATABASE_VERSION {
        return Err(BridgeError::schema_unsupported(version, DATABASE_VERSION));
    }
    if version == DATABASE_VERSION {
        return Ok(());
    }
    if version == 0 {
        conn.execute_batch(
        "
        BEGIN;
        CREATE TABLE papers (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source_type TEXT,
          arxiv_id TEXT,
          pdf_name TEXT NOT NULL DEFAULT '',
          num_pages INTEGER NOT NULL DEFAULT 0,
          full_text TEXT NOT NULL DEFAULT '',
          rating INTEGER NOT NULL DEFAULT 0,
          categories_json TEXT NOT NULL DEFAULT '[]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE sections (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL,
          source_text TEXT NOT NULL DEFAULT '',
          page_start INTEGER,
          page_end INTEGER,
          position INTEGER NOT NULL,
          PRIMARY KEY (paper_id, section_id)
        );
        CREATE TABLE reading_parts (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          part_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          sort_order INTEGER NOT NULL,
          title TEXT,
          heading TEXT,
          semantic_type TEXT,
          PRIMARY KEY (paper_id, part_id)
        );
        CREATE TABLE analyses (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL,
          body TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, section_id)
        );
        CREATE TABLE translations (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL,
          language TEXT NOT NULL,
          body TEXT NOT NULL,
          source TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, section_id, language)
        );
        CREATE TABLE recall_cards (
          paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
          markdown TEXT NOT NULL DEFAULT '',
          images_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_messages (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, seq)
        );
        CREATE TABLE reading_positions (
          paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
          view TEXT NOT NULL,
          section_id TEXT,
          pdf_page INTEGER,
          content_version TEXT,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;
        ",
        )
        .map_err(sqlite_error)?;
    }
    migrate_attachments(conn)?;
    Ok(())
}

fn migrate_attachments(conn: &Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version >= 2 {
        return Ok(());
    }
    conn.execute_batch(
        "
        BEGIN;
        CREATE TABLE attachments (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          attachment_id TEXT NOT NULL,
          name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, attachment_id)
        );
        PRAGMA user_version = 2;
        COMMIT;
        ",
    )
    .map_err(sqlite_error)?;
    Ok(())
}

pub(crate) fn normalize_paper(paper: &mut PaperDto) -> Result<(), BridgeError> {
    paper.id = paper.id.trim().to_string();
    paper.title = paper.title.trim().to_string();
    if paper.id.is_empty() {
        return Err(BridgeError::invalid_input("论文需要 id"));
    }
    if paper.title.is_empty() {
        return Err(BridgeError::invalid_input("论文需要 title"));
    }
    if paper.added_at.is_empty() {
        paper.added_at = now_iso();
    } else {
        require_iso("addedAt", &paper.added_at)?;
    }
    if paper.updated_at.is_empty() {
        paper.updated_at = now_iso();
    } else {
        require_iso("updatedAt", &paper.updated_at)?;
    }
    require_unique_ids(
        paper.sections.iter().map(|item| item.id.as_str()),
        "sections.id",
    )?;
    require_unique_ids(paper.parts.iter().map(|item| item.id.as_str()), "parts.id")?;
    require_unique_ids(
        paper.analyses.iter().map(|item| item.section_id.as_str()),
        "analyses.sectionId",
    )?;
    require_unique_ids(
        paper
            .translations
            .iter()
            .map(|item| format!("{}:{}", item.section_id, item.language)),
        "translations.sectionId+language",
    )?;
    for section in &paper.sections {
        if section.id.trim().is_empty() {
            return Err(BridgeError::invalid_input("原文章节需要 id"));
        }
    }
    for part in &paper.parts {
        if part.id.trim().is_empty() {
            return Err(BridgeError::invalid_input("精读部分需要 id"));
        }
    }
    for analysis in &paper.analyses {
        if analysis.section_id.trim().is_empty() {
            return Err(BridgeError::invalid_input("精读结果需要 sectionId"));
        }
        require_iso("analyses.updatedAt", &analysis.updated_at)?;
    }
    for translation in &paper.translations {
        if translation.section_id.trim().is_empty() || translation.language.trim().is_empty() {
            return Err(BridgeError::invalid_input("翻译需要 sectionId 与 language"));
        }
        require_iso("translations.updatedAt", &translation.updated_at)?;
    }
    if paper.recall_card.updated_at.is_empty() {
        paper.recall_card.updated_at = epoch_iso();
    } else {
        require_iso("recallCard.updatedAt", &paper.recall_card.updated_at)?;
    }
    for message in &mut paper.chat {
        if message.role.trim().is_empty() {
            return Err(BridgeError::invalid_input("论文问答需要 role"));
        }
        if message.created_at.is_empty() {
            message.created_at = now_iso();
        } else {
            require_iso("chat.createdAt", &message.created_at)?;
        }
    }
    Ok(())
}

fn require_unique_ids<I, S>(ids: I, field: &str) -> Result<(), BridgeError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = HashSet::new();
    for id in ids {
        let id = id.as_ref();
        if !seen.insert(id.to_string()) {
            return Err(BridgeError::invalid_input(format!("{field} 不能重复: {id}")));
        }
    }
    Ok(())
}

pub(crate) fn upsert_paper(tx: &Transaction, paper: &PaperDto) -> Result<(), BridgeError> {
    tx.execute(
        "INSERT INTO papers(
            id, title, source_type, arxiv_id, pdf_name, num_pages, full_text, rating,
            categories_json, tags_json, added_at, updated_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            source_type=excluded.source_type,
            arxiv_id=excluded.arxiv_id,
            pdf_name=excluded.pdf_name,
            num_pages=excluded.num_pages,
            full_text=excluded.full_text,
            rating=excluded.rating,
            categories_json=excluded.categories_json,
            tags_json=excluded.tags_json,
            added_at=excluded.added_at,
            updated_at=excluded.updated_at",
        params![
            paper.id,
            paper.title,
            paper.source_type,
            paper.arxiv_id,
            paper.pdf_name,
            paper.num_pages,
            paper.full_text,
            paper.rating,
            json_text(&paper.categories)?,
            json_text(&paper.tags)?,
            paper.added_at,
            paper.updated_at
        ],
    )
    .map_err(sqlite_error)?;

    tx.execute("DELETE FROM sections WHERE paper_id = ?1", params![paper.id])
        .map_err(sqlite_error)?;
    tx.execute("DELETE FROM reading_parts WHERE paper_id = ?1", params![paper.id])
        .map_err(sqlite_error)?;
    tx.execute("DELETE FROM analyses WHERE paper_id = ?1", params![paper.id])
        .map_err(sqlite_error)?;
    tx.execute("DELETE FROM translations WHERE paper_id = ?1", params![paper.id])
        .map_err(sqlite_error)?;
    tx.execute("DELETE FROM recall_cards WHERE paper_id = ?1", params![paper.id])
        .map_err(sqlite_error)?;
    tx.execute("DELETE FROM chat_messages WHERE paper_id = ?1", params![paper.id])
        .map_err(sqlite_error)?;

    for (position, section) in paper.sections.iter().enumerate() {
        tx.execute(
            "INSERT INTO sections(paper_id, section_id, source_text, page_start, page_end, position)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                paper.id,
                section.id,
                section.source_text,
                section.page_start,
                section.page_end,
                position as i64
            ],
        )
        .map_err(sqlite_error)?;
    }
    for (position, part) in paper.parts.iter().enumerate() {
        tx.execute(
            "INSERT INTO reading_parts(paper_id, part_id, position, sort_order, title, heading, semantic_type)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                paper.id,
                part.id,
                position as i64,
                part.sort_order,
                part.title,
                part.heading,
                part.semantic_type
            ],
        )
        .map_err(sqlite_error)?;
    }
    for analysis in &paper.analyses {
        tx.execute(
            "INSERT INTO analyses(paper_id, section_id, body, updated_at)
             VALUES(?1, ?2, ?3, ?4)",
            params![paper.id, analysis.section_id, analysis.text, analysis.updated_at],
        )
        .map_err(sqlite_error)?;
    }
    for translation in &paper.translations {
        tx.execute(
            "INSERT INTO translations(paper_id, section_id, language, body, source, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                paper.id,
                translation.section_id,
                translation.language,
                translation.text,
                translation.source,
                translation.updated_at
            ],
        )
        .map_err(sqlite_error)?;
    }
    tx.execute(
        "INSERT INTO recall_cards(paper_id, markdown, images_json, updated_at)
         VALUES(?1, ?2, ?3, ?4)",
        params![
            paper.id,
            paper.recall_card.markdown,
            json_text(&paper.recall_card.images)?,
            paper.recall_card.updated_at
        ],
    )
    .map_err(sqlite_error)?;
    for (seq, message) in paper.chat.iter().enumerate() {
        tx.execute(
            "INSERT INTO chat_messages(paper_id, seq, role, content, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5)",
            params![paper.id, seq as i64, message.role, message.content, message.created_at],
        )
        .map_err(sqlite_error)?;
    }
    Ok(())
}

fn load_paper(conn: &Connection, paper_id: &str) -> Result<PaperDto, BridgeError> {
    let paper = conn
        .query_row(
            "SELECT id, title, source_type, arxiv_id, pdf_name, num_pages, full_text, rating,
                    categories_json, tags_json, added_at, updated_at
             FROM papers WHERE id = ?1",
            params![paper_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?
        .ok_or_else(|| BridgeError::paper_not_found(paper_id))?;

    let categories = parse_string_list(&paper.8)?;
    let tags = parse_string_list(&paper.9)?;

    let mut sections_stmt = conn
        .prepare(
            "SELECT section_id, source_text, page_start, page_end
             FROM sections WHERE paper_id = ?1 ORDER BY position, section_id",
        )
        .map_err(sqlite_error)?;
    let sections = sections_stmt
        .query_map(params![paper_id], |row| {
            Ok(SectionDto {
                id: row.get(0)?,
                source_text: row.get(1)?,
                page_start: row.get(2)?,
                page_end: row.get(3)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut parts_stmt = conn
        .prepare(
            "SELECT part_id, title, heading, semantic_type, sort_order
             FROM reading_parts WHERE paper_id = ?1 ORDER BY position, part_id",
        )
        .map_err(sqlite_error)?;
    let parts = parts_stmt
        .query_map(params![paper_id], |row| {
            Ok(PartDto {
                id: row.get(0)?,
                title: row.get(1)?,
                heading: row.get(2)?,
                semantic_type: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut analyses_stmt = conn
        .prepare(
            "SELECT section_id, body, updated_at FROM analyses WHERE paper_id = ?1 ORDER BY section_id",
        )
        .map_err(sqlite_error)?;
    let analyses = analyses_stmt
        .query_map(params![paper_id], |row| {
            Ok(AnalysisDto {
                section_id: row.get(0)?,
                text: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut translations_stmt = conn
        .prepare(
            "SELECT section_id, language, body, source, updated_at
             FROM translations WHERE paper_id = ?1 ORDER BY section_id, language",
        )
        .map_err(sqlite_error)?;
    let translations = translations_stmt
        .query_map(params![paper_id], |row| {
            Ok(TranslationDto {
                section_id: row.get(0)?,
                language: row.get(1)?,
                text: row.get(2)?,
                source: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let recall_card = conn
        .query_row(
            "SELECT markdown, images_json, updated_at FROM recall_cards WHERE paper_id = ?1",
            params![paper_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?
        .map(|(markdown, images_json, updated_at)| {
            Ok(RecallCardDto {
                markdown,
                images: parse_images(&images_json)?,
                updated_at,
            })
        })
        .transpose()?
        .unwrap_or_default();

    let mut chat_stmt = conn
        .prepare(
            "SELECT role, content, created_at FROM chat_messages WHERE paper_id = ?1 ORDER BY seq",
        )
        .map_err(sqlite_error)?;
    let chat = chat_stmt
        .query_map(params![paper_id], |row| {
            Ok(ChatMessageDto {
                role: row.get(0)?,
                content: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    Ok(PaperDto {
        id: paper.0,
        title: paper.1,
        source_type: paper.2,
        arxiv_id: paper.3,
        pdf_name: paper.4,
        num_pages: paper.5,
        full_text: paper.6,
        rating: paper.7,
        categories,
        tags,
        added_at: paper.10,
        updated_at: paper.11,
        sections,
        parts,
        analyses,
        translations,
        recall_card,
        chat,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unsupported_schema_version_is_not_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let db_dir = dir.path().join("database");
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("library.sqlite")).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        drop(conn);
        let error = match Library::open(dir.path()) {
            Ok(_) => panic!("应拒绝不支持的数据库版本"),
            Err(error) => error,
        };
        assert_eq!(error.code, "schema_unsupported");
        assert!(!error.retryable);
        assert_eq!(error.details.unwrap()["found"], json!(99));
    }
}
