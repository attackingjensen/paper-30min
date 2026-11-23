// 模型响应缓存回归（SPEC-translation §9，paper-30min-crd.7）：
// 缓存键覆盖原句/atom 内容、上下文、语言、provider/model 与协议版本；
// 存储只保存完整合法响应，损坏/键不匹配条目降级 miss 并删除，不抛错。
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, test } from "@playwright/test";
import { parseDocumentTree } from "../src/shared/document/tree";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import type { TranslationGenerator } from "../src/shared/translation/contracts";
import {
  createTranslationMetaInput,
  createTranslationModelInput,
  translationProtocolVersions,
} from "../src/main/translation/model-io";
import { createTranslationResponseCache, translationCacheKey } from "../src/main/translation/response-cache";
import { complexReaderTree } from "./fixtures/reader/complex-document";

const budget = { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 };

type CacheGenerator = TranslationGenerator & { normalizationVersion: number };

const generator: CacheGenerator = {
  provider: "openai-completions",
  model: "controlled-translate",
  ...translationProtocolVersions,
};

function unitFixture(): ReaderUnitContent {
  const paperId = randomUUID();
  const { tree, ids } = complexReaderTree(paperId);
  const projection = buildReaderProjection(parseDocumentTree(tree, paperId));
  const item = projection.items.find((candidate) => candidate.kind === "unit" && candidate.unitId === ids.abstract);
  if (!item || item.kind !== "unit") throw new Error("测试单元不存在。");
  return item;
}

function unitInput(unit: ReaderUnitContent) {
  return createTranslationModelInput({
    baseRevision: "revision-current",
    modelBudget: budget,
    sourceLanguage: "en",
    targetLanguage: "zh",
    unit,
    context: { paperTitle: "Reading paper", sectionPath: ["Abstract"] },
  });
}

function metaInput() {
  return createTranslationMetaInput({
    baseRevision: "revision-current",
    modelBudget: budget,
    sourceLanguage: "en",
    targetLanguage: "zh",
    sources: {
      paperTitle: "Reading paper",
      sections: [{ sectionId: "section-1", title: "1 Introduction" }],
      rawBlocks: [{ blockId: "raw-1", text: "Quoted source line." }],
    },
  });
}

