// 视图状态机纯函数缝（#69/#70 / 规格 #56 决策 1–6、14、22 与 #33 导航语义）：
// 给定状态输入，断言 tab/节页/落地分流/侧栏折叠宽度/拖拽/浮钮/节树状态/出处路由/阅读位置值域。
// 不断言 DOM 与样式数值；UI 壳走真实窗口走查（#70 侧栏交互，全量在 #72）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseRefs, partIdForSection } from '../ui/js/protocol.js';
import {
  APP_VIEWS,
  PDF_WIDTH_DEFAULT_RATIO,
  PDF_WIDTH_MAX_RATIO,
  PDF_WIDTH_MIN,
  READER_TABS,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MAX,
  TREE_WIDTH_MIN,
  applyPosition,
  backToMap,
  clampPdfWidth,
  clampTreeWidth,
  closePaper,
  collapsePdf,
  collapseTree,
  deepAllPartIds,
  defaultPdfWidth,
  expandPdf,
  expandTree,
  initialState,
  mapSurface,
  normalizeReadingView,
  openPaper,
  openSection,
  paneFabVisibility,
  pdfPageForSection,
  resizePdfByClientX,
  resizeTreeByClientX,
  resolvedPdfWidth,
  routeCite,
  setHasMap,
  setMapping,
  setPdfPage,
  setPdfWidth,
  setTreeWidth,
  shouldCancelTasks,
  snapshotPosition,
  switchAppView,
  switchTab,
  togglePdf,
  toggleTranslateCompare,
  treeItemStatus,
  treeItems,
} from '../ui/js/view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapped = JSON.parse(
  readFileSync(path.join(here, '..', 'src-tauri', 'tests', 'fixtures', 'protocol', 'blockmodel-basic.json'), 'utf-8'),
);

function reader(overrides = {}) {
  return openPaper(initialState(), { hasMap: true, ...overrides });
}

test('常量：四 tab 与三视图值域', () => {
  assert.deepEqual(READER_TABS, ['map', 'source', 'chat', 'recall']);
  assert.deepEqual(APP_VIEWS, ['library', 'tasks', 'reader']);
});

test('落地分流：未建图 → 落地页，进行中 → 进度落地，已建图 → 地图页', () => {
  const idle = openPaper(initialState(), { hasMap: false, mapping: false });
  assert.equal(idle.appView, 'reader');
  assert.equal(idle.paperOpen, true);
  assert.equal(idle.tab, 'map');
  assert.equal(mapSurface(idle), 'landing-idle');

  const running = openPaper(initialState(), { hasMap: false, mapping: true });
  assert.equal(mapSurface(running), 'landing-running');

  const ready = openPaper(initialState(), { hasMap: true, mapping: true });
  assert.equal(mapSurface(ready), 'map');
  assert.equal(ready.sectionId, null);
});

test('建图完成后落地页转为地图页；建图中途不开放节页', () => {
  let state = openPaper(initialState(), { hasMap: false, mapping: true });
  assert.deepEqual(openSection(state, 'abstract'), state);
  state = setHasMap(setMapping(state, false), true);
  assert.equal(mapSurface(state), 'map');
  state = openSection(state, 'abstract');
  assert.equal(mapSurface(state), 'section');
  assert.equal(state.sectionId, 'abstract');
});

test('tab 切换只落在四 tab；翻译不是 tab', () => {
  const state = switchTab(reader(), 'chat');
  assert.equal(state.tab, 'chat');
  assert.equal(switchTab(state, 'translate').tab, 'chat');
  assert.equal(switchTab(state, 'digest').tab, 'chat');
  assert.equal(toggleTranslateCompare(state, true).translateCompare, true);
  assert.equal(toggleTranslateCompare(state, true).tab, 'chat');
});

test('两层导航：下钻进节页、返回地图；切 tab 保留节选中', () => {
  let state = openSection(reader(), 'part-1');
  assert.equal(state.tab, 'map');
  assert.equal(state.sectionId, 'part-1');
  assert.equal(mapSurface(state), 'section');

  state = switchTab(state, 'source');
  assert.equal(state.tab, 'source');
  assert.equal(state.sectionId, 'part-1');

  state = switchTab(state, 'map');
  assert.equal(mapSurface(state), 'section');

  state = backToMap(state);
  assert.equal(state.sectionId, null);
  assert.equal(mapSurface(state), 'map');
});

test('未建图时节页不可达，返回地图清空节选中', () => {
  const idle = openPaper(initialState(), { hasMap: false });
  assert.equal(openSection(idle, 'abstract').sectionId, null);
  const drilled = openSection(reader(), 'part-2');
  assert.equal(backToMap(drilled).sectionId, null);
});

