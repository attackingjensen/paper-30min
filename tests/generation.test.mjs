import assert from 'node:assert/strict';
import test from 'node:test';
import * as papers from '../public/js/papers.js';
import * as generation from '../public/js/generation.js';

// ---- 测试夹具 ----

function memoryStore() {
  const records = new Map();
  return {
    records,
    async getAll() { return [...records.values()]; },
    async get(id) { return records.get(id); },
    async put(paper) { records.set(paper.id, paper); },
    async delete(id) { records.delete(id); },
  };
}

function paperFixture(overrides = {}) {
  return {
    id: 'p1',
    title: 'Test Paper',
    sections: { abstract: 'Abstract section content.', introduction: 'Introduction content.' },
    parts: [],
    analyses: {},
    ...overrides,
  };
}

function abortError() {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/** 假 chat：记录调用，由 fn 驱动 onDelta/signal 并返回完整文本。 */
function chatWith(fn) {
  const calls = [];
  const chat = (messages, opts = {}) => {
    calls.push({ messages, signal: opts.signal });
    return fn(opts);
  };
  return { chat, calls };
}

/** 依次发出累积增量后正常完成的假 chat。 */
function streamingChat(chunks, settings = { maxChars: 16000 }) {
  const { chat, calls } = chatWith(async ({ onDelta }) => {
    let full = '';
    for (const chunk of chunks) {
      full += chunk;
      onDelta(full);
    }
    return full;
  });
  return { chat, calls, settings };
}

function initDeps(chat, settings = { maxChars: 16000 }) {
  generation.init({ chat, loadSettings: () => settings });
}

// ---- 单节生成：完成与失败 ----

test('单节生成完成：增量经 sink 透出，结果经 saveAnalysis 缝落库', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat, calls } = streamingChat(['精读', '结果']);
  initDeps(chat);
  const paper = paperFixture();
  const updates = [];

  const started = generation.startSection(paper, 'abstract', { onUpdate: full => updates.push(full) });
  assert.equal(started.accepted, true);
  const result = await started.done;

  assert.equal(result.status, 'completed');
  assert.equal(result.text, '精读结果');
  assert.deepEqual(updates, ['精读', '精读结果']);
  assert.equal(paper.analyses.abstract.text, '精读结果');
  assert.equal(store.records.get('p1').analyses.abstract.text, '精读结果');
  assert.equal(calls.length, 1);
});

test('模型返回空结果：任务失败且不落库', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat } = streamingChat(['  ']);
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'abstract');
  const result = await started.done;

  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, '模型未返回内容');
  assert.deepEqual(paper.analyses, {});
  assert.equal(store.records.size, 0);
});

test('模型调用抛错：任务失败并携带错误，不落库', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat } = chatWith(async () => { throw new Error('HTTP 500'); });
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'abstract');
  const result = await started.done;

  assert.equal(result.status, 'failed');
  assert.equal(result.error.message, 'HTTP 500');
  assert.deepEqual(paper.analyses, {});
});

// ---- 取消语义 ----

/** 发出累积增量后挂起，直到 signal 中断后以 AbortError 拒绝的假 chat。 */
function hangingChat(chunks) {
  return chatWith(({ onDelta, signal }) => new Promise((resolve, reject) => {
    let full = '';
    for (const chunk of chunks) {
      full += chunk;
      onDelta(full);
    }
    signal.addEventListener('abort', () => reject(abortError()));
  }));
}

test('中断且部分结果超过 60 字符：拼警示标记落库', async () => {
  const store = memoryStore();
  papers.init(store);
  const partial = 'x'.repeat(61);
  const { chat } = hangingChat([partial]);
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'abstract');
  started.task.cancel();
  const result = await started.done;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.saved, partial + '\n\n> ⚠️ 生成被中断，内容为部分结果。');
  assert.equal(store.records.get('p1').analyses.abstract.text, result.saved);
});

