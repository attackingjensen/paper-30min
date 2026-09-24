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
    let result = snapshot.result.expect("model.chat 成功应带 usage/时延 result");
    assert!(result["ttftMs"].as_u64().is_some(), "应有 ttftMs");
    assert!(result["elapsedMs"].as_u64().is_some(), "应有 elapsedMs");
    assert!(result.get("usage").is_none(), "mock 未返回 usage 时字段缺省");

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
    assert!(
        body.get("enable_thinking").is_none(),
        "未传 stage 时不应注入内建思考默认"
    );
    assert_eq!(
        body["stream_options"],
        json!({ "include_usage": true }),
        "流式请求应要求 usage"
    );
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
    let body: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    assert!(body.get("stream_options").is_none(), "非流式不加 stream_options");
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
        json!({ "messages": [{ "role": "user", "content": 1 }] }),
        json!({ "messages": [{ "role": "user", "content": [] }] }),
        json!({ "messages": [{ "role": "user", "content": [{ "type": "file" }] }] }),
        json!({ "messages": [{ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "" } }] }] }),
        json!({ "messages": [{ "role": "user", "content": "x" }], "stream": "yes" }),
        json!({ "messages": [{ "role": "user", "content": "x" }], "temperature": "high" }),
        json!({ "messages": [{ "role": "user", "content": "x" }], "stage": "nope" }),
        json!({ "messages": [{ "role": "user", "content": "x" }], "stage": 1 }),
    ] {
        let error = registry.start("model.chat@1", input.clone(), sink.clone()).unwrap_err();
        assert_eq!(error.code, "invalid_input", "应拒绝非法输入: {input}");
        assert!(!error.retryable);
    }
}

#[test]
fn chat_forwards_multimodal_image_url_parts() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path == "/v1/chat/completions" {
            sse_chat(vec![
                json!({"choices": [{"delta": {"content": "见图"}}]}).to_string(),
                json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}).to_string(),
            ])
        } else {
            MockResponse::json(404, json!({"error": {"message": "no such route"}}))
        }
    });
    configure_model(&registry, &library, &mock.url("/v1"));
    let parts = json!([
        { "type": "text", "text": "这张图什么意思？" },
        { "type": "image_url", "image_url": { "url": "data:image/webp;base64,Zmln" } }
    ]);
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": parts }] }),
            sink,
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let body: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    assert_eq!(body["messages"][0]["content"], parts);
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

fn sse_chat_with_usage(content: &str, usage: Value) -> MockResponse {
    MockResponse::sse(
        vec![
            json!({"choices": [{"delta": {"content": content}}]}).to_string(),
            json!({"choices": [], "usage": usage}).to_string(),
            "[DONE]".to_string(),
        ],
        Duration::from_millis(1),
    )
}

#[test]
fn chat_extracts_usage_from_empty_choices_sse_event() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        sse_chat_with_usage(
            "遥测",
            json!({
                "prompt_tokens": 12,
                "completion_tokens": 4,
                "prompt_tokens_details": { "cached_tokens": 8 },
                "completion_tokens_details": { "reasoning_tokens": 2 }
            }),
        )
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
    let chunks: Vec<String> = sink
        .events()
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(chunks, vec!["遥测".to_string()]);
    let result = registry.get(&task_id).unwrap().result.expect("应带 result");
    assert_eq!(result["usage"]["promptTokens"], json!(12));
    assert_eq!(result["usage"]["completionTokens"], json!(4));
    assert_eq!(result["usage"]["cachedTokens"], json!(8));
    assert_eq!(result["usage"]["reasoningTokens"], json!(2));
    assert!(result["ttftMs"].as_u64().is_some());
    assert!(result["elapsedMs"].as_u64().unwrap() >= result["ttftMs"].as_u64().unwrap());
}

#[test]
fn chat_non_streaming_carries_usage_from_json_body() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(
            200,
            json!({
                "choices": [{"message": {"content": "完整回复"}}],
                "usage": { "prompt_tokens": 3, "completion_tokens": 5 }
            }),
        )
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
    let result = registry.get(&task_id).unwrap().result.expect("应带 result");
    assert_eq!(result["usage"]["promptTokens"], json!(3));
    assert_eq!(result["usage"]["completionTokens"], json!(5));
    assert!(result.get("usage").unwrap().get("cachedTokens").is_none());
}

