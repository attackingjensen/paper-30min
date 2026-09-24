use crate::admission::{AdmissionGate, ComponentClaim};
use crate::component::{self, ComponentManifest};
use crate::error::BridgeError;
use crate::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DOWNLOAD_URL: &str = "https://github.com/attackingjensen/paper-30min/releases/download/v1.2.0/Paper30Min_pdfparse_1.2.0_windows-x86_64.zip";

/// 组件包下载等待上限（#94）：连接与「每次读取」各有有界等待，停流/断网可在预期时间内退出。
/// 刻意不设整包期限：组件包约 885 MB，慢速但持续有字节的下载必须能完成。
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// 组件进度事件出口：生产为 Tauri 事件，测试可捕获（先例：tasks::EventSink）。
pub trait ComponentSink: Send + Sync {
    fn component_progress(&self, value: Value);
}

/// 生产事件出口：`app:component-progress` 频道。
pub struct TauriComponentSink<'a>(pub &'a AppHandle);

impl ComponentSink for TauriComponentSink<'_> {
    fn component_progress(&self, value: Value) {
        let _ = self.0.emit("app:component-progress", value);
    }
}

pub struct ComponentRuntime {
    pub root: PathBuf,
    cancelled: AtomicBool,
    progress: Mutex<Value>,
    error: Mutex<String>,
    gate: Arc<AdmissionGate>,
}

impl ComponentRuntime {
    pub fn new(root: PathBuf, gate: Arc<AdmissionGate>) -> Arc<Self> {
        Arc::new(Self {
            root,
            cancelled: AtomicBool::new(false),
            progress: Mutex::new(json!({ "phase": "idle" })),
            error: Mutex::new(String::new()),
            gate,
        })
    }

    fn begin(&self, registry: &TaskRegistry) -> Result<ComponentClaim, BridgeError> {
        let claim = self.gate.admit_component(registry)?;
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(claim)
    }

    pub fn start_task<T>(
        &self,
        start: impl FnOnce() -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        self.gate.admit_task(start)
    }

    fn emit(&self, sink: &dyn ComponentSink, phase: &str, downloaded: u64, total: u64, message: &str) {
        let value =
            json!({ "phase": phase, "downloaded": downloaded, "total": total, "message": message });
        *self
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = value.clone();
        sink.component_progress(value);
    }

