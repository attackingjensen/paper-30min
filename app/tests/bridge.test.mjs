import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBridge,
  trackTask,
  taskStatusLabel,
  isTerminalStatus,
  activeTasks,
  waitForActiveTasks,
} from '../ui/bridge.js';

test('waitForActiveTasks：事件缺失时轮询到任务终态', async () => {
  let calls = 0;
  const bridge = { invoke: async () => ({ tasks: [{ status: ++calls < 3 ? 'running' : 'succeeded' }] }) };
  assert.equal(await waitForActiveTasks(bridge, { intervalMs: 0 }), true);
  assert.equal(calls, 3);
});

test('waitForActiveTasks：取消等待后不再关闭窗口', async () => {
  const controller = new AbortController();
  let calls = 0;
  const bridge = { invoke: async () => {
    calls += 1;
    controller.abort();
    return { tasks: [{ status: 'running' }] };
  } };
  assert.equal(await waitForActiveTasks(bridge, { signal: controller.signal, intervalMs: 0 }), false);
  assert.equal(calls, 1);
});

test('waitForActiveTasks：轮询间隔中取消会及时停止', async () => {
  const controller = new AbortController();
  let calls = 0;
  const bridge = { invoke: async () => {
    calls += 1;
    return { tasks: [{ status: 'running' }] };
  } };
  const waiting = waitForActiveTasks(bridge, { signal: controller.signal, intervalMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  assert.equal(await waiting, false);
  assert.equal(calls, 1);
});

function createTauriStub() {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    listeners,
    core: {
      invoke: (cmd, args) => {
        calls.push({ cmd, args });
        return Promise.resolve({ schemaVersion: 1 });
      },
    },
    event: {
      listen: (channel, handler) => {
        listeners.set(channel, handler);
        return Promise.resolve(() => {});
      },
    },
  };
}

test('invoke 命令经统一入口带版本化命令名与输入', async () => {
  const tauri = createTauriStub();
  const bridge = createBridge(tauri);
  await bridge.invoke('tasks.list@1', { activeOnly: true });
  assert.deepEqual(tauri.calls[0], {
    cmd: 'bridge_invoke',
    args: { command: 'tasks.list@1', input: { activeOnly: true } },
  });
});

test('invoke 缺省输入为空对象', async () => {
  const tauri = createTauriStub();
  const bridge = createBridge(tauri);
  await bridge.invoke('app.info@1');
  assert.deepEqual(tauri.calls[0].args, { command: 'app.info@1', input: {} });
});

test('start 走 bridge_start 入口并携带任务类型', async () => {
  const tauri = createTauriStub();
  const bridge = createBridge(tauri);
  await bridge.start('demo.stream-text@1', { chunks: 4 });
  assert.deepEqual(tauri.calls[0], {
    cmd: 'bridge_start',
    args: { kind: 'demo.stream-text@1', input: { chunks: 4 } },
  });
});

test('subscribe 订阅 task:{taskId} 事件通道并解包 payload', async () => {
  const tauri = createTauriStub();
  const bridge = createBridge(tauri);
  const received = [];
  await bridge.subscribe('task-000001', (event) => received.push(event));
  const handler = tauri.listeners.get('task:task-000001');
  assert.ok(handler);
  handler({ payload: { schemaVersion: 1, taskId: 'task-000001', event: 'chunk' } });
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'chunk');
});

test('onCloseRequested 订阅 app:close-requested 通道', async () => {
  const tauri = createTauriStub();
  const bridge = createBridge(tauri);
  const payloads = [];
  await bridge.onCloseRequested((payload) => payloads.push(payload));
  const handler = tauri.listeners.get('app:close-requested');
  assert.ok(handler);
  handler({ payload: { schemaVersion: 1, tasks: [] } });
  assert.equal(payloads.length, 1);
});

test('closeWindow 发送 app.close-window@1 并携带 cancelTasks', async () => {
  const tauri = createTauriStub();
  const bridge = createBridge(tauri);
  await bridge.closeWindow(true);
  assert.deepEqual(tauri.calls[0], {
    cmd: 'bridge_invoke',
    args: { command: 'app.close-window@1', input: { cancelTasks: true } },
  });
});

