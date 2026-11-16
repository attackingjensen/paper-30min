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
