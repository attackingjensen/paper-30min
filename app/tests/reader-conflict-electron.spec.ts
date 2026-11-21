// 来源候选冲突宿主真实 Electron 回归（SPEC-reader §9，paper-30min-qa3.4）：
// 受控 fixture 端点（回环 http）驱动检查更新→候选→逐项解决→发布全链路；
// 未解决不能发布，解决状态落盘，基线被推进时拒绝发布且保留解决结果；
// 发布成功后 reader 按新 revision 恢复正文。渲染进程零远端请求。
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:http";
import type {
  ArxivImportCommandResult,
  CoreCommand,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
} from "../src/shared/contracts";
import type { DocumentTree } from "../src/shared/document/tree";
import { absHtml } from "./fixtures/arxiv-abs";
import { latexmlDocument } from "./fixtures/arxiv-latexml";

const ID = "2401.01234";
const ABS_PATH = `/abs/${ID}v1`;
const HTML_PATH = `/html/${ID}v1`;
const FIG1_PATH = `/html/extracted/6543210/figures/overview.png`;
const FIG2_PATH = `/html/x2.png`;
const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
let page: Page;
let errors: string[];
let remotePageRequests: string[];
let server: Server | null = null;
let baseUrl = "";
let routes: Map<string, { bytes: Buffer; mime: string }>;

function fullRoutes(): Map<string, { bytes: Buffer; mime: string }> {
  return new Map([
    [`/abs/${ID}`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], latest: 2 })), mime: "text/html" }],
    [ABS_PATH, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], latest: 1 })), mime: "text/html" }],
    [`/abs/${ID}v2`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], latest: 2 })), mime: "text/html" }],
    [HTML_PATH, { bytes: Buffer.from(latexmlDocument()), mime: "text/html" }],
    [
      `/html/${ID}v2`,
      {
        bytes: Buffer.from(
          latexmlDocument()
            .replace('content="2401.01234v1"', 'content="2401.01234v2"')
            .replace("We study energy and mass.", "We study energy and mass. source rewrite"),
        ),
        mime: "text/html",
      },
    ],
    [FIG1_PATH, { bytes: PNG1, mime: "image/png" }],
    [FIG2_PATH, { bytes: PNG2, mime: "image/png" }],
  ]);
}

async function startServer() {
  routes = fullRoutes();
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.mime });
    res.end(route.bytes);
  });
  const listening = Promise.withResolvers<void>();
  server!.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server!.address();
  if (address === null || typeof address === "string") throw new Error("fixture 服务未监听端口");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (!server) return;
  const closing = server;
  server = null;
  closing.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  closing.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
}

async function launch() {
  const visible = process.env.PAPER30MIN_TEST_WINDOW === "visible";
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    PAPER30MIN_PROFILE: path.join(sandbox, "profile"),
    PAPER30MIN_TEST_WINDOW: visible ? "visible" : "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: ["."], env });
  desktopProcess = desktop.process();
  page = await desktop.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/i.test(url)) remotePageRequests.push(url);
  });
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
}

async function closeDesktopForCleanup() {
  if (!desktopProcess || desktopProcess.exitCode !== null || desktopProcess.signalCode !== null) return;
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxSyncOptions;
      if (options.message !== "有未保存的文档，确定放弃编辑并关闭吗？" || options.buttons?.[1] !== "放弃并关闭")
        throw new Error("测试清理遇到非预期的原生确认框。");
      return 1;
    };
  });
  await desktop.close();
}

test.beforeEach(async () => {
  errors = [];
  remotePageRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reader-conflict-"));
  await startServer();
  await launch();
});

test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
    expect(remotePageRequests).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    await stopServer();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

