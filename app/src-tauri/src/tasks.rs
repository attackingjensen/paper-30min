use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::error::BridgeError;
use crate::files;
use crate::library::Library;

pub const TASK_SCHEMA_VERSION: u32 = 1;

/// 网络任务统一重试：总尝试次数（含首次）。
pub(crate) const MAX_ATTEMPTS: u32 = 3;
/// 取消哨兵：运行器在取消检查点返回该 code 的错误，run_with_retry 识别后统一切换
/// cancelled 终态；它不会作为任务错误暴露给前端。
pub(crate) const CANCEL_SENTINEL: &str = "__cancelled__";

/// net.fetch-text@1 的默认响应上限。
const DEFAULT_FETCH_TEXT_MAX_BYTES: u64 = 30 * 1024 * 1024;
/// files.download@1 的默认下载上限。
const DEFAULT_DOWNLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;

/// 任务状态（规格：queued、running、succeeded、failed、cancel_requested、cancelled、retry_waiting）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    CancelRequested,
    Cancelled,
    RetryWaiting,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

/// 任务事件流中的单条事件，经 `subscribe(taskId)` 通道发给 JavaScript。
/// `result` 只在 succeeded 终态携带结果载荷，缺省不序列化（向后兼容）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub schema_version: u32,
    pub task_id: String,
    pub kind: String,
    pub event: &'static str,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub at: String,
}

/// 任务最终状态查询（`getTask(taskId)`）返回的快照。
/// `result` 与 TaskEvent 同义：succeeded 终态的结果载荷，缺省不序列化。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub schema_version: u32,
    pub task_id: String,
    pub kind: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// 任务事件出口。生产环境由 Tauri 事件通道实现，测试用收集器实现，
/// 使任务引擎不依赖 AppHandle 即可完整测试。
pub trait EventSink: Send + Sync {
    fn emit(&self, event: TaskEvent);
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// 已校验、可执行的任务计划。Rust 只承载演示与基础设施任务，
/// 不复制论文领域规则；领域任务类型在后续实施票接入。
#[derive(Debug)]
enum TaskPlan {
    DemoStreamText {
        chunks: Vec<String>,
        chunk_delay_ms: u64,
    },
    DemoFail {
        message: String,
    },
    ModelChat {
        messages: Vec<Value>,
        temperature: f64,
        max_tokens: u64,
        stream: bool,
    },
    ModelTest,
    NetFetchText {
        url: String,
        max_bytes: u64,
    },
    FilesDownload {
        paper_id: String,
        attachment_id: String,
        name: String,
        content_type: String,
        url: String,
        max_bytes: u64,
    },
}

const DEFAULT_STREAM_TEXT: &str = "论文精读 Windows 正式客户端桥接演示任务：\
这段文本按块流式发送，验证 start / subscribe / getTask 事件闭环。";

fn plan_task(kind: &str, input: &Value, library: &Library) -> Result<TaskPlan, BridgeError> {
    match kind {
        "demo.stream-text@1" => {
            let text = input
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or(DEFAULT_STREAM_TEXT);
            let chunk_count = input
                .get("chunks")
                .and_then(|v| v.as_u64())
                .unwrap_or(12)
                .clamp(1, 200) as usize;
            let chunk_delay_ms = input
                .get("chunkDelayMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(40)
                .clamp(0, 2_000);
            Ok(TaskPlan::DemoStreamText {
                chunks: split_chunks(text, chunk_count),
                chunk_delay_ms,
            })
        }
        "demo.fail@1" => Ok(TaskPlan::DemoFail {
            message: input
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("演示任务按请求失败")
                .to_string(),
        }),
        "model.chat@1" => plan_model_chat(input, library),
        "model.test@1" => Ok(TaskPlan::ModelTest),
        "net.fetch-text@1" => {
            let url = required_string("net.fetch-text@1", input, "url")?;
            let max_bytes = optional_u64("net.fetch-text@1", input, "maxBytes")?
                .unwrap_or(DEFAULT_FETCH_TEXT_MAX_BYTES);
            Ok(TaskPlan::NetFetchText {
                url: url.to_string(),
                max_bytes,
            })
        }
        "files.download@1" => {
            let paper_id = required_string("files.download@1", input, "paperId")?;
            let attachment_id = required_string("files.download@1", input, "attachmentId")?;
            let name = required_string("files.download@1", input, "name")?;
            let url = required_string("files.download@1", input, "url")?;
            // paperId/attachmentId/name 都会拼进附件路径或元数据，沿用 files 命令的段校验。
            files::require_safe_segment(paper_id, "paperId")?;
            files::require_safe_segment(attachment_id, "attachmentId")?;
            files::require_safe_segment(name, "name")?;
            let content_type = input
                .get("contentType")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("application/octet-stream")
                .to_string();
            let max_bytes = optional_u64("files.download@1", input, "maxBytes")?
                .unwrap_or(DEFAULT_DOWNLOAD_MAX_BYTES);
            Ok(TaskPlan::FilesDownload {
                paper_id: paper_id.to_string(),
                attachment_id: attachment_id.to_string(),
                name: name.to_string(),
                content_type,
                url: url.to_string(),
                max_bytes,
            })
        }
        _ => Err(BridgeError::unknown_command(kind)),
    }
}

/// model.chat@1 计划校验：messages 非空且 role/content 都是字符串；
/// temperature/maxTokens/stream 缺省取 settings 值，输入显式给出时覆盖。
fn plan_model_chat(input: &Value, library: &Library) -> Result<TaskPlan, BridgeError> {
    let messages = input
        .get("messages")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| BridgeError::invalid_input("model.chat@1 需要非空数组参数 messages"))?;
    let mut checked = Vec::with_capacity(messages.len());
    for (index, message) in messages.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid_input(format!("messages[{index}].role 必须是字符串")))?;
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid_input(format!("messages[{index}].content 必须是字符串")))?;
        checked.push(json!({ "role": role, "content": content }));
    }
    // 设置内容损坏时按内建缺省处理，与 settings.get@1 的合并语义一致。
    let stored = library
        .get_setting("model")?
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let stored_temperature = stored
        .as_ref()
        .and_then(|value| value.get("temperature"))
        .and_then(Value::as_f64);
    let stored_max_tokens = stored
        .as_ref()
        .and_then(|value| value.get("maxTokens"))
        .and_then(Value::as_u64);
    let temperature = match input.get("temperature") {
        None | Some(Value::Null) => stored_temperature.unwrap_or(0.3),
        Some(value) => value
            .as_f64()
            .ok_or_else(|| BridgeError::invalid_input("temperature 必须是数值"))?,
    };
    let max_tokens = match input.get("maxTokens") {
        None | Some(Value::Null) => stored_max_tokens.unwrap_or(4096),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| BridgeError::invalid_input("maxTokens 必须是正整数"))?,
    };
    let stream = match input.get("stream") {
        None | Some(Value::Null) => true,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| BridgeError::invalid_input("stream 必须是布尔值"))?,
    };
    Ok(TaskPlan::ModelChat {
        messages: checked,
        temperature,
        max_tokens,
        stream,
    })
}

