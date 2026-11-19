// PDF 导入 core* 命令面契约（SPEC-pdf-import Commands／s08.8）：
// 无配置命令经 dispatchCoreCommand 直达真实工程磁盘；云端链路由受控服务承担。
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dispatchCoreCommand } from "../src/main/core-commands";
import {
  createProject,
  openProject,
  readRevisionDocument,
} from "../src/main/project-core";
import { snapshotLocalPdf } from "../src/main/pdf/snapshot";
import { importPdfToCurrent } from "../src/main/parsing/pdf-import";
import type { BaiduPdfParseConfig } from "../src/main/parsing/baidu-task";
import type {
  PdfReparseCommandResult,
  PdfSourceSnapshotRecord,
  ProjectRevisionRecord,
} from "../src/shared/contracts";
import type { PdfParseTaskRecord } from "../src/shared/parsing";
import type {
  PdfSourceEvidenceRecord,
  VerificationRecord,
} from "../src/shared/verification";
import type { DocumentTree } from "../src/shared/document/tree";
import { projectSentenceText } from "../src/shared/document/anchor";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const TOKEN = "test-baidu-token-never-persist";
const MODEL = "PaddleOCR-VL-1.6" as const;

let sandbox: string;
let root: string;
let servers: Server[];

async function drain(request: IncomingMessage) {
  for await (const _chunk of request) {
    // Consume controlled multipart fixtures before sending the receipt.
  }
}

async function controlledServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/jobs`;
}

function config(endpoint: string): BaiduPdfParseConfig {
  return { endpoint, model: MODEL, apiKey: TOKEN };
}

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
        pages: pages.map((page) => ({
          width: page.prunedResult.width,
          height: page.prunedResult.height,
        })),
      },
      layoutParsingResults: pages,
    },
  };
  return Buffer.from(JSON.stringify(row) + "\n");
}

interface ControlledCounts {
  posts: number;
  queries: number;
  downloads: number;
}

async function controlledParseService(
  results: Array<() => Buffer>,
  counts: ControlledCounts,
): Promise<string> {
  let endpoint = "";
  endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      await drain(request);
      const index = counts.posts;
      counts.posts += 1;
      if (index >= results.length) {
        response.writeHead(500).end();
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { jobId: `job-core-${index}` } }));
      return;
    }
    const query = /^\/jobs\/(job-core-\d+)$/.exec(request.url ?? "");
    if (query) {
      counts.queries += 1;
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result/${query[1]}` } },
      }));
      return;
    }
    const download = /^\/jobs\/result\/(job-core-\d+)$/.exec(request.url ?? "");
    if (download) {
      counts.downloads += 1;
      response.end(results[Number(download[1].slice("job-core-".length))]());
      return;
    }
    response.writeHead(404).end();
  });
  return endpoint;
}

