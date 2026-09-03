// 主逻辑：书库 / 精读 / 原文 / 问答 / 设置 / 技能库
import * as papers from './papers.js';
import * as api from './api.js';
import { renderMarkdown, typesetMath } from './markdown.js';
import {
  effectiveSkills, getSkill, buildPrompt, saveCustomSkill, resetSkill,
  parseSkillFile, loadCustomSkills, CHAT_SYSTEM_TEMPLATE,
} from './skills.js';
import { parseArxivHtml, parsePdfFile, parsePlainText } from './parser.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function escapeTemplate(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------- 全局状态 ----------------
let library = [];
let current = null;          // 当前打开的论文
let aborter = null;          // 生成中断控制器
let generating = false;
let editingSkillId = null;
let digestSection = 'abstract';
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

function renderMarkdownInto(element, text) {
  element.innerHTML = renderMarkdown(text);
  typesetMath(element);
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

function ratingText(value) {
  const rating = Math.min(Math.max(Number(value) || 0, 0), 5);
  return rating ? `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}` : '未评分';
}

function metadataTokens(paper) {
  return [...papers.paperCategories(paper), ...papers.paperTags(paper)];
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
  $('#streak-badge').textContent = total ? `🔥 连续 ${papers.streakDays(library)} 天 · 已读 ${total} 篇 · 精读 ${doneCount}/${sectionCount} 节` : '';
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
  empty.innerHTML = library.length
    ? '<p>没有符合当前筛选条件的论文。</p>'
    : '<p>书库还是空的。</p><p>点击右上角「导入论文 PDF」，或先「打开示例论文」体验一遍精读流程。</p>';

  const ready = api.settingsReady();
  const warn = $('#api-warning');
  warn.hidden = ready;
  if (!ready) warn.textContent = '⚠️ 尚未配置大模型 API，AI 精读功能暂不可用。点击这里前往设置（支持 OpenAI / DeepSeek / Moonshot / 阿里云百炼 / Ollama 等兼容接口）。';

  for (const p of visiblePapers) {
    const card = document.createElement('div');
    card.className = 'paper-card';
    const defs = papers.readingParts(p);
    const { done } = papers.readingProgress(p);
    card.innerHTML = `
      <div style="min-width:0;flex:1">
        <p class="pc-title"></p>
        <div class="pc-sub">
          <span class="progress-dots" title="精读进度 ${done}/${defs.length}">${defs.map(s =>
            `<span class="pdot ${p.analyses?.[s.id]?.text ? 'done' : ''}"></span>`).join('')}</span>
          <span>${p.numPages ? p.numPages + ' 页 · ' : ''}导入于 ${fmtDate(p.addedAt)}</span>
          ${done ? `<span>最近精读 ${fmtDate(Math.max(...Object.values(p.analyses).map(a => a.updatedAt || 0)))}</span>` : ''}
        </div>
        <div class="pc-metadata" data-role="metadata"></div>
      </div>
      <div class="pc-actions">
        <button class="btn small primary" data-act="open">继续阅读</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div>`;
    card.querySelector('.pc-title').textContent = p.title;
    const metadata = card.querySelector('[data-role="metadata"]');
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
    card.querySelector('.pc-title').onclick = () => openPaper(p);
    card.querySelector('[data-act="open"]').onclick = () => openPaper(p);
    card.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`确定删除「${p.title.slice(0, 40)}…」及其精读记录？`)) return;
      await papers.removeRecord(p.id);
      refreshLibrary();
    };
    list.appendChild(card);
  }
}

// ---------------- 精读视图 ----------------
function openPaper(p) {
  current = p;
  digestSection = papers.readingParts(p)[0]?.id || 'abstract';
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
  renderRecall();
  renderSource();
  renderTranslate();
  renderChat();
  updatePdfSidebar();
  initPdfViewer();
}

function closePaper() {
  destroyPdfViewer();
  translateAborter?.abort();
  recallAborter?.abort();
  current = null;
  $('#view-reader').hidden = true;
  $('#view-library').hidden = false;
  refreshLibrary();
}

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  for (const id of ['digest', 'recall', 'source', 'translate', 'chat']) {
    $(`#tab-${id}`).hidden = id !== name;
  }
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

