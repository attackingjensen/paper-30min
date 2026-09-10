//! Docling 侧车子进程契约（Issue #57，规格 #48 §实施决策 4）。
//!
//! 侧车 = 嵌入式 Python 3.11 + 钉版依赖 + 布局/表格/OCR 模型（构建见
//! `tools/pdfparse-sidecar/build_sidecar.py`）。Rust 以子进程调用，输入 PDF 路径 +
//! 选项，输出 DoclingDocument 无损 JSON（落解析工作目录）+ 结构化错误码。
//!
//! 进程协议（与 `pdfparse_sidecar.py` 对齐）：
//! - 子进程把最终结果写 `<out-dir>/result.json`，并在 stdout 打一行 `PDFPARSE_RESULT`；
//! - 长任务进度经 stdout `PDFPARSE_PROGRESS {"stage","done","total"}` 单行上报；
//! - 退出码 0 = 结果已产出（含 ok:false 的可归类失败）；非 0 且无 result.json =
//!   侧车崩溃（sidecar_crashed，附 stderr 尾部）。
//!
//! 取消语义：任务取消 = 立即终止子进程（不产生部分结果）。当前只杀直接子进程；
//! bootstrap 的 pip 孙进程在极端时序下可能残留，属已知限制（Windows Job Object
//! 强化留待后续）。

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::error::BridgeError;
use crate::library::Library;
use crate::tasks::{run_with_retry, Progress, RunContext, CANCEL_SENTINEL};

pub const TASK_CONVERT: &str = "pdfparse.convert@1";
pub const TASK_BOOTSTRAP: &str = "pdfparse.bootstrap@1";

/// 侧车目录环境变量（测试/自定义部署用；默认随包目录或仓库开发目录）。
pub const SIDECAR_HOME_ENV: &str = "PAPER30MIN_PDFPARSE_HOME";
/// 模型目录环境变量；缺省时优先书库下运行时下载目录，其次侧车自带目录。
pub const MODELS_DIR_ENV: &str = "PAPER30MIN_PDFPARSE_MODELS";

/// 与侧车 REQUIRED_MODEL_FILES 保持一致（Rust 侧做快速文件系统检查）。
const REQUIRED_MODEL_FILES: [&str; 11] = [
    "docling-project--docling-layout-heron/model.safetensors",
    "docling-project--docling-layout-heron/config.json",
    "docling-project--docling-layout-heron/preprocessor_config.json",
    "docling-project--docling-models/model_artifacts/tableformer/accurate/tm_config.json",
    "docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
    "docling-project--docling-models/model_artifacts/tableformer/fast/tm_config.json",
    "docling-project--docling-models/model_artifacts/tableformer/fast/tableformer_fast.safetensors",
    "RapidOcr/PP-OCRv6_det_small.pth",
    "RapidOcr/PP-OCRv6_rec_small.pth",
    "RapidOcr/ppocrv6_dict.txt",
    "RapidOcr/ch_ptocr_mobile_v2.0_cls_mobile.pth",
];

const STDERR_TAIL_LIMIT: usize = 4096;
const STDOUT_LINE_LIMIT: usize = 200;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 进程协议行前缀（与 pdfparse_sidecar.py 对齐）。
const PROGRESS_PREFIX: &str = "PDFPARSE_PROGRESS ";
const RESULT_PREFIX: &str = "PDFPARSE_RESULT ";

#[derive(Debug, Clone)]
pub struct SidecarLayout {
    pub root: PathBuf,
    pub python_exe: PathBuf,
    pub app_script: PathBuf,
    pub models_dir: PathBuf,
    pub variant: Option<String>,
}

/// 侧车目录候选：环境变量 → 可执行文件旁（随包安装布局）→ 仓库开发目录。
fn sidecar_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var(SIDECAR_HOME_ENV) {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("sidecar").join("pdfparse"));
        }
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("sidecar")
            .join("pdfparse"),
    );
    candidates
}

