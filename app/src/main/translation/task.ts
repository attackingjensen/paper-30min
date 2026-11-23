import type { ReaderUnitContent } from "../../shared/reader/projection.js";
import type { TranslationLanguage, TranslationUnitContent } from "../../shared/translation/contracts.js";
import {
  createTranslationModelInput,
  maximumUnitBytes,
  parseTranslationModelOutput,
  planTranslationUnitRequests,
  TranslationModelBudgetError,
  TranslationModelOutputError,
  type TranslationModelBudget,
  type TranslationModelInput,
} from "./model-io.js";
import { TranslationModelRequestError } from "./model-request.js";
import {
  translationCacheKey,
  type TranslationCacheGenerator,
  type TranslationResponseCache,
} from "./response-cache.js";

/** 失败分类（SPEC §6.4）：网络/限流/超时/鉴权/停止与输出、预算、提交分别记录。 */
type TranslationFailureKind =
  | "network"
  | "rate-limit"
  | "timeout"
  | "auth"
  | "aborted"
  | "output"
  | "budget"
  | "commit";

/** 分类诊断文案：不含密钥、代理配置或原始服务响应正文。 */
const failureMessages: Record<TranslationFailureKind, string> = {
  network: "翻译模型网络请求失败，请检查网络与模型服务后重试。",
  "rate-limit": "翻译模型服务限流，请稍后重试。",
  timeout: "翻译模型请求超时，请稍后重试。",
  auth: "翻译模型鉴权失败，请在设置中检查 API 密钥。",
  aborted: "翻译已停止：未发送批次已取消，已完成译文保留。",
  output: "翻译模型输出无效。",
  budget: "翻译超出预算。",
  commit: "译文写入失败，旧译文保持不变。",
};

interface TranslationSentenceFailure {
  sentenceId: string;
  kind: TranslationFailureKind;
  diagnostic: string;
}

type TranslationUnitResult =
  | { status: "ready"; unitId: string; unit: TranslationUnitContent; committed: boolean }
  | { status: "gap"; unitId: string; sentenceFailures: TranslationSentenceFailure[] };

export type TranslationTaskResult =
  | {
      status: "skipped";
      reason: "not-selected" | "same-language" | "already-generated";
      units: [];
    }
  | { status: "finished"; units: TranslationUnitResult[] };

export interface TranslationTaskOptions {
  baseRevision: string;
  modelBudget?: TranslationModelBudget;
  sourceLanguage: TranslationLanguage;
  selectedLanguage?: TranslationLanguage;
  generatedLanguages?: readonly TranslationLanguage[];
  units: readonly ReaderUnitContent[];
  /** 已提交且与当前原句摘要一致的单元→句子集合；恢复时跳过，不重复请求。 */
  committedSentences?: ReadonlyMap<string, ReadonlySet<string>>;
  context?: {
    paperTitle?: string;
    sectionPath?: readonly string[];
  };
  /** 对已有 unit 的 fill-gaps/update-stale：每个目标句独立计划、校验、merge 提交，
   * 一句失败不拖累同 unit 其他合法目标句；初次 generate 缺省保持 unit 原子。 */
  sentenceAtomic?: boolean;
  signal?: AbortSignal;
  /** 每个新 fragment/unit 调度前复核 current 与取消状态；false 即停止调度。 */
  ensureCurrent?: () => Promise<boolean>;
  generate: (input: TranslationModelInput) => Promise<string>;
  /** 可重建响应缓存（SPEC §9）：命中仍走同一校验，完整合法响应才写入；缺省不缓存。
   * generator 提供 provider/model 与协议版本键成分（与提交事实同源）。 */
  responseCache?: { cache: TranslationResponseCache; generator: TranslationCacheGenerator };
  onUnitReady?: (unit: TranslationUnitContent) => Promise<void>;
}

const maximumLanguageContentBytes = 64 * 1024 * 1024;

function logicalContentBytes(sourceUnit: ReaderUnitContent, translated: TranslationUnitContent) {
  const sourceAtoms = new Map<string, string>();
  for (const sentence of sourceUnit.sentences) {
    for (const part of sentence.parts) if (part.kind === "atom") sourceAtoms.set(part.atom.id, part.atom.text);
  }
  let bytes = 0;
  for (const sentence of translated.sentences) {
    for (const part of sentence.content) {
      if (part.kind === "text") {
        bytes += Buffer.byteLength(part.text, "utf8");
      } else {
        const sourceText = sourceAtoms.get(part.atomId);
        if (sourceText === undefined) throw new Error("译文 atom 缺少来源逻辑内容。");
        bytes += Buffer.byteLength(sourceText, "utf8");
      }
    }
  }
  return bytes;
}

