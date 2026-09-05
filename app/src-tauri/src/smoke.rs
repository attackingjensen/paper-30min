//! 可重复冒烟命令：`paper30min --bridge-smoke`（debug 构建，保留控制台输出）。
//! 不开窗口，直接验证桥接外部行为：版本化命令、统一错误、任务事件流、取消与任务查询。
//! 全部通过时进程退出码为 0，否则为 1。

use serde_json::{json, Value};
use std::time::Duration;

use crate::bridge;
use crate::tasks::{TaskRegistry, TaskStatus};
use crate::testkit::{wait_terminal, Collector};

fn check(name: &str, f: impl FnOnce() -> Result<String, String>, report: &mut Vec<Value>) {
    let (pass, detail) = match f() {
        Ok(detail) => (true, detail),
        Err(detail) => (false, detail),
    };
    report.push(json!({ "check": name, "pass": pass, "detail": detail }));
}

pub fn run() -> i32 {
    let mut report: Vec<Value> = Vec::new();
    let registry = TaskRegistry::new();

    check(
        "app.info@1 返回 schemaVersion",
        || match bridge::invoke(&registry, "app.info@1", &json!({})) {
            Ok(value) if value["schemaVersion"] == json!(1) => Ok("schemaVersion=1".to_string()),
            Ok(value) => Err(format!("schemaVersion 不符: {value}")),
            Err(error) => Err(format!("调用失败: {error}")),
        },
        &mut report,
    );

    check(
        "bridge.echo@1 原样回显",
        || {
            let input = json!({ "message": "桥接自检", "n": 1 });
            match bridge::invoke(&registry, "bridge.echo@1", &input) {
                Ok(value) if value["echo"] == input => Ok("回显一致".to_string()),
                Ok(value) => Err(format!("回显不符: {value}")),
                Err(error) => Err(format!("调用失败: {error}")),
            }
        },
        &mut report,
    );

    check(
        "未知命令返回统一错误结构",
        || match bridge::invoke(&registry, "no.such-command@1", &json!({})) {
            Err(error) if error.code == "unknown_command" && !error.retryable => {
                Ok("code=unknown_command retryable=false".to_string())
            }
            Err(error) => Err(format!("错误结构不符: {error:?}")),
            Ok(value) => Err(format!("未知命令不应成功: {value}")),
        },
        &mut report,
    );

    check(
        "demo.stream-text@1 任务事件流完整",
        || {
            let sink = Collector::new();
            let text = "桥接冒烟测试文本";
            let task_id = registry
                .start(
                    "demo.stream-text@1",
                    json!({ "text": text, "chunks": 4, "chunkDelayMs": 5 }),
                    sink.clone(),
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            match wait_terminal(&registry, &task_id, Duration::from_secs(5)) {
                Some(TaskStatus::Succeeded) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let events = sink.events();
            let reassembled: String = events
                .iter()
                .filter(|event| event.event == "chunk")
                .filter_map(|event| event.chunk.clone())
                .collect();
            if reassembled != text {
                return Err(format!("流式内容拼接不符: {reassembled:?}"));
            }
            let final_event = events.last().ok_or("没有事件")?;
            if final_event.event != "status" || final_event.status != TaskStatus::Succeeded {
                return Err("末尾不是成功状态事件".to_string());
            }
            Ok(format!("{} 个事件，内容一致", events.len()))
        },
        &mut report,
    );

    check(
        "取消请求幂等且任务在安全检查点停止",
        || {
            let sink = Collector::new();
            let task_id = registry
                .start(
                    "demo.stream-text@1",
                    json!({ "chunks": 100, "chunkDelayMs": 20 }),
                    sink,
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            let first = registry
                .request_cancel(&task_id)
                .map_err(|error| format!("取消失败: {error}"))?;
            if first.status != TaskStatus::CancelRequested {
                return Err(format!("取消后状态不符: {:?}", first.status));
            }
            match wait_terminal(&registry, &task_id, Duration::from_secs(5)) {
                Some(TaskStatus::Cancelled) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            let again = registry
                .request_cancel(&task_id)
                .map_err(|error| format!("重复取消失败: {error}"))?;
            if again.status != TaskStatus::Cancelled {
                return Err(format!("重复取消不应改变终态: {:?}", again.status));
            }
            Ok("cancel_requested -> cancelled，重复取消幂等".to_string())
        },
        &mut report,
    );

    check(
        "关闭前运行中任务查询只返回非终态任务",
        || {
            let sink = Collector::new();
            let running_id = registry
                .start(
                    "demo.stream-text@1",
                    json!({ "chunks": 100, "chunkDelayMs": 20 }),
                    sink,
                )
                .map_err(|error| format!("启动失败: {error}"))?;
            let active = registry.list(true);
            if !active.iter().any(|task| task.task_id == running_id) {
                return Err("运行中任务未出现在活动查询里".to_string());
            }
            registry.cancel_all_active();
            match wait_terminal(&registry, &running_id, Duration::from_secs(5)) {
                Some(TaskStatus::Cancelled) => {}
                other => return Err(format!("终态不符: {other:?}")),
            }
            if registry.list(true).iter().any(|task| task.task_id == running_id) {
                return Err("已取消任务仍出现在活动查询里".to_string());
            }
            Ok("活动查询与取消批量操作正常".to_string())
        },
        &mut report,
    );

    let passed = report.iter().filter(|item| item["pass"] == json!(true)).count();
    let failures = report.len() - passed;
    let output = json!({
        "smoke": "bridge",
        "total": report.len(),
        "passed": passed,
        "failed": failures,
        "checks": report,
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
    if failures == 0 {
        0
    } else {
        1
    }
}
