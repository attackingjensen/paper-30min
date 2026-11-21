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
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision)).toThrow(/未解决|冲突/);

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
  expect(result.tombstones).toContainEqual(
    expect.objectContaining({
      nodeType: "unit",
      nodeId: selectionIds.secondUnit,
      lastRevision: result.baseRevision,
    }),
  );
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
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision)).toThrow(/未解决|冲突/);

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  expect(resolved.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(resolved.tombstones).toContainEqual(
    expect.objectContaining({
      nodeType: "unit",
      nodeId: selectionIds.secondUnit,
    }),
  );
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
  candidate.sections[selectionIds.section].unitIds = candidate.sections[selectionIds.section].unitIds.map((id) =>
    id === baseBibUnit ? newBibUnit : id,
  );
  candidate.blocks = candidate.blocks.map((block) =>
    block.kind === "unit" && block.unitId === baseBibUnit ? { ...block, unitId: newBibUnit } : block,
  );
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
  candidate.sentences[selectionIds.sentence].content = candidate.sentences[selectionIds.sentence].content.map((part) =>
    part.kind === "atom" && part.atomId === baseCiteAtom ? { kind: "atom", atomId: newCiteAtom } : part,
  );

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

/** 模拟确定性转换器重跑：unit 经 source alias 对齐，但句子是新分配的 UUID。 */
function reconvertedSecondUnit(base: DocumentTree, text: string): DocumentTree {
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const newSentenceId = randomUUID();
  delete candidate.sentences[selectionIds.thirdSentence];
  candidate.sentences[newSentenceId] = {
    id: newSentenceId,
    unitId: selectionIds.secondUnit,
    content: [{ kind: "text", text }],
  };
  candidate.units[selectionIds.secondUnit].sentenceIds = [newSentenceId];
  return candidate;
}

test("document-core 重解析对齐 unit 后句子延续稳定 ID：来源修正成为 changed 而非删除新增", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const current = structuredClone(base);
  const candidate = reconvertedSecondUnit(base, "Next unit revised.");

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  expect(projectSentenceText(result.document, selectionIds.thirdSentence)).toBe("Next unit revised.");
  const sentenceChange = result.changeset.changes.find(
    (entry) => entry.nodeType === "sentence" && entry.nodeId === selectionIds.thirdSentence,
  );
  expect(sentenceChange?.status).toBe("changed");
  expect(result.changeset.changes.some((entry) => entry.nodeType === "sentence" && entry.status === "added")).toBe(
    false,
  );
});

/** 句子重排的候选：unit 经 alias 对齐，句子沿用同一 ID 但顺序颠倒。 */
function reorderedSecondUnit(base: DocumentTree): DocumentTree {
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const order = base.units[selectionIds.secondUnit].sentenceIds;
  candidate.units[selectionIds.secondUnit].sentenceIds = [...order].reverse();
  return candidate;
}

test("document-core 来源重排 unit 内句子对三方合并可见：无本地修改时采用来源新顺序", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  reissueSentences(base, selectionIds.secondUnit, ["Alpha first.", "Beta second."]);
  const current = structuredClone(base);
  const candidate = reorderedSecondUnit(base);

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  expect(result.document.units[selectionIds.secondUnit].sentenceIds).toEqual(
    candidate.units[selectionIds.secondUnit].sentenceIds,
  );
  const unitChange = result.changeset.changes.find(
    (entry) => entry.nodeType === "unit" && entry.nodeId === selectionIds.secondUnit,
  );
  expect(unitChange?.status).toBe("moved");
  // 换位的句子本身也记录 moved（阅读位置是结构事实），不得仍是 retained。
  for (const sentenceId of base.units[selectionIds.secondUnit].sentenceIds) {
    expect(
      result.changeset.changes.find((entry) => entry.nodeType === "sentence" && entry.nodeId === sentenceId)?.status,
    ).toBe("moved");
  }
  expect(result.changeset.changes.some((entry) => entry.status === "added" || entry.status === "removed")).toBe(false);
});

