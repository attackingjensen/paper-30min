// 界面壳与编排：书库 / 阅读 / 任务中心三个视图与全部弹窗。
// 领域规则在 js/ 模块里；本文件只做 DOM 与流程编排。阅读视图状态（四 tab、节页、
// 落地分流、侧栏折叠/拖拽、浮钮、节树状态）走 view.js；地图页 / 节页内容走 content.js。
// 壳只负责渲染（#69/#70/#71 / 规格 #56）。

import { createBridge, trackTask, taskStatusLabel, isTerminalStatus, activeTasks } from '../bridge.js';
import * as papers from './papers.js';
import * as model from './model.js';
import * as generation from './generation.js';
import * as parser from './parser.js';
import { createTauriStore, bytesToBase64, base64ToBytes } from './store.js';
import { renderMarkdown, typesetMath } from './markdown.js';
import { PROTOCOL_TASKS, parseRefs, partIdForSection, sectionForPart } from './protocol.js';
import * as view from './view.js';
import {
  COPY,
  citeSegments,
  landingModel,
  linkifyCiteHtml,
  mapPageModel,
  runningDeepDivePartIds,
  sectionPageModel,
  traceTaskId,
  recallDraftMaterial,
} from './content.js';
import {
  initSkills, effectiveSkills, getSkill, saveCustomSkill, resetSkill,
  parseSkillFile, loadCustomSkills, loadSkills,
} from './skills.js';
import {
  QA_GATE_MESSAGE,
  BLOCKMODEL_ATTACHMENT_ID,
  applyMention,
  assembleQaContext,
  composerMessage,
  emptyBinding,
  fragmentBinding,
  hasMapProduct,
  mentionCandidates,
  parseMentionTrigger,
  sectionBinding,
  userBindingView,
} from './qa.js';
import {
  fmtDate,
  libraryMapState,
  notesMarkdown,
  ratingText,
  taskDetailModel,
} from './present.js';

const bridge = createBridge(window.__TAURI__);
let store = null; // createTauriStore(bridge)，启动序列中创建

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function escapeTemplate(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------- 全局状态 ----------------
let library = [];
let current = null;          // 当前打开的论文（切到书库/任务中心不清除）
let currentView = 'library'; // library | tasks | reader
let currentTab = 'map';      // map | source | chat | recall
let reader = view.initialState();
let chatAborter = null;      // 问答中断控制器（独立于精读生成任务）
let editingSkillId = null;
let sourceTab = 'abstract';
let currentMapped = null;    // 当前论文块模型；未建图或加载失败为 null
let chatComposer = emptyBinding();
let mentionItems = [];
let mentionActive = 0;
let mentionOpen = false;
let pendingSourceHits = [];
let chatQuoteExpanded = new Set();
let composerQuoteExpanded = false;
let translateAborter = null;
let recallAborter = null;
let pdfDocument = null;
let pdfRenderTask = null;
let pdfPage = 1;
let pdfScale = 1;
let pdfSidebarOpen = true;
let libraryQuery = '';
let categoryFilter = '';
let ratingFilter = 0;
let doneFilter = ''; // '' | 'done' | 'undone'（书库「已读完」筛选，规格 #51 决策 16）
let organizeDraft = { rating: 0, categories: [], tags: [] };
let migrationToken = '';

// 会话内任务登记表：taskId -> { kind, input, retry, status? }。重试与 PDF 栏任务上下文都从这里取。
// 只增不清会随会话膨胀：容量上限 50 条，任务到达终态后把 status 记入条目，
// 新增条目超出上限时按插入顺序淘汰最旧的 succeeded 条目（failed/cancelled 保留，
// 任务中心的「重试」按钮依赖这些条目）。
const SESSION_TASKS_LIMIT = 50;
const sessionTasks = new Map();
/** 会话登记的取证轨迹步数上限（只收 tool 步；快照 details 容量 500 由 Rust SNAPSHOT_DETAILS_CAP 守）。 */
const SESSION_STEPS_CAP = 200;

function registerSessionTask(taskId, entry) {
  sessionTasks.set(taskId, entry);
  if (sessionTasks.size <= SESSION_TASKS_LIMIT) return;
  for (const [id, meta] of sessionTasks) {
    if (sessionTasks.size <= SESSION_TASKS_LIMIT) break;
    if (id === taskId) continue; // 不淘汰刚登记的条目
    if (meta.status === 'succeeded') sessionTasks.delete(id);
  }
}
let lastActiveTasks = [];    // 最近一次 activeOnly 轮询结果（供顶栏角标与 PDF 栏）
let positionTimer = null;    // 阅读位置 500ms 防抖
const recallBlobUrls = new Map(); // 回忆卡图片 imageId -> Blob URL，离开论文时统一 revoke
let paneDrag = null;         // 双侧栏拖拽：{ side, pointerId, treeLeft }

// 任务 kind -> 中文名（kind 带 @1 后缀，先剥掉版本再匹配）。
const TASK_KIND_LABELS = {
  'model.chat': '模型生成',
  'model.test': '连接测试',
  'net.fetch-text': '网页抓取',
  'files.download': '文件下载',
  'pdfparse.convert': '解析 PDF',
  'pdfassets.prerender': '预渲染页图',
  'paper.build-map': '建图',
  'paper.deep-dive': '深挖',
  'paper.synthesize': '综合',
};

function taskKindLabel(kind) {
  const bare = String(kind || '').replace(/@\d+$/, '');
  if (TASK_KIND_LABELS[bare]) return TASK_KIND_LABELS[bare];
  if (bare.startsWith('demo.')) return '演示任务';
  return bare || '未知任务';
}

function renderMarkdownInto(element, text) {
  element.innerHTML = renderMarkdown(text);
  typesetMath(element);
}

function dateStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function ensureSettings() {
  if (model.settingsReady()) return true;
  toast('请先在「设置」中配置 API', true);
  openSettingsModal();
  return false;
}

function metadataTokens(paper) {
  return [...papers.paperCategories(paper), ...papers.paperTags(paper)];
}

function isMappingPaper(paperId) {
  return hasOpenProtocolTask(paperId, PROTOCOL_TASKS.buildMap);
}

function isDeepDivingPaper(paperId) {
  return hasOpenProtocolTask(paperId, PROTOCOL_TASKS.deepDive);
}

function isSynthesizingPaper(paperId) {
  return hasOpenProtocolTask(paperId, PROTOCOL_TASKS.synthesize);
}

function hasOpenProtocolTask(paperId, kind) {
  if (!paperId) return false;
  for (const meta of sessionTasks.values()) {
    if (meta.kind !== kind || meta.input?.paperId !== paperId) continue;
    if (meta.status && isTerminalStatus(meta.status)) continue;
    return true;
  }
  for (const task of lastActiveTasks) {
    if (task.kind !== kind) continue;
    const meta = sessionTasks.get(task.taskId);
    // 会话登记已知终态的任务不算开放：lastActiveTasks 是 3s 轮询快照，终态后短暂滞留
    // 会让「正在生成/深挖中」卡到下一次渲染触发（#72 走查发现）。
    if (meta?.status && isTerminalStatus(meta.status)) continue;
    if ((meta?.input?.paperId || task.input?.paperId) === paperId) return true;
  }
  return false;
}

function syncReaderLocals() {
  currentView = reader.appView;
  currentTab = reader.tab;
  if (reader.sourceSectionId) sourceTab = reader.sourceSectionId;
  if (Number.isFinite(reader.pdfPage)) pdfPage = reader.pdfPage;
  pdfSidebarOpen = reader.pdfOpen && !reader.pdfCollapsed;
}

function renderReaderChrome({ restore = false } = {}) {
  syncReaderLocals();
  $('#view-library').hidden = reader.appView !== 'library';
  $('#view-tasks').hidden = reader.appView !== 'tasks';
  $('#view-reader').hidden = reader.appView !== 'reader';
  $('#nav-library').classList.toggle('active', reader.appView === 'library');
  $('#nav-reader').classList.toggle('active', reader.appView === 'reader');
  $('#nav-reader').hidden = !reader.paperOpen;
  $('#nav-tasks').classList.toggle('active', reader.appView === 'tasks');
  setTasksPolling(reader.appView === 'tasks');
  if (reader.appView === 'reader') {
    renderReaderTabs();
    renderMapTab();
    updatePdfSidebar();
    updatePaneFabs();
  } else {
    updatePaneFabs();
  }
  if (!restore && reader.appView === 'reader' && current) schedulePositionSave();
}

function commitReader(next, options) {
  reader = next;
  renderReaderChrome(options);
}

function renderReaderTabs() {
  $$('#reader-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === reader.tab));
  for (const id of view.READER_TABS) {
    const panel = $(`#tab-${id}`);
    if (panel) panel.hidden = id !== reader.tab;
  }
  if (reader.tab !== 'source') hideSourceAskFloat();
}

function updatePaneFabs() {
  const fabs = view.paneFabVisibility(reader);
  $('#tree-fab').hidden = !fabs.tree;
  $('#pdf-fab').hidden = !fabs.pdf;
}

// 原生窗口标题随视图切换；document.title 只作 WebView 内兜底（不同步原生标题，实测）。
function setWindowTitle(title) {
  document.title = title;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (win) void win.setTitle(title);
  } catch { /* 浏览器/测试环境无原生窗口 */ }
}

function showView(name) {
  if (current && name !== 'reader') void flushPositionSave(current);
  commitReader(view.switchAppView(reader, name), { restore: true });
  // 窗口标题：书库/任务中心显示产品名；阅读页显示「论文标题 · Paper30Min」（打磨批改名条款）。
  if (name !== 'reader') setWindowTitle('Paper30Min');
  // 回到书库即刷新：建图状态 chip 与进度点依赖最新记录与会话任务（#56 决策 12）。
  if (name === 'library') void refreshLibrary();
}

// ---------------- 桥接长任务辅助 ----------------
// 事件订阅、退订清理、tasks.get@1 快照复核与 abort 取消统一走 bridge.js 的 trackTask；
// 这里只实现各任务的终态语义，并把终态写回会话登记表（供容量淘汰与重试）。

// net.fetch-text@1：累积 chunk 为全文；succeeded 解全文，failed 拒 Error(error.message)。
async function fetchText(url) {
  const { taskId } = await bridge.start('net.fetch-text@1', { url });
  const meta = {
    kind: 'net.fetch-text@1',
    input: { url },
    retry: () => fetchText(url),
  };
  registerSessionTask(taskId, meta);
  let full = '';
  const { status, error } = await trackTask(bridge, taskId, {
    onChunk: chunk => { full += chunk; },
  });
  meta.status = status;
  if (status === 'succeeded') return full;
  if (status === 'failed') throw new Error(error?.message || '网页抓取失败');
  throw new DOMException('任务已取消', 'AbortError');
}

// files.download@1：等终态；succeeded 解出 result，failed 抛出带 code/retryable 的 Error。
async function downloadPdf({ arxivId, paperId }) {
  const input = {
    paperId,
    attachmentId: 'pdf',
    name: `${arxivId}.pdf`,
    url: `https://arxiv.org/pdf/${arxivId}`,
    contentType: 'application/pdf',
  };
  const { taskId } = await bridge.start('files.download@1', input);
  // 记入会话 Map：PDF 栏按 input.paperId 过滤显示进行中/已完成的下载，重试走 retry。
  const meta = {
    kind: 'files.download@1',
    input,
    retry: () => downloadPdf({ arxivId, paperId }),
  };
  registerSessionTask(taskId, meta);
  renderPdfTasks();
  const { status, error, result } = await trackTask(bridge, taskId, {});
  meta.status = status;
  if (status === 'succeeded') return result ?? null;
  if (status === 'failed') {
    throw Object.assign(new Error(error?.message || '文件下载失败'), {
      code: error?.code || 'unknown',
      retryable: Boolean(error?.retryable),
    });
  }
  throw new DOMException('任务已取消', 'AbortError');
}

// ---------------- 打卡（连续天数） ----------------
function updateStreakBadge() {
  const total = library.length;
  let doneCount = 0;
  let sectionCount = 0;
  for (const p of library) {
    const progress = papers.readingProgress(p);
    doneCount += progress.done;
    sectionCount += progress.total;
  }
  $('#streak-badge').textContent = total ? `🔥 连续 ${papers.streakDays(library)} 天 · 已读 ${total} 篇 · 已读完 ${doneCount}/${sectionCount} 节` : '';
}

// ---------------- 书库视图 ----------------
async function refreshLibrary() {
  library = await papers.listPapers();
  const list = $('#paper-list');
  list.innerHTML = '';

  updateStreakBadge();

  const categorySelect = $('#filter-category');
  const categories = papers.cleanTokens(library.flatMap(papers.paperCategories)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  categorySelect.innerHTML = '<option value="">全部分类</option>';
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    option.selected = category === categoryFilter;
    categorySelect.appendChild(option);
  }
  if (categoryFilter && !categories.includes(categoryFilter)) categoryFilter = '';

  const query = libraryQuery.trim().toLocaleLowerCase();
  const visiblePapers = library.filter(paper => {
    const haystack = [paper.title, ...metadataTokens(paper)].join(' ').toLocaleLowerCase();
    return (!query || haystack.includes(query)) &&
      (!categoryFilter || papers.paperCategories(paper).includes(categoryFilter)) &&
      (!ratingFilter || (Number(paper.rating) || 0) >= ratingFilter) &&
      (!doneFilter || (doneFilter === 'done') === papers.isPaperRead(paper));
  });

  const empty = $('#empty-state');
  empty.hidden = visiblePapers.length > 0;
  empty.replaceChildren();
  if (!visiblePapers.length) {
    const lines = library.length
      ? ['没有符合当前筛选条件的论文。']
      : ['书库还是空的。', '点击上方「导入 PDF」，或先打开「示例论文」体验一遍精读流程。'];
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      empty.appendChild(p);
    }
  }

  const ready = model.settingsReady();
  const warn = $('#api-warning');
  warn.hidden = ready;
  if (!ready) warn.textContent = '⚠️ 尚未配置大模型 API，AI 精读功能暂不可用。点击这里前往设置（支持 OpenAI / DeepSeek / Moonshot / 阿里云百炼 / Ollama 等兼容接口）。';

  for (const p of visiblePapers) {
    const card = document.createElement('div');
    card.className = 'paper-card';
    const defs = papers.readingParts(p);
    const { done, total } = papers.readingProgress(p);

    const title = document.createElement('p');
    title.className = 'pc-title';
    title.textContent = p.title;

    const sub = document.createElement('div');
    sub.className = 'pc-sub';
    const dots = document.createElement('span');
    dots.className = 'progress-dots';
    dots.title = `已读完 ${done}/${total}`;
    for (const def of defs) {
      const dot = document.createElement('span');
      dot.className = 'pdot' + (p.readMarks?.[def.id] != null ? ' done' : '');
      dots.appendChild(dot);
    }
    sub.appendChild(dots);
    // 建图状态（#56 决策 12）：未建图 = 状态点；建图中 = 阶段进度；已建图 = 标记进度 n/N。
    const mapState = libraryMapState({
      mapped: hasMapProduct(p.products),
      mapping: isMappingPaper(p.id),
      mappingStage: mappingStageOf(p.id),
      done,
      total,
    });
    const mapChip = document.createElement('span');
    mapChip.className = `map-state-chip ${mapState.tone}`;
    mapChip.textContent = mapState.text;
    sub.appendChild(mapChip);
    if (papers.isPaperRead(p)) {
      const doneChip = document.createElement('span');
      doneChip.className = 'metadata-chip pc-done';
      doneChip.textContent = '已读完';
      sub.appendChild(doneChip);
    }
    const added = document.createElement('span');
    added.textContent = `${p.numPages ? p.numPages + ' 页 · ' : ''}导入于 ${fmtDate(p.addedAt)}`;
    sub.appendChild(added);
    // 「最近精读」只看精读结果时间，与已读完标记解耦——只标记未生成结果的论文没有该行。
    const analysisTimes = Object.values(p.analyses || {}).map(a => a?.updatedAt || 0).filter(Boolean);
    if (analysisTimes.length) {
      const recent = document.createElement('span');
      recent.textContent = `最近精读 ${fmtDate(Math.max(...analysisTimes))}`;
      sub.appendChild(recent);
    }

    const metadata = document.createElement('div');
    metadata.className = 'pc-metadata';
    const rating = document.createElement('span');
    rating.className = 'pc-rating' + (p.rating ? '' : ' empty');
    rating.textContent = ratingText(p.rating);
    metadata.appendChild(rating);
    for (const category of papers.paperCategories(p)) {
      const chip = document.createElement('span');
      chip.className = 'metadata-chip category';
      chip.textContent = category;
      metadata.appendChild(chip);
    }
    for (const tag of papers.paperTags(p)) {
      const chip = document.createElement('span');
      chip.className = 'metadata-chip tag';
      chip.textContent = `#${tag}`;
      metadata.appendChild(chip);
    }

    const actions = document.createElement('div');
    actions.className = 'pc-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'btn small primary';
    openBtn.type = 'button';
    openBtn.textContent = '继续阅读';
    openBtn.onclick = event => { event.stopPropagation(); openPaper(p); };
    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.type = 'button';
    delBtn.textContent = '删除';
    delBtn.onclick = async event => {
      event.stopPropagation();
      if (!confirm(`确定删除「${p.title.slice(0, 40)}…」及其精读记录？`)) return;
      const deletingCurrent = current?.id === p.id;
      await papers.removeRecord(p.id);
      if (deletingCurrent) await abandonPaper();
      else refreshLibrary();
    };
    actions.append(openBtn, delBtn);

    card.append(title, sub, metadata, actions);
    card.onclick = () => openPaper(p);
    list.appendChild(card);
  }
}

