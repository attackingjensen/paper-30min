//! pdfparse 侧车契约测试（Issue #57，规格 #48 §Testing Decisions 唯一新接缝）。
//! 驱动方式：夹具 PDF → 子进程 → 结构化输出/错误码；只断言外部可观察行为
//! （任务终态、result 载荷、错误码、产物文件），不断言 Docling 内部中间态。
//!
//! 侧车目录解析见 pdfparse.rs（环境变量 → 可执行文件旁 → 仓库开发目录）。
//! 未构建侧车（干净克隆）时本文件测试跳过并打印原因；打包/发布验证设
//! `PAPER30MIN_PDFPARSE_REQUIRE=1` 强制要求侧车在场。
//! OCR 慢测试（真实加载 RapidOCR 模型，约 2–3 分钟）默认跳过，设
//! `PAPER30MIN_PDFPARSE_SLOW=1` 开启。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::library::Library;
use paper30min_lib::pdfparse;
use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::{wait_terminal, Collector};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 侧车转换夹具共用一把锁：docling 模型加载吃内存与 CPU，串行防抖动。
static SIDECAR_LOCK: Mutex<()> = Mutex::new(());

const CONVERT_TIMEOUT: Duration = Duration::from_secs(300);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(60);

fn sample_pdf() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ui")
        .join("samples")
        .join("sample_paper.pdf")
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// 侧车是否可用；不可用时按 REQUIRE 环境变量决定跳过还是失败。
fn sidecar_ready(library: &Library) -> bool {
    let status = pdfparse::status(library);
    let ready = status
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !ready {
        if std::env::var("PAPER30MIN_PDFPARSE_REQUIRE").is_ok() {
            panic!("PAPER30MIN_PDFPARSE_REQUIRE=1 但侧车未就绪: {status}");
        }
        eprintln!("跳过 pdfparse 契约测试（侧车未就绪）: {status}");
    }
    ready
}

fn start_convert(
    registry: &Arc<TaskRegistry>,
    pdf: &Path,
    work_dir: Option<&Path>,
) -> (String, Arc<Collector>) {
    let sink = Collector::new();
    let mut input = json!({ "pdfPath": pdf.to_string_lossy() });
    if let Some(dir) = work_dir {
        input["workDir"] = json!(dir.to_string_lossy());
    }
    let task_id = registry
        .start(pdfparse::TASK_CONVERT, input, sink.clone())
        .expect("启动 pdfparse.convert@1");
    (task_id, sink)
}

