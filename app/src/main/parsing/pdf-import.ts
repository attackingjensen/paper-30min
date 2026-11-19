import type { Dispatcher } from "undici";
import { readDiagnosticArray, type ImportDiagnostic } from "../../shared/arxiv.js";
import type {
  PdfParseSourceSnapshotRecord,
  ProjectRevisionRecord,
} from "../../shared/contracts.js";
import type {
  BaiduUploadConfirmationRequest,
  PdfParseTaskRecord,
} from "../../shared/parsing.js";
import { openProject, readRevision } from "../project-core.js";
import {
  executeNewPdfParse,
  executeResumePdfParse,
  findBatchParseSnapshot,
  listBaiduPdfParseTasks,
  saveTask,
  withActive,
  type BaiduPdfParseConfig,
  type TaskHooks,
  type TaskTiming,
} from "./baidu-task.js";
import { publishParseSnapshot } from "./parse-snapshot.js";
import { createParseMergeCandidate, publishParseDocument, type PdfConvertHooks } from "./parse-convert.js";
import type { DocumentMergeCandidate } from "../document/merge.js";

/** 端到端 PDF 导入结果：published 表示 current 已原子推进，正文可离线阅读。 */
export type PdfImportResult =
  | { outcome: "cancelled" }
  | { outcome: "incomplete"; task: PdfParseTaskRecord; diagnostic: ImportDiagnostic }
  | { outcome: "stopped"; task: PdfParseTaskRecord }
  | {
      outcome: "published";
      task: PdfParseTaskRecord;
      revision: ProjectRevisionRecord;
      warnings: ImportDiagnostic[];
    };

interface ContinueOptions {
  signal: AbortSignal;
  dispatcher?: Dispatcher;
  convertHooks?: PdfConvertHooks;
}

async function stopTask(root: string, task: PdfParseTaskRecord): Promise<PdfImportResult> {
  task.phase = "stopped";
  task.diagnostic = {
    code: "baidu-task-stopped",
    severity: "fatal",
    stage: "convert",
    messageKey: "baidu.task.stoppedRemoteMayContinue",
  };
  await saveTask(root, task);
  return { outcome: "stopped", task };
}

/** 下载完成后继续：去敏发布解析快照 → 转换 → 首次发布 current。
 * 致命失败保留任务现场与诊断；本机停止不冒充远端失败。 */
async function continueToCurrent(
  root: string,
  task: PdfParseTaskRecord,
  source: { response: { bytes: Uint8Array; sha256: string } } | { snapshot: PdfParseSourceSnapshotRecord },
  options: ContinueOptions,
): Promise<PdfImportResult> {
  let snapshot: PdfParseSourceSnapshotRecord;
  if ("response" in source) {
    const sanitized = await publishParseSnapshot({
      root,
      task,
      response: source.response,
      signal: options.signal,
      ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
      hooks: options.convertHooks?.commitHooks ?? {},
    });
    if (!sanitized.ok) {
      if (sanitized.diagnostic.code === "parse-stopped") return stopTask(root, task);
      return { outcome: "incomplete", task: sanitized.task, diagnostic: sanitized.diagnostic };
    }
    task = sanitized.task;
    snapshot = sanitized.snapshot;
  } else {
    snapshot = source.snapshot;
  }
  task.phase = "converting";
  delete task.diagnostic;
  await saveTask(root, task);
  const published = await publishParseDocument({
    root,
    task,
    snapshot,
    signal: options.signal,
    onCandidateBuilt: async ({ revisionId }) => {
      task.candidateRevisionId = revisionId;
      await saveTask(root, task);
    },
    hooks: options.convertHooks ?? {},
  });
  if (!published.ok) {
    if (published.diagnostic.code === "pdf-convert-stopped") return stopTask(root, task);
    task.diagnostic = published.diagnostic;
    await saveTask(root, task);
    return { outcome: "incomplete", task, diagnostic: published.diagnostic };
  }
  task.phase = "candidate-complete";
  task.candidateRevisionId = published.revision.revisionId;
  delete task.diagnostic;
  await saveTask(root, task);
  return { outcome: "published", task, revision: published.revision, warnings: published.warnings };
}

/** 本地 PDF → 云端解析 → 去敏快照 → 规范文档树 → 首次发布 current。
 * 全程在同一串行守卫内：同一工程同时只有一个活动导入，停止可直达转换阶段。 */
export async function importPdfToCurrent(input: {
  root: string;
  sourceSnapshotId: string;
  config: BaiduPdfParseConfig;
  confirmUpload: (request: BaiduUploadConfirmationRequest) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  taskHooks?: TaskHooks;
  convertHooks?: PdfConvertHooks;
  timing?: TaskTiming;
}): Promise<PdfImportResult> {
  return withActive(input.root, input.signal, async ({ signal, setBatch }) => {
    const started = await executeNewPdfParse(
      {
        root: input.root,
        sourceSnapshotId: input.sourceSnapshotId,
        config: input.config,
        confirmUpload: input.confirmUpload,
        ...(input.taskHooks === undefined ? {} : { hooks: input.taskHooks }),
        ...(input.timing === undefined ? {} : { timing: input.timing }),
      },
      { signal, setBatch },
    );
    if (started.outcome === "cancelled") return { outcome: "cancelled" };
    if (started.outcome === "incomplete")
      return { outcome: "incomplete", task: started.task, diagnostic: started.task.diagnostic! };
    if (started.outcome === "downloaded") {
      return continueToCurrent(input.root, started.task, { response: started.response }, {
        signal,
        ...(input.config.dispatcher === undefined ? {} : { dispatcher: input.config.dispatcher }),
        ...(input.convertHooks === undefined ? {} : { convertHooks: input.convertHooks }),
      });
    }
    return continueToCurrent(input.root, started.task, { snapshot: started.snapshot }, {
      signal,
      ...(input.convertHooks === undefined ? {} : { convertHooks: input.convertHooks }),
    });
  });
}

