//! 常驻侧车契约测试（Issue #84，规格 #74 §A3；可观测性 Issue #88）。
//! 覆盖：serve 协议（READY / ping / convert 与 render 并行 / shutdown）、第二次
//! convert 免启动（startupMs == 0 且 resident: true）、连续三次 convert 复用同一
//! 进程（sidecarPid 相同、sidecarReused 递进）、常驻不可用回退一次一进程
//!（warnings 记 sidecar_resident_fallback + 原因码）、进程中途死亡回退时并入
//! stderr 尾巴（sidecarFallback）、取消 kill 常驻进程后下次请求重新拉起、
//! 空闲超时自动释放。
//!
//! 侧车未构建时跳过并打印原因；`PAPER30MIN_PDFPARSE_REQUIRE=1` 强制要求在场。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::pdfparse;
use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::wait_terminal;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// docling 模型加载吃内存与 CPU：本文件全部测试串行。
static RESIDENT_LOCK: Mutex<()> = Mutex::new(());

const CONVERT_TIMEOUT: Duration = Duration::from_secs(300);
const FAST_TIMEOUT: Duration = Duration::from_secs(30);

fn sample_pdf() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ui")
        .join("samples")
        .join("sample_paper.pdf")
}

fn sidecar_ready(library: &paper30min_lib::library::Library) -> bool {
    let status = pdfparse::status(library);
    let ready = status
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !ready {
        if std::env::var("PAPER30MIN_PDFPARSE_REQUIRE").is_ok() {
            panic!("PAPER30MIN_PDFPARSE_REQUIRE=1 但侧车未就绪: {status}");
        }
        eprintln!("跳过常驻侧车契约测试（侧车未就绪）: {status}");
    }
    ready
}

struct EnvGuard(&'static str);

impl Drop for EnvGuard {
    fn drop(&mut self) {
        std::env::remove_var(self.0);
    }
}

fn resident_state(registry: &Arc<TaskRegistry>, library: &paper30min_lib::library::Library) -> Value {
    let result = bridge::invoke(registry, library, "pdfparse.status@1", &json!({}))
        .expect("pdfparse.status@1");
    result["sidecar"]["resident"].clone()
}

fn start_convert(registry: &Arc<TaskRegistry>, pdf: &Path, work_dir: &Path) -> String {
    registry
        .start(
            pdfparse::TASK_CONVERT,
            json!({ "pdfPath": pdf.to_string_lossy(), "workDir": work_dir.to_string_lossy() }),
            paper30min_lib::testkit::Collector::new(),
        )
        .expect("启动 pdfparse.convert@1")
}

// ---------- 原始协议驱动（不经任务层） ----------

#[derive(Debug)]
enum ServeLine {
    Ready(Value),
    Result(Value),
}

struct ServeProcess {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<ServeLine>,
}

fn spawn_serve(layout: &pdfparse::SidecarLayout) -> ServeProcess {
    let mut command = Command::new(&layout.python_exe);
    command
        .arg(&layout.app_script)
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("HF_HUB_DISABLE_XET", "1")
        .arg("--models-dir")
        .arg(&layout.models_dir)
        .arg("--table-mode")
        .arg("fast")
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().expect("启动 serve 常驻进程");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(payload) = line.strip_prefix("PDFPARSE_READY ") {
                let _ = tx.send(ServeLine::Ready(serde_json::from_str(payload).unwrap()));
            } else if let Some(payload) = line.strip_prefix("PDFPARSE_RESULT ") {
                let _ = tx.send(ServeLine::Result(serde_json::from_str(payload).unwrap()));
            }
        }
    });
    ServeProcess {
        child,
        stdin,
        lines: rx,
    }
}

impl ServeProcess {
    fn send(&mut self, request: Value) {
        writeln!(self.stdin, "{}", serde_json::to_string(&request).unwrap())
            .expect("写入 serve 请求");
        self.stdin.flush().expect("flush serve 请求");
    }

