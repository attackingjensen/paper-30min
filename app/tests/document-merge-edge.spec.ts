import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { projectSentenceText } from "../src/shared/document/anchor";
import {
  appendRemovedTombstones,
  createDocumentChangeset,
} from "../src/shared/document/changeset";
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

function removeSecondUnit(tree: DocumentTree) {
  delete tree.units[selectionIds.secondUnit];
  delete tree.sentences[selectionIds.thirdSentence];
  tree.sections[selectionIds.section].unitIds = [selectionIds.unit];
  tree.blocks = tree.blocks.filter((block) => block.id !== selectionIds.secondBlock);
}

function locallyDeletedFixture() {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  removeSecondUnit(current);
  const ids = revisions();
  const previousTombstones = appendRemovedTombstones(
    base,
    createDocumentChangeset({ base, current, ...ids }),
  );
  return { base, current, previousTombstones };
}

function addSecondSection(tree: DocumentTree) {
  const secondSection = randomUUID();
  tree.sections[secondSection] = {
    id: secondSection,
    parentSectionId: null,
    title: "Second section",
    childSectionIds: [],
    unitIds: [],
  };
  return secondSection;
}

function addSectionUnit(tree: DocumentTree, sectionId: string) {
  const unitId = randomUUID();
  const sentenceId = randomUUID();
  const blockId = randomUUID();
  tree.units[unitId] = {
    id: unitId,
    sectionId,
    kind: "paragraph",
    sentenceIds: [sentenceId],
  };
  tree.sentences[sentenceId] = {
    id: sentenceId,
    unitId,
    content: [{ kind: "text", text: "Independent second section content." }],
  };
  tree.sections[sectionId].unitIds.push(unitId);
  tree.blocks.push({ id: blockId, sectionId, kind: "unit", unitId });
}

function moveSecondUnit(tree: DocumentTree, sectionId: string) {
  tree.sections[selectionIds.section].unitIds = [selectionIds.unit];
  tree.sections[sectionId].unitIds = [selectionIds.secondUnit];
  tree.units[selectionIds.secondUnit].sectionId = sectionId;
  const block = tree.blocks.find((candidate) => candidate.id === selectionIds.secondBlock);
  if (!block) throw new Error("fixture 缺少第二阅读块");
  block.sectionId = sectionId;
}

