// Tauri 存储适配器：papers.js 存储缝在正式客户端的实现。
// 记录 ↔ DTO 双向映射必须与 app/src-tauri/src/migration.rs 的转换函数写入的形状完全一致：
// - DTO 日期是 ISO 8601 UTC 字符串，领域层是毫秒数字，双向转换只发生在本模块边界；
// - sections 在 DTO 是数组 [{id, sourceText, pageStart, pageEnd}]，在记录是
//   {sections: id→text 映射, sectionPages: id→{start,end} 映射} 两个冗余字段；
// - parts 在 DTO 只存元数据（id/title/heading/semanticType/sortOrder），记录侧的
//   text/pageRange 冗余字段在载入时从 sections/sectionPages 重建，sourceRange 丢弃；
// - translations 记录侧键为 `sectionId:language`，DTO 拆成独立字段；
// - PDF 字节不进 DTO：写入时先落论文记录，再经 files.putAttachment@1 落附件（id 固定 'pdf'）。

// PDF 附件 id 与 migration.rs 的 convert_attachment 保持一致。
const PDF_ATTACHMENT_ID = 'pdf';

// 与 Rust 端 epoch_iso() 对齐：时间戳缺失时的兜底值（对应 optional_timestamp 的 None 分支）。
const EPOCH_ISO = '1970-01-01T00:00:00Z';

// ---------------- base64 编解码 ----------------
// Tauri webview 与 node 都有 atob/btoa；大文件分块拼接，避免展开参数导致栈溢出。

export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------- 日期转换 ----------------

// 毫秒/字符串 → ISO。字符串原样透传（容忍来源已是 ISO 的数据），空值回落兜底；
// 保存方向一律输出 ISO。对应 migration.rs 的 timestamp_to_iso + optional_timestamp。
function toIso(value, fallback = EPOCH_ISO) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value) return value;
  return fallback;
}

// ISO/毫秒 → 毫秒数字。载入方向容忍数字与字符串两种来源，无法解析时回落 0（epoch）。
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// ---------------- 记录 → DTO ----------------

// sections 映射 + sectionPages 映射 → SectionDto 数组。
// 顺序对齐 migration.rs 的 ordered_section_ids：abstract 在前，其后按 parts 顺序，最后是其余键。
function sectionsToDto(paper) {
  const sections = paper.sections || {};
  const pages = paper.sectionPages || {};
  const ordered = [];
  if ('abstract' in sections) ordered.push('abstract');
  for (const part of paper.parts || []) {
    if (part?.id && part.id in sections && !ordered.includes(part.id)) ordered.push(part.id);
  }
  for (const id of Object.keys(sections)) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered.map(id => {
    const range = pages[id];
    return {
      id,
      sourceText: typeof sections[id] === 'string' ? sections[id] : '',
      pageStart: range && Number.isFinite(range.start) ? range.start : null,
      pageEnd: range && Number.isFinite(range.end) ? range.end : null,
    };
  });
}

// parts 数组 → PartDto 数组：只存元数据，sortOrder 取数组下标（与 convert_parts 一致）。
function partsToDto(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter(part => typeof part?.id === 'string' && part.id)
    .map((part, index) => ({
      id: part.id,
      title: part.title ?? null,
      heading: part.heading ?? null,
      semanticType: part.semanticType ?? null,
      sortOrder: index,
    }));
}

function analysesToDto(analyses) {
  return Object.entries(analyses || {})
    .filter(([sectionId]) => sectionId.trim())
    .map(([sectionId, analysis]) => ({
      sectionId,
      text: analysis?.text ?? '',
      updatedAt: toIso(analysis?.updatedAt),
    }));
}

