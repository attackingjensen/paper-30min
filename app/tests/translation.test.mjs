import test from 'node:test';
import assert from 'node:assert/strict';
import { translateForPaper } from '../ui/js/translation.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('translation completed after switching papers does not save to either paper', async () => {
  const paper = { id: 'old' };
  const reply = deferred();
  let current = paper;
  const saved = [];
  const operation = translateForPaper({
    paper, partId: 'part-1', chunks: ['source'], language: 'zh', source: 'source', systemPrompt: 'translate',
    chat: () => reply.promise,
    save: (...args) => saved.push(args),
    isCurrent: () => current === paper,
    signal: new AbortController().signal,
  });

  current = { id: 'new' };
  reply.resolve('译文');
  await assert.rejects(operation, { name: 'AbortError' });
  assert.deepEqual(saved, []);
});

test('translation saves the captured paper after all chunks succeed', async () => {
  const paper = { id: 'paper' };
  const saved = [];
  const result = await translateForPaper({
    paper, partId: 'part-1', chunks: ['one', 'two'], language: 'zh', source: 'one two', systemPrompt: 'translate',
    chat: async messages => messages[1].content.toUpperCase(),
    save: (...args) => saved.push(args),
    isCurrent: () => true,
    signal: new AbortController().signal,
  });

  assert.equal(result, 'ONE\n\nTWO');
  assert.deepEqual(saved, [[paper, 'part-1', 'zh', result, 'one two']]);
});

test('cancelled translation does not start another chunk or save', async () => {
  const paper = { id: 'paper' };
  const controller = new AbortController();
  let calls = 0;
  let saved = false;
  const operation = translateForPaper({
    paper, partId: 'part-1', chunks: ['one', 'two'], language: 'zh', source: 'one two', systemPrompt: 'translate',
    chat: async () => {
      calls += 1;
      controller.abort();
      return 'ONE';
    },
    save: () => { saved = true; },
    isCurrent: () => true,
    signal: controller.signal,
  });

  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(saved, false);
});
