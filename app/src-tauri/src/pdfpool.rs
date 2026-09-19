//! 常驻侧车池（Issue #84，规格 #74 §A3）。
//!
//! 持有单个常驻 `serve` 子进程：懒启动；请求 id 单调递增；读线程按 `id` 把进度与
//! 结果行分发到各请求的 channel。`pdfparse.convert@1` / `pdfassets.prerender@1`
//! 任务优先向池提交请求并等待；取消检查点命中时向池发 `cancel`，2 秒内未收到结果
//! 则 kill 子进程并标记需重启（下次请求重新拉起，接受一次冷启）。
//!
//! 回退：常驻进程 spawn 失败、READY 超时（30s）、协议行不可解析或进程中途死亡时，
//! 本次请求走现有一次一进程路径，任务结果 warnings 记 `sidecar_resident_fallback`；
//! 连续 2 次回退后本会话（本注册表）停用常驻。空闲超时（设置
//! `pdfparse.idleShutdownMinutes`，默认 10 分钟）后发 `shutdown` 并回收，下次请求
//! 重新启动。应用启动预热见 `pdfparse::warm_resident_sidecar`。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::error::BridgeError;
use crate::pdfparse::{SidecarLayout, PROGRESS_PREFIX, READY_PREFIX, RESULT_PREFIX, STDERR_TAIL};
use crate::tasks::{Progress, RunContext};

/// 回退到一次一进程时写入任务结果 warnings 的标记（规格 #74 §A3）。
pub const FALLBACK_WARNING: &str = "sidecar_resident_fallback";
/// serve 入口脚本覆盖（测试/诊断用）：指向不存在的脚本可伪造常驻不可用。
pub const SERVE_ENTRY_ENV: &str = "PAPER30MIN_PDFPARSE_SERVE";
/// 空闲释放的秒级覆盖（契约测试钩子；生产路径用设置 pdfparse.idleShutdownMinutes）。
pub const IDLE_SECS_ENV: &str = "PAPER30MIN_PDFPARSE_IDLE_SECS";

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const WARM_TIMEOUT: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_CONSECUTIVE_FALLBACKS: u32 = 2;

/// 常驻侧车状态（设置面板「解析」区展示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentState {
    NotStarted,
    Warming,
    Ready,
    Released,
    Disabled,
}

impl ResidentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotStarted => "not_started",
            Self::Warming => "warming",
            Self::Ready => "ready",
            Self::Released => "released",
            Self::Disabled => "disabled",
        }
    }
}

/// 池请求的结局：Completed 携带侧车成功载荷与启动拆分遥测；Failed 是侧车归类的
/// 业务失败（ok:false，不触发回退）；Fallback 由调用方走一次一进程；Cancelled
/// 由任务层切换 cancelled 终态。
pub enum PoolOutcome {
    Completed {
        payload: Value,
        startup_ms: Option<u64>,
        model_load_ms: Option<u64>,
    },
    Failed(BridgeError),
    Fallback,
    Cancelled,
}

enum PoolEvent {
    Progress(Progress, Option<String>),
    Result(Value),
    Died,
}

/// 读线程与请求者共享的分发状态。
struct ReaderShared {
    pending: Mutex<HashMap<u64, mpsc::Sender<PoolEvent>>>,
    ready: Mutex<Option<Result<u32, String>>>,
    ready_cv: Condvar,
    broken: AtomicBool,
}

impl ReaderShared {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            ready: Mutex::new(None),
            ready_cv: Condvar::new(),
            broken: AtomicBool::new(false),
        }
    }

    /// 协议破裂或 EOF：唤醒 READY 等待者，并把全部在途请求标为 Died。
    fn mark_broken(&self, reason: String) {
        self.broken.store(true, Ordering::SeqCst);
        {
            let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
            if ready.is_none() {
                *ready = Some(Err(reason));
            }
        }
        self.ready_cv.notify_all();
        let pending = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, tx) in pending {
            let _ = tx.send(PoolEvent::Died);
        }
    }

    fn dispatch(&self, payload: &str, is_progress: bool) -> Result<(), serde_json::Error> {
        let value = serde_json::from_str::<Value>(payload)?;
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            return Ok(());
        };
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned();
        if let Some(tx) = tx {
            let event = if is_progress {
                let done = value.get("done").and_then(Value::as_u64).unwrap_or(0);
                let total = value.get("total").and_then(Value::as_u64).unwrap_or(0);
                let stage = value
                    .get("stage")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                PoolEvent::Progress(Progress { done, total }, stage)
            } else {
                PoolEvent::Result(value)
            };
            let _ = tx.send(event);
        }
        Ok(())
    }
}

