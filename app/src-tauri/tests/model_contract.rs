//! 模型任务外部行为契约：model.chat@1 与 model.test@1 只通过任务事件流与快照观察，
//! 上游 HTTP 由 testkit 的 mock 服务器提供；端点规范化单测在 src/model.rs。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::{wait_for_event, wait_terminal, Collector, MockHttp, MockResponse};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

fn terminal(registry: &Arc<TaskRegistry>, task_id: &str) -> TaskStatus {
    wait_terminal(registry, task_id, Duration::from_secs(15)).expect("任务未在超时内到达终态")
}

fn configure_model(registry: &Arc<TaskRegistry>, library: &Library, base_url: &str) {
    bridge::invoke(
        registry,
        library,
        "settings.putModel@1",
        &json!({ "settings": { "baseUrl": base_url, "apiKey": "sk-test", "model": "gpt-smoke" } }),
    )
    .expect("写入模型设置");
}

fn sse_chat(mut payloads: Vec<String>) -> MockResponse {
    payloads.push("[DONE]".to_string());
    MockResponse::sse(payloads, Duration::from_millis(1))
}

#[test]
fn chat_streams_deltas_in_order_to_normalized_endpoint() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/v1/chat/completions" {
            sse_chat(vec![
                json!({"choices": [{"delta": {"content": "精读"}}]}).to_string(),
                json!({"choices": [{"delta": {"content": "桥接"}}]}).to_string(),
                json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}).to_string(),
            ])
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    // baseUrl 带 /v1：端点规范化不应重复补 /v1。
    configure_model(&registry, &library, &mock.url("/v1"));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "总结这篇论文" }] }),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    let events = sink.events();
    let chunks: Vec<String> = events
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(chunks, vec!["精读".to_string(), "桥接".to_string()], "增量应按序到达且不累积");
    let snapshot = registry.get(&task_id).unwrap();
    assert!(snapshot.error.is_none());
    assert!(snapshot.result.is_none(), "model.chat 不带 result");
    let serialized = serde_json::to_value(&snapshot).unwrap();
    assert!(serialized.get("result").is_none(), "result 缺省不序列化");

    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/chat/completions");
    assert_eq!(request.header("authorization"), Some("Bearer sk-test"));
    assert_eq!(
        request.header("accept"),
        Some("application/json, text/event-stream")
    );
    assert!(
        request.header("user-agent").unwrap_or("").contains("Mozilla/5.0"),
        "应带浏览器 UA"
    );
    let body: Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["model"], json!("gpt-smoke"));
    assert_eq!(body["stream"], json!(true));
    assert_eq!(body["max_tokens"], json!(4096), "缺省取 settings 值");
    assert_eq!(body["temperature"], json!(0.3));
    assert_eq!(body["messages"][0]["content"], json!("总结这篇论文"));
}

#[test]
fn chat_non_streaming_returns_single_chunk() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(200, json!({"choices": [{"message": {"content": "完整回复"}}]}))
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }], "stream": false }),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let chunks: Vec<String> = sink
        .events()
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(chunks, vec!["完整回复".to_string()], "非流式只发一个 chunk");
}

#[test]
fn chat_without_model_settings_fails_not_configured() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink,
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "model_not_configured");
    assert!(!error.retryable);
}

#[test]
fn chat_plan_validation_rejects_bad_input_at_start() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    for input in [
        json!({}),
        json!({ "messages": [] }),
        json!({ "messages": [{ "role": "user" }] }),
        json!({ "messages": [{ "role": 1, "content": "x" }] }),
        json!({ "messages": [{ "role": "user", "content": "x" }], "stream": "yes" }),
        json!({ "messages": [{ "role": "user", "content": "x" }], "temperature": "high" }),
    ] {
        let error = registry.start("model.chat@1", input.clone(), sink.clone()).unwrap_err();
        assert_eq!(error.code, "invalid_input", "应拒绝非法输入: {input}");
        assert!(!error.retryable);
    }
}

#[test]
fn chat_http_401_is_not_retried() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(401, json!({"error": {"message": "invalid api key"}}))
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink,
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "model_http_error");
    assert!(!error.retryable, "401 不可重试");
    assert!(error.message.contains("HTTP 401"), "message 应含状态: {}", error.message);
    assert!(
        error.message.contains("invalid api key"),
        "message 应含上游摘录: {}",
        error.message
    );
    assert_eq!(mock.hits(), 1, "401 不应重试");
}

