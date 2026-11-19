import type { DocumentAnchor } from "./anchor.js";
import {
  appendRemovedTombstones,
  createDocumentChangeset,
  parseDocumentTombstones,
  type DocumentChangeset,
  type Tombstone,
} from "./changeset.js";
import { parseDocumentTree, type DocumentTree } from "./tree.js";

type Side = "current" | "candidate";
type MergeChoice = Side;
type ConflictType = "content" | "deletion" | "order" | "structure" | "asset";
type MergeConflict = {
  id: string;
  type: ConflictType;
  anchors: DocumentAnchor[];
  base: unknown;
  current: unknown;
  candidate: unknown;
};
type Selection<T> = { side: Side | null; value: T | null };

export interface DocumentMergeResult {
  baseRevision: string;
  revisionId: string;
  base: DocumentTree;
  current: DocumentTree;
  sourceBase: DocumentTree;
  document: DocumentTree;
  changeset: DocumentChangeset;
  tombstones: Tombstone[];
  previousTombstones: Tombstone[];
  conflicts: MergeConflict[];
  resolutions: Record<string, MergeChoice>;
}

type UnitSelection = { side: Side; unitId: string };
type SectionSelection = { side: Side; value: DocumentTree["sections"][string] };
type BlockSelection = { side: Side; value: DocumentTree["blocks"][number] };

function invalid(message: string): never {
  throw new Error(`三方合并无效：${message}`);
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

function equal(left: unknown, right: unknown) {
  return canonical(left) === canonical(right);
}

function unitSnapshot(tree: DocumentTree, unitId: string) {
  const unit = tree.units[unitId];
  if (!unit) return null;
  return {
    id: unit.id,
    kind: unit.kind,
    sourceAliases: unit.sourceAliases,
    sentences: unit.sentenceIds.map((sentenceId) => {
      const sentence = tree.sentences[sentenceId];
      return {
        content: sentenceContent(tree, sentenceId),
        sourceAliases: sentence.sourceAliases,
      };
    }).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    atoms: Object.values(tree.atoms)
      .filter((atom) => atom.unitId === unitId)
      .sort((a, b) => canonical(atomContent(a)).localeCompare(canonical(atomContent(b))))
      .map(atomContent),
  };
}

function blockUnits(block: DocumentTree["blocks"][number]) {
  switch (block.kind) {
    case "unit": return [block.unitId];
    case "figure": return block.captionUnitId ? [block.captionUnitId] : [];
    case "table": return [
      ...(block.captionUnitId ? [block.captionUnitId] : []),
      ...block.rows.flat().map((cell) => cell.unitId),
    ];
    default: return [];
  }
}

function insertByOrder(order: string[], id: string, preferred: string[]) {
  if (order.includes(id)) return;
  const index = preferred.indexOf(id);
  if (index >= 0) {
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const existing = order.indexOf(preferred[cursor]);
      if (existing >= 0) {
        order.splice(existing + 1, 0, id);
        return;
      }
    }
    for (let cursor = index + 1; cursor < preferred.length; cursor++) {
      const existing = order.indexOf(preferred[cursor]);
      if (existing >= 0) {
        order.splice(existing, 0, id);
        return;
      }
    }
  }
  order.push(id);
}

function conflictAnchorsForUnit(unitId: string): DocumentAnchor[] {
  return [{ kind: "unit", unitId }];
}

type NodeKind = "section" | "unit" | "sentence" | "atom" | "block";
type DocumentNode = { id: string; sourceAliases?: string[] } & Record<string, unknown>;

function nodes(tree: DocumentTree, kind: NodeKind): DocumentNode[] {
  switch (kind) {
    case "section": return Object.values(tree.sections);
    case "unit": return Object.values(tree.units);
    case "sentence": return Object.values(tree.sentences);
    case "atom": return Object.values(tree.atoms);
    case "block": return tree.blocks;
  }
}

function atomContent(atom: DocumentTree["atoms"][string]) {
  const { id: _id, unitId: _unitId, sourceAliases: _aliases, ...content } = atom;
  return content;
}

function sentenceContent(tree: DocumentTree, sentenceId: string): unknown {
  const sentence = tree.sentences[sentenceId];
  return sentence.content.map((part) => part.kind === "text"
    ? part
    : { kind: "atom", content: atomContent(tree.atoms[part.atomId]) });
}

function unitContent(tree: DocumentTree, unitId: string): unknown {
  const unit = tree.units[unitId];
  return {
    kind: unit.kind,
    sentences: unit.sentenceIds.map((sentenceId) => sentenceContent(tree, sentenceId)),
  };
}

