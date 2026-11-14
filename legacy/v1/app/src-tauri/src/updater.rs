use serde_json::{json, Value};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tokio::time::Instant;

use crate::admission::AdmissionGate;
use crate::error::BridgeError;
use crate::tasks::TaskRegistry;

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

pub fn info(app: &AppHandle) -> Value {
    json!({ "version": app.package_info().version.to_string() })
}

pub async fn check(app: &AppHandle, mode: crate::settings::ProxyMode) -> Result<Value, BridgeError> {
    let updater = configured_updater(app, mode).map_err(check_error)?;
    let update = check_update(&updater, CHECK_TIMEOUT).await?;
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
    let updater = configured_updater(app, registry.proxy_mode()?).map_err(install_error)?;
    install_from_updater(
        &updater,
        gate,
        registry,
        expected_version,
        (CHECK_TIMEOUT, DOWNLOAD_IDLE_TIMEOUT),
        |progress| {
            let _ = app.emit("app:update-progress", progress);
        },
        |update, bytes| update.install(bytes),
    )
    .await
}

async fn check_update(updater: &Updater, timeout: Duration) -> Result<Option<Update>, BridgeError> {
    tokio::time::timeout(timeout, updater.check())
        .await
        .map_err(|_| BridgeError::new("update_check_timeout", "检查更新超时，请重试。", true))?
        .map_err(check_error)
}

fn configured_updater(app: &AppHandle, mode: crate::settings::ProxyMode) -> tauri_plugin_updater::Result<Updater> {
    let builder = app.updater_builder();
    let builder = if mode == crate::settings::ProxyMode::Direct { builder.no_proxy() } else { builder };
    builder.build()
}

async fn install_from_updater(
    updater: &Updater,
    gate: &Arc<AdmissionGate>,
    registry: &TaskRegistry,
    expected_version: &str,
    deadlines: (Duration, Duration),
    mut progress: impl FnMut(Value),
    installer: impl FnOnce(&Update, Vec<u8>) -> tauri_plugin_updater::Result<()>,
) -> Result<(), BridgeError> {
    let _claim = gate.admit_update(registry)?;
    let mut update = check_update(updater, deadlines.0)
        .await?
        .ok_or_else(|| BridgeError::new("update_unavailable", "当前没有可安装的更新。", false))?;
    if update.version != expected_version {
        return Err(BridgeError::new(
            "update_changed",
            "更新版本已变化，请重新检查。",
            true,
        ));
    }
    update.no_proxy = registry.proxy_mode()? == crate::settings::ProxyMode::Direct;
    let mut downloaded = 0_u64;
    let activity = DownloadActivity::new();
    let download = update.download(
        |chunk, total| {
            activity.received(chunk);
            downloaded = downloaded.saturating_add(chunk as u64);
            progress(json!({
                "downloaded": downloaded,
                "total": total,
                "finished": false,
            }));
        },
        || {},
    );
    let bytes = download_with_idle_timeout(download, &activity, deadlines.1).await?;
    // The plugin's finish callback precedes signature verification; publish only verified bytes.
    progress(json!({ "finished": true }));
    installer(&update, bytes).map_err(install_error)?;
    Ok(())
}

struct DownloadActivity(Mutex<Instant>);

impl DownloadActivity {
    fn new() -> Self {
        Self(Mutex::new(Instant::now()))
    }

    fn received(&self, bytes: usize) {
        if bytes > 0 {
            *self.0.lock().unwrap() = Instant::now();
        }
    }

    fn deadline(&self, idle: Duration) -> Instant {
        *self.0.lock().unwrap() + idle
    }
}

async fn download_with_idle_timeout<T>(
    download: impl Future<Output = tauri_plugin_updater::Result<T>>,
    activity: &DownloadActivity,
    idle: Duration,
) -> Result<T, BridgeError> {
    // Keep ownership here: returning drops the download future before InstallClaim releases.
    tokio::pin!(download);
    let timer = tokio::time::sleep_until(activity.deadline(idle));
    tokio::pin!(timer);
    loop {
        tokio::select! {
            biased;
            _ = &mut timer => {
                let deadline = activity.deadline(idle);
                if Instant::now() >= deadline {
                    return Err(BridgeError::new(
                        "update_download_timeout", "下载更新停流超时，请检查网络后重试。", true,
                    ));
                }
                timer.as_mut().reset(deadline);
            }
            result = &mut download => return result.map_err(|error| BridgeError::new(
                "update_download_failed", format!("下载或校验更新失败：{error}"), true,
            )),
        }
    }
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

#[cfg(test)]
#[path = "updater_tests.rs"]
mod tests;
