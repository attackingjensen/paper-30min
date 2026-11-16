import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  commitRevision,
  createProject,
  openProject,
  publishSourceSnapshot,
  readRevision,
  readSourceSnapshot,
} from "../src/main/project-core";
import { testDocumentTree, testRevisionFiles } from "./fixtures/document-tree";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-project-core-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function committedProject(name = "已提交") {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: {
      "abs.html": Buffer.from("<html>metadata</html>"),
      "document.html": Buffer.from("<html>paper</html>"),
    },
    metadata: { kind: "arxiv", canonicalId: "2401.00001v1" },
  });
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "第一版"),
    metadata: { normalizationVersion: 1 },
  });
  return { created, source, revision };
}

test("project-core 创建无 PDF 工程，只保存主论文身份、空 current 和首次导入记录", async () => {
  const created = await createProject({ parent: sandbox, name: "论文" });
  const root = path.join(sandbox, "论文");
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "paper30min.json"), "utf8"),
  );

  expect(manifest).toEqual({
    formatVersion: 2,
    id: created.manifest.id,
    name: "论文",
    paper: {
      id: created.manifest.paper.id,
      currentRevision: null,
    },
  });
  expect(manifest.id).toMatch(uuid);
  expect(manifest.paper.id).toMatch(uuid);
  expect(manifest.paper.id).not.toBe(manifest.id);
  expect(created.root).toBe(root);
  expect(await fs.readdir(root)).toHaveLength(2);
  await expect(fs.readdir(root)).resolves.toEqual(
    expect.arrayContaining(["paper30min.json", ".paper30min"]),
  );

  const importRecord = JSON.parse(
    await fs.readFile(
      path.join(root, ".paper30min", "imports", "initial.json"),
      "utf8",
    ),
  );
  expect(importRecord).toEqual({
    formatVersion: 1,
    id: expect.stringMatching(uuid),
    projectId: manifest.id,
    paperId: manifest.paper.id,
  });
  expect(created.importRecord).toEqual(importRecord);
});

