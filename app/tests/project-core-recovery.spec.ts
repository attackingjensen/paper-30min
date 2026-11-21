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
  readRevision,
  readRevisionDocument,
  readSourceSnapshot,
} from "../src/main/project-core";
import { testDocumentTree, testRevisionFiles } from "./fixtures/document-tree";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-project-recovery-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function committedProject(name = "恢复基线") {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "旧 current"),
  });
  return { created, source, revision };
}

test("project-core 工程目录已创建但清单未提交时保留现场并给出恢复诊断", async () => {
  const root = path.join(sandbox, "创建中断");
  await expect(
    createProject(
      { parent: sandbox, name: "创建中断" },
      {
        onCommitPoint(point) {
          if (point === "project-manifest") throw new Error("injected manifest failure");
        },
      },
    ),
  ).rejects.toThrow("injected manifest failure");

  expect((await fs.stat(root)).isDirectory()).toBe(true);
  await expect(openProject(root)).rejects.toThrow(/清单|未完成创建/);
  await expect(createProject({ parent: sandbox, name: "创建中断" })).rejects.toThrow("已存在");
  expect(await fs.stat(path.join(root, "paper30min.json")).catch(() => null)).toBeNull();
});

test("project-core 来源保留文件名按可搬迁的大小写规则拒绝", async () => {
  const created = await createProject({ parent: sandbox, name: "保留名" });
  await expect(
    publishSourceSnapshot({
      root: created.root,
      files: { "Snapshot.json": Buffer.from("user content") },
    }),
  ).rejects.toThrow(/保留|覆盖/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 元数据写入预算在来源发布前失败", async () => {
  const created = await createProject({ parent: sandbox, name: "元数据预算" });
  await expect(
    publishSourceSnapshot({
      root: created.root,
      files: { "document.html": Buffer.from("paper") },
      metadata: { description: "x".repeat(1024 * 1024) },
    }),
  ).rejects.toThrow(/1 MiB|预算/);

  await expect(fs.stat(path.join(created.root, "sources"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 文件摘要记录保留可选 MIME", async () => {
  const created = await createProject({ parent: sandbox, name: "MIME" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: {
      "document.html": { bytes: Buffer.from("paper"), mime: "text/html" },
    },
  });

  expect(source.files).toEqual([expect.objectContaining({ path: "document.html", mime: "text/html" })]);
  expect((await readSourceSnapshot(created.root, source.sourceSnapshotId)).files).toEqual([
    expect.objectContaining({ path: "document.html", mime: "text/html" }),
  ]);

  const document = Buffer.from(JSON.stringify(testDocumentTree(created.manifest.paper.id, "MIME")));
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      ...testRevisionFiles(created.manifest.paper.id, "MIME"),
      "document.json": { bytes: document, mime: "application/json" },
    },
  });
  expect(revision.files.find((file) => file.path === "document.json")?.mime).toBe("application/json");
  expect(
    (await readRevision(created.root, revision.revisionId)).files.find((file) => file.path === "document.json")?.mime,
  ).toBe("application/json");
  expect(
    (await openProject(created.root)).currentRevision?.files.find((file) => file.path === "document.json")?.mime,
  ).toBe("application/json");
});

test("project-core 普通计数字段不按凭据字段名误删", async () => {
  const created = await createProject({ parent: sandbox, name: "普通元数据" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
    metadata: { tokenCount: 128, converter: { name: "fixture" } },
  });

  expect(source).toMatchObject({
    tokenCount: 128,
    converter: { name: "fixture" },
  });
});

test("project-core current 完整时不让历史首次导入记录阻断阅读", async () => {
  const { created, revision } = await committedProject("历史记录损坏");
  await fs.writeFile(path.join(created.root, ".paper30min", "imports", "initial.json"), "{");

  const reopened = await openProject(created.root);
  expect(reopened.currentRevision).toEqual(revision);
  expect(reopened.importRecord).toBeNull();
});

test("project-core 同进程同基线并发提交只有一个成功", async () => {
  const { created, source, revision } = await committedProject("进程内并发");
  const attempt = (title: string) =>
    commitRevision({
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: source.sourceSnapshotId,
      files: testRevisionFiles(created.manifest.paper.id, title, revision.revisionId),
    });
  const results = await Promise.allSettled([attempt("候选 A"), attempt("候选 B")]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/基线|current/);
  const reopened = await openProject(created.root);
  expect(reopened.manifest.paper.currentRevision).toBe(fulfilled[0].value.revisionId);
  expect(reopened.currentRevision).toEqual(fulfilled[0].value);
});

test("project-core 首次导入候选发布后故障保留空 current 和完整候选", async () => {
  const created = await createProject({ parent: sandbox, name: "首导入故障" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  let candidateId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: null,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "首导入候选"),
      },
      {
        onCommitPoint(point, context) {
          if (point === "revision-metadata") {
            candidateId = context.revisionId!;
            throw new Error("injected first import failure");
          }
        },
      },
    ),
  ).rejects.toThrow("injected first import failure");

  const reopened = await openProject(created.root);
  expect(reopened.manifest.paper.currentRevision).toBeNull();
  expect(reopened.importRecord).toEqual(created.importRecord);
  expect((await readRevision(created.root, candidateId)).baseRevision).toBeNull();
});

