// 正文更新后的译文迁移（SPEC-translation §7，paper-30min-crd.3）：
// 新 current 发布前按 document-core changeset 继承已提交译文：
// retained/moved 原样保留，changed 保留旧译文（读取路径推导 stale），added 为 gap，
// removed/split/merge 的旧译文只进失效诊断，不自动重挂；不因 revisionId 改变清空全篇。
// 仅经 translationInheritCommitHooks 注入 commitRevision 的 before-current-replace
// 钩子调用：在串行临界区内、current 替换前执行，提交失败不产生孤儿侧车。
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameManaged } from "../managed-rename.js";
import { openProject, readRevisionDocument, type ProjectCommitHooks } from "../project-core.js";
import { documentNodeExcerpt } from "../../shared/document/changeset.js";
import type { DocumentChangeset, Tombstone } from "../../shared/document/changeset.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import type {
  TranslationIndex,
  TranslationLanguage,
  TranslationRetiredEntry,
  TranslationUnitFile,
} from "../../shared/translation/contracts.js";
import { maximumUnitBytes } from "./model-io.js";
import { parseTranslationIndex, parseTranslationUnitFile, storedLogicalText } from "./store.js";

const languages: TranslationLanguage[] = ["zh", "en"];
const indexBudget = 64 * 1024 * 1024;
const maximumLanguageContentBytes = 64 * 1024 * 1024;

