import type { Dispatcher } from "undici";
import type { ArxivReference, ImportDiagnostic } from "../../shared/arxiv.js";
import type { ProjectCommitHooks } from "../project-core.js";
import type { SourceSnapshotRecord } from "../../shared/contracts.js";

/** 受控获取响应：只保留公开头，不携带 Cookie/Authorization 等请求密钥。 */
export interface ArxivFetchResponse {
  status: number;
  /** 最终 URL（重定向链终点），必须已通过 host 与版本校验。 */
  url: string;
  /** 实际经过的 URL 链（含起点与终点），供快照记录重定向链。 */
  redirectChain: string[];
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export type ArxivFetchFailureCode =
  | "arxiv-fetch-invalid-url"
  | "arxiv-fetch-host-rejected"
  | "arxiv-fetch-redirect-invalid"
  | "arxiv-fetch-redirect-limit"
  | "arxiv-fetch-tls"
  | "arxiv-fetch-network"
  | "arxiv-fetch-stalled"
  | "arxiv-fetch-status"
  | "arxiv-fetch-budget"
  | "arxiv-fetch-cancelled";

export class ArxivFetchError extends Error {
  constructor(
    readonly code: ArxivFetchFailureCode,
    readonly url: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`${code}: ${url}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "ArxivFetchError";
  }
}

/** 把受控 transport 的分类失败映射为稳定诊断；不互相冒充。stage 由调用阶段决定。 */
export function fetchDiagnostic(
  error: unknown,
  url: string,
  kind: "abs" | "html",
  stage: ImportDiagnostic["stage"] = "fetch",
): ImportDiagnostic {
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

export interface ArxivFetchOptions {
  /** 响应字节预算（声明大小与实际字节均受约束）。 */
  budgetBytes: number;
  signal?: AbortSignal;
  /** 连接或持续无字节进度判定停滞的毫秒数，默认 30 秒。 */
  stallTimeoutMs?: number;
  /** 每次显式获取动作的自动额外重试上限，默认 2。 */
  maxRetries?: number;
  /** 重定向上限，默认 5。 */
  maxRedirects?: number;
  /** 有界 Retry-After 等待上限，默认 30 秒。 */
  retryAfterCapMs?: number;
  /** 生产注入点：默认 undici 默认 dispatcher，不放宽 TLS。 */
  dispatcher?: Dispatcher;
  /** 测试注入点：等待 Retry-After 的实现。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 受控 fixture 端点专用：允许回环 http 目标。生产路径不得开启；
   * 仅当命令 baseUrl 指向回环且主进程测试环境显式允许时由 IPC 层注入。 */
  allowFixtureLoopback?: boolean;
}

/** 受控幂等 GET：先验证 URL 与每一跳重定向，再访问网络；失败以 ArxivFetchError 分类。 */
export type ArxivTransport = (
  url: string,
  options: ArxivFetchOptions,
) => Promise<ArxivFetchResponse>;

export interface ArxivAssetMapping {
  /** 相对固定版本 HTML URL 解析出的原始绝对 URL。 */
  originalUrl: string;
  /** 快照内相对路径 assets/<sha256>.<ext>。 */
  path: string;
  sha256: string;
  size: number;
  mime?: string;
}

/** 快照元数据中的来源事实（SPEC 快照契约）。 */
export interface ArxivSourceMetadata {
  kind: "arxiv";
  baseId: string;
  version: number;
  canonicalId: string;
  absUrl: string;
  htmlUrl: string;
  title: string | null;
  authors: string[];
  versionDate: string | null;
  licenseUrl: string | null;
  fetchedAt: string;
  /** 资产原始 URL 映射；键为快照内相对路径。 */
  assets: Record<string, ArxivAssetMapping>;
  response?: {
    abs?: { etag?: string; lastModified?: string; contentType?: string; redirectChain?: string[] };
    html?: { etag?: string; lastModified?: string; contentType?: string; redirectChain?: string[] };
  };
  /** 获取阶段警告（外部资产未抓取、单资产失败等）；随快照持久化，重开可继续呈现。 */
  warnings?: ImportDiagnostic[];
}

export type ArxivSnapshotResult =
  | {
      ok: true;
      /** 字节与已验证快照相同时复用既有快照，不制造重复身份。 */
      reused: boolean;
      snapshot: SourceSnapshotRecord;
      warnings: ImportDiagnostic[];
      /** 快照存在不代表正文可读；转换属于后续阶段。 */
      bodyReadable: false;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

export interface FetchArxivSnapshotInput {
  root: string;
  /** 必须已固定版本（version 为正整数）。 */
  reference: ArxivReference;
  transport: ArxivTransport;
  /** 端点基址注入点：生产默认 https://arxiv.org；受控测试映射到本地 fixtures。 */
  baseUrl?: string;
  signal?: AbortSignal;
  /** 受控 fixture 端点（回环 http）专用；生产路径不得开启。 */
  allowFixtureLoopback?: boolean;
  /** 资产并发，默认 4。 */
  assetConcurrency?: number;
  /** 单项原始资产预算，默认 32 MiB。 */
  assetBudgetBytes?: number;
  /** 单快照原始资产合计预算，默认 512 MiB。 */
  totalAssetBudgetBytes?: number;
  /** 快照发布提交点故障注入；生产路径不注入。 */
  hooks?: ProjectCommitHooks;
}
