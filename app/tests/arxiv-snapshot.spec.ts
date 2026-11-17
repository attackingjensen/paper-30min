import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createProject, openProject, readSourceSnapshot, readSourceSnapshotAsset } from "../src/main/project-core";
import { parseArxivReference } from "../src/main/arxiv/reference";
import { fetchArxivSnapshot } from "../src/main/arxiv/snapshot";
import type { ArxivFetchOptions, ArxivFetchResponse, ArxivTransport } from "../src/main/arxiv/fetch";
import { ArxivFetchError } from "../src/main/arxiv/fetch";
import { absHtml } from "./fixtures/arxiv-abs";

const BASE = "http://127.0.0.1:9999";
const ABS_URL = `${BASE}/abs/2401.01234v1`;
const HTML_URL = `${BASE}/html/2401.01234v1`;
const FIG1_URL = `${BASE}/html/figures/fig1.png`;
const FIG2_URL = `${BASE}/html/figures/fig2.png`;

const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

function latexmlHtml(images: string[]): string {
  return `<!DOCTYPE html>
<html><head><title>Fixture Paper</title>
<meta name="citation_arxiv_id" content="2401.01234v1" />
</head><body>
<article class="ltx_document">
<h1 class="ltx_title">Fixture Paper</h1>
<section class="ltx_section"><p class="ltx_p">Body text.</p>
${images.map((src) => `<figure class="ltx_figure"><img src="${src}" alt="fig" /></figure>`).join("\n")}
</section>
</article>
</body></html>`;
}

interface FakeRoute {
  status?: number;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  finalUrl?: string;
  error?: ArxivFetchError;
}

function fakeTransport(routes: Record<string, FakeRoute>) {
  const calls: string[] = [];
  const transport: ArxivTransport = async (url, options: ArxivFetchOptions) => {
    calls.push(url);
    if (options.signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", url);
    const route = routes[url];
    if (!route) throw new ArxivFetchError("arxiv-fetch-status", url, 404);
    if (route.error) throw route.error;
    const bytes = route.bytes ?? Buffer.from("");
    if (bytes.byteLength > options.budgetBytes)
      throw new ArxivFetchError("arxiv-fetch-budget", url);
    const response: ArxivFetchResponse = {
      status: route.status ?? 200,
      url: route.finalUrl ?? url,
      redirectChain: [url, route.finalUrl ?? url],
      headers: { "content-type": "text/html", ...route.headers },
      bytes,
    };
    return response;
  };
  return { transport, calls };
}

function defaultRoutes(): Record<string, FakeRoute> {
  return {
    [ABS_URL]: { bytes: Buffer.from(absHtml({ id: "2401.01234", versions: [1] })) },
    [HTML_URL]: {
      bytes: Buffer.from(latexmlHtml(["figures/fig1.png", "figures/fig2.png"])),
      headers: { "content-type": "text/html; charset=utf-8", etag: '"html-1"' },
    },
    [FIG1_URL]: { bytes: PNG1, headers: { "content-type": "image/png" } },
    [FIG2_URL]: { bytes: PNG2, headers: { "content-type": "image/png" } },
  };
}

function pinned(input = "2401.01234v1") {
  const result = parseArxivReference(input);
  if (!result.ok) throw new Error("fixture reference rejected");
  return result.reference;
}

let sandbox: string;
let root: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-arxiv-snapshot-"));
  const created = await createProject({ parent: sandbox, name: "arxiv 工程" });
  root = created.root;
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("arxiv-import 快照发布：abs/HTML/资产原始字节、来源事实与资产 URL 映射完整", async () => {
  const { transport, calls } = fakeTransport(defaultRoutes());
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.reused).toBe(false);
  expect(result.bodyReadable).toBe(false);
  expect(result.warnings).toEqual([]);

  const snapshot = result.snapshot;
  expect(snapshot.baseId).toBe("2401.01234");
  expect(snapshot.version).toBe(1);
  expect(snapshot.canonicalId).toBe("2401.01234v1");
  expect(snapshot.absUrl).toBe(ABS_URL);
  expect(snapshot.htmlUrl).toBe(HTML_URL);
  expect(snapshot.title).toBe("Fixture Paper");
  expect(snapshot.kind).toBe("arxiv");

  const paths = snapshot.files.map((file) => file.path).sort();
  expect(paths).toEqual([
    "abs.html",
    `assets/${createHash("sha256").update(PNG1).digest("hex")}.png`,
    `assets/${createHash("sha256").update(PNG2).digest("hex")}.png`,
    "document.html",
  ]);
  for (const file of snapshot.files) {
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.size).toBeGreaterThan(0);
  }
  const assets = snapshot.assets as Record<string, { originalUrl: string; path: string }>;
  expect(Object.values(assets).map((a) => a.originalUrl).sort()).toEqual([FIG1_URL, FIG2_URL]);

  // 先 abs 后 HTML；资产相对固定版本 HTML URL 解析。
  expect(calls.slice(0, 2)).toEqual([ABS_URL, HTML_URL]);
  expect(calls.slice(2).sort()).toEqual([FIG1_URL, FIG2_URL]);

  // 快照可校验：abs 原始字节按登记摘要复核；资产走受管读取。
  const absRecord = snapshot.files.find((file) => file.path === "abs.html")!;
  const absBytes = await fs.readFile(path.join(root, snapshot.path, "abs.html"));
  expect(createHash("sha256").update(absBytes).digest("hex")).toBe(absRecord.sha256);
  expect(absBytes.toString("utf8")).toContain("citation_arxiv_id");
  const fig = await readSourceSnapshotAsset(
    root,
    snapshot.sourceSnapshotId,
    `assets/${createHash("sha256").update(PNG1).digest("hex")}.png`,
  );
  expect(Buffer.from(fig.bytes)).toEqual(PNG1);

  // 快照存在不代表正文可读：current 仍为空。
  const opened = await openProject(root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
});