/// 模型目录候选：环境变量 → 书库下运行时下载目录（download 案首启填充）→ 侧车自带。
fn models_dir_candidates(sidecar_root: &Path, library_root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var(MODELS_DIR_ENV) {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    candidates.push(library_root.join("pdfparse-models"));
    candidates.push(sidecar_root.join("models"));
    candidates
}

fn models_complete(models_dir: &Path) -> bool {
    REQUIRED_MODEL_FILES
        .iter()
        .all(|rel| models_dir.join(rel).is_file())
}

fn missing_models(models_dir: &Path) -> Vec<String> {
    REQUIRED_MODEL_FILES
        .iter()
        .filter(|rel| !models_dir.join(rel).is_file())
        .map(|rel| rel.to_string())
        .collect()
}

fn read_variant(sidecar_root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(sidecar_root.join("sidecar-manifest.json")).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("variant")?
        .as_str()
        .map(str::to_string)
}

pub fn deps_ready(sidecar_root: &Path) -> bool {
    // deps.ok 只在依赖完整安装（构建或 bootstrap 成功）后写入；
    // 取消残留的半截 site-packages 不会误过门禁（评审发现）。
    sidecar_root.join("deps.ok").is_file()
        && sidecar_root
            .join("python")
            .join("Lib")
            .join("site-packages")
            .join("docling")
            .is_dir()
}

/// 侧车解析：找不到可执行文件时返回 None（status 用）而不是报错。
pub fn resolve_sidecar(library_root: &Path) -> Option<SidecarLayout> {
    for root in sidecar_root_candidates() {
        let python_exe = root.join("python").join("python.exe");
        let app_script = root.join("app").join("pdfparse_sidecar.py");
        if python_exe.is_file() && app_script.is_file() {
            // 模型目录：取第一个"完整"的候选；都不完整时取第一个存在的（便于报缺失清单）。
            let candidates = models_dir_candidates(&root, library_root);
            let models_dir = candidates
                .iter()
                .find(|dir| models_complete(dir))
                .cloned()
                .or_else(|| candidates.iter().find(|dir| dir.is_dir()).cloned())
                .unwrap_or_else(|| root.join("models"));
            return Some(SidecarLayout {
                variant: read_variant(&root),
                root,
                python_exe,
                app_script,
                models_dir,
            });
        }
    }
    None
}

/// `pdfparse.status@1`：纯文件系统检查（不启动 Python，毫秒级），
/// 供导入前探明侧车可用性与 download 案的待补齐项。
pub fn status(library: &Library) -> Value {
    match resolve_sidecar(library.root()) {
        None => json!({
            "present": false,
            "ready": false,
        }),
        Some(layout) => {
            let deps = deps_ready(&layout.root);
            let missing = missing_models(&layout.models_dir);
            json!({
                "present": true,
                "ready": deps && missing.is_empty(),
                "sidecarRoot": layout.root.to_string_lossy(),
                "variant": layout.variant,
                "depsReady": deps,
                "modelsDir": layout.models_dir.to_string_lossy(),
                "modelsReady": missing.is_empty(),
                "missingModels": missing,
            })
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct SidecarError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SidecarResult {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<SidecarError>,
    /// 成功载荷原样透传（doclingJsonPath/pages/elapsedMs/ocrPages/warnings/...）。
    #[serde(flatten)]
    pub payload: Value,
}

/// 子进程 + 输出读取线程的句柄集。stdout/stderr 各有独立读取线程，
/// 防止管道缓冲写满导致子进程阻塞。
pub(crate) struct ChildHarness {
    child: Child,
    progress_rx: mpsc::Receiver<Progress>,
    stdout_lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    stderr_tail: std::sync::Arc<std::sync::Mutex<String>>,
    stdout_thread: Option<std::thread::JoinHandle<()>>,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
}

pub(crate) fn base_command(layout: &SidecarLayout, hf_endpoint: Option<&str>) -> Command {
    let mut command = Command::new(&layout.python_exe);
    command
        .arg(&layout.app_script)
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        // 嵌入版不带用户级 site（见 build_sidecar.py），双保险。
        .env("PYTHONNOUSERSITE", "1")
        // xet 直传域名在国内不可达；强制普通 HTTP 路径（镜像可走通）。
        .env("HF_HUB_DISABLE_XET", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(endpoint) = hf_endpoint {
        command.env("HF_ENDPOINT", endpoint);
    }
    command
}

pub(crate) fn spawn_child(mut command: Command) -> Result<ChildHarness, BridgeError> {
    let mut child = command
        .spawn()
        .map_err(|err| BridgeError::internal(format!("侧车进程启动失败: {err}")))?;

    let (progress_tx, progress_rx) = mpsc::channel::<Progress>();
    let stdout_lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));

    let stdout = child.stdout.take().expect("已配置 piped stdout");
    let stdout_lines_writer = std::sync::Arc::clone(&stdout_lines);
    let stdout_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(payload) = line.strip_prefix(PROGRESS_PREFIX) {
                if let Ok(value) = serde_json::from_str::<Value>(payload) {
                    let done = value.get("done").and_then(Value::as_u64).unwrap_or(0);
                    let total = value.get("total").and_then(Value::as_u64).unwrap_or(0);
                    let _ = progress_tx.send(Progress { done, total });
                }
                continue;
            }
            let mut lines = stdout_lines_writer.lock().unwrap_or_else(|e| e.into_inner());
            if lines.len() < STDOUT_LINE_LIMIT {
                lines.push(line);
            }
        }
    });

    let stderr = child.stderr.take().expect("已配置 piped stderr");
    let stderr_tail_writer = std::sync::Arc::clone(&stderr_tail);
    let stderr_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0_u8; 2048];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let mut tail = stderr_tail_writer.lock().unwrap_or_else(|e| e.into_inner());
                    tail.push_str(&chunk);
                    if tail.len() > STDERR_TAIL_LIMIT {
                        // 按字节截断再 lossy 解码，避免 UTF-8 字符边界 panic。
                        let bytes = tail.as_bytes()[tail.len() - STDERR_TAIL_LIMIT..].to_vec();
                        *tail = String::from_utf8_lossy(&bytes).into_owned();
                    }
                }
            }
        }
    });

    Ok(ChildHarness {
        child,
        progress_rx,
        stdout_lines,
        stderr_tail,
        stdout_thread: Some(stdout_thread),
        stderr_thread: Some(stderr_thread),
    })
}

