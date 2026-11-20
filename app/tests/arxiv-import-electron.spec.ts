// 真实 Electron 高层回归（SPEC-arxiv-import Testing Strategy）：
// 生产 preload、project:command IPC、Node utility process 与真实 undici transport，
// 端点经 baseUrl 映射到本地受控 fixture 服务（回环 http，spec §2.4），不访问真实 arXiv。
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
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type {
  ArxivImportCommandResult,
  ArxivPdfFallbackCommandResult,
  ArxivUpdateCandidateCommandResult,
  ArxivUpdateCheckCommandResult,
  ArxivUpdatePublishCommandResult,
  CoreCommand,
  ProjectCoreSnapshot,
} from "../src/shared/contracts";
import type { DocumentTree } from "../src/shared/document/tree";
import { absHtml } from "./fixtures/arxiv-abs";
import { latexmlDocument, FIG1_SRC, FIG2_SRC } from "./fixtures/arxiv-latexml";

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
let requests: string[] = [];
let routes: Map<string, { bytes: Buffer; mime: string }>;

function fullRoutes(): Map<string, { bytes: Buffer; mime: string }> {
  return new Map([
    [`/abs/${ID}`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1] })), mime: "text/html" }],
    [ABS_PATH, { bytes: Buffer.from(absHtml({ id: ID, versions: [1] })), mime: "text/html" }],
    [HTML_PATH, { bytes: Buffer.from(latexmlDocument()), mime: "text/html" }],
    [FIG1_PATH, { bytes: PNG1, mime: "image/png" }],
    [FIG2_PATH, { bytes: PNG2, mime: "image/png" }],
  ]);
}

async function startServer() {
  routes = fullRoutes();
  requests = [];
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const route = routes.get(url);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.mime });
    res.end(route.bytes);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  if (address === null || typeof address === "string") throw new Error("fixture 服务未监听端口");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (!server) return;
  const closing = server;
  server = null;
  closing.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    closing.close((error) => (error ? reject(error) : resolve())),
  );
}

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
  // 渲染进程不得发起任何远端加载：正文与资产只经 paper30min:// 本地协议。
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/i.test(url)) remotePageRequests.push(url);
  });
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible();
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
  remotePageRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-arxiv-electron-"));
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

// 命令经生产 preload、project:command IPC 与 Node utility process 执行。
function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

let operationSeq = 0;
const importPaper = (name: string, input: string) =>
  invoke<ArxivImportCommandResult>({ type: "coreArxivImport", parent: sandbox, name, input, operationId: `op-${++operationSeq}`, baseUrl });
const resume = (root: string) =>
  invoke<ArxivImportCommandResult>({ type: "coreArxivResume", root, operationId: `op-${++operationSeq}`, baseUrl });
const open = (root: string) => invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
const readDocument = (root: string, revisionId: string) =>
  invoke<DocumentTree>({ type: "coreReadDocument", root, revisionId, tree: "document" });

function treeTexts(tree: DocumentTree): string[] {
  return Object.values(tree.units).flatMap((unit) =>
    unit.sentenceIds.flatMap((id) =>
      tree.sentences[id].content.map((part) => (part.kind === "text" ? part.text : "")),
    ),
  );
}

/** 按阅读块顺序投影正文：阅读顺序的权威比较口径（单元表遍历顺序不是阅读顺序）。 */
function orderedTreeTexts(tree: DocumentTree): string[] {
  const unitText = (unitId: string) =>
    tree.units[unitId].sentenceIds
      .map((id) => tree.sentences[id].content.map((part) => (part.kind === "text" ? part.text : "")).join(""))
      .join("");
  return tree.blocks.flatMap((block) => {
    if (block.kind === "unit") return [unitText(block.unitId)];
    if (block.kind === "figure") return block.captionUnitId ? [unitText(block.captionUnitId)] : [];
    if (block.kind === "table")
      return [...(block.captionUnitId ? [block.captionUnitId] : []), ...block.rows.flat().map((cell) => cell.unitId)].map(unitText);
    if (block.kind === "formula") return [block.text];
    return [block.text];
  });
}