test("project-core 重开首次导入中断工程时保留身份，并明确正文尚未提交", async () => {
  const created = await createProject({ parent: sandbox, name: "中断恢复" });
  const firstImport = created.importRecord;
  const reopened = await openProject(created.root);

  expect(reopened.manifest).toEqual(created.manifest);
  expect(reopened.manifest.paper.currentRevision).toBeNull();
  expect(reopened.importRecord).toEqual(firstImport);
  await expect(
    fs.stat(path.join(created.root, "paper", "revisions")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("project-core 拒绝覆盖已有目录，也不把空 current 的损坏工程当成可恢复工程", async () => {
  const created = await createProject({ parent: sandbox, name: "保留现场" });
  await fs.rm(path.join(created.root, ".paper30min", "imports", "initial.json"));

  await expect(openProject(created.root)).rejects.toThrow("首次导入记录");
  await expect(
    createProject({ parent: sandbox, name: "保留现场" }),
  ).rejects.toThrow("已存在");
  expect(await fs.readFile(path.join(created.root, "paper30min.json"), "utf8"))
    .toContain('"formatVersion": 2');
});

test("project-core 对 formatVersion: 1 明确分流，不按新清单读取", async () => {
  const root = path.join(sandbox, "旧工程");
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "paper30min.json"),
    JSON.stringify({ formatVersion: 1 }),
  );

  await expect(openProject(root)).rejects.toThrow("旧格式");
});

test("project-core 发布来源快照和首个 revision 后才推进 current", async () => {
  const { created, source, revision } = await committedProject("首次发布");
  expect(created.manifest.paper.currentRevision).toBeNull();
  expect(source.sourceSnapshotId).toMatch(uuid);
  expect(source.path).toBe(`sources/${source.sourceSnapshotId}`);
  expect(source.files).toHaveLength(2);

  const snapshotJson = JSON.parse(
    await fs.readFile(path.join(created.root, source.path, "snapshot.json"), "utf8"),
  );
  expect(snapshotJson).toMatchObject({
    formatVersion: 1,
    sourceSnapshotId: source.sourceSnapshotId,
    projectId: created.manifest.id,
    paperId: created.manifest.paper.id,
    kind: "arxiv",
    canonicalId: "2401.00001v1",
  });
  expect(snapshotJson.files.every((file: { path: string }) => !path.isAbsolute(file.path)))
    .toBe(true);

  expect(revision.revisionId).toMatch(uuid);
  expect(revision.baseRevision).toBeNull();
  expect(revision.path).toBe(`paper/revisions/${revision.revisionId}`);
  const reopened = await openProject(created.root);
  expect(reopened.manifest.paper.currentRevision).toBe(revision.revisionId);
  expect(reopened.currentRevision).toEqual(revision);
  expect(reopened.importRecord).toBeNull();

  const revisionJson = JSON.parse(
    await fs.readFile(
      path.join(created.root, ".paper30min", "revisions", revision.revisionId, "revision.json"),
      "utf8",
    ),
  );
  expect(revisionJson).toMatchObject({
    revisionId: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    baseRevision: null,
    normalizationVersion: 1,
  });
  expect(revisionJson.path).not.toContain(created.root);
  expect(
    JSON.parse(await fs.readFile(path.join(created.root, revision.path, "document.json"), "utf8")),
  ).toEqual(testDocumentTree(created.manifest.paper.id, "第一版"));
});

test("project-core 修正产生新 revision，已发布正文和来源字节保持不变", async () => {
  const { created, source, revision: first } = await committedProject("不可变");
  const sourceFile = path.join(created.root, source.path, "document.html");
  const firstDocument = path.join(created.root, first.path, "document.json");
  const firstMetadata = path.join(
    created.root, ".paper30min", "revisions", first.revisionId, "revision.json",
  );
  const originalSource = await fs.readFile(sourceFile);
  const originalDocument = await fs.readFile(firstDocument);
  const originalMetadata = await fs.readFile(firstMetadata);

  const second = await commitRevision({
    root: created.root,
    baseRevision: first.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "本地修正", first.revisionId, "第一版"),
  });

  expect(second.revisionId).not.toBe(first.revisionId);
  expect(second.baseRevision).toBe(first.revisionId);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(second.revisionId);
  expect(await fs.readFile(sourceFile)).toEqual(originalSource);
  expect(await fs.readFile(firstDocument)).toEqual(originalDocument);
  expect(await fs.readFile(firstMetadata)).toEqual(originalMetadata);
  await expect(readRevision(created.root, first.revisionId)).resolves.toEqual(first);
});

test("project-core 识别来源和 current 内容的外部修改，不自动覆盖现场", async () => {
  const { created, source, revision } = await committedProject("外部修改");
  const sourceFile = path.join(created.root, source.path, "document.html");
  const originalSource = await fs.readFile(sourceFile);
  await fs.writeFile(sourceFile, "tampered");

  await expect(readSourceSnapshot(created.root, source.sourceSnapshotId))
    .rejects.toThrow(/摘要|完整性/);
  await expect(openProject(created.root)).resolves.toMatchObject({
    currentRevision: { revisionId: revision.revisionId },
  });

  await fs.writeFile(sourceFile, originalSource);
  const currentDocument = path.join(created.root, revision.path, "document.json");
  await fs.writeFile(currentDocument, "tampered");
  await expect(openProject(created.root)).rejects.toThrow(/摘要|完整性/);
  expect(await fs.readFile(currentDocument, "utf8")).toBe("tampered");
  expect(
    JSON.parse(await fs.readFile(path.join(created.root, "paper30min.json"), "utf8"))
      .paper.currentRevision,
  ).toBe(revision.revisionId);
});

test("project-core 拒绝缺少必需正文文件的 revision", async () => {
  const created = await createProject({ parent: sandbox, name: "缺文件" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  const files: Record<string, Buffer> = testRevisionFiles(created.manifest.paper.id, "不完整");
  delete files["changeset.json"];

  await expect(commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files,
  })).rejects.toThrow(/缺少|必需/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 来源发布故障只留下 staging，不产生可读取快照或 current", async () => {
  const created = await createProject({ parent: sandbox, name: "来源故障" });
  let sourceSnapshotId = "";
  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  }, {
    onCommitPoint(point, context) {
      if (point === "source-content") {
        sourceSnapshotId = context.sourceSnapshotId!;
        throw new Error("injected source failure");
      }
    },
  })).rejects.toThrow("injected source failure");

  expect(sourceSnapshotId).toMatch(uuid);
  await expect(fs.stat(path.join(created.root, "sources", sourceSnapshotId)))
    .rejects.toMatchObject({ code: "ENOENT" });
  const staging = await fs.readdir(path.join(created.root, ".paper30min", "staging"), {
    recursive: true,
  });
  expect(staging.some((entry) => entry.endsWith("document.html"))).toBe(true);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

for (const point of ["revision-content", "revision-metadata", "before-current-replace"] as const) {
  test(`project-core ${point} 故障时旧 current 完整且候选未成为 current`, async () => {
    const { created, source, revision: first } = await committedProject(`故障-${point}`);
    const manifestFile = path.join(created.root, "paper30min.json");
    const originalManifest = await fs.readFile(manifestFile);
    let candidateId = "";

    await expect(commitRevision({
      root: created.root,
      baseRevision: first.revisionId,
      sourceSnapshotId: source.sourceSnapshotId,
      files: testRevisionFiles(created.manifest.paper.id, "故障候选", first.revisionId, "第一版"),
    }, {
      async onCommitPoint(currentPoint, context) {
        if (currentPoint === point) {
          candidateId = context.revisionId!;
          await fs.writeFile(path.join(created.root, "fault-marker"), currentPoint);
          throw new Error(`injected ${point}`);
        }
      },
    })).rejects.toThrow(`injected ${point}`);

    expect(candidateId).toMatch(uuid);
    expect(candidateId).not.toBe(first.revisionId);
    expect(await fs.readFile(manifestFile)).toEqual(originalManifest);
    expect((await openProject(created.root)).currentRevision).toEqual(first);
    expect(
      await fs.readFile(path.join(created.root, first.path, "document.json"), "utf8"),
    ).toContain("第一版");
    expect(
      (await fs.stat(path.join(created.root, "paper", "revisions", candidateId))).isDirectory(),
    ).toBe(true);
    if (point === "revision-content") {
      await expect(readRevision(created.root, candidateId)).rejects.toThrow();
    } else {
      const candidate = await readRevision(created.root, candidateId);
      expect(candidate.revisionId).toBe(candidateId);
      expect(candidate.baseRevision).toBe(first.revisionId);
    }
    expect((await fs.readdir(created.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
}

test("project-core 发布前 current 被外部推进时拒绝覆盖并保留候选", async () => {
  const { created, source, revision: first } = await committedProject("基线竞争");
  const second = await commitRevision({
    root: created.root,
    baseRevision: first.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "第二版", first.revisionId, "第一版"),
  });
  const manifestFile = path.join(created.root, "paper30min.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.paper.currentRevision = first.revisionId;
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  let candidateId = "";

  await expect(commitRevision({
    root: created.root,
    baseRevision: first.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "过期候选", first.revisionId, "第一版"),
  }, {
    async onCommitPoint(point, context) {
      if (point === "revision-metadata") {
        candidateId = context.revisionId!;
        const changed = JSON.parse(await fs.readFile(manifestFile, "utf8"));
        changed.paper.currentRevision = second.revisionId;
        await fs.writeFile(manifestFile, JSON.stringify(changed, null, 2) + "\n");
      }
    },
  })).rejects.toThrow(/清单|基线|current/);

  expect(JSON.parse(await fs.readFile(manifestFile, "utf8")).paper.currentRevision)
    .toBe(second.revisionId);
  expect((await openProject(created.root)).currentRevision).toEqual(second);
  expect((await readRevision(created.root, candidateId)).baseRevision).toBe(first.revisionId);
});

test("project-core 整体搬迁后保持身份、current 和来源相对引用", async () => {
  const { created, source, revision } = await committedProject("搬迁前");
  const moved = path.join(sandbox, "搬迁后");
  await fs.rename(created.root, moved);

  const reopened = await openProject(moved);
  expect(reopened.root).toBe(await fs.realpath(moved));
  expect(reopened.manifest.id).toBe(created.manifest.id);
  expect(reopened.manifest.paper.id).toBe(created.manifest.paper.id);
  expect(reopened.currentRevision).toEqual(revision);
  expect((await readSourceSnapshot(moved, source.sourceSnapshotId)).path)
    .toBe(`sources/${source.sourceSnapshotId}`);
  expect(
    JSON.parse(await fs.readFile(path.join(moved, revision.path, "document.json"), "utf8")),
  ).toEqual(testDocumentTree(created.manifest.paper.id, "第一版"));
  expect(reopened.currentRevision?.path).not.toContain(moved);
});

test("project-core 写入端拒绝路径穿越和伪造资产摘要", async () => {
  const created = await createProject({ parent: sandbox, name: "写入校验" });
  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "../escape.html": Buffer.from("escape") },
  })).rejects.toThrow(/路径|名称/);
  expect(await fs.stat(path.join(sandbox, "escape.html")).catch(() => null)).toBeNull();

  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  const fakeHash = "0".repeat(64);
  await expect(commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      ...testRevisionFiles(created.manifest.paper.id, "资产错误"),
      [`assets/${fakeHash}.png`]: Buffer.from("not-the-hash"),
    },
  })).rejects.toThrow(/资产|摘要/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 受管写入不跟随 sources 目录链接", async () => {
  const created = await createProject({ parent: sandbox, name: "链接校验" });
  const outside = path.join(sandbox, "外部");
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(created.root, "sources"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  })).rejects.toThrow(/链接|联接/);
  expect(await fs.readdir(outside)).toEqual([]);
});

