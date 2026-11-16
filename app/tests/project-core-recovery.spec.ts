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
  await expect(createProject({ parent: sandbox, name: "创建中断" }, {
    onCommitPoint(point) {
      if (point === "project-manifest") throw new Error("injected manifest failure");
    },
  })).rejects.toThrow("injected manifest failure");

  expect((await fs.stat(root)).isDirectory()).toBe(true);
  await expect(openProject(root)).rejects.toThrow(/清单|未完成创建/);
  await expect(createProject({ parent: sandbox, name: "创建中断" }))
    .rejects.toThrow("已存在");
  expect(await fs.stat(path.join(root, "paper30min.json")).catch(() => null)).toBeNull();
});

test("project-core 来源保留文件名按可搬迁的大小写规则拒绝", async () => {
  const created = await createProject({ parent: sandbox, name: "保留名" });
  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "Snapshot.json": Buffer.from("user content") },
  })).rejects.toThrow(/保留|覆盖/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 元数据写入预算在来源发布前失败", async () => {
  const created = await createProject({ parent: sandbox, name: "元数据预算" });
  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
    metadata: { description: "x".repeat(1024 * 1024) },
  })).rejects.toThrow(/1 MiB|预算/);

  await expect(fs.stat(path.join(created.root, "sources")))
    .rejects.toMatchObject({ code: "ENOENT" });
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

  expect(source.files).toEqual([
    expect.objectContaining({ path: "document.html", mime: "text/html" }),
  ]);
  expect((await readSourceSnapshot(created.root, source.sourceSnapshotId)).files)
    .toEqual([expect.objectContaining({ path: "document.html", mime: "text/html" })]);

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
  expect(revision.files.find((file) => file.path === "document.json")?.mime)
    .toBe("application/json");
  expect((await readRevision(created.root, revision.revisionId)).files
    .find((file) => file.path === "document.json")?.mime).toBe("application/json");
  expect((await openProject(created.root)).currentRevision?.files
    .find((file) => file.path === "document.json")?.mime).toBe("application/json");
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
  await fs.writeFile(
    path.join(created.root, ".paper30min", "imports", "initial.json"),
    "{",
  );

  const reopened = await openProject(created.root);
  expect(reopened.currentRevision).toEqual(revision);
  expect(reopened.importRecord).toBeNull();
});

test("project-core 同进程同基线并发提交只有一个成功", async () => {
  const { created, source, revision } = await committedProject("进程内并发");
  const attempt = (title: string) => commitRevision({
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
  await expect(commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "首导入候选"),
  }, {
    onCommitPoint(point, context) {
      if (point === "revision-metadata") {
        candidateId = context.revisionId!;
        throw new Error("injected first import failure");
      }
    },
  })).rejects.toThrow("injected first import failure");

  const reopened = await openProject(created.root);
  expect(reopened.manifest.paper.currentRevision).toBeNull();
  expect(reopened.importRecord).toEqual(created.importRecord);
  expect((await readRevision(created.root, candidateId)).baseRevision).toBeNull();
});

test("project-core current 替换前复核旧 revision 内容摘要", async () => {
  const { created, source, revision } = await committedProject("旧基线篡改");
  const manifestFile = path.join(created.root, "paper30min.json");
  let candidateId = "";
  await expect(commitRevision({
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "新候选", revision.revisionId),
  }, {
    async onCommitPoint(point, context) {
      if (point === "revision-metadata") {
        candidateId = context.revisionId!;
        await fs.writeFile(path.join(created.root, revision.path, "document.json"), "tampered");
      }
    },
  })).rejects.toThrow(/摘要|完整性/);

  expect(JSON.parse(await fs.readFile(manifestFile, "utf8")).paper.currentRevision)
    .toBe(revision.revisionId);
  await expect(openProject(created.root)).rejects.toThrow(/摘要|完整性/);
  expect((await readRevision(created.root, candidateId)).baseRevision)
    .toBe(revision.revisionId);
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
  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
    metadata: { files: [] },
  })).rejects.toThrow(/覆盖|核心/);
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  });
  await expect(commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: { ...testRevisionFiles(created.manifest.paper.id, "非法 JSON"), "changeset.json": Buffer.from("{") },
  })).rejects.toThrow(/JSON/);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("project-core 清单已提交但首次导入记录未提交时保留可诊断现场", async () => {
  const root = path.join(sandbox, "导入记录中断");
  await expect(createProject({ parent: sandbox, name: "导入记录中断" }, {
    onCommitPoint(point) {
      if (point === "import-record") throw new Error("injected import record failure");
    },
  })).rejects.toThrow("injected import record failure");

  expect(await fs.stat(path.join(root, "paper30min.json"))).toBeTruthy();
  await expect(openProject(root)).rejects.toThrow(/首次导入记录/);
  await expect(createProject({ parent: sandbox, name: "导入记录中断" }))
    .rejects.toThrow("已存在");
});

test("project-core 损坏的 revision 和首次导入 JSON 给出领域诊断", async () => {
  const { created, revision } = await committedProject("损坏 JSON");
  await fs.writeFile(
    path.join(created.root, ".paper30min", "revisions", revision.revisionId, "revision.json"),
    "{",
  );
  await expect(openProject(created.root)).rejects.toThrow(/revision.*(损坏|不完整)/);

  const initial = await createProject({ parent: sandbox, name: "损坏导入记录" });
  await fs.writeFile(path.join(initial.root, ".paper30min", "imports", "initial.json"), "{");
  await expect(openProject(initial.root)).rejects.toThrow(/首次导入记录.*(损坏|无效)/);
});

test("project-core 来源发布前工程身份变化时不得返回成功", async () => {
  const created = await createProject({ parent: sandbox, name: "来源身份竞争" });
  const manifestFile = path.join(created.root, "paper30min.json");
  let sourceSnapshotId = "";
  await expect(publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("paper") },
  }, {
    async onCommitPoint(point, context) {
      if (point === "source-content") {
        sourceSnapshotId = context.sourceSnapshotId!;
        const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
        manifest.id = randomUUID();
        manifest.paper.id = randomUUID();
        await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
      }
    },
  })).rejects.toThrow(/身份|清单/);

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

  await expect(readSourceSnapshot(created.root, source.sourceSnapshotId))
    .rejects.toThrow(/1 MiB|预算/);
});
