// 三阶段协议的纯函数缝（#65 缝一 / 规格 #55 §Testing Decisions）：配方拼装、分片合并、
// 出处校验、工具调用块解析、产物 schema 校验。运行时由 Rust 驱动（app/src-tauri/src/protocol.rs），
// 本模块与其共享同一套规则与常量（token 估算式、块文本渲染格式、工具块围栏、出处语法、
// 校验口径）；两侧以同一份块模型磁盘夹具（src-tauri/tests/fixtures/protocol/）锚定，改动须同步。
// 消费方：本模块测试 + 后续视图票（#69 起）的产物渲染/出处定位/配方预览。

import { composePrompt, SECTION_TYPES } from './skills.js';

// ---------- 协议常量（与 Rust protocol.rs 一致，改动须同步） ----------
export const PROTOCOL_TASKS = {
  buildMap: 'paper.build-map@1',
  deepDive: 'paper.deep-dive@1',
  synthesize: 'paper.synthesize@1',
};
export const MAX_TOOL_STEPS = 12;
export const MAX_PARSE_FAILURES = 2;
export const INPUT_TOKEN_HARD_TOP = 983_616;
export const READ_SECTION_CHAR_CAP = 8_000;
export const SEARCH_HIT_CAP = 50;
export const PAGE_IMAGE_TOKEN_BUDGET = 1_902;
export const TOOL_NAMES = ['read_section', 'search_paper', 'get_figure', 'get_page_image'];
export const DEEP_DIVE_HEADERS = ['## 核心论点', '## 关键细节', '## 与全局的关系', '## 边界与存疑'];
export const SYNTHESIZE_HEADERS = ['## 问题', '## 方法', '## 证据', '## 边界'];

// ---------- token 估算（与 Rust estimate_text_tokens 同式） ----------
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** 保守文本 token 估算：CJK ≈ 1 token，其余 ≈ 1/4 token（上取整）。 */
export function estimateTextTokens(text) {
  let quarterUnits = 0;
  for (const ch of String(text ?? '')) {
    quarterUnits += CJK_RE.test(ch) ? 4 : 1;
  }
  return Math.ceil(quarterUnits / 4);
}

// ---------- 节 ↔ 精读部分映射（顺序对应约定，与 Rust 同规则） ----------
const CONTENT_ROLES = new Set(['body', 'appendix']);

/** 参与 L2 的节：除 References / Acknowledgments 外的全部原文章节（含 Abstract）。 */
export function l2Sections(mapped) {
  return (mapped?.sections ?? []).filter(s => s.role !== 'references' && s.role !== 'acknowledgments');
}

/** 内容节：part-N 映射的取值域（role ∈ body/appendix，按阅读顺序）。 */
export function contentSections(mapped) {
  return (mapped?.sections ?? []).filter(s => CONTENT_ROLES.has(s.role));
}

/** 节 → 精读部分 id：abstract → 'abstract'；第 i 个内容节 → part-{i+1}；映射不到为 null。 */
export function partIdForSection(mapped, secId) {
  const section = (mapped?.sections ?? []).find(s => s.id === secId);
  if (!section) return null;
  if (section.role === 'abstract') return 'abstract';
  const index = contentSections(mapped).findIndex(s => s.id === secId);
  return index === -1 ? null : `part-${index + 1}`;
}

/** 精读部分 id → 节：'abstract' → abstract 节；'part-N' → 第 N 个内容节；无效为 null。 */
export function sectionForPart(mapped, partId) {
  if (partId === 'abstract') {
    return (mapped?.sections ?? []).find(s => s.role === 'abstract') ?? null;
  }
  const match = /^part-(\d+)$/.exec(partId ?? '');
  if (!match) return null;
  const index = Number(match[1]);
  if (index < 1) return null;
  return contentSections(mapped)[index - 1] ?? null;
}

// ---------- 文本层渲染（与 Rust render_section_text / render_paper_text 同格式） ----------
/** 单节文本层：每块 `L{id} (p{page})：{text}`，块间空行。 */
export function renderSectionText(section) {
  return (section?.blocks ?? [])
    .map(block => `L${block.id} (p${block.page})：${String(block.text ?? '').trim()}`)
    .join('\n\n');
}

