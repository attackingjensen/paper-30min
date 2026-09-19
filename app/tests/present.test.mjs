// present.js 的行为测试（#72 缝二）：假 tasks.list@1 快照 + 会话登记驱动任务中心呈现模型、
// 书库卡片建图状态分支、导出笔记内容组装。先例：model.test.mjs 的假快照形状。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTES_FORMAT_NOTE,
  buildMapStageFlow,
  convertTimingRows,
  deepDiveRunState,
  deepDiveSectionFlow,
  deepDiveStatusLine,
  libraryMapState,
  notesMarkdown,
  roundProgressView,
  warningText,
  roundStartView,
  roundView,
  synthesizeRunState,
  taskDetailModel,
  taskKindLabel,
  toolStepView,
} from '../ui/js/present.js';

// ---------------- 夹具 ----------------

/** tasks.list@1 快照条目形状（camelCase，与 Rust TaskSnapshot serde 一致）。 */
function taskSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    kind: 'paper.build-map@1',
    status: 'running',
    createdAt: '2026-09-12T01:00:00Z',
    updatedAt: '2026-09-12T01:00:01Z',
    ...overrides,
  };
}

const MAPPED = {
  sections: [
    { id: 'abs', role: 'abstract', title: 'Abstract', pageStart: 1, pageEnd: 1 },
    { id: 'sec_1', role: 'body', title: 'Introduction', pageStart: 1, pageEnd: 3 },
    { id: 'sec_2', role: 'body', title: 'Method', pageStart: 3, pageEnd: 7 },
    { id: 'refs', role: 'references', title: 'References', pageStart: 8, pageEnd: 9 },
  ],
  figures: [],
  tables: [],
};

function paperFixture(overrides = {}) {
  return {
    id: 'p1',
    title: 'Test Paper',
    addedAt: Date.parse('2026-09-01T08:00:00Z'),
    rating: 4,
    categories: ['LLM'],
    tags: ['agent'],
    parts: [
      { id: 'part-1', title: 'Introduction', semanticType: 'introduction' },
      { id: 'part-2', title: 'Method', semanticType: 'method' },
    ],
    readMarks: {},
    products: [],
    analyses: {},
    ...overrides,
  };
}

// ---------------- 书库卡片建图状态 ----------------

test('书库卡片：未建图 = 状态点', () => {
  assert.deepEqual(libraryMapState({ mapped: false, mapping: false }), { tone: 'idle', text: '未建图' });
});

test('书库卡片：建图中 = 阶段进度（无阶段事件时退化为纯状态）', () => {
  assert.deepEqual(
    libraryMapState({ mapping: true, mappingStage: 'map-l2' }),
    { tone: 'running', text: '建图中 · 生成节薄摘要（L2）' },
  );
  assert.deepEqual(libraryMapState({ mapping: true }), { tone: 'running', text: '建图中' });
  assert.deepEqual(
    libraryMapState({ mapping: true, mappingStage: 'map-l2', mappingProgress: { done: 2, total: 5 } }),
    { tone: 'running', text: '建图中 · 薄摘要 2/4' },
  );
});

test('书库卡片：已建图 = 标记进度 n/N', () => {
  assert.deepEqual(
    libraryMapState({ mapped: true, done: 3, total: 8 }),
    { tone: 'done', text: '已建图 · 已读完 3/8' },
  );
});

// ---------------- 建图阶段流 ----------------

test('建图阶段流：map-l2 进行中用进度 n/N，preflight 已完成、map-l1 未到达', () => {
  const flow = buildMapStageFlow({ stage: 'map-l2', shard: 2, shards: 4 }, 'running', { done: 2, total: 5 });
  assert.deepEqual(flow, [
    { key: 'preflight', label: '预渲染校验', state: 'done' },
    { key: 'map-l2', label: '生成节薄摘要（L2） · 2/4', state: 'current' },
    { key: 'map-l1', label: '合成阅读地图（L1）', state: 'todo' },
  ]);
});

test('建图阶段流：succeeded 不显示；failed 标记当前阶段；无阶段事件不显示', () => {
  assert.equal(buildMapStageFlow({ stage: 'map-l1' }, 'succeeded'), null);
  assert.equal(buildMapStageFlow(null, 'running'), null);
  const flow = buildMapStageFlow({ stage: 'preflight' }, 'failed');
  assert.deepEqual(flow.map(item => item.state), ['failed', 'todo', 'todo']);
});

// ---------------- 工具步骤流 ----------------