/** 导入 v1 并制造本地修正：摘要句被本地改写，与 v2 来源改写形成 content 冲突。 */
async function conflictedProject(name: string) {
  const imported = await invoke<ArxivImportCommandResult>({
    type: "coreArxivImport",
    parent: sandbox,
    name,
    input: `${ID}v1`,
    operationId: `op-${name}`,
    baseUrl,
  });
  expect(imported.ok, imported.ok ? "" : JSON.stringify(imported.diagnostic)).toBe(true);
  if (!imported.ok) throw new Error(imported.diagnostic.messageKey);
  const root = imported.root;
  const revision = imported.revision;
  const tree = await invoke<DocumentTree>({
    type: "coreReadDocument",
    root,
    revisionId: revision.revisionId,
    tree: "document",
  });
  const sourceBase = await invoke<DocumentTree>({
    type: "coreReadDocument",
    root,
    revisionId: revision.revisionId,
    tree: "source-base",
  });
  const unit = Object.values(tree.units).find((candidate) =>
    candidate.sentenceIds.some((id) =>
      tree.sentences[id].content.some((part) => part.kind === "text" && part.text.includes("We study energy")),
    ),
  )!;
  const sentenceId = unit.sentenceIds[0];
  tree.sentences[sentenceId].content = [{ kind: "text", text: "We study energy and mass. local rewrite" }];
  // 编辑提交携带基线全部受管资产。
  const revisionRecord = await invoke<ProjectRevisionRecord>({
    type: "coreReadRevision",
    root,
    revisionId: revision.revisionId,
  });
  const files: Record<string, Uint8Array> = {
    "document.json": new TextEncoder().encode(JSON.stringify(tree)),
    "source-base.json": new TextEncoder().encode(JSON.stringify(sourceBase)),
    "tombstones.json": new TextEncoder().encode("[]"),
    "changeset.json": new TextEncoder().encode(JSON.stringify({ baseRevision: revision.revisionId })),
  };
  for (const file of revisionRecord.files) {
    if (!file.path.startsWith("assets/")) continue;
    files[file.path] = new Uint8Array(await fs.readFile(path.join(root, revisionRecord.path, file.path)));
  }
  const edited = await page.evaluate<
    ProjectRevisionRecord,
    { root: string; baseRevision: string; sourceSnapshotId: string; files: Record<string, Uint8Array> }
  >(
    ({ root, baseRevision, sourceSnapshotId, files }) =>
      window.desktop.invoke({ type: "coreCommit", root, baseRevision, sourceSnapshotId, files }),
    { root, baseRevision: revision.revisionId, sourceSnapshotId: revision.sourceSnapshotId, files },
  );
  return { root, imported, edited };
}

async function openFolder(root: string) {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
}

test("reader 冲突宿主：逐项解决前不能发布，采用 candidate 后发布并恢复新正文", async () => {
  const { root, edited } = await conflictedProject("冲突解决");
  await openFolder(root);
  const reader = page.locator(".full-reader");
  await expect(reader).toBeVisible();
  await expect(reader).toContainText("local rewrite");
  // 显式检查更新 → v2 候选进入冲突宿主。
  await reader.getByRole("button", { name: "检查来源更新" }).click();
  const host = reader.locator(".conflict-host");
  await expect(host).toBeVisible({ timeout: 30000 });
  await expect(host.locator(".conflict-count")).toContainText("未解决");
  const items = host.locator(".conflict-item");
  expect(await items.count()).toBeGreaterThan(0);
  // 冲突呈现 base/current/candidate 三方内容。
  const first = items.first();
  await expect(first).toContainText("内容冲突");
  await expect(first.locator(".conflict-sides")).toContainText("local rewrite");
  await expect(first.locator(".conflict-sides")).toContainText("source rewrite");
  // 未解决时发布按钮禁用。
  const publishButton = host.getByRole("button", { name: "发布候选为新 current" });
  await expect(publishButton).toBeDisabled();
  // 逐项解决：全部采用 candidate。
  const count = await items.count();
  for (let index = 0; index < count; index++) {
    await items.nth(index).getByRole("button", { name: "采用 candidate" }).click();
    await expect(items.nth(index)).toHaveClass(/resolved/);
  }
  await expect(host.locator(".conflict-count")).toContainText("未解决 0");
  await expect(publishButton).toBeEnabled();
  // 解决期间 current 未被推进。
  const during = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(during.currentRevision?.revisionId).toBe(edited.revisionId);
  // 阅读流预览可见。
  await host.getByRole("button", { name: "预览发布后阅读流" }).click();
  await expect(host.locator(".conflict-order-preview")).toBeVisible();
  await publishButton.click();
  await expect(host).toHaveCount(0);
  // 发布后正文恢复为 candidate 内容，本地改写被显式替换。
  await expect(reader).toContainText("source rewrite", { timeout: 30000 });
  await expect(reader).not.toContainText("local rewrite");
  const after = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(after.currentRevision?.revisionId).not.toBe(edited.revisionId);
  await page.screenshot({ path: "test-results/reader-conflict-published.png", fullPage: false });
});

test("reader 冲突宿主：保留 current 的解决落盘，重开候选后状态仍在", async () => {
  const { root, edited } = await conflictedProject("解决保留");
  await openFolder(root);
  const reader = page.locator(".full-reader");
  await reader.getByRole("button", { name: "检查来源更新" }).click();
  const host = reader.locator(".conflict-host");
  await expect(host).toBeVisible({ timeout: 30000 });
  const first = host.locator(".conflict-item").first();
  const conflictId = await first.getAttribute("data-conflict-id");
  await first.getByRole("button", { name: "保留 current" }).click();
  await expect(first).toHaveClass(/resolved/);
  await expect(first.locator(".conflict-state")).toContainText("保留 current");
  // 关闭宿主后重新检查更新：同一候选身份重载，解决状态来自存储。
  await host.getByRole("button", { name: "返回阅读" }).click();
  await expect(host).toHaveCount(0);
  await reader.getByRole("button", { name: "检查来源更新" }).click();
  const reopened = reader.locator(".conflict-host");
  await expect(reopened).toBeVisible({ timeout: 30000 });
  const same = reopened.locator(`[data-conflict-id="${conflictId}"]`);
  await expect(same).toHaveClass(/resolved/);
  await expect(same.locator(".conflict-state")).toContainText("保留 current");
  // current 仍是本地修正版本。
  const current = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(current.currentRevision?.revisionId).toBe(edited.revisionId);
});

