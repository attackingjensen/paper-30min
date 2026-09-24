pub mod admission;
pub mod bridge;
pub mod component;
pub mod component_runtime;
pub mod error;
pub mod exports;
pub mod files;
pub mod library;
pub mod migration;
pub mod model;
pub mod net;
pub mod pdfassets;
pub mod pdfmap;
pub mod pdfparse;
pub mod pdfpool;
pub mod protocol;
pub mod settings;
pub mod skills;
pub mod smoke;
pub mod tasks;
pub mod testkit;
pub mod updater;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use component_runtime::ComponentRuntime;
use admission::AdmissionGate;
use error::BridgeError;
use library::Library;
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
    /// 书库句柄：任务注册表与命令分发共享同一份（bridge::invoke 经自动 deref 仍收 &Library）。
    library: Arc<Library>,
    /// 用户在前端确认过关闭选择后置位，之后 CloseRequested 直接放行。
    force_close: AtomicBool,
    /// 更新安装、任务注册与组件操作共用的准入门（#93）。
    admission: Arc<AdmissionGate>,
    component: Arc<ComponentRuntime>,
}

#[tauri::command]
fn bridge_invoke(
    window: WebviewWindow,
    state: State<AppState>,
    command: String,
    input: Option<Value>,
) -> Result<Value, BridgeError> {
    let input = input.unwrap_or(Value::Null);
    if command == "dialog.pickFile@1" {
        return dialog_pick_file(&window, &input);
    }
    if command == "dialog.saveFile@1" {
        return dialog_save_file(&window, &input);
    }
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
    bridge::invoke(&state.registry, &state.library, &command, &input)
}

/// 打开单选文件对话框（阻塞式）；取消返回 path: null。
/// 需要窗口句柄，由 Tauri 命令层拦截，不进 bridge::invoke 纯函数分发。
fn dialog_pick_file(window: &WebviewWindow, input: &Value) -> Result<Value, BridgeError> {
    let mut builder = window.dialog().file();
    if let Some(title) = input.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    if let Some(filters) = input.get("filters").and_then(Value::as_array) {
        for filter in filters {
            let name = filter
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let extensions: Vec<&str> = filter
                .get("extensions")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            builder = builder.add_filter(name, &extensions);
        }
    }
    let path = builder.blocking_pick_file().map(|path| path.to_string());
    Ok(json!({
        "schemaVersion": bridge::BRIDGE_SCHEMA_VERSION,
        "path": path,
    }))
}

/// 打开保存对话框（阻塞式）；取消返回 path: null。
fn dialog_save_file(window: &WebviewWindow, input: &Value) -> Result<Value, BridgeError> {
    let mut builder = window.dialog().file();
    if let Some(title) = input.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    if let Some(default_name) = input.get("defaultName").and_then(Value::as_str) {
        builder = builder.set_file_name(default_name);
    }
    let path = builder.blocking_save_file().map(|path| path.to_string());
    Ok(json!({
        "schemaVersion": bridge::BRIDGE_SCHEMA_VERSION,
        "path": path,
    }))
}

#[tauri::command]
fn bridge_start(
    app: AppHandle,
    state: State<AppState>,
    kind: String,
    input: Option<Value>,
) -> Result<Value, BridgeError> {
    let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink { app });
    let task_id = state.component.start_task(|| {
        state
            .registry
            .start(&kind, input.unwrap_or(Value::Null), sink)
    })?;
    Ok(json!({
        "schemaVersion": bridge::BRIDGE_SCHEMA_VERSION,
        "taskId": task_id,
    }))
}

#[tauri::command]
fn updater_info(app: AppHandle) -> Value {
    updater::info(&app)
}

#[tauri::command]
async fn updater_check(app: AppHandle) -> Result<Value, BridgeError> {
    updater::check(&app).await
}

#[tauri::command]
async fn updater_install(
    app: AppHandle,
    state: State<'_, AppState>,
    version: String,
) -> Result<(), BridgeError> {
    updater::install(&app, &state.admission, &state.registry, &version).await
}

#[tauri::command]
fn component_status(state: State<'_, AppState>) -> Value {
    state.component.status()
}

#[tauri::command]
fn component_cancel(state: State<'_, AppState>) {
    state.component.cancel();
}

