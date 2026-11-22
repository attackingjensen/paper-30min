// 翻译任务编排（SPEC-translation §1/§4/§6/§8，paper-30min-crd.2/crd.3）：
// 按需启动、逐单元原子发布、首轮失败自动补试一次、恢复不重复提交。
// 任务只处理 gap，不自动覆盖 ready/stale；显式 stale 更新以句为最小提交；
// 打开缺口按 baseRevision＋language＋model＋gap 指纹每会话最多自动补试一次。
// 同一 baseRevision＋language 只运行一个任务；任务固定开始时的模型配置。
import { buildReaderProjection } from "../../shared/reader/projection.js";
import { readerProjectionUnits } from "../../shared/reader/translation-view.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import { createHash } from "node:crypto";
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
  commitTranslationUnit,
  readTranslationProjection,
  translationSentenceDigests,
  writeTranslationTaskRecord,
} from "./store.js";
import { runTranslationTask } from "./task.js";

/** 全部可读单元（正文、表格单元、图注、脚注、参考文献），按 blocks 阅读顺序。 */
export function translationSourceUnits(tree: DocumentTree) {
  return readerProjectionUnits(buildReaderProjection(tree));
}

export type TranslationRunMode = "generate" | "fill-gaps" | "update-stale";

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

const activeTasks = new Map<string, Promise<TranslationRunResult>>();

/** 在途任务的取消控制器：应用退出时中止未发送批次；合法完成项已保存。 */
const taskControllers = new Map<string, AbortController>();

/** 应用退出：中止全部在途翻译任务并等待落定；合法完成项已保存，pending 不冒充 ready。 */
export async function settleTranslationTasks(): Promise<void> {
  for (const controller of Array.from(taskControllers.values())) controller.abort();
  await Promise.allSettled(Array.from(activeTasks.values()));
}

export async function runProjectTranslation(input: TranslationRunInput): Promise<TranslationRunResult> {
  const opened = await openProject(input.root);
  if (!opened.currentRevision) return { status: "skipped", reason: "no-current", projection: null };
  const baseRevision = opened.currentRevision.revisionId;
  const key = `${opened.root}\0${baseRevision}\0${input.language}`;
  const running = activeTasks.get(key);
  if (running) return { status: "skipped", reason: "busy", projection: null };

  const controller = new AbortController();
  taskControllers.set(`${opened.root}\0${input.language}`, controller);
  const run = execute({ ...input, signal: controller.signal }, opened.root, baseRevision).finally(() => {
    if (taskControllers.get(`${opened.root}\0${input.language}`) === controller)
      taskControllers.delete(`${opened.root}\0${input.language}`);
  });
  activeTasks.set(key, run);
  try {
    return await run;
  } finally {
    if (activeTasks.get(key) === run) activeTasks.delete(key);
  }
}

/** 打开缺口自动补试的会话指纹登记：同 baseRevision＋language＋model＋gap 内容
 * 最多自动补试一次；手动补译与显式 stale 更新不受此限制。 */
const autoFillFingerprints = new Set<string>();