test('中断且部分结果不超过 60 字符：丢弃不落库', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat } = hangingChat(['x'.repeat(60)]);
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'abstract');
  started.task.cancel();
  const result = await started.done;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.saved, null);
  assert.deepEqual(paper.analyses, {});
  assert.equal(store.records.size, 0);
});

test('取消幂等：重复取消与完成后再取消都不改变终态', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat } = hangingChat(['x'.repeat(61)]);
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'abstract');
  started.task.cancel();
  started.task.cancel();
  const result = await started.done;
  assert.equal(result.status, 'cancelled');
  started.task.cancel();
  assert.equal(store.records.get('p1').analyses.abstract.text, result.saved);

  initDeps(streamingChat(['新', '结果']).chat);
  const again = generation.startSection(paper, 'abstract');
  assert.equal(again.accepted, true);
  const againResult = await again.done;
  again.task.cancel();
  assert.equal(againResult.status, 'completed');
  assert.equal(paper.analyses.abstract.text, '新结果');
});

test('cancelling 占线：收尾完成前同论文新任务被拒绝，收尾后可启动', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat } = hangingChat(['x'.repeat(61)]);
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'abstract');
  started.task.cancel();
  const duringTeardown = generation.startSection(paper, 'introduction');
  assert.equal(duringTeardown.accepted, false);
  assert.equal(duringTeardown.reason, 'busy');
  await started.done;
  initDeps(streamingChat(['引言结果']).chat);
  const afterTeardown = generation.startSection(paper, 'introduction');
  assert.equal(afterTeardown.accepted, true);
  await afterTeardown.done;
});

// ---- 并发边界与前置校验 ----

test('互斥：同论文精读任务进行中时新任务被拒绝，跨论文不互斥', async () => {
  papers.init(memoryStore());
  const { chat } = hangingChat(['部分']);
  initDeps(chat);
  const paperA = paperFixture({ id: 'pa' });
  const paperB = paperFixture({ id: 'pb' });

  const first = generation.startSection(paperA, 'abstract');
  assert.equal(first.accepted, true);
  const rejected = generation.startSection(paperA, 'introduction');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'busy');

  const otherPaper = generation.startSection(paperB, 'abstract');
  assert.equal(otherPaper.accepted, true);

  first.task.cancel();
  otherPaper.task.cancel();
  await Promise.all([first.done, otherPaper.done]);
});

test('无原文的精读部分拒绝启动，不占用互斥位', async () => {
  papers.init(memoryStore());
  initDeps(streamingChat(['x']).chat);
  const paper = paperFixture();

  const started = generation.startSection(paper, 'method');
  assert.equal(started.accepted, false);
  assert.equal(started.reason, 'no-source');

  const next = generation.startSection(paper, 'abstract');
  assert.equal(next.accepted, true);
  await next.done;
});

// ---- 组提示词组装 ----

test('组提示词：按技能组装，标题与章节名按字面注入，maxChars 截断', async () => {
  papers.init(memoryStore());
  const { chat, calls } = streamingChat(['ok']);
  initDeps(chat, { maxChars: 10 });
  const paper = paperFixture({
    sections: { s1: 'a'.repeat(100) },
    parts: [{ id: 's1', semanticType: 'theory', title: 'Problem Formulation' }],
  });

  const started = generation.startSection(paper, 's1');
  assert.equal(started.accepted, true);
  await started.done;

  const prompt = calls[0].messages[0].content;
  assert.ok(prompt.includes('《Test Paper》'));
  assert.ok(prompt.includes('第 1 部分 · Problem Formulation'));
  assert.ok(prompt.includes('a'.repeat(10) + '\n\n[……原文过长，已截断……]'));
  assert.ok(!prompt.includes('a'.repeat(11)));
});

// ---- 批量生成编排 ----

/** 全部四个默认精读部分都有原文的论文。 */
function fullSourcePaper(id = 'p1') {
  return paperFixture({
    id,
    sections: {
      abstract: 'abstract content',
      introduction: 'introduction content',
      method: 'method content',
      experiments: 'experiments content',
    },
  });
}

