import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as httpFetch,
  type Dispatcher,
} from "undici";
import type {
  AgentCommand,
  ChatMessage,
  ChatSession,
  ThinkingLevel,
} from "../shared/contracts.js";
import type { ModelConfig } from "./agent-settings.js";

interface Conversation {
  manager: SessionManager;
  state: ChatSession;
  session?: AgentSession;
  network?: Dispatcher;
  unsubscribe?: () => void;
  run?: Promise<void>;
  initializing?: boolean;
  activeModelId?: string;
}

function textOf(message: { content: unknown }) {
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("")
      : "";
}
function thinkingOf(message: { content: unknown }) {
  return Array.isArray(message.content)
    ? message.content
        .filter((c) => c.type === "thinking")
        .map((c) => c.thinking)
        .join("")
    : "";
}
function failure(message?: string) {
  if (/401|403|authentication|api.key|模型认证失败/i.test(message ?? ""))
    return "模型认证失败，请检查 API 密钥与端点。";
  if (/429|rate.limit|模型服务限流/i.test(message ?? ""))
    return "模型服务限流，请稍后重试。";
  return "模型请求失败，请检查端点、模型名称和代理后重试。";
}

// Bound cancellation independently of provider stream progress, and sanitize failures before Pi persists them.
function guardedStream(
  stream: StreamFunction,
  config: { apiKey: string; maxTokens: number },
  network: Dispatcher,
): StreamFunction {
  return (model, context, options) => {
    const output = new AssistantMessageEventStream();
    let terminal = false;
    let latest: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "aborted",
      timestamp: Date.now(),
    };
    const finish = () => {
      if (terminal) return;
      terminal = true;
      output.push({
        type: "error",
        reason: "aborted",
        error: {
          ...structuredClone(latest),
          stopReason: "aborted",
          errorMessage: "已停止",
        },
      });
      output.end();
    };
    options?.signal?.addEventListener("abort", finish, { once: true });
    if (options?.signal?.aborted) finish();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      try {
        return (await httpFetch(
          input as string,
          { ...init, dispatcher: network } as Parameters<typeof httpFetch>[1],
        )) as unknown as Response;
      } catch {
        throw new Error("模型网络连接失败。");
      }
    };
    void (async () => {
      try {
        if (terminal) return;
        const source = stream(model, context, {
          ...options,
          apiKey: config.apiKey,
          fetch,
          env: {
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            http_proxy: "",
            https_proxy: "",
            all_proxy: "",
            NO_PROXY: "*",
            no_proxy: "*",
          },
          transport: "sse",
          maxTokens: config.maxTokens,
        });
        for await (const event of source) {
          if (terminal) break;
          if ("partial" in event) latest = event.partial;
          if (event.type === "error") {
            event.error.errorMessage = failure(event.error.errorMessage);
            terminal = true;
          } else if (event.type === "done") terminal = true;
          output.push(event);
        }
      } catch {
        if (!terminal) {
          terminal = true;
          output.push({
            type: "error",
            reason: "error",
            error: { ...latest, stopReason: "error", errorMessage: failure() },
          });
        }
      } finally {
        options?.signal?.removeEventListener("abort", finish);
        output.end();
      }
    })();
    return output;
  };
}

