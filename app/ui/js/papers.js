// 论文生命周期 module：统一拥有记录创建、精读部分投影、进度派生与全部写入。
// 设计决定见 Git 历史 35324e7 的 docs/adr/0004-paper-lifecycle-module.md；现行语义见根 CONCEPTS.md。
// - 存储适配器由 ./store.js 注入，不在领域模块内持久化；
// - PDF 字节不随记录持久化，导出信封需要的 base64 经 init 注入的 pdfHelpers.pdfBase64 获取。
// - 进度域（progressParts，#90/#92）：已建图时以 L2 产物集合为域
//   （节树同域，覆盖存量 parts 未对齐的记录）；块模型无 abstract 节时摘要占位不计入
//   进度。

// ---------------- 存储缝 ----------------

let store = null;

// PDF 导出助手：pdfBase64(paper) -> string|null。导入流程的瞬时 Blob/File
// 仍在记录上时，缺省实现直接从 Blob 读字节转 base64。
const defaultPdfHelpers = {
  async pdfBase64(paper) {
    if (!(paper?.pdfBlob instanceof Blob) || !paper.pdfBlob.size) return null;
    const bytes = new Uint8Array(await paper.pdfBlob.arrayBuffer());
    return bytesToBase64(bytes);
  },
};

let pdfHelpers = defaultPdfHelpers;

/** 注入存储适配器 { getAll(), get(id), put(paper), delete(id) } 与 PDF 导出助手（可缺省）。 */
export function init(adapter, helpers) {
  store = adapter;
  pdfHelpers = { ...defaultPdfHelpers, ...(helpers || {}) };
}

// ---------------- 记录创建 ----------------

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function basePaper(title) {
  const now = Date.now();
  return {
    id: uid(),
    title,
    addedAt: now,
    updatedAt: now,
    analyses: {},
    translations: {},
    recallCard: { markdown: '', images: [], updatedAt: 0 },
    rating: 0,
    categories: [],
    tags: [],
    chat: [],
    readMarks: {},
    activityDays: [],
    products: [],
  };
}

/** 本地 PDF 解析结果 → 论文记录，并落库。pdfBlob 是瞬时 Blob/File，由存储适配器落附件。 */
export async function createPdfPaper(parsed, pdfFile) {
  const paper = {
    ...basePaper(parsed.title || pdfFile.name.replace(/\.pdf$/i, '')),
    numPages: parsed.numPages,
    sections: parsed.sections,
    sectionPages: parsed.sectionPages,
    parts: parsed.parts,
    fullText: parsed.fullText,
    pdfBlob: pdfFile,
    pdfName: pdfFile.name,
  };
  recordActivityDay(paper, 'import'); // 写入缝一：导入论文计入当日打卡
  await store.put(paper);
  return paper;
}

/** arXiv HTML 解析结果 → 论文记录，并落库。pdfBlob 可为 null（之后可手动关联）。 */
export async function createArxivPaper(parsed, arxivId, pdfBlob) {
  const paper = {
    ...basePaper(parsed.title),
    arxivId,
    sourceType: parsed.sourceType,
    numPages: 0,
    sections: parsed.sections,
    parts: parsed.parts,
    fullText: parsed.fullText,
    pdfBlob,
    pdfName: pdfBlob ? `${arxivId}.pdf` : '',
  };
  recordActivityDay(paper, 'import'); // 写入缝一：导入论文计入当日打卡
  await store.put(paper);
  return paper;
}

/** 内置「使用说明」论文（发布版首启播种）：纯文本记录，无 PDF、不参与建图。
 *  blocks: [{ heading, text }]，首个块落摘要位，其余依次落 part-N。 */