test("arxiv-import 真实 Electron 裸 ID 创建无 PDF 工程，断网重开后完整阅读", async () => {
  const result = await importPaper("离线阅读", ID);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.reference).toEqual({ baseId: ID, version: 1, canonicalId: `${ID}v1` });
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
  await expect(fs.stat(path.join(result.root, "paper", "paper.pdf"))).rejects.toThrow(/ENOENT/);

  const tree = await readDocument(result.root, result.revision.revisionId);
  expect(treeTexts(tree).some((text) => text.includes("We study energy and mass."))).toBe(true);
  const figures = tree.blocks.filter((block) => block.kind === "figure" && block.asset !== null);
  expect(figures.length).toBe(2);

  // 关闭网络与应用后重开：正文与资产全部来自本地 current revision。
  const requestsBefore = requests.length;
  await stopServer();
  await closeDesktopForCleanup();
  await launch();
  const reopened = await open(result.root);
  expect(reopened.manifest.paper.currentRevision).toBe(result.revision.revisionId);
  const offlineTree = await readDocument(result.root, result.revision.revisionId);
  expect(offlineTree).toEqual(tree);
  for (const block of figures) {
    if (block.kind !== "figure" || !block.asset) continue;
    const bytes = await fs.readFile(path.join(result.root, "paper", "revisions", result.revision.revisionId, block.asset.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(block.asset.sha256);
  }
  // 已完成工程的恢复是幂等的：不重复快照或 revision，也不发起网络请求。
  const resumed = await resume(result.root);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.revision.revisionId).toBe(result.revision.revisionId);
  expect(requests.length).toBe(requestsBefore);
});

test("arxiv-import 真实 Electron 首次导入失败保留现场，重试恢复工程身份不变", async () => {
  routes.delete(HTML_PATH);
  const failed = await importPaper("失败恢复", ID);
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.diagnostic.stage).toBe("fetch");
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
  const opened = await open(failed.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "resolve", reference: { version: 1 } });

  routes.set(HTML_PATH, { bytes: Buffer.from(latexmlDocument()), mime: "text/html" });
  const resumed = await resume(failed.root);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  const after = await open(failed.root);
  expect(after.manifest.paper.currentRevision).toBe(resumed.revision.revisionId);
  expect(after.manifest.paper.id).toBe(opened.manifest.paper.id);
  expect(after.importRecord).toBeNull();
  const snapshots = await fs.readdir(path.join(failed.root, "sources"));
  expect(snapshots).toHaveLength(1);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
});

test("arxiv-import 真实 Electron 转换失败快照保留，离线重转换不访问网络", async () => {
  routes.set(HTML_PATH, {
    bytes: Buffer.from(`<!DOCTYPE html><html><head><meta name="citation_arxiv_id" content="${ID}v1"/></head><body><article class="ltx_document"><div class="ltx_abstract"><p class="ltx_p">Only abstract.</p></div></article></body></html>`),
    mime: "text/html",
  });
  const failed = await importPaper("转换失败", ID);
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.diagnostic.stage).toBe("convert");
  const opened = await open(failed.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "snapshot" });
  expect(await fs.readdir(path.join(failed.root, "sources"))).toHaveLength(1);

  // 断网后离线重新转换：只读既有快照，如实失败，不发起任何请求。
  const requestsBefore = requests.length;
  await stopServer();
  const offline = await resume(failed.root);
  expect(offline.ok).toBe(false);
  if (offline.ok) return;
  expect(offline.diagnostic.stage).toBe("convert");
  expect(requests.length).toBe(requestsBefore);
  expect((await open(failed.root)).manifest.paper.currentRevision).toBeNull();
});

