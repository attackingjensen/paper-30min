import Type from "typebox";
import Schema from "typebox/schema";
import { documentAnchorDependencies, projectSentenceText } from "./anchor.js";
import type { DocumentTree } from "./tree.js";

const IdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const NodeTypeSchema = Type.Union([
  Type.Literal("section"),
  Type.Literal("unit"),
  Type.Literal("sentence"),
  Type.Literal("atom"),
  Type.Literal("block"),
]);
const ChangeStatusSchema = Type.Union([
  Type.Literal("retained"),
  Type.Literal("moved"),
  Type.Literal("changed"),
  Type.Literal("removed"),
  Type.Literal("added"),
  Type.Literal("conflicted"),
]);
const AnchorChangeSchema = Type.Object({
  nodeType: NodeTypeSchema,
  nodeId: IdSchema,
  status: ChangeStatusSchema,
}, { additionalProperties: false });
const DocumentChangesetSchema = Type.Object({
  changesetFormatVersion: Type.Literal(1),
  baseRevision: Type.Union([IdSchema, Type.Null()]),
  revisionId: IdSchema,
  changes: Type.Array(AnchorChangeSchema),
}, { additionalProperties: false });
const TombstoneSchema = Type.Object({
  nodeType: NodeTypeSchema,
  nodeId: IdSchema,
  lastRevision: IdSchema,
  excerpt: Type.String(),
  reason: Type.Union([
    Type.Literal("removed"),
    Type.Literal("split"),
    Type.Literal("merged"),
    Type.Literal("retyped"),
    Type.Literal("unresolved"),
  ]),
  referenceCandidates: Type.Optional(Type.Array(Type.Object({
    nodeType: NodeTypeSchema,
    nodeId: IdSchema,
  }, { additionalProperties: false }))),
}, { additionalProperties: false });
const TombstonesSchema = Type.Array(TombstoneSchema);

export type DocumentChangeset = Type.Static<typeof DocumentChangesetSchema>;
export type NodeType = DocumentChangeset["changes"][number]["nodeType"];
type ChangeStatus = DocumentChangeset["changes"][number]["status"];
export type Tombstone = Type.Static<typeof TombstoneSchema>;
type DocumentNode = { id: string } & Record<string, unknown>;

const changesetSchema = Schema.Compile(DocumentChangesetSchema);
const tombstonesSchema = Schema.Compile(TombstonesSchema);
const nodeTypes: NodeType[] = ["section", "unit", "sentence", "atom", "block"];

function invalid(message: string): never {
  throw new Error(`文档 changeset 无效：${message}`);
}

function uniqueNodeIds(entries: Array<{ nodeId: string }>, description: string) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.nodeId)) invalid(`${description}包含重复节点 ID：${entry.nodeId}。`);
    ids.add(entry.nodeId);
  }
  return ids;
}

export function parseDocumentChangeset(value: unknown): DocumentChangeset {
  if (!changesetSchema.Check(value)) invalid("不符合 changesetFormatVersion: 1 schema。");
  if (value.baseRevision === value.revisionId) invalid("baseRevision 与 revisionId 不能相同。");
  uniqueNodeIds(value.changes, "变化记录");
  return value;
}

function currentNodeIds(tree: DocumentTree) {
  return new Set([
    ...Object.keys(tree.sections),
    ...Object.keys(tree.units),
    ...Object.keys(tree.sentences),
    ...Object.keys(tree.atoms),
    ...tree.blocks.map((block) => block.id),
  ]);
}

