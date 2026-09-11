//! schema v6 迁移契约：预置 v5 库快照（冻结 DDL + 一篇带旧 chat_messages 行的论文
//! 夹具），打开即迁移，断言增列后旧行经 `library.*@1` DTO 读出 bindingKind=none、
//! 绑定字段可经整记录写入缝往返、失败整体回滚并拒绝启动（规格 #52 决策 1–2）。
//! 回填结果一律经 DTO 黑盒观察；仅回滚断言用只读连接核对 user_version。

use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// 冻结的 v5 快照 DDL：刻意不复用 library.rs 的迁移 SQL——快照必须钉住迁移发生前的
/// 表结构。v5 = v4 全部表 + protocol_products；chat_messages 尚无绑定列。
const V5_SCHEMA: &str = "
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
CREATE TABLE protocol_products (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  part_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, kind, part_id)
);
PRAGMA user_version = 5;
";

/// 在 dir 下预置 v5 快照库：一篇带两条旧问答（无绑定列）的论文。
fn create_v5_fixture(dir: &Path) {
    let db_dir = dir.join("database");
    std::fs::create_dir_all(&db_dir).expect("创建 database 分区");
    let conn = Connection::open(db_dir.join("library.sqlite")).expect("打开夹具库");
    conn.execute_batch(V5_SCHEMA).expect("写入 v5 快照结构");
    conn.execute(
        "INSERT INTO papers(id, title, added_at, updated_at) VALUES('paper-a', 'v5 论文', '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z')",
        [],
    )
    .expect("插入夹具论文");
    conn.execute(
        "INSERT INTO chat_messages(paper_id, seq, role, content, created_at) VALUES('paper-a', 0, 'user', '核心贡献是什么？', '2026-09-01T10:00:00Z')",
        [],
    )
    .expect("插入夹具用户消息");
    conn.execute(
        "INSERT INTO chat_messages(paper_id, seq, role, content, created_at) VALUES('paper-a', 1, 'assistant', '提出了一种注意力机制。', '2026-09-01T10:00:05Z')",
        [],
    )
    .expect("插入夹具助手消息");
}

fn open_migrated(dir: &Path) -> (Arc<TaskRegistry>, Arc<Library>) {
    let library = Arc::new(Library::open(dir).expect("v5 快照应成功迁移到 v6"));
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
fn v5_snapshot_migrates_to_v6_and_old_chat_rows_backfill_none() {
    let dir = tempfile::tempdir().unwrap();
    create_v5_fixture(dir.path());
    let (registry, library) = open_migrated(dir.path());

    let info = bridge::invoke(&registry, &library, "library.info@1", &json!({})).unwrap();
    assert_eq!(info["databaseVersion"], json!(6));

    let paper = get_paper(&registry, &library, "paper-a");
    assert_eq!(
        paper["paper"]["chat"],
        json!([
            {
                "role": "user",
                "content": "核心贡献是什么？",
                "createdAt": "2026-09-01T10:00:00Z",
                "bindingKind": "none",
                "secId": null,
                "fragmentText": null,
                "cite": null,
                "assetIds": []
            },
            {
                "role": "assistant",
                "content": "提出了一种注意力机制。",
                "createdAt": "2026-09-01T10:00:05Z",
                "bindingKind": "none",
                "secId": null,
                "fragmentText": null,
                "cite": null,
                "assetIds": []
            }
        ])
    );
}

#[test]
fn migrated_v6_library_round_trips_bindings_and_reopens() {
    let dir = tempfile::tempdir().unwrap();
    create_v5_fixture(dir.path());
    {
        let (registry, library) = open_migrated(dir.path());
        let paper = get_paper(&registry, &library, "paper-a");
        let mut updated = paper["paper"].clone();
        updated["chat"] = json!([
            {
                "role": "user",
                "content": "这节在说什么？",
                "createdAt": "2026-09-11T08:00:00Z",
                "bindingKind": "section",
                "secId": "sec_3_method",
                "fragmentText": null,
                "cite": {
                    "startSecId": "sec_3_method",
                    "startBlock": 1,
                    "endSecId": "sec_3_method",
                    "endBlock": 20,
                    "startPage": 4,
                    "endPage": 6
                },
                "assetIds": []
            },
            {
                "role": "assistant",
                "content": "方法节给出了注意力机制。",
                "createdAt": "2026-09-11T08:00:05Z",
                "bindingKind": "none",
                "secId": null,
                "fragmentText": null,
                "cite": null,
                "assetIds": []
            }
        ]);
        bridge::invoke(
            &registry,
            &library,
            "library.putPaper@1",
            &json!({ "paper": updated }),
        )
        .expect("library.putPaper@1");
    }

    let (registry, library) = open_migrated(dir.path());
    let info = bridge::invoke(&registry, &library, "library.info@1", &json!({})).unwrap();
    assert_eq!(info["databaseVersion"], json!(6));
    let paper = get_paper(&registry, &library, "paper-a");
    assert_eq!(paper["paper"]["chat"][0]["bindingKind"], json!("section"));
    assert_eq!(paper["paper"]["chat"][0]["secId"], json!("sec_3_method"));
    assert_eq!(paper["paper"]["chat"][0]["cite"]["startBlock"], json!(1));
    assert_eq!(paper["paper"]["chat"][1]["bindingKind"], json!("none"));
}

#[test]
fn failed_v6_migration_rolls_back_and_refuses_startup() {
    let dir = tempfile::tempdir().unwrap();
    create_v5_fixture(dir.path());
    // 预置同名列：ALTER TABLE ADD COLUMN 必失败，迁移必须整体回滚而非带病启动。
    {
        let conn = Connection::open(dir.path().join("database").join("library.sqlite")).unwrap();
        conn.execute_batch(
            "ALTER TABLE chat_messages ADD COLUMN binding_kind TEXT NOT NULL DEFAULT 'none';",
        )
        .unwrap();
    }

    let error = match Library::open(dir.path()) {
        Ok(_) => panic!("迁移失败应拒绝启动"),
        Err(error) => error,
    };
    assert!(
        error.message.contains("binding_kind") || error.message.contains("duplicate column"),
        "错误应指认失败原因: {}",
        error.message
    );

    // 整体回滚：user_version 仍为 5。预置的冲突列在夹具侧，不属于迁移产物；
    // 回滚断言只核对 user_version，不把表结构当契约。
    let conn = Connection::open(dir.path().join("database").join("library.sqlite")).unwrap();
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 5, "失败迁移不得推进 user_version");
    drop(conn);

    let again: Result<Library, BridgeError> = Library::open(dir.path());
    assert!(again.is_err());
}

#[test]
fn empty_v5_library_migrates_to_v6() {
    let dir = tempfile::tempdir().unwrap();
    {
        let db_dir = dir.path().join("database");
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = Connection::open(db_dir.join("library.sqlite")).unwrap();
        conn.execute_batch(V5_SCHEMA).unwrap();
    }
    let library = Library::open(dir.path()).expect("空 v5 库应成功迁移");
    assert_eq!(library.info().database_version, 6);
}