async function execute(input: TranslationRunInput, root: string, baseRevision: string): Promise<TranslationRunResult> {
  const mode = input.mode ?? "generate";
  const tree = await readRevisionDocument(root, baseRevision, "document");
  const sourceLanguage = detectSourceLanguage(tree);
  const before = await readTranslationProjection(root, baseRevision, input.language);
  const projectionWithSource = { ...before, sourceLanguage };
  if (!sourceLanguage) return { status: "skipped", reason: "unknown-language", projection: projectionWithSource };
  if (sourceLanguage === input.language)
    return { status: "skipped", reason: "same-language", projection: projectionWithSource };

  const units = translationSourceUnits(tree);
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
  if (targets.length === 0) return { status: "skipped", reason: "already-generated", projection: projectionWithSource };

  const selected = input.config.models.find((model) => model.id === input.config.selectedModelId)!;
  // 自动补试指纹：同会话同 baseRevision＋language＋model＋gap 内容最多一次。
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        baseRevision,
        language: input.language,
        model: selected.model,
        gaps: targets.map((unit) => ({ unitId: unit.unitId, sentenceIds: unit.sentences.map((s) => s.sentenceId) })),
      }),
    )
    .digest("hex");
  if (mode === "generate" && before.translationRevision !== null && autoFillFingerprints.has(fingerprint))
    return { status: "skipped", reason: "already-generated", projection: projectionWithSource };

  const session = createTranslationModelSession(input.config);
  const modelBudget = {
    contextWindow: selected.contextWindow,
    maxTokens: selected.maxTokens,
    // UTF-8 字节是保守预算单位；安全余量吸收协议封装与估算误差。
    safetyMarginTokens: 1024,
  };
  try {
    await writeTranslationTaskRecord(root, baseRevision, input.language, { status: "running", gaps: [] });
    const options = {
      baseRevision,
      modelBudget,
      sourceLanguage,
      selectedLanguage: input.language,
      units: targets,
      // 部分提交：目标句之外的已提交 ready 句不重发；stale 句不属于 gap 任务目标。
      committedSentences: committed,
      generate: async (modelInput: Parameters<typeof session.generate>[0]) => {
        input.signal?.throwIfAborted();
        return session.generate(modelInput, input.signal);
      },
      onUnitReady: async (unit: TranslationUnitContent) => {
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
    // 首轮：合法单元完成即发布；失败单元记 gap。
    let task = await runTranslationTask(options);
    // 首轮结束后对失败单元自动补试一次；已保存内容不重发。
    const failedIds = new Set(task.units.flatMap((unit) => (unit.status === "gap" ? [unit.unitId] : [])));
    if (failedIds.size > 0 && !input.signal?.aborted) {
      const refreshed = await readTranslationProjection(root, baseRevision, input.language);
      const refreshedStatus = new Map(
        refreshed.units.map((unit) => [
          unit.unitId,
          new Map(unit.sentences.map((sentence) => [sentence.sentenceId, sentence.status])),
        ]),
      );
      const retryTargets = targets
        .filter((unit) => failedIds.has(unit.unitId))
        .map((unit) => ({
          ...unit,
          sentences: unit.sentences.filter(
            (sentence) => (refreshedStatus.get(unit.unitId)?.get(sentence.sentenceId) ?? "gap") === targetStatus,
          ),
        }))
        .filter((unit) => unit.sentences.length > 0);
      if (retryTargets.length > 0) {
        const retry = await runTranslationTask({
          ...options,
          units: retryTargets,
          committedSentences: committedSentenceMap(refreshed),
        });
        const retried = new Map(
          retry.units.map((unit) => [unit.status === "ready" ? unit.unit.unitId : unit.unitId, unit]),
        );
        task = {
          status: "finished",
          units: task.units.map((unit) => {
            const id = unit.status === "ready" ? unit.unit.unitId : unit.unitId;
            return retried.get(id) ?? unit;
          }),
        };
      }
    }
    if (mode === "generate" && before.translationRevision !== null) autoFillFingerprints.add(fingerprint);
    const gaps = task.units.flatMap((unit) =>
      unit.status === "gap" ? [{ unitId: unit.unitId, diagnostic: unit.diagnostic }] : [],
    );
    await writeTranslationTaskRecord(root, baseRevision, input.language, { status: "finished", gaps });
    const projection = await readTranslationProjection(root, baseRevision, input.language);
    return {
      status: "finished",
      units: task.units.map((unit) =>
        unit.status === "ready"
          ? { status: "ready", unitId: unit.unit.unitId, committed: unit.committed }
          : { status: "gap", unitId: unit.unitId, diagnostic: unit.diagnostic },
      ),
      projection: { ...projection, sourceLanguage },
    };
  } finally {
    await session.close();
  }
}
