import { safeStorage } from "electron";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultAgentSettings,
  type AgentSettings,
} from "../shared/contracts.js";

export interface ModelConfig extends AgentSettings {
  apiKey: string;
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

export class AgentSettingsStore {
  constructor(private file: string) {}
  async read(): Promise<ModelConfig> {
    try {
      const { encryptedKey, ...settings } = JSON.parse(
        await fs.readFile(this.file, "utf8"),
      );
      const apiKey = encryptedKey
        ? safeStorage.decryptString(Buffer.from(encryptedKey, "base64"))
        : "";
      return { ...this.validate(settings), hasKey: !!apiKey, apiKey };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...defaultAgentSettings, apiKey: "" };
      throw new Error("模型配置无法读取，请重新保存本机配置。");
    }
  }
  async publicSettings(): Promise<AgentSettings> {
    const { apiKey: _key, ...settings } = await this.read();
    return settings;
  }
  private validate(settings: AgentSettings): AgentSettings {
    if (
      !settings ||
      ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ].includes(settings.api)
    )
      throw new Error("不支持此模型协议。");
    if (
      typeof settings.baseUrl !== "string" ||
      typeof settings.proxyUrl !== "string"
    )
      throw new Error("模型或代理地址无效。");
    if (settings.baseUrl) validateUrl(settings.baseUrl, "模型端点");
    if (!["direct", "environment", "custom"].includes(settings.proxy))
      throw new Error("代理模式无效。");
    if (settings.proxy === "custom") validateUrl(settings.proxyUrl, "代理");
    if (
      typeof settings.model !== "string" ||
      settings.model.length > 256 ||
      !Number.isInteger(settings.contextWindow) ||
      settings.contextWindow < 1024 ||
      settings.contextWindow > 2000000 ||
      !Number.isInteger(settings.maxTokens) ||
      settings.maxTokens < 1 ||
      settings.maxTokens > settings.contextWindow
    )
      throw new Error("模型名称或 token 预算无效。");
    return {
      api: settings.api,
      baseUrl: settings.baseUrl.trim(),
      model: settings.model.trim(),
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
      proxy: settings.proxy,
      proxyUrl: settings.proxyUrl.trim(),
      hasKey: false,
    };
  }
  async save(settings: AgentSettings, apiKey?: string, clearKey?: boolean) {
    const validated = this.validate(settings);
    if (
      apiKey !== undefined &&
      (typeof apiKey !== "string" || apiKey.length > 8192)
    )
      throw new Error("API 密钥无效。");
    // Explicit key replacement or removal can recover unreadable settings without silently discarding a key.
    const key = clearKey ? "" : apiKey?.trim() || (await this.read()).apiKey;
    if (key && !safeStorage.isEncryptionAvailable())
      throw new Error("系统凭据加密不可用，无法保存 API 密钥。");
    // Only these public fields may enter the file; the renderer cannot persist extra secrets.
    const value = {
      ...validated,
      encryptedKey: key
        ? safeStorage.encryptString(key).toString("base64")
        : "",
    };
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
    return this.publicSettings();
  }
}