function alignmentContent(tree: DocumentTree, kind: NodeKind, node: DocumentNode): unknown {
  if (kind === "section") return { title: node.title };
  if (kind === "unit") return unitContent(tree, node.id);
  if (kind === "sentence") return sentenceContent(tree, node.id);
  if (kind === "atom") return atomContent(tree.atoms[node.id]);
  const block = tree.blocks.find((candidate) => candidate.id === node.id)!;
  if (block.kind === "unit") return { kind: block.kind, content: unitContent(tree, block.unitId) };
  if (block.kind === "figure") return {
    kind: block.kind,
    asset: block.asset,
    warning: block.warning,
    caption: block.captionUnitId ? unitContent(tree, block.captionUnitId) : null,
  };
  if (block.kind === "table") return {
    kind: block.kind,
    caption: block.captionUnitId ? unitContent(tree, block.captionUnitId) : null,
    rows: block.rows.map((row) => row.map((cell) => ({
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      content: unitContent(tree, cell.unitId),
    }))),
  };
  const { id: _id, sectionId: _sectionId, sourceAliases: _aliases, ...content } = block;
  return content;
}

function parentId(node: DocumentNode, kind: NodeKind) {
  if (kind === "section") return (node.parentSectionId as string | null) ?? null;
  if (kind === "unit" || kind === "block") return node.sectionId as string;
  return node.unitId as string;
}

function orderedIds(tree: DocumentTree, kind: NodeKind, parent: string): string[] {
  if (kind === "unit") return tree.sections[parent]?.unitIds ?? [];
  if (kind === "sentence") return tree.units[parent]?.sentenceIds ?? [];
  if (kind === "atom") return (tree.units[parent]?.sentenceIds ?? []).flatMap((sentenceId) =>
    tree.sentences[sentenceId].content.flatMap((part) => part.kind === "atom" ? [part.atomId] : []));
  if (kind === "block") return tree.blocks.filter((block) => block.sectionId === parent).map((block) => block.id);
  return [];
}

function remapCandidateIds(candidate: DocumentTree, mapping: Map<string, string>) {
  const mapped = structuredClone(candidate);
  const id = (value: string) => mapping.get(value) ?? value;
  const nullableId = (value: string | null) => value === null ? null : id(value);
  mapped.sections = Object.fromEntries(Object.values(candidate.sections).map((section) => {
    const next = {
      ...structuredClone(section),
      id: id(section.id),
      parentSectionId: nullableId(section.parentSectionId),
      childSectionIds: section.childSectionIds.map(id),
      unitIds: section.unitIds.map(id),
    };
    return [next.id, next];
  }));
  mapped.units = Object.fromEntries(Object.values(candidate.units).map((unit) => {
    const next = {
      ...structuredClone(unit),
      id: id(unit.id),
      sectionId: id(unit.sectionId),
      sentenceIds: unit.sentenceIds.map(id),
    };
    return [next.id, next];
  }));
  mapped.sentences = Object.fromEntries(Object.values(candidate.sentences).map((sentence) => {
    const next = {
      ...structuredClone(sentence),
      id: id(sentence.id),
      unitId: id(sentence.unitId),
      content: sentence.content.map((part) => part.kind === "text"
        ? structuredClone(part)
        : { kind: "atom" as const, atomId: id(part.atomId) }),
    };
    return [next.id, next];
  }));
  mapped.atoms = Object.fromEntries(Object.values(candidate.atoms).map((atom) => {
    const next = { ...structuredClone(atom), id: id(atom.id), unitId: id(atom.unitId) };
    if ((next.kind === "cross-reference" || next.kind === "footnote-reference" || next.kind === "citation") && next.targetUnitId)
      next.targetUnitId = id(next.targetUnitId);
    return [next.id, next];
  }));
  mapped.blocks = candidate.blocks.map((block) => {
    const next = { ...structuredClone(block), id: id(block.id), sectionId: id(block.sectionId) };
    if (next.kind === "unit") next.unitId = id(next.unitId);
    if ((next.kind === "figure" || next.kind === "table") && next.captionUnitId)
      next.captionUnitId = id(next.captionUnitId);
    if (next.kind === "table") next.rows = next.rows.map((row) => row.map((cell) => ({
      ...cell,
      unitId: id(cell.unitId),
    })));
    return next;
  });
  return mapped;
}