#[test]
fn consecutive_chats_reuse_http_connection() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| sse_chat(vec![
        json!({"choices": [{"delta": {"content": "复用"}}]}).to_string(),
    ]));
    configure_model(&registry, &library, &mock.url(""));
    for _ in 0..2 {
        let sink = Collector::new();
        let task_id = registry
            .start(
                "model.chat@1",
                json!({ "messages": [{ "role": "user", "content": "hi" }] }),
                sink,
            )
            .unwrap();
        assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    }
    assert_eq!(mock.hits(), 2, "应发出两轮请求");
    assert_eq!(
        mock.connections(),
        1,
        "共享客户端应对同一 mock 复用 TCP 连接"
    );
}

#[test]
fn chat_stage_qa_injects_enable_thinking_true() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        sse_chat(vec![
            json!({"choices": [{"delta": {"content": "答"}}]}).to_string(),
            json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}).to_string(),
        ])
    });
    configure_model(&registry, &library, &mock.url(""));
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "stage": "qa"
            }),
            sink,
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let body: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    assert_eq!(body["enable_thinking"], json!(true));
    assert_eq!(body["model"], json!("gpt-smoke"));
}

#[test]
fn chat_stage_translate_disables_thinking_by_default() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        sse_chat(vec![json!({"choices": [{"delta": {"content": "译文"}}]}).to_string()])
    });
    configure_model(&registry, &library, &mock.url(""));
    let task_id = registry
        .start(
            "model.chat@1",
            json!({"messages": [{"role": "user", "content": "source"}], "stage": "translate"}),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let snapshot = registry.get(&task_id).unwrap();
    assert!(snapshot.details.unwrap_or_default().iter().any(|entry| {
        entry["event"] == "stage" && entry["detail"]["stage"] == "translate"
    }));
    let body: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    assert_eq!(body["enable_thinking"], json!(false));
}

#[test]
fn chat_stage_extra_body_overrides_and_null_deletes_protected_keys() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        sse_chat(vec![
            json!({"choices": [{"delta": {"content": "x"}}]}).to_string(),
            json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}).to_string(),
        ])
    });
    configure_model(&registry, &library, &mock.url(""));
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({
            "settings": {
                "extraBody": {
                    "temperature": null,
                    "model": "hijack",
                    "messages": [],
                    "stream": false,
                    "keep": 1
                },
                "stageExtraBody": {
                    "deep-dive": { "enable_thinking": true, "reasoning_effort": "low" }
                }
            }
        }),
    )
    .expect("写入附加参数");
    let sink = Collector::new();
    let task_id = registry
        .start(
            "model.chat@1",
            json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "stage": "deep-dive"
            }),
            sink,
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let body: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    assert_eq!(body["enable_thinking"], json!(true));
    assert_eq!(body["reasoning_effort"], json!("low"));
    assert_eq!(body["keep"], json!(1));
    assert!(body.get("temperature").is_none(), "null 应删除 temperature");
    assert_eq!(body["model"], json!("gpt-smoke"), "model 不可被覆盖");
    assert_eq!(body["stream"], json!(true), "stream 不可被覆盖");
    assert_eq!(body["messages"][0]["content"], json!("hi"), "messages 不可被覆盖");
}

#[test]
fn chat_ignores_reasoning_content_and_emits_thinking_then_content() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::sse(
            vec![
                json!({"choices": [{"delta": {"reasoning_content": "想"}}]}).to_string(),
                json!({"choices": [{"delta": {"reasoning_content": "一"}}]}).to_string(),
                json!({"choices": [{"delta": {"reasoning_content": "想"}}]}).to_string(),
                json!({"choices": [{"delta": {"content": "答案"}, "finish_reason": "stop"}]}).to_string(),
                "[DONE]".to_string(),
            ],
            Duration::from_millis(40),
        )
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

    let events = sink.events();
    let chunks: Vec<String> = events
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(chunks, vec!["答案".to_string()], "推理段不应产生 chunk");

    let thinking: Vec<&paper30min_lib::tasks::TaskEvent> = events
        .iter()
        .filter(|event| event.event == "thinking")
        .collect();
    assert!(!thinking.is_empty(), "应至少有一条 thinking");
    assert_eq!(thinking[0].detail.as_ref().unwrap()["kind"], json!("thinking"));
    assert!(thinking[0].detail.as_ref().unwrap()["elapsedMs"].as_u64().is_some());
    assert!(thinking[0].detail.as_ref().unwrap()["reasoningChars"].as_u64().unwrap() > 0);

    let first_chunk = events.iter().position(|event| event.event == "chunk").unwrap();
    assert!(
        events.iter().skip(first_chunk).all(|event| event.event != "thinking"),
        "正文到达后不应再有 thinking"
    );

    let result = registry.get(&task_id).unwrap().result.expect("应带 result");
    let ttft = result["ttftMs"].as_u64().unwrap();
    let reasoning = result["reasoningMs"].as_u64().unwrap();
    let elapsed = result["elapsedMs"].as_u64().unwrap();
    assert!(reasoning > 0);
    assert!(ttft <= elapsed);
    assert!(
        ttft.saturating_add(reasoning) <= elapsed,
        "首字时延应落在首个推理增量，思考时长为推理→正文，二者之和不超过总时长"
    );
}

