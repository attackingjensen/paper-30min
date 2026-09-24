//! 本地书库：应用数据根目录、版本化 SQLite 与论文记录 DTO。
//! JavaScript 只看到版本化命令返回的领域 DTO；表结构不是前端契约。

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use time::format_description::well_known::{Iso8601, Rfc3339};
use time::OffsetDateTime;

use crate::error::BridgeError;

pub const DATABASE_VERSION: i32 = 7;
pub const LIBRARY_SCHEMA_VERSION: u32 = 1;

/// activity_days.kind 的合法取值：导入论文 / 精读结果 / 中断保留的部分结果 / 设置已读完标记。
/// 建图产物、论文问答、翻译与回想卡片编辑不算阅读活动，不进表。
pub(crate) const ACTIVITY_DAY_KINDS: &[&str] = &["import", "analysis", "partial", "mark"];

/// protocol_products.kind 的合法取值：阅读地图 / 节薄摘要 / 深挖结果 / 复述稿（规格 #55 决策 21）。
pub(crate) const PRODUCT_KINDS: &[&str] = &["map", "l2", "dig", "retell"];

/// chat_messages.binding_kind 的合法取值：无绑定（全文提问）/ @节 / 选中片段（规格 #52 决策 1）。
pub(crate) const BINDING_KINDS: &[&str] = &["none", "section", "fragment"];

fn default_binding_kind() -> String {
    "none".to_string()
}

/// 该 kind 是否为论文级产物（map/retell）。论文级产物 part_id 用空串约定；
/// 节级产物（l2/dig）的 part_id 必须是精读部分 id。
pub(crate) fn is_paper_level_product(kind: &str) -> bool {
    matches!(kind, "map" | "retell")
}

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

/// 绑定提问的块区间出处：起止节与块号，可选页码（规格 #52 决策 1；跨节记起止两段）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatCiteDto {
    pub start_sec_id: String,
    pub start_block: i64,
    pub end_sec_id: String,
    pub end_block: i64,
    #[serde(default)]
    pub start_page: Option<i64>,
    #[serde(default)]
    pub end_page: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default = "default_binding_kind")]
    pub binding_kind: String,
    #[serde(default)]
    pub sec_id: Option<String>,
    #[serde(default)]
    pub fragment_text: Option<String>,
    #[serde(default)]
    pub cite: Option<ChatCiteDto>,
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

/// 已读完标记：用户对单个精读部分的手动完成记录，可撤销（撤销 = 快照少一行）。
/// part_id 沿用精读部分身份（abstract + part-N），不依赖 reading_parts 行存在。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadMarkDto {
    pub part_id: String,
    pub marked_at: String,
}

/// 活动日：某个 UTC 日历日（YYYY-MM-DD）在某篇论文上发生过一类阅读活动。
/// append-only：只插入、不更新，除随论文级联删除外不删除。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDayDto {
    pub day: String,
    pub kind: String,
}

/// 协议产物：建图/深挖/综合三阶段协议的持久化成果（规格 #55 决策 21）。
/// part_id 为精读部分 id；论文级产物（map/retell）用空串约定。body 是 JSON 值：
/// map/l2 为结构对象（字段级契约见规格 #55 决策 16-17），dig/retell 为 Markdown 字符串。
/// 撤销/重做不留版本——重跑覆盖即快照重写后少一行或换一行。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProductDto {
    pub kind: String,
    #[serde(default)]
    pub part_id: String,
    pub body: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    pub read_marks: Vec<ReadMarkDto>,
    #[serde(default)]
    pub activity_days: Vec<ActivityDayDto>,
    #[serde(default)]
    pub products: Vec<ProductDto>,
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
    let parsed = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| BridgeError::invalid_input(format!("{field} 必须是 ISO 8601 UTC 日期")))?;
    if parsed.offset() != time::UtcOffset::UTC {
        return Err(BridgeError::invalid_input(format!(
            "{field} 必须是 ISO 8601 UTC 日期"
        )));
    }
    Ok(())
}

/// activity_days.day 是否合法的 YYYY-MM-DD 日历日。
pub(crate) fn is_valid_day(value: &str) -> bool {
    time::Date::parse(value, &Iso8601::DATE).is_ok()
}

