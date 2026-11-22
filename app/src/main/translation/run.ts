// 翻译任务编排（SPEC-translation §1/§4/§6/§8，paper-30min-crd.2/crd.3/crd.5）：
// 按需启动、逐单元原子发布、首轮失败自动补试一次、恢复不重复提交。
// 任务只处理 gap，不自动覆盖 ready/stale；对已有 unit 的补译/stale 更新以句为
// 最小提交（初次 generate 保持 unit 原子）；同会话同指纹自动尝试（含用户停止）
// 最多一次。同一 baseRevision＋language 只运行一个任务；任务固定开始时的模型配置。
// current 推进或用户停止即中止旧任务并停止调度新批次；已完成结果只写旧 revision
// 侧车，再经 changeset 迁移继承，不直写新 current。
import { buildReaderProjection, type ReaderUnitContent } from "../../shared/reader/projection.js";
import { readerProjectionUnits } from "../../shared/reader/translation-view.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { TranslationStartCommandResult } from "../../shared/contracts.js";
import {
  detectSourceLanguage,
  type TranslationLanguage,
  type TranslationProjection,
  type TranslationUnitContent,
} from "../../shared/translation/contracts.js";

import { openProject, readRevisionDocument } from "../project-core.js";
import type { ModelConfig } from "../agent-settings.js";
import { createTranslationModelSession } from "./model-request.js";
import {
  commitTranslationMeta,
  commitTranslationUnit,
  readPaperTitle,
  readTranslationProjection,
  readTranslationTaskRecord,
  translationMetaSources,
  translationSentenceDigests,
  writeTranslationTaskRecord,
} from "./store.js";
import { createTranslationMetaInput, parseTranslationMetaOutput, type TranslationMetaSources } from "./model-io.js";
import { runTranslationTask } from "./task.js";

/** 全部可读单元（正文、表格单元、图注、脚注、参考文献），按 blocks 阅读顺序。 */
export function translationSourceUnits(tree: DocumentTree) {
  return readerProjectionUnits(buildReaderProjection(tree));
}

type TranslationRunMode = "generate" | "fill-gaps" | "update-stale";

export interface TranslationRunInput {
  root: string;
  language: TranslationLanguage;
  config: ModelConfig;
  /** generate：按需生成（只处理 gap）；fill-gaps：手动补译；update-stale：显式更新过期译文。 */
  mode?: TranslationRunMode;
  signal?: AbortSignal;
  /** 每次 index 原子推进后通知（worker → 主进程 → renderer 渐进刷新）。 */
  onCommitted?: () => void;
}

export type TranslationRunResult = TranslationStartCommandResult;

/** 已提交且与当前原句摘要一致的单元→句子集合（恢复跳过依据）。 */
function committedSentenceMap(projection: TranslationProjection): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const unit of projection.units) {
    const ready = unit.sentences.filter((sentence) => sentence.status === "ready");
    if (ready.length > 0) map.set(unit.unitId, new Set(ready.map((sentence) => sentence.sentenceId)));
  }
  return map;
}

interface ActiveTranslationTask {
  root: string;
  baseRevision: string;
  language: TranslationLanguage;
  controller: AbortController;
  /** 停止登记所需事实：停止时按剩余 gap＋meta 计算指纹，与 generate 指纹同口径。 */
  model?: string;
  sourceUnits?: readonly ReaderUnitContent[];
  metaSources?: TranslationMetaSources;
  /** 手动任务保留既有持久化指纹，不擦除自动尝试限次记录。 */
  previousFingerprint?: string;
  done: Promise<TranslationRunResult>;
}

/** 在途任务按完整 key（root＋baseRevision＋language）管理：不同 revision 的任务
 * 互不覆盖控制器；退出与停止都能中止全部在途任务。 */
const activeTasks = new Map<string, ActiveTranslationTask>();

/** 在途任务事实（renderer busy 的权威来源）：停止等待落定后即为 false。 */
export function hasActiveTranslationTask(root: string, baseRevision: string, language: TranslationLanguage): boolean {
  return activeTasks.has(`${root}\0${baseRevision}\0${language}`);
}