export async function createGuidePaper(title, blocks) {
  const sections = {};
  const sectionPages = {};
  const parts = [];
  blocks.forEach((block, index) => {
    const id = index === 0 ? 'abstract' : `part-${index}`;
    sections[id] = block.text;
    sectionPages[id] = { start: 1, end: 1 };
    if (index > 0) parts.push({ id, title: block.heading, heading: block.heading, semanticType: 'part' });
  });
  const paper = {
    ...basePaper(title),
    numPages: 0,
    sections,
    sectionPages,
    parts,
    fullText: blocks.map(block => `${block.heading}\n\n${block.text}`).join('\n\n'),
  };
  // 不计入打卡：播种是应用行为，不是用户的阅读活动（规格 #51 打卡口径）。
  await store.put(paper);
  return paper;
}

// ---------------- 分类与标签 ----------------

/** 分类/标签清洗：去首尾空白、压缩内部空白、按大小写不敏感去重。 */
export function cleanTokens(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map(value => String(value).trim().replace(/\s+/g, ' '))
    .filter(value => value && !seen.has(value.toLocaleLowerCase()) && seen.add(value.toLocaleLowerCase()));
}

export function paperCategories(paper) {
  return cleanTokens(paper?.categories);
}

export function paperTags(paper) {
  return cleanTokens(paper?.tags);
}

// ---------------- 写入规则 ----------------
// 每个写入函数统一执行：变更 + 推进 updatedAt + 持久化（ADR-0004）。

