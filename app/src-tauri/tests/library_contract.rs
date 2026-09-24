//! 书库外部行为契约：只通过版本化 `library.*@1` 命令观察 DTO，不读取 SQLite 表结构。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::sync::Arc;
use std::thread;

fn invoke(registry: &Arc<TaskRegistry>, library: &Library, command: &str, input: Value) -> Value {
    bridge::invoke(registry, library, command, &input).expect(command)
}

fn invoke_err(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    command: &str,
    input: Value,
) -> paper30min_lib::error::BridgeError {
    bridge::invoke(registry, library, command, &input).expect_err(command)
}

fn sample_paper(id: &str, title: &str) -> Value {
    json!({
        "paper": {
            "id": id,
            "title": title,
            "sourceType": "plain-text",
            "arxivId": null,
            "pdfName": "",
            "numPages": 2,
            "fullText": "摘要正文",
            "rating": 3,
            "categories": ["NLP"],
            "tags": ["transformer"],
            "addedAt": "2026-09-01T08:00:00Z",
            "updatedAt": "2026-09-01T09:00:00Z",
            "sections": [
                { "id": "abstract", "sourceText": "摘要正文", "pageStart": 1, "pageEnd": 1 }
            ],
            "parts": [
                { "id": "part-1", "title": "方法", "heading": "2 Method", "semanticType": "method", "sortOrder": 0 }
            ],
            "analyses": [
                { "sectionId": "abstract", "text": "精读结果", "updatedAt": "2026-09-01T09:00:00Z" }
            ],
            "translations": [
                {
                    "sectionId": "abstract",
                    "language": "zh",
                    "text": "译文",
                    "source": "model",
                    "updatedAt": "2026-09-01T09:10:00Z"
                }
            ],
            "recallCard": {
                "markdown": "回想要点",
                "images": [{ "id": "img-1", "name": "sketch.png" }],
                "updatedAt": "2026-09-01T09:20:00Z"
            },
            "chat": [
                { "role": "user", "content": "核心贡献是什么？", "createdAt": "2026-09-01T10:00:00Z" },
                { "role": "assistant", "content": "提出了一种注意力机制。", "createdAt": "2026-09-01T10:00:05Z" }
            ]
        }
    })
}

fn sample_chat_bindings() -> Value {
    json!([
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
            "bindingKind": "section",
            "secId": "sec_3_method",
            "fragmentText": "应被清掉",
            "cite": { "startSecId": "sec_3_method", "startBlock": 1, "endSecId": "sec_3_method", "endBlock": 2 },
            "assetIds": ["crop-fig_1"]
        },
        {
            "role": "user",
            "content": "这张图什么意思？",
            "createdAt": "2026-09-11T08:01:00Z",
            "bindingKind": "fragment",
            "secId": null,
            "fragmentText": "Figure 1 shows the architecture.",
            "cite": {
                "startSecId": "sec_2_intro",
                "startBlock": 12,
                "endSecId": "sec_3_method",
                "endBlock": 2,
                "startPage": 2,
                "endPage": 4
            },
            "assetIds": ["crop-fig_1"]
        }
    ])
}

#[test]
fn first_launch_creates_versioned_database_and_partitions() {
    let (registry, library, dir) = common::env();
    let info = invoke(&registry, &library, "library.info@1", json!({}));
    assert_eq!(info["schemaVersion"], json!(1));
    assert_eq!(info["databaseVersion"], json!(7));
    let root = info["dataRoot"].as_str().expect("dataRoot");
    assert_eq!(root, dir.path().to_string_lossy().as_ref());
    let partitions = info["partitions"].as_array().expect("partitions");
    for name in ["database", "attachments", "operations", "exports"] {
        assert!(partitions.iter().any(|item| item == name), "缺少分区 {name}");
        assert!(dir.path().join(name).is_dir(), "未创建目录 {name}");
    }
    assert!(dir.path().join("database").join("library.sqlite").is_file());
}