    /// 收取下一个 PDFPARSE_RESULT（READY 已在 spawn 后单独断言）。
    fn recv_result(&self, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "等待 serve 结果超时");
            match self.lines.recv_timeout(remaining) {
                Ok(ServeLine::Result(value)) => return value,
                Ok(ServeLine::Ready(_)) => panic!("READY 应在请求前已消费"),
                Err(err) => panic!("serve 输出通道异常: {err}"),
            }
        }
    }
}

/// serve 契约：READY 先行；ping 回结果；convert 进行中提交的 render 并行完成；
/// shutdown 后进程退出。
#[test]
fn serve_protocol_ping_parallel_render_and_shutdown() {
    let (_registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();
    let layout = pdfparse::resolve_sidecar(Path::new(env!("CARGO_MANIFEST_DIR")))
        .expect("侧车在位");
    let mut serve = spawn_serve(&layout);

    // READY：启动完成先行（含 pid）。
    match serve.lines.recv_timeout(FAST_TIMEOUT) {
        Ok(ServeLine::Ready(payload)) => {
            assert!(payload["pid"].as_u64().unwrap() > 0, "READY 应带 pid");
        }
        other => panic!("首条协议行应为 READY，实得 {other:?}"),
    }

    serve.send(json!({ "id": 1, "op": "ping" }));
    let pong = serve.recv_result(FAST_TIMEOUT);
    assert_eq!(pong["id"], json!(1));
    assert_eq!(pong["ok"], json!(true));

    // convert 进行中提交 render：render（独立线程，只用 pypdfium2）应先完成。
    let convert_dir = dir.path().join("serve-convert");
    let render_dir = dir.path().join("serve-render");
    let job_path = dir.path().join("serve-job.json");
    std::fs::write(&job_path, serde_json::to_vec(&json!({ "scale": 2, "quality": 86, "pages": [1] })).unwrap())
        .expect("写渲染作业");
    serve.send(json!({
        "id": 2, "op": "convert",
        "pdf": sample_pdf().to_string_lossy(),
        "outDir": convert_dir.to_string_lossy(),
    }));
    std::thread::sleep(Duration::from_secs(2));
    serve.send(json!({
        "id": 3, "op": "render",
        "pdf": sample_pdf().to_string_lossy(),
        "outDir": render_dir.to_string_lossy(),
        "job": job_path.to_string_lossy(),
    }));

    let first = serve.recv_result(CONVERT_TIMEOUT);
    let second = serve.recv_result(CONVERT_TIMEOUT);
    assert_eq!(first["id"], json!(3), "render 应与 convert 并行完成（先到）: {first}");
    assert_eq!(first["ok"], json!(true));
    assert_eq!(second["id"], json!(2));
    assert_eq!(second["ok"], json!(true), "convert 应成功: {second}");
    assert!(convert_dir.join("docling.json").is_file());
    assert!(render_dir.join("pages").join("page-1.webp").is_file());

    serve.send(json!({ "id": 9, "op": "shutdown" }));
    let ack = serve.recv_result(FAST_TIMEOUT);
    assert_eq!(ack["id"], json!(9));
    assert_eq!(ack["ok"], json!(true));
    let status = serve.child.wait().expect("等待 serve 退出");
    assert_eq!(status.code(), Some(0), "shutdown 后应干净退出");
}

/// 第二次 convert 复用常驻进程：resident: true 且 startupMs == 0。
#[test]
fn resident_second_convert_has_zero_startup() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();

    let first_id = start_convert(&registry, &sample_pdf(), &dir.path().join("r-conv-1"));
    let status = wait_terminal(&registry, &first_id, CONVERT_TIMEOUT).expect("第一次转换超时");
    assert_eq!(status, TaskStatus::Succeeded);
    let first = registry.get(&first_id).unwrap().result.expect("第一次结果");
    assert_eq!(first["resident"], json!(true), "常驻可用时不应回退: {first}");
    assert!(first["startupMs"].as_u64().is_some());
    assert!(
        !first["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!(paper30min_lib::pdfpool::FALLBACK_WARNING)),
        "常驻命中不应有回退警示: {first}"
    );

    let resident = resident_state(&registry, &library);
    assert_eq!(resident["state"], json!("ready"), "常驻应就绪: {resident}");
    assert!(resident["pid"].as_u64().is_some(), "就绪时应暴露 pid");

    let second_id = start_convert(&registry, &sample_pdf(), &dir.path().join("r-conv-2"));
    let status = wait_terminal(&registry, &second_id, CONVERT_TIMEOUT).expect("第二次转换超时");
    assert_eq!(status, TaskStatus::Succeeded);
    let second = registry.get(&second_id).unwrap().result.expect("第二次结果");
    assert_eq!(second["resident"], json!(true));
    assert_eq!(
        second["startupMs"],
        json!(0),
        "常驻命中（模型已加载）的启动拆分应为 0: {second}"
    );
    // 第二篇应显著快于第一篇（免模型加载）。
    assert!(
        second["wallClockMs"].as_u64().unwrap() < first["wallClockMs"].as_u64().unwrap(),
        "第二次常驻转换应更快: first={} second={}",
        first["wallClockMs"],
        second["wallClockMs"]
    );
}

/// #88 验收：连续 3 次 convert 复用同一常驻进程——第 2 次起 startupMs == 0 且
/// 无 modelLoadMs（模型不再重载），sidecarPid 三次相同，sidecarReused 依次为
/// false / true / true（首次拉起进程，其后复用）。
#[test]
fn resident_three_converts_reuse_same_pid() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();

    let mut pids = Vec::new();
    let mut reused = Vec::new();
    for index in 1..=3 {
        let task_id = start_convert(
            &registry,
            &sample_pdf(),
            &dir.path().join(format!("w-conv-{index}")),
        );
        let status = wait_terminal(&registry, &task_id, CONVERT_TIMEOUT).expect("转换超时");
        assert_eq!(status, TaskStatus::Succeeded, "第 {index} 次转换应成功");
        let result = registry.get(&task_id).unwrap().result.expect("结果");
        assert_eq!(result["resident"], json!(true), "应命中常驻: {result}");
        pids.push(
            result["sidecarPid"]
                .as_u64()
                .unwrap_or_else(|| panic!("常驻命中应带 sidecarPid: {result}")),
        );
        reused.push(result["sidecarReused"].as_bool().expect("应带 sidecarReused"));
        if index > 1 {
            assert_eq!(
                result["startupMs"], json!(0),
                "第 {index} 次常驻复用不应再付模型加载: {result}"
            );
            assert!(
                result.get("modelLoadMs").is_none(),
                "第 {index} 次常驻复用不应有 modelLoadMs: {result}"
            );
        }
    }
    assert_eq!(pids[0], pids[1], "第 1/2 次应为同一常驻进程: {pids:?}");
    assert_eq!(pids[1], pids[2], "第 2/3 次应为同一常驻进程: {pids:?}");
    assert_eq!(reused, vec![false, true, true], "复用判定: {reused:?}");
}

