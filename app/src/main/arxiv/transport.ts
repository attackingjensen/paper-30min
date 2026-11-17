import { request } from "undici";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import {
  ArxivFetchError,
  type ArxivFetchOptions,
  type ArxivFetchResponse,
} from "./fetch.js";
import { isAllowedSourceHost } from "./reference.js";


export { ArxivFetchError } from "./fetch.js";
const DEFAULT_STALL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// host 允许清单（SPEC §2.2–2.3）：正文与资产只从明确的 arXiv host 获取。
// 回环地址仅用于受控本地 fixtures 的 http 端点；生产 arXiv 来源始终 https。

function privateOrLocalTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal")) return true;
  const version = isIP(host);
  if (version === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 0;
  }
  if (version === 6) {
    return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  }
  return false;
}

/** 每一跳访问网络前先验证：协议、凭据、host 允许清单与私网目标。 */
function validateHop(rawUrl: string, kind: "start" | "redirect"): URL {
  const invalidCode = kind === "start" ? "arxiv-fetch-invalid-url" : "arxiv-fetch-redirect-invalid";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ArxivFetchError(invalidCode, rawUrl);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ArxivFetchError(invalidCode, rawUrl);
  if (url.username !== "" || url.password !== "")
    throw new ArxivFetchError(invalidCode, rawUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!isAllowedSourceHost(host))
    throw new ArxivFetchError(kind === "start" ? "arxiv-fetch-host-rejected" : invalidCode, rawUrl);
  // 回环 fixture 端点允许；其余本地/私网目标一律拒绝（含重定向）。
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && privateOrLocalTarget(host))
    throw new ArxivFetchError(invalidCode, rawUrl);
  return url;
}

function retryAfterMs(value: string | undefined, capMs: number): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, capMs);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), capMs);
  return undefined;
}

function networkErrorCode(error: unknown): "arxiv-fetch-tls" | "arxiv-fetch-network" {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  return /^(CERT_|UNABLE_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS)/.test(code) ||
    /certificate/i.test(String((error as Error | undefined)?.message))
    ? "arxiv-fetch-tls"
    : "arxiv-fetch-network";
}

async function readBody(
  body: AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void },
  budgetBytes: number,
  stallMs: number,
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: NodeJS.Timeout | undefined;
  let stalled = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      body.destroy?.(new Error("stalled"));
    }, stallMs);
  };
  const onAbort = () => body.destroy?.(new Error("cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  try {
    for await (const chunk of body) {
      if (signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", url);
      total += chunk.byteLength;
      if (total > budgetBytes) {
        body.destroy?.(new Error("budget"));
        throw new ArxivFetchError("arxiv-fetch-budget", url);
      }
      chunks.push(chunk);
      arm();
    }
  } catch (error) {
    if (signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", url);
    if (stalled) throw new ArxivFetchError("arxiv-fetch-stalled", url);
    if (error instanceof ArxivFetchError) throw error;
    throw new ArxivFetchError(networkErrorCode(error), url);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks);
}

async function attempt(
  startUrl: string,
  options: ArxivFetchOptions,
): Promise<ArxivFetchResponse> {
  const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const signal = options.signal;
  const chain: string[] = [];
  let current = validateHop(startUrl, "start");
  for (let hop = 0; ; hop += 1) {
    signal?.throwIfAborted();
    chain.push(current.href);
    let response;
    try {
      response = await request(current.href, {
        method: "GET",
        // 手动处理重定向：每一跳先验证再访问；undici 默认 maxRedirections=0。
        dispatcher: options.dispatcher,
        signal,
        headersTimeout: stallMs,
        bodyTimeout: stallMs,
        // 不携带任何凭据；响应头只保留公开字段。
        headers: { "user-agent": "Paper30Min/2.0 (arxiv-import)" },
      });
    } catch (error) {
      if (signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", current.href);
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
      if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" ||
          code === "UND_ERR_CONNECT_TIMEOUT")
        throw new ArxivFetchError("arxiv-fetch-stalled", current.href);
      throw new ArxivFetchError(networkErrorCode(error), current.href);
    }
    const status = response.statusCode;
    if (REDIRECT_STATUSES.has(status)) {
      const location = response.headers.location;
      // 丢弃未读取的重定向正文，避免连接泄漏。
      await response.body.dump().catch(() => undefined);
      if (typeof location !== "string" || location === "")
        throw new ArxivFetchError("arxiv-fetch-redirect-invalid", current.href);
      if (hop >= maxRedirects)
        throw new ArxivFetchError("arxiv-fetch-redirect-limit", current.href);
      const next = validateHop(new URL(location, current).href, "redirect");
      // HTTP 只能规范化为 HTTPS（真实 arXiv host）；回环 fixture 保持 http。
      if (next.protocol === "http:" && next.hostname.toLowerCase() === "arxiv.org")
        next.protocol = "https:";
      current = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      await response.body.dump().catch(() => undefined);
      throw new ArxivFetchError(
        "arxiv-fetch-status",
        current.href,
        status,
        retryAfterMs(
          typeof response.headers["retry-after"] === "string"
            ? response.headers["retry-after"]
            : undefined,
          options.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS,
        ),
      );
    }
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > options.budgetBytes) {
      await response.body.dump().catch(() => undefined);
      throw new ArxivFetchError("arxiv-fetch-budget", current.href);
    }
    const bytes = await readBody(response.body, options.budgetBytes, stallMs, current.href, signal);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    return { status, url: current.href, redirectChain: chain, headers, bytes };
  }
}

/**
 * 受控幂等 GET（SPEC §2）：先验证规范化 URL 与每一跳重定向再访问网络；
 * 自动重试仅限网络中断、停滞、429 与可重试 5xx，且只在同一次用户动作内、
 * 默认最多两次额外重试；404/403/TLS/预算错误不重试；尊重有界 Retry-After；
 * 用户取消立即生效。不放宽生产 TLS 校验。
 */
export async function arxivFetch(
  url: string,
  options: ArxivFetchOptions,
): Promise<ArxivFetchResponse> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let lastError: ArxivFetchError | undefined;
  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    options.signal?.throwIfAborted();
    try {
      return await attempt(url, options);
    } catch (error) {
      if (options.signal?.aborted) throw new ArxivFetchError("arxiv-fetch-cancelled", url);
      if (!(error instanceof ArxivFetchError)) throw error;
      lastError = error;
      const retryable =
        error.code === "arxiv-fetch-network" ||
        error.code === "arxiv-fetch-stalled" ||
        (error.code === "arxiv-fetch-status" &&
          error.status !== undefined &&
          (error.status === 429 ||
            (error.status >= 500 && error.status <= 599 && error.status !== 501)));
      if (!retryable || attemptIndex === maxRetries) throw error;
      try {
        await sleep(error.retryAfterMs ?? 0, options.signal);
      } catch {
        throw new ArxivFetchError("arxiv-fetch-cancelled", url);
      }
    }
  }
  throw lastError ?? new ArxivFetchError("arxiv-fetch-network", url);
}