test('工具步骤：四种工具的目标与结果摘要', () => {
  assert.equal(
    toolStepView({ step: 1, name: 'read_section', args: { sec_id: 'sec_2', offset: 12 }, ok: true, result: { blocks: 8, total: 45, truncated: true } }).text,
    '第 1 步 · read_section(sec_2 自第 12 块) → 8/45 块 · 余量见页图',
  );
  assert.equal(
    toolStepView({ step: 2, name: 'search_paper', args: { pattern: 'attention' }, ok: true, result: { hits: 5, truncated: false } }).text,
    '第 2 步 · search_paper(「attention」) → 5 处命中',
  );
  assert.equal(
    toolStepView({ step: 3, name: 'get_figure', args: { fig_id: 'fig_3' }, ok: true, result: { page: 5, cropAssetId: 'a' } }).text,
    '第 3 步 · get_figure(fig_3) → p5 裁切图',
  );
  assert.equal(
    toolStepView({ step: 4, name: 'get_page_image', args: { page: 5 }, ok: true, result: { page: 5, assetId: 'a' } }).text,
    '第 4 步 · get_page_image(p5) → p5 页图',
  );
});

test('工具步骤：失败步带错误码', () => {
  const view = toolStepView({ step: 2, name: 'get_figure', args: { fig_id: 'fig_9' }, ok: false, error: { code: 'invalid_ref' } });
  assert.equal(view.ok, false);
  assert.equal(view.text, '第 2 步 · get_figure(fig_9) ✕ invalid_ref');
});

// ---------------- 任务中心呈现模型 ----------------

test('任务中心：建图任务呈现阶段流', () => {
  const task = taskSnapshot({ kind: 'paper.build-map@1' });
  const meta = { input: { paperId: 'p1' }, stageDetail: { stage: 'map-l1' } };
  const model = taskDetailModel({ task, meta });
  assert.deepEqual(model.stageFlow.map(item => item.state), ['done', 'done', 'current']);
  assert.equal(model.steps, undefined);
});