function alignCandidateTree(base: DocumentTree, value: DocumentTree) {
  const candidate = parseDocumentTree(structuredClone(value));
  const mapping = new Map<string, string>();
  const usedBaseIds = new Set<string>();
  // 句子 anchor 资格：只有 ID 同一或 alias 唯一匹配产生的对齐可作位置延续的边界
  // 证据；内容分组／文本投影配对不升级为 anchor，避免保留句配对自举串 ID。
  const structuralSentencePairs = new Set<string>();
  const kinds: NodeKind[] = ["section", "unit", "sentence", "atom", "block"];
  for (const kind of kinds) {
    const baseIds = new Set(nodes(base, kind).map((node) => node.id));
    for (const node of nodes(candidate, kind)) {
      if (!baseIds.has(node.id) || usedBaseIds.has(node.id)) continue;
      mapping.set(node.id, node.id);
      usedBaseIds.add(node.id);
      if (kind === "sentence") structuralSentencePairs.add(node.id);
    }
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    // 反向映射（base ID → candidate ID）：避免每个父节点全量扫描 mapping。
    const reverse = new Map<string, string>();
    for (const [candidateId, baseId] of mapping) reverse.set(baseId, candidateId);
    // 句子边界证据快照：只含结构性对齐（ID 同一／alias 唯一匹配）；内容分组／
    // 文本投影配对不升级为 anchor，防止「保留句配对→自举 anchor→被删句按位置
    // 串 ID」跨轮自举。
    const sentenceAnchorsAtStart = new Map(
      [...mapping].filter(([candidateId]) => structuralSentencePairs.has(candidateId)),
    );
    for (const kind of kinds) {
      const baseNodes = nodes(base, kind).filter((node) => !usedBaseIds.has(node.id));
      const candidateNodes = nodes(candidate, kind).filter((node) => !mapping.has(node.id));
      const tryMap = (baseNode: DocumentNode, candidateNode: DocumentNode) => {
        if (usedBaseIds.has(baseNode.id) || mapping.has(candidateNode.id)) return false;
        mapping.set(candidateNode.id, baseNode.id);
        usedBaseIds.add(baseNode.id);
        progressed = true;
        return true;
      };

      for (const candidateNode of candidateNodes) {
        const aliases = new Set(candidateNode.sourceAliases ?? []);
        if (!aliases.size) continue;
        const matches = baseNodes.filter((baseNode) =>
          (baseNode.sourceAliases ?? []).some((alias) => aliases.has(alias)));
        if (matches.length === 1) {
          const reverseMatches = candidateNodes.filter((other) =>
            (other.sourceAliases ?? []).some((alias) =>
              (matches[0].sourceAliases ?? []).includes(alias)));
          if (reverseMatches.length === 1 && tryMap(matches[0], candidateNode) && kind === "sentence")
            structuralSentencePairs.add(candidateNode.id);
        }
      }

      const groups = new Map<string, { base: DocumentNode[]; candidate: DocumentNode[] }>();
      const remainingBase = nodes(base, kind).filter((node) => !usedBaseIds.has(node.id));
      const remainingCandidate = nodes(candidate, kind).filter((node) => !mapping.has(node.id));
      const add = (side: "base" | "candidate", node: DocumentNode, tree: DocumentTree) => {
        const parent = parentId(node, kind);
        const mappedParent = parent === null ? null : side === "candidate" ? mapping.get(parent) : parent;
        if (parent !== null && (side === "base" ? !usedBaseIds.has(parent) : !mappedParent)) return;
        const key = `${mappedParent ?? "<root>"}:${canonical(alignmentContent(tree, kind, node))}`;
        const group = groups.get(key) ?? { base: [], candidate: [] };
        group[side].push(node);
        groups.set(key, group);
      };
      for (const node of remainingBase) add("base", node, base);
      for (const node of remainingCandidate) add("candidate", node, candidate);
      for (const group of groups.values()) {
        if (group.base.length === 1 && group.candidate.length === 1)
          tryMap(group.base[0], group.candidate[0]);
      }

      const globalGroups = new Map<string, { base: DocumentNode[]; candidate: DocumentNode[] }>();
      for (const node of nodes(base, kind).filter((candidateNode) => !usedBaseIds.has(candidateNode.id))) {
        const key = canonical(alignmentContent(base, kind, node));
        const group = globalGroups.get(key) ?? { base: [], candidate: [] };
        group.base.push(node);
        globalGroups.set(key, group);
      }
      for (const node of nodes(candidate, kind).filter((candidateNode) => !mapping.has(candidateNode.id))) {
        const key = canonical(alignmentContent(candidate, kind, node));
        const group = globalGroups.get(key) ?? { base: [], candidate: [] };
        group.candidate.push(node);
        globalGroups.set(key, group);
      }
      for (const group of globalGroups.values()) {
        if (group.base.length !== 1 || group.candidate.length !== 1) continue;
        const baseParent = parentId(group.base[0], kind);
        const candidateParent = parentId(group.candidate[0], kind);
        const baseContextKnown = baseParent === null || usedBaseIds.has(baseParent);
        const candidateContextKnown = candidateParent === null || mapping.has(candidateParent);
        if (baseContextKnown && candidateContextKnown) tryMap(group.base[0], group.candidate[0]);
      }

      // 已对齐 unit 内的句子延续稳定 ID（SPEC-pdf-import §8.3）：确定性重转换会为
      // 句子重新分配 UUID，延续使来源修正成为 changed 而非删除＋新增。边界证据只认
      // 句子处理开始前已存在的对齐（ID 同一或 alias 唯一匹配）；本轮文本配对与内容
      // 分组产生的对齐不升级为 anchor，避免「保留句配对→自举 anchor→被删句按位置
      // 串 ID」。无 anchor 时仅整 unit 单句对单句延续；拼接／划分／无证据的等长重排
      // 不延续，交由 tombstone 规则处理。
      if (kind === "sentence") {
        const anchored = (baseId: string, candidateId: string) =>
          sentenceAnchorsAtStart.get(candidateId) === baseId;
        const sentenceProjection = (tree: DocumentTree, sentenceId: string) =>
          tree.sentences[sentenceId].content
            .map((part) => part.kind === "text" ? part.text : tree.atoms[part.atomId].text)
            .join("");
        const boundaryKept = (
          baseOrder: string[],
          candidateOrder: string[],
          baseStart: number,
          baseEnd: number,
          candidateStart: number,
          candidateEnd: number,
        ) => {
          const leftOk = baseStart === 0
            ? candidateStart === 0
            : candidateStart > 0 && anchored(baseOrder[baseStart - 1], candidateOrder[candidateStart - 1]);
          const rightOk = baseEnd === baseOrder.length
            ? candidateEnd === candidateOrder.length
            : candidateEnd < candidateOrder.length && anchored(baseOrder[baseEnd], candidateOrder[candidateEnd]);
          return leftOk && rightOk;
        };
        // 边界重组检测：候选句投影等于多个 base 句投影拼接（合并），或多个候选句
        // 投影拼接等于一个 base 句投影（拆分）。出现即说明该段不是 1:1 延续。
        const boundaryRestructured = (baseIds: string[], candidateIds: string[]) => {
          const baseTexts = baseIds.map((id) => sentenceProjection(base, id));
          const candidateTexts = candidateIds.map((id) => sentenceProjection(candidate, id));
          for (const text of candidateTexts) {
            for (let start = 0; start < baseTexts.length; start++) {
              let joined = "";
              for (let end = start; end < baseTexts.length; end++) {
                joined += baseTexts[end];
                if (joined === text && end > start) return true;
                if (joined.length > text.length) break;
              }
            }
          }
          for (const text of baseTexts) {
            for (let start = 0; start < candidateTexts.length; start++) {
              let joined = "";
              for (let end = start; end < candidateTexts.length; end++) {
                joined += candidateTexts[end];
                if (joined === text && end > start) return true;
                if (joined.length > text.length) break;
              }
            }
          }
          return false;
        };
        for (const unit of nodes(base, "unit")) {
          const candidateUnitId = reverse.get(unit.id);
          if (!candidateUnitId) continue;
          const baseOrder = orderedIds(base, "sentence", unit.id);
          const candidateOrder = orderedIds(candidate, "sentence", candidateUnitId);
          if (!baseOrder.length || !candidateOrder.length) continue;
          const pair = (baseId: string, candidateId: string) => {
            if (usedBaseIds.has(baseId) || mapping.has(candidateId)) return;
            tryMap(base.sentences[baseId], candidate.sentences[candidateId]);
          };
          // anchor 只认句子处理开始前已对齐的句子（见 sentenceAnchorsAtStart）。
          const anchoredAtStart = (baseId: string, candidateId: string) =>
            sentenceAnchorsAtStart.get(candidateId) === baseId;
          // 先按文本证据配对：候选句投影恰等于唯一 base 句投影且对应唯一才延续。
          // 这一步不依赖数量相等，删除＋插入同数量时保留句延续、被删句 tombstone。
          const baseByProjection = new Map<string, string[]>();
          for (const baseId of baseOrder) {
            if (usedBaseIds.has(baseId)) continue;
            const key = sentenceProjection(base, baseId);
            const group = baseByProjection.get(key) ?? [];
            group.push(baseId);
            baseByProjection.set(key, group);
          }
          const matchesByBase = new Map<string, number>();
          const candidateMatches: Array<{ baseId: string; candidateId: string }> = [];
          for (const candidateId of candidateOrder) {
            if (mapping.has(candidateId)) continue;
            const group = baseByProjection.get(sentenceProjection(candidate, candidateId));
            if (!group || group.length !== 1) continue;
            const baseId = group[0];
            matchesByBase.set(baseId, (matchesByBase.get(baseId) ?? 0) + 1);
            candidateMatches.push({ baseId, candidateId });
          }
          for (const { baseId, candidateId } of candidateMatches)
            if (matchesByBase.get(baseId) === 1) pair(baseId, candidateId);
          // 位置延续只认结构性 anchor（ID 同一／alias 唯一）作边界证据：相邻 anchor
          // 之间数量一致的段按位置 1:1，段内不得出现拼接／划分。无 anchor 时仅整 unit
          // 单句对单句延续（数量本身即 1:1 证据）；多句等长重排不延续，交由 tombstone。
          const hasAnchor = baseOrder.some((baseId, index) => anchoredAtStart(baseId, candidateOrder[index]));
          if (!hasAnchor) {
            if (
              baseOrder.length === 1 && candidateOrder.length === 1 &&
              !usedBaseIds.has(baseOrder[0]) && !mapping.has(candidateOrder[0]) &&
              !boundaryRestructured(baseOrder, candidateOrder)
            )
              pair(baseOrder[0], candidateOrder[0]);
            continue;
          }
          let baseStart = 0;
          let candidateStart = 0;
          while (baseStart < baseOrder.length || candidateStart < candidateOrder.length) {
            if (
              baseStart < baseOrder.length && candidateStart < candidateOrder.length &&
              anchoredAtStart(baseOrder[baseStart], candidateOrder[candidateStart])
            ) {
              baseStart += 1;
              candidateStart += 1;
              continue;
            }
            let baseEnd = baseStart;
            while (baseEnd < baseOrder.length &&
              !(candidateStart < candidateOrder.length && anchoredAtStart(baseOrder[baseEnd], candidateOrder[candidateStart])))
              baseEnd += 1;
            let candidateEnd = candidateStart;
            while (candidateEnd < candidateOrder.length &&
              !(baseEnd < baseOrder.length && anchoredAtStart(baseOrder[baseEnd], candidateOrder[candidateEnd])))
              candidateEnd += 1;
            const baseCount = baseEnd - baseStart;
            const candidateCount = candidateEnd - candidateStart;
            if (
              baseCount > 0 && baseCount === candidateCount &&
              boundaryKept(baseOrder, candidateOrder, baseStart, baseEnd, candidateStart, candidateEnd) &&
              !boundaryRestructured(
                baseOrder.slice(baseStart, baseEnd),
                candidateOrder.slice(candidateStart, candidateEnd),
              )
            ) {
              for (let offset = 0; offset < baseCount; offset++)
                pair(baseOrder[baseStart + offset], candidateOrder[candidateStart + offset]);
            }
            // 无边界保持证据的段不延续；推进到下一段，避免死循环。
            if (baseEnd === baseStart && candidateEnd === candidateStart) {
              baseStart += 1;
              candidateStart += 1;
            } else {
              baseStart = baseEnd;
              candidateStart = candidateEnd;
            }
          }
        }
      }

      for (const baseParent of nodes(base, kind === "section" ? "section" : kind === "unit" || kind === "block" ? "section" : "unit")) {
        const candidateParentId = reverse.get(baseParent.id);
        if (!candidateParentId) continue;
        const baseOrder = orderedIds(base, kind, baseParent.id);
        const candidateOrder = orderedIds(candidate, kind, candidateParentId);
        if (!baseOrder.length || baseOrder.length !== candidateOrder.length) continue;
        const unmatched = new Map<string, Array<{ base: DocumentNode; candidate: DocumentNode }>>();
        for (let index = 0; index < baseOrder.length; index++) {
          const baseId = baseOrder[index];
          const candidateId = candidateOrder[index];
          if (mapping.get(candidateId) === baseId) continue;
          const baseNode = nodes(base, kind).find((node) => node.id === baseId);
          const candidateNode = nodes(candidate, kind).find((node) => node.id === candidateId);
          if (!baseNode || !candidateNode || usedBaseIds.has(baseId) || mapping.has(candidateId)) {
            unmatched.clear();
            break;
          }
          const key = canonical(alignmentContent(base, kind, baseNode));
          if (key !== canonical(alignmentContent(candidate, kind, candidateNode))) {
            unmatched.clear();
            break;
          }
          const pairs = unmatched.get(key) ?? [];
          pairs.push({ base: baseNode, candidate: candidateNode });
          unmatched.set(key, pairs);
        }
        for (const pairs of unmatched.values()) {
          if (pairs.length === 1) tryMap(pairs[0].base, pairs[0].candidate);
        }
      }
    }
  }
  return parseDocumentTree(remapCandidateIds(candidate, mapping));
}