/// 等待子进程结束：轮询取消标志，取消即 kill 并返回哨兵错误。
/// 进程退出后 join 两个读取线程（管道 EOF 后立即结束），
/// 保证读结果时 stdout 行已全部入队（修复评审发现的竞态）。
pub(crate) fn wait_child(ctx: &RunContext, harness: &mut ChildHarness) -> Result<i32, BridgeError> {
    let mut cancelled = false;
    let exit_code = loop {
        while let Ok(progress) = harness.progress_rx.try_recv() {
            ctx.push_progress(progress);
        }
        if let Some(status) = harness
            .child
            .try_wait()
            .map_err(|err| BridgeError::internal(format!("侧车进程等待失败: {err}")))?
        {
            break status.code().unwrap_or(-1);
        }
        if ctx.registry.cancel_requested(&ctx.task_id) {
            let _ = harness.child.kill();
            let _ = harness.child.wait();
            cancelled = true;
            break -1;
        }
        std::thread::sleep(POLL_INTERVAL);
    };
    if let Some(thread) = harness.stdout_thread.take() {
        let _ = thread.join();
    }
    if let Some(thread) = harness.stderr_thread.take() {
        let _ = thread.join();
    }
    while let Ok(progress) = harness.progress_rx.try_recv() {
        ctx.push_progress(progress);
    }
    if cancelled || ctx.registry.cancel_requested(&ctx.task_id) {
        return Err(BridgeError::new(CANCEL_SENTINEL, "任务已取消", false));
    }
    Ok(exit_code)
}