// ---------- #86：可空 temperature 与 400 自动卸参数 ----------

/// 设置 temperature=null → 请求体不带该键；任务输入显式 null 覆盖 settings 值同义。
#[test]
fn chat_omits_temperature_when_null() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        sse_chat(vec![json!({"choices": [{"delta": {"content": "好"}}]}).to_string()])
    });
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({ "settings": {
            "baseUrl": mock.url(""), "apiKey": "sk-test", "model": "gpt-smoke",
            "temperature": null,
        } }),
    )
    .expect("settings 应接受 temperature: null");
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    // 任务输入显式 null：即使 settings 有值也不发送。
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({ "settings": { "temperature": 0.7 } }),
    )
    .expect("写入 temperature");
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }], "temperature": null }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    for (index, request) in requests.iter().enumerate() {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert!(
            body.get("temperature").is_none(),
            "第 {} 个请求不应携带 temperature: {body}",
            index + 1
        );
    }
}

/// mock 端点对含 temperature 的请求回 400（error.param 命中），否则正常 SSE：
/// 任务成功；mock 收到 2 个请求，第二个不含 temperature；快照 details 含
/// param_dropped 事件、warnings 含 param_dropped:temperature；同一进程内后续
/// 任务直接不带 temperature（端点能力缓存生效，mock 只再多收 1 个请求）。
#[test]
fn chat_drops_rejected_temperature_once_and_remembers() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        if body.get("temperature").is_some() {
            return MockResponse::json(
                400,
                json!({ "error": { "param": "temperature", "code": "unsupported_parameter",
                    "message": "Unsupported parameter: temperature" } }),
            );
        }
        sse_chat(vec![json!({"choices": [{"delta": {"content": "好"}}]}).to_string()])
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
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "卸参数后应成功");

    let requests = mock.requests();
    assert_eq!(requests.len(), 2, "首发 400 + 卸参数重发一次");
    let first: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert!(first.get("temperature").is_some(), "首发应带 temperature");
    let second: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert!(second.get("temperature").is_none(), "重发不应带 temperature");

    let snapshot = registry.get(&task_id).unwrap();
    let details = snapshot.details.clone().unwrap_or_default();
    let drop_event = details
        .iter()
        .find(|entry| entry["event"] == json!("param_dropped"))
        .expect("details 应含 param_dropped 事件");
    assert!(
        drop_event["detail"]["params"]
            .as_array()
            .unwrap()
            .contains(&json!("temperature")),
        "param_dropped 应列出 temperature: {drop_event}"
    );
    let warnings = snapshot.warnings.expect("快照应带 warnings");
    assert!(
        warnings.contains(&"param_dropped:temperature".to_string()),
        "warnings 应含 param_dropped:temperature: {warnings:?}"
    );

    // 端点能力缓存：第二个任务不再白跑 400，请求直接不含 temperature。
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let requests = mock.requests();
    assert_eq!(requests.len(), 3, "缓存生效后每轮只发 1 个请求");
    let third: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert!(third.get("temperature").is_none(), "缓存命中应预先卸掉 temperature");
}

/// max_tokens 被拒 → 改名为 max_completion_tokens 重发（OpenAI 推理系列规则）。
#[test]
fn chat_renames_rejected_max_tokens() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        if body.get("max_tokens").is_some() {
            return MockResponse::json(
                400,
                json!({ "error": { "param": "max_tokens", "code": "unsupported_parameter",
                    "message": "Unsupported parameter: max_tokens. Use max_completion_tokens instead." } }),
            );
        }
        sse_chat(vec![json!({"choices": [{"delta": {"content": "好"}}]}).to_string()])
    });
    configure_model(&registry, &library, &mock.url(""));
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let second: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert!(second.get("max_tokens").is_none(), "重发不应带 max_tokens");
    assert_eq!(
        second["max_completion_tokens"],
        json!(4096),
        "max_tokens 应改名为 max_completion_tokens 且值保留"
    );
    let warnings = registry.get(&task_id).unwrap().warnings.unwrap_or_default();
    assert!(
        warnings.contains(&"param_renamed:max_tokens:max_completion_tokens".to_string()),
        "warnings 应记改名: {warnings:?}"
    );
}

