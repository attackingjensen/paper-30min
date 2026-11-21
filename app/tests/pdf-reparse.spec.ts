import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  commitRevision,
  createProject,
  listSourceSnapshots,
  openProject,
  readRevisionAsset,
  readRevisionDocument,
} from "../src/main/project-core";
import { snapshotLocalPdf } from "../src/main/pdf/snapshot";
import {
  createVerification,
  readVerificationRecords,
  verificationInheritCommitHooks,
} from "../src/main/pdf/verification";
import type { BaiduPdfParseConfig } from "../src/main/parsing/baidu-task";
import { importPdfToCurrent, reparsePdfToCandidate, resumePdfReparse } from "../src/main/parsing/pdf-import";
import { publishDocumentMergeCandidate, resolveDocumentMergeCandidateConflict } from "../src/main/document/merge";
import { projectSentenceText } from "../src/shared/document/anchor";
import type { DocumentTree } from "../src/shared/document/tree";
import type { PdfParseSourceSnapshotRecord } from "../src/shared/contracts";
import type { PdfParseTaskRecord } from "../src/shared/parsing";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const TOKEN = "test-baidu-token-never-persist";
const OTHER_PDF = path.resolve("tests/fixtures/pdfparse_formula_graphics.pdf");
const MODEL = "PaddleOCR-VL-1.6" as const;

let sandbox: string;
let root: string;
let sourceSnapshotId: string;
let servers: Server[];

async function drain(request: IncomingMessage) {
  for await (const _chunk of request) {
    // Consume controlled multipart fixtures before sending the receipt.
  }
}

async function controlledServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
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

