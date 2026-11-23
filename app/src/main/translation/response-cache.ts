// 模型响应缓存（SPEC-translation §9，paper-30min-crd.7）：
// .paper30min/cache/translation/ 是可重建优化，不是译文权威，不与已提交 index 混用。
// 键覆盖原句/atom 内容、上下文、语言、provider/model 与 prompt/schema/规范化版本；
// 只由调用方在完整合法响应产生后写入。损坏、键不匹配或超预算条目按 miss 降级并删除，
// 读写失败一律静默降级重新请求；不保存 API key、Authorization、代理配置或服务原始响应头。
import { createHash, randomUUID } from "node:crypto";
import Type from "typebox";
import Schema from "typebox/schema";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ReaderUnitContent } from "../../shared/reader/projection.js";
import type { TranslationGenerator } from "../../shared/translation/contracts.js";
import { renameManaged } from "../managed-rename.js";
import { maximumUnitBytes, type TranslationMetaInput, type TranslationModelInput } from "./model-io.js";

/** 缓存条目格式版本：改变存储结构必须递增，旧版本条目按损坏处理。 */
const cacheEntryVersion = 1;

const cacheEntrySchema = Schema.Compile(
  Type.Object(
    {
      version: Type.Literal(cacheEntryVersion),
      key: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      response: Type.String(),
    },
    { additionalProperties: false },
  ),
);

/** 缓存 generator 事实：协议三版本必须齐全（模型输入与 session.generator 均满足）。 */
export type TranslationCacheGenerator = TranslationGenerator & { normalizationVersion: number };

/** 缓存键：模型实际收到的 prompt 全文（含 unit/atom 占位、上下文、语言、schema）
 * ＋generator 与协议版本＋atom 完整逻辑内容（占位符隐藏的部分）＋unit/sentence 身份。
 * 表面文本相同但 atom、上下文或模型配置不同的请求不得复用结果（SPEC §9.2/§9.4）。 */
export function translationCacheKey(options: {
  generator: TranslationCacheGenerator;
  input: TranslationModelInput | TranslationMetaInput;
  unit?: ReaderUnitContent;
}): string {
  const { generator, input, unit } = options;
  const atoms =
    unit === undefined
      ? null
      : unit.sentences.flatMap((sentence) =>
          sentence.parts.flatMap((part) =>
            part.kind === "atom" ? [{ unitId: unit.unitId, sentenceId: sentence.sentenceId, atom: part.atom }] : [],
          ),
        );
  return createHash("sha256")
    .update(
      JSON.stringify({
        entryVersion: cacheEntryVersion,
        generator,
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        normalizationVersion: input.normalizationVersion,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        unit: "unit" in input ? input.unit : null,
        atoms,
      }),
    )
    .digest("hex");
}

export interface TranslationResponseCache {
  /** 命中返回缓存的完整响应文本；miss、损坏或读取失败返回 undefined（损坏条目删除）。 */
  read(key: string): Promise<string | undefined>;
  /** 只接受完整合法响应；超预算或写入失败静默跳过，不影响任务。 */
  put(key: string, response: string): Promise<void>;
}

export function createTranslationResponseCache(root: string): TranslationResponseCache {
  const directory = path.join(root, ".paper30min", "cache", "translation");
  const entryFile = (key: string) => path.join(directory, `${key}.json`);

  return {
    read: async (key) => {
      const file = entryFile(key);
      let raw: string;
      try {
        const entry = await fs.lstat(file);
        if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maximumUnitBytes * 2) return undefined;
        raw = await fs.readFile(file, "utf8");
      } catch {
        return undefined;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = undefined;
      }
      if (value === undefined || !cacheEntrySchema.Check(value) || value.key !== key) {
        await fs.rm(file, { force: true }).catch(() => undefined);
        return undefined;
      }
      return value.response;
    },
    put: async (key, response) => {
      if (Buffer.byteLength(response, "utf8") > maximumUnitBytes) return;
      const bytes = Buffer.from(JSON.stringify({ version: cacheEntryVersion, key, response }) + "\n");
      let temporary: string | undefined;
      try {
        await fs.mkdir(directory, { recursive: true });
        temporary = path.join(directory, `.paper30min-${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, "wx");
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await renameManaged(temporary, entryFile(key));
      } catch {
        // 缓存写入失败只是失去优化：任务继续按在线请求路径执行。
      } finally {
        if (temporary !== undefined) await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
}
