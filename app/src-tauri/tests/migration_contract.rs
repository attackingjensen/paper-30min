//! 浏览器整库 JSON 迁移外部行为契约：只通过版本化 `migration.*@1`
//! 命令观察预检/提交结果，再用 `library.*@1` / `files.*@1` 确认书库变化。
//! 不读取 SQLite 表结构，也不把绝对路径当作前端契约。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Arc;

fn invoke(registry: &Arc<TaskRegistry>, library: &Library, command: &str, input: Value) -> Value {
    bridge::invoke(registry, library, command, &input).expect(command)
}

fn invoke_err(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    command: &str,
    input: Value,
) -> BridgeError {
    bridge::invoke(registry, library, command, &input).expect_err(command)
}

const HELLO_PDF_B64: &str = "aGVsbG8tcGRm";
const HELLO_PDF_SHA256: &str = "787039b5a469fb8e720be530ac94788a4a85c6b81b786efa5a2727738cfa8a6a";
const ADDED_AT_MS: i64 = 1_788_249_600_000;
const ADDED_AT_ISO: &str = "2026-09-01T08:00:00Z";

fn sample_browser_paper(id: &str, title: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "addedAt": ADDED_AT_MS,
        "updatedAt": ADDED_AT_MS,
        "sourceType": "plain-text",
        "pdfName": "attention.pdf",
        "numPages": 2,
        "fullText": "摘要正文",
        "rating": 3,
        "categories": ["NLP"],
        "tags": ["transformer"],
        "sections": { "abstract": "摘要正文" },
        "sectionPages": { "abstract": { "start": 1, "end": 1 } },
        "parts": [{
            "id": "part-1",
            "title": "方法",
            "heading": "2 Method",
            "semanticType": "method"
        }],
        "analyses": {
            "abstract": { "text": "精读结果", "updatedAt": ADDED_AT_MS }
        },
        "translations": {
            "abstract:zh": {
                "text": "译文",
                "source": "model",
                "updatedAt": ADDED_AT_MS
            }
        },
        "recallCard": {
            "markdown": "回想要点",
            "images": [{ "id": "img-1", "name": "sketch.png" }],
            "updatedAt": ADDED_AT_MS
        },
        "chat": [{ "role": "user", "content": "核心贡献是什么？" }],
        "pdfBlob": { "base64": HELLO_PDF_B64, "type": "application/pdf" }
    })
}

fn envelope(papers: Vec<Value>) -> Value {
    json!({
        "format": "paper-30min-library",
        "version": 1,
        "exportedAt": "2026-09-06T00:00:00.000Z",
        "papers": papers,
        "skills": { "method": "custom skill" },
        "settings": {
            "baseUrl": "https://example.com/v1",
            "apiKey": "sk-secret-should-not-migrate",
            "model": "qwen"
        }
    })
}

fn write_export(dir: &Path, name: &str, payload: &Value) -> std::path::PathBuf {
    let path = dir.join(name);
    fs::write(&path, serde_json::to_vec_pretty(payload).unwrap()).unwrap();
    path
}

fn inspect(registry: &Arc<TaskRegistry>, library: &Library, source_path: &Path) -> Value {
    invoke(
        registry,
        library,
        "migration.inspect@1",
        json!({ "sourcePath": source_path.to_string_lossy() }),
    )
}

fn inspect_err(registry: &Arc<TaskRegistry>, library: &Library, source_path: &Path) -> BridgeError {
    invoke_err(
        registry,
        library,
        "migration.inspect@1",
        json!({ "sourcePath": source_path.to_string_lossy() }),
    )
}

fn commit(registry: &Arc<TaskRegistry>, library: &Library, token: &str) -> Value {
    invoke(
        registry,
        library,
        "migration.commit@1",
        json!({ "token": token }),
    )
}

fn commit_err(registry: &Arc<TaskRegistry>, library: &Library, token: &str) -> BridgeError {
    invoke_err(
        registry,
        library,
        "migration.commit@1",
        json!({ "token": token }),
    )
}

fn put_existing_paper(registry: &Arc<TaskRegistry>, library: &Library, id: &str, title: &str) {
    invoke(
        registry,
        library,
        "library.putPaper@1",
        json!({
            "paper": {
                "id": id,
                "title": title,
                "addedAt": "2026-08-01T00:00:00Z",
                "updatedAt": "2026-08-01T00:00:00Z"
            }
        }),
    );
}

