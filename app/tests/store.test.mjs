// store.js 的记录 ↔ DTO 双向映射与 PDF 附件缝的单元测试。
// 假 bridge 记录全部调用；DTO 断言形状与 app/src-tauri/src/migration.rs 的转换函数对齐。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTauriStore, bytesToBase64, base64ToBytes } from '../ui/js/store.js';

function createFakeBridge(handlers = {}) {
  const calls = [];
  return {
    calls,
    async invoke(command, input = {}) {
      calls.push({ command, input });
      const handler = handlers[command];
      if (!handler) throw new Error(`未 mock 的命令：${command}`);
      return handler(input, calls);
    },
  };
}

const iso = ms => new Date(ms).toISOString();

function sampleRecord() {
  return {
    id: 'p1',
    title: '测试论文',
    addedAt: 1700000000000,
    updatedAt: 1700000100000,
    numPages: 12,
    fullText: 'full text',
    rating: 4,
    categories: ['ML'],
    tags: ['t1'],
    sections: { abstract: 'ABS', 'part-1': 'P1' },
    sectionPages: { abstract: { start: 1, end: 1 }, 'part-1': { start: 2, end: 4 } },
    parts: [{
      id: 'part-1', title: 'Introduction', heading: '1. Introduction',
      semanticType: 'introduction', text: 'P1', pageRange: { start: 2, end: 4 },
      sourceRange: { start: 5, end: 9 },
    }],
    analyses: { abstract: { text: '精读', updatedAt: 1700000050000 } },
    translations: { 'abstract:zh': { text: '译文', source: 'model', updatedAt: 1700000060000 } },
    recallCard: { markdown: '# 卡片', images: [{ id: 'img1', data: 'free-json' }], updatedAt: 1700000070000 },
    chat: [
      { role: 'user', content: '问题', createdAt: 1700000080000 },
      { role: 'assistant', content: '回答' }, // 缺 createdAt，保存时用论文 updatedAt 补齐
    ],
    pdfBlob: null,
    pdfName: 'paper.pdf',
  };
}

test('put：记录 → DTO（ISO 日期、sections 数组、parts sortOrder、translations 数组、chat 补齐）', async () => {
  const bridge = createFakeBridge({ 'library.putPaper@1': () => ({ schemaVersion: 1 }) });
  const store = createTauriStore(bridge);
  await store.put(sampleRecord());

  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].command, 'library.putPaper@1');
  const dto = bridge.calls[0].input.paper;
  assert.deepEqual(dto, {
    id: 'p1',
    title: '测试论文',
    sourceType: null,
    arxivId: null,
    pdfName: 'paper.pdf',
    numPages: 12,
    fullText: 'full text',
    rating: 4,
    categories: ['ML'],
    tags: ['t1'],
    addedAt: iso(1700000000000),
    updatedAt: iso(1700000100000),
    // sections 数组：abstract 在前，其后按 parts 顺序；页码范围并入 {start,end} → pageStart/pageEnd
    sections: [
      { id: 'abstract', sourceText: 'ABS', pageStart: 1, pageEnd: 1 },
      { id: 'part-1', sourceText: 'P1', pageStart: 2, pageEnd: 4 },
    ],
    // parts 只存元数据，sortOrder = 数组下标，sourceRange 丢弃
    parts: [{ id: 'part-1', title: 'Introduction', heading: '1. Introduction', semanticType: 'introduction', sortOrder: 0 }],
    analyses: [{ sectionId: 'abstract', text: '精读', updatedAt: iso(1700000050000) }],
    // translations 键 `sectionId:language` 拆成独立字段
    translations: [{ sectionId: 'abstract', language: 'zh', text: '译文', source: 'model', updatedAt: iso(1700000060000) }],
    recallCard: { markdown: '# 卡片', images: [{ id: 'img1', data: 'free-json' }], updatedAt: iso(1700000070000) },
    chat: [
      { role: 'user', content: '问题', createdAt: iso(1700000080000) },
      { role: 'assistant', content: '回答', createdAt: iso(1700000100000) },
    ],
  });
  // 运行时字段不进 DTO
  assert.ok(!('pdfBlob' in dto));
  assert.ok(!('sectionPages' in dto));
  assert.ok(!('pdfAttachment' in dto));
});

test('put：先经 library.putPaper@1 落记录，再传 files.putAttachment@1 附件，上传后 pdfBlob 剥离', async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
  const bridge = createFakeBridge({
    'files.putAttachment@1': () => ({ schemaVersion: 1, attachment: {} }),
    'library.putPaper@1': () => ({ schemaVersion: 1 }),
  });
  const store = createTauriStore(bridge);
  const paper = { ...sampleRecord(), pdfBlob: new Blob([bytes], { type: 'application/pdf' }), pdfName: 'x.pdf' };
  await store.put(paper);

  assert.equal(bridge.calls.length, 2);
  // putAttachment 校验论文必须已存在，落记录必须先行
  assert.equal(bridge.calls[0].command, 'library.putPaper@1');
  const upload = bridge.calls[1];
  assert.equal(upload.command, 'files.putAttachment@1');
  assert.equal(upload.input.paperId, 'p1');
  assert.deepEqual(
    { ...upload.input.attachment, contentBase64: '<略>' },
    { id: 'pdf', name: 'x.pdf', contentType: 'application/pdf', contentBase64: '<略>' },
  );
  assert.deepEqual([...base64ToBytes(upload.input.attachment.contentBase64)], [...bytes]);
  // 上传成功后瞬时句柄被清掉，后续 put 不再重复上传
  assert.equal(paper.pdfBlob, null);
});