fn reader_loop(stdout: impl Read, shared: Arc<ReaderShared>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(payload) = line.strip_prefix(READY_PREFIX) {
            let parsed = serde_json::from_str::<Value>(payload)
                .ok()
                .and_then(|value| value.get("pid").and_then(Value::as_u64))
                .map(|pid| pid as u32)
                .ok_or_else(|| "READY 载荷不可解析".to_string());
            {
                let mut ready = shared.ready.lock().unwrap_or_else(|e| e.into_inner());
                if ready.is_none() {
                    *ready = Some(parsed);
                }
            }
            shared.ready_cv.notify_all();
            continue;
        }
        if let Some(payload) = line.strip_prefix(PROGRESS_PREFIX) {
            if let Err(err) = shared.dispatch(payload, true) {
                shared.mark_broken(format!("进度行不可解析: {err}"));
            }
            continue;
        }
        if let Some(payload) = line.strip_prefix(RESULT_PREFIX) {
            if let Err(err) = shared.dispatch(payload, false) {
                shared.mark_broken(format!("结果行不可解析: {err}"));
            }
            continue;
        }
        // 非协议行忽略：torch/docling 可能向 stdout 打噪音（与一次一进程路径一致）。
    }
    shared.mark_broken("常驻侧车 stdout 已关闭".to_string());
}

fn spawn_stderr_tail(stderr: impl Read + Send + 'static) -> Arc<Mutex<String>> {
    let tail = Arc::new(Mutex::new(String::new()));
    let writer = Arc::clone(&tail);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0_u8; 2048];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let mut tail = writer.lock().unwrap_or_else(|e| e.into_inner());
                    tail.push_str(&chunk);
                    if tail.len() > STDERR_TAIL {
                        let bytes = tail.as_bytes()[tail.len() - STDERR_TAIL..].to_vec();
                        *tail = String::from_utf8_lossy(&bytes).into_owned();
                    }
                }
            }
        }
    });
    tail
}

struct ResidentChild {
    child: Child,
    stdin: ChildStdin,
    shared: Arc<ReaderShared>,
    stderr_tail: Arc<Mutex<String>>,
    pid: u32,
}

impl ResidentChild {
    /// 注册在途请求并写入请求行；写管道失败时回滚注册并返回 false（调用方按回退处理）。
    fn send_request(&mut self, id: u64, line: &str, tx: mpsc::Sender<PoolEvent>) -> bool {
        self.shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        if writeln!(self.stdin, "{line}")
            .and_then(|_| self.stdin.flush())
            .is_err()
        {
            self.shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return false;
        }
        true
    }
}

/// 回收常驻子进程（kill + wait 收割，避免僵尸进程）。
fn reap_child(mut child: ResidentChild) {
    let _ = child.child.kill();
    let _ = child.child.wait();
}

struct PoolState {
    child: Option<ResidentChild>,
    consecutive_fallbacks: u32,
    idle_deadline: Option<Instant>,
}

/// 常驻侧车池。随 TaskRegistry 同生命周期（注册表即会话）：注册表 drop 时回收子进程。
///
/// `status` 独立成锁：spawn/模型加载期间 state 锁会被占住，状态查询仍须即时返回
/// （设置面板轮询）。状态语义：NotStarted（无进程）→ Warming（拉起中 / 首个请求
/// 在飞）→ Ready（已服务过请求）→ Released（空闲释放）/ Disabled（本会话停用）。
pub struct SidecarPool {
    state: Mutex<PoolState>,
    status: Mutex<ResidentState>,
    next_id: AtomicU64,
}

