// parser.js 的 node 可导入性与纯文本/编号解析用例（pdfjs 与 DOMParser 路径不在 node 覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeArxivId, parsePlainText, initParser, fetchArxiv } from '../ui/js/parser.js';

test('normalizeArxivId 接受裸编号与 abs/html/pdf 链接', () => {
  assert.equal(normalizeArxivId('2401.12345'), '2401.12345');
  assert.equal(normalizeArxivId('  2401.12345v2  '), '2401.12345v2');
  assert.equal(normalizeArxivId('https://arxiv.org/abs/2401.12345'), '2401.12345');
  assert.equal(normalizeArxivId('https://arxiv.org/html/2401.12345v3'), '2401.12345v3');
  assert.equal(normalizeArxivId('arxiv.org/pdf/hep-th/9901001'), 'hep-th/9901001');
  assert.equal(normalizeArxivId('not an id'), '');
  assert.equal(normalizeArxivId(''), '');
});

test('parsePlainText 切出摘要与编号章节', () => {
  const abstractBody = 'We study parser testing in node environments and show that plain text splitting keeps working after the port to the Tauri client without any behavioral drift in the section rules.';
  const introBody = 'Parsing research papers into sections is the foundation of the reading workflow. This introduction body deliberately contains enough prose to pass the one hundred and twenty character threshold used by the numbered part detection logic.';
  const result = parsePlainText(`Abstract\n${abstractBody}\n\n1. Introduction\n${introBody}`);

  assert.equal(result.sections.abstract, abstractBody);
  assert.ok(result.sections.introduction.includes(introBody));
  assert.ok(result.fullText.includes(abstractBody));
  assert.ok(result.fullText.includes(introBody));
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].id, 'part-1');
  assert.equal(result.parts[0].semanticType, 'introduction');
  assert.equal(result.sections['part-1'], introBody);
});

test('fetchArxiv：非法编号在触碰注入缝之前拒绝', async () => {
  let called = false;
  initParser({ fetchText: async () => { called = true; return ''; } });
  await assert.rejects(fetchArxiv('not an id'), /有效的 arXiv/);
  assert.equal(called, false);
});

test('fetchArxiv：经注入缝拉取 HTML（URL 指向 arxiv.org/html/）', async () => {
  const urls = [];
  initParser({
    fetchText: async url => {
      urls.push(url);
      throw new Error('网络替身终止'); // 不进入 DOMParser 路径
    },
  });
  await assert.rejects(fetchArxiv('2401.12345'), /网络替身终止/);
  assert.deepEqual(urls, ['https://arxiv.org/html/2401.12345']);
});
