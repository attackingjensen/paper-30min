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

#[test]
fn first_launch_creates_versioned_database_and_partitions() {
    let (registry, library, dir) = common::env();
    let info = invoke(&registry, &library, "library.info@1", json!({}));
    assert_eq!(info["schemaVersion"], json!(1));
    assert_eq!(info["databaseVersion"], json!(1));
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
    let registry = TaskRegistry::new();
    {
        let library = Library::open(dir.path()).unwrap();
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
    }
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
    let library = Arc::new(library);

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
    ] {
        assert!(commands.iter().any(|item| item == name), "app.info 未列出 {name}");
    }
}
