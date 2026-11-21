import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRangeAnchor } from "../src/shared/document/anchor";
import {
  appendRemovedTombstones,
  createDocumentChangeset,
  deriveAnchorState,
  parseDocumentChangeset,
  parseDocumentTombstones,
} from "../src/shared/document/changeset";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

function revisions() {
  return { baseRevision: randomUUID(), revisionId: randomUUID() };
}

function change(changeset: ReturnType<typeof createDocumentChangeset>, nodeType: string, nodeId: string) {
  const result = changeset.changes.find((entry) => entry.nodeType === nodeType && entry.nodeId === nodeId);
  if (!result) throw new Error(`缺少变化记录：${nodeType}/${nodeId}`);
  return result;
}

test("document-core 普通文字修正只让对应章节派生内容 stale", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  current.sections[selectionIds.section].title = "修订标题";
  const changeset = createDocumentChangeset({
    base,
    current,
    ...revisions(),
  });

  expect(change(changeset, "section", selectionIds.section).status).toBe("changed");
  expect(change(changeset, "sentence", selectionIds.sentence).status).toBe("retained");
  expect(
    deriveAnchorState(base, changeset, {
      kind: "section",
      sectionId: selectionIds.section,
    }),
  ).toBe("stale");
  expect(
    deriveAnchorState(base, changeset, {
      kind: "sentence",
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
    }),
  ).toBe("fresh");
  expect(parseDocumentChangeset(JSON.parse(JSON.stringify(changeset)))).toEqual(changeset);
});

test("document-core 内容不变的可靠移动保留文本派生关系", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  current.sections[selectionIds.section].unitIds.reverse();
  current.blocks.reverse();
  const changeset = createDocumentChangeset({
    base,
    current,
    ...revisions(),
  });

  expect(change(changeset, "section", selectionIds.section).status).toBe("moved");
  expect(change(changeset, "block", selectionIds.block).status).toBe("moved");
  expect(change(changeset, "unit", selectionIds.secondUnit).status).toBe("retained");
  expect(
    deriveAnchorState(base, changeset, {
      kind: "unit",
      unitId: selectionIds.secondUnit,
    }),
  ).toBe("fresh");
});

test("document-core atom 修正只让引用该 atom 的精确选区 stale", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const atom = current.atoms[selectionIds.atom];
  if (atom.kind !== "math") throw new Error("fixture 原子类型错误");
  atom.text = "π";
  atom.source.value = "\\pi";
  const changeset = createDocumentChangeset({
    base,
    current,
    ...revisions(),
  });
  const atomRange = createRangeAnchor(base, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
      start: 4,
      end: 5,
    },
  ]);
  const textRange = createRangeAnchor(base, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
      start: 5,
      end: 8,
    },
  ]);

  expect(change(changeset, "atom", selectionIds.atom).status).toBe("changed");
  expect(change(changeset, "sentence", selectionIds.sentence).status).toBe("retained");
  expect(deriveAnchorState(base, changeset, atomRange)).toBe("stale");
  expect(deriveAnchorState(base, changeset, textRange)).toBe("fresh");
});

test("document-core 重新分段只失效受影响句子并保留 tombstone 摘录", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const firstNewSentence = randomUUID();
  const secondNewSentence = randomUUID();
  delete current.sentences[selectionIds.secondSentence];
  current.sentences[firstNewSentence] = {
    id: firstNewSentence,
    unitId: selectionIds.unit,
    content: [{ kind: "text", text: "Second " }],
  };
  current.sentences[secondNewSentence] = {
    id: secondNewSentence,
    unitId: selectionIds.unit,
    content: [{ kind: "text", text: "😀 é sentence." }],
  };
  current.units[selectionIds.unit].sentenceIds = [selectionIds.sentence, firstNewSentence, secondNewSentence];
  const ids = revisions();
  const changeset = createDocumentChangeset({ base, current, ...ids });
  const tombstones = appendRemovedTombstones(base, changeset);
  const oldRange = createRangeAnchor(base, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.secondSentence,
      start: 0,
      end: 6,
    },
  ]);

  expect(change(changeset, "unit", selectionIds.unit).status).toBe("changed");
  expect(change(changeset, "sentence", selectionIds.secondSentence).status).toBe("removed");
  expect(change(changeset, "sentence", firstNewSentence).status).toBe("added");
  expect(change(changeset, "sentence", secondNewSentence).status).toBe("added");
  expect(deriveAnchorState(base, changeset, oldRange)).toBe("invalid");
  expect(
    deriveAnchorState(base, changeset, {
      kind: "sentence",
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
    }),
  ).toBe("fresh");
  expect(tombstones).toHaveLength(1);
  expect(tombstones[0]).toMatchObject({
    nodeType: "sentence",
    nodeId: selectionIds.secondSentence,
    lastRevision: ids.baseRevision,
    excerpt: "Second 😀 é sentence.",
  });
  expect(parseDocumentTombstones(JSON.parse(JSON.stringify(tombstones)), current)).toEqual(tombstones);
});

