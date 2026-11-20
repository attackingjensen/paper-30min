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
import { expectAppReady } from "./electron-launch";
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
  PdfUploadConfirmation,
  ProjectRevisionRecord,
} from "../src/shared/contracts";
import type { PdfParseTaskRecord } from "../src/shared/parsing";
import type { DocumentTree } from "../src/shared/document/tree";
import { projectSentenceText } from "../src/shared/document/anchor";
import type { VerificationRecord } from "../src/shared/verification";

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
let holdDownloads = false;
const heldDownloads: Array<() => void> = [];

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

function vendorPage(
  blocks: ReturnType<typeof block>[],
  markdown?: Record<string, unknown>,
) {
  return {
    prunedResult: {
      width: 1191,
      height: 1684,
      model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
      parsing_res_list: blocks,
    },
    ...(markdown === undefined ? {} : { markdown }),
  };
}

function parseResponse(
  secondPageText: string,
  extra: {
    images?: Record<string, string>;
    pageCount?: number;
    pages?: Array<ReturnType<typeof vendorPage>>;
  } = {},
): Buffer {
  const pages = extra.pages ?? [
    vendorPage([block(0, "First page paragraph"), block(1, "Figure 1: caption")]),
    vendorPage([block(0, secondPageText)]),
  ];
  if (extra.images && pages[0])
    pages[0] = vendorPage(pages[0].prunedResult.parsing_res_list, { images: extra.images });
  const row = {
    result: {
      dataInfo: {
        type: "pdf",
        numPages: extra.pageCount ?? pages.length,
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
  holdDownloads = false;
  heldDownloads.length = 0;
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
        if (holdDownloads)
          await new Promise<void>((resolve) => heldDownloads.push(resolve));
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
  await expectAppReady(page);
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

/** 经真实 will-quit → shutdown → worker 落定 → 进程退出路径关闭应用（非强杀）。 */
async function quitDesktop() {
  await desktop.evaluate(({ app: electronApp, dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    electronApp.quit();
  });
  await new Promise<void>((resolve) => {
    if (desktopProcess.exitCode !== null || desktopProcess.signalCode !== null) resolve();
    else desktopProcess.once("exit", () => resolve());
  });
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

/** 捕获 worker 经生产通道发来的确认请求（含 confirmationId）：在主进程侧旁路
 * 记录 webContents.send 的原始 payload，生产转发路径不变。 */
async function captureConfirmations(): Promise<void> {
  await desktop.evaluate(({ BrowserWindow }) => {
    const captured: PdfUploadConfirmation[] = [];
    (globalThis as unknown as { __pdfConfirms: PdfUploadConfirmation[] }).__pdfConfirms = captured;
    for (const win of BrowserWindow.getAllWindows()) {
      const original = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "pdf:uploadConfirm") captured.push(args[0] as PdfUploadConfirmation);
        return original(channel, ...args);
      };
    }
  });
}

async function readCapturedConfirmations(): Promise<PdfUploadConfirmation[]> {
  return desktop.evaluate(() =>
    (globalThis as unknown as { __pdfConfirms?: PdfUploadConfirmation[] }).__pdfConfirms ?? []);
}

/** 经生产 preload 直接发送确认应答；可携带任意 confirmed 值以验证 fail-closed。 */
async function replyConfirmation(
  operationId: string,
  confirmationId: string,
  confirmed: unknown,
): Promise<void> {
  await page.evaluate(({ operationId, confirmationId, confirmed }) =>
    window.desktop.replyPdfUploadConfirm({
      operationId,
      confirmationId,
      confirmed,
    } as Parameters<Window["desktop"]["replyPdfUploadConfirm"]>[0]),
  { operationId, confirmationId, confirmed });
}

/** 真实本地修正：改第一页句子文本后经 coreCommit 发布新 current；返回新 revision。 */
async function commitLocalCorrection(
  root: string,
  base: ProjectRevisionRecord,
  correctedText: string,
): Promise<ProjectRevisionRecord> {
  const document = await readTree(root, base.revisionId);
  const sourceBase = await invoke<DocumentTree>({
    type: "coreReadDocument", root, revisionId: base.revisionId, tree: "source-base",
  });
  const sentenceId = firstSentence(document);
  const part = document.sentences[sentenceId].content[0];
  if (part.kind !== "text") throw new Error("fixture 首句不是纯文本");
  part.text = correctedText;
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
  }, {
    root,
    baseRevision: base.revisionId,
    sourceSnapshotId: base.sourceSnapshotId,
    document,
    sourceBase,
  }) as Promise<ProjectRevisionRecord>;
}

async function listProjectFiles(root: string): Promise<string[]> {
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

  // 工程文件不出现旧权威残留与凭据。
  const files = await listProjectFiles(root);
  expect(files.some((file) => file.includes("materials"))).toBe(false);
  expect(files.some((file) => file.endsWith("candidate.md"))).toBe(false);
  for (const file of files.filter((entry) => /\.(json|jsonl|md)$/.test(entry))) {
    const content = await fs.readFile(path.join(root, file), "utf8");
    expect(content).not.toContain("paper://cite");
    expect(content).not.toContain(TOKEN);
  }

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

  // 真实本地修正：经 coreCommit 发布新 current，重解析以新 current 为基线。
  const corrected = await commitLocalCorrection(
    root, published.revision, "First page paragraph corrected locally");
  expect(corrected.revisionId).not.toBe(published.revision.revisionId);
  const correctedTree = await readTree(root, corrected.revisionId);
  const correctedSentence = Object.values(correctedTree.units).find((entry) =>
    entry.kind === "paragraph" && entry.sentenceIds.length === 1 &&
    projectSentenceText(correctedTree, entry.sentenceIds[0]) ===
      "First page paragraph corrected locally");
  expect(correctedSentence).toBeDefined();

  results.push(() => parseResponse("Second page text v2"));
  const reparse = invoke<PdfReparseCommandResult>({
    type: "corePdfReparse",
    root,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    baseRevision: corrected.revisionId,
    operationId: nextOperation(),
  });
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const candidate = await reparse;
  expect(candidate.outcome).toBe("candidate");
  if (candidate.outcome !== "candidate") throw new Error("reparse did not form candidate");
  // 候选不推进 current；本地修正与候选改动不在同一句，无冲突。
  const opened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(opened.manifest.paper.currentRevision).toBe(corrected.revisionId);
  expect(candidate.candidate.baseRevision).toBe(corrected.revisionId);
  expect(candidate.candidate.conflicts).toEqual([]);
  expect(JSON.stringify(candidate)).not.toContain(TOKEN);

  const merged = await invoke<ProjectRevisionRecord>({
    type: "corePdfPublishCandidate",
    root,
    parseBatchId: candidate.task.parseBatchId,
    baseRevision: corrected.revisionId,
  });
  expect(merged.revisionId).toBe(candidate.candidate.revisionId);
  const tree = await readTree(root, merged.revisionId);
  const texts = Object.values(tree.units).flatMap((unit) =>
    unit.sentenceIds.map((id) => projectSentenceText(tree, id)));
  // 发布后本地修正保留，候选的第二页更新同时生效。
  expect(texts).toContain("First page paragraph corrected locally");
  expect(texts).toContain("Second page text v2");
  expect(texts).not.toContain("First page paragraph");
});

test("pdf-import 真实 Electron 本地修正与候选冲突：未选择拒绝发布，显式选择后按所选发布", async () => {
  const root = await createCoreProject("冲突候选");
  const snapshot = await snapshotPdf(root);
  const first = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const published = await first.run;
  expect(published.outcome).toBe("published");
  if (published.outcome !== "published") throw new Error("seed import did not publish");
  const corrected = await commitLocalCorrection(
    root, published.revision, "First page paragraph corrected locally");

  // 候选改写同一句：与本地修正形成内容冲突。
  results.push(() => parseResponse(
    "Second page text v2",
    { pages: [
      vendorPage([block(0, "First page paragraph cloud rewrite"), block(1, "Figure 1: caption")]),
      vendorPage([block(0, "Second page text v2")]),
    ] },
  ));
  const reparse = invoke<PdfReparseCommandResult>({
    type: "corePdfReparse",
    root,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    baseRevision: corrected.revisionId,
    operationId: nextOperation(),
  });
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const candidate = await reparse;
  expect(candidate.outcome).toBe("candidate");
  if (candidate.outcome !== "candidate") throw new Error("reparse did not form candidate");
  expect(candidate.candidate.conflicts.length).toBeGreaterThan(0);
  const conflictId = candidate.candidate.conflicts[0].id;

  // 未解决冲突不得发布，current 不变。
  await expect(invoke({
    type: "corePdfPublishCandidate",
    root,
    parseBatchId: candidate.task.parseBatchId,
    baseRevision: corrected.revisionId,
  })).rejects.toThrow(/冲突/);
  expect((await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root }))
    .manifest.paper.currentRevision).toBe(corrected.revisionId);

  // 显式选择 candidate 后发布：冲突句取云端改写，其余本地修正不受影响。
  const merged = await invoke<ProjectRevisionRecord>({
    type: "corePdfPublishCandidate",
    root,
    parseBatchId: candidate.task.parseBatchId,
    baseRevision: corrected.revisionId,
    resolutions: [{ conflictId, choice: "candidate" }],
  });
  const tree = await readTree(root, merged.revisionId);
  const texts = Object.values(tree.units).flatMap((unit) =>
    unit.sentenceIds.map((id) => projectSentenceText(tree, id)));
  expect(texts).toContain("First page paragraph cloud rewrite");
  expect(texts).not.toContain("First page paragraph corrected locally");
});

