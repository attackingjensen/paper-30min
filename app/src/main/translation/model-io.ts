import Type from "typebox";
import Schema from "typebox/schema";
import type { ReaderSentence, ReaderUnitContent } from "../../shared/reader/projection.js";
import type { TranslationLanguage, TranslationUnitContent } from "../../shared/translation/contracts.js";

export const maximumUnitBytes = 2 * 1024 * 1024;

/** 翻译协议版本事实：prompt 文本变化必须递增 promptVersion（SPEC §2.7）；
 * generator 记录与模型输入共用同一来源，避免两处字面量漂移。 */
export const translationProtocolVersions = { promptVersion: 2, schemaVersion: 1 } as const;
const atomTokenPattern = /⟦atom:([^⟧]+)⟧/g;
const htmlPattern = /<!--|<!doctype|<\?|<\/?[a-z][^>]*>/i;

const TranslationResponseSchema = Type.Object(
  {
    unitId: Type.String({ minLength: 1 }),
    sentences: Type.Array(
      Type.Object(
        {
          sentenceId: Type.String({ minLength: 1 }),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const translationResponseSchema = Schema.Compile(TranslationResponseSchema);

export class TranslationModelOutputError extends Error {
  constructor(message: string) {
    super(`翻译模型输出无效：${message}`);
    this.name = "TranslationModelOutputError";
  }
}

export class TranslationModelBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationModelBudgetError";
  }
}

export interface TranslationModelBudget {
  contextWindow: number;
  maxTokens: number;
  safetyMarginTokens: number;
}

function inputTokenBudget(budget: TranslationModelBudget) {
  if (
    !Number.isInteger(budget.contextWindow) ||
    budget.contextWindow < 1 ||
    !Number.isInteger(budget.maxTokens) ||
    budget.maxTokens < 1 ||
    !Number.isInteger(budget.safetyMarginTokens) ||
    budget.safetyMarginTokens < 0
  )
    throw new TranslationModelBudgetError("翻译模型预算无效：窗口、输出和安全余量必须是有效整数。");
  const available = budget.contextWindow - budget.maxTokens - budget.safetyMarginTokens;
  if (available < 1) throw new TranslationModelBudgetError("翻译模型预算无效：没有可用的输入窗口。");
  return available;
}

function estimatedTokens(value: string) {
  // UTF-8 字节数是保守的协议预算单位：宁可提前拆句，也不靠截断适配模型窗口。
  return Buffer.byteLength(value, "utf8");
}

function invalid(message: string): never {
  throw new TranslationModelOutputError(message);
}

interface TranslationModelUnit {
  unitId: string;
  sentences: Array<{ sentenceId: string; content: string }>;
}

export interface TranslationModelInput {
  baseRevision: string;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  promptVersion: typeof translationProtocolVersions.promptVersion;
  schemaVersion: typeof translationProtocolVersions.schemaVersion;
  maxTokens: number;
  estimatedInputTokens: number;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: typeof TranslationResponseSchema;
  unit: TranslationModelUnit;
}

export interface CreateTranslationModelInputOptions {
  baseRevision: string;
  modelBudget: TranslationModelBudget;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  unit: ReaderUnitContent;
  context?: {
    paperTitle?: string;
    sectionPath?: readonly string[];
  };
}

function modelText(sentence: ReaderSentence) {
  return sentence.parts.map((part) => (part.kind === "text" ? part.text : `⟦atom:${part.atom.id}⟧`)).join("");
}

export function createTranslationModelInput(options: CreateTranslationModelInputOptions): TranslationModelInput {
  const inputBudget = inputTokenBudget(options.modelBudget);
  const unit = {
    unitId: options.unit.unitId,
    sentences: options.unit.sentences.map((sentence) => ({
      sentenceId: sentence.sentenceId,
      content: modelText(sentence),
    })),
  };
  const systemPrompt = [
    "你是论文全文翻译器，只翻译输入指定的句子。",
    "只返回符合所给 JSON schema 的 JSON，不返回 Markdown、HTML、摘要或工具调用。",
    "句子 ID、数量和顺序必须与输入完全一致，不得合并、拆分、遗漏、新增句子或修正原文。",
    "⟦atom:...⟧ 占位符必须留在对应原句且各出现一次，不得改写或新增。",
    "作者姓名、DOI、arXiv 编号等标识符以及参考文献条目中的作者名保持原文，不翻译或转写；期刊名与标题按目标语言翻译。",
  ].join("\n");
  const userPrompt = JSON.stringify({
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    context: options.context ?? {},
    responseSchema: TranslationResponseSchema,
    unit,
  });
  const estimatedInputTokens = estimatedTokens(systemPrompt) + estimatedTokens(userPrompt);
  if (estimatedInputTokens > inputBudget)
    throw new TranslationModelBudgetError(
      `翻译请求超过模型输入预算：估算 ${estimatedInputTokens}，可用 ${inputBudget}。`,
    );
  return {
    baseRevision: options.baseRevision,
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    ...translationProtocolVersions,
    maxTokens: options.modelBudget.maxTokens,
    estimatedInputTokens,
    systemPrompt,
    userPrompt,
    responseSchema: TranslationResponseSchema,
    unit,
  };
}

export function planTranslationUnitRequests(options: CreateTranslationModelInputOptions): ReaderUnitContent[] {
  const inputBudget = inputTokenBudget(options.modelBudget);
  const emptyInput = createTranslationModelInput({ ...options, unit: { ...options.unit, sentences: [] } });
  const fragments: ReaderUnitContent[] = [];
  let currentSentences: ReaderSentence[] = [];
  let currentTokens = emptyInput.estimatedInputTokens;

  const flush = () => {
    if (currentSentences.length === 0) return;
    fragments.push({ ...options.unit, sentences: currentSentences });
    currentSentences = [];
    currentTokens = emptyInput.estimatedInputTokens;
  };

  for (const sentence of options.unit.sentences) {
    const sentenceTokens = estimatedTokens(
      JSON.stringify({ sentenceId: sentence.sentenceId, content: modelText(sentence) }),
    );
    if (emptyInput.estimatedInputTokens + sentenceTokens > inputBudget)
      throw new TranslationModelBudgetError(`句子 ${sentence.sentenceId} 超过模型输入预算，未截断或发送。`);
    if (currentTokens + 1 + sentenceTokens > inputBudget) flush();
    currentSentences.push(sentence);
    currentTokens += sentenceTokens;
    if (currentSentences.length > 1) currentTokens += 1;
  }
  flush();
  if (fragments.length === 0) return [{ ...options.unit, sentences: [] }];
  return fragments;
}

function atomCounts(ids: readonly string[]) {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function sameCounts(left: Map<string, number>, right: Map<string, number>) {
  if (left.size !== right.size) return false;
  for (const [id, count] of left) if (right.get(id) !== count) return false;
  return true;
}

function parseSentence(sentence: ReaderSentence, rawContent: string): TranslationUnitContent["sentences"][number] {
  const content = rawContent.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!content) invalid(`句子 ${sentence.sentenceId} 没有目标内容。`);
  if (htmlPattern.test(content)) invalid(`句子 ${sentence.sentenceId} 包含 HTML 或额外结构。`);

  const matches = [...content.matchAll(atomTokenPattern)];
  const remainder = content.replace(atomTokenPattern, "");
  if (remainder.includes("⟦") || remainder.includes("⟧"))
    invalid(`句子 ${sentence.sentenceId} 包含无法识别的 atom 占位。`);

  const expectedAtoms = sentence.parts.flatMap((part) => (part.kind === "atom" ? [part.atom.id] : []));
  const actualAtoms = matches.map((match) => match[1]);
  if (!sameCounts(atomCounts(expectedAtoms), atomCounts(actualAtoms)))
    invalid(`句子 ${sentence.sentenceId} 的 atom ID、数量或归属与请求不一致。`);

  const parts: TranslationUnitContent["sentences"][number]["content"] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index;
    if (start > cursor) parts.push({ kind: "text", text: content.slice(cursor, start) });
    parts.push({ kind: "atom", atomId: match[1] });
    cursor = start + match[0].length;
  }
  if (cursor < content.length) parts.push({ kind: "text", text: content.slice(cursor) });
  if (parts.length === 0) invalid(`句子 ${sentence.sentenceId} 没有目标内容。`);
  return { sentenceId: sentence.sentenceId, content: parts };
}

export function parseTranslationModelOutput(unit: ReaderUnitContent, raw: string): TranslationUnitContent {
  if (Buffer.byteLength(raw, "utf8") > maximumUnitBytes) invalid("单元响应超过 2 MiB 预算。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("响应不是 JSON。");
  }
  if (!translationResponseSchema.Check(value)) invalid("响应不符合受控 JSON schema。");
  if (value.unitId !== unit.unitId) invalid("unitId 与请求不一致。");

  const expectedIds = unit.sentences.map((sentence) => sentence.sentenceId);
  const actualIds = value.sentences.map((sentence) => sentence.sentenceId);
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((sentenceId, index) => sentenceId !== expectedIds[index])
  )
    invalid("句子 ID、数量或顺序与请求不一致。");

  return {
    unitId: unit.unitId,
    sentences: unit.sentences.map((sentence, index) => parseSentence(sentence, value.sentences[index].content)),
  };
}
