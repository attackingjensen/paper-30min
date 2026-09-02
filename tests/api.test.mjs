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

const { chat } = await import('../public/js/api.js');

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