impl SidecarPool {
    pub fn new() -> Arc<Self> {
        let pool = Arc::new(Self {
            state: Mutex::new(PoolState {
                child: None,
                consecutive_fallbacks: 0,
                idle_deadline: None,
            }),
            status: Mutex::new(ResidentState::NotStarted),
            next_id: AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&pool);
        std::thread::Builder::new()
            .name("pdfparse-idle-watchdog".to_string())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let Some(pool) = weak.upgrade() else {
                    return;
                };
                pool.idle_tick();
            })
            .expect("启动侧车空闲看门狗线程");
        pool
    }

    fn set_status(&self, status: ResidentState) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    fn resident_state(&self) -> ResidentState {
        *self
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn status_json(&self) -> Value {
        let status = self.resident_state();
        // state 锁可能被进行中的 spawn 占住：pid/回退计数尽力而为，不阻塞状态查询。
        let state = self.state.try_lock().ok();
        json!({
            "state": status.as_str(),
            "consecutiveFallbacks": state.as_ref().map(|s| s.consecutive_fallbacks).unwrap_or(0),
            "pid": state.as_ref().and_then(|s| s.child.as_ref().map(|child| child.pid)),
        })
    }

    /// 应用启动预热：后台拉起常驻进程并触发默认键的模型加载；失败只记日志，
    /// 不计入回退停用计数（首个真实请求仍会按需冷启或回退）。
    pub(crate) fn warm(
        self: &Arc<Self>,
        layout: &SidecarLayout,
        hf_endpoint: Option<&str>,
        table_mode: &str,
        idle_timeout: Duration,
    ) {
        let pool = Arc::clone(self);
        let layout = layout.clone();
        let hf_endpoint = hf_endpoint.map(str::to_string);
        let table_mode = table_mode.to_string();
        let _ = std::thread::Builder::new()
            .name("pdfparse-warm".to_string())
            .spawn(move || {
                let outcome = pool.submit(
                    &layout,
                    hf_endpoint.as_deref(),
                    &table_mode,
                    idle_timeout,
                    "warm",
                    json!({
                        "modelsDir": layout.models_dir.to_string_lossy(),
                        "tableMode": table_mode,
                    }),
                    None,
                    false,
                    Some(WARM_TIMEOUT),
                );
                if !matches!(outcome, PoolOutcome::Completed { .. }) {
                    eprintln!("[pdfpool] 常驻侧车预热未生效（忽略，首个解析任务按需冷启或回退）");
                }
            });
    }

    /// convert 请求：参数与侧车 convert 子命令一致（#84：含 tableMode 按请求携带）。
    pub(crate) fn convert(
        self: &Arc<Self>,
        ctx: &RunContext,
        layout: &SidecarLayout,
        pdf_path: &Path,
        out_dir: &Path,
        formula_enrichment: bool,
        table_mode: &str,
        hf_endpoint: Option<&str>,
        idle_timeout: Duration,
    ) -> PoolOutcome {
        self.submit(
            layout,
            hf_endpoint,
            table_mode,
            idle_timeout,
            "convert",
            json!({
                "pdf": pdf_path.to_string_lossy(),
                "outDir": out_dir.to_string_lossy(),
                "modelsDir": layout.models_dir.to_string_lossy(),
                "tableMode": table_mode,
                "formulaEnrichment": formula_enrichment,
            }),
            Some(ctx),
            true,
            None,
        )
    }

    /// render 请求：与 convert 并行（侧车侧 render 走独立线程，只用 pypdfium2 + Pillow）。
    pub(crate) fn render(
        self: &Arc<Self>,
        ctx: &RunContext,
        layout: &SidecarLayout,
        pdf_path: &Path,
        out_dir: &Path,
        job_path: &Path,
        table_mode: &str,
        idle_timeout: Duration,
    ) -> PoolOutcome {
        self.submit(
            layout,
            None,
            table_mode,
            idle_timeout,
            "render",
            json!({
                "pdf": pdf_path.to_string_lossy(),
                "outDir": out_dir.to_string_lossy(),
                "job": job_path.to_string_lossy(),
            }),
            Some(ctx),
            true,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn submit(
        self: &Arc<Self>,
        layout: &SidecarLayout,
        hf_endpoint: Option<&str>,
        table_mode: &str,
        idle_timeout: Duration,
        op: &str,
        fields: Value,
        ctx: Option<&RunContext>,
        count_fallback: bool,
        overall_timeout: Option<Duration>,
    ) -> PoolOutcome {
        if self.resident_state() == ResidentState::Disabled {
            return PoolOutcome::Fallback;
        }
        if self.ensure_child(layout, hf_endpoint, table_mode).is_err() {
            if count_fallback {
                self.note_fallback();
            }
            return PoolOutcome::Fallback;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut request = fields;
        request["id"] = json!(id);
        request["op"] = json!(op);
        let (tx, rx) = mpsc::channel();
        // 注册在途请求并写入 stdin；与空闲看门狗的 shutdown 互斥（同一把 state 锁）。
        // 若 ensure 之后 child 恰被看门狗回收，重新拉起重试一次。
        let mut respawned = false;
        loop {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(child) = state.child.as_mut() else {
                drop(state);
                if respawned || self.ensure_child(layout, hf_endpoint, table_mode).is_err() {
                    if count_fallback {
                        self.note_fallback();
                    }
                    return PoolOutcome::Fallback;
                }
                respawned = true;
                continue;
            };
            let line = match serde_json::to_string(&request) {
                Ok(line) => line,
                Err(err) => {
                    return PoolOutcome::Failed(BridgeError::internal(format!(
                        "常驻请求序列化失败: {err}"
                    )));
                }
            };
            if !child.send_request(id, &line, tx) {
                drop(state);
                self.kill_child();
                if count_fallback {
                    self.note_fallback();
                }
                return PoolOutcome::Fallback;
            }
            break;
        }
        self.wait_result(id, &rx, ctx, idle_timeout, count_fallback, overall_timeout)
    }

    fn wait_result(
        &self,
        id: u64,
        rx: &mpsc::Receiver<PoolEvent>,
        ctx: Option<&RunContext>,
        idle_timeout: Duration,
        count_fallback: bool,
        overall_timeout: Option<Duration>,
    ) -> PoolOutcome {
        let submitted = Instant::now();
        let mut stage_log: Vec<(String, Instant)> = Vec::new();
        let mut cancel_sent_at: Option<Instant> = None;
        loop {
            match rx.recv_timeout(POLL_INTERVAL) {
                Ok(PoolEvent::Progress(progress, stage)) => {
                    if let Some(stage) = stage {
                        stage_log.push((stage, Instant::now()));
                    }
                    if let Some(ctx) = ctx {
                        ctx.push_progress(progress);
                    }
                }
                Ok(PoolEvent::Result(value)) => {
                    self.remove_pending(id);
                    // 取消优先于结果（与一次一进程路径的语义一致：取消即终止）。
                    if cancel_sent_at.is_some()
                        || ctx.is_some_and(|c| c.registry.cancel_requested(&c.task_id))
                    {
                        return PoolOutcome::Cancelled;
                    }
                    // 业务失败（ok:false）同样证明常驻链路可用：计空闲起点、清回退计数。
                    self.note_request_end(idle_timeout);
                    return self.map_result(value, &stage_log);
                }
                Ok(PoolEvent::Died) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.remove_pending(id);
                    if cancel_sent_at.is_some() {
                        return PoolOutcome::Cancelled;
                    }
                    self.reap_dead_child();
                    if count_fallback {
                        self.note_fallback();
                    }
                    return PoolOutcome::Fallback;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(sent_at) = cancel_sent_at {
                        if sent_at.elapsed() >= CANCEL_GRACE {
                            // 2 秒宽限内未收到结果：kill 常驻进程并标记需重启。
                            self.remove_pending(id);
                            self.kill_child();
                            return PoolOutcome::Cancelled;
                        }
                        continue;
                    }
                    if let Some(limit) = overall_timeout {
                        if submitted.elapsed() >= limit {
                            self.remove_pending(id);
                            self.kill_child();
                            return PoolOutcome::Fallback;
                        }
                    }
                    if let Some(ctx) = ctx {
                        if ctx.registry.cancel_requested(&ctx.task_id) {
                            cancel_sent_at = Some(Instant::now());
                            self.send_cancel(id);
                        }
                    }
                }
            }
        }
    }

    /// 结果载荷 → 结局。startupMs：常驻命中（无模型加载阶段）为 0；本次请求触发
    /// 加载时为加载段耗时（预热耗时，规格 #74 §A3），不含排队等待。modelLoadMs 同源。
    fn map_result(&self, value: Value, stage_log: &[(String, Instant)]) -> PoolOutcome {
        if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            let startup_at = stage_log.iter().find(|(stage, _)| stage == "startup");
            let loaded_at = stage_log.iter().find(|(stage, _)| stage == "models_loaded");
            let load_ms = match (startup_at, loaded_at) {
                (Some((_, start)), Some((_, loaded))) => {
                    Some(loaded.duration_since(*start).as_millis() as u64)
                }
                _ => None,
            };
            return PoolOutcome::Completed {
                payload: value,
                startup_ms: Some(load_ms.unwrap_or(0)),
                model_load_ms: load_ms,
            };
        }
        let error = value.get("error").cloned().unwrap_or(Value::Null);
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("sidecar_result_invalid");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("常驻侧车失败结果缺少 error.message");
        let retryable = error
            .get("retryable")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut mapped = BridgeError::new(code, message.to_string(), retryable);
        let tail = self.stderr_tail();
        if !tail.trim().is_empty() {
            mapped = mapped.with_details(json!({ "stderrTail": tail }));
        }
        PoolOutcome::Failed(mapped)
    }

    fn ensure_child(
        &self,
        layout: &SidecarLayout,
        hf_endpoint: Option<&str>,
        table_mode: &str,
    ) -> Result<(), ()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = state.child.as_mut() {
            let alive = !child.shared.broken.load(Ordering::SeqCst)
                && matches!(child.child.try_wait(), Ok(None));
            if alive {
                return Ok(());
            }
            reap_child(state.child.take().expect("child 在位"));
        }
        // Warming 覆盖「拉起中 + 首个请求在飞」；首个请求结束（note_request_end）转 Ready。
        self.set_status(ResidentState::Warming);
        state.idle_deadline = None;
        match spawn_serve(layout, hf_endpoint, table_mode) {
            Ok(child) => {
                state.child = Some(child);
                // 注意：回退计数只在常驻请求成功服务时清零（note_request_end）；
                // 进程能拉起不代表协议可用，spawn 成功不清零（#84 评审）。
                Ok(())
            }
            Err(()) => {
                self.set_status(ResidentState::NotStarted);
                Err(())
            }
        }
    }

    fn send_line(&self, line: String) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = state.child.as_mut() {
            let _ = writeln!(child.stdin, "{line}");
            let _ = child.stdin.flush();
        }
    }

    /// cancel 请求即规格 #74 §A3 的 `cancel {id}`：id 即目标请求，无独立回执。
    fn send_cancel(&self, target: u64) {
        self.send_line(json!({ "id": target, "op": "cancel" }).to_string());
    }

    fn remove_pending(&self, id: u64) {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = state.child.as_ref() {
            child
                .shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
        }
    }

    fn note_request_end(&self, idle_timeout: Duration) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.consecutive_fallbacks = 0;
        // 只在进程仍在位时记空闲起点：结果分发与看门狗释放可能竞态，
        // 过期 deadline 会误杀之后重新拉起的进程。
        if state.child.is_some() {
            state.idle_deadline = Some(Instant::now() + idle_timeout);
            self.set_status(ResidentState::Ready);
        }
    }

    fn note_fallback(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.consecutive_fallbacks += 1;
        if state.consecutive_fallbacks >= MAX_CONSECUTIVE_FALLBACKS {
            // 连续回退：本会话停用常驻，顺收残留子进程释放内存。
            self.set_status(ResidentState::Disabled);
            if let Some(child) = state.child.take() {
                reap_child(child);
            }
        }
    }

    /// 进程已死（EOF/协议破裂）后的回收；下次请求由 ensure_child 重新拉起。
    fn reap_dead_child(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let dead = state.child.as_mut().is_some_and(|child| {
            child.shared.broken.load(Ordering::SeqCst)
                || !matches!(child.child.try_wait(), Ok(None))
        });
        if dead {
            reap_child(state.child.take().expect("child 在位"));
            self.set_status(ResidentState::NotStarted);
        }
    }

    /// 取消宽限耗尽或预热超时：kill 常驻进程并标记需重启（下次请求冷启）。
    fn kill_child(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = state.child.take() {
            reap_child(child);
        }
        self.set_status(ResidentState::NotStarted);
    }

    fn stderr_tail(&self) -> String {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .child
            .as_ref()
            .and_then(|child| child.stderr_tail.lock().ok().map(|tail| tail.clone()))
            .unwrap_or_default()
    }

    /// 空闲看门狗：最后一个请求结束起计时，超过空闲阈值且没有在途请求时发
    /// shutdown 并回收进程；下次请求由 ensure_child 重新拉起。
    fn idle_tick(&self) {
        if self.resident_state() != ResidentState::Ready {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(deadline) = state.idle_deadline else {
            return;
        };
        if Instant::now() < deadline {
            return;
        }
        let Some(child) = state.child.as_mut() else {
            return;
        };
        if !child
            .shared
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
        {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = writeln!(child.stdin, "{}", json!({ "id": id, "op": "shutdown" }));
        let _ = child.stdin.flush();
        let shutdown_deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            match child.child.try_wait() {
                Ok(Some(_)) => break,
                _ if Instant::now() >= shutdown_deadline => {
                    let _ = child.child.kill();
                    break;
                }
                _ => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        let mut child = state.child.take().expect("child 在位");
        let _ = child.child.wait();
        state.idle_deadline = None;
        drop(state);
        self.set_status(ResidentState::Released);
    }
}

impl Drop for SidecarPool {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(child) = state.child.take() {
                reap_child(child);
            }
        }
    }
}

