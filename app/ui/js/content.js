// 地图页 / 节页内容区纯函数（#71 / 规格 #56 决策 7–11、14–16）：
// 落地页分支、L1 五区块 + 复述稿、节页四段（L2 / 三态深挖 / 图表 / 标记）、
// 出处分段与取证轨迹任务定位。无 DOM；UI 壳只负责渲染。
//
// 消费方：本模块测试 + 阅读视图壳（main.js）。

import { l2Sections, parseRefs, partIdForSection, sectionForPart } from './protocol.js';
import { cropAttachmentId } from './qa.js';

export const COPY = {
  startMap: '▶ 开始建图',
  landingIdle: '这篇论文还未建图',
  landingRunning: '正在建图',
  landingCopy: '建图将生成：L1 阅读地图、全部节薄摘要（L2），并备妥页图与图表裁切图。建图完成后可进行深挖、复述稿与提问。',
  landingProgress: '建图进行中：进度与任务中心联动。',
  startDive: '开始深挖',
  redive: '重新深挖',
  trace: '取证轨迹 →',
  synthesize: '生成复述稿',
  resynthesize: '重新生成',
  readSource: '读原文 →',
  mark: '标记已读完',
  marked: '已读完（点击撤销）',
  legacyTitle: '旧精读结果（只读）',
  greyDive: '本节不参与 L2 / 深挖',
  overwriteDive: '重新深挖将覆盖本节已有结果。继续吗？',
  overwriteRetell: '重新生成将覆盖现有复述稿。继续吗？',
};

const TREE_GREY_ROLES = new Set(['references', 'acknowledgments']);
const STAGE_LABELS = {
  preflight: '预渲染校验',
  'map-l2': '生成节薄摘要（L2）',
  'map-l1': '合成阅读地图（L1）',
};

export function mappingStageLabel(stage) {
  return STAGE_LABELS[stage] || '进行中';
}

export function productOf(products, kind, partId = '') {
  return (products ?? []).find(item => item?.kind === kind && (item.partId ?? '') === partId) ?? null;
}

function isDeepDiveKind(kind) {
  return String(kind || '').replace(/@\d+$/, '') === 'paper.deep-dive';
}

