use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::error::BridgeError;
use crate::tasks::TaskRegistry;

pub fn info(app: &AppHandle) -> Value {
    json!({ "version": app.package_info().version.to_string() })
}

pub async fn check(app: &AppHandle) -> Result<Value, BridgeError> {
    let updater = app.updater().map_err(check_error)?;
    let update = updater.check().await.map_err(check_error)?;
    Ok(match update {
        Some(update) => json!({
            "available": true,
            "version": update.version,
            "notes": update.body.unwrap_or_default(),
        }),
        None => json!({ "available": false }),
    })
}

struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub async fn install(
    app: &AppHandle,
    registry: &TaskRegistry,
    installing: &AtomicBool,
    expected_version: &str,
) -> Result<(), BridgeError> {
    if installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(BridgeError::new(
            "update_busy",
            "更新安装已在进行中。",
            false,
        ));
    }
    let _guard = InstallGuard(installing);
    if registry.has_active() {
        return Err(BridgeError::new(
            "tasks_active",
            "请先等待运行中的任务完成或取消，再安装更新。",
            true,
        ));
    }
    let updater = app.updater().map_err(install_error)?;
    let update = updater
        .check()
        .await
        .map_err(install_error)?
        .ok_or_else(|| BridgeError::new("update_unavailable", "当前没有可安装的更新。", false))?;
    if update.version != expected_version {
        return Err(BridgeError::new(
            "update_changed",
            "更新版本已变化，请重新检查。",
            true,
        ));
    }
    let mut downloaded = 0_u64;
    let events = app.clone();
    let finished = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = events.emit(
                    "app:update-progress",
                    json!({
                        "downloaded": downloaded,
                        "total": total,
                        "finished": false,
                    }),
                );
            },
            move || {
                let _ = finished.emit("app:update-progress", json!({ "finished": true }));
            },
        )
        .await
        .map_err(install_error)?;
    Ok(())
}

fn check_error(error: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(
        "update_check_failed",
        format!("检查更新失败：{error}"),
        true,
    )
}

fn install_error(error: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(
        "update_install_failed",
        format!("下载或安装更新失败：{error}"),
        true,
    )
}
