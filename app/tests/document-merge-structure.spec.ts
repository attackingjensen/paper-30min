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

const extraIds = {
  unit: "00000000-0000-4000-8000-000000000010",
  sentence: "00000000-0000-4000-8000-000000000011",
  block: "00000000-0000-4000-8000-000000000012",
  figureBlock: "00000000-0000-4000-8000-000000000013",
} as const;

function revisions() {
  return { baseRevision: randomUUID(), revisionId: randomUUID() };
}

function merge(base: DocumentTree, current: DocumentTree, candidate: DocumentTree) {
  return mergeDocumentTrees({ base, current, candidate, ...revisions() });
}

function addThirdUnit(tree: DocumentTree, text = "Third unit.") {
  tree.units[extraIds.unit] = {
    id: extraIds.unit,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [extraIds.sentence],
  };
  tree.sentences[extraIds.sentence] = {
    id: extraIds.sentence,
    unitId: extraIds.unit,
    content: [{ kind: "text", text }],
  };
  tree.sections[selectionIds.section].unitIds.push(extraIds.unit);
  tree.blocks.push({
    id: extraIds.block,
    sectionId: selectionIds.section,
    kind: "unit",
    unitId: extraIds.unit,
  });
}

function reorderUnits(tree: DocumentTree, unitIds: string[]) {
  tree.sections[selectionIds.section].unitIds = unitIds;
  const blocks = new Map(tree.blocks.map((block) => [block.kind === "unit" ? block.unitId : block.id, block]));
  tree.blocks = unitIds.map((unitId) => {
    const block = blocks.get(unitId);
    if (!block) throw new Error(`缺少单元阅读块：${unitId}`);
    return block;
  });
}

function setFirstTrailingText(tree: DocumentTree, text: string) {
  const content = tree.sentences[selectionIds.sentence].content;
  const last = content.at(-1);
  if (last?.kind !== "text") throw new Error("fixture 末尾不是文本");
  last.text = text;
}

function setThirdSentence(tree: DocumentTree, text: string) {
  tree.sentences[selectionIds.thirdSentence].content = [{ kind: "text", text }];
}

function remapSecondUnit(tree: DocumentTree, newUnitId: string) {
  const unit = tree.units[selectionIds.secondUnit];
  delete tree.units[selectionIds.secondUnit];
  unit.id = newUnitId;
  tree.units[newUnitId] = unit;
  tree.sections[selectionIds.section].unitIds = tree.sections[selectionIds.section].unitIds.map((id) =>
    id === selectionIds.secondUnit ? newUnitId : id,
  );
  tree.sentences[selectionIds.thirdSentence].unitId = newUnitId;
  const block = tree.blocks.find((candidate) => candidate.id === selectionIds.secondBlock);
  if (block?.kind !== "unit") throw new Error("fixture 阅读块类型错误");
  block.unitId = newUnitId;
}

test("document-core 双方以不同方式重排时产生 structure/order 冲突并显式解决", () => {
  const base = testSelectionTree(randomUUID());
  addThirdUnit(base);
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  reorderUnits(current, [selectionIds.secondUnit, selectionIds.unit, extraIds.unit]);
  reorderUnits(candidate, [selectionIds.unit, extraIds.unit, selectionIds.secondUnit]);

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts.map((conflict) => conflict.type)).toEqual(expect.arrayContaining(["structure", "order"]));
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision)).toThrow(/未解决|冲突/);

  let resolved = unresolved;
  for (const conflict of unresolved.conflicts)
    resolved = resolveDocumentMergeConflict(resolved, conflict.id, "candidate");
  expect(resolved.document.sections[selectionIds.section].unitIds).toEqual([
    selectionIds.unit,
    extraIds.unit,
    selectionIds.secondUnit,
  ]);
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 双方替换不同资产时产生 asset 冲突，不做二进制自动合并", () => {
  const base = testSelectionTree(randomUUID());
  const baseHash = "1".repeat(64);
  base.blocks.push({
    id: extraIds.figureBlock,
    sectionId: selectionIds.section,
    kind: "figure",
    asset: { path: `assets/${baseHash}.png`, sha256: baseHash, mime: "image/png" },
    captionUnitId: null,
  });
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  const currentHash = "2".repeat(64);
  const candidateHash = "3".repeat(64);
  const currentFigure = current.blocks.find((block) => block.id === extraIds.figureBlock);
  const candidateFigure = candidate.blocks.find((block) => block.id === extraIds.figureBlock);
  if (currentFigure?.kind !== "figure" || candidateFigure?.kind !== "figure") throw new Error("fixture 图片块类型错误");
  currentFigure.asset = { path: `assets/${currentHash}.png`, sha256: currentHash, mime: "image/png" };
  candidateFigure.asset = { path: `assets/${candidateHash}.png`, sha256: candidateHash, mime: "image/png" };

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts).toHaveLength(1);
  expect(unresolved.conflicts[0].type).toBe("asset");

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  const figure = resolved.document.blocks.find((block) => block.id === extraIds.figureBlock);
  expect(figure?.kind === "figure" ? figure.asset?.sha256 : null).toBe(candidateHash);
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 对齐使用一致 source alias，并在来源更新时保留本地 unit 修正", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["source-unit-2"];
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  setThirdSentence(current, "local edit");
  setFirstTrailingText(candidate, " source edit");
  const candidateUnitId = randomUUID();
  remapSecondUnit(candidate, candidateUnitId);

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  expect(result.document.units[candidateUnitId]).toBeUndefined();
  expect(projectSentenceText(result.document, selectionIds.sentence)).toBe("Dr. 3.14 source edit");
  expect(projectSentenceText(result.document, selectionIds.thirdSentence)).toBe("local edit");
  expect(projectSentenceText(result.sourceBase, selectionIds.sentence)).toBe("Dr. 3.14 source edit");
  expect(projectSentenceText(result.sourceBase, selectionIds.thirdSentence)).toBe("Next unit.");
  expect(result.sourceBase.units[candidateUnitId]).toBeUndefined();
});