test("project-core 拒绝其他工程的来源快照身份", async () => {
  const first = await committedProject("来源工程");
  const second = await createProject({ parent: sandbox, name: "其他工程" });
  await fs.cp(
    path.join(first.created.root, "sources"),
    path.join(second.root, "sources"),
    { recursive: true },
  );

  await expect(commitRevision({
    root: second.root,
    baseRevision: null,
    sourceSnapshotId: first.source.sourceSnapshotId,
    files: testRevisionFiles(second.manifest.paper.id, "错绑来源"),
  })).rejects.toThrow(/身份|不匹配/);
  expect((await openProject(second.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 资产按实际内容摘要记录", async () => {
  const created = await createProject({ parent: sandbox, name: "资产摘要" });
  const asset = Buffer.from("image bytes");
  const sha256 = createHash("sha256").update(asset).digest("hex");
  const source = await publishSourceSnapshot({
    root: created.root,
    files: {
      "document.html": Buffer.from("paper"),
      [`assets/${sha256}.png`]: asset,
    },
  });
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      ...testRevisionFiles(created.manifest.paper.id, "含资产"),
      [`assets/${sha256}.png`]: asset,
    },
  });

  expect(source.files.find((file) => file.path.endsWith(".png"))).toMatchObject({ sha256 });
  expect(revision.files.find((file) => file.path.endsWith(".png"))).toMatchObject({ sha256 });
  await expect(openProject(created.root)).resolves.toMatchObject({
    currentRevision: { revisionId: revision.revisionId },
  });
});
