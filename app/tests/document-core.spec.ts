import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
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
import { parseDocumentTree } from "../src/shared/document/tree";
import {
  testDocumentIds,
  testDocumentTree,
  testRevisionFiles,
} from "./fixtures/document-tree";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-document-core-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function createdProject() {
  const created = await createProject({ parent: sandbox, name: "文档树" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
  });
  return { created, source };
}

test("document-core current 与 source-base 共用树 schema，重开保留五类 ID 和已存句子边界", async () => {
  const { created, source } = await createdProject();
  const paperId = created.manifest.paper.id;
  const tree = testDocumentTree(paperId, "稳定正文");
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(paperId, "稳定正文"),
  });
  const documentFile = path.join(created.root, revision.path, "document.json");
  const sourceBaseFile = path.join(created.root, revision.path, "source-base.json");
  const originalDocument = await fs.readFile(documentFile);
  const originalSourceBase = await fs.readFile(sourceBaseFile);

  const reopened = await openProject(created.root);
  expect(reopened.manifest.paper.currentRevision).toBe(revision.revisionId);
  const current = await readRevisionDocument(created.root, revision.revisionId, "document");
  const sourceBase = await readRevisionDocument(created.root, revision.revisionId, "source-base");

  expect(current).toEqual(tree);
  expect(sourceBase).toEqual(tree);
  expect({
    sections: Object.keys(current.sections),
    units: Object.keys(current.units),
    sentences: Object.keys(current.sentences),
    atoms: Object.keys(current.atoms),
    blocks: current.blocks.map((block) => block.id),
  }).toEqual({
    sections: [testDocumentIds.section],
    units: [testDocumentIds.unit],
    sentences: [testDocumentIds.sentence],
    atoms: [testDocumentIds.atom],
    blocks: [testDocumentIds.block],
  });
  expect(current.sentences[testDocumentIds.sentence].content)
    .toEqual(tree.sentences[testDocumentIds.sentence].content);
  expect(Object.keys(current.sentences)).toHaveLength(1);
  expect(await fs.readFile(documentFile)).toEqual(originalDocument);
  expect(await fs.readFile(sourceBaseFile)).toEqual(originalSourceBase);
});

test("document-core 提交对 current 与 source-base 执行同一引用完整性校验", async () => {
  const { created, source } = await createdProject();
  const paperId = created.manifest.paper.id;
  const invalidCurrent = testDocumentTree(paperId);
  invalidCurrent.blocks[0].kind = "unit";
  if (invalidCurrent.blocks[0].kind !== "unit") throw new Error("fixture 类型错误");
  invalidCurrent.blocks[0].unitId = randomUUID();
  const invalidSourceBase = testDocumentTree(paperId);
  invalidSourceBase.sentences[testDocumentIds.sentence].unitId = randomUUID();

  await expect(commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      ...testRevisionFiles(paperId, "有效正文"),
      "document.json": Buffer.from(JSON.stringify(invalidCurrent)),
    },
  })).rejects.toThrow(/文档树|引用/);
  await expect(commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      ...testRevisionFiles(paperId, "有效正文"),
      "source-base.json": Buffer.from(JSON.stringify(invalidSourceBase)),
    },
  })).rejects.toThrow(/文档树|引用/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("document-core 拒绝跨节点类型重复 ID", () => {
  const tree = testDocumentTree(randomUUID());
  tree.blocks[0].id = testDocumentIds.section;

  expect(() => parseDocumentTree(tree)).toThrow(/ID|唯一|重复/);
});

test("document-core 拒绝原子与所属单元不一致", () => {
  const tree = testDocumentTree(randomUUID());
  tree.atoms[testDocumentIds.atom].unitId = randomUUID();

  expect(() => parseDocumentTree(tree)).toThrow(/atom|原子|所属|引用/);
});

test("document-core 拒绝与清单 paperId 不匹配的正文树", () => {
  const tree = testDocumentTree(randomUUID());

  expect(() => parseDocumentTree(tree, randomUUID())).toThrow(/paperId|论文身份/);
});
