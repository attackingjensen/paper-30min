import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { projectSentenceText } from "../src/shared/document/anchor";
import {
  assertDocumentMergePublishable,
  mergeDocumentTrees,
  resolveDocumentMergeConflict,
} from "../src/shared/document/merge";
import type { DocumentTree } from "../src/shared/document/tree";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

function revisions() {
  return { baseRevision: randomUUID(), revisionId: randomUUID() };
}

function setThirdSentence(tree: DocumentTree, text: string) {
  tree.sentences[selectionIds.thirdSentence].content = [{ kind: "text", text }];
}

function removeSecondUnit(tree: DocumentTree) {
  delete tree.units[selectionIds.secondUnit];
  delete tree.sentences[selectionIds.thirdSentence];
  tree.sections[selectionIds.section].unitIds = [selectionIds.unit];
  tree.blocks = tree.blocks.filter((block) => block.id !== selectionIds.secondBlock);
}

function merge(base: DocumentTree, current: DocumentTree, candidate: DocumentTree) {
  return mergeDocumentTrees({ base, current, candidate, ...revisions() });
}

test("document-core 三方合并 current 等于 base 时采用 candidate 并更新 source-base", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  setThirdSentence(candidate, "source edit");

  const result = merge(base, current, candidate);

  expect(projectSentenceText(result.document, selectionIds.thirdSentence)).toBe("source edit");
  expect(result.sourceBase).toEqual(candidate);
  expect(result.conflicts).toEqual([]);
});

test("document-core 三方合并 candidate 等于 base 时保留 current 本地修正", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  setThirdSentence(current, "local edit");

  const result = merge(base, current, candidate);

  expect(projectSentenceText(result.document, selectionIds.thirdSentence)).toBe("local edit");
  expect(result.sourceBase).toEqual(candidate);
  expect(result.conflicts).toEqual([]);
});

test("document-core 三方合并双方作出相同修改时不生成冲突", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  setThirdSentence(current, "same edit");
  setThirdSentence(candidate, "same edit");

  const result = merge(base, current, candidate);

  expect(projectSentenceText(result.document, selectionIds.thirdSentence)).toBe("same edit");
  expect(result.conflicts).toEqual([]);
});

test("document-core 同一 unit 被双方不同修改时生成 content 冲突并要求显式解决", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  setThirdSentence(current, "local edit");
  setThirdSentence(candidate, "source edit");

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts).toHaveLength(1);
  expect(unresolved.conflicts[0]).toMatchObject({
    type: "content",
    anchors: [{ kind: "unit", unitId: selectionIds.secondUnit }],
  });
  expect(unresolved.conflicts[0].base).toBeDefined();
  expect(unresolved.conflicts[0].current).toBeDefined();
  expect(unresolved.conflicts[0].candidate).toBeDefined();
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision))
    .toThrow(/未解决|冲突/);

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "current");
  expect(projectSentenceText(resolved.document, selectionIds.thirdSentence)).toBe("local edit");
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core candidate 删除未本地修改 unit 时接受删除并建立 tombstone", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  removeSecondUnit(candidate);

  const result = merge(base, current, candidate);

  expect(result.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(result.conflicts).toEqual([]);
  expect(result.tombstones).toContainEqual(expect.objectContaining({
    nodeType: "unit",
    nodeId: selectionIds.secondUnit,
    lastRevision: result.baseRevision,
  }));
});

test("document-core candidate 删除已本地修改 unit 时生成 deletion 冲突，可采用删除", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  setThirdSentence(current, "local edit");
  removeSecondUnit(candidate);

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts).toHaveLength(1);
  expect(unresolved.conflicts[0].type).toBe("deletion");
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision))
    .toThrow(/未解决|冲突/);

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  expect(resolved.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(resolved.tombstones).toContainEqual(expect.objectContaining({
    nodeType: "unit",
    nodeId: selectionIds.secondUnit,
  }));
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core current 本地删除且 candidate 未变时保留本地删除", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  removeSecondUnit(current);

  const result = merge(base, current, candidate);

  expect(result.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(result.conflicts).toEqual([]);
});

