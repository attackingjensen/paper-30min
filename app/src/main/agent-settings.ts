import { safeStorage } from "electron";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultAgentSettings,
  thinkingLevels,
  type AgentSettings,
  type ThinkingLevel,
} from "../shared/contracts.js";

export interface ModelConfig extends AgentSettings {
  keys: Record<string, string>;
  unreadableKeys: string[];
}

function validateUrl(value: string, label: string) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new Error(`${label}需要不含凭据的 HTTP/HTTPS 地址。`);
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}

export class AgentSettingsStore {
  constructor(private file: string) {}
  async read(): Promise<ModelConfig> {
    let stored: any;
    try {
      stored = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          ...structuredClone(defaultAgentSettings),
          keys: {},
          unreadableKeys: [],
        };
      throw new Error("模型配置无法读取，请重新保存本机配置。");
    }
    try {
      if (stored.formatVersion !== 2) {
        const settings = this.validate({
          services: [
            {
              id: "default",
              name: "默认服务",
              api: stored.api,
              baseUrl: stored.baseUrl,
              hasKey: false,
            },
          ],
          models: [
            {
              id: "default",
              serviceId: "default",
              name: stored.model,
              model: stored.model,
              contextWindow: stored.contextWindow,
              maxTokens: stored.maxTokens,
              availableThinking: ["off"],
              thinking: "off",
            },
          ],
          selectedModelId: "default",
          proxy: stored.proxy,
          proxyUrl: stored.proxyUrl,
        });
        const keys: Record<string, string> = {};
        const unreadableKeys: string[] = [];
        if (stored.encryptedKey) {
          try {
            keys.default = safeStorage.decryptString(
              Buffer.from(stored.encryptedKey, "base64"),
            );
          } catch {
            unreadableKeys.push("default");
          }
        }
        return { ...settings, keys, unreadableKeys };
      }
      const settings = this.validate(stored);
      const keys: Record<string, string> = {};
      const unreadableKeys: string[] = [];
      for (const service of settings.services) {
        const encrypted = stored.encryptedKeys?.[service.id];
        if (encrypted) {
          try {
            keys[service.id] = safeStorage.decryptString(
              Buffer.from(encrypted, "base64"),
            );
          } catch {
            unreadableKeys.push(service.id);
          }
        }
      }
      return { ...settings, keys, unreadableKeys };
    } catch {
      throw new Error("模型配置无法读取，请重新保存本机配置。");
    }
  }
  async publicSettings(): Promise<AgentSettings> {
    const { keys, unreadableKeys, ...settings } = await this.read();
    return {
      ...settings,
      services: settings.services.map((service) => ({
        ...service,
        hasKey: !!keys[service.id] || unreadableKeys.includes(service.id),
        keyError: unreadableKeys.includes(service.id),
      })),
    };
  }
  private validate(settings: AgentSettings): AgentSettings {
    if (
      !settings ||
      !Array.isArray(settings.services) ||
      !Array.isArray(settings.models) ||
      settings.services.length < 1 ||
      settings.models.length < 1 ||
      settings.services.length > 50 ||
      settings.models.length > 200 ||
      !["direct", "environment", "custom"].includes(settings.proxy) ||
      typeof settings.proxyUrl !== "string"
    )
      throw new Error("模型配置无效。");
    if (settings.proxy === "custom") validateUrl(settings.proxyUrl, "代理");
    const serviceIds = new Set<string>();
    const services = settings.services.map((service) => {
      if (
        !validId(service.id) ||
        serviceIds.has(service.id) ||
        typeof service.name !== "string" ||
        !service.name.trim() ||
        service.name.length > 100 ||
        ![
          "openai-completions",
          "openai-responses",
          "anthropic-messages",
        ].includes(service.api) ||
        typeof service.baseUrl !== "string"
      )
        throw new Error("模型服务配置无效。");
      if (service.baseUrl) validateUrl(service.baseUrl, "模型端点");
      serviceIds.add(service.id);
      return {
        id: service.id,
        name: service.name.trim(),
        api: service.api,
        baseUrl: service.baseUrl.trim(),
        hasKey: false,
      };
    });
    const modelIds = new Set<string>();
    const models = settings.models.map((model) => {
      if (
        !validId(model.id) ||
        modelIds.has(model.id) ||
        !serviceIds.has(model.serviceId) ||
        typeof model.name !== "string" ||
        model.name.length > 100 ||
        typeof model.model !== "string" ||
        model.model.length > 256 ||
        !Number.isInteger(model.contextWindow) ||
        model.contextWindow < 1024 ||
        model.contextWindow > 2000000 ||
        !Number.isInteger(model.maxTokens) ||
        model.maxTokens < 1 ||
        model.maxTokens > model.contextWindow ||
        !Array.isArray(model.availableThinking) ||
        !model.availableThinking.length ||
        model.availableThinking.some(
          (level: ThinkingLevel) => !thinkingLevels.includes(level),
        ) ||
        !model.availableThinking.includes(model.thinking) ||
        (model.availableThinking.includes("ultra") &&
          services.find((s) => s.id === model.serviceId)?.api !==
            "openai-completions")
      )
        throw new Error("模型名称、预算或思考等级无效。");
      modelIds.add(model.id);
      return {
        id: model.id,
        serviceId: model.serviceId,
        name: model.name.trim(),
        model: model.model.trim(),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        availableThinking: [
          ...new Set(model.availableThinking),
        ] as ThinkingLevel[],
        thinking: model.thinking,
      };
    });
    if (settings.selectedModelId && !modelIds.has(settings.selectedModelId))
      throw new Error("已选模型不存在。");
    return {
      services,
      models,
      selectedModelId: settings.selectedModelId || models[0]?.id || "",
      proxy: settings.proxy,
      proxyUrl: settings.proxyUrl.trim(),
    };
  }
  async save(
    settings: AgentSettings,
    apiKeys: Record<string, string> = {},
    clearKeyIds: string[] = [],
  ) {
    const validated = this.validate(settings);
    const ids = new Set(validated.services.map((s) => s.id));
    if (
      Object.entries(apiKeys).some(
        ([id, key]) =>
          !ids.has(id) || typeof key !== "string" || key.length > 8192,
      ) ||
      clearKeyIds.some((id) => !ids.has(id))
    )
      throw new Error("API 密钥无效。");
    let stored: any = {};
    try {
      stored = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !Object.keys(apiKeys).length &&
        !clearKeyIds.length
      )
        throw new Error("模型配置无法读取，请重新填写配置和 API 密钥。");
    }
    const previous: Record<string, unknown> =
      stored.formatVersion === 2
        ? (stored.encryptedKeys ?? {})
        : { default: stored.encryptedKey };
    const encryptedKeys: Record<string, string> = {};
    for (const service of validated.services) {
      if (clearKeyIds.includes(service.id)) continue;
      const replacement = apiKeys[service.id]?.trim();
      if (replacement) {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统凭据加密不可用，无法保存 API 密钥。");
        encryptedKeys[service.id] = safeStorage
          .encryptString(replacement)
          .toString("base64");
      } else if (previous[service.id] !== undefined) {
        const encrypted = previous[service.id];
        if (typeof encrypted !== "string")
          throw new Error(
            `服务「${service.name}」的密钥无法读取，请替换或移除。`,
          );
        try {
          safeStorage.decryptString(Buffer.from(encrypted, "base64"));
        } catch {
          throw new Error(
            `服务「${service.name}」的密钥无法读取，请替换或移除。`,
          );
        }
        if (encrypted) encryptedKeys[service.id] = encrypted;
      }
    }
    const value = { formatVersion: 2, ...validated, encryptedKeys };
    await this.write(value);
    return this.publicSettings();
  }
  private async write(value: object) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
        flag: "wx",
      });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async select(modelId: string, thinking?: ThinkingLevel) {
    const current = await this.read();
    const model = current.models.find((item) => item.id === modelId);
    if (!model || (thinking && !model.availableThinking.includes(thinking)))
      throw new Error("模型或思考等级不可用。");
    const {
      keys: _keys,
      unreadableKeys: _unreadableKeys,
      ...settings
    } = current;
    settings.selectedModelId = modelId;
    if (thinking) model.thinking = thinking;
    let stored: any = {};
    try {
      stored = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const encryptedKeys =
      stored.formatVersion === 2
        ? (stored.encryptedKeys ?? {})
        : { default: stored.encryptedKey };
    await this.write({
      formatVersion: 2,
      ...this.validate(settings),
      encryptedKeys,
    });
    return this.publicSettings();
  }
}
