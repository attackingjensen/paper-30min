// 阅读视图状态机（#69/#70 / 规格 #56）：当前视图、四 tab、节页选中、侧栏折叠与宽度、
// 拖拽调宽、浮钮可见性、节树状态、落地分流、出处定位路由、阅读位置值域。
// 纯函数、无 DOM；UI 壳只负责渲染。
//
// 消费方：本模块测试 + 阅读视图壳（main.js）。

import { l2Sections, parseRefs, partIdForSection, sectionForPart } from './protocol.js';

export const APP_VIEWS = ['library', 'tasks', 'reader'];
export const READER_TABS = ['map', 'source', 'chat', 'recall'];
export const TREE_WIDTH_DEFAULT = 250;
export const TREE_WIDTH_MIN = 200;
export const TREE_WIDTH_MAX = 440;
export const PDF_WIDTH_MIN = 390;
export const PDF_WIDTH_MAX_RATIO = 0.75;
export const PDF_WIDTH_DEFAULT_RATIO = 0.46;

const LEGACY_READING_VIEW = {
  digest: 'map',
  translate: 'source',
  pdf: 'map',
  reader: 'map',
};

export function initialState(overrides = {}) {
  return {
    appView: 'library',
    paperOpen: false,
    hasMap: false,
    mapping: false,
    tab: 'map',
    sectionId: null,
    sourceSectionId: null,
    treeCollapsed: false,
    treeWidth: TREE_WIDTH_DEFAULT,
    pdfOpen: true,
    pdfCollapsed: false,
    pdfWidth: null,
    pdfPage: null,
    translateCompare: false,
    citeFocus: null,
    ...overrides,
  };
}

function patch(state, updates) {
  return { ...state, ...updates };
}

/** 地图 tab 的表面：建图落地 / 地图页 / 节页。 */
export function mapSurface(state) {
  if (!state?.hasMap) return state?.mapping ? 'landing-running' : 'landing-idle';
  if (state.sectionId) return 'section';
  return 'map';
}

export function openPaper(state, { hasMap = false, mapping = false } = {}) {
  return patch(initialState({
    treeWidth: state?.treeWidth ?? TREE_WIDTH_DEFAULT,
    pdfWidth: state?.pdfWidth ?? null,
    pdfOpen: state?.pdfOpen !== false,
  }), {
    appView: 'reader',
    paperOpen: true,
    hasMap: !!hasMap,
    mapping: !!mapping,
    tab: 'map',
  });
}

export function closePaper(state) {
  return initialState({
    treeWidth: state?.treeWidth ?? TREE_WIDTH_DEFAULT,
    pdfWidth: state?.pdfWidth ?? null,
  });
}

export function switchAppView(state, appView) {
  if (!APP_VIEWS.includes(appView)) return state;
  if (appView === 'reader' && !state.paperOpen) return state;
  return patch(state, { appView });
}

export function switchTab(state, tab) {
  if (!READER_TABS.includes(tab)) return state;
  return patch(state, { tab, citeFocus: null });
}

export function openSection(state, sectionId, { mapped = null } = {}) {
  if (!state.hasMap || !sectionId) return state;
  const page = pdfPageForSection(mapped, sectionId);
  const updates = { appView: 'reader', tab: 'map', sectionId, citeFocus: null };
  if (Number.isFinite(page) && page >= 1) updates.pdfPage = page;
  return patch(state, updates);
}

export function backToMap(state) {
  return patch(state, { tab: 'map', sectionId: null, citeFocus: null });
}

export function setHasMap(state, hasMap) {
  const next = patch(state, { hasMap: !!hasMap });
  if (next.hasMap) return next;
  return patch(next, { sectionId: null });
}

export function setMapping(state, mapping) {
  return patch(state, { mapping: !!mapping });
}

export function setSourceSection(state, sourceSectionId) {
  return patch(state, { sourceSectionId: sourceSectionId || null });
}

export function setPdfPage(state, pdfPage) {
  return patch(state, { pdfPage: Number.isFinite(pdfPage) ? pdfPage : null });
}

/** 节起始页：接受精读部分 id 或原文章节 id。 */
export function pdfPageForSection(mapped, sectionOrPartId) {
  if (!mapped || !sectionOrPartId) return null;
  const byId = (mapped.sections ?? []).find(section => section.id === sectionOrPartId);
  const section = byId || sectionForPart(mapped, sectionOrPartId);
  const page = section?.pageStart;
  return Number.isFinite(page) && page >= 1 ? page : null;
}