/** 受管目录（与 store 同口径）：拒绝符号链接、目录联接与普通文件冒充。 */
async function managedDirectory(root: string, relative: string, create: boolean) {
  let target = root;
  for (const part of relative.split("/")) {
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

/** 迁移一种语言：旧 index 引用的单元逐句继承到新 revision 侧车。
 * 保留句的内容与摘要事实原样复制；新 index 原子推进后才可见。 */
async function migrateLanguage(input: {
  root: string;
  baseRevision: string;
  revisionId: string;
  language: TranslationLanguage;
  baseDocument: DocumentTree;
  document: DocumentTree;
  changeset: DocumentChangeset;
  tombstones: Tombstone[];
}): Promise<void> {
  const relative = `.paper30min/revisions/${input.baseRevision}/translations/${input.language}`;
  const source = await managedDirectory(input.root, relative, false);
  if (!source) return;
  let index: TranslationIndex;
  try {
    index = parseTranslationIndex(
      await readJsonFile(path.join(source, "index.json"), indexBudget, "译文 index"),
      input.baseRevision,
      input.language,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  // 退役原因以本次 revision 的 tombstone 为准（split/merged 显式原因优先）；
  // 历史 tombstone 不参与本次迁移判定。
  const retiredReason = new Map<string, TranslationRetiredEntry["reason"]>();
  for (const tombstone of input.tombstones) {
    if (tombstone.nodeType !== "sentence" || tombstone.lastRevision !== input.baseRevision) continue;
    if (tombstone.reason === "removed" || tombstone.reason === "split" || tombstone.reason === "merged")
      retiredReason.set(tombstone.nodeId, tombstone.reason);
  }
  const removedSentences = new Set(
    input.changeset.changes
      .filter((change) => change.nodeType === "sentence" && change.status === "removed")
      .map((change) => change.nodeId),
  );

  // 新树全局 sentence→unit 归属：跨 unit moved 句按新归属迁移（不 stale、不 tombstone），
  // 多个旧 unit 的保留句可汇入同一目标 unit。
  const ownerBySentence = new Map<string, string>();
  for (const unit of Object.values(input.document.units))
    for (const sentenceId of unit.sentenceIds) ownerBySentence.set(sentenceId, unit.id);
  const keptByUnit = new Map<string, TranslationUnitFile["sentences"]>();
  const retired: TranslationRetiredEntry[] = [...(index.retired ?? [])];
  for (const entry of index.units) {
    const file = parseTranslationUnitFile(
      await readJsonFile(path.join(source, entry.file), maximumUnitBytes, "译文单元文件"),
      entry,
    );
    for (const sentence of file.sentences) {
      const owner = ownerBySentence.get(sentence.sentenceId);
      if (owner) {
        const bucket = keptByUnit.get(owner) ?? [];
        bucket.push(sentence);
        keptByUnit.set(owner, bucket);
        continue;
      }
      // 新树中不存在的旧句：removed/split/merge 只进失效诊断，不重挂到相似新句。
      const reason =
        retiredReason.get(sentence.sentenceId) ?? (removedSentences.has(sentence.sentenceId) ? "removed" : null);
      if (!reason) throw new Error(`译文句子无法可靠延续到新 current：${sentence.sentenceId}。`);
      retired.push({
        sentenceId: sentence.sentenceId,
        unitId: entry.unitId,
        reason,
        excerpt: documentNodeExcerpt(input.baseDocument, "sentence", sentence.sentenceId),
        content: sentence.content,
        generator: sentence.generator,
      });
    }
  }

  const units: TranslationIndex["units"] = [];
  const staged: Array<{ file: string; bytes: Buffer }> = [];
  let logicalContentBytes = 0;
  for (const [unitId, kept] of keptByUnit) {
    const currentUnit = input.document.units[unitId];
    // 句子顺序以新树为权威（moved 更新阅读位置）；内容、摘要、generator 与 atom 快照原样保留。
    const byId = new Map(kept.map((sentence) => [sentence.sentenceId, sentence]));
    const sentences = currentUnit.sentenceIds.flatMap((sentenceId) => {
      const sentence = byId.get(sentenceId);
      return sentence ? [sentence] : [];
    });
    // 继承句的逻辑文本以提交时快照为准：旧 atom 已改/已删不阻断 current 发布。
    const logicalBytes = Buffer.byteLength(
      sentences.map((sentence) => storedLogicalText(sentence, input.document)).join(""),
      "utf8",
    );
    const unitFile: TranslationUnitFile = { formatVersion: 1, unitId, sentences };
    const bytes = Buffer.from(JSON.stringify(unitFile, null, 2) + "\n");
    if (bytes.byteLength > maximumUnitBytes) throw new Error(`迁移译文单元超过 2 MiB 预算：${unitId}。`);
    const file = `units/${unitId}.${randomUUID()}.json`;
    staged.push({ file, bytes });
    units.push({
      unitId,
      file,
      logicalBytes,
      sentences: sentences.map(({ sentenceId, sourceSha256, translationSha256, generator }) => ({
        sentenceId,
        sourceSha256,
        translationSha256,
        generator,
      })),
    });
    logicalContentBytes += logicalBytes;
  }
  if (units.length === 0 && retired.length === 0) return;
  if (logicalContentBytes > maximumLanguageContentBytes)
    throw new Error("迁移使单语言逻辑内容超过 64 MiB 预算，未发布。");

  const targetRelative = `.paper30min/revisions/${input.revisionId}/translations/${input.language}`;
  const target = await managedDirectory(input.root, targetRelative, true);
  if (!target) throw new Error("译文侧车目录不可用。");
  const unitsDirectory = await managedDirectory(input.root, `${targetRelative}/units`, true);
  if (!unitsDirectory) throw new Error("译文单元目录不可用。");
  // 单元文件先完整写入；index 推进前崩溃时未引用文件不作为当前投影。
  for (const { file, bytes } of staged) {
    const temporary = path.join(unitsDirectory, `.paper30min-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameManaged(temporary, path.join(unitsDirectory, path.basename(file)));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const next: TranslationIndex = {
    formatVersion: 1,
    baseRevision: input.revisionId,
    language: input.language,
    translationRevision: randomUUID(),
    logicalContentBytes,
    units,
    ...(retired.length > 0 ? { retired } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n");
  if (bytes.byteLength > indexBudget) throw new Error("迁移译文 index 超过 64 MiB 写入预算，未发布。");
  const temporary = path.join(target, `.paper30min-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameManaged(temporary, path.join(target, "index.json"));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** 译文继承的 commit 钩子：由持有翻译语义的调用方注入通用提交路径
 * （coreCommit、修正发布、合并发布、来源更新与重解析候选发布）。
 * 无旧译文时零写入；迁移失败拒绝发布，不产生半篇可见的新侧车。 */
export function translationInheritCommitHooks(input: {
  root: string;
  baseRevision: string | null;
  revisionId: string;
  document: DocumentTree;
  changeset: DocumentChangeset;
  tombstones: Tombstone[];
}): ProjectCommitHooks {
  return {
    onCommitPoint: async (point) => {
      if (point !== "before-current-replace" || input.baseRevision === null) return;
      const opened = await openProject(input.root);
      const baseDocument = await readRevisionDocument(opened.root, input.baseRevision, "document");
      for (const language of languages) {
        await migrateLanguage({
          root: opened.root,
          baseRevision: input.baseRevision,
          revisionId: input.revisionId,
          language,
          baseDocument,
          document: input.document,
          changeset: input.changeset,
          tombstones: input.tombstones,
        });
      }
    },
  };
}
