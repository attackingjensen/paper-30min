import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { readDiagnosticArray, type ImportDiagnostic } from "../../shared/arxiv.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import { parseDocumentTree } from "../../shared/document/tree.js";
import { createDocumentChangeset } from "../../shared/document/changeset.js";
import type {
  ManagedFileContent,
  PdfParseSourceSnapshotRecord,
  ProjectRevisionRecord,
} from "../../shared/contracts.js";
import type {
  PdfParseAssetFact,
  PdfParseFactsFile,
  PdfParseTaskRecord,
} from "../../shared/parsing.js";
import {
  commitRevision,
  completePublishedRevision,
  inspectImportCandidate,
  openProject,
  readRevision,
  readSourceSnapshot,
  type ProjectCommitHooks,
} from "../project-core.js";
import { createDocumentMergeCandidate, type DocumentMergeCandidate } from "../document/merge.js";
import { cropPdfPageRegions, type PdfCropAsset, type PdfCropRequest } from "../pdf/page-crop.js";
import { MISSING_ASSET_PLACEHOLDER } from "./parse-snapshot.js";

/** 转换器持久版本：算法变化必须递增（SPEC-pdf-import §6.10 确定性契约）。 */
export const PDF_CONVERTER_VERSION = 2;

const MAX_TABLE_ROWS = 4096;
const MAX_TABLE_COLUMNS = 256;

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type InlinePart = DocumentTree["sentences"][string]["content"][number];
type BlockNode = DocumentTree["blocks"][number];
type FigureBlock = Extract<BlockNode, { kind: "figure" }>;
type UnitKind = DocumentTree["units"][string]["kind"];
type AssetReference = FigureBlock["asset"];
type AtomValue = DocumentTree["atoms"][string];
type AtomInput = AtomValue extends infer T
  ? T extends AtomValue ? Omit<T, "id" | "unitId"> : never
  : never;

type PdfConvertPoint = "candidate-built" | "before-publish";

export interface PdfConvertHooks {
  onConvertPoint?: (point: PdfConvertPoint) => void | Promise<void>;
  commitHooks?: ProjectCommitHooks;
}

interface ConvertParseInput {
  paperId: string;
  /** 已去敏并本地化的受管 result.jsonl 字节。 */
  resultBytes: Uint8Array;
  facts: PdfParseFactsFile;
  /** 原页裁切请求（无云端资产的视觉块）；纯转换不渲染，由调用方先行裁切。 */
  cropRequests?: PdfCropRequest[];
  /** 已渲染裁剪资产：key（首个块别名）→ 内容寻址 PNG。 */
  cropAssets?: Map<string, PdfCropAsset>;
  signal?: AbortSignal;
}

type ConvertParseResult =
  | {
      ok: true;
      tree: DocumentTree;
      warnings: ImportDiagnostic[];
      cropRequests: PdfCropRequest[];
      /** 已渲染裁剪资产；convertParseResult 输入按块别名键，convertSnapshotTree 输出按资产路径键。 */
      cropAssets?: Map<string, PdfCropAsset>;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

interface PublishParseDocumentInput {
  root: string;
  /** phase 为 downloaded 或 converting，且已关联解析快照。 */
  task: PdfParseTaskRecord;
  snapshot: PdfParseSourceSnapshotRecord;
  signal?: AbortSignal;
  /** 候选身份持久化回调：提交前由调用方写入恢复记录，崩溃后沿用同一候选。 */
  onCandidateBuilt?: (candidate: { revisionId: string }) => Promise<void>;
  hooks?: PdfConvertHooks;
}

type PublishParseDocumentResult =
  | {
      ok: true;
      revision: ProjectRevisionRecord;
      warnings: ImportDiagnostic[];
      converterVersion: number;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

const MESSAGE_KEYS: Record<string, string> = {
  "pdf-convert-snapshot-invalid": "pdf.convert.snapshotInvalid",
  "pdf-convert-snapshot-digest": "pdf.convert.snapshotDigest",
  "pdf-convert-group-invalid": "pdf.convert.groupInvalid",
  "pdf-convert-body-empty": "pdf.convert.bodyEmpty",
  "pdf-convert-tree-invalid": "pdf.convert.treeInvalid",
  "pdf-convert-current-exists": "pdf.convert.currentExists",
  "pdf-convert-publish-failed": "pdf.convert.publishFailed",
  "pdf-convert-interrupted": "pdf.convert.interrupted",
  "pdf-convert-progress-failed": "pdf.convert.progressFailed",
  "pdf-convert-candidate-inspect-failed": "pdf.convert.candidateInspectFailed",
  "pdf-convert-record-corrupt": "pdf.convert.recordCorrupt",
  "pdf-convert-version-missing": "pdf.convert.versionMissing",
  "pdf-convert-stopped": "pdf.convert.stopped",
  "pdf-convert-hierarchy-flattened": "pdf.convert.hierarchyFlattened",
  "pdf-convert-order-degraded": "pdf.convert.orderDegraded",
  "pdf-convert-label-downgraded": "pdf.convert.labelDowngraded",
  "pdf-convert-furniture": "pdf.convert.furniture",
  "pdf-convert-caption-unattached": "pdf.convert.captionUnattached",
  "pdf-convert-figure-missing": "pdf.convert.figureMissing",
  "pdf-convert-formula-empty": "pdf.convert.formulaEmpty",
  "pdf-convert-table-lossy": "pdf.convert.tableLossy",
  "pdf-convert-html-sanitized": "pdf.convert.htmlSanitized",
  "pdf-convert-table-image": "pdf.convert.tableImage",
  "pdf-convert-image-unresolved": "pdf.convert.imageUnresolved",
  "pdf-convert-asset-unreferenced": "pdf.convert.assetUnreferenced",
  "pdf-convert-page-empty": "pdf.convert.pageEmpty",
  "pdf-convert-title-empty": "pdf.convert.titleEmpty",
  "pdf-convert-title-duplicate": "pdf.convert.titleDuplicate",
  "pdf-convert-section-empty": "pdf.convert.sectionEmpty",
};

class ConvertFatalError extends Error {
  constructor(
    readonly code: string,
    readonly stage: ImportDiagnostic["stage"],
  ) {
    super(code);
    this.name = "ConvertFatalError";
  }
}

/** 元数据校验专用错误：按类型分类，不与无关提交故障的消息文本混淆。 */
class ConvertMetadataError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
    this.name = "ConvertMetadataError";
  }
}

function fatal(code: string, stage: ImportDiagnostic["stage"] = "convert"): never {
  throw new ConvertFatalError(code, stage);
}

function diagnostic(
  code: string,
  severity: ImportDiagnostic["severity"],
  stage: ImportDiagnostic["stage"],
  sourceAlias?: string,
): ImportDiagnostic {
  return {
    code,
    severity,
    stage,
    messageKey: MESSAGE_KEYS[code] ?? code,
    ...(sourceAlias === undefined ? {} : { sourceAlias }),
  };
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fatal("pdf-convert-snapshot-invalid");
  return value as Record<string, unknown>;
}

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

