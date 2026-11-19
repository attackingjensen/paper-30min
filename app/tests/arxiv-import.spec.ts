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
import type { ImportDiagnostic } from "../src/shared/arxiv";
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

test("arxiv-import current 推进中断：候选保留，恢复沿用同一 revisionId 完成发布", async () => {
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
  // 中断前候选已完整发布：恢复记录持久化其 revisionId，磁盘只有一份 revision。
  const candidateId = opened.importRecord?.arxiv?.candidateRevisionId;
  expect(candidateId).toBeTruthy();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "convert" });
  const revisionsBefore = await fs.readdir(path.join(failed.root, "paper", "revisions"));
  expect(revisionsBefore).toEqual([candidateId]);

  const resumed = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.revision.revisionId).toBe(candidateId);
  const after = await openProject(failed.root);
  expect(after.manifest.paper.currentRevision).toBe(candidateId);
  expect(after.manifest.paper.id).toBe(opened.manifest.paper.id);
  // 恢复只补做 current 推进，不新建 revision。
  expect(await fs.readdir(path.join(failed.root, "paper", "revisions"))).toEqual([candidateId]);
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
  const handoff = await prepareArxivPdfFallback(before, failed.diagnostic, BASE);
  expect(handoff.ok).toBe(true);
  if (!handoff.ok) return;
  expect(handoff.request).toMatchObject({
    kind: "arxiv-pdf",
    baseId: "2401.01234",
    version: 1,
    reasonCode: failed.diagnostic.code,
    baseRevision: null,
  });
  // 交接不再携带 URL：下载目标由主进程按固定版本重建。
  expect(handoff.request).not.toHaveProperty("absUrl");
  expect(handoff.request).not.toHaveProperty("pdfUrl");
  expect(calls.length).toBe(callsBefore);
  const after = await openProject(failed.root);
  expect(after.manifest.paper.currentRevision).toBeNull();
  expect(after.manifest.paper.id).toBe(before.manifest.paper.id);
});