export function toggleTranslateCompare(state, force) {
  const translateCompare = typeof force === 'boolean' ? force : !state.translateCompare;
  return patch(state, { translateCompare });
}

export function collapseTree(state) {
  return patch(state, { treeCollapsed: true });
}

export function expandTree(state) {
  return patch(state, { treeCollapsed: false });
}

export function clampTreeWidth(width) {
  const n = Number(width);
  if (!Number.isFinite(n)) return TREE_WIDTH_DEFAULT;
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(n)));
}

export function setTreeWidth(state, width) {
  return patch(state, { treeWidth: clampTreeWidth(width) });
}

export function togglePdf(state, force) {
  if (typeof force === 'boolean') {
    return patch(state, { pdfOpen: force, pdfCollapsed: false });
  }
  if (state.pdfOpen) return patch(state, { pdfOpen: false, pdfCollapsed: false });
  return patch(state, { pdfOpen: true, pdfCollapsed: false });
}

export function collapsePdf(state) {
  if (!state.pdfOpen) return state;
  return patch(state, { pdfCollapsed: true });
}

export function expandPdf(state) {
  return patch(state, { pdfOpen: true, pdfCollapsed: false });
}

/** 收起后视口边缘圆形浮钮：左节树在地图/节页与原文 tab 出现，右 PDF 在全开且收起时出现。 */
export function paneFabVisibility(state) {
  const onReader = !!state?.paperOpen && state.appView === 'reader';
  const surface = mapSurface(state);
  const treeOn = onReader && (
    (state.tab === 'map' && (surface === 'map' || surface === 'section'))
    || state.tab === 'source'
  );
  return {
    tree: treeOn && !!state.treeCollapsed,
    pdf: onReader && !!state.pdfOpen && !!state.pdfCollapsed,
  };
}

const TREE_GREY_ROLES = new Set(['references', 'acknowledgments']);

/** 节树条目：L2 节用精读部分 id；References / Acknowledgments 灰显并保留节 id。 */
export function treeItems(mapped) {
  return (mapped?.sections ?? []).map(section => {
    const grey = TREE_GREY_ROLES.has(section.role);
    const partId = partIdForSection(mapped, section.id);
    return {
      id: partId || section.id,
      title: section.title || section.id,
      grey,
    };
  });
}

/** 状态点：灰=未深挖 / 橙=已深挖 / 绿=已标记读完。灰显节不参与 L2，点保持未深挖。 */
export function treeItemStatus(partId, { readMarks = {}, products = [], grey = false } = {}) {
  if (grey) return 'todo';
  if (readMarks?.[partId] != null) return 'marked';
  if ((products ?? []).some(item => item.kind === 'dig' && item.partId === partId)) return 'dug';
  return 'todo';
}

/** 「全部深挖」的 partIds：参与 L2 的节，按阅读顺序。 */
export function deepAllPartIds(mapped) {
  return l2Sections(mapped)
    .map(section => partIdForSection(mapped, section.id))
    .filter(Boolean);
}

export function defaultPdfWidth(windowWidth) {
  return Math.round((Number(windowWidth) || 0) * PDF_WIDTH_DEFAULT_RATIO);
}

export function clampPdfWidth(width, windowWidth) {
  const max = Math.max(PDF_WIDTH_MIN, Math.round((Number(windowWidth) || 0) * PDF_WIDTH_MAX_RATIO));
  const n = Number(width);
  if (!Number.isFinite(n)) return Math.max(PDF_WIDTH_MIN, defaultPdfWidth(windowWidth));
  return Math.min(max, Math.max(PDF_WIDTH_MIN, Math.round(n)));
}

export function setPdfWidth(state, width, windowWidth) {
  return patch(state, { pdfWidth: clampPdfWidth(width, windowWidth) });
}

/** 节树拖拽：指针相对栏左缘的距离即宽度。 */
export function resizeTreeByClientX(state, clientX, treeLeft) {
  return setTreeWidth(state, Number(clientX) - Number(treeLeft));
}