function block(id: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    block_label: "text",
    block_content: content,
    block_bbox: [10 * (id + 1), 20, 100 + 10 * id, 60],
    block_id: id,
    block_order: id,
    group_id: id,
    ...extra,
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

function row(pages: ReturnType<typeof vendorPage>[]) {
  return {
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
}

function jsonl(rows: unknown[]): Buffer {
  return Buffer.from(rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

function parseResponse(secondPageText: string): Buffer {
  return jsonl([
    row([
      vendorPage([block(0, "First page paragraph"), block(1, "Figure 1: caption")]),
      vendorPage([block(0, secondPageText)]),
    ]),
  ]);
}

interface ControlledCounts {
  posts: number;
  queries: number;
  downloads: number;
}

/** 受控百度服务：jobId 按 POST 顺序分配，查询与下载按任务号返回对应结果。 */
async function controlledParseService(results: Array<() => Buffer>, counts: ControlledCounts): Promise<string> {
  const jobs: string[] = [];
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
      const jobId = `job-reparse-${index}`;
      jobs.push(jobId);
      response.end(JSON.stringify({ code: 0, data: { jobId } }));
      return;
    }
    const query = /^\/jobs\/(job-reparse-\d+)$/.exec(request.url ?? "");
    if (query) {
      counts.queries += 1;
      response.end(
        JSON.stringify({
          code: 0,
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result/${query[1]}` } },
        }),
      );
      return;
    }
    const download = /^\/jobs\/result\/(job-reparse-\d+)$/.exec(request.url ?? "");
    if (download) {
      counts.downloads += 1;
      response.end(results[Number(download[1].slice("job-reparse-".length))]());
      return;
    }
    response.writeHead(404).end();
  });
  return endpoint;
}

async function currentRevisionId(): Promise<string | null> {
  return (await openProject(root)).manifest.paper.currentRevision;
}

async function parseSnapshots(): Promise<PdfParseSourceSnapshotRecord[]> {
  return (await listSourceSnapshots(root)).filter(
    (snapshot) => snapshot.kind === "pdf-parse",
  ) as PdfParseSourceSnapshotRecord[];
}

function taskPath(parseBatchId: string) {
  return path.join(root, ".paper30min", "parsing", parseBatchId, "task.json");
}

async function readTaskRecord(parseBatchId: string): Promise<PdfParseTaskRecord> {
  return JSON.parse(await fs.readFile(taskPath(parseBatchId), "utf8")) as PdfParseTaskRecord;
}

function normalized(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function unitText(tree: DocumentTree, unitId: string): string {
  return tree.units[unitId].sentenceIds.map((sentenceId) => projectSentenceText(tree, sentenceId)).join(" ");
}

function findSentenceByText(tree: DocumentTree, text: string): string {
  const unit = Object.values(tree.units).find(
    (entry) => entry.kind === "paragraph" && normalized(unitText(tree, entry.id)) === text,
  );
  if (!unit || unit.sentenceIds.length !== 1) throw new Error(`fixture text not found: ${text}`);
  return unit.sentenceIds[0];
}

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reparse-"));
  servers = [];
  const project = await createProject({ parent: sandbox, name: "重解析工程" });
  root = project.root;
  const snapshot = await snapshotLocalPdf({ root, source: SAMPLE });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  sourceSnapshotId = snapshot.snapshot.sourceSnapshotId;
});

test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("pdf-import 同 PDF 重解析：新解析快照形成候选，发布保留本地修正且不新增 PDF 快照", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => parseResponse("Second page text v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const tree = await readRevisionDocument(root, first.revision.revisionId, "document");
  const firstSentence = findSentenceByText(tree, "First page paragraph");
  const secondSentence = findSentenceByText(tree, "Second page text");

  // 本地修正第一页段落；重解析只改第二页，二者不冲突。
  const local = structuredClone(tree);
  local.sentences[firstSentence].content = [{ kind: "text", text: "First page paragraph local fix" }];
  const localRevision = await commitRevision({
    root,
    baseRevision: first.revision.revisionId,
    sourceSnapshotId: first.revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(local)),
      "source-base.json": Buffer.from(JSON.stringify(tree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: first.revision.revisionId })),
    },
  });

  const confirmations: string[] = [];
  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: localRevision.revisionId,
    config: config(endpoint),
    confirmUpload: async (request) => {
      confirmations.push(request.pdfSha256);
      return true;
    },
  });
  expect(confirmations).toHaveLength(1);
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("reparse did not form candidate");
  expect(reparse.candidate.conflicts).toHaveLength(0);
  expect(await currentRevisionId()).toBe(localRevision.revisionId);

  const published = await publishDocumentMergeCandidate(reparse.candidate);
  expect(await currentRevisionId()).toBe(published.revisionId);
  const current = await readRevisionDocument(root, published.revisionId, "document");
  expect(projectSentenceText(current, firstSentence)).toBe("First page paragraph local fix");
  expect(projectSentenceText(current, secondSentence)).toBe("Second page text v2");
  const sourceBase = await readRevisionDocument(root, published.revisionId, "source-base");
  expect(projectSentenceText(sourceBase, firstSentence)).toBe("First page paragraph");
  expect(projectSentenceText(sourceBase, secondSentence)).toBe("Second page text v2");

  const snapshots = await parseSnapshots();
  expect(snapshots).toHaveLength(2);
  expect(snapshots.every((entry) => entry.parentSourceSnapshotId === sourceSnapshotId)).toBe(true);
  const pdfSnapshots = (await listSourceSnapshots(root)).filter((entry) => entry.kind === "pdf");
  expect(pdfSnapshots).toHaveLength(1);
  expect(counts).toEqual({ posts: 2, queries: 2, downloads: 2 });
});

test("pdf-import 重解析：发布前 current 已变化时保留候选并拒绝发布，旧 current 可读", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => parseResponse("Second page text v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const tree = await readRevisionDocument(root, first.revision.revisionId, "document");

  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("reparse did not form candidate");

  // 候选形成后另一操作推进 current。
  const other = structuredClone(tree);
  const otherSentence = findSentenceByText(other, "Second page text");
  other.sentences[otherSentence].content = [{ kind: "text", text: "Other concurrent edit" }];
  const otherRevision = await commitRevision({
    root,
    baseRevision: first.revision.revisionId,
    sourceSnapshotId: first.revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(other)),
      "source-base.json": Buffer.from(JSON.stringify(tree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: first.revision.revisionId })),
    },
  });

  await expect(publishDocumentMergeCandidate(reparse.candidate)).rejects.toThrow(/baseRevision|基线/);
  expect(await currentRevisionId()).toBe(otherRevision.revisionId);
  const current = await readRevisionDocument(root, otherRevision.revisionId, "document");
  expect(projectSentenceText(current, otherSentence)).toBe("Other concurrent edit");
  // 候选与解析快照保留，可在重新核对基线后再次合并。
  expect((await parseSnapshots()).length).toBe(2);
});

test("pdf-import 重解析：拒绝上传确认不产生 POST 或任务记录", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService([() => parseResponse("Second page text")], counts);
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");

  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => false,
  });
  expect(reparse.outcome).toBe("cancelled");
  expect(counts.posts).toBe(1);
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
  expect((await parseSnapshots()).length).toBe(1);
});

test("pdf-import 重解析：baseRevision 已过期时不发起上传", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService([() => parseResponse("Second page text")], counts);
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const tree = await readRevisionDocument(root, first.revision.revisionId, "document");
  const newer = await commitRevision({
    root,
    baseRevision: first.revision.revisionId,
    sourceSnapshotId: first.revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(tree)),
      "source-base.json": Buffer.from(JSON.stringify(tree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: first.revision.revisionId })),
    },
  });

  await expect(
    reparsePdfToCandidate({
      root,
      sourceSnapshotId,
      baseRevision: first.revision.revisionId,
      config: config(endpoint),
      confirmUpload: async () => true,
    }),
  ).rejects.toThrow(/baseRevision/);
  expect(counts.posts).toBe(1);
  expect(await currentRevisionId()).toBe(newer.revisionId);
});

test("pdf-import 重解析：任务记录持久化基线与解析快照，供恢复与重新合并使用", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => parseResponse("Second page text v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");

  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("reparse did not form candidate");
  const task = await readTaskRecord(reparse.task.parseBatchId);
  expect(task.phase).toBe("candidate-complete");
  expect(task.baseRevision).toBe(first.revision.revisionId);
  expect(task.parseSourceSnapshotId).toBe(reparse.candidate.sourceSnapshotId);
});

test("pdf-import 重解析恢复：已完成候选离线重建合并，不重复下载不推进 current", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => parseResponse("Second page text v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("reparse did not form candidate");

  const resumed = await resumePdfReparse({ root, parseBatchId: reparse.task.parseBatchId });
  expect(resumed.outcome).toBe("candidate");
  if (resumed.outcome !== "candidate") throw new Error("resume did not rebuild candidate");
  expect(resumed.candidate.document).toEqual(reparse.candidate.document);
  expect(resumed.candidate.changeset).toEqual(reparse.candidate.changeset);
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
  expect(counts).toEqual({ posts: 2, queries: 2, downloads: 2 });

  const published = await publishDocumentMergeCandidate(resumed.candidate);
  expect(await currentRevisionId()).toBe(published.revisionId);
});

test("pdf-import 重解析恢复：受理后本机停止，恢复沿用原任务号查询下载", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => parseResponse("Second page text v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const controller = new AbortController();
  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
    signal: controller.signal,
    taskHooks: {
      onPoint: (point) => {
        if (point === "job-persisted") controller.abort();
      },
    },
  });
  // 提交受理后本机停止：远端可能继续，任务保留原任务号。
  expect(reparse.outcome).toBe("incomplete");
  if (reparse.outcome !== "incomplete") throw new Error("expected stopped task");
  expect(reparse.task.phase).toBe("stopped");

  const resumed = await resumePdfReparse({
    root,
    parseBatchId: reparse.task.parseBatchId,
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("candidate");
  if (resumed.outcome !== "candidate") throw new Error("resume did not form candidate");
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
  expect(counts.posts).toBe(2);
  expect(counts.downloads).toBe(2);
});

test("pdf-import 重解析恢复：提交结果不明时人工关联任务号，绝不重传", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  let endpoint = "";
  let failReceipt = false;
  endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      await drain(request);
      counts.posts += 1;
      if (failReceipt) {
        response.end(JSON.stringify({ code: 0, data: {} }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { jobId: "job-reparse-0" } }));
      return;
    }
    if (request.url === "/jobs/job-reparse-0") {
      counts.queries += 1;
      response.end(
        JSON.stringify({
          code: 0,
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result/job-reparse-0` } },
        }),
      );
      return;
    }
    if (request.url === "/jobs/result/job-reparse-0") {
      counts.downloads += 1;
      response.end(parseResponse("Second page text"));
      return;
    }
    response.writeHead(404).end();
  });
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");

  failReceipt = true;
  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(reparse.outcome).toBe("incomplete");
  if (reparse.outcome !== "incomplete") throw new Error("expected unknown submission");
  expect(reparse.task.phase).toBe("unknown");
  const postsAfterUnknown = counts.posts;

  const resumed = await resumePdfReparse({
    root,
    parseBatchId: reparse.task.parseBatchId,
    config: config(endpoint),
    jobId: "job-reparse-0",
  });
  expect(resumed.outcome).toBe("candidate");
  if (resumed.outcome !== "candidate") throw new Error("resume did not form candidate");
  expect(counts.posts).toBe(postsAfterUnknown);
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
});

