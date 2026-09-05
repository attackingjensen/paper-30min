//! 测试与冒烟共用的支撑代码：事件收集器与终态等待。
//! 生产路径不使用；放在库内以便集成测试与 `--bridge-smoke` 共享同一份实现。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::tasks::{EventSink, TaskEvent, TaskRegistry, TaskStatus};

/// 把任务事件收集到内存里，供断言事件序列。
pub struct Collector {
    events: Mutex<Vec<TaskEvent>>,
}

impl Collector {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
        })
    }

    pub fn events(&self) -> Vec<TaskEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl EventSink for Collector {
    fn emit(&self, event: TaskEvent) {
        self.events.lock().unwrap().push(event);
    }
}

/// 轮询直到任务到达终态或超时；超时返回 None。
pub fn wait_terminal(registry: &Arc<TaskRegistry>, task_id: &str, timeout: Duration) -> Option<TaskStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(snapshot) = registry.get(task_id) {
            if snapshot.status.is_terminal() {
                return Some(snapshot.status);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}
