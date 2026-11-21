import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRangeAnchor, parseDocumentAnchor } from "../src/shared/document/anchor";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

test("document-core 选区按 UTF-16 code unit 处理代理对与组合字符", () => {
  const tree = testSelectionTree(randomUUID());
  const anchor = createRangeAnchor(tree, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.secondSentence,
      start: 7,
      end: 12,
    },
  ]);

  expect(anchor.quote.text).toBe("😀 é");
  expect(anchor.ranges[0]).toEqual({
    unitId: selectionIds.unit,
    sentenceId: selectionIds.secondSentence,
    start: 7,
    end: 12,
  });
  expect(parseDocumentAnchor(tree, anchor)).toEqual(anchor);
});

test("document-core atom 占一个逻辑位置且选区 quote 复用原子文本", () => {
  const tree = testSelectionTree(randomUUID());
  const anchor = createRangeAnchor(tree, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
      start: 4,
      end: 5,
    },
  ]);

  expect(anchor.quote).toEqual({ text: "3.14", before: "Dr. ", after: " in 论文 remains one sentence." });
  expect(
    parseDocumentAnchor(tree, {
      kind: "atom",
      unitId: selectionIds.unit,
      atomId: selectionIds.atom,
    }),
  ).toEqual({ kind: "atom", unitId: selectionIds.unit, atomId: selectionIds.atom });
});

test("document-core 跨句跨单元选区持久化全部连续 ranges 和必要上下文", () => {
  const tree = testSelectionTree(randomUUID());
  const firstLength = 4 + 1 + " in 论文 remains one sentence.".length;
  const secondLength = "Second 😀 é sentence.".length;
  const anchor = createRangeAnchor(tree, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.sentence,
      start: 4,
      end: firstLength,
    },
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.secondSentence,
      start: 0,
      end: secondLength,
    },
    {
      unitId: selectionIds.secondUnit,
      sentenceId: selectionIds.thirdSentence,
      start: 0,
      end: 4,
    },
  ]);

  expect(anchor.ranges).toHaveLength(3);
  expect(anchor.quote).toEqual({
    text: "3.14 in 论文 remains one sentence.\nSecond 😀 é sentence.\nNext",
    before: "Dr. ",
    after: " unit.",
  });
  expect(parseDocumentAnchor(tree, structuredClone(anchor))).toEqual(anchor);
});

test("document-core quote 被篡改或偏移越界时拒绝解析", () => {
  const tree = testSelectionTree(randomUUID());
  const anchor = createRangeAnchor(tree, [
    {
      unitId: selectionIds.unit,
      sentenceId: selectionIds.secondSentence,
      start: 0,
      end: 6,
    },
  ]);
  anchor.quote.text = "tampered";
  expect(() => parseDocumentAnchor(tree, anchor)).toThrow(/quote|摘录/);

  expect(() =>
    createRangeAnchor(tree, [
      {
        unitId: selectionIds.unit,
        sentenceId: selectionIds.secondSentence,
        start: 0,
        end: 10_000,
      },
    ]),
  ).toThrow(/偏移|边界/);
});

test("document-core 跨单元范围缺句时拒绝，不用首尾点猜测中间内容", () => {
  const tree = testSelectionTree(randomUUID());
  const firstLength = 4 + 1 + " in 论文 remains one sentence.".length;
  expect(() =>
    createRangeAnchor(tree, [
      {
        unitId: selectionIds.unit,
        sentenceId: selectionIds.sentence,
        start: 0,
        end: firstLength,
      },
      {
        unitId: selectionIds.secondUnit,
        sentenceId: selectionIds.thirdSentence,
        start: 0,
        end: 4,
      },
    ]),
  ).toThrow(/跨句或跨单元选区不连续/);
});

test("document-core ranges 逆序时拒绝", () => {
  const tree = testSelectionTree(randomUUID());
  expect(() =>
    createRangeAnchor(tree, [
      {
        unitId: selectionIds.unit,
        sentenceId: selectionIds.secondSentence,
        start: 0,
        end: 6,
      },
      {
        unitId: selectionIds.unit,
        sentenceId: selectionIds.sentence,
        start: 0,
        end: 5,
      },
    ]),
  ).toThrow(/多个选区必须按原文顺序排列/);
});

test("document-core 同一句出现多个范围时拒绝", () => {
  const tree = testSelectionTree(randomUUID());
  expect(() =>
    createRangeAnchor(tree, [
      {
        unitId: selectionIds.unit,
        sentenceId: selectionIds.sentence,
        start: 0,
        end: 2,
      },
      {
        unitId: selectionIds.unit,
        sentenceId: selectionIds.sentence,
        start: 4,
        end: 6,
      },
    ]),
  ).toThrow(/多个选区必须按原文顺序排列，且每句至多一个范围/);
});

test("document-core 锚点校验父子关系，不按重复 quote 自动重锚", () => {
  const tree = testSelectionTree(randomUUID());
  expect(() =>
    parseDocumentAnchor(tree, {
      kind: "sentence",
      unitId: selectionIds.secondUnit,
      sentenceId: selectionIds.sentence,
    }),
  ).toThrow(/父子|所属|关系/);
  expect(() =>
    parseDocumentAnchor(tree, {
      kind: "atom",
      unitId: selectionIds.secondUnit,
      atomId: selectionIds.atom,
    }),
  ).toThrow(/父子|所属|关系/);
});