fn require_day(field: &str, value: &str) -> Result<(), BridgeError> {
    if !is_valid_day(value) {
        return Err(BridgeError::invalid_input(format!(
            "{field} 必须是 YYYY-MM-DD 日历日"
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
    serde_json::to_string(value)
        .map_err(|err| BridgeError::internal(format!("JSON 编码失败: {err}")))
}

fn parse_string_list(text: &str) -> Result<Vec<String>, BridgeError> {
    serde_json::from_str(text).map_err(|err| BridgeError::internal(format!("JSON 解码失败: {err}")))
}

fn parse_cite_json(text: Option<String>) -> Result<Option<ChatCiteDto>, BridgeError> {
    let Some(text) = text.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|err| BridgeError::internal(format!("chat.cite JSON 解码失败: {err}")))
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
        let mut conn = Connection::open(&db_path).map_err(sqlite_error)?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))
            .map_err(sqlite_error)?;
        conn.pragma_update(None, "foreign_keys", true)
            .map_err(sqlite_error)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(sqlite_error)?;
        migrate(&mut conn)?;
        let library = Self {
            root,
            conn: Mutex::new(conn),
            inspect_tokens: Mutex::new(HashMap::new()),
        };
        if let Err(error) = library.retry_pending_file_cleanup() {
            eprintln!("附件清理重试失败: {error}");
        }
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
        let cleanup_pending: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_file_cleanup WHERE paper_id = ?1)",
                params![paper_id],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        if cleanup_pending {
            self.remove_paper_files(&paper_id)?;
        }
        let tx = conn.transaction().map_err(sqlite_error)?;
        tx.execute(
            "DELETE FROM pending_file_cleanup WHERE paper_id = ?1",
            params![paper_id],
        )
        .map_err(sqlite_error)?;
        upsert_paper(&tx, &paper)?;
        tx.commit().map_err(sqlite_error)?;
        load_paper(&conn, &paper_id)
    }

    pub fn delete_paper(&self, paper_id: &str) -> Result<bool, BridgeError> {
        self.delete_paper_with_cleanup(paper_id, |id| self.remove_paper_files(id))
    }

    fn delete_paper_with_cleanup(
        &self,
        paper_id: &str,
        cleanup: impl FnOnce(&str) -> Result<(), BridgeError>,
    ) -> Result<bool, BridgeError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(sqlite_error)?;
        let changed = tx
            .execute("DELETE FROM papers WHERE id = ?1", params![paper_id])
            .map_err(sqlite_error)?;
        if changed == 0 {
            return Err(BridgeError::paper_not_found(paper_id));
        }
        tx.execute(
            "INSERT OR IGNORE INTO pending_file_cleanup (paper_id) VALUES (?1)",
            params![paper_id],
        )
        .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)?;
        if let Err(error) = cleanup(paper_id) {
            eprintln!("论文 {paper_id} 的附件待下次启动清理: {error}");
            return Ok(true);
        }
        if let Err(error) = conn.execute(
            "DELETE FROM pending_file_cleanup WHERE paper_id = ?1",
            params![paper_id],
        ) {
            eprintln!("论文 {paper_id} 附件已清理，但清理标记未移除: {error}");
            return Ok(true);
        }
        Ok(false)
    }

    fn retry_pending_file_cleanup(&self) -> Result<(), BridgeError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT paper_id FROM pending_file_cleanup")
            .map_err(sqlite_error)?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        drop(stmt);
        for id in ids {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM papers WHERE id = ?1)",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(sqlite_error)?;
            if !exists {
                if let Err(error) = self.remove_paper_files(&id) {
                    eprintln!("论文 {id} 的附件清理重试失败: {error}");
                    continue;
                }
            }
            conn.execute(
                "DELETE FROM pending_file_cleanup WHERE paper_id = ?1",
                params![id],
            )
            .map_err(sqlite_error)?;
        }
        Ok(())
    }

    #[cfg(test)]
    fn pending_file_cleanup_count(&self) -> Result<i64, BridgeError> {
        self.lock_conn()?
            .query_row("SELECT COUNT(*) FROM pending_file_cleanup", [], |row| {
                row.get(0)
            })
            .map_err(sqlite_error)
    }

    pub fn get_reading_position(
        &self,
        paper_id: &str,
    ) -> Result<Option<ReadingPositionDto>, BridgeError> {
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

    pub fn put_reading_position(
        &self,
        mut position: ReadingPositionDto,
    ) -> Result<ReadingPositionDto, BridgeError> {
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
            .execute(
                "DELETE FROM reading_positions WHERE paper_id = ?1",
                params![paper_id],
            )
            .map_err(sqlite_error)?;
        tx.commit().map_err(sqlite_error)?;
        Ok(changed > 0)
    }

    /// 读取应用设置值；未写入过返回 None。设置不进论文/导出 DTO。
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, BridgeError> {
        if key.trim().is_empty() {
            return Err(BridgeError::invalid_input("设置需要非空 key"));
        }
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)
    }

    /// 写入应用设置值，重复写入覆盖同 key 的旧值。
    pub fn put_setting(&self, key: &str, value: &str) -> Result<(), BridgeError> {
        if key.trim().is_empty() {
            return Err(BridgeError::invalid_input("设置需要非空 key"));
        }
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(sqlite_error)?;
        Ok(())
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

fn migrate(conn: &mut Connection) -> Result<(), BridgeError> {
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
    migrate_settings(conn)?;
    migrate_read_marks(conn)?;
    migrate_protocol_products(conn)?;
    migrate_chat_bindings(conn)?;
    migrate_pending_file_cleanup(conn)?;
    Ok(())
}

fn migrate_pending_file_cleanup(conn: &mut Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version >= 7 {
        return Ok(());
    }
    let tx = conn.transaction().map_err(sqlite_error)?;
    tx.execute_batch("CREATE TABLE pending_file_cleanup (paper_id TEXT PRIMARY KEY);")
        .map_err(sqlite_error)?;
    tx.pragma_update(None, "user_version", 7)
        .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
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

/// v3：应用设置键值表。设置（含 API Key）只进这张表，不进任何论文/导出 DTO。
fn migrate_settings(conn: &Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version >= 3 {
        return Ok(());
    }
    conn.execute_batch(
        "
        BEGIN;
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        PRAGMA user_version = 3;
        COMMIT;
        ",
    )
    .map_err(sqlite_error)?;
    Ok(())
}

/// v4 迁移的回填判据常量：中断保留的部分结果在正文末尾追加的警示后缀。
/// 这是运行时 JS 常量（ui/js/generation.js PARTIAL_MARKER）的历史快照，按规格 #51 决策 12
/// 写死于此——运行时常量日后改动不影响本迁移对历史数据的判据。
const V4_PARTIAL_MARKER_SNAPSHOT: &str = "\n\n> ⚠️ 生成被中断，内容为部分结果。";

/// 取 RFC3339 时间戳的 UTC 日历日（YYYY-MM-DD）。库内时间戳必须可解析；
/// 无法解析即迁移失败（全有或全无，不引入降级路径）。
fn iso_day(value: &str) -> Result<String, BridgeError> {
    let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| {
        BridgeError::internal(format!("schema v4 迁移遇到无法解析的时间戳: {value}"))
    })?;
    Ok(parsed.to_offset(time::UtcOffset::UTC).date().to_string())
}

fn insert_activity_day(
    tx: &Transaction,
    day: &str,
    paper_id: &str,
    kind: &str,
) -> Result<(), BridgeError> {
    tx.execute(
        "INSERT OR IGNORE INTO activity_days(day, paper_id, kind) VALUES(?1, ?2, ?3)",
        params![day, paper_id, kind],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

/// v4：已读完标记与 append-only 活动日表，并按快照判据从既有数据回填（规格 #51 §迁移）：
/// - analyses 行存在且正文不以警示后缀结尾 → 回填 read_marks，marked_at 取该结果 updated_at；
///   中断保留的部分结果不迁移为已读完；
/// - 活动日回填：论文 added_at → import 日；各 analyses.updated_at → analysis/partial 日
///  （同一判据）；迁移新建标记的 marked_at → mark 日；
/// - day 取事件时间戳的 UTC 日历日；整个迁移在单事务内完成，失败整体回滚并拒绝启动。
fn migrate_read_marks(conn: &mut Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version >= 4 {
        return Ok(());
    }
    let tx = conn.transaction().map_err(sqlite_error)?;
    tx.execute_batch(
        "
        CREATE TABLE read_marks (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          part_id TEXT NOT NULL,
          marked_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, part_id)
        );
        CREATE TABLE activity_days (
          day TEXT NOT NULL,
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          PRIMARY KEY (day, paper_id, kind)
        );
        ",
    )
    .map_err(sqlite_error)?;

    // import 日：论文 added_at。查询先整体收进 Vec 再写入，避免语句借用与写入冲突。
    let papers = {
        let mut stmt = tx
            .prepare("SELECT id, added_at FROM papers")
            .map_err(sqlite_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    };
    for (paper_id, added_at) in &papers {
        insert_activity_day(&tx, &iso_day(added_at)?, paper_id, "import")?;
    }

    // analysis/partial 日 + read_marks 回填 + 迁移新建标记的 mark 日。
    let analyses = {
        let mut stmt = tx
            .prepare("SELECT paper_id, section_id, body, updated_at FROM analyses")
            .map_err(sqlite_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    };
    for (paper_id, section_id, body, updated_at) in &analyses {
        let partial = body.ends_with(V4_PARTIAL_MARKER_SNAPSHOT);
        let day = iso_day(updated_at)?;
        insert_activity_day(
            &tx,
            &day,
            paper_id,
            if partial { "partial" } else { "analysis" },
        )?;
        if !partial {
            tx.execute(
                "INSERT INTO read_marks(paper_id, part_id, marked_at) VALUES(?1, ?2, ?3)",
                params![paper_id, section_id, updated_at],
            )
            .map_err(sqlite_error)?;
            insert_activity_day(&tx, &day, paper_id, "mark")?;
        }
    }

    tx.pragma_update(None, "user_version", 4)
        .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

/// v5：协议产物表（规格 #55 决策 21）。新表无历史数据回填——三阶段协议的产物由后续
/// 任务产生。part_id 空串约定：论文级产物（map/retell）的 part_id 为 ''，使其能参与
/// 主键。建表在单事务内完成，失败整体回滚并拒绝启动（沿用 v1–v4 纪律）。
fn migrate_protocol_products(conn: &mut Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version >= 5 {
        return Ok(());
    }
    let tx = conn.transaction().map_err(sqlite_error)?;
    tx.execute_batch(
        "
        CREATE TABLE protocol_products (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          part_id TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, kind, part_id)
        );
        ",
    )
    .map_err(sqlite_error)?;
    tx.pragma_update(None, "user_version", 5)
        .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

/// v6：chat_messages 增绑定列（规格 #52 决策 1–2）。ALTER 带 DEFAULT 使旧行回填
/// binding_kind=none、asset_ids 空列表；sec_id/fragment_text/cite 可空。一次版本跃迁，
/// 单事务失败整体回滚并拒绝启动。v4/v5 已合入主线，本票不再合并进既有迁移。
fn migrate_chat_bindings(conn: &mut Connection) -> Result<(), BridgeError> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if version >= 6 {
        return Ok(());
    }
    let tx = conn.transaction().map_err(sqlite_error)?;
    tx.execute_batch(
        "
        ALTER TABLE chat_messages ADD COLUMN binding_kind TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE chat_messages ADD COLUMN sec_id TEXT;
        ALTER TABLE chat_messages ADD COLUMN fragment_text TEXT;
        ALTER TABLE chat_messages ADD COLUMN cite_json TEXT;
        ALTER TABLE chat_messages ADD COLUMN asset_ids_json TEXT NOT NULL DEFAULT '[]';
        ",
    )
    .map_err(sqlite_error)?;
    tx.pragma_update(None, "user_version", 6)
        .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
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
        normalize_chat_binding(message)?;
    }
    require_unique_ids(
        paper.read_marks.iter().map(|item| item.part_id.as_str()),
        "readMarks.partId",
    )?;
    require_unique_ids(
        paper
            .activity_days
            .iter()
            .map(|item| format!("{}:{}", item.day, item.kind)),
        "activityDays.day+kind",
    )?;
    for mark in &paper.read_marks {
        if mark.part_id.trim().is_empty() {
            return Err(BridgeError::invalid_input("已读完标记需要 partId"));
        }
        require_iso("readMarks.markedAt", &mark.marked_at)?;
    }
    for entry in &paper.activity_days {
        require_day("activityDays.day", &entry.day)?;
        if !ACTIVITY_DAY_KINDS.contains(&entry.kind.as_str()) {
            return Err(BridgeError::invalid_input(format!(
                "activityDays.kind 未知: {}",
                entry.kind
            )));
        }
    }
    require_unique_ids(
        paper
            .products
            .iter()
            .map(|item| format!("{}:{}", item.kind, item.part_id)),
        "products.kind+partId",
    )?;
    for product in &paper.products {
        if !PRODUCT_KINDS.contains(&product.kind.as_str()) {
            return Err(BridgeError::invalid_input(format!(
                "products.kind 未知: {}",
                product.kind
            )));
        }
        if is_paper_level_product(&product.kind) {
            if !product.part_id.is_empty() {
                return Err(BridgeError::invalid_input(
                    "products.partId 空值约定：map/retell 是论文级产物，partId 必须为空",
                ));
            }
        } else if product.part_id.trim().is_empty() {
            return Err(BridgeError::invalid_input(format!(
                "products.partId：{} 产物需要精读部分 id",
                product.kind
            )));
        }
        if product.body.is_null() {
            return Err(BridgeError::invalid_input("products.body 不能为空值"));
        }
        require_iso("products.updatedAt", &product.updated_at)?;
    }
    Ok(())
}

fn blank_to_none(value: &mut Option<String>) {
    if let Some(text) = value {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            *value = None;
        } else if trimmed != text.as_str() {
            *value = Some(trimmed.to_string());
        }
    }
}

fn clear_chat_binding(message: &mut ChatMessageDto) {
    message.binding_kind = default_binding_kind();
    message.sec_id = None;
    message.fragment_text = None;
    message.cite = None;
    message.asset_ids.clear();
}

fn normalize_chat_binding(message: &mut ChatMessageDto) -> Result<(), BridgeError> {
    message.binding_kind = message.binding_kind.trim().to_string();
    if message.binding_kind.is_empty() {
        message.binding_kind = default_binding_kind();
    }
    blank_to_none(&mut message.sec_id);
    blank_to_none(&mut message.fragment_text);
    message.asset_ids.retain(|id| !id.trim().is_empty());
    for id in &mut message.asset_ids {
        *id = id.trim().to_string();
    }
    if message.role == "assistant" {
        // assistant 消息恒 none（规格 #52 决策 1）：多带的绑定字段清掉，不拒绝整篇写入。
        clear_chat_binding(message);
        return Ok(());
    }
    if !BINDING_KINDS.contains(&message.binding_kind.as_str()) {
        return Err(BridgeError::invalid_input(format!(
            "chat.bindingKind 未知: {}",
            message.binding_kind
        )));
    }
    if message.binding_kind == "none" {
        message.sec_id = None;
        message.fragment_text = None;
        message.cite = None;
        message.asset_ids.clear();
    } else if message.binding_kind == "section" {
        if message.sec_id.is_none() {
            return Err(BridgeError::invalid_input("chat.secId：@节绑定需要节 id"));
        }
        message.fragment_text = None;
    } else if message.fragment_text.is_none() {
        return Err(BridgeError::invalid_input(
            "chat.fragmentText：片段绑定需要选中原文",
        ));
    }
    if let Some(cite) = &message.cite {
        if cite.start_sec_id.trim().is_empty() || cite.end_sec_id.trim().is_empty() {
            return Err(BridgeError::invalid_input("chat.cite 需要起止节 id"));
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
            return Err(BridgeError::invalid_input(format!(
                "{field} 不能重复: {id}"
            )));
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

    tx.execute(
        "DELETE FROM sections WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM reading_parts WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM analyses WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM translations WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM recall_cards WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM chat_messages WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    // read_marks 按 DTO 快照整组重写：撤销 = 快照少一行。
    tx.execute(
        "DELETE FROM read_marks WHERE paper_id = ?1",
        params![paper.id],
    )
    .map_err(sqlite_error)?;
    // activity_days 是 append-only：不按快照重写、不删除，DTO 未携带的历史行不受影响。
    // protocol_products 按 DTO 快照整组重写：重跑覆盖 = 快照换一行，撤销/重做不留版本。
    tx.execute(
        "DELETE FROM protocol_products WHERE paper_id = ?1",
        params![paper.id],
    )
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
            params![
                paper.id,
                analysis.section_id,
                analysis.text,
                analysis.updated_at
            ],
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
        let cite_json = match &message.cite {
            Some(cite) => Some(json_text(cite)?),
            None => None,
        };
        tx.execute(
            "INSERT INTO chat_messages(
                paper_id, seq, role, content, created_at,
                binding_kind, sec_id, fragment_text, cite_json, asset_ids_json
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                paper.id,
                seq as i64,
                message.role,
                message.content,
                message.created_at,
                message.binding_kind,
                message.sec_id,
                message.fragment_text,
                cite_json,
                json_text(&message.asset_ids)?
            ],
        )
        .map_err(sqlite_error)?;
    }
    for mark in &paper.read_marks {
        tx.execute(
            "INSERT INTO read_marks(paper_id, part_id, marked_at) VALUES(?1, ?2, ?3)",
            params![paper.id, mark.part_id, mark.marked_at],
        )
        .map_err(sqlite_error)?;
    }
    for entry in &paper.activity_days {
        insert_activity_day(tx, &entry.day, &paper.id, &entry.kind)?;
    }
    for product in &paper.products {
        tx.execute(
            "INSERT INTO protocol_products(paper_id, kind, part_id, body, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5)",
            params![
                paper.id,
                product.kind,
                product.part_id,
                json_text(&product.body)?,
                product.updated_at
            ],
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
            "SELECT role, content, created_at, binding_kind, sec_id, fragment_text, cite_json, asset_ids_json
             FROM chat_messages WHERE paper_id = ?1 ORDER BY seq",
        )
        .map_err(sqlite_error)?;
    let chat = chat_stmt
        .query_map(params![paper_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?
        .into_iter()
        .map(
            |(
                role,
                content,
                created_at,
                binding_kind,
                sec_id,
                fragment_text,
                cite_json,
                asset_ids_json,
            )| {
                Ok(ChatMessageDto {
                    role,
                    content,
                    created_at,
                    binding_kind,
                    sec_id,
                    fragment_text,
                    cite: parse_cite_json(cite_json)?,
                    asset_ids: parse_string_list(&asset_ids_json)?,
                })
            },
        )
        .collect::<Result<Vec<_>, BridgeError>>()?;

    let mut marks_stmt = conn
        .prepare("SELECT part_id, marked_at FROM read_marks WHERE paper_id = ?1 ORDER BY part_id")
        .map_err(sqlite_error)?;
    let read_marks = marks_stmt
        .query_map(params![paper_id], |row| {
            Ok(ReadMarkDto {
                part_id: row.get(0)?,
                marked_at: row.get(1)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut days_stmt = conn
        .prepare("SELECT day, kind FROM activity_days WHERE paper_id = ?1 ORDER BY day, kind")
        .map_err(sqlite_error)?;
    let activity_days = days_stmt
        .query_map(params![paper_id], |row| {
            Ok(ActivityDayDto {
                day: row.get(0)?,
                kind: row.get(1)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;

    let mut products_stmt = conn
        .prepare(
            "SELECT kind, part_id, body, updated_at
             FROM protocol_products WHERE paper_id = ?1 ORDER BY kind, part_id",
        )
        .map_err(sqlite_error)?;
    let products = products_stmt
        .query_map(params![paper_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?
        .into_iter()
        .map(|(kind, part_id, body, updated_at)| {
            Ok(ProductDto {
                kind,
                part_id,
                body: serde_json::from_str(&body)
                    .map_err(|err| BridgeError::internal(format!("JSON 解码失败: {err}")))?,
                updated_at,
            })
        })
        .collect::<Result<Vec<_>, BridgeError>>()?;

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
        read_marks,
        activity_days,
        products,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_file_cleanup_keeps_retry_after_record_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let paper = PaperDto {
            id: "paper-1".into(),
            title: "Paper".into(),
            ..PaperDto::default()
        };
        library.put_paper(paper).unwrap();
        let attachment_dir = dir.path().join("attachments").join("paper-1");
        fs::create_dir_all(&attachment_dir).unwrap();
        fs::write(attachment_dir.join("pdf"), b"pdf").unwrap();
        fs::write(attachment_dir.join("pdf.old"), b"old").unwrap();

        let pending = library
            .delete_paper_with_cleanup("paper-1", |_| Err(BridgeError::internal("附件占用")))
            .unwrap();
        assert!(pending);
        assert!(library.get_paper("paper-1").is_err());
        assert!(attachment_dir.exists());
        library.cleanup_temps().unwrap();
        drop(library);

        let reopened = Library::open(dir.path()).unwrap();
        assert!(!attachment_dir.exists());
        assert_eq!(reopened.pending_file_cleanup_count().unwrap(), 0);
    }

    #[test]
    fn reusing_deleted_id_clears_old_files_before_new_record() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(dir.path()).unwrap();
        let paper = PaperDto {
            id: "paper-1".into(),
            title: "Old".into(),
            ..PaperDto::default()
        };
        library.put_paper(paper.clone()).unwrap();
        let attachment_dir = dir.path().join("attachments").join("paper-1");
        fs::create_dir_all(&attachment_dir).unwrap();
        fs::write(attachment_dir.join("old-pdf"), b"old").unwrap();
        assert!(library
            .delete_paper_with_cleanup("paper-1", |_| Err(BridgeError::internal("busy")))
            .unwrap());
        library
            .put_paper(PaperDto {
                title: "New".into(),
                ..paper
            })
            .unwrap();
        assert!(!attachment_dir.exists());
        assert_eq!(library.pending_file_cleanup_count().unwrap(), 0);
        assert_eq!(library.get_paper("paper-1").unwrap().title, "New");
    }

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