/** 精读结果写入。生成任务模块经此缝提交；中断保留的部分结果由调用方在 text 中携带警示标记并传 { partial: true }。 */
export async function saveAnalysis(paper, sectionId, text, { partial = false } = {}) {
  paper.analyses = paper.analyses || {};
  paper.analyses[sectionId] = { text, updatedAt: Date.now() };
  // 写入缝二/三：产生精读结果（analysis）与中断保留部分结果（partial）各计入当日打卡。
  recordActivityDay(paper, partial ? 'partial' : 'analysis');
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/**
 * 已读完标记写入缝（规格 #51）：设置标记即生成当日 mark 活动日；
 * 撤销只移除标记，不写也不回收任何活动日（打卡是发生过的历史事实）。
 * 重复设置幂等：保留首次 marked_at。
 * 与其他写入缝不同，这里落库失败时回滚内存变更——标记是用户可见的开关，
 * 失败已 toast 告知，不能让脏快照被后续无关 put 静默冲刷进库。
 */
export async function setReadMark(paper, partId, marked) {
  paper.readMarks = paper.readMarks || {};
  paper.activityDays = Array.isArray(paper.activityDays) ? paper.activityDays : [];
  const prevMark = paper.readMarks[partId];
  const prevDaysLength = paper.activityDays.length;
  const prevUpdatedAt = paper.updatedAt;
  if (marked) {
    if (prevMark == null) {
      paper.readMarks[partId] = Date.now();
      recordActivityDay(paper, 'mark'); // 写入缝四
    }
  } else {
    delete paper.readMarks[partId];
  }
  paper.updatedAt = Date.now();
  try {
    await store.put(paper);
  } catch (err) {
    if (prevMark == null) delete paper.readMarks[partId];
    else paper.readMarks[partId] = prevMark;
    paper.activityDays.length = prevDaysLength;
    paper.updatedAt = prevUpdatedAt;
    throw err;
  }
}

/** 章节原文保存（手动粘贴）。 */
export async function saveSectionSource(paper, sectionId, text) {
  paper.sections = paper.sections || {};
  paper.sections[sectionId] = text;
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 译文存储键。 */
export function translationKey(sectionId, language) {
  return `${sectionId}:${language}`;
}

/** 翻译结果写入。 */
export async function saveTranslation(paper, sectionId, language, text, source) {
  paper.translations = paper.translations || {};
  paper.translations[translationKey(sectionId, language)] = { text, source, updatedAt: Date.now() };
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 回忆卡整体替换（正文 + 图片）。 */
export async function saveRecallCard(paper, markdown, images) {
  paper.recallCard = { markdown, images, updatedAt: Date.now() };
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 移除回忆卡中的一张图片，不改动正文。 */
export async function removeRecallImage(paper, imageId) {
  const card = paper.recallCard || { markdown: '', images: [] };
  paper.recallCard = {
    ...card,
    images: (card.images || []).filter(image => image.id !== imageId),
    updatedAt: Date.now(),
  };
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 追加一条问答消息，只保留最近 40 条；绑定字段随被淘汰的消息一并删除。 */
export async function appendChatMessage(paper, message) {
  paper.chat = paper.chat || [];
  paper.chat.push(message);
  if (paper.chat.length > 40) paper.chat = paper.chat.slice(-40);
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 评分、分类与标签写入。 */
export async function saveOrganize(paper, { rating, categories, tags }) {
  paper.rating = rating;
  paper.categories = cleanTokens(categories);
  paper.tags = cleanTokens(tags);
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 关联 PDF 文件。 */
export async function attachPdf(paper, file) {
  paper.pdfBlob = file;
  paper.pdfName = file.name;
  paper.updatedAt = Date.now();
  await store.put(paper);
}

/** 纠正页数；无变化时不写入，返回是否发生了变化。 */
export async function setNumPages(paper, numPages) {
  if (paper.numPages === numPages) return false;
  paper.numPages = numPages;
  paper.updatedAt = Date.now();
  await store.put(paper);
  return true;
}

// ---------------- 重新切分 ----------------

function nonEmptyEntries(source) {
  return Object.fromEntries(Object.entries(source || {}).filter(([, value]) => value));
}

/**
 * 重新切分：把新的切分结果合并进记录，并作废失去指涉的成果（ADR-0004）。
 * 规则：除摘要外的精读结果与翻译一律作废；摘要原文未变时保留摘要的结果与翻译；
 * 全文被整体替换，__full 翻译总是作废。返回 { discarded } 供界面提示。
 */
export async function applyResplit(paper, parseResult) {
  const abstractBefore = paper.sections?.abstract || '';
  paper.sections = { ...paper.sections, ...nonEmptyEntries(parseResult.sections) };
  paper.sectionPages = { ...paper.sectionPages, ...nonEmptyEntries(parseResult.sectionPages) };
  paper.parts = parseResult.parts;
  paper.fullText = parseResult.fullText;
  const abstractUnchanged = (paper.sections.abstract || '') === abstractBefore;

  let discarded = 0;
  const keptAnalyses = {};
  for (const [sectionId, analysis] of Object.entries(paper.analyses || {})) {
    if (sectionId === 'abstract' && abstractUnchanged) keptAnalyses[sectionId] = analysis;
    else discarded++;
  }
  paper.analyses = keptAnalyses;

  const keptTranslations = {};
  for (const [key, translation] of Object.entries(paper.translations || {})) {
    if (key.split(':')[0] === 'abstract' && abstractUnchanged) keptTranslations[key] = translation;
    else discarded++;
  }
  paper.translations = keptTranslations;

  // 已读完标记随其结果一并作废、不留孤儿（规格 #51 决策 9，与分析同一保留规则）。
  const keptMarks = {};
  for (const [partId, markedAt] of Object.entries(paper.readMarks || {})) {
    if (partId === 'abstract' && abstractUnchanged) keptMarks[partId] = markedAt;
  }
  paper.readMarks = keptMarks;

  // 消失部分的 l2/dig 产物随结果一并作废（规格 #55 决策 22，与分析同一保留规则）；
  // map/retell 是论文级产物，不随重新切分作废——重建图/重新综合是显式覆盖动作。
  paper.products = (Array.isArray(paper.products) ? paper.products : [])
    .filter(product => {
      if (product?.kind !== 'l2' && product?.kind !== 'dig') return true;
      return product.partId === 'abstract' && abstractUnchanged;
    });

  paper.updatedAt = Date.now();
  await store.put(paper);
  return { discarded };
}

// ---------------- 书库与投影 ----------------

// ---------------- 打卡 ----------------
// 打卡数据源是落库的 append-only 活动日表（记录侧 activityDays 数组）：
// 导入/结果写入/中断保留/设置标记四个写入缝各自在发生时写入当日行，撤销不回收、
// 重读不改写历史。kind 取值与 Rust 端 ACTIVITY_DAY_KINDS 对齐：import/analysis/partial/mark。

// 时间戳 → UTC 日历日（YYYY-MM-DD）。日界与 schema v4 迁移回填同一口径（#61 定：
// 库内时间戳一律 RFC3339 UTC，活动日 = 事件时间戳的 UTC 日，全库一条规则）。
export function activityDayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// 写入缝共用：把当日活动日行并入记录，同日同 kind 幂等（库层另有主键去重兜底）。
function recordActivityDay(paper, kind) {
  const day = activityDayOf(Date.now());
  paper.activityDays = Array.isArray(paper.activityDays) ? paper.activityDays : [];
  if (!paper.activityDays.some(entry => entry?.day === day && entry?.kind === kind)) {
    paper.activityDays.push({ day, kind });
  }
}

/** 阅读活动日列表：落库活动日的日期部分（语义见 CONCEPTS.md「打卡」）。 */
export function activityDays(paper) {
  return (Array.isArray(paper?.activityDays) ? paper.activityDays : [])
    .filter(entry => typeof entry?.day === 'string' && entry.day)
    .map(entry => entry.day);
}

/** 连续阅读天数：从今天向前数连续天数；今天尚无活动时从昨天起算。 */
export function streakDays(allPapers) {
  const days = new Set();
  for (const paper of allPapers) {
    for (const day of activityDays(paper)) days.add(day);
  }
  let streak = 0;
  // 按 UTC 日界回退：24h 步进恰好跨过一个 UTC 日，不涉本地夏令时。
  let cursor = Date.now();
  if (!days.has(activityDayOf(cursor))) cursor -= 86400000;
  while (days.has(activityDayOf(cursor))) { streak++; cursor -= 86400000; }
  return streak;
}

/** 删除一条论文记录。 */
export async function removeRecord(id) {
  return store.delete(id);
}

/** 书库列表：按导入时间倒序。筛选与搜索属于视图层。 */
export async function listPapers() {
  const all = await store.getAll();
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

// ---------------- 整库导出 / 导入 ----------------

const LIBRARY_FORMAT = 'paper-30min-library';
const LIBRARY_VERSION = 1;

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function serializePaper(paper) {
  const copy = { ...paper };
  // pdfAttachment 是运行时的附件句柄，不进导出信封；
  // PDF base64 经注入缝获取（Tauri 端从附件存储读，缺省从瞬时 pdfBlob 读）。
  delete copy.pdfAttachment;
  const base64 = await pdfHelpers.pdfBase64(paper);
  copy.pdfBlob = base64
    ? { base64, type: paper.pdfBlob?.type || paper.pdfAttachment?.contentType || 'application/pdf' }
    : null;
  return copy;
}

function deserializePaper(raw) {
  const paper = { ...raw };
  const marker = paper.pdfBlob;
  if (marker && typeof marker === 'object' && typeof marker.base64 === 'string') {
    paper.pdfBlob = new Blob([base64ToBytes(marker.base64)], { type: marker.type || 'application/pdf' });
  } else if (!(paper.pdfBlob instanceof Blob)) {
    paper.pdfBlob = null;
  }
  return paper;
}

/**
 * 导出整个书库为 JSON 字符串。信封格式由本模块拥有；
 * skills 与 settings 是调用方传入的不透明载荷（settings 不应携带 apiKey）。
 */
export async function exportLibrary({ skills = null, settings = null } = {}) {
  const all = await listPapers();
  const papers = [];
  for (const paper of all) papers.push(await serializePaper(paper));
  return JSON.stringify({
    format: LIBRARY_FORMAT,
    version: LIBRARY_VERSION,
    exportedAt: new Date().toISOString(),
    papers,
    skills,
    settings,
  });
}

/** 解析并校验导出文件；格式错误时抛出可读错误。 */
export function parseLibraryFile(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (!payload || payload.format !== LIBRARY_FORMAT) {
    throw new Error('这不是 Paper30Min 书库导出文件');
  }
  if (payload.version !== LIBRARY_VERSION) {
    throw new Error(`不支持的导出版本 ${payload.version}（当前支持 ${LIBRARY_VERSION}）`);
  }
  if (!Array.isArray(payload.papers)) {
    throw new Error('导出文件缺少论文列表');
  }
  return payload;
}

/** 导入导出载荷：按 id 合并——同 id 记录跳过，新 id 加入书库。返回 { added, skipped }。 */
export async function importLibrary(payload) {
  let added = 0;
  let skipped = 0;
  for (const raw of payload.papers) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) { skipped++; continue; }
    const existing = await store.get(raw.id);
    if (existing) { skipped++; continue; }
    await store.put(deserializePaper(raw));
    added++;
  }
  return { added, skipped };
}

// 论文没有识别出实际章节时的四个固定精读部分。
const FALLBACK_PARTS = [
  { id: 'abstract',     skillId: 'abstract',     label: 'Abstract · 摘要',      hint: '英文原文 + 规范中文翻译' },
  { id: 'introduction', skillId: 'introduction', label: 'Introduction · 引言',  hint: '领域背景 / 相关工作 / 要解决的问题 / 贡献' },
  { id: 'method',       skillId: 'method',       label: 'Method · 方法',        hint: '核心创新点 / 方法详解 / 为什么有效' },
  { id: 'experiments',  skillId: 'experiments',  label: 'Experiment · 实验',    hint: '基准与结果 / 训练推理细节 / 消融实验 / 洞察' },
];

/**
 * 「已建图」判据：map 产物且 body 为对象——与 qa.js 的 hasMapProduct 同形，
 * 本模块零依赖故内联。partial 建图不写 map 产物，不会误判。
 */
function hasBuiltMap(paper) {
  const mapRow = (paper?.products ?? []).find(item => item?.kind === 'map');
  return !!mapRow?.body && typeof mapRow.body === 'object' && !Array.isArray(mapRow.body);
}

/**
 * 摘要占位是否留在进度域（#90）。块模型没有 abstract 节时留在域里会让论文永远到不了
 * 「已读完」——占位在节树中没有对应节点、也标不上标记。判不了时一律保留：
 * - 记录没有 parts（固定四部分兜底）；
 * - 尚未建图：pdf.js 预切分的 parts 只收正文节，摘要单列在 `sections.abstract`；
 * - 已建图且对齐后的 parts 含 abstract：建图把 parts 回写为块模型同构形状（#87）；
 * - 存量论文（建图早于对齐缝落地，parts 仍是 pdf.js 形状）：由 L2 产物兜底判断。
 * 注：已建图且 l2 行在场的论文走 l2ProgressParts（#92），本函数只兜剩余形态。
 */
function keepsAbstractPlaceholder(paper) {
  const recordParts = paper?.parts ?? [];
  if (!recordParts.length) return true;
  if (!hasBuiltMap(paper)) return true;
  if (recordParts.some(part => part?.id === 'abstract')) return true;
  return (paper?.products ?? []).some(item => item?.kind === 'l2' && item?.partId === 'abstract');
}

/** 进度域排序：abstract 在前，part-N 按数字序，其余 id 按字典序殿后。 */
function compareProgressIds(a, b) {
  const rank = id => (id === 'abstract' ? [0, 0, id] : /^part-(\d+)$/.test(id) ? [1, Number(id.slice(5)), id] : [2, 0, id]);
  const [ra, na, ia] = rank(a);
  const [rb, nb, ib] = rank(b);
  return ra - rb || na - nb || (ia < ib ? -1 : ia > ib ? 1 : 0);
}

/**
 * 已建图论文的进度域 = L2 产物 partId 集合（#92 方向 1）。L2 行与节树同属块模型域
 * （建图按 l2Sections 逐节产出，树项即 partIdForSection），而存量论文（#87 前建图）
 * 的记录 parts 从未对齐、节数可多可少——分母错且域大部分标不上，永远到不了「已读完」。
 * 安全性：map 产物只在建图成功时写入，建图成功蕴含 L2 完整（partial 无 map 产物），
 * 不会误用偏小的集合；l2 行缺失（数据异常）时返回 null 回退 parts 域，不劣化现状。
 * 条目只带 id（消费方=书库进度点与 readingProgress，均只用 id）：不借记录 parts 的
 * 标题——存量论文的 part-N 与块模型 part-N 可能指向不同章节，借标题反而误导。
 */
function l2ProgressParts(paper) {
  if (!hasBuiltMap(paper)) return null;
  const ids = [...new Set(
    (paper?.products ?? [])
      .filter(item => item?.kind === 'l2' && typeof item?.partId === 'string' && item.partId)
      .map(item => item.partId),
  )].sort(compareProgressIds);
  if (!ids.length) return null;
  return ids.map(id => ({ id }));
}

/**
 * 阅读进度域：与节树里可标记的节点同域（References / Acknowledgments 灰项本就不参与 L2、
 * 也标不上，故不在进度域）。已建图时由 L2 产物集合决定（#92，覆盖存量 parts 未对齐
 * 的记录）；其余形态下块模型没有 abstract 节的论文不把摘要占位计入（#90）。
 * 内容投影仍走 readingParts——原文 tab 的摘要文本照旧可读，只是不再算作进度单元。
 */
export function progressParts(paper) {
  const l2Domain = l2ProgressParts(paper);
  if (l2Domain) return l2Domain;
  const parts = readingParts(paper);
  if (keepsAbstractPlaceholder(paper)) return parts;
  return parts.filter(part => part.id !== 'abstract');
}

/** 精读部分投影：摘要 + 实际一级章节，按原文顺序。内容域（原文 tab / 旧结果留存）用它。 */
export function readingParts(paper) {
  if (!paper?.parts?.length) return FALLBACK_PARTS;
  // 精读部分身份唯一（abstract + part-N）：parts 里与摘要同 id 或彼此重复的条目只取首次出现，
  // 防止投影重复计数（如手工构造的浏览器导出把 abstract 写进 parts）。
  const seen = new Set(['abstract']);
  const parts = [];
  for (const part of paper.parts) {
    if (!part?.id || seen.has(part.id)) continue;
    seen.add(part.id);
    parts.push({
      id: part.id,
      skillId: part.semanticType === 'experiments'
        ? 'experiments'
        : part.semanticType === 'introduction'
          ? 'introduction'
          : part.semanticType === 'method'
            ? 'method'
            : 'part',
      label: `第 ${parts.length + 1} 部分 · ${part.title || part.heading || '未命名章节'}`,
      pickerLabel: part.title || `第 ${parts.length + 1} 部分`,
      hint: part.semanticType === 'experiments'
        ? '实验设置 / 主要结果 / 消融与洞察'
        : `论文正文第 ${parts.length + 1} 部分 · ${part.semanticType === 'method' ? '方法深度精读' : '通用章节精读'}`,
    });
  }
  return [FALLBACK_PARTS[0], ...parts];
}

/** 阅读进度：已读完标记数 / 当前精读部分总数，前端派生不落库（规格 #51 决策 6）。 */
export function readingProgress(paper) {
  const parts = progressParts(paper);
  const marks = paper?.readMarks || {};
  const done = parts.filter(part => marks[part.id] != null).length;
  return { done, total: parts.length };
}

/** 论文级已读完：全部精读部分均有标记的派生态（规格 #51 决策 7），不设论文级字段。 */
export function isPaperRead(paper) {
  const { done, total } = readingProgress(paper);
  return total > 0 && done === total;
}