fn stderr_tail_of(harness: &ChildHarness) -> String {
    harness
        .stderr_tail
        .lock()
        .map(|tail| tail.clone())
        .unwrap_or_default()
}

fn result_line_of(harness: &ChildHarness) -> Option<String> {
    let lines = harness.stdout_lines.lock().ok()?;
    lines
        .iter()
        .find_map(|line| line.strip_prefix(RESULT_PREFIX).map(str::to_string))
}

/// 读取结构化结果：优先 result.json 文件，退回 stdout 的 PDFPARSE_RESULT 行。
pub(crate) fn read_sidecar_result(result_dir: &Path, harness: &ChildHarness) -> Option<SidecarResult> {
    if let Ok(text) = std::fs::read_to_string(result_dir.join("result.json")) {
        if let Ok(parsed) = serde_json::from_str::<SidecarResult>(&text) {
            return Some(parsed);
        }
    }
    result_line_of(harness).and_then(|line| serde_json::from_str(&line).ok())
}

pub(crate) fn map_failure(result: &SidecarResult, harness: &ChildHarness) -> BridgeError {
    if let Some(error) = &result.error {
        let mut mapped = BridgeError::new(&error.code, error.message.clone(), error.retryable);
        let tail = stderr_tail_of(harness);
        if !tail.trim().is_empty() {
            mapped = mapped.with_details(json!({ "stderrTail": tail }));
        }
        return mapped;
    }
    BridgeError::new("sidecar_result_invalid", "侧车失败结果缺少 error 字段", true)
        .with_details(json!({ "stderrTail": stderr_tail_of(harness) }))
}

pub(crate) fn crashed_error(exit_code: i32, harness: &ChildHarness) -> BridgeError {
    BridgeError::new(
        "sidecar_crashed",
        format!("侧车异常退出（exit={exit_code}），未产出结构化结果"),
        true,
    )
    .with_details(json!({
        "stderrTail": stderr_tail_of(harness),
        "exitCode": exit_code,
    }))
}

/// 从 settings 读 HF 端点覆盖（键与字段的知识归 settings 模块）。
fn configured_hf_endpoint(ctx: &RunContext) -> Option<String> {
    crate::settings::pdfparse_hf_endpoint(&ctx.library)
}

/// 侧车解析的统一入口：缺失时报 sidecar_missing（两个任务共用）。
pub(crate) fn require_sidecar(ctx: &RunContext) -> Result<SidecarLayout, BridgeError> {
    resolve_sidecar(ctx.library.root()).ok_or_else(|| {
        BridgeError::new(
            "sidecar_missing",
            "Docling 侧车未安装（缺少 python/python.exe 或 app/pdfparse_sidecar.py）",
            false,
        )
    })
}

/// pdfparse.convert@1：单篇 PDF → DoclingDocument JSON。
/// 输入: { pdfPath, workDir?, formulaEnrichment? }
/// 结果: { doclingJsonPath, workDir, pages, elapsedMs, wallClockMs,
///         doclingVersion, ocrPages, warnings }
/// 不做自动重试：转换动辄数分钟，失败后由用户显式重试（retryable 标记保留）。
pub(crate) fn run_convert(
    ctx: &RunContext,
    pdf_path: &Path,
    work_dir: Option<&Path>,
    formula_enrichment: bool,
) {
    match convert_once(ctx, pdf_path, work_dir, formula_enrichment) {
        Ok(()) => {}
        Err(error) if error.code == CANCEL_SENTINEL => ctx.cancel_now(),
        Err(error) => ctx.fail(error),
    }
}