test.describe("translation 响应缓存键", () => {
  test("同输入确定性同键；键为 64 位十六进制摘要", () => {
    const input = unitInput(unitFixture());
    const first = translationCacheKey({ generator, input });
    const second = translationCacheKey({ generator, input });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("语言、模型、provider、协议版本、上下文、句内容与 atom 内容各自隔离键", () => {
    const unit = unitFixture();
    const baseInput = unitInput(unit);
    const keys = new Set<string>([translationCacheKey({ generator, input: baseInput })]);
    const record = (key: string) => {
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    };

    record(translationCacheKey({ generator: { ...generator, provider: "anthropic-messages" }, input: baseInput }));
    record(translationCacheKey({ generator: { ...generator, model: "other-model" }, input: baseInput }));
    record(
      translationCacheKey({
        generator: { ...generator, promptVersion: generator.promptVersion + 1 },
        input: baseInput,
      }),
    );
    record(
      translationCacheKey({
        generator: { ...generator, schemaVersion: generator.schemaVersion + 1 },
        input: baseInput,
      }),
    );
    record(
      translationCacheKey({
        generator: { ...generator, normalizationVersion: generator.normalizationVersion + 1 },
        input: baseInput,
      }),
    );

    // 语言/上下文变化经构造器重建（prompt 与字段一致），与生产输入同口径。
    const rebuild = (overrides: Partial<Parameters<typeof createTranslationModelInput>[0]>) =>
      translationCacheKey({
        generator,
        input: createTranslationModelInput({
          baseRevision: "revision-current",
          modelBudget: budget,
          sourceLanguage: "en",
          targetLanguage: "zh",
          unit,
          context: { paperTitle: "Reading paper", sectionPath: ["Abstract"] },
          ...overrides,
        }),
      });
    record(rebuild({ targetLanguage: "en" }));
    record(rebuild({ context: { paperTitle: "Another paper", sectionPath: ["Abstract"] } }));

    const otherContent = structuredClone(baseInput);
    otherContent.unit.sentences[0].content = otherContent.unit.sentences[0].content.replace(
      "We study reading.",
      "We study writing.",
    );
    record(translationCacheKey({ generator, input: otherContent }));

    const otherUnitId = structuredClone(baseInput);
    otherUnitId.unit.unitId = randomUUID();
    record(translationCacheKey({ generator, input: otherUnitId }));

    const otherSentenceId = structuredClone(baseInput);
    otherSentenceId.unit.sentences[0].sentenceId = randomUUID();
    record(translationCacheKey({ generator, input: otherSentenceId }));

    // 表面文本相同（占位符不变）但 atom 逻辑内容不同：不得复用。
    const otherAtomUnit = structuredClone(unit);
    const atomPart = otherAtomUnit.sentences[0].parts.find((part) => part.kind === "atom");
    if (!atomPart || atomPart.kind !== "atom") throw new Error("测试 atom 不存在。");
    atomPart.atom.text = "E=mc^3";
    const otherAtomInput = unitInput(otherAtomUnit);
    expect(otherAtomInput.unit).toEqual(baseInput.unit);
    record(translationCacheKey({ generator, input: otherAtomInput, unit: otherAtomUnit }));
  });

  test("meta 请求与 unit 请求键域隔离；meta 目标内容改变键", () => {
    const unitKey = translationCacheKey({ generator, input: unitInput(unitFixture()) });
    const base = metaInput();
    const metaKey = translationCacheKey({ generator, input: base });
    expect(metaKey).not.toBe(unitKey);
    const changed = createTranslationMetaInput({
      baseRevision: "revision-current",
      modelBudget: budget,
      sourceLanguage: "en",
      targetLanguage: "zh",
      sources: {
        paperTitle: "Reading paper",
        sections: [{ sectionId: "section-1", title: "2 Method" }],
        rawBlocks: [{ blockId: "raw-1", text: "Quoted source line." }],
      },
    });
    expect(translationCacheKey({ generator, input: changed })).not.toBe(metaKey);
  });
});

test.describe("translation 响应缓存存储", () => {
  let sandbox: string;

  test.beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-cache-"));
  });

  test.afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const cacheDirectory = (root: string) => path.join(root, ".paper30min", "cache", "translation");

  test("完整合法条目命中返回原始响应；缺失键返回 undefined", async () => {
    const cache = createTranslationResponseCache(sandbox);
    const key = translationCacheKey({ generator, input: unitInput(unitFixture()) });
    const raw = JSON.stringify({ unitId: "u", sentences: [] });
    expect(await cache.read(key)).toBeUndefined();
    await cache.put(key, raw);
    expect(await cache.read(key)).toBe(raw);
    expect(await cache.read("0".repeat(64))).toBeUndefined();
  });

  test("损坏条目降级 miss 并删除，随后可重建", async () => {
    const cache = createTranslationResponseCache(sandbox);
    const key = translationCacheKey({ generator, input: unitInput(unitFixture()) });
    await cache.put(key, '{"unitId":"u"}');
    const file = path.join(cacheDirectory(sandbox), `${key}.json`);
    await fs.writeFile(file, "{broken");
    expect(await cache.read(key)).toBeUndefined();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await cache.put(key, '{"unitId":"u"}');
    expect(await cache.read(key)).toBe('{"unitId":"u"}');
  });

  test("键不匹配或非法条目版本的条目按损坏处理", async () => {
    const cache = createTranslationResponseCache(sandbox);
    const key = translationCacheKey({ generator, input: unitInput(unitFixture()) });
    const file = path.join(cacheDirectory(sandbox), `${key}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, key: "f".repeat(64), response: "x" }));
    expect(await cache.read(key)).toBeUndefined();
    await fs.writeFile(file, JSON.stringify({ version: 999, key, response: "x" }));
    expect(await cache.read(key)).toBeUndefined();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("超过单元响应预算的响应不写入缓存", async () => {
    const cache = createTranslationResponseCache(sandbox);
    const key = translationCacheKey({ generator, input: unitInput(unitFixture()) });
    await cache.put(key, "x".repeat(2 * 1024 * 1024 + 1));
    expect(await cache.read(key)).toBeUndefined();
    await expect(fs.stat(path.join(cacheDirectory(sandbox), `${key}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("缓存目录被普通文件占据时读写静默降级，不抛错", async () => {
    await fs.mkdir(path.join(sandbox, ".paper30min"), { recursive: true });
    await fs.writeFile(path.join(sandbox, ".paper30min", "cache"), "占位文件");
    const cache = createTranslationResponseCache(sandbox);
    const key = translationCacheKey({ generator, input: unitInput(unitFixture()) });
    await cache.put(key, "{}");
    expect(await cache.read(key)).toBeUndefined();
  });
});
