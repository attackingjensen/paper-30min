// 主逻辑：书库 / 精读 / 原文 / 问答 / 设置 / 技能库
import * as db from './db.js';
import * as api from './api.js';
import { renderMarkdown, typesetMath } from './markdown.js';
import {
  effectiveSkills, getSkill, buildPrompt, saveCustomSkill, resetSkill,
  parseSkillFile, loadCustomSkills, CHAT_SYSTEM_TEMPLATE,
} from './skills.js';
import { parseArxivHtml, parsePdfFile, parsePlainText } from './parser.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const SECTION_DEFS = [
  { id: 'abstract',     skillId: 'abstract',     label: 'Abstract · 摘要',      hint: '英文原文 + 规范中文翻译' },
  { id: 'introduction', skillId: 'introduction', label: 'Introduction · 引言',  hint: '领域背景 / 相关工作 / 要解决的问题 / 贡献' },
  { id: 'method',       skillId: 'method',       label: 'Method · 方法',        hint: '核心创新点 / 方法详解 / 为什么有效' },
  { id: 'experiments',  skillId: 'experiments',  label: 'Experiment · 实验',    hint: '基准与结果 / 训练推理细节 / 消融实验 / 洞察' },
];

function paperSectionDefs(paper) {
  if (!paper?.parts?.length) return SECTION_DEFS;
  const abstract = SECTION_DEFS[0];
  const parts = paper.parts.map((part, index) => ({
    id: part.id,
    skillId: part.semanticType === 'experiments'
      ? 'experiments'
      : part.semanticType === 'introduction'
        ? 'introduction'
        : part.semanticType === 'method'
          ? 'method'
          : 'part',
    label: `第 ${index + 1} 部分 · ${part.title || part.heading || '未命名章节'}`,
    pickerLabel: part.title || `第 ${index + 1} 部分`,
    hint: part.semanticType === 'experiments'
      ? '实验设置 / 主要结果 / 消融与洞察'
      : `论文正文第 ${index + 1} 部分 · ${part.semanticType === 'method' ? '方法深度精读' : '通用章节精读'}`,
  }));
  return [abstract, ...parts];
}