test("pdf-import 真实 Electron 发布前基线变化：候选发布拒绝，current 保持新基线", async () => {
  const root = await createCoreProject("基线变化");
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

  // 候选形成后 current 又前进：旧基线的发布必须拒绝。
  const advanced = await commitLocalCorrection(
    root, published.revision, "First page paragraph advanced baseline");
  await expect(invoke({
    type: "corePdfPublishCandidate",
    root,
    parseBatchId: candidate.task.parseBatchId,
    baseRevision: published.revision.revisionId,
  })).rejects.toThrow(/baseRevision/);
  const opened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(opened.manifest.paper.currentRevision).toBe(advanced.revisionId);
});

test("pdf-import 真实 Electron 确认应答 fail-closed：truthy 非布尔按拒绝，显式 true 才上传", async () => {
  await captureConfirmations();
  const root = await createCoreProject("应答校验");
  const snapshot = await snapshotPdf(root);
  const { operationId, run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(1);
  const [confirmation] = await readCapturedConfirmations();
  expect(confirmation.operationId).toBe(operationId);
  expect(confirmation.confirmationId).toBeTruthy();

  // 字符串 "false"、数字 1 等 truthy 值都不是显式确认：按拒绝落定，零 POST。
  await replyConfirmation(operationId, confirmation.confirmationId, "false");
  const rejected = await run;
  expect(rejected.outcome).toBe("cancelled");
  expect(counts.posts).toBe(0);

  const second = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(2);
  const [, next] = await readCapturedConfirmations();
  expect(next.confirmationId).not.toBe(confirmation.confirmationId);
  await replyConfirmation(second.operationId, next.confirmationId, 1);
  expect((await second.run).outcome).toBe("cancelled");
  expect(counts.posts).toBe(0);

  // 显式 true 正常上传发布。
  const third = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(3);
  const [, , explicit] = await readCapturedConfirmations();
  await replyConfirmation(third.operationId, explicit.confirmationId, true);
  expect((await third.run).outcome).toBe("published");
  expect(counts.posts).toBe(1);
  const tasks = await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root });
  expect(tasks).toHaveLength(1);
});

