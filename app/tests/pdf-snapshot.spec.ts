import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  createProject,
  listSourceSnapshots,
  openProject,
  readSourceSnapshot,
} from "../src/main/project-core";
import { snapshotLocalPdf, snapshotArxivPdf } from "../src/main/pdf/snapshot";
import {
  ArxivFetchError,
  type ArxivFetchResponse,
  type ArxivTransport,
} from "../src/main/arxiv/fetch";
import type { PdfFallbackRequest } from "../src/shared/arxiv";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const LONG = path.resolve("tests/fixtures/long-150.pdf");
const ENCRYPTED = path.resolve("tests/fixtures/encrypted.pdf");
const PDF_URL = "https://arxiv.org/pdf/2401.01234v2";
const MAX_PDF_BYTES = 50 * 1024 * 1024;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fallbackRequest(version = 2): PdfFallbackRequest {
  return {
    kind: "arxiv-pdf",
    baseId: "2401.01234",
    version,
    reasonCode: "arxiv-html-not-found",
    baseRevision: null,
  };
}

const pdfUrlOf = (version: number) => `https://arxiv.org/pdf/2401.01234v${version}`;

function pdfTransport(bytes: Uint8Array, finalUrl = PDF_URL) {
  const calls: string[] = [];
  const transport: ArxivTransport = async (url, options) => {
    calls.push(url);
    options.signal?.throwIfAborted();
    if (bytes.byteLength > options.budgetBytes) throw new Error("fixture budget exceeded");
    const response: ArxivFetchResponse = {
      status: 200,
      url: finalUrl,
      redirectChain: [url, finalUrl],
      headers: { "content-type": "application/pdf" },
      bytes,
    };
    return response;
  };
  return { transport, calls };
}

let sandbox: string;
let root: string;
let projectId: string;
let paperId: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-snapshot-"));
  const created = await createProject({ parent: sandbox, name: "PDF 工程" });
  root = created.root;
  projectId = created.manifest.id;
  paperId = created.manifest.paper.id;
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("pdf-import 本地主论文只读复制为可搬迁快照，普通参考 PDF 不登记", async () => {
  const external = path.join(sandbox, "外部 论文.pdf");
  await fs.copyFile(SAMPLE, external);
  const original = await fs.readFile(external);
  const originalStat = await fs.stat(external);
  const manifestBefore = await fs.readFile(path.join(root, "paper30min.json"), "utf8");

  const result = await snapshotLocalPdf({ root, source: external });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.reused).toBe(false);
  expect(result.bodyReadable).toBe(false);
  const snapshot = result.snapshot;
  expect(snapshot.kind).toBe("pdf");
  expect(snapshot.originalName).toBe("外部 论文.pdf");
  expect(snapshot.sha256).toBe(sha256(original));
  expect(snapshot.pageCount).toBe(2);
  expect(snapshot.sourceSnapshotId).toMatch(/^[0-9a-f-]{36}$/);
  expect(snapshot.sourceSnapshotId).not.toBe(snapshot.sha256);
  expect(snapshot.projectId).toBe(projectId);
  expect(snapshot.paperId).toBe(paperId);
  expect(snapshot.files).toEqual([
    expect.objectContaining({
      path: "paper.pdf",
      sha256: sha256(original),
      size: original.byteLength,
      mime: "application/pdf",
    }),
  ]);
  expect(await fs.readFile(path.join(root, snapshot.path, "paper.pdf"))).toEqual(original);
  expect(await fs.readFile(external)).toEqual(original);
  expect((await fs.stat(external)).mtimeMs).toBe(originalStat.mtimeMs);
  const storedMetadata = await fs.readFile(path.join(root, snapshot.path, "snapshot.json"), "utf8");
  expect(storedMetadata).not.toContain(external);
  expect(storedMetadata).not.toContain(sandbox);

  await fs.mkdir(path.join(root, "references"));
  await fs.copyFile(LONG, path.join(root, "references", "普通参考.pdf"));
  expect(await listSourceSnapshots(root)).toHaveLength(1);
  expect(await fs.readFile(path.join(root, "paper30min.json"), "utf8")).toBe(manifestBefore);
  expect(JSON.parse(manifestBefore)).not.toHaveProperty("materials");

  const moved = path.join(sandbox, "搬迁后");
  await fs.rename(root, moved);
  const reopened = await readSourceSnapshot(moved, snapshot.sourceSnapshotId);
  expect(reopened.path).toBe(`sources/${snapshot.sourceSnapshotId}`);
  expect(await fs.readFile(path.join(moved, reopened.path, "paper.pdf"))).toEqual(original);
});

