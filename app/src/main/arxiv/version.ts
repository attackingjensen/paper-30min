import type { ArxivReference, ImportDiagnostic } from "../../shared/arxiv.js";
import { arxivEndpointUrl, isAllowedSourceHost, parseArxivReference } from "./reference.js";
import { fetchDiagnostic } from "./fetch.js";

/** 受控 abs 获取入口：生产 transport 在后续切片接入，测试映射到本地 fixtures。 */
export type AbsFetch = (url: string) => Promise<string>;

export type ArxivVersionResolution =
  | { ok: true; reference: ArxivReference; absUrl: string }
  | { ok: false; diagnostic: ImportDiagnostic };

export type ArxivVersionGuard = { ok: true } | { ok: false; diagnostic: ImportDiagnostic };

export interface ArxivVersionEvidence {
  /** 响应 HTML 中 citation_arxiv_id 元数据的值（如有）。 */
  citationId?: string;
}

function fail(code: string, messageKey: string, sourceUrl?: string): { ok: false; diagnostic: ImportDiagnostic } {
  return {
    ok: false,
    diagnostic: { code, severity: "fatal", stage: "resolve", messageKey, sourceUrl },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AbsIdentity {
  baseId: string;
  version: number | null;
}

/** 从 abs/HTML 页面元数据或 URL 路径中读取完整来源身份；解析失败返回 null。 */
function identityFromText(text: string): AbsIdentity | null {
  const parsed = parseArxivReference(text);
  return parsed.ok ? { baseId: parsed.reference.baseId, version: parsed.reference.version } : null;
}

function citationIdentity(html: string): AbsIdentity | null {
  const match = /<meta\b[^>]*\bname=["']citation_arxiv_id["'][^>]*>/i.exec(html);
  if (!match) return null;
  const content = /\bcontent=["']([^"']*)["']/i.exec(match[0]);
  return content ? identityFromText(content[1]) : null;
}

/** abs 页面 <title> 的 [id] 前缀给出该页面对应的 base ID。 */
function absTitleBaseId(html: string): string | null {
  const match = /<title>\s*\[([^\]]+)\]/i.exec(html);
  return match ? (identityFromText(match[1])?.baseId ?? null) : null;
}

interface HistoryEntry {
  version: number;
  withdrawn: boolean;
}

/** 提交历史中指向同一 base ID 的版本记录；旧版可链接，当前最新版常只有 strong 文本。 */
function submissionHistory(html: string, baseId: string): HistoryEntry[] {
  const source = /<div\b[^>]*class=["'][^"']*\bsubmission-history\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  if (!source) return [];
  const entries: HistoryEntry[] = [];
  const linked = new RegExp(
    `<a\\b[^>]*\\bhref=["']/abs/${escapeRegExp(baseId)}v(\\d+)["'][^>]*>\\s*\\[v\\d+\\]\\s*</a>([\\s\\S]*?)(?=<a\\b|<b>|<strong\\b|$)`,
    "gi",
  );
  for (const match of source.matchAll(linked)) {
    entries.push({ version: Number(match[1]), withdrawn: /withdrawn/i.test(match[2]) });
  }
  const unlinked = /<strong\b[^>]*>\s*\[v(\d+)\]\s*<\/strong>([\s\S]*?)(?=<strong\b|$)/gi;
  for (const match of source.matchAll(unlinked)) {
    entries.push({ version: Number(match[1]), withdrawn: /withdrawn/i.test(match[2]) });
  }
  return entries;
}

/** 只信提交历史中的版本记录，忽略页面其他数字；无历史返回 null。 */
export function arxivLatestVersion(html: string, baseId: string): number | null {
  const versions = submissionHistory(html, baseId).map((entry) => entry.version);
  return versions.length === 0 ? null : Math.max(...versions);
}

/**
 * 固定实际版本（SPEC §1.4–1.7）：
 * - 无版本输入读取一次 abs，从提交历史按整数取最新并固定；
 * - 显式版本读取该版本 abs 核验存在性与身份，绝不改取其他版本；
 * - 无版本目标为撤稿版时报告撤稿，不自动采用上一版；用户显式选择的历史版本照常固定。
 */
export async function resolveArxivVersion(
  reference: ArxivReference,
  fetchAbs: AbsFetch,
  /** 受控端点基址注入点；默认生产 https://arxiv.org，URL 语义不变。 */
  absUrl: string = arxivEndpointUrl(reference, "abs"),
): Promise<ArxivVersionResolution> {
  let html: string;
  try {
    html = await fetchAbs(absUrl);
  } catch (error) {
    // 复用统一 transport 分类：404/403/429/TLS/停滞/网络/取消不互相冒充。
    return { ok: false, diagnostic: fetchDiagnostic(error, absUrl, "abs", "resolve") };
  }
  const identity = citationIdentity(html);
  const titleBaseId = absTitleBaseId(html);
  const pageBaseId = identity?.baseId ?? titleBaseId;
  if (pageBaseId !== null && pageBaseId !== reference.baseId)
    return fail("arxiv-identity-mismatch", "arxiv.identity.mismatch", absUrl);
  const history = submissionHistory(html, reference.baseId);
  if (reference.version !== null) {
    const entry = history.find((candidate) => candidate.version === reference.version);
    if (!entry) return fail("arxiv-version-missing", "arxiv.version.missing", absUrl);
    return { ok: true, reference, absUrl };
  }
  if (history.length === 0) return fail("arxiv-version-unresolved", "arxiv.version.unresolved", absUrl);
  const latest = history.reduce((best, entry) => (entry.version > best.version ? entry : best));
  if (latest.withdrawn) return fail("arxiv-version-withdrawn", "arxiv.version.withdrawn", absUrl);
  return {
    ok: true,
    reference: {
      baseId: reference.baseId,
      version: latest.version,
      canonicalId: `${reference.baseId}v${latest.version}`,
    },
    absUrl,
  };
}

/** 版本状态查询（SPEC §8.1）：只读已获取的 abs 提交历史，比较固定版本与最新版。
 * 不下载 HTML、不生成候选；页面身份不符或历史缺失如实失败。撤稿按事实报告。 */
export type ArxivVersionStatus =
  | { ok: true; latest: ArxivReference; upToDate: boolean; withdrawn: boolean }
  | { ok: false; diagnostic: ImportDiagnostic };

export function arxivVersionStatus(html: string, pinned: ArxivReference, absUrl: string): ArxivVersionStatus {
  if (pinned.version === null) return fail("arxiv-version-unpinned", "arxiv.version.unpinned", absUrl);
  const identity = citationIdentity(html);
  const titleBaseId = absTitleBaseId(html);
  const pageBaseId = identity?.baseId ?? titleBaseId;
  if (pageBaseId !== null && pageBaseId !== pinned.baseId)
    return fail("arxiv-identity-mismatch", "arxiv.identity.mismatch", absUrl);
  const history = submissionHistory(html, pinned.baseId);
  if (history.length === 0) return fail("arxiv-version-unresolved", "arxiv.version.unresolved", absUrl);
  if (!history.some((entry) => entry.version === pinned.version))
    return fail("arxiv-version-missing", "arxiv.version.missing", absUrl);
  const latest = history.reduce((best, entry) => (entry.version > best.version ? entry : best));
  return {
    ok: true,
    latest: {
      baseId: pinned.baseId,
      version: latest.version,
      canonicalId: `${pinned.baseId}v${latest.version}`,
    },
    upToDate: latest.version === pinned.version,
    withdrawn: latest.withdrawn,
  };
}

/** 显式目标版本的存在与撤稿核验（SPEC §8.2）：更新候选获取前只读该版本 abs；
 * 撤稿版本拒绝生成候选，不自动采用上一版。 */
export function assertArxivVersionAvailable(html: string, pinned: ArxivReference, absUrl: string): ArxivVersionGuard {
  if (pinned.version === null) return fail("arxiv-version-unpinned", "arxiv.version.unpinned", absUrl);
  const identity = citationIdentity(html);
  const titleBaseId = absTitleBaseId(html);
  const pageBaseId = identity?.baseId ?? titleBaseId;
  if (pageBaseId !== null && pageBaseId !== pinned.baseId)
    return fail("arxiv-identity-mismatch", "arxiv.identity.mismatch", absUrl);
  const entry = submissionHistory(html, pinned.baseId).find((candidate) => candidate.version === pinned.version);
  if (!entry) return fail("arxiv-version-missing", "arxiv.version.missing", absUrl);
  if (entry.withdrawn) return fail("arxiv-version-withdrawn", "arxiv.version.withdrawn", absUrl);
  return { ok: true };
}

/**
 * 版本守卫（SPEC §1.5–1.6）：HTML 最终 URL 与元数据必须与固定版本完全一致，
 * 版本混杂即失败，不得拼接不同版本的正文和资产；不同 base ID 是另一来源。
 */
export function assertArxivVersionConsistent(
  pinned: ArxivReference,
  finalUrl: string,
  evidence: ArxivVersionEvidence = {},
): ArxivVersionGuard {
  if (pinned.version === null) return fail("arxiv-version-unpinned", "arxiv.version.unpinned", finalUrl);
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return fail("arxiv-source-url-invalid", "arxiv.source.urlInvalid", finalUrl);
  }
  if (!isAllowedSourceHost(url.hostname))
    return fail("arxiv-source-host-rejected", "arxiv.source.hostRejected", finalUrl);
  const fromUrl = identityFromText(`https://arxiv.org${url.pathname}`);
  if (!fromUrl || fromUrl.baseId !== pinned.baseId)
    return fail("arxiv-identity-mismatch", "arxiv.identity.mismatch", finalUrl);
  if (fromUrl.version !== null && fromUrl.version !== pinned.version)
    return fail("arxiv-version-mixed", "arxiv.version.mixed", finalUrl);
  let metaVersion: number | null = null;
  if (evidence.citationId !== undefined) {
    const fromMeta = identityFromText(evidence.citationId);
    if (!fromMeta || fromMeta.baseId !== pinned.baseId)
      return fail("arxiv-identity-mismatch", "arxiv.identity.mismatch", finalUrl);
    if (fromMeta.version !== null && fromMeta.version !== pinned.version)
      return fail("arxiv-version-mixed", "arxiv.version.mixed", finalUrl);
    metaVersion = fromMeta.version;
  }
  // fail closed：URL 与元数据至少一项必须明确等于固定 vN；
  // 两者都无版本时无法证明响应属于该版本，不得发布。
  if (fromUrl.version === null && metaVersion === null)
    return fail("arxiv-version-unproven", "arxiv.version.unproven", finalUrl);
  return { ok: true };
}