test("document-core 本地重排与来源重排方向不同时生成 unit 冲突，显式解决前不可发布", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  reissueSentences(base, selectionIds.secondUnit, ["Alpha first.", "Beta second.", "Gamma third."]);
  const [a, b, c] = base.units[selectionIds.secondUnit].sentenceIds;
  // 三句保证 base、current、candidate 顺序两两不同：本地与来源都重排但方向不同。
  const current = structuredClone(base);
  current.units[selectionIds.secondUnit].sentenceIds = [b, a, c];
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  candidate.units[selectionIds.secondUnit].sentenceIds = [c, b, a];

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts).toHaveLength(1);
  expect(unresolved.conflicts[0]).toMatchObject({
    type: "content",
    anchors: [{ kind: "unit", unitId: selectionIds.secondUnit }],
  });
  expect(() => assertDocumentMergePublishable(unresolved, unresolved.baseRevision)).toThrow(/未解决|冲突/);

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  expect(resolved.document.units[selectionIds.secondUnit].sentenceIds).toEqual([c, b, a]);
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 重转换重发句子 UUID 且重排：对齐延续 ID，顺序变化可见且无删除新增", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  reissueSentences(base, selectionIds.secondUnit, ["Alpha first.", "Beta second.", "Gamma third."]);
  const [a, b, c] = base.units[selectionIds.secondUnit].sentenceIds;
  const current = structuredClone(base);
  // 真实重转换形状：句子全部重发 UUID，且来源把阅读顺序改为 c,a,b。
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const fresh = ["Gamma third.", "Alpha first.", "Beta second."].map(() => randomUUID());
  for (const oldId of [a, b, c]) delete candidate.sentences[oldId];
  ["Gamma third.", "Alpha first.", "Beta second."].forEach((text, index) => {
    candidate.sentences[fresh[index]] = {
      id: fresh[index],
      unitId: selectionIds.secondUnit,
      content: [{ kind: "text", text }],
    };
  });
  candidate.units[selectionIds.secondUnit].sentenceIds = fresh;

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  // 文本证据延续稳定 ID：无 added/removed，阅读顺序采用来源新顺序。
  expect(
    result.changeset.changes.some(
      (entry) => entry.nodeType === "sentence" && (entry.status === "added" || entry.status === "removed"),
    ),
  ).toBe(false);
  expect(result.document.units[selectionIds.secondUnit].sentenceIds).toEqual([c, a, b]);
  expect(projectSentenceText(result.document, c)).toBe("Gamma third.");
  expect(projectSentenceText(result.document, a)).toBe("Alpha first.");
  const unitChange = result.changeset.changes.find(
    (entry) => entry.nodeType === "unit" && entry.nodeId === selectionIds.secondUnit,
  );
  expect(unitChange?.status).toBe("moved");
});

test("document-core 重解析对齐 unit 后本地句子修正与来源修正产生 content 冲突", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const current = structuredClone(base);
  setThirdSentence(current, "local edit");
  const candidate = reconvertedSecondUnit(base, "source edit");

  const unresolved = merge(base, current, candidate);
  expect(unresolved.conflicts).toHaveLength(1);
  expect(unresolved.conflicts[0]).toMatchObject({
    type: "content",
    anchors: [{ kind: "unit", unitId: selectionIds.secondUnit }],
  });

  const resolved = resolveDocumentMergeConflict(unresolved, unresolved.conflicts[0].id, "candidate");
  expect(projectSentenceText(resolved.document, selectionIds.thirdSentence)).toBe("source edit");
  expect(() => assertDocumentMergePublishable(resolved, resolved.baseRevision)).not.toThrow();
});