/** 与更新后 PDF 页数一致的单页受控解析响应。 */
function singlePageResponse(text: string): Buffer {
  return jsonl([row([vendorPage([block(0, text)])])]);
}

test("pdf-import 新 PDF 更新：形成候选不覆盖 current，内容改变核验成为 modified-unreviewed 并附来源变化", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => singlePageResponse("Updated paper text")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const tree = await readRevisionDocument(root, first.revision.revisionId, "document");
  const firstSentence = findSentenceByText(tree, "First page paragraph");
  await createVerification({
    root,
    expectedRevisionId: first.revision.revisionId,
    anchor: { kind: "sentence", unitId: tree.sentences[firstSentence].unitId, sentenceId: firstSentence },
    actor: { kind: "user", confirmed: true },
  });

  const updated = await snapshotLocalPdf({ root, source: OTHER_PDF });
  expect(updated.ok).toBe(true);
  if (!updated.ok) throw new Error("updated PDF snapshot failed");
  expect(updated.reused).toBe(false);
  expect(updated.snapshot.sourceSnapshotId).not.toBe(sourceSnapshotId);

  const confirmations: string[] = [];
  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId: updated.snapshot.sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async (request) => {
      confirmations.push(request.sourceSnapshotId);
      return true;
    },
  });
  expect(confirmations).toEqual([updated.snapshot.sourceSnapshotId]);
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("update did not form candidate");
  expect(await currentRevisionId()).toBe(first.revision.revisionId);

  let candidate = reparse.candidate;
  for (const conflict of candidate.conflicts)
    candidate = resolveDocumentMergeCandidateConflict(candidate, conflict.id, "candidate");
  // 继承钩子由 PDF 侧调用方注入（wp4）：通用发布本身不含核验语义。
  const published = await publishDocumentMergeCandidate(
    candidate,
    verificationInheritCommitHooks({
      root,
      baseRevision: candidate.baseRevision,
      revisionId: candidate.revisionId,
      sourceSnapshotId: candidate.sourceSnapshotId,
      document: candidate.document,
    }),
  );
  expect(await currentRevisionId()).toBe(published.revisionId);
  const inherited = await readVerificationRecords(root, published.revisionId);
  expect(inherited).toHaveLength(1);
  expect(inherited[0].coverage.every((entry) => entry.validity === "modified-unreviewed")).toBe(true);
  expect(inherited[0].pdfSourceChanged).toBe(true);
  expect(inherited[0].verifiedRevisionId).toBe(first.revision.revisionId);
  expect(inherited[0].pdfSnapshotId).toBe(sourceSnapshotId);
  const pdfSnapshots = (await listSourceSnapshots(root)).filter((entry) => entry.kind === "pdf");
  expect(pdfSnapshots).toHaveLength(2);
});