    fn checkpoint(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(io::Error::new(io::ErrorKind::Interrupted, "组件安装已取消"))
        } else {
            Ok(())
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_busy(&self) -> bool {
        self.gate.component_busy()
    }

    pub fn status(&self) -> Value {
        let manifest = trusted_manifest();
        let installed = component::active_component(&self.root);
        let (ready, integrity_error) = match installed {
            Ok(Some(_)) => (true, String::new()),
            Ok(None) => (false, String::new()),
            Err(error) => (false, format!("组件损坏：{error}")),
        };
        let progress = self
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let error = if integrity_error.is_empty() {
            self.error
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        } else {
            integrity_error
        };
        let legacy_available =
            legacy_source().is_some() && !self.root.join("legacy-migrated").exists() && !ready;
        json!({
            "ready": ready,
            "installedVersion": if ready { component::COMPONENT_VERSION } else { "" },
            "archiveBytes": manifest.archive_bytes,
            "unpackedBytes": manifest.unpacked_bytes,
            "phase": if self.gate.component_busy() { progress["phase"].as_str().unwrap_or("installing") } else { "idle" },
            "downloaded": progress["downloaded"],
            "total": progress["total"],
            "error": error,
            "legacyAvailable": legacy_available,
        })
    }

    pub fn install(
        &self,
        sink: &dyn ComponentSink,
        registry: &TaskRegistry,
        source: Option<&Path>,
    ) -> Result<Value, BridgeError> {
        let _guard = self.begin(registry)?;
        let result = self.install_inner(sink, registry, source);
        *self.error.lock().unwrap_or_else(|error| error.into_inner()) = result
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default();
        self.emit(sink, "idle", 0, 0, "");
        result
    }

    fn install_inner(
        &self,
        sink: &dyn ComponentSink,
        registry: &TaskRegistry,
        source: Option<&Path>,
    ) -> Result<Value, BridgeError> {
        let manifest = trusted_manifest();
        let temporary = self.root.join("download");
        fs::create_dir_all(&temporary).map_err(component_error)?;
        let archive = temporary.join(component::ARCHIVE_NAME);
        let staged = temporary.join(format!("{}.part", component::ARCHIVE_NAME));
        let outcome = (|| {
            let mut output = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&staged)
                .map_err(component_error)?;
            if let Some(source) = source {
                self.emit(
                    sink,
                    "verifying",
                    0,
                    manifest.archive_bytes,
                    "正在读取本地组件包",
                );
                let mut input = File::open(source).map_err(component_error)?;
                copy_progress(
                    &mut input,
                    &mut output,
                    self,
                    sink,
                    "verifying",
                    manifest.archive_bytes,
                )?;
            } else {
                self.emit(
                    sink,
                    "downloading",
                    0,
                    manifest.archive_bytes,
                    "正在下载解析组件",
                );
                download_archive(
                    DOWNLOAD_URL,
                    &mut output,
                    manifest.archive_bytes,
                    DOWNLOAD_CONNECT_TIMEOUT,
                    DOWNLOAD_READ_TIMEOUT,
                    &|| self.checkpoint(),
                    &|done| self.emit(sink, "downloading", done, manifest.archive_bytes, ""),
                )?;
            }
            output.sync_all().map_err(component_error)?;
            drop(output);
            self.checkpoint().map_err(component_error)?;
            match fs::remove_file(&archive) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(component_error(error)),
            }
            fs::rename(&staged, &archive).map_err(component_error)?;
            self.emit(
                sink,
                "verifying",
                manifest.archive_bytes,
                manifest.archive_bytes,
                "正在校验组件包",
            );
            let verified = component::verify_archive(&archive, &manifest, &manifest.sha256)
                .map_err(component_error)?;
            self.checkpoint().map_err(component_error)?;
            if registry.has_active() {
                return Err(BridgeError::new(
                    "tasks_active",
                    "安装期间启动了新任务，请重试。",
                    true,
                ));
            }
            registry.sidecar_pool().release();
            self.emit(
                sink,
                "installing",
                manifest.archive_bytes,
                manifest.archive_bytes,
                "正在安装并自检",
            );
            component::install_verified_archive_cancellable(
                &self.root,
                &archive,
                &verified,
                self_check,
                || self.checkpoint(),
            )
            .map_err(component_error)?;
            Ok(self.status())
        })();
        let _ = fs::remove_file(&staged);
        let _ = fs::remove_file(&archive);
        outcome
    }

    pub fn migrate_legacy(
        &self,
        sink: &dyn ComponentSink,
        registry: &TaskRegistry,
        source: &Path,
    ) -> Result<(), BridgeError> {
        if component::active_component(&self.root)
            .ok()
            .flatten()
            .is_some()
            || self.root.join("legacy-migrated").exists()
            || !source.is_dir()
        {
            return Ok(());
        }
        let _guard = self.begin(registry)?;
        // 准入后复查：守卫求值与取得占用之间，状态可能已被并发迁移或卸载改变。
        if component::active_component(&self.root)
            .ok()
            .flatten()
            .is_some()
            || self.root.join("legacy-migrated").exists()
        {
            return Ok(());
        }
        self.emit(sink, "migrating", 0, 0, "正在迁移旧版解析组件");
        let result =
            component::migrate_legacy_sidecar_cancellable(&self.root, source, self_check, || {
                self.checkpoint()
            })
            .and_then(|_| fs::write(self.root.join("legacy-migrated"), b"1.2.0\n"))
            .map_err(component_error);
        *self.error.lock().unwrap_or_else(|error| error.into_inner()) = result
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default();
        self.emit(sink, "idle", 0, 0, "");
        result.map(|_| ())
    }

    pub fn remove(&self, sink: &dyn ComponentSink, registry: &TaskRegistry) -> Result<Value, BridgeError> {
        let _guard = self.begin(registry)?;
        registry.sidecar_pool().release();
        fs::create_dir_all(&self.root).map_err(component_error)?;
        fs::write(self.root.join("legacy-migrated"), b"uninstalled\n").map_err(component_error)?;
        let versions = self.root.join("versions");
        if versions.exists() {
            let meta = fs::symlink_metadata(&versions).map_err(component_error)?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(BridgeError::invalid_input(
                    "组件目录不是普通目录，无法卸载。",
                ));
            }
            fs::remove_dir_all(&versions).map_err(component_error)?;
        }
        let active = self.root.join("active.json");
        if active.exists() {
            fs::remove_file(active).map_err(component_error)?;
        }
        self.emit(sink, "idle", 0, 0, "");
        Ok(self.status())
    }
}