/// 拉起常驻 serve 进程并完成 READY 握手（30s 超时）。失败即清理，由调用方回退。
fn spawn_serve(
    layout: &SidecarLayout,
    hf_endpoint: Option<&str>,
    table_mode: &str,
) -> Result<ResidentChild, ()> {
    let script = std::env::var(SERVE_ENTRY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| layout.app_script.clone());
    let mut command = crate::pdfparse::base_command_script(layout, &script, hf_endpoint);
    command
        .arg("--models-dir")
        .arg(&layout.models_dir)
        .arg("--table-mode")
        .arg(table_mode)
        .arg("serve")
        .stdin(Stdio::piped());
    let mut child = command.spawn().map_err(|err| {
        eprintln!("[pdfpool] 常驻侧车启动失败: {err}");
    })?;
    let shared = Arc::new(ReaderShared::new());
    let stdout = child.stdout.take().expect("已配置 piped stdout");
    {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || reader_loop(stdout, shared));
    }
    let stderr = child.stderr.take().expect("已配置 piped stderr");
    let stderr_tail = spawn_stderr_tail(stderr);
    let stdin = child.stdin.take().expect("已配置 piped stdin");

    let deadline = Instant::now() + READY_TIMEOUT;
    let ready_result = {
        let mut ready = shared.ready.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(result) = ready.clone() {
                break result;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                eprintln!("[pdfpool] 常驻侧车 READY 超时（30s）");
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
            let (guard, _) = shared
                .ready_cv
                .wait_timeout(ready, remaining)
                .unwrap_or_else(|e| e.into_inner());
            ready = guard;
        }
    };
    match ready_result {
        Ok(pid) => Ok(ResidentChild {
            child,
            stdin,
            shared,
            stderr_tail,
            pid,
        }),
        Err(reason) => {
            eprintln!("[pdfpool] 常驻侧车 READY 前退出: {reason}");
            let _ = child.kill();
            let _ = child.wait();
            Err(())
        }
    }
}