test("pdf-import 新 PDF 更新：内容未变节点保留历史来源核验，删除节点核验成为 removed", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => singlePageResponse("First page paragraph")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const tree = await readRevisionDocument(root, first.revision.revisionId, "document");
  const firstSentence = findSentenceByText(tree, "First page paragraph");
  const secondSentence = findSentenceByText(tree, "Second page text");
  await createVerification({
    root,
    expectedRevisionId: first.revision.revisionId,
    anchor: { kind: "sentence", unitId: tree.sentences[firstSentence].unitId, sentenceId: firstSentence },
    actor: { kind: "user", confirmed: true },
  });
  await createVerification({
    root,
    expectedRevisionId: first.revision.revisionId,
    anchor: { kind: "sentence", unitId: tree.sentences[secondSentence].unitId, sentenceId: secondSentence },
    actor: { kind: "user", confirmed: true },
  });

  const updated = await snapshotLocalPdf({ root, source: OTHER_PDF });
  expect(updated.ok).toBe(true);
  if (!updated.ok) throw new Error("updated PDF snapshot failed");
  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId: updated.snapshot.sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("update did not form candidate");
  let candidate = reparse.candidate;
  for (const conflict of candidate.conflicts)
    candidate = resolveDocumentMergeCandidateConflict(candidate, conflict.id, "candidate");
  const published = await publishDocumentMergeCandidate(
    candidate,
    verificationInheritCommitHooks({
      root,
      baseRevision: candidate.baseRevision,
      revisionId: candidate.revisionId,
      sourceSnapshotId: candidate.sourceSnapshotId,
      document: candidate.document,
    }),
  );
  const inherited = await readVerificationRecords(root, published.revisionId);
  expect(inherited).toHaveLength(2);
  const bySentence = new Map(
    inherited.map((record) => [
      record.anchor.kind === "sentence" ? record.anchor.sentenceId : null,
      record.coverage.find((entry) => entry.nodeType === "sentence")?.validity,
    ]),
  );
  expect(bySentence.get(firstSentence)).toBe("historical-source");
  expect(bySentence.get(secondSentence)).toBe("removed");
});