test("pdf-import 真实 Electron 错 operationId 应答不消费确认：正确应答随后仍可确认上传", async () => {
  await captureConfirmations();
  const root = await createCoreProject("错配恢复");
  const snapshot = await snapshotPdf(root);
  const { operationId, run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(1);
  const [confirmation] = await readCapturedConfirmations();
  // 错 operationId 的应答不得消费表项：worker 按拒绝处理该应答，但确认仍待答。
  await replyConfirmation("wrong-operation", confirmation.confirmationId, true);
  // 正确 operationId + confirmationId 的显式 true 随后仍能确认并上传。
  await replyConfirmation(operationId, confirmation.confirmationId, true);
  expect((await run).outcome).toBe("published");
  expect(counts.posts).toBe(1);
});

test("pdf-import 真实 Electron 错误 confirmationId 与重复应答不命中，旧应答不命中复用 ID 的新操作", async () => {
  await captureConfirmations();
  const root = await createCoreProject("应答身份");
  const snapshot = await snapshotPdf(root);
  const operationId = nextOperation();
  const first = invoke<PdfImportCommandResult>({
    type: "corePdfImport", root, sourceSnapshotId: snapshot.sourceSnapshotId, operationId,
  });
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(1);
  const [confirmation] = await readCapturedConfirmations();

  // 错误 confirmationId：不命中当前确认，零 POST，对话框仍在。
  await replyConfirmation(operationId, "not-the-confirmation-id", true);
  expect(counts.posts).toBe(0);
  await expect(confirmDialog()).toBeVisible();

  // 正确应答后重复投递同一应答：被忽略，不影响结果。
  await replyConfirmation(operationId, confirmation.confirmationId, true);
  await replyConfirmation(operationId, confirmation.confirmationId, true);
  const published = await first;
  expect(published.outcome).toBe("published");
  expect(counts.posts).toBe(1);

  // 操作结束后复用同一 operationId：旧 confirmationId 的迟到 true 不得命中新确认。
  results.push(() => parseResponse("Second page text v2"));
  const second = invoke<PdfImportCommandResult>({
    type: "corePdfImport", root, sourceSnapshotId: snapshot.sourceSnapshotId, operationId,
  });
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(2);
  const [, next] = await readCapturedConfirmations();
  expect(next.confirmationId).not.toBe(confirmation.confirmationId);
  await replyConfirmation(operationId, confirmation.confirmationId, true);
  expect(counts.posts).toBe(1);
  await expect(confirmDialog()).toBeVisible();
  await replyConfirmation(operationId, next.confirmationId, false);
  expect((await second).outcome).toBe("cancelled");
  expect(counts.posts).toBe(1);
});

test("pdf-import 真实 Electron 两工程并发确认排队不覆盖，各自 settle", async () => {
  await captureConfirmations();
  const rootA = await createCoreProject("并发甲");
  const rootB = await createCoreProject("并发乙");
  const snapshotA = await snapshotPdf(rootA);
  const snapshotB = await snapshotPdf(rootB);
  const importA = startImport(rootA, snapshotA.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(1);
  const importB = startImport(rootB, snapshotB.sourceSnapshotId);
  // 第二个请求到达后第一个对话框不被覆盖：队首仍是甲的确认。
  await expect.poll(async () => (await readCapturedConfirmations()).length).toBe(2);
  const [first, second] = await readCapturedConfirmations();
  expect(first.operationId).toBe(importA.operationId);
  expect(second.operationId).toBe(importB.operationId);
  await expect(confirmDialog()).toBeVisible();
  expect(counts.posts).toBe(0);

  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const publishedA = await importA.run;
  expect(publishedA.outcome).toBe("published");
  // 乙的确认排队浮现，独立应答。
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await importB.run).outcome).toBe("cancelled");
  expect(counts.posts).toBe(1);
  expect(await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root: rootB })).toEqual([]);
});