function chooseThreeWay<T>(input: {
  base: T | null;
  current: T | null;
  candidate: T | null;
  conflictId: string;
  conflictType: ConflictType;
  anchors: DocumentAnchor[];
  resolutions: Record<string, MergeChoice>;
  conflicts: MergeConflict[];
}): Selection<T> {
  const { base, current, candidate, resolutions } = input;
  const resolve = (type: ConflictType): Selection<T> => {
    input.conflicts.push({
      id: input.conflictId,
      type,
      anchors: input.anchors,
      base,
      current,
      candidate,
    });
    const side = resolutions[input.conflictId] ?? "current";
    if (side !== "current" && side !== "candidate") invalid(`冲突解决方式无效：${input.conflictId}。`);
    return { side, value: side === "current" ? current : candidate };
  };
  if (base !== null) {
    if (current !== null && candidate !== null) {
      if (equal(candidate, base) || equal(current, candidate)) return { side: "current", value: current };
      if (equal(current, base)) return { side: "candidate", value: candidate };
      return resolve(input.conflictType);
    }
    if (current !== null) {
      if (equal(current, base)) return { side: "candidate", value: null };
      return resolve("deletion");
    }
    if (candidate !== null) {
      if (equal(candidate, base)) return { side: "current", value: null };
      return resolve("deletion");
    }
    return { side: null, value: null };
  }
  if (current !== null && candidate !== null && !equal(current, candidate))
    return resolve(input.conflictType);
  if (current !== null) return { side: "current", value: current };
  if (candidate !== null) return { side: "candidate", value: candidate };
  return { side: null, value: null };
}