export function parseDocumentTombstones(
  value: unknown,
  current?: DocumentTree,
): Tombstone[] {
  if (!tombstonesSchema.Check(value)) invalid("tombstones 不符合运行时 schema。");
  const retired = uniqueNodeIds(value, "tombstones");
  if (current) {
    for (const id of currentNodeIds(current)) {
      if (retired.has(id)) invalid(`退役 ID 不得在当前文档中复用：${id}。`);
    }
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function nodes(tree: DocumentTree, nodeType: NodeType): DocumentNode[] {
  switch (nodeType) {
    case "section": return Object.values(tree.sections);
    case "unit": return Object.values(tree.units);
    case "sentence": return Object.values(tree.sentences);
    case "atom": return Object.values(tree.atoms);
    case "block": return tree.blocks;
  }
}

function contentFingerprint(node: DocumentNode, nodeType: NodeType) {
  const excluded = new Set(["id"]);
  if (nodeType === "section") {
    excluded.add("parentSectionId");
    excluded.add("childSectionIds");
    excluded.add("unitIds");
  } else if (nodeType === "unit") {
    excluded.add("sectionId");
    excluded.add("sentenceIds");
  } else if (nodeType === "sentence" || nodeType === "atom") excluded.add("unitId");
  else excluded.add("sectionId");
  return canonical(Object.fromEntries(
    Object.entries(node).filter(([key]) => !excluded.has(key)),
  ));
}

function structureFingerprint(
  node: DocumentNode,
  nodeType: NodeType,
  blockIndex: number,
  sentenceIndex: number,
) {
  if (nodeType === "section") return canonical({
    parentSectionId: node.parentSectionId,
    childSectionIds: node.childSectionIds,
    unitIds: node.unitIds,
  });
  if (nodeType === "unit") return canonical({
    sectionId: node.sectionId,
    sentenceIds: node.sentenceIds,
  });
  // 句子在父 unit 内的阅读位置属于结构事实：仅重排也应记录 moved（SPEC §9）。
  if (nodeType === "sentence") return canonical({ unitId: node.unitId, index: sentenceIndex });
  if (nodeType === "atom") return canonical({ unitId: node.unitId });
  return canonical({ sectionId: node.sectionId, index: blockIndex });
}

function sentenceIndexes(tree: DocumentTree | null): Map<string, number> {
  const indexes = new Map<string, number>();
  if (!tree) return indexes;
  for (const unit of Object.values(tree.units))
    unit.sentenceIds.forEach((sentenceId, index) => indexes.set(sentenceId, index));
  return indexes;
}

function sameMembers(base: unknown, current: unknown) {
  if (!Array.isArray(base) || !Array.isArray(current) || base.length !== current.length) return false;
  const remaining = new Set(base);
  for (const id of current) {
    if (!remaining.delete(id)) return false;
  }
  return remaining.size === 0;
}

function membershipChanged(base: DocumentNode, current: DocumentNode, nodeType: NodeType) {
  if (nodeType === "section") return !sameMembers(base.childSectionIds, current.childSectionIds) ||
    !sameMembers(base.unitIds, current.unitIds);
  if (nodeType === "unit") return !sameMembers(base.sentenceIds, current.sentenceIds);
  return false;
}

function changeStatus(
  nodeType: NodeType,
  base: DocumentNode | undefined,
  current: DocumentNode | undefined,
  baseBlockIndex: number,
  currentBlockIndex: number,
  baseSentenceIndex: number,
  currentSentenceIndex: number,
): ChangeStatus {
  if (!base && current) return "added";
  if (base && !current) return "removed";
  if (!base || !current) throw new Error("变化节点必须至少出现在一棵树中。");
  if (contentFingerprint(base, nodeType) !== contentFingerprint(current, nodeType)) return "changed";
  if (structureFingerprint(base, nodeType, baseBlockIndex, baseSentenceIndex) !==
    structureFingerprint(current, nodeType, currentBlockIndex, currentSentenceIndex))
    return membershipChanged(base, current, nodeType) ? "changed" : "moved";
  return "retained";
}

export function createDocumentChangeset(input: {
  base: DocumentTree | null;
  current: DocumentTree;
  baseRevision: string | null;
  revisionId: string;
}): DocumentChangeset {
  if ((input.base === null) !== (input.baseRevision === null))
    invalid("base 树与 baseRevision 必须同时为空或同时提供。");
  if (input.base && input.base.paperId !== input.current.paperId)
    invalid("base 与 current 的 paperId 不一致。");
  const changes: DocumentChangeset["changes"] = [];
  const baseBlockIndexes = new Map(input.base?.blocks.map((block, index) => [block.id, index]));
  const currentBlockIndexes = new Map(input.current.blocks.map((block, index) => [block.id, index]));
  const baseSentenceIndexes = sentenceIndexes(input.base);
  const currentSentenceIndexes = sentenceIndexes(input.current);
  for (const nodeType of nodeTypes) {
    const baseNodes = new Map(input.base ? nodes(input.base, nodeType).map((node) => [node.id, node]) : []);
    const currentNodes = new Map(nodes(input.current, nodeType).map((node) => [node.id, node]));
    const ids = new Set([...baseNodes.keys(), ...currentNodes.keys()]);
    for (const nodeId of [...ids].sort()) {
      changes.push({
        nodeType,
        nodeId,
        status: changeStatus(
          nodeType,
          baseNodes.get(nodeId),
          currentNodes.get(nodeId),
          baseBlockIndexes.get(nodeId) ?? -1,
          currentBlockIndexes.get(nodeId) ?? -1,
          baseSentenceIndexes.get(nodeId) ?? -1,
          currentSentenceIndexes.get(nodeId) ?? -1,
        ),
      });
    }
  }
  return parseDocumentChangeset({
    changesetFormatVersion: 1,
    baseRevision: input.baseRevision,
    revisionId: input.revisionId,
    changes,
  });
}

function unitExcerpt(tree: DocumentTree, unitId: string) {
  const unit = tree.units[unitId];
  return unit ? unit.sentenceIds.map((id) => projectSentenceText(tree, id)).join("\n") : "";
}

function nodeExcerpt(tree: DocumentTree, nodeType: NodeType, nodeId: string) {
  if (nodeType === "section") return tree.sections[nodeId]?.title ?? "";
  if (nodeType === "unit") return unitExcerpt(tree, nodeId);
  if (nodeType === "sentence") return projectSentenceText(tree, nodeId);
  if (nodeType === "atom") return tree.atoms[nodeId]?.text ?? "";
  const block = tree.blocks.find((candidate) => candidate.id === nodeId);
  if (!block) return "";
  if (block.kind === "unit") return unitExcerpt(tree, block.unitId);
  if (block.kind === "figure")
    return block.captionUnitId ? unitExcerpt(tree, block.captionUnitId) : block.warning ?? block.asset?.path ?? "";
  if (block.kind === "table") {
    const unitIds = [
      ...(block.captionUnitId ? [block.captionUnitId] : []),
      ...block.rows.flat().map((cell) => cell.unitId),
    ];
    return unitIds.map((id) => unitExcerpt(tree, id)).join("\n");
  }
  return block.text;
}

function excerpt(text: string) {
  return Array.from(text).slice(0, 500).join("");
}

/** 节点内容指纹（与 changeset changed 判定同一口径）：排除结构引用，只含内容字段。 */
export function documentNodeContentFingerprint(
  tree: DocumentTree,
  nodeType: NodeType,
  nodeId: string,
): string {
  const node = nodes(tree, nodeType).find((candidate) => candidate.id === nodeId)
    ?? invalid(`节点不存在：${nodeType}/${nodeId}。`);
  return contentFingerprint(node, nodeType);
}

/** 节点可读文本摘录（上限 500 码点），供核验 quote 与 tombstone 共用口径。 */
export function documentNodeExcerpt(
  tree: DocumentTree,
  nodeType: NodeType,
  nodeId: string,
): string {
  return excerpt(nodeExcerpt(tree, nodeType, nodeId));
}

export function appendRemovedTombstones(
  base: DocumentTree,
  value: DocumentChangeset,
  previous: Tombstone[] = [],
): Tombstone[] {
  const changeset = parseDocumentChangeset(value);
  const tombstones = [...parseDocumentTombstones(previous)];
  const baseNodes = new Map(nodeTypes.map((nodeType) => [
    nodeType,
    new Map(nodes(base, nodeType).map((node) => [node.id, node])),
  ]));
  for (const entry of changeset.changes) {
    if (entry.status !== "removed") continue;
    if (!changeset.baseRevision) invalid("removed 记录需要非空 baseRevision 以标记最后出现 revision。");
    if (!baseNodes.get(entry.nodeType)?.has(entry.nodeId))
      invalid(`removed 节点不在 base 树中：${entry.nodeId}。`);
    tombstones.push({
      nodeType: entry.nodeType,
      nodeId: entry.nodeId,
      lastRevision: changeset.baseRevision,
      excerpt: excerpt(nodeExcerpt(base, entry.nodeType, entry.nodeId)),
      reason: "removed",
    });
  }
  return parseDocumentTombstones(tombstones);
}

export function deriveAnchorState(
  tree: DocumentTree,
  value: DocumentChangeset,
  anchor: unknown,
): "fresh" | "stale" | "invalid" | "missing" {
  const changeset = parseDocumentChangeset(value);
  const changes = new Map(changeset.changes.map((entry) => [entry.nodeId, entry.status]));
  const statuses = documentAnchorDependencies(tree, anchor).map((dependency) => {
    const status = changes.get(dependency.nodeId);
    if (!status) invalid(`changeset 缺少锚点依赖记录：${dependency.nodeType}/${dependency.nodeId}。`);
    return status;
  });
  if (statuses.some((status) => status === "removed" || status === "conflicted")) return "invalid";
  if (statuses.some((status) => status === "changed")) return "stale";
  if (statuses.some((status) => status === "added")) return "missing";
  return "fresh";
}
