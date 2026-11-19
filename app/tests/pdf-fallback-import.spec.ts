// 契约回归（SPEC-pdf-import §3.4、Testing Strategy 第 6 条／s08.6）：
// arXiv 固定版本 PDF 回退组合入口——交接与工程谱系核验、固定 vN 下载、
// 显式上传确认前零 POST、拒绝保留快照、更新场景走候选不覆盖 current。
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createProject, openProject } from "../src/main/project-core";
import { importArxivPdfFallback } from "../src/main/pdf/fallback-import";
import { prepareArxivPdfFallback } from "../src/main/arxiv/import";
import type { ArxivTransport } from "../src/main/arxiv/fetch";
import type { PdfFallbackRequest } from "../src/shared/arxiv";
import type { BaiduPdfParseConfig } from "../src/main/parsing/baidu-task";
import type { BaiduUploadConfirmationRequest } from "../src/shared/parsing";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const ID = "2401.01234";

let sandbox: string;
let baidu: Server | null = null;
let endpoint = "";
let posts: number;

function block(id: number, content: string) {
  return {
    block_label: "text",
    block_content: content,
    block_bbox: [10, 20, 100, 60],
    block_id: id,
    block_order: id,
    group_id: id,
  };
}

function parseResponse(): Buffer {
  const page = (text: string) => ({
    prunedResult: {
      width: 1191,
      height: 1684,
      model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
      parsing_res_list: [block(0, text)],
    },
  });
  return Buffer.from(JSON.stringify({
    result: {
      dataInfo: { type: "pdf", numPages: 2, pages: [{ width: 1191, height: 1684 }, { width: 1191, height: 1684 }] },
      layoutParsingResults: [page("Fallback contract text"), page("Fallback second page")],
    },
  }) + "\n");
}

