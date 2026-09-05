import { createBridge, taskStatusLabel, isTerminalStatus, activeTasks } from './bridge.js';

const bridge = createBridge(window.__TAURI__);

const logEl = document.getElementById('log');
const tasksEl = document.getElementById('tasks');
const closeDialog = document.getElementById('close-dialog');
const closeTaskList = document.getElementById('close-task-list');

function log(message, data) {
  const line = data === undefined ? message : `${message}\n${JSON.stringify(data, null, 2)}`;
  logEl.textContent = `${line}\n\n${logEl.textContent}`;
}

function showError(prefix, error) {
  const detail = error && typeof error === 'object' && 'code' in error
    ? `${error.code}: ${error.message}${error.retryable ? '（可重试）' : ''}`
    : String(error);
  log(`${prefix}：${detail}`);
}

// 统一包裹按钮动作：失败时按统一错误结构展示，不扩散 try/catch 样板。
function guard(prefix, action) {
  return async () => {
    try {
      await action();
    } catch (error) {
      showError(prefix, error);
    }
  };
}

// 任务卡片：taskId -> { el, statusEl, progressEl, streamEl, cancelBtn, streamed }
const cards = new Map();

function ensureCard(taskId, kind) {
  if (cards.has(taskId)) {
    return cards.get(taskId);
  }
  const el = document.createElement('div');
  el.className = 'task-card';
  el.innerHTML = `
    <div class="task-head">
      <code>${taskId}</code>
      <span class="muted">${kind}</span>
      <span class="task-status"></span>
      <button class="task-cancel">取消</button>
    </div>
    <progress max="1" value="0"></progress>
    <pre class="task-stream"></pre>
  `;
  tasksEl.prepend(el);
  const card = {
    el,
    statusEl: el.querySelector('.task-status'),
    progressEl: el.querySelector('progress'),
    streamEl: el.querySelector('.task-stream'),
    cancelBtn: el.querySelector('.task-cancel'),
    streamed: '',
  };
  card.cancelBtn.addEventListener('click', guard('取消失败', async () => {
    await bridge.invoke('tasks.cancel@1', { taskId });
  }));
  cards.set(taskId, card);
  return card;
}

function applyEvent(event) {
  const card = ensureCard(event.taskId, event.kind);
  card.statusEl.textContent = taskStatusLabel(event.status);
  card.el.dataset.status = event.status;
  if (event.progress) {
    card.progressEl.max = event.progress.total;
    card.progressEl.value = event.progress.done;
  }
  if (event.chunk) {
    card.streamed += event.chunk;
    card.streamEl.textContent = card.streamed;
  }
  if (event.error) {
    card.streamEl.textContent = `${event.error.code}: ${event.error.message}`;
  }
  if (isTerminalStatus(event.status)) {
    card.cancelBtn.disabled = true;
  }
}

async function startTask(kind, input) {
  const { taskId } = await bridge.start(kind, input);
  ensureCard(taskId, kind);
  await bridge.subscribe(taskId, applyEvent);
  // 事件不重放：订阅后查询一次快照，补上订阅前已到终态的状态。
  const snapshot = await bridge.invoke('tasks.get@1', { taskId });
  applyEvent(snapshot.task);
  log(`任务已启动：${taskId}（${kind}）`);
}

document.getElementById('btn-info').addEventListener('click', guard('app.info@1 失败', async () => {
  log('app.info@1', await bridge.invoke('app.info@1'));
}));

document.getElementById('btn-echo').addEventListener('click', guard('bridge.echo@1 失败', async () => {
  log('bridge.echo@1', await bridge.invoke('bridge.echo@1', { message: '桥接回声', at: new Date().toISOString() }));
}));

document.getElementById('btn-stream').addEventListener('click', guard('启动任务失败', () =>
  startTask('demo.stream-text@1', { chunks: 24, chunkDelayMs: 400 })));

document.getElementById('btn-stream-long').addEventListener('click', guard('启动任务失败', () =>
  startTask('demo.stream-text@1', { chunks: 60, chunkDelayMs: 1000 })));

document.getElementById('btn-fail').addEventListener('click', guard('启动任务失败', () =>
  startTask('demo.fail@1', { message: '演示任务按请求失败' })));

document.getElementById('btn-active').addEventListener('click', guard('tasks.list@1 失败', async () => {
  const result = await bridge.invoke('tasks.list@1', { activeOnly: true });
  log('tasks.list@1（仅活动任务）', result);
}));

// 关闭流程：窗口被拦截时提示等待完成或停止任务。
bridge.onCloseRequested((payload) => {
  const active = activeTasks(payload.tasks ?? []);
  closeTaskList.replaceChildren();
  for (const task of active) {
    const item = document.createElement('li');
    item.textContent = `${task.taskId}（${task.kind}）：${taskStatusLabel(task.status)}`;
    closeTaskList.appendChild(item);
  }
  if (!closeDialog.open) {
    closeDialog.showModal();
  }
});

document.getElementById('btn-close-wait').addEventListener('click', guard('等待任务完成失败', async () => {
  const result = await bridge.invoke('tasks.list@1', { activeOnly: true });
  const active = activeTasks(result.tasks ?? []);
  if (active.length === 0) {
    await bridge.closeWindow(false);
    return;
  }
  let remaining = active.length;
  for (const task of active) {
    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      remaining -= 1;
      if (remaining <= 0) {
        await bridge.closeWindow(false);
      }
    };
    await bridge.subscribe(task.taskId, (event) => {
      if (isTerminalStatus(event.status)) {
        void settle();
      }
    });
    // 事件不重放：订阅后复查快照，任务可能已在订阅前到达终态。
    const snapshot = await bridge.invoke('tasks.get@1', { taskId: task.taskId });
    if (isTerminalStatus(snapshot.task.status)) {
      await settle();
    }
  }
  closeDialog.close();
  log('等待全部任务完成后自动退出……');
}));

document.getElementById('btn-close-stop').addEventListener('click', guard('停止任务并退出失败', async () => {
  await bridge.closeWindow(true);
}));

document.getElementById('btn-close-cancel').addEventListener('click', () => {
  closeDialog.close();
});
