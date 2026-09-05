pub mod bridge;
pub mod error;
pub mod smoke;
pub mod tasks;
pub mod testkit;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

use error::BridgeError;
use tasks::{EventSink, TaskEvent, TaskRegistry};

/// 生产事件出口：`subscribe(taskId)` 对应 `task:{taskId}` 事件通道。
struct TauriEventSink {
    app: AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: TaskEvent) {
        let channel = format!("task:{}", event.task_id);
        let _ = self.app.emit(&channel, event);
    }
}

pub struct AppState {
    registry: Arc<TaskRegistry>,
    /// 用户在前端确认过关闭选择后置位，之后 CloseRequested 直接放行。
    force_close: AtomicBool,
}

#[tauri::command]
fn bridge_invoke(
    window: WebviewWindow,
    state: State<AppState>,
    command: String,
    input: Option<Value>,
) -> Result<Value, BridgeError> {
    let input = input.unwrap_or(Value::Null);
    if command == "app.close-window@1" {
        let cancel_tasks = input
            .get("cancelTasks")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if cancel_tasks {
            state.registry.cancel_all_active();
        }
        state.force_close.store(true, Ordering::SeqCst);
        window
            .close()
            .map_err(|e| BridgeError::internal(format!("关闭窗口失败: {e}")))?;
        return Ok(json!({
            "schemaVersion": bridge::BRIDGE_SCHEMA_VERSION,
            "closing": true,
        }));
    }
    bridge::invoke(&state.registry, &command, &input)
}

#[tauri::command]
fn bridge_start(
    app: AppHandle,
    state: State<AppState>,
    kind: String,
    input: Option<Value>,
) -> Result<Value, BridgeError> {
    let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink { app });
    let task_id = state.registry.start(&kind, input.unwrap_or(Value::Null), sink)?;
    Ok(json!({
        "schemaVersion": bridge::BRIDGE_SCHEMA_VERSION,
        "taskId": task_id,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            registry: TaskRegistry::new(),
            force_close: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![bridge_invoke, bridge_start])
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                if state.force_close.load(Ordering::SeqCst) || !state.registry.has_active() {
                    return;
                }
                let active = state.registry.list(true);
                if !active.is_empty() {
                    // 仍有运行中任务：阻止关闭，交给前端提示等待完成或停止任务。
                    api.prevent_close();
                    let _ = window.emit(
                        "app:close-requested",
                        json!({
                            "schemaVersion": bridge::BRIDGE_SCHEMA_VERSION,
                            "tasks": active,
                        }),
                    );
                }
            }
            WindowEvent::Destroyed => {
                // 兜底：窗口销毁时请求取消全部运行中任务，不遗留后台工作。
                let state = window.state::<AppState>();
                state.registry.cancel_all_active();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("论文精读客户端启动失败");
}