pub fn legacy_source() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|dir| dir.join("sidecar").join("pdfparse"))
        .filter(|path| path.is_dir())
}

fn copy_progress<R: Read>(
    input: &mut R,
    output: &mut File,
    runtime: &ComponentRuntime,
    sink: &dyn ComponentSink,
    phase: &str,
    total: u64,
) -> Result<(), BridgeError> {
    let mut buffer = [0_u8; 1024 * 1024];
    let mut done = 0_u64;
    loop {
        runtime.checkpoint().map_err(component_error)?;
        let count = input.read(&mut buffer).map_err(component_error)?;
        if count == 0 {
            break;
        }
        account_chunk(output, &buffer[..count], &mut done, total)?;
        runtime.emit(sink, phase, done, total, "");
    }
    verify_total_bytes(done, total)
}

/// 本地拷贝与下载共用的大小记账（#94 审查 #9）：累加、超可信清单上限拒绝、写入。
fn account_chunk(
    output: &mut File,
    chunk: &[u8],
    done: &mut u64,
    total: u64,
) -> Result<(), BridgeError> {
    *done = done.saturating_add(chunk.len() as u64);
    if *done > total {
        return Err(BridgeError::invalid_input("组件包大小超出可信清单。"));
    }
    output.write_all(chunk).map_err(component_error)
}

/// 终量核对：字节数必须与可信清单一致。
fn verify_total_bytes(done: u64, total: u64) -> Result<(), BridgeError> {
    if done != total {
        return Err(BridgeError::invalid_input("组件包大小与可信清单不符。"));
    }
    Ok(())
}

/// 组件包下载（#94 可测缝）：异步客户端以获得按读超时——reqwest 阻塞客户端只有整包期限，
/// 会在慢速网络上误杀 885 MB 的正常下载；按读超时只掐断连续无字节的停流。
/// 每次读取前先过 `checkpoint` 响应取消；块大小核对与本地来源路径共用 account_chunk。
pub fn download_archive(
    url: &str,
    output: &mut File,
    total: u64,
    connect_timeout: Duration,
    read_timeout: Duration,
    checkpoint: &(dyn Fn() -> io::Result<()> + Sync),
    progress: &(dyn Fn(u64) + Sync),
) -> Result<(), BridgeError> {
    let client = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .build()
        .map_err(component_error)?;
    tauri::async_runtime::block_on(async {
        let mut response = client
            .get(url)
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(component_error)?;
        let mut done = 0_u64;
        loop {
            checkpoint().map_err(component_error)?;
            let Some(chunk) = response.chunk().await.map_err(component_error)? else {
                break;
            };
            account_chunk(output, &chunk, &mut done, total)?;
            progress(done);
        }
        verify_total_bytes(done, total)
    })
}

fn trusted_manifest() -> ComponentManifest {
    serde_json::from_str(include_str!("../component-release.json")).expect("有效的内置组件清单")
}

fn self_check(root: &Path) -> io::Result<()> {
    let mut command = Command::new(root.join("python/python.exe"));
    command
        .arg(root.join("app/pdfparse_sidecar.py"))
        .arg("--models-dir")
        .arg(root.join("models"))
        .arg("selfcheck")
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let result = stdout
        .lines()
        .find_map(|line| line.strip_prefix(crate::pdfparse::RESULT_PREFIX))
        .and_then(|line| serde_json::from_str::<Value>(line).ok());
    if !output.status.success()
        || result.as_ref().and_then(|value| value["ready"].as_bool()) != Some(true)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "解析组件自检未通过：{}",
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(300)
                    .collect::<String>()
            ),
        ));
    }
    Ok(())
}

fn component_error(error: impl std::fmt::Display) -> BridgeError {
    BridgeError::new(
        "component_failed",
        format!("解析组件操作失败：{error}"),
        true,
    )
}
