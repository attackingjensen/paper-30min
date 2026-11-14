mod common;

use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::{wait_terminal, Collector};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn terminal(registry: &Arc<TaskRegistry>, task_id: &str) -> TaskStatus {
    wait_terminal(registry, task_id, Duration::from_secs(5)).expect("任务未在超时内到达终态")
}

#[test]
fn stream_text_task_streams_chunks_then_succeeds() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry
        .start(
            "demo.stream-text@1",
            json!({ "text": "精读桥接", "chunks": 2, "chunkDelayMs": 5 }),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    let snapshot = registry.get(&task_id).unwrap();
    assert_eq!(snapshot.kind, "demo.stream-text@1");
    assert_eq!(snapshot.progress.unwrap(), paper30min_lib::tasks::Progress { done: 2, total: 2 });
    assert!(snapshot.error.is_none());

    let events = sink.events();
    assert_eq!(events.first().unwrap().event, "status");
    assert_eq!(events.first().unwrap().status, TaskStatus::Running);
    let chunks: Vec<String> = events
        .iter()
        .filter(|event| event.event == "chunk")
        .map(|event| event.chunk.clone().unwrap())
        .collect();
    assert_eq!(chunks.concat(), "精读桥接");
    assert_eq!(events.last().unwrap().event, "status");
    assert_eq!(events.last().unwrap().status, TaskStatus::Succeeded);
    for event in &events {
        assert_eq!(event.schema_version, 1);
        assert_eq!(event.task_id, task_id);
    }
}

#[test]
fn cancel_stops_stream_task_at_safe_checkpoint_and_is_idempotent() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry
        .start(
            "demo.stream-text@1",
            json!({ "chunks": 100, "chunkDelayMs": 20 }),
            sink.clone(),
        )
        .unwrap();

    let requested = registry.request_cancel(&task_id).unwrap();
    assert_eq!(requested.status, TaskStatus::CancelRequested);

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Cancelled);

    let again = registry.request_cancel(&task_id).unwrap();
    assert_eq!(again.status, TaskStatus::Cancelled);

    let events = sink.events();
    assert_eq!(events.last().unwrap().status, TaskStatus::Cancelled);
    assert!(events.iter().any(|event| event.status == TaskStatus::CancelRequested));
    let chunk_count = events.iter().filter(|event| event.event == "chunk").count();
    assert!(chunk_count < 100, "取消后不应流完全部块，实际流出 {chunk_count} 块");
}

#[test]
fn cancel_unknown_task_returns_task_not_found() {
    let (registry, _library, _dir) = common::env();
    let error = registry.request_cancel("task-424242").unwrap_err();
    assert_eq!(error.code, "task_not_found");
}

#[test]
fn fail_task_ends_failed_with_unified_error() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry
        .start("demo.fail@1", json!({ "message": "预期失败" }), sink)
        .unwrap();

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let snapshot = registry.get(&task_id).unwrap();
    let error = snapshot.error.unwrap();
    assert_eq!(error.code, "demo_failure");
    assert!(error.retryable);
    assert_eq!(error.message, "预期失败");
}

#[test]
fn active_list_only_contains_non_terminal_tasks() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let done_id = registry
        .start("demo.stream-text@1", json!({ "chunks": 1, "chunkDelayMs": 0 }), sink.clone())
        .unwrap();
    terminal(&registry, &done_id);

    let running_id = registry
        .start("demo.stream-text@1", json!({ "chunks": 100, "chunkDelayMs": 20 }), sink)
        .unwrap();

    assert!(registry.has_active());
    let active = registry.list(true);
    assert!(active.iter().any(|task| task.task_id == running_id));
    assert!(!active.iter().any(|task| task.task_id == done_id));

    registry.cancel_all_active();
    assert_eq!(terminal(&registry, &running_id), TaskStatus::Cancelled);
    assert!(!registry.has_active());
}

#[test]
fn snapshot_uses_versioned_camel_case_dto() {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry
        .start("demo.stream-text@1", json!({ "chunks": 1, "chunkDelayMs": 0 }), sink)
        .unwrap();
    terminal(&registry, &task_id);

    let snapshot = registry.get(&task_id).unwrap();
    let value = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(value["schemaVersion"], json!(1));
    assert_eq!(value["taskId"], json!(task_id));
    assert_eq!(value["status"], json!("succeeded"));
    assert!(value.get("createdAt").is_some());
    assert!(value.get("updatedAt").is_some());
    assert!(value.get("task_id").is_none());
}
