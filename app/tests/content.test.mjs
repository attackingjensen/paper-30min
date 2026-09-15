// 地图页 / 节页内容区行为缝（#71 / 规格 #56 决策 7–11、14–16）：
// 假产物 + 假任务快照驱动落地页分支、三态深挖区、出处分段与路由。
// 不断言样式数值；DOM 事件绑定走真实窗口走查。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseRefs, partIdForSection } from '../ui/js/protocol.js';
import { initialState, openPaper, openSection, routeCite } from '../ui/js/view.js';
import {
  COPY,
  citeSegments,
  deepDiveZone,
  landingModel,
  linkifyCiteHtml,
  mapPageModel,
  runningDeepDivePartIds,
  sectionFigures,
  sectionPageModel,
  traceTaskId,
  undugStats,
  recallDraftMaterial,
} from '../ui/js/content.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapped = JSON.parse(
  readFileSync(path.join(here, '..', 'src-tauri', 'tests', 'fixtures', 'protocol', 'blockmodel-basic.json'), 'utf-8'),
);

const mapBody = {
  problem: { text: '小样例问题长期存在。', refs: ['(p1)'] },
  method: { text: '提出样例方法。', refs: ['(fig_1)', '(p2)'] },
  contributions: [{ text: '贡献一', refs: ['(p2)'] }],
  keyEvidence: [{ assetId: 'fig_1', note: '架构图', refs: ['(p2)'] }],
  glossary: [{ term: '样例', defRef: '(sec_1:L1)' }],
  structure: [{ secId: 'sec_1_abstract' }],
};

const products = [
  { kind: 'map', partId: '', body: mapBody, updatedAt: 1 },
  {
    kind: 'l2',
    partId: 'part-1',
    body: {
      secId: 'sec_2_introduction',
      gist: '引言说明问题背景。',
      points: [{ text: '背景长期存在', refs: ['(L1)'] }],
      keyAssets: ['fig_1'],
      pages: { start: 1, end: 2 },
    },
  },
  {
    kind: 'l2',
    partId: 'part-2',
    body: {
      secId: 'sec_3_method',
      gist: '方法分两步。',
      points: [{ text: '先读入再输出', refs: ['(p2)'] }],
      keyAssets: ['tbl_1'],
      pages: { start: 2, end: 3 },
    },
  },
  {
    kind: 'l2',
    partId: 'abstract',
    body: {
      secId: 'sec_1_abstract',
      gist: '本文研究小样例问题。',
      points: [{ text: '提出样例方法', refs: ['(p1)'] }],
      keyAssets: [],
      pages: { start: 1, end: 1 },
    },
  },
  {
    kind: 'dig',
    partId: 'part-1',
    body: '## 核心论点\n注意力即可 (L1)。\n\n## 关键细节\n见图 (fig_1)。\n\n## 与全局的关系\n承接摘要 (sec_1:L1)。\n\n## 边界与存疑\n无。',
  },
];

function reader() {
  return openPaper(initialState(), { hasMap: true });
}

test('落地页：未建图显示开始建图；进行中改进度文案；提问保持门禁', () => {
  const paper = { title: 'Fixture 论文：小样例方法', numPages: 3, addedAt: Date.parse('2026-01-02T00:00:00Z') };
  const idle = landingModel({ paper, hasMap: false, mapping: false });
  assert.equal(idle.surface, 'landing-idle');
  assert.equal(idle.heading, '这篇论文还未建图');
  assert.equal(idle.paperTitle, 'Fixture 论文：小样例方法');
  assert.match(idle.paperMeta, /3 页/);
  assert.match(idle.copy, /L1 阅读地图/);
  assert.match(idle.copy, /节薄摘要/);
  assert.equal(idle.showStart, true);
  assert.equal(idle.showProgress, false);
  assert.equal(idle.chatGated, true);
  assert.equal(idle.startLabel, COPY.startMap);

  const running = landingModel({ paper, hasMap: false, mapping: true, mappingStage: 'map-l2' });
  assert.equal(running.surface, 'landing-running');
  assert.equal(running.heading, '正在建图');
  assert.equal(running.showStart, false);
  assert.equal(running.showProgress, true);
  assert.equal(running.progressText, '建图进行中：生成节薄摘要（L2）');
  assert.equal(running.chatGated, true);
  assert.equal(
    landingModel({
      paper,
      mapping: true,
      mappingStage: 'map-l2',
      mappingProgress: { done: 2, total: 5 },
    }).progressText,
    '建图进行中：薄摘要 2/4',
  );

  const pending = landingModel({ paper, hasMap: false, mapping: true });
  assert.equal(pending.progressText, COPY.landingProgress);
});

