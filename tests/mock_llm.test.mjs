// tools/mock_llm.py 的集成测试：真实启动 mock，验证 SSE 字节流形态，
// 并用前端 chat() 走一遍「末尾 data 行无换行」的完整解析链路（Issue #7）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MOCK = fileURLToPath(new URL('../tools/mock_llm.py', import.meta.url));
const pythonOk = spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0;
const needPython = pythonOk ? false : '未找到 python，跳过 mock 集成测试';

// localStorage 桩必须在 import api.js 之前就位；baseUrl 在拿到端口后回填。
const settings = { baseUrl: '', apiKey: 'mock', model: 'mock-reader-1' };
globalThis.localStorage = {
  getItem: () => JSON.stringify(settings),
  setItem: () => {},
};
const { chat } = await import('../public/js/api.js');

function startMock(args = []) {
  const child = spawn('python', [MOCK, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`mock 启动超时，输出：${out}`)), 15000);
    child.stdout.on('data', d => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`mock 提前退出（exit ${code}）：${out}`));
    });
  });
  return { child, port };
}

async function fetchStreamRaw(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-reader-1',
      stream: true,
      messages: [{ role: 'user', content: 'Abstract 原文：（触发 abstract 回复）' }],
    }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

test('mock --unterminated-tail：末尾 data 行无换行、无 [DONE]，前端 chat() 收全', { skip: needPython }, async (t) => {
  const { child, port } = await startMock(['--unterminated-tail']);
  t.after(() => child.kill());

  const raw = await fetchStreamRaw(await port);
  assert.ok(!raw.includes('[DONE]'), '未终止模式不应发送 [DONE]');
  assert.ok(!raw.endsWith('\n'), '末尾 data 行不应带任何换行符');
  const lastLine = raw.split('\n').filter(Boolean).at(-1);
  assert.ok(lastLine.startsWith('data: '), '末尾仍应是完整 data 事件');
  const tailDelta = JSON.parse(lastLine.slice(5).trim()).choices[0].delta.content;

  settings.baseUrl = `http://127.0.0.1:${await port}/v1`;
  const updates = [];
  const result = await chat([{ role: 'user', content: 'Abstract 原文：x' }], {
    onDelta: text => updates.push(text),
  });
  assert.ok(result.endsWith(tailDelta), '末尾未终止事件的增量应被收尾解析收进全文');
  assert.ok(updates.length > 5, '应收到多次流式增量');
  assert.equal(updates.at(-1), result);
});

test('mock 默认模式：以 data: [DONE]\\n\\n 正常收尾', { skip: needPython }, async (t) => {
  const { child, port } = await startMock();
  t.after(() => child.kill());

  const raw = await fetchStreamRaw(await port);
  assert.ok(raw.endsWith('data: [DONE]\n\n'));
});
