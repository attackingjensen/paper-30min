import { randomUUID } from "node:crypto";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { PdfParseAssetFact } from "../../shared/parsing.js";
import { MISSING_ASSET_PLACEHOLDER } from "./parse-snapshot.js";
import {
  textSentences,
  type AssetReference,
  type BlockNode,
  type CaptionInput,
  type CellInput,
  type FigureBlock,
  type TreeBuilder,
} from "./parse-tree.js";

/** HTML 表格转换：行列跨度结构化与安全消毒（SPEC-pdf-import §6.6）。
 * 无法无损结构化时降级为消毒后的 raw block；清洗后为空只保留固定占位，绝不回退清洗前原文。 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const MAX_TABLE_ROWS = 4096;
const MAX_TABLE_COLUMNS = 256;
const RAW_HTML_TAGS: Record<string, true> = {
  blockquote: true, br: true, code: true, em: true, li: true, ol: true, p: true,
  pre: true, span: true, strong: true, sub: true, sup: true, table: true,
  tbody: true, td: true, tfoot: true, th: true, thead: true, tr: true, ul: true,
};
const CELL_INLINE_TAGS: Record<string, true> = {
  br: true, code: true, em: true, p: true, span: true, strong: true, sub: true, sup: true,
};
const DANGEROUS_TAGS: Record<string, true> = {
  script: true, style: true, iframe: true, object: true, embed: true, noscript: true,
  template: true, link: true, meta: true, base: true,
};
/** 消毒后为空的表格只保留该固定占位；清洗前原文不进入任何持久化内容。 */
const EMPTY_TABLE_PLACEHOLDER = "[empty table]";

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isParent(node: Node): node is ParentNode {
  return "childNodes" in node;
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function findTag(root: Node, tagName: string): Element | null {
  if (isElement(root) && root.tagName === tagName) return root;
  if (!isParent(root)) return null;
  for (const child of root.childNodes) {
    const found = findTag(child, tagName);
    if (found) return found;
  }
  return null;
}

interface TablePageFacts {
  /** vendorPath → 本地资产引用或去敏占位。 */
  images: Record<string, string>;
  assets: PdfParseAssetFact[];
}

export interface TableContext {
  builder: TreeBuilder;
  page: TablePageFacts;
  /** 已引用的本地资产路径，供资产未引用诊断。 */
  referenced: Set<string>;
  /** 表格别名：诊断归属键。 */
  aliases: string[];
  /** 配对图注：结构化时随表格，降级时成为普通段落。 */
  caption: CaptionInput | null;
  /** 视觉块占位：空表格或消毒后为空时保留块事实与可选裁剪资产。 */
  placeholder: (warning: string) => FigureBlock;
  warn: (code: string, sourceAlias?: string) => void;
  sanitized: boolean;
  tableImage: boolean;
}

function resolveImage(vendorPath: string, context: TableContext): AssetReference {
  const reference = context.page.images[vendorPath];
  if (reference === undefined || reference === MISSING_ASSET_PLACEHOLDER) return null;
  const fact = context.page.assets.find((asset) => asset.vendorPath === vendorPath);
  if (!fact) return null;
  context.referenced.add(fact.path);
  return { path: fact.path, sha256: fact.sha256, mime: fact.mime };
}

function imagePlaceholder(element: Element, context: TableContext): string {
  const src = attr(element, "src");
  if (src !== undefined) resolveImage(src, context);
  context.tableImage = true;
  const alt = attr(element, "alt");
  return alt && alt.trim() ? alt.trim() : "[image]";
}

/** 单元格文本投影：保留文字，图片给可读占位，危险与未知标记消毒。 */
function cellText(node: Node, context: TableContext): string {
  if (node.nodeName === "#text")
    return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (node.nodeName === "#comment") {
    context.sanitized = true;
    return "";
  }
  if (!isElement(node))
    return isParent(node) ? node.childNodes.map((child) => cellText(child, context)).join("") : "";
  const element = node;
  if (DANGEROUS_TAGS[element.tagName]) {
    context.sanitized = true;
    return "";
  }
  if (element.tagName === "img") {
    context.sanitized = true;
    return imagePlaceholder(element, context);
  }
  if (element.tagName === "br") return " ";
  const structural = element.tagName === "td" || element.tagName === "th";
  for (const entry of element.attrs) {
    if (structural && (entry.name === "colspan" || entry.name === "rowspan")) continue;
    context.sanitized = true;
  }
  if (!CELL_INLINE_TAGS[element.tagName]) context.sanitized = true;
  const children = element.childNodes.map((child) => cellText(child, context)).join("");
  return element.tagName === "p" ? ` ${children} ` : children;
}

interface SpanCell {
  unitId: string;
  rowSpan: number;
  columnSpan: number;
  text: string;
}

/** 行列跨度提取：来源跨度不可信，超出网格规模、非安全整数或跨度范围重叠时整体降级 raw。 */
function tableRows(tabular: Element, context: TableContext): SpanCell[][] | null {
  const trs: Element[] = [];
  const collectRows = (node: Node): void => {
    if (isElement(node) && node.tagName === "tr") {
      trs.push(node);
      return;
    }
    if (isElement(node) && node.tagName === "table" && node !== tabular) return;
    if (isParent(node)) for (const child of node.childNodes) collectRows(child);
  };
  collectRows(tabular);
  if (!trs.length || trs.length > MAX_TABLE_ROWS) return null;
  const cellsOf = (tr: Element): Element[] => tr.childNodes.filter(
    (child): child is Element => isElement(child) && (child.tagName === "td" || child.tagName === "th"),
  );
  for (const tr of trs) {
    const cells = cellsOf(tr);
    if (!cells.length) return null;
    // 任意深度的嵌套表格都无法用行列跨度无损表达。
    for (const cell of cells)
      if (findTag(cell, "table")) return null;
  }
  const spanOf = (cell: Element, name: string): number | null => {
    const raw = attr(cell, name);
    if (raw === undefined) return 1;
    if (!/^[0-9]+$/.test(raw.trim())) return null;
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return value;
  };
  const rows: SpanCell[][] = [];
  const occupied = new Map<string, true>();
  const key = (row: number, column: number): string => `${row}:${column}`;
  for (let rowIndex = 0; rowIndex < trs.length; rowIndex += 1) {
    const row: SpanCell[] = [];
    let columnIndex = 0;
    for (const cell of cellsOf(trs[rowIndex])) {
      while (occupied.has(key(rowIndex, columnIndex))) columnIndex += 1;
      const rowSpan = spanOf(cell, "rowspan");
      const columnSpan = spanOf(cell, "colspan");
      if (rowSpan === null || columnSpan === null) return null;
      if (rowSpan > trs.length - rowIndex || columnSpan > MAX_TABLE_COLUMNS) return null;
      if (columnIndex + columnSpan > MAX_TABLE_COLUMNS) return null;
      // 跨度范围内部任一格已被占用都会产生重叠单元：整体降级，不静默错排。
      for (let dr = 0; dr < rowSpan; dr += 1)
        for (let dc = 0; dc < columnSpan; dc += 1)
          if (occupied.has(key(rowIndex + dr, columnIndex + dc))) return null;
      row.push({
        unitId: context.builder.reserveUnit(),
        rowSpan,
        columnSpan,
        text: cellText(cell, context),
      });
      for (let dr = 0; dr < rowSpan; dr += 1)
        for (let dc = 0; dc < columnSpan; dc += 1)
          occupied.set(key(rowIndex + dr, columnIndex + dc), true);
      columnIndex += columnSpan;
    }
    rows.push(row);
  }
  return rows;
}

/** 重建消毒后的 HTML：白名单标记、无属性、危险内容移除、未知标记解包。 */
function sanitizeNode(node: Node, context: TableContext): Node[] {
  if (node.nodeName === "#text") return [node];
  if (node.nodeName === "#comment") {
    context.sanitized = true;
    return [];
  }
  if (!isElement(node)) {
    context.sanitized = true;
    return [];
  }
  const element = node;
  if (DANGEROUS_TAGS[element.tagName]) {
    context.sanitized = true;
    return [];
  }
  if (element.tagName === "img") {
    context.sanitized = true;
    const placeholder = imagePlaceholder(element, context);
    return [{ nodeName: "#text", value: placeholder, parentNode: null } as unknown as Node];
  }
  const children = element.childNodes.flatMap((child) => sanitizeNode(child, context));
  if (element.attrs.length) context.sanitized = true;
  if (!RAW_HTML_TAGS[element.tagName]) {
    context.sanitized = true;
    return children;
  }
  return [{
    ...element,
    attrs: [],
    childNodes: children as DefaultTreeAdapterMap["element"]["childNodes"],
  }];
}

function textProjection(nodes: Node[]): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeName === "#text") {
      parts.push((node as DefaultTreeAdapterMap["textNode"]).value);
      return;
    }
    if (isElement(node) && DANGEROUS_TAGS[node.tagName]) return;
    if (isParent(node)) for (const child of node.childNodes) walk(child);
  };
  for (const node of nodes) walk(node);
  return parts.join("");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 表格块转换入口：结构化成功落 table 块；否则消毒降级 raw；清洗后为空只留固定占位。 */