test("arxiv-import 快照不可变：发布后目录内容摘要可复核，重复发布同字节复用既有快照", async () => {
  const first = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(defaultRoutes()).transport });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const second = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(defaultRoutes()).transport });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.reused).toBe(true);
  expect(second.snapshot.sourceSnapshotId).toBe(first.snapshot.sourceSnapshotId);
  const sources = await fs.readdir(path.join(root, "sources"));
  expect(sources).toHaveLength(1);
  const reread = await readSourceSnapshot(root, first.snapshot.sourceSnapshotId);
  expect(reread.files).toEqual(first.snapshot.files);
});

test("arxiv-import 同版重取得到不同字节时建立新快照，不覆盖旧快照", async () => {
  const first = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(defaultRoutes()).transport });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const changed = defaultRoutes();
  changed[HTML_URL] = {
    bytes: Buffer.from(latexmlHtml(["figures/fig1.png"]).replace("Body text.", "Revised body.")),
    headers: { "content-type": "text/html" },
  };
  const second = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(changed).transport });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.reused).toBe(false);
  expect(second.snapshot.sourceSnapshotId).not.toBe(first.snapshot.sourceSnapshotId);
  const sources = await fs.readdir(path.join(root, "sources"));
  expect(sources).toHaveLength(2);
  // 旧快照仍然完整可校验。
  await expect(readSourceSnapshot(root, first.snapshot.sourceSnapshotId)).resolves.toBeTruthy();
});

test("arxiv-import 版本混杂：HTML 最终 URL 指向其他版本时拒绝发布", async () => {
  const routes = defaultRoutes();
  routes[HTML_URL] = { ...routes[HTML_URL], finalUrl: `${BASE}/html/2401.01234v2` };
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(routes).transport });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.code).toBe("arxiv-version-mixed");
  await expect(fs.readdir(path.join(root, "sources"))).rejects.toThrow();
});