test("document-core 唯一规范内容结合父级上下文可以对齐，重复文本不得仅凭内容继承 ID", () => {
  const base = testSelectionTree(randomUUID());
  addThirdUnit(base, "Third unique unit.");
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  const uniqueUnitId = randomUUID();
  remapSecondUnit(candidate, uniqueUnitId);

  const aligned = merge(base, current, candidate);
  expect(aligned.sourceBase.units[selectionIds.secondUnit]).toBeDefined();
  expect(aligned.sourceBase.units[uniqueUnitId]).toBeUndefined();

  const duplicateBase = testSelectionTree(randomUUID());
  addThirdUnit(duplicateBase, "Next unit.");
  const duplicateCurrent = structuredClone(duplicateBase);
  const duplicateCandidate = structuredClone(duplicateBase);
  const duplicateUnitId = randomUUID();
  const thirdUnitId = randomUUID();
  remapSecondUnit(duplicateCandidate, duplicateUnitId);
  const third = duplicateCandidate.units[extraIds.unit];
  delete duplicateCandidate.units[extraIds.unit];
  third.id = thirdUnitId;
  duplicateCandidate.units[thirdUnitId] = third;
  duplicateCandidate.sentences[extraIds.sentence].unitId = thirdUnitId;
  duplicateCandidate.sections[selectionIds.section].unitIds = duplicateCandidate.sections[
    selectionIds.section
  ].unitIds.map((id) => (id === extraIds.unit ? thirdUnitId : id));
  const thirdBlock = duplicateCandidate.blocks.find((block) => block.id === extraIds.block);
  if (thirdBlock?.kind !== "unit") throw new Error("fixture 阅读块类型错误");
  thirdBlock.unitId = thirdUnitId;
  const ambiguous = merge(duplicateBase, duplicateCurrent, duplicateCandidate);

  expect(ambiguous.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(ambiguous.document.units[extraIds.unit]).toBeUndefined();
  expect(ambiguous.document.units[duplicateUnitId]).toBeDefined();
  expect(ambiguous.document.units[thirdUnitId]).toBeDefined();
});

test("document-core 多轮来源更新后本地修正仍能与新 source-base 区分", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const firstCandidate = structuredClone(base);
  setFirstTrailingText(current, " local edit");
  setThirdSentence(firstCandidate, "source v2");
  const first = merge(base, current, firstCandidate);

  const secondCandidate = structuredClone(first.sourceBase);
  setThirdSentence(secondCandidate, "source v3");
  const second = mergeDocumentTrees({
    base: first.sourceBase,
    current: first.document,
    candidate: secondCandidate,
    ...revisions(),
  });

  expect(second.conflicts).toEqual([]);
  expect(second.document.sentences[selectionIds.sentence].content.at(-1)).toEqual({
    kind: "text",
    text: " local edit",
  });
  expect(projectSentenceText(second.document, selectionIds.thirdSentence)).toBe("source v3");
  expect(second.sourceBase.sentences[selectionIds.sentence].content.at(-1)).not.toEqual({
    kind: "text",
    text: " local edit",
  });
  expect(projectSentenceText(second.sourceBase, selectionIds.thirdSentence)).toBe("source v3");
});

test("document-core 合并候选基线已变化时禁止发布", () => {
  const base = testSelectionTree(randomUUID());
  const result = merge(base, structuredClone(base), structuredClone(base));

  expect(() => assertDocumentMergePublishable(result, randomUUID())).toThrow(/baseRevision|current/);
});