test('切换书库/任务中心/阅读页不关闭论文、不取消任务', () => {
  const state = reader();
  assert.equal(switchAppView(state, 'library').paperOpen, true);
  assert.equal(switchAppView(state, 'library').appView, 'library');
  assert.equal(switchAppView(state, 'tasks').appView, 'tasks');
  assert.equal(switchAppView(state, 'reader').appView, 'reader');
  assert.equal(shouldCancelTasks({ type: 'switch-view', view: 'library' }, { paperOpen: true, currentPaperId: 'p1' }), false);
  assert.equal(shouldCancelTasks({ type: 'switch-view', view: 'tasks' }, { paperOpen: true, currentPaperId: 'p1' }), false);
  assert.equal(shouldCancelTasks({ type: 'switch-view', view: 'reader' }, { paperOpen: true, currentPaperId: 'p1' }), false);
});

test('明确关闭论文或打开另一篇才取消任务；同篇再进不取消', () => {
  assert.equal(shouldCancelTasks({ type: 'close-paper' }, { paperOpen: true, currentPaperId: 'p1' }), true);
  assert.equal(shouldCancelTasks({ type: 'close-paper' }, { paperOpen: false }), false);
  assert.equal(shouldCancelTasks({ type: 'open-paper', paperId: 'p2' }, { paperOpen: true, currentPaperId: 'p1' }), true);
  assert.equal(shouldCancelTasks({ type: 'open-paper', paperId: 'p1' }, { paperOpen: true, currentPaperId: 'p1' }), false);
  const closed = closePaper(reader());
  assert.equal(closed.paperOpen, false);
  assert.equal(closed.appView, 'library');
  assert.equal(switchAppView(closed, 'reader').appView, 'library');
});

test('侧栏折叠：节树收起/展开；PDF 顶栏全关全开与收起浮钮互不混淆', () => {
  let state = collapseTree(reader());
  assert.equal(state.treeCollapsed, true);
  state = expandTree(state);
  assert.equal(state.treeCollapsed, false);

  state = collapsePdf(reader());
  assert.equal(state.pdfOpen, true);
  assert.equal(state.pdfCollapsed, true);

  state = expandPdf(state);
  assert.equal(state.pdfCollapsed, false);
  assert.equal(state.pdfOpen, true);

  state = togglePdf(reader(), false);
  assert.equal(state.pdfOpen, false);
  assert.equal(state.pdfCollapsed, false);
  assert.equal(collapsePdf(state).pdfCollapsed, false);
  state = togglePdf(state, true);
  assert.equal(state.pdfOpen, true);

  state = togglePdf(reader());
  assert.equal(state.pdfOpen, false);
  assert.equal(state.pdfCollapsed, false);
  state = togglePdf(collapsePdf(reader()));
  assert.equal(state.pdfOpen, false);
  assert.equal(state.pdfCollapsed, false);
  state = togglePdf(state);
  assert.equal(state.pdfOpen, true);
  assert.equal(state.pdfCollapsed, false);
});

test('侧栏宽度钳制：节树 200–440 默认 250；PDF 最小 390、最宽 75%，默认约 46%', () => {
  assert.equal(TREE_WIDTH_DEFAULT, 250);
  assert.equal(clampTreeWidth(100), TREE_WIDTH_MIN);
  assert.equal(clampTreeWidth(999), TREE_WIDTH_MAX);
  assert.equal(setTreeWidth(reader(), 300).treeWidth, 300);

  assert.equal(defaultPdfWidth(1200), Math.round(1200 * PDF_WIDTH_DEFAULT_RATIO));
  assert.equal(clampPdfWidth(100, 1200), PDF_WIDTH_MIN);
  assert.equal(clampPdfWidth(2000, 1200), Math.round(1200 * PDF_WIDTH_MAX_RATIO));
  assert.equal(setPdfWidth(reader(), 500, 1200).pdfWidth, 500);
});

test('拖拽调宽：节树按指针相对左缘；PDF 按窗口右缘距离，未拖过时取默认约 46%', () => {
  const tree = resizeTreeByClientX(reader(), 520, 200);
  assert.equal(tree.treeWidth, 320);

  const pdf = resizePdfByClientX(reader(), 700, 1200);
  assert.equal(pdf.pdfWidth, 500);

  assert.equal(resolvedPdfWidth(reader(), 1200), Math.round(1200 * PDF_WIDTH_DEFAULT_RATIO));
  assert.equal(resolvedPdfWidth(setPdfWidth(reader(), 500, 1200), 1200), 500);
  assert.equal(resolvedPdfWidth(setPdfWidth(reader(), 700, 1200), 800), Math.round(800 * PDF_WIDTH_MAX_RATIO));
});