fn required_string<'a>(kind: &str, input: &'a Value, field: &str) -> Result<&'a str, BridgeError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| BridgeError::invalid_input(format!("{kind} 需要字符串参数 {field}")))
}

fn optional_u64(kind: &str, input: &Value, field: &str) -> Result<Option<u64>, BridgeError> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let number = value
                .as_u64()
                .filter(|number| *number > 0)
                .ok_or_else(|| BridgeError::invalid_input(format!("{kind} 的 {field} 必须是正整数")))?;
            Ok(Some(number))
        }
    }
}

/// 按字符边界把文本切成 `target` 份，保持块顺序连接后等于原文。
fn split_chunks(text: &str, target: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    let target = target.min(chars.len());
    let mut chunks = Vec::with_capacity(target);
    let mut start = 0;
    for i in 0..target {
        let remaining_chars = chars.len() - start;
        let remaining_slots = target - i;
        let len = remaining_chars.div_ceil(remaining_slots);
        let end = start + len;
        chunks.push(chars[start..end].iter().collect());
        start = end;
    }
    chunks
}

pub fn available_task_kinds() -> &'static [&'static str] {
    &[
        "demo.stream-text@1",
        "demo.fail@1",
        "model.chat@1",
        "model.test@1",
        "net.fetch-text@1",
        "files.download@1",
    ]
}

struct TaskEntry {
    snapshot: TaskSnapshot,
    cancel: Arc<AtomicBool>,
    sink: Arc<dyn EventSink>,
}

pub struct TaskRegistry {
    entries: Mutex<HashMap<String, TaskEntry>>,
    next_id: AtomicU64,
    /// 书库句柄：网络类任务运行器读设置、写附件元数据时使用。
    library: Arc<Library>,
}