test("project-core current 替换前复核旧 revision 内容摘要", async () => {
  const { created, source, revision } = await committedProject("旧基线篡改");
  const manifestFile = path.join(created.root, "paper30min.json");
  let candidateId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: revision.revisionId,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "新候选", revision.revisionId),
      },
      {
        async onCommitPoint(point, context) {
          if (point === "revision-metadata") {
            candidateId = context.revisionId!;
            await fs.writeFile(path.join(created.root, revision.path, "document.json"), "tampered");
          }
        },
      },
    ),
  ).rejects.toThrow(/摘要|完整性/);

  expect(JSON.parse(await fs.readFile(manifestFile, "utf8")).paper.currentRevision).toBe(revision.revisionId);
  await expect(openProject(created.root)).rejects.toThrow(/摘要|完整性/);
  expect((await readRevision(created.root, candidateId)).baseRevision).toBe(revision.revisionId);
});

test("project-core current 指向缺失 revision 时给出可行动诊断", async () => {
  const { created } = await committedProject("缺失 revision");
  const manifestFile = path.join(created.root, "paper30min.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.paper.currentRevision = randomUUID();
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

  await expect(openProject(created.root)).rejects.toThrow(/revision.*(不存在|不完整)/);
});

test("project-core 拒绝非法必需 JSON 和覆盖核心元数据字段", async () => {
  const created = await createProject({ parent: sandbox, name: "输入边界" });
  await expect(
    publishSourceSnapshot({
      root: created.root,
      files: { "document.html": Buffer.from("paper") },
      metadata: { files: [] },
    }),
  ).rejects.toThrow(/覆盖|核心/);
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  await expect(
    commitRevision({
      root: created.root,
      baseRevision: null,
      sourceSnapshotId: source.sourceSnapshotId,
      files: { ...testRevisionFiles(created.manifest.paper.id, "非法 JSON"), "changeset.json": Buffer.from("{") },
    }),
  ).rejects.toThrow(/JSON/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 清单已提交但首次导入记录未提交时保留可诊断现场", async () => {
  const root = path.join(sandbox, "导入记录中断");
  await expect(
    createProject(
      { parent: sandbox, name: "导入记录中断" },
      {
        onCommitPoint(point) {
          if (point === "import-record") throw new Error("injected import record failure");
        },
      },
    ),
  ).rejects.toThrow("injected import record failure");

  expect(await fs.stat(path.join(root, "paper30min.json"))).toBeTruthy();
  await expect(openProject(root)).rejects.toThrow(/首次导入记录/);
  await expect(createProject({ parent: sandbox, name: "导入记录中断" })).rejects.toThrow("已存在");
});

test("project-core 损坏的 revision 和首次导入 JSON 给出领域诊断", async () => {
  const { created, revision } = await committedProject("损坏 JSON");
  await fs.writeFile(path.join(created.root, ".paper30min", "revisions", revision.revisionId, "revision.json"), "{");
  await expect(openProject(created.root)).rejects.toThrow(/revision.*(损坏|不完整)/);

  const initial = await createProject({ parent: sandbox, name: "损坏导入记录" });
  await fs.writeFile(path.join(initial.root, ".paper30min", "imports", "initial.json"), "{");
  await expect(openProject(initial.root)).rejects.toThrow(/首次导入记录.*(损坏|无效)/);
});

test("project-core 来源发布前工程身份变化时不得返回成功", async () => {
  const created = await createProject({ parent: sandbox, name: "来源身份竞争" });
  const manifestFile = path.join(created.root, "paper30min.json");
  let sourceSnapshotId = "";
  await expect(
    publishSourceSnapshot(
      {
        root: created.root,
        files: { "document.html": Buffer.from("paper") },
      },
      {
        async onCommitPoint(point, context) {
          if (point === "source-content") {
            sourceSnapshotId = context.sourceSnapshotId!;
            const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
            manifest.id = randomUUID();
            manifest.paper.id = randomUUID();
            await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
          }
        },
      },
    ),
  ).rejects.toThrow(/身份|清单/);

  expect(sourceSnapshotId).not.toBe("");
  await expect(readSourceSnapshot(created.root, sourceSnapshotId)).rejects.toThrow(/身份|不匹配/);
});

test("project-core 读取端拒绝超过预算的受管 JSON", async () => {
  const created = await createProject({ parent: sandbox, name: "读取预算" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  await fs.writeFile(
    path.join(created.root, source.path, "snapshot.json"),
    JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
  );

  await expect(readSourceSnapshot(created.root, source.sourceSnapshotId)).rejects.toThrow(/1 MiB|预算/);
});

test("project-core 同一 revisionId 的残留候选拒绝不同正文或元数据后仍可原样重试", async () => {
  const created = await createProject({ parent: sandbox, name: "候选重试" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  const revisionId = randomUUID();
  const input = {
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    revisionId,
    files: testRevisionFiles(created.manifest.paper.id, "可重试候选"),
  } as const;

  await expect(
    commitRevision(input, {
      onCommitPoint(point) {
        if (point === "before-current-replace") throw new Error("injected retry failure");
      },
    }),
  ).rejects.toThrow("injected retry failure");
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();

  const candidate = await readRevision(created.root, revisionId);
  const documentFile = path.join(created.root, candidate.path, "document.json");
  const metadataFile = path.join(created.root, ".paper30min", "revisions", revisionId, "revision.json");
  const originalDocument = await fs.readFile(documentFile);
  const originalMetadata = await fs.readFile(metadataFile);

  await expect(
    commitRevision({
      ...input,
      files: testRevisionFiles(created.manifest.paper.id, "篡改候选"),
    }),
  ).rejects.toThrow(/受管内容摘要不符|完整性校验失败/);
  await expect(
    commitRevision({
      ...input,
      metadata: { origin: "tampered" },
    }),
  ).rejects.toThrow(/相同 revisionId|残留候选|拒绝覆盖/);
  expect(await fs.readFile(documentFile)).toEqual(originalDocument);
  expect(await fs.readFile(metadataFile)).toEqual(originalMetadata);
  expect(await readRevision(created.root, revisionId)).toEqual(candidate);
  expect(
    Object.values((await readRevisionDocument(created.root, revisionId, "document")).sections).map(
      (section) => section.title,
    ),
  ).toEqual(["可重试候选"]);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();

  await expect(commitRevision(input)).resolves.toMatchObject({ revisionId });
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(revisionId);
  expect(
    Object.values((await readRevisionDocument(created.root, revisionId, "document")).sections).map(
      (section) => section.title,
    ),
  ).toEqual(["可重试候选"]);
});

test("project-core completePublishedRevision 核验完整候选后只推进 current", async () => {
  const { completePublishedRevision } = await import("../src/main/project-core");
  const created = await createProject({ parent: sandbox, name: "候选完成" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  let candidateId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: null,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "完整候选"),
      },
      {
        onCommitPoint(point, context) {
          if (point === "before-current-replace") {
            candidateId = context.revisionId!;
            throw new Error("injected current failure");
          }
        },
      },
    ),
  ).rejects.toThrow("injected current failure");
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();

  const revision = await completePublishedRevision(created.root, candidateId);
  expect(revision.revisionId).toBe(candidateId);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(candidateId);
});

test("project-core completePublishedRevision 提交窗口内候选被篡改时拒绝推进", async () => {
  const { completePublishedRevision } = await import("../src/main/project-core");
  const created = await createProject({ parent: sandbox, name: "候选篡改" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  let candidateId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: null,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "待篡改候选"),
      },
      {
        onCommitPoint(point, context) {
          if (point === "before-current-replace") {
            candidateId = context.revisionId!;
            throw new Error("injected current failure");
          }
        },
      },
    ),
  ).rejects.toThrow("injected current failure");

  await expect(
    completePublishedRevision(created.root, candidateId, {
      async onCommitPoint(point) {
        if (point === "before-current-replace") {
          await fs.writeFile(path.join(created.root, "paper", "revisions", candidateId, "document.json"), "tampered");
        }
      },
    }),
  ).rejects.toThrow(/摘要|完整性/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core completePublishedRevision 提交窗口内元数据换源时拒绝推进", async () => {
  const { completePublishedRevision } = await import("../src/main/project-core");
  const created = await createProject({ parent: sandbox, name: "换源候选" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  let candidateId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: null,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "换源候选"),
      },
      {
        onCommitPoint(point, context) {
          if (point === "before-current-replace") {
            candidateId = context.revisionId!;
            throw new Error("injected current failure");
          }
        },
      },
    ),
  ).rejects.toThrow("injected current failure");

  await expect(
    completePublishedRevision(created.root, candidateId, {
      async onCommitPoint(point) {
        if (point === "before-current-replace") {
          // 只改元数据的 sourceSnapshotId（内容不动）：深度相等核验必须拒绝。
          const metaFile = path.join(created.root, ".paper30min", "revisions", candidateId, "revision.json");
          const record = JSON.parse(await fs.readFile(metaFile, "utf8"));
          record.sourceSnapshotId = randomUUID();
          await fs.writeFile(metaFile, JSON.stringify(record));
        }
      },
    }),
  ).rejects.toThrow(/元数据.*变化|摘要|完整性/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core inspectImportCandidate 区分已发布/残留/缺失，残留清理不碰已发布内容", async () => {
  const { inspectImportCandidate } = await import("../src/main/project-core");
  const created = await createProject({ parent: sandbox, name: "候选探测" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  // 缺失：内容目录不存在。
  const absentId = randomUUID();
  expect(await inspectImportCandidate(created.root, absentId)).toBe("absent");

  // 残留：内容目录存在但元数据未写（revision-content 中断）。
  let residualId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: null,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "残留候选"),
      },
      {
        onCommitPoint(point, context) {
          if (point === "revision-content") {
            residualId = context.revisionId!;
            throw new Error("injected content failure");
          }
        },
      },
    ),
  ).rejects.toThrow("injected content failure");
  expect(await inspectImportCandidate(created.root, residualId)).toBe("residual");
  await expect(fs.access(path.join(created.root, "paper", "revisions", residualId))).rejects.toThrow();

  // 已发布：内容与元数据都在（before-current-replace 中断）。
  let publishedId = "";
  await expect(
    commitRevision(
      {
        root: created.root,
        baseRevision: null,
        sourceSnapshotId: source.sourceSnapshotId,
        files: testRevisionFiles(created.manifest.paper.id, "完整候选"),
      },
      {
        onCommitPoint(point, context) {
          if (point === "before-current-replace") {
            publishedId = context.revisionId!;
            throw new Error("injected current failure");
          }
        },
      },
    ),
  ).rejects.toThrow("injected current failure");
  expect(await inspectImportCandidate(created.root, publishedId)).toBe("published");
  // 已发布内容不被清理。
  await expect(
    fs.access(path.join(created.root, "paper", "revisions", publishedId, "document.json")),
  ).resolves.toBeUndefined();
});
