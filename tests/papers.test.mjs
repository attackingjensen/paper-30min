import assert from 'node:assert/strict';
import test from 'node:test';
import * as papers from '../public/js/papers.js';

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

function parsedPdfFixture(overrides = {}) {
  return {
    title: 'Sample Paper',
    numPages: 2,
    sections: { abstract: 'Abs' },
    sectionPages: { abstract: { start: 1, end: 1 } },
    parts: [],
    fullText: 'Abs',
    ...overrides,
  };
}

test('createPdfPaper builds a full record and persists it', async () => {
  const store = memoryStore();
  papers.init(store);
  const file = { name: 'my-paper.pdf' };

  const paper = await papers.createPdfPaper(parsedPdfFixture(), file);

  assert.equal(store.records.size, 1);
  assert.equal(store.records.get(paper.id), paper);
  assert.equal(paper.title, 'Sample Paper');
  assert.equal(paper.pdfBlob, file);
  assert.equal(paper.pdfName, 'my-paper.pdf');
  assert.equal(paper.numPages, 2);
  assert.deepEqual(paper.analyses, {});
  assert.deepEqual(paper.translations, {});
  assert.deepEqual(paper.recallCard, { markdown: '', images: [], updatedAt: 0 });
  assert.equal(paper.rating, 0);
  assert.deepEqual(paper.categories, []);
  assert.deepEqual(paper.tags, []);
  assert.deepEqual(paper.chat, []);
  assert.equal(paper.addedAt, paper.updatedAt);
});

test('createPdfPaper falls back to the file name without extension as the title', async () => {
  papers.init(memoryStore());
  const paper = await papers.createPdfPaper(parsedPdfFixture({ title: '' }), { name: 'fallback.PDF' });
  assert.equal(paper.title, 'fallback');
});

test('createArxivPaper records arXiv identity and derives the PDF name', async () => {
  const store = memoryStore();
  papers.init(store);
  const parsed = { title: 'ArXiv Paper', sourceType: 'arxiv-html', sections: {}, parts: [], fullText: 'x' };

  const withPdf = await papers.createArxivPaper(parsed, '2401.12345', new Uint8Array([1]));
  assert.equal(withPdf.arxivId, '2401.12345');
  assert.equal(withPdf.sourceType, 'arxiv-html');
  assert.equal(withPdf.pdfName, '2401.12345.pdf');
  assert.equal(withPdf.numPages, 0);
  assert.ok(!('sectionPages' in withPdf));
  assert.equal(store.records.size, 1);

  const withoutPdf = await papers.createArxivPaper(parsed, '2401.99999', null);
  assert.equal(withoutPdf.pdfName, '');
  assert.equal(withoutPdf.pdfBlob, null);
});

test('listPapers returns records newest-first', async () => {
  const store = memoryStore();
  papers.init(store);
  store.records.set('old', { id: 'old', title: 'Old', addedAt: 1 });
  store.records.set('new', { id: 'new', title: 'New', addedAt: 2 });

  const list = await papers.listPapers();
  assert.deepEqual(list.map(paper => paper.id), ['new', 'old']);
});

test('readingParts falls back to the four fixed sections when a paper has no parts', () => {
  const defs = papers.readingParts({ parts: [] });
  assert.deepEqual(defs.map(def => def.id), ['abstract', 'introduction', 'method', 'experiments']);
  assert.deepEqual(defs.map(def => def.skillId), ['abstract', 'introduction', 'method', 'experiments']);
});

test('readingParts projects abstract plus actual sections in order', () => {
  const paper = {
    parts: [
      { id: 'part-1', title: 'Intro', heading: '1 Intro', semanticType: 'introduction' },
      { id: 'part-2', title: '', heading: '2 System', semanticType: 'system' },
      { id: 'part-3', title: 'Exps', heading: '3 Exps', semanticType: 'experiments' },
    ],
  };
  const defs = papers.readingParts(paper);
  assert.deepEqual(defs.map(def => def.id), ['abstract', 'part-1', 'part-2', 'part-3']);
  assert.deepEqual(defs.map(def => def.skillId), ['abstract', 'introduction', 'part', 'experiments']);
  assert.equal(defs[1].label, '第 1 部分 · Intro');
  assert.equal(defs[2].pickerLabel, '第 2 部分');
  assert.equal(defs[2].hint, '论文正文第 2 部分 · 通用章节精读');
});

test('readingProgress is derived from analyses and counts partial results', () => {
  const paper = {
    parts: [
      { id: 'part-1', title: 'A', semanticType: 'method' },
      { id: 'part-2', title: 'B', semanticType: 'experiments' },
    ],
    analyses: {
      abstract: { text: '译文', updatedAt: 1 },
      'part-1': { text: '部分结果\n\n> ⚠️ 生成被中断，内容为部分结果。', updatedAt: 2 },
    },
  };
  assert.deepEqual(papers.readingProgress(paper), { done: 2, total: 3 });
});

