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