export function convertTable(content: string, context: TableContext): void {
  const { builder, aliases, caption } = context;
  const trimmed = content.trim();
  const fallback = (html: string, text: string): void => {
    context.warn("pdf-convert-table-lossy", aliases[0]);
    builder.addRaw(html, text, ["pdf.convert.tableLossy"], aliases);
    // 图注随 raw 降级为普通段落，按 vendor 顺序落在表格投影之后，不丢弃。
    if (caption)
      builder.flushUnit(caption.unitId, "paragraph", caption.sentences, {
        id: randomUUID(),
        sectionId: builder.currentSectionId,
        kind: "unit",
        unitId: caption.unitId,
        ...(caption.aliases ? { sourceAliases: caption.aliases } : {}),
      } as BlockNode, caption.aliases);
  };
  const emptyPlaceholder = (): void => {
    // 空表格或清洗后为空：保留视觉块事实与固定可读占位，绝不回退清洗前原文。
    context.warn("pdf-convert-table-lossy", aliases[0]);
    const block = context.placeholder("pdf.convert.figureMissing");
    const unitId = builder.reserveUnit();
    builder.attachCaption(block, {
      unitId,
      sentences: textSentences(EMPTY_TABLE_PLACEHOLDER, unitId, builder),
      aliases,
    });
    if (caption) builder.flushUnit(caption.unitId, "paragraph", caption.sentences, null, caption.aliases);
  };
  if (!trimmed) {
    emptyPlaceholder();
    return;
  }
  if (!trimmed.startsWith("<")) {
    fallback(escapeText(content), content);
    return;
  }
  const fragment = parseFragment(content);
  const tables = fragment.childNodes.filter(
    (child): child is Element => isElement(child) && child.tagName === "table",
  );
  const onlyTable = tables.length === 1 && fragment.childNodes.every(
    (child) => child === tables[0] ||
      (child.nodeName === "#text" && !(child as DefaultTreeAdapterMap["textNode"]).value.trim()),
  );
  const rows = onlyTable ? tableRows(tables[0], context) : null;
  if (rows) {
    // 结构化成功但所有单元格消毒后无文字（如 script 独占）：等价于清洗后为空，
    // 只留固定占位，不产生空表格块。
    if (rows.every((row) => row.every((cell) => !cell.text.trim()))) {
      emptyPlaceholder();
      if (context.sanitized) context.warn("pdf-convert-html-sanitized", aliases[0]);
      return;
    }
    const cells: CellInput[][] = rows.map((row) => row.map((cell) => ({
      unitId: cell.unitId,
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      sentences: textSentences(cell.text || " ", cell.unitId, builder),
      ...(aliases ? { aliases } : {}),
    })));
    builder.addTable(cells, caption, aliases);
    if (context.tableImage) context.warn("pdf-convert-table-image", aliases[0]);
    if (context.sanitized) context.warn("pdf-convert-html-sanitized", aliases[0]);
    return;
  }
  const cleaned = fragment.childNodes.flatMap((child) => sanitizeNode(child, context));
  const html = cleaned.map((node) => isElement(node)
    ? serialize(node)
    : escapeText((node as DefaultTreeAdapterMap["textNode"]).value)).join("");
  const text = textProjection(cleaned);
  if (!html.trim() && !text.trim()) {
    emptyPlaceholder();
  } else {
    fallback(html || escapeText(EMPTY_TABLE_PLACEHOLDER), text || EMPTY_TABLE_PLACEHOLDER);
  }
  if (context.tableImage) context.warn("pdf-convert-table-image", aliases[0]);
  if (context.sanitized) context.warn("pdf-convert-html-sanitized", aliases[0]);
}