function copyUnit(tree: DocumentTree, unitId: string, target: DocumentTree) {
  const unit = structuredClone(tree.units[unitId]);
  target.units[unitId] = unit;
  for (const sentenceId of unit.sentenceIds) {
    target.sentences[sentenceId] = structuredClone(tree.sentences[sentenceId]);
  }
  for (const atom of Object.values(tree.atoms)) {
    if (atom.unitId === unitId) target.atoms[atom.id] = structuredClone(atom);
  }
}

function removeCopiedUnit(target: DocumentTree, unitId: string) {
  const unit = target.units[unitId];
  if (!unit) return;
  for (const sentenceId of unit.sentenceIds) delete target.sentences[sentenceId];
  for (const atom of Object.values(target.atoms))
    if (atom.unitId === unitId) delete target.atoms[atom.id];
  delete target.units[unitId];
}

function restoreSection(
  source: DocumentTree,
  sectionId: string,
  side: Side,
  target: DocumentTree,
  selections: Map<string, SectionSelection>,
) {
  if (target.sections[sectionId]) return;
  const section = source.sections[sectionId];
  if (!section) return;
  if (section.parentSectionId)
    restoreSection(source, section.parentSectionId, side, target, selections);
  selections.set(sectionId, { side, value: structuredClone(section) });
  target.sections[sectionId] = {
    ...structuredClone(section),
    childSectionIds: [],
    unitIds: [],
  };
}