// translations 映射（键 `sectionId:language`）→ TranslationDto 数组。
// 键按第一个冒号拆分，与 convert_translations 的 split_once 一致；拆不出两段则丢弃。
function translationsToDto(translations) {
  const out = [];
  for (const [key, translation] of Object.entries(translations || {})) {
    const idx = key.indexOf(':');
    if (idx <= 0 || idx === key.length - 1) continue;
    out.push({
      sectionId: key.slice(0, idx),
      language: key.slice(idx + 1),
      text: translation?.text ?? '',
      source: translation?.source ?? null,
      updatedAt: toIso(translation?.updatedAt),
    });
  }
  return out;
}

// images 是自由 JSON，原样透传。
function recallCardToDto(recallCard) {
  return {
    markdown: recallCard?.markdown ?? '',
    images: Array.isArray(recallCard?.images) ? recallCard.images : [],
    updatedAt: toIso(recallCard?.updatedAt),
  };
}

// chat 消息缺 createdAt 时用论文 updatedAt 补齐（DTO 要求每条都有时间戳）。
function chatToDto(paper) {
  return (Array.isArray(paper.chat) ? paper.chat : []).map(message => ({
    role: message?.role ?? '',
    content: message?.content ?? '',
    createdAt: message?.createdAt ? toIso(message.createdAt) : toIso(paper.updatedAt),
  }));
}

// 论文记录 → PaperDto。pdfBlob/pdfAttachment/sectionPages 是运行时字段，不进 DTO。
function recordToDto(paper) {
  const now = new Date().toISOString();
  return {
    id: paper.id,
    title: paper.title ?? '',
    sourceType: paper.sourceType ?? null,
    arxivId: paper.arxivId ?? null,
    pdfName: paper.pdfName ?? '',
    numPages: paper.numPages ?? 0,
    fullText: paper.fullText ?? '',
    rating: paper.rating ?? 0,
    categories: Array.isArray(paper.categories) ? paper.categories : [],
    tags: Array.isArray(paper.tags) ? paper.tags : [],
    addedAt: toIso(paper.addedAt, now),
    updatedAt: toIso(paper.updatedAt, now),
    sections: sectionsToDto(paper),
    parts: partsToDto(paper.parts),
    analyses: analysesToDto(paper.analyses),
    translations: translationsToDto(paper.translations),
    recallCard: recallCardToDto(paper.recallCard),
    chat: chatToDto(paper),
  };
}

// ---------------- DTO → 记录 ----------------

// SectionDto 数组 → {sections 映射, sectionPages 映射}。
// 容忍两种来源：DTO 数组形状，以及迁移期/浏览器导出里的映射形状（含 sectionPages 字段）。
function sectionsFromDto(dto) {
  const sections = {};
  const sectionPages = {};
  const raw = dto?.sections;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      // 与 convert_sections 的数组分支一致：sourceText 缺失时接受 text 键。
      sections[id] = item.sourceText ?? item.text ?? '';
      if (Number.isFinite(item.pageStart) || Number.isFinite(item.pageEnd)) {
        sectionPages[id] = { start: item.pageStart ?? null, end: item.pageEnd ?? null };
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [id, text] of Object.entries(raw)) {
      if (typeof text === 'string') sections[id] = text;
    }
    for (const [id, range] of Object.entries(dto.sectionPages || {})) {
      if (range && (Number.isFinite(range.start) || Number.isFinite(range.end))) {
        sectionPages[id] = { start: range.start ?? null, end: range.end ?? null };
      }
    }
  }
  return { sections, sectionPages };
}

// PartDto 数组 → 浏览器 parts 形状：按 sortOrder 排序，text/pageRange 从
// sections/sectionPages 重建（浏览器 parts 冗余携带这两个字段），sourceRange 丢弃。
function partsFromDto(parts, sections, sectionPages) {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter(part => typeof part?.id === 'string' && part.id)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(part => ({
      id: part.id,
      title: part.title ?? '',
      heading: part.heading ?? '',
      semanticType: part.semanticType ?? 'part',
      text: sections[part.id] ?? '',
      pageRange: sectionPages[part.id] ?? null,
    }));
}

