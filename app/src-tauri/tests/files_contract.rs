//! 附件与 PDF 外部行为契约：只通过版本化 `files.*@1` 命令观察 DTO，
//! 不读取 SQLite 表结构，也不把绝对路径当作前端契约。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::sync::Arc;

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

fn sample_paper(id: &str) -> Value {
    json!({
        "paper": {
            "id": id,
            "title": "注意力论文",
            "addedAt": "2026-09-01T08:00:00Z",
            "updatedAt": "2026-09-01T09:00:00Z"
        }
    })
}

fn put_paper(registry: &Arc<TaskRegistry>, library: &Library, id: &str) {
    invoke(registry, library, "library.putPaper@1", sample_paper(id));
}

/// 9 字节固定内容，便于断言范围读取与完整性。
const HELLO_PDF: &str = "hello-pdf";
const HELLO_PDF_B64: &str = "aGVsbG8tcGRm";
const HELLO_PDF_SHA256: &str = "787039b5a469fb8e720be530ac94788a4a85c6b81b786efa5a2727738cfa8a6a";

fn put_pdf_input(paper_id: &str, attachment_id: &str, name: &str) -> Value {
    json!({
        "paperId": paper_id,
        "attachment": {
            "id": attachment_id,
            "name": name,
            "contentType": "application/pdf",
            "contentBase64": HELLO_PDF_B64
        }
    })
}

#[test]
fn put_attachment_round_trips_metadata_without_absolute_path() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-a");

    let saved = invoke(
        &registry,
        &library,
        "files.putAttachment@1",
        put_pdf_input("paper-a", "pdf", "attention.pdf"),
    );
    assert_eq!(saved["schemaVersion"], json!(1));
    let attachment = &saved["attachment"];
    assert_eq!(attachment["paperId"], json!("paper-a"));
    assert_eq!(attachment["id"], json!("pdf"));
    assert_eq!(attachment["name"], json!("attention.pdf"));
    assert_eq!(attachment["contentType"], json!("application/pdf"));
    assert_eq!(attachment["size"], json!(9));
    assert_eq!(attachment["sha256"], json!(HELLO_PDF_SHA256));
    assert!(attachment.get("path").is_none(), "DTO 不得暴露绝对路径");
    assert!(attachment.get("absolutePath").is_none());
    assert!(
        attachment["createdAt"].as_str().unwrap().ends_with('Z'),
        "createdAt 必须是 ISO 8601 UTC"
    );

    let listed = invoke(
        &registry,
        &library,
        "files.listAttachments@1",
        json!({ "paperId": "paper-a" }),
    );
    assert_eq!(listed["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(listed["attachments"][0]["id"], json!("pdf"));
    assert!(listed["attachments"][0].get("path").is_none());

    let loaded = invoke(
        &registry,
        &library,
        "files.getAttachment@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf" }),
    );
    assert_eq!(loaded["attachment"], saved["attachment"]);

    let stored = dir.path().join("attachments").join("paper-a").join("pdf");
    assert!(stored.is_file(), "附件应按论文分区落在 attachments/{{paperId}}/");
    assert_eq!(std::fs::read_to_string(&stored).unwrap(), HELLO_PDF);
    assert!(
        !dir.path().join("attachments").join("paper-a").join("pdf.part").exists(),
        "成功写入后不应留下临时文件"
    );
}

#[test]
fn escaped_paths_are_rejected_and_do_not_write_outside_attachments() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-a");
    let exports = dir.path().join("exports");
    assert!(exports.is_dir());

    for paper_id in ["../exports", "..\\exports", "paper-a/../exports", ".", ".."] {
        let error = invoke_err(
            &registry,
            &library,
            "files.putAttachment@1",
            put_pdf_input(paper_id, "pdf", "attention.pdf"),
        );
        assert_eq!(error.code, "invalid_input", "paperId={paper_id}");
        assert!(!error.retryable);
    }
    for attachment_id in ["../x", "..\\x", "pdf/../x", "pdf\\x", ".part"] {
        let error = invoke_err(
            &registry,
            &library,
            "files.putAttachment@1",
            put_pdf_input("paper-a", attachment_id, "attention.pdf"),
        );
        assert_eq!(error.code, "invalid_input", "attachmentId={attachment_id}");
    }

    let mut outside = std::fs::read_dir(&exports).unwrap();
    assert!(outside.next().is_none(), "越界路径不得在 exports/ 留下文件");
    let attachment_entries: Vec<_> = std::fs::read_dir(dir.path().join("attachments"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(
        attachment_entries.iter().all(|name| name != std::ffi::OsStr::new("..")
            && name != std::ffi::OsStr::new("exports")),
        "attachments/ 下不应出现逃逸目录项: {attachment_entries:?}"
    );
}

#[test]
fn leftover_temp_file_is_not_usable_and_cleanup_removes_it() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-a");
    let paper_dir = dir.path().join("attachments").join("paper-a");
    std::fs::create_dir_all(&paper_dir).unwrap();
    let part = paper_dir.join("pdf.part");
    std::fs::write(&part, "HALF-WRITTEN").unwrap();

    let listed = invoke(
        &registry,
        &library,
        "files.listAttachments@1",
        json!({ "paperId": "paper-a" }),
    );
    assert_eq!(listed["attachments"].as_array().unwrap().len(), 0);

    let missing = invoke_err(
        &registry,
        &library,
        "files.getAttachment@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf" }),
    );
    assert_eq!(missing.code, "not_found");

    let cleaned = invoke(&registry, &library, "files.cleanupTemps@1", json!({}));
    assert_eq!(cleaned["removed"], json!(1));
    assert!(!part.exists(), "清理后不应留下 .part 临时文件");
}