function relatedConflictIds(
  conflict: MergeConflict,
  trees: DocumentTree[],
) {
  const ids = new Set<string>();
  for (const anchor of conflict.anchors) {
    if (anchor.kind === "section") ids.add(anchor.sectionId);
    if (anchor.kind === "unit") {
      ids.add(anchor.unitId);
      for (const tree of trees) {
        const unit = tree.units[anchor.unitId];
        if (!unit) continue;
        for (const sentenceId of unit.sentenceIds) {
          ids.add(sentenceId);
          for (const part of tree.sentences[sentenceId].content)
            if (part.kind === "atom") ids.add(part.atomId);
        }
        for (const block of tree.blocks)
          if (blockUnits(block).includes(anchor.unitId)) ids.add(block.id);
      }
    }
    if (anchor.kind === "sentence") ids.add(anchor.sentenceId);
    if (anchor.kind === "atom") ids.add(anchor.atomId);
    if (anchor.kind === "block") ids.add(anchor.blockId);
  }
  return ids;
}

function buildMergedTree(
  base: DocumentTree,
  current: DocumentTree,
  candidate: DocumentTree,
  resolutions: Record<string, MergeChoice>,
  conflicts: MergeConflict[],
) {
  const merged: DocumentTree = {
    documentFormatVersion: 1,
    paperId: current.paperId,
    sections: {},
    units: {},
    sentences: {},
    atoms: {},
    blocks: [],
  };
  const unitSelections = new Map<string, UnitSelection>();
  const unitIds = new Set([
    ...Object.keys(base.units),
    ...Object.keys(current.units),
    ...Object.keys(candidate.units),
  ]);
  for (const unitId of [...unitIds].sort()) {
    const selected = chooseThreeWay({
      base: unitSnapshot(base, unitId),
      current: unitSnapshot(current, unitId),
      candidate: unitSnapshot(candidate, unitId),
      conflictId: `unit:${unitId}`,
      conflictType: "content",
      anchors: conflictAnchorsForUnit(unitId),
      resolutions,
      conflicts,
    });
    if (!selected.side) continue;
    const tree = selected.side === "current" ? current : candidate;
    if (!tree.units[unitId]) continue;
    unitSelections.set(unitId, { side: selected.side, unitId });
    copyUnit(tree, unitId, merged);
  }

  const sectionSelections = new Map<string, SectionSelection>();
  const sectionIds = new Set([
    ...Object.keys(base.sections),
    ...Object.keys(current.sections),
    ...Object.keys(candidate.sections),
  ]);
  for (const sectionId of [...sectionIds].sort()) {
    const selected = chooseThreeWay({
      base: base.sections[sectionId] ?? null,
      current: current.sections[sectionId] ?? null,
      candidate: candidate.sections[sectionId] ?? null,
      conflictId: `section:${sectionId}`,
      conflictType: "structure",
      anchors: [{ kind: "section", sectionId }],
      resolutions,
      conflicts,
    });
    if (!selected.side || !selected.value) continue;
    sectionSelections.set(sectionId, { side: selected.side, value: selected.value });
    merged.sections[sectionId] = {
      ...structuredClone(selected.value),
      childSectionIds: [],
      unitIds: [],
    };
  }

  const parentSelections = new Map<string, { side: Side; value: string }>();
  for (const [unitId, selected] of [...unitSelections]) {
    const source = selected.side === "current" ? current : candidate;
    const baseParent = base.units[unitId]?.sectionId ?? null;
    const currentParent = current.units[unitId]?.sectionId ?? null;
    const candidateParent = candidate.units[unitId]?.sectionId ?? null;
    let side = selected.side;
    let preferred = source.units[unitId].sectionId;
    const conflictId = `unit-parent:${unitId}`;
    const addConflict = () => {
      if (conflicts.some((conflict) => conflict.id === conflictId)) return;
      conflicts.push({
        id: conflictId,
        type: "structure",
        anchors: [
          { kind: "unit", unitId },
          ...(baseParent ? [{ kind: "section", sectionId: baseParent } as DocumentAnchor] : []),
        ],
        base: baseParent,
        current: currentParent,
        candidate: candidateParent,
      });
    };
    if (current.units[unitId] && candidate.units[unitId]) {
      if (currentParent === baseParent && candidateParent) {
        side = "candidate";
        preferred = candidateParent;
      } else if (candidateParent === baseParent || currentParent === candidateParent) {
        side = "current";
        preferred = currentParent!;
      } else {
        addConflict();
        side = resolutions[conflictId] ?? "current";
        preferred = (side === "current" ? currentParent : candidateParent)!;
      }
    }
    if (!merged.sections[preferred]) {
      addConflict();
      side = resolutions[conflictId] ?? "current";
      if (side !== "current" && side !== "candidate") invalid(`父级冲突解决方式无效：${conflictId}。`);
      const chosen = side === "current" ? current : candidate;
      const chosenParent = chosen.units[unitId]?.sectionId ?? null;
      if (chosenParent && chosen.sections[chosenParent]) {
        restoreSection(chosen, chosenParent, side, merged, sectionSelections);
        preferred = chosenParent;
      } else {
        removeCopiedUnit(merged, unitId);
        unitSelections.delete(unitId);
        continue;
      }
    }
    parentSelections.set(unitId, { side, value: preferred });
  }

  const fallbackSection = Object.keys(merged.sections).sort()[0];
  if (!fallbackSection) invalid("合并结果没有可保留的章节，不能形成可阅读正文。");
  for (const [sectionId, section] of Object.entries(merged.sections)) {
    const selected = sectionSelections.get(sectionId)!;
    const parent = selected.value.parentSectionId;
    section.parentSectionId = parent && merged.sections[parent] ? parent : null;
    if (!section.parentSectionId && !fallbackSection) invalid("合并结果缺少根章节。");
  }
  for (const [sectionId, selected] of sectionSelections) {
    const section = merged.sections[sectionId];
    const preferred = selected.value.childSectionIds.filter((id) => merged.sections[id]);
    section.childSectionIds = preferred.filter((id) => merged.sections[id].parentSectionId === sectionId);
    for (const childId of Object.keys(merged.sections)) {
      if (merged.sections[childId].parentSectionId === sectionId)
        insertByOrder(section.childSectionIds, childId, preferred);
    }
  }

  for (const [unitId] of unitSelections) {
    const preferred = parentSelections.get(unitId)!.value;
    if (!merged.sections[preferred]) invalid(`单元 ${unitId} 的父章节解决结果不存在。`);
    merged.units[unitId].sectionId = preferred;
  }

  const blockSelections = new Map<string, BlockSelection>();
  const blockIds = new Set([
    ...base.blocks.map((block) => block.id),
    ...current.blocks.map((block) => block.id),
    ...candidate.blocks.map((block) => block.id),
  ]);
  for (const blockId of [...blockIds].sort()) {
    const baseBlock = base.blocks.find((block) => block.id === blockId) ?? null;
    const currentBlock = current.blocks.find((block) => block.id === blockId) ?? null;
    const candidateBlock = candidate.blocks.find((block) => block.id === blockId) ?? null;
    const selected = chooseThreeWay({
      base: baseBlock,
      current: currentBlock,
      candidate: candidateBlock,
      conflictId: `block:${blockId}`,
      conflictType: baseBlock?.kind === "figure" ? "asset" : "structure",
      anchors: [{ kind: "block", blockId }],
      resolutions,
      conflicts,
    });
    if (!selected.side || !selected.value) continue;
    blockSelections.set(blockId, { side: selected.side, value: selected.value });
  }

  const order = chooseThreeWay({
    base: base.blocks.map((block) => block.id),
    current: current.blocks.map((block) => block.id),
    candidate: candidate.blocks.map((block) => block.id),
    conflictId: "blocks:order",
    conflictType: "order",
    anchors: [...blockIds].sort().map((blockId) => ({ kind: "block", blockId }) as DocumentAnchor),
    resolutions,
    conflicts,
  });
  const blockOrder = (order.value ?? []).filter((id) => blockSelections.has(id));

  for (const [unitId, selected] of unitSelections) {
    if ([...blockSelections.values()].some((block) => blockUnits(block.value).includes(unitId))) continue;
    const source = selected.side === "current" ? current : candidate;
    const block = source.blocks.find((candidateBlock) => blockUnits(candidateBlock).includes(unitId));
    if (block) blockSelections.set(block.id, { side: selected.side, value: structuredClone(block) });
  }
  for (const [blockId, selected] of [...blockSelections]) {
    const required = selected.value.kind === "unit" ? [selected.value.unitId] : [];
    if (required.some((unitId) => !merged.units[unitId])) blockSelections.delete(blockId);
  }
  for (const [blockId, selected] of blockSelections) insertByOrder(
    blockOrder,
    blockId,
    (selected.side === "current" ? current : candidate).blocks.map((block) => block.id),
  );

  for (const blockId of blockOrder) {
    const selected = blockSelections.get(blockId);
    if (!selected) continue;
    const block = structuredClone(selected.value);
    const units = blockUnits(block).filter((unitId) => merged.units[unitId]);
    if (block.kind === "figure" && block.captionUnitId && !merged.units[block.captionUnitId])
      block.captionUnitId = null;
    if (block.kind === "table") {
      block.rows = block.rows.map((row) => row.filter((cell) => merged.units[cell.unitId]))
        .filter((row) => row.length);
    }
    block.sectionId = units.length
      ? merged.units[units[0]].sectionId
      : merged.sections[block.sectionId]
        ? block.sectionId
        : fallbackSection;
    merged.blocks.push(block);
  }
  for (const section of Object.values(merged.sections)) section.unitIds = [];
  for (const block of merged.blocks) {
    const section = merged.sections[block.sectionId];
    if (!section) invalid(`合并阅读块缺少章节：${block.id}。`);
    for (const unitId of blockUnits(block)) {
      if (!section.unitIds.includes(unitId)) section.unitIds.push(unitId);
      merged.units[unitId].sectionId = section.id;
    }
  }
  return parseDocumentTree(merged);
}