function migrationShapeDto() {
  // 迁移写入的形状：sections 数组带 pageStart/pageEnd、ISO 字符串日期、无 sectionPages 字段
  return {
    id: 'p1',
    title: 'T',
    sourceType: 'arxiv-html',
    arxivId: '2401.00001',
    pdfName: '2401.00001.pdf',
    numPages: 0,
    fullText: 'F',
    rating: 0,
    categories: [],
    tags: [],
    addedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T03:04:05Z',
    sections: [
      { id: 'abstract', sourceText: 'ABS', pageStart: 1, pageEnd: 1 },
      { id: 'part-1', sourceText: 'P1', pageStart: null, pageEnd: null },
    ],
    parts: [{ id: 'part-1', title: 'Intro', heading: '1. Intro', semanticType: 'introduction', sortOrder: 0 }],
    analyses: [{ sectionId: 'abstract', text: 'A', updatedAt: '2024-01-03T00:00:00Z' }],
    // 容忍数字时间戳（optional_timestamp 对数字/字符串分别处理）
    translations: [{ sectionId: 'abstract', language: 'zh', text: '译', source: null, updatedAt: 1700000060000 }],
    recallCard: { markdown: '', images: [], updatedAt: '1970-01-01T00:00:00Z' },
    chat: [{ role: 'user', content: 'q', createdAt: '' }],
  };
}