function escapeTemplate(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------- 全局状态 ----------------
let papers = [];
let current = null;          // 当前打开的论文
let aborter = null;          // 生成中断控制器
let generating = false;
let editingSkillId = null;
let digestSection = 'abstract';
let translateSection = 'abstract';
let translateAborter = null;
let pdfDocument = null;
let pdfRenderTask = null;
let pdfPage = 1;
let pdfScale = 1;
let pdfSidebarOpen = true;

function renderMarkdownInto(element, text) {
  element.innerHTML = renderMarkdown(text);
  typesetMath(element);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: isError ? '#d64545' : '#1f2430', color: '#fff', padding: '9px 18px',
    borderRadius: '8px', zIndex: 200, fontSize: '13.5px', boxShadow: '0 6px 24px rgba(0,0,0,.25)',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------------- 打卡（连续天数） ----------------
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function updateStreakBadge() {
  const streak = computeStreak();
  const total = papers.length;
  const doneCount = papers.reduce((n, p) => n + paperSectionDefs(p).filter(s => p.analyses?.[s.id]?.text).length, 0);
  const sectionCount = papers.reduce((n, p) => n + paperSectionDefs(p).length, 0);
  $('#streak-badge').textContent = total ? `🔥 连续 ${streak} 天 · 已读 ${total} 篇 · 精读 ${doneCount}/${sectionCount} 节` : '';
}

function computeStreak() {
  const days = new Set();
  for (const p of papers) {
    days.add(dayKey(p.addedAt));
    for (const a of Object.values(p.analyses || {})) if (a?.updatedAt) days.add(dayKey(a.updatedAt));
  }
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // 今天还没读，从昨天算起
  while (days.has(dayKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

// ---------------- 书库视图 ----------------
async function refreshLibrary() {
  papers = (await db.getAllPapers()).sort((a, b) => b.addedAt - a.addedAt);
  const list = $('#paper-list');
  list.innerHTML = '';
  $('#empty-state').hidden = papers.length > 0;

  updateStreakBadge();

  const ready = api.settingsReady();
  const warn = $('#api-warning');
  warn.hidden = ready;
  if (!ready) warn.textContent = '⚠️ 尚未配置大模型 API，AI 精读功能暂不可用。点击这里前往设置（支持 OpenAI / DeepSeek / Moonshot / 通义 / Ollama 等兼容接口）。';

  for (const p of papers) {
    const card = document.createElement('div');
    card.className = 'paper-card';
    const defs = paperSectionDefs(p);
    const done = defs.filter(s => p.analyses?.[s.id]?.text).length;
    card.innerHTML = `
      <div style="min-width:0;flex:1">
        <p class="pc-title"></p>
        <div class="pc-sub">
          <span class="progress-dots" title="精读进度 ${done}/${defs.length}">${defs.map(s =>
            `<span class="pdot ${p.analyses?.[s.id]?.text ? 'done' : ''}"></span>`).join('')}</span>
          <span>${p.numPages ? p.numPages + ' 页 · ' : ''}导入于 ${fmtDate(p.addedAt)}</span>
          ${done ? `<span>最近精读 ${fmtDate(Math.max(...Object.values(p.analyses).map(a => a.updatedAt || 0)))}</span>` : ''}
        </div>
      </div>
      <div class="pc-actions">
        <button class="btn small primary" data-act="open">继续阅读</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div>`;
    card.querySelector('.pc-title').textContent = p.title;
    card.querySelector('.pc-title').onclick = () => openPaper(p);
    card.querySelector('[data-act="open"]').onclick = () => openPaper(p);
    card.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`确定删除「${p.title.slice(0, 40)}…」及其精读记录？`)) return;
      await db.deletePaper(p.id);
      refreshLibrary();
    };
    list.appendChild(card);
  }
}

// ---------------- 精读视图 ----------------
function openPaper(p) {
  current = p;
  digestSection = paperSectionDefs(p)[0]?.id || 'abstract';
  sourceTab = 'abstract';
  translateSection = digestSection;
  pdfPage = 1;
  pdfScale = 1;
  pdfSidebarOpen = true;
  $('#view-library').hidden = true;
  $('#view-reader').hidden = false;
  $('#reader-title').textContent = p.title;
  switchTab('digest');
  renderDigest();
  renderSource();
  renderTranslate();
  renderChat();
  updatePdfSidebar();
  initPdfViewer();
}

function closePaper() {
  destroyPdfViewer();
  translateAborter?.abort();
  current = null;
  $('#view-reader').hidden = true;
  $('#view-library').hidden = false;
  refreshLibrary();
}

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  for (const id of ['digest', 'source', 'translate', 'chat']) {
    $(`#tab-${id}`).hidden = id !== name;
  }
}

function updateReaderMeta() {
  if (!current) return;
  const defs = paperSectionDefs(current);
  const done = defs.filter(s => current.analyses?.[s.id]?.text).length;
  $('#reader-meta').textContent = `${current.numPages ? current.numPages + ' 页 · ' : ''}导入于 ${fmtDate(current.addedAt)} · 精读进度 ${done}/${defs.length}`;
  updateStreakBadge();
}

function renderDigest() {
  const defs = paperSectionDefs(current);
  const picker = $('#digest-section-picker');
  const wrap = $('#digest-cards');
  picker.innerHTML = '';
  wrap.innerHTML = '';
  const anyMissing = defs.some(s => !current.sections?.[s.id]);
  $('#digest-hint').textContent = anyMissing
    ? '部分章节未能自动识别，可在卡片内手动粘贴该节原文。'
    : '每个章节使用对应「技能」生成精读，可在技能库中自定义提示词。';

  for (const def of defs) {
    const analysis = current.analyses?.[def.id];
    const button = document.createElement('button');
    button.className = 'digest-section-option' + (def.id === digestSection ? ' active' : '');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(def.id === digestSection));
    button.innerHTML = `<span>${escapeTemplate(def.pickerLabel || def.label.split(' · ')[0])}</span><small>${analysis?.text ? '已完成' : '待精读'}</small>`;
    button.onclick = () => {
      if (digestSection === def.id) return;
      digestSection = def.id;
      renderDigest();
      syncPdfToSection(def.id);
    };
    picker.appendChild(button);
  }

  const def = defs.find(section => section.id === digestSection) || defs[0];
  const card = document.createElement('article');
  card.className = 'digest-card';
  card.id = `card-${def.id}`;
  const analysis = current.analyses?.[def.id];
  const hasSource = !!(current.sections?.[def.id]?.trim());
  card.innerHTML = `
      <div class="dc-head">
        <h4>${escapeTemplate(def.label)}<span class="dc-sub">${escapeTemplate(def.hint)}</span></h4>
        <span class="dc-status" data-role="status"></span>
        <button class="btn small primary" data-role="gen">${analysis?.text ? '重新生成' : '生成精读'}</button>
      </div>
      ${hasSource ? '' : `
        <div class="dc-body dc-manual">
          <p class="muted">未能从 PDF 自动提取本节原文，可手动粘贴（不影响其它章节）：</p>
          <textarea rows="4" data-role="manual" placeholder="粘贴本节英文原文……"></textarea>
          <button class="btn small" data-role="save-manual">保存原文</button>
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
  card.querySelector('[data-role="gen"]').onclick = () => generateSection(def.id);
  const saveBtn = card.querySelector('[data-role="save-manual"]');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const txt = card.querySelector('[data-role="manual"]').value.trim();
      if (!txt) return toast('请先粘贴原文', true);
      current.sections[def.id] = txt;
      current.updatedAt = Date.now();
      await db.putPaper(current);
      toast('已保存本节原文，现在可以生成精读了');
      renderDigest();
    };
  }
  wrap.appendChild(card);
  updateReaderMeta();
}

