//! 网络抓取任务外部行为契约：net.fetch-text@1 与 files.download@1 只通过任务事件流、
//! 快照与版本化 files.*@1 命令观察；上游 HTTP 由 testkit 的 mock 服务器提供。

mod common;

use base64::Engine;
use paper30min_lib::bridge;
use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::{wait_terminal, Collector, MockHttp, MockResponse};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;

fn terminal(registry: &Arc<TaskRegistry>, task_id: &str) -> TaskStatus {
    wait_terminal(registry, task_id, Duration::from_secs(15)).expect("任务未在超时内到达终态")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn put_paper(registry: &Arc<TaskRegistry>, library: &paper30min_lib::library::Library, id: &str) {
    bridge::invoke(
        registry,
        library,
        "library.putPaper@1",
        &json!({ "paper": { "id": id, "title": "下载论文" } }),
    )
    .expect("写入论文");
}

fn download_input(registry_url: &str) -> Value {
    json!({
        "paperId": "paper-dl",
        "attachmentId": "pdf",
        "name": "dl.pdf",
        "contentType": "application/pdf",
        "url": registry_url,
    })
}

#[test]
fn fetch_text_returns_full_text_and_progress() {
    let (registry, _library, _dir) = common::env();
    let body = "抓取文本内容：多字节字符也要完整。";
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/text" {
            MockResponse::bytes(200, "text/plain; charset=utf-8", body.as_bytes().to_vec())
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    let sink = Collector::new();
    let task_id = registry
        .start("net.fetch-text@1", json!({ "url": mock.url("/text") }), sink.clone())
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let events = sink.events();
    let chunks: Vec<String> = events
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(chunks, vec![body.to_string()], "完成后应只发一个全文 chunk");
    let progresses: Vec<_> = events.iter().filter_map(|event| event.progress.clone()).collect();
    assert!(
        progresses.iter().any(|p| p.done == body.len() as u64 && p.total == body.len() as u64),
        "进度应报到 Content-Length: {progresses:?}"
    );
    let snapshot = registry.get(&task_id).unwrap();
    assert!(snapshot.result.is_none(), "net.fetch-text 不带 result");
}

#[test]
fn fetch_text_over_limit_fails_too_large() {
    let (registry, _library, _dir) = common::env();
    let body = vec![b'x'; 64 * 1024];
    let mock = MockHttp::start(move |_request, _hit| {
        MockResponse::bytes(200, "application/octet-stream", body.clone())
    });
    let sink = Collector::new();
    let task_id = registry
        .start(
            "net.fetch-text@1",
            json!({ "url": mock.url("/big"), "maxBytes": 1024 }),
            sink,
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "too_large");
    assert!(!error.retryable);
    assert_eq!(mock.hits(), 1, "too_large 不应重试");
}

#[test]
fn fetch_text_5xx_retries_then_succeeds() {
    let (registry, _library, _dir) = common::env();
    let mock = MockHttp::start(|_request, hit| {
        if hit == 1 {
            MockResponse::json(500, json!({"error": {"message": "boom"}}))
        } else {
            MockResponse::bytes(200, "text/plain", "重试后的文本")
        }
    });
    let sink = Collector::new();
    let task_id = registry
        .start("net.fetch-text@1", json!({ "url": mock.url("/flaky") }), sink.clone())
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    assert_eq!(mock.hits(), 2);
    assert!(
        sink.events().iter().any(|event| event.status == TaskStatus::RetryWaiting),
        "5xx 应转 retry_waiting"
    );
    let text: String = sink
        .events()
        .iter()
        .filter(|event| event.event == "chunk")
        .filter_map(|event| event.chunk.clone())
        .collect();
    assert_eq!(text, "重试后的文本");
}

#[test]
fn fetch_text_rejects_non_http_scheme() {
    let (registry, _library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| MockResponse::bytes(200, "text/plain", "unused"));
    let sink = Collector::new();
    let task_id = registry
        .start("net.fetch-text@1", json!({ "url": "file:///etc/passwd" }), sink)
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "invalid_input");
    assert!(!error.retryable);
    assert_eq!(mock.hits(), 0, "scheme 非法不应发请求");
}