#[tauri::command]
async fn component_install(
    app: AppHandle,
    state: State<'_, AppState>,
    source: Option<String>,
) -> Result<Value, BridgeError> {
    let component = Arc::clone(&state.component);
    let registry = Arc::clone(&state.registry);
    tauri::async_runtime::spawn_blocking(move || {
        let sink = component_runtime::TauriComponentSink(&app);
        component.install(&sink, &registry, source.as_deref().map(std::path::Path::new))
    })
    .await
    .map_err(|error| BridgeError::internal(format!("组件安装线程失败：{error}")))?
}

#[tauri::command]
async fn component_remove(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, BridgeError> {
    let component = Arc::clone(&state.component);
    let registry = Arc::clone(&state.registry);
    tauri::async_runtime::spawn_blocking(move || {
        let sink = component_runtime::TauriComponentSink(&app);
        component.remove(&sink, &registry)
    })
    .await
    .map_err(|error| BridgeError::internal(format!("组件卸载线程失败：{error}")))?
}

#[tauri::command]
async fn component_migrate(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, BridgeError> {
    let source = component_runtime::legacy_source()
        .ok_or_else(|| BridgeError::invalid_input("未找到旧版解析组件。"))?;
    let component = Arc::clone(&state.component);
    let registry = Arc::clone(&state.registry);
    tauri::async_runtime::spawn_blocking(move || {
        let sink = component_runtime::TauriComponentSink(&app);
        component
            .migrate_legacy(&sink, &registry, &source)
            .map(|_| component.status())
    })
    .await
    .map_err(|error| BridgeError::internal(format!("组件迁移线程失败：{error}")))?
}

fn external_url(destination: &str) -> Option<&'static str> {
    match destination {
        "source" => Some("https://github.com/attackingjensen/paper-30min"),
        "releases" => Some("https://github.com/attackingjensen/paper-30min/releases"),
        "issues" => Some("https://github.com/attackingjensen/paper-30min/issues"),
        _ => None,
    }
}

#[tauri::command]
fn open_external(app: AppHandle, destination: String) -> Result<(), BridgeError> {
    let url =
        external_url(&destination).ok_or_else(|| BridgeError::invalid_input("未知的项目链接"))?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| BridgeError::internal(format!("打开链接失败: {err}")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            let component_root = component::component_root(&app.path().app_local_data_dir()?);
            pdfparse::set_component_root(component_root.clone());
            let admission = AdmissionGate::new();
            let component = ComponentRuntime::new(component_root, Arc::clone(&admission));
            let library = Arc::new(Library::open(&root)?);
            let registry = TaskRegistry::new(Arc::clone(&library));
            // 常驻解析侧车启动预热（#84）：侧车就绪且设置开启时后台拉起并加载模型，
            // 第二篇及以后的论文解析免去启动等待；失败只记日志。
            let legacy = component_runtime::legacy_source();
            if let Some(source) = legacy.filter(|source| source.is_dir()) {
                let app_handle = app.handle().clone();
                let component_for_migration = Arc::clone(&component);
                let registry_for_migration = Arc::clone(&registry);
                let library_for_migration = Arc::clone(&library);
                std::thread::spawn(move || {
                    let sink = component_runtime::TauriComponentSink(&app_handle);
                    if let Err(error) = component_for_migration.migrate_legacy(
                        &sink,
                        &registry_for_migration,
                        &source,
                    ) {
                        eprintln!("[component] 旧版解析组件迁移失败：{error}");
                    } else {
                        pdfparse::warm_resident_sidecar(
                            &registry_for_migration,
                            &library_for_migration,
                        );
                    }
                });
            } else {
                pdfparse::warm_resident_sidecar(&registry, &library);
            }
            app.manage(AppState {
                registry,
                library,
                force_close: AtomicBool::new(false),
                admission,
                component,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge_invoke,
            bridge_start,
            updater_info,
            updater_check,
            updater_install,
            component_status,
            component_install,
            component_cancel,
            component_remove,
            component_migrate,
            open_external
        ])
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
        .expect("Paper30Min 客户端启动失败");
}

#[cfg(test)]
mod tests {
    use super::external_url;

    #[test]
    fn project_links_are_allowlisted() {
        assert_eq!(
            external_url("releases"),
            Some("https://github.com/attackingjensen/paper-30min/releases")
        );
        assert_eq!(
            external_url("issues"),
            Some("https://github.com/attackingjensen/paper-30min/issues")
        );
        assert_eq!(external_url("https://example.com"), None);
    }
}
