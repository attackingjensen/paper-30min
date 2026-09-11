// app/ui/js/papers.js 的领域行为测试（Tauri 副本）。当前只覆盖与 #61 数据契约相关的
// 重新切分规则：已读完标记随其结果一并作废（规格 #51 决策 9）。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as papers from '../ui/js/papers.js';

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

function resplitFixture() {
  return {
    id: 'p1',
    title: 'T',
    addedAt: 1700000000000,
    updatedAt: 1700000000000,
    sections: { abstract: 'ABS', 'part-1': 'P1' },
    sectionPages: {},
    parts: [{ id: 'part-1', title: '旧章节', heading: '1. Old', semanticType: 'method' }],
    fullText: 'ABS P1',
    analyses: {
      abstract: { text: '摘要精读', updatedAt: 1700000010000 },
      'part-1': { text: '章节精读', updatedAt: 1700000020000 },
    },
    translations: {},
    readMarks: { abstract: 1700000010000, 'part-1': 1700000020000 },
    activityDays: [{ day: '2023-11-14', kind: 'import' }],
  };
}

function newSplit(abstractText) {
  return {
    title: 'T',
    sections: { abstract: abstractText, 'part-1': 'P1-new' },
    sectionPages: {},
    parts: [{ id: 'part-1', title: '新章节', heading: '1. New', semanticType: 'method' }],
    fullText: `${abstractText} P1-new`,
  };
}

test('applyResplit：摘要原文未变时保留摘要标记，其余标记随结果作废', async () => {
  papers.init(memoryStore());
  const paper = resplitFixture();
  await papers.applyResplit(paper, newSplit('ABS'));

  // 摘要结果与标记保留；part-1 结果与标记一并作废（不作齐新部分）
  assert.deepEqual(Object.keys(paper.analyses), ['abstract']);
  assert.deepEqual(paper.readMarks, { abstract: 1700000010000 });
  // 活动日是 append-only 历史事实，重新切分不回收
  assert.deepEqual(paper.activityDays, [{ day: '2023-11-14', kind: 'import' }]);
});

test('applyResplit：摘要原文变化时全部标记随结果作废', async () => {
  papers.init(memoryStore());
  const paper = resplitFixture();
  await papers.applyResplit(paper, newSplit('ABS-REWRITTEN'));

  assert.deepEqual(paper.analyses, {});
  assert.deepEqual(paper.readMarks, {});
});

test('整库导出信封携带 readMarks 与 activityDays（规格 #51 决策 14）', async () => {
  const store = memoryStore();
  papers.init(store);
  const paper = resplitFixture();
  await store.put(paper);

  const payload = JSON.parse(await papers.exportLibrary());
  const exported = payload.papers.find(item => item.id === 'p1');
  assert.deepEqual(exported.readMarks, { abstract: 1700000010000, 'part-1': 1700000020000 });
  assert.deepEqual(exported.activityDays, [{ day: '2023-11-14', kind: 'import' }]);
});

// ---------------- 进度派生（规格 #51 决策 6/7） ----------------

function progressFixture() {
  return {
    id: 'p1',
    title: 'T',
    sections: { abstract: 'ABS', 'part-1': 'P1', 'part-2': 'P2' },
    parts: [
      { id: 'part-1', title: '第一章', semanticType: 'method' },
      { id: 'part-2', title: '第二章', semanticType: 'part' },
    ],
    analyses: {},
    readMarks: {},
    activityDays: [],
  };
}

test('readingProgress：数据源是已读完标记而非精读结果（规格 #51 决策 6）', () => {
  const paper = progressFixture();
  // 有精读结果但无标记 → 进度不动
  paper.analyses = { abstract: { text: '精读', updatedAt: 1700000010000 } };
  assert.deepEqual(papers.readingProgress(paper), { done: 0, total: 3 });
  // 有标记但无精读结果 → 进度照计（看薄摘要就够的节也能计入）
  paper.analyses = {};
  paper.readMarks = { abstract: 1700000010000, 'part-1': 1700000020000 };
  assert.deepEqual(papers.readingProgress(paper), { done: 2, total: 3 });
  // 不属于当前精读部分的孤儿标记不计入
  paper.readMarks = { abstract: 1700000010000, 'part-9': 1700000030000 };
  assert.deepEqual(papers.readingProgress(paper), { done: 1, total: 3 });
});