/// 卸参数后重发仍 400 → 按现状失败（model_http_error），不再消耗重试额度（命中数 = 2）。
#[test]
fn chat_fails_after_unsuccessful_drop() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(
            400,
            json!({ "error": { "param": "temperature", "code": "unsupported_parameter",
                "message": "Unsupported parameter: temperature" } }),
        )
    });
    configure_model(&registry, &library, &mock.url(""));
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(mock.hits(), 2, "首发 + 卸参数重发各一次，不重试");
    let error = registry.get(&task_id).unwrap().error.expect("应有错误");
    assert_eq!(error.code, "model_http_error");
    assert!(
        error.message.contains("已尝试去掉：temperature"),
        "错误信息应附已尝试去掉的参数: {}",
        error.message
    );
}

/// 400 但错误体不命中任何已知参数 → 不重发（命中数 = 1），按现状失败。
#[test]
fn chat_does_not_resend_unrecognized_400() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::json(400, json!({ "error": { "message": "余额不足，请充值" } }))
    });
    configure_model(&registry, &library, &mock.url(""));
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(mock.hits(), 1, "未命中已知参数不应重发");
    assert_eq!(
        registry.get(&task_id).unwrap().error.unwrap().code,
        "model_http_error"
    );
}

/// model.test@1 不做卸参数（连接测试如实暴露端点行为）。
#[test]
fn test_connection_does_not_drop_params_on_400() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        if request.path.ends_with("/models") {
            // /models 不可用 → 退路走最小 chat 请求。
            return MockResponse::json(404, json!({ "error": { "message": "no such route" } }));
        }
        MockResponse::json(
            400,
            json!({ "error": { "param": "max_tokens", "code": "unsupported_parameter",
                "message": "Unsupported parameter: max_tokens" } }),
        )
    });
    configure_model(&registry, &library, &mock.url(""));
    let task_id = registry
        .start("model.test@1", json!({}), Collector::new())
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let posts = mock
        .requests()
        .iter()
        .filter(|request| request.method == "POST")
        .count();
    assert_eq!(posts, 1, "连接测试不卸参数不重发");
    let error = registry.get(&task_id).unwrap().error.expect("应有错误");
    assert_eq!(error.code, "model_http_error");
    assert!(
        !error.message.contains("已尝试去掉"),
        "连接测试应如实报错: {}",
        error.message
    );
}

/// max_completion_tokens 被拒 → 改回 max_tokens（反向改名；经 extraBody 预置
/// max_completion_tokens 并 null 删掉 max_tokens 来构造请求体）。
#[test]
fn chat_renames_rejected_max_completion_tokens_back() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        if body.get("max_completion_tokens").is_some() {
            return MockResponse::json(
                400,
                json!({ "error": { "param": "max_completion_tokens",
                    "code": "unsupported_parameter",
                    "message": "Unsupported parameter: max_completion_tokens" } }),
            );
        }
        sse_chat(vec![json!({"choices": [{"delta": {"content": "好"}}]}).to_string()])
    });
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({ "settings": {
            "baseUrl": mock.url(""), "apiKey": "sk-test", "model": "gpt-smoke",
            "extraBody": { "max_tokens": null, "max_completion_tokens": 100 },
        } }),
    )
    .expect("写入模型设置");
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let first: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(first["max_completion_tokens"], json!(100));
    assert!(first.get("max_tokens").is_none(), "extraBody null 应删键");
    let second: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert!(second.get("max_completion_tokens").is_none(), "重发不应带 max_completion_tokens");
    assert_eq!(second["max_tokens"], json!(100), "应改回 max_tokens 且值保留");
    let warnings = registry.get(&task_id).unwrap().warnings.unwrap_or_default();
    assert!(
        warnings.contains(&"param_renamed:max_completion_tokens:max_tokens".to_string()),
        "warnings 应记反向改名: {warnings:?}"
    );
}

/// 400 错误体为纯文本（中转站常见）→ 词边界命中已知参数同样卸参数重发。
#[test]
fn chat_drops_param_on_plain_text_400() {
    let (registry, library, _dir) = common::env();
    let mock = MockHttp::start(|request, _hit| {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        if body.get("temperature").is_some() {
            return MockResponse::bytes(
                400,
                "text/plain",
                "Bad Request: this endpoint does not accept temperature",
            );
        }
        sse_chat(vec![json!({"choices": [{"delta": {"content": "好"}}]}).to_string()])
    });
    configure_model(&registry, &library, &mock.url(""));
    let task_id = registry
        .start(
            "model.chat@1",
            json!({ "messages": [{ "role": "user", "content": "hi" }] }),
            Collector::new(),
        )
        .unwrap();
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let requests = mock.requests();
    assert_eq!(requests.len(), 2);
    let second: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert!(second.get("temperature").is_none(), "纯文本 400 也应识别并卸掉 temperature");
}