test("document-core 本地删除 tombstone 不误伤仍合法包含节点的 source-base", () => {
  const { base, current, previousTombstones } = locallyDeletedFixture();
  const candidate = structuredClone(base);

  const result = mergeDocumentTrees({
    base,
    current,
    candidate,
    previousTombstones,
    ...revisions(),
  });

  expect(result.conflicts).toEqual([]);
  expect(result.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(result.sourceBase.units[selectionIds.secondUnit]).toBeDefined();
  expect(result.tombstones).toEqual(previousTombstones);
});

test("document-core 显式恢复已本地删除的同一逻辑单元时撤销对应退役记录", () => {
  const { base, current, previousTombstones } = locallyDeletedFixture();
  const candidate = structuredClone(base);
  candidate.sentences[selectionIds.thirdSentence].content = [{ kind: "text", text: "source restore" }];
  const unresolved = mergeDocumentTrees({
    base,
    current,
    candidate,
    previousTombstones,
    ...revisions(),
  });

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  expect(projectSentenceText(resolved.document, selectionIds.thirdSentence)).toBe("source restore");
  expect(resolved.tombstones.some((entry) => entry.nodeId === selectionIds.secondUnit)).toBe(false);
  expect(resolved.tombstones.some((entry) => entry.nodeId === selectionIds.thirdSentence)).toBe(false);
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 父章节删除与子单元保留产生 structure 冲突，不静默改挂其他章节", () => {
  const base = testSelectionTree(randomUUID());
  const secondSection = addSecondSection(base);
  moveSecondUnit(base, secondSection);
  const current = structuredClone(base);
  current.sentences[selectionIds.thirdSentence].content = [{ kind: "text", text: "local edit" }];
  const candidate = structuredClone(base);
  removeSecondUnit(candidate);
  delete candidate.sections[secondSection];

  const unresolved = mergeDocumentTrees({ base, current, candidate, ...revisions() });
  expect(unresolved.conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "deletion" }),
    expect.objectContaining({ type: "structure" }),
  ]));
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision))
    .toThrow(/未解决|冲突/);

  let resolved = resolveDocumentMergeConflict(unresolved, `unit:${selectionIds.secondUnit}`, "current");
  resolved = resolveDocumentMergeConflict(resolved, `unit-parent:${selectionIds.secondUnit}`, "current");
  expect(resolved.document.units[selectionIds.secondUnit].sectionId).toBe(secondSection);
  expect(resolved.document.sections[secondSection]).toBeDefined();
  expect(resolved.document.units[selectionIds.secondUnit].sectionId).not.toBe(selectionIds.section);
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 重复句子更换 ID 不把未修改来源误判为 content 冲突", () => {
  const base = testSelectionTree(randomUUID());
  delete base.atoms[selectionIds.atom];
  base.sentences[selectionIds.sentence].content = [{ kind: "text", text: "duplicate" }];
  base.sentences[selectionIds.secondSentence].content = [{ kind: "text", text: "duplicate" }];
  const current = structuredClone(base);
  current.sentences[selectionIds.secondSentence].content = [{ kind: "text", text: "local edit" }];
  const candidate = structuredClone(base);
  const firstNewSentenceId = randomUUID();
  const secondNewSentenceId = randomUUID();
  delete candidate.sentences[selectionIds.sentence];
  delete candidate.sentences[selectionIds.secondSentence];
  candidate.sentences[firstNewSentenceId] = {
    id: firstNewSentenceId,
    unitId: selectionIds.unit,
    content: [{ kind: "text", text: "duplicate" }],
  };
  candidate.sentences[secondNewSentenceId] = {
    id: secondNewSentenceId,
    unitId: selectionIds.unit,
    content: [{ kind: "text", text: "duplicate" }],
  };
  candidate.units[selectionIds.unit].sentenceIds = [firstNewSentenceId, secondNewSentenceId];

  const result = mergeDocumentTrees({ base, current, candidate, ...revisions() });

  expect(result.conflicts).toEqual([]);
  expect(projectSentenceText(result.document, selectionIds.secondSentence)).toBe("local edit");
});

test("document-core 唯一内容跨节可靠移动保留稳定 ID 与本地修正", () => {
  const base = testSelectionTree(randomUUID());
  const secondSection = addSecondSection(base);
  addSectionUnit(base, secondSection);
  const current = structuredClone(base);
  current.sentences[selectionIds.thirdSentence].content = [{ kind: "text", text: "local move" }];
  const candidate = structuredClone(base);
  const newUnitId = randomUUID();
  const unit = candidate.units[selectionIds.secondUnit];
  delete candidate.units[selectionIds.secondUnit];
  unit.id = newUnitId;
  candidate.units[newUnitId] = unit;
  candidate.sentences[selectionIds.thirdSentence].unitId = newUnitId;
  const block = candidate.blocks.find((candidateBlock) => candidateBlock.id === selectionIds.secondBlock);
  if (block?.kind !== "unit") throw new Error("fixture 阅读块类型错误");
  block.unitId = newUnitId;
  candidate.sections[selectionIds.section].unitIds = [selectionIds.unit];
  candidate.sections[secondSection].unitIds = [
    newUnitId,
    ...candidate.sections[secondSection].unitIds,
  ];
  unit.sectionId = secondSection;
  block.sectionId = secondSection;

  const result = mergeDocumentTrees({ base, current, candidate, ...revisions() });

  expect(result.conflicts).toEqual([]);
  expect(result.document.units[newUnitId]).toBeUndefined();
  expect(result.document.units[selectionIds.secondUnit].sectionId).toBe(secondSection);
  expect(projectSentenceText(result.document, selectionIds.thirdSentence)).toBe("local move");
});