test("pdf-import 同字节复用、不同字节新快照，哈希不改变工程或论文身份", async () => {
  const first = await snapshotLocalPdf({ root, source: SAMPLE });
  const repeated = await snapshotLocalPdf({ root, source: SAMPLE });
  const changed = await snapshotLocalPdf({ root, source: LONG });
  for (const result of [first, repeated, changed]) expect(result.ok).toBe(true);
  if (!first.ok || !repeated.ok || !changed.ok) return;

  expect(repeated.reused).toBe(true);
  expect(repeated.snapshot.sourceSnapshotId).toBe(first.snapshot.sourceSnapshotId);
  expect(changed.reused).toBe(false);
  expect(changed.snapshot.sourceSnapshotId).not.toBe(first.snapshot.sourceSnapshotId);
  expect(changed.snapshot.sha256).not.toBe(first.snapshot.sha256);
  expect(changed.snapshot.pageCount).toBe(150);
  for (const snapshot of [first.snapshot, repeated.snapshot, changed.snapshot]) {
    expect(snapshot.projectId).toBe(projectId);
    expect(snapshot.paperId).toBe(paperId);
  }
  expect((await openProject(root)).manifest.id).toBe(projectId);
  expect((await openProject(root)).manifest.paper.id).toBe(paperId);
  expect(await fs.readdir(path.join(root, "sources"))).toHaveLength(2);

  await fs.writeFile(path.join(root, first.snapshot.path, "paper.pdf"), "tampered");
  await expect(readSourceSnapshot(root, first.snapshot.sourceSnapshotId)).rejects.toThrow();
});

test("pdf-import arXiv 回退只获取固定版本并保存来源谱系", async () => {
  const bytes = await fs.readFile(SAMPLE);
  const { transport, calls } = pdfTransport(bytes);
  const request = fallbackRequest();
  const result = await snapshotArxivPdf({ root, request, transport });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(calls).toEqual([PDF_URL]);
  expect(result.bodyReadable).toBe(false);
  expect(result.snapshot.kind).toBe("pdf");
  expect(result.snapshot.originalName).toBe("2401.01234v2.pdf");
  expect(result.snapshot.pageCount).toBe(2);
  expect(result.snapshot.sha256).toBe(sha256(bytes));
  expect(result.snapshot.arxiv).toEqual({
    baseId: "2401.01234",
    version: 2,
    pdfUrl: PDF_URL,
  });
  expect(result.snapshot.projectId).toBe(projectId);
  expect(result.snapshot.paperId).toBe(paperId);
  expect(result.snapshot.sourceSnapshotId).not.toBe(result.snapshot.sha256);
});

test("pdf-import arXiv 下载 URL 由主进程按固定版本重建，renderer 注入 URL 被忽略", async () => {
  const bytes = await fs.readFile(SAMPLE);
  const { transport, calls } = pdfTransport(bytes);
  const result = await snapshotArxivPdf({
    root,
    // 契约上请求不携带 URL；即使运行时被注入恶意 URL 也不得影响下载目标。
    request: { ...fallbackRequest(), pdfUrl: "https://evil.example/pdf/2401.01234v3" } as PdfFallbackRequest,
    transport,
  });
  expect(result.ok).toBe(true);
  expect(calls).toEqual([pdfUrlOf(2)]);
});