impl TaskRegistry {
    pub fn new(library: Arc<Library>) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            library,
        })
    }

    pub fn start(
        self: &Arc<Self>,
        kind: &str,
        input: serde_json::Value,
        sink: Arc<dyn EventSink>,
    ) -> Result<String, BridgeError> {
        let plan = plan_task(kind, &input, &self.library)?;
        let task_id = format!("task-{:06}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        let now = now_iso();
        let entry = TaskEntry {
            snapshot: TaskSnapshot {
                schema_version: TASK_SCHEMA_VERSION,
                task_id: task_id.clone(),
                kind: kind.to_string(),
                status: TaskStatus::Queued,
                progress: None,
                error: None,
                result: None,
                created_at: now.clone(),
                updated_at: now,
            },
            cancel: Arc::new(AtomicBool::new(false)),
            sink: Arc::clone(&sink),
        };
        self.entries
            .lock()
            .map_err(|_| BridgeError::internal("任务注册表锁定失败"))?
            .insert(task_id.clone(), entry);
        let registry = Arc::clone(self);
        let runner_id = task_id.clone();
        let library = Arc::clone(&self.library);
        std::thread::spawn(move || run_task(registry, runner_id, plan, sink, library));
        Ok(task_id)
    }

    pub fn get(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.entries
            .lock()
            .ok()?
            .get(task_id)
            .map(|entry| entry.snapshot.clone())
    }

    /// 关闭前运行中任务查询：`active_only` 只返回非终态任务。
    pub fn list(&self, active_only: bool) -> Vec<TaskSnapshot> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };
        let mut snapshots: Vec<TaskSnapshot> = entries
            .values()
            .filter(|entry| !active_only || !entry.snapshot.status.is_terminal())
            .map(|entry| entry.snapshot.clone())
            .collect();
        snapshots.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        snapshots
    }

    pub fn has_active(&self) -> bool {
        self.entries.lock().map_or(false, |entries| {
            entries
                .values()
                .any(|entry| !entry.snapshot.status.is_terminal())
        })
    }

    /// 取消请求幂等：终态任务原样返回，进行中任务置 cancel_requested，
    /// 由运行器在安全检查点真正停下后置 cancelled。
    pub fn request_cancel(&self, task_id: &str) -> Result<TaskSnapshot, BridgeError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| BridgeError::internal("任务注册表锁定失败"))?;
        let entry = entries
            .get_mut(task_id)
            .ok_or_else(|| BridgeError::task_not_found(task_id))?;
        if entry.snapshot.status.is_terminal() {
            return Ok(entry.snapshot.clone());
        }
        entry.cancel.store(true, Ordering::SeqCst);
        if entry.snapshot.status == TaskStatus::CancelRequested {
            return Ok(entry.snapshot.clone());
        }
        entry.snapshot.status = TaskStatus::CancelRequested;
        entry.snapshot.updated_at = now_iso();
        let snapshot = entry.snapshot.clone();
        let sink = Arc::clone(&entry.sink);
        drop(entries);
        sink.emit(TaskEvent {
            schema_version: TASK_SCHEMA_VERSION,
            task_id: snapshot.task_id.clone(),
            kind: snapshot.kind.clone(),
            event: "status",
            status: snapshot.status,
            progress: snapshot.progress.clone(),
            chunk: None,
            error: None,
            result: None,
            at: snapshot.updated_at.clone(),
        });
        Ok(snapshot)
    }

    pub fn cancel_all_active(&self) -> usize {
        let Ok(entries) = self.entries.lock() else {
            return 0;
        };
        let ids: Vec<String> = entries
            .values()
            .filter(|entry| !entry.snapshot.status.is_terminal())
            .map(|entry| entry.snapshot.task_id.clone())
            .collect();
        let count = ids.len();
        drop(entries);
        for id in ids {
            let _ = self.request_cancel(&id);
        }
        count
    }

    fn cancel_requested(&self, task_id: &str) -> bool {
        self.entries.lock().map_or(false, |entries| {
            entries
                .get(task_id)
                .map_or(false, |entry| entry.cancel.load(Ordering::SeqCst))
        })
    }

    /// 状态变化：更新快照并发 status 事件。
    fn transition(&self, task_id: &str, sink: &Arc<dyn EventSink>, status: TaskStatus, error: Option<BridgeError>) {
        self.publish(task_id, sink, Some(status), None, None, error, None);
    }

    /// 成功终态：可携带结果载荷（result 只在 succeeded 终态使用）。
    fn succeed(&self, task_id: &str, sink: &Arc<dyn EventSink>, result: Option<Value>) {
        self.publish(task_id, sink, Some(TaskStatus::Succeeded), None, None, None, result);
    }

    /// 流式块：只推进进度并发 chunk 事件；取消请求后的状态在检查点统一切换，不在此覆盖。
    fn push_chunk(&self, task_id: &str, sink: &Arc<dyn EventSink>, progress: Progress, chunk: String) {
        self.publish(task_id, sink, None, Some(progress), Some(chunk), None, None);
    }

    /// 字节进度：只推进进度并发 status 事件（不改变状态），供下载/抓取的进度通道。
    fn push_progress(&self, task_id: &str, sink: &Arc<dyn EventSink>, progress: Progress) {
        self.publish(task_id, sink, None, Some(progress), None, None, None);
    }

    /// 更新快照并向订阅者发一条事件。有 chunk 为 chunk 事件，否则为 status 事件。
    fn publish(
        &self,
        task_id: &str,
        sink: &Arc<dyn EventSink>,
        status: Option<TaskStatus>,
        progress: Option<Progress>,
        chunk: Option<String>,
        error: Option<BridgeError>,
        result: Option<Value>,
    ) {
        let snapshot = {
            let Ok(mut entries) = self.entries.lock() else {
                return;
            };
            let Some(entry) = entries.get_mut(task_id) else {
                return;
            };
            if let Some(status) = status {
                entry.snapshot.status = status;
            }
            if let Some(progress) = &progress {
                entry.snapshot.progress = Some(progress.clone());
            }
            if let Some(error) = &error {
                entry.snapshot.error = Some(error.clone());
            }
            if let Some(result) = &result {
                entry.snapshot.result = Some(result.clone());
            }
            entry.snapshot.updated_at = now_iso();
            entry.snapshot.clone()
        };
        sink.emit(TaskEvent {
            schema_version: TASK_SCHEMA_VERSION,
            task_id: snapshot.task_id,
            kind: snapshot.kind,
            event: if chunk.is_some() { "chunk" } else { "status" },
            status: snapshot.status,
            progress,
            chunk,
            error,
            result,
            at: snapshot.updated_at,
        });
    }
}