test("arxiv-import 真实 Electron 显式 PDF 回退确认前后均无 PDF 请求，交接固定版本", async () => {
  routes.delete(HTML_PATH);
  const failed = await importPaper("回退交接", ID);
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
  const before = await open(failed.root);

  const handoff = await invoke<ArxivPdfFallbackCommandResult>({
    type: "coreArxivPdfFallback",
    root: failed.root,
    reason: failed.diagnostic,
    baseUrl,
  });
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) return;
  expect(handoff.request).toEqual({
    kind: "arxiv-pdf",
    baseId: ID,
    version: 1,
    reasonCode: failed.diagnostic.code,
    baseRevision: null,
  });
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
  const after = await open(failed.root);
  expect(after.manifest.paper.currentRevision).toBeNull();
  expect(after.manifest.paper.id).toBe(before.manifest.paper.id);

  // current 已可读：不携带 baseRevision 拒绝；携带当前 revision 的更新交接成功且零 PDF 请求。
  routes.set(HTML_PATH, { bytes: Buffer.from(latexmlDocument()), mime: "text/html" });
  const imported = await importPaper("已可读", ID);
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const blocked = await invoke<ArxivPdfFallbackCommandResult>({
    type: "coreArxivPdfFallback",
    root: imported.root,
    reason: failed.diagnostic,
    baseUrl,
  });
  expect(blocked.ok).toBe(false);
  const update = await invoke<ArxivPdfFallbackCommandResult>({
    type: "coreArxivPdfFallback",
    root: imported.root,
    reason: failed.diagnostic,
    baseUrl,
    baseRevision: imported.revision.revisionId,
  });
  expect(update.ok).toBe(true);
  if (!update.ok) return;
  expect(update.request.baseRevision).toBe(imported.revision.revisionId);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
});

test("arxiv-import 真实 Electron 中途取消保留现场，随后恢复完成导入", async () => {
  // HTML 端点挂住不响应：导入停在获取阶段，等待取消。
  routes.delete(HTML_PATH);
  const hanging = new Map(routes);
  await stopServer();
  requests = [];
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    if (url === HTML_PATH) return; // 永不响应
    const route = hanging.get(url);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.mime });
    res.end(route.bytes);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  if (address === null || typeof address === "string") throw new Error("fixture 服务未监听端口");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const operationId = "cancel-op";
  const pending = invoke<ArxivImportCommandResult>({
    type: "coreArxivImport", parent: sandbox, name: "中途取消", input: ID, operationId, baseUrl,
  });
  // 等待 abs 已读、HTML 请求挂住，再经生产 IPC 取消。
  await expect.poll(() => requests.includes(HTML_PATH), { timeout: 10_000 }).toBe(true);
  const cancelled = await invoke<{ cancelled: boolean }>({ type: "coreArxivCancel", operationId });
  expect(cancelled.cancelled).toBe(true);
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.code).toBe("arxiv-fetch-cancelled");
  const opened = await open(result.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ reference: { version: 1 } });

  // 恢复端点后补做未完成阶段，工程身份不变。
  hanging.set(HTML_PATH, { bytes: Buffer.from(latexmlDocument()), mime: "text/html" });
  routes = hanging;
  await stopServer();
  await startServer();
  const resumed = await resume(result.root);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  const after = await open(result.root);
  expect(after.manifest.paper.currentRevision).toBe(resumed.revision.revisionId);
  expect(after.manifest.paper.id).toBe(opened.manifest.paper.id);
});