test("arxiv-import HTML 元数据版本与固定版本不一致时拒绝发布", async () => {
  const routes = defaultRoutes();
  routes[HTML_URL] = {
    bytes: Buffer.from(latexmlHtml([]).replace('content="2401.01234v1"', 'content="2401.01234v2"')),
    headers: { "content-type": "text/html" },
  };
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(routes).transport });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.code).toBe("arxiv-version-mixed");
});

test("arxiv-import abs 页面冒充 full-text HTML 时拒绝发布", async () => {
  const routes = defaultRoutes();
  routes[HTML_URL] = {
    bytes: Buffer.from(absHtml({ id: "2401.01234", versions: [1] })),
    headers: { "content-type": "text/html" },
  };
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(routes).transport });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.code).toBe("arxiv-html-not-fulltext");
  await expect(fs.readdir(path.join(root, "sources"))).rejects.toThrow();
});

test("arxiv-import HTML 404 与网络失败区分诊断，不发布快照", async () => {
  const routes = defaultRoutes();
  delete routes[HTML_URL];
  const missing = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(routes).transport });
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.diagnostic.code).toBe("arxiv-html-fetch-failed");
    expect(missing.diagnostic.messageKey).toBe("arxiv.html.notFound");
  }
  const broken = defaultRoutes();
  broken[HTML_URL] = { error: new ArxivFetchError("arxiv-fetch-network", HTML_URL) };
  const failed = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(broken).transport });
  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.diagnostic.code).toBe("arxiv-html-fetch-failed");
    expect(failed.diagnostic.messageKey).toBe("arxiv.html.network");
  }
});

test("arxiv-import 外部图片不抓取，记录 warning 并照常发布快照", async () => {
  const routes = defaultRoutes();
  routes[HTML_URL] = {
    bytes: Buffer.from(latexmlHtml(["figures/fig1.png", "https://cdn.example.com/external.png"])),
    headers: { "content-type": "text/html" },
  };
  const { transport, calls } = fakeTransport(routes);
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(calls).not.toContain("https://cdn.example.com/external.png");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0].code).toBe("arxiv-asset-external-blocked");
  expect(result.warnings[0].severity).toBe("warning");
  expect(result.warnings[0].sourceUrl).toBe("https://cdn.example.com/external.png");
  expect(result.snapshot.files.filter((f) => f.path.startsWith("assets/"))).toHaveLength(1);
});

test("arxiv-import 单个非核心资产失败记录 warning，快照仍可发布", async () => {
  const routes = defaultRoutes();
  delete routes[FIG2_URL];
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned(), transport: fakeTransport(routes).transport });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0].code).toBe("arxiv-asset-fetch-failed");
  expect(result.warnings[0].sourceUrl).toBe(FIG2_URL);
  expect(result.snapshot.files.filter((f) => f.path.startsWith("assets/"))).toHaveLength(1);
});

test("arxiv-import 资产合计超预算即中止，不截断后发布", async () => {
  const routes = defaultRoutes();
  const result = await fetchArxivSnapshot({
    root,
    baseUrl: BASE,
    reference: pinned(),
    transport: fakeTransport(routes).transport,
    totalAssetBudgetBytes: PNG1.byteLength, // 第二张图必然超限
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.code).toBe("arxiv-budget-exceeded");
  await expect(fs.readdir(path.join(root, "sources"))).rejects.toThrow();
});

test("arxiv-import 未固定版本的引用在网络与工程写入前拒绝", async () => {
  const { transport, calls } = fakeTransport(defaultRoutes());
  const result = await fetchArxivSnapshot({ root, baseUrl: BASE, reference: pinned("2401.01234"), transport });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-version-unpinned");
  expect(calls).toEqual([]);
});

test("arxiv-import 用户取消保留工程与现场，不发布快照", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await fetchArxivSnapshot({
    root,
    baseUrl: BASE,
    reference: pinned(),
    transport: fakeTransport(defaultRoutes()).transport,
    signal: controller.signal,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-fetch-cancelled");
  await expect(fs.readdir(path.join(root, "sources"))).rejects.toThrow();
  const opened = await openProject(root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
});
