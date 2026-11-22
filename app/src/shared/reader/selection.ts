// Full 原文选区映射（SPEC-reader §3，paper-30min-qa3.2）：
// DOM 只承担交互；权威偏移来自投影逻辑序列（UTF-16 code unit，atom 占一位，
// 半开区间）。KaTeX/MathML 辅助节点、屏幕像素与 textContent 不参与偏移。
// 跨句/跨单元按阅读顺序完整展开；无法精确映射的端点显式降级为 block 锚点，
// 中间存在不可映射内容时不产出伪连续 ranges。
import type { DocumentAnchor } from "../document/anchor.js";
import { type ReaderProjection, type ReaderUnitContent } from "./projection.js";

type SelectionRange = Extract<DocumentAnchor, { kind: "range" }>["ranges"][number];
export type SentenceInfo = {
  unitId: string;
  length: number;
  /** 文本片段逻辑边界（atom 位置无条目，端点落入时整位纳入）。 */
  textParts: Array<{ start: number; end: number }>;
};
type BlockInfo = { blockId: string; sentenceIds: string[] };

export interface SelectionIndex {
  sentences: Map<string, SentenceInfo>;
  blocks: Map<string, BlockInfo>;
  order: Map<string, number>;
}

function unitSentences(unit: ReaderUnitContent, index: SelectionIndex) {
  for (const sentence of unit.sentences) {
    let length = 0;
    const textParts: Array<{ start: number; end: number }> = [];
    for (const part of sentence.parts) {
      if (part.kind === "text") textParts.push({ start: part.start, end: part.end });
      length = part.end;
    }
    index.sentences.set(sentence.sentenceId, { unitId: unit.unitId, length, textParts });
    index.order.set(sentence.sentenceId, index.order.size);
  }
}

/** 按投影构建选区索引：句子逻辑长度、文本片段边界与阅读顺序。
 * FullReader 每次投影构建一次，选区事件复用，不重复遍历文档。 */
export function buildSelectionIndex(projection: ReaderProjection): SelectionIndex {
  const index: SelectionIndex = { sentences: new Map(), blocks: new Map(), order: new Map() };
  for (const item of projection.items) {
    const sentenceIds: string[] = [];
    const collect = (unit: ReaderUnitContent) => {
      unitSentences(unit, index);
      sentenceIds.push(...unit.sentences.map((sentence) => sentence.sentenceId));
    };
    switch (item.kind) {
      case "unit":
        collect(item);
        break;
      case "figure":
        if (item.caption) collect(item.caption);
        break;
      case "table":
        if (item.caption) collect(item.caption);
        for (const row of item.rows) for (const cell of row) collect(item.cells[cell.unitId]);
        break;
      default:
        break;
    }
    index.blocks.set(item.blockId, { blockId: item.blockId, sentenceIds });
  }
  return index;
}

type Endpoint =
  | { kind: "text"; sentenceId: string; offset: number }
  | { kind: "atom"; sentenceId: string; offset: number }
  | { kind: "sentence"; sentenceId: string; edge: "start" | "end" }
  | { kind: "block"; blockId: string };

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** 端点解析：从 DOM 节点向上找投影锚点；atom 内任何深度（含 KaTeX 辅助层）
 * 都整位纳入（起点取 atom 头、终点取 atom 尾）；raw/公式等无 unit 结构块
 * 降级为 block 锚点。 */
function resolveEndpoint(node: Node, offset: number, index: SelectionIndex, side: "start" | "end"): Endpoint | null {
  let element = elementOf(node);
  // 先收集句子身份（外层），再解析片段/atom 边界（内层）；
  // 端点直接落在句子/块容器上时按句首/句尾或 block 降级处理。
  let sentenceId: string | null = null;
  for (let cursor = element; cursor; cursor = cursor.parentElement) {
    const sentenceAttr = cursor.getAttribute("data-sentence-id");
    if (sentenceAttr && index.sentences.has(sentenceAttr)) {
      sentenceId = sentenceAttr;
      break;
    }
  }
  while (element) {
    if (element.hasAttribute("data-atom-id") && sentenceId) {
      const start = Number(element.getAttribute("data-start"));
      const end = Number(element.getAttribute("data-end"));
      if (Number.isInteger(start) && Number.isInteger(end))
        return { kind: "atom", sentenceId, offset: side === "start" ? start : end };
    }
    const startAttr = element.getAttribute("data-start");
    if (startAttr !== null && sentenceId && element.hasAttribute("data-end")) {
      const start = Number(startAttr);
      const length = node instanceof Text ? node.data.length : 0;
      return { kind: "text", sentenceId, offset: start + Math.min(offset, length) };
    }
    if (element === elementOf(node)) {
      const sentenceAttr = element.getAttribute("data-sentence-id");
      if (sentenceAttr && index.sentences.has(sentenceAttr))
        return { kind: "sentence", sentenceId: sentenceAttr, edge: offset <= 0 ? "start" : "end" };
      const blockId = element.getAttribute("data-block-id");
      if (blockId && index.blocks.has(blockId)) {
        if (sentenceId) return { kind: "sentence", sentenceId, edge: offset <= 0 ? "start" : "end" };
        return { kind: "block", blockId };
      }
    }
    element = element.parentElement;
  }
  return null;
}