test('浮钮：节树收起后在地图/节页与原文 tab 露出左缘 »；PDF 收起露出右缘 «，顶栏全关则无浮钮', () => {
  const onMap = reader();
  assert.deepEqual(paneFabVisibility(onMap), { tree: false, pdf: false });

  const treeDown = collapseTree(onMap);
  assert.deepEqual(paneFabVisibility(treeDown), { tree: true, pdf: false });
  // 共享节树：原文 tab 也显示节树，折叠后同样露出浮钮（未建图时由壳层按节树可见性再压掉）。
  assert.equal(paneFabVisibility(switchTab(treeDown, 'source')).tree, true);
  assert.equal(paneFabVisibility(switchAppView(treeDown, 'library')).tree, false);
  assert.equal(paneFabVisibility(openPaper(initialState(), { hasMap: false })).tree, false);

  const pdfDown = collapsePdf(onMap);
  assert.deepEqual(paneFabVisibility(pdfDown), { tree: false, pdf: true });
  assert.equal(paneFabVisibility(switchTab(pdfDown, 'chat')).pdf, true);
  assert.equal(paneFabVisibility(togglePdf(pdfDown, false)).pdf, false);
  assert.equal(paneFabVisibility(switchAppView(pdfDown, 'tasks')).pdf, false);
});

test('节树：进度状态点灰/橙/绿；References 灰显不参与 L2；全部深挖只收 L2 部分', () => {
  const items = treeItems(mapped);
  assert.deepEqual(items.map(item => [item.id, item.grey]), [
    ['abstract', false],
    ['part-1', false],
    ['part-2', false],
    ['sec_4_references', true],
  ]);
  assert.equal(items[3].title, 'References');

  assert.equal(treeItemStatus('abstract', { grey: false }), 'todo');
  assert.equal(treeItemStatus('abstract', {
    products: [{ kind: 'dig', partId: 'abstract' }],
  }), 'dug');
  assert.equal(treeItemStatus('abstract', {
    readMarks: { abstract: 1 },
    products: [{ kind: 'dig', partId: 'abstract' }],
  }), 'marked');
  assert.equal(treeItemStatus('sec_4_references', { grey: true, readMarks: { 'sec_4_references': 1 } }), 'todo');

  assert.deepEqual(deepAllPartIds(mapped), ['abstract', 'part-1', 'part-2']);
  assert.deepEqual(deepAllPartIds(null), []);
});

test('附录留在原文章节树中但不成为可标记或批量深挖部分', () => {
  const withAppendix = { ...mapped, sections: [
    ...mapped.sections.slice(0, 3),
    { ...mapped.sections[2], id: 'appendix-a', role: 'appendix', title: 'Appendix A' },
    mapped.sections[3],
  ] };
  assert.deepEqual(treeItems(withAppendix).map(item => [item.id, item.grey]), [
    ['abstract', false], ['part-1', false], ['part-2', false],
    ['appendix-a', true], ['sec_4_references', true],
  ]);
  assert.deepEqual(deepAllPartIds(withAppendix), ['abstract', 'part-1', 'part-2']);
  assert.deepEqual(treeItems(withAppendix, { legacy: true }).map(item => [item.id, item.grey])[3], ['part-3', false]);
});

test('进节页时 PDF 对照定位该节起始页；栏收起仍记页码，不自动展开', () => {
  assert.equal(pdfPageForSection(mapped, 'part-2'), 2);
  assert.equal(pdfPageForSection(mapped, 'sec_3_method'), 2);
  assert.equal(pdfPageForSection(mapped, 'abstract'), 1);
  assert.equal(pdfPageForSection(mapped, 'sec_4_references'), 3);
  assert.equal(pdfPageForSection(mapped, 'ghost'), null);
  assert.equal(pdfPageForSection(null, 'abstract'), null);

  const toMethod = openSection(reader(), 'part-2', { mapped });
  assert.equal(toMethod.sectionId, 'part-2');
  assert.equal(toMethod.pdfPage, 2);

  const collapsed = collapsePdf(setPdfPage(reader(), 1));
  const stillCollapsed = openSection(collapsed, 'part-2', { mapped });
  assert.equal(stillCollapsed.pdfCollapsed, true);
  assert.equal(stillCollapsed.pdfOpen, true);
  assert.equal(stillCollapsed.pdfPage, 2);

  const noMap = openSection(reader(), 'part-2');
  assert.equal(noMap.pdfPage, null);
});

