// 论文生命周期 module：统一拥有记录创建、精读部分投影、进度派生与全部写入。
// 设计决定见 docs/adr/0004-paper-lifecycle-module.md。

// ---------------- 存储缝 ----------------

let store = null;

/** 注入存储适配器：{ getAll(), get(id), put(paper), delete(id) }。 */
export function init(adapter) {
  store = adapter;
}

/** IndexedDB 存储适配器（浏览器运行时使用）。 */
export function createIndexedDBStore() {
  const DB_NAME = 'paper-reader';
  const STORE_NAME = 'papers';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async getAll() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    },
    async get(id) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    },
    async put(paper) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(paper);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    },
    async delete(id) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    },
  };
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
  };
}

/** 本地 PDF 解析结果 → 论文记录，并落库。 */
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
  await store.put(paper);
  return paper;
}

// ---------------- 书库与投影 ----------------

/**
 * 通用持久化入口（过渡）：原样落库，不施加写入规则。
 * Issue #9 第 2 步会把各调用点逐一替换为带规则的写入函数，届时移除。
 */
export async function saveRecord(paper) {
  await store.put(paper);
}

/** 删除一条论文记录。 */
export async function removeRecord(id) {
  await store.delete(id);
}

/** 书库列表：按导入时间倒序。筛选与搜索属于视图层。 */
export async function listPapers() {
  const all = await store.getAll();
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

// 论文没有识别出实际章节时的四个固定精读部分。
const FALLBACK_PARTS = [
  { id: 'abstract',     skillId: 'abstract',     label: 'Abstract · 摘要',      hint: '英文原文 + 规范中文翻译' },
  { id: 'introduction', skillId: 'introduction', label: 'Introduction · 引言',  hint: '领域背景 / 相关工作 / 要解决的问题 / 贡献' },
  { id: 'method',       skillId: 'method',       label: 'Method · 方法',        hint: '核心创新点 / 方法详解 / 为什么有效' },
  { id: 'experiments',  skillId: 'experiments',  label: 'Experiment · 实验',    hint: '基准与结果 / 训练推理细节 / 消融实验 / 洞察' },
];

/** 精读部分投影：摘要 + 实际一级章节，按原文顺序。 */
export function readingParts(paper) {
  if (!paper?.parts?.length) return FALLBACK_PARTS;
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
  return [FALLBACK_PARTS[0], ...parts];
}

/** 阅读进度：永远从精读结果派生、不落库；生成中断保留的部分结果计入。 */
export function readingProgress(paper) {
  const parts = readingParts(paper);
  const done = parts.filter(part => paper?.analyses?.[part.id]?.text).length;
  return { done, total: parts.length };
}