test('批量：按精读部分顺序串行推进，无原文节跳过，结果逐节落库', async () => {
  const store = memoryStore();
  papers.init(store);
  const { chat, calls } = chatWith(async ({ onDelta }) => { onDelta('结果'); return '结果'; });
  initDeps(chat);
  const paper = paperFixture(); // 仅 abstract / introduction 有原文
  const starts = [];
  const settles = [];

  const started = generation.startBatch(paper, {
    onSectionStart: def => { starts.push(def.id); },
    onSectionSettled: (def, result) => { settles.push(`${def.id}:${result.status}`); },
  });
  assert.equal(started.accepted, true);
  const batchResult = await started.done;

  assert.equal(batchResult.status, 'completed');
  assert.deepEqual(starts, ['abstract', 'introduction', 'method', 'experiments']);
  assert.deepEqual(settles, ['abstract:completed', 'introduction:completed', 'method:skipped', 'experiments:skipped']);
  assert.equal(calls.length, 2);
  assert.equal(paper.analyses.abstract.text, '结果');
  assert.equal(paper.analyses.introduction.text, '结果');
  assert.equal(store.records.get('p1').analyses.introduction.text, '结果');
});

test('批量：任意时刻至多一个模型调用在途（并发度 1）', async () => {
  papers.init(memoryStore());
  let inflight = 0;
  let maxInflight = 0;
  const { chat } = chatWith(async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inflight -= 1;
    return '结果';
  });
  initDeps(chat);

  const started = generation.startBatch(fullSourcePaper());
  const batchResult = await started.done;

  assert.equal(batchResult.status, 'completed');
  assert.equal(maxInflight, 1);
  assert.equal(batchResult.results.length, 4);
});

test('批量：单节失败不中断后续节', async () => {
  papers.init(memoryStore());
  let call = 0;
  const { chat } = chatWith(async () => {
    call += 1;
    if (call === 1) throw new Error('HTTP 500');
    return '结果';
  });
  initDeps(chat);
  const paper = paperFixture();

  const started = generation.startBatch(paper);
  const batchResult = await started.done;

  assert.equal(batchResult.status, 'completed');
  assert.deepEqual(
    batchResult.results.map(r => `${r.sectionId}:${r.status}`),
    ['abstract:failed', 'introduction:completed', 'method:skipped', 'experiments:skipped'],
  );
  assert.equal(paper.analyses.introduction.text, '结果');
});