#[test]
fn inspect_valid_export_returns_stats_and_does_not_modify_library() {
    let (registry, library, dir) = common::env();
    put_existing_paper(&registry, &library, "paper-old", "已有论文");
    let path = write_export(
        dir.path(),
        "library.json",
        &envelope(vec![
            sample_browser_paper("paper-new", "新论文"),
            sample_browser_paper("paper-old", "导出会被跳过"),
            json!({ "title": "没有编号" }),
        ]),
    );

    let report = inspect(&registry, &library, &path);
    assert_eq!(report["schemaVersion"], json!(1));
    assert_eq!(report["format"], json!("paper-30min-library"));
    assert_eq!(report["formatVersion"], json!(1));
    assert_eq!(report["paperCount"], json!(3));
    assert_eq!(report["conflicts"]["new"], json!(1));
    assert_eq!(report["conflicts"]["existing"], json!(1));
    assert_eq!(report["conflicts"]["invalid"], json!(1));
    assert_eq!(report["apiKeyStripped"], json!(true));
    assert!(report["token"].as_str().unwrap().starts_with("mig-"));
    assert!(report["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert!(report.get("settings").is_none());
    assert!(report.get("apiKey").is_none());
    let errors = report["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1);
    assert!(errors[0]["message"].as_str().unwrap().contains("id"));

    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    assert_eq!(listed["papers"].as_array().unwrap().len(), 1);
    assert_eq!(listed["papers"][0]["id"], json!("paper-old"));
}

#[test]
fn inspect_corrupt_or_incompatible_export_does_not_issue_token() {
    let (registry, library, dir) = common::env();

    let not_json = dir.path().join("broken.json");
    fs::write(&not_json, "这不是 JSON").unwrap();
    let corrupt = inspect_err(&registry, &library, &not_json);
    assert_eq!(corrupt.code, "invalid_input");
    assert!(!corrupt.retryable);
    assert!(corrupt.message.contains("JSON"));

    let wrong_format = write_export(dir.path(), "other.json", &json!({ "format": "other", "version": 1, "papers": [] }));
    let format_err = inspect_err(&registry, &library, &wrong_format);
    assert_eq!(format_err.code, "invalid_input");

    let future = write_export(
        dir.path(),
        "v99.json",
        &json!({ "format": "paper-30min-library", "version": 99, "papers": [] }),
    );
    let version_err = inspect_err(&registry, &library, &future);
    assert_eq!(version_err.code, "unsupported_version");
    assert!(!version_err.retryable);
    assert_eq!(version_err.details.as_ref().unwrap()["found"], json!(99));

    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    assert_eq!(listed["papers"].as_array().unwrap().len(), 0);
}

#[test]
fn commit_merges_by_paper_id_and_imports_attachment_without_api_key() {
    let (registry, library, dir) = common::env();
    put_existing_paper(&registry, &library, "paper-old", "已有论文");
    let path = write_export(
        dir.path(),
        "library.json",
        &envelope(vec![
            sample_browser_paper("paper-new", "新论文"),
            sample_browser_paper("paper-old", "不应覆盖已有论文"),
        ]),
    );

    let token = inspect(&registry, &library, &path)["token"]
        .as_str()
        .unwrap()
        .to_string();
    let result = commit(&registry, &library, &token);
    assert_eq!(result["schemaVersion"], json!(1));
    assert_eq!(result["added"], json!(1));
    assert_eq!(result["skipped"], json!(1));
    assert_eq!(result["attachments"], json!(1));

    let existing = invoke(
        &registry,
        &library,
        "library.getPaper@1",
        json!({ "paperId": "paper-old" }),
    );
    assert_eq!(existing["paper"]["title"], json!("已有论文"));

    let imported = invoke(
        &registry,
        &library,
        "library.getPaper@1",
        json!({ "paperId": "paper-new" }),
    );
    let paper = &imported["paper"];
    assert_eq!(paper["title"], json!("新论文"));
    assert_eq!(paper["addedAt"], json!(ADDED_AT_ISO));
    assert_eq!(paper["sections"][0]["id"], json!("abstract"));
    assert_eq!(paper["sections"][0]["sourceText"], json!("摘要正文"));
    assert_eq!(paper["sections"][0]["pageStart"], json!(1));
    assert_eq!(paper["analyses"][0]["text"], json!("精读结果"));
    assert_eq!(paper["translations"][0]["language"], json!("zh"));
    assert_eq!(paper["recallCard"]["markdown"], json!("回想要点"));
    assert_eq!(paper["chat"][0]["role"], json!("user"));
    assert!(paper["chat"][0]["createdAt"].as_str().unwrap().ends_with('Z'));
    let dumped = serde_json::to_string(paper).unwrap();
    assert!(!dumped.contains("sk-secret"), "API Key 不得进入论文记录");
    assert!(paper.get("pdfBlob").is_none());
    assert!(paper.get("settings").is_none());

    let attachment = invoke(
        &registry,
        &library,
        "files.getAttachment@1",
        json!({ "paperId": "paper-new", "attachmentId": "pdf" }),
    );
    assert_eq!(attachment["attachment"]["name"], json!("attention.pdf"));
    assert_eq!(attachment["attachment"]["sha256"], json!(HELLO_PDF_SHA256));
    assert!(attachment["attachment"].get("path").is_none());
}

#[test]
fn changed_source_file_requires_reinspect_and_keeps_library() {
    let (registry, library, dir) = common::env();
    let path = write_export(
        dir.path(),
        "library.json",
        &envelope(vec![sample_browser_paper("paper-new", "新论文")]),
    );
    let token = inspect(&registry, &library, &path)["token"]
        .as_str()
        .unwrap()
        .to_string();

    fs::write(&path, "{ \"format\": \"paper-30min-library\", \"version\": 1, \"papers\": [] }").unwrap();
    let error = commit_err(&registry, &library, &token);
    assert_eq!(error.code, "source_changed");
    assert!(!error.retryable);

    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    assert_eq!(listed["papers"].as_array().unwrap().len(), 0);

    let again = inspect(&registry, &library, &path);
    assert_eq!(again["paperCount"], json!(0));
    assert_ne!(again["token"].as_str().unwrap(), token);
}

#[test]
fn expired_token_requires_reinspect_and_keeps_library() {
    let (registry, library, dir) = common::env();
    let path = write_export(
        dir.path(),
        "library.json",
        &envelope(vec![sample_browser_paper("paper-new", "新论文")]),
    );
    let report = invoke(
        &registry,
        &library,
        "migration.inspect@1",
        json!({
            "sourcePath": path.to_string_lossy(),
            "ttlSeconds": 0
        }),
    );
    let token = report["token"].as_str().unwrap();
    let error = commit_err(&registry, &library, token);
    assert_eq!(error.code, "token_expired");
    assert!(!error.retryable);

    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    assert_eq!(listed["papers"].as_array().unwrap().len(), 0);
}

#[test]
fn duplicate_commit_does_not_create_duplicate_papers() {
    let (registry, library, dir) = common::env();
    let path = write_export(
        dir.path(),
        "library.json",
        &envelope(vec![sample_browser_paper("paper-new", "新论文")]),
    );
    let token = inspect(&registry, &library, &path)["token"]
        .as_str()
        .unwrap()
        .to_string();
    commit(&registry, &library, &token);

    let error = commit_err(&registry, &library, &token);
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("令牌"));

    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    assert_eq!(listed["papers"].as_array().unwrap().len(), 1);

    let token2 = inspect(&registry, &library, &path)["token"]
        .as_str()
        .unwrap()
        .to_string();
    let second = commit(&registry, &library, &token2);
    assert_eq!(second["added"], json!(0));
    assert_eq!(second["skipped"], json!(1));
    let listed = invoke(&registry, &library, "library.listPapers@1", json!({}));
    assert_eq!(listed["papers"].as_array().unwrap().len(), 1);
}

#[test]
fn failed_commit_leaves_source_file_reusable() {
    let (registry, library, dir) = common::env();
    let path = write_export(
        dir.path(),
        "library.json",
        &envelope(vec![sample_browser_paper("paper-new", "新论文")]),
    );
    let original = fs::read(&path).unwrap();
    let token = inspect(&registry, &library, &path)["token"]
        .as_str()
        .unwrap()
        .to_string();
    fs::write(&path, "CORRUPT").unwrap();
    let error = commit_err(&registry, &library, &token);
    assert_eq!(error.code, "source_changed");
    assert!(path.is_file(), "提交失败不得删除原导出文件");
    assert_eq!(fs::read_to_string(&path).unwrap(), "CORRUPT", "提交失败不得改写源文件");

    fs::write(&path, original).unwrap();
    let restored = inspect(&registry, &library, &path);
    assert_eq!(restored["paperCount"], json!(1));
    let committed = commit(&registry, &library, restored["token"].as_str().unwrap());
    assert_eq!(committed["added"], json!(1));
}

#[test]
fn app_info_lists_migration_commands() {
    let (registry, library, _dir) = common::env();
    let info = invoke(&registry, &library, "app.info@1", json!({}));
    for name in ["migration.inspect@1", "migration.commit@1"] {
        assert!(
            info["commands"].as_array().unwrap().iter().any(|item| item == name),
            "app.info 未列出 {name}"
        );
    }
}