test("arxiv-import 真实 Electron 局部图片 warning 可发布，核心正文缺失拒绝发布", async () => {
  routes.set(HTML_PATH, {
    bytes: Buffer.from(latexmlDocument().replace(`src="${FIG2_SRC}"`, `src="https://cdn.example.org/external.png"`)),
    mime: "text/html",
  });
  const warned = await importPaper("局部警告", ID);
  expect(warned.ok).toBe(true);
  if (!warned.ok) return;
  expect(warned.warnings.some((w) => w.code === "arxiv-asset-external-blocked")).toBe(true);
  expect(warned.warnings.some((w) => w.code === "arxiv-convert-asset-missing")).toBe(true);
  // 外部资产不被抓取：受控服务之外没有任何请求目标。
  expect(requests.every((url) => url.startsWith("/abs/") || url.startsWith("/html/"))).toBe(true);
  const tree = await readDocument(warned.root, warned.revision.revisionId);
  const missing = tree.blocks.find((block) => block.kind === "figure" && block.asset === null);
  expect(missing).toBeDefined();
  if (missing?.kind === "figure") {
    expect(missing.warning).toBeTruthy();
    expect(missing.captionUnitId).not.toBeNull();
  }

  routes.set(HTML_PATH, {
    bytes: Buffer.from(`<!DOCTYPE html><html><head><meta name="citation_arxiv_id" content="${ID}v1"/></head><body><article class="ltx_document"><div class="ltx_abstract"><p class="ltx_p">Only abstract.</p></div></article></body></html>`),
    mime: "text/html",
  });
  const rejected = await importPaper("核心缺失", ID);
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(rejected.diagnostic.severity).toBe("fatal");
  expect(rejected.diagnostic.stage).toBe("convert");
  expect((await open(rejected.root)).manifest.paper.currentRevision).toBeNull();
});

