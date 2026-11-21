// Full 阅读位置解析契约（SPEC-reader §5，paper-30min-qa3.3）：
// 恢复只按稳定锚点与 changeset 状态；retained/moved 恢复原锚点，
// changed 定位原节点并提示，removed 保留摘录/tombstone 并按父 section
// 显式回退；绝不按相似文本或最近段落静默重挂，不复用旧像素位置。
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import { createDocumentChangeset, appendRemovedTombstones } from "../src/shared/document/changeset";
import { buildReaderProjection } from "../src/shared/reader/projection";
import { resolveReadingPosition, type ReadingPosition } from "../src/shared/reader/position";
import { complexReaderTree } from "./fixtures/reader/complex-document";

const paperId = randomUUID();
const revisionA = randomUUID();
const revisionB = randomUUID();

function fixtureTree() {
  const { tree, ids } = complexReaderTree(paperId);
  return { tree: parseDocumentTree(tree, paperId), ids };
}

/** 深拷贝后按修改器生成 next 树；changeset/tombstones 与 coreCommit 同一口径。 */
function revise(base: DocumentTree, mutate: (tree: DocumentTree) => void) {
  const next = parseDocumentTree(structuredClone(base), paperId);
  mutate(next);
  const changeset = createDocumentChangeset({
    base, current: next, baseRevision: revisionA, revisionId: revisionB,
  });
  const tombstones = appendRemovedTombstones(base, changeset);
  return { next, changeset, tombstones };
}

function positionAt(unitId: string, tree: DocumentTree): ReadingPosition {
  const unit = tree.units[unitId];
  return {
    revisionId: revisionA,
    view: "source",
    anchor: { kind: "unit", unitId },
    parentSectionId: unit.sectionId,
    excerpt: unit.sentenceIds.map(() => "").join(""),
    offsetWithinAnchor: 12,
    scrollTop: 9999,
    capturedAt: "2026-11-20T00:00:00.000Z",
  };
}

function resolve(base: DocumentTree, next: DocumentTree, position: ReadingPosition) {
  const changeset = createDocumentChangeset({
    base, current: next, baseRevision: revisionA, revisionId: revisionB,
  });
  return resolveReadingPosition(
    position,
    { tree: next, projection: buildReaderProjection(next), changeset, tombstones: appendRemovedTombstones(base, changeset) },
  );
}

test("reader 位置解析 retained/moved 恢复原锚点并保留锚内相对偏移，不复用旧 scrollTop", () => {
  const { tree, ids } = fixtureTree();
  const position = positionAt(ids.reference, tree);
  // 在目标块之前插入新单元：目标 moved，但身份不变。
  const { next } = revise(tree, (t) => {
    const unitId = randomUUID();
    const sentenceId = randomUUID();
    t.sentences[sentenceId] = { id: sentenceId, unitId, content: [{ kind: "text", text: "New lead paragraph." }] };
    t.units[unitId] = { id: unitId, sectionId: ids.body, kind: "paragraph", sentenceIds: [sentenceId] };
    t.sections[ids.body].unitIds.unshift(unitId);
    t.blocks.unshift({ id: randomUUID(), sectionId: ids.body, kind: "unit", unitId });
  });
  const result = resolve(tree, next, position);
  expect(result).toEqual({ status: "restored", anchor: { kind: "unit", unitId: ids.reference }, offsetWithinAnchor: 12 });
});

test("reader 位置解析 changed 定位原节点并携带内容已变化提示", () => {
  const { tree, ids } = fixtureTree();
  const position = positionAt(ids.intro, tree);
  const { next } = revise(tree, (t) => {
    const sentence = t.sentences[t.units[ids.intro].sentenceIds[0]];
    const part = sentence.content[0];
    if (part.kind === "text") part.text = "Rewritten prior work ";
  });
  const result = resolve(tree, next, position);
  expect(result.status).toBe("changed");
  if (result.status !== "changed") throw new Error("状态不符");
  expect(result.anchor).toEqual({ kind: "unit", unitId: ids.intro });
  expect(result.notice).toContain("内容已变化");
});

