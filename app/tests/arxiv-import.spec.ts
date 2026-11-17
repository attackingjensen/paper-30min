import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createProject,
  listSourceSnapshots,
  openProject,
  readRevisionDocument,
} from "../src/main/project-core";
import { convertArxivSnapshot } from "../src/main/arxiv/convert";
import { importArxivPaper, prepareArxivPdfFallback, resumeArxivImport } from "../src/main/arxiv/import";
import type { ArxivImportProgressHooks } from "../src/main/arxiv/import";
import type { ArxivFetchOptions, ArxivFetchResponse, ArxivTransport } from "../src/main/arxiv/fetch";
import { ArxivFetchError } from "../src/main/arxiv/fetch";
import { absHtml } from "./fixtures/arxiv-abs";
import { latexmlDocument, FIG1_SRC, FIG2_SRC } from "./fixtures/arxiv-latexml";

const BASE = "http://127.0.0.1:9999";
const ABS_URL = `${BASE}/abs/2401.01234v1`;
const HTML_URL = `${BASE}/html/2401.01234v1`;
const FIG1_URL = `${BASE}/html/extracted/6543210/figures/overview.png`;
const FIG2_URL = `${BASE}/html/x2.png`;
const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

let sandbox: string;
test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-arxiv-import-"));
});
test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function fullRoutes(): Record<string, { bytes: Uint8Array; mime: string }> {
  return {
    [ABS_URL]: { bytes: Buffer.from(absHtml({ id: "2401.01234", versions: [1] })), mime: "text/html" },
    [HTML_URL]: { bytes: Buffer.from(latexmlDocument()), mime: "text/html" },
    [FIG1_URL]: { bytes: PNG1, mime: "image/png" },
    [FIG2_URL]: { bytes: PNG2, mime: "image/png" },
    [`${BASE}/abs/2401.01234`]: { bytes: Buffer.from(absHtml({ id: "2401.01234", versions: [1] })), mime: "text/html" },
  };
}

function controlledTransport(routes: Record<string, { bytes: Uint8Array; mime: string }>) {
  const calls: string[] = [];
  const transport: ArxivTransport = async (url: string, options: ArxivFetchOptions) => {
    calls.push(url);
    if (options.signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", url);
    const route = routes[url];
    if (!route) throw new ArxivFetchError("arxiv-fetch-status", url, 404);
    const response: ArxivFetchResponse = {
      status: 200,
      url,
      redirectChain: [url],
      headers: { "content-type": route.mime },
      bytes: route.bytes,
    };
    return response;
  };
  return { calls, transport };
}

test("arxiv-import 首次导入：无版本输入固定实际版本，发布 current，全程无 PDF 请求", async () => {
  const { calls, transport } = controlledTransport(fullRoutes());
  const result = await importArxivPaper({ parent: sandbox, name: "首次导入", input: "2401.01234", transport, baseUrl: BASE });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.reference.version).toBe(1);
  const opened = await openProject(result.root);
  expect(opened.manifest.paper.currentRevision).toBe(result.revision.revisionId);
  const tree = await readRevisionDocument(result.root, result.revision.revisionId, "document");
  expect(Object.keys(tree.sections).length).toBeGreaterThan(0);
  expect(calls.some((url) => url.includes("/pdf/"))).toBe(false);
  const snapshots = await listSourceSnapshots(result.root);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].canonicalId).toBe("2401.01234v1");
});

test("arxiv-import 非法输入在网络与工程写入前被拒绝", async () => {
  const { calls, transport } = controlledTransport(fullRoutes());
  const result = await importArxivPaper({ parent: sandbox, name: "非法输入", input: "https://evil.org/abs/2401.01234", transport, baseUrl: BASE });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.stage).toBe("resolve");
  expect(calls).toHaveLength(0);
  expect(await fs.readdir(sandbox)).toHaveLength(0);
});