#[test]
fn put_and_get_paper_round_trips_nested_reading_results() {
    let (registry, library, _dir) = common::env();
    let saved = invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-a", "注意力论文"));
    assert_eq!(saved["schemaVersion"], json!(1));
    let paper = &saved["paper"];
    assert_eq!(paper["id"], json!("paper-a"));
    assert_eq!(paper["title"], json!("注意力论文"));
    assert_eq!(paper["sections"][0]["sourceText"], json!("摘要正文"));
    assert_eq!(paper["analyses"][0]["text"], json!("精读结果"));
    assert_eq!(paper["translations"][0]["language"], json!("zh"));
    assert_eq!(paper["recallCard"]["markdown"], json!("回想要点"));
    assert_eq!(paper["chat"][1]["role"], json!("assistant"));
    assert!(paper.get("categories_json").is_none(), "SQLite 列名不应出现在 DTO 中");

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-a" }));
    assert_eq!(loaded["paper"], saved["paper"]);
    assert_eq!(loaded["paper"]["parts"][0]["sortOrder"], json!(0));

    let mut ordered = sample_paper("paper-order", "章节顺序");
    ordered["paper"]["sections"] = json!([
        { "id": "z-section", "sourceText": "先写入" },
        { "id": "a-section", "sourceText": "后写入" }
    ]);
    invoke(&registry, &library, "library.putPaper@1", ordered);
    let ordered_loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-order" }));
    assert_eq!(ordered_loaded["paper"]["sections"][0]["id"], json!("z-section"));
    assert_eq!(ordered_loaded["paper"]["sections"][1]["id"], json!("a-section"));
}

#[test]
fn list_papers_returns_newest_first_summaries_without_body() {
    let (registry, library, _dir) = common::env();
    invoke(&registry, &library, "library.putPaper@1", sample_paper("old", "旧论文"));
    let newer = sample_paper("new", "新论文");
    // 较新的 addedAt 应排在前面。
    let mut newer = newer;
    newer["paper"]["addedAt"] = json!("2026-09-03T08:00:00Z");
    invoke(&registry, &library, "library.putPaper@1", newer);

    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    let ids: Vec<&str> = listed["papers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|paper| paper["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["new", "old"]);
    assert!(listed["papers"][0].get("fullText").is_none());
    assert!(listed["papers"][0].get("analyses").is_none());
    assert_eq!(listed["papers"][0]["title"], json!("新论文"));
}

#[test]
fn put_paper_replaces_nested_records_in_one_transaction() {
    let (registry, library, _dir) = common::env();
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-a", "注意力论文"));
    let mut updated = sample_paper("paper-a", "注意力论文（修订）");
    updated["paper"]["analyses"] = json!([
        { "sectionId": "part-1", "text": "新精读", "updatedAt": "2026-09-02T09:00:00Z" }
    ]);
    updated["paper"]["translations"] = json!([]);
    updated["paper"]["updatedAt"] = json!("2026-09-02T09:00:00Z");
    invoke(&registry, &library, "library.putPaper@1", updated);

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-a" }));
    assert_eq!(loaded["paper"]["title"], json!("注意力论文（修订）"));
    assert_eq!(loaded["paper"]["analyses"].as_array().unwrap().len(), 1);
    assert_eq!(loaded["paper"]["analyses"][0]["sectionId"], json!("part-1"));
    assert_eq!(loaded["paper"]["translations"].as_array().unwrap().len(), 0);
}