test('批量取消：当前节按中断语义收尾落库，后续节不再启动', async () => {
  const store = memoryStore();
  papers.init(store);
  const partial = 'y'.repeat(61);
  const { chat, calls } = hangingChat([partial]);
  initDeps(chat);
  const paper = fullSourcePaper();

  const started = generation.startBatch(paper, { onSectionStart: () => ({}) });
  started.batch.cancel();
  const batchResult = await started.done;

  assert.equal(batchResult.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(
    store.records.get('p1').analyses.abstract.text,
    partial + '\n\n> ⚠️ 生成被中断，内容为部分结果。',
  );
  assert.equal(paper.analyses.introduction, undefined);
});

test('批量与单节互斥：批量进行中单节启动被拒绝', async () => {
  papers.init(memoryStore());
  const { chat } = hangingChat(['部分']);
  initDeps(chat);
  const paper = fullSourcePaper();

  const batch = generation.startBatch(paper);
  assert.equal(batch.accepted, true);
  const single = generation.startSection(paper, 'method');
  assert.equal(single.accepted, false);
  assert.equal(single.reason, 'busy');

  batch.batch.cancel();
  await batch.done;
});

// ---- cancelForPaper：离开即中断并等待收尾 ----

test('cancelForPaper：返回时中断保存已落库，之后可重新生成（离开再进入）', async () => {
  const store = memoryStore();
  papers.init(store);
  const partial = 'z'.repeat(61);
  const { chat } = hangingChat([partial]);
  initDeps(chat);
  const paper = paperFixture();

  generation.startSection(paper, 'abstract');
  await generation.cancelForPaper(paper);

  // cancelForPaper 返回即收尾完成：部分结果已落库
  assert.equal(
    store.records.get('p1').analyses.abstract.text,
    partial + '\n\n> ⚠️ 生成被中断，内容为部分结果。',
  );

  initDeps(streamingChat(['重', '新结果']).chat);
  const again = generation.startSection(paper, 'abstract');
  assert.equal(again.accepted, true);
  const result = await again.done;
  assert.equal(result.status, 'completed');
  assert.equal(paper.analyses.abstract.text, '重新结果');
});

test('cancelForPaper：批量进行中离开时取消整个编排', async () => {
  const store = memoryStore();
  papers.init(store);
  const partial = 'y'.repeat(61);
  const { chat, calls } = hangingChat([partial]);
  initDeps(chat);
  const paper = fullSourcePaper();

  generation.startBatch(paper);
  await generation.cancelForPaper(paper);

  assert.equal(calls.length, 1);
  assert.equal(store.records.get('p1').analyses.abstract.text, partial + '\n\n> ⚠️ 生成被中断，内容为部分结果。');
  assert.equal(paper.analyses.introduction, undefined);
});

test('cancelForPaper：无进行中任务时是空操作', async () => {
  papers.init(memoryStore());
  initDeps(streamingChat(['x']).chat);
  await generation.cancelForPaper(paperFixture());
});

// ---- done 只 resolve 不 reject：界面回调与落库错误被隔离 ----

function muteConsoleError() {
  const original = console.error;
  console.error = () => {};
  return () => { console.error = original; };
}

test('sink 抛错不影响任务终态与互斥位：onStart/onUpdate/onSettled 错误被隔离', async () => {
  const restore = muteConsoleError();
  try {
    const store = memoryStore();
    papers.init(store);
    initDeps(streamingChat(['结', '果']).chat);
    const paper = paperFixture();

    const started = generation.startSection(paper, 'abstract', {
      onStart: () => { throw new Error('UI boom'); },
      onUpdate: () => { throw new Error('UI boom'); },
      onSettled: () => { throw new Error('UI boom'); },
    });
    assert.equal(started.accepted, true);
    const result = await started.done;
    assert.equal(result.status, 'completed');
    assert.equal(paper.analyses.abstract.text, '结果');

    const next = generation.startSection(paper, 'abstract');
    assert.equal(next.accepted, true);
    await next.done;
  } finally {
    restore();
  }
});

test('批量 hook 抛错不中断编排：done 正常 resolve', async () => {
  const restore = muteConsoleError();
  try {
    papers.init(memoryStore());
    initDeps(streamingChat(['结果']).chat);
    const paper = paperFixture();

    const started = generation.startBatch(paper, {
      onSectionStart: () => { throw new Error('UI boom'); },
      onSectionSettled: () => { throw new Error('UI boom'); },
    });
    assert.equal(started.accepted, true);
    const result = await started.done;
    assert.equal(result.status, 'completed');
    assert.equal(paper.analyses.abstract.text, '结果');
  } finally {
    restore();
  }
});

test('中断部分结果落库失败：done 仍 resolve，任务按 cancelled 收尾且不占用互斥位', async () => {
  const restore = muteConsoleError();
  try {
    const store = memoryStore();
    papers.init({ ...store, async put() { throw new Error('IndexedDB 不可用'); } });
    const { chat } = hangingChat(['x'.repeat(61)]);
    initDeps(chat);
    const paper = paperFixture();

    const started = generation.startSection(paper, 'abstract');
    started.task.cancel();
    const result = await started.done;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.saved, null);
    const next = generation.startSection(paper, 'abstract');
    assert.equal(next.accepted, true);
    next.task.cancel();
    await next.done;
  } finally {
    restore();
  }
});