/// 任务运行器上下文：注册表、事件出口与书库句柄，
/// 网络类任务经它发事件、查取消、访问书库。
pub(crate) struct RunContext {
    pub registry: Arc<TaskRegistry>,
    pub task_id: String,
    pub sink: Arc<dyn EventSink>,
    pub library: Arc<Library>,
}

impl RunContext {
    fn new(
        registry: Arc<TaskRegistry>,
        task_id: String,
        sink: Arc<dyn EventSink>,
        library: Arc<Library>,
    ) -> Self {
        Self {
            registry,
            task_id,
            sink,
            library,
        }
    }

    /// 取消检查点：收到取消请求时返回哨兵错误，由 run_with_retry 或运行器统一切换
    /// cancelled 终态。
    pub(crate) fn cancel_checkpoint(&self) -> Result<(), BridgeError> {
        if self.registry.cancel_requested(&self.task_id) {
            Err(BridgeError::new(CANCEL_SENTINEL, "任务已取消", false))
        } else {
            Ok(())
        }
    }

    /// 非重试任务在检查点发现取消后直接转 cancelled 终态。
    pub(crate) fn cancel_now(&self) {
        self.registry
            .transition(&self.task_id, &self.sink, TaskStatus::Cancelled, None);
    }

    pub(crate) fn push_chunk(&self, progress: Progress, chunk: String) {
        self.registry
            .push_chunk(&self.task_id, &self.sink, progress, chunk);
    }

    pub(crate) fn push_progress(&self, progress: Progress) {
        self.registry
            .push_progress(&self.task_id, &self.sink, progress);
    }

    /// 直接置 failed 终态（不可重试的错误或未配置等情况）。
    pub(crate) fn fail(&self, error: BridgeError) {
        self.registry
            .transition(&self.task_id, &self.sink, TaskStatus::Failed, Some(error));
    }

    /// 置 succeeded 终态，可携带 result 载荷。
    pub(crate) fn succeed(&self, result: Option<Value>) {
        self.registry.succeed(&self.task_id, &self.sink, result);
    }
}

