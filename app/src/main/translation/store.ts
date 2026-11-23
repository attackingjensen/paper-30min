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
import {
  openProject,
  readRevision,
  readRevisionDocument,
  readSourceSnapshot,
  withProjectWriteLock,
} from "../project-core.js";
import { sentenceSourceDigestInput } from "../../shared/document/changeset.js";
import { AtomNodeSchema, type DocumentTree } from "../../shared/document/tree.js";
import type { ReaderUnitContent } from "../../shared/reader/projection.js";
import type {
  TranslationAtomSnapshot,
  TranslationGenerator,
  TranslationIndex,
  TranslationInlinePart,
  TranslationLanguage,
  TranslationPaperTitleEntry,
  TranslationProjection,
  TranslationSectionFile,
  TranslationSectionIndexEntry,
  TranslationUnitContent,
  TranslationUnitFile,
  TranslationUnitIndexEntry,
} from "../../shared/translation/contracts.js";
import { maximumUnitBytes, type TranslationMetaContent, type TranslationMetaSources } from "./model-io.js";

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
    // crd.7 起记录规范化版本；旧侧车缺省仍合法（读取回退不影响既有译文）。
    normalizationVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const SentenceDigestSchema = Type.Object(
  {
    sentenceId: Type.String({ minLength: 1 }),
    sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    generator: GeneratorSchema,
  },
  { additionalProperties: false },
);
const UnitFileSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    unitId: Type.String({ minLength: 1 }),
    sentences: Type.Array(
      Type.Object(
        {
          sentenceId: Type.String({ minLength: 1 }),
          sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          content: Type.Array(InlinePartSchema, { minItems: 1 }),
          generator: GeneratorSchema,
          atoms: Type.Optional(Type.Array(AtomNodeSchema)),
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
          logicalBytes: Type.Integer({ minimum: 0 }),
          sentences: Type.Array(SentenceDigestSchema),
        },
        { additionalProperties: false },
      ),
    ),
    retired: Type.Optional(Type.Array(RetiredEntrySchema)),
    paperTitle: Type.Optional(
      Type.Object(
        {
          source: Type.String({ minLength: 1 }),
          sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          content: Type.String({ minLength: 1 }),
          translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          generator: GeneratorSchema,
        },
        { additionalProperties: false },
      ),
    ),
    sections: Type.Optional(
      Type.Array(
        Type.Object(
          {
            sectionId: Type.String({ minLength: 1 }),
            file: Type.String({ minLength: 1 }),
            logicalBytes: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
const unitFileSchema = Schema.Compile(UnitFileSchema);
const indexSchema = Schema.Compile(IndexSchema);

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** 原句内容摘要（含引用 atom 内容）：shared 确定性输入 + main 侧 SHA-256。 */
export function sentenceSourceDigest(tree: DocumentTree, sentenceId: string): string {
  return digest(sentenceSourceDigestInput(tree, sentenceId));
}

/** 译文逻辑内容摘要：text 计自身，atom 计原句 atom 的逻辑文本（与任务预算同口径）。 */
function translationLogicalContent(parts: readonly TranslationInlinePart[], tree: DocumentTree): string {
  return parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      const atom = tree.atoms[part.atomId];
      if (!atom) throw new Error(`译文 atom 缺少来源逻辑内容：${part.atomId}。`);
      return atom.text;
    })
    .join("");
}

/** 逐句内容摘要：原句用统一 sentence-source 摘要（含引用 atom 内容），译文用逻辑内容。 */
export function translationSentenceDigests(
  tree: DocumentTree,
  sourceUnit: ReaderUnitContent,
  sentences: TranslationUnitContent["sentences"],
): Array<{ sentenceId: string; sourceSha256: string; translationSha256: string }> {
  const sourceIds = new Set(sourceUnit.sentences.map((sentence) => sentence.sentenceId));
  return sentences.map((sentence) => {
    if (!sourceIds.has(sentence.sentenceId)) throw new Error(`译文句子缺少对应原句：${sentence.sentenceId}。`);
    return {
      sentenceId: sentence.sentenceId,
      sourceSha256: sentenceSourceDigest(tree, sentence.sentenceId),
      translationSha256: digest(translationLogicalContent(sentence.content, tree)),
    };
  });
}

/** 已提交句的逻辑文本：优先提交时 atom 快照（旧 atom 可能已改/已删），
 * 快照缺省（旧格式）回退当前树。摘要核验与预算计算共用，不依赖新树仍存在旧 atom。 */
export function storedLogicalText(
  sentence: { content: TranslationInlinePart[]; atoms?: TranslationAtomSnapshot[] },
  tree: DocumentTree,
): string {
  const snapshot = new Map((sentence.atoms ?? []).map((atom) => [atom.id, atom]));
  return sentence.content
    .map((part) => {
      if (part.kind === "text") return part.text;
      const atom = snapshot.get(part.atomId) ?? tree.atoms[part.atomId];
      if (!atom) throw new Error(`译文 atom 缺少快照与来源逻辑内容：${part.atomId}。`);
      return atom.text;
    })
    .join("");
}

/** 提交时从原文树采集译文引用的 atom 完整快照（按出现顺序去重）。 */
function snapshotAtoms(content: TranslationInlinePart[], tree: DocumentTree): TranslationAtomSnapshot[] {
  const seen = new Set<string>();
  const atoms: TranslationAtomSnapshot[] = [];
  for (const part of content) {
    if (part.kind !== "atom" || seen.has(part.atomId)) continue;
    const atom = tree.atoms[part.atomId];
    if (!atom) throw new Error(`译文 atom 缺少来源逻辑内容：${part.atomId}。`);
    seen.add(part.atomId);
    atoms.push(structuredClone(atom));
  }
  return atoms;
}

interface TranslationCommitHooks {
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
    // 每代单元使用不可变版本化文件名：index 推进前后旧 index 始终指向旧文件。
    const validFile = new RegExp(
      `^units/${entry.unitId}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`,
    );
    if (!uuid.test(entry.unitId) || !validFile.test(entry.file) || seen.has(entry.unitId))
      throw new Error("译文 index 单元条目无效或重复。");
    seen.add(entry.unitId);
  }
  const seenSections = new Set<string>();
  for (const entry of value.sections ?? []) {
    const validFile = new RegExp(
      `^sections/${entry.sectionId}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`,
    );
    if (!uuid.test(entry.sectionId) || !validFile.test(entry.file) || seenSections.has(entry.sectionId))
      throw new Error("译文 index section 条目无效或重复。");
    seenSections.add(entry.sectionId);
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
        sentence.translationSha256 !== expected.translationSha256 ||
        JSON.stringify(sentence.generator) !== JSON.stringify(expected.generator)
      );
    })
  )
    throw new Error(`译文单元摘要与 index 不一致：${entry.unitId}。`);
  return value;
}

