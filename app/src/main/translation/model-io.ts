import Type from "typebox";
import Schema from "typebox/schema";
import type { ReaderSentence, ReaderUnitContent } from "../../shared/reader/projection.js";
import type { TranslationLanguage, TranslationUnitContent } from "../../shared/translation/contracts.js";

export const maximumUnitBytes = 2 * 1024 * 1024;

/** 翻译协议版本事实：prompt 文本变化必须递增 promptVersion（SPEC §2.7）；
 * generator 记录与模型输入共用同一来源，避免两处字面量漂移。 */
export const translationProtocolVersions = { promptVersion: 3, schemaVersion: 2, normalizationVersion: 1 } as const;
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
  normalizationVersion: typeof translationProtocolVersions.normalizationVersion;
  context?: CreateTranslationModelInputOptions["context"];
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
    ...(options.context === undefined ? {} : { context: options.context }),
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

/** 标题/raw 元数据翻译目标（SPEC §3.4/§3.7）：论文标题是元数据，不制造新 unit；
 * 无标题 section 不进入请求；raw 只携带安全文本投影，不携带 HTML。 */
export interface TranslationMetaSources {
  paperTitle: string | null;
  sections: Array<{ sectionId: string; title: string }>;
  rawBlocks: Array<{ blockId: string; text: string }>;
}

export interface TranslationMetaContent {
  paperTitle: string | null;
  sections: Array<{ sectionId: string; title: string }>;
  rawBlocks: Array<{ blockId: string; text: string }>;
}

const MetaResponseSchema = Type.Object(
  {
    paperTitle: Type.Union([Type.String(), Type.Null()]),
    sections: Type.Array(
      Type.Object({ sectionId: Type.String({ minLength: 1 }), title: Type.String() }, { additionalProperties: false }),
    ),
    rawBlocks: Type.Array(
      Type.Object({ blockId: Type.String({ minLength: 1 }), text: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
const metaResponseSchema = Schema.Compile(MetaResponseSchema);

export interface CreateTranslationMetaInputOptions {
  baseRevision: string;
  modelBudget: TranslationModelBudget;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  sources: TranslationMetaSources;
}

export interface TranslationMetaInput {
  baseRevision: string;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  promptVersion: typeof translationProtocolVersions.promptVersion;
  schemaVersion: typeof translationProtocolVersions.schemaVersion;
  normalizationVersion: typeof translationProtocolVersions.normalizationVersion;
  maxTokens: number;
  estimatedInputTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

export function createTranslationMetaInput(options: CreateTranslationMetaInputOptions): TranslationMetaInput {
  const inputBudget = inputTokenBudget(options.modelBudget);
  const systemPrompt = [
    "你是论文元数据翻译器，只翻译输入指定的论文标题、章节标题与 raw 文本投影。",
    "只返回符合所给 JSON schema 的 JSON，不返回 Markdown、HTML、摘要或工具调用。",
    "章节标题必须保留输入 sectionId，不得新增、遗漏或为无标题章节命名。",
    "raw 文本只输出安全译文文本，不得返回 HTML 标签或结构。",
    "论文标题输入为 null 时输出 null，不得凭空生成标题。",
  ].join("\n");
  const userPrompt = JSON.stringify({
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    responseSchema: MetaResponseSchema,
    paperTitle: options.sources.paperTitle,
    sections: options.sources.sections,
    rawBlocks: options.sources.rawBlocks,
  });
  const estimatedInputTokens = estimatedTokens(systemPrompt) + estimatedTokens(userPrompt);
  if (estimatedInputTokens > inputBudget)
    throw new TranslationModelBudgetError(
      `元数据翻译请求超过模型输入预算：估算 ${estimatedInputTokens}，可用 ${inputBudget}。`,
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
  };
}

function metaText(value: string, label: string): string {
  const content = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!content) invalid(`${label} 没有目标内容。`);
  if (htmlPattern.test(content)) invalid(`${label} 包含 HTML 或额外结构。`);
  return content;
}

export interface TranslationMetaParseResult {
  content: TranslationMetaContent;
  /** 逐项失败诊断（SPEC §4.1 合法项先提交，失败项留 gap）；空数组表示全部合法。 */
  failures: string[];
}

export function parseTranslationMetaOutput(sources: TranslationMetaSources, raw: string): TranslationMetaParseResult {
  if (Buffer.byteLength(raw, "utf8") > maximumUnitBytes) invalid("元数据响应超过 2 MiB 预算。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("响应不是 JSON。");
  }
  if (!metaResponseSchema.Check(value)) invalid("响应不符合受控 JSON schema。");
  const failures: string[] = [];

  let paperTitle: string | null = null;
  if (sources.paperTitle === null) {
    if (value.paperTitle !== null) failures.push("来源无论文标题，模型不得凭空生成。");
  } else if (value.paperTitle === null) {
    failures.push("论文标题缺少目标内容。");
  } else {
    try {
      paperTitle = metaText(value.paperTitle, "论文标题");
    } catch (error) {
      failures.push((error as Error).message);
    }
  }

  const expectedSections = sources.sections.map((section) => section.sectionId);
  const actualSections = value.sections.map((section) => section.sectionId);
  const sections: TranslationMetaContent["sections"] = [];
  if (
    actualSections.length !== expectedSections.length ||
    actualSections.some((sectionId, index) => sectionId !== expectedSections[index])
  ) {
    failures.push("section 标题 ID、数量或顺序与请求不一致（不得为无标题 section 命名）。");
  } else {
    for (const [index, section] of value.sections.entries()) {
      try {
        sections.push({
          sectionId: section.sectionId,
          title: metaText(section.title, `section ${sources.sections[index].title}`),
        });
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
  }

  const expectedRaw = sources.rawBlocks.map((block) => block.blockId);
  const actualRaw = value.rawBlocks.map((block) => block.blockId);
  const rawBlocks: TranslationMetaContent["rawBlocks"] = [];
  if (actualRaw.length !== expectedRaw.length || actualRaw.some((blockId, index) => blockId !== expectedRaw[index])) {
    failures.push("raw block ID、数量或顺序与请求不一致。");
  } else {
    for (const [index, block] of value.rawBlocks.entries()) {
      try {
        rawBlocks.push({
          blockId: block.blockId,
          text: metaText(block.text, `raw ${sources.rawBlocks[index].blockId}`),
        });
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
  }
  return { content: { paperTitle, sections, rawBlocks }, failures };
}
