import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type {
  CoreCommand,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
  SourceSnapshotRecord,
} from "../src/shared/contracts";
import type { DocumentTree } from "../src/shared/document/tree";
import { testDocumentIds, testDocumentTree } from "./fixtures/document-tree";

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
let page: Page;
let errors: string[];

async function launch() {
  const visible = process.env.PAPER30MIN_TEST_WINDOW === "visible";
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PAPER30MIN_PROFILE: path.join(sandbox, "profile"),
    PAPER30MIN_TEST_WINDOW: visible ? "visible" : "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: ["."], env });
  desktopProcess = desktop.process();
  page = await desktop.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
}

async function closeDesktopForCleanup() {
  if (
    !desktopProcess ||
    desktopProcess.exitCode !== null ||
    desktopProcess.signalCode !== null
  ) return;
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxSyncOptions;
      if (
        options.message !== "有未保存的文档，确定放弃编辑并关闭吗？" ||
        options.buttons?.[1] !== "放弃并关闭"
      ) throw new Error("测试清理遇到非预期的原生确认框。");
      return 1;
    };
  });
  await desktop.close();
}

test.beforeEach(async () => {
  errors = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-core-electron-"));
  await launch();
});

test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    // The sandbox is an exclusively created test directory, never a user-selected path.
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

// Commands travel through the production preload, project:command IPC and the
// Node utility process; only the byte payloads are assembled inside the page.
function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

const create = (name: string) =>
  invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
const open = (root: string) =>
  invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
const readRevision = (root: string, revisionId: string) =>
  invoke<ProjectRevisionRecord>({ type: "coreReadRevision", root, revisionId });
const readSource = (root: string, sourceSnapshotId: string) =>
  invoke<SourceSnapshotRecord>({ type: "coreReadSource", root, sourceSnapshotId });
const readDocument = (
  root: string,
  revisionId: string,
  tree: "document" | "source-base" = "document",
) => invoke<DocumentTree>({ type: "coreReadDocument", root, revisionId, tree });

async function publishSource(
  root: string,
  files: Record<string, string>,
  metadata?: Record<string, unknown>,
) {
  return page.evaluate(({ root, files, metadata }) => {
    const encoder = new TextEncoder();
    return window.desktop.invoke({
      type: "corePublishSource",
      root,
      files: Object.fromEntries(
        Object.entries(files).map(([relative, text]) => [relative, encoder.encode(text)]),
      ),
      metadata,
    });
  }, { root, files, metadata }) as Promise<SourceSnapshotRecord>;
}

async function commit(
  root: string,
  baseRevision: string | null,
  sourceSnapshotId: string,
  document: DocumentTree,
  sourceBase: DocumentTree,
) {
  return page.evaluate(({ root, baseRevision, sourceSnapshotId, document, sourceBase }) => {
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    return window.desktop.invoke({
      type: "coreCommit",
      root,
      baseRevision,
      sourceSnapshotId,
      files: {
        "document.json": json(document),
        "source-base.json": json(sourceBase),
        "tombstones.json": json([]),
        "changeset.json": json({ baseRevision }),
      },
    });
  }, { root, baseRevision, sourceSnapshotId, document, sourceBase }) as Promise<ProjectRevisionRecord>;
}

const mergePublish = (
  root: string,
  baseRevision: string,
  sourceSnapshotId: string,
  candidate: DocumentTree,
  resolutions?: Array<{ conflictId: string; choice: "current" | "candidate" }>,
) => invoke<ProjectRevisionRecord>({
  type: "coreMergePublish",
  root,
  baseRevision,
  sourceSnapshotId,
  candidate,
  resolutions,
});

async function committedProject(name: string, title = "第一版") {
  const created = await create(name);
  const paperId = created.manifest.paper.id;
  const source = await publishSource(
    created.root,
    { "document.html": "<html>paper</html>" },
    { kind: "arxiv", canonicalId: "2401.00001v1" },
  );
  const tree = testDocumentTree(paperId, title);
  const revision = await commit(created.root, null, source.sourceSnapshotId, tree, tree);
  return { created, source, revision, paperId };
}

function withTrailingText(tree: DocumentTree, text: string): DocumentTree {
  const next = structuredClone(tree);
  const content = next.sentences[testDocumentIds.sentence].content;
  const last = content.at(-1);
  if (last?.kind !== "text") throw new Error("fixture 末尾不是文本");
  last.text = text;
  return next;
}

const trailingText = (tree: DocumentTree) =>
  tree.sentences[testDocumentIds.sentence].content.at(-1);