export interface ReaderSelectionMapping {
  /** 精确逻辑 ranges（阅读顺序、半开区间）；经 createRangeAnchor 校验后持久化。 */
  ranges: SelectionRange[];
  /** 无法精确映射的端点/内容：显式 block 锚点，不静默近似。 */
  degraded: Array<Extract<DocumentAnchor, { kind: "block" }>>;
}

function endpointPosition(endpoint: Endpoint, index: SelectionIndex): { sentenceId: string; offset: number } | null {
  switch (endpoint.kind) {
    case "text":
    case "atom":
      return { sentenceId: endpoint.sentenceId, offset: endpoint.offset };
    case "sentence": {
      const info = index.sentences.get(endpoint.sentenceId)!;
      return { sentenceId: endpoint.sentenceId, offset: endpoint.edge === "start" ? 0 : info.length };
    }
    case "block":
      return null;
  }
}

/** atom 整位规则：偏移落在文本片段内原样保留；落在 atom 逻辑位置内部时
 * 取其后首个文本边界——起点由此整位纳入该 atom，终点偏移指向 atom 尾时
 * 落在前一文本片段末端，同样整位。绝不产生半个 atom 的 range。 */
function snap(sentenceId: string, offset: number, index: SelectionIndex): number {
  const info = index.sentences.get(sentenceId)!;
  for (const part of info.textParts) {
    if (offset >= part.start && offset <= part.end) return offset;
    if (offset < part.start) return part.start;
  }
  return info.length;
}
/** 把 DOM Range 映射为原文逻辑选区。折叠选区、投影外内容与不可映射端点
 * 不产生伪 range；跨句/跨单元完整展开中间句子；中间出现无 unit 结构的块
 * （公式/图片/raw）时清空精确 ranges，只保留显式降级锚点。 */
export function mapDomSelection(range: Range, index: SelectionIndex): ReaderSelectionMapping {
  const empty: ReaderSelectionMapping = { ranges: [], degraded: [] };
  if (range.collapsed) return empty;
  const start = resolveEndpoint(range.startContainer, range.startOffset, index, "start");
  const end = resolveEndpoint(range.endContainer, range.endOffset, index, "end");
  if (!start || !end) return empty;

  const degraded: Array<Extract<DocumentAnchor, { kind: "block" }>> = [];
  if (start.kind === "block") degraded.push({ kind: "block", blockId: start.blockId });
  if (end.kind === "block" && (start.kind !== "block" || end.blockId !== start.blockId))
    degraded.push({ kind: "block", blockId: end.blockId });

  const from = endpointPosition(start, index);
  const to = endpointPosition(end, index);
  const anchorPosition = from ?? to;
  if (!anchorPosition) return { ranges: [], degraded };

  const ranges: SelectionRange[] = [];
  const pushRange = (sentenceId: string, startOffset: number, endOffset: number) => {
    if (startOffset >= endOffset) return;
    const info = index.sentences.get(sentenceId)!;
    ranges.push({ unitId: info.unitId, sentenceId, start: startOffset, end: endOffset });
  };

  if (from && to) {
    const fromIndex = index.order.get(from.sentenceId)!;
    const toIndex = index.order.get(to.sentenceId)!;
    if (fromIndex > toIndex) return { ranges: [], degraded };
    if (fromIndex === toIndex) {
      pushRange(from.sentenceId, snap(from.sentenceId, from.offset, index), snap(to.sentenceId, to.offset, index));
      return { ranges, degraded };
    }
    // 跨句/跨单元：中间句子全部显式保存；区间内部出现无 unit 结构的块
    // （公式/图片/raw）时连续精确映射失效，不静默跳过拼接伪连续选区。
    const sentenceBlock = new Map<string, number>();
    let blockPosition = 0;
    const blockPositions = new Map<string, number>();
    for (const [blockId, block] of index.blocks) {
      blockPositions.set(blockId, blockPosition++);
      for (const sentenceId of block.sentenceIds) sentenceBlock.set(sentenceId, blockPositions.get(blockId)!);
    }
    const firstBlock = sentenceBlock.get(from.sentenceId)!;
    const lastBlock = sentenceBlock.get(to.sentenceId)!;
    let contiguous = true;
    for (const [blockId, block] of index.blocks) {
      const position = blockPositions.get(blockId)!;
      if (position <= firstBlock || position >= lastBlock) continue;
      if (block.sentenceIds.length === 0) {
        contiguous = false;
        degraded.push({ kind: "block", blockId });
      }
    }
    if (!contiguous) return { ranges: [], degraded };
    pushRange(from.sentenceId, snap(from.sentenceId, from.offset, index), index.sentences.get(from.sentenceId)!.length);
    for (const [sentenceId, order] of index.order) {
      if (order <= fromIndex || order >= toIndex) continue;
      // 语言视图索引中 gap 句在读取顺序里但不可精确选区：跨 gap 不拼接伪连续 ranges。
      const info = index.sentences.get(sentenceId);
      if (!info) return { ranges: [], degraded };
      pushRange(sentenceId, 0, info.length);
    }
    pushRange(to.sentenceId, 0, snap(to.sentenceId, to.offset, index));
    return { ranges, degraded };
  }

  // 单端可映射：保留该端所在句子的精确部分（到句尾/从句首）。
  const position = anchorPosition;
  const info = index.sentences.get(position.sentenceId)!;
  if (from) pushRange(position.sentenceId, snap(position.sentenceId, position.offset, index), info.length);
  else pushRange(position.sentenceId, 0, snap(position.sentenceId, position.offset, index));
  return { ranges, degraded };
}