test("pdf-import 真实 Electron 确认期间重载 renderer：操作被拒绝不挂起，零 POST", async () => {
  const root = await createCoreProject("重载拒绝");
  const snapshot = await snapshotPdf(root);
  const { run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.reload();
  await expectAppReady(page);
  const result = await run;
  expect(result.outcome).toBe("cancelled");
  expect(counts.posts).toBe(0);
  expect(await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root })).toEqual([]);
  // 重载后新导入不受影响。
  const retry = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  expect((await retry.run).outcome).toBe("published");
});

test("pdf-import 真实 Electron 等待确认时退出：shutdown 拒绝确认并等待落定，零 POST", async () => {
  const root = await createCoreProject("确认中退出");
  const snapshot = await snapshotPdf(root);
  const { run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  const settled = run.then(
    (result) => ({ ok: true as const, result }),
    (error: Error) => ({ ok: false as const, message: error.message }),
  );
  await quitDesktop();
  // 操作必须先落定（拒绝或进程退出错误），不得永久挂起；零 POST。
  const outcome = await settled;
  if (outcome.ok) expect(outcome.result.outcome).toBe("cancelled");
  else expect(outcome.message).toMatch(/工程进程|closed/);
  expect(counts.posts).toBe(0);

  await launch();
  const opened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root })).toEqual([]);
});