async function readManifest(root: string) {
  return JSON.parse(await fs.readFile(path.join(root, "paper30min.json"), "utf8"));
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(relative: string) {
    const directory = relative ? path.join(root, relative) : root;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else {
        entries[child] = createHash("sha256")
          .update(await fs.readFile(path.join(root, child)))
          .digest("hex");
      }
    }
  }
  await walk("");
  return entries;
}

test("project-core 真实 Electron 创建无 PDF 工程，首次提交后才正文可读", async () => {
  const created = await create("无 PDF 工程");
  expect(created.manifest.formatVersion).toBe(2);
  expect(created.manifest.paper.currentRevision).toBeNull();
  expect(created.importRecord).not.toBeNull();
  expect(await readManifest(created.root)).toEqual(created.manifest);
  await expect(fs.stat(path.join(created.root, "text"))).rejects.toThrow(/ENOENT/);

  const before = await open(created.root);
  expect(before.currentRevision).toBeNull();
  expect(before.importRecord).not.toBeNull();

  const source = await publishSource(
    created.root,
    { "document.html": "<html>paper</html>" },
    { kind: "arxiv", canonicalId: "2401.00001v1" },
  );
  expect(source.files.find((file) => file.path === "document.html")?.sha256)
    .toBe(createHash("sha256").update("<html>paper</html>").digest("hex"));
  await fs.access(path.join(created.root, source.path, "snapshot.json"));

  const paperId = created.manifest.paper.id;
  const tree = testDocumentTree(paperId, "第一版");
  const revision = await commit(created.root, null, source.sourceSnapshotId, tree, tree);
  const after = await open(created.root);
  expect(after.manifest.paper.currentRevision).toBe(revision.revisionId);
  expect(after.currentRevision?.revisionId).toBe(revision.revisionId);
  expect(after.importRecord).toBeNull();
  expect(await readDocument(created.root, revision.revisionId)).toEqual(tree);
  expect((await readManifest(created.root)).paper.currentRevision).toBe(revision.revisionId);
});

test("project-core 真实 Electron 重开与整体搬迁后身份和 current 不变", async () => {
  const { created, revision, paperId } = await committedProject("搬迁工程");
  await closeDesktopForCleanup();
  await launch();

  const reopened = await open(created.root);
  expect(reopened.manifest.id).toBe(created.manifest.id);
  expect(reopened.manifest.paper.id).toBe(paperId);
  expect(reopened.manifest.paper.currentRevision).toBe(revision.revisionId);

  const moved = path.join(sandbox, "搬迁后工程");
  await fs.rename(created.root, moved);
  const afterMove = await open(moved);
  expect(afterMove.manifest.id).toBe(created.manifest.id);
  expect(afterMove.manifest.paper.id).toBe(paperId);
  expect(afterMove.currentRevision?.revisionId).toBe(revision.revisionId);
  expect(await readDocument(moved, revision.revisionId))
    .toEqual(testDocumentTree(paperId, "第一版"));
});

test("project-core 真实 Electron 更新提交推进 current 且旧 revision 仍可读", async () => {
  const { created, source, revision: first, paperId } = await committedProject("更新工程");
  const second = await commit(
    created.root,
    first.revisionId,
    source.sourceSnapshotId,
    testDocumentTree(paperId, "第二版"),
    testDocumentTree(paperId, "第一版"),
  );
  expect(second.baseRevision).toBe(first.revisionId);
  const opened = await open(created.root);
  expect(opened.manifest.paper.currentRevision).toBe(second.revisionId);

  expect((await readRevision(created.root, first.revisionId)).revisionId)
    .toBe(first.revisionId);
  expect((await readDocument(created.root, first.revisionId))
    .sections[testDocumentIds.section].title).toBe("第一版");
  expect((await readDocument(created.root, second.revisionId))
    .sections[testDocumentIds.section].title).toBe("第二版");
  expect((await readDocument(created.root, second.revisionId, "source-base"))
    .sections[testDocumentIds.section].title).toBe("第一版");
});

test("project-core 真实 Electron 过期基线拒绝发布并保留 current", async () => {
  const { created, source, revision: first, paperId } = await committedProject("基线工程");
  const second = await commit(
    created.root,
    first.revisionId,
    source.sourceSnapshotId,
    testDocumentTree(paperId, "第二版"),
    testDocumentTree(paperId, "第一版"),
  );
  await expect(commit(
    created.root,
    first.revisionId,
    source.sourceSnapshotId,
    testDocumentTree(paperId, "过期候选"),
    testDocumentTree(paperId, "第一版"),
  )).rejects.toThrow(/baseRevision 已过期/);
  const opened = await open(created.root);
  expect(opened.manifest.paper.currentRevision).toBe(second.revisionId);
  expect((await readDocument(created.root, second.revisionId))
    .sections[testDocumentIds.section].title).toBe("第二版");
});

