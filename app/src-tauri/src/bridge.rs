use serde_json::{json, Value};
use std::sync::Arc;

use crate::error::BridgeError;
use crate::tasks::{available_task_kinds, TaskRegistry};

pub const BRIDGE_SCHEMA_VERSION: u32 = 1;

/// `invoke(command, input)` 支持的第一组版本化命令。
/// 名称带 `@1` 后缀；不兼容变更升级版本号而不是改变原命令语义。
pub fn available_commands() -> &'static [&'static str] {
    &[
        "app.info@1",
        "bridge.echo@1",
        "tasks.list@1",
        "tasks.get@1",
        "tasks.cancel@1",
        "app.close-window@1",
    ]
}

/// 统一命令分发。短时、幂等或事务性操作走这里；长任务走 `start`。
/// `app.close-window@1` 需要窗口句柄，由 Tauri 命令层拦截，不在此分发。
pub fn invoke(
    registry: &Arc<TaskRegistry>,
    command: &str,
    input: &Value,
) -> Result<Value, BridgeError> {
    match command {
        "app.info@1" => Ok(json!({
            "schemaVersion": BRIDGE_SCHEMA_VERSION,
            "app": {
                "name": "Paper30min",
                "version": env!("CARGO_PKG_VERSION"),
                "identifier": "com.paper30min.reader",
                "platform": std::env::consts::OS,
            },
            "commands": available_commands(),
            "taskKinds": available_task_kinds(),
        })),
        "bridge.echo@1" => Ok(json!({
            "schemaVersion": BRIDGE_SCHEMA_VERSION,
            "echo": input,
        })),
        "tasks.list@1" => {
            let active_only = input
                .get("activeOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "tasks": registry.list(active_only),
            }))
        }
        "tasks.get@1" => {
            let task_id = required_task_id(command, input)?;
            let task = registry
                .get(task_id)
                .ok_or_else(|| BridgeError::task_not_found(task_id))?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "task": task,
            }))
        }
        "tasks.cancel@1" => {
            let task_id = required_task_id(command, input)?;
            let task = registry.request_cancel(task_id)?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "task": task,
            }))
        }
        _ => Err(BridgeError::unknown_command(command)),
    }
}

fn required_task_id<'a>(command: &str, input: &'a Value) -> Result<&'a str, BridgeError> {
    input
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::invalid_input(format!("{command} 需要字符串参数 taskId")))
}