/** 自动尝试指纹唯一构造口径（启动／停止／持久化共用）：正文 gap＋meta 目标。 */
function autoAttemptFingerprint(input: {
  root: string;
  baseRevision: string;
  language: TranslationLanguage;
  model: string;
  gaps: Array<{ unitId: string; sentenceIds: string[] }>;
  meta: (TranslationMetaSources & { targetStatus: "gap" | "stale" }) | null;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** 打开缺口自动尝试的会话指纹登记：同 root＋baseRevision＋language＋model＋gap 内容
 * 在实际开始自动网络尝试时登记（与是否存在已提交 index 解耦），最多自动一次；
 * 用户停止同样登记。手动补译与显式 stale 更新不受此限制。 */
const autoFillFingerprints = new Set<string>();

/** 中止匹配的全部在途任务并等待落定；合法完成项已保存，pending 不冒充 ready。
 * 用户停止按停止后的剩余 gap 登记指纹：同指纹 generate 不再自动启动（SPEC §6.3）。 */
async function abortTasks(matches: (task: ActiveTranslationTask) => boolean, registerStop: boolean): Promise<void> {
  const tasks = Array.from(activeTasks.values()).filter(matches);
  for (const task of tasks) task.controller.abort();
  await Promise.allSettled(tasks.map((task) => task.done));
  if (!registerStop) return;
  for (const task of tasks) {
    if (!task.model || !task.sourceUnits || !task.metaSources) continue;
    try {
      const projection = await readTranslationProjection(task.root, task.baseRevision, task.language);
      const committed = committedSentenceMap(projection);
      const gaps = task.sourceUnits
        .map((unit) => ({
          unitId: unit.unitId,
          sentenceIds: unit.sentences
            .filter((sentence) => !committed.get(unit.unitId)?.has(sentence.sentenceId))
            .map((sentence) => sentence.sentenceId),
        }))
        .filter((unit) => unit.sentenceIds.length > 0);
      if (gaps.length === 0) continue;
      const fingerprint = autoAttemptFingerprint({
        root: task.root,
        baseRevision: task.baseRevision,
        language: task.language,
        model: task.model,
        gaps,
        meta: null,
      });
      autoFillFingerprints.add(fingerprint);
      // 持久化停止指纹：重开应用后同指纹 generate 同样不再自动启动。
      const record = await readTranslationTaskRecord(task.root, task.baseRevision, task.language);
      await writeTranslationTaskRecord(task.root, task.baseRevision, task.language, {
        status: record?.status ?? "finished",
        gaps: record?.gaps ?? [],
        autoAttemptFingerprint: fingerprint,
      });
    } catch {
      // 停止登记失败不改变已中止事实；下次打开仍受任务记录与已提交内容约束。
    }
  }
}

/** 应用退出：中止全部在途翻译任务并等待落定。 */
export async function settleTranslationTasks(): Promise<void> {
  await abortTasks(() => true, false);
}

/** 用户停止（coreTranslationStop）：中止该 root＋language 全部在途任务（跨 revision）
 * 并等待落定；登记停止指纹使同指纹 generate 不再自动启动，手动补译仍可显式发起。
 * 已在途的请求可能已产生费用；完成且合法的结果仍保存，不谎称撤回费用。 */
export async function stopTranslationTasks(root: string, language: TranslationLanguage): Promise<void> {
  const canonical = await fs.realpath(root);
  await abortTasks((task) => task.root === canonical && task.language === language, true);
}

export async function runProjectTranslation(input: TranslationRunInput): Promise<TranslationRunResult> {
  const opened = await openProject(input.root);
  if (!opened.currentRevision) return { status: "skipped", reason: "no-current", projection: null };
  const baseRevision = opened.currentRevision.revisionId;
  const key = `${opened.root}\0${baseRevision}\0${input.language}`;
  if (activeTasks.has(key)) {
    // 已有任务在途：返回当前投影（running=true），renderer 据此保持 busy 与
    // 渐进刷新，不得把显式动作悬挂在无投影的 skipped 上。
    const projection = await readTranslationProjection(opened.root, baseRevision, input.language);
    return { status: "skipped", reason: "busy", projection: { ...projection, running: true } };
  }

  // 组合外部 signal 与内部控制器（AnyAbort 语义）：调用方停止同样取消未发送批次。
  const controller = new AbortController();
  const external = input.signal;
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });

  const task: ActiveTranslationTask = {
    root: opened.root,
    baseRevision,
    language: input.language,
    controller,
    // execute 同步启动后立即回填；登记与等待只发生在回填之后。
    done: undefined as unknown as Promise<TranslationRunResult>,
  };
  task.done = execute({ ...input, signal: controller.signal }, task, opened.root, baseRevision).finally(() => {
    external?.removeEventListener("abort", onExternalAbort);
    if (activeTasks.get(key) === task) activeTasks.delete(key);
  });
  activeTasks.set(key, task);
  // 必须 await：activeTasks 清理发生在 task.done 落定时；提前返回会让
  // 在途任务被误判空闲，重复 generate 覆盖任务记录并悬挂 invoke。
  return await task.done;
}