test('任务状态文案覆盖全部规格状态', () => {
  assert.equal(taskStatusLabel('queued'), '等待');
  assert.equal(taskStatusLabel('running'), '进行中');
  assert.equal(taskStatusLabel('succeeded'), '成功');
  assert.equal(taskStatusLabel('failed'), '失败');
  assert.equal(taskStatusLabel('cancel_requested'), '取消中');
  assert.equal(taskStatusLabel('cancelled'), '已取消');
  assert.equal(taskStatusLabel('retry_waiting'), '待重试');
});

test('isTerminalStatus 只认三个终态', () => {
  assert.ok(isTerminalStatus('succeeded'));
  assert.ok(isTerminalStatus('failed'));
  assert.ok(isTerminalStatus('cancelled'));
  assert.ok(!isTerminalStatus('cancel_requested'));
  assert.ok(!isTerminalStatus('running'));
});

test('activeTasks 只保留仍在运行的任务', () => {
  const active = activeTasks([
    { taskId: 'a', status: 'running' },
    { taskId: 'b', status: 'succeeded' },
    { taskId: 'c', status: 'cancel_requested' },
    { taskId: 'd', status: 'cancelled' },
  ]);
  assert.deepEqual(active.map((t) => t.taskId), ['a', 'c']);
});

// ---------------- trackTask：subscribe + tasks.get@1 快照复核的公共收尾 ----------------

// 假 bridge：手动派发事件序列；tasks.get@1 快照可预置。
function createTaskBridge({ snapshot } = {}) {
  const calls = [];
  const handlers = new Map();
  return {
    calls,
    emit: (taskId, event) => handlers.get(taskId)?.(event),
    async subscribe(taskId, handler) {
      handlers.set(taskId, handler);
      return () => handlers.delete(taskId);
    },
    async invoke(command, input = {}) {
      calls.push({ command, input });
      if (command === 'tasks.get@1') {
        // 与真实桥一致：{ schemaVersion, task }，终态字段在 task 上。
        return { schemaVersion: 1, task: snapshot ?? { taskId: input.taskId, status: 'running' } };
      }
      if (command === 'tasks.cancel@1') return { schemaVersion: 1 };
      throw new Error(`未 mock 的命令：${command}`);
    },
  };
}

// 等 subscribe/快照复核的微任务链走完再派发事件。
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('trackTask：chunk 转发 onChunk，终态 status 解出 { status, result }', async () => {
  const bridge = createTaskBridge();
  const chunks = [];
  const statuses = [];
  const promise = trackTask(bridge, 'task-1', {
    onChunk: chunk => chunks.push(chunk),
    onStatus: status => statuses.push(status),
  });
  await tick();

  bridge.emit('task-1', { event: 'chunk', chunk: '甲' });
  bridge.emit('task-1', { event: 'status', status: 'retry_waiting' });
  bridge.emit('task-1', { event: 'chunk', chunk: '乙' });
  bridge.emit('task-1', { event: 'status', status: 'succeeded', result: { ok: true } });

  assert.deepEqual(await promise, { status: 'succeeded', error: undefined, result: { ok: true } });
  assert.deepEqual(chunks, ['甲', '乙']);
  assert.ok(!statuses.includes('chunk'), 'onStatus 只收 status 事件');
});

test('trackTask：onEvent 转发阶段/工具等全部事件', async () => {
  const bridge = createTaskBridge();
  const events = [];
  const promise = trackTask(bridge, 'task-1', { onEvent: event => events.push(event.event) });
  await tick();

  bridge.emit('task-1', { event: 'stage', detail: { stage: 'map-l2' } });
  bridge.emit('task-1', { event: 'tool', detail: { name: 'read_section' } });
  bridge.emit('task-1', { event: 'status', status: 'succeeded' });

  assert.equal((await promise).status, 'succeeded');
  assert.deepEqual(events, ['stage', 'tool', 'status']);
});