test("arxiv-import 回退边界：版本未固定拒绝；更新场景携带 baseRevision，stale base 拒绝", async () => {
  const created = await createProject({ parent: sandbox, name: "无版本记录" });
  const opened = await openProject(created.root);
  const reason: ImportDiagnostic = {
    code: "arxiv-html-fetch-failed",
    severity: "fatal",
    stage: "fetch",
    messageKey: "arxiv.html.notFound",
  };
  const unresolved = await prepareArxivPdfFallback(opened, reason);
  expect(unresolved.ok).toBe(false);

  const { transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name: "已可读", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const readable = await openProject(imported.root);

  // 更新场景（SPEC §7.4）：交接用户当前读取的 revision，身份来自 current 的 arXiv 快照。
  const update = await prepareArxivPdfFallback(readable, reason, BASE, imported.revision.revisionId);
  expect(update.ok).toBe(true);
  if (!update.ok) return;
  expect(update.request).toMatchObject({
    kind: "arxiv-pdf",
    baseId: "2401.01234",
    version: 1,
    baseRevision: imported.revision.revisionId,
  });

  // stale base：调用方读取后 current 已变化（或从未匹配）时拒绝。
  const stale = await prepareArxivPdfFallback(readable, reason, BASE, "00000000-0000-4000-8000-011111100000");
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.diagnostic.code).toBe("arxiv-fallback-base-mismatch");
  // current 已存在却不携带 baseRevision 同样拒绝，不静默按首次导入处理。
  const missing = await prepareArxivPdfFallback(readable, reason, BASE);
  expect(missing.ok).toBe(false);
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

test("arxiv-import 转换中崩溃：候选未落盘，恢复沿用已记录候选身份完成发布", async () => {
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
  // 候选身份已记录但 revision 未落盘：恢复重新转换并沿用同一 revisionId。
  const candidateId = opened.importRecord?.arxiv?.candidateRevisionId;
  expect(candidateId).toBeTruthy();
  expect(opened.importRecord?.arxiv).toMatchObject({ stage: "convert" });
  await expect(fs.readdir(path.join(failed.root, "paper", "revisions"))).rejects.toThrow();

  const resumed = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.revision.revisionId).toBe(candidateId);
  expect((await openProject(failed.root)).manifest.paper.currentRevision).toBe(candidateId);
});

test("arxiv-import revision-content 中断：残留候选被清除，恢复沿用同一身份完成发布", async () => {
  const { transport } = controlledTransport(fullRoutes());
  const hooks: ArxivImportProgressHooks = {
    onCommitPoint(point) {
      if (point === "revision-content") throw new Error("injected content failure");
    },
  };
  const failed = await importArxivPaper({ parent: sandbox, name: "内容中断", input: "2401.01234", transport, baseUrl: BASE, hooks });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  const opened = await openProject(failed.root);
  const candidateId = opened.importRecord?.arxiv?.candidateRevisionId;
  expect(candidateId).toBeTruthy();
  // 内容目录已 rename 但元数据未写：残留候选存在。
  await expect(fs.access(path.join(failed.root, "paper", "revisions", candidateId!))).resolves.toBeUndefined();
  await expect(fs.access(path.join(failed.root, ".paper30min", "revisions", candidateId!, "revision.json"))).rejects.toThrow();

  const resumed = await resumeArxivImport({ root: failed.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.revision.revisionId).toBe(candidateId);
  const after = await openProject(failed.root);
  expect(after.manifest.paper.currentRevision).toBe(candidateId);
  expect(await fs.readdir(path.join(failed.root, "paper", "revisions"))).toEqual([candidateId]);
});

test("arxiv-import 回退 stale base：读取后 current 实际推进，旧 base 请求被拒绝", async () => {
  const { transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name: "stale现场", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const openedAtA = await openProject(imported.root);
  const revisionA = imported.revision.revisionId;

  // 通过 coreMergePublish 的底层 commitRevision 推进 current 到 B（模拟另一动作）。
  const { commitRevision } = await import("../src/main/project-core");
  const { testDocumentTree } = await import("./fixtures/document-tree");
  const treeB = testDocumentTree(imported.revision.paperId, "第二版");
  const sourceB = await publishSourceForTest(imported.root);
  const revisionB = await commitRevision({
    root: imported.root,
    baseRevision: revisionA,
    sourceSnapshotId: sourceB,
    files: {
      "document.json": Buffer.from(JSON.stringify(treeB)),
      "source-base.json": Buffer.from(JSON.stringify(treeB)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: revisionA })),
    },
  });
  expect(revisionB.revisionId).not.toBe(revisionA);

  const reason: ImportDiagnostic = {
    code: "arxiv-html-fetch-failed", severity: "fatal", stage: "fetch", messageKey: "arxiv.html.notFound",
  };
  // 调用方仍持有 A 时刻的 opened 与 baseRevision=A：必须按最新 current=B 拒绝。
  const stale = await prepareArxivPdfFallback(openedAtA, reason, BASE, revisionA);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.diagnostic.code).toBe("arxiv-fallback-base-mismatch");
  // 携带最新 current=B 则允许（身份仍来自 arXiv 快照链）。
  const fresh = await prepareArxivPdfFallback(openedAtA, reason, BASE, revisionB.revisionId);
  expect(fresh.ok).toBe(true);
});

async function publishSourceForTest(root: string): Promise<string> {
  const { publishSourceSnapshot } = await import("../src/main/project-core");
  const snapshot = await publishSourceSnapshot({
    root,
    files: { "document.html": Buffer.from("<html>second</html>") },
    metadata: { kind: "arxiv", baseId: "2401.01234", version: 1, canonicalId: "2401.01234v1" },
  });
  return snapshot.sourceSnapshotId;
}