function setCardStatus(sectionId, text, cls) {
  const el = $(`#card-${sectionId} [data-role="status"]`);
  if (el) { el.textContent = text; el.className = 'dc-status ' + (cls || ''); }
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[……原文过长，已截断……]';
}

async function generateSection(sectionId, { silent = false } = {}) {
  const def = paperSectionDefs(current).find(section => section.id === sectionId);
  const skill = getSkill(def?.skillId || sectionId);
  const content = current.sections?.[sectionId]?.trim();
  if (!content) {
    if (!silent) toast('该章节没有原文，请先在卡片中粘贴原文', true);
    return false;
  }
  const { maxChars } = api.loadSettings();
  const prompt = buildPrompt(skill, current.title, truncate(content, maxChars), def?.label || sectionId);

  const card = $(`#card-${sectionId}`);
  const body = card.querySelector('[data-role="body"]');
  const btn = card.querySelector('[data-role="gen"]');
  btn.disabled = true;
  body.classList.remove('empty-hint');
  body.classList.add('cursor');
  setCardStatus(sectionId, '生成中…', '');

  aborter = new AbortController();
  try {
    const text = await api.chat([{ role: 'user', content: prompt }], {
      stream: true,
      signal: aborter.signal,
      onDelta: full => { renderMarkdownInto(body, full); },
    });
    body.classList.remove('cursor');
    if (!text.trim()) throw new Error('模型未返回内容');
    renderMarkdownInto(body, text);
    current.analyses = current.analyses || {};
    current.analyses[sectionId] = { text, updatedAt: Date.now() };
    current.updatedAt = Date.now();
    await db.putPaper(current);
    setCardStatus(sectionId, `✓ ${fmtDate(Date.now())}`, 'ok');
    btn.textContent = '重新生成';
    updateReaderMeta();
    return true;
  } catch (err) {
    body.classList.remove('cursor');
    const aborted = err.name === 'AbortError';
    const partial = body.textContent.trim();
    if (aborted && partial.length > 60) {
      current.analyses = current.analyses || {};
      current.analyses[sectionId] = { text: partial + '\n\n> ⚠️ 生成被中断，内容为部分结果。', updatedAt: Date.now() };
      await db.putPaper(current);
      setCardStatus(sectionId, '⚠ 已停止（保留部分）', 'err');
    } else {
      body.classList.add('empty-hint');
      body.innerHTML = aborted ? '已停止生成。' : `生成失败：${err.message}`;
      setCardStatus(sectionId, aborted ? '已停止' : '失败', 'err');
      if (!silent) toast(err.message, true);
    }
    return false;
  } finally {
    btn.disabled = false;
    aborter = null;
  }
}

async function generateAll() {
  if (generating) return;
  if (!api.settingsReady()) {
    toast('请先在「设置」中配置 API', true);
    openSettingsModal();
    return;
  }
  generating = true;
  const initialSection = digestSection;
  $('#btn-gen-all').disabled = true;
  $('#btn-stop').hidden = false;
  for (const def of paperSectionDefs(current)) {
    if (!generating) break;
    digestSection = def.id;
    renderDigest();
    await generateSection(def.id, { silent: true });
  }
  const completed = generating;
  finishBatch();
  digestSection = initialSection;
  renderDigest();
  toast(completed ? '全部精读生成完毕' : '已停止');
}

