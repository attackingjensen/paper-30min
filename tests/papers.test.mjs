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