test("reader 冲突宿主：发布前 current 被推进时拒绝，解决结果保留，正文仍可读", async () => {
  const { root, edited } = await conflictedProject("基线拒绝");
  await openFolder(root);
  const reader = page.locator(".full-reader");
  await reader.getByRole("button", { name: "检查来源更新" }).click();
  // 工程 watcher 可能在候选构建后触发重读（.full-reader 卸载）：等回到 ready，
  // 宿主若被卸载则重新检查更新，再对当前挂载的列表逐项解决。
  await expect(reader).toBeVisible({ timeout: 30000 });
  let host = reader.locator(".conflict-host");
  if ((await host.count()) === 0) {
    await reader.getByRole("button", { name: "检查来源更新" }).click();
    host = reader.locator(".conflict-host");
  }
  await expect(host).toBeVisible({ timeout: 30000 });
  const items = host.locator(".conflict-item");
  await expect(items.first()).toBeVisible();
  const count = await items.count();
  expect(count).toBeGreaterThan(0);
  // 逐项解决并等待落盘呈现：慢 runner 上不得把未消费的点击当成已解决。
  for (let index = 0; index < count; index++) {
    await items.nth(index).getByRole("button", { name: "保留 current" }).click();
    await expect(items.nth(index)).toHaveClass(/resolved/);
  }
  await expect(host.getByRole("button", { name: "发布候选为新 current" })).toBeEnabled();
  // 另一操作经 IPC 推进 current。
  const tree = await invoke<DocumentTree>({
    type: "coreReadDocument",
    root,
    revisionId: edited.revisionId,
    tree: "document",
  });
  const sourceBase = await invoke<DocumentTree>({
    type: "coreReadDocument",
    root,
    revisionId: edited.revisionId,
    tree: "source-base",
  });
  const revisionRecord = await invoke<ProjectRevisionRecord>({
    type: "coreReadRevision",
    root,
    revisionId: edited.revisionId,
  });
  const files: Record<string, Uint8Array> = {
    "document.json": new TextEncoder().encode(JSON.stringify(tree)),
    "source-base.json": new TextEncoder().encode(JSON.stringify(sourceBase)),
    "tombstones.json": new TextEncoder().encode("[]"),
    "changeset.json": new TextEncoder().encode(JSON.stringify({ baseRevision: edited.revisionId })),
  };
  for (const file of revisionRecord.files) {
    if (!file.path.startsWith("assets/")) continue;
    files[file.path] = new Uint8Array(await fs.readFile(path.join(root, revisionRecord.path, file.path)));
  }
  const advanced = await page.evaluate<
    ProjectRevisionRecord,
    { root: string; baseRevision: string; sourceSnapshotId: string; files: Record<string, Uint8Array> }
  >(
    ({ root, baseRevision, sourceSnapshotId, files }) =>
      window.desktop.invoke({ type: "coreCommit", root, baseRevision, sourceSnapshotId, files }),
    { root, baseRevision: edited.revisionId, sourceSnapshotId: revisionRecord.sourceSnapshotId, files },
  );
  // 等待 reader 按新 current 完成重读（watchProject → epoch 刷新），
  // 避免发布点击落在 loading 卸载窗口上丢失。
  await expect(reader).toHaveAttribute("data-revision-id", advanced.revisionId, { timeout: 15000 });
  await expect(host.getByRole("button", { name: "发布候选为新 current" })).toBeEnabled();
  await host.getByRole("button", { name: "发布候选为新 current" }).click();
  await expect(host.locator(".conflict-error").filter({ hasText: "已被另一操作推进" })).toBeVisible();
  await expect(host.locator(".conflict-error").filter({ hasText: "baseMismatch" })).toBeVisible();
  // 解决结果保留：全部项仍是 resolved。
  for (let index = 0; index < count; index++) await expect(items.nth(index)).toHaveClass(/resolved/);
  // current 是外部推进结果，正文仍可读。
  const current = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(current.currentRevision?.revisionId).toBe(advanced.revisionId);
  await expect(reader).toContainText("local rewrite");
});