export function mergeDocumentTrees(input: {
  base: DocumentTree;
  current: DocumentTree;
  candidate: DocumentTree;
  baseRevision: string;
  revisionId: string;
  previousTombstones?: Tombstone[];
  resolutions?: Record<string, MergeChoice>;
}): DocumentMergeResult {
  const base = parseDocumentTree(structuredClone(input.base));
  const current = parseDocumentTree(structuredClone(input.current));
  const sourceBase = alignCandidateTree(base, input.candidate);
  if (base.paperId !== current.paperId || current.paperId !== sourceBase.paperId)
    invalid("base、current 与 candidate 的 paperId 必须一致。");
  const previousTombstones = parseDocumentTombstones(input.previousTombstones ?? [], current);
  const resolutions = { ...input.resolutions };
  const conflicts: MergeConflict[] = [];
  const document = buildMergedTree(base, current, sourceBase, resolutions, conflicts);
  const changeset = createDocumentChangeset({
    base: current,
    current: document,
    baseRevision: input.baseRevision,
    revisionId: input.revisionId,
  });
  for (const conflict of conflicts) {
    if (resolutions[conflict.id]) continue;
    const ids = relatedConflictIds(conflict, [base, current, sourceBase]);
    for (const entry of changeset.changes)
      if (ids.has(entry.nodeId)) entry.status = "conflicted";
  }
  const restored = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.type === "deletion" && resolutions[conflict.id] === "candidate" &&
      conflict.current === null && conflict.candidate !== null) {
      for (const id of relatedConflictIds(conflict, [base, current, sourceBase])) restored.add(id);
    }
  }
  const inheritedTombstones = previousTombstones.filter((entry) => !restored.has(entry.nodeId));
  const tombstones = parseDocumentTombstones(
    appendRemovedTombstones(current, changeset, inheritedTombstones),
    document,
  );
  return {
    baseRevision: input.baseRevision,
    revisionId: input.revisionId,
    base,
    current,
    sourceBase,
    document,
    changeset,
    tombstones,
    previousTombstones,
    conflicts,
    resolutions,
  };
}

