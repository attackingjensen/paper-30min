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

// 任务收尾公共流程：subscribe 任务事件流，订阅后立即用 tasks.get@1 快照复核
//（事件不重放，订阅前已到达的终态只能从快照补齐）。注意 tasks.get@1 返回
// { schemaVersion, task }，终态字段在 task 上——与事件形状不同，勿混用（修过的坑）。
// 只在终态 resolve { status, error?, result? }；终态语义（resolve 全文 / reject Error /
// reject AbortError）由调用方在 promise 结果上实现。signal abort 时调 tasks.cancel@1
//（幂等，重复调用安全）。
export function trackTask(bridge, taskId, { signal, onChunk, onStatus } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten = null;

    const onAbort = () => {
      bridge.invoke('tasks.cancel@1', { taskId }).catch(err => console.warn('取消任务失败：', err));
    };

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (typeof unlisten === 'function') {
        try { unlisten(); } catch { /* 忽略退订失败 */ }
      }
    };
    const settle = payload => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };
    const handleStatus = (status, error, result) => {
      onStatus?.(status, error, result);
      if (isTerminalStatus(status)) settle({ status, error, result });
    };

    // start 返回前 signal 可能已 aborted：补发取消而不是等事件。
    if (signal?.aborted) onAbort();
    else if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const subscribed = bridge.subscribe(taskId, event => {
      if (settled || !event) return;
      if (event.event === 'chunk' && typeof event.chunk === 'string') onChunk?.(event.chunk);
      if (event.event === 'status') handleStatus(event.status, event.error, event.result);
    });
    // subscribe 返回退订函数（可能是 promise）；已终态时立即补退订。
    Promise.resolve(subscribed)
      .then(fn => {
        unlisten = typeof fn === 'function' ? fn : null;
        if (settled && unlisten) { try { unlisten(); } catch { /* 忽略退订失败 */ } }
      })
      .catch(() => {});
    // 快照复核：subscribe 前已到达终态时事件不会重放，从快照收尾。
    bridge.invoke('tasks.get@1', { taskId })
      .then(snapshot => {
        if (!snapshot?.task || settled) return;
        handleStatus(snapshot.task.status, snapshot.task.error, snapshot.task.result);
      })
      .catch(err => {
        if (!settled) { settled = true; cleanup(); reject(err); }
      });
  });
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
