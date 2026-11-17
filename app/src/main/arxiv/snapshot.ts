import { createHash } from "node:crypto";
import type { ArxivReference, ImportDiagnostic } from "../../shared/arxiv.js";
import type { ManagedFileContent } from "../../shared/contracts.js";
import { listSourceSnapshots, publishSourceSnapshot, type ProjectCommitHooks } from "../project-core.js";
import { assertArxivVersionConsistent } from "./version.js";
import { ArxivFetchError, type ArxivFetchResponse, type FetchArxivSnapshotInput, type ArxivSnapshotResult, type ArxivAssetMapping, type ArxivSourceMetadata } from "./fetch.js";

const ABS_BUDGET_BYTES = 8 * 1024 * 1024;
const HTML_BUDGET_BYTES = 128 * 1024 * 1024;
const DEFAULT_ASSET_BUDGET_BYTES = 32 * 1024 * 1024;
const DEFAULT_TOTAL_ASSET_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_ASSET_CONCURRENCY = 4;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fatal(code: string, messageKey: string, stage: ImportDiagnostic["stage"], sourceUrl?: string): ArxivSnapshotResult {
  return { ok: false, diagnostic: { code, severity: "fatal", stage, messageKey, ...(sourceUrl === undefined ? {} : { sourceUrl }) } };
}

function warning(code: string, messageKey: string, sourceUrl: string): ImportDiagnostic {
  return { code, severity: "warning", stage: "fetch", messageKey, sourceUrl };
}

/** 把受控 transport 的分类失败映射为稳定诊断；不互相冒充。 */
function fetchDiagnostic(error: unknown, url: string, kind: "abs" | "html"): ImportDiagnostic {
  const stage = "fetch";
  if (error instanceof ArxivFetchError) {
    const prefix = kind === "abs" ? "arxiv-abs" : "arxiv-html";
    const keyBase = kind === "abs" ? "arxiv.abs" : "arxiv.html";
    switch (error.code) {
      case "arxiv-fetch-cancelled":
        return { code: error.code, severity: "fatal", stage, messageKey: "arxiv.fetch.cancelled", sourceUrl: url };
      case "arxiv-fetch-budget":
        return { code: "arxiv-budget-exceeded", severity: "fatal", stage, messageKey: "arxiv.fetch.budget", sourceUrl: url };
      case "arxiv-fetch-tls":
        return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.tls`, sourceUrl: url };
      case "arxiv-fetch-stalled":
        return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.stalled`, sourceUrl: url };
      case "arxiv-fetch-status":
        if (error.status === 404)
          return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.notFound`, sourceUrl: url };
        if (error.status === 403)
          return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.forbidden`, sourceUrl: url };
        if (error.status === 429)
          return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.rateLimited`, sourceUrl: url };
        return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.http`, sourceUrl: url };
      default:
        return { code: `${prefix}-fetch-failed`, severity: "fatal", stage, messageKey: `${keyBase}.network`, sourceUrl: url };
    }
  }
  return { code: `${kind === "abs" ? "arxiv-abs" : "arxiv-html"}-fetch-failed`, severity: "fatal", stage, messageKey: kind === "abs" ? "arxiv.abs.network" : "arxiv.html.network", sourceUrl: url };
}

function metaContent(html: string, name: string): string | null {
  const pattern = new RegExp(`<meta\\b[^>]*\\bname=["']${name}["'][^>]*>`, "i");
  const tag = pattern.exec(html);
  if (!tag) return null;
  const content = /\bcontent=["']([^"']*)["']/i.exec(tag[0]);
  return content ? content[1] : null;
}

function allMetaContents(html: string, name: string): string[] {
  const pattern = new RegExp(`<meta\\b[^>]*\\bname=["']${name}["'][^>]*>`, "gi");
  const values: string[] = [];
  for (const tag of html.matchAll(pattern)) {
    const content = /\bcontent=["']([^"']*)["']/i.exec(tag[0]);
    if (content) values.push(content[1]);
  }
  return values;
}

function absTitle(html: string): string | null {
  const citation = metaContent(html, "citation_title");
  if (citation) return citation;
  const match = /<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : null;
}

function absVersionDate(html: string, version: number): string | null {
  const pattern = new RegExp(
    `<a\\b[^>]*\\bhref=["'][^"']*v${version}["'][^>]*>\\s*\\[v${version}\\]\\s*</a>([\\s\\S]*?)(?=<a\\b|<b>|$)`,
    "i",
  );
  const match = pattern.exec(html);
  if (!match) return null;
  const date = /\b(\d{1,2}\s+\w+\s+\d{4})\b/.exec(match[1]);
  return date ? date[1] : null;
}

function licenseUrl(html: string): string | null {
  const match = /<a\b[^>]*\bhref=["']([^"']*license[^"']*)["']/i.exec(html);
  return match ? match[1] : null;
}