test('落地页进行中进度文案随阶段变化', () => {
  const paper = { title: 'T' };
  assert.equal(landingModel({ paper, mapping: true, mappingStage: 'preflight' }).progressText, '建图进行中：预渲染校验');
  assert.equal(landingModel({ paper, mapping: true, mappingStage: 'map-l1' }).progressText, '建图进行中：合成阅读地图（L1）');
});

test('深挖区三态：未深挖 / 进行中 / 已深挖；灰显节跳过', () => {
  const idle = deepDiveZone({ partId: 'part-2', products, runningPartIds: [] });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.primaryLabel, COPY.startDive);
  assert.equal(idle.needsOverwriteConfirm, false);
  assert.equal(idle.body, null);

  const running = deepDiveZone({
    partId: 'part-2',
    products,
    runningPartIds: ['part-2'],
    runningDetail: { partId: 'part-2', index: 1, total: 2 },
  });
  assert.equal(running.state, 'running');
  assert.equal(running.canCancel, true);
  assert.equal(running.progressText, '正在深挖（1/2）');
  assert.equal(running.primaryLabel, null);

  const done = deepDiveZone({ partId: 'part-1', products, runningPartIds: [] });
  assert.equal(done.state, 'done');
  assert.equal(done.primaryLabel, COPY.redive);
  assert.equal(done.traceLabel, COPY.trace);
  assert.equal(done.needsOverwriteConfirm, true);
  assert.match(done.body, /## 核心论点/);
  assert.match(done.body, /## 边界与存疑/);

  const redug = deepDiveZone({ partId: 'part-1', products, runningPartIds: ['part-1'] });
  assert.equal(redug.state, 'running');

  const skipped = deepDiveZone({ partId: 'sec_4_references', products, runningPartIds: [], grey: true });
  assert.equal(skipped.state, 'skipped');
  assert.match(skipped.hint, /不参与 L2/);
  assert.equal(skipped.primaryLabel, null);

  const waiting = deepDiveZone({ partId: 'part-2', products, runningPartIds: [], prerenderReady: false });
  assert.equal(waiting.state, 'idle');
  assert.equal(waiting.primaryDisabled, true);
  assert.equal(waiting.hint, COPY.prerenderPending);
  assert.equal(waiting.primaryLabel, COPY.startDive);

  const waitingRedive = deepDiveZone({ partId: 'part-1', products, runningPartIds: [], prerenderReady: false });
  assert.equal(waitingRedive.state, 'done');
  assert.equal(waitingRedive.primaryDisabled, true);
  assert.equal(waitingRedive.hint, COPY.prerenderPending);
});

test('地图页：L1 五区块带出处，复述稿未生成提示未深挖节', () => {
  const page = mapPageModel({ products, mapped, synthesizing: false });
  assert.equal(page.problem.text, '小样例问题长期存在。');
  assert.deepEqual(page.problem.refs, ['(p1)']);
  assert.equal(page.method.text, '提出样例方法。');
  assert.equal(page.contributions[0].text, '贡献一');
  assert.equal(page.keyEvidence[0].assetId, 'fig_1');
  assert.equal(page.glossary[0].term, '样例');
  assert.equal(page.glossary[0].defRef, '(sec_1:L1)');
  assert.equal(page.retell.state, 'idle');
  assert.equal(page.retell.primaryLabel, COPY.synthesize);
  assert.equal(page.retell.undug, 2);
  assert.equal(page.retell.total, 3);
  assert.equal(page.retell.hint, '当前 2/3 节未经深挖核验');
  assert.equal(page.retell.needsOverwriteConfirm, false);

  const withRetell = mapPageModel({
    products: [...products, { kind: 'retell', partId: '', body: '## 问题\n小样例 (p1)。' }],
    mapped,
    synthesizing: false,
  });
  assert.equal(withRetell.retell.state, 'done');
  assert.equal(withRetell.retell.primaryLabel, COPY.resynthesize);
  assert.equal(withRetell.retell.needsOverwriteConfirm, true);
  assert.match(withRetell.retell.body, /## 问题/);

  const busy = mapPageModel({ products, mapped, synthesizing: true });
  assert.equal(busy.retell.state, 'running');
  assert.equal(busy.retell.canCancel, true);
});

test('节页：L2 卡、图表区、标记与旧精读折叠；灰显节无 L2', () => {
  const intro = sectionPageModel({
    partId: 'part-1',
    mapped,
    products,
    paper: {
      readMarks: { 'part-1': 1 },
      analyses: { 'part-1': { text: '旧版引言精读。', updatedAt: 9 } },
    },
    runningPartIds: [],
    citeFocus: { type: 'asset', assetId: 'fig_1' },
  });
  assert.equal(intro.grey, false);
  assert.equal(intro.title, 'Introduction');
  assert.equal(intro.l2.gist, '引言说明问题背景。');
  assert.equal(intro.l2.points[0].text, '背景长期存在');
  assert.deepEqual(intro.l2.keyAssets, ['fig_1']);
  assert.equal(intro.l2.pages.start, 1);
  assert.equal(intro.deepDive.state, 'done');
  assert.equal(intro.figures.length, 1);
  assert.equal(intro.figures[0].id, 'fig_1');
  assert.equal(intro.figures[0].cropAssetId, 'crop-fig_1');
  assert.equal(intro.figures[0].caption, '图 1：样例架构图。');
  assert.equal(intro.marked, true);
  assert.equal(intro.showMark, true);
  assert.equal(intro.legacyAnalysis.text, '旧版引言精读。');
  assert.equal(intro.focusAssetId, 'fig_1');

  const refs = sectionPageModel({
    partId: 'sec_4_references',
    mapped,
    products,
    paper: { readMarks: {}, analyses: {} },
    runningPartIds: [],
  });
  assert.equal(refs.grey, true);
  assert.equal(refs.l2, null);
  assert.equal(refs.deepDive.state, 'skipped');
  assert.equal(refs.showMark, false);
  assert.equal(refs.legacyAnalysis, null);
  assert.equal(refs.figures.length, 0);
});

test('该节图表取自清单归属，不把别节的表算进来', () => {
  const introFigs = sectionFigures(mapped, 'part-1');
  assert.deepEqual(introFigs.map(item => item.id), ['fig_1']);
  const methodFigs = sectionFigures(mapped, 'part-2');
  assert.deepEqual(methodFigs.map(item => item.id), ['tbl_1']);
  assert.equal(sectionFigures(mapped, 'abstract').length, 0);
});

test('出处分段：文本块 / 图表 / 页码可交给 routeCite 三分定位', () => {
  const parts = citeSegments('方法见 (sec_3:L1-3) 与 (fig_1)，对照 (p2)。');
  assert.deepEqual(parts.map(part => part.type), ['text', 'ref', 'text', 'ref', 'text', 'ref', 'text']);
  const block = parts[1];
  const fig = parts[3];
  const page = parts[5];
  assert.equal(block.raw, '(sec_3:L1-3)');
  assert.equal(block.pointer.kind, 'blocks');
  assert.equal(fig.pointer.kind, 'figure');
  assert.equal(page.pointer.kind, 'page');

  const toSource = routeCite(reader(), block.pointer, { mapped });
  assert.equal(toSource.tab, 'source');
  assert.equal(toSource.sourceSectionId, 'sec_3_method');
  assert.deepEqual(toSource.citeFocus, { type: 'blocks', secId: 'sec_3_method', start: 1, end: 3 });

  const toFig = routeCite(openSection(reader(), 'part-2'), fig.pointer, { mapped });
  assert.equal(toFig.tab, 'map');
  assert.equal(toFig.sectionId, partIdForSection(mapped, 'sec_2_introduction'));
  assert.deepEqual(toFig.citeFocus, { type: 'asset', assetId: 'fig_1' });

  const toPage = routeCite(reader(), page.pointer, { mapped });
  assert.equal(toPage.pdfOpen, true);
  assert.equal(toPage.pdfCollapsed, false);
  assert.equal(toPage.pdfPage, 2);

  const local = parseRefs('(L2)')[0];
  const fromSection = routeCite(openSection(reader(), 'part-1'), local, {
    mapped,
    currentSecId: 'sec_2_introduction',
  });
  assert.equal(fromSection.sourceSectionId, 'sec_2_introduction');
  assert.equal(fromSection.citeFocus.start, 2);
});

test('Markdown 产物里的出处指针变成可点击 data-cite', () => {
  const html = linkifyCiteHtml('<p>见图 (fig_1) 与 (p2)</p>');
  assert.match(html, /data-cite="\(fig_1\)"/);
  assert.match(html, /data-cite="\(p2\)"/);
  assert.match(html, /class="cite-chip"/);
  assert.equal(citeSegments('无出处').length, 1);
  assert.equal(citeSegments('无出处')[0].type, 'text');
});

test('假任务快照：批量深挖的 partIds 驱动进行中；取证轨迹指向对应任务', () => {
  const tasks = [
    { taskId: 't-old', kind: 'paper.deep-dive@1', input: { paperId: 'p1', partIds: ['part-1'] }, status: 'succeeded' },
    { taskId: 't-run', kind: 'paper.deep-dive@1', input: { paperId: 'p1', partIds: ['part-2', 'abstract'] }, status: 'running' },
    { taskId: 't-other', kind: 'paper.deep-dive@1', input: { paperId: 'p2', partIds: ['part-2'] }, status: 'running' },
  ];
  assert.deepEqual(runningDeepDivePartIds(tasks, 'p1').sort(), ['abstract', 'part-2']);
  assert.equal(traceTaskId(tasks, { paperId: 'p1', partId: 'part-1' }), 't-old');
  assert.equal(traceTaskId(tasks, { paperId: 'p1', partId: 'part-2' }), 't-run');
  assert.equal(traceTaskId(tasks, { paperId: 'p1', partId: 'ghost' }), null);
});

test('未深挖统计只计 L2 节', () => {
  assert.deepEqual(undugStats({ mapped, products }), { undug: 2, total: 3 });
  assert.deepEqual(undugStats({ mapped, products: [...products, { kind: 'dig', partId: 'part-2', body: 'x' }, { kind: 'dig', partId: 'abstract', body: 'y' }] }), {
    undug: 0,
    total: 3,
  });
});

test('回想卡片草稿材料取自协议产物，不依赖旧精读结果', () => {
  const text = recallDraftMaterial(products);
  assert.match(text, /阅读地图/);
  assert.match(text, /小样例问题长期存在/);
  assert.match(text, /节薄摘要 part-1/);
  assert.match(text, /引言说明问题背景/);
  assert.match(text, /深挖 part-1/);
  assert.match(text, /## 核心论点/);
  assert.equal(recallDraftMaterial([]), '');
});
