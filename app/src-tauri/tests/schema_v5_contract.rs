//! schema v5 迁移契约：预置 v4 库快照（冻结 DDL + 一篇带 read_marks/activity_days 的论文
//! 夹具），打开即迁移，断言 protocol_products 建表后可经 `library.*@1` DTO 读写、
//! v4 既有数据原样保留、失败整体回滚并拒绝启动（规格 #55 决策 21）。
//! v5 无历史数据回填——协议产物由后续任务产生，迁移只负责建表。
//! 回填结果一律经 `library.*@1` DTO 黑盒观察；仅回滚断言用只读连接核对 user_version。

use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// 冻结的 v4 快照 DDL：刻意不复用 library.rs 的迁移 SQL——快照必须钉住迁移发生前的
/// 表结构，library.rs 的 DDL 日后演进不影响本夹具。v4 = v3 全部表 + read_marks + activity_days。
const V4_SCHEMA: &str = "
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
PRAGMA user_version = 4;
";

/// 在 dir 下预置 v4 快照库：一篇带标记与活动日的论文，验证迁移后 v4 数据原样保留。
fn create_v4_fixture(dir: &Path) {
    let db_dir = dir.join("database");
    std::fs::create_dir_all(&db_dir).expect("创建 database 分区");
    let conn = Connection::open(db_dir.join("library.sqlite")).expect("打开夹具库");
    conn.execute_batch(V4_SCHEMA).expect("写入 v4 快照结构");
    conn.execute(
        "INSERT INTO papers(id, title, added_at, updated_at) VALUES('paper-a', 'v4 论文', '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')",
        [],
    )
    .expect("插入夹具论文");
    conn.execute(
        "INSERT INTO read_marks(paper_id, part_id, marked_at) VALUES('paper-a', 'abstract', '2026-09-02T10:00:00Z')",
        [],
    )
    .expect("插入夹具标记");
    conn.execute(
        "INSERT INTO activity_days(day, paper_id, kind) VALUES('2026-09-01', 'paper-a', 'import')",
        [],
    )
    .expect("插入夹具活动日");
}

fn open_migrated(dir: &Path) -> (Arc<TaskRegistry>, Arc<Library>) {
    let library = Arc::new(Library::open(dir).expect("v4 快照应成功迁移到当前版本"));
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
fn v4_snapshot_migrates_to_v5_and_products_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    create_v4_fixture(dir.path());
    let (registry, library) = open_migrated(dir.path());

    let info = bridge::invoke(&registry, &library, "library.info@1", &json!({})).unwrap();
    assert_eq!(info["databaseVersion"], json!(7));

    // v4 既有数据原样保留：标记与活动日不受影响。
    let paper = get_paper(&registry, &library, "paper-a");
    assert_eq!(
        paper["paper"]["readMarks"],
        json!([{ "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" }])
    );
    assert_eq!(
        paper["paper"]["activityDays"],
        json!([{ "day": "2026-09-01", "kind": "import" }])
    );
    assert_eq!(paper["paper"]["products"], json!([]));

    // 迁移后的库可经整记录写入缝落产物并读回（结构对象与 Markdown 字符串两种 body）。
    let mut updated = paper["paper"].clone();
    updated["products"] = json!([
        {
            "kind": "map",
            "partId": "",
            "body": { "problem": { "text": "要解决的问题", "refs": ["(p1)"] } },
            "updatedAt": "2026-09-10T08:00:00Z"
        },
        {
            "kind": "dig",
            "partId": "part-1",
            "body": "## 核心论点\n\n……(sec_1:L30-34)",
            "updatedAt": "2026-09-10T09:00:00Z"
        }
    ]);
    let saved = bridge::invoke(
        &registry,
        &library,
        "library.putPaper@1",
        &json!({ "paper": updated }),
    )
    .expect("library.putPaper@1");
    assert_eq!(saved["paper"]["products"].as_array().unwrap().len(), 2);

    let loaded = get_paper(&registry, &library, "paper-a");
    assert_eq!(loaded["paper"], saved["paper"]);
}

#[test]
fn migrated_v5_library_reopens_without_remigrating() {
    let dir = tempfile::tempdir().unwrap();
    create_v4_fixture(dir.path());
    {
        let (registry, library) = open_migrated(dir.path());
        let paper = get_paper(&registry, &library, "paper-a");
        let mut updated = paper["paper"].clone();
        updated["products"] = json!([
            { "kind": "retell", "partId": "", "body": "# 复述稿", "updatedAt": "2026-09-10T08:00:00Z" }
        ]);
        bridge::invoke(
            &registry,
            &library,
            "library.putPaper@1",
            &json!({ "paper": updated }),
        )
        .expect("library.putPaper@1");
    }

    // 再次打开：version == DATABASE_VERSION 短路，不重复迁移；已落库产物原样读回。
    let (registry, library) = open_migrated(dir.path());
    let info = bridge::invoke(&registry, &library, "library.info@1", &json!({})).unwrap();
    assert_eq!(info["databaseVersion"], json!(7));
    let paper = get_paper(&registry, &library, "paper-a");
    assert_eq!(
        paper["paper"]["products"],
        json!([{ "kind": "retell", "partId": "", "body": "# 复述稿", "updatedAt": "2026-09-10T08:00:00Z" }])
    );
}

#[test]
fn failed_v5_migration_rolls_back_and_refuses_startup() {
    let dir = tempfile::tempdir().unwrap();
    create_v4_fixture(dir.path());
    // 预置一张同名冲突表：CREATE TABLE 必失败，迁移必须整体回滚而非带病启动。
    {
        let conn = Connection::open(dir.path().join("database").join("library.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE protocol_products(stub TEXT);")
            .unwrap();
    }

    let error = match Library::open(dir.path()) {
        Ok(_) => panic!("迁移失败应拒绝启动"),
        Err(error) => error,
    };
    assert!(
        error.message.contains("protocol_products"),
        "错误应指认失败原因: {}",
        error.message
    );

    // 整体回滚：user_version 仍为 4（预置的冲突表在夹具侧，不属于迁移产物）。
    let conn = Connection::open(dir.path().join("database").join("library.sqlite")).unwrap();
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4, "失败迁移不得推进 user_version");
    drop(conn);

    // 拒绝启动是稳定的：重试仍然失败，不出现半迁移状态被误认为成功。
    let again: Result<Library, BridgeError> = Library::open(dir.path());
    assert!(again.is_err());
}

#[test]
fn empty_v4_library_migrates_to_v5() {
    let dir = tempfile::tempdir().unwrap();
    {
        let db_dir = dir.path().join("database");
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("library.sqlite")).unwrap();
        conn.execute_batch(V4_SCHEMA).unwrap();
    }
    let library = Library::open(dir.path()).expect("空 v4 库应成功迁移");
    assert_eq!(library.info().database_version, 7);
}