test("arxiv-import 真实 Electron 整体搬迁后快照、current 与资产按相对路径工作", async () => {
  const result = await importPaper("搬迁工程", ID);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const movedRoot = path.join(sandbox, "moved", "搬迁工程");
  await fs.mkdir(path.dirname(movedRoot), { recursive: true });
  await fs.rename(result.root, movedRoot);

  const reopened = await open(movedRoot);
  expect(reopened.manifest.paper.id).toBe(result.revision.paperId);
  expect(reopened.manifest.paper.currentRevision).toBe(result.revision.revisionId);
  const tree = await readDocument(movedRoot, result.revision.revisionId);
  expect(treeTexts(tree).some((text) => text.includes("We study energy and mass."))).toBe(true);
  const source = await invoke<{ files: Array<{ path: string; sha256: string }> }>({
    type: "coreReadSource",
    root: movedRoot,
    sourceSnapshotId: result.revision.sourceSnapshotId,
  });
  for (const file of source.files) {
    const bytes = await fs.readFile(path.join(movedRoot, "sources", result.revision.sourceSnapshotId, file.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
  const fig1 = tree.blocks.find((block) => block.kind === "figure" && block.asset?.sha256 === createHash("sha256").update(PNG1).digest("hex"));
  expect(fig1).toBeDefined();
});

/** v2 LaTeX 文档：同一 base ID，citation 元数据固定 v2，结论句有真实内容变化。 */
function latexmlV2(): string {
  return latexmlDocument()
    .replace('content="2401.01234v1"', 'content="2401.01234v2"')
    .replace("We conclude with", "We now conclude with");
}

function serveV2() {
  routes.set(`/abs/${ID}`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" });
  routes.set(`/abs/${ID}v2`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" });
  routes.set(`/html/${ID}v2`, { bytes: Buffer.from(latexmlV2()), mime: "text/html" });
}

const checkUpdate = (root: string) =>
  invoke<ArxivUpdateCheckCommandResult>({ type: "coreArxivCheckUpdate", root, operationId: `op-${++operationSeq}`, baseUrl });
const updateCandidate = (root: string, version: number, baseRevision: string) =>
  invoke<ArxivUpdateCandidateCommandResult>({
    type: "coreArxivUpdateCandidate",
    root,
    reference: { baseId: ID, version, canonicalId: `${ID}v${version}` },
    baseRevision,
    operationId: `op-${++operationSeq}`,
    baseUrl,
  });
const refetch = (root: string, baseRevision: string) =>
  invoke<ArxivUpdateCandidateCommandResult>({ type: "coreArxivRefetch", root, baseRevision, operationId: `op-${++operationSeq}`, baseUrl });
const reconvert = (root: string, sourceSnapshotId: string, baseRevision: string) =>
  invoke<ArxivUpdateCandidateCommandResult>({ type: "coreArxivReconvert", root, sourceSnapshotId, baseRevision });
const publishCandidate = (root: string, sourceSnapshotId: string, baseRevision: string, resolutions?: Array<{ conflictId: string; choice: "current" | "candidate" }>) =>
  invoke<ArxivUpdatePublishCommandResult>({
    type: "coreArxivPublishCandidate",
    root,
    sourceSnapshotId,
    baseRevision,
    ...(resolutions === undefined ? {} : { resolutions }),
  });

test("arxiv-import 真实 Electron 检查新版只读 abs，候选确认发布前 current 不变，stale base 拒绝", async () => {
  const imported = await importPaper("更新检查", ID);
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  serveV2();

  // 检查新版：只有 abs 请求，无 HTML/资产/PDF 下载，无候选或 current 变化。
  const requestsBefore = requests.length;
  const checked = await checkUpdate(imported.root);
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.status).toBe("update-available");
  if (checked.status !== "update-available") return;
  expect(checked.latest.version).toBe(2);
  expect(requests.slice(requestsBefore).every((url) => url.startsWith("/abs/"))).toBe(true);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
  expect(await fs.readdir(path.join(imported.root, "sources"))).toHaveLength(1);

  // 获取候选：新版快照落盘、三方合并摘要经 IPC 返回；current 未确认前不变。
  const candidate = await updateCandidate(imported.root, 2, imported.revision.revisionId);
  expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
  if (!candidate.ok || candidate.outcome !== "candidate") return;
  expect(candidate.candidate.baseRevision).toBe(imported.revision.revisionId);
  expect(candidate.candidate.conflicts).toEqual([]);
  expect(treeTexts(candidate.candidate.document).join(" ")).toContain("We now conclude with");
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
  expect(await fs.readdir(path.join(imported.root, "sources"))).toHaveLength(2);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);

  // stale base：current 已前进（以重转换发布模拟另一动作）后旧基线发布被拒绝。
  const advanced = await reconvert(imported.root, imported.revision.sourceSnapshotId, imported.revision.revisionId);
  expect(advanced.ok).toBe(true);
  if (!advanced.ok || advanced.outcome !== "candidate") return;
  const ahead = await publishCandidate(imported.root, imported.revision.sourceSnapshotId, imported.revision.revisionId);
  expect(ahead.ok).toBe(true);
  if (!ahead.ok) return;
  const stale = await publishCandidate(imported.root, candidate.candidate.sourceSnapshotId, imported.revision.revisionId);
  expect(stale.ok).toBe(false);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(ahead.revision.revisionId);

  // 以最新 current 重建候选并确认发布：来源 v2 内容进入 current。
  const fresh = await updateCandidate(imported.root, 2, ahead.revision.revisionId);
  expect(fresh.ok).toBe(true);
  if (!fresh.ok || fresh.outcome !== "candidate") return;
  const published = await publishCandidate(imported.root, fresh.candidate.sourceSnapshotId, ahead.revision.revisionId);
  expect(published.ok, JSON.stringify(published)).toBe(true);
  if (!published.ok) return;
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(published.revision.revisionId);
  const finalTree = await readDocument(imported.root, published.revision.revisionId);
  expect(treeTexts(finalTree).join(" ")).toContain("We now conclude with");
});

test("arxiv-import 真实 Electron 同版重取相同字节复用，离线重转换断网可用且不覆盖 current", async () => {
  const imported = await importPaper("同版与离线", ID);
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;

  // 同版重取：字节一致 → reused，零新快照/候选，current 不变。
  const reused = await refetch(imported.root, imported.revision.revisionId);
  expect(reused.ok, JSON.stringify(reused)).toBe(true);
  if (!reused.ok) return;
  expect(reused.outcome).toBe("reused");
  if (reused.outcome !== "reused") return;
  expect(reused.sourceSnapshotId).toBe(imported.revision.sourceSnapshotId);
  expect(await fs.readdir(path.join(imported.root, "sources"))).toHaveLength(1);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);

  // 断网后离线重转换：候选摘要经 IPC 返回，全程零网络请求。
  const requestsBefore = requests.length;
  await stopServer();
  const offline = await reconvert(imported.root, imported.revision.sourceSnapshotId, imported.revision.revisionId);
  expect(offline.ok, JSON.stringify(offline)).toBe(true);
  if (!offline.ok || offline.outcome !== "candidate") return;
  expect(offline.candidate.conflicts).toEqual([]);
  // 同一快照与转换器：changeset 全部 retained（含阅读顺序），不得有内容变化。
  expect(offline.candidate.changeset.changes.every((entry) => entry.status === "retained")).toBe(true);
  expect(requests.length).toBe(requestsBefore);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);

  // 确认发布同样离线完成；正文内容不变（同一快照与转换器）。
  const published = await publishCandidate(imported.root, imported.revision.sourceSnapshotId, imported.revision.revisionId);
  expect(published.ok, JSON.stringify(published)).toBe(true);
  if (!published.ok) return;
  expect(published.revision.revisionId).toBe(offline.candidate.revisionId);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(published.revision.revisionId);
  const before = await readDocument(imported.root, imported.revision.revisionId);
  const after = await readDocument(imported.root, published.revision.revisionId);
  // 发布即预览：完整文档树一致，有序阅读投影一致（不排序比较）。
  expect(after).toEqual(offline.candidate.document);
  expect(orderedTreeTexts(after)).toEqual(orderedTreeTexts(before));
  expect(requests.length).toBe(requestsBefore);
});

test("arxiv-import 真实 Electron 同版异字节新快照候选，撤稿新版如实报告不产生候选", async () => {
  const imported = await importPaper("异字节与撤稿", ID);
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;

  // 同版 HTML 字节变化（仅注释）：新快照 + 无内容变化候选，旧快照与 current 保留。
  routes.set(HTML_PATH, { bytes: Buffer.from(latexmlDocument().replace("</head>", "<!-- refreshed --></head>")), mime: "text/html" });
  const requestsBeforeRefetch = requests.length;
  const refetched = await refetch(imported.root, imported.revision.revisionId);
  expect(refetched.ok, JSON.stringify(refetched)).toBe(true);
  if (!refetched.ok) return;
  expect(refetched.outcome, JSON.stringify(requests.slice(requestsBeforeRefetch))).toBe("candidate");
  if (refetched.outcome !== "candidate") return;
  // 重取确实再次请求了 HTML（不是复用旧响应）。
  expect(requests.slice(requestsBeforeRefetch)).toContain(HTML_PATH);
  expect(refetched.candidate.sourceSnapshotId).not.toBe(imported.revision.sourceSnapshotId);
  expect(refetched.candidate.changeset.changes.every((entry) => entry.status === "retained")).toBe(true);
  expect(await fs.readdir(path.join(imported.root, "sources"))).toHaveLength(2);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);

  // 检查更新不比较 HTML：同版字节变化仍报告 up-to-date。
  const sameVersion = await checkUpdate(imported.root);
  expect(sameVersion.ok).toBe(true);
  if (sameVersion.ok) expect(sameVersion.status).toBe("up-to-date");

  // 撤稿新版：检查报告 withdrawn；显式获取候选被拒绝，不产生空正文或自动采用上一版。
  routes.set(`/abs/${ID}`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], withdrawn: [2] })), mime: "text/html" });
  routes.set(`/abs/${ID}v2`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], withdrawn: [2] })), mime: "text/html" });
  routes.set(`/html/${ID}v2`, { bytes: Buffer.from(latexmlV2()), mime: "text/html" });
  const withdrawn = await checkUpdate(imported.root);
  expect(withdrawn.ok).toBe(true);
  if (!withdrawn.ok) return;
  expect(withdrawn.status).toBe("withdrawn");
  const blocked = await updateCandidate(imported.root, 2, imported.revision.revisionId);
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.diagnostic.code).toBe("arxiv-version-withdrawn");
  expect(requests.some((url) => url === `/html/${ID}v2`)).toBe(false);
  expect((await open(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
});