/** 多节文本层：节标题行 `## {secId} {title} (p{start}-{end})` + 节内块（调用①输入）。 */
export function renderPaperText(sections) {
  return sections
    .map(section => `## ${section.id} ${section.title} (p${section.pageStart}-${section.pageEnd})\n\n${renderSectionText(section)}`)
    .join('\n\n');
}

/** 图表清单渲染（调用②输入）：每件一行，含页码、归属节、图注与正文引用处数。 */
export function renderAssetList(entries) {
  if (!entries?.length) return '（空）';
  return entries
    .map(entry => `- ${entry.id}（p${entry.page}，属于 ${entry.section ?? '（首节之前）'}）：${entry.caption ?? '（无图注）'}（正文引用 ${entry.references?.length ?? 0} 处）`)
    .join('\n');
}

// ---------- 配方装配（协议提示词 + 关注点叠加经 skills.js composePrompt） ----------
/**
 * 建图调用①装配：每个参与 L2 的原文章节自成一片，返回各分片的完整提示词。
 * 分片合并不在此调用模型「总结摘要的摘要」——见 mergeL2ShardOutputs 的确定性拼装。
 */
export function assembleMapL2({ title, mapped } = {}) {
  const sections = l2Sections(mapped);
  const groups = sections.map(section => [section]);
  return {
    sharded: groups.length > 1,
    shards: groups.map(group => {
      const paperText = renderPaperText(group);
      const prompt = composePrompt('map-l2', { values: { title, paperText } });
      return {
        prompt,
        secIds: group.map(section => section.id),
        paperText,
        estimatedTokens: estimateTextTokens(prompt),
      };
    }),
  };
}

/**
 * 单片 L2 输出校验与确定性清理（与 Rust validate_l2_output 同规则）：
 * 覆盖必须恰好等于分片节集（缺/重/未知节 → throw）；title/pages 以块模型为准；
 * keyAssets 过滤到清单内 id；type 非法回退 part；输出按分片节序重排。
 * 返回 { entries, warnings }。
 */
export function validateL2Output(output, shardSections, mapped) {
  const knownAssets = new Set([...(mapped?.figures ?? []), ...(mapped?.tables ?? [])].map(entry => entry.id));
  const sections = output?.sections;
  if (!Array.isArray(sections)) throw new Error('输出缺少 sections 数组');
  const expected = shardSections.map(section => section.id);
  const seen = new Set();
  const warnings = [];
  const entries = [];
  for (const [index, item] of sections.entries()) {
    const secId = item?.secId;
    if (typeof secId !== 'string' || !secId) throw new Error(`sections[${index}] 缺少字符串字段 secId`);
    if (!expected.includes(secId)) throw new Error(`sections[${index}] 的 secId「${secId}」不在本分片节集内（不得产出分片外的节）`);
    if (seen.has(secId)) throw new Error(`节「${secId}」出现多次（每节恰好一条薄摘要）`);
    seen.add(secId);
    const section = shardSections.find(s => s.id === secId);
    const gist = typeof item.gist === 'string' ? item.gist.trim() : '';
    if (!gist) throw new Error(`节「${secId}」缺少非空 gist`);
    if (!Array.isArray(item.points) || !item.points.length) throw new Error(`节「${secId}」需要非空 points 数组`);
    const points = [];
    for (const point of item.points) {
      const text = typeof point?.text === 'string' ? point.text.trim() : '';
      if (!text) {
        warnings.push(`l2_points_dropped:${secId}`);
        continue;
      }
      const refs = Array.isArray(point.refs) ? point.refs.filter(r => typeof r === 'string') : [];
      points.push({ text, refs });
    }
    if (!points.length) throw new Error(`节「${secId}」的 points 全部为空`);
    // 规格 #55 决策 16 的字段级约束（要点 3–6 条、gist ≤2 句）按软约束落实：
    // 记 warning 不拒绝（与 Rust validate_l2_output 同口径）。
    if (points.length < 3 || points.length > 6) warnings.push(`l2_points_count:${secId}:${points.length}`);
    const gistSentences = gist.split(/[。！？.]/).filter(part => part.trim()).length;
    if (gistSentences > 2) warnings.push(`l2_gist_long:${secId}:${gistSentences}`);
    const keyAssets = [];
    for (const asset of Array.isArray(item.keyAssets) ? item.keyAssets : []) {
      if (typeof asset !== 'string') continue;
      if (knownAssets.has(asset)) keyAssets.push(asset);
      else warnings.push(`l2_key_asset_unknown:${secId}:${asset}`);
    }
    const type = SECTION_TYPES.includes(item.type) ? item.type : 'part';
    if (type !== item.type) warnings.push(`l2_type_fallback:${secId}:${item.type}`);
    entries.push({
      secId,
      title: section.title,
      type,
      gist,
      points,
      keyAssets,
      pages: { start: section.pageStart, end: section.pageEnd },
    });
  }
  const missing = expected.filter(id => !seen.has(id));
  if (missing.length) {
    throw new Error(`薄摘要覆盖不完整：缺少 ${missing.join(', ')}（每个原文章节恰好一条，References/Acknowledgments 除外）`);
  }
  entries.sort((a, b) => expected.indexOf(a.secId) - expected.indexOf(b.secId));
  return { entries, warnings };
}