test("project-core 真实 Electron 并发同基线提交只有一个推进 current", async () => {
  const { created, source, revision: first, paperId } = await committedProject("并发工程");
  const results = await Promise.allSettled([
    commit(
      created.root,
      first.revisionId,
      source.sourceSnapshotId,
      testDocumentTree(paperId, "候选甲"),
      testDocumentTree(paperId, "第一版"),
    ),
    commit(
      created.root,
      first.revisionId,
      source.sourceSnapshotId,
      testDocumentTree(paperId, "候选乙"),
      testDocumentTree(paperId, "第一版"),
    ),
  ]);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<ProjectRevisionRecord> =>
      result.status === "fulfilled",
  );
  expect(fulfilled).toHaveLength(1);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(String(rejected?.reason)).toMatch(/基线/);
  const opened = await open(created.root);
  expect(opened.manifest.paper.currentRevision).toBe(fulfilled[0].value.revisionId);
  expect((await readDocument(created.root, fulfilled[0].value.revisionId))
    .sections[testDocumentIds.section].title).toMatch(/候选甲|候选乙/);
});

test("project-core 真实 Electron 外部篡改受管正文被识别并保留现场", async () => {
  const { created, revision } = await committedProject("篡改工程");
  const documentFile = path.join(created.root, revision.path, "document.json");
  const original = await fs.readFile(documentFile);
  await fs.writeFile(documentFile, Buffer.concat([original, Buffer.from(" ")]));

  await expect(open(created.root))
    .rejects.toThrow(/受管内容摘要不符或完整性校验失败/);
  await expect(readDocument(created.root, revision.revisionId))
    .rejects.toThrow(/受管内容摘要不符或完整性校验失败/);
  expect(await fs.readFile(documentFile)).toEqual(Buffer.concat([original, Buffer.from(" ")]));
  expect((await readManifest(created.root)).paper.currentRevision).toBe(revision.revisionId);
});

test("project-core 真实 Electron current 指向缺失 revision 时给出可行动错误", async () => {
  const { created, revision } = await committedProject("缺失工程");
  await fs.rm(path.join(created.root, revision.path), { recursive: true });
  await expect(open(created.root))
    .rejects.toThrow(/revision 不存在或内容不完整/);
  expect((await readManifest(created.root)).paper.currentRevision).toBe(revision.revisionId);
});

test("project-core 真实 Electron 旧 formatVersion 1 工程明确分流且目录不变", async () => {
  const legacyRoot = path.join(sandbox, "旧工程");
  await fs.mkdir(legacyRoot);
  await fs.writeFile(path.join(legacyRoot, "paper30min.json"), JSON.stringify({
    formatVersion: 1,
    id: "legacy-project",
    name: "旧工程",
    paper: { id: "legacy-paper", path: "text/paper.pdf", sha256: "0".repeat(64) },
  }));
  await fs.mkdir(path.join(legacyRoot, "text"));
  await fs.writeFile(path.join(legacyRoot, "text/paper.pdf"), "pdf bytes");
  const before = await treeSnapshot(legacyRoot);

  await expect(open(legacyRoot)).rejects.toThrow(/formatVersion: 1 旧格式/);
  expect(await treeSnapshot(legacyRoot)).toEqual(before);
});

test("project-core 真实 Electron 同名工程拒绝创建且不覆盖", async () => {
  const created = await create("同名工程");
  const before = await fs.readFile(path.join(created.root, "paper30min.json"), "utf8");
  await expect(create("同名工程")).rejects.toThrow(/同名工程文件夹已存在/);
  expect(await fs.readFile(path.join(created.root, "paper30min.json"), "utf8")).toBe(before);
});

test("project-core 真实 Electron 非法受管路径经生产 IPC 拒绝且磁盘不变", async () => {
  const created = await create("边界工程");
  const before = await treeSnapshot(created.root);
  await expect(page.evaluate(({ root }) => {
    const encoder = new TextEncoder();
    return window.desktop.invoke({
      type: "corePublishSource",
      root,
      files: { "..\\evil.txt": encoder.encode("evil") },
    });
  }, { root: created.root })).rejects.toThrow(/工程内相对路径/);
  expect(await treeSnapshot(created.root)).toEqual(before);
});

