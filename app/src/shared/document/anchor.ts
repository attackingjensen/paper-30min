import Type from "typebox";
import Schema from "typebox/schema";
import type { DocumentTree } from "./tree.js";

const IdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const SelectionRangeSchema = Type.Object(
  {
    unitId: IdSchema,
    sentenceId: IdSchema,
    start: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    end: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
const QuoteSnapshotSchema = Type.Object(
  {
    text: Type.String(),
    before: Type.String(),
    after: Type.String(),
  },
  { additionalProperties: false },
);
export const DocumentAnchorSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("section"),
      sectionId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unit"),
      unitId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("sentence"),
      unitId: IdSchema,
      sentenceId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("atom"),
      unitId: IdSchema,
      atomId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("block"),
      blockId: IdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("range"),
      ranges: Type.Array(SelectionRangeSchema, { minItems: 1 }),
      quote: QuoteSnapshotSchema,
    },
    { additionalProperties: false },
  ),
]);

export type DocumentAnchor = Type.Static<typeof DocumentAnchorSchema>;
type SelectionRange = Extract<DocumentAnchor, { kind: "range" }>["ranges"][number];
type RangeAnchor = Extract<DocumentAnchor, { kind: "range" }>;
type Sentence = DocumentTree["sentences"][string];
type Block = DocumentTree["blocks"][number];
type Dependency = {
  nodeType: "section" | "unit" | "sentence" | "atom" | "block";
  nodeId: string;
};

const anchorSchema = Schema.Compile(DocumentAnchorSchema);
const quoteContextLength = 32;

function invalid(message: string): never {
  throw new Error(`文档锚点无效：${message}`);
}

function sentence(tree: DocumentTree, sentenceId: string) {
  return tree.sentences[sentenceId] ?? invalid(`句子不存在：${sentenceId}。`);
}

function logicalLength(sentence: Sentence) {
  return sentence.content.reduce((length, part) => length + (part.kind === "text" ? part.text.length : 1), 0);
}

function logicalSlice(tree: DocumentTree, value: Sentence, start: number, end: number) {
  let cursor = 0;
  let text = "";
  for (const part of value.content) {
    if (part.kind === "text") {
      const partEnd = cursor + part.text.length;
      if (start < partEnd && end > cursor) {
        const from = Math.max(0, start - cursor);
        const to = Math.min(part.text.length, end - cursor);
        text += part.text.slice(from, to);
      }
      cursor = partEnd;
    } else {
      if (start <= cursor && cursor < end)
        text += tree.atoms[part.atomId]?.text ?? invalid(`原子不存在：${part.atomId}。`);
      cursor += 1;
    }
    if (cursor >= end) break;
  }
  return text;
}

export function projectSentenceText(tree: DocumentTree, sentenceId: string) {
  const value = sentence(tree, sentenceId);
  return logicalSlice(tree, value, 0, logicalLength(value));
}

function blockUnits(block: Block) {
  switch (block.kind) {
    case "unit":
      return [block.unitId];
    case "figure":
      return block.captionUnitId ? [block.captionUnitId] : [];
    case "table":
      return [...(block.captionUnitId ? [block.captionUnitId] : []), ...block.rows.flat().map((cell) => cell.unitId)];
    default:
      return [];
  }
}

function sentenceOrder(tree: DocumentTree) {
  const order = new Map<string, number>();
  for (const block of tree.blocks) {
    for (const unitId of blockUnits(block)) {
      const unit = tree.units[unitId] ?? invalid(`阅读块单元不存在：${unitId}。`);
      for (const sentenceId of unit.sentenceIds) {
        if (order.has(sentenceId)) invalid(`句子在阅读流中重复：${sentenceId}。`);
        order.set(sentenceId, order.size);
      }
    }
  }
  return order;
}

function validateRanges(tree: DocumentTree, ranges: SelectionRange[]) {
  const order = sentenceOrder(tree);
  let previous: { index: number; end: number; sentenceId: string } | null = null;
  for (const range of ranges) {
    const value = sentence(tree, range.sentenceId);
    if (value.unitId !== range.unitId) invalid("选区句子的父子关系不一致。");
    const index = order.get(range.sentenceId);
    if (index === undefined) invalid(`句子不在阅读流中：${range.sentenceId}。`);
    const length = logicalLength(value);
    if (range.start >= range.end || range.end > length) invalid(`选区偏移超出句子逻辑边界：${range.sentenceId}。`);
    if (previous) {
      if (index <= previous.index) invalid("多个选区必须按原文顺序排列，且每句至多一个范围。");
      if (
        index !== previous.index + 1 ||
        previous.end !== logicalLength(sentence(tree, previous.sentenceId)) ||
        range.start !== 0
      )
        invalid("跨句或跨单元选区不连续，必须显式保存全部中间句子。");
    }
    previous = { index, end: range.end, sentenceId: range.sentenceId };
  }
}