#[test]
fn delete_paper_removes_record_and_reading_position() {
    let (registry, library, _dir) = common::env();
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-a", "注意力论文"));
    invoke(
        &registry,
        &library,
        "library.putReadingPosition@1",
        json!({
            "position": {
                "paperId": "paper-a",
                "view": "digest",
                "sectionId": "abstract",
                "pdfPage": null,
                "contentVersion": "v1"
            }
        }),
    );
    let deleted = invoke(&registry, &library, "library.deletePaper@1", json!({ "paperId": "paper-a" }));
    assert_eq!(deleted["deleted"], json!(true));
    assert_eq!(deleted["cleanupPending"], json!(false));
    let error = invoke_err(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-a" }));
    assert_eq!(error.code, "not_found");
    assert!(!error.retryable);
    assert_eq!(error.details.unwrap()["paperId"], json!("paper-a"));
    let position = invoke(&registry, &library, "library.getReadingPosition@1", json!({ "paperId": "paper-a" }));
    assert!(position["position"].is_null());
}

#[test]
fn missing_paper_and_invalid_dto_are_classified() {
    let (registry, library, _dir) = common::env();
    let missing = invoke_err(&registry, &library, "library.getPaper@1", json!({ "paperId": "nope" }));
    assert_eq!(missing.code, "not_found");
    assert!(!missing.retryable);

    let no_id = invoke_err(
        &registry,
        &library,
        "library.putPaper@1",
        json!({ "paper": { "title": "无编号" } }),
    );
    assert_eq!(no_id.code, "invalid_input");
    assert!(!no_id.retryable);

    let bad_date = invoke_err(
        &registry,
        &library,
        "library.putPaper@1",
        json!({
            "paper": { "id": "p1", "title": "日期错误", "addedAt": "昨天" }
        }),
    );
    assert_eq!(bad_date.code, "invalid_input");

    let offset_date = invoke_err(
        &registry,
        &library,
        "library.putPaper@1",
        json!({
            "paper": {
                "id": "p2",
                "title": "带时区",
                "addedAt": "2026-09-05T12:00:00+08:00",
                "updatedAt": "2026-09-05T12:00:00+08:00"
            }
        }),
    );
    assert_eq!(offset_date.code, "invalid_input");

    let with_frac = invoke(
        &registry,
        &library,
        "library.putPaper@1",
        json!({
            "paper": {
                "id": "frac",
                "title": "毫秒时间戳",
                "addedAt": "2026-09-05T12:00:00.123Z",
                "updatedAt": "2026-09-05T12:00:00.123Z"
            }
        }),
    );
    assert_eq!(with_frac["paper"]["id"], json!("frac"));
    assert_eq!(with_frac["paper"]["addedAt"], json!("2026-09-05T12:00:00.123Z"));
}

#[test]
fn reading_position_round_trips_for_existing_paper() {
    let (registry, library, _dir) = common::env();
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-a", "注意力论文"));
    let saved = invoke(
        &registry,
        &library,
        "library.putReadingPosition@1",
        json!({
            "position": {
                "paperId": "paper-a",
                "view": "pdf",
                "sectionId": null,
                "pdfPage": 4,
                "contentVersion": "v2"
            }
        }),
    );
    assert_eq!(saved["position"]["view"], json!("pdf"));
    assert_eq!(saved["position"]["pdfPage"], json!(4));
    assert!(saved["position"]["updatedAt"].as_str().unwrap().ends_with('Z'));

    let loaded = invoke(&registry, &library, "library.getReadingPosition@1", json!({ "paperId": "paper-a" }));
    assert_eq!(loaded["position"]["paperId"], json!("paper-a"));
    assert_eq!(loaded["position"]["pdfPage"], json!(4));
    assert_eq!(loaded["position"]["contentVersion"], json!("v2"));

    let deleted = invoke(
        &registry,
        &library,
        "library.deleteReadingPosition@1",
        json!({ "paperId": "paper-a" }),
    );
    assert_eq!(deleted["deleted"], json!(true));
    let cleared = invoke(&registry, &library, "library.getReadingPosition@1", json!({ "paperId": "paper-a" }));
    assert!(cleared["position"].is_null());
}

#[test]
fn reading_position_for_unknown_paper_is_not_found() {
    let (registry, library, _dir) = common::env();
    let error = invoke_err(
        &registry,
        &library,
        "library.putReadingPosition@1",
        json!({ "position": { "paperId": "missing", "view": "digest" } }),
    );
    assert_eq!(error.code, "not_found");
}

#[test]
fn restart_restores_paper_and_reading_position() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(dir.path()).unwrap());
    let registry = TaskRegistry::new(Arc::clone(&library));
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-a", "注意力论文"));
    invoke(
        &registry,
        &library,
        "library.putReadingPosition@1",
        json!({
            "position": {
                "paperId": "paper-a",
                "view": "digest",
                "sectionId": "abstract"
            }
        }),
    );
    // 另开一条连接只读到已提交数据，验证落盘持久化。
    let library = Library::open(dir.path()).unwrap();
    let paper = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-a" }));
    assert_eq!(paper["paper"]["title"], json!("注意力论文"));
    assert_eq!(paper["paper"]["analyses"][0]["text"], json!("精读结果"));
    assert_eq!(paper["paper"]["chat"].as_array().unwrap().len(), 2);
    let position = invoke(&registry, &library, "library.getReadingPosition@1", json!({ "paperId": "paper-a" }));
    assert_eq!(position["position"]["view"], json!("digest"));
    assert_eq!(position["position"]["sectionId"], json!("abstract"));
}