// ---------------------------------------------------------------------------
// 受管响应解析与 facts 交叉核验
// ---------------------------------------------------------------------------

interface ConvertedBlock {
  id: number;
  label: string;
  content: string;
  order: number | null;
  groupId: number | null;
  bbox: [number, number, number, number] | null;
}

interface ConvertedPage {
  page: number;
  width: number;
  height: number;
  blocks: ConvertedBlock[];
  /** vendorPath → 本地资产引用或去敏占位。 */
  images: Record<string, string>;
  assets: PdfParseAssetFact[];
  /** 页面预处理事实：use_doc_preprocessor 为 true 时区域映射不可靠。 */
  preprocessed: boolean;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fatal("pdf-convert-snapshot-invalid");
  return value;
}

function nullableBbox(value: unknown): [number, number, number, number] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  )
    fatal("pdf-convert-snapshot-invalid");
  return value as [number, number, number, number];
}

function validateFacts(value: unknown): PdfParseFactsFile {
  const record = objectValue(value);
  if (record.formatVersion !== 1 || !Array.isArray(record.pages))
    fatal("pdf-convert-snapshot-invalid");
  const pageCount = record.pageCount;
  if (
    typeof pageCount !== "number" ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    record.pages.length !== pageCount
  )
    fatal("pdf-convert-snapshot-invalid");
  for (const [index, entry] of (record.pages as unknown[]).entries()) {
    const page = objectValue(entry);
    if (page.page !== index + 1) fatal("pdf-convert-snapshot-invalid");
    if (
      typeof page.width !== "number" || !Number.isFinite(page.width) || page.width <= 0 ||
      typeof page.height !== "number" || !Number.isFinite(page.height) || page.height <= 0 ||
      !Array.isArray(page.blocks) || !Array.isArray(page.assets)
    )
      fatal("pdf-convert-snapshot-invalid");
    for (const block of page.blocks as unknown[]) {
      const fact = objectValue(block);
      if (
        typeof fact.blockId !== "number" || !Number.isSafeInteger(fact.blockId) ||
        typeof fact.label !== "string"
      )
        fatal("pdf-convert-snapshot-invalid");
      nullableNumber(fact.order);
      nullableNumber(fact.groupId);
      nullableBbox(fact.bbox);
    }
    for (const asset of page.assets as unknown[]) {
      const fact = objectValue(asset);
      if (
        typeof fact.vendorPath !== "string" ||
        typeof fact.path !== "string" ||
        typeof fact.sha256 !== "string" ||
        typeof fact.size !== "number" ||
        typeof fact.mime !== "string"
      )
        fatal("pdf-convert-snapshot-invalid");
    }
  }
  return value as PdfParseFactsFile;
}

/** 解析受管 result.jsonl 并与 facts.json 交叉核验；任何不一致都拒绝转换。 */
function parseSanitizedRows(bytes: Uint8Array, facts: PdfParseFactsFile): ConvertedPage[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fatal("pdf-convert-snapshot-invalid");
  }
  const pages: ConvertedPage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fatal("pdf-convert-snapshot-invalid");
    }
    const rowRecord = objectValue(value);
    const result = objectValue(rowRecord.result);
    const info = objectValue(result.dataInfo);
    const list = result.layoutParsingResults;
    if (info.type !== "pdf" || !Array.isArray(list) || info.numPages !== list.length)
      fatal("pdf-convert-snapshot-invalid");
    for (const entry of list as unknown[]) {
      const pageRecord = objectValue(entry);
      const data = objectValue(pageRecord.prunedResult);
      const width = data.width;
      const height = data.height;
      if (
        typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
        typeof height !== "number" || !Number.isFinite(height) || height <= 0 ||
        !Array.isArray(data.parsing_res_list)
      )
        fatal("pdf-convert-snapshot-invalid");
      const blocks: ConvertedBlock[] = [];
      for (const item of data.parsing_res_list as unknown[]) {
        const record = objectValue(item);
        if (
          typeof record.block_id !== "number" || !Number.isSafeInteger(record.block_id) ||
          typeof record.block_label !== "string" ||
          typeof record.block_content !== "string"
        )
          fatal("pdf-convert-snapshot-invalid");
        blocks.push({
          id: record.block_id,
          label: record.block_label,
          content: record.block_content,
          order: nullableNumber(record.block_order),
          groupId: nullableNumber(record.group_id),
          bbox: nullableBbox(record.block_bbox),
        });
      }
      const images: Record<string, string> = {};
      if (pageRecord.markdown !== undefined) {
        const markdown = objectValue(pageRecord.markdown);
        if (markdown.images !== undefined) {
          const manifest = objectValue(markdown.images);
          for (const [vendorPath, raw] of Object.entries(manifest)) {
            if (typeof raw !== "string") fatal("pdf-convert-snapshot-invalid");
            images[vendorPath] = raw;
          }
        }
      }
      const settings = data.model_settings;
      const preprocessed = settings !== null && typeof settings === "object" &&
        (settings as Record<string, unknown>).use_doc_preprocessor === true;
      pages.push({ page: pages.length + 1, width, height, blocks, images, assets: [], preprocessed });
    }
  }
  if (pages.length !== facts.pageCount) fatal("pdf-convert-snapshot-invalid");
  for (const [index, page] of pages.entries()) {
    const fact = facts.pages[index];
    if (page.width !== fact.width || page.height !== fact.height)
      fatal("pdf-convert-snapshot-invalid");
    if (page.blocks.length !== fact.blocks.length) fatal("pdf-convert-snapshot-invalid");
    for (const [blockIndex, block] of page.blocks.entries()) {
      const blockFact = fact.blocks[blockIndex];
      if (
        block.id !== blockFact.blockId ||
        block.label !== blockFact.label ||
        block.order !== blockFact.order ||
        block.groupId !== blockFact.groupId ||
        JSON.stringify(block.bbox) !== JSON.stringify(blockFact.bbox)
      )
        fatal("pdf-convert-snapshot-invalid");
    }
    page.assets = fact.assets;
    const factByPath = new Map(fact.assets.map((asset) => [asset.vendorPath, asset]));
    for (const [vendorPath, reference] of Object.entries(page.images)) {
      const asset = factByPath.get(vendorPath);
      if (reference === MISSING_ASSET_PLACEHOLDER) {
        if (asset) fatal("pdf-convert-snapshot-invalid");
      } else if (!asset || asset.path !== reference) {
        fatal("pdf-convert-snapshot-invalid");
      }
    }
    for (const asset of fact.assets)
      if (page.images[asset.vendorPath] !== asset.path) fatal("pdf-convert-snapshot-invalid");
  }
  return pages;
}

