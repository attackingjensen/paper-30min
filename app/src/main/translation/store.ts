// 译文侧车原子存储（SPEC-translation §4，paper-30min-crd.2）：
// unit 文件先完整写入并核验，再以同目录临时文件＋替换原子推进 index.json；
// index 是此语言当前投影的唯一指针，未引用文件不是当前译文。
// stale/gap 是读取时对照当前原文树推导的投影状态，不回写单元文件。
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Type from "typebox";
import Schema from "typebox/schema";
import { renameManaged } from "../managed-rename.js";
import { openProject, readRevisionDocument, withProjectWriteLock } from "../project-core.js";
import { documentNodeContentFingerprint } from "../../shared/document/changeset.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import type { ReaderUnitContent } from "../../shared/reader/projection.js";
import type {
  TranslationGenerator,
  TranslationIndex,
  TranslationInlinePart,
  TranslationLanguage,
  TranslationProjection,
  TranslationUnitContent,
  TranslationUnitFile,
  TranslationUnitIndexEntry,
} from "../../shared/translation/contracts.js";
import { maximumUnitBytes } from "./model-io.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const indexBudget = 64 * 1024 * 1024;
const maximumLanguageContentBytes = 64 * 1024 * 1024;

const InlinePartSchema = Type.Union([
  Type.Object({ kind: Type.Literal("text"), text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("atom"), atomId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
const GeneratorSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    promptVersion: Type.Integer({ minimum: 1 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const SentenceDigestSchema = Type.Object(
  {
    sentenceId: Type.String({ minLength: 1 }),
    sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
const UnitFileSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    unitId: Type.String({ minLength: 1 }),
    generator: GeneratorSchema,
    sentences: Type.Array(
      Type.Object(
        {
          sentenceId: Type.String({ minLength: 1 }),
          sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          content: Type.Array(InlinePartSchema, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const RetiredEntrySchema = Type.Object(
  {
    sentenceId: Type.String({ minLength: 1 }),
    unitId: Type.String({ minLength: 1 }),
    reason: Type.Union([Type.Literal("removed"), Type.Literal("split"), Type.Literal("merged")]),
    excerpt: Type.String(),
    content: Type.Array(InlinePartSchema, { minItems: 1 }),
    generator: GeneratorSchema,
  },
  { additionalProperties: false },
);
const IndexSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    baseRevision: Type.String({ minLength: 1 }),
    language: Type.Union([Type.Literal("zh"), Type.Literal("en")]),
    translationRevision: Type.String({ minLength: 1 }),
    logicalContentBytes: Type.Integer({ minimum: 0 }),
    units: Type.Array(
      Type.Object(
        {
          unitId: Type.String({ minLength: 1 }),
          file: Type.String({ minLength: 1 }),
          generator: GeneratorSchema,
          logicalBytes: Type.Integer({ minimum: 0 }),
          sentences: Type.Array(SentenceDigestSchema),
        },
        { additionalProperties: false },
      ),
    ),
    retired: Type.Optional(Type.Array(RetiredEntrySchema)),
  },
  { additionalProperties: false },
);
const unitFileSchema = Schema.Compile(UnitFileSchema);
const indexSchema = Schema.Compile(IndexSchema);

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** 译文逻辑内容摘要：text 计自身，atom 计原句 atom 的逻辑文本（与任务预算同口径）。 */
export function translationLogicalContent(parts: readonly TranslationInlinePart[], tree: DocumentTree): string {
  return parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      const atom = tree.atoms[part.atomId];
      if (!atom) throw new Error(`译文 atom 缺少来源逻辑内容：${part.atomId}。`);
      return atom.text;
    })
    .join("");
}

/** 逐句内容摘要：原句用 document-core 内容指纹（含 atom 结构），译文用逻辑内容。 */
export function translationSentenceDigests(
  tree: DocumentTree,
  sourceUnit: ReaderUnitContent,
  sentences: TranslationUnitContent["sentences"],
): Array<{ sentenceId: string; sourceSha256: string; translationSha256: string }> {
  return sentences.map((sentence) => {
    const source = sourceUnit.sentences.find((candidate) => candidate.sentenceId === sentence.sentenceId);
    if (!source) throw new Error(`译文句子缺少对应原句：${sentence.sentenceId}。`);
    return {
      sentenceId: sentence.sentenceId,
      sourceSha256: digest(documentNodeContentFingerprint(tree, "sentence", sentence.sentenceId)),
      translationSha256: digest(translationLogicalContent(sentence.content, tree)),
    };
  });
}

export interface TranslationCommitHooks {
  /** index 替换前故障注入点；抛错时旧 index 与旧译文保持权威。 */
  beforeIndexReplace?: () => void | Promise<void>;
  /** index 替换后故障注入点；提交已可见，抛错不回滚。 */
  afterIndexReplace?: () => void | Promise<void>;
}

export interface CommitTranslationUnitInput {
  root: string;
  baseRevision: string;
  language: TranslationLanguage;
  generator: TranslationGenerator;
  unit: TranslationUnitContent;
  digests: Array<{ sentenceId: string; sourceSha256: string; translationSha256: string }>;
  /** 句级合并提交：只替换本次提供的句子，保留同单元其他已提交句（含 stale）。
   * 缺省为整单元提交：句子 ID、数量与顺序必须与 current 单元完全一致。 */
  merge?: boolean;
  hooks?: TranslationCommitHooks;
}

async function managedDirectory(root: string, relative: string, create: boolean) {
  let target = root;
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === ".." || part.includes("\\")) throw new Error("译文侧车路径无效。");
    target = path.join(target, part);
    let entry;
    try {
      entry = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
      await fs.mkdir(target);
      entry = await fs.lstat(target);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("译文受管目录不能通过符号链接、目录联接或普通文件访问。");
  }
  return target;
}

async function readJsonFile(file: string, budget: number, description: string): Promise<unknown> {
  const entry = await fs.lstat(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > budget)
    throw new Error(`${description}无效或超过读取预算。`);
  const bytes = await fs.readFile(file);
  if (bytes.byteLength > budget) throw new Error(`${description}超过读取预算。`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${description}损坏；请保留现场检查。`);
  }
}

async function atomicWriteJson(destination: string, value: unknown, budget: number, description: string) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (bytes.byteLength > budget) throw new Error(`${description}超过写入预算，未发布。`);
  const temporary = path.join(path.dirname(destination), `.paper30min-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameManaged(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** index 契约校验（读取与迁移共用）：损坏或与请求不一致时明确拒绝。 */
export function parseTranslationIndex(
  value: unknown,
  baseRevision: string,
  language: TranslationLanguage,
): TranslationIndex {
  if (!indexSchema.Check(value)) throw new Error("译文 index 损坏或不符合契约。");
  if (value.baseRevision !== baseRevision || value.language !== language || !uuid.test(value.translationRevision))
    throw new Error("译文 index 与请求的 revision／语言不一致。");
  const seen = new Set<string>();
  for (const entry of value.units) {
    if (!uuid.test(entry.unitId) || entry.file !== `units/${entry.unitId}.json` || seen.has(entry.unitId))
      throw new Error("译文 index 单元条目无效或重复。");
    seen.add(entry.unitId);
  }
  return value;
}

/** 单元文件契约校验（读取与迁移共用）：身份与逐句摘要必须与 index 一致。 */
export function parseTranslationUnitFile(value: unknown, entry: TranslationUnitIndexEntry): TranslationUnitFile {
  if (!unitFileSchema.Check(value)) throw new Error(`译文单元文件损坏：${entry.unitId}。`);
  if (value.unitId !== entry.unitId) throw new Error(`译文单元文件身份与 index 不一致：${entry.unitId}。`);
  if (
    value.sentences.length !== entry.sentences.length ||
    value.sentences.some((sentence, index) => {
      const expected = entry.sentences[index];
      return (
        sentence.sentenceId !== expected.sentenceId ||
        sentence.sourceSha256 !== expected.sourceSha256 ||
        sentence.translationSha256 !== expected.translationSha256
      );
    })
  )
    throw new Error(`译文单元摘要与 index 不一致：${entry.unitId}。`);
  return value;
}

/** 单元原子提交：unit 文件完整写入并核验后，才以临时文件＋替换推进 index。
 * 整单元提交要求句子与 current 完全一致；merge 提交只替换目标句（局部 stale
 * 更新与补译的最小提交单位），其余已提交句原样保留。失败保留旧 index 与旧译文。 */
export async function commitTranslationUnit(
  input: CommitTranslationUnitInput,
): Promise<{ translationRevision: string; logicalContentBytes: number }> {
  if (!uuid.test(input.baseRevision)) throw new Error("baseRevision 必须是 revision ID。");
  if (input.language !== "zh" && input.language !== "en") throw new Error("目标语言无效。");
  const root = await fs.realpath(input.root);
  const opened = await openProject(root);
  if (!opened.currentRevision || opened.currentRevision.revisionId !== input.baseRevision)
    throw new Error("译文提交的 baseRevision 不是当前 current，拒绝写入过期侧车。");
  const tree = await readRevisionDocument(root, input.baseRevision, "document");
  const sourceUnit = tree.units[input.unit.unitId];
  if (!sourceUnit) throw new Error(`译文单元不存在于 current 树：${input.unit.unitId}。`);
  if (input.unit.sentences.length === 0) throw new Error("译文提交不能为空单元。");

  const digestBySentence = new Map(input.digests.map((entry) => [entry.sentenceId, entry]));
  const incoming = input.unit.sentences.map((sentence) => {
    const digests = digestBySentence.get(sentence.sentenceId);
    if (!digests || !sourceUnit.sentenceIds.includes(sentence.sentenceId))
      throw new Error(`译文句子缺少摘要或不属于该单元：${sentence.sentenceId}。`);
    const sourceSha256 = digest(documentNodeContentFingerprint(tree, "sentence", sentence.sentenceId));
    const translationSha256 = digest(translationLogicalContent(sentence.content, tree));
    if (digests.sourceSha256 !== sourceSha256 || digests.translationSha256 !== translationSha256)
      throw new Error(`译文摘要与提交内容不一致：${sentence.sentenceId}。`);
    return { ...sentence, sourceSha256, translationSha256 };
  });
  const incomingIds = new Set(incoming.map((sentence) => sentence.sentenceId));
  if (incomingIds.size !== incoming.length) throw new Error("译文提交包含重复句子。");
  if (!input.merge) {
    if (
      incoming.length !== sourceUnit.sentenceIds.length ||
      incoming.some((sentence, index) => sentence.sentenceId !== sourceUnit.sentenceIds[index])
    )
      throw new Error("译文句子 ID、数量或顺序与 current 单元不一致。");
  }

  return withProjectWriteLock(root, async () => {
    const relative = `.paper30min/revisions/${input.baseRevision}/translations/${input.language}`;
    const directory = await managedDirectory(root, relative, true);
    if (!directory) throw new Error("译文侧车目录不可用。");
    const unitsDirectory = await managedDirectory(root, `${relative}/units`, true);
    if (!unitsDirectory) throw new Error("译文单元目录不可用。");

    let previous: TranslationIndex | null = null;
    try {
      previous = parseTranslationIndex(
        await readJsonFile(path.join(directory, "index.json"), indexBudget, "译文 index"),
        input.baseRevision,
        input.language,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const previousEntry = previous?.units.find((entry) => entry.unitId === input.unit.unitId);
    let previousFile: TranslationUnitFile | null = null;
    if (previousEntry) {
      previousFile = parseTranslationUnitFile(
        await readJsonFile(path.join(directory, previousEntry.file), maximumUnitBytes, "译文单元文件"),
        previousEntry,
      );
    }
    // 合并提交：以旧文件为底，只替换目标句；句子顺序以 current 单元为权威。
    // 旧文件中不属于 current 单元的句子（迁移残留）不进入新文件。
    const kept = (previousFile?.sentences ?? []).filter(
      (sentence) => sourceUnit.sentenceIds.includes(sentence.sentenceId) && !incomingIds.has(sentence.sentenceId),
    );
    const byId = new Map([...kept, ...incoming].map((sentence) => [sentence.sentenceId, sentence]));
    const sentences = sourceUnit.sentenceIds.flatMap((sentenceId) => {
      const sentence = byId.get(sentenceId);
      return sentence ? [sentence] : [];
    });
    if (!input.merge && sentences.length !== sourceUnit.sentenceIds.length)
      throw new Error("译文句子 ID、数量或顺序与 current 单元不一致。");

    const unitFile: TranslationUnitFile = {
      formatVersion: 1,
      unitId: input.unit.unitId,
      generator: input.generator,
      sentences,
    };
    const logicalBytes = Buffer.byteLength(
      sentences.map((sentence) => translationLogicalContent(sentence.content, tree)).join(""),
      "utf8",
    );
    const logicalContentBytes =
      (previous?.logicalContentBytes ?? 0) - (previousEntry?.logicalBytes ?? 0) + logicalBytes;
    if (logicalContentBytes > maximumLanguageContentBytes)
      throw new Error("单元译文使单语言逻辑内容超过 64 MiB 预算，未发布。");

    const entry: TranslationUnitIndexEntry = {
      unitId: input.unit.unitId,
      file: `units/${input.unit.unitId}.json`,
      generator: input.generator,
      logicalBytes,
      sentences: sentences.map(({ sentenceId, sourceSha256, translationSha256 }) => ({
        sentenceId,
        sourceSha256,
        translationSha256,
      })),
    };
    // 替换已有单元时先写未引用临时单元文件；index 推进前旧译文持续可读，
    // 崩溃留下的未引用文件不作为当前投影。
    const finalUnitFile = path.join(unitsDirectory, `${input.unit.unitId}.json`);
    const stagedUnitFile = previousEntry
      ? path.join(unitsDirectory, `.paper30min-${randomUUID()}.staged.json`)
      : finalUnitFile;
    await atomicWriteJson(stagedUnitFile, unitFile, maximumUnitBytes, "译文单元文件");
    parseTranslationUnitFile(await readJsonFile(stagedUnitFile, maximumUnitBytes, "译文单元文件"), entry);

    const translationRevision = randomUUID();
    const next: TranslationIndex = {
      formatVersion: 1,
      baseRevision: input.baseRevision,
      language: input.language,
      translationRevision,
      logicalContentBytes,
      units: [...(previous?.units.filter((candidate) => candidate.unitId !== input.unit.unitId) ?? []), entry],
      ...(previous?.retired && previous.retired.length > 0 ? { retired: previous.retired } : {}),
    };
    const indexFile = path.join(directory, "index.json");
    const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n");
    if (bytes.byteLength > indexBudget) throw new Error("译文 index 超过 64 MiB 写入预算，未发布。");
    const temporary = path.join(directory, `.paper30min-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await input.hooks?.beforeIndexReplace?.();
      if (stagedUnitFile !== finalUnitFile) await renameManaged(stagedUnitFile, finalUnitFile);
      await renameManaged(temporary, indexFile);
    } finally {
      await fs.rm(temporary, { force: true });
      if (stagedUnitFile !== finalUnitFile) await fs.rm(stagedUnitFile, { force: true });
    }
    await input.hooks?.afterIndexReplace?.();
    return { translationRevision, logicalContentBytes };
  });
}

/** 离线读取已提交投影：只认 index 引用的单元文件；stale/gap 对照当前树推导。
 * 无 index 返回空投影（全部 gap 由消费方按原文补齐），不猜测未引用文件。 */
export async function readTranslationProjection(
  root: string,
  baseRevision: string,
  language: TranslationLanguage,
): Promise<TranslationProjection> {
  if (!uuid.test(baseRevision)) throw new Error("baseRevision 必须是 revision ID。");
  if (language !== "zh" && language !== "en") throw new Error("目标语言无效。");
  const canonical = await fs.realpath(root);
  const tree = await readRevisionDocument(canonical, baseRevision, "document");
  const directory = await managedDirectory(
    canonical,
    `.paper30min/revisions/${baseRevision}/translations/${language}`,
    false,
  );
  const task = await readTranslationTaskRecord(canonical, baseRevision, language);
  const taskFacts = task ? { status: task.status, gaps: task.gaps } : null;
  const empty: TranslationProjection = {
    baseRevision,
    language,
    translationRevision: null,
    sourceLanguage: null,
    units: [],
    task: taskFacts,
  };
  if (!directory) return empty;
  let index: TranslationIndex;
  try {
    index = parseTranslationIndex(
      await readJsonFile(path.join(directory, "index.json"), indexBudget, "译文 index"),
      baseRevision,
      language,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }

  const units: TranslationProjection["units"] = [];
  for (const entry of index.units) {
    const file = parseTranslationUnitFile(
      await readJsonFile(path.join(directory, entry.file), maximumUnitBytes, "译文单元文件"),
      entry,
    );
    const sourceUnit = tree.units[entry.unitId];
    const stored = new Map(file.sentences.map((sentence) => [sentence.sentenceId, sentence]));
    const sentences = (sourceUnit?.sentenceIds ?? []).map((sentenceId) => {
      const sentence = stored.get(sentenceId);
      if (!sentence) return { sentenceId, status: "gap" as const, content: null };
      const currentSha256 = digest(documentNodeContentFingerprint(tree, "sentence", sentenceId));
      if (currentSha256 !== sentence.sourceSha256)
        return {
          sentenceId,
          status: "stale" as const,
          staleReason: "source-changed" as const,
          content: sentence.content,
        };
      if (digest(translationLogicalContent(sentence.content, tree)) !== sentence.translationSha256)
        throw new Error(`译文内容摘要不符：${sentenceId}。`);
      return { sentenceId, status: "ready" as const, content: sentence.content };
    });
    units.push({ unitId: entry.unitId, generator: file.generator, sentences });
  }
  return {
    baseRevision,
    language,
    translationRevision: index.translationRevision,
    sourceLanguage: null,
    units,
    task: taskFacts,
    retired: index.retired ?? [],
  };
}

/** 任务记录（task.json）：pending/failed 属于任务事实，不能冒充 ready。
 * 与 index 分离：崩溃或失败不污染已提交投影。 */
export interface TranslationTaskRecord {
  formatVersion: 1;
  baseRevision: string;
  language: TranslationLanguage;
  status: "running" | "finished";
  updatedAt: string;
  gaps: Array<{ unitId: string; diagnostic: string }>;
}

const TaskRecordSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    baseRevision: Type.String({ minLength: 1 }),
    language: Type.Union([Type.Literal("zh"), Type.Literal("en")]),
    status: Type.Union([Type.Literal("running"), Type.Literal("finished")]),
    updatedAt: Type.String({ minLength: 1 }),
    gaps: Type.Array(
      Type.Object(
        { unitId: Type.String({ minLength: 1 }), diagnostic: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const taskRecordSchema = Schema.Compile(TaskRecordSchema);

export async function writeTranslationTaskRecord(
  root: string,
  baseRevision: string,
  language: TranslationLanguage,
  record: Pick<TranslationTaskRecord, "status" | "gaps">,
): Promise<void> {
  if (!uuid.test(baseRevision)) throw new Error("baseRevision 必须是 revision ID。");
  const directory = await managedDirectory(
    await fs.realpath(root),
    `.paper30min/revisions/${baseRevision}/translations/${language}`,
    true,
  );
  if (!directory) throw new Error("译文侧车目录不可用。");
  const value: TranslationTaskRecord = {
    formatVersion: 1,
    baseRevision,
    language,
    updatedAt: new Date().toISOString(),
    ...record,
  };
  await atomicWriteJson(path.join(directory, "task.json"), value, indexBudget, "翻译任务记录");
}

async function readTranslationTaskRecord(
  root: string,
  baseRevision: string,
  language: TranslationLanguage,
): Promise<TranslationTaskRecord | null> {
  const directory = await managedDirectory(
    await fs.realpath(root),
    `.paper30min/revisions/${baseRevision}/translations/${language}`,
    false,
  );
  if (!directory) return null;
  let value: unknown;
  try {
    value = await readJsonFile(path.join(directory, "task.json"), indexBudget, "翻译任务记录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!taskRecordSchema.Check(value) || value.baseRevision !== baseRevision || value.language !== language)
    throw new Error("翻译任务记录损坏或与请求不一致；请保留现场检查。");
  return value;
}
