import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { ImportDiagnostic } from "../../shared/arxiv.js";
import { readDiagnosticArray } from "../../shared/arxiv.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import { parseDocumentTree } from "../../shared/document/tree.js";
import { createDocumentChangeset } from "../../shared/document/changeset.js";
import {
  commitRevision,
  completePublishedRevision,
  openProject,
  readSourceSnapshot,
  type ProjectCommitHooks,
} from "../project-core.js";
import type { ArxivAssetMapping, ArxivSourceMetadata } from "./fetch.js";
import type {
  ManagedFileContent,
  ProjectRevisionRecord,
  SourceSnapshotRecord,
} from "../../shared/contracts.js";

/** 转换器持久版本：算法变化必须递增（SPEC §4.11 确定性契约）。 */
const ARXIV_CONVERTER_VERSION = 1;

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

type UnitKind = DocumentTree["units"][string]["kind"];
type AtomInput = AtomValue extends infer T
  ? T extends AtomValue ? Omit<T, "id" | "unitId"> : never
  : never;

interface UnitInput {
  kind: UnitKind;
  aliases?: string[];
}

interface PendingRef {
  atomId: string;
  kind: "cross-reference" | "citation" | "footnote-reference";
  target: string;
}

interface PendingTarget {
  target: string;
  unitId: string;
}

export interface ConvertLatexmlInput {
  html: Uint8Array;
  paperId: string;
  /** 实际固定版本 HTML URL；资产 src 相对它解析。 */
  htmlUrl: string;
  /** 快照资产映射，键为快照内相对路径。 */
  assets: Record<string, ArxivAssetMapping>;
  /** 快照资产原始字节，键与 assets 一致；用于摘要核验。 */
  assetBytes: Record<string, Uint8Array>;
}