test('出处定位三分：文本块→原文 tab，图表→节页，页码→展开 PDF 对照', () => {
  const block = parseRefs('(sec_3:L1-3)')[0];
  const fromMap = routeCite(reader(), block, { mapped });
  assert.equal(fromMap.tab, 'source');
  assert.equal(fromMap.sourceSectionId, 'sec_3_method');
  assert.deepEqual(fromMap.citeFocus, { type: 'blocks', secId: 'sec_3_method', start: 1, end: 3 });

  const local = parseRefs('(L2)')[0];
  const fromSection = routeCite(openSection(reader(), 'part-1'), local, {
    mapped,
    currentSecId: 'sec_2_introduction',
  });
  assert.equal(fromSection.tab, 'source');
  assert.equal(fromSection.sourceSectionId, 'sec_2_introduction');
  assert.equal(fromSection.citeFocus.start, 2);

  const fig = parseRefs('(fig_1)')[0];
  const toFig = routeCite(switchTab(reader(), 'source'), fig, { mapped });
  assert.equal(toFig.tab, 'map');
  assert.equal(toFig.sectionId, partIdForSection(mapped, 'sec_2_introduction'));
  assert.deepEqual(toFig.citeFocus, { type: 'asset', assetId: 'fig_1' });

  const tbl = parseRefs('(tbl_1)')[0];
  const toTbl = routeCite(reader(), tbl, { mapped });
  assert.equal(toTbl.sectionId, partIdForSection(mapped, 'sec_3_method'));
  assert.equal(toTbl.citeFocus.assetId, 'tbl_1');

  const page = parseRefs('(p2)')[0];
  const collapsed = collapsePdf(togglePdf(reader(), false));
  const toPage = routeCite(collapsed, page, { mapped });
  assert.equal(toPage.pdfOpen, true);
  assert.equal(toPage.pdfCollapsed, false);
  assert.equal(toPage.pdfPage, 2);

  const unmapped = openPaper(initialState(), { hasMap: false });
  const figNoMap = routeCite(unmapped, fig, { mapped });
  assert.equal(figNoMap.sectionId, null);
  assert.equal(figNoMap.tab, 'map');
});

test('阅读位置：新值域快照；旧 digest/translate/pdf 映射', () => {
  assert.equal(normalizeReadingView('map'), 'map');
  assert.equal(normalizeReadingView('section'), 'section');
  assert.equal(normalizeReadingView('digest'), 'map');
  assert.equal(normalizeReadingView('translate'), 'source');
  assert.equal(normalizeReadingView('pdf'), 'map');
  assert.equal(normalizeReadingView('reader'), 'map');

  const sectionState = openSection(reader(), 'part-1');
  assert.deepEqual(snapshotPosition(sectionState, 'p1'), {
    paperId: 'p1',
    view: 'section',
    sectionId: 'part-1',
    pdfPage: null,
  });

  const sourceState = { ...switchTab(reader(), 'source'), sourceSectionId: 'sec_2_introduction', pdfPage: 3 };
  assert.deepEqual(snapshotPosition(sourceState, 'p1'), {
    paperId: 'p1',
    view: 'source',
    sectionId: 'sec_2_introduction',
    pdfPage: 3,
  });

  const fromDigest = applyPosition(reader(), { view: 'digest', sectionId: 'abstract', pdfPage: 4 }, {
    validPartIds: ['abstract', 'part-1'],
  });
  assert.equal(fromDigest.tab, 'map');
  assert.equal(fromDigest.sectionId, null);
  assert.equal(fromDigest.pdfPage, 4);

  const fromTranslate = applyPosition(reader(), { view: 'translate', sectionId: 'part-1' }, {
    validPartIds: ['abstract', 'part-1'],
  });
  assert.equal(fromTranslate.tab, 'source');
  assert.equal(fromTranslate.sourceSectionId, 'part-1');

  const fromSection = applyPosition(reader(), { view: 'section', sectionId: 'part-1' }, {
    validPartIds: ['abstract', 'part-1'],
  });
  assert.equal(fromSection.tab, 'map');
  assert.equal(fromSection.sectionId, 'part-1');

  const unknownPart = applyPosition(reader(), { view: 'section', sectionId: 'ghost' }, {
    validPartIds: ['abstract'],
  });
  assert.equal(unknownPart.sectionId, null);

  const unmapped = applyPosition(openPaper(initialState(), { hasMap: false }), { view: 'section', sectionId: 'abstract' }, {
    validPartIds: ['abstract'],
  });
  assert.equal(mapSurface(unmapped), 'landing-idle');
});