/** 经真实导入链路建立 current，返回任务与 revision；后续命令全部走 core* 面。 */
async function seedPublished() {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService([() => parseResponse("Second page text")], counts);
  const snapshot = await snapshotLocalPdf({ root, source: SAMPLE });
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  const imported = await importPdfToCurrent({
    root,
    sourceSnapshotId: snapshot.snapshot.sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  if (imported.outcome !== "published") throw new Error("seed import did not publish");
  return { counts, endpoint, snapshot: snapshot.snapshot, imported };
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
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-core-"));
  servers = [];
  const project = await createProject({ parent: sandbox, name: "命令面工程" });
  root = project.root;
});

test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("pdf-import corePdfSnapshot：本地 PDF 形成来源快照，同字节复用不新增", async () => {
  const first = await dispatchCoreCommand({ type: "corePdfSnapshot", root, source: SAMPLE }) as
    { ok: true; reused: boolean; snapshot: PdfSourceSnapshotRecord };
  expect(first.ok).toBe(true);
  expect(first.reused).toBe(false);
  expect(first.snapshot.kind).toBe("pdf");
  expect(first.snapshot.pageCount).toBe(2);

  const second = await dispatchCoreCommand({ type: "corePdfSnapshot", root, source: SAMPLE }) as
    { ok: true; reused: boolean; snapshot: PdfSourceSnapshotRecord };
  expect(second.reused).toBe(true);
  expect(second.snapshot.sourceSnapshotId).toBe(first.snapshot.sourceSnapshotId);
});

test("pdf-import corePdfTasks：导入后列出任务记录，含解析快照与候选身份", async () => {
  const { imported } = await seedPublished();
  const tasks = await dispatchCoreCommand({ type: "corePdfTasks", root }) as PdfParseTaskRecord[];
  expect(tasks).toHaveLength(1);
  expect(tasks[0].parseBatchId).toBe(imported.task.parseBatchId);
  expect(tasks[0].phase).toBe("candidate-complete");
  expect(tasks[0].parseSourceSnapshotId).toBe(imported.revision.sourceSnapshotId);
  expect(tasks[0].candidateRevisionId).toBe(imported.revision.revisionId);
  expect(JSON.stringify(tasks)).not.toContain(TOKEN);
});

test("pdf-import corePdfReconvert + corePdfPublishCandidate：离线候选按同一身份发布", async () => {
  const { imported, counts } = await seedPublished();
  const summary = await dispatchCoreCommand({
    type: "corePdfReconvert",
    root,
    parseBatchId: imported.task.parseBatchId,
    baseRevision: imported.revision.revisionId,
  }) as PdfReparseCommandResult;
  expect(summary.outcome).toBe("candidate");
  if (summary.outcome !== "candidate") throw new Error("reconvert did not form candidate");
  expect(summary.candidate.conflicts).toHaveLength(0);
  expect(summary.candidate.baseRevision).toBe(imported.revision.revisionId);
  expect(summary.candidate.revisionId).not.toBe(imported.revision.revisionId);
  expect(JSON.stringify(summary)).not.toContain(TOKEN);

  const published = await dispatchCoreCommand({
    type: "corePdfPublishCandidate",
    root,
    parseBatchId: imported.task.parseBatchId,
    baseRevision: imported.revision.revisionId,
  }) as ProjectRevisionRecord;
  expect(published.revisionId).toBe(summary.candidate.revisionId);
  expect((await openProject(root)).manifest.paper.currentRevision).toBe(published.revisionId);
  const tree = await readRevisionDocument(root, published.revisionId, "document");
  expect(projectSentenceText(tree, firstSentence(tree))).toBe("First page paragraph");
  expect(counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import corePdfReconvert：基线过期时拒绝，current 不变", async () => {
  const { imported } = await seedPublished();
  await expect(dispatchCoreCommand({
    type: "corePdfReconvert",
    root,
    parseBatchId: imported.task.parseBatchId,
    baseRevision: randomUUID(),
  })).rejects.toThrow(/baseRevision/);
  expect((await openProject(root)).manifest.paper.currentRevision)
    .toBe(imported.revision.revisionId);
});

test("pdf-import corePdfVerify / corePdfReadVerification：显式确认建立核验，未确认拒绝", async () => {
  const { imported } = await seedPublished();
  const tree = await readRevisionDocument(root, imported.revision.revisionId, "document");
  const sentenceId = firstSentence(tree);
  const anchor = {
    kind: "sentence",
    unitId: tree.sentences[sentenceId].unitId,
    sentenceId,
  };
  await expect(dispatchCoreCommand({
    type: "corePdfVerify",
    root,
    expectedRevisionId: imported.revision.revisionId,
    anchor,
    actor: { kind: "user", confirmed: false },
  })).rejects.toThrow(/确认/);
  expect(await dispatchCoreCommand({
    type: "corePdfReadVerification",
    root,
    revisionId: imported.revision.revisionId,
  })).toEqual([]);

  const record = await dispatchCoreCommand({
    type: "corePdfVerify",
    root,
    expectedRevisionId: imported.revision.revisionId,
    anchor,
    actor: { kind: "user", confirmed: true },
  }) as VerificationRecord;
  expect(record.validity).toBe("verified");
  expect(record.pdfSnapshotId).toBeDefined();
  const records = await dispatchCoreCommand({
    type: "corePdfReadVerification",
    root,
    revisionId: imported.revision.revisionId,
  }) as VerificationRecord[];
  expect(records).toHaveLength(1);
  expect(records[0].verificationId).toBe(record.verificationId);
});

test("pdf-import corePdfEvidence：登记来源读取证据，越界页码拒绝", async () => {
  const { snapshot } = await seedPublished();
  await expect(dispatchCoreCommand({
    type: "corePdfEvidence",
    root,
    pdfSnapshotId: snapshot.sourceSnapshotId,
    pages: [3],
    sessionId: "session-1",
    taskId: "task-1",
    contentSha256: "a".repeat(64),
  })).rejects.toThrow(/页码/);

  const evidence = await dispatchCoreCommand({
    type: "corePdfEvidence",
    root,
    pdfSnapshotId: snapshot.sourceSnapshotId,
    pages: [2, 1],
    sessionId: "session-1",
    taskId: "task-1",
    contentSha256: "a".repeat(64),
  }) as PdfSourceEvidenceRecord;
  expect(evidence.pages).toEqual([1, 2]);
  expect(evidence.pdfSnapshotId).toBe(snapshot.sourceSnapshotId);
});

test("pdf-import corePdfStop：无活动任务时返回 false，不触碰任务记录", async () => {
  const { imported } = await seedPublished();
  const stopped = await dispatchCoreCommand({
    type: "corePdfStop",
    root,
    parseBatchId: imported.task.parseBatchId,
  }) as { stopped: boolean };
  expect(stopped.stopped).toBe(false);
  const tasks = await dispatchCoreCommand({ type: "corePdfTasks", root }) as PdfParseTaskRecord[];
  expect(tasks[0].phase).toBe("candidate-complete");
});

test("pdf-import corePdfImport 缺少本机配置时明确拒绝，不发起上传", async () => {
  const snapshot = await snapshotLocalPdf({ root, source: SAMPLE });
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  await expect(dispatchCoreCommand({
    type: "corePdfImport",
    root,
    sourceSnapshotId: snapshot.snapshot.sourceSnapshotId,
    operationId: "op-no-config",
  })).rejects.toThrow(/配置/);
});