/// 网络任务统一重试策略：retryable 失败 → 状态转 retry_waiting（发 status 事件）→
/// 取消感知睡眠（第 1 次 1s、第 2 次 3s，50ms 切片检查取消）→ 重试；共 3 次尝试。
/// 重试期间收到取消 → cancelled；3 次尝试后仍失败 → failed，保留最后一次错误与其 retryable。
/// 返回值 Err(()) 表示终态已处理（cancelled 或 failed），运行器不再发事件。
pub(crate) fn run_with_retry<T>(
    ctx: &RunContext,
    attempt: impl FnMut(&RunContext) -> Result<T, BridgeError>,
) -> Result<T, ()> {
    run_with_retry_while(ctx, attempt, || true)
}

/// 带重试门槛的统一重试：`may_retry` 返回 false 时，即使错误 retryable 也不再发起
/// 新尝试（直接 failed，错误的 retryable 保留，供 UI 手动重试）。流式任务用它禁止
/// 「已产出内容后重发请求」——重发会把已发出的增量再推一遍。
pub(crate) fn run_with_retry_while<T>(
    ctx: &RunContext,
    mut attempt: impl FnMut(&RunContext) -> Result<T, BridgeError>,
    may_retry: impl Fn() -> bool,
) -> Result<T, ()> {
    let mut last_error: Option<BridgeError> = None;
    for try_index in 0..MAX_ATTEMPTS {
        match attempt(ctx) {
            Ok(value) => return Ok(value),
            Err(error) if error.code == CANCEL_SENTINEL => {
                ctx.cancel_now();
                return Err(());
            }
            Err(error) if error.retryable && may_retry() && try_index + 1 < MAX_ATTEMPTS => {
                ctx.registry.transition(
                    &ctx.task_id,
                    &ctx.sink,
                    TaskStatus::RetryWaiting,
                    Some(error),
                );
                let delay_ms: u64 = if try_index == 0 { 1_000 } else { 3_000 };
                // 50ms 切片睡眠，切片间检查取消。
                let mut slept = 0_u64;
                while slept < delay_ms {
                    std::thread::sleep(Duration::from_millis(50));
                    slept += 50;
                    if ctx.registry.cancel_requested(&ctx.task_id) {
                        ctx.cancel_now();
                        return Err(());
                    }
                }
                ctx.registry
                    .transition(&ctx.task_id, &ctx.sink, TaskStatus::Running, None);
            }
            Err(error) => {
                last_error = Some(error);
                break;
            }
        }
    }
    let error = last_error.expect("重试循环至少执行一次尝试");
    ctx.fail(error);
    Err(())
}

fn run_task(
    registry: Arc<TaskRegistry>,
    task_id: String,
    plan: TaskPlan,
    sink: Arc<dyn EventSink>,
    library: Arc<Library>,
) {
    registry.transition(&task_id, &sink, TaskStatus::Running, None);
    let ctx = RunContext::new(
        Arc::clone(&registry),
        task_id.clone(),
        Arc::clone(&sink),
        library,
    );
    match plan {
        TaskPlan::DemoStreamText {
            chunks,
            chunk_delay_ms,
        } => {
            let total = chunks.len() as u64;
            for (index, chunk) in chunks.into_iter().enumerate() {
                // 安全检查点：只在块之间响应取消。
                if registry.cancel_requested(&task_id) {
                    registry.transition(&task_id, &sink, TaskStatus::Cancelled, None);
                    return;
                }
                let progress = Progress {
                    done: index as u64 + 1,
                    total,
                };
                registry.push_chunk(&task_id, &sink, progress, chunk);
                std::thread::sleep(std::time::Duration::from_millis(chunk_delay_ms));
            }
            registry.succeed(&task_id, &sink, None);
        }
        TaskPlan::DemoFail { message } => {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let error = BridgeError::new("demo_failure", message, true);
            registry.transition(&task_id, &sink, TaskStatus::Failed, Some(error));
        }
        TaskPlan::ModelChat {
            messages,
            temperature,
            max_tokens,
            stream,
        } => crate::model::run_chat(&ctx, &messages, temperature, max_tokens, stream),
        TaskPlan::ModelTest => crate::model::run_test(&ctx),
        TaskPlan::NetFetchText { url, max_bytes } => crate::net::run_fetch_text(&ctx, &url, max_bytes),
        TaskPlan::FilesDownload {
            paper_id,
            attachment_id,
            name,
            content_type,
            url,
            max_bytes,
        } => crate::net::run_download(
            &ctx,
            &paper_id,
            &attachment_id,
            &name,
            &content_type,
            &url,
            max_bytes,
        ),
    }
}
