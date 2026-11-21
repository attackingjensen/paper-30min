// document-core 结构化修正回归（SPEC-document-core §6，SPEC-reader §8，
// paper-30min-qa3.4）：单元/atom 修正、拆分/合并/删除/移动、资产替换与 raw 文本投影；
// 预览与发布同一命令序列，发布前重放并复核 baseRevision；草稿失败不触碰 current。
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  commitRevision,
  createProject,
  openProject,
  publishSourceSnapshot,
  readRevisionDocument,
  readRevisionTombstones,
} from "../src/main/project-core";
import { applyDocumentCorrections } from "../src/main/document/correction-engine";
import { previewDocumentCorrections, publishDocumentCorrections } from "../src/main/document/correction";
import { unitEditText, unitLogicalText } from "../src/shared/document/correction";
import type { DocumentTree } from "../src/shared/document/tree";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-correction-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function json(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

function revisions() {
  return { baseRevision: randomUUID(), revisionId: randomUUID() };
}

function apply(base: DocumentTree, corrections: unknown[]) {
  return applyDocumentCorrections({ base, ...revisions(), corrections });
}

test("document-core 单元文字修正保留 unit/sentence/atom ID，changeset 标记 changed", () => {
  const base = testSelectionTree(randomUUID());
  const expected = unitEditText(base, selectionIds.unit);
  const result = apply(base, [
    {
      type: "unit-text",
      unitId: selectionIds.unit,
      expected,
      text: expected.replace("remains one sentence.", "is now corrected."),
    },
  ]);
  expect(result.document.units[selectionIds.unit]).toBeDefined();
  expect(result.document.atoms[selectionIds.atom]).toEqual(base.atoms[selectionIds.atom]);
  // 普通文字修正不退役句子锚点：句数不变时逐句保留原 ID。
  expect(result.document.units[selectionIds.unit].sentenceIds).toEqual(base.units[selectionIds.unit].sentenceIds);
  const sentenceChange = result.changeset.changes.find((entry) => entry.nodeId === selectionIds.sentence);
  expect(sentenceChange?.status).toBe("changed");
  expect(result.tombstones.some((entry) => entry.nodeType === "sentence")).toBe(false);
  expect(unitLogicalText(result.document, selectionIds.unit)).toContain("is now corrected.");
  // unit 节点内容指纹排除 sentenceIds：句内改写由句子 changed 表达，unit 本身 retained。
  const unitChange = result.changeset.changes.find((entry) => entry.nodeId === selectionIds.unit);
  expect(unitChange?.status).toBe("retained");
  // 输入树不被修改（staging 副本）。
  expect(unitEditText(base, selectionIds.unit)).toBe(expected);
});

test("document-core 修正文本丢失或乱序 atom 占位时拒绝，不产生半修正", () => {
  const base = testSelectionTree(randomUUID());
  const expected = unitEditText(base, selectionIds.unit);
  expect(() =>
    apply(base, [
      {
        type: "unit-text",
        unitId: selectionIds.unit,
        expected,
        text: "no atom placeholder here.",
      },
    ]),
  ).toThrow(/占位/);
});

test("document-core 预期原内容不符时拒绝修正（基线保护）", () => {
  const base = testSelectionTree(randomUUID());
  expect(() =>
    apply(base, [
      {
        type: "unit-text",
        unitId: selectionIds.unit,
        expected: "stale content",
        text: "whatever 3.14",
      },
    ]),
  ).toThrow(/预期不符/);
});

test("document-core 同类型 atom 内容修正保留 ID；类型变化拒绝", () => {
  const base = testSelectionTree(randomUUID());
  const atom = base.atoms[selectionIds.atom];
  const result = apply(base, [
    {
      type: "atom",
      atomId: selectionIds.atom,
      expected: atom,
      kind: "math",
      text: "2.71",
      source: { format: "latex", value: "2.71" },
    },
  ]);
  expect(result.document.atoms[selectionIds.atom]).toMatchObject({
    kind: "math",
    text: "2.71",
    source: { format: "latex", value: "2.71" },
  });
  expect(result.changeset.changes.find((entry) => entry.nodeId === selectionIds.atom)?.status).toBe("changed");
  expect(() =>
    apply(base, [
      {
        type: "atom",
        atomId: selectionIds.atom,
        expected: atom,
        kind: "link",
        text: "x",
        href: "https://example.org/",
      },
    ]),
  ).toThrow(/类型/);
});

test("document-core 拆分单元退役旧 ID 并建立 split tombstone，新单元按顺序进入阅读流", () => {
  const base = testSelectionTree(randomUUID());
  const expected = unitLogicalText(base, selectionIds.secondUnit);
  const result = apply(base, [
    {
      type: "unit-split",
      unitId: selectionIds.secondUnit,
      expected,
      parts: ["First half.", "Second half."],
    },
  ]);
  expect(result.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(result.tombstones.some((entry) => entry.nodeId === selectionIds.secondUnit && entry.reason === "split")).toBe(
    true,
  );
  const section = result.document.sections[selectionIds.section];
  expect(section.unitIds).toHaveLength(3);
  const texts = section.unitIds.map((id) => unitLogicalText(result.document, id));
  expect(texts).toEqual([unitLogicalText(base, selectionIds.unit), "First half.", "Second half."]);
});

test("document-core 合并相邻单元退役旧 ID（merged），阅读流只留一个合并块", () => {
  const base = testSelectionTree(randomUUID());
  // 合并目标必须无 atom：用 secondUnit 与新增的第三单元。
  const thirdUnit = randomUUID();
  const thirdSentence = randomUUID();
  const thirdBlock = randomUUID();
  base.units[thirdUnit] = {
    id: thirdUnit,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [thirdSentence],
  };
  base.sentences[thirdSentence] = {
    id: thirdSentence,
    unitId: thirdUnit,
    content: [{ kind: "text", text: "Third unit." }],
  };
  base.sections[selectionIds.section].unitIds.push(thirdUnit);
  base.blocks.push({ id: thirdBlock, sectionId: selectionIds.section, kind: "unit", unitId: thirdUnit });
  const result = apply(base, [
    {
      type: "unit-merge",
      unitIds: [selectionIds.secondUnit, thirdUnit],
      expected: ["Next unit.", "Third unit."],
    },
  ]);
  expect(result.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(result.document.units[thirdUnit]).toBeUndefined();
  expect(result.tombstones.filter((entry) => entry.reason === "merged").length).toBeGreaterThanOrEqual(2);
  const section = result.document.sections[selectionIds.section];
  expect(section.unitIds).toHaveLength(2);
  expect(unitLogicalText(result.document, section.unitIds[1])).toBe("Next unit. Third unit.");
});

test("document-core 删除单元建立 removed tombstone；引用原子解除目标不猜测", () => {
  const base = testSelectionTree(randomUUID());
  // 给 secondUnit 加一个指向它的 citation。
  const citationId = randomUUID();
  const hostSentence = base.sentences[selectionIds.sentence];
  hostSentence.content.push({ kind: "atom", atomId: citationId });
  base.atoms[citationId] = {
    id: citationId,
    unitId: selectionIds.unit,
    kind: "citation",
    text: "[9]",
    targetUnitId: selectionIds.secondUnit,
  };
  const result = apply(base, [
    {
      type: "unit-delete",
      unitId: selectionIds.secondUnit,
      expected: unitLogicalText(base, selectionIds.secondUnit),
    },
  ]);
  expect(result.document.units[selectionIds.secondUnit]).toBeUndefined();
  expect(
    result.tombstones.some((entry) => entry.nodeId === selectionIds.secondUnit && entry.reason === "removed"),
  ).toBe(true);
  expect(result.document.atoms[citationId]).toMatchObject({ targetUnitId: null });
  expect(result.document.blocks.some((block) => block.id === selectionIds.secondBlock)).toBe(false);
});

test("document-core 移动单元跨章节保留 ID，changeset 记录 moved/changed 而非 removed", () => {
  const base = testSelectionTree(randomUUID());
  const otherSection = randomUUID();
  const otherUnit = randomUUID();
  const otherSentence = randomUUID();
  const otherBlock = randomUUID();
  base.sections[otherSection] = {
    id: otherSection,
    parentSectionId: selectionIds.section,
    title: "子节",
    childSectionIds: [],
    unitIds: [otherUnit],
  };
  base.sections[selectionIds.section].childSectionIds = [otherSection];
  base.units[otherUnit] = {
    id: otherUnit,
    sectionId: otherSection,
    kind: "paragraph",
    sentenceIds: [otherSentence],
  };
  base.sentences[otherSentence] = {
    id: otherSentence,
    unitId: otherUnit,
    content: [{ kind: "text", text: "Anchor unit." }],
  };
  base.blocks.push({ id: otherBlock, sectionId: otherSection, kind: "unit", unitId: otherUnit });
  const result = apply(base, [
    {
      type: "unit-move",
      unitId: selectionIds.secondUnit,
      afterUnitId: otherUnit,
    },
  ]);
  expect(result.document.units[selectionIds.secondUnit]).toBeDefined();
  expect(result.document.units[selectionIds.secondUnit].sectionId).toBe(otherSection);
  expect(result.tombstones.some((entry) => entry.nodeId === selectionIds.secondUnit)).toBe(false);
  const order = result.document.sections[otherSection].unitIds;
  expect(order).toEqual([otherUnit, selectionIds.secondUnit]);
});

test("document-core raw block 只接受受控文本投影，HTML 注入被转义", () => {
  const base = testSelectionTree(randomUUID());
  const rawId = randomUUID();
  base.blocks.push({
    id: rawId,
    sectionId: selectionIds.section,
    kind: "raw",
    html: "<p>original</p>",
    text: "original",
    limitations: ["受控投影"],
  });
  const result = apply(base, [
    {
      type: "raw-text",
      blockId: rawId,
      expected: "original",
      text: "<script>alert(1)</script> & more",
    },
  ]);
  const block = result.document.blocks.find((entry) => entry.id === rawId)!;
  expect(block.kind).toBe("raw");
  if (block.kind === "raw") {
    expect(block.text).toBe("<script>alert(1)</script> & more");
    expect(block.html).not.toContain("<script>");
    expect(block.html).toContain("&lt;script&gt;");
  }
});

test("document-core 同一 revisionId 重放修正产生逐字节一致的树（预览即发布内容）", () => {
  const base = testSelectionTree(randomUUID());
  const ids = revisions();
  const corrections = [
    {
      type: "unit-split",
      unitId: selectionIds.secondUnit,
      expected: unitLogicalText(base, selectionIds.secondUnit),
      parts: ["Alpha.", "Beta."],
    },
  ];
  const first = applyDocumentCorrections({ base, ...ids, corrections });
  const second = applyDocumentCorrections({ base, ...ids, corrections });
  expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document));
  expect(JSON.stringify(second.tombstones)).toBe(JSON.stringify(first.tombstones));
});

async function initialProject(name: string) {
  const created = await createProject({ parent: sandbox, name });
  const tree = testSelectionTree(created.manifest.paper.id);
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
  });
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: null }),
    },
  });
  return { created, tree, source, revision };
}

