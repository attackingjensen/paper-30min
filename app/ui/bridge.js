// Rust/JavaScript 桥接客户端。纯 ESM、无构建步骤：
// 生产环境传入 window.__TAURI__，测试传入捕获调用的替身。
export function createBridge(tauri) {
  const { invoke } = tauri.core;
  const { listen } = tauri.event;

  return {
    // invoke(command, input)：短时、幂等或事务性操作。
    invoke: (command, input = {}) => invoke('bridge_invoke', { command, input }),

    // start(taskKind, input)：长任务，返回 { schemaVersion, taskId }。
    start: (kind, input = {}) => invoke('bridge_start', { kind, input }),

    // subscribe(taskId)：任务事件流（chunk / progress / status）。
    subscribe: (taskId, handler) =>
      listen(`task:${taskId}`, (event) => handler(event.payload)),

    // 窗口关闭被拦截且仍有运行中任务时触发，payload 为 { schemaVersion, tasks }。
    onCloseRequested: (handler) =>
      listen('app:close-requested', (event) => handler(event.payload)),

    // 用户在关闭提示中选择后调用：cancelTasks=true 停止任务并退出，false 任务已结束直接退出。
    closeWindow: (cancelTasks) =>
      invoke('bridge_invoke', { command: 'app.close-window@1', input: { cancelTasks } }),
  };
}

// 任务状态 -> 界面文案（规格：等待、进行中、成功、失败、已取消、待重试）。
export const TASK_STATUS_LABELS = {
  queued: '等待',
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
  cancel_requested: '取消中',
  cancelled: '已取消',
  retry_waiting: '待重试',
};

export function taskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] ?? status;
}

export function isTerminalStatus(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

// 关闭提示使用：从任务快照中筛出仍在运行（非终态）的任务。
export function activeTasks(tasks) {
  return tasks.filter((task) => !isTerminalStatus(task.status));
}
