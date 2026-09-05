import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBridge,
  taskStatusLabel,
  isTerminalStatus,
  activeTasks,
} from '../ui/bridge.js';

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