/** 单元原子提交：每代 unit 写入不可变版本化文件并核验，next index 引用新文件，
 * 最后才以临时文件＋替换推进 index.json；index 推进失败或崩溃时旧 index 仍指向
 * 旧文件，旧译文持续可读，新文件只是未引用残留（延迟清理，不作为当前投影）。
 * current 校验在写锁内复核：迟到提交（current 已推进）明确拒绝，不写锁外旧侧车。
 * 整单元提交要求句子与 current 完全一致；merge 提交只替换目标句（局部 stale
 * 更新与补译的最小提交单位），其余已提交句连同 generator 与 atom 快照原样保留。 */
export async function commitTranslationUnit(
  input: CommitTranslationUnitInput,
): Promise<{ translationRevision: string; logicalContentBytes: number }> {
  if (!uuid.test(input.baseRevision)) throw new Error("baseRevision 必须是 revision ID。");
  if (input.language !== "zh" && input.language !== "en") throw new Error("目标语言无效。");
  const root = await fs.realpath(input.root);
  if (input.unit.sentences.length === 0) throw new Error("译文提交不能为空单元。");
  const digestBySentence = new Map(input.digests.map((entry) => [entry.sentenceId, entry]));
  const incomingIds = new Set(input.unit.sentences.map((sentence) => sentence.sentenceId));
  if (incomingIds.size !== input.unit.sentences.length) throw new Error("译文提交包含重复句子。");

  return withProjectWriteLock(root, async () => {
    const opened = await openProject(root);
    if (!opened.currentRevision || opened.currentRevision.revisionId !== input.baseRevision)
      throw new Error("译文提交的 baseRevision 不是当前 current，拒绝写入过期侧车。");
    const tree = await readRevisionDocument(root, input.baseRevision, "document");
    const sourceUnit = tree.units[input.unit.unitId];
    if (!sourceUnit) throw new Error(`译文单元不存在于 current 树：${input.unit.unitId}。`);
    const sourceIds = new Set(sourceUnit.sentenceIds);
    const incoming = input.unit.sentences.map((sentence) => {
      const digests = digestBySentence.get(sentence.sentenceId);
      if (!digests || !sourceIds.has(sentence.sentenceId))
        throw new Error(`译文句子缺少摘要或不属于该单元：${sentence.sentenceId}。`);
      const sourceSha256 = sentenceSourceDigest(tree, sentence.sentenceId);
      const translationSha256 = digest(translationLogicalContent(sentence.content, tree));
      if (digests.sourceSha256 !== sourceSha256 || digests.translationSha256 !== translationSha256)
        throw new Error(`译文摘要与提交内容不一致：${sentence.sentenceId}。`);
      return {
        ...sentence,
        sourceSha256,
        translationSha256,
        generator: input.generator,
        atoms: snapshotAtoms(sentence.content, tree),
      };
    });
    if (!input.merge) {
      if (
        incoming.length !== sourceUnit.sentenceIds.length ||
        incoming.some((sentence, index) => sentence.sentenceId !== sourceUnit.sentenceIds[index])
      )
        throw new Error("译文句子 ID、数量或顺序与 current 单元不一致。");
    }

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
    // kept 句保留旧摘要、generator 与 atom 快照；旧文件中不属于 current 单元的
    // 句子（迁移残留）不进入新文件。
    const kept = (previousFile?.sentences ?? []).filter(
      (sentence) => sourceIds.has(sentence.sentenceId) && !incomingIds.has(sentence.sentenceId),
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
      sentences,
    };
    // kept 句的逻辑文本以提交时快照为准：旧 atom 已改/已删不阻断后续句级提交。
    const logicalBytes = Buffer.byteLength(
      sentences.map((sentence) => storedLogicalText(sentence, tree)).join(""),
      "utf8",
    );
    const logicalContentBytes =
      (previous?.logicalContentBytes ?? 0) - (previousEntry?.logicalBytes ?? 0) + logicalBytes;
    if (logicalContentBytes > maximumLanguageContentBytes)
      throw new Error("单元译文使单语言逻辑内容超过 64 MiB 预算，未发布。");

    const generation = randomUUID();
    const entry: TranslationUnitIndexEntry = {
      unitId: input.unit.unitId,
      file: `units/${input.unit.unitId}.${generation}.json`,
      logicalBytes,
      sentences: sentences.map(({ sentenceId, sourceSha256, translationSha256, generator }) => ({
        sentenceId,
        sourceSha256,
        translationSha256,
        generator,
      })),
    };
    const newUnitFile = path.join(unitsDirectory, `${input.unit.unitId}.${generation}.json`);
    await atomicWriteJson(newUnitFile, unitFile, maximumUnitBytes, "译文单元文件");
    parseTranslationUnitFile(await readJsonFile(newUnitFile, maximumUnitBytes, "译文单元文件"), entry);

    const translationRevision = randomUUID();
    const next: TranslationIndex = {
      formatVersion: 1,
      baseRevision: input.baseRevision,
      language: input.language,
      translationRevision,
      logicalContentBytes,
      units: [...(previous?.units.filter((candidate) => candidate.unitId !== input.unit.unitId) ?? []), entry],
      ...(previous?.retired && previous.retired.length > 0 ? { retired: previous.retired } : {}),
      ...(previous?.paperTitle ? { paperTitle: previous.paperTitle } : {}),
      ...(previous?.sections && previous.sections.length > 0 ? { sections: previous.sections } : {}),
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
      await renameManaged(temporary, indexFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    // 旧代文件已成为未引用残留：index 推进后才清理；崩溃时残留不作为当前投影。
    if (previousEntry) await fs.rm(path.join(directory, previousEntry.file), { force: true });
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
  const paperTitle = await readPaperTitle(canonical, baseRevision);
  const sources = translationMetaSources(tree, paperTitle);
  const empty: TranslationProjection = {
    baseRevision,
    language,
    translationRevision: null,
    sourceLanguage: null,
    units: [],
    task: taskFacts,
    ...metaProjectionFields(sources, null, new Map()),
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
      if (!sentence)
        return {
          sentenceId,
          status: "gap" as const,
          content: null,
          sourceSha256: null,
          translationSha256: null,
          generator: null,
        };
      const facts = {
        sourceSha256: sentence.sourceSha256,
        translationSha256: sentence.translationSha256,
        generator: sentence.generator,
      };
      // 原句或引用 atom 内容改变、原句/引用 atom 已删除 → 仅该句 stale；
      // stale 展示与 quote 由提交时 atom 快照重建，不依赖当前树。
      let currentSha256: string | null = null;
      try {
        currentSha256 = sentenceSourceDigest(tree, sentenceId);
      } catch {
        currentSha256 = null;
      }
      if (currentSha256 === null || currentSha256 !== sentence.sourceSha256)
        return {
          sentenceId,
          status: "stale" as const,
          staleReason: "source-changed" as const,
          content: sentence.content,
          ...facts,
          ...(sentence.atoms ? { atoms: sentence.atoms } : {}),
        };
      if (digest(storedLogicalText(sentence, tree)) !== sentence.translationSha256)
        throw new Error(`译文内容摘要不符：${sentenceId}。`);
      return { sentenceId, status: "ready" as const, content: sentence.content, ...facts };
    });
    units.push({ unitId: entry.unitId, sentences });
  }
  const sectionFiles = new Map<string, TranslationSectionFile>();
  for (const entry of index.sections ?? []) {
    sectionFiles.set(
      entry.sectionId,
      parseTranslationSectionFile(
        await readJsonFile(path.join(directory, entry.file), maximumUnitBytes, "译文 section 文件"),
        entry,
      ),
    );
  }
  return {
    baseRevision,
    language,
    translationRevision: index.translationRevision,
    sourceLanguage: null,
    units,
    task: taskFacts,
    retired: index.retired ?? [],
    ...metaProjectionFields(sources, index.paperTitle ?? null, sectionFiles),
  };
}

/** 标题/raw 投影字段：对照当前树与来源标题推导三态；无目标时省略字段。 */
function metaProjectionFields(
  sources: TranslationMetaSources,
  paperTitle: TranslationPaperTitleEntry | null,
  sectionFiles: ReadonlyMap<string, TranslationSectionFile>,
): Pick<TranslationProjection, "paperTitle" | "sections" | "rawBlocks"> {
  const fields: Pick<TranslationProjection, "paperTitle" | "sections" | "rawBlocks"> = {};
  if (sources.paperTitle !== null) fields.paperTitle = metaProjection(paperTitle, sources.paperTitle);
  if (sources.sections.length > 0)
    fields.sections = sources.sections.map((section) => ({
      sectionId: section.sectionId,
      ...metaProjection(sectionFiles.get(section.sectionId)?.title ?? null, section.title),
    }));
  if (sources.rawBlocks.length > 0) {
    const rawStored = new Map<string, TranslationSectionFile["rawBlocks"][number]>();
    for (const file of sectionFiles.values()) for (const raw of file.rawBlocks) rawStored.set(raw.blockId, raw);
    fields.rawBlocks = sources.rawBlocks.map((raw) => ({
      blockId: raw.blockId,
      ...metaProjection(rawStored.get(raw.blockId) ?? null, raw.text),
    }));
  }
  return fields;
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
  /** 本记录对应自动尝试的 gap 指纹（SPEC §6.2 每会话限次的持久化依据）：
   * 重开应用后同 baseRevision＋language＋model＋gap 内容不再自动补试。 */
  autoAttemptFingerprint?: string;
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
    autoAttemptFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  },
  { additionalProperties: false },
);
const taskRecordSchema = Schema.Compile(TaskRecordSchema);

export async function writeTranslationTaskRecord(
  root: string,
  baseRevision: string,
  language: TranslationLanguage,
  record: Pick<TranslationTaskRecord, "status" | "gaps"> & { autoAttemptFingerprint?: string },
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

export async function readTranslationTaskRecord(
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

/** 标题/raw 元数据来源（SPEC §3.4/§3.7）：论文标题来自已验证来源快照；
 * 有标题 section 按树顺序；raw 只取安全文本投影（空文本不进入目标）。 */
export function translationMetaSources(tree: DocumentTree, paperTitle: string | null): TranslationMetaSources {
  return {
    paperTitle,
    sections: Object.values(tree.sections)
      .filter((section) => section.title.trim().length > 0)
      .map((section) => ({ sectionId: section.id, title: section.title })),
    rawBlocks: tree.blocks.flatMap((block) =>
      block.kind === "raw" && block.text.trim().length > 0 ? [{ blockId: block.id, text: block.text }] : [],
    ),
  };
}

/** 读取 current revision 对应来源快照的论文标题；缺失或类型不符为 null。 */
export async function readPaperTitle(root: string, revisionId: string): Promise<string | null> {
  const opened = await openProject(root);
  const record =
    opened.currentRevision?.revisionId === revisionId
      ? opened.currentRevision
      : await readRevision(opened.root, revisionId);
  const snapshot = await readSourceSnapshot(opened.root, record.sourceSnapshotId);
  return typeof snapshot.title === "string" && snapshot.title ? snapshot.title : null;
}

const MetaTextEntrySchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    content: Type.String({ minLength: 1 }),
    translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    generator: GeneratorSchema,
  },
  { additionalProperties: false },
);
const SectionFileSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    sectionId: Type.String({ minLength: 1 }),
    title: Type.Union([MetaTextEntrySchema, Type.Null()]),
    rawBlocks: Type.Array(
      Type.Object(
        {
          blockId: Type.String({ minLength: 1 }),
          source: Type.String({ minLength: 1 }),
          sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          content: Type.String({ minLength: 1 }),
          translationSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          generator: GeneratorSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const sectionFileSchema = Schema.Compile(SectionFileSchema);

/** section 文件契约校验（读取与迁移共用）。 */
export function parseTranslationSectionFile(
  value: unknown,
  entry: TranslationSectionIndexEntry,
): TranslationSectionFile {
  if (!sectionFileSchema.Check(value)) throw new Error(`译文 section 文件损坏：${entry.sectionId}。`);
  if (value.sectionId !== entry.sectionId)
    throw new Error(`译文 section 文件身份与 index 不一致：${entry.sectionId}。`);
  return value;
}

export interface CommitTranslationMetaInput {
  root: string;
  baseRevision: string;
  language: TranslationLanguage;
  generator: TranslationGenerator;
  sources: TranslationMetaSources;
  translated: TranslationMetaContent;
  hooks?: TranslationCommitHooks;
}

/** 标题/raw 元数据原子提交：section 文件先完整写入并核验，next index 引用新文件，
 * 最后临时文件＋替换推进 index.json；论文标题作为 index 元数据，不制造新 unit。
 * 与单元提交同一写锁与 current 复核口径；失败保留旧 index。 */
export async function commitTranslationMeta(
  input: CommitTranslationMetaInput,
): Promise<{ translationRevision: string; logicalContentBytes: number }> {
  if (!uuid.test(input.baseRevision)) throw new Error("baseRevision 必须是 revision ID。");
  if (input.language !== "zh" && input.language !== "en") throw new Error("目标语言无效。");
  const root = await fs.realpath(input.root);

  return withProjectWriteLock(root, async () => {
    const opened = await openProject(root);
    if (!opened.currentRevision || opened.currentRevision.revisionId !== input.baseRevision)
      throw new Error("译文提交的 baseRevision 不是当前 current，拒绝写入过期侧车。");
    const tree = await readRevisionDocument(root, input.baseRevision, "document");
    const currentSources = translationMetaSources(tree, input.sources.paperTitle);
    // 目标可以是 current 元数据的子集（只处理 gap/stale）；但不得超出 current。
    const currentSectionIds = new Set(currentSources.sections.map((section) => section.sectionId));
    const currentRawIds = new Set(currentSources.rawBlocks.map((raw) => raw.blockId));
    if (
      input.sources.sections.some((section) => !currentSectionIds.has(section.sectionId)) ||
      input.sources.rawBlocks.some((raw) => !currentRawIds.has(raw.blockId))
    )
      throw new Error("元数据提交目标与 current 树不一致。");
    if (input.translated.paperTitle !== null && input.sources.paperTitle === null)
      throw new Error("来源无论文标题，不得提交凭空生成的标题。");

    const relative = `.paper30min/revisions/${input.baseRevision}/translations/${input.language}`;
    const directory = await managedDirectory(root, relative, true);
    if (!directory) throw new Error("译文侧车目录不可用。");
    const sectionsDirectory = await managedDirectory(root, `${relative}/sections`, true);
    if (!sectionsDirectory) throw new Error("译文 section 目录不可用。");

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

    // 非目标元数据保留旧内容、摘要与 generator：只替换本次目标字段。
    const previousFiles = new Map<string, TranslationSectionFile>();
    for (const entry of previous?.sections ?? []) {
      previousFiles.set(
        entry.sectionId,
        parseTranslationSectionFile(
          await readJsonFile(path.join(directory, entry.file), maximumUnitBytes, "译文 section 文件"),
          entry,
        ),
      );
    }
    const rawById = new Map(tree.blocks.flatMap((block) => (block.kind === "raw" ? [[block.id, block] as const] : [])));
    const rawBySection = new Map<string, TranslationMetaContent["rawBlocks"]>();
    for (const raw of input.translated.rawBlocks) {
      const block = rawById.get(raw.blockId);
      if (!block) throw new Error(`元数据 raw block 不存在：${raw.blockId}。`);
      const bucket = rawBySection.get(block.sectionId) ?? [];
      bucket.push(raw);
      rawBySection.set(block.sectionId, bucket);
    }
    const titleBySection = new Map(input.translated.sections.map((section) => [section.sectionId, section.title]));
    const affected = new Set<string>([
      ...input.translated.sections.map((section) => section.sectionId),
      ...rawBySection.keys(),
    ]);

    const sectionEntries: TranslationSectionIndexEntry[] = (previous?.sections ?? []).filter(
      (entry) => !affected.has(entry.sectionId),
    );
    let logicalContentBytes = previous?.logicalContentBytes ?? 0;
    for (const entry of previous?.sections ?? [])
      if (affected.has(entry.sectionId)) logicalContentBytes -= entry.logicalBytes;

    for (const sectionId of affected) {
      const section = tree.sections[sectionId];
      if (!section) throw new Error(`元数据 section 不存在于 current 树：${sectionId}。`);
      const old = previousFiles.get(sectionId);
      const title = titleBySection.get(sectionId);
      const incomingRaw = new Map((rawBySection.get(sectionId) ?? []).map((raw) => [raw.blockId, raw]));
      const keptRaw = (old?.rawBlocks ?? []).filter((raw) => !incomingRaw.has(raw.blockId) && rawById.has(raw.blockId));
      const file: TranslationSectionFile = {
        formatVersion: 1,
        sectionId,
        title:
          title === undefined
            ? (old?.title ?? null)
            : {
                source: section.title,
                sourceSha256: digest(section.title),
                content: title,
                translationSha256: digest(title),
                generator: input.generator,
              },
        rawBlocks: [
          ...keptRaw,
          ...(rawBySection.get(sectionId) ?? []).map((raw) => {
            const block = rawById.get(raw.blockId)!;
            return {
              blockId: raw.blockId,
              source: block.text,
              sourceSha256: digest(block.text),
              content: raw.text,
              translationSha256: digest(raw.text),
              generator: input.generator,
            };
          }),
        ],
      };
      if (file.title === null && file.rawBlocks.length === 0) continue;
      const logicalBytes = Buffer.byteLength(
        [file.title?.content ?? "", ...file.rawBlocks.map((raw) => raw.content)].join(""),
        "utf8",
      );
      logicalContentBytes += logicalBytes;
      const generation = randomUUID();
      const entry: TranslationSectionIndexEntry = {
        sectionId,
        file: `sections/${sectionId}.${generation}.json`,
        logicalBytes,
      };
      const sectionFile = path.join(sectionsDirectory, `${sectionId}.${generation}.json`);
      await atomicWriteJson(sectionFile, file, maximumUnitBytes, "译文 section 文件");
      parseTranslationSectionFile(await readJsonFile(sectionFile, maximumUnitBytes, "译文 section 文件"), entry);
      sectionEntries.push(entry);
    }
    if (logicalContentBytes > maximumLanguageContentBytes)
      throw new Error("元数据译文使单语言逻辑内容超过 64 MiB 预算，未发布。");

    const paperTitle: TranslationPaperTitleEntry | undefined =
      input.translated.paperTitle !== null && input.sources.paperTitle !== null
        ? {
            source: input.sources.paperTitle,
            sourceSha256: digest(input.sources.paperTitle),
            content: input.translated.paperTitle,
            translationSha256: digest(input.translated.paperTitle),
            generator: input.generator,
          }
        : previous?.paperTitle;

    const translationRevision = randomUUID();
    const next: TranslationIndex = {
      formatVersion: 1,
      baseRevision: input.baseRevision,
      language: input.language,
      translationRevision,
      logicalContentBytes,
      units: previous?.units ?? [],
      ...(previous?.retired && previous.retired.length > 0 ? { retired: previous.retired } : {}),
      ...(paperTitle ? { paperTitle } : {}),
      ...(sectionEntries.length > 0 ? { sections: sectionEntries } : {}),
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
      await renameManaged(temporary, indexFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    // 旧代 section 文件成为未引用残留：index 推进后才清理。
    for (const entry of previous?.sections ?? [])
      if (affected.has(entry.sectionId)) await fs.rm(path.join(directory, entry.file), { force: true });
    await input.hooks?.afterIndexReplace?.();
    return { translationRevision, logicalContentBytes };
  });
}

/** 元数据三态推导：摘要一致 ready；来源变化 stale（保留旧译文）；未提交 gap。 */
function metaProjection(
  stored: { sourceSha256: string; content: string; translationSha256: string } | null | undefined,
  source: string,
): { status: "ready" | "stale" | "gap"; source: string; content: string | null; staleReason?: "source-changed" } {
  if (!stored) return { status: "gap", source, content: null };
  // 与单元同口径：译文内容摘要不符即损坏，明确拒绝而非冒充 ready。
  if (digest(stored.content) !== stored.translationSha256) throw new Error(`元数据译文内容摘要不符：${source}。`);
  if (stored.sourceSha256 !== digest(source))
    return { status: "stale", staleReason: "source-changed", source, content: stored.content };
  return { status: "ready", source, content: stored.content };
}
