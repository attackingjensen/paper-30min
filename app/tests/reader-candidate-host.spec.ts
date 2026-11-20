// 候选宿主命令回归（SPEC-reader §9，paper-30min-qa3.4）：
// 构建时落盘的候选可按身份重载（不重新转换）；冲突解决显式落盘，
// 重载后解决状态保留；候选资产经受管读取供冲突预览；发布前基线复核。
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  commitRevision,
  createProject,
  openProject,
  publishSourceSnapshot,
  readRevisionDocument,
} from "../src/main/project-core";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
} from "../src/main/document/merge";
import {
  loadUpdateCandidate,
  readUpdateCandidateAsset,
  resolveStoredCandidateConflict,
  storeUpdateCandidate,
} from "../src/main/document/candidate-store";
import { projectSentenceText } from "../src/shared/document/anchor";
import type { DocumentTree } from "../src/shared/document/tree";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-candidate-host-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function json(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

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

function setThirdSentence(tree: DocumentTree, text: string) {
  tree.sentences[selectionIds.thirdSentence].content = [{ kind: "text", text }];
}

/** 构造 content 冲突候选：本地与来源改同一单元。 */
async function conflictedCandidate(name: string) {
  const { created, tree, revision } = await initialProject(name);
  const local = structuredClone(tree);
  setThirdSentence(local, "local edit");
  const localSource = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>local</html>") },
  });
  const localRevision = await commitRevision({
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: localSource.sourceSnapshotId,
    files: {
      "document.json": json(local),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  const candidateTree = structuredClone(tree);
  setThirdSentence(candidateTree, "source edit");
  const candidateSource = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>candidate</html>") },
  });
  const candidate = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: localRevision.revisionId,
    sourceSnapshotId: candidateSource.sourceSnapshotId,
    candidate: candidateTree,
  });
  const stored = await storeUpdateCandidate(candidate);
  return { created, stored, localRevision };
}

test("reader 候选重载按存储字节恢复冲突与双方内容，不重新转换", async () => {
  const { created, stored } = await conflictedCandidate("候选重载");
  const loaded = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  expect(loaded.revisionId).toBe(stored.revisionId);
  expect(loaded.baseRevision).toBe(stored.baseRevision);
  expect(loaded.conflicts).toEqual(stored.conflicts);
  expect(loaded.conflicts.length).toBeGreaterThan(0);
  expect(JSON.stringify(loaded.document)).toBe(JSON.stringify(stored.document));
  expect(loaded.resolutions).toEqual({});
});

test("reader 冲突解决显式落盘：重载保留选择，未解决项仍可见，发布按解决结果", async () => {
  const { created, stored, localRevision } = await conflictedCandidate("解决落盘");
  const conflict = stored.conflicts[0];
  const resolved = await resolveStoredCandidateConflict({
    root: created.root,
    revisionId: stored.revisionId,
    conflictId: conflict.id,
    choice: "candidate",
  });
  expect(resolved.resolutions[conflict.id]).toBe("candidate");
  expect(resolved.conflicts.some((entry) => entry.id === conflict.id)).toBe(true);
  // 重载后解决状态来自存储，不依赖内存对象。
  const loaded = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  expect(loaded.resolutions[conflict.id]).toBe("candidate");
  expect(projectSentenceText(loaded.document, selectionIds.thirdSentence)).toBe("source edit");
  // current 未被解决动作推进。
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(localRevision.revisionId);
  const published = await publishDocumentMergeCandidate(loaded);
  expect(published.revisionId).toBe(stored.revisionId);
  expect(projectSentenceText(
    await readRevisionDocument(created.root, published.revisionId, "document"),
    selectionIds.thirdSentence,
  )).toBe("source edit");
});

test("reader 未解决冲突的存储候选不能发布；解决结果在基线变化后保留但不套用", async () => {
  const { created, stored, localRevision } = await conflictedCandidate("基线保护");
  const conflict = stored.conflicts[0];
  // 未解决即发布：明确拒绝，current 不推进。
  const unresolved = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  await expect(publishDocumentMergeCandidate(unresolved)).rejects.toThrow(/未解决|冲突/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(localRevision.revisionId);
  await resolveStoredCandidateConflict({
    root: created.root, revisionId: stored.revisionId, conflictId: conflict.id, choice: "current",
  });
  const loaded = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  // 另一操作推进 current。
  const tree = await readRevisionDocument(created.root, localRevision.revisionId, "document");
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>other</html>") },
  });
  const advanced = await commitRevision({
    root: created.root,
    baseRevision: localRevision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: localRevision.revisionId }),
    },
  });
  await expect(publishDocumentMergeCandidate(loaded)).rejects.toThrow(/baseRevision/);
  // 解决结果仍在存储中；current 是另一操作的结果。
  const after = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  expect(after.resolutions[conflict.id]).toBe("current");
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(advanced.revisionId);
});