test("document-core 修正预览不推进 current；发布重放同一命令并复核基线", async () => {
  const { created, tree, revision } = await initialProject("修正预览");
  const corrections = [
    {
      type: "unit-text",
      unitId: selectionIds.unit,
      expected: unitEditText(tree, selectionIds.unit),
      text: unitEditText(tree, selectionIds.unit).replace("remains one sentence.", "is corrected."),
    },
  ];
  const preview = await previewDocumentCorrections({
    root: created.root,
    baseRevision: revision.revisionId,
    corrections,
  });
  expect(preview.baseRevision).toBe(revision.revisionId);
  expect(unitLogicalText(preview.document, selectionIds.unit)).toContain("is corrected.");
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(revision.revisionId);

  const published = await publishDocumentCorrections({
    root: created.root,
    baseRevision: revision.revisionId,
    revisionId: preview.revisionId,
    corrections,
  });
  expect(published.revisionId).toBe(preview.revisionId);
  const stored = await readRevisionDocument(created.root, published.revisionId, "document");
  expect(JSON.stringify(stored)).toBe(JSON.stringify(preview.document));
  // source-base 不含本地修正。
  const sourceBase = await readRevisionDocument(created.root, published.revisionId, "source-base");
  expect(unitLogicalText(sourceBase, selectionIds.unit)).not.toContain("is corrected.");
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(published.revisionId);
});