test("reader 位置解析 removed 保留摘录与 tombstone，父 section 存在时显式回退到该 section", () => {
  const { tree, ids } = fixtureTree();
  const position = { ...positionAt(ids.intro, tree), excerpt: "Prior work inspires this" };
  const { next } = revise(tree, (t) => {
    const unit = t.units[ids.intro];
    for (const sentenceId of unit.sentenceIds) delete t.sentences[sentenceId];
    delete t.units[ids.intro];
    t.sections[ids.body].unitIds = t.sections[ids.body].unitIds.filter((id) => id !== ids.intro);
    t.blocks = t.blocks.filter((b) => !(b.kind === "unit" && b.unitId === ids.intro));
  });
  const result = resolve(tree, next, position);
  expect(result.status).toBe("removed");
  if (result.status !== "removed") throw new Error("状态不符");
  expect(result.notice).toContain("原阅读位置已失效");
  expect(result.excerpt).toBe("Prior work inspires this");
  expect(result.tombstone?.nodeId).toBe(ids.intro);
  expect(result.tombstone?.excerpt).toContain("Prior work");
  expect(result.fallback).toEqual({ kind: "section", sectionId: ids.body });
});

test("reader 位置解析 removed 且父 section 也删除时回到文首，不按相似文本挂到其它段落", () => {
  const { tree, ids } = fixtureTree();
  const position = positionAt(ids.intro, tree);
  const { next } = revise(tree, (t) => {
    // 删除整个 body 直属内容单元与 intro；保留 method 子章节及其单元。
    for (const unitId of t.sections[ids.body].unitIds) {
      const unit = t.units[unitId];
      for (const sentenceId of unit.sentenceIds) delete t.sentences[sentenceId];
      delete t.units[unitId];
      t.blocks = t.blocks.filter((b) => !(b.kind === "unit" && b.unitId === unitId));
    }
    t.sections[ids.body].unitIds = [];
  });
  const result = resolve(tree, next, position);
  expect(result.status).toBe("removed");
  if (result.status !== "removed") throw new Error("状态不符");
  // 父 section body 仍存在（作为容器），回退到它；不选择文本相似的其它单元。
  expect(result.fallback).toEqual({ kind: "section", sectionId: ids.body });
  expect(JSON.stringify(result)).not.toContain(ids.abstract);
});

test("reader 位置解析跨 revision 链：changeset 与目标 revision 不一致时按当前树直接校验", () => {
  const { tree, ids } = fixtureTree();
  const position = positionAt(ids.reference, tree);
  const { next, changeset } = revise(tree, () => {});
  // 伪造 revisionId 的 changeset：解析不得因链缺口崩溃，按存在性恢复。
  const foreign = { ...changeset, revisionId: randomUUID() };
  const result = resolveReadingPosition(
    position,
    { tree: next, projection: buildReaderProjection(next), changeset: foreign, tombstones: [] },
  );
  expect(result.status).toBe("restored");
});

test("reader 位置解析 removed 的父 section 整体删除时回到文首并提示", () => {
  const { tree, ids } = fixtureTree();
  const position = { ...positionAt(ids.intro, tree), parentSectionId: ids.method };
  // 把 intro 挪进 method 再整体删除 method（含其全部单元/块）。
  const { next } = revise(tree, (t) => {
    const removeSection = (sectionId: string) => {
      const section = t.sections[sectionId];
      for (const child of section.childSectionIds) removeSection(child);
      for (const unitId of section.unitIds) {
        const unit = t.units[unitId];
        for (const sentenceId of unit.sentenceIds) delete t.sentences[sentenceId];
        delete t.units[unitId];
      }
      t.blocks = t.blocks.filter((b) => b.sectionId !== sectionId);
      delete t.sections[sectionId];
    };
    // 先移入 method（结构变化），随后删除 method。
    const unit = t.units[ids.intro];
    t.sections[ids.body].unitIds = t.sections[ids.body].unitIds.filter((id) => id !== ids.intro);
    unit.sectionId = ids.method;
    t.sections[ids.method].unitIds.push(ids.intro);
    for (const b of t.blocks) if (b.kind === "unit" && b.unitId === ids.intro) b.sectionId = ids.method;
    removeSection(ids.method);
    t.sections[ids.body].childSectionIds = t.sections[ids.body].childSectionIds.filter((id) => id !== ids.method);
  });
  const result = resolve(tree, next, position);
  expect(result.status).toBe("removed");
  if (result.status !== "removed") throw new Error("状态不符");
  expect(result.fallback).toBeNull();
  expect(result.notice).toContain("文首");
});