#[test]
fn reopen_discards_leftover_temp_files() {
    let dir = tempfile::tempdir().unwrap();
    let registry = TaskRegistry::new();
    {
        let library = Library::open(dir.path()).unwrap();
        put_paper(&registry, &library, "paper-a");
    }
    let part = dir.path().join("attachments").join("paper-a").join("pdf.part");
    std::fs::create_dir_all(part.parent().unwrap()).unwrap();
    std::fs::write(&part, "HALF-WRITTEN").unwrap();
    let library = Library::open(dir.path()).unwrap();
    assert!(!part.exists(), "重开书库时应清掉中断留下的临时文件");
    let listed = invoke(
        &registry,
        &library,
        "files.listAttachments@1",
        json!({ "paperId": "paper-a" }),
    );
    assert_eq!(listed["attachments"].as_array().unwrap().len(), 0);
}

#[test]
fn corrupt_or_missing_file_fails_integrity_checks() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-a");
    invoke(
        &registry,
        &library,
        "files.putAttachment@1",
        put_pdf_input("paper-a", "pdf", "attention.pdf"),
    );
    let stored = dir.path().join("attachments").join("paper-a").join("pdf");

    std::fs::write(&stored, "corrupted").unwrap();
    let size_error = invoke_err(
        &registry,
        &library,
        "files.verifyAttachment@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf" }),
    );
    assert_eq!(size_error.code, "integrity_failed");
    assert!(!size_error.retryable);

    std::fs::write(&stored, "hello-pdX").unwrap();
    let hash_error = invoke_err(
        &registry,
        &library,
        "files.verifyAttachment@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf" }),
    );
    assert_eq!(hash_error.code, "integrity_failed");

    std::fs::remove_file(&stored).unwrap();
    let missing = invoke_err(
        &registry,
        &library,
        "files.readRange@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf", "offset": 0, "length": 4 }),
    );
    assert_eq!(missing.code, "integrity_failed");
}

#[test]
fn read_range_returns_requested_bytes_without_path() {
    let (registry, library, _dir) = common::env();
    put_paper(&registry, &library, "paper-a");
    invoke(
        &registry,
        &library,
        "files.putAttachment@1",
        put_pdf_input("paper-a", "pdf", "attention.pdf"),
    );

    let range = invoke(
        &registry,
        &library,
        "files.readRange@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf", "offset": 2, "length": 4 }),
    );
    assert_eq!(range["schemaVersion"], json!(1));
    assert_eq!(range["offset"], json!(2));
    assert_eq!(range["length"], json!(4));
    assert_eq!(range["totalSize"], json!(9));
    assert_eq!(range["contentBase64"], json!("bGxvLQ=="));
    assert!(range["attachment"].get("path").is_none());

    let tail = invoke(
        &registry,
        &library,
        "files.readRange@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf", "offset": 6, "length": 100 }),
    );
    assert_eq!(tail["length"], json!(3));
    assert_eq!(tail["contentBase64"], json!("cGRm"));
}

#[test]
fn delete_paper_removes_attachments_with_records() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-a");
    invoke(
        &registry,
        &library,
        "files.putAttachment@1",
        put_pdf_input("paper-a", "pdf", "attention.pdf"),
    );
    let paper_dir = dir.path().join("attachments").join("paper-a");
    assert!(paper_dir.join("pdf").is_file());

    invoke(
        &registry,
        &library,
        "library.deletePaper@1",
        json!({ "paperId": "paper-a" }),
    );
    assert!(!paper_dir.exists(), "删除论文后应去掉该论文附件目录");
    let missing = invoke_err(
        &registry,
        &library,
        "files.getAttachment@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf" }),
    );
    assert_eq!(missing.code, "not_found");
}

#[test]
fn restart_restores_attachment_and_app_info_lists_file_commands() {
    let dir = tempfile::tempdir().unwrap();
    let registry = TaskRegistry::new();
    {
        let library = Library::open(dir.path()).unwrap();
        put_paper(&registry, &library, "paper-a");
        invoke(
            &registry,
            &library,
            "files.putAttachment@1",
            put_pdf_input("paper-a", "pdf", "attention.pdf"),
        );
    }
    let library = Library::open(dir.path()).unwrap();
    let loaded = invoke(
        &registry,
        &library,
        "files.getAttachment@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf" }),
    );
    assert_eq!(loaded["attachment"]["sha256"], json!(HELLO_PDF_SHA256));
    let range = invoke(
        &registry,
        &library,
        "files.readRange@1",
        json!({ "paperId": "paper-a", "attachmentId": "pdf", "offset": 0, "length": 9 }),
    );
    assert_eq!(range["contentBase64"], json!(HELLO_PDF_B64));

    let info = invoke(&registry, &library, "app.info@1", json!({}));
    for name in [
        "files.putAttachment@1",
        "files.listAttachments@1",
        "files.getAttachment@1",
        "files.readRange@1",
        "files.verifyAttachment@1",
        "files.cleanupTemps@1",
    ] {
        assert!(
            info["commands"].as_array().unwrap().iter().any(|item| item == name),
            "app.info 未列出 {name}"
        );
    }
}