/** PDF 拖拽：指针到窗口右缘的距离即宽度。 */
export function resizePdfByClientX(state, clientX, windowWidth) {
  return setPdfWidth(state, Number(windowWidth) - Number(clientX), windowWidth);
}

/** 会话内已拖过用钳制后的栏宽；未拖过取窗口 46% 默认（仍走 PDF 钳制）。 */
export function resolvedPdfWidth(state, windowWidth) {
  if (Number.isFinite(state?.pdfWidth)) return clampPdfWidth(state.pdfWidth, windowWidth);
  return clampPdfWidth(defaultPdfWidth(windowWidth), windowWidth);
}

/**
 * 切换视图 ≠ 关闭论文。只有明确关闭当前论文，或打开另一篇时，才取消任务。
 */
export function shouldCancelTasks(intent, { paperOpen = false, currentPaperId = null } = {}) {
  if (!intent || intent.type === 'switch-view') return false;
  if (intent.type === 'close-paper') return !!paperOpen;
  if (intent.type === 'open-paper') {
    return !!paperOpen && currentPaperId != null && currentPaperId !== intent.paperId;
  }
  return false;
}

export function normalizeReadingView(view) {
  if (READER_TABS.includes(view) || view === 'section') return view;
  return LEGACY_READING_VIEW[view] || 'map';
}

export function snapshotPosition(state, paperId) {
  const view = state.tab === 'map' && state.sectionId ? 'section' : state.tab;
  const sectionId = view === 'section'
    ? state.sectionId
    : view === 'source'
      ? state.sourceSectionId
      : null;
  return {
    paperId,
    view,
    sectionId,
    pdfPage: Number.isFinite(state.pdfPage) ? state.pdfPage : null,
  };
}

export function applyPosition(state, position = {}, { validPartIds = [] } = {}) {
  const view = normalizeReadingView(position?.view);
  const next = Number.isFinite(position?.pdfPage)
    ? patch(state, { pdfPage: position.pdfPage })
    : { ...state };

  if (view === 'source') {
    return patch(next, {
      tab: 'source',
      sourceSectionId: position.sectionId || next.sourceSectionId,
    });
  }
  if (view === 'chat' || view === 'recall') {
    return patch(next, { tab: view });
  }
  if (view === 'section' && next.hasMap && validPartIds.includes(position.sectionId)) {
    return patch(next, { tab: 'map', sectionId: position.sectionId });
  }
  return patch(next, { tab: 'map', sectionId: null });
}

function sectionIds(mapped) {
  return (mapped?.sections ?? []).map(section => section.id);
}

function resolveSecId(mapped, secId, currentSecId) {
  if (!secId) return currentSecId || null;
  const ids = sectionIds(mapped);
  if (ids.includes(secId)) return secId;
  const prefix = ids.filter(id => id.startsWith(`${secId}_`));
  return prefix.length === 1 ? prefix[0] : secId;
}

function assetOwnerSecId(mapped, assetId) {
  const entries = [...(mapped?.figures ?? []), ...(mapped?.tables ?? [])];
  return entries.find(entry => entry.id === assetId)?.section ?? null;
}

export function routeCite(state, ref, { mapped = null, currentSecId = null } = {}) {
  const pointer = ref && typeof ref === 'object' && !ref.kind && ref.raw
    ? parseRefs(ref.raw)[0]
    : ref;
  if (!pointer?.kind) return state;

  if (pointer.kind === 'page') {
    return patch(state, {
      pdfOpen: true,
      pdfCollapsed: false,
      pdfPage: pointer.page,
      citeFocus: { type: 'page', page: pointer.page },
    });
  }

  if (pointer.kind === 'figure' || pointer.kind === 'table') {
    if (!state.hasMap) return state;
    const secId = assetOwnerSecId(mapped, pointer.assetId);
    const partId = secId ? (partIdForSection(mapped, secId) ?? secId) : null;
    return patch(state, {
      tab: 'map',
      sectionId: partId,
      citeFocus: { type: 'asset', assetId: pointer.assetId },
    });
  }

  if (pointer.kind === 'blocks') {
    const secId = resolveSecId(mapped, pointer.secId, currentSecId);
    return patch(state, {
      tab: 'source',
      sourceSectionId: secId,
      citeFocus: { type: 'blocks', secId, start: pointer.start, end: pointer.end },
    });
  }

  return state;
}