#[test]
fn status_reports_sidecar_layout() {
    let (registry, library, _dir) = common::env();
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let result = bridge::invoke(&registry, &library, "pdfparse.status@1", &json!({}))
        .expect("pdfparse.status@1");
    assert_eq!(result["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    let sidecar = &result["sidecar"];
    if !sidecar_ready(&library) {
        return;
    }
    assert_eq!(sidecar["present"], json!(true));
    assert_eq!(sidecar["depsReady"], json!(true));
    assert_eq!(sidecar["modelsReady"], json!(true));
    assert_eq!(sidecar["variant"], json!("bundled"));
    assert_eq!(sidecar["missingModels"], json!([]));
}

/// 环境变量守卫：测试结束（含 panic）时移除，避免污染同进程其他测试。
struct EnvGuard(&'static str);

impl Drop for EnvGuard {
    fn drop(&mut self) {
        std::env::remove_var(self.0);
    }
}

#[test]
fn convert_without_deps_reports_bootstrap_required() {
    // download 案未 bootstrap：骨架侧车（python.exe 在、无 site-packages/docling）
    // 应得到结构化 bootstrap_required，而不是子进程崩溃。无需真实侧车。
    let (registry, _library, _dir) = common::env();
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let fake = tempfile::tempdir().expect("临时目录");
    std::fs::create_dir_all(fake.path().join("python")).unwrap();
    std::fs::write(fake.path().join("python").join("python.exe"), b"").unwrap();
    std::fs::create_dir_all(fake.path().join("app")).unwrap();
    std::fs::write(fake.path().join("app").join("pdfparse_sidecar.py"), b"").unwrap();
    let _env = EnvGuard(pdfparse::SIDECAR_HOME_ENV);
    std::env::set_var(pdfparse::SIDECAR_HOME_ENV, fake.path());

    let (task_id, _sink) = start_convert(&registry, &sample_pdf(), None);
    let status = wait_terminal(&registry, &task_id, CANCEL_TIMEOUT).expect("任务超时");
    assert_eq!(status, TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.expect("失败应带错误");
    assert_eq!(error.code, "bootstrap_required");
    assert!(!error.retryable);
}

#[test]
fn convert_sample_pdf_produces_docling_document() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let work_dir = dir.path().join("convert-ok");
    let (task_id, sink) = start_convert(&registry, &sample_pdf(), Some(&work_dir));

    let status = wait_terminal(&registry, &task_id, CONVERT_TIMEOUT).expect("转换超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let snapshot = registry.get(&task_id).expect("任务快照");
    let result = snapshot.result.expect("succeeded 应携带 result");
    let docling_path = PathBuf::from(result["doclingJsonPath"].as_str().expect("doclingJsonPath"));
    assert!(docling_path.is_file(), "DoclingDocument JSON 应落盘");
    assert_eq!(result["pages"], json!(2));
    assert_eq!(result["doclingVersion"], json!("2.126.0"));
    assert!(result["elapsedMs"].as_u64().unwrap() > 0);
    assert_eq!(result["ocrPages"], json!([]));

    // 块级 prov 契约（#48 用户故事 13）：文本块带 page_no + BOTTOMLEFT bbox。
    let doc: Value = serde_json::from_str(
        &std::fs::read_to_string(&docling_path).expect("读取 docling.json"),
    )
    .expect("docling.json 应是合法 JSON");
    assert_eq!(doc["schema_name"], json!("DoclingDocument"));
    let texts = doc["texts"].as_array().expect("texts 数组");
    assert!(!texts.is_empty(), "示例论文应有文本块");
    let first_prov = &texts[0]["prov"][0];
    assert!(first_prov["page_no"].as_u64().unwrap() >= 1);
    assert_eq!(first_prov["bbox"]["coord_origin"], json!("BOTTOMLEFT"));
}

#[test]
fn convert_missing_pdf_fails_with_structured_error() {
    // Rust 侧预检（不启动子进程），无侧车也可运行。
    let (registry, _library, dir) = common::env();
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let missing = dir.path().join("no-such.pdf");
    let (task_id, _sink) = start_convert(&registry, &missing, None);

    let status = wait_terminal(&registry, &task_id, CANCEL_TIMEOUT).expect("任务超时");
    assert_eq!(status, TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.expect("失败应带错误");
    assert_eq!(error.code, "pdf_not_found");
    assert!(!error.retryable, "文件不存在不可重试");
}

#[test]
fn convert_corrupt_pdf_fails_with_structured_error() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let work_dir = dir.path().join("convert-corrupt");
    let (task_id, _sink) = start_convert(&registry, &fixture("pdfparse_corrupt.pdf"), Some(&work_dir));

    let status = wait_terminal(&registry, &task_id, CONVERT_TIMEOUT).expect("任务超时");
    assert_eq!(status, TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.expect("失败应带错误");
    assert_eq!(error.code, "pdf_open_failed", "损坏 PDF 应归类为打开失败: {error:?}");
    assert!(!error.retryable);
    // 不产生部分结果（规格 #48 §诚实档 16）。
    assert!(!work_dir.join("docling.json").exists());
}

#[test]
fn convert_cancel_terminates_subprocess() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let work_dir = dir.path().join("convert-cancel");
    let (task_id, _sink) = start_convert(&registry, &sample_pdf(), Some(&work_dir));

    // 等任务进入运行态后请求取消：模型加载需数十秒，取消必落在子进程存活期。
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if registry.get(&task_id).unwrap().status == TaskStatus::Running {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "任务未进入运行态");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_secs(2));
    registry.request_cancel(&task_id).expect("请求取消");

    let status = wait_terminal(&registry, &task_id, CANCEL_TIMEOUT).expect("取消后任务应收敛到终态");
    assert_eq!(status, TaskStatus::Cancelled);
    // 取消 = 终止子进程，不产生部分结果。
    assert!(!work_dir.join("docling.json").exists());
}

#[test]
fn convert_rejects_missing_pdf_path_input() {
    // 计划阶段校验（不启动子进程），无侧车也可运行。
    let (registry, _library, _dir) = common::env();
    let error = registry
        .start(pdfparse::TASK_CONVERT, json!({}), Collector::new())
        .expect_err("缺少 pdfPath 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
}

/// OCR 降级路径：无文本层页面触发 RapidOCR（torch 后端）并打降级标记。
/// 真实加载 OCR 模型，耗时 2–3 分钟，默认跳过。
#[test]
fn convert_scanned_blank_page_marks_ocr_degraded() {
    if std::env::var("PAPER30MIN_PDFPARSE_SLOW").is_err() {
        eprintln!("跳过 OCR 慢测试（设 PAPER30MIN_PDFPARSE_SLOW=1 开启）");
        return;
    }
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = SIDECAR_LOCK.lock().unwrap();
    let work_dir = dir.path().join("convert-ocr");
    let (task_id, sink) = start_convert(&registry, &fixture("pdfparse_scanned_blank.pdf"), Some(&work_dir));

    let status = wait_terminal(&registry, &task_id, Duration::from_secs(600)).expect("转换超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());
    let result = registry.get(&task_id).unwrap().result.unwrap();
    assert_eq!(result["pages"], json!(1));
    assert_eq!(result["ocrPages"], json!([1]));
    assert!(
        result["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!("scanned_pages_ocr")),
        "无文本层页应带降级提示: {result}"
    );
}