test("pdf-import 重解析：PDF 快照缺失时不发起上传，current 保持可读", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService([() => parseResponse("Second page text")], counts);
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const pdfSnapshots = (await listSourceSnapshots(root)).filter((entry) => entry.kind === "pdf");
  await fs.rm(path.join(root, pdfSnapshots[0].path), { recursive: true, force: true });

  await expect(
    reparsePdfToCandidate({
      root,
      sourceSnapshotId,
      baseRevision: first.revision.revisionId,
      config: config(endpoint),
      confirmUpload: async () => true,
    }),
  ).rejects.toThrow();
  expect(counts.posts).toBe(1);
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
});

test("pdf-import 重解析：解析结果无可读正文时保留快照与诊断，不形成候选", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [
      () => parseResponse("Second page text"),
      () => jsonl([row([vendorPage([]), vendorPage([])])]),
      () => parseResponse("Second page text v2"),
    ],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");

  const failed = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(failed.outcome).toBe("incomplete");
  if (failed.outcome !== "incomplete") throw new Error("expected incomplete reparse");
  expect(failed.diagnostic).toMatchObject({
    code: "pdf-convert-failed",
    severity: "fatal",
    stage: "convert",
    messageKey: "pdf.convert.failed",
  });
  expect(failed.task.phase).toBe("failed");
  const persisted = await readTaskRecord(failed.task.parseBatchId);
  expect(persisted.phase).toBe("failed");
  expect(persisted.diagnostic).toEqual(failed.diagnostic);
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
  // 解析快照已去敏发布并保留，可供修复后离线重新转换。
  expect((await parseSnapshots()).length).toBe(2);
  // 失败任务不永久阻塞：用户可以显式发起新的云端任务。
  const retry = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(retry.outcome).toBe("candidate");
  expect(counts.posts).toBe(3);
});

