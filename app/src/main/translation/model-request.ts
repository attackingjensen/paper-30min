// 翻译模型请求（SPEC-translation §2，paper-30min-crd.2）：
// 复用本机模型服务配置与 Pi 模型调用基础设施，但任务与持续 Agent 会话分离。
// 凭据只存在于进程内存；译文侧车只记录 provider/model 与协议版本事实。
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as httpFetch, type Dispatcher } from "undici";
import type { ModelConfig } from "../agent-settings.js";
import type { TranslationGenerator } from "../../shared/translation/contracts.js";
import type { TranslationModelInput } from "./model-io.js";

/** 受控 fixture 端点门控（与 arXiv 导入同口径）：仅测试环境 + 回环 baseUrl
 * 才允许回环 http；生产命令即使配置回环端点也无法访问本机/私网服务。 */
export function translationFixtureGate(baseUrl: string): boolean {
  if (process.env.PAPER30MIN_TEST_WINDOW === undefined) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  } catch {
    return false;
  }
}

export interface TranslationModelSession {
  generator: TranslationGenerator;
  generate: (input: TranslationModelInput, signal?: AbortSignal) => Promise<string>;
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
        : new Agent();
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
      promptVersion: 1,
      schemaVersion: 1,
    },
    generate: async (input, signal) => {
      const message = await models.completeSimple(
        model,
        {
          systemPrompt: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
        },
        { apiKey, fetch, maxTokens: input.maxTokens, maxRetries: 0, ...(signal ? { signal } : {}) },
      );
      if (message.stopReason !== "stop")
        throw new Error(message.errorMessage ?? "翻译模型请求未完成，请检查模型配置后重试。");
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (!text) throw new Error("翻译模型没有返回文本内容。");
      return text;
    },
    close: () => network.destroy(),
  };
}