/** 基本 LaTeXML full-text 容器校验：摘要页、错误页不得冒充正文。 */
function isFulltextHtml(html: string): boolean {
  return /<(?:article|div|body)\b[^>]*\bltx_document\b/i.test(html) ||
    /<article\b[^>]*class=["'][^"']*ltx_document/i.test(html);
}

function imageSources(html: string): string[] {
  const sources: string[] = [];
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag[0]);
    if (src) sources.push(src[1]);
  }
  return [...new Set(sources)];
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "application/pdf": "pdf",
};

function assetExtension(url: URL, mime: string | undefined): string {
  const fromMime = mime ? MIME_EXTENSIONS[mime.split(";")[0].trim().toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  const last = url.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot > 0) {
    const ext = last.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return "bin";
}

function responseFacts(response: ArxivFetchResponse) {
  return {
    ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }),
    ...(response.headers["last-modified"] === undefined ? {} : { lastModified: response.headers["last-modified"] }),
    ...(response.headers["content-type"] === undefined ? {} : { contentType: response.headers["content-type"] }),
    redirectChain: response.redirectChain,
  };
}

/**
 * 获取并发布不可变来源快照（SPEC §2–3）：
 * 先 abs 核验固定版本与元数据，再取对应版本 HTML 与资产；
 * 身份、版本、响应类型与 LaTeXML 容器可验证才经 project-core 发布；
 * 同字节复用已验证快照，不同字节建立新快照；快照存在不代表正文可读。
 */