// ---------------- 阅读位置 ----------------
// tab 切换、精读节点击、PDF 翻页、离开论文时保存；500ms 防抖；写入失败静默。

function positionSnapshot(paper) {
  return view.snapshotPosition({
    ...reader,
    sourceSectionId: sourceTab || reader.sourceSectionId,
    pdfPage: pdfDocument ? pdfPage : reader.pdfPage,
  }, paper.id);
}

function schedulePositionSave() {
  if (!current) return;
  const paper = current;
  clearTimeout(positionTimer);
  positionTimer = setTimeout(async () => {
    positionTimer = null;
    if (current !== paper) return;
    try { await store.positions.put(positionSnapshot(paper)); } catch { /* 失败静默 */ }
  }, 500);
}

// 离开论文前立即落一次位置（不等防抖），目标论文显式传入。
async function flushPositionSave(paper) {
  clearTimeout(positionTimer);
  positionTimer = null;
  if (!paper) return;
  try { await store.positions.put(positionSnapshot(paper)); } catch { /* 失败静默 */ }
}

// ---------------- 阅读视图 ----------------
async function openPaper(p) {
  if (current?.id === p.id) {
    showView('reader');
    return;
  }
  if (view.shouldCancelTasks(
    { type: 'open-paper', paperId: p.id },
    { paperOpen: !!current, currentPaperId: current?.id },
  )) {
    await abandonPaper({ keepView: true });
  }

  revokeRecallBlobUrls();
  current = p;
  currentMapped = null;
  chatComposer = emptyBinding();
  composerQuoteExpanded = false;
  mentionItems = [];
  mentionOpen = false;
  pendingSourceHits = [];
  chatQuoteExpanded = new Set();
  sourceTab = 'abstract';
  pdfPage = 1;
  pdfScale = 1;
  $('#paste-area').value = '';
  $('#reader-title').textContent = p.title;
  setWindowTitle(`${p.title} · Paper30Min`);
  reader = view.openPaper(reader, {
    hasMap: hasMapProduct(p.products),
    mapping: isMappingPaper(p.id),
  });
  renderReaderChrome({ restore: true });
  await refreshMapped(p);
  if (current !== p) return;
  reader = view.setHasMap(reader, hasMapProduct(p.products));
  if (currentMapped) sourceTab = '__full';
  reader = view.setSourceSection(reader, sourceTab);
  renderRecall();
  renderSource();
  renderChat();
  let restored = null;
  try { restored = await store.positions.get(p.id); } catch { restored = null; }
  if (restored && current === p) {
    const validPartIds = papers.readingParts(p).map(def => def.id);
    reader = view.applyPosition(reader, restored, { validPartIds });
    if (reader.tab === 'source' && restored.sectionId) sourceTab = restored.sectionId;
    if (Number.isFinite(restored.pdfPage)) pdfPage = restored.pdfPage;
  }
  renderReaderChrome({ restore: true });
  if (reader.tab === 'source') renderSource();
  if (reader.tab === 'chat') renderChat();
  if (reader.tab === 'recall') renderRecall();
  initPdfViewer();
}

async function abandonPaper({ keepView = false } = {}) {
  const paper = current;
  if (paper) await flushPositionSave(paper);
  destroyPdfViewer();
  const settling = paper ? generation.cancelForPaper(paper) : null;
  chatAborter?.abort();
  translateAborter?.abort();
  recallAborter?.abort();
  current = null;
  currentMapped = null;
  chatComposer = emptyBinding();
  hideSourceAskFloat();
  hideMentionMenu();
  revokeRecallBlobUrls();
  reader = view.closePaper(reader);
  if (!keepView) renderReaderChrome({ restore: true });
  if (settling) await settling.catch(() => {});
  if (!keepView) refreshLibrary();
}

function switchTab(name, { restore = false } = {}) {
  commitReader(view.switchTab(reader, name), { restore });
  if (name === 'source') renderSource();
  if (name === 'chat') renderChat();
  if (name === 'recall') renderRecall();
}

function updateReaderMeta() {
  if (!current) return;
  const categories = papers.paperCategories(current);
  const tags = papers.paperTags(current);
  const details = [
    current.numPages ? `${current.numPages} 页` : '',
    `导入于 ${fmtDate(current.addedAt)}`,
    ratingText(current.rating),
    categories.join(' · '),
    tags.length ? tags.map(tag => `#${tag}`).join(' ') : '',
  ].filter(Boolean);
  $('#reader-meta').textContent = details.join(' · ');
  updateStreakBadge();
  const chip = $('#map-progress-chip');
  if (chip) {
    const { done, total } = papers.readingProgress(current);
    chip.textContent = `${done}/${total} 已读完`;
  }
}

// ---------------- 地图 tab（落地 / 地图页 / 节页内容） ----------------
function mapNavItems() {
  if (currentMapped?.sections?.length) return view.treeItems(currentMapped);
  return papers.readingParts(current).map(part => ({
    id: part.id,
    title: part.pickerLabel || part.label,
    grey: false,
  }));
}

function navTitleById(id) {
  return mapNavItems().find(item => item.id === id)?.title || id;
}

function sessionTaskList() {
  return [...sessionTasks.entries()].map(([taskId, meta]) => ({
    taskId,
    kind: meta.kind,
    input: meta.input,
    status: meta.status,
  }));
}

function openProtocolTaskMeta(paperId, kind) {
  for (const [taskId, meta] of sessionTasks) {
    if (meta.kind !== kind || meta.input?.paperId !== paperId) continue;
    if (meta.status && isTerminalStatus(meta.status)) continue;
    return { taskId, meta };
  }
  return null;
}

function mappingStageOf(paperId) {
  return openProtocolTaskMeta(paperId, PROTOCOL_TASKS.buildMap)?.meta.lastStage || null;
}

function diveRunningDetail(paperId) {
  return openProtocolTaskMeta(paperId, PROTOCOL_TASKS.deepDive)?.meta.lastDetail || null;
}

function citeChipHtml(raw) {
  const safe = escapeTemplate(raw);
  return `<button type="button" class="cite-chip" data-cite="${safe}">${safe}</button>`;
}

function citedHtml(text) {
  return citeSegments(text).map(part => (
    part.type === 'text' ? escapeTemplate(part.text) : citeChipHtml(part.raw)
  )).join('');
}

function refsHtml(refs) {
  return (refs || []).map(citeChipHtml).join(' ');
}

function renderCitedMarkdownInto(element, text) {
  element.innerHTML = linkifyCiteHtml(renderMarkdown(text));
  typesetMath(element);
}

function renderLanding(surface) {
  const model = landingModel({
    paper: current,
    hasMap: surface === 'map' || surface === 'section',
    mapping: surface === 'landing-running',
    mappingStage: mappingStageOf(current.id),
  });
  const landing = $('#map-landing');
  const split = $('#map-split');
  landing.hidden = model.surface !== 'landing-idle' && model.surface !== 'landing-running';
  split.hidden = model.surface === 'landing-idle' || model.surface === 'landing-running';
  $('#map-landing-title').textContent = model.heading || COPY.landingIdle;
  const paperLine = $('#map-landing-paper');
  const paperBits = [model.paperTitle, model.paperMeta].filter(Boolean).join(' · ');
  paperLine.textContent = paperBits;
  paperLine.hidden = !paperBits;
  $('#map-landing-copy').textContent = model.copy || COPY.landingCopy;
  $('#map-landing-progress').hidden = !model.showProgress;
  $('#map-landing-progress').textContent = model.progressText || COPY.landingProgress;
  const start = $('#btn-build-map');
  start.hidden = !model.showStart;
  start.textContent = model.startLabel || COPY.startMap;
}

function renderMapPage() {
  const page = mapPageModel({
    products: current.products,
    mapped: currentMapped,
    synthesizing: isSynthesizingPaper(current.id),
  });
  const empty = '<p class="muted">（尚未生成）</p>';
  const contributions = page.contributions.length
    ? `<ul>${page.contributions.map(item => `<li>${citedHtml(item.text)} ${refsHtml(item.refs)}</li>`).join('')}</ul>`
    : empty;
  const evidence = page.keyEvidence.length
    ? page.keyEvidence.map(item => {
      const cite = `(${item.assetId})`;
      const note = item.note ? escapeTemplate(item.note) : '';
      return `${citeChipHtml(cite)} ${note} ${refsHtml(item.refs)}`;
    }).join('<br>')
    : empty;
  const glossary = page.glossary.length
    ? page.glossary.map(item => `${escapeTemplate(item.term)} ${item.defRef ? citeChipHtml(item.defRef) : ''}`).join('　')
    : empty;
  let retell = `<p class="muted">手动触发 · 输入 = L1 + 全部 L2 + 已有深挖 · 未深挖节将标注「未经深挖核验」</p>`;
  if (page.retell.state === 'running') {
    retell += `<p>正在生成复述稿</p><button class="btn small" type="button" data-action="cancel-synth">取消</button>`;
  } else if (page.retell.state === 'done') {
    retell += `<div class="md retell-body"></div><div class="dig-head"><button class="btn small" type="button" data-action="resynthesize">${escapeTemplate(page.retell.primaryLabel)}</button></div>`;
  } else {
    retell += `<button class="btn primary" type="button" data-action="synthesize">${escapeTemplate(page.retell.primaryLabel)}</button>`;
    if (page.retell.hint) retell += `<span class="muted"> ${escapeTemplate(page.retell.hint)}</span>`;
  }
  const body = $('#map-page-body');
  body.innerHTML = `
    <div class="card map-sec"><h3>要解决的问题</h3>${page.problem.text ? `<p>${citedHtml(page.problem.text)} ${refsHtml(page.problem.refs)}</p>` : empty}</div>
    <div class="card map-sec"><h3>方法概述</h3>${page.method.text ? `<p>${citedHtml(page.method.text)} ${refsHtml(page.method.refs)}</p>` : empty}</div>
    <div class="card map-sec"><h3>贡献声明</h3>${contributions}</div>
    <div class="card map-sec"><h3>关键证据</h3>${evidence}</div>
    <div class="card map-sec"><h3>术语表</h3><p>${glossary}</p></div>
    <div class="card map-sec" id="retell-block"><h3>复述稿（综合）</h3>${retell}</div>
  `;
  const retellBody = body.querySelector('.retell-body');
  if (retellBody && page.retell.body) renderCitedMarkdownInto(retellBody, page.retell.body);
}

function renderSectionPage() {
  const model = sectionPageModel({
    partId: reader.sectionId,
    mapped: currentMapped,
    products: current.products,
    paper: current,
    runningPartIds: runningDeepDivePartIds(sessionTaskList(), current.id),
    runningDetail: diveRunningDetail(current.id),
    citeFocus: reader.citeFocus,
  });
  const paper = current;
  const busy = isDeepDivingPaper(current.id) && model.deepDive.state !== 'running';
  let l2 = '';
  if (model.l2) {
    const points = model.l2.points.map(item => `<li>${citedHtml(item.text || '')} ${refsHtml(item.refs)}</li>`).join('');
    const assets = (model.l2.keyAssets || []).map(id => citeChipHtml(`(${id})`)).join(' ');
    const pages = model.l2.pages ? `页码 p${model.l2.pages.start}–p${model.l2.pages.end}` : '';
    l2 = `<div class="card l2-card">
      <div class="chip" style="margin-bottom:6px">L2 节薄摘要</div>
      <div class="gist">${citedHtml(model.l2.gist)}</div>
      ${points ? `<ul>${points}</ul>` : ''}
      <div class="muted">${assets}${assets && pages ? ' · ' : ''}${escapeTemplate(pages)}</div>
    </div>`;
  }
  let dig = '<div class="card dig-zone">';
  if (model.deepDive.state === 'skipped') {
    dig += `<div class="dig-empty muted">${escapeTemplate(model.deepDive.hint)}</div>`;
  } else if (model.deepDive.state === 'running') {
    dig += `<div class="dig-empty"><p>${escapeTemplate(model.deepDive.progressText)}</p>
      <button class="btn small" type="button" data-action="cancel-dig">取消</button></div>`;
  } else if (model.deepDive.state === 'done') {
    dig += `<div class="dig-head"><span class="chip">L3 深挖结果</span><span style="flex:1"></span>
      <button class="btn small" type="button" data-action="redig">${escapeTemplate(model.deepDive.primaryLabel)}</button>
      <button class="btn small ghost" type="button" data-action="trace">${escapeTemplate(model.deepDive.traceLabel)}</button></div>
      <div class="dig-result md"></div>`;
  } else {
    dig += `<div class="dig-empty"><p class="muted">本节尚未深挖</p>
      <button class="btn primary" type="button" data-action="start-dig"${busy ? ' disabled' : ''}>▶ ${escapeTemplate(model.deepDive.primaryLabel)}</button>
      <p class="muted">配方打底 + 工具越界取证；深挖任务在任务中心可回看步骤</p></div>`;
  }
  dig += '</div>';
  let figs = '';
  if (model.figures.length) {
    const cards = model.figures.map(item => {
      const focus = model.focusAssetId === item.id ? ' is-locate' : '';
      const cap = `${escapeTemplate(item.caption)}${item.page ? ` (p${item.page})` : ''}`;
      return `<div class="fig-box${focus}" id="asset-${escapeTemplate(item.id)}">
        <img alt="${escapeTemplate(item.caption)}" data-crop-id="${escapeTemplate(item.cropAssetId)}">
        <div class="fig-cap">${cap} ${citeChipHtml(`(${item.id})`)}</div>
      </div>`;
    }).join('');
    figs = `<div class="card fig-zone"><h4>图表区</h4><div class="fig-grid">${cards}</div></div>`;
  }
  const mark = model.showMark
    ? `<button class="btn mark-switch${model.marked ? ' on' : ''}" type="button" data-action="mark">${escapeTemplate(model.markLabel)}</button>`
    : '';
  const foot = `<div class="card sec-foot">${mark}
    <button class="btn ghost" type="button" data-action="read-source">${escapeTemplate(model.readSourceLabel)}</button>
    <span style="flex:1"></span>
    <span class="muted">${escapeTemplate(model.pagesLabel)}</span>
  </div>`;
  const legacy = model.legacyAnalysis
    ? `<details class="card legacy-analysis"><summary>${escapeTemplate(COPY.legacyTitle)}</summary><div class="md legacy-body"></div></details>`
    : '';
  const body = $('#section-page-body');
  body.innerHTML = `${l2}${dig}${figs}${foot}${legacy}`;
  const result = body.querySelector('.dig-result');
  if (result && model.deepDive.body) renderCitedMarkdownInto(result, model.deepDive.body);
  const legacyBody = body.querySelector('.legacy-body');
  if (legacyBody) renderCitedMarkdownInto(legacyBody, model.legacyAnalysis.text);
  fillCropImages(body, paper).then(() => {
    if (current !== paper) return;
    focusAsset(model.focusAssetId);
  });
}