test('readingProgress counts the four fallback sections for part-less papers', () => {
  assert.deepEqual(papers.readingProgress({}), { done: 0, total: 4 });
});

async function storedPaper() {
  const store = memoryStore();
  papers.init(store);
  return papers.createPdfPaper(parsedPdfFixture(), { name: 'p.pdf' });
}

test('saveAnalysis writes the result, bumps updatedAt and persists', async () => {
  const paper = await storedPaper();
  paper.updatedAt = 0;

  await papers.saveAnalysis(paper, 'part-1', '精读内容');

  assert.deepEqual(paper.analyses['part-1'], { text: '精读内容', updatedAt: paper.analyses['part-1'].updatedAt });
  assert.ok(paper.analyses['part-1'].updatedAt > 0);
  assert.ok(paper.updatedAt > 0);
});

test('saveSectionSource stores the pasted source text', async () => {
  const paper = await storedPaper();
  await papers.saveSectionSource(paper, 'part-2', 'pasted text');
  assert.equal(paper.sections['part-2'], 'pasted text');
  assert.equal(paper.sections.abstract, 'Abs');
});

test('saveTranslation stores under the section:language key', async () => {
  const paper = await storedPaper();
  assert.equal(papers.translationKey('__full', 'zh'), '__full:zh');

  await papers.saveTranslation(paper, 'abstract', 'zh', '译文', 'Abs');

  const saved = paper.translations['abstract:zh'];
  assert.equal(saved.text, '译文');
  assert.equal(saved.source, 'Abs');
  assert.ok(saved.updatedAt > 0);
});

test('saveRecallCard replaces the whole card', async () => {
  const paper = await storedPaper();
  const images = [{ id: 'img-1', name: 'a.png', dataUrl: 'data:' }];

  await papers.saveRecallCard(paper, '卡片正文', images);

  assert.deepEqual(paper.recallCard.markdown, '卡片正文');
  assert.equal(paper.recallCard.images, images);
  assert.ok(paper.recallCard.updatedAt > 0);
});

test('removeRecallImage keeps the markdown and drops only the target image', async () => {
  const paper = await storedPaper();
  await papers.saveRecallCard(paper, '正文', [
    { id: 'img-1', name: 'a.png', dataUrl: 'data:1' },
    { id: 'img-2', name: 'b.png', dataUrl: 'data:2' },
  ]);

  await papers.removeRecallImage(paper, 'img-1');

  assert.equal(paper.recallCard.markdown, '正文');
  assert.deepEqual(paper.recallCard.images.map(image => image.id), ['img-2']);
});

test('appendChatMessage persists every message and keeps the newest 40', async () => {
  const paper = await storedPaper();
  for (let i = 0; i < 42; i++) {
    await papers.appendChatMessage(paper, { role: 'user', content: `m${i}` });
  }
  assert.equal(paper.chat.length, 40);
  assert.equal(paper.chat[0].content, 'm2');
  assert.equal(paper.chat[39].content, 'm41');
});

test('saveOrganize clamps nothing but cleans tokens case-insensitively', async () => {
  const paper = await storedPaper();

  await papers.saveOrganize(paper, {
    rating: 4,
    categories: ['  LLM ', 'llm', 'Agent'],
    tags: ['x y', '  x   y  ', 'z'],
  });

  assert.equal(paper.rating, 4);
  assert.deepEqual(paper.categories, ['LLM', 'Agent']);
  assert.deepEqual(paper.tags, ['x y', 'z']);
});

test('attachPdf records the file and its name', async () => {
  const paper = await storedPaper();
  const file = { name: 'other.pdf' };
  await papers.attachPdf(paper, file);
  assert.equal(paper.pdfBlob, file);
  assert.equal(paper.pdfName, 'other.pdf');
});

test('setNumPages is a no-op when unchanged and reports real changes', async () => {
  const paper = await storedPaper();
  assert.equal(await papers.setNumPages(paper, 2), false);

  paper.updatedAt = 0;
  assert.equal(await papers.setNumPages(paper, 7), true);
  assert.equal(paper.numPages, 7);
  assert.ok(paper.updatedAt > 0);
});

test('cleanTokens trims, collapses whitespace and dedupes case-insensitively', () => {
  assert.deepEqual(papers.cleanTokens(['  A b ', 'a   B', 'c', '']), ['A b', 'c']);
  assert.deepEqual(papers.cleanTokens('not-an-array'), []);
});

