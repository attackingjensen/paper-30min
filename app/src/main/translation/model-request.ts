// 翻译模型请求（SPEC-translation §2/§6/§11，paper-30min-crd.2/crd.5）：
// 复用本机模型服务配置与 Pi 模型调用基础设施，但任务与持续 Agent 会话分离。
// 凭据只存在于进程内存；译文侧车只记录 provider/model 与协议版本事实。
// 请求边界产生分类 typed error（不含密钥/原始响应正文）；流式文本按 UTF-8 字节
// 累计，超过单元响应预算立即断开连接，不等完整缓冲。
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as httpFetch, type Dispatcher } from "undici";
import type { ModelConfig } from "../agent-settings.js";
import type { TranslationCacheGenerator } from "./response-cache.js";
import {
  maximumUnitBytes,
  translationProtocolVersions,
  type TranslationMetaInput,
  type TranslationModelInput,
} from "./model-io.js";

/** 请求失败分类：诊断只保存类别与安全文案，不保存原始服务错误或凭据。 */
export type TranslationRequestFailureKind = "network" | "rate-limit" | "timeout" | "auth" | "aborted" | "output";

export class TranslationModelRequestError extends Error {
  readonly kind: TranslationRequestFailureKind;
  constructor(kind: TranslationRequestFailureKind) {
    super(`翻译模型请求失败（${kind}）`);
    this.name = "TranslationModelRequestError";
    this.kind = kind;
  }
}

/** 单请求超时上限：连接与流式响应头都不得无限挂起；超时按 timeout 分类，可恢复。 */
const requestTimeoutMs = 120_000;

/** 受控 fixture 端点门控（与 arXiv 导入同口径）：仅测试环境 + 回环 baseUrl
 * 才允许回环 http；生产命令即使配置回环端点也无法访问本机/私网服务。 */
function translationFixtureGate(baseUrl: string): boolean {
  if (process.env.PAPER30MIN_TEST_WINDOW === undefined) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  } catch {
    return false;
  }
}

export interface TranslationModelSession {
  generator: TranslationCacheGenerator;
  generate: (input: TranslationModelInput | TranslationMetaInput, signal?: AbortSignal) => Promise<string>;
  close: () => Promise<void>;
}

