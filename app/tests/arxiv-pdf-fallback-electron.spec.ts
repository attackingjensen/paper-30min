// 真实 Electron 高层回归（SPEC-pdf-import Testing Strategy 第 6 条／s08.6）：
// arXiv 固定版本 PDF 回退的组合交接经生产 preload、project:command IPC 与
// Node utility process：受控 arXiv fixture 服务提供固定 vN PDF，受控百度服务
// 提供解析结果；工程与 paper.id 不变，上传确认前零 POST。
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ArxivImportCommandResult,
  ArxivPdfFallbackCommandResult,
  ArxivPdfFallbackImportCommandResult,
  PdfSourceSnapshotRecord,
  ProjectCoreSnapshot,
} from "../src/shared/contracts";
import type { DocumentTree } from "../src/shared/document/tree";
import { absHtml } from "./fixtures/arxiv-abs";
import { latexmlDocument } from "./fixtures/arxiv-latexml";

const ID = "2401.01234";
const ABS_PATH = `/abs/${ID}v1`;
const HTML_PATH = `/html/${ID}v1`;
const PDF_PATH = `/pdf/${ID}v1`;
const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
let page: Page;
let errors: string[];
let remotePageRequests: string[];
let arxivServer: Server | null = null;
let baiduServer: Server | null = null;
let baseUrl = "";
let endpoint = "";
let requests: string[];
let routes: Map<string, { bytes: Buffer; mime: string }>;
let posts: number;
let queryStarted: number;
let holdQuery: boolean;
let releaseQuery: (() => void) | undefined;
let holdPdf: boolean;

function block(id: number, content: string) {
  return {
    block_label: "text",
    block_content: content,
    block_bbox: [10 * (id + 1), 20, 100 + 10 * id, 60],
    block_id: id,
    block_order: id,
    group_id: id,
  };
}

function parseResponse(): Buffer {
  const pages = [
    {
      prunedResult: {
        width: 1191,
        height: 1684,
        model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
        parsing_res_list: [block(0, "Fallback first page"), block(1, "Fallback second unit")],
      },
    },
    {
      prunedResult: {
        width: 1191,
        height: 1684,
        model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
        parsing_res_list: [block(0, "Fallback page two")],
      },
    },
  ];
  const row = {
    result: {
      dataInfo: {
        type: "pdf",
        numPages: pages.length,
        pages: pages.map((entry) => ({
          width: entry.prunedResult.width,
          height: entry.prunedResult.height,
        })),
      },
      layoutParsingResults: pages,
    },
  };
  return Buffer.from(JSON.stringify(row) + "\n");
}

async function drain(request: IncomingMessage) {
  for await (const _chunk of request) {
    // 受控 multipart 上传在回执前消费完毕。
  }
}