function classifyFailure(error: unknown, aborted: boolean): { kind: TranslationFailureKind; diagnostic: string } {
  if (error instanceof TranslationModelOutputError) return { kind: "output", diagnostic: error.message };
  if (error instanceof TranslationModelBudgetError) return { kind: "budget", diagnostic: error.message };
  if (error instanceof TranslationModelRequestError)
    return { kind: error.kind, diagnostic: failureMessages[error.kind] };
  if (aborted) return { kind: "aborted", diagnostic: failureMessages.aborted };
  if (error instanceof Error && error.name === "AbortError")
    return { kind: "aborted", diagnostic: failureMessages.aborted };
  return { kind: "network", diagnostic: failureMessages.network };
}

export async function runTranslationTask(options: TranslationTaskOptions): Promise<TranslationTaskResult> {
  const targetLanguage = options.selectedLanguage;
  if (!targetLanguage) return { status: "skipped", reason: "not-selected", units: [] };
  if (targetLanguage === options.sourceLanguage) return { status: "skipped", reason: "same-language", units: [] };
  if (options.generatedLanguages?.includes(targetLanguage))
    return { status: "skipped", reason: "already-generated", units: [] };

  const modelBudget = options.modelBudget;
  if (!modelBudget)
    return {
      status: "finished",
      units: options.units.map((unit) => ({
        status: "gap",
        unitId: unit.unitId,
        sentenceFailures: unit.sentences.map((sentence) => ({
          sentenceId: sentence.sentenceId,
          kind: "budget" as const,
          diagnostic: "缺少模型上下文与输出预算，请检查模型配置。",
        })),
      })),
    };

  const results: TranslationUnitResult[] = [];
  let languageContentBytes = 0;
  const requestOptions = {
    baseRevision: options.baseRevision,
    modelBudget,
    sourceLanguage: options.sourceLanguage,
    targetLanguage,
    context: options.context,
  };
  // 响应缓存接线：命中不绕过 parse 校验；仅完整合法片段响应入缓存，失败/部分 unit 不写。
  const generateFragment = async (input: TranslationModelInput, fragment: ReaderUnitContent) => {
    const responseCache = options.responseCache;
    const cached = responseCache
      ? await responseCache.cache.read(
          translationCacheKey({ generator: responseCache.generator, input, unit: fragment }),
        )
      : undefined;
    if (cached !== undefined) return parseTranslationModelOutput(fragment, cached);
    const raw = await options.generate(input);
    const translated = parseTranslationModelOutput(fragment, raw);
    if (responseCache)
      await responseCache.cache.put(
        translationCacheKey({ generator: responseCache.generator, input, unit: fragment }),
        raw,
      );
    return translated;
  };
  for (const sourceUnit of options.units) {
    const committed = options.committedSentences?.get(sourceUnit.unitId);
    if (
      committed &&
      sourceUnit.sentences.length > 0 &&
      sourceUnit.sentences.every((sentence) => committed.has(sentence.sentenceId))
    ) {
      // 已提交内容以存储为权威；这里只报告完成，不重发请求。
      results.push({
        status: "ready",
        unitId: sourceUnit.unitId,
        committed: true,
        unit: {
          unitId: sourceUnit.unitId,
          sentences: sourceUnit.sentences.map((sentence) => ({ sentenceId: sentence.sentenceId, content: [] })),
        },
      });
      continue;
    }
    if (options.sentenceAtomic) {
      // 已有 unit 的句级最小提交：逐句独立计划、校验、merge 发布与诊断。
      const readySentences: TranslationUnitContent["sentences"] = [];
      const failures: TranslationSentenceFailure[] = [];
      for (const sentence of sourceUnit.sentences) {
        const single = { ...sourceUnit, sentences: [sentence] };
        try {
          if (options.signal?.aborted || (options.ensureCurrent && !(await options.ensureCurrent())))
            throw options.signal?.reason ?? new Error("翻译任务已停止调度。");
          const fragments = planTranslationUnitRequests({ ...requestOptions, unit: single });
          const sentences: TranslationUnitContent["sentences"] = [];
          let assembledBytes = Buffer.byteLength(JSON.stringify({ unitId: sourceUnit.unitId, sentences: [] }), "utf8");
          for (const fragment of fragments) {
            if (options.signal?.aborted || (options.ensureCurrent && !(await options.ensureCurrent())))
              throw options.signal?.reason ?? new Error("翻译任务已停止调度。");
            const input = createTranslationModelInput({ ...requestOptions, unit: fragment });
            const translated = await generateFragment(input, fragment);
            sentences.push(...translated.sentences);
            assembledBytes += Buffer.byteLength(JSON.stringify(translated.sentences), "utf8");
            if (assembledBytes > maximumUnitBytes)
              throw new TranslationModelBudgetError("重组后的单元译文文件超过 2 MiB 预算。");
          }
          const unit = { unitId: sourceUnit.unitId, sentences };
          const unitContentBytes = logicalContentBytes(sourceUnit, unit);
          if (languageContentBytes + unitContentBytes > maximumLanguageContentBytes)
            throw new TranslationModelBudgetError("单元译文使单语言逻辑内容超过 64 MiB 预算。");
          try {
            await options.onUnitReady?.(unit);
          } catch (error) {
            const aborted = options.signal?.aborted ?? false;
            failures.push({
              sentenceId: sentence.sentenceId,
              ...(aborted
                ? { kind: "aborted" as const, diagnostic: failureMessages.aborted }
                : {
                    kind: "commit" as const,
                    diagnostic: `${failureMessages.commit}${(error as Error).message}`,
                  }),
            });
            continue;
          }
          // 只有确定提交成功后才占用本轮语言预算；发布失败不占预算。
          languageContentBytes += unitContentBytes;
          readySentences.push(...sentences);
        } catch (error) {
          failures.push({
            sentenceId: sentence.sentenceId,
            ...classifyFailure(error, options.signal?.aborted ?? false),
          });
        }
      }
      results.push(
        failures.length === 0
          ? {
              status: "ready",
              unitId: sourceUnit.unitId,
              committed: false,
              unit: { unitId: sourceUnit.unitId, sentences: readySentences },
            }
          : { status: "gap", unitId: sourceUnit.unitId, sentenceFailures: failures },
      );
      continue;
    }
    try {
      const fragments = planTranslationUnitRequests({ ...requestOptions, unit: sourceUnit });
      const sentences: TranslationUnitContent["sentences"] = [];
      let assembledBytes = Buffer.byteLength(JSON.stringify({ unitId: sourceUnit.unitId, sentences: [] }), "utf8");
      for (const fragment of fragments) {
        // 每个新 fragment 调度前复核 current 与取消状态；已推进即停止，不冒充普通 gap 补试。
        if (options.signal?.aborted || (options.ensureCurrent && !(await options.ensureCurrent())))
          throw options.signal?.reason ?? new Error("翻译任务已停止调度。");
        const input = createTranslationModelInput({ ...requestOptions, unit: fragment });
        const translated = await generateFragment(input, fragment);
        sentences.push(...translated.sentences);
        // 每追加一个 fragment 即累计重组 unit 大小；超限立即停止后续片段。
        assembledBytes += Buffer.byteLength(JSON.stringify(translated.sentences), "utf8");
        if (assembledBytes > maximumUnitBytes)
          throw new TranslationModelBudgetError("重组后的单元译文文件超过 2 MiB 预算。");
      }
      const unit = { unitId: sourceUnit.unitId, sentences };
      const unitContentBytes = logicalContentBytes(sourceUnit, unit);
      if (languageContentBytes + unitContentBytes > maximumLanguageContentBytes)
        throw new TranslationModelBudgetError("单元译文使单语言逻辑内容超过 64 MiB 预算。");
      try {
        await options.onUnitReady?.(unit);
      } catch (error) {
        const aborted = options.signal?.aborted ?? false;
        results.push({
          status: "gap",
          unitId: sourceUnit.unitId,
          sentenceFailures: sourceUnit.sentences.map((sentence) => ({
            sentenceId: sentence.sentenceId,
            ...(aborted
              ? { kind: "aborted" as const, diagnostic: failureMessages.aborted }
              : { kind: "commit" as const, diagnostic: `${failureMessages.commit}${(error as Error).message}` }),
          })),
        });
        continue;
      }
      // 只有确定提交成功后才占用本轮语言预算；发布失败不占预算（R9）。
      languageContentBytes += unitContentBytes;
      results.push({ status: "ready", unitId: sourceUnit.unitId, unit, committed: false });
    } catch (error) {
      const failure = classifyFailure(error, options.signal?.aborted ?? false);
      results.push({
        status: "gap",
        unitId: sourceUnit.unitId,
        sentenceFailures: sourceUnit.sentences.map((sentence) => ({ sentenceId: sentence.sentenceId, ...failure })),
      });
    }
  }
  return { status: "finished", units: results };
}