test("arxiv-import HTML 获取失败：保留工程与恢复记录，current 为空，不请求 PDF", async () => {
  const routes = fullRoutes();
  delete routes[HTML_URL];
  const { calls, transport } = controlledTransport(routes);
  const result = await importArxivPaper({ parent: sandbox, name: "HTML失败", input: "2401.01234", transport, baseUrl: BASE });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.stage).toBe("fetch");
  const opened = await openProject(result.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "resolve", reference: { version: 1 } });
  expect(calls.some((url) => url.includes("/pdf/"))).toBe(false);
  expect(await listSourceSnapshots(result.root)).toHaveLength(0);
});

test("arxiv-import 快照发布中断：重试不重复已验证内容，恢复后 current 可读", async () => {
  const { calls, transport } = controlledTransport(fullRoutes());
  const hooks: ArxivImportProgressHooks = {
    onCommitPoint(point) {
      if (point === "source-content") throw new Error("injected snapshot failure");
    },
  };
  const failed = await importArxivPaper({ parent: sandbox, name: "快照中断", input: "2401.01234", transport, baseUrl: BASE, hooks });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.diagnostic.stage).toBe("snapshot");
  const opened = await openProject(failed.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "resolve" });

  const resumed = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  const after = await openProject(failed.root);
  expect(after.manifest.paper.currentRevision).toBe(resumed.revision.revisionId);
  expect(after.manifest.paper.id).toBe(opened.manifest.paper.id);
  expect(await listSourceSnapshots(failed.root)).toHaveLength(1);
  // resolve 阶段 abs 已读一次；恢复只补做快照与转换，不重复解析版本。
  expect(calls.filter((url) => url === ABS_URL)).toHaveLength(2); // 首次导入 resolve + fetchArxivSnapshot 各一次
});

test("arxiv-import 转换失败：有效快照保留不误报可读，修复后离线重转换恢复", async () => {
  const routes = fullRoutes();
  routes[HTML_URL] = {
    bytes: Buffer.from(`<!DOCTYPE html><html><head><meta name="citation_arxiv_id" content="2401.01234v1"/></head><body><article class="ltx_document"><div class="ltx_abstract"><p class="ltx_p">Only abstract.</p></div></article></body></html>`),
    mime: "text/html",
  };
  const { calls, transport } = controlledTransport(routes);
  const failed = await importArxivPaper({ parent: sandbox, name: "转换失败", input: "2401.01234", transport, baseUrl: BASE });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.diagnostic.stage).toBe("convert");
  const opened = await openProject(failed.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "snapshot", diagnostic: { stage: "convert" } });
  const snapshots = await listSourceSnapshots(failed.root);
  expect(snapshots).toHaveLength(1);

  // 同一快照转换器重试仍失败：不改变快照，不发布。
  const retried = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(retried.ok).toBe(false);
  expect(await listSourceSnapshots(failed.root)).toHaveLength(1);
  const callsBefore = calls.length;

  // 离线重新转换（不注入 transport）：快照仍缺正文，如实失败且不访问网络。
  const offline = await resumeArxivImport({ root: failed.root, baseUrl: BASE });
  expect(offline.ok).toBe(false);
  expect(calls.length).toBe(callsBefore);
});

test("arxiv-import current 推进中断：候选保留，重试完成发布且内容一致", async () => {
  const { transport } = controlledTransport(fullRoutes());
  const hooks: ArxivImportProgressHooks = {
    onCommitPoint(point) {
      if (point === "before-current-replace") throw new Error("injected current failure");
    },
  };
  const failed = await importArxivPaper({ parent: sandbox, name: "推进中断", input: "2401.01234", transport, baseUrl: BASE, hooks });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.diagnostic.stage).toBe("publish");
  const opened = await openProject(failed.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "snapshot" });

  const resumed = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  const after = await openProject(failed.root);
  expect(after.manifest.paper.currentRevision).toBe(resumed.revision.revisionId);
  expect(after.manifest.paper.id).toBe(opened.manifest.paper.id);
});