// ---------------------------------------------------------------------------
// 规范树构建
// ---------------------------------------------------------------------------

function mergeTextParts(parts: InlinePart[]): InlinePart[] {
  const merged: InlinePart[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (!part.text) continue;
      const last = merged[merged.length - 1];
      if (last && last.kind === "text") {
        last.text += part.text;
        continue;
      }
      merged.push({ kind: "text", text: part.text });
    } else {
      merged.push(part);
    }
  }
  return merged;
}

/** 确定句切分：英文终止符后随空白或结尾，中文终止符直接断句；不猜测语义。 */
function splitSentences(parts: InlinePart[]): InlinePart[][] {
  const sentences: InlinePart[][] = [];
  let current: InlinePart[] = [];
  const flush = (): void => {
    const merged = mergeTextParts(current);
    if (merged.some((part) => part.kind === "atom" || part.text.trim())) sentences.push(merged);
    current = [];
  };
  for (const part of parts) {
    if (part.kind === "atom") {
      current.push(part);
      continue;
    }
    let rest = part.text;
    for (;;) {
      const match = /[.!?](?=\s|$)|[。！？]/.exec(rest);
      if (!match) {
        if (rest) current.push({ kind: "text", text: rest });
        break;
      }
      const end = match.index + match[0].length;
      current.push({ kind: "text", text: rest.slice(0, end) });
      flush();
      rest = rest.slice(end).replace(/^\s+/, "");
    }
  }
  flush();
  return sentences;
}

interface CaptionInput {
  unitId: string;
  sentences: InlinePart[][];
  aliases?: string[];
}

interface CellInput {
  unitId: string;
  sentences: InlinePart[][];
  rowSpan: number;
  columnSpan: number;
  aliases?: string[];
}

class TreeBuilder {
  readonly tree: DocumentTree;
  readonly warnings: ImportDiagnostic[] = [];
  readonly rootId: string;
  currentSectionId: string;
  readableUnits = 0;

  constructor(paperId: string) {
    this.rootId = randomUUID();
    this.currentSectionId = this.rootId;
    this.tree = {
      documentFormatVersion: 1,
      paperId,
      sections: {
        [this.rootId]: {
          id: this.rootId,
          parentSectionId: null,
          title: "",
          childSectionIds: [],
          unitIds: [],
        },
      },
      units: {},
      sentences: {},
      atoms: {},
      blocks: [],
    };
  }

  reserveUnit(): string {
    return randomUUID();
  }

  addAtom(unitId: string, atom: AtomInput): string {
    const atomId = randomUUID();
    (this.tree.atoms as Record<string, unknown>)[atomId] = { id: atomId, unitId, ...atom };
    return atomId;
  }

  setRootTitle(title: string, aliases?: string[]): void {
    const root = this.tree.sections[this.rootId];
    root.title = title;
    if (aliases) root.sourceAliases = aliases;
  }

  /** 平铺章节：vendor 不提供层级，全部直属根章节（SPEC §6.2 确定降级）。 */
  addSection(title: string, aliases?: string[]): string {
    const id = randomUUID();
    this.tree.sections[id] = {
      id,
      parentSectionId: this.rootId,
      title,
      childSectionIds: [],
      unitIds: [],
      ...(aliases ? { sourceAliases: aliases } : {}),
    };
    this.tree.sections[this.rootId].childSectionIds.push(id);
    this.currentSectionId = id;
    return id;
  }

  flushUnit(
    unitId: string,
    kind: UnitKind,
    sentences: InlinePart[][],
    block: BlockNode | null,
    aliases?: string[],
  ): void {
    const sectionId = this.currentSectionId;
    const sentenceIds: string[] = [];
    let readable = false;
    for (const parts of sentences) {
      const merged = mergeTextParts(parts);
      if (!merged.length) continue;
      if (merged.some((part) => part.kind === "atom" || part.text.trim())) readable = true;
      const sentenceId = randomUUID();
      this.tree.sentences[sentenceId] = { id: sentenceId, unitId, content: merged };
      sentenceIds.push(sentenceId);
      for (const part of merged)
        if (part.kind === "atom") this.tree.atoms[part.atomId].unitId = unitId;
    }
    if (!sentenceIds.length) {
      const sentenceId = randomUUID();
      this.tree.sentences[sentenceId] = {
        id: sentenceId,
        unitId,
        content: [{ kind: "text", text: " " }],
      };
      sentenceIds.push(sentenceId);
    }
    this.tree.units[unitId] = {
      id: unitId,
      sectionId,
      kind,
      sentenceIds,
      ...(aliases ? { sourceAliases: aliases } : {}),
    };
    this.tree.sections[sectionId].unitIds.push(unitId);
    if (block) this.tree.blocks.push(block);
    if (readable) this.readableUnits += 1;
  }

  addUnit(kind: UnitKind, sentences: InlinePart[][], aliases?: string[]): string {
    const unitId = this.reserveUnit();
    this.flushUnit(unitId, kind, sentences, {
      id: randomUUID(),
      sectionId: this.currentSectionId,
      kind: "unit",
      unitId,
      ...(aliases ? { sourceAliases: aliases } : {}),
    }, aliases);
    return unitId;
  }

  addFigure(input: { asset: AssetReference; warning?: string; aliases?: string[] }): FigureBlock {
    const block: FigureBlock = {
      id: randomUUID(),
      sectionId: this.currentSectionId,
      kind: "figure",
      asset: input.asset,
      captionUnitId: null,
      ...(input.warning ? { warning: input.warning } : {}),
      ...(input.aliases ? { sourceAliases: input.aliases } : {}),
    };
    this.tree.blocks.push(block);
    return block;
  }

  /** 图注紧随视觉块落树：单元顺序与阅读块顺序一致（validateBlocks 契约）。 */
  attachCaption(block: FigureBlock, caption: CaptionInput): void {
    block.captionUnitId = caption.unitId;
    this.flushUnit(caption.unitId, "caption", caption.sentences, null, caption.aliases);
  }

  addTable(rows: CellInput[][], caption: CaptionInput | null, aliases?: string[]): void {
    const sectionId = this.currentSectionId;
    const block: BlockNode = {
      id: randomUUID(),
      sectionId,
      kind: "table",
      captionUnitId: caption?.unitId ?? null,
      rows: rows.map((row) => row.map((cell) => ({
        unitId: cell.unitId,
        rowSpan: cell.rowSpan,
        columnSpan: cell.columnSpan,
      }))),
      ...(aliases ? { sourceAliases: aliases } : {}),
    };
    const ordered: Array<{ kind: UnitKind; entry: CaptionInput | CellInput }> = [
      ...(caption ? [{ kind: "caption" as UnitKind, entry: caption }] : []),
      ...rows.flat().map((cell) => ({ kind: "table-cell" as UnitKind, entry: cell })),
    ];
    for (const [index, { kind, entry }] of ordered.entries())
      this.flushUnit(entry.unitId, kind, entry.sentences, index === 0 ? block : null, entry.aliases);
    if (!ordered.length) this.tree.blocks.push(block);
  }