/// 常驻不可用（serve 入口指向不存在的脚本）时任务仍成功，warnings 记
/// sidecar_resident_fallback 与原因码 spawn_failed；连续 2 次回退后本会话停用常驻。
#[test]
fn resident_fallback_when_serve_entry_missing() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();
    let _env = EnvGuard(paper30min_lib::pdfpool::SERVE_ENTRY_ENV);
    std::env::set_var(
        paper30min_lib::pdfpool::SERVE_ENTRY_ENV,
        dir.path().join("no-such-serve-entry.py"),
    );

    for (index, name) in ["f-conv-1", "f-conv-2"].iter().enumerate() {
        let task_id = start_convert(&registry, &sample_pdf(), &dir.path().join(name));
        let status = wait_terminal(&registry, &task_id, CONVERT_TIMEOUT).expect("回退转换超时");
        assert_eq!(status, TaskStatus::Succeeded, "常驻不可用应回退成功");
        let result = registry.get(&task_id).unwrap().result.expect("结果");
        assert_eq!(result["resident"], json!(false), "回退路径 resident 应为 false");
        assert!(
            result["warnings"]
                .as_array()
                .unwrap()
                .contains(&json!(paper30min_lib::pdfpool::FALLBACK_WARNING)),
            "回退应记 sidecar_resident_fallback: {result}"
        );
        assert!(
            result["warnings"]
                .as_array()
                .unwrap()
                .contains(&json!("sidecar_fallback_reason:spawn_failed")),
            "回退应记原因码（#88）: {result}"
        );
        assert_eq!(
            result["sidecarFallback"]["reason"],
            json!("spawn_failed"),
            "载荷应带 sidecarFallback 诊断（#88）: {result}"
        );
        let resident = resident_state(&registry, &library);
        assert_eq!(
            resident["consecutiveFallbacks"],
            json!(index as u64 + 1),
            "回退计数: {resident}"
        );
    }
    let resident = resident_state(&registry, &library);
    assert_eq!(
        resident["state"],
        json!("disabled"),
        "连续 2 次回退后本会话应停用常驻: {resident}"
    );
}