function analysesFromDto(analyses) {
  const out = {};
  for (const item of Array.isArray(analyses) ? analyses : []) {
    const sectionId = typeof item?.sectionId === 'string' ? item.sectionId.trim() : '';
    if (!sectionId) continue;
    out[sectionId] = { text: item.text ?? '', updatedAt: toMillis(item.updatedAt) };
  }
  return out;
}

function translationsFromDto(translations) {
  const out = {};
  for (const item of Array.isArray(translations) ? translations : []) {
    const sectionId = typeof item?.sectionId === 'string' ? item.sectionId.trim() : '';
    const language = typeof item?.language === 'string' ? item.language.trim() : '';
    if (!sectionId || !language) continue;
    out[`${sectionId}:${language}`] = {
      text: item.text ?? '',
      source: item.source ?? null,
      updatedAt: toMillis(item.updatedAt),
    };
  }
  return out;
}

function recallCardFromDto(recallCard) {
  return {
    markdown: recallCard?.markdown ?? '',
    images: Array.isArray(recallCard?.images) ? recallCard.images : [],
    updatedAt: toMillis(recallCard?.updatedAt),
  };
}

// chat 消息缺 createdAt 时用论文 updatedAt 补齐（与保存方向同一规则）。
function chatFromDto(dto) {
  const fallback = toMillis(dto?.updatedAt);
  return (Array.isArray(dto?.chat) ? dto.chat : []).map(message => ({
    role: message?.role ?? '',
    content: message?.content ?? '',
    createdAt: message?.createdAt ? toMillis(message.createdAt) : fallback,
  }));
}

// PaperDto → 论文记录：日期 ISO → 毫秒，数组 → 映射，parts 冗余字段重建。
function dtoToRecord(dto) {
  const { sections, sectionPages } = sectionsFromDto(dto);
  const record = {
    id: dto.id,
    title: dto.title ?? '',
    numPages: dto.numPages ?? 0,
    fullText: dto.fullText ?? '',
    rating: dto.rating ?? 0,
    categories: Array.isArray(dto.categories) ? dto.categories : [],
    tags: Array.isArray(dto.tags) ? dto.tags : [],
    addedAt: toMillis(dto.addedAt),
    updatedAt: toMillis(dto.updatedAt),
    sections,
    sectionPages,
    parts: partsFromDto(dto.parts, sections, sectionPages),
    analyses: analysesFromDto(dto.analyses),
    translations: translationsFromDto(dto.translations),
    recallCard: recallCardFromDto(dto.recallCard),
    chat: chatFromDto(dto),
    pdfName: dto.pdfName ?? '',
    pdfBlob: null,
  };
  if (dto.sourceType) record.sourceType = dto.sourceType;
  if (dto.arxivId) record.arxivId = dto.arxivId;
  return record;
}

// ---------------- PDF 附件 ----------------

// 瞬时 pdfBlob：导入/关联流程传入的 Blob/File（带 arrayBuffer()）。
function isPdfBlob(blob) {
  return Boolean(blob) && typeof blob.arrayBuffer === 'function' && (blob.size === undefined || blob.size > 0);
}

async function uploadPdfAttachment(bridge, paper) {
  const bytes = new Uint8Array(await paper.pdfBlob.arrayBuffer());
  await bridge.invoke('files.putAttachment@1', {
    paperId: paper.id,
    attachment: {
      id: PDF_ATTACHMENT_ID,
      name: paper.pdfName || 'paper.pdf',
      contentType: 'application/pdf',
      contentBase64: bytesToBase64(bytes),
    },
  });
}

// ---------------- 存储适配器 ----------------