test('isPaperRead：全部精读部分均有标记才是已读完（规格 #51 决策 7）', () => {
  const paper = progressFixture();
  assert.equal(papers.isPaperRead(paper), false);
  paper.readMarks = { abstract: 1, 'part-1': 2 };
  assert.equal(papers.isPaperRead(paper), false);
  paper.readMarks = { abstract: 1, 'part-1': 2, 'part-2': 3 };
  assert.equal(papers.isPaperRead(paper), true);
});

test('readingParts：parts 中与摘要同 id 或重复的条目只计一次（部分身份唯一）', () => {
  const paper = progressFixture();
  // 手工构造的浏览器导出可能把 abstract 写进 parts（迁移走查夹具即如此）
  paper.parts = [
    { id: 'abstract', title: '摘要', semanticType: 'abstract' },
    { id: 'part-1', title: '第一章', semanticType: 'method' },
    { id: 'part-1', title: '第一章重复', semanticType: 'method' },
    { id: 'part-2', title: '第二章', semanticType: 'part' },
  ];
  const defs = papers.readingParts(paper);
  assert.deepEqual(defs.map(def => def.id), ['abstract', 'part-1', 'part-2']);
  // 进度分母随之只计三个部分
  assert.deepEqual(papers.readingProgress(paper), { done: 0, total: 3 });
});

// ---------------- 四写入缝的活动日行生成（规格 #51 决策 5） ----------------

function parsedFixture() {
  return {
    title: 'T',
    numPages: 3,
    sections: { abstract: 'ABS', 'part-1': 'P1' },
    sectionPages: {},
    parts: [{ id: 'part-1', title: '第一章', heading: '1. One', semanticType: 'method' }],
    fullText: 'ABS P1',
  };
}

test('activityDayOf：输出 UTC 日历日 YYYY-MM-DD（与 v4 迁移回填同一口径）', () => {
  // 2023-11-14T22:13:20Z → 2023-11-14；22:00Z 之后仍属当日（UTC 日界，不随本地时区偏移）
  assert.equal(papers.activityDayOf(1700000000000), '2023-11-14');
  assert.equal(papers.activityDayOf(Date.parse('2026-09-11T16:00:00Z')), '2026-09-11');
  assert.match(papers.activityDayOf(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});

test('导入论文写入缝：createPdfPaper 生成当日 import 活动日', async () => {
  papers.init(memoryStore());
  const paper = await papers.createPdfPaper(parsedFixture(), { name: 'x.pdf' });
  assert.deepEqual(paper.activityDays, [{ day: papers.activityDayOf(Date.now()), kind: 'import' }]);
});

test('导入论文写入缝：createArxivPaper 生成当日 import 活动日', async () => {
  papers.init(memoryStore());
  const paper = await papers.createArxivPaper(parsedFixture(), '2401.00001', null);
  assert.deepEqual(paper.activityDays, [{ day: papers.activityDayOf(Date.now()), kind: 'import' }]);
});

test('精读结果写入缝：saveAnalysis 生成当日 analysis 活动日，同日幂等', async () => {
  const store = memoryStore();
  papers.init(store);
  const paper = await papers.createArxivPaper(parsedFixture(), '2401.00001', null);
  const today = papers.activityDayOf(Date.now());

  await papers.saveAnalysis(paper, 'abstract', '摘要精读');
  await papers.saveAnalysis(paper, 'part-1', '章节精读');
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'analysis' },
  ]);

  // 同日重读旧节再写结果：不重复增行（历史打卡不被改写）
  await papers.saveAnalysis(paper, 'abstract', '重读后的摘要精读');
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'analysis' },
  ]);
});

