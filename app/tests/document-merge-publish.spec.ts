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
  readRevision,
  readRevisionDocument,
} from "../src/main/project-core";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
  resolveDocumentMergeCandidateConflict,
} from "../src/main/document/merge";
import { projectSentenceText } from "../src/shared/document/anchor";
import type { DocumentTree } from "../src/shared/document/tree";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-merge-publish-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function json(value: unknown) {
  return Buffer.from(JSON.stringify(value));
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

async function source(root: string) {
  return publishSourceSnapshot({
    root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
  });
}

async function commitTree(
  root: string,
  baseRevision: string | null,
  sourceSnapshotId: string,
  document: DocumentTree,
  sourceBase: DocumentTree,
  assets: Record<string, { bytes: Uint8Array; mime?: string }> = {},
) {
  return commitRevision({
    root,
    baseRevision,
    sourceSnapshotId,
    files: {
      "document.json": json(document),
      "source-base.json": json(sourceBase),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision }),
      ...assets,
    },
  });
}

async function initialProject(name: string, tree: DocumentTree) {
  const created = await createProject({ parent: sandbox, name });
  tree.paperId = created.manifest.paper.id;
  const initialSource = await source(created.root);
  const revision = await commitTree(
    created.root,
    null,
    initialSource.sourceSnapshotId,
    tree,
    tree,
  );
  return { created, initialSource, revision };
}

test("document-core 多轮真实发布后 current 保留本地修正，source-base 只含新来源", async () => {
  const base = testSelectionTree(randomUUID());
  const { created, revision: first } = await initialProject("多轮合并", base);
  const local = structuredClone(base);
  setFirstTrailingText(local, " local edit");
  const localSource = await source(created.root);
  const localRevision = await commitTree(
    created.root,
    first.revisionId,
    localSource.sourceSnapshotId,
    local,
    base,
  );

  const candidateV2 = structuredClone(base);
  setThirdSentence(candidateV2, "source v2");
  const sourceV2 = await source(created.root);
  const mergeV2 = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: localRevision.revisionId,
    sourceSnapshotId: sourceV2.sourceSnapshotId,
    candidate: candidateV2,
  });
  const publishedV2 = await publishDocumentMergeCandidate(mergeV2);

  const candidateV3 = structuredClone(mergeV2.sourceBase);
  setThirdSentence(candidateV3, "source v3");
  const sourceV3 = await source(created.root);
  const mergeV3 = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: publishedV2.revisionId,
    sourceSnapshotId: sourceV3.sourceSnapshotId,
    candidate: candidateV3,
  });
  const publishedV3 = await publishDocumentMergeCandidate(mergeV3);

  expect((await openProject(created.root)).manifest.paper.currentRevision)
    .toBe(publishedV3.revisionId);
  const current = await readRevisionDocument(created.root, publishedV3.revisionId, "document");
  const sourceBase = await readRevisionDocument(created.root, publishedV3.revisionId, "source-base");
  expect(current.sentences[selectionIds.sentence].content.at(-1))
    .toEqual({ kind: "text", text: " local edit" });
  expect(projectSentenceText(current, selectionIds.thirdSentence)).toBe("source v3");
  expect(sourceBase.sentences[selectionIds.sentence].content.at(-1))
    .not.toEqual({ kind: "text", text: " local edit" });
  expect(projectSentenceText(sourceBase, selectionIds.thirdSentence)).toBe("source v3");
});

test("document-core 未解决冲突不推进 current，显式解决后才发布", async () => {
  const base = testSelectionTree(randomUUID());
  const { created, revision: first } = await initialProject("冲突发布", base);
  const local = structuredClone(base);
  setThirdSentence(local, "local edit");
  const localSource = await source(created.root);
  const localRevision = await commitTree(
    created.root,
    first.revisionId,
    localSource.sourceSnapshotId,
    local,
    base,
  );
  const candidateTree = structuredClone(base);
  setThirdSentence(candidateTree, "source edit");
  const candidateSource = await source(created.root);
  const candidate = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: localRevision.revisionId,
    sourceSnapshotId: candidateSource.sourceSnapshotId,
    candidate: candidateTree,
  });

  await expect(publishDocumentMergeCandidate(candidate)).rejects.toThrow(/未解决|冲突/);
  expect((await openProject(created.root)).manifest.paper.currentRevision)
    .toBe(localRevision.revisionId);

  const resolved = resolveDocumentMergeCandidateConflict(
    candidate,
    candidate.conflicts[0].id,
    "candidate",
  );
  const published = await publishDocumentMergeCandidate(resolved);
  expect(published.revisionId).toBe(candidate.revisionId);
  expect(projectSentenceText(
    await readRevisionDocument(created.root, published.revisionId, "document"),
    selectionIds.thirdSentence,
  )).toBe("source edit");
});

