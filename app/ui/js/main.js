// 界面壳与编排（Issue #31）：书库 / 阅读 / 任务中心三个视图与全部弹窗。
// 业务行为移植自 public/js/app.js；领域规则全部在 js/ 下的模块里，本文件只做 DOM 与流程编排。
// 与浏览器版的差异：
// - 模型、网络、下载、迁移、导出等能力全部走 bridge（Rust 侧实现），不再有 fetch/localStorage；
// - 精读 tab 由「选择器 + 单卡片」改为「分节卡片流」（渐进式重设计，生成/取消/落库语义不变）；
// - 新增任务中心视图、阅读位置保存与恢复、PDF 附件 SHA-256 校验、回忆卡图片走附件存储。

import { createBridge, trackTask, taskStatusLabel, isTerminalStatus, activeTasks } from '../bridge.js';
import * as papers from './papers.js';
import * as model from './model.js';
import * as generation from './generation.js';
import * as parser from './parser.js';
import { createTauriStore, bytesToBase64, base64ToBytes } from './store.js';
import { renderMarkdown, typesetMath } from './markdown.js';
import {
  initSkills, effectiveSkills, getSkill, saveCustomSkill, resetSkill,
  parseSkillFile, loadCustomSkills, loadSkills, CHAT_SYSTEM_TEMPLATE,
} from './skills.js';