async function fillCropImages(root, paper) {
  const imgs = [...root.querySelectorAll('img[data-crop-id]')];
  if (!imgs.length) return;
  const ids = [...new Set(imgs.map(img => img.dataset.cropId))];
  const crops = await loadCropDataUrls(paper, ids);
  if (current !== paper) return;
  for (const img of imgs) {
    const url = crops[img.dataset.cropId];
    if (url) img.src = url;
    else img.alt = `${img.alt}（加载失败）`;
  }
}

function focusAsset(assetId) {
  if (!assetId) return;
  const el = document.getElementById(`asset-${assetId}`);
  if (!el) return;
  el.classList.add('is-locate');
  el.scrollIntoView({ block: 'center' });
}

function currentSecIdForCite() {
  if (!reader.sectionId) return null;
  return sectionForPart(currentMapped, reader.sectionId)?.id
    || (currentMapped?.sections ?? []).find(section => section.id === reader.sectionId)?.id
    || null;
}

function applyCite(raw) {
  const pointer = typeof raw === 'string' ? parseRefs(raw)[0] : raw;
  if (!pointer) return;
  const next = view.routeCite(reader, pointer, { mapped: currentMapped, currentSecId: currentSecIdForCite() });
  commitReader(next);
  const focus = next.citeFocus;
  if (focus?.type === 'blocks') {
    renderSource();
    highlightLocate({
      cite: {
        startSecId: focus.secId,
        startBlock: focus.start,
        endSecId: focus.secId,
        endBlock: focus.end,
      },
    });
  } else if (focus?.type === 'asset') {
    focusAsset(focus.assetId);
  } else if (focus?.type === 'page') {
    if (pdfSidebarOpen && hasPdf() && !pdfDocument) initPdfViewer();
    else if (pdfDocument) renderPdfPage();
  }
}

function onProtocolContentClick(event) {
  const cite = event.target.closest('[data-cite]');
  if (cite) {
    event.preventDefault();
    applyCite(cite.dataset.cite);
    return;
  }
  const btn = event.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  event.preventDefault();
  handleProtocolAction(btn.dataset.action);
}

function handleProtocolAction(action) {
  if (action === 'synthesize') {
    startSynthesize(false).catch(err => toast(errorText(err), true));
    return;
  }
  if (action === 'resynthesize') {
    if (!confirm(COPY.overwriteRetell)) return;
    startSynthesize(true).catch(err => toast(errorText(err), true));
    return;
  }
  if (action === 'cancel-synth') {
    cancelOpenProtocolTask(PROTOCOL_TASKS.synthesize);
    return;
  }
  if (action === 'start-dig' || action === 'redig') {
    startSectionDive(action === 'redig').catch(err => toast(errorText(err), true));
    return;
  }
  if (action === 'cancel-dig') {
    cancelOpenProtocolTask(PROTOCOL_TASKS.deepDive);
    return;
  }
  if (action === 'trace') {
    const taskId = traceTaskId(sessionTaskList(), { paperId: current?.id, partId: reader.sectionId });
    jumpToTask(taskId).catch(err => toast(errorText(err), true));
    return;
  }
  if (action === 'mark') {
    toggleSectionMark().catch(err => toast(errorText(err), true));
    return;
  }
  if (action === 'read-source') {
    readSectionSource(reader.sectionId);
  }
}

function renderMapTab() {
  if (!current) return;
  const surface = view.mapSurface(reader);
  renderLanding(surface);

  const tree = $('#map-tree');
  tree.classList.toggle('rail', reader.treeCollapsed);
  applyTreeWidth();

  $('#map-page').hidden = surface !== 'map';
  $('#section-page').hidden = surface !== 'section';
  $('#btn-tree-map').classList.toggle('cur', surface === 'map');
  if (surface === 'section') {
    const title = navTitleById(reader.sectionId);
    $('#section-page-title').textContent = title;
    $('#btn-back-map').textContent = `← 地图 / ${title}`;
  }

  const items = $('#map-tree-items');
  items.innerHTML = '';
  for (const item of mapNavItems()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tree-item' + (item.grey ? ' grey' : '') + (reader.sectionId === item.id ? ' cur' : '');
    const note = item.grey ? '<span class="muted tree-l2-note">不参与 L2</span>' : '';
    const dot = view.treeItemStatus(item.id, {
      readMarks: current.readMarks,
      products: current.products,
      grey: item.grey,
    });
    button.innerHTML = `<span class="dot ${dot}"></span><span class="tname">${escapeTemplate(item.title)}</span>${note}`;
    button.onclick = () => drillSection(item.id);
    items.appendChild(button);
  }
  const partIds = view.deepAllPartIds(currentMapped);
  const deepBtn = $('#btn-deep-all');
  deepBtn.disabled = !reader.hasMap || partIds.length === 0 || isDeepDivingPaper(current.id);
  if (surface === 'map') renderMapPage();
  if (surface === 'section') renderSectionPage();
  updateReaderMeta();
  updatePaneFabs();
}

function drillSection(sectionId) {
  commitReader(view.openSection(reader, sectionId, { mapped: currentMapped }));
  if (pdfSidebarOpen && pdfDocument && Number.isFinite(pdfPage)) renderPdfPage();
}

function backToMap() {
  commitReader(view.backToMap(reader));
}

function readSectionSource(partId) {
  const section = sectionForPart(currentMapped, partId)
    || (currentMapped?.sections ?? []).find(item => item.id === partId);
  const secId = section?.id || partId;
  commitReader(view.setSourceSection(view.switchTab(reader, 'source'), secId));
  sourceTab = secId;
  renderSource();
  highlightLocate({ secId });
}

async function toggleSectionMark() {
  if (!current || !reader.sectionId) return;
  const marked = current.readMarks?.[reader.sectionId] == null;
  await papers.setReadMark(current, reader.sectionId, marked);
  renderMapTab();
}

async function jumpToTask(taskId) {
  showView('tasks');
  await pollTasks();
  if (!taskId) return;
  const row = document.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
  if (!row) return;
  row.classList.add('is-locate');
  row.scrollIntoView({ block: 'center' });
}

async function refreshPaperRecord(paperId) {
  if (!paperId) return null;
  try {
    const fresh = await store.get(paperId);
    if (!fresh) return null;
    const idx = library.findIndex(item => item.id === fresh.id);
    if (idx >= 0) library[idx] = fresh;
    if (current?.id === fresh.id) {
      current = fresh;
      reader = view.setHasMap(reader, hasMapProduct(fresh.products));
    }
    return fresh;
  } catch {
    return null;
  }
}

async function cancelOpenProtocolTask(kind) {
  const open = openProtocolTaskMeta(current?.id, kind);
  if (!open) return;
  try {
    await bridge.invoke('tasks.cancel@1', { taskId: open.taskId });
  } catch (err) {
    toast(`取消失败：${errorText(err)}`, true);
  }
}

// ---------------- 建图前置产物（#73）----------------
// 建图 preflight 依赖块模型/页图/裁切图，由 pdfparse.convert@1 → pdfassets.prerender@1
// 串行生产。三处接线：本地 PDF 导入后、arXiv PDF 关联后自动排队；「开始建图」前兜底补齐。
// 两任务都进会话登记（任务中心可见、失败可重试）；链路幂等：块模型已在库直接返回。

// 论文记录只挂 pdfAttachment 句柄，附件全集要查 files.listAttachments@1（store.js attachPdfInfo 同缝）。
async function paperAttachmentIds(paperId) {
  try {
    const result = await bridge.invoke('files.listAttachments@1', { paperId });
    return new Set((result?.attachments || []).map(attachment => attachment.id));
  } catch {
    return new Set();
  }
}

/** 该论文是否已有在途的解析/预渲染任务（防导入自动排队与建图兜底双开同一链路）。 */
function hasOpenPreflightTask(paperId) {
  for (const meta of sessionTasks.values()) {
    if (meta.kind !== 'pdfparse.convert@1' && meta.kind !== 'pdfassets.prerender@1') continue;
    if (meta.input?.paperId !== paperId) continue;
    if (meta.status && isTerminalStatus(meta.status)) continue;
    return true;
  }
  return false;
}

/** 串行跑 convert → prerender。任一步失败 toast 并返回 false；无 PDF 附件返回 false。 */
async function runPreflightChain(paperId) {
  const ids = await paperAttachmentIds(paperId);
  if (ids.has('blockmodel.json')) return true;
  if (!ids.has('pdf')) return false;
  if (hasOpenPreflightTask(paperId)) return false;
  try {
    const convertInput = { paperId };
    const { taskId: convertId } = await bridge.start('pdfparse.convert@1', convertInput);
    registerSessionTask(convertId, {
      kind: 'pdfparse.convert@1',
      input: convertInput,
      retry: () => runPreflightChain(paperId),
    });
    const convert = await trackTask(bridge, convertId, {});
    if (convert.status !== 'succeeded') {
      if (convert.status === 'failed') toast(`PDF 解析失败：${convert.error?.message || '未知错误'}`, true);
      return false;
    }
    const doclingJsonPath = convert.result?.doclingJsonPath;
    if (!doclingJsonPath) {
      toast('PDF 解析结果缺少 doclingJsonPath', true);
      return false;
    }
    const prerenderInput = { paperId, doclingJsonPath };
    const { taskId: prerenderId } = await bridge.start('pdfassets.prerender@1', prerenderInput);
    registerSessionTask(prerenderId, {
      kind: 'pdfassets.prerender@1',
      input: prerenderInput,
      retry: () => runPreflightChain(paperId),
    });
    const prerender = await trackTask(bridge, prerenderId, {});
    if (prerender.status !== 'succeeded') {
      if (prerender.status === 'failed') toast(`页图预渲染失败：${prerender.error?.message || '未知错误'}`, true);
      return false;
    }
    await refreshPaperRecord(paperId);
    return true;
  } catch (err) {
    toast(`建图前置准备失败：${errorText(err)}`, true);
    return false;
  }
}

async function startBuildMap() {
  if (!current || isMappingPaper(current.id) || !ensureSettings()) return;
  const paperId = current.id;
  // 前置兜底：缺块模型且有 PDF 时先补产（#73），链路失败则不发起建图（preflight 必失败）。
  const preflightIds = await paperAttachmentIds(paperId);
  if (!preflightIds.has('blockmodel.json') && preflightIds.has('pdf')) {
    if (hasOpenPreflightTask(paperId)) {
      toast('正在解析与预渲染，完成后请再点「开始建图」');
      return;
    }
    toast('正在准备建图：先解析 PDF 并预渲染页图…');
    const ready = await runPreflightChain(paperId);
    if (!ready) return;
  }
  const input = { paperId, overwriteConfirmed: false };
  let meta = null;
  try {
    const { taskId } = await bridge.start(PROTOCOL_TASKS.buildMap, input);
    meta = {
      kind: PROTOCOL_TASKS.buildMap,
      input,
      lastStage: null,
      retry: () => startBuildMap(),
    };
    registerSessionTask(taskId, meta);
    reader = view.setMapping(reader, true);
    renderMapTab();
    toast('已开始建图');
    const { status, error } = await trackTask(bridge, taskId, {
      onEvent: event => {
        if (event.event === 'stage' && event.detail?.stage) {
          meta.lastStage = event.detail.stage;
          // 完整阶段载荷（含 map-l2 分片 shard/shards）供任务中心阶段流呈现。
          meta.stageDetail = event.detail;
          if (current?.id === paperId) renderMapTab();
        }
      },
    });
    meta.status = status;
    await refreshPaperRecord(paperId);
    if (current?.id === paperId) {
      await refreshMapped(current);
      if (reader.tab === 'source') renderSource();
      if (reader.tab === 'chat') renderChat();
      if (reader.tab === 'recall') renderRecall();
    }
    if (status === 'failed') toast(error?.message || '建图失败', true);
    else if (status === 'succeeded') toast('建图已完成');
  } catch (err) {
    if (meta && !meta.status) meta.status = 'failed';
    toast(errorText(err), true);
  } finally {
    if (current?.id === paperId) {
      reader = view.setMapping(reader, isMappingPaper(paperId));
      if (reader.appView === 'reader') renderMapTab();
    }
  }
}

async function startSynthesize(overwriteConfirmed) {
  if (!current || isSynthesizingPaper(current.id) || !ensureSettings()) return;
  const paperId = current.id;
  const input = { paperId, overwriteConfirmed: !!overwriteConfirmed };
  let meta = null;
  try {
    const { taskId } = await bridge.start(PROTOCOL_TASKS.synthesize, input);
    meta = {
      kind: PROTOCOL_TASKS.synthesize,
      input,
      retry: () => startSynthesize(true),
    };
    registerSessionTask(taskId, meta);
    if (current?.id === paperId) renderMapTab();
    toast('已开始生成复述稿');
    const { status, error } = await trackTask(bridge, taskId, {});
    meta.status = status;
    await refreshPaperRecord(paperId);
    if (status === 'failed') toast(error?.message || '复述稿生成失败', true);
    else if (status === 'succeeded') toast('复述稿已生成');
  } catch (err) {
    if (meta && !meta.status) meta.status = 'failed';
    toast(errorText(err), true);
  } finally {
    if (current?.id === paperId && reader.appView === 'reader') renderMapTab();
  }
}

async function startDeepAll() {
  if (!current || !currentMapped || !ensureSettings()) return;
  const partIds = view.deepAllPartIds(currentMapped);
  if (!partIds.length || isDeepDivingPaper(current.id)) return;
  await startDeepDive(current.id, partIds);
}

async function startSectionDive(overwrite) {
  if (!current || !reader.sectionId || !ensureSettings()) return;
  if (isDeepDivingPaper(current.id)) {
    toast('已有深挖任务进行中', true);
    return;
  }
  if (overwrite && !confirm(COPY.overwriteDive)) return;
  await startDeepDive(current.id, [reader.sectionId]);
}

async function startDeepDive(paperId, partIds) {
  if (!paperId || !partIds?.length) return;
  const input = { paperId, partIds };
  const batch = partIds.length > 1;
  let meta = null;
  try {
    const { taskId } = await bridge.start(PROTOCOL_TASKS.deepDive, input);
    meta = {
      kind: PROTOCOL_TASKS.deepDive,
      input,
      lastDetail: null,
      steps: [],
      retry: () => startDeepDive(paperId, partIds),
    };
    registerSessionTask(taskId, meta);
    if (current?.id === paperId) renderMapTab();
    toast(batch ? '已开始全部深挖' : '已开始深挖');
    const { status, error } = await trackTask(bridge, taskId, {
      onEvent: event => {
        if (event.event === 'stage' && event.detail) {
          meta.lastDetail = event.detail;
          if (current?.id === paperId) renderMapTab();
        } else if (event.event === 'tool' && event.detail) {
          // 取证轨迹逐步累积，任务中心步骤流与「取证轨迹 →」回看共用（#56 决策 13）。
          meta.steps.push(event.detail);
          if (meta.steps.length > SESSION_STEPS_CAP) meta.steps.splice(0, meta.steps.length - SESSION_STEPS_CAP);
        }
      },
    });
    meta.status = status;
    await refreshPaperRecord(paperId);
    if (status === 'failed') toast(error?.message || '深挖失败', true);
    else if (status === 'succeeded') toast(batch ? '全部深挖已完成' : '深挖已完成');
  } catch (err) {
    if (meta && !meta.status) meta.status = 'failed';
    toast(errorText(err), true);
  } finally {
    if (current?.id === paperId && reader.appView === 'reader') renderMapTab();
  }
}

