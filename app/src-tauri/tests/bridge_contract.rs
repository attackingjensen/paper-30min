use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::json;

#[test]
fn error_serializes_to_unified_shape() {
    let error = BridgeError::task_not_found("task-000042");
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["code"], json!("task_not_found"));
    assert_eq!(value["retryable"], json!(false));
    assert!(value["message"].as_str().unwrap().contains("task-000042"));
    assert_eq!(value["details"]["taskId"], json!("task-000042"));

    let without_details = serde_json::to_value(BridgeError::invalid_input("缺少参数")).unwrap();
    assert_eq!(without_details["code"], json!("invalid_input"));
    assert!(without_details.get("details").is_none());
}

#[test]
fn unknown_command_returns_unified_error() {
    let registry = TaskRegistry::new();
    let error = bridge::invoke(&registry, "papers.delete@9", &json!({})).unwrap_err();
    assert_eq!(error.code, "unknown_command");
    assert!(!error.retryable);
    assert_eq!(error.details.unwrap()["command"], json!("papers.delete@9"));
}

#[test]
fn echo_round_trips_input_with_schema_version() {
    let registry = TaskRegistry::new();
    let input = json!({ "message": "你好", "nested": { "list": [1, 2, 3] } });
    let result = bridge::invoke(&registry, "bridge.echo@1", &input).unwrap();
    assert_eq!(result["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    assert_eq!(result["echo"], input);
}

#[test]
fn app_info_reports_versioned_surface() {
    let registry = TaskRegistry::new();
    let result = bridge::invoke(&registry, "app.info@1", &json!({})).unwrap();
    assert_eq!(result["schemaVersion"], json!(1));
    assert_eq!(result["app"]["identifier"], json!("com.paper30min.reader"));
    let commands = result["commands"].as_array().unwrap();
    assert!(commands.contains(&json!("app.info@1")));
    assert!(commands.contains(&json!("tasks.cancel@1")));
    let kinds = result["taskKinds"].as_array().unwrap();
    assert!(kinds.contains(&json!("demo.stream-text@1")));
}

#[test]
fn tasks_get_requires_task_id() {
    let registry = TaskRegistry::new();
    let error = bridge::invoke(&registry, "tasks.get@1", &json!({})).unwrap_err();
    assert_eq!(error.code, "invalid_input");
    assert!(!error.retryable);
}

#[test]
fn tasks_get_unknown_id_returns_task_not_found() {
    let registry = TaskRegistry::new();
    let error = bridge::invoke(&registry, "tasks.get@1", &json!({ "taskId": "task-999999" })).unwrap_err();
    assert_eq!(error.code, "task_not_found");
}

#[test]
fn unknown_task_kind_is_rejected_at_start() {
    let registry = TaskRegistry::new();
    let sink: std::sync::Arc<dyn paper30min_lib::tasks::EventSink> =
        std::sync::Arc::new(NoopSink);
    let error = registry.start("papers.generate@1", json!({}), sink).unwrap_err();
    assert_eq!(error.code, "unknown_command");
}

struct NoopSink;
impl paper30min_lib::tasks::EventSink for NoopSink {
    fn emit(&self, _event: paper30min_lib::tasks::TaskEvent) {}
}