test("document-core 拆分单元不默认继承旧身份，tombstones 累积且禁止复用", () => {
  const base = testSelectionTree(randomUUID());
  const current = structuredClone(base);
  const firstNewUnit = randomUUID();
  const secondNewUnit = randomUUID();
  const newSentence = randomUUID();
  const firstNewBlock = randomUUID();
  const secondNewBlock = randomUUID();
  delete current.units[selectionIds.secondUnit];
  current.units[firstNewUnit] = {
    id: firstNewUnit,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [selectionIds.thirdSentence],
  };
  current.units[secondNewUnit] = {
    id: secondNewUnit,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [newSentence],
  };
  current.sentences[selectionIds.thirdSentence].unitId = firstNewUnit;
  current.sentences[newSentence] = {
    id: newSentence,
    unitId: secondNewUnit,
    content: [{ kind: "text", text: "Additional sentence." }],
  };
  current.sections[selectionIds.section].unitIds = [selectionIds.unit, firstNewUnit, secondNewUnit];
  current.blocks = current.blocks.filter((block) => block.id !== selectionIds.secondBlock);
  current.blocks.push(
    {
      id: firstNewBlock,
      sectionId: selectionIds.section,
      kind: "unit",
      unitId: firstNewUnit,
    },
    {
      id: secondNewBlock,
      sectionId: selectionIds.section,
      kind: "unit",
      unitId: secondNewUnit,
    },
  );
  const changeset = createDocumentChangeset({ base, current, ...revisions() });
  const previous = [
    {
      nodeType: "sentence" as const,
      nodeId: randomUUID(),
      lastRevision: randomUUID(),
      excerpt: " Earlier tombstone. ",
      reason: "removed" as const,
    },
  ];
  const tombstones = appendRemovedTombstones(base, changeset, previous);

  expect(previous).toHaveLength(1);
  expect(change(changeset, "unit", selectionIds.secondUnit).status).toBe("removed");
  expect(change(changeset, "unit", firstNewUnit).status).toBe("added");
  expect(change(changeset, "unit", secondNewUnit).status).toBe("added");
  expect(change(changeset, "sentence", selectionIds.thirdSentence).status).toBe("moved");
  expect(tombstones[0]).toEqual(previous[0]);
  expect(tombstones.filter((entry) => entry.nodeId === selectionIds.secondUnit)).toHaveLength(1);
  expect(parseDocumentTombstones(tombstones, current)).toEqual(tombstones);

  current.units[selectionIds.secondUnit] = {
    id: selectionIds.secondUnit,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [],
  };
  expect(() => parseDocumentTombstones(tombstones, current)).toThrow(/复用|tombstone|退役/);
});

test("document-core conflicted 变化不得向下游投影为有效内容", () => {
  const base = testSelectionTree(randomUUID());
  const changeset = createDocumentChangeset({
    base,
    current: structuredClone(base),
    ...revisions(),
  });
  change(changeset, "sentence", selectionIds.sentence).status = "conflicted";

  expect(
    deriveAnchorState(base, changeset, {
      kind: "sentence",
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
    }),
  ).toBe("invalid");
});