function renderDigest() {
  const defs = papers.readingParts(current);
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
      await papers.saveSectionSource(current, def.id, txt);
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
  const def = papers.readingParts(current).find(section => section.id === sectionId);
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
  // 中断保存必须用原始 Markdown；body.textContent 是渲染后的纯文本，会丢失格式。
  let streamed = '';
  try {
    const text = await api.chat([{ role: 'user', content: prompt }], {
      stream: true,
      signal: aborter.signal,
      onDelta: full => { streamed = full; renderMarkdownInto(body, full); },
    });
    body.classList.remove('cursor');
    if (!text.trim()) throw new Error('模型未返回内容');
    renderMarkdownInto(body, text);
    await papers.saveAnalysis(current, sectionId, text);
    setCardStatus(sectionId, `✓ ${fmtDate(Date.now())}`, 'ok');
    btn.textContent = '重新生成';
    updateReaderMeta();
    return true;
  } catch (err) {
    body.classList.remove('cursor');
    const aborted = err.name === 'AbortError';
    const partial = streamed.trim();
    if (aborted && partial.length > 60) {
      await papers.saveAnalysis(current, sectionId, partial + '\n\n> ⚠️ 生成被中断，内容为部分结果。');
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
  for (const def of papers.readingParts(current)) {
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

// ---------------- 回忆卡 ----------------
function recallCard() {
  return current?.recallCard || { markdown: '', images: [], updatedAt: 0 };
}

function updateRecallPreview() {
  const preview = $('#recall-preview');
  const markdown = $('#recall-editor').value.trim();
  preview.classList.toggle('empty-hint', !markdown);
  if (markdown) renderMarkdownInto(preview, markdown);
  else preview.textContent = '尚未生成或填写回忆卡。';
}

function renderRecallImages() {
  const gallery = $('#recall-image-gallery');
  gallery.innerHTML = '';
  const images = recallCard().images || [];
  gallery.hidden = images.length === 0;
  for (const image of images) {
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name || '回忆卡图片';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recall-image-remove';
    remove.title = '移除图片';
    remove.setAttribute('aria-label', `移除图片 ${img.alt}`);
    remove.textContent = '×';
    remove.onclick = async () => {
      if (!confirm('从回忆卡中移除这张图片？')) return;
      await papers.removeRecallImage(current, image.id);
      renderRecallImages();
    };
    figure.append(img, remove);
    gallery.appendChild(figure);
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
  if (!silent) toast('回忆卡已保存');
}

async function generateRecallDraft() {
  if (!api.settingsReady()) {
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
    const text = await api.chat(messages, {
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

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

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
    if (blob) return await readAsDataUrl(blob);
  } catch { /* 不支持解码时保留原图 */ }
  return readAsDataUrl(file);
}

async function addRecallImages(files) {
  const imageFiles = [...files].filter(file => file.type?.startsWith('image/'));
  if (!imageFiles.length) return;
  const existing = recallCard().images || [];
  if (existing.length + imageFiles.length > 8) return toast('每张回忆卡最多保存 8 张图片', true);
  try {
    const additions = [];
    for (const file of imageFiles) {
      additions.push({ id: papers.uid(), name: file.name || '粘贴的图片', dataUrl: await prepareRecallImage(file) });
    }
    await papers.saveRecallCard(current, $('#recall-editor').value.trim(), [...existing, ...additions]);
    renderRecallImages();
    $('#recall-status').textContent = `已保存 · ${fmtDate(Date.now())}`;
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- 原文视图 ----------------
let sourceTab = 'abstract';

function renderSource() {
  const chips = $('#source-chips');
  chips.innerHTML = '';
  const paperDefs = papers.readingParts(current);
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
    if (await papers.setNumPages(current, pdfDocument.numPages)) updateReaderMeta();
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
  await papers.attachPdf(current, file);
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
  if (!q || generating) return;
  input.value = '';
  await papers.appendChatMessage(current, { role: 'user', content: q });
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
    await papers.appendChatMessage(current, { role: 'assistant', content: text });
  } catch (err) {
    bubble.classList.add('err');
    bubble.textContent = err.name === 'AbortError' ? '已停止。' : `出错了：${err.message}`;
    await papers.appendChatMessage(current, { role: 'assistant', content: `（出错：${err.message}）` });
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
    const paper = await papers.createPdfPaper(parsed, file);
    await refreshLibrary();
    openPaper(paper);
    const found = papers.readingParts(paper).filter(s => paper.sections?.[s.id]?.trim()).length;
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
    const paper = await papers.createArxivPaper(parsed, id, pdfBlob);
    $('#modal-arxiv').hidden = true;
    await refreshLibrary();
    openPaper(paper);
    const found = papers.readingParts(paper).filter(s => paper.sections?.[s.id]?.trim()).length;
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
  const meta = [
    `导入日期：${fmtDate(current.addedAt)}`,
    `导出日期：${fmtDate(Date.now())}`,
    `评分：${ratingText(current.rating)}`,
    papers.paperCategories(current).length ? `分类：${papers.paperCategories(current).join('、')}` : '',
    papers.paperTags(current).length ? `标签：${papers.paperTags(current).join('、')}` : '',
  ].filter(Boolean).join(' · ');
  const lines = [`# 精读笔记：${current.title}`, '', `> ${meta}`, ''];
  if (current.recallCard?.markdown) {
    lines.push('## 回忆卡', '', current.recallCard.markdown, '');
  }
  for (const def of papers.readingParts(current)) {
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
  $('#btn-recall-save').onclick = () => saveRecallCard();
  $('#btn-recall-image').onclick = () => $('#recall-image-input').click();
  $('#recall-image-input').onchange = e => {
    if (e.target.files?.length) addRecallImages(e.target.files);
    e.target.value = '';
  };
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
  $('#btn-organize-save').onclick = saveOrganizeMetadata;

  $('#btn-gen-all').onclick = generateAll;
  $('#btn-stop').onclick = stopGeneration;
  $('#btn-export').onclick = exportNotes;

  $('#btn-paste-split').onclick = async () => {
    const text = $('#paste-area').value.trim();
    if (!text) return toast('请先粘贴全文', true);
    const parsed = parsePlainText(text);
    const { discarded } = await papers.applyResplit(current, parsed);
    renderSource();
    renderDigest();
    $('#source-empty').hidden = true;
    toast(discarded
      ? `重新切分完成，识别出 ${parsed.headingCount} 个标题；${discarded} 条已失效的精读/翻译结果被作废`
      : `重新切分完成，识别出 ${parsed.headingCount} 个标题`);
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
  for (const id of ['modal-arxiv', 'modal-settings', 'modal-skills', 'modal-organize']) {
    const mask = $(`#${id}`);
    mask.addEventListener('click', e => { if (e.target === mask) mask.hidden = true; });
    mask.querySelectorAll('[data-close]').forEach(b => b.onclick = () => mask.hidden = true);
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('#modal-arxiv').hidden = true;
      $('#modal-settings').hidden = true;
      $('#modal-skills').hidden = true;
      $('#modal-organize').hidden = true;
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
papers.init(papers.createIndexedDBStore());
bindEvents();
refreshLibrary();