/** 恢复 PDF 导入到 current：已发布快照或候选纯离线完成，不重复下载、不重转换；
 * 只有尚未取得结果的远端任务才需要本机配置并沿用原 jobId 查询下载。 */
export async function resumePdfImport(input: {
  root: string;
  parseBatchId: string;
  config?: BaiduPdfParseConfig;
  jobId?: string;
  signal?: AbortSignal;
  taskHooks?: TaskHooks;
  convertHooks?: PdfConvertHooks;
  timing?: TaskTiming;
}): Promise<PdfImportResult> {
  return withActive(input.root, input.signal, async ({ signal, setBatch }) => {
    const opened = await openProject(input.root);
    const tasks = await listBaiduPdfParseTasks(input.root);
    const task = tasks.find((entry) => entry.parseBatchId === input.parseBatchId);
    if (!task) throw new Error("PDF 云端任务不存在。");
    setBatch(task.parseBatchId);
    if (task.phase === "candidate-complete") {
      if (
        task.candidateRevisionId === undefined ||
        opened.manifest.paper.currentRevision !== task.candidateRevisionId
      )
        throw new Error("任务记录与 current 不一致，保留现场检查。");
      const revision = await readRevision(opened.root, task.candidateRevisionId);
      if (revision.sourceSnapshotId !== task.parseSourceSnapshotId)
        throw new Error("任务关联的解析快照与 current 来源不一致，保留现场。");
      const metadata = revision.pdfParse;
      const warnings = readDiagnosticArray(
        metadata !== null && typeof metadata === "object"
          ? (metadata as Record<string, unknown>).warnings
          : undefined,
      );
      return { outcome: "published", task, revision, warnings };
    }
    const snapshot = await findBatchParseSnapshot(opened.root, task);
    if (snapshot) {
      task.parseSourceSnapshotId = snapshot.sourceSnapshotId;
      task.sanitizedSha256 = snapshot.sanitizedSha256;
      delete task.diagnostic;
      return continueToCurrent(opened.root, task, { snapshot }, {
        signal,
        ...(input.convertHooks === undefined ? {} : { convertHooks: input.convertHooks }),
      });
    }
    if (input.config === undefined)
      throw new Error("恢复未完成云端任务需要本机解析配置；离线重新转换只需已发布快照。");
    const resumed = await executeResumePdfParse(
      {
        root: input.root,
        parseBatchId: input.parseBatchId,
        config: input.config,
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
        ...(input.taskHooks === undefined ? {} : { hooks: input.taskHooks }),
        ...(input.timing === undefined ? {} : { timing: input.timing }),
      },
      { signal, setBatch },
    );
    if (resumed.outcome === "incomplete")
      return { outcome: "incomplete", task: resumed.task, diagnostic: resumed.task.diagnostic! };
    if (resumed.outcome === "cancelled") return { outcome: "cancelled" };
    if (resumed.outcome === "downloaded") {
      return continueToCurrent(opened.root, resumed.task, { response: resumed.response }, {
        signal,
        ...(input.config.dispatcher === undefined ? {} : { dispatcher: input.config.dispatcher }),
        ...(input.convertHooks === undefined ? {} : { convertHooks: input.convertHooks }),
      });
    }
    return continueToCurrent(opened.root, resumed.task, { snapshot: resumed.snapshot }, {
      signal,
      ...(input.convertHooks === undefined ? {} : { convertHooks: input.convertHooks }),
    });
  });
}

/** 离线重新转换（SPEC §8.4）：复用已发布解析快照形成三方合并候选，
 * 不访问云端、不产生新任务；快照缺失时明确拒绝，不自动重新上传。 */
export async function reconvertParseCandidate(input: {
  root: string;
  parseBatchId: string;
  baseRevision: string;
  signal?: AbortSignal;
}): Promise<DocumentMergeCandidate> {
  const opened = await openProject(input.root);
  const tasks = await listBaiduPdfParseTasks(input.root);
  const task = tasks.find((entry) => entry.parseBatchId === input.parseBatchId);
  if (!task) throw new Error("PDF 云端任务不存在。");
  const snapshot = await findBatchParseSnapshot(opened.root, task);
  if (!snapshot) throw new Error("解析快照缺失，不能离线重新转换；不自动重新上传。");
  const { candidate } = await createParseMergeCandidate({
    root: opened.root,
    task,
    snapshot,
    baseRevision: input.baseRevision,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return candidate;
}