function stopGeneration() {
  generating = false;
  aborter?.abort();
}

function finishBatch() {
  generating = false;
  $('#btn-gen-all').disabled = false;
  $('#btn-stop').hidden = true;
}

// ---------------- 原文视图 ----------------
let sourceTab = 'abstract';

function renderSource() {
  const chips = $('#source-chips');
  chips.innerHTML = '';
  const paperDefs = paperSectionDefs(current);
  const defs = [...paperDefs, { id: 'conclusion', label: 'Conclusion' }, { id: '__full', label: '全文' }];
  for (const def of defs) {
    const has = def.id === '__full' ? !!current.fullText : !!current.sections?.[def.id]?.trim();
    const chip = document.createElement('button');
    chip.className = 'chip' + (def.id === sourceTab ? ' active' : '');
    chip.textContent = def.label + (has ? '' : '（缺）');
    chip.onclick = () => { sourceTab = def.id; renderSource(); };
    chips.appendChild(chip);
  }
  const text = sourceTab === '__full' ? current.fullText : current.sections?.[sourceTab];
  const anySection = paperDefs.some(s => current.sections?.[s.id]?.trim());
  $('#source-empty').hidden = anySection;
  $('#source-text').textContent = text || (anySection ? '（本节未提取到内容）' : '');
}

// ---------------- PDF 对照阅读 ----------------
function hasPdf(paper = current) {
  return paper?.pdfBlob instanceof Blob && paper.pdfBlob.size > 0;
}

function updatePdfSidebar() {
  const workspace = $('#reader-workspace');
  workspace.classList.toggle('pdf-closed', !pdfSidebarOpen);
  $('#pdf-sidebar').hidden = !pdfSidebarOpen;
  $('#btn-pdf-toggle').setAttribute('aria-expanded', String(pdfSidebarOpen));
  $('#btn-pdf-toggle').classList.toggle('active', pdfSidebarOpen);
  $('#pdf-empty').hidden = !pdfSidebarOpen || hasPdf();
  $('#pdf-viewer').hidden = !pdfSidebarOpen || !hasPdf();
}

function togglePdfSidebar(force) {
  pdfSidebarOpen = typeof force === 'boolean' ? force : !pdfSidebarOpen;
  updatePdfSidebar();
  if (pdfSidebarOpen && hasPdf() && !pdfDocument) initPdfViewer();
  if (pdfSidebarOpen && pdfDocument) requestAnimationFrame(() => fitPdfPage());
}

async function destroyPdfViewer() {
  pdfRenderTask?.cancel();
  pdfRenderTask = null;
  if (pdfDocument) {
    try { await pdfDocument.destroy(); } catch { /* ignore cleanup errors */ }
  }
  pdfDocument = null;
  const canvas = $('#pdf-canvas');
  canvas.width = 0;
  canvas.height = 0;
}

