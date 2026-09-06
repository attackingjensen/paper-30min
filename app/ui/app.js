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

const SAMPLE_PAPER_ID = 'ui-sample-paper';

function samplePaper() {
  const now = new Date().toISOString();
  return {
    id: SAMPLE_PAPER_ID,
    title: '桥接自检示例论文',
    sourceType: 'plain-text',
    fullText: '这是用于书库自检的示例原文。',
    addedAt: now,
    updatedAt: now,
    sections: [{ id: 'abstract', sourceText: '这是用于书库自检的示例原文。' }],
    analyses: [{ sectionId: 'abstract', text: '示例精读结果', updatedAt: now }],
    translations: [{ sectionId: 'abstract', language: 'zh', text: '示例译文', source: 'manual', updatedAt: now }],
    recallCard: { markdown: '示例回想卡片', images: [], updatedAt: now },
    chat: [{ role: 'user', content: '这篇论文在讲什么？', createdAt: now }],
  };
}

document.getElementById('btn-library-info').addEventListener('click', guard('library.info@1 失败', async () => {
  log('library.info@1', await bridge.invoke('library.info@1'));
}));

document.getElementById('btn-library-save').addEventListener('click', guard('library.putPaper@1 失败', async () => {
  log('library.putPaper@1', await bridge.invoke('library.putPaper@1', { paper: samplePaper() }));
}));

document.getElementById('btn-library-load').addEventListener('click', guard('library.getPaper@1 失败', async () => {
  log('library.getPaper@1', await bridge.invoke('library.getPaper@1', { paperId: SAMPLE_PAPER_ID }));
}));

document.getElementById('btn-library-position').addEventListener('click', guard('library.putReadingPosition@1 失败', async () => {
  log('library.putReadingPosition@1', await bridge.invoke('library.putReadingPosition@1', {
    position: { paperId: SAMPLE_PAPER_ID, view: 'digest', sectionId: 'abstract' },
  }));
}));

document.getElementById('btn-library-list').addEventListener('click', guard('library.listPapers@1 失败', async () => {
  log('library.listPapers@1', await bridge.invoke('library.listPapers@1'));
}));

document.getElementById('btn-library-delete').addEventListener('click', guard('library.deletePaper@1 失败', async () => {
  log('library.deletePaper@1', await bridge.invoke('library.deletePaper@1', { paperId: SAMPLE_PAPER_ID }));
}));

let lastMigrationToken = '';

document.getElementById('btn-migration-inspect').addEventListener('click', guard('migration.inspect@1 失败', async () => {
  const sourcePath = document.getElementById('migration-path').value.trim();
  const result = await bridge.invoke('migration.inspect@1', { sourcePath });
  lastMigrationToken = result.token || '';
  log('migration.inspect@1', result);
}));

document.getElementById('btn-migration-commit').addEventListener('click', guard('migration.commit@1 失败', async () => {
  const result = await bridge.invoke('migration.commit@1', { token: lastMigrationToken });
  lastMigrationToken = '';
  log('migration.commit@1', result);
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
