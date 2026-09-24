//! schema v4 迁移契约：预置 v3 库快照（冻结 DDL + 三类论文夹具：正常结果 / 带警示后缀的
//! 中断部分结果 / 无结果），打开即迁移，断言 read_marks 与 activity_days 的回填内容、
//! 中断负例不产生标记、事务失败整体回滚并拒绝启动（规格 #51 §迁移）。
//! 回填结果一律经 `library.*@1` DTO 黑盒观察；仅回滚断言用只读连接核对 user_version。

use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// 冻结的 v3 快照 DDL：刻意不复用 library.rs 的迁移 SQL——快照必须钉住迁移发生前的
/// 表结构，library.rs 的 DDL 日后演进不影响本夹具。
const V3_SCHEMA: &str = "
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
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
PRAGMA user_version = 3;
";

/// 与 v4 迁移判据常量对应的历史警示后缀（生成中断保留的部分结果）。
const PARTIAL_MARKER: &str = "\n\n> ⚠️ 生成被中断，内容为部分结果。";

fn insert_paper(conn: &Connection, id: &str, title: &str, added_at: &str) {
    conn.execute(
        "INSERT INTO papers(id, title, added_at, updated_at) VALUES(?1, ?2, ?3, ?3)",
        rusqlite::params![id, title, added_at],
    )
    .expect("插入夹具论文");
}

fn insert_analysis(
    conn: &Connection,
    paper_id: &str,
    section_id: &str,
    body: &str,
    updated_at: &str,
) {
    conn.execute(
        "INSERT INTO analyses(paper_id, section_id, body, updated_at) VALUES(?1, ?2, ?3, ?4)",
        rusqlite::params![paper_id, section_id, body, updated_at],
    )
    .expect("插入夹具精读结果");
}

/// 在 dir 下预置 v3 快照库：正常结果（paper-normal）、中断部分结果（paper-partial）、
/// 无结果（paper-empty）三类论文。paper-normal 另含同日两条结果，验证活动日按主键去重。
fn create_v3_fixture(dir: &Path) {
    let db_dir = dir.join("database");
    std::fs::create_dir_all(&db_dir).expect("创建 database 分区");
    let conn = Connection::open(db_dir.join("library.sqlite")).expect("打开夹具库");
    conn.execute_batch(V3_SCHEMA).expect("写入 v3 快照结构");

    insert_paper(&conn, "paper-normal", "正常结果", "2026-08-01T08:00:00Z");
    insert_analysis(
        &conn,
        "paper-normal",
        "abstract",
        "摘要精读结果",
        "2026-08-02T09:00:00Z",
    );
    insert_analysis(
        &conn,
        "paper-normal",
        "part-1",
        "第一节精读结果",
        "2026-08-03T09:00:00Z",
    );
    insert_analysis(
        &conn,
        "paper-normal",
        "part-2",
        "同日第二节精读结果",
        "2026-08-03T18:30:00Z",
    );

    insert_paper(
        &conn,
        "paper-partial",
        "中断部分结果",
        "2026-08-05T08:00:00Z",
    );
    let partial_body = format!("已生成的前半部分内容{PARTIAL_MARKER}");
    insert_analysis(
        &conn,
        "paper-partial",
        "abstract",
        &partial_body,
        "2026-08-06T10:00:00Z",
    );
    insert_analysis(
        &conn,
        "paper-partial",
        "part-1",
        "完整精读结果",
        "2026-08-07T10:00:00Z",
    );

    insert_paper(&conn, "paper-empty", "无结果", "2026-08-10T08:00:00Z");
}

fn open_migrated(dir: &Path) -> (Arc<TaskRegistry>, Arc<Library>) {
    let library = Arc::new(Library::open(dir).expect("v3 快照应成功迁移到最新版本"));
    (TaskRegistry::new(Arc::clone(&library)), library)
}

fn get_paper(registry: &Arc<TaskRegistry>, library: &Arc<Library>, paper_id: &str) -> Value {
    bridge::invoke(
        registry,
        library,
        "library.getPaper@1",
        &json!({ "paperId": paper_id }),
    )
    .expect("library.getPaper@1")
}

#[test]
fn v3_snapshot_migrates_read_marks_by_snapshot_criterion() {
    let dir = tempfile::tempdir().unwrap();
    create_v3_fixture(dir.path());
    let (registry, library) = open_migrated(dir.path());

    let info = bridge::invoke(&registry, &library, "library.info@1", &json!({})).unwrap();
    // v3 快照经 v4 回填后继续顺延到最新版本（当前 v6：问答绑定列）。
    assert_eq!(info["databaseVersion"], json!(7));

    // 正常结果：每个 analyses 行各产生一条标记，marked_at 取该结果 updated_at。
    let normal = get_paper(&registry, &library, "paper-normal");
    assert_eq!(
        normal["paper"]["readMarks"],
        json!([
            { "partId": "abstract", "markedAt": "2026-08-02T09:00:00Z" },
            { "partId": "part-1", "markedAt": "2026-08-03T09:00:00Z" },
            { "partId": "part-2", "markedAt": "2026-08-03T18:30:00Z" }
        ])
    );

    // 中断负例：带警示后缀的部分结果不迁移为已读完；同日完整结果正常迁移。
    let partial = get_paper(&registry, &library, "paper-partial");
    assert_eq!(
        partial["paper"]["readMarks"],
        json!([{ "partId": "part-1", "markedAt": "2026-08-07T10:00:00Z" }])
    );

    // 无结果：没有任何标记。
    let empty = get_paper(&registry, &library, "paper-empty");
    assert_eq!(empty["paper"]["readMarks"], json!([]));
}