async function startBaidu() {
  posts = 0;
  baidu = createServer((request, response) => {
    void (async () => {
      if (request.method === "POST") {
        for await (const _chunk of request) { /* 消费受控上传 */ }
        posts += 1;
        response.end(JSON.stringify({ code: 0, data: { jobId: "job-contract-0" } }));
        return;
      }
      if (request.url === "/jobs/job-contract-0") {
        response.end(JSON.stringify({
          code: 0,
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
        }));
        return;
      }
      if (request.url === "/jobs/result") {
        response.end(parseResponse());
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => baidu!.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(baidu!.address() as AddressInfo).port}/jobs`;
}

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-fallback-contract-"));
  await startBaidu();
});

test.afterEach(async () => {
  if (baidu) {
    baidu.closeAllConnections();
    await new Promise<void>((resolve) => baidu!.close(() => resolve()));
    baidu = null;
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** 受控 arXiv transport：只服务固定 vN PDF；记录请求供断言。 */
function pdfTransport(pdfBytes: Buffer, requested: string[]): ArxivTransport {
  return async (url) => {
    requested.push(url);
    if (url !== `https://arxiv.org/pdf/${ID}v1`)
      throw new Error(`非预期 URL：${url}`);
    return {
      status: 200,
      url,
      redirectChain: [url],
      headers: { "content-type": "application/pdf" },
      bytes: pdfBytes,
    };
  };
}

function config(): BaiduPdfParseConfig {
  return { endpoint, model: "PaddleOCR-VL-1.6", apiKey: "contract-token" };
}

/** 构造带固定版本导入记录的工程：模拟 HTML 失败后的可回退现场。 */
async function fallbackProject(name: string) {
  const created = await createProject({ parent: sandbox, name });
  const imports = path.join(created.root, ".paper30min", "imports");
  await fs.mkdir(imports, { recursive: true });
  await fs.writeFile(path.join(imports, "initial.json"), JSON.stringify({
    formatVersion: 1,
    id: randomUUID(),
    projectId: created.manifest.id,
    paperId: created.manifest.paper.id,
    arxiv: {
      reference: { baseId: ID, version: 1, canonicalId: `${ID}v1` },
      stage: "resolve",
      nextAction: "pdf-fallback",
    },
  }) + "\n");
  const opened = await openProject(created.root);
  const handoff = await prepareArxivPdfFallback(opened, {
    code: "arxiv-html-fetch-failed",
    severity: "fatal",
    stage: "fetch",
    messageKey: "arxiv.html.fetchFailed",
  });
  if (!handoff.ok) throw new Error("fixture handoff failed");
  return { root: created.root, request: handoff.request, paperId: opened.manifest.paper.id };
}

test("pdf-fallback 组合：固定版本下载形成快照，确认前零 POST，发布后工程与 paper.id 不变", async () => {
  const { root, request, paperId } = await fallbackProject("组合首次");
  const pdfBytes = await fs.readFile(SAMPLE);
  const requested: string[] = [];
  let confirmedRequest: BaiduUploadConfirmationRequest | null = null;
  const result = await importArxivPdfFallback({
    root,
    request,
    transport: pdfTransport(pdfBytes, requested),
    config: config(),
    confirmUpload: async (upload) => {
      confirmedRequest = upload;
      expect(posts).toBe(0);
      return true;
    },
    signal: new AbortController().signal,
  });
  expect(result.outcome, JSON.stringify(result)).toBe("published");
  if (result.outcome !== "published") return;
  expect(posts).toBe(1);
  expect(requested).toEqual([`https://arxiv.org/pdf/${ID}v1`]);
  expect(confirmedRequest!.pdfSha256).toBeTruthy();
  const opened = await openProject(root);
  expect(opened.manifest.paper.id).toBe(paperId);
  expect(opened.manifest.paper.currentRevision).toBe(result.revision.revisionId);
});

test("pdf-fallback 组合：拒绝确认零 POST，PDF 快照保留且重试复用不重复下载", async () => {
  const { root, request } = await fallbackProject("组合拒绝");
  const pdfBytes = await fs.readFile(SAMPLE);
  const requested: string[] = [];
  const rejected = await importArxivPdfFallback({
    root,
    request,
    transport: pdfTransport(pdfBytes, requested),
    config: config(),
    confirmUpload: async () => false,
    signal: new AbortController().signal,
  });
  expect(rejected.outcome).toBe("cancelled");
  expect(posts).toBe(0);
  expect((await openProject(root)).manifest.paper.currentRevision).toBeNull();
  const sources = await fs.readdir(path.join(root, "sources"));
  expect(sources).toHaveLength(1);
  // 重试：同字节同谱系复用快照，transport 不再被调用。
  const retried = await importArxivPdfFallback({
    root,
    request,
    transport: async (url) => {
      requested.push(url);
      throw new Error("重试不应重新下载同字节来源");
    },
    config: config(),
    confirmUpload: async () => true,
    signal: new AbortController().signal,
  });
  expect(retried.outcome).toBe("published");
  expect(requested).toHaveLength(1);
});

test("pdf-fallback 组合：交接与工程谱系不符在网络前拒绝", async () => {
  const { root, request } = await fallbackProject("组合篡改");
  const requested: string[] = [];
  const pdfBytes = await fs.readFile(SAMPLE);
  const tampered: PdfFallbackRequest = { ...request, version: 2 };
  await expect(importArxivPdfFallback({
    root,
    request: tampered,
    transport: pdfTransport(pdfBytes, requested),
    config: config(),
    confirmUpload: async () => true,
    signal: new AbortController().signal,
  })).rejects.toThrow(/现场不符/);
  expect(requested).toHaveLength(0);
  expect(posts).toBe(0);
  // current 已存在时首次导入交接（baseRevision=null）同样拒绝。
  const created = await createProject({ parent: sandbox, name: "已有正文" });
  await expect(importArxivPdfFallback({
    root: created.root,
    request,
    transport: pdfTransport(pdfBytes, requested),
    config: config(),
    confirmUpload: async () => true,
    signal: new AbortController().signal,
  })).rejects.toThrow(/现场不符/);
  expect(requested).toHaveLength(0);
});

test("pdf-fallback 组合：下载失败不创建云端任务、不产生费用", async () => {
  const { root, request } = await fallbackProject("组合下载失败");
  const result = await importArxivPdfFallback({
    root,
    request,
    transport: async () => {
      throw new Error("arxiv-fetch-network: simulated");
    },
    config: config(),
    confirmUpload: async () => {
      throw new Error("下载失败不应到达上传确认");
    },
    signal: new AbortController().signal,
  });
  expect(result.outcome).toBe("snapshot-failed");
  expect(posts).toBe(0);
  expect((await openProject(root)).manifest.paper.currentRevision).toBeNull();
});

test("pdf-fallback 组合：PDF 来源工程冒充 arXiv HTML 更新交接被拒绝，current 不变", async () => {
  // 先经首次回退发布 current，再构造同 baseId 固定版本的更新交接。
  const { root, request, paperId } = await fallbackProject("组合更新");
  const pdfBytes = await fs.readFile(SAMPLE);
  const requested: string[] = [];
  const first = await importArxivPdfFallback({
    root,
    request,
    transport: pdfTransport(pdfBytes, requested),
    config: config(),
    confirmUpload: async () => true,
    signal: new AbortController().signal,
  });
  expect(first.outcome).toBe("published");
  if (first.outcome !== "published") return;
  const current = first.revision.revisionId;
  // 更新交接：baseRevision 指向当前 revision；主进程按 current 来源谱系核验。
  // current 来源是 pdf-parse（父为 arXiv PDF），不是 arxiv HTML：核验必须拒绝，
  // 不能把 PDF 来源工程冒充 arXiv HTML 更新现场。
  const update: PdfFallbackRequest = { ...request, baseRevision: current };
  await expect(importArxivPdfFallback({
    root,
    request: update,
    transport: pdfTransport(pdfBytes, requested),
    config: config(),
    confirmUpload: async () => true,
    signal: new AbortController().signal,
  })).rejects.toThrow(/现场不符/);
  expect(posts).toBe(1);
  expect((await openProject(root)).manifest.paper.currentRevision).toBe(current);
  expect((await openProject(root)).manifest.paper.id).toBe(paperId);
});