test("pdf-import arXiv 请求版本混用在网络前拒绝", async () => {
  const bytes = await fs.readFile(SAMPLE);
  const { transport, calls } = pdfTransport(bytes);
  // 请求不携带 URL：网络前拦截由取消守卫承担；版本混用守卫作用于响应最终 URL。
  const controller = new AbortController();
  controller.abort();
  await snapshotArxivPdf({
    root,
    request: fallbackRequest(),
    transport,
    signal: controller.signal,
  });
  const result = await snapshotArxivPdf({
    root,
    request: fallbackRequest(),
    transport: pdfTransport(bytes, "https://arxiv.org/pdf/2401.01234v3").transport,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-version-mixed");
  expect(calls).toEqual([]);
  expect(await listSourceSnapshots(root)).toEqual([]);
});

test("pdf-import arXiv 响应版本混用不发布快照", async () => {
  const bytes = await fs.readFile(SAMPLE);
  const { transport } = pdfTransport(bytes, "https://arxiv.org/pdf/2401.01234v3");
  const result = await snapshotArxivPdf({ root, request: fallbackRequest(), transport });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-version-mixed");
  expect(await listSourceSnapshots(root)).toEqual([]);
});

test("pdf-import 同字节但本地与 arXiv 来源不复用，且各自保留谱系", async () => {
  const bytes = await fs.readFile(SAMPLE);
  const local = await snapshotLocalPdf({ root, source: SAMPLE });
  const arxiv = await snapshotArxivPdf({
    root,
    request: fallbackRequest(),
    transport: pdfTransport(bytes).transport,
  });
  expect(local.ok).toBe(true);
  expect(arxiv.ok).toBe(true);
  if (!local.ok || !arxiv.ok) return;
  expect(arxiv.reused).toBe(false);
  expect(arxiv.snapshot.sourceSnapshotId).not.toBe(local.snapshot.sourceSnapshotId);
  expect(local.snapshot).not.toHaveProperty("arxiv");
  expect(arxiv.snapshot.arxiv).toEqual({
    baseId: "2401.01234",
    version: 2,
    pdfUrl: PDF_URL,
  });
  expect(await fs.readdir(path.join(root, "sources"))).toHaveLength(2);

  const arxivFirst = await createProject({ parent: sandbox, name: "arXiv 优先" });
  const firstArxiv = await snapshotArxivPdf({
    root: arxivFirst.root,
    request: fallbackRequest(),
    transport: pdfTransport(bytes).transport,
  });
  const afterArxiv = await snapshotLocalPdf({
    root: arxivFirst.root,
    source: SAMPLE,
  });
  expect(firstArxiv.ok).toBe(true);
  expect(afterArxiv.ok).toBe(true);
  if (!firstArxiv.ok || !afterArxiv.ok) return;
  expect(afterArxiv.reused).toBe(false);
  expect(afterArxiv.snapshot.sourceSnapshotId).not.toBe(
    firstArxiv.snapshot.sourceSnapshotId,
  );
  expect(afterArxiv.snapshot).not.toHaveProperty("arxiv");
  const repeatedLocal = await snapshotLocalPdf({
    root: arxivFirst.root,
    source: SAMPLE,
  });
  expect(repeatedLocal.ok).toBe(true);
  if (!repeatedLocal.ok) return;
  expect(repeatedLocal.reused).toBe(true);
  expect(repeatedLocal.snapshot.sourceSnapshotId).toBe(
    afterArxiv.snapshot.sourceSnapshotId,
  );
});

test("pdf-import 同字节但 arXiv 固定版本不同不复用", async () => {
  const bytes = await fs.readFile(SAMPLE);
  const v2 = fallbackRequest(2);
  const v1 = fallbackRequest(1);
  const second = await snapshotArxivPdf({
    root,
    request: v2,
    transport: pdfTransport(bytes, pdfUrlOf(2)).transport,
  });
  const first = await snapshotArxivPdf({
    root,
    request: v1,
    transport: pdfTransport(bytes, pdfUrlOf(1)).transport,
  });
  expect(second.ok).toBe(true);
  expect(first.ok).toBe(true);
  if (!second.ok || !first.ok) return;
  expect(first.reused).toBe(false);
  expect(first.snapshot.sourceSnapshotId).not.toBe(
    second.snapshot.sourceSnapshotId,
  );
  expect(second.snapshot.arxiv?.version).toBe(2);
  expect(first.snapshot.arxiv?.version).toBe(1);
  expect(await fs.readdir(path.join(root, "sources"))).toHaveLength(2);

  const repeated = await snapshotArxivPdf({
    root,
    request: v2,
    transport: pdfTransport(bytes, pdfUrlOf(2)).transport,
  });
  expect(repeated.ok).toBe(true);
  if (!repeated.ok) return;
  expect(repeated.reused).toBe(true);
  expect(repeated.snapshot.sourceSnapshotId).toBe(
    second.snapshot.sourceSnapshotId,
  );
});

test("pdf-import arXiv 传输失败保留 PDF 诊断且不发布", async () => {
  const calls: string[] = [];
  const transport: ArxivTransport = async (url) => {
    calls.push(url);
    throw new ArxivFetchError("arxiv-fetch-status", url, 500);
  };
  const result = await snapshotArxivPdf({
    root,
    request: fallbackRequest(),
    transport,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostic).toEqual({
      code: "arxiv-pdf-fetch-failed",
      severity: "fatal",
      stage: "fetch",
      messageKey: "arxiv.pdf.http",
      sourceUrl: PDF_URL,
    });
  }
  expect(calls).toEqual([PDF_URL]);
  expect(await listSourceSnapshots(root)).toEqual([]);
});

test("pdf-import arXiv 下载内容不是有效 PDF 时不发布", async () => {
  const result = await snapshotArxivPdf({
    root,
    request: fallbackRequest(),
    transport: pdfTransport(
      Buffer.from("%PDF-1.7\nbroken download\n"),
    ).transport,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("pdf-invalid");
  expect(await listSourceSnapshots(root)).toEqual([]);
});

test("pdf-import 扫描空白页形成快照但不等同于可读正文", async () => {
  const result = await snapshotLocalPdf({
    root,
    source: path.resolve("tests/fixtures/pdfparse_scanned_blank.pdf"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.snapshot.pageCount).toBeGreaterThan(0);
  expect(result.bodyReadable).toBe(false);
});

test("pdf-import 损坏、加密和超预算 PDF 均明确拒绝且不发布", async () => {
  const corrupt = path.join(sandbox, "损坏.pdf");
  await fs.writeFile(corrupt, "%PDF-1.7\nbroken document\n");
  const oversized = path.join(sandbox, "超预算.pdf");
  await fs.writeFile(oversized, "%PDF-1.7\n");
  await fs.truncate(oversized, MAX_PDF_BYTES + 1);

  const cases = [
    { source: corrupt, code: "pdf-invalid" },
    { source: ENCRYPTED, code: "pdf-encrypted" },
    { source: oversized, code: "pdf-budget-exceeded" },
  ];
  for (const item of cases) {
    const result = await snapshotLocalPdf({ root, source: item.source });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe(item.code);
  }
  expect(await listSourceSnapshots(root)).toEqual([]);
});
