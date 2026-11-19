import { randomUUID } from "node:crypto";
import type { ImportDiagnostic } from "../../shared/arxiv.js";
import type { DocumentTree } from "../../shared/document/tree.js";

/** 纯规范树构建：document-core 节点身份分配、句切分与文本投影。
 * 不解析 vendor 响应、不访问文件系统或网络；块组转换与发布流程见 parse-convert。 */

export type InlinePart = DocumentTree["sentences"][string]["content"][number];
export type BlockNode = DocumentTree["blocks"][number];
export type FigureBlock = Extract<BlockNode, { kind: "figure" }>;
export type UnitKind = DocumentTree["units"][string]["kind"];
export type AssetReference = FigureBlock["asset"];
type AtomValue = DocumentTree["atoms"][string];
type AtomInput = AtomValue extends infer T
  ? T extends AtomValue ? Omit<T, "id" | "unitId"> : never
  : never;

export interface CaptionInput {
  unitId: string;
  sentences: InlinePart[][];
  aliases?: string[];
}

export interface CellInput {
  unitId: string;
  sentences: InlinePart[][];
  rowSpan: number;
  columnSpan: number;
  aliases?: string[];
}

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

export class TreeBuilder {
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

export function textSentences(text: string, unitId: string, builder: TreeBuilder): InlinePart[][] {
  return splitSentences(inlineParts(text, unitId, builder));
}