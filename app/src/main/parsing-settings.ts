import { safeStorage } from "electron";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultParsingSettings,
  type ParsingSettings,
} from "../shared/parsing.js";

export interface ParsingConfig extends ParsingSettings {
  apiKey: string;
}

export class ParsingSettingsStore {
  constructor(private file: string) {}
  async read(): Promise<ParsingConfig> {
    let value: any;
    try {
      value = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...defaultParsingSettings, apiKey: "" };
      throw new Error("解析配置无法读取，请重新保存。");
    }
    const settings = this.validate(value);
    try {
      return {
        ...settings,
        apiKey: value.encryptedKey
          ? safeStorage.decryptString(Buffer.from(value.encryptedKey, "base64"))
          : "",
      };
    } catch {
      return { ...settings, apiKey: "", hasKey: true, keyError: true };
    }
  }
  async publicSettings(): Promise<ParsingSettings> {
    const { apiKey, ...settings } = await this.read();
    return { ...settings, hasKey: !!apiKey || !!settings.keyError };
  }
  private validate(value: ParsingSettings): ParsingSettings {
    const url = new URL(value.endpoint);
    if (
      (!["https:"].includes(url.protocol) &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.endsWith("/") ||
      value.model !== defaultParsingSettings.model
    )
      throw new Error(
        "解析服务需要 HTTPS 任务地址及 PaddleOCR-VL-1.6 模型；本机服务可用 HTTP。",
      );
    return { endpoint: url.href, model: value.model, hasKey: false };
  }
  async save(settings: ParsingSettings, apiKey?: string, clearKey?: boolean) {
    const validated = this.validate(settings);
    if (
      apiKey !== undefined &&
      (typeof apiKey !== "string" || apiKey.length > 8192)
    )
      throw new Error("百度 Token 无效。");
    let previous: any = {};
    try {
      previous = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !apiKey?.trim() &&
        !clearKey
      )
        throw new Error(
          "解析配置无法读取，请重新填写配置和百度 Token，或明确清除旧凭据。",
        );
    }
    let encryptedKey = clearKey ? undefined : previous.encryptedKey;
    if (!clearKey && apiKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统凭据加密不可用。");
      encryptedKey = safeStorage
        .encryptString(apiKey.trim())
        .toString("base64");
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify(
          { formatVersion: 1, ...validated, encryptedKey },
          null,
          2,
        ),
        { flag: "wx" },
      );
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return this.publicSettings();
  }
}
