use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::error::BridgeError;

pub const TASK_SCHEMA_VERSION: u32 = 1;

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
    pub at: String,
}

/// 任务最终状态查询（`getTask(taskId)`）返回的快照。
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
}

const DEFAULT_STREAM_TEXT: &str = "论文精读 Windows 正式客户端桥接演示任务：\
这段文本按块流式发送，验证 start / subscribe / getTask 事件闭环。";

fn plan_task(kind: &str, input: &serde_json::Value) -> Result<TaskPlan, BridgeError> {
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
        _ => Err(BridgeError::unknown_command(kind)),
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
    &["demo.stream-text@1", "demo.fail@1"]
}

struct TaskEntry {
    snapshot: TaskSnapshot,
    cancel: Arc<AtomicBool>,
    sink: Arc<dyn EventSink>,
}

pub struct TaskRegistry {
    entries: Mutex<HashMap<String, TaskEntry>>,
    next_id: AtomicU64,
}

impl TaskRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        })
    }

    pub fn start(
        self: &Arc<Self>,
        kind: &str,
        input: serde_json::Value,
        sink: Arc<dyn EventSink>,
    ) -> Result<String, BridgeError> {
        let plan = plan_task(kind, &input)?;
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
        std::thread::spawn(move || run_task(registry, runner_id, plan, sink));
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
        self.publish(task_id, sink, Some(status), None, None, error);
    }

    /// 流式块：只推进进度并发 chunk 事件；取消请求后的状态在检查点统一切换，不在此覆盖。
    fn push_chunk(&self, task_id: &str, sink: &Arc<dyn EventSink>, progress: Progress, chunk: String) {
        self.publish(task_id, sink, None, Some(progress), Some(chunk), None);
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
            at: snapshot.updated_at,
        });
    }
}

fn run_task(registry: Arc<TaskRegistry>, task_id: String, plan: TaskPlan, sink: Arc<dyn EventSink>) {
    registry.transition(&task_id, &sink, TaskStatus::Running, None);
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
            registry.transition(&task_id, &sink, TaskStatus::Succeeded, None);
        }
        TaskPlan::DemoFail { message } => {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let error = BridgeError::new("demo_failure", message, true);
            registry.transition(&task_id, &sink, TaskStatus::Failed, Some(error));
        }
    }
}
