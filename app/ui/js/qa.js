// 提问三形态上下文组装纯函数（#67 / 规格 #52 决策 4–8）：
// 输入 = 论文产物（L1 阅读地图 / L2 节薄摘要 / 块模型）+ 会话历史 + 当轮绑定，
// 输出 = messages 数组。历史重放只含用户原文与引用标注文本形态，绑定注入不重放；
// 装配超 INPUT_TOKEN_HARD_TOP 硬顶报错拒绝（不截断）。页图不进问答；图表裁切图是
// 问答唯一图像通道（仅片段形态覆盖图表占位时附上）。
//
// 消费方：本模块测试 + 问答发送路径（#68 绑定 UI 把当轮绑定写入消息后即走此缝）。

import {
  INPUT_TOKEN_HARD_TOP,
  PAGE_IMAGE_TOKEN_BUDGET,
  estimateTextTokens,
  l2Sections,
  partIdForSection,
  renderPaperText,
  renderSectionText,
} from './protocol.js';

export const CHAT_HISTORY_WINDOW = 12;
export const BLOCKMODEL_ATTACHMENT_ID = 'blockmodel.json';
export const CROP_ID_PREFIX = 'crop-';

/** 裁切图附件 ID：`crop-fig_3` / `crop-tbl_1`（与 Rust pdfassets::crop_attachment_id 同约定）。 */
export function cropAttachmentId(assetId) {
  return `${CROP_ID_PREFIX}${assetId}`;
}

function qaError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function mapBodyFrom(products) {
  const row = (products ?? []).find(item => item?.kind === 'map');
  return row?.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : null;
}

function l2BodyForSection(products, mapped, secId) {
  const partId = partIdForSection(mapped, secId);
  if (!partId) return null;
  const row = (products ?? []).find(item => item?.kind === 'l2' && item.partId === partId);
  return row?.body ?? null;
}

function sectionById(mapped, secId) {
  return (mapped?.sections ?? []).find(section => section.id === secId) ?? null;
}

function bindingKindOf(binding) {
  const kind = binding?.bindingKind;
  return kind || 'none';
}

function bindingAnnotation(binding, mapped) {
  const kind = bindingKindOf(binding);
  if (kind === 'section') {
    const section = sectionById(mapped, binding?.secId);
    const name = section?.title || binding?.secId || '';
    return name ? `[@${name}]` : null;
  }
  if (kind === 'fragment') {
    const text = typeof binding?.fragmentText === 'string' ? binding.fragmentText : '';
    return `[引用："${text}"]`;
  }
  return null;
}

function annotateUserText(content, binding, mapped) {
  const annotation = bindingAnnotation(binding, mapped);
  const text = String(content ?? '');
  if (!annotation) return text;
  if (text.startsWith(annotation)) return text;
  return `${annotation}\n${text}`;
}

function sectionOrderIndex(mapped, secId) {
  return (mapped?.sections ?? []).findIndex(section => section.id === secId);
}

function blockPosition(mapped, secId, blockId) {
  const index = sectionOrderIndex(mapped, secId);
  if (index === -1) return null;
  return index * 1_000_000 + Number(blockId);
}

/**
 * 选区覆盖的文本块并集（跨节取起止两段之间、按阅读顺序）。
 * 起止颠倒时按文档序归一。
 */
function coveredBlockItems(mapped, cite) {
  if (!cite || typeof cite !== 'object') {
    throw qaError('invalid_binding', '片段绑定需要块区间出处（cite）。');
  }
  const start = blockPosition(mapped, cite.startSecId, cite.startBlock);
  const end = blockPosition(mapped, cite.endSecId, cite.endBlock);
  if (start == null || end == null) {
    throw qaError('invalid_binding', '片段出处指向的节不在块模型地址空间内。');
  }
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const items = [];
  for (const section of mapped?.sections ?? []) {
    for (const block of section.blocks ?? []) {
      const pos = blockPosition(mapped, section.id, block.id);
      if (pos != null && pos >= lo && pos <= hi) items.push({ section, block });
    }
  }
  if (!items.length) {
    throw qaError('invalid_binding', '片段出处没有覆盖到任何文本块。');
  }
  return items;
}

function renderCoveredBlocks(items) {
  const groups = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.section.id === item.section.id) last.blocks.push(item.block);
    else groups.push({ section: item.section, blocks: [item.block] });
  }
  const sliced = groups.map(({ section, blocks }) => ({ ...section, blocks }));
  return sliced.length === 1 ? renderSectionText(sliced[0]) : renderPaperText(sliced);
}

function knownAssetIds(mapped) {
  return new Set([...(mapped?.figures ?? []), ...(mapped?.tables ?? [])].map(entry => entry.id));
}

/** 覆盖块中的图/表占位 → 裁切图附件 id（清单内、覆盖即附、不设数量帽、阅读序去重）。 */
function cropAssetIdsForBlocks(items, mapped) {
  const known = knownAssetIds(mapped);
  const ids = [];
  const seen = new Set();
  const add = assetId => {
    if (!assetId || !known.has(assetId) || seen.has(assetId)) return;
    seen.add(assetId);
    ids.push(cropAttachmentId(assetId));
  };
  for (const { block } of items) {
    if (typeof block.assetId === 'string') add(block.assetId);
    const text = String(block.text ?? '');
    for (const match of text.matchAll(/\[(?:图|表) ((?:fig|tbl)_[\w-]+)\]/g)) add(match[1]);
  }
  return ids;
}

function renderJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function buildSystemContent({ title, mapped, products, kind, section, coveredText }) {
  const lines = [
    `你是「论文精读助手」，正在帮助用户深入理解论文《${title}》。`,
    '请基于下方材料用中文回答；引用原文时使用统一出处语法：`(p5)` 页、`(fig_3)` / `(tbl_2)` 图表、`(L12-18)` 本节块、`(sec_2:L30-34)` 跨节块。',
    '如果材料中没有相关内容，请如实说明，不要编造。回答使用 Markdown 格式。问答不使用抓取工具。',
    '',
    '阅读地图（L1）：',
    '"""',
    renderJson(mapBodyFrom(products)),
    '"""',
  ];
  if (kind === 'section' && section) {
    const l2 = l2BodyForSection(products, mapped, section.id);
    if (l2) {
      lines.push('', '本节薄摘要（L2）：', '"""', renderJson(l2), '"""');
    }
    lines.push('', '本节原文（完整，块号以 L 标注）：', '"""', renderSectionText(section), '"""');
  } else if (kind === 'fragment') {
    lines.push('', '选中片段覆盖的文本块：', '"""', coveredText, '"""');
  } else {
    lines.push('', '整篇原文（块序）：', '"""', renderPaperText(mapped?.sections ?? []), '"""');
  }
  return lines.join('\n');
}

function replayHistory(history, mapped) {
  const windowed = (history ?? []).slice(-CHAT_HISTORY_WINDOW);
  return windowed.map(message => {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'assistant') {
      return { role, content: String(message?.content ?? '') };
    }
    return { role, content: annotateUserText(message?.content ?? '', message, mapped) };
  });
}

function userMessage(text, cropAssetIds, crops) {
  const urls = cropAssetIds
    .map(id => crops?.[id])
    .filter(url => typeof url === 'string' && url);
  if (!urls.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...urls.map(url => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

function estimateMessageTokens(message) {
  const content = message?.content;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part?.type === 'text') total += estimateTextTokens(part.text);
    else if (part?.type === 'image_url') total += PAGE_IMAGE_TOKEN_BUDGET;
  }
  return total;
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * 三形态提问上下文组装。
 *
 * @param {object} input
 * @param {string} input.title
 * @param {object} input.mapped 块模型
 * @param {Array}  input.products protocol_products 快照（含 map / l2）
 * @param {Array}  input.history 先前 chat 消息（可超 12 条，函数取尾窗）
 * @param {string} input.question 当轮用户原文
 * @param {object} input.binding 当轮绑定（bindingKind/secId/fragmentText/cite）
 * @param {object} [input.crops] 裁切图 data URL，键为 crop-* 附件 id
 * @param {number} [input.hardTop] 测试可下调；生产为 983,616
 * @returns {{ messages: Array, estimatedTokens: number, cropAssetIds: string[] }}
 */
export function assembleQaContext({
  title,
  mapped,
  products = [],
  history = [],
  question = '',
  binding = { bindingKind: 'none' },
  crops = {},
  hardTop = INPUT_TOKEN_HARD_TOP,
} = {}) {
  if (!mapBodyFrom(products)) {
    throw qaError(
      'map_required',
      '未建图：提问须先完成建图。阅读地图就位后才能装配上下文。',
    );
  }
  const kind = bindingKindOf(binding);
  let section = null;
  let coveredText = '';
  let cropAssetIds = [];

  if (kind === 'section') {
    section = sectionById(mapped, binding?.secId);
    if (!section) {
      throw qaError('invalid_binding', `绑定的原文章节「${binding?.secId ?? ''}」不在块模型地址空间内。`);
    }
    const needsL2 = l2Sections(mapped).some(item => item.id === section.id);
    if (needsL2 && !l2BodyForSection(products, mapped, section.id)) {
      throw qaError(
        'l2_missing',
        `未找到本节节薄摘要（${section.id}）。提问须在建图完成后进行。`,
      );
    }
  } else if (kind === 'fragment') {
    const items = coveredBlockItems(mapped, binding?.cite);
    coveredText = renderCoveredBlocks(items);
    cropAssetIds = cropAssetIdsForBlocks(items, mapped);
  }

  const system = {
    role: 'system',
    content: buildSystemContent({
      title: title ?? mapped?.title ?? '',
      mapped,
      products,
      kind,
      section,
      coveredText,
    }),
  };
  const replayed = replayHistory(history, mapped);
  const current = userMessage(annotateUserText(question, binding, mapped), cropAssetIds, crops);
  const messages = [system, ...replayed, current];
  const estimatedTokens = estimateMessagesTokens(messages);
  if (estimatedTokens > hardTop) {
    throw qaError(
      'input_too_large',
      `论文过长：装配后估算输入 ${estimatedTokens} token，超过模型输入硬顶 ${hardTop}（不截断）。请改用绑定提问缩小范围。`,
      { estimatedTokens, hardTop },
    );
  }
  return { messages, estimatedTokens, cropAssetIds };
}