test('任务中心：建图 L2 按 secId 显示排队 / 生成中 / 完成 / 失败', () => {
  const task = taskSnapshot({
    kind: 'paper.build-map@1',
    status: 'failed',
    progress: { done: 1, total: 4 },
    error: { code: 'protocol_shard_failed', details: { failedSections: [{ secId: 'sec_2', code: 'protocol_parse_failed' }] } },
    details: [
      { event: 'stage', detail: { stage: 'map-l2', shards: 3, sections: ['sec_1', 'sec_2', 'sec_3'] } },
      { event: 'stage', detail: { stage: 'map-l2', shard: 1, shards: 3, secId: 'sec_1', shardStatus: 'done' } },
      { event: 'stage', detail: { stage: 'map-l2', shard: 2, shards: 3, secId: 'sec_2', shardStatus: 'failed' } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.deepEqual(model.shardFlow.map(item => item.state), ['done', 'failed', 'queued']);
  assert.equal(model.shardFlow[0].label, 'sec_1 · 完成');
  assert.equal(model.shardFlow[1].label, 'sec_2 · 失败');
  assert.equal(model.shardFlow[2].label, 'sec_3 · 排队');
  assert.equal(
    taskDetailModel({ task: { ...task, status: 'succeeded' }, meta: null }).shardFlow,
    undefined,
  );
});

test('任务中心：批量深挖呈现逐节子进度与工具步骤流', () => {
  const task = taskSnapshot({ kind: 'paper.deep-dive@1', progress: { done: 1, total: 3 } });
  const meta = {
    input: { paperId: 'p1', partIds: ['part-1', 'part-2', 'part-3'] },
    lastDetail: { stage: 'deep-dive', partId: 'part-2', secId: 'sec_2', title: 'Method', index: 2, total: 3 },
    steps: [
      { step: 1, partId: 'part-1', secId: 'sec_1', name: 'search_paper', args: { pattern: 'x' }, ok: true, result: { hits: 2 } },
      { step: 2, partId: 'part-2', secId: 'sec_2', name: 'get_figure', args: { fig_id: 'fig_3' }, ok: false, error: { code: 'invalid_ref' } },
    ],
  };
  const model = taskDetailModel({ task, meta });
  assert.deepEqual(model.subProgress, { index: 2, total: 3, title: 'Method' });
  assert.equal(model.stepsTotal, 2);
  assert.equal(model.steps.length, 2);
  assert.equal(model.steps[1].ok, false);
});

test('任务中心：单节深挖不呈现逐节子进度（1/1 是噪音）', () => {
  const task = taskSnapshot({ kind: 'paper.deep-dive@1' });
  const meta = {
    input: { paperId: 'p1', partIds: ['part-1'] },
    lastDetail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 1, title: 'Introduction' },
    steps: [{ step: 1, name: 'get_page_image', args: { page: 3 }, ok: true, result: { page: 3 } }],
  };
  const model = taskDetailModel({ task, meta });
  assert.equal(model.subProgress, undefined);
  assert.equal(model.stepsTotal, 1);
});

// ---------------- #83：批量深挖有界并发（按节分组） ----------------

const QUEUED_3 = {
  stage: 'deep-dive-queued',
  total: 3,
  targets: [
    { partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1 },
    { partId: 'part-2', secId: 'sec_2', title: 'Method', index: 2 },
    { partId: 'part-3', secId: 'sec_3', title: 'Experiments', index: 3 },
  ],
};

test('任务中心：批量深挖按节分组状态流（排队 / 第 n 轮 / 完成）', () => {
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'running',
    progress: { done: 1, total: 3 },
    details: [
      { event: 'stage', detail: QUEUED_3 },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1, total: 3 } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-2', secId: 'sec_2', title: 'Method', index: 2, total: 3 } },
      { event: 'round-start', detail: { partId: 'part-2', round: 2, stage: 'deep-dive' } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1, total: 3, sectionStatus: 'done' } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.equal(model.subProgress, undefined, '有 queued 事件时不再用逐节子进度');
  const flow = model.sectionFlow;
  assert.deepEqual(flow.map(item => item.state), ['done', 'current', 'queued']);
  assert.equal(flow[0].label, '1. Introduction · 完成');
  assert.equal(flow[1].label, '2. Method · 第 2 轮');
  assert.equal(flow[2].label, '3. Experiments · 排队');
});

test('任务中心：批量深挖失败节标红（sectionStatus 与 failedSections 双通道）', () => {
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'failed',
    error: { code: 'protocol_deep_dive_failed', details: { failedSections: [{ partId: 'part-2', code: 'step_limit_exceeded' }] } },
    details: [
      { event: 'stage', detail: { stage: 'deep-dive-queued', total: 2, targets: [
        { partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1 },
        { partId: 'part-2', secId: 'sec_2', title: 'Method', index: 2 },
      ] } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 2 } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 2, sectionStatus: 'done' } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-2', index: 2, total: 2 } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.deepEqual(model.sectionFlow.map(item => item.state), ['done', 'failed']);
  assert.equal(model.sectionFlow[1].label, '2. Method · 失败');
});

test('任务中心：deepDiveSectionFlow 在成功终态与无 queued 事件时回退', () => {
  assert.equal(deepDiveSectionFlow({ details: [{ event: 'stage', detail: QUEUED_3 }], status: 'succeeded' }), null);
  assert.equal(deepDiveSectionFlow({ details: [], status: 'running' }), null);
  assert.equal(deepDiveSectionFlow({}), null);
});

test('任务中心：批量深挖轨迹按节分栏', () => {
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'running',
    details: [
      { event: 'stage', detail: QUEUED_3 },
      { event: 'round', detail: { partId: 'part-1', round: 1, ttftMs: 100, elapsedMs: 200 } },
      { event: 'tool', detail: { partId: 'part-2', step: 1, name: 'get_figure', args: { fig_id: 'fig_1' }, ok: true, result: { page: 2 } } },
      { event: 'tool', detail: { partId: 'part-1', step: 1, name: 'read_section', args: { sec_id: 'sec_1' }, ok: true, result: { blocks: 3, total: 3 } } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.equal(model.trace, undefined, '批量不再平铺');
  assert.equal(model.sectionTraces.length, 2, 'part-3 无轨迹不出栏');
  assert.equal(model.sectionTraces[0].title, 'Introduction');
  assert.deepEqual(model.sectionTraces[0].items.map(item => item.kind), ['round', 'tool']);
  assert.equal(model.sectionTraces[0].toolCount, 1);
  assert.equal(model.sectionTraces[1].title, 'Method');
  assert.equal(model.sectionTraces[1].items[0].text, '第 1 步 · get_figure(fig_1) → p2 裁切图');
});

test('任务中心：单节深挖带 queued 事件时不呈现状态流、轨迹平铺', () => {
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'running',
    details: [
      { event: 'stage', detail: { stage: 'deep-dive-queued', total: 1, targets: [{ partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1 }] } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1, total: 1 } },
      { event: 'round', detail: { partId: 'part-1', round: 1, ttftMs: 100, elapsedMs: 200 } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.equal(model.subProgress, undefined);
  assert.equal(model.sectionFlow, undefined, '单节一行状态流是噪音，不呈现');
  assert.equal(model.sectionTraces, undefined, '单节不分栏');
  assert.equal(model.trace.length, 1);
});

test('任务中心：批量深挖成功终态不回落逐节子进度，轨迹仍按节分栏', () => {
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'succeeded',
    progress: { done: 2, total: 2 },
    details: [
      { event: 'stage', detail: { stage: 'deep-dive-queued', total: 2, targets: [
        { partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1 },
        { partId: 'part-2', secId: 'sec_2', title: 'Method', index: 2 },
      ] } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 2 } },
      { event: 'tool', detail: { partId: 'part-1', step: 1, name: 'read_section', args: { sec_id: 'sec_1' }, ok: true, result: { blocks: 3, total: 3 } } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 2, sectionStatus: 'done' } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-2', index: 2, total: 2 } },
      { event: 'round', detail: { partId: 'part-2', round: 1, ttftMs: 100, elapsedMs: 200 } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-2', index: 2, total: 2, sectionStatus: 'done' } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.equal(model.sectionFlow, undefined, '成功终态不显示状态流（与建图片流一致）');
  assert.equal(model.subProgress, undefined, '成功终态不回落到完成顺序的逐节子进度');
  assert.equal(model.sectionTraces.length, 2, '终态轨迹仍按节分栏');
  assert.equal(model.sectionTraces[0].title, 'Introduction');
  assert.equal(model.sectionTraces[1].title, 'Method');
});

test('任务中心：已取消的批量深挖在飞节标「已取消」，未开工节保持排队', () => {
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'cancelled',
    details: [
      { event: 'stage', detail: QUEUED_3 },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 3 } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 3, sectionStatus: 'done' } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-2', index: 2, total: 3 } },
    ],
  });
  const model = taskDetailModel({ task, meta: null });
  assert.deepEqual(model.sectionFlow.map(item => item.state), ['done', 'current', 'queued']);
  assert.equal(model.sectionFlow[1].label, '2. Method · 已取消');
  assert.equal(model.sectionFlow[2].label, '3. Experiments · 排队');
});

test('任务中心：综合为普通任务；会话登记缺失时降级为空模型', () => {
  assert.deepEqual(taskDetailModel({ task: taskSnapshot({ kind: 'paper.synthesize@1' }), meta: null }), {});
  assert.deepEqual(taskDetailModel({ task: taskSnapshot({ kind: 'model.chat@1' }), meta: null }), {});
  assert.deepEqual(taskDetailModel({ task: taskSnapshot({ kind: 'paper.build-map@1' }), meta: null }), {});
  assert.deepEqual(taskDetailModel({ task: taskSnapshot({ kind: 'paper.deep-dive@1' }), meta: null }), {});
});

test('任务中心：快照 details 日志优先于会话登记（订阅前事件不丢）', () => {
  // 快照携带完整 details：订阅建立前发出的阶段与首步也在（#72 走查实测缺陷的修复路径）。
  const task = taskSnapshot({
    kind: 'paper.deep-dive@1',
    details: [
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', secId: 'sec_1', title: 'Introduction', index: 1, total: 2 } },
      { event: 'tool', detail: { step: 1, partId: 'part-1', secId: 'sec_1', name: 'read_section', args: { sec_id: 'sec_1' }, ok: true, result: { blocks: 4, total: 4 } } },
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-2', secId: 'sec_2', title: 'Method', index: 2, total: 2 } },
      { event: 'tool', detail: { step: 2, partId: 'part-2', secId: 'sec_2', name: 'get_figure', args: { fig_id: 'fig_1' }, ok: true, result: { page: 2 } } },
    ],
  });
  // meta 为空也能完整呈现：子进度取最新 stage，步骤流取全部 tool。
  const model = taskDetailModel({ task, meta: null });
  assert.deepEqual(model.subProgress, { index: 2, total: 2, title: 'Method' });
  assert.equal(model.stepsTotal, 2);
  assert.equal(model.steps[0].text, '第 1 步 · read_section(sec_1) → 4/4 块');
  assert.equal(model.steps[1].text, '第 2 步 · get_figure(fig_1) → p2 裁切图');

  // 建图同理：快照 details 驱动阶段流
  const mapTask = taskSnapshot({
    kind: 'paper.build-map@1',
    details: [{ event: 'stage', detail: { stage: 'map-l2', shard: 1, shards: 2 } }],
  });
  const mapModel = taskDetailModel({ task: mapTask, meta: null });
  assert.deepEqual(mapModel.stageFlow.map(item => item.state), ['done', 'current', 'todo']);
});

test('任务中心：解析计时拆分与模型轮遥测行', () => {
  assert.deepEqual(
    convertTimingRows({
      startupMs: 1200,
      modelLoadMs: 3400,
      wallClockMs: 18000,
      timings: { layout: 5.2, table: 3.1, ocr: 0, other: 1.4 },
    }).map(row => row.key),
    ['startup', 'modelLoad', 'layout', 'table', 'ocr', 'other', 'total'],
  );
  assert.equal(
    convertTimingRows({
      timings: { page: 2, assemble: 0.5, readingOrder: 0.5, other: 1 },
    }).find(row => row.key === 'other').ms,
    4000,
  );
  const parseTask = taskSnapshot({
    kind: 'pdfparse.convert@1',
    status: 'succeeded',
    result: { startupMs: 800, timings: { layout: 2, table: 1 }, elapsedMs: 5000 },
  });
  const parseModel = taskDetailModel({ task: parseTask, meta: null });
  assert.equal(parseModel.timings[0].label, '启动');
  assert.equal(parseModel.timings.find(row => row.key === 'layout').ms, 2000);

  const round = roundView({
    round: 2,
    ttftMs: 400,
    elapsedMs: 2100,
    promptTokens: 800,
    completionTokens: 120,
    cachedTokens: 400,
    reasoningTokens: 90,
  });
  assert.equal(round.text, '第 2 轮 · 首字 0.4 s · 总 2.1 s · 输入 800 / 输出 120 · 缓存 400');
  assert.equal(round.reasoning, true);

  const thinkingRound = roundView({
    round: 1,
    ttftMs: 200,
    elapsedMs: 4000,
    reasoningMs: 1600,
  });
  assert.equal(thinkingRound.text, '第 1 轮 · 首字 0.2 s · 总 4.0 s · 思考 1.6 s');
  assert.equal(thinkingRound.reasoning, true);

  const mapTask = taskSnapshot({
    kind: 'paper.build-map@1',
    details: [
      { event: 'stage', detail: { stage: 'map-l2', shard: 1, shards: 1 } },
      { event: 'round', detail: { stage: 'map-l2', round: 1, ttftMs: 200, elapsedMs: 1000, receivedChars: 12 } },
    ],
  });
  const mapModelWithRound = taskDetailModel({ task: mapTask, meta: null });
  assert.equal(mapModelWithRound.trace.length, 1);
  assert.equal(mapModelWithRound.trace[0].kind, 'round');
  assert.equal(mapModelWithRound.trace[0].reasoning, false);
  assert.match(mapModelWithRound.trace[0].text, /第 1 轮/);

  const diveTask = taskSnapshot({
    kind: 'paper.deep-dive@1',
    details: [
      { event: 'round', detail: { stage: 'deep-dive', partId: 'part-1', round: 1, ttftMs: 200, elapsedMs: 800, receivedChars: 40 } },
      { event: 'tool', detail: { step: 1, name: 'get_figure', args: { fig_id: 'fig_1' }, ok: true, result: { page: 2 } } },
      { event: 'round', detail: { stage: 'deep-dive', partId: 'part-1', round: 2, ttftMs: 150, elapsedMs: 900, receivedChars: 80 } },
    ],
  });
  const diveTrace = taskDetailModel({ task: diveTask, meta: null }).trace.map(item => item.kind);
  assert.deepEqual(diveTrace, ['round', 'tool', 'round']);
});

// ---------------- 导出笔记 ----------------

test('导出笔记：协议产物为正源，旧结果进只读附录，格式说明随行', () => {
  const paper = paperFixture({
    readMarks: { abstract: 1 },
    products: [
      {
        kind: 'map', partId: '', body: {
          problem: { text: '如何高效读论文', refs: ['(L12-18)'] },
          method: { text: '三层阅读协议', refs: [] },
          contributions: [{ text: '提出地图+深挖流程', refs: ['(p3)'] }],
          keyEvidence: [{ assetId: 'fig_3', note: '准确率提升', refs: ['(sec_2:L30-34)'] }],
          glossary: [{ term: 'L2', defRef: '(L40-41)' }],
        },
      },
      { kind: 'l2', partId: 'abstract', body: { gist: '本文提出三层协议。', points: [{ text: '要点一', refs: ['(L1-2)'] }], keyAssets: ['fig_3'], pages: { start: 1, end: 1 } } },
      { kind: 'l2', partId: 'part-2', body: { gist: '方法节摘要。', points: [], keyAssets: [], pages: { start: 3, end: 7 } } },
      { kind: 'dig', partId: 'part-1', body: '## 核心论点\n论点甲 (L12-18)' },
      { kind: 'retell', partId: '', body: '## 问题\n问题复述' },
    ],
    analyses: { 'part-2': { text: '旧方法精读结果', updatedAt: Date.parse('2026-08-01T00:00:00Z') } },
  });
  const md = notesMarkdown({ paper, mapped: MAPPED, now: Date.parse('2026-09-12T10:00:00Z') });

  assert.match(md, /^# 精读笔记：Test Paper/m);
  assert.match(md, /导入日期：2026-09-01 · 导出日期：2026-09-12 · 评分：★★★★☆ · 分类：LLM · 标签：agent/);
  assert.ok(md.includes(NOTES_FORMAT_NOTE));

  // L1 五区块，出处原样保留
  assert.match(md, /## 阅读地图（L1）/);
  assert.match(md, /### 要解决的问题\n\n如何高效读论文 \(L12-18\)/);
  assert.match(md, /- 提出地图\+深挖流程 \(p3\)/);
  assert.match(md, /- \(fig_3\) 准确率提升 \(sec_2:L30-34\)/);
  assert.match(md, /- L2（定义见 \(L40-41\)）/);

  // 复述稿
  assert.match(md, /## 复述稿（综合）\n\n## 问题\n问题复述/);

  // 节区按 L2 节顺序（abstract → Introduction → Method），用块模型节标题
  const sectionIdx = md.indexOf('## 节薄摘要与深挖');
  const absIdx = md.indexOf('### Abstract');
  const introIdx = md.indexOf('### Introduction');
  const methodIdx = md.indexOf('### Method');
  assert.ok(sectionIdx !== -1 && absIdx > sectionIdx && introIdx > absIdx && methodIdx > introIdx);
  assert.match(md, /\*\*薄摘要\*\*：本文提出三层协议。\n\n- 要点一 \(L1-2\)/);
  assert.match(md, /关键图表：fig_3 · 页码：p1–p1/);
  assert.match(md, /\*\*深挖结果\*\*：\n\n## 核心论点\n论点甲 \(L12-18\)/);

  // 附录：旧结果只读、带更新时间；正文区不含旧结果文本
  assert.match(md, /## 附录：旧精读结果（只读）/);
  assert.match(md, /### 第 2 部分 · Method（更新于 2026-08-01）\n\n旧方法精读结果/);
  assert.ok(md.indexOf('旧方法精读结果') > md.indexOf('## 附录'));
});

test('导出笔记：未建图论文主体给提示行，旧结果仍入附录；无产物无附录时不空转', () => {
  const legacyOnly = paperFixture({ analyses: { abstract: { text: '旧摘要精读', updatedAt: Date.parse('2026-08-02T00:00:00Z') } } });
  const md = notesMarkdown({ paper: legacyOnly, mapped: null, now: Date.parse('2026-09-12T10:00:00Z') });
  assert.ok(md.includes('（本论文尚未建图，暂无协议产物'));
  assert.ok(!md.includes('## 阅读地图'));
  assert.ok(!md.includes('## 节薄摘要与深挖'));
  assert.match(md, /## 附录：旧精读结果（只读）[\s\S]*### Abstract · 摘要（更新于 2026-08-02）\n\n旧摘要精读/);

  const empty = notesMarkdown({ paper: paperFixture(), mapped: null, now: Date.parse('2026-09-12T10:00:00Z') });
  assert.ok(empty.includes('（本论文尚未建图'));
  assert.ok(!empty.includes('## 附录'));
  assert.ok(!empty.includes('## 回想卡片'));
});

test('任务类型标签：prerender 按 scope 区分页图 / 图表 / 默认', () => {
  assert.equal(taskKindLabel('pdfassets.prerender@1', { scope: 'pages' }), '预渲染页图');
  assert.equal(taskKindLabel('pdfassets.prerender@1', { scope: 'crops' }), '预渲染图表');
  assert.equal(taskKindLabel('pdfassets.prerender@1', { scope: 'all' }), '预渲染');
  assert.equal(taskKindLabel('pdfassets.prerender@1'), '预渲染');
  assert.equal(taskKindLabel('pdfparse.convert@1'), '解析 PDF');
});

test('导出笔记：无块模型时按精读部分顺序与标签组织节区；回想卡片保留', () => {
  const paper = paperFixture({
    recallCard: { markdown: '一句话回忆' },
    products: [
      { kind: 'l2', partId: 'part-2', body: { gist: '只有方法节有摘要。', points: [], keyAssets: [], pages: { start: 3, end: 7 } } },
    ],
  });
  const md = notesMarkdown({ paper, mapped: null, now: Date.parse('2026-09-12T10:00:00Z') });
  assert.match(md, /## 回想卡片\n\n一句话回忆/);
  assert.match(md, /### 第 2 部分 · Method\n\n\*\*薄摘要\*\*：只有方法节有摘要。/);
  // part-1 无产物不列
  assert.ok(!md.includes('### 第 1 部分'));
});

// ---------------- #80：任务事件 → 节页/地图页运行态归约 ----------------

const DD_EVENTS = [
  { event: 'round-start', detail: { stage: 'deep-dive', partId: 'part-1', round: 1, contextTokensEstimated: 9000 } },
  { event: 'tool', detail: { step: 1, partId: 'part-1', secId: 'sec_2', name: 'read_section', args: { sec_id: 'sec_3' }, ok: true } },
  { event: 'round', detail: { stage: 'deep-dive', partId: 'part-1', round: 1, receivedChars: 120 } },
];

test('深挖运行态：round-start 开轮、tool 记当前工具、round 记上轮字数', () => {
  const state = deepDiveRunState(DD_EVENTS, 'part-1', 'running');
  assert.equal(state.round, 1);
  assert.equal(state.currentTool?.name, 'read_section');
  assert.deepEqual(state.currentTool?.args, { sec_id: 'sec_3' });
  assert.equal(state.receivedChars, 120);
  assert.equal(state.previewText, null);
});

test('深挖运行态：新一轮重置工具与字数，preview 推进预览正文与字数', () => {
  const state = deepDiveRunState([
    ...DD_EVENTS,
    { event: 'round-start', detail: { stage: 'deep-dive', partId: 'part-1', round: 2, contextTokensEstimated: 9500 } },
    { event: 'preview', detail: { stage: 'deep-dive', partId: 'part-1', text: '## 核心论点\n甲' } },
    { event: 'preview', detail: { stage: 'deep-dive', partId: 'part-1', text: '## 核心论点\n甲乙' } },
  ], 'part-1', 'running');
  assert.equal(state.round, 2);
  assert.equal(state.currentTool, null, '新一轮清空工具态');
  assert.equal(state.previewText, '## 核心论点\n甲乙');
  assert.equal(state.receivedChars, '## 核心论点\n甲乙'.length);
});

test('深挖运行态：preview text:null 清空预览', () => {
  const state = deepDiveRunState([
    { event: 'round-start', detail: { partId: 'part-1', round: 1 } },
    { event: 'preview', detail: { partId: 'part-1', text: '## 核心论点\n甲' } },
    { event: 'preview', detail: { partId: 'part-1', text: null } },
  ], 'part-1', 'running');
  assert.equal(state.previewText, null);
});

test('深挖运行态：批量时忽略其他节的事件', () => {
  const state = deepDiveRunState([
    { event: 'round-start', detail: { partId: 'part-1', round: 1 } },
    { event: 'round-start', detail: { partId: 'part-2', round: 3 } },
    { event: 'preview', detail: { partId: 'part-2', text: '## 核心论点\n别节' } },
    { event: 'tool', detail: { partId: 'part-2', name: 'get_figure', args: { fig_id: 'fig_1' } } },
  ], 'part-1', 'running');
  assert.equal(state.round, 1);
  assert.equal(state.currentTool, null);
  assert.equal(state.previewText, null);
});

test('深挖运行态：乱序 round-start 回退被忽略，重复事件幂等', () => {
  const state = deepDiveRunState([
    { event: 'round-start', detail: { partId: 'part-1', round: 2 } },
    { event: 'preview', detail: { partId: 'part-1', text: '## 核心论点\n甲' } },
    { event: 'round-start', detail: { partId: 'part-1', round: 1 } },
    { event: 'preview', detail: { partId: 'part-1', text: '## 核心论点\n甲' } },
  ], 'part-1', 'running');
  assert.equal(state.round, 2);
  assert.equal(state.previewText, '## 核心论点\n甲');
});

test('深挖运行态：任务终态清理；无事件为 null', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    assert.equal(deepDiveRunState(DD_EVENTS, 'part-1', status), null, status);
  }
  assert.equal(deepDiveRunState([], 'part-1', 'running'), null);
  assert.equal(deepDiveRunState(null, 'part-1', 'running'), null);
});

test('深挖状态行：第 n 轮 · 正在调用工具 · 已收到 x 字', () => {
  assert.equal(deepDiveStatusLine(null), '');
  assert.equal(deepDiveStatusLine({ round: 1 }), '第 1 轮');
  assert.equal(
    deepDiveStatusLine({ round: 2, currentTool: { name: 'read_section', args: { sec_id: 'sec_3' } } }),
    '第 2 轮 · 正在调用 read_section(sec_3)',
  );
  assert.equal(deepDiveStatusLine({ round: 2, receivedChars: 1234 }), '第 2 轮 · 已收到 1234 字');
  assert.equal(
    deepDiveStatusLine({ round: 3, currentTool: { name: 'get_figure', args: { fig_id: 'fig_1' } }, receivedChars: 56 }),
    '第 3 轮 · 正在调用 get_figure(fig_1) · 已收到 56 字',
  );
});

test('复述稿运行态：preview 推进、null 清空、终态清理', () => {
  const events = [
    { event: 'preview', detail: { stage: 'synthesize', text: '## 问题\n甲' } },
    { event: 'preview', detail: { stage: 'synthesize', text: '## 问题\n甲乙' } },
  ];
  const state = synthesizeRunState(events, 'running');
  assert.equal(state.previewText, '## 问题\n甲乙');
  assert.equal(state.receivedChars, '## 问题\n甲乙'.length);
  const cleared = synthesizeRunState([...events, { event: 'preview', detail: { stage: 'synthesize', text: null } }], 'running');
  assert.equal(cleared.previewText, null);
  assert.equal(synthesizeRunState(events, 'succeeded'), null);
  assert.equal(synthesizeRunState(events, 'failed'), null);
});

test('任务中心摘要行：round-start / round-progress 摘要', () => {
  assert.equal(
    roundStartView({ round: 3, contextTokensEstimated: 12000 }).text,
    '第 3 轮开始 · 上下文约 12000 token',
  );
  assert.equal(roundStartView({ round: 1 }).text, '第 1 轮开始');
  assert.equal(
    roundProgressView({ stage: 'map-l2', shard: 2, receivedChars: 3456, elapsedMs: 12300 }).text,
    '分片 2 · 已收到 3456 字 · 12.3 s',
  );
  assert.equal(roundProgressView({ stage: 'map-l1', receivedChars: 100, elapsedMs: 500 }).text, '已收到 100 字 · 0.5 s');
});

test('任务中心：liveLine 取最新 round-start / round-progress，成功终态不显示', () => {
  const dd = taskSnapshot({
    kind: 'paper.deep-dive@1',
    details: [
      { event: 'stage', detail: { stage: 'deep-dive', partId: 'part-1', index: 1, total: 1 } },
      { event: 'round-start', detail: { stage: 'deep-dive', partId: 'part-1', round: 1, contextTokensEstimated: 9000 } },
      { event: 'tool', detail: { step: 1, partId: 'part-1', name: 'read_section', args: { sec_id: 'sec_3' }, ok: true } },
      { event: 'round-start', detail: { stage: 'deep-dive', partId: 'part-1', round: 2, contextTokensEstimated: 9800 } },
    ],
  });
  assert.equal(taskDetailModel({ task: dd }).liveLine, '第 2 轮开始 · 上下文约 9800 token');

  const bm = taskSnapshot({
    details: [
      { event: 'stage', detail: { stage: 'map-l2', shard: 1, shards: 2, secId: 'sec_1', shardStatus: 'running' } },
      { event: 'round-progress', detail: { stage: 'map-l2', shard: 1, receivedChars: 800, elapsedMs: 2100 } },
      { event: 'round-progress', detail: { stage: 'map-l2', shard: 1, receivedChars: 1600, elapsedMs: 4200 } },
    ],
  });
  assert.equal(taskDetailModel({ task: bm }).liveLine, '分片 1 · 已收到 1600 字 · 4.2 s');

  const done = taskSnapshot({
    kind: 'paper.deep-dive@1',
    status: 'succeeded',
    details: [{ event: 'round-start', detail: { partId: 'part-1', round: 1 } }],
  });
  assert.equal(taskDetailModel({ task: done }).liveLine, undefined);
});

test('任务警示文案（#86）：卸参数与改名映射为可读提示，未知编码原文显示', () => {
  assert.equal(warningText('param_dropped:temperature'), '端点不支持 temperature，已自动去掉');
  assert.equal(
    warningText('param_renamed:max_tokens:max_completion_tokens'),
    '端点要求以 max_completion_tokens 传递长度上限，已自动改名（原 max_tokens）',
  );
  assert.equal(warningText('scanned_pages_ocr'), 'scanned_pages_ocr');
});