#[test]
fn v3_snapshot_migrates_activity_days_from_added_at_and_results() {
    let dir = tempfile::tempdir().unwrap();
    create_v3_fixture(dir.path());
    let (registry, library) = open_migrated(dir.path());

    // import 日取 addedAt；analysis 日按主键去重（part-1 与 part-2 同日只留一行）；
    // 迁移新建标记的 marked_at 产生 mark 日。
    let normal = get_paper(&registry, &library, "paper-normal");
    assert_eq!(
        normal["paper"]["activityDays"],
        json!([
            { "day": "2026-08-01", "kind": "import" },
            { "day": "2026-08-02", "kind": "analysis" },
            { "day": "2026-08-02", "kind": "mark" },
            { "day": "2026-08-03", "kind": "analysis" },
            { "day": "2026-08-03", "kind": "mark" }
        ])
    );

    // 中断部分结果记 partial 日而非 analysis 日，且不产生 mark 日。
    let partial = get_paper(&registry, &library, "paper-partial");
    assert_eq!(
        partial["paper"]["activityDays"],
        json!([
            { "day": "2026-08-05", "kind": "import" },
            { "day": "2026-08-06", "kind": "partial" },
            { "day": "2026-08-07", "kind": "analysis" },
            { "day": "2026-08-07", "kind": "mark" }
        ])
    );

    // 无结果论文只有 import 日。
    let empty = get_paper(&registry, &library, "paper-empty");
    assert_eq!(
        empty["paper"]["activityDays"],
        json!([{ "day": "2026-08-10", "kind": "import" }])
    );
}

#[test]
fn migrated_library_reopens_without_remigrating() {
    let dir = tempfile::tempdir().unwrap();
    create_v3_fixture(dir.path());
    drop(open_migrated(dir.path()));

    // 再次打开：version == DATABASE_VERSION 短路，不重复回填。
    let (registry, library) = open_migrated(dir.path());
    let normal = get_paper(&registry, &library, "paper-normal");
    assert_eq!(normal["paper"]["readMarks"].as_array().unwrap().len(), 3);
    assert_eq!(normal["paper"]["activityDays"].as_array().unwrap().len(), 5);
}

#[test]
fn failed_migration_rolls_back_and_refuses_startup() {
    let dir = tempfile::tempdir().unwrap();
    create_v3_fixture(dir.path());
    // 塞入无法解析的时间戳：迁移必须整体失败而非带病回填。
    {
        let conn = Connection::open(dir.path().join("database").join("library.sqlite")).unwrap();
        insert_analysis(&conn, "paper-empty", "abstract", "时间戳损坏的结果", "昨天");
    }

    let error = match Library::open(dir.path()) {
        Ok(_) => panic!("迁移失败应拒绝启动"),
        Err(error) => error,
    };
    assert!(
        error.message.contains("时间戳"),
        "错误应指认失败原因: {}",
        error.message
    );

    // 整体回滚：user_version 仍为 3，read_marks/activity_days 两表不存在。
    let conn = Connection::open(dir.path().join("database").join("library.sqlite")).unwrap();
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3, "失败迁移不得推进 user_version");
    assert!(
        conn.query_row("SELECT COUNT(1) FROM read_marks", [], |row| row
            .get::<_, i64>(0))
            .is_err(),
        "失败迁移不得留下 read_marks 表"
    );
    assert!(
        conn.query_row("SELECT COUNT(1) FROM activity_days", [], |row| row
            .get::<_, i64>(0))
            .is_err(),
        "失败迁移不得留下 activity_days 表"
    );
    drop(conn);

    // 拒绝启动是稳定的：重试仍然失败，不出现半迁移状态被误认为成功。
    let again: Result<Library, BridgeError> = Library::open(dir.path());
    assert!(again.is_err());
}

#[test]
fn empty_v3_library_migrates_to_latest_version() {
    let dir = tempfile::tempdir().unwrap();
    {
        let db_dir = dir.path().join("database");
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("library.sqlite")).unwrap();
        conn.execute_batch(V3_SCHEMA).unwrap();
    }
    let library = Library::open(dir.path()).expect("空 v3 库应成功迁移");
    assert_eq!(library.info().database_version, 7);
}