test('get：DTO → 记录（迁移形状），parts 的 text/pageRange 重建，chat createdAt 补齐', async () => {
  const attachment = {
    paperId: 'p1', id: 'pdf', name: 'p.pdf', contentType: 'application/pdf',
    size: 100, sha256: 'x', createdAt: '2024-01-01T00:00:00Z',
  };
  const bridge = createFakeBridge({
    'library.getPaper@1': () => ({ schemaVersion: 1, paper: migrationShapeDto() }),
    'files.listAttachments@1': () => ({ schemaVersion: 1, attachments: [attachment] }),
  });
  const store = createTauriStore(bridge);
  const paper = await store.get('p1');

  assert.equal(paper.addedAt, Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(paper.updatedAt, Date.parse('2024-01-02T03:04:05Z'));
  assert.equal(paper.sourceType, 'arxiv-html');
  assert.equal(paper.arxivId, '2401:00001'.replace(':', '.'));
  assert.deepEqual(paper.sections, { abstract: 'ABS', 'part-1': 'P1' });
  // 页码范围重建：只有 abstract 带有效 pageStart/pageEnd
  assert.deepEqual(paper.sectionPages, { abstract: { start: 1, end: 1 } });
  // parts 冗余字段从 sections/sectionPages 重建
  assert.deepEqual(paper.parts, [{
    id: 'part-1', title: 'Intro', heading: '1. Intro', semanticType: 'introduction',
    text: 'P1', pageRange: null,
  }]);
  assert.deepEqual(paper.analyses, { abstract: { text: 'A', updatedAt: Date.parse('2024-01-03T00:00:00Z') } });
  // 数字时间戳原样保留
  assert.deepEqual(paper.translations, { 'abstract:zh': { text: '译', source: null, updatedAt: 1700000060000 } });
  assert.deepEqual(paper.recallCard, { markdown: '', images: [], updatedAt: 0 });
  // chat 缺 createdAt 时用论文 updatedAt 补齐
  assert.deepEqual(paper.chat, [{ role: 'user', content: 'q', createdAt: Date.parse('2024-01-02T03:04:05Z') }]);
  // PDF 附件句柄挂上，pdfBlob 置空
  assert.deepEqual(paper.pdfAttachment, attachment);
  assert.equal(paper.pdfBlob, null);
});

test('get：listAttachments 失败不阻塞载入', async () => {
  const bridge = createFakeBridge({
    'library.getPaper@1': () => ({ schemaVersion: 1, paper: migrationShapeDto() }),
    'files.listAttachments@1': () => { throw new Error('IO 错误'); },
  });
  const store = createTauriStore(bridge);
  const paper = await store.get('p1');
  assert.equal(paper.id, 'p1');
  assert.equal(paper.pdfAttachment, undefined);
  assert.equal(paper.pdfBlob, null);
});

test('getAll：先 listPapers 再逐篇 getPaper', async () => {
  const bridge = createFakeBridge({
    'library.listPapers@1': () => ({ schemaVersion: 1, papers: [{ id: 'a' }, { id: 'b' }] }),
    'library.getPaper@1': ({ paperId }) => ({
      schemaVersion: 1,
      paper: { ...migrationShapeDto(), id: paperId },
    }),
    'files.listAttachments@1': () => ({ schemaVersion: 1, attachments: [] }),
  });
  const store = createTauriStore(bridge);
  const papers = await store.getAll();

  assert.deepEqual(papers.map(p => p.id), ['a', 'b']);
  assert.deepEqual(bridge.calls.map(c => c.command), [
    'library.listPapers@1',
    'library.getPaper@1',
    'files.listAttachments@1',
    'library.getPaper@1',
    'files.listAttachments@1',
  ]);
});

test('delete：转发 library.deletePaper@1', async () => {
  const bridge = createFakeBridge({ 'library.deletePaper@1': () => ({ schemaVersion: 1 }) });
  const store = createTauriStore(bridge);
  await store.delete('p1');
  assert.deepEqual(bridge.calls, [{ command: 'library.deletePaper@1', input: { paperId: 'p1' } }]);
});

test('positions：三命令转发，updatedAt 毫秒 ↔ ISO 双向转换', async () => {
  const bridge = createFakeBridge({
    'library.getReadingPosition@1': () => ({
      schemaVersion: 1,
      position: { paperId: 'p1', view: 'reader', sectionId: 'abstract', pdfPage: null, contentVersion: null, updatedAt: '2024-01-01T00:00:00Z' },
    }),
    'library.putReadingPosition@1': () => ({ schemaVersion: 1 }),
    'library.deleteReadingPosition@1': () => ({ schemaVersion: 1 }),
  });
  const store = createTauriStore(bridge);

  const position = await store.positions.get('p1');
  assert.equal(position.updatedAt, Date.parse('2024-01-01T00:00:00Z'));

  await store.positions.put({ paperId: 'p1', view: 'reader', sectionId: 'abstract', updatedAt: 1700000000000 });
  const putCall = bridge.calls.find(c => c.command === 'library.putReadingPosition@1');
  assert.deepEqual(putCall.input.position, {
    paperId: 'p1', view: 'reader', sectionId: 'abstract',
    pdfPage: null, contentVersion: null, updatedAt: iso(1700000000000),
  });

  await store.positions.delete('p1');
  assert.deepEqual(bridge.calls.at(-1), { command: 'library.deleteReadingPosition@1', input: { paperId: 'p1' } });
});

test('pdf.has / bytes / base64：pdfBlob 优先，否则 readRange 全量读附件', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const contentBase64 = bytesToBase64(bytes);
  const bridge = createFakeBridge({
    'files.readRange@1': ({ paperId, attachmentId, offset, length }) => {
      assert.equal(paperId, 'p1');
      assert.equal(attachmentId, 'pdf');
      assert.equal(offset, 0);
      assert.equal(length, 4);
      return { schemaVersion: 1, attachment: {}, offset: 0, length: 4, totalSize: 4, contentBase64 };
    },
  });
  const store = createTauriStore(bridge);

  assert.equal(store.pdf.has({}), false);
  assert.equal(store.pdf.has({ pdfAttachment: { size: 4 } }), true);
  assert.equal(store.pdf.has({ pdfBlob: new Blob([bytes]) }), true);

  // 附件路径：readRange
  const fromAttachment = { id: 'p1', pdfAttachment: { size: 4 } };
  assert.deepEqual([...new Uint8Array(await store.pdf.bytes(fromAttachment))], [...bytes]);
  assert.equal(await store.pdf.base64(fromAttachment), contentBase64);

  // 瞬时 pdfBlob 优先：不再触发 readRange
  const withBlob = { id: 'p1', pdfBlob: new Blob([bytes]), pdfAttachment: { size: 4 } };
  const callsBefore = bridge.calls.length;
  assert.equal(await store.pdf.base64(withBlob), contentBase64);
  assert.equal(bridge.calls.length, callsBefore);

  // 无附件返回 null
  assert.equal(await store.pdf.bytes({ id: 'p1' }), null);
  assert.equal(await store.pdf.base64({ id: 'p1' }), null);
});

test('pdf.attach：即 putAttachment（id 固定 pdf）', async () => {
  const bridge = createFakeBridge({ 'files.putAttachment@1': () => ({ schemaVersion: 1 }) });
  const store = createTauriStore(bridge);
  await store.pdf.attach('p1', new Blob([new Uint8Array([1])], { type: 'application/pdf' }));
  const call = bridge.calls[0];
  assert.equal(call.command, 'files.putAttachment@1');
  assert.equal(call.input.paperId, 'p1');
  assert.equal(call.input.attachment.id, 'pdf');
  assert.equal(call.input.attachment.contentType, 'application/pdf');
  assert.deepEqual([...base64ToBytes(call.input.attachment.contentBase64)], [1]);
});