/** 分片合并 = 确定性拼装：逐片校验后按分片顺序拼接（覆盖校验已在片内完成）。 */
export function mergeL2ShardOutputs(outputs, shardGroups, mapped) {
  const entries = [];
  const warnings = [];
  for (const [index, output] of outputs.entries()) {
    const merged = validateL2Output(output, shardGroups[index], mapped);
    entries.push(...merged.entries);
    warnings.push(...merged.warnings);
  }
  return { entries, warnings };
}

/** 建图调用②装配：全部 L2 + 图表清单 + 摘要 → L1 阅读地图。 */
export function assembleMapL1({ title, abstract, l2Entries, figures, tables } = {}) {
  return composePrompt('map-l1', {
    values: {
      title,
      abstract: abstract ?? '',
      l2Summaries: JSON.stringify(l2Entries ?? [], null, 2),
      figureList: renderAssetList(figures),
      tableList: renderAssetList(tables),
    },
  });
}

/** 深挖配方打底：L1 全带 + L2 全带 + 当前节原文全送；返回提示词与随消息附图页码（±1 页）。 */
export function assembleDeepDive({ title, mapBody, l2Bodies, section, sectionType, pageCount } = {}) {
  const sectionText = renderSectionText(section);
  const sectionPages = section.pageStart === section.pageEnd
    ? `p${section.pageStart}`
    : `p${section.pageStart}-p${section.pageEnd}`;
  const prompt = composePrompt('deep-dive', {
    values: {
      title,
      map: JSON.stringify(mapBody ?? {}, null, 2),
      l2Summaries: JSON.stringify(l2Bodies ?? [], null, 2),
      sectionId: section.id,
      sectionTitle: section.title,
      sectionType,
      sectionText,
      sectionPages,
    },
    sectionType,
  });
  const imagePages = [];
  for (let page = Math.max(1, section.pageStart - 1); page <= Math.min(pageCount, section.pageEnd + 1); page++) {
    imagePages.push(page);
  }
  return { prompt, imagePages };
}