test('trackTask：订阅前已终态时由 tasks.get@1 快照复核收尾（事件不重放）', async () => {
  const bridge = createTaskBridge({
    snapshot: { taskId: 'task-1', status: 'failed', error: { code: 'boom', message: '坏了', retryable: true } },
  });
  const outcome = await trackTask(bridge, 'task-1', {});
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'boom');
  assert.ok(bridge.calls.some(c => c.command === 'tasks.get@1' && c.input.taskId === 'task-1'));
});

test('trackTask：signal abort 调 tasks.cancel@1，cancelled 终态照常收尾', async () => {
  const bridge = createTaskBridge();
  const controller = new AbortController();
  const promise = trackTask(bridge, 'task-1', { signal: controller.signal });
  await tick();

  controller.abort();
  await tick();
  const cancels = bridge.calls.filter(c => c.command === 'tasks.cancel@1');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].input.taskId, 'task-1');

  bridge.emit('task-1', { event: 'status', status: 'cancelled' });
  assert.equal((await promise).status, 'cancelled');
});

// 等竞态的测试用有界等待：收尾失败时以明确的报错失败，而不是把整轮卡死。
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = promise => Promise.race([
  promise,
  sleep(200).then(() => { throw new Error('任务未在 200ms 内收尾（终态收尾丢失）'); }),
]);

// #91：瞬时失败的任务在「订阅建立」前就终态（事件不重放），若快照又在终态写入前取到，
// 两次都错过 → 任务永不收尾，界面停在「深挖进行中」且按钮永久禁用。
test('trackTask：任务在订阅建立前瞬时失败，由订阅建立后的快照复核收尾', async () => {
  let releaseListen;
  const gate = new Promise(resolve => { releaseListen = resolve; });
  let status = 'running';
  const bridge = {
    async subscribe() {
      await gate; // 监听建立有延迟（真实桥的 listen 是异步注册）
      return () => {};
    },
    async invoke(command, input = {}) {
      assert.equal(command, 'tasks.get@1');
      // 快照读的是调用时刻的登记状态：终态写入晚于第一次快照时，第一次只能读到 running
      return {
        schemaVersion: 1,
        task: {
          taskId: input.taskId,
          status,
          error: status === 'failed' ? { code: 'invalid_input', message: '未知的精读部分' } : undefined,
        },
      };
    },
  };

  const promise = trackTask(bridge, 'task-1', {});
  await tick();        // 旧实现此刻已取过快照（读到 running）
  status = 'failed';   // 订阅建立前终态：终态事件不会重放
  releaseListen();

  const outcome = await withTimeout(promise);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'invalid_input');
});

test('trackTask：事件订阅失败后仍以快照轮询到终态', async () => {
  let status = 'running';
  let reads = 0;
  const bridge = {
    async subscribe() { throw new Error('WebView 监听失败'); },
    async invoke(command, input) {
      assert.equal(command, 'tasks.get@1');
      reads += 1;
      return { schemaVersion: 1, task: { taskId: input.taskId, status } };
    },
  };

  const outcome = trackTask(bridge, 'task-1');
  await tick();
  assert.equal(reads, 2);
  status = 'succeeded';

  const result = await Promise.race([
    outcome,
    sleep(1000).then(() => { throw new Error('订阅失败后未通过快照收尾'); }),
  ]);
  assert.equal(result.status, 'succeeded');
  assert.ok(reads >= 3);
});

// #91：终态收尾优先于回调副作用——渲染回调抛错不能让任务登记永远停在「开放」。
test('trackTask：onEvent 抛错不阻断终态收尾', async () => {
  const bridge = createTaskBridge();
  const promise = trackTask(bridge, 'task-1', {
    onEvent: () => { throw new Error('渲染炸了'); },
  });
  await tick();

  assert.throws(
    () => bridge.emit('task-1', { event: 'status', status: 'failed', error: { code: 'x', message: 'y' } }),
    /渲染炸了/,
  );
  const outcome = await withTimeout(promise);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'x');
});
