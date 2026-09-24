//! 准入门契约（#93）：更新安装、任务注册与解析组件操作共用同一准入门，
//! 检查与占用不可交错——任何时刻只允许「更新安装」或「任务/组件操作」一方进入。

mod common;

use paper30min_lib::admission::AdmissionGate;
use paper30min_lib::component_runtime::ComponentRuntime;
use paper30min_lib::error::BridgeError;
use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::{wait_terminal, Collector};
use serde_json::json;
use std::sync::{Arc, Barrier};
use std::time::Duration;

/// 长时间占位的流式任务：块间延迟大，测试结束前要主动取消。
fn long_task_input() -> serde_json::Value {
    json!({ "text": "准入门占位", "chunks": 200, "chunkDelayMs": 1000 })
}

fn start_long_task(registry: &Arc<TaskRegistry>) -> Result<String, BridgeError> {
    registry.start("demo.stream-text@1", long_task_input(), Collector::new())
}

fn finish_task(registry: &Arc<TaskRegistry>, task_id: &str) {
    registry.request_cancel(task_id).expect("取消占位任务");
    let status = wait_terminal(registry, task_id, Duration::from_secs(10)).expect("占位任务应到达终态");
    assert_eq!(status, TaskStatus::Cancelled);
}

/// 顺序一：更新安装先占用准入，新任务与组件操作一律被拒，直到安装占用释放。
#[test]
fn update_claim_blocks_tasks_and_component_ops() {
    let (registry, _library, _dir) = common::env();
    let gate = AdmissionGate::new();
    let claim = gate
        .admit_update(&registry)
        .expect("无任务无组件操作时应允许安装更新");
    assert!(gate.installing());

    let task_err = gate.admit_task(|| Ok::<(), BridgeError>(())).unwrap_err();
    assert_eq!(task_err.code, "update_busy");
    let component_err = gate.admit_component(&registry).unwrap_err();
    assert_eq!(component_err.code, "update_busy");
    let second_install = gate.admit_update(&registry).unwrap_err();
    assert_eq!(second_install.code, "update_busy");

    drop(claim);
    assert!(!gate.installing());
    gate.admit_task(|| Ok::<(), BridgeError>(()))
        .expect("安装占用释放后任务可注册");
    gate.admit_component(&registry)
        .expect("安装占用释放后组件可操作");
}

/// 顺序二：任务先注册且仍在运行，更新安装与组件操作都必须被拒；任务终态后放行。
#[test]
fn active_task_blocks_update_and_component_until_finished() {
    let (registry, _library, _dir) = common::env();
    let gate = AdmissionGate::new();
    let task_id = gate
        .admit_task(|| start_long_task(&registry))
        .expect("空闲时应允许注册任务");

    let update_err = gate.admit_update(&registry).unwrap_err();
    assert_eq!(update_err.code, "tasks_active");
    let component_err = gate.admit_component(&registry).unwrap_err();
    assert_eq!(component_err.code, "tasks_active");

    finish_task(&registry, &task_id);
    gate.admit_update(&registry)
        .expect("任务终态后应允许安装更新");
    gate.admit_component(&registry)
        .expect("任务终态后应允许组件操作");
}

/// 顺序三：组件操作先占用，更新安装、新任务与第二个组件操作都被拒。
#[test]
fn component_claim_blocks_update_task_and_second_component() {
    let (registry, _library, _dir) = common::env();
    let gate = AdmissionGate::new();
    let claim = gate.admit_component(&registry).expect("空闲时应允许组件操作");
    assert!(gate.component_busy());

    assert_eq!(gate.admit_update(&registry).unwrap_err().code, "component_busy");
    assert_eq!(
        gate.admit_task(|| Ok::<(), BridgeError>(())).unwrap_err().code,
        "component_busy"
    );
    assert_eq!(
        gate.admit_component(&registry).unwrap_err().code,
        "component_busy"
    );

    drop(claim);
    assert!(!gate.component_busy());
    gate.admit_update(&registry)
        .expect("组件占用释放后应允许安装更新");
}

/// 可控屏障：任务注册与更新安装在同一刻放行，结果必须互斥——
/// 不得出现「任务注册成功且更新也通过活动检查」的交错。
#[test]
fn simultaneous_task_and_update_admission_are_mutually_exclusive() {
    for round in 0..20 {
        let (registry, _library, _dir) = common::env();
        let gate = AdmissionGate::new();
        let barrier = Arc::new(Barrier::new(2));
        let task_thread = {
            let gate = Arc::clone(&gate);
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                gate.admit_task(|| start_long_task(&registry))
            })
        };
        let update_thread = {
            let gate = Arc::clone(&gate);
            let registry = Arc::clone(&registry);
            std::thread::spawn(move || {
                barrier.wait();
                gate.admit_update(&registry)
            })
        };
        let task_result = task_thread.join().expect("任务线程应结束");
        let update_result = update_thread.join().expect("更新线程应结束");
        match (task_result, update_result) {
            (Ok(task_id), Err(update_err)) => {
                assert_eq!(update_err.code, "tasks_active", "第 {round} 轮：任务先入场");
                finish_task(&registry, &task_id);
            }
            (Err(task_err), Ok(_claim)) => {
                assert_eq!(task_err.code, "update_busy", "第 {round} 轮：更新先入场");
            }
            (Ok(_), Ok(_)) => panic!("第 {round} 轮：任务与更新同时通过，准入互斥失效"),
            (Err(_), Err(_)) => panic!("第 {round} 轮：无冲突场景下双方都被拒绝"),
        }
    }
}

/// ComponentRuntime 的任务入口同样走准入门：更新安装或组件操作占用时拒绝新任务。
#[test]
fn component_runtime_task_entry_respects_gate() {
    let (registry, _library, dir) = common::env();
    let gate = AdmissionGate::new();
    let component = ComponentRuntime::new(dir.path().join("component"), Arc::clone(&gate));

    let update_claim = gate.admit_update(&registry).unwrap();
    let err = component
        .start_task(|| start_long_task(&registry))
        .unwrap_err();
    assert_eq!(err.code, "update_busy");
    drop(update_claim);

    let component_claim = gate.admit_component(&registry).unwrap();
    let err = component
        .start_task(|| start_long_task(&registry))
        .unwrap_err();
    assert_eq!(err.code, "component_busy");
    drop(component_claim);

    let task_id = component
        .start_task(|| start_long_task(&registry))
        .expect("准入空闲后任务可注册");
    finish_task(&registry, &task_id);
}