async function initPdfViewer() {
  await destroyPdfViewer();
  updatePdfSidebar();
  if (!current || !hasPdf()) return;
  const loading = $('#pdf-loading');
  loading.hidden = false;
  loading.textContent = '正在载入 PDF…';
  try {
    const data = await current.pdfBlob.arrayBuffer();
    pdfDocument = await pdfjsLib.getDocument({ data }).promise;
    pdfPage = Math.min(Math.max(pdfPage, 1), pdfDocument.numPages);
    $('#pdf-page-input').max = pdfDocument.numPages;
    $('#pdf-page-count').textContent = `/ ${pdfDocument.numPages}`;
    if (current.numPages !== pdfDocument.numPages) {
      current.numPages = pdfDocument.numPages;
      await db.putPaper(current);
      updateReaderMeta();
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    await fitPdfPage();
  } catch (err) {
    console.error(err);
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
}

async function attachPdf(file) {
  if (!current || !file) return;
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    toast('请选择 PDF 文件', true);
    return;
  }
  current.pdfBlob = file;
  current.pdfName = file.name;
  current.updatedAt = Date.now();
  await db.putPaper(current);
  updatePdfSidebar();
  await initPdfViewer();
  toast('PDF 已关联，可与精读结果对照查看');
}

function downloadCurrentPdf() {
  if (!hasPdf()) return;
  const url = URL.createObjectURL(current.pdfBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = current.pdfName || `${current.title}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------- 独立翻译 ----------------
function translationKey(sectionId = translateSection, language = $('#translate-language').value) {
  return `${sectionId}:${language}`;
}

function renderTranslate() {
  if (!current) return;
  const select = $('#translate-section');
  const defs = [...paperSectionDefs(current), { id: '__full', label: '全文' }];
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
  const saved = current.translations?.[translationKey()];
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
  if (!api.settingsReady()) {
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
  const chunks = splitTranslationText(source, api.loadSettings().maxChars);
  try {
    const translated = [];
    for (let index = 0; index < chunks.length; index++) {
      $('#translate-status').textContent = chunks.length > 1 ? `翻译中 ${index + 1}/${chunks.length}…` : '翻译中…';
      const piece = await api.chat([
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
    current.translations = current.translations || {};
    current.translations[translationKey(translateSection, language)] = {
      text, source, updatedAt: Date.now(),
    };
    current.updatedAt = Date.now();
    await db.putPaper(current);
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
function buildChatContext(p) {
  const cap = 5000;
  const parts = [`论文标题：${p.title}`];
  for (const def of paperSectionDefs(p)) {
    const t = p.sections?.[def.id]?.trim();
    if (t) parts.push(`\n===== ${def.label} =====\n${truncate(t, cap)}`);
  }
  return CHAT_SYSTEM_TEMPLATE
    .replaceAll('{title}', p.title)
    .replaceAll('{content}', parts.join('\n').slice(0, 24000));
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
  if (!q || generating) return;
  input.value = '';
  current.chat = current.chat || [];
  current.chat.push({ role: 'user', content: q });
  appendChatBubble('user', q);
  const bubble = appendChatBubble('assistant', '…');

  const history = current.chat.slice(-12).map(m => ({ role: m.role, content: m.content }));
  const messages = [
    { role: 'system', content: buildChatContext(current) },
    ...history,
  ];
  aborter = new AbortController();
  try {
    const text = await api.chat(messages, {
      stream: true,
      signal: aborter.signal,
      onDelta: full => { renderMarkdownInto(bubble, full); $('#chat-log').scrollTop = $('#chat-log').scrollHeight; },
    });
    renderMarkdownInto(bubble, text || '（无回复）');
    current.chat.push({ role: 'assistant', content: text });
    if (current.chat.length > 40) current.chat = current.chat.slice(-40);
    await db.putPaper(current);
  } catch (err) {
    bubble.classList.add('err');
    bubble.textContent = err.name === 'AbortError' ? '已停止。' : `出错了：${err.message}`;
    current.chat.push({ role: 'assistant', content: `（出错：${err.message}）` });
  } finally {
    aborter = null;
  }
}

// ---------------- 导入 ----------------
async function importPdfFile(file) {
  const btn = $('#btn-import');
  btn.disabled = true;
  btn.textContent = '解析中…';
  try {
    const parsed = await parsePdfFile(file);
    const paper = {
      id: uid(),
      title: parsed.title || file.name.replace(/\.pdf$/i, ''),
      addedAt: Date.now(),
      updatedAt: Date.now(),
      numPages: parsed.numPages,
      sections: parsed.sections,
      sectionPages: parsed.sectionPages,
      parts: parsed.parts,
      fullText: parsed.fullText,
      pdfBlob: file,
      pdfName: file.name,
      analyses: {},
      translations: {},
      chat: [],
    };
    await db.putPaper(paper);
    await refreshLibrary();
    openPaper(paper);
    const found = paperSectionDefs(paper).filter(s => paper.sections?.[s.id]?.trim()).length;
    toast(`导入成功，自动识别出 ${found} 个精读部分`);
  } catch (err) {
    console.error(err);
    toast('PDF 解析失败：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '＋ 导入论文 PDF';
  }
}

function normalizeArxivId(value) {
  const match = String(value).trim().match(/(?:arxiv\.org\/(?:abs|html|pdf)\/)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i);
  return match?.[1] || '';
}

async function importArxiv() {
  const id = normalizeArxivId($('#arxiv-input').value);
  const status = $('#arxiv-status');
  const btn = $('#btn-arxiv-import');
  if (!id) {
    status.textContent = '请输入有效的 arXiv 编号或链接';
    return;
  }
  btn.disabled = true;
  status.textContent = '正在读取结构化 HTML…';
  try {
    const response = await fetch(`/api/arxiv?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(response.status === 404 ? '这篇论文暂不提供 HTML，请改用 PDF 导入' : `arXiv 返回 ${response.status}`);
    const parsed = parseArxivHtml(await response.text());
    let pdfBlob = null;
    try {
      const pdfResponse = await fetch(`/api/arxiv-pdf?id=${encodeURIComponent(id)}`);
      if (pdfResponse.ok) pdfBlob = await pdfResponse.blob();
    } catch { /* HTML 导入仍可继续，之后可手动关联 PDF */ }
    const paper = {
      id: uid(), title: parsed.title, arxivId: id, sourceType: parsed.sourceType,
      addedAt: Date.now(), updatedAt: Date.now(), numPages: 0,
      sections: parsed.sections, parts: parsed.parts, fullText: parsed.fullText,
      pdfBlob, pdfName: pdfBlob ? `${id}.pdf` : '', analyses: {}, translations: {}, chat: [],
    };
    await db.putPaper(paper);
    $('#modal-arxiv').hidden = true;
    await refreshLibrary();
    openPaper(paper);
    const found = paperSectionDefs(paper).filter(s => paper.sections?.[s.id]?.trim()).length;
    toast(`arXiv HTML 导入成功，识别出 ${found} 个精读部分${pdfBlob ? '，PDF 已保存' : ''}`);
  } catch (err) {
    console.error(err);
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 导出笔记 ----------------
function exportNotes() {
  const lines = [`# 精读笔记：${current.title}`, '', `> 导入日期：${fmtDate(current.addedAt)} · 导出日期：${fmtDate(Date.now())}`, ''];
  for (const def of paperSectionDefs(current)) {
    lines.push(`## ${def.label}`, '');
    lines.push(current.analyses?.[def.id]?.text || '（尚未生成精读）', '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.title.slice(0, 60).replace(/[\\/:*?"<>|]/g, '_')}.精读笔记.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 设置弹窗 ----------------
function openSettingsModal() {
  const s = api.loadSettings();
  $('#set-baseurl').value = s.baseUrl;
  $('#set-apikey').value = s.apiKey;
  $('#set-model').value = s.model;
  $('#set-temp').value = s.temperature;
  $('#set-maxchars').value = s.maxChars;
  $('#api-test-result').textContent = '';
  $('#modal-settings').hidden = false;
}

async function saveSettings() {
  const s = api.loadSettings();
  s.baseUrl = $('#set-baseurl').value.trim();
  s.apiKey = $('#set-apikey').value.trim();
  s.model = $('#set-model').value.trim();
  s.temperature = parseFloat($('#set-temp').value) || 0.3;
  s.maxChars = parseInt($('#set-maxchars').value) || 16000;
  api.saveSettings(s);
  $('#modal-settings').hidden = true;
  refreshLibrary();
  toast('设置已保存');
}

// ---------------- 技能库弹窗 ----------------
function openSkillsModal() {
  renderSkillList();
  const first = effectiveSkills()[0];
  selectSkill(first.id);
  $('#modal-skills').hidden = false;
}

function renderSkillList() {
  const wrap = $('#skill-list');
  wrap.innerHTML = '';
  for (const s of effectiveSkills()) {
    const div = document.createElement('div');
    div.className = 'skill-item' + (s.customized ? ' custom' : '') + (s.id === editingSkillId ? ' active' : '');
    div.innerHTML = `<div class="si-name">${s.name}</div><div class="si-desc">${s.description}</div>`;
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

function importSkillFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const parsed = parseSkillFile(file.name, reader.result);
    // 映射到目标章节技能；无法识别时提示用户手动选择
    const target = effectiveSkills().find(s => s.section === parsed.section || s.id === parsed.section);
    if (target) {
      saveCustomSkill(target.id, parsed.prompt);
      selectSkill(target.id);
      toast(`已导入「${parsed.name}」→ ${target.name}`);
    } else {
      const list = effectiveSkills().map(s => s.id).join(' / ');
      toast(`未识别目标章节（frontmatter 的 section 应为：${list}），请在左侧选择要覆盖的技能后再导入`, true);
    }
  };
  reader.readAsText(file);
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('#brand-home').onclick = closePaper;
  $('#btn-back').onclick = closePaper;
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
  $('#btn-sample').onclick = async () => {
    try {
      const res = await fetch('samples/sample_paper.pdf');
      if (!res.ok) throw new Error('未找到示例文件');
      const blob = await res.blob();
      await importPdfFile(new File([blob], 'sample_paper.pdf', { type: 'application/pdf' }));
    } catch (err) {
      toast('示例论文不可用：' + err.message, true);
    }
  };
  $('#api-warning').onclick = openSettingsModal;
  $('#btn-settings').onclick = openSettingsModal;
  $('#btn-save-settings').onclick = saveSettings;
  $('#btn-test-api').onclick = async () => {
    const r = $('#api-test-result');
    r.textContent = '测试中…';
    // 先临时保存再测试
    const s = api.loadSettings();
    s.baseUrl = $('#set-baseurl').value.trim();
    s.apiKey = $('#set-apikey').value.trim();
    s.model = $('#set-model').value.trim();
    api.saveSettings(s);
    try { r.textContent = await api.testConnection(); }
    catch (err) { r.textContent = '❌ ' + err.message; }
  };

  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $('#btn-pdf-toggle').onclick = () => togglePdfSidebar();
  $('#btn-pdf-close').onclick = () => togglePdfSidebar(false);
  $('#btn-pdf-attach').onclick = () => $('#pdf-attach-input').click();
  $('#pdf-attach-input').onchange = e => {
    if (e.target.files[0]) attachPdf(e.target.files[0]);
    e.target.value = '';
  };
  $('#btn-pdf-prev').onclick = () => changePdfPage(-1);
  $('#btn-pdf-next').onclick = () => changePdfPage(1);
  $('#pdf-page-input').onchange = e => {
    if (!pdfDocument) return;
    pdfPage = Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), pdfDocument.numPages);
    renderPdfPage();
  };
  $('#btn-pdf-zoom-out').onclick = () => changePdfZoom(0.85);
  $('#btn-pdf-zoom-in').onclick = () => changePdfZoom(1.18);
  $('#btn-pdf-download').onclick = downloadCurrentPdf;

  $('#translate-section').onchange = e => {
    translateSection = e.target.value;
    loadTranslationSection();
  };
  $('#translate-language').onchange = loadTranslationSection;
  $('#btn-translate').onclick = translateCurrentText;
  $('#btn-translate-stop').onclick = () => translateAborter?.abort();

  $('#btn-gen-all').onclick = generateAll;
  $('#btn-stop').onclick = stopGeneration;
  $('#btn-export').onclick = exportNotes;

  $('#btn-paste-split').onclick = async () => {
    const text = $('#paste-area').value.trim();
    if (!text) return toast('请先粘贴全文', true);
    const { sections, sectionPages, parts, fullText, headingCount } = parsePlainText(text);
    current.sections = { ...current.sections, ...Object.fromEntries(Object.entries(sections).filter(([, v]) => v)) };
    current.sectionPages = { ...current.sectionPages, ...Object.fromEntries(Object.entries(sectionPages).filter(([, v]) => v)) };
    current.parts = parts;
    current.fullText = fullText;
    current.updatedAt = Date.now();
    await db.putPaper(current);
    renderSource();
    renderDigest();
    $('#source-empty').hidden = true;
    toast(`重新切分完成，识别出 ${headingCount} 个标题`);
  };

  $('#btn-chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  $('#btn-skills').onclick = openSkillsModal;
  $('#btn-skill-save').onclick = () => {
    if (!editingSkillId) return;
    saveCustomSkill(editingSkillId, $('#skill-edit-prompt').value);
    renderSkillList();
    toast('技能已保存');
  };
  $('#btn-skill-reset').onclick = () => {
    if (!editingSkillId) return;
    resetSkill(editingSkillId);
    selectSkill(editingSkillId);
    toast('已恢复默认提示词');
  };
  $('#btn-skill-import').onclick = () => $('#skill-file').click();
  $('#skill-file').onchange = e => { if (e.target.files[0]) importSkillFile(e.target.files[0]); e.target.value = ''; };

  // 点击遮罩关闭弹窗
  for (const id of ['modal-arxiv', 'modal-settings', 'modal-skills']) {
    const mask = $(`#${id}`);
    mask.addEventListener('click', e => { if (e.target === mask) mask.hidden = true; });
    mask.querySelectorAll('[data-close]').forEach(b => b.onclick = () => mask.hidden = true);
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('#modal-arxiv').hidden = true;
      $('#modal-settings').hidden = true;
      $('#modal-skills').hidden = true;
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfSidebarOpen && pdfDocument) fitPdfPage();
    }, 180);
  });
}

// ---------------- 启动 ----------------
bindEvents();
refreshLibrary();