export function createTauriStore(bridge) {
  // 载入后查询 PDF 附件：存在则挂 pdfAttachment 句柄、pdfBlob 置空。
  // listAttachments 失败不阻塞载入——论文内容已可读，仅 PDF 面板降级为「未关联」。
  async function attachPdfInfo(paper) {
    try {
      const result = await bridge.invoke('files.listAttachments@1', { paperId: paper.id });
      const pdf = (result?.attachments || []).find(attachment => attachment.id === PDF_ATTACHMENT_ID);
      if (pdf) paper.pdfAttachment = pdf;
    } catch (err) {
      console.warn(`读取论文 ${paper.id} 的附件清单失败，按无 PDF 处理：`, err);
    }
    paper.pdfBlob = null;
    return paper;
  }

  async function get(id) {
    const result = await bridge.invoke('library.getPaper@1', { paperId: id });
    if (!result?.paper) return undefined;
    return attachPdfInfo(dtoToRecord(result.paper));
  }

  async function readPdfRange(paper) {
    const result = await bridge.invoke('files.readRange@1', {
      paperId: paper.id,
      attachmentId: PDF_ATTACHMENT_ID,
      offset: 0,
      length: paper.pdfAttachment.size,
    });
    return result?.contentBase64 ?? '';
  }

  return {
    async getAll() {
      // 先取摘要列表再逐篇 getPaper：本地 IPC 开销低、个人书库规模小，
      // 而书库卡片需要 analyses 计算精读进度，摘要列表本身不够用。
      const result = await bridge.invoke('library.listPapers@1');
      const papers = [];
      for (const summary of result?.papers || []) {
        const paper = await get(summary.id);
        if (paper) papers.push(paper);
      }
      return papers;
    },

    get,

    async put(paper) {
      // PDF 字节不随记录持久化：pdfBlob 是运行时字段，不进 DTO。
      // 必须先落论文记录再传附件——files.putAttachment@1 校验论文必须已存在。
      await bridge.invoke('library.putPaper@1', { paper: recordToDto(paper) });
      if (isPdfBlob(paper.pdfBlob)) {
        await uploadPdfAttachment(bridge, paper);
        // 上传成功后清掉瞬时句柄，避免后续每次 put 重复上传整份 PDF。
        paper.pdfBlob = null;
      }
    },

    async delete(id) {
      await bridge.invoke('library.deletePaper@1', { paperId: id });
    },

    // 阅读位置三命令。位置 DTO 的 updatedAt 同样在边界做 毫秒↔ISO 双向转换。
    positions: {
      async get(paperId) {
        const result = await bridge.invoke('library.getReadingPosition@1', { paperId });
        const position = result?.position ?? null;
        if (position) position.updatedAt = toMillis(position.updatedAt);
        return position;
      },
      async put(position) {
        await bridge.invoke('library.putReadingPosition@1', {
          position: {
            paperId: position.paperId,
            view: position.view,
            sectionId: position.sectionId ?? null,
            pdfPage: position.pdfPage ?? null,
            contentVersion: position.contentVersion ?? null,
            updatedAt: toIso(position.updatedAt, new Date().toISOString()),
          },
        });
      },
      async delete(paperId) {
        await bridge.invoke('library.deleteReadingPosition@1', { paperId });
      },
    },

    // PDF 附件能力：bytes/base64 优先读瞬时 pdfBlob，否则经 readRange 全量读附件。
    pdf: {
      has(paper) {
        return isPdfBlob(paper?.pdfBlob) || Boolean(paper?.pdfAttachment);
      },
      async bytes(paper) {
        if (isPdfBlob(paper?.pdfBlob)) return paper.pdfBlob.arrayBuffer();
        if (!paper?.pdfAttachment) return null;
        const base64 = await readPdfRange(paper);
        return base64ToBytes(base64).buffer;
      },
      async base64(paper) {
        if (isPdfBlob(paper?.pdfBlob)) {
          return bytesToBase64(new Uint8Array(await paper.pdfBlob.arrayBuffer()));
        }
        if (!paper?.pdfAttachment) return null;
        return readPdfRange(paper);
      },
      async attach(paperId, file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await bridge.invoke('files.putAttachment@1', {
          paperId,
          attachment: {
            id: PDF_ATTACHMENT_ID,
            name: file.name || 'paper.pdf',
            contentType: file.type || 'application/pdf',
            contentBase64: bytesToBase64(bytes),
          },
        });
      },
    },
  };
}