/** 复述稿的深挖材料拼装：按节阅读顺序排列，标注部分身份与节标题（与 Rust render_dig_blob 同形态）。 */
export function renderDigBlob({ digs = [], mapped, parts = [] } = {}) {
  if (!digs.length) return '（尚无深挖结果）';
  const orderOf = partId => {
    const section = sectionForPart(mapped, partId);
    const index = (mapped?.sections ?? []).findIndex(s => s.id === section?.id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return digs
    .map(dig => ({ dig, order: orderOf(dig.partId) }))
    .sort((a, b) => a.order - b.order)
    .map(({ dig }) => {
      const title = parts.find(part => part.id === dig.partId)?.title ?? '';
      return `### ${dig.partId}（${title}）\n${dig.body}`;
    })
    .join('\n\n');
}

/** 综合装配：L1 + 全部 L2 + 已有深挖结果。 */
export function assembleSynthesize({ title, mapBody, l2Bodies, digsBlob } = {}) {
  return composePrompt('synthesize', {
    values: {
      title,
      map: JSON.stringify(mapBody ?? {}, null, 2),
      l2Summaries: JSON.stringify(l2Bodies ?? [], null, 2),
      digResults: digsBlob ?? '（尚无深挖结果）',
    },
  });
}

// ---------- 文本协议：工具调用块解析（与 Rust parse_round_output 同规则） ----------
function validateToolArgs(name, args) {
  const needString = field => {
    const value = args[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`工具 ${name} 需要非空字符串参数 ${field}`);
  };
  const needPositiveInt = field => {
    const value = args[field];
    if (!Number.isInteger(value) || value < 1) throw new Error(`工具 ${name} 的 ${field} 必须是正整数`);
  };
  switch (name) {
    case 'read_section':
      needString('sec_id');
      for (const field of ['offset', 'limit']) {
        if (field in args) needPositiveInt(field);
      }
      break;
    case 'search_paper':
      needString('pattern');
      break;
    case 'get_figure':
      needString('fig_id');
      break;
    case 'get_page_image':
      needPositiveInt('page');
      break;
    default:
      throw new Error(`未知工具 ${name}（可用：${TOOL_NAMES.join(', ')}）`);
  }
}

/**
 * 解析一轮模型输出：无 ```tool 围栏 → {type:'final', text}；有围栏解析为工具调用
 * {type:'call', name, args}；围栏未闭合 / JSON 非法 / 缺 name / args 非对象 / 未知工具 /
 * 参数形状非法 → {type:'error', message}（由调用方喂回模型并计入连续失败）。
 */
export function parseToolCallBlock(text) {
  const start = String(text ?? '').indexOf('```tool');
  if (start === -1) return { type: 'final', text: String(text ?? '').trim() };
  const afterMarker = text.slice(start + '```tool'.length).replace(/^[ \t]+/, '').replace(/^\n/, '');
  const end = afterMarker.indexOf('```');
  if (end === -1) return { type: 'error', message: '工具调用块围栏未闭合（缺少收尾的 ```）' };
  const content = afterMarker.slice(0, end).trim();
  let value;
  try {
    value = JSON.parse(content);
  } catch (err) {
    return { type: 'error', message: `工具调用块 JSON 解析失败: ${err.message}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'error', message: '工具调用块必须是一个 JSON 对象' };
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return { type: 'error', message: '工具调用块缺少字符串字段 name' };
  if (!TOOL_NAMES.includes(name)) {
    return { type: 'error', message: `未知工具 ${name}（可用：${TOOL_NAMES.join(', ')}）` };
  }
  let args = {};
  if (value.args != null) {
    if (typeof value.args !== 'object' || Array.isArray(value.args)) {
      return { type: 'error', message: '工具调用块的 args 必须是对象' };
    }
    args = value.args;
  }
  try {
    validateToolArgs(name, args);
  } catch (err) {
    return { type: 'error', message: err.message };
  }
  return { type: 'call', name, args };
}

// ---------- 出处指针解析与校验（统一语法：(p5) / (fig_3) / (tbl_2) / (L12-18) / (sec_2:L30-34)） ----------
const REF_RE = /\((p\d+|fig_[\w-]+|tbl_[\w-]+|L\d+(?:\s*-\s*\d+)?|sec_[\w-]+:L\d+(?:\s*-\s*\d+)?)\)/g;

/** 提取文本中的全部出处指针，解析为结构化形态。 */
export function parseRefs(text) {
  const refs = [];
  for (const match of String(text ?? '').matchAll(REF_RE)) {
    const raw = match[1];
    let ref;
    if (/^p\d+$/.test(raw)) {
      ref = { kind: 'page', page: Number(raw.slice(1)) };
    } else if (raw.startsWith('fig_')) {
      ref = { kind: 'figure', assetId: raw };
    } else if (raw.startsWith('tbl_')) {
      ref = { kind: 'table', assetId: raw };
    } else if (raw.startsWith('L')) {
      const [start, end] = raw.slice(1).split('-').map(part => Number(part.trim()));
      ref = { kind: 'blocks', secId: null, start, end: end ?? start };
    } else {
      const [secId, range] = raw.split(':');
      const [start, end] = range.slice(1).split('-').map(part => Number(part.trim()));
      ref = { kind: 'blocks', secId, start, end: end ?? start };
    }
    ref.raw = `(${raw})`;
    refs.push(ref);
  }
  return refs;
}

/**
 * 出处校验：space = { pageCount, assetIds: Set, sections: Map(secId → blockCount), currentSecId }。
 * 本节块引用（L12-18）落在 currentSecId；跨节引用的节 id 允许精确或 sec_{n}_ 前缀唯一匹配
 * （提示词示例的 sec_2 短形与地址空间全形 sec_2_method 同源）。返回 { refs, invalid }。
 */
export function validateRefs(text, space) {
  const { pageCount = 0, assetIds = new Set(), sections = new Map(), currentSecId = '' } = space ?? {};
  const resolveSection = secId => {
    if (!secId) return currentSecId;
    if (sections.has(secId)) return secId;
    const prefixMatches = [...sections.keys()].filter(id => id.startsWith(`${secId}_`));
    return prefixMatches.length === 1 ? prefixMatches[0] : null;
  };
  const refs = [];
  const invalid = [];
  for (const ref of parseRefs(text)) {
    let ok = true;
    if (ref.kind === 'page') {
      ok = ref.page >= 1 && ref.page <= pageCount;
    } else if (ref.kind === 'figure' || ref.kind === 'table') {
      ok = assetIds.has(ref.assetId);
    } else {
      const secId = resolveSection(ref.secId);
      const blockCount = secId ? sections.get(secId) : 0;
      ok = !!secId && ref.start >= 1 && ref.end >= ref.start && ref.end <= blockCount;
      if (secId) ref.secId = secId;
    }
    (ok ? refs : invalid).push(ref);
  }
  return { refs, invalid };
}

// ---------- 产物 schema 校验（protocol_products 四种 kind） ----------
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validateTextWithRefs(entry, field, errors) {
  if (!entry || typeof entry !== 'object') {
    errors.push(`${field} 必须是对象`);
    return;
  }
  if (!isNonEmptyString(entry.text)) errors.push(`${field}.text 必须是非空字符串`);
  if (entry.refs != null && !isStringArray(entry.refs)) errors.push(`${field}.refs 必须是字符串数组`);
}

/**
 * 产物 schema 校验：map/l2 为结构对象（含可选 partial 中断标记），dig/retell 为 Markdown 字符串。
 * 返回 { ok, errors }；只做形状校验，出处完整性由产物纪律与 validateRefs 承担。
 */
export function validateProduct(kind, body) {
  const errors = [];
  if (kind === 'dig' || kind === 'retell') {
    if (!isNonEmptyString(body)) errors.push('dig/retell 产物 body 必须是非空 Markdown 字符串');
    return { ok: errors.length === 0, errors };
  }
  if (kind === 'map') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, errors: ['map 产物 body 必须是对象'] };
    }
    validateTextWithRefs(body.problem, 'problem', errors);
    validateTextWithRefs(body.method, 'method', errors);
    for (const field of ['contributions', 'keyEvidence', 'glossary', 'structure']) {
      if (body[field] != null && !Array.isArray(body[field])) errors.push(`${field} 必须是数组`);
    }
    for (const [index, item] of (body.keyEvidence ?? []).entries()) {
      if (!isNonEmptyString(item?.assetId)) errors.push(`keyEvidence[${index}].assetId 必须是非空字符串`);
    }
    for (const [index, item] of (body.structure ?? []).entries()) {
      if (!isNonEmptyString(item?.secId)) errors.push(`structure[${index}].secId 必须是非空字符串`);
    }
  } else if (kind === 'l2') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, errors: ['l2 产物 body 必须是对象'] };
    }
    if (!isNonEmptyString(body.secId)) errors.push('secId 必须是非空字符串');
    if (!isNonEmptyString(body.gist)) errors.push('gist 必须是非空字符串');
    if (!Array.isArray(body.points) || !body.points.length) {
      errors.push('points 必须是非空数组');
    } else {
      for (const [index, point] of body.points.entries()) {
        if (!isNonEmptyString(point?.text)) errors.push(`points[${index}].text 必须是非空字符串`);
        if (point?.refs != null && !isStringArray(point.refs)) errors.push(`points[${index}].refs 必须是字符串数组`);
      }
    }
    if (body.keyAssets != null && !isStringArray(body.keyAssets)) errors.push('keyAssets 必须是字符串数组');
    if (body.type != null && !SECTION_TYPES.includes(body.type)) errors.push(`type 必须是受控词表之一（${SECTION_TYPES.join('/')}）`);
    const pages = body.pages;
    if (pages != null) {
      if (!Number.isInteger(pages.start) || !Number.isInteger(pages.end) || pages.start < 1 || pages.end < pages.start) {
        errors.push('pages 必须是 {start, end} 正整数区间');
      }
    }
  } else {
    errors.push(`未知产物 kind: ${kind}`);
  }
  if (body && typeof body === 'object' && body.partial != null && typeof body.partial !== 'boolean') {
    errors.push('partial 标记必须是布尔值');
  }
  return { ok: errors.length === 0, errors };
}