  addFormula(
    source: { format: "latex" | "text"; value: string },
    text: string,
    aliases?: string[],
    asset?: AssetReference,
  ): void {
    this.tree.blocks.push({
      id: randomUUID(),
      sectionId: this.currentSectionId,
      kind: "formula",
      source,
      text,
      ...(asset ? { asset } : {}),
      ...(aliases ? { sourceAliases: aliases } : {}),
    });
  }

  addRaw(html: string, text: string, limitations: string[], aliases?: string[]): void {
    this.tree.blocks.push({
      id: randomUUID(),
      sectionId: this.currentSectionId,
      kind: "raw",
      html,
      text,
      limitations,
      ...(aliases ? { sourceAliases: aliases } : {}),
    });
  }
}

function warn(builder: TreeBuilder, code: string, sourceAlias?: string): void {
  builder.warnings.push(diagnostic(code, "warning", "convert", sourceAlias));
}

/** 行内内容：$$…$$ 与 $…$ 成为 math atom，其余逐字保留为文本投影。 */
function inlineParts(text: string, unitId: string, builder: TreeBuilder): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const inner = (match[1] ?? match[2] ?? "").trim();
    if (!inner) continue;
    if (match.index > cursor)
      parts.push({ kind: "text", text: text.slice(cursor, match.index) });
    const atomId = builder.addAtom(unitId, {
      kind: "math",
      text: match[0],
      source: { format: "latex", value: inner },
    });
    parts.push({ kind: "atom", atomId });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}

function textSentences(text: string, unitId: string, builder: TreeBuilder): InlinePart[][] {
  return splitSentences(inlineParts(text, unitId, builder));
}

// ---------------------------------------------------------------------------
// HTML 表格：结构化转换与安全消毒
// ---------------------------------------------------------------------------

const RAW_HTML_TAGS = new Set([
  "blockquote", "br", "code", "em", "li", "ol", "p", "pre", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const CELL_INLINE_TAGS = new Set(["br", "code", "em", "p", "span", "strong", "sub", "sup"]);
const DANGEROUS_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "link", "meta", "base",
]);