async function execute(
  input: TranslationRunInput,
  task: ActiveTranslationTask,
  root: string,
  baseRevision: string,
): Promise<TranslationRunResult> {
  const mode = input.mode ?? "generate";
  const tree = await readRevisionDocument(root, baseRevision, "document");
  const sourceLanguage = detectSourceLanguage(tree);
  const before = await readTranslationProjection(root, baseRevision, input.language);
  const projectionWithSource = { ...before, sourceLanguage };
  if (!sourceLanguage) return { status: "skipped", reason: "unknown-language", projection: projectionWithSource };
  if (sourceLanguage === input.language)
    return { status: "skipped", reason: "same-language", projection: projectionWithSource };

  const units = translationSourceUnits(tree);
  const paperTitle = await readPaperTitle(root, baseRevision);
  const metaSources = translationMetaSources(tree, paperTitle);
  task.sourceUnits = units;
  const committed = committedSentenceMap(before);
  const statusByUnit = new Map(
    before.units.map((unit) => [
      unit.unitId,
      new Map(unit.sentences.map((sentence) => [sentence.sentenceId, sentence.status])),
    ]),
  );
  // 目标句筛选：generate/fill-gaps 只处理 gap（stale/ready 不自动覆盖）；
  // update-stale 只处理 stale。未提交单元的全部句子都是 gap。
  const targetStatus = mode === "update-stale" ? "stale" : "gap";
  const targets = units
    .map((unit) => {
      const statuses = statusByUnit.get(unit.unitId);
      const sentences = unit.sentences.filter(
        (sentence) => (statuses?.get(sentence.sentenceId) ?? "gap") === targetStatus,
      );
      return { ...unit, sentences };
    })
    .filter((unit) => unit.sentences.length > 0);
  // 元数据目标与正文同口径：只请求目标状态（gap 或 stale）的标题/raw，
  // 非目标（ready 或另一状态）不重译、不覆盖其内容与 generator 事实。
  const sectionStatus = new Map((before.sections ?? []).map((section) => [section.sectionId, section.status]));
  const rawStatus = new Map((before.rawBlocks ?? []).map((raw) => [raw.blockId, raw.status]));
  const metaTargets: TranslationMetaSources = {
    paperTitle:
      metaSources.paperTitle !== null && (before.paperTitle?.status ?? "gap") === targetStatus
        ? metaSources.paperTitle
        : null,
    sections: metaSources.sections.filter(
      (section) => (sectionStatus.get(section.sectionId) ?? "gap") === targetStatus,
    ),
    rawBlocks: metaSources.rawBlocks.filter((raw) => (rawStatus.get(raw.blockId) ?? "gap") === targetStatus),
  };
  const metaNeedsWork =
    metaTargets.paperTitle !== null || metaTargets.sections.length > 0 || metaTargets.rawBlocks.length > 0;
  if (targets.length === 0 && !metaNeedsWork)
    return { status: "skipped", reason: "already-generated", projection: projectionWithSource };

  const selected = input.config.models.find((model) => model.id === input.config.selectedModelId)!;
  task.model = selected.model;
  task.metaSources = metaSources;
  // 正文自动尝试指纹：同会话同 root＋baseRevision＋language＋model＋gap 内容最多一次。
  // meta 目标独立按状态筛选（每次 generate 至多一次），不并入正文指纹，
  // 避免 meta 提交后指纹变化导致正文限次失效。
  const fingerprint = autoAttemptFingerprint({
    root,
    baseRevision,
    language: input.language,
    model: selected.model,
    gaps: targets.map((unit) => ({ unitId: unit.unitId, sentenceIds: unit.sentences.map((s) => s.sentenceId) })),
    meta: null,
  });
  const previousTask = await readTranslationTaskRecord(root, baseRevision, input.language);
  task.previousFingerprint = previousTask?.autoAttemptFingerprint;
  const unitSkipped =
    mode === "generate" &&
    (autoFillFingerprints.has(fingerprint) || previousTask?.autoAttemptFingerprint === fingerprint);
  if (unitSkipped) autoFillFingerprints.add(fingerprint);
  if (targets.length === 0 && !metaNeedsWork)
    return { status: "skipped", reason: "already-generated", projection: projectionWithSource };
  if (unitSkipped && !metaNeedsWork)
    return { status: "skipped", reason: "already-generated", projection: projectionWithSource };

  const session = createTranslationModelSession(input.config);
  const modelBudget = {
    contextWindow: selected.contextWindow,
    maxTokens: selected.maxTokens,
    // UTF-8 字节是保守预算单位；安全余量吸收协议封装与估算误差。
    safetyMarginTokens: 1024,
  };
  // current 复核：每个新 fragment/unit 调度前与每次提交前检查。current 已推进
  // 即中止本任务并停止调度（不是普通 gap，也不进入自动补试）。
  const ensureCurrent = async () => {
    if (task.controller.signal.aborted) return false;
    const opened = await openProject(root);
    if (opened.currentRevision?.revisionId !== baseRevision) {
      task.controller.abort();
      return false;
    }
    return true;
  };
  try {
    await writeTranslationTaskRecord(root, baseRevision, input.language, {
      status: "running",
      gaps: [],
      ...(mode === "generate" && !unitSkipped
        ? { autoAttemptFingerprint: fingerprint }
        : task.previousFingerprint
          ? { autoAttemptFingerprint: task.previousFingerprint }
          : {}),
    });
    if (mode === "generate") {
      // 在实际开始自动网络尝试时登记指纹：全失败（无 index）与用户停止同样受限。
      autoFillFingerprints.add(fingerprint);
    }
    const options = {
      baseRevision,
      modelBudget,
      sourceLanguage,
      selectedLanguage: input.language,
      units: unitSkipped ? [] : targets,
      // 对已有 unit 的 fill-gaps/update-stale 按目标句独立计划、校验、merge 提交；
      // 初次 generate 的新 unit 保持整单元原子。
      sentenceAtomic: mode !== "generate",
      signal: task.controller.signal,
      ensureCurrent,
      // 部分提交：目标句之外的已提交 ready 句不重发；stale 句不属于 gap 任务目标。
      committedSentences: committed,
      generate: async (modelInput: Parameters<typeof session.generate>[0]) => {
        task.controller.signal.throwIfAborted();
        return session.generate(modelInput, task.controller.signal);
      },
      onUnitReady: async (unit: TranslationUnitContent) => {
        if (!(await ensureCurrent())) throw task.controller.signal.reason ?? new Error("翻译任务已停止。");
        const sourceUnit = units.find((candidate) => candidate.unitId === unit.unitId)!;
        await commitTranslationUnit({
          root,
          baseRevision,
          language: input.language,
          generator: session.generator,
          unit,
          digests: translationSentenceDigests(tree, sourceUnit, unit.sentences),
          // 句级合并：只替换本次目标句，保留同单元其他已提交句（含 stale）。
          merge: true,
        });
        input.onCommitted?.();
      },
    };
    // 标题/raw 元数据：与单元同一任务内独立请求、校验与原子提交。
    // 元数据失败不丢弃已提交单元（旧译文保持权威），但任务整体记为失败并给出
    // 可行动诊断；投影保持 gap/stale，可由补译/更新显式重试。
    let metaFailure: string | null = null;
    if (metaNeedsWork && (await ensureCurrent())) {
      try {
        const metaInput = createTranslationMetaInput({
          baseRevision,
          modelBudget,
          sourceLanguage,
          targetLanguage: input.language,
          sources: metaTargets,
        });
        const parsed = parseTranslationMetaOutput(
          metaTargets,
          await session.generate(metaInput, task.controller.signal),
        );
        if (parsed.failures.length > 0) metaFailure = `标题/raw 元数据部分失败：${parsed.failures.join("；")}`;
        const hasValid =
          parsed.content.paperTitle !== null ||
          parsed.content.sections.length > 0 ||
          parsed.content.rawBlocks.length > 0;
        if (hasValid) {
          if (!(await ensureCurrent())) throw task.controller.signal.reason ?? new Error("翻译任务已停止。");
          await commitTranslationMeta({
            root,
            baseRevision,
            language: input.language,
            generator: session.generator,
            sources: metaTargets,
            translated: parsed.content,
          });
          input.onCommitted?.();
        }
      } catch (error) {
        if (task.controller.signal.aborted) throw error;
        metaFailure = `标题/raw 元数据翻译失败：${(error as Error).message}`;
      }
    }
    // 首轮：合法单元（或句级目标）完成即发布；失败项记 gap。
    const first = unitSkipped ? null : await runTranslationTask(options);
    let results = first && first.status === "finished" ? first.units : [];
    // 首轮结束后对失败目标自动补试一次；已保存内容与停止/revision 失效不重发。
    if (!unitSkipped && results.some((unit) => unit.status !== "ready") && (await ensureCurrent())) {
      const refreshed = await readTranslationProjection(root, baseRevision, input.language);
      const refreshedStatus = new Map(
        refreshed.units.map((unit) => [
          unit.unitId,
          new Map(unit.sentences.map((sentence) => [sentence.sentenceId, sentence.status])),
        ]),
      );
      const retryTargets = results
        .filter((unit) => unit.status !== "ready")
        .flatMap((failed) => {
          const source = targets.find((unit) => unit.unitId === failed.unitId);
          if (!source) return [];
          const sentences = source.sentences.filter(
            (sentence) =>
              failed.sentenceFailures.some((failure) => failure.sentenceId === sentence.sentenceId) &&
              (refreshedStatus.get(source.unitId)?.get(sentence.sentenceId) ?? "gap") === targetStatus,
          );
          return sentences.length > 0 ? [{ ...source, sentences }] : [];
        });
      if (retryTargets.length > 0) {
        const retryRun = await runTranslationTask({
          ...options,
          units: retryTargets,
          committedSentences: committedSentenceMap(refreshed),
        });
        const retried = retryRun.status === "finished" ? retryRun.units : [];
        results = results.map((failed) => {
          if (failed.status === "ready") return failed;
          const retry = retried.find((unit) => unit.unitId === failed.unitId);
          if (!retry) return failed;
          if (retry.status === "ready") return retry;
          const retriedIds = new Set(retry.sentenceFailures.map((failure) => failure.sentenceId));
          return {
            ...failed,
            sentenceFailures: [
              ...failed.sentenceFailures.filter((failure) => !retriedIds.has(failure.sentenceId)),
              ...retry.sentenceFailures,
            ],
          };
        });
      }
    }
    // task.json 记录句级分类诊断：kind 前缀＋安全文案；同 unit 多句失败逐句列出。
    // 记录 schema 由存储层拥有（unitId＋diagnostic），分类信息编码进诊断文本。
    const gaps = results.flatMap((unit) =>
      unit.status === "ready"
        ? []
        : unit.sentenceFailures.map((failure) => ({
            unitId: unit.unitId,
            diagnostic: `[${failure.kind}] 句子 ${failure.sentenceId}：${failure.diagnostic}`,
          })),
    );
    if (metaFailure !== null) gaps.push({ unitId: "meta", diagnostic: metaFailure });
    await writeTranslationTaskRecord(root, baseRevision, input.language, {
      status: "finished",
      gaps,
      ...(mode === "generate" && !unitSkipped
        ? { autoAttemptFingerprint: fingerprint }
        : task.previousFingerprint
          ? { autoAttemptFingerprint: task.previousFingerprint }
          : {}),
    });
    const projection = await readTranslationProjection(root, baseRevision, input.language);
    return {
      status: "finished",
      units: [
        ...results.map((unit) =>
          unit.status === "ready"
            ? { status: "ready" as const, unitId: unit.unitId, committed: unit.committed }
            : {
                status: "gap" as const,
                unitId: unit.unitId,
                diagnostic: unit.sentenceFailures[0]?.diagnostic ?? "翻译未完成。",
                sentences: unit.sentenceFailures.map((failure) => ({
                  sentenceId: failure.sentenceId,
                  kind: failure.kind,
                  diagnostic: failure.diagnostic,
                })),
              },
        ),
        ...(metaFailure !== null ? [{ status: "gap" as const, unitId: "meta", diagnostic: metaFailure }] : []),
      ],
      projection: { ...projection, sourceLanguage, running: false },
    };
  } finally {
    await session.close();
  }
}