#[test]
fn fetch_text_plan_requires_url() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let error = registry.start("net.fetch-text@1", json!({}), sink).unwrap_err();
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn download_stores_attachment_with_metadata_and_result() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-dl");
    let body: Vec<u8> = (0..300_000_u32).map(|i| (i % 251) as u8).collect();
    let expected_sha256 = sha256_hex(&body);
    let mock = MockHttp::start(move |_request, _hit| {
        MockResponse::bytes(200, "application/octet-stream", body.clone())
    });
    let sink = Collector::new();
    let task_id = registry
        .start("files.download@1", download_input(&mock.url("/file")), sink.clone())
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    // succeeded 携带 result.attachment。
    let snapshot = registry.get(&task_id).unwrap();
    let result = snapshot.result.expect("succeeded 应携带 result");
    let attachment = &result["attachment"];
    assert_eq!(attachment["paperId"], json!("paper-dl"));
    assert_eq!(attachment["id"], json!("pdf"));
    assert_eq!(attachment["name"], json!("dl.pdf"));
    assert_eq!(attachment["contentType"], json!("application/pdf"));
    assert_eq!(attachment["size"], json!(300_000));
    assert_eq!(attachment["sha256"], json!(expected_sha256));
    assert!(attachment.get("path").is_none(), "DTO 不得暴露绝对路径");

    // files.getAttachment@1 元数据与 result.attachment 一致。
    let loaded = bridge::invoke(
        &registry,
        &library,
        "files.getAttachment@1",
        &json!({ "paperId": "paper-dl", "attachmentId": "pdf" }),
    )
    .unwrap();
    assert_eq!(loaded["attachment"], *attachment);

    // 落盘内容与范围读取正确。
    let stored = dir.path().join("attachments").join("paper-dl").join("pdf");
    assert!(stored.is_file());
    let range = bridge::invoke(
        &registry,
        &library,
        "files.readRange@1",
        &json!({ "paperId": "paper-dl", "attachmentId": "pdf", "offset": 0, "length": 16 }),
    )
    .unwrap();
    let expected: String = base64::engine::general_purpose::STANDARD.encode(&[
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    assert_eq!(range["contentBase64"], json!(expected));
    assert!(
        !dir.path().join("attachments").join("paper-dl").join("pdf.part").exists(),
        "成功后不应留下 .part 临时文件"
    );
    // 完整性校验通过。
    bridge::invoke(
        &registry,
        &library,
        "files.verifyAttachment@1",
        &json!({ "paperId": "paper-dl", "attachmentId": "pdf" }),
    )
    .unwrap();
    // 下载进度报到 Content-Length。
    assert!(sink
        .events()
        .iter()
        .filter_map(|event| event.progress.clone())
        .any(|p| p.done == 300_000 && p.total == 300_000));
}

#[test]
fn download_defaults_content_type_to_octet_stream() {
    let (registry, library, _dir) = common::env();
    put_paper(&registry, &library, "paper-dl");
    let mock = MockHttp::start(|_request, _hit| MockResponse::bytes(200, "application/octet-stream", b"bin".to_vec()));
    let sink = Collector::new();
    let mut input = download_input(&mock.url("/file"));
    input.as_object_mut().unwrap().remove("contentType");
    let task_id = registry.start("files.download@1", input, sink).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let result = registry.get(&task_id).unwrap().result.unwrap();
    assert_eq!(result["attachment"]["contentType"], json!("application/octet-stream"));
}

#[test]
fn download_missing_paper_fails_not_found_before_request() {
    let (registry, _library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| MockResponse::bytes(200, "application/octet-stream", b"x".to_vec()));
    let sink = Collector::new();
    let task_id = registry
        .start("files.download@1", download_input(&mock.url("/file")), sink)
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "not_found");
    assert!(!error.retryable);
    assert_eq!(mock.hits(), 0, "论文不存在应在下载前失败");
}

#[test]
fn download_over_limit_cleans_part_and_fails() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-dl");
    let body = vec![b'y'; 64 * 1024];
    let mock = MockHttp::start(move |_request, _hit| {
        MockResponse::bytes(200, "application/octet-stream", body.clone())
    });
    let sink = Collector::new();
    let mut input = download_input(&mock.url("/big"));
    input.as_object_mut().unwrap().insert("maxBytes".to_string(), json!(1024));
    let task_id = registry.start("files.download@1", input, sink).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "too_large");
    assert!(!error.retryable);
    assert!(
        !dir.path().join("attachments").join("paper-dl").join("pdf.part").exists(),
        "超限应清理 .part"
    );
    assert!(
        !dir.path().join("attachments").join("paper-dl").join("pdf").exists(),
        "超限不应留下就位文件"
    );
    let missing = bridge::invoke(
        &registry,
        &library,
        "files.getAttachment@1",
        &json!({ "paperId": "paper-dl", "attachmentId": "pdf" }),
    )
    .unwrap_err();
    assert_eq!(missing.code, "not_found");
}

#[test]
fn download_retries_after_500_then_succeeds() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "paper-dl");
    let body = b"retry-download-body".to_vec();
    let expected_sha256 = sha256_hex(&body);
    let mock = MockHttp::start(move |_request, hit| {
        if hit == 1 {
            MockResponse::json(500, json!({"error": {"message": "boom"}}))
        } else {
            MockResponse::bytes(200, "application/octet-stream", body.clone())
        }
    });
    let sink = Collector::new();
    let task_id = registry
        .start("files.download@1", download_input(&mock.url("/file")), sink.clone())
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    assert_eq!(mock.hits(), 2, "整文件重下，共两次尝试");
    assert!(sink
        .events()
        .iter()
        .any(|event| event.status == TaskStatus::RetryWaiting));
    let stored = dir.path().join("attachments").join("paper-dl").join("pdf");
    assert_eq!(std::fs::read(&stored).unwrap(), b"retry-download-body");
    let loaded = bridge::invoke(
        &registry,
        &library,
        "files.getAttachment@1",
        &json!({ "paperId": "paper-dl", "attachmentId": "pdf" }),
    )
    .unwrap();
    assert_eq!(loaded["attachment"]["sha256"], json!(expected_sha256));
}

#[test]
fn download_rejects_unsafe_segments_at_start() {
    let (registry, library, _dir) = common::env();
    put_paper(&registry, &library, "paper-dl");
    let sink = Collector::new();
    for (field, value) in [
        ("paperId", ".."),
        ("paperId", "../exports"),
        ("attachmentId", "../x"),
        ("attachmentId", ".part"),
        ("name", "a/b"),
    ] {
        let mut input = download_input("http://127.0.0.1:1/unused");
        input.as_object_mut().unwrap().insert(field.to_string(), json!(value));
        let error = registry.start("files.download@1", input, sink.clone()).unwrap_err();
        assert_eq!(error.code, "invalid_input", "{field}={value} 应在启动时拒绝");
        assert!(!error.retryable);
    }
}
