use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::admission::AdmissionGate;
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

pub async fn install(
    app: &AppHandle,
    gate: &Arc<AdmissionGate>,
    registry: &TaskRegistry,
    expected_version: &str,
) -> Result<(), BridgeError> {
    // 准入门（#93）：占用 installing 与活动任务/组件 busy 检查在同一把锁内完成，
    // 新任务与组件操作在下载安装期间一律被拒。
    let _claim = gate.admit_update(registry)?;
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