export function resolveDocumentMergeConflict(
  result: DocumentMergeResult,
  conflictId: string,
  choice: MergeChoice,
): DocumentMergeResult {
  if (!result.conflicts.some((conflict) => conflict.id === conflictId))
    invalid(`合并冲突不存在：${conflictId}。`);
  if (choice !== "current" && choice !== "candidate") invalid("冲突解决必须显式选择 current 或 candidate。");
  return mergeDocumentTrees({
    base: result.base,
    current: result.current,
    candidate: result.sourceBase,
    baseRevision: result.baseRevision,
    revisionId: result.revisionId,
    previousTombstones: result.previousTombstones,
    resolutions: { ...result.resolutions, [conflictId]: choice },
  });
}

export function assertDocumentMergePublishable(
  result: DocumentMergeResult,
  currentRevision: string,
) {
  if (result.baseRevision !== currentRevision)
    invalid(`baseRevision 已变化：候选基线为 ${result.baseRevision}，current 为 ${currentRevision}。`);
  const unresolved = result.conflicts.filter((conflict) => !result.resolutions[conflict.id]);
  if (unresolved.length)
    invalid(`仍有 ${unresolved.length} 个未解决冲突，不能发布：${unresolved.map((conflict) => `${conflict.id}（${conflict.type}）`).join("、")}。`);
  if (result.changeset.changes.some((entry) => entry.status === "conflicted"))
    invalid("changeset 仍包含 conflicted 节点，不能发布。");
  parseDocumentTree(result.document);
  parseDocumentTree(result.sourceBase);
  parseDocumentTombstones(result.tombstones, result.document);
}