// ---------------- 回忆卡 ----------------
function recallCard() {
  return current?.recallCard || { markdown: '', images: [], updatedAt: 0 };
}

function updateRecallPreview() {
  const preview = $('#recall-preview');
  const markdown = $('#recall-editor').value.trim();
  preview.classList.toggle('empty-hint', !markdown);
  if (markdown) renderMarkdownInto(preview, markdown);
  else preview.textContent = '尚未生成或填写回想卡片。';
}

function revokeRecallBlobUrls() {
  for (const url of recallBlobUrls.values()) URL.revokeObjectURL(url);
  recallBlobUrls.clear();
}

// 图片改走附件：有 attachmentId 的经 files.readRange@1 取字节转 Blob URL；
// 只有 dataUrl 的（浏览器迁移来的老数据）直接渲染。
function renderRecallImages() {
  const gallery = $('#recall-image-gallery');
  gallery.innerHTML = '';
  const images = recallCard().images || [];
  gallery.hidden = images.length === 0;
  const paper = current;
  for (const image of images) {
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.alt = image.name || '回想卡片图片';
    if (image.dataUrl) {
      img.src = image.dataUrl;
    } else if (image.attachmentId) {
      loadRecallImageAttachment(paper, image, img);
    } else {
      img.alt = `${img.alt}（缺少图片数据）`;
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recall-image-remove';
    remove.title = '移除图片';
    remove.setAttribute('aria-label', `移除图片 ${img.alt}`);
    remove.textContent = '×';
    remove.onclick = async () => {
      if (!confirm('从回想卡片中移除这张图片？')) return;
      const url = recallBlobUrls.get(image.id);
      if (url) { URL.revokeObjectURL(url); recallBlobUrls.delete(image.id); }
      await papers.removeRecallImage(current, image.id);
      renderRecallImages();
    };
    figure.append(img, remove);
    gallery.appendChild(figure);
  }
}

async function loadRecallImageAttachment(paper, image, img) {
  try {
    const meta = await bridge.invoke('files.getAttachment@1', { paperId: paper.id, attachmentId: image.attachmentId });
    const attachment = meta?.attachment;
    if (!attachment) throw new Error('附件不存在');
    const range = await bridge.invoke('files.readRange@1', {
      paperId: paper.id,
      attachmentId: image.attachmentId,
      offset: 0,
      length: attachment.size,
    });
    const blob = new Blob([base64ToBytes(range.contentBase64)], { type: attachment.contentType || 'image/webp' });
    const url = URL.createObjectURL(blob);
    // 载入期间用户可能已离开该论文：不再赋值，立即回收。
    if (current !== paper) {
      URL.revokeObjectURL(url);
      return;
    }
    recallBlobUrls.set(image.id, url);
    img.src = url;
  } catch (err) {
    console.warn('回忆卡图片加载失败：', err);
    img.alt = `${image.name || '回想卡片图片'}（加载失败）`;
  }
}

function renderRecall() {
  if (!current) return;
  const card = recallCard();
  const mapped = hasMapProduct(current.products);
  $('#recall-editor').value = card.markdown || '';
  $('#recall-status').textContent = card.updatedAt ? `已保存 · ${fmtDate(card.updatedAt)}` : '';
  const generate = $('#btn-recall-generate');
  generate.textContent = card.markdown ? '重新生成 AI 草稿' : '生成 AI 草稿';
  generate.disabled = !mapped;
  generate.title = mapped ? '' : '未建图：AI 草稿须先完成建图。';
  updateRecallPreview();
  renderRecallImages();
}

async function saveRecallCard({ silent = false } = {}) {
  await papers.saveRecallCard(current, $('#recall-editor').value.trim(), recallCard().images || []);
  $('#recall-status').textContent = `已保存 · ${fmtDate(Date.now())}`;
  $('#btn-recall-generate').textContent = current.recallCard.markdown ? '重新生成 AI 草稿' : '生成 AI 草稿';
  if (!silent) toast('回想卡片已保存');
}

async function generateRecallDraft() {
  if (!hasMapProduct(current?.products)) {
    toast('未建图：AI 草稿须先完成建图。', true);
    return;
  }
  if (!ensureSettings()) return;
  const source = recallDraftMaterial(current.products).slice(0, 32000);
  if (!source.trim()) return toast('暂无协议产物可生成草稿', true);
  if ($('#recall-editor').value.trim() && !confirm('重新生成会覆盖当前卡片文字，已添加的图片会保留。继续吗？')) return;

  const messages = [
    {
      role: 'system',
      content: '你是论文回忆卡编辑器。根据阅读地图、节薄摘要与深挖结果生成高度凝练、事实准确、便于快速复习的中文 Markdown 卡片。不要复述章节结构，不要编造材料中没有的信息。',
    },
    {
      role: 'user',
      content: `论文标题：${current.title}\n\n协议产物：\n${source}\n\n请严格使用以下结构：\n## 一句话回忆\n一句话说明这项工作解决什么问题、如何解决。\n\n## 主要贡献\n- 2 至 4 条最重要贡献\n\n## 核心创新\n- 2 至 4 条方法或设计创新，并说明为什么有效\n\n## 关键证据\n- 最能支撑结论的实验结果或消融\n\n## 使用边界\n- 局限、适用条件或需要继续确认的问题`,
    },
  ];
  const editor = $('#recall-editor');
  const button = $('#btn-recall-generate');
  button.disabled = true;
  $('#btn-recall-stop').hidden = false;
  $('#recall-status').textContent = '生成中…';
  recallAborter = new AbortController();
  try {
    const text = await model.chat(messages, {
      stream: true,
      signal: recallAborter.signal,
      onDelta: full => {
        editor.value = full;
        updateRecallPreview();
      },
      // 任务中心「重试」：重跑回想卡片草稿生成。
      retry: () => { void generateRecallDraft(); },
    });
    if (!text.trim()) throw new Error('模型未返回卡片内容');
    editor.value = text;
    updateRecallPreview();
    await saveRecallCard({ silent: true });
    toast('AI 草稿已生成，可以继续编辑');
  } catch (err) {
    if (err.name === 'AbortError') $('#recall-status').textContent = '已停止，当前文字尚未保存';
    else {
      $('#recall-status').textContent = '生成失败';
      toast(err.message, true);
    }
  } finally {
    button.disabled = !hasMapProduct(current?.products);
    $('#btn-recall-stop').hidden = true;
    recallAborter = null;
  }
}

// canvas 压缩到 ≤1600px webp；解码失败时保留原始字节。返回字节与真实 contentType。
async function prepareRecallImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 12 * 1024 * 1024) throw new Error('单张图片不能超过 12 MB');
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: 'image/webp' };
  } catch { /* 不支持解码时保留原图 */ }
  return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type || 'application/octet-stream' };
}

async function addRecallImages(files) {
  const imageFiles = [...files].filter(file => file.type?.startsWith('image/'));
  if (!imageFiles.length) return;
  const existing = recallCard().images || [];
  if (existing.length + imageFiles.length > 8) return toast('每张回想卡片最多保存 8 张图片', true);
  try {
    const additions = [];
    for (const file of imageFiles) {
      const prepared = await prepareRecallImage(file);
      const attachmentId = `recall-${papers.uid()}`;
      await bridge.invoke('files.putAttachment@1', {
        paperId: current.id,
        attachment: {
          id: attachmentId,
          name: file.name || '粘贴的图片',
          contentType: prepared.contentType,
          contentBase64: bytesToBase64(prepared.bytes),
        },
      });
      additions.push({ id: papers.uid(), name: file.name || '粘贴的图片', attachmentId });
    }
    await papers.saveRecallCard(current, $('#recall-editor').value.trim(), [...existing, ...additions]);
    renderRecallImages();
    $('#recall-status').textContent = `已保存 · ${fmtDate(Date.now())}`;
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- 原文视图 ----------------
function qaReady() {
  return !!(current && hasMapProduct(current.products) && currentMapped);
}

async function refreshMapped(paper) {
  if (!paper || !hasMapProduct(paper.products)) {
    currentMapped = null;
    return;
  }
  try {
    currentMapped = await loadBlockModel(paper);
  } catch {
    currentMapped = null;
  }
}

function clearComposerBinding() {
  chatComposer = emptyBinding();
  composerQuoteExpanded = false;
  hideMentionMenu();
  renderChatComposer();
}

function hideSourceAskFloat() {
  const btn = $('#source-ask-float');
  if (btn) btn.hidden = true;
  pendingSourceHits = [];
}

function startSectionAsk(section) {
  if (!qaReady()) {
    toast(QA_GATE_MESSAGE, true);
    return;
  }
  chatComposer = sectionBinding(section);
  composerQuoteExpanded = false;
  hideMentionMenu();
  renderChatComposer();
  switchTab('chat');
  const input = $('#chat-input');
  input.focus();
}

function startFragmentAsk(hits) {
  if (!qaReady()) {
    toast(QA_GATE_MESSAGE, true);
    return;
  }
  try {
    chatComposer = fragmentBinding(currentMapped, hits);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  composerQuoteExpanded = false;
  hideMentionMenu();
  hideSourceAskFloat();
  renderChatComposer();
  switchTab('chat');
  $('#chat-input').focus();
}

function locateBinding(locate) {
  if (!locate) return;
  if (!currentMapped) {
    toast('无法定位：块模型未加载', true);
    return;
  }
  switchTab('source');
  if (locate.type === 'section') {
    sourceTab = locate.secId || '__full';
    reader = view.setSourceSection(reader, sourceTab);
    renderSource();
    highlightLocate({ secId: locate.secId });
    return;
  }
  const cite = locate.cite;
  if (!cite) return;
  sourceTab = cite.startSecId === cite.endSecId ? cite.startSecId : '__full';
  reader = view.setSourceSection(reader, sourceTab);
  renderSource();
  highlightLocate({ cite });
}

function highlightLocate({ secId, cite }) {
  const nodes = $$('#source-doc [data-sec-id][data-block-id]');
  nodes.forEach(el => el.classList.remove('is-locate'));
  let first = null;
  if (cite) {
    let marking = false;
    for (const node of nodes) {
      const isStart = node.dataset.secId === cite.startSecId && Number(node.dataset.blockId) === Number(cite.startBlock);
      const isEnd = node.dataset.secId === cite.endSecId && Number(node.dataset.blockId) === Number(cite.endBlock);
      if (isStart) marking = true;
      if (marking) {
        node.classList.add('is-locate');
        if (!first) first = node;
      }
      if (isEnd) break;
    }
  } else if (secId) {
    for (const node of nodes) {
      if (node.dataset.secId !== secId) continue;
      node.classList.add('is-locate');
      if (!first) first = node;
    }
    const head = $(`#source-doc [data-sec-head="${secId}"]`);
    if (head) first = head;
  }
  first?.scrollIntoView({ block: 'center' });
}

function hitsFromSelection(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return [];
  const hits = [];
  for (const el of root.querySelectorAll('[data-sec-id][data-block-id]')) {
    const blockRange = document.createRange();
    blockRange.selectNodeContents(el);
    if (
      range.compareBoundaryPoints(Range.START_TO_END, blockRange) < 0
      && range.compareBoundaryPoints(Range.END_TO_START, blockRange) > 0
    ) {
      hits.push({ secId: el.dataset.secId, blockId: Number(el.dataset.blockId) });
    }
  }
  return hits;
}

function positionSourceAskFloat() {
  const sel = window.getSelection();
  const btn = $('#source-ask-float');
  if (!sel || sel.rangeCount === 0 || !btn) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  btn.hidden = false;
  btn.style.top = `${Math.round(rect.bottom + 8)}px`;
  btn.style.left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - 88)))}px`;
}

function onSourceMouseUp() {
  hideSourceAskFloat();
  const doc = $('#source-doc');
  if (!doc || doc.hidden || !qaReady()) return;
  const hits = hitsFromSelection(doc);
  if (!hits.length) return;
  pendingSourceHits = hits;
  positionSourceAskFloat();
}

function mappedSourceTab() {
  const sections = currentMapped?.sections ?? [];
  if (sourceTab === '__full') return '__full';
  if (sections.some(section => section.id === sourceTab)) return sourceTab;
  const byRole = sections.find(section => section.role === sourceTab);
  if (byRole) return byRole.id;
  const fromPart = sectionForPart(currentMapped, sourceTab);
  return fromPart?.id || '__full';
}

function appendSourceAskChip(wrap, section) {
  const group = document.createElement('span');
  group.className = 'source-chip-wrap';
  const chip = document.createElement('button');
  chip.className = 'chip' + (mappedSourceTab() === section.id ? ' active' : '');
  chip.type = 'button';
  chip.textContent = section.title || section.id;
  chip.onclick = () => { sourceTab = section.id; reader = view.setSourceSection(reader, section.id); renderSource(); };
  const ask = document.createElement('button');
  ask.className = 'chip-ask';
  ask.type = 'button';
  ask.textContent = '提问';
  ask.disabled = !qaReady();
  ask.title = qaReady() ? `就「${section.title || section.id}」提问` : QA_GATE_MESSAGE;
  ask.onclick = event => {
    event.stopPropagation();
    startSectionAsk(section);
  };
  group.append(chip, ask);
  wrap.appendChild(group);
}

function renderMappedSource() {
  const chips = $('#source-chips');
  chips.innerHTML = '';
  const tab = mappedSourceTab();
  sourceTab = tab;
  const full = document.createElement('button');
  full.className = 'chip' + (tab === '__full' ? ' active' : '');
  full.type = 'button';
  full.textContent = '全文';
  full.onclick = () => { sourceTab = '__full'; reader = view.setSourceSection(reader, '__full'); renderSource(); };
  chips.appendChild(full);
  for (const section of currentMapped.sections ?? []) {
    appendSourceAskChip(chips, section);
  }
  const hint = document.createElement('span');
  hint.className = 'muted';
  hint.textContent = '选中文本可浮动「提问」（含跨节选择）';
  chips.appendChild(hint);

  $('#source-text').hidden = true;
  $('#source-empty').hidden = true;
  const doc = $('#source-doc');
  doc.hidden = false;
  doc.innerHTML = '';
  const visible = tab === '__full'
    ? (currentMapped.sections ?? [])
    : (currentMapped.sections ?? []).filter(section => section.id === tab);
  for (const section of visible) {
    const head = document.createElement('div');
    head.className = 'src-sec-head';
    head.dataset.secHead = section.id;
    const title = document.createElement('h3');
    title.textContent = section.title || section.id;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${section.id} · p${section.pageStart}–p${section.pageEnd}`;
    const ask = document.createElement('button');
    ask.className = 'btn small';
    ask.type = 'button';
    ask.textContent = '提问';
    ask.disabled = !qaReady();
    ask.title = qaReady() ? '就本节提问' : QA_GATE_MESSAGE;
    ask.onclick = () => startSectionAsk(section);
    head.append(title, meta, ask);
    doc.appendChild(head);
    for (const block of section.blocks ?? []) {
      const el = document.createElement('p');
      el.className = 'src-block';
      el.dataset.secId = section.id;
      el.dataset.blockId = String(block.id);
      el.append(document.createTextNode(String(block.text ?? '')));
      if (block.page) {
        const pg = document.createElement('span');
        pg.className = 'src-pg';
        pg.textContent = `p${block.page}`;
        el.appendChild(pg);
      }
      doc.appendChild(el);
    }
  }
}