export type ConvertLatexmlResult =
  | {
      ok: true;
      tree: DocumentTree;
      warnings: ImportDiagnostic[];
      converterVersion: number;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

export type ArxivConvertPoint = "candidate-built" | "before-publish";

export interface ConvertArxivSnapshotInput {
  root: string;
  sourceSnapshotId: string;
  /** 恢复已构建候选：沿用中断前持久化的 revisionId，不新建身份。 */
  revisionId?: string;
  /** 候选 revision 已完整落盘（仅 current 未推进）：核验后只推进指针，不重新转换。 */
  completePublished?: boolean;
  /** 候选构建后、提交前回调：组合入口借此把 revisionId 与警告持久化到恢复记录，
   * 使 current 推进中断后的恢复沿用同一候选，而不是重新转换新建 revision。 */
  onCandidateBuilt?: (candidate: { revisionId: string; warnings: ImportDiagnostic[] }) => Promise<void>;
  /** 转换阶段故障注入：候选构建后、提交发布前；生产路径不注入。 */
  hooks?: {
    onConvertPoint?: (point: ArxivConvertPoint) => void | Promise<void>;
    commitHooks?: ProjectCommitHooks;
  };
  /** 转换器升级注入（SPEC §6 恢复）：默认当前 convertLatexml；
   * 测试模拟未来转换器修复同一快照，生产路径不注入。 */
  converter?: typeof convertLatexml;
}

export type ConvertArxivSnapshotResult =
  | {
      ok: true;
      revision: ProjectRevisionRecord;
      warnings: ImportDiagnostic[];
      converterVersion: number;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

function fatal(
  code: string,
  messageKey: string,
  stage: ImportDiagnostic["stage"],
  sourceAlias?: string,
): { ok: false; diagnostic: ImportDiagnostic } {
  return {
    ok: false,
    diagnostic: {
      code,
      severity: "fatal",
      stage,
      messageKey,
      ...(sourceAlias === undefined ? {} : { sourceAlias }),
    },
  };
}

function warning(
  code: string,
  messageKey: string,
  sourceAlias?: string,
): ImportDiagnostic {
  return {
    code,
    severity: "warning",
    stage: "convert",
    messageKey,
    ...(sourceAlias === undefined ? {} : { sourceAlias }),
  };
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isParent(node: Node): node is ParentNode {
  return "childNodes" in node;
}

function classes(element: Element): string[] {
  const value = element.attrs.find((attr) => attr.name === "class")?.value ?? "";
  return value.split(/\s+/).filter(Boolean);
}

function hasClass(element: Element, name: string): boolean {
  return classes(element).includes(name);
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (!isParent(node)) return "";
  return node.childNodes.map(textOf).join("");
}

/** 折叠空白后的可见文本；用于覆盖判断与文本投影。 */
function visibleText(node: Node): string {
  return textOf(node).replace(/\s+/g, " ").trim();
}

function findClass(root: Node, name: string): Element | null {
  if (isElement(root) && hasClass(root, name)) return root;
  if (!isParent(root)) return null;
  for (const child of root.childNodes) {
    const found = findClass(child, name);
    if (found) return found;
  }
  return null;
}

function collectIds(root: Node, ids: Set<string>): void {
  if (isElement(root)) {
    const id = attr(root, "id");
    if (id) ids.add(id);
  }
  if (isParent(root)) for (const child of root.childNodes) collectIds(child, ids);
}

const MATHML_TEXT_TAGS = new Set(["mi", "mn", "mo", "mtext"]);

function mathmlText(math: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (isElement(node)) {
      if (node.tagName === "annotation" || node.tagName === "annotation-xml") return;
      if (MATHML_TEXT_TAGS.has(node.tagName)) {
        const text = visibleText(node);
        if (text) parts.push(text);
        return;
      }
    }
    if (isParent(node)) for (const child of node.childNodes) walk(child);
  };
  walk(math);
  return parts.join(" ");
}

interface MathRepresentation {
  text: string;
  source: { format: "latex" | "mathml" | "text"; value: string };
}

/** 行内/独立公式表示：alttext/TeX annotation 优先，其次 MathML 文本投影。 */
function mathRepresentation(math: Element): MathRepresentation | null {
  const alttext = attr(math, "alttext")?.trim();
  if (alttext) return { text: alttext, source: { format: "latex", value: alttext } };
  const annotation = findClass(math, "ltx_annotation");
  if (annotation) {
    const tex = visibleText(annotation);
    if (tex) return { text: tex, source: { format: "latex", value: tex } };
  }
  let texAnnotation: string | null = null;
  const walk = (node: Node): void => {
    if (texAnnotation !== null) return;
    if (isElement(node) && node.tagName === "annotation") {
      const encoding = attr(node, "encoding") ?? "";
      if (encoding.includes("tex")) {
        const tex = visibleText(node);
        if (tex) texAnnotation = tex;
      }
    }
    if (isParent(node)) for (const child of node.childNodes) walk(child);
  };
  walk(math);
  if (texAnnotation !== null) {
    const tex: string = texAnnotation;
    return { text: tex, source: { format: "latex", value: tex } };
  }
  const projection = mathmlText(math);
  if (projection) {
    return { text: projection, source: { format: "text", value: projection } };
  }
  return null;
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

const RAW_HTML_TAGS = new Set([
  "blockquote", "br", "code", "em", "li", "ol", "p", "pre", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 白名单投影：保留允许标签的结构，剥离属性与不支持元素，文本转义。 */
function projectRawHtml(node: Node): string {
  if (node.nodeName === "#text")
    return escapeHtml((node as DefaultTreeAdapterMap["textNode"]).value);
  if (!isElement(node)) return isParent(node) ? node.childNodes.map(projectRawHtml).join("") : "";
  if (!RAW_HTML_TAGS.has(node.tagName)) {
    return isParent(node) ? node.childNodes.map(projectRawHtml).join("") : "";
  }
  const inner = node.childNodes.map(projectRawHtml).join("");
  if (node.tagName === "br") return "<br>";
  return `<${node.tagName}>${inner}</${node.tagName}>`;
}

function aliasesOf(element: Element): string[] | undefined {
  const id = attr(element, "id");
  return id ? [id] : undefined;
}

class TreeBuilder {
  readonly tree: DocumentTree;
  readonly warnings: ImportDiagnostic[] = [];
  readonly pendingRefs: PendingRef[] = [];
  readonly aliases = new Map<string, PendingTarget>();
  private readonly sectionStack: string[] = [];
  private readonly deferred: DeferredUnit[] = [];
  private mathTotal = 0;
  private mathFailed = 0;
  private figureTotal = 0;
  private figureMissing = 0;
  private bodySectionCreated = false;

  constructor(paperId: string) {
    const rootId = randomUUID();
    this.tree = {
      documentFormatVersion: 1,
      paperId,
      sections: {
        [rootId]: {
          id: rootId,
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
    this.sectionStack.push(rootId);
  }

  get currentSection(): string {
    return this.sectionStack[this.sectionStack.length - 1];
  }

  pushSection(title: string, aliases?: string[]): string {
    const id = randomUUID();
    const parent = this.currentSection;
    this.tree.sections[id] = {
      id,
      parentSectionId: parent,
      title,
      childSectionIds: [],
      unitIds: [],
      ...(aliases ? { sourceAliases: aliases } : {}),
    };
    this.tree.sections[parent].childSectionIds.push(id);
    this.sectionStack.push(id);
    this.bodySectionCreated = true;
    return id;
  }

  popSection(): void {
    this.sectionStack.pop();
  }

  hasBodySections(): boolean {
    return this.bodySectionCreated;
  }

  registerAlias(target: string, unitId: string): void {
    if (!this.aliases.has(target)) this.aliases.set(target, { target, unitId });
  }

  /** 预分配单元 ID：行内原子先于单元落树，unitId 在 flush 时回填。 */
  reserveUnit(): string {
    return randomUUID();
  }

  /** 直属单元：立即按阅读顺序落树并占用一个 unit block。 */
  addUnit(input: UnitInput, sentences: Array<Array<InlinePart>>): string {
    return this.addUnitWithId(this.reserveUnit(), input, sentences);
  }

  /** 以预分配 ID 落树直属单元；行内原子已携带该 unitId。 */
  addUnitWithId(unitId: string, input: UnitInput, sentences: Array<Array<InlinePart>>): string {
    this.flushUnit(unitId, input, sentences, this.currentSection, {
      id: randomUUID(),
      sectionId: this.currentSection,
      kind: "unit",
      unitId,
      ...(input.aliases ? { sourceAliases: input.aliases } : {}),
    });
    return unitId;
  }

  /** 延迟单元（caption/表格单元）：先占位，等所属块确定后按块顺序落树。 */
  deferUnit(unitId: string, input: UnitInput, sentences: Array<Array<InlinePart>>): void {
    this.deferred.push({ unitId, input, sentences, sectionId: this.currentSection });
  }

  /** 按给定块落树延迟单元；块顺序即单元阅读顺序。 */
  flushUnit(
    unitId: string,
    input: UnitInput,
    sentences: Array<Array<InlinePart>>,
    sectionId: string,
    block: DocumentTree["blocks"][number] | null,
  ): void {
    const sentenceIds: string[] = [];
    for (const parts of sentences) {
      const merged = mergeTextParts(parts);
      if (!merged.length) continue;
      const sentenceId = randomUUID();
      this.tree.sentences[sentenceId] = { id: sentenceId, unitId, content: merged };
      sentenceIds.push(sentenceId);
      for (const part of merged) {
        if (part.kind === "atom") this.tree.atoms[part.atomId].unitId = unitId;
      }
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
      kind: input.kind,
      sentenceIds,
      ...(input.aliases ? { sourceAliases: input.aliases } : {}),
    };
    this.tree.sections[sectionId].unitIds.push(unitId);
    if (block) this.tree.blocks.push(block);
    for (const alias of input.aliases ?? []) this.registerAlias(alias, unitId);
  }

  /** 取出延迟单元定义；不存在时抛错（调用方必须成对使用 defer/flush）。 */
  takeDeferred(unitId: string): DeferredUnit {
    const index = this.deferred.findIndex((entry) => entry.unitId === unitId);
    if (index < 0) throw new Error(`延迟单元未登记：${unitId}`);
    return this.deferred.splice(index, 1)[0];
  }

  addAtom(unitId: string, atom: AtomInput): string {
    const atomId = randomUUID();
    (this.tree.atoms as Record<string, unknown>)[atomId] = { id: atomId, unitId, ...atom };
    return atomId;
  }

  noteMath(ok: boolean): void {
    this.mathTotal += 1;
    if (!ok) this.mathFailed += 1;
  }

  noteFigure(missing: boolean): void {
    this.figureTotal += 1;
    if (missing) this.figureMissing += 1;
  }

  systematicFailure(): { code: string; messageKey: string } | null {
    if (this.mathTotal > 0 && this.mathFailed === this.mathTotal)
      return { code: "arxiv-convert-math-systemic", messageKey: "arxiv.convert.mathSystemic" };
    if (this.figureTotal > 0 && this.figureMissing === this.figureTotal)
      return { code: "arxiv-convert-figure-systemic", messageKey: "arxiv.convert.figureSystemic" };
    return null;
  }
}

interface DeferredUnit {
  unitId: string;
  input: UnitInput;
  sentences: Array<Array<InlinePart>>;
  sectionId: string;
}

type InlinePart = DocumentTree["sentences"][string]["content"][number];
type AtomValue = DocumentTree["atoms"][string];

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
      const match = /[.!?](?=\s|$)/.exec(rest);
      if (!match) {
        if (rest) current.push({ kind: "text", text: rest });
        break;
      }
      const end = match.index + 1;
      current.push({ kind: "text", text: rest.slice(0, end) });
      flush();
      rest = rest.slice(end).replace(/^\s+/, "");
    }
  }
  flush();
  return sentences;
}

export function convertLatexml(input: ConvertLatexmlInput): ConvertLatexmlResult {
  let document: DefaultTreeAdapterMap["document"];
  try {
    document = parse(new TextDecoder("utf-8", { fatal: true }).decode(input.html));
  } catch {
    return fatal("arxiv-convert-html-invalid", "arxiv.convert.htmlInvalid", "convert");
  }
  const article = findClass(document, "ltx_document");
  if (!article)
    return fatal("arxiv-convert-container-missing", "arxiv.convert.containerMissing", "convert");

  const sourceIds = new Set<string>();
  collectIds(article, sourceIds);

  const builder = new TreeBuilder(input.paperId);
  const assetBySource = new Map<string, ArxivAssetMapping>();
  for (const mapping of Object.values(input.assets)) assetBySource.set(mapping.originalUrl, mapping);

  const context: WalkContext = {
    builder,
    input,
    assetBySource,
    sourceIds,
  };

  try {
    walkChildren(article, context);
  } catch (error) {
    if (error instanceof CoverageError)
      return fatal(error.code, error.messageKey, "convert", error.sourceAlias);
    throw error;
  }

  if (!builder.hasBodySections())
    return fatal("arxiv-convert-body-missing", "arxiv.convert.bodyMissing", "convert");

  resolveReferences(builder, sourceIds);

  const systematic = builder.systematicFailure();
  if (systematic)
    return fatal(systematic.code, systematic.messageKey, "convert");

  if (!builder.tree.blocks.length)
    return fatal("arxiv-convert-empty", "arxiv.convert.empty", "convert");

  try {
    parseDocumentTree(builder.tree, input.paperId);
  } catch (error) {
    return fatal(
      "arxiv-convert-tree-invalid",
      `arxiv.convert.treeInvalid:${error instanceof Error ? error.message : String(error)}`,
      "validate",
    );
  }
  return {
    ok: true,
    tree: builder.tree,
    warnings: builder.warnings,
    converterVersion: ARXIV_CONVERTER_VERSION,
  };
}

class CoverageError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
    readonly sourceAlias?: string,
  ) {
    super(messageKey);
  }
}

/** 元数据校验专用错误：按类型分类诊断，不与无关提交故障的消息文本混淆。 */
class ArxivMetadataError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
  ) {
    super(messageKey);
  }
}

interface WalkContext {
  builder: TreeBuilder;
  input: ConvertLatexmlInput;
  assetBySource: Map<string, ArxivAssetMapping>;
  sourceIds: Set<string>;
}

const IGNORED_TAGS = new Set(["script", "style", "meta", "link", "head", "noscript", "template"]);

function walkChildren(parent: ParentNode, context: WalkContext): void {
  for (const child of parent.childNodes) walkNode(child, context);
}

function walkNode(node: Node, context: WalkContext): void {
  if (node.nodeName === "#text") {
    const text = (node as DefaultTreeAdapterMap["textNode"]).value;
    if (text.trim()) emitLooseText(text, context);
    return;
  }
  if (!isElement(node)) {
    if (isParent(node)) walkChildren(node, context);
    return;
  }
  const element = node;
  if (IGNORED_TAGS.has(element.tagName)) return;

  if (hasClass(element, "ltx_title_document") || hasClass(element, "ltx_authors") ||
      hasClass(element, "ltx_dates") || hasClass(element, "ltx_creator")) return;

  if (hasClass(element, "ltx_abstract")) {
    walkAbstract(element, context);
    return;
  }
  if (hasClass(element, "ltx_bibliography")) {
    walkBibliography(element, context);
    return;
  }
  if (hasClass(element, "ltx_section") || hasClass(element, "ltx_subsection") ||
      hasClass(element, "ltx_subsubsection") || hasClass(element, "ltx_appendix") ||
      hasClass(element, "ltx_chapter") || hasClass(element, "ltx_part")) {
    walkSection(element, context);
    return;
  }
  if (hasClass(element, "ltx_para")) {
    walkChildren(element, context);
    return;
  }
  if (hasClass(element, "ltx_p")) {
    emitParagraph(element, context, "paragraph");
    return;
  }
  if (hasClass(element, "ltx_item")) {
    walkListItem(element, context);
    return;
  }
  if (hasClass(element, "ltx_figure") || hasClass(element, "ltx_subfigure")) {
    walkFigure(element, context);
    return;
  }
  if (hasClass(element, "ltx_table")) {
    walkTableFigure(element, context);
    return;
  }
  if (hasClass(element, "ltx_equation") || hasClass(element, "ltx_eqn_table") ||
      hasClass(element, "ltx_equationgroup")) {
    walkEquation(element, context);
    return;
  }
  if (hasClass(element, "ltx_theorem")) {
    walkTheorem(element, context);
    return;
  }
  if (element.tagName === "math") {
    emitBlockMath(element, context);
    return;
  }
  if (element.tagName === "figure") {
    walkFigure(element, context);
    return;
  }
  if (element.tagName === "table") {
    walkTableFigure(element, context);
    return;
  }
  if (element.tagName === "ul" || element.tagName === "ol") {
    walkChildren(element, context);
    return;
  }
  if (element.tagName === "section") {
    walkSection(element, context);
    return;
  }
  // 无 ltx_p 类的裸段落（真实 LaTeXML 偶有输出）：按正文段落转换，不落入 raw 降级。
  if (element.tagName === "p") {
    emitParagraph(element, context, "paragraph");
    return;
  }

  // 未识别的可见内容：结构化降级为带文本投影的 raw block，绝不静默丢弃。
  const text = visibleText(element);
  if (!text) {
    if (isParent(element)) walkChildren(element, context);
    return;
  }
  emitRawBlock(element, context, ["arxiv.convert.unstructured"]);
}

function emitLooseText(text: string, context: WalkContext): void {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return;
  context.builder.addUnit({ kind: "paragraph" }, [[{ kind: "text", text: trimmed }]]);
}

function sectionTitle(section: Element): string {
  for (const child of section.childNodes) {
    if (isElement(child) && hasClass(child, "ltx_title")) {
      const clone = visibleText(child);
      // 去掉编号 tag（"1 "、"A.1 "、"Appendix A "）。
      const tag = findClass(child, "ltx_tag");
      if (tag) {
        const tagText = visibleText(tag);
        if (tagText && clone.startsWith(tagText)) return clone.slice(tagText.length).trim();
      }
      return clone;
    }
  }
  return "";
}

function walkSection(section: Element, context: WalkContext): void {
  const title = sectionTitle(section);
  context.builder.pushSection(title, aliasesOf(section));
  for (const child of section.childNodes) {
    if (isElement(child) && hasClass(child, "ltx_title")) continue;
    walkNode(child, context);
  }
  context.builder.popSection();
}

function walkAbstract(abstract: Element, context: WalkContext): void {
  for (const child of abstract.childNodes) {
    if (isElement(child) && hasClass(child, "ltx_title")) continue;
    if (isElement(child) && hasClass(child, "ltx_p")) {
      emitParagraph(child, context, "abstract");
    } else {
      walkNode(child, context);
    }
  }
  context.builder.registerAlias(attr(abstract, "id") ?? "abstract",
    Object.values(context.builder.tree.units).find((unit) => unit.kind === "abstract")?.id ?? "");
}

function walkBibliography(bibliography: Element, context: WalkContext): void {
  context.builder.pushSection("References", aliasesOf(bibliography));
  const walk = (node: Node): void => {
    if (isElement(node) && hasClass(node, "ltx_bibitem")) {
      const unitId = context.builder.reserveUnit();
      const parts = inlineParts(node, context, unitId);
      context.builder.addUnitWithId(unitId, { kind: "reference", aliases: aliasesOf(node) }, splitSentences(parts));
      return;
    }
    if (isElement(node) && hasClass(node, "ltx_title")) return;
    if (isParent(node)) for (const child of node.childNodes) walk(child);
  };
  walk(bibliography);
  context.builder.popSection();
}

function walkListItem(item: Element, context: WalkContext): void {
  const paragraphs: Element[] = [];
  const collect = (node: Node): void => {
    if (isElement(node) && hasClass(node, "ltx_p")) {
      paragraphs.push(node);
      return;
    }
    if (isElement(node) && (hasClass(node, "ltx_itemize") || hasClass(node, "ltx_enumerate"))) return;
    if (isParent(node)) for (const child of node.childNodes) collect(child);
  };
  collect(item);
  const unitId = context.builder.reserveUnit();
  if (paragraphs.length) {
    const parts: InlinePart[] = [];
    for (const paragraph of paragraphs) {
      if (parts.length) parts.push({ kind: "text", text: " " });
      parts.push(...inlineParts(paragraph, context, unitId));
    }
    context.builder.addUnitWithId(unitId, { kind: "list-item", aliases: aliasesOf(item) }, splitSentences(parts));
  } else {
    const parts = inlineParts(item, context, unitId);
    context.builder.addUnitWithId(unitId, { kind: "list-item", aliases: aliasesOf(item) }, splitSentences(parts));
  }
  // 嵌套列表单独遍历。
  for (const child of item.childNodes) {
    if (isElement(child) && (hasClass(child, "ltx_itemize") || hasClass(child, "ltx_enumerate")))
      walkChildren(child, context);
  }
}

function walkTheorem(theorem: Element, context: WalkContext): void {
  const title = findClass(theorem, "ltx_title");
  if (title) {
    const text = visibleText(title);
    if (text) context.builder.addUnit({ kind: "paragraph" }, [[{ kind: "text", text }]]);
  }
  for (const child of theorem.childNodes) {
    if (isElement(child) && hasClass(child, "ltx_title")) continue;
    walkNode(child, context);
  }
}

function emitParagraph(paragraph: Element, context: WalkContext, kind: "paragraph" | "abstract"): void {
  const unitId = context.builder.reserveUnit();
  const parts = inlineParts(paragraph, context, unitId);
  context.builder.addUnitWithId(unitId, { kind, aliases: aliasesOf(paragraph) }, splitSentences(parts));
}

/** 行内内容遍历：文本、公式、引用、脚注、链接与未知行内元素。 */
function inlineParts(node: Node, context: WalkContext, unitId: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const walk = (current: Node): void => {
    if (current.nodeName === "#text") {
      const text = (current as DefaultTreeAdapterMap["textNode"]).value.replace(/\s+/g, " ");
      if (text) parts.push({ kind: "text", text });
      return;
    }
    if (!isElement(current)) {
      if (isParent(current)) for (const child of current.childNodes) walk(child);
      return;
    }
    const element = current;
    if (IGNORED_TAGS.has(element.tagName)) return;
    if (element.tagName === "math") {
      emitInlineMath(element, context, parts, unitId);
      return;
    }
    if (hasClass(element, "ltx_note")) {
      emitFootnote(element, context, parts, unitId);
      return;
    }
    if (element.tagName === "cite" || hasClass(element, "ltx_cite")) {
      emitCitation(element, context, parts, unitId);
      return;
    }
    if (element.tagName === "a") {
      emitAnchor(element, context, parts, unitId);
      return;
    }
    if (element.tagName === "img" || element.tagName === "svg") {
      // 行内图片降级为占位文本，块级图片由 figure 处理。
      const alt = attr(element, "alt")?.trim();
      parts.push({ kind: "text", text: alt ? `[image: ${alt}]` : "[image]" });
      return;
    }
    if (isParent(element)) for (const child of element.childNodes) walk(child);
  };
  walk(node);
  return parts;
}

function emitInlineMath(math: Element, context: WalkContext, parts: InlinePart[], unitId: string): void {
  const representation = mathRepresentation(math);
  context.builder.noteMath(representation !== null);
  if (!representation) {
    context.builder.warnings.push(
      warning("arxiv-convert-math-unreadable", "arxiv.convert.mathUnreadable", attr(math, "id")),
    );
    parts.push({ kind: "text", text: "[formula]" });
    return;
  }
  const atomId = context.builder.addAtom(unitId, {
    kind: "math",
    text: representation.text,
    source: representation.source,
    ...(aliasesOf(math) ? { sourceAliases: aliasesOf(math) } : {}),
  });
  parts.push({ kind: "atom", atomId });
}

function emitFootnote(note: Element, context: WalkContext, parts: InlinePart[], unitId: string): void {
  const mark = findClass(note, "ltx_note_mark");
  const content = findClass(note, "ltx_note_content");
  const footnoteText = content ? visibleText(content) : visibleText(note);
  const footnoteUnitId = context.builder.addUnit(
    { kind: "footnote", aliases: aliasesOf(note) },
    [[{ kind: "text", text: footnoteText || " " }]],
  );
  const atomId = context.builder.addAtom(unitId, {
    kind: "footnote-reference",
    text: mark ? visibleText(mark) : "[note]",
    targetUnitId: footnoteUnitId,
  });
  parts.push({ kind: "atom", atomId });
}

function emitCitation(cite: Element, context: WalkContext, parts: InlinePart[], unitId: string): void {
  const text = visibleText(cite) || "[citation]";
  const targets: string[] = [];
  const collect = (node: Node): void => {
    if (isElement(node) && node.tagName === "a") {
      const href = attr(node, "href") ?? "";
      if (href.startsWith("#")) targets.push(href.slice(1));
    }
    if (isParent(node)) for (const child of node.childNodes) collect(child);
  };
  collect(cite);
  const atomId = context.builder.addAtom(unitId, {
    kind: "citation",
    text,
    targetUnitId: null,
    ...(targets.length ? { sourceAliases: targets } : {}),
  });
  parts.push({ kind: "atom", atomId });
  for (const target of targets)
    context.builder.pendingRefs.push({ atomId, kind: "citation", target });
}

function emitAnchor(anchor: Element, context: WalkContext, parts: InlinePart[], unitId: string): void {
  const href = attr(anchor, "href") ?? "";
  const text = visibleText(anchor) || href || "[link]";
  if (href.startsWith("#")) {
    const target = href.slice(1);
    const atomId = context.builder.addAtom(unitId, {
      kind: "cross-reference",
      text,
      targetUnitId: null,
      sourceTarget: target,
    });
    parts.push({ kind: "atom", atomId });
    context.builder.pendingRefs.push({ atomId, kind: "cross-reference", target });
    return;
  }
  let protocol: string | null = null;
  try {
    protocol = new URL(href).protocol;
  } catch {
    protocol = null;
  }
  if (protocol && ["https:", "http:", "mailto:"].includes(protocol)) {
    const atomId = context.builder.addAtom(unitId, {
      kind: "link",
      text,
      href,
    });
    parts.push({ kind: "atom", atomId });
    return;
  }
  // 危险或不支持的 URL：只保留文本，不进入运行时。
  context.builder.warnings.push(
    warning("arxiv-convert-link-blocked", "arxiv.convert.linkBlocked", attr(anchor, "id")),
  );
  parts.push({ kind: "text", text });
}

function walkFigure(figure: Element, context: WalkContext): void {
  const builder = context.builder;
  const sectionId = builder.currentSection;

  // 子图（ltx_subfigure）：每个子图独立成块并注册自己的别名，
  // 不得只转换第一张而静默省略其余可见内容（SPEC §4.2/§4.8）。
  const subfigures: Element[] = [];
  const collectSubs = (node: Node): void => {
    if (isElement(node) && node !== figure && hasClass(node, "ltx_subfigure")) {
      subfigures.push(node);
      return;
    }
    if (isElement(node) && hasClass(node, "ltx_caption")) return;
    if (isParent(node)) for (const child of node.childNodes) collectSubs(child);
  };
  collectSubs(figure);

  // 父图 caption 必须排除子图子树：深度优先 findClass 会误取第一个子图 caption。
  const caption = findCaptionOutsideSubfigures(figure);
  let captionUnitId: string | null = null;
  let captionInput: UnitInput | null = null;
  let captionSentences: InlinePart[][] = [];
  const figureAliases = aliasesOf(figure);
  if (caption) {
    captionUnitId = builder.reserveUnit();
    captionInput = { kind: "caption", ...(figureAliases ? { aliases: figureAliases } : {}) };
    captionSentences = splitSentences([{ kind: "text", text: captionTextOf(caption) || " " }]);
    builder.deferUnit(captionUnitId, captionInput, captionSentences);
  }

  // 无 caption 的图也要有合法锚定单元：交叉引用只能指向 unit，不能指向 block。
  // 非叶容器（含子图）的 alias 持久化到锚定单元，不只留在临时映射。
  const anchorUnitId = captionUnitId ?? builder.addUnit(
    { kind: "paragraph", ...(figureAliases ? { aliases: figureAliases } : {}) },
    [[{ kind: "text", text: figureAnchorText(figure) }]],
  );

  const images = subfigures.length ? [] : collectImages(figure);
  if (subfigures.length) {
    // 主 caption 先落树，再按来源顺序转换每个子图。
    if (captionUnitId && captionInput) {
      const deferred = builder.takeDeferred(captionUnitId);
      builder.flushUnit(deferred.unitId, deferred.input, deferred.sentences, sectionId, {
        id: randomUUID(),
        sectionId,
        kind: "unit",
        unitId: captionUnitId,
      });
    }
    for (const sub of subfigures) walkFigure(sub, context);
    const figureAlias = attr(figure, "id");
    if (figureAlias) builder.registerAlias(figureAlias, anchorUnitId);
    return;
  }

  const image = images[0] ?? null;
  let asset: { path: string; sha256: string; mime: string } | null = null;
  let figureWarning: string | undefined;
  if (image && image.tagName === "img") {
    const resolved = resolveAsset(image, context);
    if (resolved) {
      asset = resolved;
    } else {
      figureWarning = "arxiv.convert.assetUnavailable";
    }
  } else if (image && image.tagName === "svg") {
    // 原始 SVG 保留在快照；revision 不执行其中内容，降级为占位与警告。
    figureWarning = "arxiv.convert.svgNotRendered";
    builder.warnings.push(
      warning("arxiv-convert-svg-inline", "arxiv.convert.svgInline", attr(figure, "id")),
    );
  } else {
    figureWarning = "arxiv.convert.assetUnavailable";
  }
  // 同一 figure 内多张图片而结构无法表达：raw 降级保留全部可见内容，不静默丢弃。
  if (images.length > 1) {
    builder.warnings.push(
      warning("arxiv-convert-figure-multi-image", "arxiv.convert.figureMultiImage", attr(figure, "id")),
    );
    if (captionUnitId) {
      const deferred = builder.takeDeferred(captionUnitId);
      builder.flushUnit(deferred.unitId, { kind: "paragraph" }, deferred.sentences, sectionId, {
        id: randomUUID(),
        sectionId,
        kind: "unit",
        unitId: captionUnitId,
      });
    }
    emitRawBlock(figure, context, ["arxiv.convert.figureMultiImage"]);
    const figureAlias = attr(figure, "id");
    if (figureAlias) builder.registerAlias(figureAlias, anchorUnitId);
    builder.noteFigure(true);
    return;
  }
  builder.noteFigure(asset === null);
  const figureBlock: DocumentTree["blocks"][number] = {
    id: randomUUID(),
    sectionId,
    kind: "figure",
    asset,
    captionUnitId,
    ...(figureWarning ? { warning: figureWarning } : {}),
    ...(aliasesOf(figure) ? { sourceAliases: aliasesOf(figure) } : {}),
  };
  if (captionUnitId && captionInput) {
    const deferred = builder.takeDeferred(captionUnitId);
    builder.flushUnit(deferred.unitId, deferred.input, deferred.sentences, sectionId, figureBlock);
  } else {
    builder.tree.blocks.push(figureBlock);
  }
  const figureAlias = attr(figure, "id");
  if (figureAlias) builder.registerAlias(figureAlias, anchorUnitId);
  if (asset === null && figureWarning === "arxiv.convert.assetUnavailable") {
    builder.warnings.push(
      warning("arxiv-convert-asset-missing", "arxiv.convert.assetMissing", figureAlias),
    );
  }
}

/** 无 caption 图片的锚定文本：优先 alt，其次来源 ID，保证可读占位。 */
function figureAnchorText(figure: Element): string {
  const image = findImage(figure);
  const alt = image ? attr(image, "alt")?.trim() : undefined;
  if (alt) return `[image: ${alt}]`;
  const id = attr(figure, "id");
  return id ? `[image: ${id}]` : "[image]";
}

function collectImages(root: Element): Element[] {
  const found: Element[] = [];
  const walk = (node: Node): void => {
    if (isElement(node) && (node.tagName === "img" || node.tagName === "svg")) {
      found.push(node);
      return;
    }
    if (isElement(node) && hasClass(node, "ltx_caption")) return;
    if (isParent(node)) for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return found;
}

function captionTextOf(caption: Element): string {
  const tag = findClass(caption, "ltx_tag");
  const full = visibleText(caption);
  if (tag) {
    const tagText = visibleText(tag);
    if (tagText && full.startsWith(tagText)) return full.slice(tagText.length).trim();
  }
  return full;
}

function findImage(root: Element): Element | null {
  return collectImages(root)[0] ?? null;
}

/** 查找 figure 直属 caption：跳过子图子树，但不跳过 figure 自身（子图递归时自身即 ltx_subfigure）。 */
function findCaptionOutsideSubfigures(figure: Element): Element | null {
  const search = (node: Node, isRoot: boolean): Element | null => {
    if (isElement(node) && !isRoot && hasClass(node, "ltx_subfigure")) return null;
    if (isElement(node) && hasClass(node, "ltx_caption")) return node;
    if (!isParent(node)) return null;
    for (const child of node.childNodes) {
      const found = search(child, false);
      if (found) return found;
    }
    return null;
  };
  return search(figure, true);
}

function resolveAsset(image: Element, context: WalkContext): { path: string; sha256: string; mime: string } | null {
  const src = attr(image, "src");
  if (!src) return null;
  let originalUrl: string;
  try {
    originalUrl = new URL(src, context.input.htmlUrl).href;
  } catch {
    return null;
  }
  const mapping = context.assetBySource.get(originalUrl);
  if (!mapping) return null;
  const bytes = context.input.assetBytes[mapping.path];
  if (!bytes) return null;
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== mapping.sha256) {
    throw new CoverageError(
      "arxiv-convert-asset-digest",
      "arxiv.convert.assetDigest",
      mapping.path,
    );
  }
  const mime = mapping.mime ?? "application/octet-stream";
  if (!IMAGE_MIME_EXTENSIONS[mime]) return null;
  return { path: mapping.path, sha256: mapping.sha256, mime };
}

function walkTableFigure(figure: Element, context: WalkContext): void {
  const builder = context.builder;
  const sectionId = builder.currentSection;
  const caption = findClass(figure, "ltx_caption");
  let captionUnitId: string | null = null;
  if (caption) {
    captionUnitId = builder.reserveUnit();
    builder.deferUnit(
      captionUnitId,
      { kind: "caption" },
      splitSentences([{ kind: "text", text: captionTextOf(caption) || " " }]),
    );
  }
  const tabular = findClass(figure, "ltx_tabular") ??
    (figure.tagName === "table" ? figure : null);
  const rows = tabular ? tableRows(tabular, context) : null;
  // 无 caption 表格也要有合法锚定单元：交叉引用只能指向 unit，不能指向 block。
  const anchorUnitId = captionUnitId ?? builder.addUnit(
    { kind: "paragraph" },
    [[{ kind: "text", text: tableAnchorText(figure) }]],
  );
  const aliases = aliasesOf(figure);
  if (rows) {
    const blockId = randomUUID();
    const tableBlock: DocumentTree["blocks"][number] = {
      id: blockId,
      sectionId,
      kind: "table",
      captionUnitId,
      rows,
      ...(aliases ? { sourceAliases: aliases } : {}),
    };
    // 按块顺序落树：caption 在前，单元格按行序；table block 只 push 一次。
    const ordered = [
      ...(captionUnitId ? [captionUnitId] : []),
      ...rows.flat().map((cell) => cell.unitId),
    ];
    for (const [index, unitId] of ordered.entries()) {
      const deferred = builder.takeDeferred(unitId);
      builder.flushUnit(
        deferred.unitId,
        deferred.input,
        deferred.sentences,
        sectionId,
        index === 0 ? tableBlock : null,
      );
    }
    if (!ordered.length) builder.tree.blocks.push(tableBlock);
    const alias = attr(figure, "id");
    if (alias) builder.registerAlias(alias, anchorUnitId);
    return;
  }
  // 无法无损表达：raw block + 文本投影 + warning；caption 随 raw 降级为普通段落。
  if (captionUnitId) {
    const deferred = builder.takeDeferred(captionUnitId);
    builder.flushUnit(deferred.unitId, { kind: "paragraph" }, deferred.sentences, sectionId, {
      id: randomUUID(),
      sectionId,
      kind: "unit",
      unitId: captionUnitId,
    });
  }
  builder.warnings.push(
    warning("arxiv-convert-table-lossy", "arxiv.convert.tableLossy", attr(figure, "id")),
  );
  emitRawBlock(figure, context, ["arxiv.convert.tableLossy"]);
  const alias = attr(figure, "id");
  if (alias) builder.registerAlias(alias, anchorUnitId);
}

/** 无 caption 表格的锚定文本：来源 ID 优先，保证可读占位。 */
function tableAnchorText(figure: Element): string {
  const id = attr(figure, "id");
  return id ? `[table: ${id}]` : "[table]";
}

interface CellSpan {
  unitId: string;
  rowSpan: number;
  columnSpan: number;
}

function tableRows(tabular: Element, context: WalkContext): CellSpan[][] | null {
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
  if (!trs.length) return null;

  // 嵌套表格无法用行列跨度无损表达。
  for (const tr of trs) {
    const cells = tr.childNodes.filter(
      (child): child is Element => isElement(child) && (child.tagName === "td" || child.tagName === "th"),
    );
    for (const cell of cells) {
      if (findClass(cell, "ltx_tabular") || findTag(cell, "table")) return null;
    }
  }

  // 跨度安全边界（schema 校验前的 DoS 防护）：来源 rowspan/colspan 不可信，
  // 超出实际网格规模或非安全整数时整体降级为 raw block，不逐格填充。
  const MAX_TABLE_ROWS = 4096;
  const MAX_TABLE_COLUMNS = 256;
  if (trs.length > MAX_TABLE_ROWS) return null;
  const spanOf = (cell: Element, name: string): number | null => {
    const raw = attr(cell, name);
    if (raw === undefined) return 1;
    // 完整十进制整数匹配："2.5"、"1e3" 等无法无损表达，降级而非截断。
    if (!/^[0-9]+$/.test(raw.trim())) return null;
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return value;
  };
  const rows: CellSpan[][] = [];
  const occupied = new Map<string, true>();
  const key = (row: number, column: number): string => `${row}:${column}`;
  let columnIndex = 0;
  for (let rowIndex = 0; rowIndex < trs.length; rowIndex += 1) {
    const tr = trs[rowIndex];
    const cells = tr.childNodes.filter(
      (child): child is Element => isElement(child) && (child.tagName === "td" || child.tagName === "th"),
    );
    const row: CellSpan[] = [];
    columnIndex = 0;
    for (const cell of cells) {
      while (occupied.has(key(rowIndex, columnIndex))) columnIndex += 1;
      const rowSpanRaw = spanOf(cell, "rowspan");
      const columnSpanRaw = spanOf(cell, "colspan");
      if (rowSpanRaw === null || columnSpanRaw === null) return null;
      if (rowSpanRaw > trs.length - rowIndex || columnSpanRaw > MAX_TABLE_COLUMNS) return null;
      const rowSpan = rowSpanRaw;
      const columnSpan = columnSpanRaw;
      if (columnIndex + columnSpan > MAX_TABLE_COLUMNS) return null;
      const unitId = context.builder.reserveUnit();
      const parts = inlineParts(cell, context, unitId);
      context.builder.deferUnit(
        unitId,
        { kind: "table-cell" },
        splitSentences(parts.length ? parts : [{ kind: "text", text: " " }]),
      );
      row.push({ unitId, rowSpan, columnSpan });
      for (let dr = 0; dr < rowSpan; dr += 1)
        for (let dc = 0; dc < columnSpan; dc += 1)
          occupied.set(key(rowIndex + dr, columnIndex + dc), true);
      columnIndex += columnSpan;
    }
    rows.push(row);
  }
  return rows;
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

/** 返回实际创建的锚定单元 ID（group 用它持久化组 alias，不依赖成员自身 ID）。 */
function walkEquation(equation: Element, context: WalkContext): string | null {
  // equation group 含多条对齐公式：逐条转换，不得只取第一条（SPEC §4.2 覆盖）。
  if (hasClass(equation, "ltx_equationgroup")) {
    const members: Element[] = [];
    const collect = (node: Node): void => {
      if (isElement(node) && node !== equation &&
          (hasClass(node, "ltx_equation") || hasClass(node, "ltx_eqn_table"))) {
        members.push(node);
        return;
      }
      if (isParent(node)) for (const child of node.childNodes) collect(child);
    };
    collect(equation);
    if (members.length) {
      let firstAnchor: string | null = null;
      for (const member of members) {
        const anchor = walkEquation(member, context);
        if (firstAnchor === null) firstAnchor = anchor;
      }
      const alias = attr(equation, "id");
      if (alias && !context.builder.aliases.has(alias) && firstAnchor !== null) {
        context.builder.registerAlias(alias, firstAnchor);
        // 组 ID 持久化到锚定单元的 sourceAliases，不只留在临时映射。
        const unit = context.builder.tree.units[firstAnchor];
        if (unit) {
          const existing = unit.sourceAliases ?? [];
          if (!existing.includes(alias)) unit.sourceAliases = [...existing, alias];
        }
      }
      return firstAnchor;
    }
    // 无已知成员结构的 group：整体 raw 降级，不静默丢弃。
    context.builder.warnings.push(
      warning("arxiv-convert-equationgroup-lossy", "arxiv.convert.equationGroupLossy", attr(equation, "id")),
    );
    emitRawBlock(equation, context, ["arxiv.convert.equationGroupLossy"]);
    return null;
  }
  const builder = context.builder;
  const math = findTag(equation, "math");
  const representation = math ? mathRepresentation(math) : null;
  builder.noteMath(representation !== null);
  const tag = findClass(equation, "ltx_tag");
  const tagText = tag ? visibleText(tag) : "";
  if (!representation) {
    builder.warnings.push(
      warning("arxiv-convert-math-unreadable", "arxiv.convert.mathUnreadable", attr(equation, "id")),
    );
    emitRawBlock(equation, context, ["arxiv.convert.equationUnreadable"]);
    return null;
  }
  const text = tagText ? `${representation.text} ${tagText}` : representation.text;
  // 编号锚定单元先落树：交叉引用只能指向单元，公式块本身不占用单元。
  const anchorUnitId = builder.addUnit(
    { kind: "paragraph" },
    [[{ kind: "text", text: tagText || representation.text }]],
  );
  builder.tree.blocks.push({
    id: randomUUID(),
    sectionId: builder.currentSection,
    kind: "formula",
    source: representation.source,
    text,
    ...(aliasesOf(equation) ? { sourceAliases: aliasesOf(equation) } : {}),
  });
  const alias = attr(equation, "id");
  if (alias) builder.registerAlias(alias, anchorUnitId);
  return anchorUnitId;
}

function emitBlockMath(math: Element, context: WalkContext): void {
  const representation = mathRepresentation(math);
  context.builder.noteMath(representation !== null);
  if (!representation) {
    context.builder.warnings.push(
      warning("arxiv-convert-math-unreadable", "arxiv.convert.mathUnreadable", attr(math, "id")),
    );
    return;
  }
  context.builder.tree.blocks.push({
    id: randomUUID(),
    sectionId: context.builder.currentSection,
    kind: "formula",
    source: representation.source,
    text: representation.text,
    ...(aliasesOf(math) ? { sourceAliases: aliasesOf(math) } : {}),
  });
}

function emitRawBlock(
  element: Element,
  context: WalkContext,
  limitations: string[],
): void {
  const builder = context.builder;
  const html = projectRawHtml(element);
  const text = visibleText(element) || " ";
  if (!html.trim()) {
    builder.addUnit({ kind: "paragraph" }, [[{ kind: "text", text }]]);
    return;
  }
  builder.tree.blocks.push({
    id: randomUUID(),
    sectionId: builder.currentSection,
    kind: "raw",
    html,
    text,
    limitations,
    ...(aliasesOf(element) ? { sourceAliases: aliasesOf(element) } : {}),
  });
}

function resolveReferences(builder: TreeBuilder, sourceIds: Set<string>): void {
  for (const ref of builder.pendingRefs) {
    const atom = builder.tree.atoms[ref.atomId];
    if (!atom) continue;
    const resolved = builder.aliases.get(ref.target);
    if (ref.kind === "citation") {
      if (atom.kind !== "citation") continue;
      if (resolved) {
        // 解析到书目规范单元；多目标引用取首个已解析目标，其余保留 sourceAliases。
        if (atom.targetUnitId === null) atom.targetUnitId = resolved.unitId;
      } else if (sourceIds.has(ref.target)) {
        throw new CoverageError("arxiv-convert-coverage", "arxiv.convert.coverage", ref.target);
      } else {
        builder.warnings.push(
          warning("arxiv-convert-citation-unresolved", "arxiv.convert.citationUnresolved", ref.target),
        );
      }
      continue;
    }
    if (atom.kind !== "cross-reference") continue;
    if (resolved) {
      atom.targetUnitId = resolved.unitId;
    } else if (sourceIds.has(ref.target)) {
      // 来源中存在该 ID 却没有对应规范节点：内容覆盖错误，不能降级为普通 unresolved。
      throw new CoverageError("arxiv-convert-coverage", "arxiv.convert.coverage", ref.target);
    } else {
      builder.warnings.push(
        warning("arxiv-convert-reference-unresolved", "arxiv.convert.referenceUnresolved", ref.target),
      );
    }
  }
}

export type ConvertArxivSnapshotTreeResult =
  | {
      ok: true;
      tree: DocumentTree;
      warnings: ImportDiagnostic[];
      converterVersion: number;
      /** 图块引用的快照资产字节（含 MIME），供首次发布或合并候选携带。 */
      assetBytes: Record<string, { bytes: Uint8Array; mime?: string }>;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

/** 从受管快照离线转换出规范树（SPEC §8.5／§9.3）：核验登记摘要后转换，
 * 不发布 revision、不修改快照、不访问网络。首次导入与更新候选共用此入口。 */
export async function convertArxivSnapshotTree(input: {
  root: string;
  sourceSnapshotId: string;
  converter?: typeof convertLatexml;
}): Promise<ConvertArxivSnapshotTreeResult> {
  let snapshot: SourceSnapshotRecord;
  try {
    snapshot = await readSourceSnapshot(input.root, input.sourceSnapshotId);
  } catch (error) {
    return fatal(
      "arxiv-convert-snapshot-unreadable",
      `arxiv.convert.snapshotUnreadable:${error instanceof Error ? error.message : String(error)}`,
      "convert",
    );
  }
  if (snapshot.kind !== "arxiv")
    return fatal("arxiv-convert-snapshot-kind", "arxiv.convert.snapshotKind", "convert");
  const metadata = snapshot as unknown as ArxivSourceMetadata;
  const htmlRecord = snapshot.files.find((file) => file.path === "document.html");
  if (!htmlRecord)
    return fatal("arxiv-convert-html-missing", "arxiv.convert.htmlMissing", "convert");

  const readAsset = async (relative: string): Promise<Uint8Array> => {
    const record = snapshot.files.find((file) => file.path === relative);
    if (!record) throw new Error(`快照文件缺失：${relative}`);
    const bytes = await fs.readFile(path.join(input.root, snapshot.path, relative));
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
      throw new Error(`快照摘要不符：${relative}`);
    return bytes;
  };

  let html: Uint8Array;
  const assetBytes: Record<string, Uint8Array> = {};
  try {
    html = await readAsset("document.html");
    for (const mapping of Object.values(metadata.assets ?? {}))
      assetBytes[mapping.path] = await readAsset(mapping.path);
  } catch (error) {
    return fatal(
      "arxiv-convert-snapshot-digest",
      `arxiv.convert.snapshotDigest:${error instanceof Error ? error.message : String(error)}`,
      "convert",
    );
  }

  const opened = await openProject(input.root);
  const result = (input.converter ?? convertLatexml)({
    html,
    paperId: opened.manifest.paper.id,
    htmlUrl: metadata.htmlUrl,
    assets: metadata.assets ?? {},
    assetBytes,
  });
  if (!result.ok) return result;
  const figureAssets: Record<string, { bytes: Uint8Array; mime?: string }> = {};
  for (const block of result.tree.blocks) {
    if (block.kind === "figure" && block.asset)
      figureAssets[block.asset.path] = {
        bytes: assetBytes[block.asset.path],
        ...(block.asset.mime === undefined ? {} : { mime: block.asset.mime }),
      };
  }
  return {
    ok: true,
    tree: result.tree,
    warnings: result.warnings,
    converterVersion: ARXIV_CONVERTER_VERSION,
    assetBytes: figureAssets,
  };
}

/** 从受管快照离线转换并发布首个 current；不修改快照，不访问网络。
 * current 已存在时拒绝直写：更新候选走 document-core 合并路径（update.ts）。 */
export async function convertArxivSnapshot(
  input: ConvertArxivSnapshotInput,
): Promise<ConvertArxivSnapshotResult> {
  // 已发布候选的恢复：不重新转换（节点 UUID 不可复现），核验磁盘字节后只推进 current。
  // 提前到资产读取之前：仅推进指针不需要加载 HTML 与资产字节。
  if (input.completePublished && input.revisionId !== undefined) {
    // 元数据校验在 completePublishedRevision 的串行临界区内、current 替换前执行：
    // 校验失败时 current 保持为空，不产生"返回失败但已推进"的矛盾状态。
    const validated: { value: { warnings: ImportDiagnostic[]; converterVersion: number } | null } = { value: null };
    const validateMetadata = (revision: ProjectRevisionRecord): void => {
      const arxivMeta = revision.arxiv;
      const record: Record<string, unknown> = arxivMeta !== null && typeof arxivMeta === "object"
        ? { ...arxivMeta } : {};
      let warnings: ImportDiagnostic[];
      try {
        warnings = readDiagnosticArray(record.warnings);
      } catch (error) {
        throw new ArxivMetadataError(
          "arxiv-import-record-corrupt",
          `arxiv.import.recordCorrupt:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof record.converterVersion !== "number" ||
          !Number.isInteger(record.converterVersion) || record.converterVersion < 1) {
        throw new ArxivMetadataError("arxiv-convert-version-missing", "arxiv.convert.versionMissing");
      }
      validated.value = { warnings, converterVersion: record.converterVersion };
    };
    try {
      const revision = await completePublishedRevision(
        input.root, input.revisionId, input.hooks?.commitHooks ?? {}, validateMetadata,
      );
      if (validated.value === null)
        return fatal("arxiv-convert-version-missing", "arxiv.convert.versionMissing", "convert");
      return { ok: true, revision, warnings: validated.value.warnings, converterVersion: validated.value.converterVersion };
    } catch (error) {
      // 按错误类型分类，不做消息 substring 匹配：无关提交故障即使消息含相同文本
      // 也返回 publish-failed，不冒充元数据校验失败。
      if (error instanceof ArxivMetadataError)
        return fatal(error.code, error.messageKey, "convert");
      const message = error instanceof Error ? error.message : String(error);
      return fatal("arxiv-convert-publish-failed", `arxiv.convert.publishFailed:${message}`, "publish");
    }
  }

  const converted = await convertArxivSnapshotTree({
    root: input.root,
    sourceSnapshotId: input.sourceSnapshotId,
    ...(input.converter === undefined ? {} : { converter: input.converter }),
  });
  if (!converted.ok) return converted;

  // 首次导入不变量：document 与 source-base 一致、baseRevision 必须为空；
  // current 已存在时更新候选必须走 document-core 合并路径，不得在此直写。
  const opened = await openProject(input.root);
  if (opened.manifest.paper.currentRevision !== null)
    return fatal("arxiv-convert-current-exists", "arxiv.convert.currentExists", "convert");
  try {
    await input.hooks?.onConvertPoint?.("candidate-built");
  } catch (error) {
    return fatal(
      "arxiv-convert-interrupted",
      `arxiv.convert.interrupted:${error instanceof Error ? error.message : String(error)}`,
      "convert",
    );
  }

  const revisionId = input.revisionId ?? randomUUID();
  try {
    await input.onCandidateBuilt?.({ revisionId, warnings: converted.warnings });
  } catch (error) {
    // 候选进度持久化失败：结构化诊断返回，不穿透 IPC；磁盘现场保留可恢复。
    return fatal(
      "arxiv-convert-progress-failed",
      `arxiv.convert.progressFailed:${error instanceof Error ? error.message : String(error)}`,
      "convert",
    );
  }
  const baseRevision = opened.manifest.paper.currentRevision;
  const documentJson = Buffer.from(JSON.stringify(converted.tree));
  // 确定性 changeset：同一候选重试必须产生逐字节一致的内容，
  // 否则 project-core 的同 revisionId 幂等复核会拒绝残留候选。
  const changeset = createDocumentChangeset({
    base: null,
    current: converted.tree,
    baseRevision,
    revisionId,
  });
  const files: Record<string, ManagedFileContent> = {
    "document.json": documentJson,
    "source-base.json": documentJson,
    "tombstones.json": Buffer.from("[]"),
    "changeset.json": Buffer.from(JSON.stringify(changeset)),
  };
  for (const [relative, asset] of Object.entries(converted.assetBytes))
    files[relative] = asset.mime === undefined ? asset.bytes : { bytes: asset.bytes, mime: asset.mime };
  try {
    await input.hooks?.onConvertPoint?.("before-publish");
  } catch (error) {
    return fatal(
      "arxiv-convert-interrupted",
      `arxiv.convert.interrupted:${error instanceof Error ? error.message : String(error)}`,
      "convert",
    );
  }
  try {
    const revision = await commitRevision({
      root: input.root,
      sourceSnapshotId: input.sourceSnapshotId,
      baseRevision,
      revisionId,
      files,
      metadata: {
        arxiv: {
          converterVersion: converted.converterVersion,
          warnings: converted.warnings,
        },
      },
    }, input.hooks?.commitHooks);
    return {
      ok: true,
      revision,
      warnings: converted.warnings,
      converterVersion: converted.converterVersion,
    };
  } catch (error) {
    return fatal(
      "arxiv-convert-publish-failed",
      `arxiv.convert.publishFailed:${error instanceof Error ? error.message : String(error)}`,
      "publish",
    );
  }
}
