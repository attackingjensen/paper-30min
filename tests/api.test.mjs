import assert from 'node:assert/strict';
import test from 'node:test';

const settings = JSON.stringify({
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
});

globalThis.localStorage = {
  getItem: () => settings,
  setItem: () => {},
};

const { chat, endpoint } = await import('../public/js/api.js');

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function event(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
}

test('chat consumes a complete final SSE data line without a newline', async () => {
  globalThis.fetch = async () => sseResponse([event('tail')]);
  const updates = [];

  const result = await chat([{ role: 'user', content: 'x' }], {
    onDelta: text => updates.push(text),
  });

  assert.equal(result, 'tail');
  assert.deepEqual(updates, ['tail']);
});

test('chat handles newline-delimited, split, and done SSE events once each', async () => {
  globalThis.fetch = async () => sseResponse([
    `${event('hel')}\n`,
    `${event('lo')}\n\ndata: [DO`,
    'NE]\n',
  ]);
  const updates = [];

  const result = await chat([{ role: 'user', content: 'x' }], {
    onDelta: text => updates.push(text),
  });

  assert.equal(result, 'hello');
  assert.deepEqual(updates, ['hel', 'hello']);
});

test('endpoint rewrites a bare DashScope host to the compatible-mode path', () => {
  assert.equal(
    endpoint({ baseUrl: 'https://dashscope.aliyuncs.com' }, '/chat/completions'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
});

test('endpoint leaves an already-correct compatible-mode base URL untouched', () => {
  assert.equal(
    endpoint({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, '/chat/completions'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
});

test('endpoint rewrites the international DashScope host', () => {
  assert.equal(
    endpoint({ baseUrl: 'https://dashscope-intl.aliyuncs.com' }, '/models'),
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
  );
});

test('endpoint leaves non-DashScope hosts untouched', () => {
  assert.equal(
    endpoint({ baseUrl: 'https://api.deepseek.com/v1' }, '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
});

test('endpoint strips a trailing chat/completions from the base URL', () => {
  assert.equal(
    endpoint({ baseUrl: 'https://example.com/v1/chat/completions' }, '/chat/completions'),
    'https://example.com/v1/chat/completions',
  );
});

test('endpoint rejects an empty base URL', () => {
  assert.throws(() => endpoint({ baseUrl: '   ' }, '/chat/completions'), /不能为空/);
});

test('endpoint rejects a base URL without a scheme', () => {
  assert.throws(() => endpoint({ baseUrl: 'api.example.com/v1' }, '/chat/completions'), /格式无效/);
});

test('chat points at compatible-mode when the endpoint 404s', async () => {
  globalThis.fetch = async () => new Response('no such endpoint', { status: 404 });

  await assert.rejects(chat([{ role: 'user', content: 'x' }], { stream: false }), err => {
    assert.match(err.message, /HTTP 404/);
    assert.match(err.message, /no such endpoint/);
    assert.match(err.message, /阿里云百炼需以 \/compatible-mode\/v1 结尾/);
    return true;
  });
});

test('chat omits the compatible-mode hint on non-404 failures', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 500 });

  await assert.rejects(chat([{ role: 'user', content: 'x' }], { stream: false }), err => {
    assert.match(err.message, /HTTP 500/);
    assert.match(err.message, /boom/);
    assert.doesNotMatch(err.message, /compatible-mode/);
    return true;
  });
});

test('chat reports a Cloudflare 1010 rejection distinctly', async () => {
  globalThis.fetch = async () => new Response('error code: 1010', { status: 403 });

  await assert.rejects(chat([{ role: 'user', content: 'x' }], { stream: false }), err => {
    assert.match(err.message, /Cloudflare 拒绝了请求/);
    assert.match(err.message, /1010/);
    assert.doesNotMatch(err.message, /API 请求失败/);
    return true;
  });
});

test('chat extracts the message from a JSON error body', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });

  await assert.rejects(chat([{ role: 'user', content: 'x' }], { stream: false }), err => {
    assert.match(err.message, /HTTP 401/);
    assert.match(err.message, /invalid api key/);
    return true;
  });
});