const bridge = createBridge(window.__TAURI__);
let store = null; // createTauriStore(bridge)，启动序列中创建

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function escapeTemplate(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------- 全局状态 ----------------
let library = [];
let current = null;          // 当前打开的论文
let currentView = 'library'; // library | tasks | reader
let currentTab = 'digest';   // digest | recall | source | translate | chat
let chatAborter = null;      // 问答中断控制器（独立于精读生成任务）
let activeBatch = null;      // 进行中的批量生成句柄，停止按钮经它取消
let editingSkillId = null;
let digestSection = 'abstract';
let sourceTab = 'abstract';
let translateSection = 'abstract';
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
let organizeDraft = { rating: 0, categories: [], tags: [] };
let migrationToken = '';

// 会话内任务登记表：taskId -> { kind, input, retry, status? }。重试与 PDF 栏任务上下文都从这里取。
// 只增不清会随会话膨胀：容量上限 50 条，任务到达终态后把 status 记入条目，
// 新增条目超出上限时按插入顺序淘汰最旧的 succeeded 条目（failed/cancelled 保留，
// 任务中心的「重试」按钮依赖这些条目）。
const SESSION_TASKS_LIMIT = 50;
const sessionTasks = new Map();

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

const READER_TABS = ['digest', 'recall', 'source', 'translate', 'chat'];

// 任务 kind -> 中文名（kind 带 @1 后缀，先剥掉版本再匹配）。
const TASK_KIND_LABELS = {
  'model.chat': '模型生成',
  'model.test': '连接测试',
  'net.fetch-text': '网页抓取',
  'files.download': '文件下载',
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

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function ratingText(value) {
  const rating = Math.min(Math.max(Number(value) || 0, 0), 5);
  return rating ? `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}` : '未评分';
}

function metadataTokens(paper) {
  return [...papers.paperCategories(paper), ...papers.paperTags(paper)];
}

// ---------------- 视图切换与主导航 ----------------
function showView(name) {
  currentView = name;
  $('#view-library').hidden = name !== 'library';
  $('#view-tasks').hidden = name !== 'tasks';
  $('#view-reader').hidden = name !== 'reader';
  $('#nav-library').classList.toggle('active', name === 'library' || name === 'reader');
  $('#nav-tasks').classList.toggle('active', name === 'tasks');
  setTasksPolling(name === 'tasks');
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
  $('#streak-badge').textContent = total ? `🔥 连续 ${papers.streakDays(library)} 天 · 已读 ${total} 篇 · 精读 ${doneCount}/${sectionCount}` : '';
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
      (!ratingFilter || (Number(paper.rating) || 0) >= ratingFilter);
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
    dots.title = `精读进度 ${done}/${total}`;
    for (const def of defs) {
      const dot = document.createElement('span');
      dot.className = 'pdot' + (p.analyses?.[def.id]?.text ? ' done' : '');
      dots.appendChild(dot);
    }
    const added = document.createElement('span');
    added.textContent = `${p.numPages ? p.numPages + ' 页 · ' : ''}导入于 ${fmtDate(p.addedAt)}`;
    sub.append(dots, added);
    if (done) {
      const recent = document.createElement('span');
      recent.textContent = `最近精读 ${fmtDate(Math.max(...Object.values(p.analyses).map(a => a.updatedAt || 0)))}`;
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
      await papers.removeRecord(p.id);
      refreshLibrary();
    };
    actions.append(openBtn, delBtn);

    card.append(title, sub, metadata, actions);
    card.onclick = () => openPaper(p);
    list.appendChild(card);
  }
}

// ---------------- 阅读位置 ----------------
// tab 切换、精读节点击、PDF 翻页、离开论文时保存；500ms 防抖；写入失败静默。

function positionSnapshot(paper, viewOverride) {
  const view = viewOverride || currentTab;
  return {
    paperId: paper.id,
    view,
    sectionId: view === 'digest' ? digestSection : null,
    pdfPage: pdfDocument ? pdfPage : null,
  };
}

function schedulePositionSave(viewOverride) {
  if (!current) return;
  const paper = current;
  clearTimeout(positionTimer);
  positionTimer = setTimeout(async () => {
    positionTimer = null;
    if (current !== paper) return;
    try { await store.positions.put(positionSnapshot(paper, viewOverride)); } catch { /* 失败静默 */ }
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
  revokeRecallBlobUrls();
  current = p;
  digestSection = papers.readingParts(p)[0]?.id || 'abstract';
  sourceTab = 'abstract';
  translateSection = digestSection;
  pdfPage = 1;
  pdfScale = 1;
  pdfSidebarOpen = true;
  $('#paste-area').value = '';
  $('#reader-title').textContent = p.title;
  showView('reader');
  switchTab('digest', { restore: true });
  renderDigest();
  renderRecall();
  renderSource();
  renderTranslate();
  renderChat();
  updatePdfSidebar();
  // 恢复阅读位置：tab 与 PDF 页码；读取失败静默。
  let restored = null;
  try { restored = await store.positions.get(p.id); } catch { restored = null; }
  if (restored && current === p) {
    if (restored.view && restored.view !== 'pdf' && READER_TABS.includes(restored.view)) {
      switchTab(restored.view, { restore: true });
    }
    if (restored.view === 'digest' && restored.sectionId &&
        papers.readingParts(p).some(def => def.id === restored.sectionId)) {
      setActiveDigestSection(restored.sectionId, { silent: true });
    }
    if (Number.isFinite(restored.pdfPage)) pdfPage = restored.pdfPage;
  }
  initPdfViewer();
}

async function closePaper() {
  const paper = current;
  if (paper) await flushPositionSave(paper);
  destroyPdfViewer();
  // 离开即取消进行中的生成：生成任务经 cancelForPaper 中断，问答/翻译/回忆卡各自中断。
  const settling = paper ? generation.cancelForPaper(paper) : null;
  chatAborter?.abort();
  translateAborter?.abort();
  recallAborter?.abort();
  current = null;
  revokeRecallBlobUrls();
  showView('library');
  // 等待生成任务收尾（中断保存完成）再刷新书库，避免读到落库前的旧快照。
  if (settling) await settling.catch(() => {});
  refreshLibrary();
}

function switchTab(name, { restore = false } = {}) {
  currentTab = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  for (const id of READER_TABS) {
    $(`#tab-${id}`).hidden = id !== name;
  }
  if (!restore) schedulePositionSave();
}

function updateReaderMeta() {
  if (!current) return;
  const { done, total } = papers.readingProgress(current);
  const categories = papers.paperCategories(current);
  const tags = papers.paperTags(current);
  const details = [
    current.numPages ? `${current.numPages} 页` : '',
    `导入于 ${fmtDate(current.addedAt)}`,
    `精读进度 ${done}/${total}`,
    ratingText(current.rating),
    categories.join(' · '),
    tags.length ? tags.map(tag => `#${tag}`).join(' ') : '',
  ].filter(Boolean);
  $('#reader-meta').textContent = details.join(' · ');
  updateStreakBadge();
}

// ---------------- AI 精读（分节卡片流） ----------------
function setActiveDigestSection(sectionId, { silent = false } = {}) {
  digestSection = sectionId;
  $$('#digest-cards .digest-card').forEach(card => {
    card.classList.toggle('active', card.id === `card-${sectionId}`);
  });
  if (!silent) {
    syncPdfToSection(sectionId);
    schedulePositionSave('digest');
  }
}

function renderDigest() {
  const defs = papers.readingParts(current);
  const wrap = $('#digest-cards');
  wrap.innerHTML = '';
  const anyMissing = defs.some(s => !current.sections?.[s.id]);
  $('#digest-hint').textContent = anyMissing
    ? '部分章节未能自动识别，可在卡片内手动粘贴该节原文。'
    : '每个章节使用对应「技能」生成精读，可在技能库中自定义提示词。';
  for (const def of defs) {
    wrap.appendChild(buildDigestCard(def));
  }
  setActiveDigestSection(
    defs.some(def => def.id === digestSection) ? digestSection : defs[0]?.id,
    { silent: true },
  );
  updateReaderMeta();
}

function buildDigestCard(def) {
  const analysis = current.analyses?.[def.id];
  const hasSource = !!(current.sections?.[def.id]?.trim());
  const card = document.createElement('article');
  card.className = 'digest-card';
  card.id = `card-${def.id}`;
  card.innerHTML = `
      <div class="dc-head">
        <h4>${escapeTemplate(def.label)}<span class="dc-sub">${escapeTemplate(def.hint)}</span></h4>
        <span class="dc-status" data-role="status"></span>
        <button class="btn small primary" data-role="gen" type="button">${analysis?.text ? '重新生成' : '生成精读'}</button>
      </div>
      ${hasSource ? '' : `
        <div class="dc-body dc-manual">
          <p class="muted">未能从 PDF 自动提取本节原文，可手动粘贴（不影响其它章节）：</p>
          <textarea rows="4" data-role="manual" placeholder="粘贴本节英文原文……"></textarea>
          <button class="btn small" data-role="save-manual" type="button">保存原文</button>
        </div>`}
      <div class="dc-body md" data-role="body"></div>`;
  const body = card.querySelector('[data-role="body"]');
  const status = card.querySelector('[data-role="status"]');
  if (analysis?.text) {
    renderMarkdownInto(body, analysis.text);
    status.textContent = `✓ ${fmtDate(analysis.updatedAt)}`;
    status.className = 'dc-status ok';
  } else if (!hasSource) {
    body.classList.add('empty-hint');
    body.textContent = '';
  } else {
    body.classList.add('empty-hint');
    body.textContent = '尚未生成。点击右上「生成精读」开始。';
  }
  const genBtn = card.querySelector('[data-role="gen"]');
  genBtn.onclick = event => {
    event.stopPropagation();
    setActiveDigestSection(def.id);
    generateSection(def.id);
  };
  // 点击卡片头部（按钮以外）视为「精读节点击」：激活该节、联动 PDF、记录阅读位置。
  card.querySelector('.dc-head').onclick = () => setActiveDigestSection(def.id);
  const saveBtn = card.querySelector('[data-role="save-manual"]');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const txt = card.querySelector('[data-role="manual"]').value.trim();
      if (!txt) return toast('请先粘贴原文', true);
      await papers.saveSectionSource(current, def.id, txt);
      toast('已保存本节原文，现在可以生成精读了');
      renderDigest();
    };
  }
  return card;
}

function setCardStatus(sectionId, text, cls) {
  const el = $(`#card-${sectionId} [data-role="status"]`);
  if (el) { el.textContent = text; el.className = 'dc-status ' + (cls || ''); }
}

// 卡片可能被 renderDigest 重建（手动粘贴保存后等），返回的渲染目标可能已脱离 DOM。
function digestCardRefs(sectionId) {
  const card = $(`#card-${sectionId}`);
  if (!card) return null;
  return {
    body: card.querySelector('[data-role="body"]'),
    btn: card.querySelector('[data-role="gen"]'),
  };
}

function generateSection(sectionId) {
  const refs = digestCardRefs(sectionId);
  if (!refs) return;
  const started = generation.startSection(current, sectionId, {
    onStart: () => markCardGenerating(sectionId, refs.body, refs.btn),
    onUpdate: full => renderMarkdownInto(refs.body, full),
    onSettled: result => settleDigestCard(sectionId, result, refs),
  });
  if (!started.accepted) {
    toast(started.reason === 'no-source' ? '该章节没有原文，请先在卡片中粘贴原文' : '已有生成任务进行中', true);
  }
}

function markCardGenerating(sectionId, body, btn) {
  btn.disabled = true;
  body.classList.remove('empty-hint');
  body.classList.add('cursor');
  setCardStatus(sectionId, '生成中…', '');
}

function settleDigestCard(sectionId, result, { body, btn }, { silent = false } = {}) {
  body.classList.remove('cursor');
  if (result.status === 'completed') {
    renderMarkdownInto(body, result.text);
    setCardStatus(sectionId, `✓ ${fmtDate(Date.now())}`, 'ok');
    btn.textContent = '重新生成';
    updateReaderMeta();
  } else if (result.status === 'cancelled' && result.saved) {
    setCardStatus(sectionId, '⚠ 已停止（保留部分）', 'err');
  } else {
    body.classList.add('empty-hint');
    body.textContent = result.status === 'cancelled' ? '已停止生成。' : `生成失败：${result.error.message}`;
    setCardStatus(sectionId, result.status === 'cancelled' ? '已停止' : '失败', 'err');
    if (!silent) toast(result.error.message, true);
  }
  btn.disabled = false;
}

async function generateAll() {
  if (!model.settingsReady()) {
    toast('请先在「设置」中配置 API', true);
    openSettingsModal();
    return;
  }
  const paper = current;
  const initialSection = digestSection;
  const started = generation.startBatch(paper, {
    onSectionStart(def) {
      setActiveDigestSection(def.id, { silent: true });
      $(`#card-${def.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const refs = digestCardRefs(def.id);
      return {
        onStart: () => markCardGenerating(def.id, refs.body, refs.btn),
        onUpdate: full => renderMarkdownInto(refs.body, full),
      };
    },
    onSectionSettled(def, result) {
      if (result.status === 'skipped') return;
      const refs = digestCardRefs(def.id);
      if (!refs) return;
      settleDigestCard(def.id, result, refs, { silent: true });
    },
  });
  if (!started.accepted) {
    toast('已有生成任务进行中', true);
    return;
  }
  activeBatch = started.batch;
  $('#btn-gen-all').disabled = true;
  $('#btn-stop').hidden = false;
  // 任何异常都不能跳过按钮与章节的恢复，否则按钮永久卡死。
  let result = null;
  try {
    result = await started.done;
  } finally {
    activeBatch = null;
    $('#btn-gen-all').disabled = false;
    $('#btn-stop').hidden = true;
    digestSection = initialSection;
  }
  if (current === paper) {
    renderDigest();
    toast(result.status === 'completed' ? '全部精读生成完毕' : '已停止');
  }
}

function stopGeneration() {
  activeBatch?.cancel();
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
  $('#recall-editor').value = card.markdown || '';
  $('#recall-status').textContent = card.updatedAt ? `已保存 · ${fmtDate(card.updatedAt)}` : '';
  $('#btn-recall-generate').textContent = card.markdown ? '重新生成 AI 草稿' : '生成 AI 草稿';
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
  if (!model.settingsReady()) {
    toast('请先在「设置」中配置 API', true);
    openSettingsModal();
    return;
  }
  const completed = papers.readingParts(current)
    .map(def => ({ def, text: current.analyses?.[def.id]?.text?.trim() }))
    .filter(item => item.text);
  if (!completed.length) return toast('请先完成至少一个章节的 AI 精读', true);
  if ($('#recall-editor').value.trim() && !confirm('重新生成会覆盖当前卡片文字，已添加的图片会保留。继续吗？')) return;

  const source = completed.map(({ def, text }) => `===== ${def.label} =====\n${text}`).join('\n\n').slice(0, 32000);
  const messages = [
    {
      role: 'system',
      content: '你是论文回忆卡编辑器。根据精读笔记生成高度凝练、事实准确、便于快速复习的中文 Markdown 卡片。不要复述章节结构，不要编造笔记中没有的信息。',
    },
    {
      role: 'user',
      content: `论文标题：${current.title}\n\n精读笔记：\n${source}\n\n请严格使用以下结构：\n## 一句话回忆\n一句话说明这项工作解决什么问题、如何解决。\n\n## 主要贡献\n- 2 至 4 条最重要贡献\n\n## 核心创新\n- 2 至 4 条方法或设计创新，并说明为什么有效\n\n## 关键证据\n- 最能支撑结论的实验结果或消融\n\n## 使用边界\n- 局限、适用条件或需要继续确认的问题`,
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
    button.disabled = false;
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
function renderSource() {
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
    chip.onclick = () => { sourceTab = def.id; renderSource(); };
    chips.appendChild(chip);
  }
  const text = sourceTab === '__full' ? current.fullText : current.sections?.[sourceTab];
  const anySection = paperDefs.some(s => current.sections?.[s.id]?.trim());
  $('#source-empty').hidden = anySection;
  $('#source-text').textContent = text || (anySection ? '（本节未提取到内容）' : '');
}

// ---------------- 独立翻译 ----------------
function renderTranslate() {
  if (!current) return;
  const select = $('#translate-section');
  const defs = [...papers.readingParts(current), { id: '__full', label: '全文' }];
  if (!defs.some(def => def.id === translateSection)) translateSection = defs[0]?.id || '__full';
  select.innerHTML = '';
  for (const def of defs) {
    const option = document.createElement('option');
    option.value = def.id;
    option.textContent = def.label;
    option.disabled = !(def.id === '__full' ? current.fullText : current.sections?.[def.id]?.trim());
    option.selected = def.id === translateSection;
    select.appendChild(option);
  }
  loadTranslationSection();
}

function loadTranslationSection() {
  if (!current) return;
  const source = translateSection === '__full' ? current.fullText : current.sections?.[translateSection];
  $('#translate-source').value = source || '';
  const saved = current.translations?.[papers.translationKey(translateSection, $('#translate-language').value)];
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
  const source = $('#translate-source').value.trim();
  if (!source) return toast('请先选择或输入待翻译原文', true);
  if (!model.settingsReady()) {
    toast('请先在「设置」中配置 API', true);
    openSettingsModal();
    return;
  }
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

  // 翻译调用只包含专用系统提示和编辑框原文，不复用论文问答上下文或聊天历史。
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
      });
      translated.push(piece);
    }
    const text = translated.join('\n\n');
    if (!text.trim()) throw new Error('模型未返回译文');
    renderMarkdownInto(output, text);
    await papers.saveTranslation(current, translateSection, language, text, source);
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
function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[……原文过长，已截断……]';
}

function buildChatContext(p) {
  const cap = 5000;
  const parts = [`论文标题：${p.title}`];
  for (const def of papers.readingParts(p)) {
    const t = p.sections?.[def.id]?.trim();
    if (t) parts.push(`\n===== ${def.label} =====\n${truncate(t, cap)}`);
  }
  // 函数形式替换：标题与上下文按字面注入，避免 $ 模式被替换值解释。
  return CHAT_SYSTEM_TEMPLATE
    .replaceAll('{title}', () => p.title)
    .replaceAll('{content}', () => parts.join('\n').slice(0, 24000));
}

function renderChat() {
  const log = $('#chat-log');
  log.innerHTML = '';
  const msgs = current.chat || [];
  if (!msgs.length) {
    const hint = document.createElement('div');
    hint.className = 'empty';
    hint.style.padding = '24px';
    hint.textContent = '基于这篇论文向 AI 提问，例如：「这个方法相比 Transformer 的核心区别是什么？」「消融实验说明了什么？」';
    log.appendChild(hint);
    return;
  }
  for (const m of msgs) appendChatBubble(m.role, m.content);
  log.scrollTop = log.scrollHeight;
}

function appendChatBubble(role, content, extraClass = '') {
  const log = $('#chat-log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  const div = document.createElement('div');
  div.className = `chat-msg ${role} ${role === 'assistant' ? 'md' : ''} ${extraClass}`;
  if (role === 'user') div.textContent = content;
  else renderMarkdownInto(div, content);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function sendChat() {
  const input = $('#chat-input');
  const q = input.value.trim();
  if (!q || activeBatch) return;
  // 捕获当前论文引用：问答期间用户可能返回书库（current 置 null）。
  const paper = current;
  input.value = '';
  await papers.appendChatMessage(paper, { role: 'user', content: q });
  appendChatBubble('user', q);
  const bubble = appendChatBubble('assistant', '…');

  const history = paper.chat.slice(-12).map(m => ({ role: m.role, content: m.content }));
  const messages = [
    { role: 'system', content: buildChatContext(paper) },
    ...history,
  ];
  chatAborter = new AbortController();
  try {
    const text = await model.chat(messages, {
      stream: true,
      signal: chatAborter.signal,
      onDelta: full => { renderMarkdownInto(bubble, full); $('#chat-log').scrollTop = $('#chat-log').scrollHeight; },
    });
    renderMarkdownInto(bubble, text || '（无回复）');
    // assistant 完成才落库；中断（AbortError）不落库。
    await papers.appendChatMessage(paper, { role: 'assistant', content: text });
  } catch (err) {
    bubble.classList.add('err');
    if (err.name === 'AbortError') {
      bubble.textContent = '已停止。';
    } else {
      bubble.textContent = `出错了：${err.message}`;
      await papers.appendChatMessage(paper, { role: 'assistant', content: `（出错：${err.message}）` });
    }
  } finally {
    chatAborter = null;
  }
}

// ---------------- PDF 对照阅读 ----------------
function hasPdf(paper = current) {
  return store.pdf.has(paper);
}

function updatePdfSidebar() {
  const workspace = $('#reader-workspace');
  workspace.classList.toggle('pdf-closed', !pdfSidebarOpen);
  $('#pdf-sidebar').hidden = !pdfSidebarOpen;
  $('#btn-pdf-toggle').setAttribute('aria-expanded', String(pdfSidebarOpen));
  $('#btn-pdf-toggle').classList.toggle('active', pdfSidebarOpen);
  $('#pdf-empty').hidden = !pdfSidebarOpen || hasPdf();
  $('#pdf-viewer').hidden = !pdfSidebarOpen || !hasPdf();
  renderPdfTasks();
}

function togglePdfSidebar(force) {
  pdfSidebarOpen = typeof force === 'boolean' ? force : !pdfSidebarOpen;
  updatePdfSidebar();
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

// 用户主动翻页后保存阅读位置（500ms 防抖），view 记为 'pdf'；
// 不在 renderPdfPage 内保存，避免打开论文时的首次渲染覆盖刚恢复的 tab 位置。
function savePdfPagePosition() {
  if (!current || !pdfDocument) return;
  schedulePositionSave('pdf');
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

function syncPdfToSection(sectionId) {
  const start = current?.sectionPages?.[sectionId]?.start;
  if (!pdfDocument || !Number.isFinite(start)) return;
  pdfPage = start;
  renderPdfPage();
  savePdfPagePosition();
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
  const meta = [
    `导入日期：${fmtDate(current.addedAt)}`,
    `导出日期：${fmtDate(Date.now())}`,
    `评分：${ratingText(current.rating)}`,
    papers.paperCategories(current).length ? `分类：${papers.paperCategories(current).join('、')}` : '',
    papers.paperTags(current).length ? `标签：${papers.paperTags(current).join('、')}` : '',
  ].filter(Boolean).join(' · ');
  const lines = [`# 精读笔记：${current.title}`, '', `> ${meta}`, ''];
  if (current.recallCard?.markdown) {
    lines.push('## 回想卡片', '', current.recallCard.markdown, '');
  }
  for (const def of papers.readingParts(current)) {
    lines.push(`## ${def.label}`, '');
    lines.push(current.analyses?.[def.id]?.text || '（尚未生成精读）', '');
  }
  const safeTitle = current.title.slice(0, 60).replace(/[\\/:*?"<>|]/g, '_');
  try {
    const written = await exportTextFile(`《${safeTitle}》精读笔记.md`, lines.join('\n'), '导出精读笔记');
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
    lastActiveTasks = result?.tasks || [];
    const badge = $('#nav-tasks-badge');
    badge.hidden = lastActiveTasks.length === 0;
    badge.textContent = String(lastActiveTasks.length);
    renderPdfTasks();
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
  $('#brand-home').onclick = () => { if (current) closePaper(); else showView('library'); };
  $('#nav-library').onclick = () => { if (current) closePaper(); else showView('library'); };
  $('#nav-tasks').onclick = () => showView('tasks');
  $('#btn-back').onclick = closePaper;
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
  $('#btn-filter-reset').onclick = () => {
    libraryQuery = '';
    categoryFilter = '';
    ratingFilter = 0;
    $('#library-search').value = '';
    $('#filter-rating').value = '0';
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

  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
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
  $('#btn-pdf-close').onclick = () => togglePdfSidebar(false);
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

  $('#translate-section').onchange = e => {
    translateSection = e.target.value;
    loadTranslationSection();
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

  $('#btn-gen-all').onclick = generateAll;
  $('#btn-stop').onclick = stopGeneration;
  $('#btn-export').onclick = exportNotes;

  $('#btn-paste-split').onclick = async () => {
    const text = $('#paste-area').value.trim();
    if (!text) return toast('请先粘贴全文', true);
    const parsed = parser.parsePlainText(text);
    const { discarded } = await papers.applyResplit(current, parsed);
    $('#paste-area').value = '';
    renderSource();
    renderDigest();
    $('#source-empty').hidden = true;
    const found = papers.readingParts(current).filter(s => current.sections?.[s.id]?.trim()).length;
    toast(discarded
      ? `重新切分完成，识别出 ${found} 个精读部分；${discarded} 条已失效的精读/翻译结果被作废`
      : `重新切分完成，识别出 ${found} 个精读部分`);
  };

  $('#btn-chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
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
      if (pdfSidebarOpen && pdfDocument) fitPdfPage();
    }, 180);
  });

  bindCloseFlow();
}

// ---------------- 启动序列 ----------------
model.initModel(bridge);
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