export class AgentService {
  private conversations = new Map<string, Conversation>();
  private closing = false;
  constructor(private publish: (state: ChatSession) => void) {}
  private key(root: string, id: string) {
    return root + "\0" + id;
  }
  private emit(c: Conversation) {
    c.state.revision++;
    if (!this.closing) this.publish(structuredClone(c.state));
  }
  private sync(c: Conversation) {
    c.state.messages = c.manager.getBranch().flatMap((entry): ChatMessage[] => {
      if (
        entry.type !== "message" ||
        (entry.message.role !== "user" && entry.message.role !== "assistant")
      )
        return [];
      const m = entry.message;
      const status =
        m.role === "assistant" && ["error", "aborted"].includes(m.stopReason)
          ? (m.stopReason as "error" | "aborted")
          : undefined;
      return [
        {
          id: entry.id,
          role: m.role as "user" | "assistant",
          text: textOf(m),
          thinking: m.role === "assistant" ? thinkingOf(m) : undefined,
          status,
        },
      ];
    });
    c.state.title =
      c.state.messages.find((m) => m.role === "user")?.text.slice(0, 40) ||
      "新会话";
  }
  private add(root: string, manager: SessionManager) {
    const c: Conversation = {
      manager,
      state: {
        root,
        id: manager.getSessionId(),
        title: "新会话",
        messages: [],
        busy: false,
        stopping: false,
        queued: [],
        revision: 0,
      },
    };
    this.sync(c);
    this.conversations.set(this.key(root, c.state.id), c);
    return c;
  }
  private async directory(root: string) {
    // Do not let hidden session paths escape the already validated project root.
    for (const dir of [".pi", ".pi/sessions"]) {
      const target = path.join(root, dir);
      await fs.mkdir(target, { recursive: true });
      if (
        (await fs.lstat(target)).isSymbolicLink() ||
        (await fs.realpath(target)) !== path.resolve(target)
      )
        throw new Error("会话目录不能链接到工程外。");
    }
    return path.join(root, ".pi", "sessions");
  }
  private async get(root: string, id: string) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]+$/.test(id))
      throw new Error("会话身份无效。");
    const known = this.conversations.get(this.key(root, id));
    if (known) return known;
    const dir = await this.directory(root);
    // list(cwd, dir) filters the stored cwd; listAll(dir) keeps portable project sessions visible after a move.
    const file = (await SessionManager.listAll(dir)).find(
      (info) => info.id === id,
    )?.path;
    if (!file || (await fs.lstat(file)).isSymbolicLink())
      throw new Error("找不到此会话。");
    return this.add(root, SessionManager.open(file, dir, root));
  }
  private async prepare(c: Conversation, config: ModelConfig) {
    const selected = config.models.find((m) => m.id === config.selectedModelId);
    const service = config.services.find((s) => s.id === selected?.serviceId);
    if (service && config.unreadableKeys.includes(service.id))
      throw new Error("此服务的 API 密钥无法读取，请在设置中替换或移除。");
    const apiKey = service ? config.keys[service.id] : undefined;
    if (!selected?.model || !service?.baseUrl || !apiKey)
      throw new Error("请先在设置中配置 Agent 模型与 API 密钥。");
    c.unsubscribe?.();
    c.session?.dispose();
    await c.network?.destroy();
    const network =
      config.proxy === "custom"
        ? new ProxyAgent(config.proxyUrl)
        : config.proxy === "environment"
          ? new EnvHttpProxyAgent()
          : new Agent();
    c.network = network;
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const stream =
      service.api === "openai-completions"
        ? completions
        : service.api === "openai-responses"
          ? responses
          : anthropic;
    const piLevels: Exclude<ThinkingLevel, "ultra">[] = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    const thinkingLevelMap = Object.fromEntries(
      piLevels.map((level) => [
        level,
        level === "max" && selected.thinking === "ultra"
          ? "ultra"
          : selected.availableThinking.includes(level)
            ? level
            : null,
      ]),
    );
    runtime.registerProvider("paper30min", {
      baseUrl: service.baseUrl,
      api: service.api,
      streamSimple: guardedStream(
        stream as StreamFunction,
        { apiKey, maxTokens: selected.maxTokens },
        network,
      ),
      models: [
        {
          id: selected.model,
          name: selected.name || selected.model,
          api: service.api,
          reasoning: selected.availableThinking.some(
            (level) => level !== "off",
          ),
          thinkingLevelMap,
          ...(service.api === "openai-completions" &&
          new URL(service.baseUrl).hostname === "dashscope.aliyuncs.com"
            ? {
                compat: {
                  thinkingFormat: "qwen",
                  supportsReasoningEffort: true,
                },
              }
            : {}),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: selected.contextWindow,
          maxTokens: selected.maxTokens,
        },
      ],
    });
    await runtime.setRuntimeApiKey("paper30min", apiKey);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: c.state.root,
      agentDir: path.join(c.state.root, ".pi"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      systemPrompt:
        "你是 Paper30Min 的论文研究助手。根据用户实际提供的内容回答，说明不确定点；不要声称已读取未提供的论文或修改文件。",
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: c.state.root,
      agentDir: path.join(c.state.root, ".pi"),
      modelRuntime: runtime,
      model: runtime.getModel("paper30min", selected.model)!,
      thinkingLevel: selected.thinking === "ultra" ? "max" : selected.thinking,
      settingsManager,
      resourceLoader,
      sessionManager: c.manager,
      tools: [],
    });
    c.session = session;
    c.unsubscribe = session.subscribe((event) => {
      if (!c.state.busy || c.state.stopping || this.closing) return;
      if (event.type === "queue_update") {
        c.state.queued = [...event.followUp];
        this.emit(c);
      }
      if (event.type === "message_start") {
        this.sync(c);
        if (event.message.role === "user")
          c.state.messages.push({
            id: "pending-user",
            role: "user",
            text: textOf(event.message),
          });
        this.emit(c);
      }
      if (event.type === "message_update") {
        const m = event.message;
        if (m.role === "assistant") {
          const messages = c.state.messages.filter((m) => m.id !== "streaming");
          c.state.messages = [
            ...messages,
            {
              id: "streaming",
              role: "assistant",
              text: textOf(m),
              thinking: thinkingOf(m),
            },
          ];
          this.emit(c);
        }
      }
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      )
        c.state.error = failure(event.message.errorMessage);
    });
  }
  async dispatch(
    command: Exclude<
      AgentCommand,
      { type: "settings" | "saveSettings" | "selectModel" }
    >,
    config: ModelConfig,
  ) {
    if (this.closing) throw new Error("应用正在退出。");
    const root = command.root;
    if (command.type === "stop") {
      const c = this.conversations.get(this.key(root, command.id));
      if (!c) throw new Error("找不到此会话。");
      if (c.state.busy) {
        c.state.stopping = true;
        c.state.queued = [];
        this.emit(c);
        c.session?.clearQueue();
        await c.session?.abort();
        await c.run;
      }
      return c.state;
    }
    const dir = await this.directory(root);
    if (command.type === "list") {
      const saved = await SessionManager.listAll(dir);
      for (const info of saved) {
        if (this.conversations.has(this.key(root, info.id))) continue;
        if ((await fs.lstat(info.path)).isSymbolicLink())
          throw new Error("会话文件不能为符号链接。");
        this.add(root, SessionManager.open(info.path, dir, root));
      }
      return [...this.conversations.values()]
        .filter((c) => c.state.root === root)
        .map((c) => c.state);
    }
    if (command.type === "create")
      return this.add(root, SessionManager.create(root, dir)).state;
    const c = await this.get(root, command.id);
    if (command.type === "open") return c.state;
    if (command.type === "branch") {
      if (c.state.busy) throw new Error("请先停止此会话再分支。");
      const entry = c.manager.getEntry(command.messageId);
      if (!entry || entry.type !== "message")
        throw new Error("无法从此消息创建分支。");
      const original = c.manager.getSessionFile()!;
      const branched = c.manager.createBranchedSession(entry.id);
      if (!branched) throw new Error("请先发送消息再分支。");
      const next = this.add(root, SessionManager.open(branched, dir, root));
      // Pi changes the manager to the branch file; preserve the original conversation's event revision.
      c.manager = SessionManager.open(original, dir, root);
      this.sync(c);
      this.emit(c);
      return next.state;
    }
    if (
      typeof command.text !== "string" ||
      !command.text.trim() ||
      command.text.length > 100000
    )
      throw new Error("消息不能为空或超过 100,000 字符。");
    if (c.state.stopping || c.initializing)
      throw new Error("会话正在准备或停止，请稍后再试。");
    if (c.state.busy) {
      if (c.activeModelId !== config.selectedModelId)
        throw new Error("已切换模型，请等待当前回复完成后再发送。");
      await c.session!.followUp(command.text);
      c.state.queued = c.session!.getFollowUpMessages().slice();
      this.emit(c);
      return c.state;
    }
    const model = config.models.find(
      (item) => item.id === config.selectedModelId,
    );
    const service = config.services.find(
      (item) => item.id === model?.serviceId,
    );
    if (service && config.unreadableKeys.includes(service.id))
      throw new Error("此服务的 API 密钥无法读取，请在设置中替换或移除。");
    if (!model?.model || !service?.baseUrl || !config.keys[service.id])
      throw new Error("请先在设置中配置 Agent 模型与 API 密钥。");
    c.initializing = true;
    c.activeModelId = config.selectedModelId;
    c.state.busy = true;
    c.state.error = undefined;
    c.state.stopping = false;
    c.state.messages.push({
      id: "pending-user",
      role: "user",
      text: command.text,
    });
    this.emit(c);
    c.run = (async () => {
      await this.prepare(c, config);
      c.initializing = false;
      if (!this.closing && !c.state.stopping)
        await c.session!.prompt(command.text);
    })()
      .catch(() => {
        c.state.error = failure();
      })
      .finally(() => {
        c.unsubscribe?.();
        c.unsubscribe = undefined;
        c.session?.dispose();
        c.session = undefined;
        void c.network?.destroy();
        c.network = undefined;
        c.initializing = false;
        c.activeModelId = undefined;
        this.sync(c);
        c.state.busy = false;
        c.state.stopping = false;
        c.state.queued = [];
        this.emit(c);
      });
    return c.state;
  }
  async close() {
    this.closing = true;
    await Promise.all(
      [...this.conversations.values()].map(async (c) => {
        c.unsubscribe?.();
        c.session?.clearQueue();
        await c.session?.abort();
        await c.run;
        c.session?.dispose();
        await c.network?.destroy();
      }),
    );
  }
}