test("project-core 真实 Electron 首次导入失败后重开重试，工程身份不变", async () => {
  const created = await create("首导入恢复");
  const paperId = created.manifest.paper.id;
  const source = await publishSource(created.root, { "document.html": "<html>paper</html>" });
  await fs.rm(path.join(created.root, source.path), { recursive: true });
  const tree = testDocumentTree(paperId, "第一版");
  await expect(commit(created.root, null, source.sourceSnapshotId, tree, tree))
    .rejects.toThrow(/来源快照不存在/);

  await closeDesktopForCleanup();
  await launch();
  const reopened = await open(created.root);
  expect(reopened.manifest.id).toBe(created.manifest.id);
  expect(reopened.manifest.paper.id).toBe(paperId);
  expect(reopened.manifest.paper.currentRevision).toBeNull();
  expect(reopened.importRecord).not.toBeNull();

  const retrySource = await publishSource(created.root, { "document.html": "<html>paper</html>" });
  const revision = await commit(created.root, null, retrySource.sourceSnapshotId, tree, tree);
  const after = await open(created.root);
  expect(after.manifest.paper.currentRevision).toBe(revision.revisionId);
  expect(after.manifest.paper.id).toBe(paperId);
  expect(await readDocument(created.root, revision.revisionId)).toEqual(tree);
});

test("project-core 真实 Electron 来源合并发布保留本地修正并更新 source-base", async () => {
  const { created, revision: first, paperId } = await committedProject("合并工程");
  const baseTree = testDocumentTree(paperId, "第一版");
  const localText = " in 第一版 remains one sentence. local edit";
  const localSource = await publishSource(created.root, { "document.html": "<html>local</html>" });
  const localRevision = await commit(
    created.root,
    first.revisionId,
    localSource.sourceSnapshotId,
    withTrailingText(baseTree, localText),
    baseTree,
  );

  const sourceV2 = await publishSource(created.root, { "document.html": "<html>v2</html>" });
  const candidate = structuredClone(baseTree);
  candidate.sections[testDocumentIds.section].title = "来源 v2";
  const merged = await mergePublish(
    created.root,
    localRevision.revisionId,
    sourceV2.sourceSnapshotId,
    candidate,
  );
  const opened = await open(created.root);
  expect(opened.manifest.paper.currentRevision).toBe(merged.revisionId);

  const document = await readDocument(created.root, merged.revisionId);
  expect(document.sections[testDocumentIds.section].title).toBe("来源 v2");
  expect(trailingText(document)).toEqual({ kind: "text", text: localText });
  const sourceBase = await readDocument(created.root, merged.revisionId, "source-base");
  expect(sourceBase.sections[testDocumentIds.section].title).toBe("来源 v2");
  expect(trailingText(sourceBase))
    .toEqual({ kind: "text", text: " in 第一版 remains one sentence." });
});

test("project-core 真实 Electron 合并冲突未解决拒绝发布，显式解决后可发布", async () => {
  const { created, revision: first, paperId } = await committedProject("冲突工程");
  const baseTree = testDocumentTree(paperId, "第一版");
  const localText = " in 第一版 remains one sentence. local edit";
  const localSource = await publishSource(created.root, { "document.html": "<html>local</html>" });
  const localRevision = await commit(
    created.root,
    first.revisionId,
    localSource.sourceSnapshotId,
    withTrailingText(baseTree, localText),
    baseTree,
  );

  const sourceV2 = await publishSource(created.root, { "document.html": "<html>v2</html>" });
  const candidate = withTrailingText(baseTree, " in 第一版 remains one sentence. source edit");
  await expect(mergePublish(
    created.root,
    localRevision.revisionId,
    sourceV2.sourceSnapshotId,
    candidate,
  )).rejects.toThrow(new RegExp(`未解决冲突，不能发布：unit:${testDocumentIds.unit}（content）`));
  expect((await open(created.root)).manifest.paper.currentRevision)
    .toBe(localRevision.revisionId);

  const merged = await mergePublish(
    created.root,
    localRevision.revisionId,
    sourceV2.sourceSnapshotId,
    candidate,
    [{ conflictId: `unit:${testDocumentIds.unit}`, choice: "current" }],
  );
  const document = await readDocument(created.root, merged.revisionId);
  expect(trailingText(document)).toEqual({ kind: "text", text: localText });
  expect((await readSource(created.root, sourceV2.sourceSnapshotId)).sourceSnapshotId)
    .toBe(sourceV2.sourceSnapshotId);
});