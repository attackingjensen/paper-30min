// 真实 Electron 高层回归（SPEC-pdf-import Testing Strategy／s08.8）：
// 生产 preload、project:command IPC、Node utility process 与真实 undici 传输，
// 端点经本机解析设置映射到受控百度服务，不访问真实云端。
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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  PdfImportCommandResult,
  PdfReparseCommandResult,
  PdfSourceSnapshotRecord,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
} from "../src/shared/contracts";
import type { PdfParseTaskRecord } from "../src/shared/parsing";
import type { DocumentTree } from "../src/shared/document/tree";
import { projectSentenceText } from "../src/shared/document/anchor";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const TOKEN = "test-baidu-token-never-persist";

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
let page: Page;
let errors: string[];
let remotePageRequests: string[];
let server: Server | null = null;
let holdQueries = false;
const heldQueries: Array<() => void> = [];
let endpoint = "";
let counts: { posts: number; queries: number; downloads: number };
let results: Array<() => Buffer>;
let failReceipt = false;

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

function vendorPage(blocks: ReturnType<typeof block>[]) {
  return {
    prunedResult: {
      width: 1191,
      height: 1684,
      model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
      parsing_res_list: blocks,
    },
  };
}

function parseResponse(secondPageText: string): Buffer {
  const pages = [
    vendorPage([block(0, "First page paragraph"), block(1, "Figure 1: caption")]),
    vendorPage([block(0, secondPageText)]),
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
    // Consume controlled multipart fixtures before sending the receipt.
  }
}