/// #88：常驻进程在请求中途死亡（fake serve 收到请求即写 stderr 退出）时，任务
/// 回退一次一进程仍成功；载荷 sidecarFallback 记 process_died 原因并并入池捕获的
/// stderr 尾巴，warnings 记原因码——现场再遇「池为何回退」可一眼定位。
#[test]
fn resident_process_death_reports_stderr_tail() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();
    let fake = dir.path().join("fake-serve.py");
    std::fs::write(
        &fake,
        r#"
import json, os, sys
print("PDFPARSE_READY " + json.dumps({"pid": os.getpid()}), flush=True)
sys.stdin.readline()
sys.stderr.write("fake-serve-death-marker #88\n")
sys.stderr.flush()
os._exit(3)
"#,
    )
    .expect("写 fake serve 脚本");
    let _env = EnvGuard(paper30min_lib::pdfpool::SERVE_ENTRY_ENV);
    std::env::set_var(paper30min_lib::pdfpool::SERVE_ENTRY_ENV, &fake);

    let task_id = start_convert(&registry, &sample_pdf(), &dir.path().join("d-conv"));
    let status = wait_terminal(&registry, &task_id, CONVERT_TIMEOUT).expect("转换超时");
    assert_eq!(status, TaskStatus::Succeeded, "进程死亡应回退一次一进程成功");
    let result = registry.get(&task_id).unwrap().result.expect("结果");
    assert_eq!(result["resident"], json!(false), "应走回退路径: {result}");
    assert_eq!(
        result["sidecarFallback"]["reason"],
        json!("process_died"),
        "应记 process_died 原因: {result}"
    );
    let tail = result["sidecarFallback"]["stderrTail"]
        .as_str()
        .unwrap_or_default();
    assert!(
        tail.contains("fake-serve-death-marker"),
        "stderr 尾巴应并入载荷诊断: {result}"
    );
    assert!(
        result["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!("sidecar_fallback_reason:process_died")),
        "warnings 应记原因码: {result}"
    );
}

/// 取消进行中的常驻 convert：任务 cancelled、常驻进程被 kill；下一次 convert
/// 重新拉起并成功（接受一次冷启）。
#[test]
fn resident_cancel_kills_child_and_next_convert_respawns() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();

    let work_dir = dir.path().join("r-cancel");
    let task_id = start_convert(&registry, &sample_pdf(), &work_dir);
    // 等任务进入运行态（模型加载期，取消必落在常驻进程存活期）。
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if registry.get(&task_id).unwrap().status == TaskStatus::Running {
            break;
        }
        assert!(Instant::now() < deadline, "任务未进入运行态");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_secs(2));
    registry.request_cancel(&task_id).expect("请求取消");

    let status = wait_terminal(&registry, &task_id, FAST_TIMEOUT).expect("取消后任务应收敛");
    assert_eq!(status, TaskStatus::Cancelled);
    assert!(
        !work_dir.join("docling.json").exists(),
        "取消不产生部分结果"
    );
    // 常驻进程已被 kill（2 秒宽限内 Docling 不可中断）：池回到未启动。
    let resident = resident_state(&registry, &library);
    assert_eq!(
        resident["state"],
        json!("not_started"),
        "取消 kill 后常驻应需重启: {resident}"
    );

    let next_id = start_convert(&registry, &sample_pdf(), &dir.path().join("r-after-cancel"));
    let status = wait_terminal(&registry, &next_id, CONVERT_TIMEOUT).expect("重启转换超时");
    assert_eq!(status, TaskStatus::Succeeded, "取消后下一次 convert 应重新拉起并成功");
    let result = registry.get(&next_id).unwrap().result.expect("结果");
    assert_eq!(result["resident"], json!(true));
}