test("arxiv-import 显式 PDF 回退：确认前无 PDF 请求，交接固定版本与原因，快照与 current 不变", async () => {
  const routes = fullRoutes();
  delete routes[HTML_URL];
  const { calls, transport } = controlledTransport(routes);
  const failed = await importArxivPaper({ parent: sandbox, name: "回退现场", input: "2401.01234", transport, baseUrl: BASE });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(calls.some((url) => url.includes("/pdf/"))).toBe(false);
  const before = await openProject(failed.root);

  // 用户显式确认后才生成交接请求；生成本身不发起任何网络请求。
  const callsBefore = calls.length;
  const handoff = prepareArxivPdfFallback(before, failed.diagnostic, BASE);
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) return;
  expect(handoff.request).toMatchObject({
    kind: "arxiv-pdf",
    baseId: "2401.01234",
    version: 1,
    absUrl: ABS_URL,
    pdfUrl: `${BASE}/pdf/2401.01234v1`,
    reasonCode: failed.diagnostic.code,
    baseRevision: null,
  });
  expect(calls.length).toBe(callsBefore);
  const after = await openProject(failed.root);
  expect(after.manifest.paper.currentRevision).toBeNull();
  expect(after.manifest.paper.id).toBe(before.manifest.paper.id);
});

test("arxiv-import 回退拒绝条件：版本未固定或 current 已存在时不产生交接", async () => {
  const created = await createProject({ parent: sandbox, name: "无版本记录" });
  const opened = await openProject(created.root);
  const unresolved = prepareArxivPdfFallback(opened, {
    code: "arxiv-abs-fetch-failed",
    severity: "fatal",
    stage: "resolve",
    messageKey: "arxiv.abs.fetchFailed",
  });
  expect(unresolved.ok).toBe(false);

  const { transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name: "已可读", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const readable = await openProject(imported.root);
  const blocked = prepareArxivPdfFallback(readable, imported.warnings[0] ?? {
    code: "arxiv-convert-reference-unresolved",
    severity: "warning",
    stage: "convert",
    messageKey: "arxiv.convert.referenceUnresolved",
  });
  expect(blocked.ok).toBe(false);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
});

test("arxiv-import 离线重开：完整正文来自 current revision，不发起任何网络请求", async () => {
  const { calls, transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name: "离线重开", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const callsAfterImport = calls.length;

  const reopened = await openProject(imported.root);
  const revisionId = reopened.manifest.paper.currentRevision!;
  const tree = await readRevisionDocument(imported.root, revisionId, "document");
  const texts = Object.values(tree.units).flatMap((unit) =>
    unit.sentenceIds.flatMap((id) => tree.sentences[id].content.map((part) => (part.kind === "text" ? part.text : ""))),
  );
  expect(texts.some((text) => text.includes("We study energy and mass."))).toBe(true);
  expect(calls.length).toBe(callsAfterImport);
});

test("arxiv-import 已完成工程恢复为幂等：不重复快照或 revision", async () => {
  const { transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name: "幂等恢复", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const resumed = await resumeArxivImport({ root: imported.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.revision.revisionId).toBe(imported.revision.revisionId);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(1);
});

test("arxiv-import 转换中崩溃：候选不发布，恢复重新转换后 current 可读", async () => {
  const { transport } = controlledTransport(fullRoutes());
  const hooks: ArxivImportProgressHooks = {
    onConvertPoint(point) {
      if (point === "before-publish") throw new Error("injected convert crash");
    },
  };
  const failed = await importArxivPaper({ parent: sandbox, name: "转换中断", input: "2401.01234", transport, baseUrl: BASE, hooks });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.diagnostic.stage).toBe("convert");
  const opened = await openProject(failed.root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "snapshot" });

  const resumed = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect((await openProject(failed.root)).manifest.paper.currentRevision).toBe(resumed.revision.revisionId);
});