test("document-core 重解析句子数量变化按拆分合并处理：旧句子不自动挂到新内容", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const firstNew = randomUUID();
  const secondNew = randomUUID();
  delete candidate.sentences[selectionIds.thirdSentence];
  candidate.sentences[firstNew] = {
    id: firstNew,
    unitId: selectionIds.secondUnit,
    content: [{ kind: "text", text: "Split one." }],
  };
  candidate.sentences[secondNew] = {
    id: secondNew,
    unitId: selectionIds.secondUnit,
    content: [{ kind: "text", text: "Split two." }],
  };
  candidate.units[selectionIds.secondUnit].sentenceIds = [firstNew, secondNew];

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  const sentenceChange = result.changeset.changes.find(
    (entry) => entry.nodeType === "sentence" && entry.nodeId === selectionIds.thirdSentence,
  );
  expect(sentenceChange?.status).toBe("removed");
  expect(
    result.changeset.changes.filter((entry) => entry.nodeType === "sentence" && entry.status === "added"),
  ).toHaveLength(2);
});

/** 重建 unit 的句子列表为新 UUID 句子（确定性重转换形状）。 */
function reissueSentences(tree: DocumentTree, unitId: string, texts: string[]): string[] {
  const ids = texts.map(() => randomUUID());
  for (const oldId of tree.units[unitId].sentenceIds) delete tree.sentences[oldId];
  texts.forEach((text, index) => {
    tree.sentences[ids[index]] = {
      id: ids[index],
      unitId,
      content: [{ kind: "text", text }],
    };
  });
  tree.units[unitId].sentenceIds = ids;
  return ids;
}

test("document-core 等长 split+merge 不串旧 ID：两句变两句但边界重组按 tombstone 处理", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  reissueSentences(base, selectionIds.secondUnit, ["Alpha one. Beta", "two. Gamma three."]);
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  // 等长但边界重组：候选第一句＝base 两句投影的精确拼接，第二句＝全新文本；
  // 两句对两句，位置延续必须被拒绝，旧句 tombstone、新句 added。
  const newIds = reissueSentences(candidate, selectionIds.secondUnit, [
    "Alpha one. Betatwo. Gamma three.",
    "Fresh inserted sentence.",
  ]);

  const result = merge(base, current, candidate);

  const oldIds = base.units[selectionIds.secondUnit].sentenceIds;
  for (const oldId of oldIds) {
    expect(
      result.changeset.changes.find((entry) => entry.nodeType === "sentence" && entry.nodeId === oldId)?.status,
    ).toBe("removed");
    expect(result.document.sentences[oldId]).toBeUndefined();
  }
  expect(
    result.changeset.changes.filter((entry) => entry.nodeType === "sentence" && entry.status === "added"),
  ).toHaveLength(2);
  for (const newId of newIds) expect(result.document.sentences[newId]).toBeDefined();
  expect(result.tombstones.some((entry) => entry.nodeType === "sentence" && oldIds.includes(entry.nodeId))).toBe(true);
});

test("document-core 删除＋插入同数量不串旧 ID：无边界证据的位置延续被拒绝", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  reissueSentences(base, selectionIds.secondUnit, ["Keep me.", "Delete me."]);
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  // 数量不变：删一句、插一句；保留句经内容证据延续，被删句 tombstone。
  const [keptOld, deletedOld] = base.units[selectionIds.secondUnit].sentenceIds;
  const newIds = reissueSentences(candidate, selectionIds.secondUnit, ["Keep me.", "Inserted sentence."]);

  const result = merge(base, current, candidate);

  expect(result.document.sentences[keptOld]).toBeDefined();
  expect(projectSentenceText(result.document, keptOld)).toBe("Keep me.");
  expect(
    result.changeset.changes.find((entry) => entry.nodeType === "sentence" && entry.nodeId === deletedOld)?.status,
  ).toBe("removed");
  expect(result.document.sentences[deletedOld]).toBeUndefined();
  expect(
    result.changeset.changes.filter((entry) => entry.nodeType === "sentence" && entry.status === "added"),
  ).toHaveLength(1);
  expect(result.document.sentences[newIds[1]]).toBeDefined();
  expect(projectSentenceText(result.document, newIds[1])).toBe("Inserted sentence.");
});