function renderLegacySource() {
  $('#source-text').hidden = false;
  $('#source-doc').hidden = true;
  const chips = $('#source-chips');
  chips.innerHTML = '';
  const paperDefs = papers.readingParts(current);
  const defs = [...paperDefs, { id: 'conclusion', label: 'Conclusion' }, { id: '__full', label: '全文' }];
  for (const def of defs) {
    const has = def.id === '__full' ? !!current.fullText : !!current.sections?.[def.id]?.trim();
    const chip = document.createElement('button');
    chip.className = 'chip' + (def.id === sourceTab ? ' active' : '');
    chip.type = 'button';
    chip.textContent = def.label + (has ? '' : '（缺）');
    chip.onclick = () => { sourceTab = def.id; reader = view.setSourceSection(reader, def.id); renderSource(); };
    chips.appendChild(chip);
  }
  const text = sourceTab === '__full' ? current.fullText : current.sections?.[sourceTab];
  const anySection = paperDefs.some(s => current.sections?.[s.id]?.trim());
  $('#source-empty').hidden = anySection;
  $('#source-text').textContent = text || (anySection ? '（本节未提取到内容）' : '');
}

function renderSource() {
  hideSourceAskFloat();
  if (!current) return;
  if (currentMapped) renderMappedSource();
  else renderLegacySource();
  syncTranslatePane();
}

function translationPartId() {
  if (sourceTab === '__full') return '__full';
  if (currentMapped) return partIdForSection(currentMapped, sourceTab) || sourceTab;
  return sourceTab;
}

function currentSectionSourceText() {
  if (!current) return '';
  if (sourceTab === '__full') return current.fullText || '';
  if (currentMapped) {
    const section = (currentMapped.sections ?? []).find(item => item.id === sourceTab);
    if (section) return (section.blocks ?? []).map(block => String(block.text ?? '')).join('\n\n');
  }
  return current.sections?.[sourceTab] || '';
}

function syncTranslatePane() {
  const pane = $('#source-translate-pane');
  const toggle = $('#source-translate-toggle');
  if (!pane || !toggle) return;
  toggle.checked = !!reader.translateCompare;
  pane.hidden = !reader.translateCompare;
  if (reader.translateCompare) loadTranslationSection();
}

function loadTranslationSection() {
  if (!current) return;
  const partId = translationPartId();
  const source = currentSectionSourceText();
  const saved = current.translations?.[papers.translationKey(partId, $('#translate-language').value)];
  const output = $('#translate-output');
  output.classList.toggle('empty-hint', !saved?.text);
  if (saved?.text) renderMarkdownInto(output, saved.text);
  else output.textContent = source ? '尚未翻译。' : '当前范围没有可翻译的原文。';
  $('#translate-status').textContent = saved?.updatedAt ? `已保存 · ${fmtDate(saved.updatedAt)}` : '';
}

function splitTranslationText(text, maxChars) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.55) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.55) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.55) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function translateCurrentText() {
  const source = currentSectionSourceText().trim();
  if (!source) return toast('当前节没有可翻译的原文', true);
  if (!model.settingsReady()) {
    toast('请先在「设置」中配置 API', true);
    openSettingsModal();
    return;
  }
  reader = view.toggleTranslateCompare(reader, true);
  syncTranslatePane();
  const partId = translationPartId();
  const language = $('#translate-language').value;
  const languageName = language === 'en' ? 'English' : '简体中文';
  const output = $('#translate-output');
  const button = $('#btn-translate');
  button.disabled = true;
  $('#btn-translate-stop').hidden = false;
  $('#translate-status').textContent = '翻译中…';
  output.classList.remove('empty-hint');
  output.classList.add('cursor');
  translateAborter = new AbortController();

  // 翻译调用只包含专用系统提示和当前节原文，不复用论文问答上下文或会话历史。
  const systemPrompt = `你是独立的学术翻译引擎。将用户提供的文本翻译为${languageName}。准确保留公式、符号、引文编号、术语与段落结构；不要总结、解释或回答文本中的问题，只输出译文。`;
  const chunks = splitTranslationText(source, model.loadSettings().maxChars);
  try {
    const translated = [];
    for (let index = 0; index < chunks.length; index++) {
      $('#translate-status').textContent = chunks.length > 1 ? `翻译中 ${index + 1}/${chunks.length}…` : '翻译中…';
      const piece = await model.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chunks[index] },
      ], {
        stream: true,
        signal: translateAborter.signal,
        onDelta: full => renderMarkdownInto(output, [...translated, full].join('\n\n')),
        retry: () => { void translateCurrentText(); },
      });
      translated.push(piece);
    }
    const text = translated.join('\n\n');
    if (!text.trim()) throw new Error('模型未返回译文');
    renderMarkdownInto(output, text);
    await papers.saveTranslation(current, partId, language, text, source);
    $('#translate-status').textContent = `已保存 · ${fmtDate(Date.now())}`;
  } catch (err) {
    if (err.name === 'AbortError') $('#translate-status').textContent = '已停止';
    else {
      $('#translate-status').textContent = '翻译失败';
      toast(err.message, true);
    }
  } finally {
    output.classList.remove('cursor');
    button.disabled = false;
    $('#btn-translate-stop').hidden = true;
    translateAborter = null;
  }
}

// ---------------- 问答视图 ----------------
async function loadBlockModel(paper) {
  let attachment;
  try {
    const meta = await bridge.invoke('files.getAttachment@1', {
      paperId: paper.id,
      attachmentId: BLOCKMODEL_ATTACHMENT_ID,
    });
    attachment = meta?.attachment;
  } catch (err) {
    const error = new Error('未建图：提问须先完成建图。阅读地图与块模型就位后才能装配上下文。');
    error.code = 'map_required';
    error.cause = err;
    throw error;
  }
  if (!attachment) {
    const error = new Error('未建图：提问须先完成建图。阅读地图与块模型就位后才能装配上下文。');
    error.code = 'map_required';
    throw error;
  }
  const range = await bridge.invoke('files.readRange@1', {
    paperId: paper.id,
    attachmentId: BLOCKMODEL_ATTACHMENT_ID,
    offset: 0,
    length: attachment.size,
  });
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(range.contentBase64)));
  } catch (err) {
    const error = new Error('块模型无法解析，请重新建图后再提问。');
    error.code = 'invalid_blockmodel';
    error.cause = err;
    throw error;
  }
}

async function loadCropDataUrls(paper, cropAssetIds) {
  const crops = {};
  for (const id of cropAssetIds) {
    try {
      const meta = await bridge.invoke('files.getAttachment@1', { paperId: paper.id, attachmentId: id });
      const attachment = meta?.attachment;
      if (!attachment) continue;
      const range = await bridge.invoke('files.readRange@1', {
        paperId: paper.id,
        attachmentId: id,
        offset: 0,
        length: attachment.size,
      });
      const mime = attachment.contentType || 'image/webp';
      crops[id] = `data:${mime};base64,${range.contentBase64}`;
    } catch (err) {
      console.warn(`裁切图 ${id} 读取失败：`, err);
    }
  }
  return crops;
}

async function assembleCurrentQa(paper, question, binding) {
  const mapped = await loadBlockModel(paper);
  const history = (paper.chat || []).slice(0, -1);
  const input = {
    title: paper.title,
    mapped,
    products: paper.products,
    history,
    question,
    binding,
  };
  const assembled = assembleQaContext(input);
  if (!assembled.cropAssetIds.length) return assembled.messages;
  const crops = await loadCropDataUrls(paper, assembled.cropAssetIds);
  const missing = assembled.cropAssetIds.filter(id => !crops[id]);
  if (missing.length) {
    const error = new Error(`片段覆盖的裁切图缺失：${missing.join('、')}。请先完成建图预渲染。`);
    error.code = 'preflight_missing';
    throw error;
  }
  return assembleQaContext({ ...input, crops }).messages;
}

function renderChat() {
  if (!current) return;
  const log = $('#chat-log');
  log.innerHTML = '';
  const msgs = current.chat || [];
  if (!msgs.length && qaReady()) {
    const hint = document.createElement('div');
    hint.className = 'empty';
    hint.style.padding = '24px';
    hint.textContent = '基于这篇论文作绑定提问或全文提问。输入 @ 绑定原文章节，或从原文选中片段。';
    log.appendChild(hint);
  } else if (msgs.length) {
    msgs.forEach((message, index) => appendChatBubble(message, '', index));
    log.scrollTop = log.scrollHeight;
  }
  renderChatComposer();
}

function renderBindingView(view, { composer = false, messageIndex = -1 } = {}) {
  if (view.kind === 'chip') {
    const wrap = document.createElement(composer ? 'span' : 'button');
    wrap.className = 'chat-bind-chip' + (composer ? ' in-composer' : '');
    if (!composer) wrap.type = 'button';
    const label = document.createElement('span');
    label.textContent = view.label;
    const cite = document.createElement('span');
    cite.className = 'chat-bind-cite';
    cite.textContent = view.cite;
    wrap.append(label, cite);
    if (composer) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'chat-bind-clear';
      clear.setAttribute('aria-label', '删除绑定');
      clear.textContent = '×';
      clear.onclick = clearComposerBinding;
      wrap.append(clear);
    } else {
      wrap.onclick = () => locateBinding(view.locate);
    }
    return wrap;
  }

  const quote = document.createElement('div');
  quote.className = 'chat-quote' + (composer ? ' in-composer' : '');
  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'chat-quote-body';
  const first = document.createElement('span');
  first.className = 'chat-quote-first';
  const expanded = composer
    ? composerQuoteExpanded
    : chatQuoteExpanded.has(messageIndex);
  first.textContent = expanded ? view.fullText : view.firstLine;
  if (expanded) first.classList.add('chat-quote-full');
  const cite = document.createElement('span');
  cite.className = 'chat-quote-cite';
  cite.textContent = view.cite;
  body.append(first, cite);
  if (!composer) body.onclick = () => locateBinding(view.locate);
  quote.append(body);
  const clearBinding = clearComposerBinding;
  if (composer) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chat-bind-clear';
    clear.setAttribute('aria-label', '删除绑定');
    clear.textContent = '×';
    clear.onclick = clearBinding;
    quote.append(clear);
  }
  if (view.fullText && view.fullText !== view.firstLine) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chat-quote-toggle';
    toggle.textContent = expanded ? '收起' : '展开';
    toggle.onclick = event => {
      event.stopPropagation();
      if (composer) {
        composerQuoteExpanded = !composerQuoteExpanded;
        renderChatComposer();
        return;
      }
      if (chatQuoteExpanded.has(messageIndex)) chatQuoteExpanded.delete(messageIndex);
      else chatQuoteExpanded.add(messageIndex);
      renderChat();
    };
    quote.append(toggle);
  }
  return quote;
}