test('中断保留写入缝：saveAnalysis 带 partial 生成当日 partial 活动日，同日幂等', async () => {
  papers.init(memoryStore());
  const paper = await papers.createArxivPaper(parsedFixture(), '2401.00001', null);
  const today = papers.activityDayOf(Date.now());

  await papers.saveAnalysis(paper, 'abstract', '半截内容\n\n> ⚠️ 生成被中断，内容为部分结果。', { partial: true });
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'partial' },
  ]);

  // 同日再次中断保留：不重复增行
  await papers.saveAnalysis(paper, 'part-1', '另一段半截内容', { partial: true });
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'partial' },
  ]);
});

test('设置标记写入缝：setReadMark 落标记并生成当日 mark 活动日；撤销不写不回收', async () => {
  papers.init(memoryStore());
  const paper = await papers.createArxivPaper(parsedFixture(), '2401.00001', null);
  const today = papers.activityDayOf(Date.now());

  await papers.setReadMark(paper, 'part-1', true);
  assert.equal(typeof paper.readMarks['part-1'], 'number');
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'mark' },
  ]);

  // 同日重复设置幂等：标记保留首次 marked_at，活动日不重复增行
  const firstMarkedAt = paper.readMarks['part-1'];
  await papers.setReadMark(paper, 'part-1', true);
  assert.equal(paper.readMarks['part-1'], firstMarkedAt);
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'mark' },
  ]);

  // 撤销：标记消失，当日 mark 活动日不回收（打卡是历史事实），也不产生新行
  await papers.setReadMark(paper, 'part-1', false);
  assert.deepEqual(paper.readMarks, {});
  assert.deepEqual(paper.activityDays, [
    { day: today, kind: 'import' },
    { day: today, kind: 'mark' },
  ]);
});

// ---------------- 打卡派生（数据源 = 落库活动日） ----------------

test('setReadMark：落库失败时回滚内存变更（标记开关与脏快照隔离）', async () => {
  const failingStore = {
    async getAll() { return []; },
    async get() { return undefined; },
    async put() { throw new Error('磁盘写入失败'); },
    async delete() {},
  };
  papers.init(failingStore);
  const paper = { ...progressFixture(), activityDays: [{ day: '2020-01-01', kind: 'import' }] };
  const updatedAtBefore = paper.updatedAt;

  await assert.rejects(() => papers.setReadMark(paper, 'part-1', true), /磁盘写入失败/);
  // 标记与当日 mark 活动日都不留内存痕迹，updatedAt 也不推进
  assert.deepEqual(paper.readMarks, {});
  assert.deepEqual(paper.activityDays, [{ day: '2020-01-01', kind: 'import' }]);
  assert.equal(paper.updatedAt, updatedAtBefore);

  // 撤销失败同样回滚：预先放置的标记不丢
  paper.readMarks = { 'part-1': 1700000090000 };
  await assert.rejects(() => papers.setReadMark(paper, 'part-1', false), /磁盘写入失败/);
  assert.deepEqual(paper.readMarks, { 'part-1': 1700000090000 });
});

test('activityDays / streakDays：连续天数从落库活动日派生', async () => {
  papers.init(memoryStore());
  const today = papers.activityDayOf(Date.now());
  const yesterday = papers.activityDayOf(Date.now() - 24 * 3600 * 1000);

  const fresh = await papers.createArxivPaper(parsedFixture(), '2401.00001', null);
  assert.deepEqual(papers.activityDays(fresh), [today]);
  assert.equal(papers.streakDays([fresh]), 1);

  // 昨天也有活动 → 连续 2 天
  const veteran = { ...progressFixture(), activityDays: [{ day: yesterday, kind: 'mark' }] };
  assert.equal(papers.streakDays([fresh, veteran]), 2);

  // 只有前天以前的活动 → 连续中断归 0
  const stale = { ...progressFixture(), activityDays: [{ day: '2020-01-01', kind: 'mark' }] };
  assert.equal(papers.streakDays([stale]), 0);
});