#[test]
fn concurrent_puts_of_same_paper_do_not_tear_nested_records() {
    let (registry, library, _dir) = common::env();
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-a", "初始"));

    let mut handles = Vec::new();
    for label in ["A", "B"] {
        let library = Arc::clone(&library);
        let registry = Arc::clone(&registry);
        handles.push(thread::spawn(move || {
            let input = json!({
                "paper": {
                    "id": "paper-a",
                    "title": label,
                    "addedAt": "2026-09-01T08:00:00Z",
                    "updatedAt": "2026-09-04T08:00:00Z",
                    "analyses": [
                        { "sectionId": "abstract", "text": label, "updatedAt": "2026-09-04T08:00:00Z" }
                    ]
                }
            });
            bridge::invoke(&registry, &library, "library.putPaper@1", &input).unwrap();
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }

    let loaded = invoke(&registry, library.as_ref(), "library.getPaper@1", json!({ "paperId": "paper-a" }));
    let title = loaded["paper"]["title"].as_str().unwrap();
    let analysis = loaded["paper"]["analyses"][0]["text"].as_str().unwrap();
    assert_eq!(title, analysis, "同一论文的标题与精读结果应来自同一次完整写入");
    assert!(title == "A" || title == "B");
}

#[test]
fn read_marks_and_activity_days_round_trip_through_put_paper() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-marks", "标记论文");
    input["paper"]["readMarks"] = json!([
        { "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" },
        { "partId": "part-1", "markedAt": "2026-09-03T10:00:00Z" }
    ]);
    input["paper"]["activityDays"] = json!([
        { "day": "2026-09-01", "kind": "import" },
        { "day": "2026-09-02", "kind": "mark" }
    ]);
    let saved = invoke(&registry, &library, "library.putPaper@1", input);
    assert_eq!(
        saved["paper"]["readMarks"],
        json!([
            { "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" },
            { "partId": "part-1", "markedAt": "2026-09-03T10:00:00Z" }
        ])
    );
    assert_eq!(
        saved["paper"]["activityDays"],
        json!([
            { "day": "2026-09-01", "kind": "import" },
            { "day": "2026-09-02", "kind": "mark" }
        ])
    );

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-marks" }));
    assert_eq!(loaded["paper"], saved["paper"]);
}

#[test]
fn read_marks_snapshot_rewrite_revokes_missing_rows() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-marks", "标记论文");
    input["paper"]["readMarks"] = json!([
        { "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" },
        { "partId": "part-1", "markedAt": "2026-09-03T10:00:00Z" }
    ]);
    invoke(&registry, &library, "library.putPaper@1", input);

    // 撤销 = 快照少一行：第二次 put 不再携带 part-1 标记。
    let mut revoked = sample_paper("paper-marks", "标记论文");
    revoked["paper"]["readMarks"] = json!([
        { "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" }
    ]);
    invoke(&registry, &library, "library.putPaper@1", revoked);

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-marks" }));
    assert_eq!(
        loaded["paper"]["readMarks"],
        json!([{ "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" }])
    );
}

#[test]
fn activity_days_are_append_only_and_idempotent() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-days", "打卡论文");
    input["paper"]["activityDays"] = json!([
        { "day": "2026-09-01", "kind": "import" },
        { "day": "2026-09-02", "kind": "mark" }
    ]);
    invoke(&registry, &library, "library.putPaper@1", input.clone());
    // 同日同篇同类重复写入幂等。
    invoke(&registry, &library, "library.putPaper@1", input);

    // DTO 未携带的历史行不受影响：第二次 put 只携带 import 日。
    let mut subset = sample_paper("paper-days", "打卡论文");
    subset["paper"]["activityDays"] = json!([{ "day": "2026-09-01", "kind": "import" }]);
    invoke(&registry, &library, "library.putPaper@1", subset);

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-days" }));
    assert_eq!(
        loaded["paper"]["activityDays"],
        json!([
            { "day": "2026-09-01", "kind": "import" },
            { "day": "2026-09-02", "kind": "mark" }
        ])
    );
}

#[test]
fn delete_paper_cascades_read_marks_and_activity_days() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-cascade", "级联论文");
    input["paper"]["readMarks"] = json!([
        { "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" }
    ]);
    input["paper"]["activityDays"] = json!([{ "day": "2026-09-01", "kind": "import" }]);
    invoke(&registry, &library, "library.putPaper@1", input);
    invoke(&registry, &library, "library.deletePaper@1", json!({ "paperId": "paper-cascade" }));

    // 同 id 重建一篇无标记论文：若旧行未随论文级联删除，这里会读出残留行。
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-cascade", "级联论文"));
    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-cascade" }));
    assert_eq!(loaded["paper"]["readMarks"], json!([]));
    assert_eq!(loaded["paper"]["activityDays"], json!([]));
}