test("pdf-import 真实 Electron 查询中退出：任务保留 querying 可恢复，退出零新增 POST", async () => {
  const root = await createCoreProject("查询中退出");
  const snapshot = await snapshotPdf(root);
  const { run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  holdQueries = true;
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  await expect.poll(async () => {
    const tasks = await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root });
    return tasks[0]?.phase ?? "";
  }).toBe("querying");
  const postsBefore = counts.posts;
  const settled = run.then(
    (result) => ({ ok: true as const, result }),
    (error: Error) => ({ ok: false as const, message: error.message }),
  );
  await quitDesktop();
  const outcome = await settled;
  if (outcome.ok) {
    expect(outcome.result.outcome === "stopped" || outcome.result.outcome === "incomplete").toBe(true);
    if (outcome.result.outcome === "stopped" || outcome.result.outcome === "incomplete")
      expect(outcome.result.task.phase).toBe("stopped");
  } else expect(outcome.message).toMatch(/工程进程|closed/);
  expect(counts.posts).toBe(postsBefore);

  // 重开恢复：沿用原任务号，只查询下载，不重传。
  holdQueries = false;
  for (const release of heldQueries.splice(0)) release();
  await launch();
  await saveParsingSettings();
  const tasks = await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root });
  expect(tasks).toHaveLength(1);
  const resumed = await invoke<PdfImportCommandResult>({
    type: "corePdfResume",
    root,
    parseBatchId: tasks[0].parseBatchId,
    operationId: nextOperation(),
  });
  expect(resumed.outcome).toBe("published");
  expect(counts.posts).toBe(postsBefore);
});

test("pdf-import 真实 Electron 下载中退出：任务保留可恢复，退出零新增 POST", async () => {
  const root = await createCoreProject("下载中退出");
  const snapshot = await snapshotPdf(root);
  const { run } = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  holdDownloads = true;
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  await expect.poll(async () => counts.downloads).toBe(1);
  const postsBefore = counts.posts;
  const settled = run.then(
    (result) => ({ ok: true as const, result }),
    (error: Error) => ({ ok: false as const, message: error.message }),
  );
  await quitDesktop();
  const outcome = await settled;
  if (outcome.ok) {
    expect(outcome.result.outcome === "stopped" || outcome.result.outcome === "incomplete").toBe(true);
    if (outcome.result.outcome === "stopped" || outcome.result.outcome === "incomplete")
      expect(["stopped", "querying", "downloading"]).toContain(outcome.result.task.phase);
  } else expect(outcome.message).toMatch(/工程进程|closed/);
  expect(counts.posts).toBe(postsBefore);

  holdDownloads = false;
  for (const release of heldDownloads.splice(0)) release();
  await launch();
  await saveParsingSettings();
  const tasks = await invoke<PdfParseTaskRecord[]>({ type: "corePdfTasks", root });
  expect(tasks).toHaveLength(1);
  const resumed = await invoke<PdfImportCommandResult>({
    type: "corePdfResume",
    root,
    parseBatchId: tasks[0].parseBatchId,
    operationId: nextOperation(),
  });
  expect(resumed.outcome).toBe("published");
  expect(counts.posts).toBe(postsBefore);
});