async function startServers() {
  requests = [];
  posts = 0;
  queryStarted = 0;
  holdQuery = false;
  releaseQuery = undefined;
  holdPdf = false;
  const pdfBytes = await fs.readFile(SAMPLE);
  routes = new Map([
    [`/abs/${ID}`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1] })), mime: "text/html" }],
    [ABS_PATH, { bytes: Buffer.from(absHtml({ id: ID, versions: [1] })), mime: "text/html" }],
    [HTML_PATH, { bytes: Buffer.from(latexmlDocument()), mime: "text/html" }],
    [PDF_PATH, { bytes: pdfBytes, mime: "application/pdf" }],
  ]);
  arxivServer = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    if (url === PDF_PATH && holdPdf) return;
    const route = routes.get(url);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": route.mime });
    res.end(route.bytes);
  });
  await new Promise<void>((resolve) => arxivServer!.listen(0, "127.0.0.1", resolve));
  const arxivAddress = arxivServer!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${arxivAddress.port}`;

  baiduServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method === "POST") {
        await drain(request);
        posts += 1;
        response.end(JSON.stringify({ code: 0, data: { jobId: "job-fallback-0" } }));
        return;
      }
      if (request.url === "/jobs/job-fallback-0") {
        queryStarted += 1;
        if (holdQuery) {
          const { promise, resolve } = Promise.withResolvers<void>();
          releaseQuery = resolve;
          await promise;
        }
        response.end(
          JSON.stringify({
            code: 0,
            data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result/job-fallback-0` } },
          }),
        );
        return;
      }
      if (request.url === "/jobs/result/job-fallback-0") {
        response.end(parseResponse());
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => baiduServer!.listen(0, "127.0.0.1", resolve));
  const baiduAddress = baiduServer!.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${baiduAddress.port}/jobs`;
}

async function stopServers() {
  for (const server of [arxivServer, baiduServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  arxivServer = null;
  baiduServer = null;
}

async function launch() {
  const visible = process.env.PAPER30MIN_TEST_WINDOW === "visible";
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    PAPER30MIN_PROFILE: path.join(sandbox, "profile"),
    PAPER30MIN_TEST_WINDOW: visible ? "visible" : "hidden",
    PAPER30MIN_ARXIV_BASE_URL: baseUrl,
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

/** 本机解析设置经生产 parsing:command 通道保存；Token 加密留在主进程。 */
async function saveParsingSettings() {
  await page.evaluate(async (value) => {
    const settings = await window.desktop.parsing<{ endpoint: string; model: string; hasKey: boolean }>({
      type: "settings",
    });
    await window.desktop.parsing({
      type: "saveSettings",
      settings: { ...settings, endpoint: value },
      apiKey: "test-baidu-token-never-persist",
    });
  }, endpoint);
}

function invoke<T>(command: Parameters<Window["desktop"]["invoke"]>[0]): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

let operationSeq = 0;
const nextOperation = () => `fallback-op-${++operationSeq}`;
const open = (root: string) => invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });

async function openFailedArxivCreation(name: string) {
  routes.delete(HTML_PATH);
  await page.getByRole("button", { name: "从 arXiv 新建工程", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "从 arXiv 新建工程", exact: true });
  await creation.getByLabel("arXiv URL 或 ID", { exact: true }).fill(ID);
  await creation.getByLabel("工程名称", { exact: true }).fill(name);
  await desktop.evaluate(({ dialog: nativeDialog }, parent) => {
    nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, sandbox);
  await creation.getByRole("button", { name: "选择位置", exact: true }).click();
  await creation.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(creation.getByRole("button", { name: "改用此版本 PDF 解析", exact: true })).toBeVisible();
  return creation;
}

test.beforeEach(async () => {
  errors = [];
  remotePageRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-fallback-electron-"));
  await startServers();
  await launch();
  await saveParsingSettings();
});

test.afterEach(async () => {
  releaseQuery?.();
  try {
    expect(errors).toEqual([]);
    expect(remotePageRequests).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    await stopServers();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("arxiv-pdf-fallback 真实 Electron 组合交接：固定版本 PDF 快照、显式确认上传、工程与 paper.id 不变", async () => {
  // HTML 不存在 → 首次导入失败，工程保留可恢复现场。
  routes.delete(HTML_PATH);
  const failed = await invoke<ArxivImportCommandResult>({
    type: "coreArxivImport",
    parent: sandbox,
    name: "回退组合",
    input: ID,
    operationId: nextOperation(),
    baseUrl,
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  const before = await open(failed.root);
  expect(before.manifest.paper.currentRevision).toBeNull();
  expect(posts).toBe(0);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);

  // 显式交接：固定 vN，零 PDF 请求。
  const handoff = await invoke<ArxivPdfFallbackCommandResult>({
    type: "coreArxivPdfFallback",
    root: failed.root,
    reason: failed.diagnostic,
    baseUrl,
  });
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) return;
  expect(handoff.request.version).toBe(1);
  expect(handoff.request.baseRevision).toBeNull();
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);

  // 组合命令：下载固定版本 PDF 形成快照 → 上传确认前零 POST。
  const operationId = nextOperation();
  const run = invoke<ArxivPdfFallbackImportCommandResult>({
    type: "coreArxivPdfFallbackImport",
    root: failed.root,
    request: handoff.request,
    operationId,
    baseUrl,
  });
  const dialog = page.getByRole("dialog", { name: "确认上传 PDF 到云端解析" });
  await expect(dialog).toBeVisible();
  expect(posts).toBe(0);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);
  await dialog.getByRole("button", { name: "确认上传并解析" }).click();
  const result = await run;
  expect(result.outcome).toBe("published");
  if (result.outcome !== "published") return;
  expect(posts).toBe(1);

  // 工程与 paper.id 不变；current 推进到 PDF 解析 revision。
  const after = await open(failed.root);
  expect(after.manifest.id).toBe(before.manifest.id);
  expect(after.manifest.paper.id).toBe(before.manifest.paper.id);
  expect(after.manifest.paper.currentRevision).toBe(result.revision.revisionId);

  // 正文来自 PDF 解析而非 HTML；来源谱系为 arXiv 固定版本 PDF。
  const tree = await invoke<DocumentTree>({
    type: "coreReadDocument",
    root: failed.root,
    revisionId: result.revision.revisionId,
    tree: "document",
  });
  const texts = Object.values(tree.units).flatMap((unit) =>
    unit.sentenceIds.flatMap((id) => tree.sentences[id].content.map((part) => (part.kind === "text" ? part.text : ""))),
  );
  expect(texts.join(" ")).toContain("Fallback first page");
  const revision = await invoke<{ sourceSnapshotId: string }>({
    type: "coreReadRevision",
    root: failed.root,
    revisionId: result.revision.revisionId,
  });
  const parseSnapshot = await invoke<{ kind: string; parentSourceSnapshotId: string }>({
    type: "coreReadSource",
    root: failed.root,
    sourceSnapshotId: revision.sourceSnapshotId,
  });
  expect(parseSnapshot.kind).toBe("pdf-parse");
  const pdfSnapshot = await invoke<{ kind: string; arxiv?: { baseId: string; version: number } }>({
    type: "coreReadSource",
    root: failed.root,
    sourceSnapshotId: parseSnapshot.parentSourceSnapshotId,
  });
  expect(pdfSnapshot.kind).toBe("pdf");
  expect(pdfSnapshot.arxiv).toMatchObject({ baseId: ID, version: 1 });

  // 工程不出现旧权威残留。
  const files = await listFiles(failed.root);
  expect(files.some((file) => file.includes("materials"))).toBe(false);
  expect(files.some((file) => file.endsWith("candidate.md"))).toBe(false);
  for (const file of files.filter((f) => /\.(json|jsonl|md)$/.test(f))) {
    const content = await fs.readFile(path.join(failed.root, file), "utf8").catch(() => "");
    expect(content).not.toContain("paper://cite");
    expect(content).not.toContain("test-baidu-token-never-persist");
  }

  // PDF 回退后的工程仍可参与新版本检查与更新候选（7uo 移交项 4／SPEC §8）：
  // current 来源是 pdf-parse，谱系回溯到 arXiv v1；发现 v2 后候选走三方合并。
  routes.set(`/abs/${ID}`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" });
  routes.set(`/abs/${ID}v2`, { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" });
  routes.set(`/html/${ID}v2`, {
    bytes: Buffer.from(
      latexmlDocument()
        .replace('content="2401.01234v1"', 'content="2401.01234v2"')
        .replace("We conclude with", "We now conclude with"),
    ),
    mime: "text/html",
  });
  // v2 HTML 的资产相对 v2 基址解析：真实 transport 会请求这些 URL。
  routes.set(`/html/extracted/6543210/figures/overview.png`, {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    mime: "image/png",
  });
  routes.set(`/html/x2.png`, { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]), mime: "image/png" });
  const checked = await invoke<{ ok: boolean; status?: string; latest?: { version: number } }>({
    type: "coreArxivCheckUpdate",
    root: failed.root,
    operationId: nextOperation(),
    baseUrl,
  });
  expect(checked.ok).toBe(true);
  expect(checked.status).toBe("update-available");
  expect(checked.latest?.version).toBe(2);
  const candidate = await invoke<{
    ok: boolean;
    outcome?: string;
    candidate?: { baseRevision: string; document: DocumentTree };
  }>({
    type: "coreArxivUpdateCandidate",
    root: failed.root,
    reference: { baseId: ID, version: 2, canonicalId: `${ID}v2` },
    baseRevision: result.revision.revisionId,
    operationId: nextOperation(),
    baseUrl,
  });
  expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
  expect(candidate.outcome).toBe("candidate");
  expect(candidate.candidate?.baseRevision).toBe(result.revision.revisionId);
  expect(candidate.candidate?.document.paperId).toBe(before.manifest.paper.id);
  // 候选未确认：current 仍是 PDF 解析 revision，零 PDF 下载。
  expect((await open(failed.root)).manifest.paper.currentRevision).toBe(result.revision.revisionId);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(true); // 仅首次回退那一次
  expect(requests.filter((url) => url.startsWith("/pdf/"))).toHaveLength(1);

  // 关闭受控服务与应用后重开：正文来自本地 current revision，零新增网络请求。
  const requestsBefore = requests.length + posts;
  await stopServers();
  await closeDesktopForCleanup();
  await launch();
  const reopened = await open(failed.root);
  expect(reopened.manifest.paper.currentRevision).toBe(result.revision.revisionId);
  const offlineTree = await invoke<DocumentTree>({
    type: "coreReadDocument",
    root: failed.root,
    revisionId: result.revision.revisionId,
    tree: "document",
  });
  expect(offlineTree).toEqual(tree);
  expect(requests.length + posts).toBe(requestsBefore);
});

test("arxiv-pdf-fallback 真实 Electron 拒绝上传确认：零 POST，PDF 快照与工程现场保留", async () => {
  routes.delete(HTML_PATH);
  const failed = await invoke<ArxivImportCommandResult>({
    type: "coreArxivImport",
    parent: sandbox,
    name: "回退拒绝",
    input: ID,
    operationId: nextOperation(),
    baseUrl,
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  const handoff = await invoke<ArxivPdfFallbackCommandResult>({
    type: "coreArxivPdfFallback",
    root: failed.root,
    reason: failed.diagnostic,
    baseUrl,
  });
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) return;
  const run = invoke<ArxivPdfFallbackImportCommandResult>({
    type: "coreArxivPdfFallbackImport",
    root: failed.root,
    request: handoff.request,
    operationId: nextOperation(),
    baseUrl,
  });
  const dialog = page.getByRole("dialog", { name: "确认上传 PDF 到云端解析" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  const result = await run;
  expect(result.outcome).toBe("cancelled");
  expect(posts).toBe(0);
  const after = await open(failed.root);
  expect(after.manifest.paper.currentRevision).toBeNull();
  // PDF 快照已发布（下载与上传是不同阶段），可离线重试而不重复下载。
  const pdfBytes = await fs.readFile(SAMPLE);
  const expectedSha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const sources = await fs.readdir(path.join(failed.root, "sources"));
  expect(sources.length).toBeGreaterThan(0);
  const snapshots = await Promise.all(
    sources.map(
      async (sourceSnapshotId) =>
        JSON.parse(
          await fs.readFile(path.join(failed.root, "sources", sourceSnapshotId, "snapshot.json"), "utf8"),
        ) as PdfSourceSnapshotRecord,
    ),
  );
  const pdfSnapshots = snapshots.filter((snapshot) => snapshot.kind === "pdf");
  expect(pdfSnapshots).toHaveLength(1);
  const [pdfSnapshot] = pdfSnapshots;
  const { sourceSnapshotId } = pdfSnapshot;
  expect(sources).toContain(sourceSnapshotId);
  const snapshotPath = path.join(failed.root, pdfSnapshot.path);
  expect(pdfSnapshot).toMatchObject({
    sourceSnapshotId,
    path: `sources/${sourceSnapshotId}`,
    kind: "pdf",
    sha256: expectedSha256,
    arxiv: { baseId: ID, version: 1 },
  });
  expect(pdfSnapshot.files).toEqual([
    {
      path: "paper.pdf",
      sha256: expectedSha256,
      size: pdfBytes.length,
      mime: "application/pdf",
    },
  ]);
  expect((await fs.readFile(path.join(snapshotPath, "paper.pdf"))).equals(pdfBytes)).toBe(true);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);

  const requestsBeforeRetry = requests.length;
  await stopServers();
  const retry = invoke<ArxivPdfFallbackImportCommandResult>({
    type: "coreArxivPdfFallbackImport",
    root: failed.root,
    request: handoff.request,
    operationId: nextOperation(),
    baseUrl,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  const retryResult = await retry;
  expect(retryResult.outcome).toBe("cancelled");
  expect(requests).toHaveLength(requestsBeforeRetry);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);
  expect(posts).toBe(0);
  expect((await open(failed.root)).manifest.paper.currentRevision).toBeNull();
});

test("arxiv-pdf-fallback renderer 二次确认后回退固定版本 PDF，偏好写入失败仍进入工程", async () => {
  const creation = await openFailedArxivCreation("界面 PDF 回退");
  expect(posts).toBe(0);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);

  await creation.getByRole("button", { name: "改用此版本 PDF 解析", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认 arXiv PDF 回退", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(`${ID}v1`);
  await page.screenshot({ animations: "disabled", path: "test-results/arxiv-creation/pdf-fallback-confirm.png" });
  expect(posts).toBe(0);
  expect(requests.some((url) => url.startsWith("/pdf/"))).toBe(false);
  await confirmation.getByRole("button", { name: "下载 PDF 并继续", exact: true }).click();

  const upload = page.getByRole("dialog", { name: "确认上传 PDF 到云端解析" });
  await expect(upload).toBeVisible({ timeout: 30000 });
  expect(posts).toBe(0);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);
  const preferencesFile = path.join(sandbox, "profile", "preferences.json");
  await fs.rm(preferencesFile, { force: true });
  await fs.mkdir(preferencesFile);
  await upload.getByRole("button", { name: "确认上传并解析", exact: true }).click();
  await expect(page.getByRole("tab", { name: "原始论文", exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Fallback first page", { exact: false }).first()).toBeVisible({ timeout: 30000 });
  expect(posts).toBe(1);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);
  const manifest = JSON.parse(await fs.readFile(path.join(sandbox, "界面 PDF 回退", "paper30min.json"), "utf8"));
  expect(manifest.paper.currentRevision).toEqual(expect.any(String));
});

test("arxiv-pdf-fallback renderer 停止云端等待后恢复原任务且不重复上传", async () => {
  holdQuery = true;
  const creation = await openFailedArxivCreation("停止并恢复 PDF 回退");
  await creation.getByRole("button", { name: "改用此版本 PDF 解析", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认 arXiv PDF 回退", exact: true });
  await confirmation.getByRole("button", { name: "下载 PDF 并继续", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "确认上传 PDF 到云端解析" });
  await expect(upload).toBeVisible({ timeout: 30000 });
  await upload.getByRole("button", { name: "确认上传并解析", exact: true }).click();
  await expect.poll(() => queryStarted).toBe(1);

  await creation.getByRole("button", { name: "停止回退", exact: true }).click();
  await expect(creation.getByText(/已停止本机 PDF 回退等待/)).toBeVisible({ timeout: 30000 });
  expect(posts).toBe(1);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);
  const root = path.join(sandbox, "停止并恢复 PDF 回退");
  expect((await open(root)).manifest.paper.currentRevision).toBeNull();
  await expect(page.getByRole("tab", { name: "原始论文", exact: true })).toHaveCount(0);

  holdQuery = false;
  releaseQuery?.();
  await creation.getByRole("button", { name: "恢复 PDF 任务", exact: true }).click();
  await expect(page.getByRole("tab", { name: "原始论文", exact: true })).toBeVisible({ timeout: 30000 });
  expect(posts).toBe(1);
  expect(requests.filter((url) => url === PDF_PATH)).toHaveLength(1);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "paper30min.json"), "utf8"));
  expect(manifest.paper.currentRevision).toEqual(expect.any(String));
});

test("arxiv-pdf-fallback renderer 启动早期停止不创建云端任务", async () => {
  holdPdf = true;
  const creation = await openFailedArxivCreation("启动早期停止");
  await creation.getByRole("button", { name: "改用此版本 PDF 解析", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认 arXiv PDF 回退", exact: true });
  await confirmation.getByRole("button", { name: "下载 PDF 并继续", exact: true }).click();
  await creation.getByRole("button", { name: "停止回退", exact: true }).click();
  await expect(creation.getByText(/arxiv-fetch-cancelled|已取消 PDF 回退/)).toBeVisible({ timeout: 30000 });

  expect(posts).toBe(0);
  await expect(page.getByRole("dialog", { name: "确认上传 PDF 到云端解析" })).toHaveCount(0);
  expect(requests.filter((url) => url === PDF_PATH).length).toBeLessThanOrEqual(1);
  expect((await open(path.join(sandbox, "启动早期停止"))).manifest.paper.currentRevision).toBeNull();
});

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out;
}