function quoteSnapshot(tree: DocumentTree, ranges: SelectionRange[]) {
  const first = ranges[0];
  const last = ranges.at(-1)!;
  const firstSentence = sentence(tree, first.sentenceId);
  const lastSentence = sentence(tree, last.sentenceId);
  return {
    text: ranges
      .map((range) => logicalSlice(tree, sentence(tree, range.sentenceId), range.start, range.end))
      .join("\n"),
    before: logicalSlice(tree, firstSentence, Math.max(0, first.start - quoteContextLength), first.start),
    after: logicalSlice(
      tree,
      lastSentence,
      last.end,
      Math.min(logicalLength(lastSentence), last.end + quoteContextLength),
    ),
  };
}

export function createRangeAnchor(tree: DocumentTree, ranges: SelectionRange[]): RangeAnchor {
  validateRanges(tree, ranges);
  return {
    kind: "range",
    ranges: structuredClone(ranges),
    quote: quoteSnapshot(tree, ranges),
  };
}

function validateAtomPosition(tree: DocumentTree, unitId: string, atomId: string) {
  const unit = tree.units[unitId] ?? invalid(`原子所属单元不存在：${unitId}。`);
  const referenced = unit.sentenceIds.some((sentenceId) =>
    sentence(tree, sentenceId).content.some((part) => part.kind === "atom" && part.atomId === atomId),
  );
  if (!referenced) invalid("原子未出现在所属单元的句子内容中。");
}

export function parseDocumentAnchor(tree: DocumentTree, value: unknown): DocumentAnchor {
  if (!anchorSchema.Check(value)) invalid("不符合结构化锚点 schema。");
  switch (value.kind) {
    case "section":
      if (!tree.sections[value.sectionId]) invalid(`章节不存在：${value.sectionId}。`);
      break;
    case "unit":
      if (!tree.units[value.unitId]) invalid(`单元不存在：${value.unitId}。`);
      break;
    case "sentence": {
      const target = sentence(tree, value.sentenceId);
      if (target.unitId !== value.unitId) invalid("句子锚点的父子关系不一致。");
      break;
    }
    case "atom": {
      const atom = tree.atoms[value.atomId] ?? invalid(`原子不存在：${value.atomId}。`);
      if (atom.unitId !== value.unitId) invalid("原子锚点的父子关系不一致。");
      validateAtomPosition(tree, value.unitId, value.atomId);
      break;
    }
    case "block":
      if (!tree.blocks.some((block) => block.id === value.blockId)) invalid(`阅读块不存在：${value.blockId}。`);
      break;
    case "range": {
      validateRanges(tree, value.ranges);
      const expected = quoteSnapshot(tree, value.ranges);
      if (
        value.quote.text !== expected.text ||
        value.quote.before !== expected.before ||
        value.quote.after !== expected.after
      )
        invalid("quote 与当前选区内容或前后文不一致；不得仅凭相似文本自动重锚。");
      break;
    }
  }
  return value;
}

export function documentAnchorDependencies(tree: DocumentTree, value: unknown): Dependency[] {
  const anchor = parseDocumentAnchor(tree, value);
  const dependencies: Dependency[] = [];
  const seen = new Set<string>();
  const add = (nodeType: Dependency["nodeType"], nodeId: string) => {
    const key = `${nodeType}:${nodeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    dependencies.push({ nodeType, nodeId });
  };
  const addSentence = (sentenceId: string) => {
    add("sentence", sentenceId);
    for (const part of sentence(tree, sentenceId).content) if (part.kind === "atom") add("atom", part.atomId);
  };
  const addUnit = (unitId: string) => {
    const unit = tree.units[unitId] ?? invalid(`单元不存在：${unitId}。`);
    add("unit", unitId);
    for (const sentenceId of unit.sentenceIds) addSentence(sentenceId);
  };

  if (anchor.kind === "section") {
    const sectionIds = new Set<string>();
    const pending = [anchor.sectionId];
    while (pending.length) {
      const sectionId = pending.pop()!;
      if (sectionIds.has(sectionId)) continue;
      sectionIds.add(sectionId);
      add("section", sectionId);
      pending.push(...tree.sections[sectionId].childSectionIds);
    }
    for (const unit of Object.values(tree.units)) if (sectionIds.has(unit.sectionId)) addUnit(unit.id);
    for (const block of tree.blocks) if (sectionIds.has(block.sectionId)) add("block", block.id);
  } else if (anchor.kind === "unit") addUnit(anchor.unitId);
  else if (anchor.kind === "sentence") addSentence(anchor.sentenceId);
  else if (anchor.kind === "atom") add("atom", anchor.atomId);
  else if (anchor.kind === "block") {
    const block = tree.blocks.find((candidate) => candidate.id === anchor.blockId)!;
    add("block", block.id);
    for (const unitId of blockUnits(block)) addUnit(unitId);
  } else {
    for (const range of anchor.ranges) {
      add("sentence", range.sentenceId);
      let cursor = 0;
      for (const part of sentence(tree, range.sentenceId).content) {
        if (part.kind === "text") cursor += part.text.length;
        else {
          if (range.start <= cursor && cursor < range.end) add("atom", part.atomId);
          cursor += 1;
        }
      }
    }
  }
  return dependencies;
}