export async function fetchArxivSnapshot(input: FetchArxivSnapshotInput): Promise<ArxivSnapshotResult> {
  const { root, reference, transport, signal } = input;
  if (reference.version === null || !Number.isInteger(reference.version) || reference.version < 1)
    return fatal("arxiv-version-unpinned", "arxiv.version.unpinned", "resolve");
  const pinned = { ...reference, version: reference.version };
  const endpointBase = (input.baseUrl ?? "https://arxiv.org").replace(/\/+$/, "");
  const absUrl = `${endpointBase}/abs/${pinned.canonicalId}`;
  const htmlUrl = `${endpointBase}/html/${pinned.canonicalId}`;
  const assetBudget = input.assetBudgetBytes ?? DEFAULT_ASSET_BUDGET_BYTES;
  const totalBudget = input.totalAssetBudgetBytes ?? DEFAULT_TOTAL_ASSET_BUDGET_BYTES;
  const concurrency = Math.max(1, input.assetConcurrency ?? DEFAULT_ASSET_CONCURRENCY);
  if (signal?.aborted)
    return { ok: false, diagnostic: fetchDiagnostic(new ArxivFetchError("arxiv-fetch-cancelled", absUrl), absUrl, "abs") };

  let absResponse: ArxivFetchResponse;
  try {
    absResponse = await transport(absUrl, { budgetBytes: ABS_BUDGET_BYTES, signal });
  } catch (error) {
    return { ok: false, diagnostic: fetchDiagnostic(error, absUrl, "abs") };
  }
  const absGuard = assertArxivVersionConsistent(pinned, absResponse.url, {
    citationId: metaContent(Buffer.from(absResponse.bytes).toString("utf8"), "citation_arxiv_id") ?? undefined,
  });
  if (!absGuard.ok) return absGuard;
  const absText = Buffer.from(absResponse.bytes).toString("utf8");

  let htmlResponse: ArxivFetchResponse;
  try {
    htmlResponse = await transport(htmlUrl, { budgetBytes: HTML_BUDGET_BYTES, signal });
  } catch (error) {
    return { ok: false, diagnostic: fetchDiagnostic(error, htmlUrl, "html") };
  }
  const htmlText = Buffer.from(htmlResponse.bytes).toString("utf8");
  const htmlGuard = assertArxivVersionConsistent(pinned, htmlResponse.url, {
    citationId: metaContent(htmlText, "citation_arxiv_id") ?? undefined,
  });
  if (!htmlGuard.ok) return htmlGuard;
  if ((htmlResponse.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "text/html")
    return fatal("arxiv-html-not-html", "arxiv.html.notHtml", "fetch", htmlResponse.url);
  if (!isFulltextHtml(htmlText))
    return fatal("arxiv-html-not-fulltext", "arxiv.html.notFulltext", "fetch", htmlResponse.url);

  // 资产相对实际固定版本 HTML 的最终 URL 解析。
  const baseUrl = new URL(htmlResponse.url);
  const warnings: ImportDiagnostic[] = [];
  const assets = new Map<string, { bytes: Uint8Array; mime?: string; mapping: ArxivAssetMapping }>();
  const candidates: string[] = [];
  for (const src of imageSources(htmlText)) {
    let resolved: URL;
    try {
      resolved = new URL(src, baseUrl);
    } catch {
      warnings.push(warning("arxiv-asset-url-invalid", "arxiv.asset.urlInvalid", src));
      continue;
    }
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
      warnings.push(warning("arxiv-asset-url-invalid", "arxiv.asset.urlInvalid", src));
      continue;
    }
    if (resolved.origin !== baseUrl.origin) {
      // 外部资产不在导入时抓取，也不成为运行时依赖。
      warnings.push(warning("arxiv-asset-external-blocked", "arxiv.asset.externalBlocked", resolved.href));
      continue;
    }
    candidates.push(resolved.href);
  }

  let totalAssetBytes = 0;
  let budgetExceeded: string | null = null;
  const queue = [...new Set(candidates)];
  async function worker(): Promise<void> {
    for (;;) {
      const url = queue.shift();
      if (url === undefined || budgetExceeded !== null) return;
      if (signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", url);
      let response: ArxivFetchResponse;
      try {
        response = await transport(url, { budgetBytes: assetBudget, signal });
      } catch (error) {
        if (error instanceof ArxivFetchError && error.code === "arxiv-fetch-cancelled") throw error;
        if (error instanceof ArxivFetchError && error.code === "arxiv-fetch-budget") {
          budgetExceeded = url;
          return;
        }
        warnings.push(warning("arxiv-asset-fetch-failed", "arxiv.asset.fetchFailed", url));
        continue;
      }
      const hash = sha256(response.bytes);
      const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      const relative = `assets/${hash}.${assetExtension(new URL(url), mime)}`;
      if (assets.has(relative)) continue; // 同内容资产按摘要复用，不重复登记。
      totalAssetBytes += response.bytes.byteLength;
      if (totalAssetBytes > totalBudget) {
        budgetExceeded = url;
        return;
      }
      assets.set(relative, {
        bytes: response.bytes,
        mime,
        mapping: { originalUrl: url, path: relative, sha256: hash, size: response.bytes.byteLength, ...(mime === undefined ? {} : { mime }) },
      });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, worker));
  } catch (error) {
    if (signal?.aborted)
      return { ok: false, diagnostic: fetchDiagnostic(new ArxivFetchError("arxiv-fetch-cancelled", htmlUrl), htmlUrl, "html") };
    return { ok: false, diagnostic: fetchDiagnostic(error, htmlUrl, "html") };
  }
  if (budgetExceeded !== null)
    return fatal("arxiv-budget-exceeded", "arxiv.fetch.budget", "fetch", budgetExceeded);

  const files: Record<string, ManagedFileContent> = {
    "abs.html": { bytes: absResponse.bytes, mime: "text/html" },
    "document.html": { bytes: htmlResponse.bytes, mime: "text/html" },
  };
  for (const [relative, asset] of assets) {
    files[relative] = asset.mime === undefined ? asset.bytes : { bytes: asset.bytes, mime: asset.mime };
  }
  const metadata: ArxivSourceMetadata = {
    kind: "arxiv",
    baseId: pinned.baseId,
    version: pinned.version,
    canonicalId: pinned.canonicalId,
    absUrl: absResponse.url,
    htmlUrl: htmlResponse.url,
    title: absTitle(absText),
    authors: allMetaContents(absText, "citation_author"),
    versionDate: absVersionDate(absText, pinned.version),
    licenseUrl: licenseUrl(absText),
    fetchedAt: new Date().toISOString(),
    assets: Object.fromEntries([...assets.values()].map((asset) => [asset.mapping.path, asset.mapping])),
    response: { abs: responseFacts(absResponse), html: responseFacts(htmlResponse) },
  };

  // 同字节复用：只有 abs 与 HTML 原始字节摘要都与已验证快照相同时才复用，
  // 不因 URL、文件名或修改时间相同跳过摘要核验。
  const absHash = sha256(absResponse.bytes);
  const htmlHash = sha256(htmlResponse.bytes);
  for (const existing of await listSourceSnapshots(root)) {
    if (existing.canonicalId !== pinned.canonicalId) continue;
    const absRecord = existing.files.find((file) => file.path === "abs.html");
    const htmlRecord = existing.files.find((file) => file.path === "document.html");
    if (absRecord?.sha256 === absHash && htmlRecord?.sha256 === htmlHash)
      return { ok: true, reused: true, snapshot: existing, warnings, bodyReadable: false };
  }

  try {
    const snapshot = await publishSourceSnapshot({ root, files, metadata: { ...metadata } }, input.hooks ?? {});
    return { ok: true, reused: false, snapshot, warnings, bodyReadable: false };
  } catch (error) {
    return fatal("arxiv-snapshot-publish-failed", "arxiv.snapshot.publishFailed", "snapshot", error instanceof Error ? error.message : String(error));
  }
}