test("document-core current 本地删除而 candidate 修改 unit 时生成 deletion 冲突，可恢复 candidate", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  removeSecondUnit(current);
  setThirdSentence(candidate, "source edit");

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts).toHaveLength(1);
  expect(unresolved.conflicts[0].type).toBe("deletion");

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  expect(projectSentenceText(resolved.document, selectionIds.thirdSentence)).toBe("source edit");
  expect(resolved.document.units[selectionIds.secondUnit].sectionId).toBe(selectionIds.section);
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 候选书目单元经 alias 对齐后 citation 目标随之重映射，不产生悬空引用", () => {
  const paperId = randomUUID();
  const base = testSelectionTree(paperId);
  // base 含书目单元（稳定 ID + alias）与指向它的已解析 citation。
  const baseBibUnit = randomUUID();
  const baseBibSentence = randomUUID();
  const baseCiteAtom = randomUUID();
  base.units[baseBibUnit] = {
    id: baseBibUnit,
    sectionId: selectionIds.section,
    kind: "reference",
    sentenceIds: [baseBibSentence],
    sourceAliases: ["bib.bib1"],
  };
  base.sentences[baseBibSentence] = {
    id: baseBibSentence,
    unitId: baseBibUnit,
    content: [{ kind: "text", text: "Author, A. (2020). A study." }],
  };
  base.sections[selectionIds.section].unitIds.push(baseBibUnit);
  base.blocks.push({ id: randomUUID(), sectionId: selectionIds.section, kind: "unit", unitId: baseBibUnit });
  base.atoms[baseCiteAtom] = {
    id: baseCiteAtom,
    unitId: selectionIds.unit,
    kind: "citation",
    text: "[1]",
    targetUnitId: baseBibUnit,
    sourceAliases: ["bib.bib1"],
  };
  base.sentences[selectionIds.sentence].content.push({ kind: "atom", atomId: baseCiteAtom });

  const current = structuredClone(base);
  // candidate 重新转换：书目单元与 citation 都是新 UUID，仅 alias 相同。
  const candidate = structuredClone(base);
  const newBibUnit = randomUUID();
  const newBibSentence = randomUUID();
  const newCiteAtom = randomUUID();
  delete candidate.units[baseBibUnit];
  delete candidate.sentences[baseBibSentence];
  delete candidate.atoms[baseCiteAtom];
  candidate.sections[selectionIds.section].unitIds =
    candidate.sections[selectionIds.section].unitIds.map((id) => id === baseBibUnit ? newBibUnit : id);
  candidate.blocks = candidate.blocks.map((block) =>
    block.kind === "unit" && block.unitId === baseBibUnit ? { ...block, unitId: newBibUnit } : block);
  candidate.units[newBibUnit] = {
    id: newBibUnit,
    sectionId: selectionIds.section,
    kind: "reference",
    sentenceIds: [newBibSentence],
    sourceAliases: ["bib.bib1"],
  };
  candidate.sentences[newBibSentence] = {
    id: newBibSentence,
    unitId: newBibUnit,
    content: [{ kind: "text", text: "Author, A. (2020). A study." }],
  };
  candidate.atoms[newCiteAtom] = {
    id: newCiteAtom,
    unitId: selectionIds.unit,
    kind: "citation",
    text: "[1]",
    targetUnitId: newBibUnit,
    sourceAliases: ["bib.bib1"],
  };
  candidate.sentences[selectionIds.sentence].content =
    candidate.sentences[selectionIds.sentence].content.map((part) =>
      part.kind === "atom" && part.atomId === baseCiteAtom ? { kind: "atom", atomId: newCiteAtom } : part);

  const result = merge(base, current, candidate);
  expect(result.conflicts).toEqual([]);
  // citation 目标必须重映射到 base 书目单元 ID，而不是残留 candidate UUID。
  const mergedCite = Object.values(result.document.atoms).find((atom) => atom.kind === "citation");
  expect(mergedCite).toBeDefined();
  if (mergedCite?.kind !== "citation") throw new Error("citation missing");
  expect(mergedCite.targetUnitId).toBe(baseBibUnit);
  expect(result.document.units[baseBibUnit]).toBeDefined();
  expect(() => assertDocumentMergePublishable(result, result.baseRevision)).not.toThrow();
});