/// 空闲超时（测试钩子 PAPER30MIN_PDFPARSE_IDLE_SECS）后常驻进程自动释放；
/// 下一次 convert 重新拉起并成功。
#[test]
fn resident_idle_shutdown_releases_and_restarts() {
    let (registry, library, dir) = common::env();
    if !sidecar_ready(&library) {
        return;
    }
    let _guard = RESIDENT_LOCK.lock().unwrap();
    let _env = EnvGuard(paper30min_lib::pdfpool::IDLE_SECS_ENV);
    std::env::set_var(paper30min_lib::pdfpool::IDLE_SECS_ENV, "3");

    let first_id = start_convert(&registry, &sample_pdf(), &dir.path().join("i-conv-1"));
    let status = wait_terminal(&registry, &first_id, CONVERT_TIMEOUT).expect("转换超时");
    assert_eq!(status, TaskStatus::Succeeded);
    assert_eq!(registry.get(&first_id).unwrap().result.unwrap()["resident"], json!(true));

    // 空闲 3s + 看门狗 500ms 节拍：10s 内应释放。
    let deadline = Instant::now() + Duration::from_secs(15);
    let released = loop {
        let resident = resident_state(&registry, &library);
        if resident["state"] == json!("released") {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    assert!(released, "空闲超时后常驻应释放（released）");

    let second_id = start_convert(&registry, &sample_pdf(), &dir.path().join("i-conv-2"));
    let status = wait_terminal(&registry, &second_id, CONVERT_TIMEOUT).expect("重启转换超时");
    assert_eq!(status, TaskStatus::Succeeded, "释放后下一次 convert 应自动重启并成功");
    assert_eq!(registry.get(&second_id).unwrap().result.unwrap()["resident"], json!(true));
}

/// 新设置键的默认值与校验（不需要侧车）。
#[test]
fn pdfparse_settings_warm_start_and_idle_shutdown() {
    let (registry, library, _dir) = common::env();
    let settings = bridge::invoke(&registry, &library, "settings.get@1", &json!({}))
        .expect("settings.get@1");
    assert_eq!(settings["pdfparse"]["warmStart"], json!(true), "预热默认开");
    assert_eq!(
        settings["pdfparse"]["idleShutdownMinutes"],
        json!(10),
        "空闲释放默认 10 分钟"
    );

    bridge::invoke(
        &registry,
        &library,
        "settings.putPdfparse@1",
        &json!({ "settings": { "warmStart": false, "idleShutdownMinutes": 30 } }),
    )
    .expect("写入常驻设置");
    let settings = bridge::invoke(&registry, &library, "settings.get@1", &json!({}))
        .expect("settings.get@1");
    assert_eq!(settings["pdfparse"]["warmStart"], json!(false));
    assert_eq!(settings["pdfparse"]["idleShutdownMinutes"], json!(30));

    let error = bridge::invoke(
        &registry,
        &library,
        "settings.putPdfparse@1",
        &json!({ "settings": { "idleShutdownMinutes": 0 } }),
    )
    .expect_err("0 分钟应被拒绝");
    assert_eq!(error.code, "invalid_input");
    let error = bridge::invoke(
        &registry,
        &library,
        "settings.putPdfparse@1",
        &json!({ "settings": { "warmStart": "yes" } }),
    )
    .expect_err("非布尔 warmStart 应被拒绝");
    assert_eq!(error.code, "invalid_input");
}