#[test]
fn invalid_read_marks_and_activity_days_are_rejected() {
    let (registry, library, _dir) = common::env();

    let mut duplicate = sample_paper("p-dup", "重复标记");
    duplicate["paper"]["readMarks"] = json!([
        { "partId": "abstract", "markedAt": "2026-09-02T10:00:00Z" },
        { "partId": "abstract", "markedAt": "2026-09-03T10:00:00Z" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", duplicate);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("readMarks.partId"));

    let mut bad_marked_at = sample_paper("p-date", "标记时间无效");
    bad_marked_at["paper"]["readMarks"] = json!([
        { "partId": "abstract", "markedAt": "昨天" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", bad_marked_at);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("readMarks.markedAt"));

    let mut bad_day = sample_paper("p-day", "活动日无效");
    bad_day["paper"]["activityDays"] = json!([{ "day": "2026-9-1", "kind": "import" }]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", bad_day);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("activityDays.day"));

    let mut bad_kind = sample_paper("p-kind", "活动类型未知");
    bad_kind["paper"]["activityDays"] = json!([{ "day": "2026-09-01", "kind": "reread" }]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", bad_kind);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("activityDays.kind"));
}

// ---------------- 协议产物（规格 #55 决策 21） ----------------

fn sample_products() -> Value {
    json!([
        {
            "kind": "map",
            "partId": "",
            "body": { "problem": { "text": "要解决的问题", "refs": ["(p1)"] }, "glossary": [] },
            "updatedAt": "2026-09-10T08:00:00Z"
        },
        {
            "kind": "l2",
            "partId": "part-1",
            "body": { "gist": "主旨", "points": [{ "text": "要点", "refs": ["(sec_1:L3-5)"] }], "keyAssets": ["fig_1"], "pages": { "start": 2, "end": 4 } },
            "updatedAt": "2026-09-10T08:10:00Z"
        },
        {
            "kind": "dig",
            "partId": "part-1",
            "body": "## 核心论点\n\n方法有效 (fig_1)。",
            "updatedAt": "2026-09-10T09:00:00Z"
        },
        {
            "kind": "retell",
            "partId": "",
            "body": "# 复述稿\n\n问题 → 方法 → 证据 → 边界。",
            "updatedAt": "2026-09-11T08:00:00Z"
        }
    ])
}

#[test]
fn products_round_trip_through_put_paper() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-products", "产物论文");
    input["paper"]["products"] = sample_products();
    let saved = invoke(&registry, &library, "library.putPaper@1", input);

    // 结构对象与 Markdown 字符串两种 body 原样往返；读回按 (kind, partId) 排序。
    assert_eq!(
        saved["paper"]["products"],
        json!([
            {
                "kind": "dig",
                "partId": "part-1",
                "body": "## 核心论点\n\n方法有效 (fig_1)。",
                "updatedAt": "2026-09-10T09:00:00Z"
            },
            {
                "kind": "l2",
                "partId": "part-1",
                "body": { "gist": "主旨", "points": [{ "text": "要点", "refs": ["(sec_1:L3-5)"] }], "keyAssets": ["fig_1"], "pages": { "start": 2, "end": 4 } },
                "updatedAt": "2026-09-10T08:10:00Z"
            },
            {
                "kind": "map",
                "partId": "",
                "body": { "problem": { "text": "要解决的问题", "refs": ["(p1)"] }, "glossary": [] },
                "updatedAt": "2026-09-10T08:00:00Z"
            },
            {
                "kind": "retell",
                "partId": "",
                "body": "# 复述稿\n\n问题 → 方法 → 证据 → 边界。",
                "updatedAt": "2026-09-11T08:00:00Z"
            }
        ])
    );

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-products" }));
    assert_eq!(loaded["paper"], saved["paper"]);
}

#[test]
fn products_snapshot_rewrite_overwrites_without_history() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-products", "产物论文");
    input["paper"]["products"] = sample_products();
    invoke(&registry, &library, "library.putPaper@1", input);

    // 重跑覆盖 = 快照换一行：map 换新内容，dig 不再携带即消失，不留版本历史。
    let mut rerun = sample_paper("paper-products", "产物论文");
    rerun["paper"]["products"] = json!([
        {
            "kind": "map",
            "partId": "",
            "body": { "problem": { "text": "新的问题陈述", "refs": ["(p1)"] }, "glossary": [] },
            "updatedAt": "2026-09-12T08:00:00Z"
        },
        {
            "kind": "l2",
            "partId": "part-1",
            "body": { "gist": "主旨", "points": [], "keyAssets": [], "pages": { "start": 2, "end": 4 } },
            "updatedAt": "2026-09-10T08:10:00Z"
        }
    ]);
    invoke(&registry, &library, "library.putPaper@1", rerun);

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-products" }));
    assert_eq!(
        loaded["paper"]["products"],
        json!([
            {
                "kind": "l2",
                "partId": "part-1",
                "body": { "gist": "主旨", "points": [], "keyAssets": [], "pages": { "start": 2, "end": 4 } },
                "updatedAt": "2026-09-10T08:10:00Z"
            },
            {
                "kind": "map",
                "partId": "",
                "body": { "problem": { "text": "新的问题陈述", "refs": ["(p1)"] }, "glossary": [] },
                "updatedAt": "2026-09-12T08:00:00Z"
            }
        ])
    );
}

#[test]
fn delete_paper_cascades_protocol_products() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-cascade", "级联论文");
    input["paper"]["products"] = sample_products();
    invoke(&registry, &library, "library.putPaper@1", input);
    invoke(&registry, &library, "library.deletePaper@1", json!({ "paperId": "paper-cascade" }));

    // 同 id 重建一篇无产物论文：若旧行未随论文级联删除，这里会读出残留行。
    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-cascade", "级联论文"));
    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-cascade" }));
    assert_eq!(loaded["paper"]["products"], json!([]));
}

#[test]
fn invalid_products_are_rejected() {
    let (registry, library, _dir) = common::env();

    let mut unknown_kind = sample_paper("p-kind", "未知产物");
    unknown_kind["paper"]["products"] = json!([
        { "kind": "summary", "partId": "part-1", "body": "x", "updatedAt": "2026-09-10T08:00:00Z" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", unknown_kind);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("products.kind"));

    let mut l2_without_part = sample_paper("p-nopart", "节级产物缺部分");
    l2_without_part["paper"]["products"] = json!([
        { "kind": "l2", "partId": "", "body": { "gist": "x" }, "updatedAt": "2026-09-10T08:00:00Z" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", l2_without_part);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("products.partId"));

    let mut map_with_part = sample_paper("p-withpart", "论文级产物带部分");
    map_with_part["paper"]["products"] = json!([
        { "kind": "map", "partId": "part-1", "body": { "problem": {} }, "updatedAt": "2026-09-10T08:00:00Z" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", map_with_part);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("products.partId"));

    let mut duplicate = sample_paper("p-dup", "重复产物");
    duplicate["paper"]["products"] = json!([
        { "kind": "dig", "partId": "part-1", "body": "旧", "updatedAt": "2026-09-10T08:00:00Z" },
        { "kind": "dig", "partId": "part-1", "body": "新", "updatedAt": "2026-09-11T08:00:00Z" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", duplicate);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("products.kind+partId"));

    let mut bad_date = sample_paper("p-date", "产物时间无效");
    bad_date["paper"]["products"] = json!([
        { "kind": "dig", "partId": "part-1", "body": "x", "updatedAt": "昨天" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", bad_date);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("products.updatedAt"));

    let mut null_body = sample_paper("p-nullbody", "空产物");
    null_body["paper"]["products"] = json!([
        { "kind": "retell", "partId": "", "body": null, "updatedAt": "2026-09-10T08:00:00Z" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", null_body);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("products.body"));
}

#[test]
fn chat_bindings_round_trip_through_put_paper() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-chat", "绑定论文");
    input["paper"]["chat"] = sample_chat_bindings();
    let saved = invoke(&registry, &library, "library.putPaper@1", input);

    // @节与片段原样往返；assistant 即便入参带绑定也恒回填 none。
    assert_eq!(
        saved["paper"]["chat"],
        json!([
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
            },
            {
                "role": "user",
                "content": "这张图什么意思？",
                "createdAt": "2026-09-11T08:01:00Z",
                "bindingKind": "fragment",
                "secId": null,
                "fragmentText": "Figure 1 shows the architecture.",
                "cite": {
                    "startSecId": "sec_2_intro",
                    "startBlock": 12,
                    "endSecId": "sec_3_method",
                    "endBlock": 2,
                    "startPage": 2,
                    "endPage": 4
                },
                "assetIds": ["crop-fig_1"]
            }
        ])
    );

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-chat" }));
    assert_eq!(loaded["paper"], saved["paper"]);
}

#[test]
fn chat_snapshot_rewrite_drops_bindings_with_messages() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-chat", "绑定论文");
    input["paper"]["chat"] = sample_chat_bindings();
    invoke(&registry, &library, "library.putPaper@1", input);

    // 淘汰最旧消息时绑定一并删除：第二次 put 只保留最后一条用户消息。
    let mut trimmed = sample_paper("paper-chat", "绑定论文");
    trimmed["paper"]["chat"] = json!([
        {
            "role": "user",
            "content": "这张图什么意思？",
            "createdAt": "2026-09-11T08:01:00Z",
            "bindingKind": "fragment",
            "secId": null,
            "fragmentText": "Figure 1 shows the architecture.",
            "cite": {
                "startSecId": "sec_2_intro",
                "startBlock": 12,
                "endSecId": "sec_3_method",
                "endBlock": 2,
                "startPage": 2,
                "endPage": 4
            },
            "assetIds": ["crop-fig_1"]
        }
    ]);
    invoke(&registry, &library, "library.putPaper@1", trimmed);

    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-chat" }));
    assert_eq!(loaded["paper"]["chat"].as_array().unwrap().len(), 1);
    assert_eq!(loaded["paper"]["chat"][0]["bindingKind"], json!("fragment"));
    assert_eq!(loaded["paper"]["chat"][0]["assetIds"], json!(["crop-fig_1"]));
}

#[test]
fn delete_paper_cascades_chat_bindings() {
    let (registry, library, _dir) = common::env();
    let mut input = sample_paper("paper-cascade", "级联论文");
    input["paper"]["chat"] = sample_chat_bindings();
    invoke(&registry, &library, "library.putPaper@1", input);
    invoke(&registry, &library, "library.deletePaper@1", json!({ "paperId": "paper-cascade" }));

    invoke(&registry, &library, "library.putPaper@1", sample_paper("paper-cascade", "级联论文"));
    let loaded = invoke(&registry, &library, "library.getPaper@1", json!({ "paperId": "paper-cascade" }));
    // 同 id 重建后只有 sample_paper 的两条无绑定消息，不得读出旧绑定行。
    assert_eq!(loaded["paper"]["chat"].as_array().unwrap().len(), 2);
    assert_eq!(loaded["paper"]["chat"][0]["bindingKind"], json!("none"));
    assert_eq!(loaded["paper"]["chat"][1]["bindingKind"], json!("none"));
}

#[test]
fn invalid_chat_bindings_are_rejected() {
    let (registry, library, _dir) = common::env();

    let mut unknown_kind = sample_paper("p-kind", "未知绑定");
    unknown_kind["paper"]["chat"] = json!([
        { "role": "user", "content": "q", "createdAt": "2026-09-11T08:00:00Z", "bindingKind": "quote" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", unknown_kind);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("chat.bindingKind"));

    let mut section_without_id = sample_paper("p-sec", "@节缺节 id");
    section_without_id["paper"]["chat"] = json!([
        { "role": "user", "content": "q", "createdAt": "2026-09-11T08:00:00Z", "bindingKind": "section" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", section_without_id);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("chat.secId"));

    let mut fragment_without_text = sample_paper("p-frag", "片段缺原文");
    fragment_without_text["paper"]["chat"] = json!([
        { "role": "user", "content": "q", "createdAt": "2026-09-11T08:00:00Z", "bindingKind": "fragment" }
    ]);
    let error = invoke_err(&registry, &library, "library.putPaper@1", fragment_without_text);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("chat.fragmentText"));
}

#[test]
fn app_info_lists_library_commands() {
    let (registry, library, _dir) = common::env();
    let info = invoke(&registry, &library, "app.info@1", json!({}));
    let commands = info["commands"].as_array().unwrap();
    for name in [
        "library.info@1",
        "library.listPapers@1",
        "library.getPaper@1",
        "library.putPaper@1",
        "library.deletePaper@1",
        "library.getReadingPosition@1",
        "library.putReadingPosition@1",
        "library.deleteReadingPosition@1",
        "files.putAttachment@1",
        "files.readRange@1",
    ] {
        assert!(commands.iter().any(|item| item == name), "app.info 未列出 {name}");
    }
}