test("pdf-import 重解析：存在未结束任务时拒绝新建云端任务", async () => {
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => parseResponse("Second page text"), () => parseResponse("Second page text v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const controller = new AbortController();
  const stopped = await reparsePdfToCandidate({
    root,
    sourceSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
    signal: controller.signal,
    taskHooks: {
      onPoint: (point) => {
        if (point === "job-persisted") controller.abort();
      },
    },
  });
  expect(stopped.outcome).toBe("incomplete");
  if (stopped.outcome !== "incomplete") throw new Error("expected stopped task");
  const postsBefore = counts.posts;

  await expect(
    reparsePdfToCandidate({
      root,
      sourceSnapshotId,
      baseRevision: first.revision.revisionId,
      config: config(endpoint),
      confirmUpload: async () => true,
    }),
  ).rejects.toThrow(/恢复原任务|重复付费/);
  expect(counts.posts).toBe(postsBefore);
});

/** 300x200pt 单页 PDF：黑矩形 top-left (20,30)-(100,60)。 */
function inkPdf(): Buffer {
  const stream = "0 g 20 140 80 30 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function cropVisualResponse(text: string): Buffer {
  return jsonl([
    row([
      {
        prunedResult: {
          width: 1200,
          height: 800,
          model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
          parsing_res_list: [
            block(0, text, { block_bbox: [40, 40, 600, 80] }),
            block(1, "", { block_label: "image", block_bbox: [80, 120, 400, 240] }),
          ],
        },
      },
    ]),
  ]);
}

test("pdf-import 重解析携带原页裁剪候选：发布后裁剪资产可读，旧 current 不受影响", async () => {
  const file = path.join(sandbox, "ink.pdf");
  await fs.writeFile(file, inkPdf());
  const snapshot = await snapshotLocalPdf({ root, source: file });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("ink PDF snapshot failed");
  const inkSnapshotId = snapshot.snapshot.sourceSnapshotId;
  const counts: ControlledCounts = { posts: 0, queries: 0, downloads: 0 };
  const endpoint = await controlledParseService(
    [() => cropVisualResponse("First page paragraph"), () => cropVisualResponse("First page paragraph v2")],
    counts,
  );
  const first = await importPdfToCurrent({
    root,
    sourceSnapshotId: inkSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") throw new Error("import did not publish");
  const firstTree = await readRevisionDocument(root, first.revision.revisionId, "document");
  const firstFigure = firstTree.blocks.find((entry) => entry.kind === "figure")!;
  if (firstFigure.kind !== "figure" || !firstFigure.asset) throw new Error("figure asset missing");
  const firstCrop = await readRevisionAsset(root, first.revision.revisionId, firstFigure.asset.path);

  const reparse = await reparsePdfToCandidate({
    root,
    sourceSnapshotId: inkSnapshotId,
    baseRevision: first.revision.revisionId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(reparse.outcome).toBe("candidate");
  if (reparse.outcome !== "candidate") throw new Error("reparse did not form candidate");
  // 候选未发布：current 仍是首次导入 revision。
  expect(await currentRevisionId()).toBe(first.revision.revisionId);
  expect(reparse.candidate.assets[firstFigure.asset.path]).toBeTruthy();

  const published = await publishDocumentMergeCandidate(reparse.candidate);
  const publishedTree = await readRevisionDocument(root, published.revisionId, "document");
  const figure = publishedTree.blocks.find((entry) => entry.kind === "figure")!;
  if (figure.kind !== "figure" || !figure.asset) throw new Error("published figure asset missing");
  const crop = await readRevisionAsset(root, published.revisionId, figure.asset.path);
  expect(Buffer.from(crop.bytes).equals(Buffer.from(firstCrop.bytes))).toBe(true);
  expect(
    normalized(
      unitText(publishedTree, Object.values(publishedTree.units).find((unit) => unit.kind === "paragraph")!.id),
    ),
  ).toBe("First page paragraph v2");
  expect(counts.posts).toBe(2);
});