test("pdf-import 真实 Electron 缺失图片仍发布并携带 warning；缺页拒绝且 current 不推进", async () => {
  const root = await createCoreProject("缺图缺页");
  const snapshot = await snapshotPdf(root);
  // 正文引用图片但资源 404：成为可读占位，局部失败不阻断全文发布，warnings 非空。
  results[0] = () => parseResponse("Second page text", {
    pages: [
      vendorPage(
        [block(0, "First page paragraph"), block(1, "Before ![Figure B](imgs/lost.png) after.")],
        { images: { "imgs/lost.png": `${endpoint}/missing-asset` } },
      ),
      vendorPage([block(0, "Second page text")]),
    ],
  });
  const first = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const published = await first.run;
  expect(published.outcome).toBe("published");
  if (published.outcome !== "published") throw new Error("missing image blocked publication");
  expect(published.warnings.length).toBeGreaterThan(0);
  expect(published.warnings.some((warning) => warning.code === "pdf-convert-figure-missing")).toBe(true);

  // 缺页（响应只含 1 页，父 PDF 为 2 页）：incomplete，current 不推进。
  results.push(() => parseResponse("Second page text v2", {
    pages: [vendorPage([block(0, "Only page text")])],
  }));
  const reparse = invoke<PdfReparseCommandResult>({
    type: "corePdfReparse",
    root,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    baseRevision: published.revision.revisionId,
    operationId: nextOperation(),
  });
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const incomplete = await reparse;
  expect(incomplete.outcome).toBe("incomplete");
  if (incomplete.outcome !== "incomplete") throw new Error("page mismatch did not fail");
  expect(incomplete.diagnostic.code).toBe("parse-page-count-mismatch");
  const opened = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
  expect(opened.manifest.paper.currentRevision).toBe(published.revision.revisionId);
});

test("pdf-import 真实 Electron 用户核验：未确认拒绝，显式确认后建立并读回记录", async () => {
  const root = await createCoreProject("用户核验");
  const snapshot = await snapshotPdf(root);
  const first = startImport(root, snapshot.sourceSnapshotId);
  await expect(confirmDialog()).toBeVisible();
  await page.getByRole("button", { name: "确认上传并解析" }).click();
  const published = await first.run;
  expect(published.outcome).toBe("published");
  if (published.outcome !== "published") throw new Error("seed import did not publish");
  const tree = await readTree(root, published.revision.revisionId);
  const sentenceId = firstSentence(tree);
  const anchor = {
    kind: "sentence",
    unitId: tree.sentences[sentenceId].unitId,
    sentenceId,
  };
  await expect(invoke({
    type: "corePdfVerify",
    root,
    expectedRevisionId: published.revision.revisionId,
    anchor,
    actor: { kind: "user", confirmed: false },
  })).rejects.toThrow(/确认/);
  expect(await invoke({
    type: "corePdfReadVerification", root, revisionId: published.revision.revisionId,
  })).toEqual([]);

  const record = await invoke<VerificationRecord>({
    type: "corePdfVerify",
    root,
    expectedRevisionId: published.revision.revisionId,
    anchor,
    actor: { kind: "user", confirmed: true },
  });
  expect(record.coverage.length).toBeGreaterThan(0);
  expect(record.coverage.every((entry) => entry.validity === "verified")).toBe(true);
  const records = await invoke<VerificationRecord[]>({
    type: "corePdfReadVerification", root, revisionId: published.revision.revisionId,
  });
  expect(records).toHaveLength(1);
  expect(records[0].verificationId).toBe(record.verificationId);
});