test("document-core 发布前 current 已被其他操作推进时保留旧 current 与候选", async () => {
  const base = testSelectionTree(randomUUID());
  const { created, revision: first } = await initialProject("基线竞争", base);
  const candidateTree = structuredClone(base);
  setThirdSentence(candidateTree, "source edit");
  const candidateSource = await source(created.root);
  const candidate = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: first.revisionId,
    sourceSnapshotId: candidateSource.sourceSnapshotId,
    candidate: candidateTree,
  });
  const other = structuredClone(base);
  setFirstTrailingText(other, " other current");
  const otherSource = await source(created.root);
  const otherRevision = await commitTree(
    created.root,
    first.revisionId,
    otherSource.sourceSnapshotId,
    other,
    base,
  );

  await expect(publishDocumentMergeCandidate(candidate)).rejects.toThrow(/baseRevision|current|基线/);
  expect((await openProject(created.root)).manifest.paper.currentRevision)
    .toBe(otherRevision.revisionId);
  expect((await openProject(created.root)).manifest.paper.currentRevision)
    .not.toBe(candidate.revisionId);
});

test("document-core 合并发布携带 current 与 source-base 引用的资产并集", async () => {
  const base = testSelectionTree(randomUUID());
  const sourceAsset = Buffer.from("source asset");
  const sourceHash = createHash("sha256").update(sourceAsset).digest("hex");
  const localAsset = Buffer.from("local asset");
  const localHash = createHash("sha256").update(localAsset).digest("hex");
  const figureId = randomUUID();
  base.blocks.push({
    id: figureId,
    sectionId: selectionIds.section,
    kind: "figure",
    asset: { path: `assets/${sourceHash}.png`, sha256: sourceHash, mime: "image/png" },
    captionUnitId: null,
  });
  const created = await createProject({ parent: sandbox, name: "资产合并" });
  base.paperId = created.manifest.paper.id;
  const initialSource = await publishSourceSnapshot({
    root: created.root,
    files: {
      "document.html": Buffer.from("paper"),
      [`assets/${sourceHash}.png`]: { bytes: sourceAsset, mime: "image/png" },
    },
  });
  const first = await commitTree(
    created.root,
    null,
    initialSource.sourceSnapshotId,
    base,
    base,
    { [`assets/${sourceHash}.png`]: { bytes: sourceAsset, mime: "image/png" } },
  );
  const local = structuredClone(base);
  const localFigure = local.blocks.find((block) => block.id === figureId);
  if (localFigure?.kind !== "figure") throw new Error("fixture 图片块类型错误");
  localFigure.asset = { path: `assets/${localHash}.png`, sha256: localHash, mime: "image/png" };
  const localSource = await source(created.root);
  const localRevision = await commitTree(
    created.root,
    first.revisionId,
    localSource.sourceSnapshotId,
    local,
    base,
    {
      [`assets/${sourceHash}.png`]: { bytes: sourceAsset, mime: "image/png" },
      [`assets/${localHash}.png`]: { bytes: localAsset, mime: "image/png" },
    },
  );
  const candidateTree = structuredClone(base);
  setThirdSentence(candidateTree, "source edit");
  const candidateSource = await publishSourceSnapshot({
    root: created.root,
    files: {
      "document.html": Buffer.from("paper v2"),
      [`assets/${sourceHash}.png`]: { bytes: sourceAsset, mime: "image/png" },
    },
  });
  const candidate = await createDocumentMergeCandidate({
    root: created.root,
    baseRevision: localRevision.revisionId,
    sourceSnapshotId: candidateSource.sourceSnapshotId,
    candidate: candidateTree,
  });

  const published = await publishDocumentMergeCandidate(candidate);
  const revision = await readRevision(created.root, published.revisionId);
  expect(revision.files.map((file) => file.path)).toEqual(expect.arrayContaining([
    `assets/${sourceHash}.png`,
    `assets/${localHash}.png`,
  ]));
  const current = await readRevisionDocument(created.root, published.revisionId, "document");
  const sourceBase = await readRevisionDocument(created.root, published.revisionId, "source-base");
  const currentFigure = current.blocks.find((block) => block.id === figureId);
  const sourceFigure = sourceBase.blocks.find((block) => block.id === figureId);
  expect(currentFigure?.kind === "figure" ? currentFigure.asset?.sha256 : null).toBe(localHash);
  expect(sourceFigure?.kind === "figure" ? sourceFigure.asset?.sha256 : null).toBe(sourceHash);
});