fn convert_once(
    ctx: &RunContext,
    pdf_path: &Path,
    work_dir: Option<&Path>,
    formula_enrichment: bool,
) -> Result<(), BridgeError> {
    ctx.cancel_checkpoint()?;
    if !pdf_path.is_file() {
        return Err(BridgeError::new(
            "pdf_not_found",
            format!("PDF 文件不存在: {}", pdf_path.display()),
            false,
        ));
    }
    let layout = require_sidecar(ctx)?;
    if !deps_ready(&layout.root) {
        return Err(BridgeError::new(
            "bootstrap_required",
            "侧车依赖未安装：请先运行 pdfparse.bootstrap@1（首启下载案）",
            false,
        ));
    }
    let out_dir = match work_dir {
        Some(dir) => dir.to_path_buf(),
        None => ctx.library.root().join("pdfparse").join(&ctx.task_id),
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|err| BridgeError::internal(format!("解析工作目录创建失败: {err}")))?;

    let mut command = base_command(&layout, configured_hf_endpoint(ctx).as_deref());
    command
        .arg("--models-dir")
        .arg(&layout.models_dir)
        .arg("convert")
        .arg("--pdf")
        .arg(pdf_path)
        .arg("--out-dir")
        .arg(&out_dir);
    if formula_enrichment {
        command.arg("--formula-enrichment");
    }
    let mut harness = spawn_child(command)?;
    let started = Instant::now();
    let exit_code = wait_child(ctx, &mut harness)?;

    match read_sidecar_result(&out_dir, &harness) {
        Some(result) if result.ok => {
            let mut payload = result.payload;
            if let Value::Object(ref mut map) = payload {
                map.insert("workDir".to_string(), json!(out_dir.to_string_lossy()));
                map.insert(
                    "wallClockMs".to_string(),
                    json!(started.elapsed().as_millis() as u64),
                );
            }
            ctx.succeed(Some(payload));
            Ok(())
        }
        Some(result) => Err(map_failure(&result, &harness)),
        None => Err(crashed_error(exit_code, &harness)),
    }
}

/// pdfparse.bootstrap@1：首启下载案在线补齐依赖与模型。
/// 输入: { endpoint? }（缺省读 settings pdfparse.hfEndpoint，再缺省官方源+镜像回退）
/// 网络类任务：按统一重试策略重试（pip/snapshot_download 幂等，可安全重试）。
pub(crate) fn run_bootstrap(ctx: &RunContext, endpoint: Option<&str>) {
    if let Ok(payload) = run_with_retry(ctx, |ctx| bootstrap_once(ctx, endpoint)) {
        ctx.succeed(Some(payload));
    }
}

fn bootstrap_once(ctx: &RunContext, endpoint: Option<&str>) -> Result<Value, BridgeError> {
    ctx.cancel_checkpoint()?;
    let layout = require_sidecar(ctx)?;
    // download 案的模型落书库目录（安装目录视为只读；运行时目录在解析顺序中优先）。
    let runtime_models = ctx.library.root().join("pdfparse-models");
    std::fs::create_dir_all(&runtime_models)
        .map_err(|err| BridgeError::internal(format!("模型目录创建失败: {err}")))?;
    let manifest_dir = ctx.library.root().join("pdfparse").join(&ctx.task_id);
    std::fs::create_dir_all(&manifest_dir)
        .map_err(|err| BridgeError::internal(format!("工作目录创建失败: {err}")))?;

    let endpoint = endpoint
        .map(str::to_string)
        .or_else(|| configured_hf_endpoint(ctx));
    let mut command = base_command(&layout, endpoint.as_deref());
    // --models-dir 是全局参数，必须位于子命令之前。
    command
        .arg("--models-dir")
        .arg(&runtime_models)
        .arg("bootstrap")
        .arg("--sidecar-root")
        .arg(&layout.root)
        .arg("--manifest-dir")
        .arg(&manifest_dir);
    let mut harness = spawn_child(command)?;
    let exit_code = wait_child(ctx, &mut harness)?;

    match read_sidecar_result(&manifest_dir, &harness) {
        Some(result) if result.ok => Ok(result.payload),
        Some(result) => Err(map_failure(&result, &harness)),
        None => Err(crashed_error(exit_code, &harness)),
    }
}