interface TableContext {
  builder: TreeBuilder;
  page: ConvertedPage;
  referenced: Set<string>;
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
  if (DANGEROUS_TAGS.has(element.tagName)) {
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
  if (!CELL_INLINE_TAGS.has(element.tagName)) context.sanitized = true;
  const children = element.childNodes.map((child) => cellText(child, context)).join("");
  return element.tagName === "p" ? ` ${children} ` : children;
}

interface SpanCell {
  unitId: string;
  rowSpan: number;
  columnSpan: number;
  text: string;
}

/** 行列跨度提取：来源跨度不可信，超出网格规模或非安全整数时整体降级 raw。 */
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
  if (DANGEROUS_TAGS.has(element.tagName)) {
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
  if (!RAW_HTML_TAGS.has(element.tagName)) {
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
    if (isElement(node) && DANGEROUS_TAGS.has(node.tagName)) return;
    if (isParent(node)) for (const child of node.childNodes) walk(child);
  };
  for (const node of nodes) walk(node);
  return parts.join("");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function convertTable(
  content: string,
  aliases: string[],
  caption: CaptionInput | null,
  context: TableContext,
): void {
  const builder = context.builder;
  const trimmed = content.trim();
  const fallback = (html: string, text: string): void => {
    warn(builder, "pdf-convert-table-lossy", aliases[0]);
    builder.addRaw(html, text, ["pdf.convert.tableLossy"], aliases);
    // 图注随 raw 降级为普通段落，按 vendor 顺序落在表格投影之后，不丢弃。
    if (caption)
      builder.flushUnit(caption.unitId, "paragraph", caption.sentences, {
        id: randomUUID(),
        sectionId: builder.currentSectionId,
        kind: "unit",
        unitId: caption.unitId,
        ...(caption.aliases ? { sourceAliases: caption.aliases } : {}),
      }, caption.aliases);
  };
  if (!trimmed) {
    // 空表格无法结构化：保留视觉块事实与可读占位。
    warn(builder, "pdf-convert-table-lossy", aliases[0]);
    const block = builder.addFigure({
      asset: null,
      warning: MESSAGE_KEYS["pdf-convert-figure-missing"],
      aliases,
    });
    if (caption) builder.attachCaption(block, caption);
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
    const cells: CellInput[][] = rows.map((row) => row.map((cell) => ({
      unitId: cell.unitId,
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      sentences: textSentences(cell.text || " ", cell.unitId, builder),
      ...(aliases ? { aliases } : {}),
    })));
    builder.addTable(cells, caption, aliases);
  } else {
    const cleaned = fragment.childNodes.flatMap((child) => sanitizeNode(child, context));
    const html = cleaned.map((node) => isElement(node)
      ? serialize(node)
      : escapeText((node as DefaultTreeAdapterMap["textNode"]).value)).join("");
    fallback(html || escapeText(content), textProjection(cleaned) || content);
  }
  if (context.tableImage) warn(builder, "pdf-convert-table-image", aliases[0]);
  if (context.sanitized) warn(builder, "pdf-convert-html-sanitized", aliases[0]);
}

// ---------------------------------------------------------------------------
// 块组转换
// ---------------------------------------------------------------------------

interface BlockGroup {
  label: string;
  blocks: ConvertedBlock[];
  aliases: string[];
  content: string;
}

/** 同 group_id 的多区域块合并；混用标签是结构损坏，拒绝转换。 */
function groupBlocks(page: ConvertedPage): BlockGroup[] {
  const groups: BlockGroup[] = [];
  const byGroup = new Map<number, BlockGroup>();
  for (const block of page.blocks) {
    const alias = `page-${page.page}/b${block.id}`;
    const existing = block.groupId !== null ? byGroup.get(block.groupId) : undefined;
    if (existing) {
      if (existing.label !== block.label) fatal("pdf-convert-group-invalid");
      existing.blocks.push(block);
      existing.aliases.push(alias);
      if (block.content) existing.content += (existing.content ? "\n" : "") + block.content;
    } else {
      const created: BlockGroup = {
        label: block.label,
        blocks: [block],
        aliases: [alias],
        content: block.content,
      };
      groups.push(created);
      if (block.groupId !== null) byGroup.set(block.groupId, created);
    }
  }
  return groups;
}

const IMAGE_REFERENCE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const VISUAL_LABELS = new Set(["image", "chart"]);
const FURNITURE_LABELS = new Set(["header", "footer", "number"]);

/** 文档级转换状态：标题可跨页延续，章节在首个内容块到达时才创建。 */
interface ConversionState {
  pendingTitle: { title: string; aliases: string[] } | null;
  flattened: boolean;
}

interface PageContext {
  builder: TreeBuilder;
  page: ConvertedPage;
  referenced: Set<string>;
  state: ConversionState;
  cropRequests: PdfCropRequest[];
  cropAssets: Map<string, PdfCropAsset>;
}

/** 无云端资产的视觉块登记原页裁切请求（SPEC §6.7）：预处理页区域映射不可靠，
 * 只声明页级来源并记录 warning；几何是否可校准由裁切模块按 PDF 事实判定。 */
function requestCrop(
  context: PageContext,
  aliases: string[],
  bbox: [number, number, number, number] | null,
): void {
  const key = aliases[0];
  if (context.cropAssets.has(key)) return;
  if (context.page.preprocessed) {
    if (!context.cropRequests.some((request) => request.key === key)) {
      context.builder.warnings.push({
        code: "pdf-crop-region-uncalibrated",
        severity: "warning",
        stage: "convert",
        messageKey: "pdf.crop.regionUncalibrated",
        sourceAlias: key,
      });
      context.cropRequests.push({
        key,
        page: context.page.page,
        pageWidth: context.page.width,
        pageHeight: context.page.height,
        bbox: null,
      });
    }
    return;
  }
  if (!context.cropRequests.some((request) => request.key === key)) {
    context.cropRequests.push({
      key,
      page: context.page.page,
      pageWidth: context.page.width,
      pageHeight: context.page.height,
      bbox,
    });
  }
}

/** 裁切资产引用：仅当调用方已渲染出该块区域的裁剪图时返回。 */
function cropReference(context: PageContext, aliases: string[]): AssetReference | null {
  const asset = context.cropAssets.get(aliases[0]);
  return asset ? { path: asset.path, sha256: asset.sha256, mime: asset.mime } : null;
}

function fulfillTitle(context: PageContext): void {
  if (!context.state.pendingTitle) return;
  context.builder.addSection(context.state.pendingTitle.title, context.state.pendingTitle.aliases);
  context.state.pendingTitle = null;
}

/** 标题后没有任何内容：降级为段落并记录 warning，不产生空章节。 */
function flushPendingTitleAsText(builder: TreeBuilder, state: ConversionState): void {
  if (!state.pendingTitle) return;
  const { title, aliases } = state.pendingTitle;
  state.pendingTitle = null;
  warn(builder, "pdf-convert-section-empty", aliases[0]);
  const unitId = builder.reserveUnit();
  builder.addUnit("paragraph", textSentences(title, unitId, builder), aliases);
}

function addParagraph(
  context: PageContext,
  text: string,
  aliases: string[],
  kind: UnitKind = "paragraph",
): void {
  if (!text.trim()) return;
  fulfillTitle(context);
  for (const paragraph of text.split(/\n{2,}/)) {
    if (!paragraph.trim()) continue;
    const unitId = context.builder.reserveUnit();
    context.builder.addUnit(kind, textSentences(paragraph, unitId, context.builder), aliases);
  }
}

function figureFromReference(
  vendorPath: string,
  alt: string,
  group: BlockGroup,
  context: PageContext,
  caption: CaptionInput | null,
): FigureBlock {
  const aliases = group.aliases;
  fulfillTitle(context);
  const builder = context.builder;
  const reference = context.page.images[vendorPath];
  const fact = context.page.assets.find((asset) => asset.vendorPath === vendorPath);
  let asset: AssetReference = null;
  if (reference !== undefined && reference !== MISSING_ASSET_PLACEHOLDER && fact) {
    context.referenced.add(fact.path);
    asset = { path: fact.path, sha256: fact.sha256, mime: fact.mime };
  }
  if (asset === null) {
    // 无云端资产：登记原页裁切请求；已渲染裁剪图直接引用（SPEC §6.7）。
    requestCrop(context, aliases, group.blocks[0]?.bbox ?? null);
    asset = cropReference(context, aliases);
  }
  if (asset === null) warn(builder, "pdf-convert-figure-missing", aliases[0]);
  const block = builder.addFigure({
    asset,
    ...(asset === null ? { warning: MESSAGE_KEYS["pdf-convert-figure-missing"] } : {}),
    aliases,
  });
  if (caption) {
    builder.attachCaption(block, caption);
  } else if (alt.trim()) {
    const unitId = builder.reserveUnit();
    builder.attachCaption(block, {
      unitId,
      sentences: textSentences(alt.trim(), unitId, builder),
      aliases,
    });
  }
  return block;
}

/** 文本组：图片引用拆分为 figure 块，其余按段落落树；未知引用逐字保留。 */
function convertTextGroup(
  group: BlockGroup,
  context: PageContext,
  kind: UnitKind = "paragraph",
): void {
  const content = group.content;
  if (!content.trim()) return;
  let cursor = 0;
  for (const match of content.matchAll(IMAGE_REFERENCE)) {
    const before = content.slice(cursor, match.index);
    if (before.trim()) addParagraph(context, before, group.aliases, kind);
    const vendorPath = match[2];
    if (context.page.images[vendorPath] === undefined) {
      warn(context.builder, "pdf-convert-image-unresolved", group.aliases[0]);
      addParagraph(context, match[0], group.aliases, kind);
    } else {
      figureFromReference(vendorPath, match[1], group, context, null);
    }
    cursor = match.index + match[0].length;
  }
  const rest = content.slice(cursor);
  if (rest.trim()) addParagraph(context, rest, group.aliases, kind);
}

function convertVisualGroup(
  group: BlockGroup,
  caption: CaptionInput | null,
  context: PageContext,
): void {
  const builder = context.builder;
  const content = group.content.trim();
  const placeholder = (): FigureBlock => {
    fulfillTitle(context);
    requestCrop(context, group.aliases, group.blocks[0]?.bbox ?? null);
    const crop = cropReference(context, group.aliases);
    if (crop === null) warn(builder, "pdf-convert-figure-missing", group.aliases[0]);
    return builder.addFigure({
      asset: crop,
      ...(crop === null ? { warning: MESSAGE_KEYS["pdf-convert-figure-missing"] } : {}),
      aliases: group.aliases,
    });
  };
  if (!content) {
    const block = placeholder();
    if (caption) builder.attachCaption(block, caption);
    return;
  }
  let cursor = 0;
  let first: FigureBlock | null = null;
  for (const match of content.matchAll(IMAGE_REFERENCE)) {
    const before = content.slice(cursor, match.index);
    if (before.trim()) addParagraph(context, before, group.aliases);
    // 图注必须紧随首个 figure 落树，先于后续文本单元。
    const block = figureFromReference(match[2], match[1], group, context, first ? null : caption);
    first ??= block;
    cursor = match.index + match[0].length;
  }
  const rest = content.slice(cursor);
  if (rest.trim()) addParagraph(context, rest, group.aliases);
  if (!first) {
    // 无可解析引用：保留视觉块事实与可读占位，不猜测资产归属。
    first = placeholder();
    if (caption) builder.attachCaption(first, caption);
  }
}

function convertFormulaGroup(group: BlockGroup, context: PageContext): void {
  const builder = context.builder;
  const content = group.content.trim();
  if (!content) {
    fulfillTitle(context);
    requestCrop(context, group.aliases, group.blocks[0]?.bbox ?? null);
    const crop = cropReference(context, group.aliases);
    if (crop === null) warn(builder, "pdf-convert-formula-empty", group.aliases[0]);
    builder.addFigure({
      asset: crop,
      ...(crop === null ? { warning: MESSAGE_KEYS["pdf-convert-formula-empty"] } : {}),
      aliases: group.aliases,
    });
    return;
  }
  fulfillTitle(context);
  const delimited = /^\s*(?:\$\$([\s\S]*)\$\$|\$([^$]*)\$|\\\[([\s\S]*)\\\]|\\\(([\s\S]*)\\\))\s*$/.exec(content);
  const inner = delimited
    ? (delimited[1] ?? delimited[2] ?? delimited[3] ?? delimited[4] ?? "").trim()
    : "";
  requestCrop(context, group.aliases, group.blocks[0]?.bbox ?? null);
  builder.addFormula(
    inner ? { format: "latex", value: inner } : { format: "text", value: content },
    content,
    group.aliases,
    cropReference(context, group.aliases) ?? undefined,
  );
}

function convertReferenceGroup(group: BlockGroup, context: PageContext): void {
  const content = group.content.trim();
  if (!content) return;
  fulfillTitle(context);
  const entries = content.split(/(?=\[\d+\])/).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries.length ? entries : [content]) {
    const unitId = context.builder.reserveUnit();
    context.builder.addUnit("reference", textSentences(entry, unitId, context.builder), group.aliases);
  }
}

function convertGroup(
  group: BlockGroup,
  caption: CaptionInput | null,
  context: PageContext,
): void {
  const builder = context.builder;
  const label = group.label;
  const content = group.content.trim();
  if (label === "doc_title") {
    if (!content) {
      warn(builder, "pdf-convert-title-empty", group.aliases[0]);
      return;
    }
    if (builder.tree.sections[builder.rootId].title) {
      warn(builder, "pdf-convert-title-duplicate", group.aliases[0]);
      flushPendingTitleAsText(builder, context.state);
      context.state.pendingTitle = { title: content, aliases: group.aliases };
      return;
    }
    builder.setRootTitle(content, group.aliases);
    return;
  }
  if (label === "paragraph_title") {
    if (!content) {
      warn(builder, "pdf-convert-title-empty", group.aliases[0]);
      return;
    }
    if (!context.state.flattened) {
      context.state.flattened = true;
      warn(builder, "pdf-convert-hierarchy-flattened", group.aliases[0]);
    }
    flushPendingTitleAsText(builder, context.state);
    context.state.pendingTitle = { title: content, aliases: group.aliases };
    return;
  }
  if (label === "figure_title") {
    // 预扫描已把紧邻视觉块的图注配对；到这里的是无法配对的图注。
    addParagraph(context, group.content, group.aliases);
    if (content) warn(builder, "pdf-convert-caption-unattached", group.aliases[0]);
    return;
  }
  if (label === "table") {
    fulfillTitle(context);
    convertTable(group.content, group.aliases, caption, {
      builder,
      page: context.page,
      referenced: context.referenced,
      sanitized: false,
      tableImage: false,
    });
    return;
  }
  if (VISUAL_LABELS.has(label)) {
    convertVisualGroup(group, caption, context);
    return;
  }
  if (label === "display_formula") {
    convertFormulaGroup(group, context);
    return;
  }
  if (label === "reference_content") {
    convertReferenceGroup(group, context);
    return;
  }
  if (label === "footnote") {
    convertTextGroup(group, context, "footnote");
    return;
  }
  if (FURNITURE_LABELS.has(label)) {
    if (content) warn(builder, "pdf-convert-furniture", group.aliases[0]);
    convertTextGroup(group, context);
    return;
  }
  if (label === "header_image" || label === "footer_image") {
    convertVisualGroup(group, null, context);
    return;
  }
  if (label !== "text" && label !== "aside_text")
    warn(builder, "pdf-convert-label-downgraded", group.aliases[0]);
  convertTextGroup(group, context);
}

/** 受管解析响应 → 规范文档树（SPEC-pdf-import §6）；纯函数，无网络、无模型。 */
export function convertParseResult(input: ConvertParseInput): ConvertParseResult {
  try {
    const facts = validateFacts(input.facts);
    const pages = parseSanitizedRows(input.resultBytes, facts);
    const builder = new TreeBuilder(input.paperId);
    const state: ConversionState = { pendingTitle: null, flattened: false };
    const cropRequests: PdfCropRequest[] = [];
    const cropAssets = input.cropAssets ?? new Map<string, PdfCropAsset>();
    for (const page of pages) {
      input.signal?.throwIfAborted();
      const context: PageContext = {
        builder,
        page,
        referenced: new Set(),
        state,
        cropRequests,
        cropAssets,
      };
      if (page.blocks.length === 0)
        warn(builder, "pdf-convert-page-empty", `page-${page.page}`);
      if (page.blocks.some((block) => block.order === null))
        warn(builder, "pdf-convert-order-degraded", `page-${page.page}`);
      const groups = groupBlocks(page);
      // 预扫描：figure_title 紧邻前面的 figure/table 组时配对为图注（vendor 排版约定）。
      const captions = new Map<number, number>();
      const claimed = new Set<number>();
      for (const [index, group] of groups.entries()) {
        if (group.label !== "figure_title" || index === 0) continue;
        const previous = groups[index - 1];
        if (
          (VISUAL_LABELS.has(previous.label) || previous.label === "table") &&
          !claimed.has(index - 1)
        ) {
          captions.set(index, index - 1);
          claimed.add(index - 1);
        }
      }
      const captionByTarget = new Map<number, CaptionInput>();
      for (const [captionIndex, targetIndex] of captions) {
        const captionGroup = groups[captionIndex];
        const unitId = builder.reserveUnit();
        captionByTarget.set(targetIndex, {
          unitId,
          sentences: textSentences(captionGroup.content.trim() || " ", unitId, builder),
          aliases: captionGroup.aliases,
        });
      }
      for (const [index, group] of groups.entries()) {
        input.signal?.throwIfAborted();
        if (captions.has(index)) continue;
        convertGroup(group, captionByTarget.get(index) ?? null, context);
      }
      for (const asset of page.assets) {
        if (!context.referenced.has(asset.path))
          warn(builder, "pdf-convert-asset-unreferenced", `page-${page.page}/${asset.vendorPath}`);
      }
    }
    flushPendingTitleAsText(builder, state);
    if (builder.readableUnits === 0) fatal("pdf-convert-body-empty");
    try {
      parseDocumentTree(builder.tree, input.paperId);
    } catch (error) {
      // 结构诊断消息只含节点身份与结构描述，不含正文或来源秘密。
      return {
        ok: false,
        diagnostic: {
          code: "pdf-convert-tree-invalid",
          severity: "fatal",
          stage: "validate",
          messageKey: `pdf.convert.treeInvalid:${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    return { ok: true, tree: builder.tree, warnings: builder.warnings, cropRequests };
  } catch (error) {
    if (input.signal?.aborted)
      return { ok: false, diagnostic: diagnostic("pdf-convert-stopped", "fatal", "convert") };
    if (error instanceof ConvertFatalError)
      return { ok: false, diagnostic: diagnostic(error.code, "fatal", error.stage) };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 首次发布与恢复
// ---------------------------------------------------------------------------

interface PdfParseRevisionMetadata {
  converterVersion: number;
  warnings: ImportDiagnostic[];
}

function readPdfParseMetadata(revision: ProjectRevisionRecord): PdfParseRevisionMetadata {
  const value = revision.pdfParse;
  const record: Record<string, unknown> = value !== null && typeof value === "object"
    ? { ...(value as Record<string, unknown>) } : {};
  if (
    typeof record.converterVersion !== "number" ||
    !Number.isInteger(record.converterVersion) ||
    record.converterVersion < 1
  )
    throw new ConvertMetadataError("pdf-convert-version-missing", MESSAGE_KEYS["pdf-convert-version-missing"]);
  let warnings: ImportDiagnostic[];
  try {
    warnings = readDiagnosticArray(record.warnings);
  } catch (error) {
    throw new ConvertMetadataError(
      "pdf-convert-record-corrupt",
      `${MESSAGE_KEYS["pdf-convert-record-corrupt"]}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { converterVersion: record.converterVersion, warnings };
}

/** 转换解析快照并首次发布 current（SPEC §7）：全部页面转换与全量验证通过后才提交。
 * 任务记录由调用方拥有；本模块不写 task.json，也不发起任何网络访问。 */
export async function publishParseDocument(
  input: PublishParseDocumentInput,
): Promise<PublishParseDocumentResult> {
  const { task, snapshot } = input;
  if (task.phase !== "downloaded" && task.phase !== "converting")
    throw new Error("只有已下载或转换中的 PDF 解析任务可以发布文档。");
  if (task.parseSourceSnapshotId !== snapshot.sourceSnapshotId)
    throw new Error("任务未关联该解析快照，不能发布文档。");
  try {
    const opened = await openProject(input.root);
    const current = opened.manifest.paper.currentRevision;
    if (current !== null) {
      // current 已推进但任务记录未落盘：幂等补齐，不重新转换。
      if (current === task.candidateRevisionId) {
        const revision = await readRevision(input.root, current);
        if (revision.sourceSnapshotId !== snapshot.sourceSnapshotId)
          fatal("pdf-convert-snapshot-invalid");
        const metadata = readPdfParseMetadata(revision);
        return { ok: true, revision, ...metadata };
      }
      fatal("pdf-convert-current-exists");
    }
    let revisionId = task.candidateRevisionId;
    if (revisionId !== undefined) {
      let state: "published" | "residual" | "absent";
      try {
        state = await inspectImportCandidate(input.root, revisionId);
      } catch {
        fatal("pdf-convert-candidate-inspect-failed");
      }
      if (state === "published") {
        const validated: { value: PdfParseRevisionMetadata | null } = { value: null };
        const validateMetadata = (revision: ProjectRevisionRecord): void => {
          validated.value = readPdfParseMetadata(revision);
        };
        try {
          const revision = await completePublishedRevision(
            input.root, revisionId, input.hooks?.commitHooks ?? {}, validateMetadata,
          );
          if (validated.value === null)
            fatal("pdf-convert-version-missing");
          return { ok: true, revision, ...validated.value };
        } catch (error) {
          if (error instanceof ConvertMetadataError) throw error;
          if (error instanceof ConvertFatalError) throw error;
          fatal("pdf-convert-publish-failed", "publish");
        }
      }
      // residual 已被清理；absent 无现场：按同一候选身份重新转换发布。
    } else {
      revisionId = randomUUID();
    }
    const converted = await convertSnapshotTree({
      root: input.root,
      task,
      snapshot,
      paperId: opened.manifest.paper.id,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!converted.ok) return converted;
    try {
      await input.hooks?.onConvertPoint?.("candidate-built");
    } catch {
      fatal("pdf-convert-interrupted");
    }
    try {
      await input.onCandidateBuilt?.({ revisionId });
    } catch {
      fatal("pdf-convert-progress-failed");
    }
    const documentJson = Buffer.from(JSON.stringify(converted.tree));
    // 确定性 changeset：同一候选重试必须产生逐字节一致的内容。
    const changeset = createDocumentChangeset({
      base: null,
      current: converted.tree,
      baseRevision: null,
      revisionId,
    });
    const files: Record<string, ManagedFileContent> = {
      "document.json": documentJson,
      "source-base.json": documentJson,
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify(changeset)),
    };
    for (const block of converted.tree.blocks) {
      if ((block.kind !== "figure" && block.kind !== "formula") || !block.asset) continue;
      const crop = converted.cropAssets?.get(block.asset.path);
      if (crop) {
        // 派生裁剪资产进入候选 revision，不回写原始 PDF 或解析快照（SPEC §4.6）。
        files[block.asset.path] = { bytes: crop.bytes, mime: block.asset.mime };
      } else {
        files[block.asset.path] = {
          bytes: await readSnapshotFile(input.root, snapshot, block.asset.path),
          mime: block.asset.mime,
        };
      }
    }
    try {
      await input.hooks?.onConvertPoint?.("before-publish");
    } catch {
      fatal("pdf-convert-interrupted");
    }
    input.signal?.throwIfAborted();
    let revision: ProjectRevisionRecord;
    try {
      revision = await commitRevision(
        {
          root: input.root,
          sourceSnapshotId: snapshot.sourceSnapshotId,
          baseRevision: null,
          revisionId,
          files,
          metadata: {
            pdfParse: {
              converterVersion: PDF_CONVERTER_VERSION,
              warnings: converted.warnings,
            },
          },
        },
        input.hooks?.commitHooks,
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      fatal("pdf-convert-publish-failed", "publish");
    }
    return {
      ok: true,
      revision,
      warnings: converted.warnings,
      converterVersion: PDF_CONVERTER_VERSION,
    };
  } catch (error) {
    if (input.signal?.aborted)
      return { ok: false, diagnostic: diagnostic("pdf-convert-stopped", "fatal", "convert") };
    if (error instanceof ConvertFatalError)
      return { ok: false, diagnostic: diagnostic(error.code, "fatal", error.stage) };
    if (error instanceof ConvertMetadataError)
      return {
        ok: false,
        diagnostic: { code: error.code, severity: "fatal", stage: "convert", messageKey: error.messageKey },
      };
    throw error;
  }
}

/** 校验解析快照谱系与摘要后读取受管内容并确定性转换（SPEC §6）。
 * 不读写任务记录、不访问网络；首次发布与重转换候选共用同一转换口径。 */
async function convertSnapshotTree(input: {
  root: string;
  task: PdfParseTaskRecord;
  snapshot: PdfParseSourceSnapshotRecord;
  paperId: string;
  signal?: AbortSignal;
}): Promise<ConvertParseResult> {
  const { task, snapshot } = input;
  const resultFile = snapshot.files.find((file) => file.path === "result.jsonl");
  if (
    snapshot.kind !== "pdf-parse" ||
    snapshot.parentSourceSnapshotId !== task.parentSourceSnapshotId ||
    snapshot.parseBatchId !== task.parseBatchId ||
    snapshot.provider !== task.provider ||
    snapshot.model !== task.model ||
    snapshot.jobId !== task.jobId ||
    snapshot.responseSha256 !== task.responseSha256 ||
    snapshot.sanitizedSha256 !== task.sanitizedSha256 ||
    resultFile?.sha256 !== snapshot.sanitizedSha256
  )
    fatal("pdf-convert-snapshot-invalid");
  const resultBytes = await readSnapshotFile(input.root, snapshot, "result.jsonl");
  const factsBytes = await readSnapshotFile(input.root, snapshot, "facts.json");
  let facts: PdfParseFactsFile;
  try {
    facts = JSON.parse(factsBytes.toString("utf8")) as PdfParseFactsFile;
  } catch {
    fatal("pdf-convert-snapshot-invalid");
  }
  input.signal?.throwIfAborted();
  const convertInput = {
    paperId: input.paperId,
    resultBytes,
    facts,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  // 第一遍纯转换收集裁切请求；有请求才读父 PDF 渲染，第二遍带资产重转换。
  const first = convertParseResult(convertInput);
  if (!first.ok || !first.cropRequests.length) return first;
  const pdf = await loadParentPdf(input.root, task);
  const cropped = await cropPdfPageRegions({
    pdf,
    requests: first.cropRequests,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const cropAssets = new Map(cropped.assets.map((asset) => [asset.key, asset]));
  const second = convertParseResult({ ...convertInput, cropAssets });
  if (!second.ok) return second;
  return {
    ok: true,
    tree: second.tree,
    warnings: [...second.warnings, ...cropped.warnings],
    cropRequests: [],
    cropAssets: new Map(cropped.assets.map((asset) => [asset.path, asset])),
  };
}

/** 读取父 PDF 快照字节并核验摘要；缺失或摘要不符立即拒绝，不重猜来源。 */
async function loadParentPdf(root: string, task: PdfParseTaskRecord): Promise<Buffer> {
  const source = await readSourceSnapshot(root, task.parentSourceSnapshotId);
  if (source.kind !== "pdf" || source.sha256 !== task.pdfSha256)
    fatal("pdf-convert-snapshot-invalid");
  const file = source.files.find((entry) => entry.path === "paper.pdf");
  if (!file || file.sha256 !== source.sha256) fatal("pdf-convert-snapshot-invalid");
  const bytes = await fs.readFile(path.join(root, source.path, "paper.pdf"));
  if (bytes.byteLength !== file.size || hash(bytes) !== source.sha256)
    fatal("pdf-convert-snapshot-digest");
  return bytes;
}

/** 按登记摘要读取受管快照文件；缺失或摘要不符立即拒绝，不采用另一份字节。 */
async function readSnapshotFile(
  root: string,
  snapshot: PdfParseSourceSnapshotRecord,
  relative: string,
): Promise<Buffer> {
  const record = snapshot.files.find((file) => file.path === relative);
  if (!record) fatal("pdf-convert-snapshot-invalid");
  const bytes = await fs.readFile(path.join(root, snapshot.path, relative));
  if (bytes.byteLength !== record.size || hash(bytes) !== record.sha256)
    fatal("pdf-convert-snapshot-digest");
  return bytes;
}

/** 重解析／重转换的合并候选与转换警告；候选未发布，current 保持不变。 */
export interface ParseMergeConversion {
  candidate: DocumentMergeCandidate;
  warnings: ImportDiagnostic[];
}

/** 重解析／离线重新转换候选（SPEC §8.3–§8.4）：解析快照重新转换后与旧
 * source-base、current 做三方合并；本地修正与冲突由 document-core 决定，不由转换器覆盖。
 * 不访问云端、不写任务记录；发布前 baseRevision 复核由合并发布负责。 */
export async function createParseMergeCandidate(input: {
  root: string;
  task: PdfParseTaskRecord;
  snapshot: PdfParseSourceSnapshotRecord;
  baseRevision: string;
  /** 恢复沿用同一候选身份；缺省由调用方固定或新分配，重转换不重排 revision。 */
  revisionId?: string;
  signal?: AbortSignal;
}): Promise<ParseMergeConversion> {
  const opened = await openProject(input.root);
  const current = opened.manifest.paper.currentRevision;
  if (current === null)
    throw new Error("首次正文尚未发布，不能形成重解析合并候选。");
  if (current !== input.baseRevision)
    throw new Error(`baseRevision 已变化：候选基线为 ${input.baseRevision}，current 为 ${current}。`);
  let converted: ConvertParseResult;
  try {
    converted = await convertSnapshotTree({
      root: opened.root,
      task: input.task,
      snapshot: input.snapshot,
      paperId: opened.manifest.paper.id,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof ConvertFatalError)
      throw new Error(MESSAGE_KEYS[error.code] ?? error.code);
    throw error;
  }
  if (!converted.ok) throw new Error(converted.diagnostic.messageKey);
  const candidate = await createDocumentMergeCandidate({
    root: opened.root,
    baseRevision: input.baseRevision,
    sourceSnapshotId: input.snapshot.sourceSnapshotId,
    candidate: converted.tree,
    ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
    ...(converted.cropAssets === undefined ? {} : {
      derivedAssets: Object.fromEntries([...converted.cropAssets].map(([relative, asset]) =>
        [relative, { bytes: asset.bytes, mime: asset.mime }])),
    }),
  });
  return {
    candidate: {
      ...candidate,
      metadata: {
        pdfParse: { converterVersion: PDF_CONVERTER_VERSION, warnings: converted.warnings },
      },
    },
    warnings: converted.warnings,
  };
}