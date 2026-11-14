use serde::{Deserialize, Serialize};

/// 桥接统一错误结构（规格：错误统一为 `{ code, message, retryable, details }`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl BridgeError {
    pub fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable,
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn unknown_command(command: &str) -> Self {
        Self::new("unknown_command", format!("未知命令或任务类型: {command}"), false)
            .with_details(serde_json::json!({ "command": command }))
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message, false)
    }

    pub fn task_not_found(task_id: &str) -> Self {
        Self::new("task_not_found", format!("任务不存在: {task_id}"), false)
            .with_details(serde_json::json!({ "taskId": task_id }))
    }

    pub fn paper_not_found(paper_id: &str) -> Self {
        Self::new("not_found", format!("论文不存在: {paper_id}"), false)
            .with_details(serde_json::json!({ "paperId": paper_id }))
    }

    pub fn attachment_not_found(paper_id: &str, attachment_id: &str) -> Self {
        Self::new(
            "not_found",
            format!("附件不存在: {paper_id}/{attachment_id}"),
            false,
        )
        .with_details(serde_json::json!({
            "paperId": paper_id,
            "attachmentId": attachment_id
        }))
    }

    pub fn integrity_failed(paper_id: &str, attachment_id: &str, message: impl Into<String>) -> Self {
        Self::new("integrity_failed", message, false).with_details(serde_json::json!({
            "paperId": paper_id,
            "attachmentId": attachment_id
        }))
    }

    pub fn schema_unsupported(found: i32, supported: i32) -> Self {
        Self::new(
            "schema_unsupported",
            format!("书库数据库版本 {found} 高于当前支持的 {supported}"),
            false,
        )
        .with_details(serde_json::json!({ "found": found, "supported": supported }))
    }

    pub fn unsupported_export_version(found: i64, supported: i64) -> Self {
        Self::new(
            "unsupported_version",
            format!("不支持的导出版本 {found}（当前支持 {supported}）"),
            false,
        )
        .with_details(serde_json::json!({ "found": found, "supported": supported }))
    }

    pub fn token_expired() -> Self {
        Self::new("token_expired", "预检令牌已过期，请重新预检", false)
    }

    pub fn source_changed() -> Self {
        Self::new("source_changed", "导出文件已变化，请重新预检", false)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message, true)
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BridgeError {}