#[test]
fn chat_http_500_goes_retry_waiting_then_succeeds() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, hit| {
        if hit == 1 {
            MockResponse::json(500, json!({"error": {"message": "upstream boom"}}))
        } else if request.path == "/v1/chat/completions" {
            sse_chat(vec![json!({"choices": [{"delta": {"content": "恢复"}}]}).to_string()])
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    configure_model(&registry, &library, &mock.url("/v1"));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let events = sink.events();
    assert!(
        events.iter().any(|event| event.status == TaskStatus::RetryWaiting),
        "retryable 失败应转 retry_waiting 并发 status 事件"
    );
    assert_eq!(mock.hits(), 2, "500 应重试一次后成功");
    let text: String = events
        .iter()
        .filter(|event| event.event == "chunk")
        .filter_map(|event| event.chunk.clone())
        .collect();
    assert_eq!(text, "恢复");
}

#[test]
fn chat_retry_exhausted_keeps_last_error() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(500, json!({"error": {"message": "always boom"}}))
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink,
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(mock.hits(), 3, "共 3 次尝试");
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "model_http_error");
    assert!(error.retryable, "保留最后一次错误的 retryable");
}

#[test]
fn chat_disconnect_after_chunks_fails_without_retry() {
    let (registry, library, _dir) = common::env();
    // 第一次连接发两段 SSE 后断连（不写 chunked 终止块）；若被重试，第二次会返回完整流。
    let mock = MockHttp::start(|_request, hit| {
        if hit == 1 {
            MockResponse::sse_aborted(
                vec![
                    json!({"choices": [{"delta": {"content": "前半"}}]}).to_string(),
                    json!({"choices": [{"delta": {"content": "已发"}}]}).to_string(),
                ],
                Duration::from_millis(1),
            )
        } else {
            sse_chat(vec![json!({"choices": [{"delta": {"content": "重来"}}]}).to_string()])
        }
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(mock.hits(), 1, "已发出内容 chunk 后不应自动重试");
    let events = sink.events();
    assert!(
        !events.iter().any(|event| event.status == TaskStatus::RetryWaiting),
        "已发出 chunk 后不应进入 retry_waiting"
    );
    let chunks: Vec<String> = events
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(
        chunks,
        vec!["前半".to_string(), "已发".to_string()],
        "事件流中不应出现重试后的重复 chunk"
    );
    // 错误保留 retryable：UI 的手动重试是新任务，从干净状态开始。
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "model_network_error");
    assert!(error.retryable, "断连错误仍应标记可手动重试");
}

#[test]
fn chat_disconnect_before_any_chunk_retries_and_succeeds() {
    let (registry, library, _dir) = common::env();
    // 第一次连接尚未产出任何 chunk 即断连 → 允许自动重试，第二次返回完整流。
    let mock = MockHttp::start(|_request, hit| {
        if hit == 1 {
            MockResponse::sse_aborted(vec![], Duration::ZERO)
        } else {
            sse_chat(vec![json!({"choices": [{"delta": {"content": "恢复"}}]}).to_string()])
        }
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    assert_eq!(mock.hits(), 2, "零 chunk 失败应重试一次");
    assert!(
        sink.events().iter().any(|event| event.status == TaskStatus::RetryWaiting),
        "零 chunk 失败应进入 retry_waiting"
    );
    let text: String = sink
        .events()
        .iter()
        .filter(|event| event.event == "chunk")
        .filter_map(|event| event.chunk.clone())
        .collect();
    assert_eq!(text, "恢复");
}

#[test]
fn chat_sends_task_or_settings_temperature_and_max_tokens() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        sse_chat(vec![json!({"choices": [{"delta": {"content": "好"}}]}).to_string()])
    });
    // settings 存储自定义值：任务输入缺省时应落进上游请求体。
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({ "settings": {
            "baseUrl": mock.url(""), "apiKey": "sk-test", "model": "gpt-smoke",
            "temperature": 0.7, "maxTokens": 2048,
        } }),
    )
    .expect("写入模型设置");
    let sink = Collector::new();
    let from_settings = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink.clone(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &from_settings), TaskStatus::Succeeded);

    // 任务输入显式给出时覆盖 settings 值。
    let explicit = registry
        .start(
            "model.chat@1",
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "temperature": 1.1, "maxTokens": 100,
            }),
            sink,
        )
        .unwrap();
    assert_eq!(terminal(&registry, &explicit), TaskStatus::Succeeded);

    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["temperature"], json!(0.7), "缺省应取 settings 值");
    assert_eq!(body["max_tokens"], json!(2048), "缺省应取 settings 值");
    let body: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(body["temperature"], json!(1.1), "任务输入应覆盖 settings");
    assert_eq!(body["max_tokens"], json!(100), "任务输入应覆盖 settings");
}