async function startServer() {
  counts = { posts: 0, queries: 0, downloads: 0 };
  results = [() => parseResponse("Second page text")];
  failReceipt = false;
  holdQueries = false;
  heldQueries.length = 0;
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method === "POST") {
        await drain(request);
        const index = counts.posts;
        counts.posts += 1;
        if (index >= results.length) {
          response.writeHead(500).end();
          return;
        }
        if (failReceipt && index === 1) {
          response.end(JSON.stringify({ code: 0, data: {} }));
          return;
        }
        response.end(JSON.stringify({ code: 0, data: { jobId: `job-electron-${index}` } }));
        return;
      }
      const query = /^\/jobs\/(job-electron-\d+)$/.exec(request.url ?? "");
      if (query) {
        counts.queries += 1;
        if (holdQueries)
          await new Promise<void>((resolve) => heldQueries.push(resolve));
        response.end(JSON.stringify({
          code: 0,
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result/${query[1]}` } },
        }));
        return;
      }
      const download = /^\/jobs\/result\/(job-electron-\d+)$/.exec(request.url ?? "");
      if (download) {
        counts.downloads += 1;
        response.end(results[Number(download[1].slice("job-electron-".length))]());
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}/jobs`;
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

/** 本机解析设置经生产 parsing:command 通道保存；Token 加密留在主进程。 */
async function saveParsingSettings() {
  await page.evaluate(async (value) => {
    const settings = await window.desktop.parsing<{ endpoint: string; model: string; hasKey: boolean }>({ type: "settings" });
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
const nextOperation = () => `pdf-op-${++operationSeq}`;

async function createCoreProject(name: string): Promise<string> {
  const created = await invoke<{ root: string }>({ type: "coreCreate", parent: sandbox, name });
  return created.root;
}

async function snapshotPdf(root: string): Promise<PdfSourceSnapshotRecord> {
  const result = await invoke<{ ok: true; snapshot: PdfSourceSnapshotRecord }>({
    type: "corePdfSnapshot",
    root,
    source: SAMPLE,
  });
  expect(result.ok).toBe(true);
  return result.snapshot;
}

/** 发起导入并等待 renderer 确认对话框出现；返回导入 Promise 与操作身份。 */
function startImport(root: string, sourceSnapshotId: string) {
  const operationId = nextOperation();
  const run = invoke<PdfImportCommandResult>({
    type: "corePdfImport",
    root,
    sourceSnapshotId,
    operationId,
  });
  return { operationId, run };
}

const confirmDialog = () =>
  page.getByRole("dialog", { name: "确认上传 PDF 到云端解析" });

async function readTree(root: string, revisionId: string): Promise<DocumentTree> {
  return invoke<DocumentTree>({ type: "coreReadDocument", root, revisionId, tree: "document" });
}

function firstSentence(tree: DocumentTree): string {
  const unit = Object.values(tree.units).find((entry) =>
    entry.kind === "paragraph" &&
    entry.sentenceIds.length === 1 &&
    projectSentenceText(tree, entry.sentenceIds[0]).replace(/\s+/g, " ").trim() ===
      "First page paragraph");
  if (!unit) throw new Error("fixture sentence not found");
  return unit.sentenceIds[0];
}

test.beforeEach(async () => {
  errors = [];
  remotePageRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-electron-"));
  await startServer();
  await launch();
  await saveParsingSettings();
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

test("pdf-import 真实 Electron 显式确认上传，全文发布后断网重开阅读", async () => {
  const root = await createCoreProject("确认导入");
  const snapshot = await snapshotPdf(root);
  const { run } = startImport(root, snapshot.sourceSnapshotId);

  // 确认前不得发起 POST：对话框出现时受控服务计数仍为零。
  await expect(confirmDialog()).toBeVisible();
  expect(counts.posts).toBe(0);
  await expect(confirmDialog()).toContainText("sample_paper.pdf");
  await page.getByRole("button", { name: "确认上传并解析" }).click();

  const result = await run;
  expect(result.outcome).toBe("published");
  if (result.outcome !== "published") throw new Error("import did not publish");
  expect(counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
  const tree = await readTree(root, result.revision.revisionId);
  expect(projectSentenceText(tree, firstSentence(tree))).toBe("First page paragraph");

  // 工程与 IPC 结果不携带 Token、签名 URL 或原始错误正文。
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain("Authorization");

  // 关闭网络与应用后重开：正文来自本地 current revision。
  const requestsBefore = counts.posts + counts.queries + counts.downloads;
  await stopServer();
  await closeDesktopForCleanup();
  await launch();
  const reopened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(reopened.manifest.paper.currentRevision).toBe(result.revision.revisionId);
  const offlineTree = await readTree(root, result.revision.revisionId);
  expect(offlineTree).toEqual(tree);
  expect(counts.posts + counts.queries + counts.downloads).toBe(requestsBefore);
});

test("pdf-import 真实 Electron 拒绝上传确认：零 POST、零任务记录", async () => {
  const root = await createCoreProject("拒绝上传");
  const snapshot = await snapshotPdf(root);
  const { run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const result = await run;
  expect(result.outcome).toBe("cancelled");
  expect(counts.posts).toBe(0);
  const tasks = await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root });
  expect(tasks).toEqual([]);
});

test("pdf-import 真实 Electron 受理后停止，重开应用恢复沿用原任务号", async () => {
  const root = await createCoreProject("停止恢复");
  const snapshot = await snapshotPdf(root);
  const { operationId, run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  // 受控服务扣住查询响应：受理后任务停在 querying，停止确定命中本机等待。
  holdQueries = true;
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  await expect.poll(async () => {
    const tasks = await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root });
    return tasks[0]?.jobId ?? "";
  }).not.toBe("");
  const stopped = await invoke<{ stopped: boolean }>({
    type: "corePdfStop",
    root,
    parseBatchId: (await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root }))[0].parseBatchId,
  });
  expect(stopped.stopped).toBe(true);
  const first = await run;
  expect(first.outcome === "stopped" || first.outcome === "incomplete").toBe(true);
  if (first.outcome !== "stopped" && first.outcome !== "incomplete")
    throw new Error("expected stopped task");
  expect(first.task.phase).toBe("stopped");
  const postsAfterStop = counts.posts;

  // 重开应用后经生产通道恢复：沿用原 jobId，不重复 POST。
  holdQueries = false;
  for (const release of heldQueries.splice(0)) release();
  await closeDesktopForCleanup();
  await launch();
  await saveParsingSettings();
  const resumed = await invoke<PdfImportCommandResult>({
    type: "corePdfResume",
    root,
    parseBatchId: first.task.parseBatchId,
    operationId: nextOperation(),
  });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not publish");
  expect(counts.posts).toBe(postsAfterStop);
  expect(resumed.task.jobId).toBe(first.task.jobId);
  const tree = await readTree(root, resumed.revision.revisionId);
  expect(projectSentenceText(tree, firstSentence(tree))).toBe("First page paragraph");
  void operationId;
});

test("pdf-import 真实 Electron 重解析提交结果不明：人工关联任务号恢复，绝不重传", async () => {
  const root = await createCoreProject("结果不明");
  const snapshot = await snapshotPdf(root);
  const first = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const published = await first.run;
  expect(published.outcome).toBe("published");
  if (published.outcome !== "published") throw new Error("seed import did not publish");

  // 重解析：受控服务返回无 jobId 回执，任务进入 unknown；首次导入任务已结束不阻塞。
  failReceipt = true;
  results.push(() => parseResponse("Second page text v2"));
  const reparse = invoke<PdfReparseCommandResult>({
    type: "corePdfReparse",
    root,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    baseRevision: published.revision.revisionId,
    operationId: nextOperation(),
  });
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const unknown = await reparse;
  expect(unknown.outcome).toBe("incomplete");
  if (unknown.outcome !== "incomplete") throw new Error("expected unknown submission");
  expect(unknown.task.phase).toBe("unknown");
  expect(unknown.diagnostic.code).toBe("baidu-submit-receipt-invalid");
  const postsBefore = counts.posts;

  // 人工关联原任务号恢复：只查询下载形成候选，不再 POST，current 不变。
  const resumed = await invoke<PdfReparseCommandResult>({
    type: "corePdfResumeReparse",
    root,
    parseBatchId: unknown.task.parseBatchId,
    operationId: nextOperation(),
    jobId: "job-electron-1",
  });
  expect(resumed.outcome).toBe("candidate");
  if (resumed.outcome !== "candidate") throw new Error("resume did not form candidate");
  expect(counts.posts).toBe(postsBefore);
  expect(resumed.candidate.baseRevision).toBe(published.revision.revisionId);
  const opened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(opened.manifest.paper.currentRevision).toBe(published.revision.revisionId);
  expect(JSON.stringify(resumed)).not.toContain(TOKEN);
});

test("pdf-import 真实 Electron 同 PDF 重解析形成候选，发布保留本地修正", async () => {
  const root = await createCoreProject("重解析候选");
  const snapshot = await snapshotPdf(root);
  const first = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const published = await first.run;
  expect(published.outcome).toBe("published");
  if (published.outcome !== "published") throw new Error("seed import did not publish");

  results.push(() => parseResponse("Second page text v2"));
  const reparse = invoke<PdfReparseCommandResult>({
    type: "corePdfReparse",
    root,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    baseRevision: published.revision.revisionId,
    operationId: nextOperation(),
  });
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const candidate = await reparse;
  expect(candidate.outcome).toBe("candidate");
  if (candidate.outcome !== "candidate") throw new Error("reparse did not form candidate");
  // 候选不推进 current。
  const opened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(opened.manifest.paper.currentRevision).toBe(published.revision.revisionId);
  expect(candidate.candidate.baseRevision).toBe(published.revision.revisionId);
  expect(JSON.stringify(candidate)).not.toContain(TOKEN);

  const merged = await invoke<ProjectRevisionRecord>({
    type: "corePdfPublishCandidate",
    root,
    parseBatchId: candidate.task.parseBatchId,
    baseRevision: published.revision.revisionId,
  });
  expect(merged.revisionId).toBe(candidate.candidate.revisionId);
  const tree = await readTree(root, merged.revisionId);
  expect(projectSentenceText(tree, firstSentence(tree))).toBe("First page paragraph");
});