test("document-core 发布前 current 被推进时拒绝修正发布，旧 current 与预览保持", async () => {
  const { created, tree, source, revision } = await initialProject("修正基线竞争");
  const corrections = [
    {
      type: "unit-text",
      unitId: selectionIds.unit,
      expected: unitEditText(tree, selectionIds.unit),
      text: unitEditText(tree, selectionIds.unit) + " tail",
    },
  ];
  const preview = await previewDocumentCorrections({
    root: created.root,
    baseRevision: revision.revisionId,
    corrections,
  });
  // 另一操作推进 current。
  const advanced = await commitRevision({
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  await expect(
    publishDocumentCorrections({
      root: created.root,
      baseRevision: revision.revisionId,
      revisionId: preview.revisionId,
      corrections,
    }),
  ).rejects.toThrow(/baseRevision/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(advanced.revisionId);
});

test("document-core 资产替换经内容寻址进入新 revision，图块摘要与登记一致", async () => {
  const { created, tree, source, revision } = await initialProject("资产替换");
  const figureId = randomUUID();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
  const hash = createHash("sha256").update(png).digest("hex");
  tree.blocks.push({
    id: figureId,
    sectionId: selectionIds.section,
    kind: "figure",
    asset: null,
    captionUnitId: null,
    warning: "来源图片缺失。",
  });
  const withFigure = await commitRevision({
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  const corrections = [{ type: "figure-asset", blockId: figureId, bytes: new Uint8Array(png), mime: "image/png" }];
  const preview = await previewDocumentCorrections({
    root: created.root,
    baseRevision: withFigure.revisionId,
    corrections,
  });
  expect(preview.assets.some((asset) => asset.sha256 === hash && asset.path === `assets/${hash}.png`)).toBe(true);
  const published = await publishDocumentCorrections({
    root: created.root,
    baseRevision: withFigure.revisionId,
    revisionId: preview.revisionId,
    corrections,
  });
  const stored = await readRevisionDocument(created.root, published.revisionId, "document");
  const figure = stored.blocks.find((block) => block.id === figureId)!;
  expect(figure.kind).toBe("figure");
  if (figure.kind === "figure") {
    expect(figure.asset).toMatchObject({ sha256: hash, mime: "image/png" });
    expect(figure.warning).toBeUndefined();
  }
  const tombstones = await readRevisionTombstones(created.root, published.revisionId);
  expect(tombstones).toEqual([]);
});

test("document-core 普通文字修正含字面占位文本时不误绑 atom（令牌唯一）", () => {
  const base = testSelectionTree(randomUUID());
  // 在 atom 前插入与 atom 显示文本相同的字面文字：裸显示文本匹配会误绑。
  const sentence = base.sentences[selectionIds.sentence];
  sentence.content.unshift({ kind: "text", text: "3.14 " });
  const expected = unitEditText(base, selectionIds.unit);
  const result = apply(base, [
    {
      type: "unit-text",
      unitId: selectionIds.unit,
      expected,
      text: expected.replace("remains one sentence.", "is corrected."),
    },
  ]);
  // atom 未被字面 3.14 吞并：仍作为独立 atom 存在，且位于字面文本之后。
  const content = result.document.sentences[selectionIds.sentence].content;
  const atomIndex = content.findIndex((part) => part.kind === "atom" && part.atomId === selectionIds.atom);
  expect(atomIndex).toBeGreaterThan(0);
  expect(
    content
      .slice(0, atomIndex)
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join(""),
  ).toContain("3.14");
  expect(unitLogicalText(result.document, selectionIds.unit)).toContain("is corrected.");
});

test("document-core 重复 atom 占位令牌被拒绝，不猜测唯一位置", () => {
  const base = testSelectionTree(randomUUID());
  const expected = unitEditText(base, selectionIds.unit);
  const token = expected.match(/⟦atom:[0-9a-f-]+⟧/)![0];
  expect(() =>
    apply(base, [
      {
        type: "unit-text",
        unitId: selectionIds.unit,
        expected,
        text: `${token} duplicate ${token}`,
      },
    ]),
  ).toThrow(/重复/);
});

test("document-core 超过 32 MiB 的资产替换在预览边界即拒绝，current 不变", async () => {
  const { created, tree, source, revision } = await initialProject("资产预算");
  const figureId = randomUUID();
  tree.blocks.push({
    id: figureId,
    sectionId: selectionIds.section,
    kind: "figure",
    asset: null,
    captionUnitId: null,
    warning: "来源图片缺失。",
  });
  const withFigure = await commitRevision({
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  const oversized = new Uint8Array(32 * 1024 * 1024 + 1);
  await expect(
    previewDocumentCorrections({
      root: created.root,
      baseRevision: withFigure.revisionId,
      corrections: [{ type: "figure-asset", blockId: figureId, bytes: oversized, mime: "image/png" }],
    }),
  ).rejects.toThrow(/32 MiB/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(withFigure.revisionId);
});
