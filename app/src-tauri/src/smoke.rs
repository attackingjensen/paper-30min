//! 可重复冒烟命令：`paper30min --bridge-smoke`（debug 构建，保留控制台输出）。
//! 不开窗口，直接验证桥接外部行为：版本化命令、统一错误、任务事件流、取消与任务查询。
//! 全部通过时进程退出码为 0，否则为 1。

use serde_json::{json, Value};
use std::time::Duration;

use base64::Engine;

use crate::bridge;
use crate::library::Library;
use crate::tasks::{TaskRegistry, TaskStatus};
use crate::testkit::{wait_terminal, Collector, MockHttp, MockResponse};

fn scratch_library() -> (std::path::PathBuf, Library) {
    let root = std::env::temp_dir().join(format!(
        "paper30min-smoke-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&root);
    let library = Library::open(&root).expect("打开冒烟书库");
    (root, library)
}

fn check(name: &str, f: impl FnOnce() -> Result<String, String>, report: &mut Vec<Value>) {
    let (pass, detail) = match f() {
        Ok(detail) => (true, detail),
        Err(detail) => (false, detail),
    };
    report.push(json!({ "check": name, "pass": pass, "detail": detail }));
}

pub fn run() -> i32 {
    let mut report: Vec<Value> = Vec::new();
    let (root, library) = scratch_library();
    // 注册表与命令分发共享同一份书库句柄（&Arc<Library> 自动 deref 成 &Library）。
    let library = std::sync::Arc::new(library);
    let registry = TaskRegistry::new(std::sync::Arc::clone(&library));

    check(
        "app.info@1 返回 schemaVersion",
        || match bridge::invoke(&registry, &library, "app.info@1", &json!({})) {
            Ok(value) if value["schemaVersion"] == json!(1) => Ok("schemaVersion=1".to_string()),
            Ok(value) => Err(format!("schemaVersion 不符: {value}")),
            Err(error) => Err(format!("调用失败: {error}")),
        },
        &mut report,
    );

    check(
        "bridge.echo@1 原样回显",
        || {
            let input = json!({ "message": "桥接自检", "n": 1 });
            match bridge::invoke(&registry, &library, "bridge.echo@1", &input) {
                Ok(value) if value["echo"] == input => Ok("回显一致".to_string()),
                Ok(value) => Err(format!("回显不符: {value}")),
                Err(error) => Err(format!("调用失败: {error}")),
            }
        },
        &mut report,
    );

    check(
        "未知命令返回统一错误结构",
        || match bridge::invoke(&registry, &library, "no.such-command@1", &json!({})) {
            Err(error) if error.code == "unknown_command" && !error.retryable => {
                Ok("code=unknown_command retryable=false".to_string())
            }
            Err(error) => Err(format!("错误结构不符: {error:?}")),
            Ok(value) => Err(format!("未知命令不应成功: {value}")),
        },
        &mut report,
    );

    check(
        "demo.stream-text@1 任务事件流完整",
        || {
            let sink = Collector::new();
            let text = "桥接冒烟测试文本";
            let task_id = registry
                .start(
                    "demo.stream-text@1",
                    json!({ "text": text, "chunks": 4, "chunkDelayMs": 5 }),
                    sink.clone(),
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            match wait_terminal(&registry, &task_id, Duration::from_secs(5)) {
                Some(TaskStatus::Succeeded) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let events = sink.events();
            let reassembled: String = events
                .iter()
                .filter(|event| event.event == "chunk")
                .filter_map(|event| event.chunk.clone())
                .collect();
            if reassembled != text {
                return Err(format!("流式内容拼接不符: {reassembled:?}"));
            }
            let final_event = events.last().ok_or("没有事件")?;
            if final_event.event != "status" || final_event.status != TaskStatus::Succeeded {
                return Err("末尾不是成功状态事件".to_string());
            }
            Ok(format!("{} 个事件，内容一致", events.len()))
        },
        &mut report,
    );

    check(
        "取消请求幂等且任务在安全检查点停止",
        || {
            let sink = Collector::new();
            let task_id = registry
                .start(
                    "demo.stream-text@1",
                    json!({ "chunks": 100, "chunkDelayMs": 20 }),
                    sink,
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            let first = registry
                .request_cancel(&task_id)
                .map_err(|error| format!("取消失败: {error}"))?;
            if first.status != TaskStatus::CancelRequested {
                return Err(format!("取消后状态不符: {:?}", first.status));
            }
            match wait_terminal(&registry, &task_id, Duration::from_secs(5)) {
                Some(TaskStatus::Cancelled) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let again = registry
                .request_cancel(&task_id)
                .map_err(|error| format!("重复取消失败: {error}"))?;
            if again.status != TaskStatus::Cancelled {
                return Err(format!("重复取消不应改变终态: {:?}", again.status));
            }
            Ok("cancel_requested -> cancelled，重复取消幂等".to_string())
        },
        &mut report,
    );

    check(
        "关闭前运行中任务查询只返回非终态任务",
        || {
            let sink = Collector::new();
            let running_id = registry
                .start(
                    "demo.stream-text@1",
                    json!({ "chunks": 100, "chunkDelayMs": 20 }),
                    sink,
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            let active = registry.list(true);
            if !active.iter().any(|task| task.task_id == running_id) {
                return Err("运行中任务未出现在活动查询里".to_string());
            }
            registry.cancel_all_active();
            match wait_terminal(&registry, &running_id, Duration::from_secs(5)) {
                Some(TaskStatus::Cancelled) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            if registry.list(true).iter().any(|task| task.task_id == running_id) {
                return Err("已取消任务仍出现在活动查询里".to_string());
            }
            Ok("活动查询与取消批量操作正常".to_string())
        },
        &mut report,
    );

    check(
        "library.info@1 创建版本化书库目录",
        || match bridge::invoke(&registry, &library, "library.info@1", &json!({})) {
            Ok(value)
                if value["databaseVersion"] == json!(3)
                    && value["partitions"]
                        .as_array()
                        .map(|items| items.iter().any(|item| item == "database"))
                        .unwrap_or(false) =>
            {
                Ok("databaseVersion=3".to_string())
            }
            Ok(value) => Err(format!("书库信息不符: {value}")),
            Err(error) => Err(format!("调用失败: {error}")),
        },
        &mut report,
    );

    check(
        "settings 存取往返",
        || {
            bridge::invoke(
                &registry,
                &library,
                "settings.putModel@1",
                &json!({ "settings": { "model": "smoke-model", "temperature": 0.8 } }),
            )
            .map_err(|error| format!("写入设置失败: {error}"))?;
            let loaded = bridge::invoke(&registry, &library, "settings.get@1", &json!({}))
                .map_err(|error| format!("读取设置失败: {error}"))?;
            if loaded["model"]["model"] != json!("smoke-model")
                || loaded["model"]["temperature"] != json!(0.8)
                || loaded["model"]["maxTokens"] != json!(4096)
            {
                return Err(format!("设置往返不符: {loaded}"));
            }
            Ok("模型设置写入后可读回，缺省字段保持缺省值".to_string())
        },
        &mut report,
    );

    check(
        "skills.list@1 返回五条技能",
        || match bridge::invoke(&registry, &library, "skills.list@1", &json!({})) {
            Ok(value) if value["skills"].as_array().map(|items| items.len()) == Some(5) => {
                Ok("5 条技能".to_string())
            }
            Ok(value) => Err(format!("技能数量不符: {value}")),
            Err(error) => Err(format!("调用失败: {error}")),
        },
        &mut report,
    );

    check(
        "exports.write@1 落入 exports 分区",
        || {
            let written = bridge::invoke(
                &registry,
                &library,
                "exports.write@1",
                &json!({ "fileName": "smoke-export.md", "contentBase64": "aGVsbG8=" }),
            )
            .map_err(|error| format!("写导出失败: {error}"))?;
            if written["location"] != json!("exports") || written["fileName"] != json!("smoke-export.md") {
                return Err(format!("导出结果不符: {written}"));
            }
            let bytes = std::fs::read(root.join("exports").join("smoke-export.md"))
                .map_err(|error| format!("读取导出文件失败: {error}"))?;
            if bytes != b"hello" {
                return Err("导出内容与输入不一致".to_string());
            }
            Ok("location=exports，字节一致".to_string())
        },
        &mut report,
    );

    check(
        "model.chat@1 流式输出（mock SSE）",
        || {
            let mock = MockHttp::start(|request, _hit| {
                if request.path == "/v1/chat/completions" {
                    MockResponse::sse(
                        vec![
                            json!({"choices": [{"delta": {"content": "冒烟"}}]}).to_string(),
                            json!({"choices": [{"delta": {"content": "流式"}}]}).to_string(),
                            "[DONE]".to_string(),
                        ],
                        Duration::from_millis(5),
                    )
                } else {
                    MockResponse::json(404, json!({"error": {"message": "no such route"}}))
                }
            });
            bridge::invoke(
                &registry,
                &library,
                "settings.putModel@1",
                &json!({ "settings": { "baseUrl": mock.url(""), "apiKey": "sk-smoke", "model": "smoke-model" } }),
            )
            .map_err(|error| format!("写入模型设置失败: {error}"))?;
            let sink = Collector::new();
            let task_id = registry
                .start(
                    "model.chat@1",
                    json!({ "messages": [{ "role": "user", "content": "你好" }] }),
                    sink.clone(),
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            match wait_terminal(&registry, &task_id, Duration::from_secs(10)) {
                Some(TaskStatus::Succeeded) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let text: String = sink
                .events()
                .iter()
                .filter(|event| event.event == "chunk")
                .filter_map(|event| event.chunk.clone())
                .collect();
            if text != "冒烟流式" {
                return Err(format!("流式内容拼接不符: {text:?}"));
            }
            let requests = mock.requests();
            let request = requests.first().ok_or("mock 未收到请求")?;
            if request.header("authorization") != Some("Bearer sk-smoke") {
                return Err("Authorization 头不符".to_string());
            }
            let ua = request.header("user-agent").unwrap_or("");
            if !ua.contains("Mozilla/5.0") {
                return Err(format!("User-Agent 不是浏览器 UA: {ua}"));
            }
            Ok("SSE 增量按序拼接，请求带鉴权与浏览器 UA".to_string())
        },
        &mut report,
    );

    check(
        "net.fetch-text@1 返回文本（mock）",
        || {
            let mock = MockHttp::start(|request, _hit| {
                if request.path == "/paper" {
                    MockResponse::bytes(200, "text/plain; charset=utf-8", "论文正文冒烟文本")
                } else {
                    MockResponse::json(404, json!({"error": {"message": "no such route"}}))
                }
            });
            let sink = Collector::new();
            let task_id = registry
                .start(
                    "net.fetch-text@1",
                    json!({ "url": mock.url("/paper") }),
                    sink.clone(),
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            match wait_terminal(&registry, &task_id, Duration::from_secs(10)) {
                Some(TaskStatus::Succeeded) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let chunks: Vec<String> = sink
                .events()
                .iter()
                .filter(|event| event.event == "chunk")
                .filter_map(|event| event.chunk.clone())
                .collect();
            if chunks != vec!["论文正文冒烟文本".to_string()] {
                return Err(format!("抓取文本不符: {chunks:?}"));
            }
            let snapshot = registry.get(&task_id).ok_or("任务快照缺失")?;
            if snapshot.progress.as_ref().map(|p| p.done) != Some("论文正文冒烟文本".len() as u64) {
                return Err(format!("进度不符: {:?}", snapshot.progress));
            }
            Ok("单 chunk 全文与字节进度正确".to_string())
        },
        &mut report,
    );

    check(
        "files.download@1 落盘并登记元数据（mock）",
        || {
            bridge::invoke(
                &registry,
                &library,
                "library.putPaper@1",
                &json!({ "paper": { "id": "smoke-download", "title": "下载冒烟论文" } }),
            )
            .map_err(|error| format!("写入论文失败: {error}"))?;
            let body: Vec<u8> = (0..50_000_u32).map(|i| (i % 251) as u8).collect();
            let expected_sha256 = crate::files::sha256_hex(&body);
            let mock = MockHttp::start(move |_request, _hit| {
                MockResponse::bytes(200, "application/octet-stream", body.clone())
            });
            let sink = Collector::new();
            let task_id = registry
                .start(
                    "files.download@1",
                    json!({
                        "paperId": "smoke-download",
                        "attachmentId": "pdf",
                        "name": "smoke.pdf",
                        "contentType": "application/pdf",
                        "url": mock.url("/file"),
                    }),
                    sink,
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            match wait_terminal(&registry, &task_id, Duration::from_secs(10)) {
                Some(TaskStatus::Succeeded) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let snapshot = registry.get(&task_id).ok_or("任务快照缺失")?;
            let result = snapshot.result.ok_or("succeeded 未携带 result")?;
            if result["attachment"]["id"] != json!("pdf")
                || result["attachment"]["sha256"] != json!(expected_sha256)
                || result["attachment"]["size"] != json!(50_000)
            {
                return Err(format!("result.attachment 不符: {result}"));
            }
            let loaded = bridge::invoke(
                &registry,
                &library,
                "files.getAttachment@1",
                &json!({ "paperId": "smoke-download", "attachmentId": "pdf" }),
            )
            .map_err(|error| format!("读取附件元数据失败: {error}"))?;
            if loaded["attachment"]["sha256"] != json!(expected_sha256)
                || loaded["attachment"]["contentType"] != json!("application/pdf")
            {
                return Err(format!("元数据不符: {loaded}"));
            }
            if root.join("attachments").join("smoke-download").join("pdf.part").exists() {
                return Err("成功后不应留下 .part 临时文件".to_string());
            }
            Ok("落盘、sha256、contentType 与 result.attachment 一致".to_string())
        },
        &mut report,
    );

    check(
        "论文、阅读位置、附件与浏览器迁移可写入并在重开后恢复",
        || {
            let paper = json!({
                "paper": {
                    "id": "smoke-paper",
                    "title": "冒烟论文",
                    "addedAt": "2026-09-05T00:00:00Z",
                    "updatedAt": "2026-09-05T00:00:00Z",
                    "analyses": [
                        { "sectionId": "abstract", "text": "精读", "updatedAt": "2026-09-05T00:00:00Z" }
                    ]
                }
            });
            bridge::invoke(&registry, &library, "library.putPaper@1", &paper)
                .map_err(|error| format!("写入论文失败: {error}"))?;
            bridge::invoke(
                &registry,
                &library,
                "library.putReadingPosition@1",
                &json!({ "position": { "paperId": "smoke-paper", "view": "digest", "sectionId": "abstract" } }),
            )
            .map_err(|error| format!("写入阅读位置失败: {error}"))?;
            let bytes = base64::engine::general_purpose::STANDARD.encode(b"hello-pdf");
            bridge::invoke(
                &registry,
                &library,
                "files.putAttachment@1",
                &json!({
                    "paperId": "smoke-paper",
                    "attachment": {
                        "id": "pdf",
                        "name": "smoke.pdf",
                        "contentType": "application/pdf",
                        "contentBase64": bytes
                    }
                }),
            )
            .map_err(|error| format!("写入附件失败: {error}"))?;
            // 注册表持有书库句柄无法 drop；另开一条连接只读到已提交数据，同样验证持久化。
            let reopened = Library::open(&root).map_err(|error| format!("重开书库失败: {error}"))?;
            let loaded = bridge::invoke(
                &registry,
                &reopened,
                "library.getPaper@1",
                &json!({ "paperId": "smoke-paper" }),
            )
            .map_err(|error| format!("读取论文失败: {error}"))?;
            if loaded["paper"]["title"] != json!("冒烟论文") {
                return Err(format!("论文未恢复: {loaded}"));
            }
            let position = bridge::invoke(
                &registry,
                &reopened,
                "library.getReadingPosition@1",
                &json!({ "paperId": "smoke-paper" }),
            )
            .map_err(|error| format!("读取阅读位置失败: {error}"))?;
            if position["position"]["view"] != json!("digest") {
                return Err(format!("阅读位置未恢复: {position}"));
            }
            let range = bridge::invoke(
                &registry,
                &reopened,
                "files.readRange@1",
                &json!({ "paperId": "smoke-paper", "attachmentId": "pdf", "offset": 0, "length": 5 }),
            )
            .map_err(|error| format!("读取附件失败: {error}"))?;
            if range["contentBase64"] != json!("aGVsbG8=") {
                return Err(format!("附件范围读取不符: {range}"));
            }
            let export_path = root.join("exports").join("smoke-library.json");
            let export = json!({
                "format": "paper-30min-library",
                "version": 1,
                "papers": [{
                    "id": "smoke-migrated",
                    "title": "迁移论文",
                    "addedAt": 1_788_249_600_000_i64,
                    "updatedAt": 1_788_249_600_000_i64,
                    "sections": { "abstract": "迁移摘要" },
                    "pdfBlob": { "base64": "aGVsbG8tcGRm", "type": "application/pdf" },
                    "pdfName": "smoke.pdf"
                }],
                "settings": { "apiKey": "sk-should-not-migrate" }
            });
            std::fs::write(&export_path, serde_json::to_vec(&export).unwrap())
                .map_err(|error| format!("写入导出文件失败: {error}"))?;
            let inspected = bridge::invoke(
                &registry,
                &reopened,
                "migration.inspect@1",
                &json!({ "sourcePath": export_path.to_string_lossy() }),
            )
            .map_err(|error| format!("预检失败: {error}"))?;
            if inspected["conflicts"]["new"] != json!(1) || inspected["apiKeyStripped"] != json!(true)
            {
                return Err(format!("预检结果不符: {inspected}"));
            }
            // 预检不应写入论文：与预检前的论文数一致即可（前面的检查已写过两篇）。
            let before = bridge::invoke(&registry, &reopened, "library.listPapers@1", &json!({}))
                .map_err(|error| format!("列出书库失败: {error}"))?;
            if before["papers"].as_array().map(|items| items.len()).unwrap_or(0) != 2 {
                return Err("预检不应写入论文".to_string());
            }
            let committed = bridge::invoke(
                &registry,
                &reopened,
                "migration.commit@1",
                &json!({ "token": inspected["token"] }),
            )
            .map_err(|error| format!("提交迁移失败: {error}"))?;
            if committed["added"] != json!(1) {
                return Err(format!("提交结果不符: {committed}"));
            }
            let migrated = bridge::invoke(
                &registry,
                &reopened,
                "library.getPaper@1",
                &json!({ "paperId": "smoke-migrated" }),
            )
            .map_err(|error| format!("读取迁移论文失败: {error}"))?;
            if migrated["paper"]["title"] != json!("迁移论文") {
                return Err(format!("迁移论文未写入: {migrated}"));
            }
            let _ = std::fs::remove_dir_all(&root);
            Ok("论文、阅读位置、附件与浏览器书库迁移重开后完整恢复".to_string())
        },
        &mut report,
    );

    let passed = report.iter().filter(|item| item["pass"] == json!(true)).count();
    let failures = report.len() - passed;
    let output = json!({
        "smoke": "bridge",
        "total": report.len(),
        "passed": passed,
        "failed": failures,
        "checks": report,
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
    if failures == 0 {
        0
    } else {
        1
    }
}
