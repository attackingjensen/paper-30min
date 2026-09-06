// model.js 的设置缓存与桥接任务生命周期的单元测试。
// 假 bridge 手动派发事件序列；快照经 tasks.get@1 预置。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initModel, initSettings, loadSettings, saveSettings, settingsReady,
  chat, testConnection, DEFAULT_SETTINGS,
} from '../ui/js/model.js';

function createFakeBridge({ settings } = {}) {
  const calls = [];
  const taskHandlers = new Map();
  const snapshots = new Map();
  let seq = 0;
  return {
    calls,
    snapshots,
    async start(kind, input) {
      calls.push({ method: 'start', kind, input });
      const taskId = `task-${++seq}`;
      return { schemaVersion: 1, taskId };
    },
    async subscribe(taskId, handler) {
      taskHandlers.set(taskId, handler);
      return () => taskHandlers.delete(taskId);
    },
    async invoke(command, input = {}) {
      calls.push({ method: 'invoke', command, input });
      if (command === 'settings.get@1') {
        return {
          schemaVersion: 1,
          model: settings ?? { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 2048 },
        };
      }
      if (command === 'settings.putModel@1') return { schemaVersion: 1, settings: input.settings };
      if (command === 'tasks.get@1') {
        // 与真实桥一致：{ schemaVersion, task }，终态字段在 task 上。
        const task = snapshots.get(input.taskId) ?? { taskId: input.taskId, status: 'running' };
        return { schemaVersion: 1, task };
      }
      if (command === 'tasks.cancel@1') return { schemaVersion: 1, cancelled: true };
      throw new Error(`未 mock 的命令：${command}`);
    },
    emitLast(event) {
      taskHandlers.get(`task-${seq}`)?.(event);
    },
  };
}

// 等 start/subscribe/快照复核的微任务链走完再派发事件。
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('设置：initSettings 入缓存，loadSettings 同步读，saveSettings 写回并更新缓存', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  assert.equal(loadSettings().temperature, 0.7);
  assert.equal(settingsReady(), true);

  await saveSettings({ ...loadSettings(), model: 'm2' });
  const put = bridge.calls.find(c => c.command === 'settings.putModel@1');
  assert.equal(put.input.settings.model, 'm2');
  assert.equal(put.input.settings.temperature, 0.7); // 与 DEFAULT_SETTINGS 合并
  assert.equal(loadSettings().model, 'm2');
});

test('chat：chunk 累积与 onDelta(full) 次序，succeeded resolve 全文', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  const deltas = [];
  const promise = chat([{ role: 'user', content: 'hi' }], { onDelta: full => deltas.push(full) });
  await tick();

  const startCall = bridge.calls.find(c => c.method === 'start');
  assert.equal(startCall.kind, 'model.chat@1');
  // temperature/maxTokens 取缓存设置
  assert.equal(startCall.input.temperature, 0.7);
  assert.equal(startCall.input.maxTokens, 2048);
  assert.equal(startCall.input.stream, true);
  assert.deepEqual(startCall.input.messages, [{ role: 'user', content: 'hi' }]);

  bridge.emitLast({ event: 'chunk', chunk: '你' });
  bridge.emitLast({ event: 'chunk', chunk: '好' });
  bridge.emitLast({ event: 'status', status: 'succeeded' });

  assert.equal(await promise, '你好');
  assert.deepEqual(deltas, ['你', '你好']);
});

test('chat：failed reject 携带 code 与 retryable', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  const promise = chat([{ role: 'user', content: 'hi' }]);
  await tick();
  bridge.emitLast({
    event: 'status',
    status: 'failed',
    error: { code: 'model_not_configured', message: '未配置模型', retryable: false },
  });
  await assert.rejects(promise, err =>
    err.message === '未配置模型'
    && err.code === 'model_not_configured'
    && err.retryable === false);
});

test('chat：cancelled reject AbortError', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  const promise = chat([{ role: 'user', content: 'hi' }]);
  await tick();
  bridge.emitLast({ event: 'status', status: 'cancelled' });
  await assert.rejects(promise, err => err.name === 'AbortError' && err.message === '生成已取消');
});

test('chat：signal.abort 触发 tasks.cancel@1（幂等），终态仍按 cancelled 收尾', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  const controller = new AbortController();
  const promise = chat([{ role: 'user', content: 'hi' }], { signal: controller.signal });
  await tick();

  controller.abort();
  await tick();
  const cancels = bridge.calls.filter(c => c.command === 'tasks.cancel@1');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].input.taskId, 'task-1');

  bridge.emitLast({ event: 'status', status: 'cancelled' });
  await assert.rejects(promise, err => err.name === 'AbortError');
});

test('chat：订阅前已终态时由 tasks.get@1 快照复核收尾（事件不重放）', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  // 预置终态快照：subscribe 后没有任何事件，只能靠快照复核
  bridge.snapshots.set('task-1', { taskId: 'task-1', status: 'succeeded', result: null });
  const full = await chat([{ role: 'user', content: 'hi' }]);
  assert.equal(full, '');
  assert.ok(bridge.calls.some(c => c.command === 'tasks.get@1' && c.input.taskId === 'task-1'));
});

test('chat：failed 快照缺 error 字段时给出兜底错误', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  bridge.snapshots.set('task-1', { taskId: 'task-1', status: 'failed' });
  await assert.rejects(
    chat([{ role: 'user', content: 'hi' }]),
    err => err.code === 'unknown' && err.retryable === false,
  );
});

test('testConnection：succeeded 返回 result.message，failed 抛 Error(error.message)', async () => {
  const bridge = createFakeBridge();
  initModel(bridge);
  await initSettings();

  const ok = testConnection();
  await tick();
  const startCall = bridge.calls.find(c => c.method === 'start');
  assert.equal(startCall.kind, 'model.test@1');
  assert.deepEqual(startCall.input, {});
  bridge.emitLast({ event: 'status', status: 'succeeded', result: { message: '✅ 连接成功' } });
  assert.equal(await ok, '✅ 连接成功');

  const bad = testConnection();
  await tick();
  bridge.emitLast({ event: 'status', status: 'failed', error: { code: 'http_401', message: '鉴权失败', retryable: false } });
  await assert.rejects(bad, err => err.message === '鉴权失败');
});

test('DEFAULT_SETTINGS 与浏览器端字段一致', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.3,
    maxTokens: 4096,
    maxChars: 16000,
  });
});
