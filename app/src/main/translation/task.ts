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

type TranslationUnitResult =
  | { status: "ready"; unit: TranslationUnitContent }
  | { status: "gap"; unitId: string; diagnostic: string };

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
  context?: {
    paperTitle?: string;
    sectionPath?: readonly string[];
  };
  generate: (input: TranslationModelInput) => Promise<string>;
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
        diagnostic: "缺少模型上下文与输出预算，请检查模型配置。",
      })),
    };

  const results: TranslationUnitResult[] = [];
  let languageContentBytes = 0;
  for (const sourceUnit of options.units) {
    try {
      const requestOptions = {
        baseRevision: options.baseRevision,
        modelBudget,
        sourceLanguage: options.sourceLanguage,
        targetLanguage,
        context: options.context,
      };
      const fragments = planTranslationUnitRequests({ ...requestOptions, unit: sourceUnit });
      const sentences: TranslationUnitContent["sentences"] = [];
      for (const fragment of fragments) {
        const input = createTranslationModelInput({ ...requestOptions, unit: fragment });
        const translated = parseTranslationModelOutput(fragment, await options.generate(input));
        sentences.push(...translated.sentences);
      }
      const unit = { unitId: sourceUnit.unitId, sentences };
      if (Buffer.byteLength(JSON.stringify(unit), "utf8") > maximumUnitBytes)
        throw new TranslationModelBudgetError("重组后的单元译文文件超过 2 MiB 预算。");
      const unitContentBytes = logicalContentBytes(sourceUnit, unit);
      if (languageContentBytes + unitContentBytes > maximumLanguageContentBytes)
        throw new TranslationModelBudgetError("单元译文使单语言逻辑内容超过 64 MiB 预算。");
      languageContentBytes += unitContentBytes;
      results.push({ status: "ready", unit });
    } catch (error) {
      results.push({
        status: "gap",
        unitId: sourceUnit.unitId,
        diagnostic:
          error instanceof TranslationModelOutputError || error instanceof TranslationModelBudgetError
            ? error.message
            : "翻译模型请求失败，请检查模型配置后重试。",
      });
    }
  }
  return { status: "finished", units: results };
}