function appendChatBubble(message, extraClass = '', messageIndex = -1) {
  const log = $('#chat-log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  const role = message?.role || 'assistant';
  const div = document.createElement('div');
  div.className = `chat-msg ${role} ${role === 'assistant' ? 'md' : ''} ${extraClass}`;
  if (role === 'user') {
    const view = userBindingView(message, currentMapped);
    if (view) div.appendChild(renderBindingView(view, { messageIndex }));
    const text = document.createElement('div');
    text.className = 'chat-user-text';
    text.textContent = message.content;
    div.appendChild(text);
  } else {
    renderMarkdownInto(div, message.content);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function renderChatComposer() {
  const ready = qaReady();
  const gate = $('#chat-gate');
  const input = $('#chat-input');
  const send = $('#btn-chat-send');
  gate.hidden = ready;
  gate.textContent = ready ? '' : QA_GATE_MESSAGE;
  input.disabled = !ready;
  send.disabled = !ready;
  input.placeholder = ready
    ? '输入 @ 作绑定提问，或不绑定即全文提问；Enter 发送'
    : QA_GATE_MESSAGE;

  const slot = $('#chat-binding-slot');
  slot.innerHTML = '';
  const view = userBindingView(chatComposer, currentMapped);
  slot.hidden = !view;
  if (view) slot.appendChild(renderBindingView(view, { composer: true }));
  if (!ready) hideMentionMenu();
}

function hideMentionMenu() {
  mentionOpen = false;
  mentionItems = [];
  const menu = $('#chat-mention');
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}

function renderMentionMenu() {
  const menu = $('#chat-mention');
  menu.innerHTML = '';
  if (!mentionItems.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = '无匹配的原文章节';
    menu.appendChild(empty);
  } else {
    mentionItems.forEach((section, index) => {
      const item = document.createElement('li');
      item.role = 'option';
      item.className = index === mentionActive ? 'active' : '';
      item.textContent = section.number
        ? `${section.number} ${section.title}`
        : (section.title || section.id);
      item.onmousedown = event => event.preventDefault();
      item.onclick = () => chooseMention(section);
      menu.appendChild(item);
    });
  }
  menu.hidden = false;
  mentionOpen = true;
}

function syncMentionMenu() {
  if (!qaReady() || !currentMapped) {
    hideMentionMenu();
    return;
  }
  const input = $('#chat-input');
  const trigger = parseMentionTrigger(input.value, input.selectionStart);
  if (!trigger) {
    hideMentionMenu();
    return;
  }
  mentionItems = mentionCandidates(currentMapped, trigger.query);
  if (mentionActive >= mentionItems.length) mentionActive = 0;
  renderMentionMenu();
}

function chooseMention(section) {
  const input = $('#chat-input');
  const applied = applyMention(input.value, input.selectionStart, section);
  input.value = applied.text;
  chatComposer = applied.binding;
  composerQuoteExpanded = false;
  hideMentionMenu();
  renderChatComposer();
  input.focus();
  input.setSelectionRange(applied.cursor, applied.cursor);
}

async function sendChat() {
  hideMentionMenu();
  const input = $('#chat-input');
  const q = input.value.trim();
  if (!q) return;
  if (!qaReady()) {
    toast(QA_GATE_MESSAGE, true);
    return;
  }
  const paper = current;
  const userMsg = composerMessage(q, chatComposer);
  input.value = '';
  chatComposer = emptyBinding();
  composerQuoteExpanded = false;
  hideMentionMenu();
  renderChatComposer();
  await papers.appendChatMessage(paper, userMsg);
  appendChatBubble(userMsg, '', (paper.chat || []).length - 1);
  const bubble = appendChatBubble({ role: 'assistant', content: '…' });

  const askOnce = async () => {
    chatAborter = new AbortController();
    try {
      const messages = await assembleCurrentQa(paper, q, userMsg);
      const text = await model.chat(messages, {
        stream: true,
        signal: chatAborter.signal,
        onDelta: full => { renderMarkdownInto(bubble, full); $('#chat-log').scrollTop = $('#chat-log').scrollHeight; },
        retry: () => { void askOnce(); },
      });
      renderMarkdownInto(bubble, text || '（无回复）');
      await papers.appendChatMessage(paper, { role: 'assistant', content: text, bindingKind: 'none' });
    } catch (err) {
      bubble.classList.add('err');
      if (err.name === 'AbortError') {
        bubble.textContent = '已停止。';
      } else {
        bubble.textContent = `出错了：${err.message}`;
        await papers.appendChatMessage(paper, { role: 'assistant', content: `（出错：${err.message}）`, bindingKind: 'none' });
      }
    } finally {
      chatAborter = null;
    }
  };
  await askOnce();
}

// ---------------- PDF 对照阅读 ----------------
function hasPdf(paper = current) {
  return store.pdf.has(paper);
}

function updatePdfSidebar() {
  const workspace = $('#reader-workspace');
  workspace.classList.toggle('pdf-closed', !pdfSidebarOpen);
  applyPdfPaneWidth();
  $('#pdf-sidebar').hidden = !pdfSidebarOpen;
  $('#btn-pdf-toggle').setAttribute('aria-expanded', String(pdfSidebarOpen));
  $('#btn-pdf-toggle').setAttribute('aria-pressed', String(!!reader.pdfOpen));
  $('#btn-pdf-toggle').classList.toggle('active', !!reader.pdfOpen);
  $('#pdf-empty').hidden = !pdfSidebarOpen || hasPdf();
  $('#pdf-viewer').hidden = !pdfSidebarOpen || !hasPdf();
  renderPdfTasks();
}

function applyPdfPaneWidth() {
  const workspace = $('#reader-workspace');
  if (!pdfSidebarOpen) {
    workspace.style.removeProperty('grid-template-columns');
    return;
  }
  const width = view.resolvedPdfWidth(reader, window.innerWidth);
  workspace.style.gridTemplateColumns = `minmax(0, 1fr) ${width}px`;
}

function applyTreeWidth() {
  const tree = $('#map-tree');
  if (tree) tree.style.width = `${reader.treeWidth}px`;
}

function beginPaneDrag(side, event) {
  if (event.button !== 0) return;
  const treeBox = $('#map-tree')?.getBoundingClientRect();
  paneDrag = {
    side,
    pointerId: event.pointerId,
    treeLeft: treeBox?.left ?? 0,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add('on');
  document.body.style.userSelect = 'none';
  event.preventDefault();
}

function onPaneDragMove(event) {
  if (!paneDrag || event.pointerId !== paneDrag.pointerId) return;
  if (paneDrag.side === 'tree') {
    reader = view.resizeTreeByClientX(reader, event.clientX, paneDrag.treeLeft);
    applyTreeWidth();
  } else {
    reader = view.resizePdfByClientX(reader, event.clientX, window.innerWidth);
    applyPdfPaneWidth();
  }
}

function endPaneDrag(event) {
  if (!paneDrag || event.pointerId !== paneDrag.pointerId) return;
  event.currentTarget.classList.remove('on');
  paneDrag = null;
  document.body.style.userSelect = '';
}

function bindPaneResizer(handle, side) {
  handle.addEventListener('pointerdown', event => beginPaneDrag(side, event));
  handle.addEventListener('pointermove', onPaneDragMove);
  handle.addEventListener('pointerup', endPaneDrag);
  handle.addEventListener('pointercancel', endPaneDrag);
}

function togglePdfSidebar(force) {
  commitReader(view.togglePdf(reader, force), { restore: true });
  if (pdfSidebarOpen && hasPdf() && !pdfDocument) initPdfViewer();
  if (pdfSidebarOpen && pdfDocument) requestAnimationFrame(() => fitPdfPage());
}

function collapsePdfPane() {
  commitReader(view.collapsePdf(reader), { restore: true });
}

function expandPdfPane() {
  commitReader(view.expandPdf(reader), { restore: true });
  if (pdfSidebarOpen && hasPdf() && !pdfDocument) initPdfViewer();
  if (pdfSidebarOpen && pdfDocument) requestAnimationFrame(() => fitPdfPage());
}

// PDF 栏的论文级任务上下文：会话 Map 里按 input.paperId 过滤出本论文的下载任务。
function renderPdfTasks() {
  const wrap = $('#pdf-tasks');
  wrap.innerHTML = '';
  if (!current || currentView !== 'reader') { wrap.hidden = true; return; }
  const rows = [];
  for (const [taskId, meta] of sessionTasks) {
    if (meta.kind !== 'files.download@1' || meta.input?.paperId !== current.id) continue;
    const snapshot = lastActiveTasks.find(task => task.taskId === taskId);
    if (!snapshot) continue; // 只显示仍活动的下载
    const row = document.createElement('div');
    row.className = 'pdf-task-row';
    const label = document.createElement('span');
    label.textContent = `正在下载 PDF（${taskKindLabel(snapshot.kind)}）`;
    const badge = document.createElement('span');
    badge.className = `task-badge st-${snapshot.status}`;
    badge.textContent = taskStatusLabel(snapshot.status);
    row.append(label, badge);
    rows.push(row);
  }
  wrap.hidden = rows.length === 0;
  for (const row of rows) wrap.appendChild(row);
}

function destroyPdfViewer() {
  pdfRenderTask?.cancel();
  pdfRenderTask = null;
  if (pdfDocument) {
    try { pdfDocument.destroy(); } catch { /* 忽略清理错误 */ }
  }
  pdfDocument = null;
  const canvas = $('#pdf-canvas');
  canvas.width = 0;
  canvas.height = 0;
}

async function initPdfViewer() {
  destroyPdfViewer();
  updatePdfSidebar();
  if (!current || !hasPdf()) return;
  const loading = $('#pdf-loading');
  loading.hidden = false;
  loading.textContent = '正在载入 PDF…';
  const paper = current;
  try {
    // 附件完整性校验：SHA-256 不符时 toast 警告，仍尝试渲染。
    if (paper.pdfAttachment) {
      try {
        await bridge.invoke('files.verifyAttachment@1', { paperId: paper.id, attachmentId: 'pdf' });
      } catch (err) {
        toast(`PDF 完整性校验未通过（${err.message || err}），仍尝试渲染`, true);
      }
    }
    const data = await store.pdf.bytes(paper);
    if (!data) throw new Error('PDF 附件读取失败');
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('pdf.js 尚未加载');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).href;
    }
    pdfDocument = await pdfjs.getDocument({ data }).promise;
    if (current !== paper) return; // 载入期间已切换论文
    pdfPage = Math.min(Math.max(pdfPage, 1), pdfDocument.numPages);
    $('#pdf-page-input').max = pdfDocument.numPages;
    $('#pdf-page-count').textContent = `/ ${pdfDocument.numPages}`;
    if (await papers.setNumPages(paper, pdfDocument.numPages)) updateReaderMeta();
    await new Promise(resolve => requestAnimationFrame(resolve));
    await fitPdfPage();
  } catch (err) {
    console.error(err);
    if (current !== paper) return;
    loading.hidden = false;
    loading.textContent = `PDF 载入失败：${err.message}`;
  }
}

async function renderPdfPage() {
  if (!pdfDocument || !pdfSidebarOpen) return;
  pdfPage = Math.min(Math.max(Math.round(pdfPage), 1), pdfDocument.numPages);
  $('#pdf-page-input').value = pdfPage;
  $('#btn-pdf-prev').disabled = pdfPage <= 1;
  $('#btn-pdf-next').disabled = pdfPage >= pdfDocument.numPages;
  $('#pdf-zoom-label').textContent = `${Math.round(pdfScale * 100)}%`;

  pdfRenderTask?.cancel();
  const page = await pdfDocument.getPage(pdfPage);
  const viewport = page.getViewport({ scale: pdfScale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = $('#pdf-canvas');
  const context = canvas.getContext('2d', { alpha: false });
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  $('#pdf-loading').hidden = true;
  const task = page.render({
    canvasContext: context,
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
  });
  pdfRenderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') throw err;
  } finally {
    if (pdfRenderTask === task) pdfRenderTask = null;
  }
  $('#pdf-canvas-wrap').scrollTo({ top: 0, left: 0 });
}

// 用户主动翻页后保存阅读位置（500ms 防抖）；不覆盖当前 tab。
function savePdfPagePosition() {
  if (!current || !pdfDocument) return;
  reader = view.setPdfPage(reader, pdfPage);
  schedulePositionSave();
}

async function fitPdfPage() {
  if (!pdfDocument || !pdfSidebarOpen) return;
  const page = await pdfDocument.getPage(pdfPage);
  const base = page.getViewport({ scale: 1 });
  const available = Math.max($('#pdf-canvas-wrap').clientWidth - 20, 280);
  pdfScale = Math.min(Math.max(available / base.width, 0.5), 2.25);
  await renderPdfPage();
}

function changePdfPage(delta) {
  if (!pdfDocument) return;
  pdfPage = Math.min(Math.max(pdfPage + delta, 1), pdfDocument.numPages);
  renderPdfPage();
  savePdfPagePosition();
}

function changePdfZoom(factor) {
  if (!pdfDocument) return;
  pdfScale = Math.min(Math.max(pdfScale * factor, 0.4), 3);
  renderPdfPage();
}

// put 会把瞬时 pdfBlob 上传为附件并清空句柄；随后从附件清单补回 pdfAttachment。
async function refreshPdfAttachment(paper) {
  try {
    const result = await bridge.invoke('files.listAttachments@1', { paperId: paper.id });
    const pdf = (result?.attachments || []).find(attachment => attachment.id === 'pdf');
    if (pdf) {
      paper.pdfAttachment = pdf;
      paper.pdfBlob = null;
    }
  } catch (err) {
    console.warn('刷新 PDF 附件信息失败：', err);
  }
}

async function attachPdf(file) {
  if (!current || !file) return;
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    toast('请选择 PDF 文件', true);
    return;
  }
  await papers.attachPdf(current, file);
  await refreshPdfAttachment(current);
  updatePdfSidebar();
  await initPdfViewer();
  toast('PDF 已关联，可与精读结果对照查看');
}

// ---------------- 内置使用说明（发布版首启播种） ----------------
// 空书库且未播种过时创建一份纯文本「使用说明」；可删除，welcomeSeeded 标记保证不复活。
const GUIDE_BLOCKS = [
  { heading: '欢迎使用 Paper30Min', text: 'Paper30Min 是一个论文精读助手：用大模型把一篇完整论文压缩成可在约 30 分钟内读完的形态。这一份是使用说明，读完即可删除。\n\n核心节奏是「建图 → 定向深挖 → 综合复述」：先拿到一屏的阅读地图，再只深挖你关心的章节，最后让复述稿把全篇讲清楚。' },
  { heading: '第一步：配置模型', text: '点右上角「设置」，填入模型服务的 Base URL、API Key 和模型名，保存后可用「连接测试」确认可用。API Key 只保存在本机，不会进入任何导出文件。' },
  { heading: '导入论文', text: '书库页支持三种导入：本地 PDF（自动做版式解析）、arXiv 编号或链接（优先结构化 HTML，PDF 自动关联）、示例论文。导入后应用会在后台自动完成解析与预渲染（任务中心可见进度），为建图备好材料。' },
  { heading: '建图与阅读地图', text: '打开论文后点「开始建图」。建图会为每个章节生成薄摘要，并合成一屏的阅读地图：论文要解决的问题、方法概述、贡献、关键证据位置与术语表。地图里的出处都可以点击定位。' },
  { heading: '节页：深挖与已读完', text: '从左侧节树进入任一章节：顶部是该节薄摘要，中间可按需发起「深挖」（带取证轨迹的细致分析），下方汇集该节图表，页尾「标记已读完」用来推进阅读进度。全部节标记完，这篇论文就算读完了。' },
  { heading: '提问', text: '「提问」页签支持三种问法：输入 @ 绑定某个章节提问；在「原文」页签选中一段文字后点浮动按钮就片段提问；不绑定时直接对全文提问。' },
  { heading: '任务中心与其他', text: '所有耗时操作（解析、建图、深挖、下载）都会进入「任务」页签，可查看进度、取消或重试。顶栏还有技能库（调整各阶段提示词）、阅读 streak 与导出笔记。祝你阅读高效。' },
];

async function seedGuidePaper() {
  if (library.length) return;
  try {
    const settings = await bridge.invoke('settings.get@1');
    if (settings?.ui?.welcomeSeeded) return;
    await papers.createGuidePaper('Paper30Min 使用说明', GUIDE_BLOCKS);
    await bridge.invoke('settings.putUi@1', { settings: { welcomeSeeded: true } });
    await refreshLibrary();
  } catch (err) {
    console.warn('使用说明播种失败：', err);
  }
}

// ---------------- 导入 ----------------
async function importPdfFile(file) {
  const btn = $('#btn-import');
  btn.disabled = true;
  btn.textContent = '解析中…';
  try {
    const parsed = await parser.parsePdfFile(file);
    const paper = await papers.createPdfPaper(parsed, file);
    await refreshLibrary();
    // createPdfPaper 返回的记录 pdfBlob 已被 put 清空，用刷新后的书库副本打开（带 pdfAttachment）。
    const opened = library.find(item => item.id === paper.id) || paper;
    openPaper(opened);
    const found = papers.readingParts(opened).filter(s => opened.sections?.[s.id]?.trim()).length;
    toast(`导入成功，自动识别出 ${found} 个精读部分`);
    // 后台排队解析+预渲染（#73）：建图前置产物提前备好，不阻塞打开论文。
    void runPreflightChain(paper.id);
  } catch (err) {
    console.error(err);
    toast('PDF 解析失败：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '＋ 导入 PDF';
  }
}

async function importSamplePaper() {
  try {
    const res = await fetch('samples/sample_paper.pdf');
    if (!res.ok) throw new Error('未找到示例文件');
    const bytes = await res.arrayBuffer();
    const parsed = await parser.parsePdfBytes(bytes, 'sample_paper.pdf');
    const file = new File([bytes], 'sample_paper.pdf', { type: 'application/pdf' });
    const paper = await papers.createPdfPaper(parsed, file);
    await refreshLibrary();
    const opened = library.find(item => item.id === paper.id) || paper;
    openPaper(opened);
    const found = papers.readingParts(opened).filter(s => opened.sections?.[s.id]?.trim()).length;
    toast(`示例论文已打开，自动识别出 ${found} 个精读部分`);
  } catch (err) {
    toast('示例论文不可用：' + err.message, true);
  }
}

async function importArxiv() {
  const id = parser.normalizeArxivId($('#arxiv-input').value);
  const status = $('#arxiv-status');
  const btn = $('#btn-arxiv-import');
  if (!id) {
    status.textContent = '请输入有效的 arXiv 编号或链接';
    return;
  }
  btn.disabled = true;
  status.textContent = '正在读取结构化 HTML…';
  try {
    const parsed = await parser.fetchArxiv(id);
    const paper = await papers.createArxivPaper(parsed, id, null);
    $('#modal-arxiv').hidden = true;
    await refreshLibrary();
    const opened = library.find(item => item.id === paper.id) || paper;
    openPaper(opened);
    const found = papers.readingParts(opened).filter(s => opened.sections?.[s.id]?.trim()).length;
    toast(`arXiv HTML 导入成功，识别出 ${found} 个精读部分`);
    // PDF 尽力而为：失败只提示可稍后关联，不阻塞阅读。
    parser.downloadArxivPdf(id, paper.id)
      .then(async () => {
        const target = current?.id === paper.id ? current : opened;
        await refreshPdfAttachment(target);
        if (current?.id === paper.id) {
          updatePdfSidebar();
          await initPdfViewer();
        }
        toast('arXiv PDF 已下载并关联');
        void runPreflightChain(paper.id);
      })
      .catch(err => {
        toast(`PDF 下载未完成（${err.message}），可稍后在 PDF 栏手动关联`, true);
      });
  } catch (err) {
    console.error(err);
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 导出 ----------------
// 统一导出流程：dialog.saveFile@1 选路径 → exports.write@1 写入选定路径；取消则静默放弃。
async function exportTextFile(fileName, text, dialogTitle) {
  const picked = await bridge.invoke('dialog.saveFile@1', { title: dialogTitle, defaultName: fileName });
  const targetPath = picked?.path;
  if (!targetPath) return false;
  const contentBase64 = bytesToBase64(new TextEncoder().encode(text));
  await bridge.invoke('exports.write@1', { fileName, contentBase64, targetPath });
  return true;
}

async function exportNotes() {
  if (!current) return;
  // 内容源 = 协议产物（L1/L2/深挖/复述稿）；旧精读结果只读附录（#56 决策 21）。
  const text = notesMarkdown({ paper: current, mapped: currentMapped, now: Date.now() });
  const safeTitle = current.title.slice(0, 60).replace(/[\\/:*?"<>|]/g, '_');
  try {
    const written = await exportTextFile(`《${safeTitle}》精读笔记.md`, text, '导出精读笔记');
    if (written) toast('精读笔记已导出');
  } catch (err) {
    toast('导出失败：' + err.message, true);
  }
}

async function exportLibrary() {
  const btn = $('#btn-export-library');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    // 信封与浏览器格式兼容：技能覆盖与设置随信携带；API Key 不随备份文件扩散，
    // 导出时清空（导入端不会用空值覆盖本地密钥）。
    const json = await papers.exportLibrary({
      skills: loadCustomSkills(),
      settings: { ...model.loadSettings(), apiKey: '' },
    });
    const fileName = `paper-30min-library-${dateStamp(Date.now())}.json`;
    const written = await exportTextFile(fileName, json, '导出整库');
    if (written) toast('书库已导出（API Key 未包含在内）');
  } catch (err) {
    toast('导出失败：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------- 评分、分类与标签 ----------------
function renderRatingControl() {
  $$('#rating-control [data-rating]').forEach(button => {
    const value = Number(button.dataset.rating);
    const active = value <= organizeDraft.rating;
    button.textContent = active ? '★' : '☆';
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(value === organizeDraft.rating));
  });
}

function renderOrganizeTokens(kind) {
  const values = organizeDraft[kind];
  const list = $(`#${kind === 'categories' ? 'category' : 'tag'}-list`);
  list.innerHTML = '';
  for (const value of values) {
    const token = document.createElement('span');
    token.className = `editable-token ${kind === 'categories' ? 'category' : 'tag'}`;
    const text = document.createElement('span');
    text.textContent = kind === 'tags' ? `#${value}` : value;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `移除${kind === 'categories' ? '分类' : '标签'}`;
    remove.setAttribute('aria-label', `移除 ${value}`);
    remove.textContent = '×';
    remove.onclick = () => {
      organizeDraft[kind] = organizeDraft[kind].filter(item => item !== value);
      renderOrganizeTokens(kind);
    };
    token.append(text, remove);
    list.appendChild(token);
  }
}

function addOrganizeTokens(kind) {
  const input = $(`#${kind === 'categories' ? 'category' : 'tag'}-input`);
  const additions = input.value.split(/[，,;；\n]+/).map(value => value.trim()).filter(Boolean);
  organizeDraft[kind] = papers.cleanTokens([...organizeDraft[kind], ...additions]);
  input.value = '';
  renderOrganizeTokens(kind);
}

function fillMetadataSuggestions() {
  const groups = [
    { id: 'category-suggestions', values: papers.cleanTokens(library.flatMap(papers.paperCategories)) },
    { id: 'tag-suggestions', values: papers.cleanTokens(library.flatMap(papers.paperTags)) },
  ];
  for (const group of groups) {
    const datalist = $(`#${group.id}`);
    datalist.innerHTML = '';
    for (const value of group.values) {
      const option = document.createElement('option');
      option.value = value;
      datalist.appendChild(option);
    }
  }
}

function openOrganizeModal() {
  organizeDraft = {
    rating: Math.min(Math.max(Number(current.rating) || 0, 0), 5),
    categories: papers.paperCategories(current),
    tags: papers.paperTags(current),
  };
  $('#category-input').value = '';
  $('#tag-input').value = '';
  fillMetadataSuggestions();
  renderRatingControl();
  renderOrganizeTokens('categories');
  renderOrganizeTokens('tags');
  $('#modal-organize').hidden = false;
}

async function saveOrganizeMetadata() {
  await papers.saveOrganize(current, organizeDraft);
  library = library.map(paper => paper.id === current.id ? current : paper);
  $('#modal-organize').hidden = true;
  updateReaderMeta();
  toast('评分、分类和标签已保存');
}

// ---------------- 设置弹窗 ----------------
function openSettingsModal() {
  const s = model.loadSettings();
  $('#set-baseurl').value = s.baseUrl;
  $('#set-apikey').value = s.apiKey;
  $('#set-model').value = s.model;
  $('#set-temp').value = s.temperature;
  $('#set-maxchars').value = s.maxChars;
  $('#api-test-result').textContent = '';
  $('#modal-settings').hidden = false;
}

function collectSettingsForm() {
  const s = model.loadSettings();
  s.baseUrl = $('#set-baseurl').value.trim();
  s.apiKey = $('#set-apikey').value.trim();
  s.model = $('#set-model').value.trim();
  s.temperature = parseFloat($('#set-temp').value) || 0.3;
  s.maxChars = parseInt($('#set-maxchars').value, 10) || 16000;
  return s;
}

async function saveSettings() {
  await model.saveSettings(collectSettingsForm());
  $('#modal-settings').hidden = true;
  refreshLibrary();
  toast('设置已保存');
}

// ---------------- 技能库弹窗 ----------------
function openSkillsModal() {
  renderSkillList();
  const first = effectiveSkills()[0];
  if (first) selectSkill(first.id);
  $('#modal-skills').hidden = false;
}

function renderSkillList() {
  const wrap = $('#skill-list');
  wrap.innerHTML = '';
  for (const s of effectiveSkills()) {
    const div = document.createElement('div');
    div.className = 'skill-item' + (s.customized ? ' custom' : '') + (s.id === editingSkillId ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'si-name';
    name.textContent = s.name;
    const desc = document.createElement('div');
    desc.className = 'si-desc';
    desc.textContent = s.description;
    div.append(name, desc);
    div.onclick = () => selectSkill(s.id);
    wrap.appendChild(div);
  }
}

function selectSkill(id) {
  editingSkillId = id;
  const s = getSkill(id);
  $('#skill-edit-name').textContent = s.name;
  $('#skill-edit-desc').textContent = s.description;
  $('#skill-edit-prompt').value = s.prompt;
  renderSkillList();
}

async function importSkillFile(file) {
  const text = await file.text();
  const parsed = parseSkillFile(file.name, text);
  // 映射到目标章节技能；无法识别时提示用户手动选择
  const target = effectiveSkills().find(s => s.section === parsed.section || s.id === parsed.section);
  if (target) {
    await saveCustomSkill(target.id, parsed.prompt);
    selectSkill(target.id);
    toast(`已导入「${parsed.name}」→ ${target.name}`);
  } else {
    const list = effectiveSkills().map(s => s.id).join(' / ');
    toast(`未识别目标章节（frontmatter 的 section 应为：${list}），请在左侧选择要覆盖的技能后再导入`, true);
  }
}

// ---------------- 浏览器迁移 ----------------
// 取代浏览器版的应用内整库导入：选文件 → 预检 → 展示报告 → 确认迁入。
// inspect/commit 错误（source_changed / token_expired / 损坏 JSON / 版本不符）
// 统一展示 code + message，并允许重新选择文件重新预检。

function openMigrateModal() {
  migrationToken = '';
  $('#migrate-status').textContent = '';
  $('#migrate-report').hidden = true;
  $('#migrate-report').replaceChildren();
  $('#btn-migrate-commit').hidden = true;
  $('#modal-migrate').hidden = false;
}

function errorText(err) {
  const code = err && typeof err === 'object' && err.code ? `${err.code}：` : '';
  return `${code}${err?.message || err}`;
}

async function pickMigrationFile() {
  const status = $('#migrate-status');
  const pickBtn = $('#btn-migrate-pick');
  let picked = null;
  try {
    picked = await bridge.invoke('dialog.pickFile@1', {
      title: '选择浏览器导出的书库 JSON',
      filters: [{ name: '书库导出 JSON', extensions: ['json'] }],
    });
  } catch (err) {
    status.textContent = `无法打开文件对话框：${errorText(err)}`;
    return;
  }
  if (!picked?.path) {
    status.textContent = '未选择文件';
    return;
  }
  pickBtn.disabled = true;
  status.textContent = '正在预检…';
  $('#migrate-report').hidden = true;
  $('#btn-migrate-commit').hidden = true;
  migrationToken = '';
  try {
    const report = await bridge.invoke('migration.inspect@1', { sourcePath: picked.path });
    migrationToken = report.token || '';
    renderMigrationReport(report);
    status.textContent = '';
  } catch (err) {
    status.textContent = `预检失败（${errorText(err)}），请重新选择文件`;
  } finally {
    pickBtn.disabled = false;
  }
}

function renderMigrationReport(report) {
  const wrap = $('#migrate-report');
  wrap.replaceChildren();
  const dl = document.createElement('dl');
  const rows = [
    ['文件格式', `${report.format}（版本 ${report.formatVersion}）`],
    ['论文数量', `${report.paperCount} 篇`],
    ['可迁入', `${report.conflicts?.new ?? 0} 篇`],
    ['已存在（跳过）', `${report.conflicts?.existing ?? 0} 篇`],
    ['无效记录（跳过）', `${report.conflicts?.invalid ?? 0} 篇`],
    ['预检令牌有效期至', report.expiresAt ? new Date(report.expiresAt).toLocaleString() : '—'],
  ];
  for (const [name, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  wrap.appendChild(dl);
  if (report.apiKeyStripped) {
    const note = document.createElement('p');
    note.className = 'migrate-note';
    note.textContent = '源文件中的 API Key 已被剔除，不会迁入；请在设置中重新配置。';
    wrap.appendChild(note);
  }
  if (report.errors?.length) {
    const list = document.createElement('ul');
    list.className = 'migrate-errors';
    for (const issue of report.errors) {
      const item = document.createElement('li');
      item.textContent = issue.paperId ? `${issue.paperId}：${issue.message}` : issue.message;
      list.appendChild(item);
    }
    wrap.appendChild(list);
  }
  wrap.hidden = false;
  // 令牌耗尽/过期后必须重新预检：commit 失败会清空令牌并隐藏确认按钮。
  $('#btn-migrate-commit').hidden = !migrationToken;
}

async function commitMigration() {
  const status = $('#migrate-status');
  if (!migrationToken) {
    status.textContent = '请先选择文件并完成预检';
    return;
  }
  const commitBtn = $('#btn-migrate-commit');
  commitBtn.disabled = true;
  status.textContent = '正在迁入…';
  try {
    const result = await bridge.invoke('migration.commit@1', { token: migrationToken });
    migrationToken = '';
    commitBtn.hidden = true;
    const wrap = $('#migrate-report');
    wrap.replaceChildren();
    const done = document.createElement('p');
    done.textContent = `迁入完成：新增 ${result.added} 篇，跳过已存在 ${result.skipped} 篇，写入附件 ${result.attachments} 个。`;
    wrap.appendChild(done);
    wrap.hidden = false;
    status.textContent = '';
    await refreshLibrary();
    toast('浏览器书库已迁入');
  } catch (err) {
    // source_changed / token_expired / 损坏 JSON / 版本不符：展示 code+message，允许重新选文件。
    migrationToken = '';
    commitBtn.hidden = true;
    status.textContent = `迁入失败（${errorText(err)}），请重新选择文件并预检`;
  } finally {
    commitBtn.disabled = false;
  }
}

// ---------------- 任务中心 ----------------
let tasksPollTimer = null;

async function pollTasks() {
  try {
    const result = await bridge.invoke('tasks.list@1', {});
    const tasks = (result?.tasks || [])
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (currentView === 'tasks') renderTaskList(tasks);
  } catch (err) {
    console.warn('任务列表轮询失败：', err);
  }
}

function setTasksPolling(on) {
  if (tasksPollTimer) {
    clearInterval(tasksPollTimer);
    tasksPollTimer = null;
  }
  if (on) {
    pollTasks();
    tasksPollTimer = setInterval(pollTasks, 1500);
  }
}

function renderTaskList(tasks) {
  const wrap = $('#task-list');
  wrap.innerHTML = '';
  $('#tasks-empty').hidden = tasks.length > 0;
  for (const task of tasks) {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.dataset.taskId = task.taskId;

    const head = document.createElement('div');
    head.className = 'task-row-head';
    const kind = document.createElement('span');
    kind.className = 'task-kind';
    kind.textContent = taskKindLabel(task.kind);
    const id = document.createElement('span');
    id.className = 'task-id';
    id.textContent = task.taskId;
    const badge = document.createElement('span');
    badge.className = `task-badge st-${task.status}`;
    badge.textContent = taskStatusLabel(task.status);
    head.append(kind, id, badge);

    const actions = document.createElement('div');
    actions.className = 'task-row-actions';
    if (!isTerminalStatus(task.status)) {
      const cancel = document.createElement('button');
      cancel.className = 'btn small';
      cancel.type = 'button';
      cancel.textContent = '取消';
      cancel.onclick = async () => {
        cancel.disabled = true;
        try { await bridge.invoke('tasks.cancel@1', { taskId: task.taskId }); } catch (err) {
          toast(`取消失败：${errorText(err)}`, true);
        }
        pollTasks();
      };
      actions.appendChild(cancel);
    }
    const meta = sessionTasks.get(task.taskId);
    if (task.status === 'failed' && task.error?.retryable && meta?.retry) {
      const retry = document.createElement('button');
      retry.className = 'btn small primary';
      retry.type = 'button';
      retry.textContent = '重试';
      retry.onclick = async () => {
        retry.disabled = true;
        try {
          await meta.retry();
          toast('重试任务已完成');
        } catch (err) {
          if (err.name !== 'AbortError') toast(`重试失败：${err.message}`, true);
        }
        pollTasks();
      };
      actions.appendChild(retry);
    }
    head.appendChild(actions);
    row.appendChild(head);

    // 进度条：progress.total 为 0（或缺失）且未终结时显示不定态动画。
    const progress = document.createElement('div');
    progress.className = 'task-progress';
    const fill = document.createElement('div');
    fill.className = 'task-progress-fill';
    progress.appendChild(fill);
    const p = task.progress;
    if (p && p.total > 0) {
      fill.style.width = `${Math.min(100, Math.round((p.done / p.total) * 100))}%`;
    } else if (task.status === 'succeeded') {
      fill.style.width = '100%';
    } else if (!isTerminalStatus(task.status)) {
      progress.classList.add('indeterminate');
    } else {
      progress.hidden = true;
    }
    row.appendChild(progress);

    // 协议任务附加区（#56 决策 13 / #75）：建图 = 阶段流 + 穿插轮次；深挖 = 逐节子进度
    // （批量）+ 轨迹流（工具步与模型轮按 details 原序）；解析 = 计时拆分。
    // 数据来自任务快照 details，缺登记时自动降级。
    const detail = taskDetailModel({ task, meta });
    if (detail.stageFlow) {
      const flow = document.createElement('div');
      flow.className = 'task-stage-flow';
      for (const stage of detail.stageFlow) {
        const chip = document.createElement('span');
        chip.className = `task-stage ${stage.state}`;
        chip.textContent = stage.label;
        flow.appendChild(chip);
      }
      row.appendChild(flow);
    }
    if (detail.subProgress) {
      const sub = document.createElement('div');
      sub.className = 'task-sub-progress';
      const { index, total, title } = detail.subProgress;
      sub.textContent = `逐节推进：第 ${index}/${total} 节${title ? ` · ${title}` : ''}`;
      row.appendChild(sub);
    }
    if (detail.trace?.length) {
      const hasTools = detail.trace.some(item => item.kind === 'tool');
      const wrap = document.createElement('div');
      wrap.className = hasTools ? 'task-steps' : 'task-rounds';
      const head = document.createElement('div');
      head.className = hasTools ? 'task-steps-head' : 'task-rounds-head';
      const toolCount = detail.stepsTotal ?? detail.trace.filter(item => item.kind === 'tool').length;
      head.textContent = hasTools ? `取证轨迹（共 ${toolCount} 步）` : '模型轮';
      wrap.appendChild(head);
      const list = document.createElement('div');
      list.className = 'task-trace';
      for (const item of detail.trace) {
        const line = document.createElement('div');
        if (item.kind === 'tool') {
          line.className = item.ok ? 'task-tool' : 'task-tool fail';
        } else {
          line.className = item.reasoning ? 'task-round reasoning' : 'task-round';
        }
        line.textContent = item.text;
        list.appendChild(line);
      }
      wrap.appendChild(list);
      row.appendChild(wrap);
    } else if (detail.steps?.length) {
      const stepsWrap = document.createElement('div');
      stepsWrap.className = 'task-steps';
      const head = document.createElement('div');
      head.className = 'task-steps-head';
      head.textContent = `取证轨迹（共 ${detail.stepsTotal} 步）`;
      stepsWrap.appendChild(head);
      const list = document.createElement('ol');
      for (const step of detail.steps) {
        const item = document.createElement('li');
        item.className = step.ok ? '' : 'fail';
        item.textContent = step.text;
        list.appendChild(item);
      }
      stepsWrap.appendChild(list);
      row.appendChild(stepsWrap);
    }
    if (detail.timings?.length) {
      const table = document.createElement('div');
      table.className = 'task-timings';
      const head = document.createElement('div');
      head.className = 'task-timings-head';
      head.textContent = '解析计时';
      table.appendChild(head);
      for (const item of detail.timings) {
        const line = document.createElement('div');
        line.className = 'task-timing-row';
        line.textContent = `${item.label} ${(item.ms / 1000).toFixed(1)} s`;
        table.appendChild(line);
      }
      row.appendChild(table);
    }

    if (task.status === 'failed' && task.error) {
      const error = document.createElement('div');
      error.className = 'task-error';
      error.textContent = `${task.error.code || 'unknown'}：${task.error.message || '任务失败'}`;
      row.appendChild(error);
    }
    wrap.appendChild(row);
  }
}

// 顶栏「任务」角标：每 3s 轮询活动任务数（所有视图都轮询），并顺带刷新 PDF 栏任务上下文。
async function pollActiveTasks() {
  try {
    const result = await bridge.invoke('tasks.list@1', { activeOnly: true });
    const prevCount = lastActiveTasks.length;
    lastActiveTasks = result?.tasks || [];
    const badge = $('#nav-tasks-badge');
    badge.hidden = lastActiveTasks.length === 0;
    badge.textContent = String(lastActiveTasks.length);
    // 书库视图的建图状态 chip 依赖活动任务：任务出现/消失时刷新一次卡片，
    // 免得停留书库期间「建图中」滞留或建图完成后不翻「已建图」（#72 走查发现）。
    if (reader.appView === 'library' && lastActiveTasks.length !== prevCount) void refreshLibrary();
    renderPdfTasks();
    if (current) {
      const mapping = isMappingPaper(current.id);
      if (mapping !== reader.mapping) {
        const wasMapping = reader.mapping;
        reader = view.setMapping(reader, mapping);
        if (wasMapping && !mapping) {
          const fresh = await refreshPaperRecord(current.id);
          if (fresh) await refreshMapped(current);
          if (reader.tab === 'source') renderSource();
          if (reader.tab === 'chat') renderChat();
          if (reader.tab === 'recall') renderRecall();
        }
        if (reader.appView === 'reader') renderMapTab();
      }
    }
  } catch (err) {
    console.warn('活动任务轮询失败：', err);
  }
}

// ---------------- 关闭确认（移植自旧预览界面 app.js） ----------------
function bindCloseFlow() {
  bridge.onCloseRequested(payload => {
    const active = activeTasks(payload?.tasks ?? []);
    const list = $('#close-task-list');
    list.replaceChildren();
    for (const task of active) {
      const item = document.createElement('li');
      item.textContent = `${taskKindLabel(task.kind)}（${task.taskId}）：${taskStatusLabel(task.status)}`;
      list.appendChild(item);
    }
    $('#modal-close').hidden = false;
  });

  $('#btn-close-wait').addEventListener('click', async () => {
    try {
      const result = await bridge.invoke('tasks.list@1', { activeOnly: true });
      const active = activeTasks(result?.tasks ?? []);
      if (active.length === 0) {
        await bridge.closeWindow(false);
        return;
      }
      let remaining = active.length;
      for (const task of active) {
        let settled = false;
        const settle = async () => {
          if (settled) return;
          settled = true;
          remaining -= 1;
          if (remaining <= 0) {
            await bridge.closeWindow(false);
          }
        };
        await bridge.subscribe(task.taskId, event => {
          if (isTerminalStatus(event?.status)) {
            void settle();
          }
        });
        // 事件不重放：订阅后复查快照，任务可能已在订阅前到达终态。
        const snapshot = await bridge.invoke('tasks.get@1', { taskId: task.taskId });
        if (isTerminalStatus(snapshot?.task?.status)) {
          await settle();
        }
      }
      $('#modal-close').hidden = true;
    } catch (err) {
      toast(`等待任务完成失败：${errorText(err)}`, true);
    }
  });

  $('#btn-close-stop').addEventListener('click', async () => {
    try {
      await bridge.closeWindow(true);
    } catch (err) {
      toast(`停止任务并退出失败：${errorText(err)}`, true);
    }
  });

  $('#btn-close-cancel').addEventListener('click', () => {
    $('#modal-close').hidden = true;
  });
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('#brand-home').onclick = () => showView('library');
  $('#nav-library').onclick = () => showView('library');
  $('#nav-reader').onclick = () => { if (current) showView('reader'); };
  $('#nav-tasks').onclick = () => showView('tasks');
  $('#btn-back').onclick = () => showView('library');
  $('#btn-organize').onclick = openOrganizeModal;
  $('#btn-import').onclick = () => $('#file-input').click();
  $('#btn-arxiv').onclick = () => {
    $('#arxiv-input').value = '';
    $('#arxiv-status').textContent = '';
    $('#modal-arxiv').hidden = false;
    setTimeout(() => $('#arxiv-input').focus(), 0);
  };
  $('#btn-arxiv-import').onclick = importArxiv;
  $('#arxiv-input').addEventListener('keydown', e => { if (e.key === 'Enter') importArxiv(); });
  $('#file-input').onchange = e => { if (e.target.files[0]) importPdfFile(e.target.files[0]); e.target.value = ''; };
  $('#btn-sample').onclick = importSamplePaper;
  $('#btn-migrate').onclick = openMigrateModal;
  $('#btn-migrate-pick').onclick = pickMigrationFile;
  $('#btn-migrate-commit').onclick = commitMigration;
  $('#btn-export-library').onclick = exportLibrary;
  $('#api-warning').onclick = openSettingsModal;
  $('#library-search').oninput = e => {
    libraryQuery = e.target.value;
    refreshLibrary();
  };
  $('#filter-category').onchange = e => {
    categoryFilter = e.target.value;
    refreshLibrary();
  };
  $('#filter-rating').onchange = e => {
    ratingFilter = Number(e.target.value) || 0;
    refreshLibrary();
  };
  $('#filter-done').onchange = e => {
    doneFilter = e.target.value;
    refreshLibrary();
  };
  $('#btn-filter-reset').onclick = () => {
    libraryQuery = '';
    categoryFilter = '';
    ratingFilter = 0;
    doneFilter = '';
    $('#library-search').value = '';
    $('#filter-rating').value = '0';
    $('#filter-done').value = '';
    refreshLibrary();
  };
  $('#btn-settings').onclick = openSettingsModal;
  $('#btn-save-settings').onclick = async () => {
    try { await saveSettings(); } catch (err) { toast('设置保存失败：' + errorText(err), true); }
  };
  $('#btn-test-api').onclick = async () => {
    const r = $('#api-test-result');
    r.textContent = '测试中…';
    // 先保存再测试：测试连接读取的是已落库的设置。
    try {
      await model.saveSettings(collectSettingsForm());
      r.textContent = await model.testConnection();
    } catch (err) {
      r.textContent = '❌ ' + (err?.message || err);
    }
  };

  $$('#reader-tabs .tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $('#recall-editor').oninput = () => {
    updateRecallPreview();
    $('#recall-status').textContent = '有未保存的修改';
  };
  $('#recall-editor').addEventListener('paste', event => {
    const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    addRecallImages(images);
  });
  $('#btn-recall-generate').onclick = generateRecallDraft;
  $('#btn-recall-stop').onclick = () => recallAborter?.abort();
  $('#btn-recall-save').onclick = () => saveRecallCard().catch(err => toast('回想卡片保存失败：' + errorText(err), true));
  $('#btn-recall-image').onclick = () => $('#recall-image-input').click();
  $('#recall-image-input').onchange = e => {
    if (e.target.files?.length) addRecallImages(e.target.files).catch(err => toast(err.message, true));
    e.target.value = '';
  };
  $('#btn-pdf-toggle').onclick = () => togglePdfSidebar();
  $('#btn-pdf-close').onclick = collapsePdfPane;
  $('#pdf-fab').onclick = expandPdfPane;
  $('#tree-fab').onclick = () => commitReader(view.expandTree(reader), { restore: true });
  $('#btn-tree-fold').onclick = () => commitReader(view.collapseTree(reader), { restore: true });
  $('#btn-tree-map').onclick = backToMap;
  $('#btn-back-map').onclick = backToMap;
  $('#btn-deep-all').onclick = () => startDeepAll().catch(err => toast(errorText(err), true));
  $('#btn-build-map').onclick = () => startBuildMap().catch(err => toast(errorText(err), true));
  $('#map-page-body').onclick = onProtocolContentClick;
  $('#section-page-body').onclick = onProtocolContentClick;
  bindPaneResizer($('#tree-resizer'), 'tree');
  bindPaneResizer($('#pdf-resizer'), 'pdf');
  $('#btn-pdf-attach').onclick = () => $('#pdf-attach-input').click();
  $('#pdf-attach-input').onchange = e => {
    if (e.target.files[0]) attachPdf(e.target.files[0]).catch(err => toast('关联 PDF 失败：' + err.message, true));
    e.target.value = '';
  };
  $('#btn-pdf-prev').onclick = () => changePdfPage(-1);
  $('#btn-pdf-next').onclick = () => changePdfPage(1);
  $('#pdf-page-input').onchange = e => {
    if (!pdfDocument) return;
    pdfPage = Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), pdfDocument.numPages);
    renderPdfPage();
    savePdfPagePosition();
  };
  $('#btn-pdf-zoom-out').onclick = () => changePdfZoom(0.85);
  $('#btn-pdf-zoom-in').onclick = () => changePdfZoom(1.18);
  $('#btn-pdf-fit').onclick = () => fitPdfPage();

  $('#source-translate-toggle').onchange = e => {
    reader = view.toggleTranslateCompare(reader, e.target.checked);
    syncTranslatePane();
  };
  $('#translate-language').onchange = loadTranslationSection;
  $('#btn-translate').onclick = translateCurrentText;
  $('#btn-translate-stop').onclick = () => translateAborter?.abort();

  $$('#rating-control [data-rating]').forEach(button => {
    button.onclick = () => {
      organizeDraft.rating = Number(button.dataset.rating);
      renderRatingControl();
    };
  });
  $('#btn-rating-clear').onclick = () => {
    organizeDraft.rating = 0;
    renderRatingControl();
  };
  $('#btn-category-add').onclick = () => addOrganizeTokens('categories');
  $('#btn-tag-add').onclick = () => addOrganizeTokens('tags');
  $('#category-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addOrganizeTokens('categories'); }
  });
  $('#tag-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addOrganizeTokens('tags'); }
  });
  $('#btn-organize-save').onclick = () => saveOrganizeMetadata().catch(err => toast('整理保存失败：' + errorText(err), true));

  $('#btn-export').onclick = exportNotes;

  $('#btn-paste-split').onclick = async () => {
    const text = $('#paste-area').value.trim();
    if (!text) return toast('请先粘贴全文', true);
    const parsed = parser.parsePlainText(text);
    const { discarded } = await papers.applyResplit(current, parsed);
    $('#paste-area').value = '';
    renderSource();
    renderMapTab();
    $('#source-empty').hidden = true;
    const found = papers.readingParts(current).filter(s => current.sections?.[s.id]?.trim()).length;
    toast(discarded
      ? `重新切分完成，识别出 ${found} 个精读部分；${discarded} 条已失效的精读/翻译结果被作废`
      : `重新切分完成，识别出 ${found} 个精读部分`);
  };

  $('#btn-chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', e => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActive = mentionItems.length ? (mentionActive + 1) % mentionItems.length : 0;
        renderMentionMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActive = mentionItems.length
          ? (mentionActive - 1 + mentionItems.length) % mentionItems.length
          : 0;
        renderMentionMenu();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (mentionItems[mentionActive]) chooseMention(mentionItems[mentionActive]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chat-input').addEventListener('input', syncMentionMenu);
  $('#chat-input').addEventListener('click', syncMentionMenu);
  $('#chat-input').addEventListener('keyup', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') syncMentionMenu();
  });
  $('#source-doc').addEventListener('mouseup', onSourceMouseUp);
  $('#source-doc').addEventListener('scroll', hideSourceAskFloat);
  $('#source-ask-float').addEventListener('mousedown', e => e.preventDefault());
  $('#source-ask-float').onclick = () => {
    if (pendingSourceHits.length) startFragmentAsk(pendingSourceHits);
  };
  document.addEventListener('mousedown', e => {
    const float = $('#source-ask-float');
    if (float && !float.hidden && !float.contains(e.target) && !$('#source-doc')?.contains(e.target)) {
      hideSourceAskFloat();
    }
  });

  $('#btn-skills').onclick = openSkillsModal;
  $('#btn-skill-save').onclick = async () => {
    if (!editingSkillId) return;
    try {
      await saveCustomSkill(editingSkillId, $('#skill-edit-prompt').value);
      renderSkillList();
      toast('技能已保存');
    } catch (err) {
      toast('技能保存失败：' + errorText(err), true);
    }
  };
  $('#btn-skill-reset').onclick = async () => {
    if (!editingSkillId) return;
    try {
      await resetSkill(editingSkillId);
      selectSkill(editingSkillId);
      toast('已恢复默认提示词');
    } catch (err) {
      toast('恢复默认失败：' + errorText(err), true);
    }
  };
  $('#btn-skill-import').onclick = () => $('#skill-file').click();
  $('#skill-file').onchange = e => {
    if (e.target.files[0]) importSkillFile(e.target.files[0]).catch(err => toast('技能导入失败：' + err.message, true));
    e.target.value = '';
  };

  // 点击遮罩或「取消」按钮关闭弹窗；关闭确认弹窗的遮罩点击等同「取消关闭」。
  for (const id of ['modal-arxiv', 'modal-settings', 'modal-skills', 'modal-organize', 'modal-migrate', 'modal-close']) {
    const mask = $(`#${id}`);
    mask.addEventListener('click', e => { if (e.target === mask) mask.hidden = true; });
    mask.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { mask.hidden = true; });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      for (const id of ['modal-arxiv', 'modal-settings', 'modal-skills', 'modal-organize', 'modal-migrate', 'modal-close']) {
        $(`#${id}`).hidden = true;
      }
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfSidebarOpen) applyPdfPaneWidth();
      if (pdfSidebarOpen && pdfDocument) fitPdfPage();
    }, 180);
  });

  bindCloseFlow();
}

// ---------------- 启动序列 ----------------
model.initModel(bridge, { registerTask: registerSessionTask });
parser.initParser({ fetchText, downloadPdf });
store = createTauriStore(bridge);
papers.init(store, { pdfBase64: p => store.pdf.base64(p) });
generation.init({ chat: model.chat, loadSettings: model.loadSettings });
await initSkills({
  listSkillFiles: async () => (await bridge.invoke('skills.list@1'))?.skills || [],
  loadOverrides: async () => (await bridge.invoke('settings.get@1'))?.skillsOverrides || {},
  saveOverrides: async overrides => { await bridge.invoke('settings.putSkillsOverrides@1', { overrides }); },
});
bindEvents();
await model.initSettings();
const skillsSource = await loadSkills();
if (skillsSource === 'builtin') toast('技能文件加载失败，已使用内置提示词', true);
pollActiveTasks();
setInterval(pollActiveTasks, 3000);
await refreshLibrary();
await seedGuidePaper();