#[test]
fn cancel_during_stream_ends_cancelled() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        let payloads: Vec<String> = (0..50)
            .map(|i| json!({"choices": [{"delta": {"content": format!("块{i}")}}]}).to_string())
            .collect();
        MockResponse::sse(payloads, Duration::from_millis(100))
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink.clone(),
        )
        .unwrap();
    assert!(
        wait_for_event(&sink, |event| event.event == "chunk", Duration::from_secs(5)),
        "应先等到第一个 chunk"
    );
    registry.request_cancel(&task_id).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Cancelled);
}

#[test]
fn cancel_during_retry_sleep_ends_cancelled() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(500, json!({"error": {"message": "boom"}}))
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            sink.clone(),
        )
        .unwrap();
    assert!(
        wait_for_event(&sink, |event| event.status == TaskStatus::RetryWaiting, Duration::from_secs(5)),
        "应先等到 retry_waiting"
    );
    registry.request_cancel(&task_id).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Cancelled);
    assert_eq!(mock.hits(), 1, "retry_waiting 睡眠中取消不应发起第二次尝试");
}

#[test]
fn test_connection_finds_model_in_list() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/v1/models" {
            MockResponse::json(200, json!({"data": [{"id": "gpt-smoke"}, {"id": "other"}]}))
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry.start("model.test@1", json!({}), sink.clone()).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let snapshot = registry.get(&task_id).unwrap();
    let result = snapshot.result.expect("succeeded 应携带 result");
    assert_eq!(
        result["message"],
        json!("✅ 连接成功，已找到模型「gpt-smoke」")
    );
    // result 也应出现在 succeeded 事件里。
    let final_event = sink.events().last().unwrap().clone();
    assert_eq!(final_event.status, TaskStatus::Succeeded);
    assert_eq!(final_event.result, Some(result));
    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/v1/models");
}

#[test]
fn test_connection_warns_when_model_missing_from_list() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/v1/models" {
            MockResponse::json(200, json!({"data": [{"id": "a-model"}, {"id": "b-model"}]}))
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry.start("model.test@1", json!({}), sink).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let result = registry.get(&task_id).unwrap().result.unwrap();
    assert_eq!(
        result["message"],
        json!("⚠️ 连接成功，但模型列表中未找到「gpt-smoke」。可用模型：a-model, b-model")
    );
}

#[test]
fn test_connection_falls_back_to_ping_when_models_fails() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/v1/models" {
            MockResponse::json(404, json!({"error": {"message": "not found"}}))
        } else if request.path == "/v1/chat/completions" {
            MockResponse::json(200, json!({"choices": [{"message": {"content": "pong"}}]}))
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry.start("model.test@1", json!({}), sink).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let result = registry.get(&task_id).unwrap().result.unwrap();
    assert_eq!(result["message"], json!("✅ 连接成功"));
    let requests = mock.requests();
    assert_eq!(requests.len(), 2, "应走过 /models 失败 + chat 退路两段");
    assert_eq!(requests[1].path, "/v1/chat/completions");
    let body: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(body["max_tokens"], json!(1));
    assert_eq!(body["messages"][0]["content"], json!("ping"));
}

#[test]
fn test_connection_fails_when_both_paths_fail() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/v1/models" {
            MockResponse::json(500, json!({"error": {"message": "boom"}}))
        } else {
            MockResponse::json(401, json!({"error": {"message": "invalid api key"}}))
        }
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry.start("model.test@1", json!({}), sink).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "model_http_error");
    assert!(!error.retryable, "退路 401 不可重试");
    assert!(error.message.contains("HTTP 401"));
}

#[test]
fn test_connection_without_config_fails_not_configured() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry.start("model.test@1", json!({}), sink).unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "model_not_configured");
    assert!(!error.retryable);
}

#[test]
fn app_info_lists_new_task_kinds() {
    let (registry, library, _dir) = common::env();
    let info = bridge::invoke(&registry, &library, "app.info@1", &json!({})).unwrap();
    let kinds = info["taskKinds"].as_array().unwrap();
    for kind in ["model.chat@1", "model.test@1", "net.fetch-text@1", "files.download@1"] {
        assert!(kinds.iter().any(|item| item == kind), "app.info 未列出 {kind}");
    }
}