test("document-core 相邻 unchanged anchor 证明的 1:1 位置延续仍然成立", () => {
  const base = testSelectionTree(randomUUID());
  base.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  reissueSentences(base, selectionIds.secondUnit, ["Anchor head.", "Middle old.", "Anchor tail."]);
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  candidate.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  const [head, , tail] = base.units[selectionIds.secondUnit].sentenceIds;
  const middleNew = randomUUID();
  const baseOrder = base.units[selectionIds.secondUnit].sentenceIds;
  delete candidate.sentences[baseOrder[1]];
  candidate.sentences[middleNew] = {
    id: middleNew,
    unitId: selectionIds.secondUnit,
    content: [{ kind: "text", text: "Middle revised." }],
  };
  candidate.units[selectionIds.secondUnit].sentenceIds = [head, middleNew, tail];

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  expect(projectSentenceText(result.document, baseOrder[1])).toBe("Middle revised.");
  expect(
    result.changeset.changes.find((entry) => entry.nodeType === "sentence" && entry.nodeId === baseOrder[1])?.status,
  ).toBe("changed");
  expect(result.changeset.changes.some((entry) => entry.nodeType === "sentence" && entry.status === "added")).toBe(
    false,
  );
});

test("document-core 多个新增块共享同一锚点时按来源顺序确定插入，不依赖遍历顺序", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const candidate = structuredClone(base);
  // 在既有块之间插入三个全新单元块：它们共享前后两个已对齐锚点。
  const anchorBlock = selectionIds.block;
  const newTexts = ["Inserted one.", "Inserted two.", "Inserted three."];
  const newUnitIds = newTexts.map(() => randomUUID());
  const newBlockIds = newTexts.map(() => randomUUID());
  newTexts.forEach((text, index) => {
    const unitId = newUnitIds[index];
    const sentenceId = randomUUID();
    candidate.units[unitId] = {
      id: unitId,
      sectionId: selectionIds.section,
      kind: "paragraph",
      sentenceIds: [sentenceId],
    };
    candidate.sentences[sentenceId] = {
      id: sentenceId,
      unitId,
      content: [{ kind: "text", text }],
    };
  });
  // 直属单元顺序必须与阅读块顺序一致：新单元插在首个单元之后。
  candidate.sections[selectionIds.section].unitIds = [selectionIds.unit, ...newUnitIds, selectionIds.secondUnit];
  const anchorIndex = candidate.blocks.findIndex((block) => block.id === anchorBlock);
  candidate.blocks.splice(
    anchorIndex + 1,
    0,
    ...newBlockIds.map((blockId, index) => ({
      id: blockId,
      sectionId: selectionIds.section,
      kind: "unit" as const,
      unitId: newUnitIds[index],
    })),
  );

  const result = merge(base, current, candidate);

  expect(result.conflicts).toEqual([]);
  const order = result.document.blocks.map((block) => block.id);
  // 三个新增块必须按来源 preferred 顺序相邻排列在锚点之后。
  expect(order.indexOf(newBlockIds[0])).toBeGreaterThan(order.indexOf(anchorBlock));
  expect(order.indexOf(newBlockIds[1])).toBe(order.indexOf(newBlockIds[0]) + 1);
  expect(order.indexOf(newBlockIds[2])).toBe(order.indexOf(newBlockIds[1]) + 1);
  expect(projectSentenceText(result.document, result.document.units[newUnitIds[0]].sentenceIds[0])).toBe(
    "Inserted one.",
  );
  expect(projectSentenceText(result.document, result.document.units[newUnitIds[2]].sentenceIds[0])).toBe(
    "Inserted three.",
  );
});