function isOpenTask(task) {
  const status = task?.status;
  return !status || (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled');
}

export function runningDeepDivePartIds(tasks, paperId) {
  const ids = [];
  for (const task of tasks ?? []) {
    if (!isDeepDiveKind(task.kind) || task.input?.paperId !== paperId) continue;
    if (!isOpenTask(task)) continue;
    for (const partId of task.input?.partIds ?? []) {
      if (partId && !ids.includes(partId)) ids.push(partId);
    }
  }
  return ids;
}

export function traceTaskId(tasks, { paperId, partId } = {}) {
  let found = null;
  for (const task of tasks ?? []) {
    if (!isDeepDiveKind(task.kind) || task.input?.paperId !== paperId) continue;
    if (!(task.input?.partIds ?? []).includes(partId)) continue;
    found = task.taskId ?? null;
  }
  return found;
}

function paperMeta(paper) {
  const bits = [];
  if (paper?.numPages) bits.push(`${paper.numPages} 页`);
  if (Number.isFinite(paper?.addedAt)) {
    const d = new Date(paper.addedAt);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    bits.push(`导入于 ${stamp}`);
  }
  return bits.join(' · ');
}

export function landingModel({ paper, hasMap = false, mapping = false, mappingStage = null } = {}) {
  if (hasMap) return { surface: 'map', chatGated: false };
  const running = !!mapping;
  return {
    surface: running ? 'landing-running' : 'landing-idle',
    heading: running ? COPY.landingRunning : COPY.landingIdle,
    paperTitle: paper?.title || '',
    paperMeta: paperMeta(paper),
    copy: COPY.landingCopy,
    showStart: !running,
    startLabel: COPY.startMap,
    showProgress: running,
    progressText: running
      ? (mappingStage ? `建图进行中：${mappingStageLabel(mappingStage)}` : COPY.landingProgress)
      : '',
    chatGated: true,
  };
}

export function undugStats({ mapped, products } = {}) {
  const partIds = l2Sections(mapped)
    .map(section => partIdForSection(mapped, section.id))
    .filter(Boolean);
  const dug = new Set((products ?? []).filter(item => item?.kind === 'dig').map(item => item.partId));
  return { undug: partIds.filter(id => !dug.has(id)).length, total: partIds.length };
}

export function deepDiveZone({
  partId,
  products = [],
  runningPartIds = [],
  runningDetail = null,
  grey = false,
} = {}) {
  if (grey) {
    return {
      state: 'skipped',
      hint: COPY.greyDive,
      primaryLabel: null,
      body: null,
      canCancel: false,
      needsOverwriteConfirm: false,
      progressText: '',
      traceLabel: null,
    };
  }
  const running = (runningPartIds ?? []).includes(partId);
  const dig = productOf(products, 'dig', partId);
  if (running) {
    const same = runningDetail?.partId === partId;
    const index = Number(runningDetail?.index);
    const total = Number(runningDetail?.total);
    const progressText = same && Number.isFinite(index) && Number.isFinite(total)
      ? `正在深挖（${index}/${total}）`
      : '深挖进行中';
    return {
      state: 'running',
      hint: '',
      primaryLabel: null,
      body: typeof dig?.body === 'string' ? dig.body : null,
      canCancel: true,
      needsOverwriteConfirm: false,
      progressText,
      traceLabel: null,
    };
  }
  if (typeof dig?.body === 'string' && dig.body.trim()) {
    return {
      state: 'done',
      hint: '',
      primaryLabel: COPY.redive,
      body: dig.body,
      canCancel: false,
      needsOverwriteConfirm: true,
      progressText: '',
      traceLabel: COPY.trace,
    };
  }
  return {
    state: 'idle',
    hint: '',
    primaryLabel: COPY.startDive,
    body: null,
    canCancel: false,
    needsOverwriteConfirm: false,
    progressText: '',
    traceLabel: null,
  };
}

function textWithRefs(entry) {
  if (!entry || typeof entry !== 'object') return { text: '', refs: [] };
  const refs = Array.isArray(entry.refs) ? entry.refs.filter(item => typeof item === 'string') : [];
  return { text: typeof entry.text === 'string' ? entry.text : '', refs };
}

export function mapPageModel({ products = [], mapped = null, synthesizing = false } = {}) {
  const body = productOf(products, 'map')?.body;
  const map = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const retell = productOf(products, 'retell');
  const stats = undugStats({ mapped, products });
  const retellBody = typeof retell?.body === 'string' && retell.body.trim() ? retell.body : null;
  let retellState = 'idle';
  if (synthesizing) retellState = 'running';
  else if (retellBody) retellState = 'done';
  return {
    problem: textWithRefs(map.problem),
    method: textWithRefs(map.method),
    contributions: Array.isArray(map.contributions) ? map.contributions.map(textWithRefs) : [],
    keyEvidence: Array.isArray(map.keyEvidence)
      ? map.keyEvidence.map(item => ({
        assetId: typeof item?.assetId === 'string' ? item.assetId : '',
        note: typeof item?.note === 'string' ? item.note : '',
        refs: Array.isArray(item?.refs) ? item.refs.filter(ref => typeof ref === 'string') : [],
      })).filter(item => item.assetId)
      : [],
    glossary: Array.isArray(map.glossary)
      ? map.glossary.map(item => ({
        term: typeof item?.term === 'string' ? item.term : '',
        defRef: typeof item?.defRef === 'string' ? item.defRef : '',
      })).filter(item => item.term)
      : [],
    retell: {
      state: retellState,
      body: retellBody,
      undug: stats.undug,
      total: stats.total,
      hint: stats.undug ? `当前 ${stats.undug}/${stats.total} 节未经深挖核验` : '',
      primaryLabel: retellState === 'done' ? COPY.resynthesize : COPY.synthesize,
      needsOverwriteConfirm: retellState === 'done',
      canCancel: retellState === 'running',
    },
  };
}

function resolveSection(mapped, partId) {
  if (!mapped || !partId) return null;
  return (mapped.sections ?? []).find(section => section.id === partId)
    || sectionForPart(mapped, partId)
    || null;
}

export function sectionFigures(mapped, partId) {
  const section = resolveSection(mapped, partId);
  if (!section) return [];
  const entries = [...(mapped?.figures ?? []), ...(mapped?.tables ?? [])]
    .filter(entry => entry?.section === section.id);
  return entries.map(entry => ({
    id: entry.id,
    caption: entry.caption || entry.id,
    page: entry.page,
    cropAssetId: cropAttachmentId(entry.id),
  }));
}

export function sectionPageModel({
  partId,
  mapped = null,
  products = [],
  paper = null,
  runningPartIds = [],
  runningDetail = null,
  citeFocus = null,
} = {}) {
  const section = resolveSection(mapped, partId);
  const grey = !!(section && TREE_GREY_ROLES.has(section.role));
  const l2 = productOf(products, 'l2', partId)?.body;
  const l2Ok = l2 && typeof l2 === 'object' && !Array.isArray(l2) ? l2 : null;
  const analysis = paper?.analyses?.[partId];
  const legacyText = typeof analysis?.text === 'string' ? analysis.text.trim() : '';
  return {
    grey,
    title: section?.title || partId,
    l2: (!grey && l2Ok)
      ? {
        gist: typeof l2Ok.gist === 'string' ? l2Ok.gist : '',
        points: Array.isArray(l2Ok.points) ? l2Ok.points : [],
        keyAssets: Array.isArray(l2Ok.keyAssets) ? l2Ok.keyAssets : [],
        pages: l2Ok.pages && typeof l2Ok.pages === 'object' ? l2Ok.pages : null,
      }
      : null,
    deepDive: deepDiveZone({ partId, products, runningPartIds, runningDetail, grey }),
    figures: grey ? [] : sectionFigures(mapped, partId),
    marked: paper?.readMarks?.[partId] != null,
    showMark: !grey && (partId === 'abstract' || /^part-\d+$/.test(partId)),
    legacyAnalysis: (!grey && legacyText)
      ? { text: analysis.text, updatedAt: analysis.updatedAt ?? null }
      : null,
    focusAssetId: citeFocus?.type === 'asset' ? citeFocus.assetId : null,
    readSourceLabel: COPY.readSource,
    markLabel: paper?.readMarks?.[partId] != null ? COPY.marked : COPY.mark,
    pagesLabel: section ? `p${section.pageStart}–p${section.pageEnd}` : '',
  };
}

export function citeSegments(text) {
  const source = String(text ?? '');
  const refs = parseRefs(source);
  if (!refs.length) return [{ type: 'text', text: source }];
  const parts = [];
  let cursor = 0;
  for (const pointer of refs) {
    const idx = source.indexOf(pointer.raw, cursor);
    if (idx === -1) continue;
    if (idx > cursor) parts.push({ type: 'text', text: source.slice(cursor, idx) });
    parts.push({ type: 'ref', raw: pointer.raw, pointer });
    cursor = idx + pointer.raw.length;
  }
  if (cursor < source.length) parts.push({ type: 'text', text: source.slice(cursor) });
  return parts;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function linkifyCiteHtml(html) {
  const refs = parseRefs(html);
  if (!refs.length) return String(html ?? '');
  let out = String(html ?? '');
  const seen = new Set();
  for (const pointer of refs) {
    if (seen.has(pointer.raw)) continue;
    seen.add(pointer.raw);
    const chip = `<button type="button" class="cite-chip" data-cite="${escapeAttr(pointer.raw)}">${pointer.raw}</button>`;
    out = out.split(pointer.raw).join(chip);
  }
  return out;
}

/** 回想卡片 AI 草稿的协议产物材料：L1 + 全部 L2 + 已深挖结果。 */
export function recallDraftMaterial(products = []) {
  const parts = [];
  const map = productOf(products, 'map')?.body;
  if (map && typeof map === 'object') {
    const lines = [
      map.problem?.text && `问题：${map.problem.text}`,
      map.method?.text && `方法：${map.method.text}`,
      ...(Array.isArray(map.contributions) ? map.contributions.map(item => item?.text && `贡献：${item.text}`).filter(Boolean) : []),
    ].filter(Boolean);
    if (lines.length) parts.push(`===== 阅读地图 =====\n${lines.join('\n')}`);
  }
  for (const item of products.filter(row => row?.kind === 'l2')) {
    const body = item.body;
    const gist = body && typeof body === 'object' ? body.gist : '';
    const text = typeof gist === 'string' && gist.trim() ? gist : (typeof body === 'string' ? body : '');
    if (text) parts.push(`===== 节薄摘要 ${item.partId} =====\n${text}`);
  }
  for (const item of products.filter(row => row?.kind === 'dig')) {
    if (typeof item.body === 'string' && item.body.trim()) {
      parts.push(`===== 深挖 ${item.partId} =====\n${item.body}`);
    }
  }
  return parts.join('\n\n');
}