/** 任务开始时固定 provider/model 配置；任务期间配置变化不影响在途请求。 */
export function createTranslationModelSession(config: ModelConfig): TranslationModelSession {
  const selected = config.models.find((model) => model.id === config.selectedModelId);
  const service = config.services.find((candidate) => candidate.id === selected?.serviceId);
  const apiKey = service ? config.keys[service.id] : undefined;
  if (!selected?.model || !service?.baseUrl || !apiKey)
    throw new Error("请先在设置中配置模型与 API 密钥，再开始翻译。");
  if (service && config.unreadableKeys.includes(service.id))
    throw new Error("此服务的 API 密钥无法读取，请在设置中替换或移除。");

  const loopback = translationFixtureGate(service.baseUrl);
  const url = new URL(service.baseUrl);
  if (!loopback && (url.protocol !== "https:" || url.username || url.password || url.search || url.hash))
    throw new Error("翻译模型端点需要不含凭据的 HTTPS 地址。");

  const network: Dispatcher =
    config.proxy === "custom"
      ? new ProxyAgent(config.proxyUrl)
      : config.proxy === "environment"
        ? new EnvHttpProxyAgent()
        : new Agent({ headersTimeout: requestTimeoutMs, bodyTimeout: requestTimeoutMs });
  const fetch: typeof globalThis.fetch = async (input, init) =>
    (await httpFetch(
      input as string,
      { ...init, dispatcher: network } as Parameters<typeof httpFetch>[1],
    )) as unknown as Response;

  const stream =
    service.api === "openai-completions" ? completions : service.api === "openai-responses" ? responses : anthropic;
  const isDashScope = service.api === "openai-completions" && url.hostname === "dashscope.aliyuncs.com";
  const model: Model<typeof service.api> = {
    id: selected.model,
    name: selected.name || selected.model,
    api: service.api,
    provider: "paper30min-translation",
    baseUrl: service.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: selected.contextWindow,
    maxTokens: selected.maxTokens,
    ...(isDashScope ? { compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" as const } } : {}),
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "paper30min-translation",
      baseUrl: service.baseUrl,
      auth: {
        apiKey: {
          name: "翻译模型 API 密钥",
          resolve: async () => ({ auth: { apiKey } }),
        },
      },
      models: [model],
      api: { stream, streamSimple: stream },
    }),
  );

  return {
    generator: {
      provider: service.api,
      model: selected.model,
      promptVersion: translationProtocolVersions.promptVersion,
      schemaVersion: translationProtocolVersions.schemaVersion,
      normalizationVersion: translationProtocolVersions.normalizationVersion,
    },
    generate: async (input, signal) => {
      signal?.throwIfAborted();
      // 请求级控制器：外部取消与响应字节超限共用同一中止路径；超限立即断开连接。
      const request = new AbortController();
      const onExternalAbort = () => request.abort();
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      let responseBytes = 0;
      let exceeded = false;
      let httpStatus: number | undefined;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, requestTimeoutMs);
      try {
        const events = models.streamSimple(
          model,
          {
            systemPrompt: input.systemPrompt,
            messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
          },
          {
            apiKey,
            fetch,
            maxTokens: input.maxTokens,
            maxRetries: 0,
            timeoutMs: requestTimeoutMs,
            signal: request.signal,
            onResponse: ({ status }) => {
              httpStatus = status;
            },
          },
        );
        const chunks: string[] = [];
        let failure: { stopReason: string; errorMessage?: string } | undefined;
        for await (const event of events) {
          if (event.type === "text_delta") {
            // 流式边界累计 UTF-8 字节；超限即中止，不等 completeSimple 完整缓冲。
            responseBytes += Buffer.byteLength(event.delta, "utf8");
            if (responseBytes > maximumUnitBytes) {
              exceeded = true;
              request.abort();
              break;
            }
            chunks.push(event.delta);
          } else if (event.type === "error") {
            failure = { stopReason: event.reason, errorMessage: event.error.errorMessage };
          }
        }
        const message = await events.result();
        if (exceeded) throw new TranslationModelRequestError("output");
        const stopReason = failure?.stopReason ?? message.stopReason;
        const errorMessage = failure?.errorMessage ?? message.errorMessage ?? "";
        if (stopReason === "aborted")
          throw new TranslationModelRequestError(signal?.aborted ? "aborted" : timedOut ? "timeout" : "network");
        if (stopReason !== "stop") {
          if (timedOut || /timed out|timeout/i.test(errorMessage)) throw new TranslationModelRequestError("timeout");
          // SDK 错误经 pi 归一化后只剩文案：状态码前缀（"429 ..." / "Error (429): ..."）是分类依据。
          const status = httpStatus ?? Number(errorMessage.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? Number.NaN);
          if (status === 429) throw new TranslationModelRequestError("rate-limit");
          if (status === 401 || status === 403) throw new TranslationModelRequestError("auth");
          if (/abort/i.test(errorMessage)) throw new TranslationModelRequestError("aborted");
          if (Number.isFinite(status) && status >= 500) throw new TranslationModelRequestError("network");
          if (Number.isFinite(status)) throw new TranslationModelRequestError("output");
          throw new TranslationModelRequestError("network");
        }
        const text = chunks.join("");
        if (!text) throw new TranslationModelRequestError("output");
        return text;
      } catch (error) {
        if (error instanceof TranslationModelRequestError) throw error;
        if (exceeded) throw new TranslationModelRequestError("output");
        if (timedOut) throw new TranslationModelRequestError("timeout");
        if (signal?.aborted || request.signal.aborted) throw new TranslationModelRequestError("aborted");
        const status =
          typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
            ? error.status
            : undefined;
        if (status === 429) throw new TranslationModelRequestError("rate-limit");
        if (status === 401 || status === 403) throw new TranslationModelRequestError("auth");
        if (error instanceof Error && /timed out|timeout/i.test(error.message))
          throw new TranslationModelRequestError("timeout");
        throw new TranslationModelRequestError("network");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onExternalAbort);
      }
    },
    close: () => network.destroy(),
  };
}