test("arxiv-import 重开恢复返回持久化的警告与转换器版本", async () => {
  const routes = fullRoutes();
  routes[HTML_URL] = {
    bytes: Buffer.from(latexmlDocument().replace(`src="${FIG2_SRC}"`, `src="https://cdn.example.org/external.png"`)),
    mime: "text/html",
  };
  const { transport } = controlledTransport(routes);
  const imported = await importArxivPaper({ parent: sandbox, name: "警告持久化", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  expect(imported.warnings.length).toBeGreaterThan(0);

  const resumed = await resumeArxivImport({ root: imported.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  // 恢复从受管记录读取原警告，不返回空数组冒充零问题。
  expect(resumed.warnings.some((w) => w.code === "arxiv-asset-external-blocked")).toBe(true);
  expect(resumed.warnings.some((w) => w.code === "arxiv-convert-asset-missing")).toBe(true);
  const meta = resumed.revision.arxiv;
  expect(meta).toBeDefined();
  if (meta !== null && typeof meta === "object" && "converterVersion" in meta)
    expect(meta.converterVersion).toBe(1);
});

test("arxiv-import completePublished 恢复返回持久化转换器版本，缺失时明确失败", async () => {
  const { convertArxivSnapshot } = await import("../src/main/arxiv/convert");
  const { commitRevision, publishSourceSnapshot } = await import("../src/main/project-core");
  const { testDocumentTree } = await import("./fixtures/document-tree");
  const { randomUUID } = await import("node:crypto");

  async function candidateWithoutCurrent(name: string, arxivMeta: Record<string, unknown>) {
    const created = await createProject({ parent: sandbox, name });
    const source = await publishSourceSnapshot({
      root: created.root,
      files: { "document.html": Buffer.from("<html>paper</html>") },
      metadata: { kind: "arxiv", baseId: "2401.01234", version: 1, canonicalId: "2401.01234v1" },
    });
    const tree = testDocumentTree(created.manifest.paper.id, "候选");
    const revisionId = randomUUID();
    await commitRevision({
      root: created.root,
      baseRevision: null,
      sourceSnapshotId: source.sourceSnapshotId,
      revisionId,
      files: {
        "document.json": Buffer.from(JSON.stringify(tree)),
        "source-base.json": Buffer.from(JSON.stringify(tree)),
        "tombstones.json": Buffer.from("[]"),
        "changeset.json": Buffer.from(JSON.stringify({ baseRevision: null })),
      },
      metadata: { arxiv: arxivMeta },
    }, {
      onCommitPoint(point) {
        if (point === "before-current-replace") throw new Error("injected current failure");
      },
    }).catch(() => undefined);
    return { root: created.root, sourceSnapshotId: source.sourceSnapshotId, revisionId };
  }

  const withVersion = await candidateWithoutCurrent("版本候选", { converterVersion: 7, warnings: [] });
  const result = await convertArxivSnapshot({
    root: withVersion.root,
    sourceSnapshotId: withVersion.sourceSnapshotId,
    revisionId: withVersion.revisionId,
    completePublished: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // 返回候选持久化的版本 7，而不是当前转换器版本。
  expect(result.converterVersion).toBe(7);

  const missingVersion = await candidateWithoutCurrent("版本缺失", { warnings: [] });
  const missing = await convertArxivSnapshot({
    root: missingVersion.root,
    sourceSnapshotId: missingVersion.sourceSnapshotId,
    revisionId: missingVersion.revisionId,
    completePublished: true,
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.diagnostic.code).toBe("arxiv-convert-version-missing");
  // 校验失败时 current 必须仍为空：不产生"返回失败但已推进"的矛盾状态。
  expect((await openProject(missingVersion.root)).manifest.paper.currentRevision).toBeNull();
  // 未修复元数据前重试不会转为成功。
  const retry = await convertArxivSnapshot({
    root: missingVersion.root,
    sourceSnapshotId: missingVersion.sourceSnapshotId,
    revisionId: missingVersion.revisionId,
    completePublished: true,
  });
  expect(retry.ok).toBe(false);
  expect((await openProject(missingVersion.root)).manifest.paper.currentRevision).toBeNull();

  // warnings 损坏同样在 current 推进前拒绝。
  const corruptWarnings = await candidateWithoutCurrent("警告损坏候选", { converterVersion: 1, warnings: [{ code: 123 }] });
  const corrupt = await convertArxivSnapshot({
    root: corruptWarnings.root,
    sourceSnapshotId: corruptWarnings.sourceSnapshotId,
    revisionId: corruptWarnings.revisionId,
    completePublished: true,
  });
  expect(corrupt.ok).toBe(false);
  if (!corrupt.ok) expect(corrupt.diagnostic.code).toBe("arxiv-import-record-corrupt");
  expect((await openProject(corruptWarnings.root)).manifest.paper.currentRevision).toBeNull();
});

test("arxiv-import 无关提交故障即使消息含校验文本也返回 publish-failed，不冒充元数据失败", async () => {
  const { convertArxivSnapshot } = await import("../src/main/arxiv/convert");
  const { commitRevision, publishSourceSnapshot } = await import("../src/main/project-core");
  const { testDocumentTree } = await import("./fixtures/document-tree");
  const { randomUUID } = await import("node:crypto");
  const created = await createProject({ parent: sandbox, name: "无关故障" });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
    metadata: { kind: "arxiv", baseId: "2401.01234", version: 1, canonicalId: "2401.01234v1" },
  });
  const tree = testDocumentTree(created.manifest.paper.id, "候选");
  const revisionId = randomUUID();
  await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    revisionId,
    files: {
      "document.json": Buffer.from(JSON.stringify(tree)),
      "source-base.json": Buffer.from(JSON.stringify(tree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: null })),
    },
    metadata: { arxiv: { converterVersion: 1, warnings: [] } },
  }, {
    onCommitPoint(point) {
      if (point === "before-current-replace") throw new Error("injected current failure");
    },
  }).catch(() => undefined);

  const result = await convertArxivSnapshot({
    root: created.root,
    sourceSnapshotId: source.sourceSnapshotId,
    revisionId,
    completePublished: true,
    hooks: {
      commitHooks: {
        onCommitPoint(point) {
          // 合法元数据，但提交钩子抛出含校验文本的无关错误。
          if (point === "before-current-replace")
            throw new Error("disk error near arxiv-convert-version-missing 诊断数组损坏");
        },
      },
    },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-convert-publish-failed");
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBeNull();
});

test("arxiv-import 受管警告损坏时恢复明确失败，不静默清空警告", async () => {
  const { transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name: "警告损坏", input: "2401.01234", transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  // 篡改 revision 元数据中的 warnings 为畸形数组。
  const metaFile = path.join(imported.root, ".paper30min", "revisions", imported.revision.revisionId, "revision.json");
  const record = JSON.parse(await fs.readFile(metaFile, "utf8"));
  record.arxiv.warnings = [{ code: 123 }];
  await fs.writeFile(metaFile, JSON.stringify(record));

  const resumed = await resumeArxivImport({ root: imported.root, transport, baseUrl: BASE });
  expect(resumed.ok).toBe(false);
  if (resumed.ok) return;
  expect(resumed.diagnostic.code).toBe("arxiv-import-record-corrupt");
});

test("arxiv-import 进度写入持续失败时返回结构化诊断，不穿透异常", async () => {
  const { transport } = controlledTransport(fullRoutes());
  // 快照内容写入后破坏导入记录文件，使后续所有进度写入持续失败。
  const hooks: ArxivImportProgressHooks = {
    async onCommitPoint(point) {
      if (point === "source-content") {
        const recordFile = path.join(sandbox, "进度故障", ".paper30min", "imports", "initial.json");
        await fs.rm(recordFile, { force: true });
        await fs.mkdir(recordFile); // 目录占据文件路径 → 读取/写入失败
      }
    },
  };
  const failed = await importArxivPaper({ parent: sandbox, name: "进度故障", input: "2401.01234", transport, baseUrl: BASE, hooks });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  // 快照后进度写入失败：结构化诊断而非原始异常穿透。
  expect(failed.diagnostic.code).toBe("arxiv-import-progress-failed");
  expect(failed.diagnostic.stage).toBe("snapshot");
  // 工程与快照现场保留，current 未推进。
  const manifest = JSON.parse(await fs.readFile(path.join(failed.root, "paper30min.json"), "utf8"));
  expect(manifest.paper.currentRevision).toBeNull();
  expect(await fs.readdir(path.join(failed.root, "sources"))).toHaveLength(1);
});