test("reader 候选资产经受管读取：摘要校验，未登记资产拒绝", async () => {
  const { created, tree, source, revision } = await initialProject("候选资产");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(png).digest("hex");
  const figureId = randomUUID();
  const withFigure = structuredClone(tree);
  withFigure.blocks.push({
    id: figureId, sectionId: selectionIds.section, kind: "figure",
    asset: { path: `assets/${hash}.png`, sha256: hash, mime: "image/png" },
    captionUnitId: null,
  });
  const candidateSource = await publishSourceSnapshot({
    root: created.root,
    files: {
      "document.html": Buffer.from("<html>figure</html>"),
      [`assets/${hash}.png`]: { bytes: png, mime: "image/png" },
    },
  });
  const candidate = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: candidateSource.sourceSnapshotId,
    candidate: withFigure,
  });
  const stored = await storeUpdateCandidate(candidate);
  const asset = await readUpdateCandidateAsset({
    root: created.root, revisionId: stored.revisionId, path: `assets/${hash}.png`,
  });
  expect(Buffer.from(asset.bytes).equals(png)).toBe(true);
  expect(asset.mime).toBe("image/png");
  await expect(readUpdateCandidateAsset({
    root: created.root, revisionId: stored.revisionId, path: `assets/${"0".repeat(64)}.png`,
  })).rejects.toThrow();
  void source;
});

test("reader 不存在的候选身份重载明确拒绝，不伪造空候选", async () => {
  const { created } = await initialProject("缺失候选");
  await expect(loadUpdateCandidate({ root: created.root, revisionId: randomUUID() }))
    .rejects.toThrow();
});

test("reader 并发解决不同冲突串行落盘，两项选择重载后都保留", async () => {
  const { created, tree, revision } = await initialProject("并发解决");
  // 两个单元分别被本地与来源不同修改 → 两项 content 冲突。
  const local = structuredClone(tree);
  setThirdSentence(local, "local edit B");
  local.sentences[selectionIds.sentence].content = [
    { kind: "text", text: "local edit A " },
    { kind: "atom", atomId: selectionIds.atom },
    { kind: "text", text: " tail." },
  ];
  const localSource = await publishSourceSnapshot({
    root: created.root, files: { "document.html": Buffer.from("<html>local</html>") },
  });
  const localRevision = await commitRevision({
    root: created.root, baseRevision: revision.revisionId, sourceSnapshotId: localSource.sourceSnapshotId,
    files: {
      "document.json": json(local), "source-base.json": json(tree),
      "tombstones.json": json([]), "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  const candidateTree = structuredClone(tree);
  setThirdSentence(candidateTree, "source edit B");
  candidateTree.sentences[selectionIds.sentence].content = [
    { kind: "text", text: "source edit A " },
    { kind: "atom", atomId: selectionIds.atom },
    { kind: "text", text: " tail." },
  ];
  const candidateSource = await publishSourceSnapshot({
    root: created.root, files: { "document.html": Buffer.from("<html>candidate</html>") },
  });
  const candidate = await createDocumentMergeCandidate({
    root: created.root, baseRevision: localRevision.revisionId,
    sourceSnapshotId: candidateSource.sourceSnapshotId, candidate: candidateTree,
  });
  const stored = await storeUpdateCandidate(candidate);
  expect(stored.conflicts.length).toBeGreaterThanOrEqual(2);
  const [first, second] = stored.conflicts;
  // 并发解决两项不同冲突：写锁串行化，后写者不得覆盖先写者的选择。
  await Promise.all([
    resolveStoredCandidateConflict({ root: created.root, revisionId: stored.revisionId, conflictId: first.id, choice: "current" }),
    resolveStoredCandidateConflict({ root: created.root, revisionId: stored.revisionId, conflictId: second.id, choice: "candidate" }),
  ]);
  const loaded = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  expect(loaded.resolutions[first.id]).toBe("current");
  expect(loaded.resolutions[second.id]).toBe("candidate");
});

test("reader 解决代际切换崩溃后旧代际仍完整可读（manifest 是唯一原子点）", async () => {
  const { created, stored } = await conflictedCandidate("代际崩溃");
  const conflict = stored.conflicts[0];
  await resolveStoredCandidateConflict({
    root: created.root, revisionId: stored.revisionId, conflictId: conflict.id, choice: "candidate",
  });
  const directory = path.join(created.root, ".paper30min", "update-candidates", stored.revisionId);
  // 模拟第二次解决在写完新代际树文件后、切换 manifest 前崩溃：
  // 留下孤儿代际文件，但 manifest 仍指向完整旧代际。
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "candidate.json"), "utf8"));
  const generation = (manifest.generation ?? 0) + 1;
  for (const name of ["base", "current", "sourceBase", "document", "candidateTree", "changeset", "tombstones", "previousTombstones"])
    await fs.writeFile(path.join(directory, `${name}.${generation}.json`), Buffer.from("{}"));
  // 重载仍按 manifest 指向的代际读取，候选与已落盘解决保持可用。
  const loaded = await loadUpdateCandidate({ root: created.root, revisionId: stored.revisionId });
  expect(loaded.resolutions[conflict.id]).toBe("candidate");
  expect(loaded.conflicts.length).toBe(stored.conflicts.length);
});
