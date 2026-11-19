import type { Dispatcher } from "undici";
import { createHash } from "node:crypto";
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
import {
  createParseMergeCandidate,
  publishParseDocument,
  type ParseMergeConversion,
  type PdfConvertHooks,
  type PublishParseDocumentResult,
} from "./parse-convert.js";
import type { DocumentMergeCandidate } from "../document/merge.js";
import {
  publishDocumentMergeCandidate,
  resolveDocumentMergeCandidateConflict,
} from "../document/merge.js";

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

/** 重解析／更新结果：candidate 表示三方合并候选已形成但未发布 current，
 * 冲突与发布时机由用户决定；旧 current 始终可读。 */
export type PdfReparseResult =
  | { outcome: "cancelled" }
  | { outcome: "incomplete"; task: PdfParseTaskRecord; diagnostic: ImportDiagnostic }
  | { outcome: "stopped"; task: PdfParseTaskRecord }
  | {
      outcome: "candidate";
      task: PdfParseTaskRecord;
      candidate: DocumentMergeCandidate;
      warnings: ImportDiagnostic[];
    };

interface ReparseContinueOptions {
  signal: AbortSignal;
  dispatcher?: Dispatcher;
}

/** 重解析下载完成后继续：去敏发布新解析快照 → 重新转换 → 三方合并候选（SPEC §8）。
 * 不推进 current；致命失败保留任务现场与诊断，本机停止不冒充远端失败。 */
async function continueToCandidate(
  root: string,
  task: PdfParseTaskRecord,
  baseRevision: string,
  source: { response: { bytes: Uint8Array; sha256: string } } | { snapshot: PdfParseSourceSnapshotRecord },
  options: ReparseContinueOptions,
): Promise<PdfReparseResult> {
  let snapshot: PdfParseSourceSnapshotRecord;
  if ("response" in source) {
    const sanitized = await publishParseSnapshot({
      root,
      task,
      response: source.response,
      signal: options.signal,
      ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
    });
    if (!sanitized.ok) {
      if (sanitized.diagnostic.code === "parse-stopped") {
        task.phase = "stopped";
        task.diagnostic = sanitized.diagnostic;
        await saveTask(root, task);
        return { outcome: "stopped", task };
      }
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
  let merged: ParseMergeConversion;
  try {
    merged = await createParseMergeCandidate({
      root,
      task,
      snapshot,
      baseRevision,
      ...(task.candidateRevisionId === undefined ? {} : { revisionId: task.candidateRevisionId }),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      task.phase = "stopped";
      task.diagnostic = {
        code: "pdf-convert-stopped",
        severity: "fatal",
        stage: "convert",
        messageKey: "pdf.convert.stopped",
      };
      await saveTask(root, task);
      return { outcome: "stopped", task };
    }
    // 非中止失败落为 failed＋稳定诊断（SPEC §3/§5）：任务不再永久 converting，
    // 不阻塞新任务；已发布解析快照保留，修复后可离线重新转换或恢复重建候选。
    const diagnostic: ImportDiagnostic = {
      code: "pdf-convert-failed",
      severity: "fatal",
      stage: "convert",
      messageKey: "pdf.convert.failed",
      errorDetail: convertErrorDetail(error),
    };
    task.phase = "failed";
    task.diagnostic = diagnostic;
    await saveTask(root, task);
    return { outcome: "incomplete", task, diagnostic };
  }
  task.candidateRevisionId = merged.candidate.revisionId;
  task.phase = "candidate-complete";
  delete task.diagnostic;
  await saveTask(root, task);
  return { outcome: "candidate", task, candidate: merged.candidate, warnings: merged.warnings };
}

/** 显式重解析／更新主论文 PDF（SPEC §8.1–§8.3）：每个新云端任务重新确认上传与费用，
 * 新结果只形成三方合并候选，不直接覆盖 current；同 PDF 复用 PDF 快照、产生新解析快照。 */
export async function reparsePdfToCandidate(input: {
  root: string;
  sourceSnapshotId: string;
  baseRevision: string;
  config: BaiduPdfParseConfig;
  confirmUpload: (request: BaiduUploadConfirmationRequest) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  taskHooks?: TaskHooks;
  timing?: TaskTiming;
}): Promise<PdfReparseResult> {
  return withActive(input.root, input.signal, async ({ signal, setBatch }) => {
    const opened = await openProject(input.root);
    const current = opened.manifest.paper.currentRevision;
    if (current === null)
      throw new Error("首次正文尚未发布，请使用首次导入而不是重解析。");
    if (current !== input.baseRevision)
      throw new Error(`baseRevision 已变化：候选基线为 ${input.baseRevision}，current 为 ${current}。`);
    const started = await executeNewPdfParse(
      {
        root: opened.root,
        sourceSnapshotId: input.sourceSnapshotId,
        config: input.config,
        confirmUpload: input.confirmUpload,
        baseRevision: input.baseRevision,
        ...(input.taskHooks === undefined ? {} : { hooks: input.taskHooks }),
        ...(input.timing === undefined ? {} : { timing: input.timing }),
      },
      { signal, setBatch },
    );
    if (started.outcome === "cancelled") return { outcome: "cancelled" };
    if (started.outcome === "incomplete")
      return { outcome: "incomplete", task: started.task, diagnostic: started.task.diagnostic! };
    // 候选身份在任务受理后固定；恢复沿用同一候选，不重新分配。
    if (started.task.candidateRevisionId === undefined) {
      started.task.candidateRevisionId =
        candidateIdentity(`${started.task.parseBatchId}:${input.baseRevision}`);
      await saveTask(opened.root, started.task);
    }
    const options: ReparseContinueOptions = {
      signal,
      ...(input.config.dispatcher === undefined ? {} : { dispatcher: input.config.dispatcher }),
    };
    if (started.outcome === "downloaded")
      return continueToCandidate(opened.root, started.task, input.baseRevision, { response: started.response }, options);
    return continueToCandidate(opened.root, started.task, input.baseRevision, { snapshot: started.snapshot }, options);
  });
}

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

/** 转换失败诊断附底层原文（截断 500 字、去敏签名参数与凭据形态），
 * 稳定 code/messageKey 仍是分类权威；errorDetail 只供定位。 */
function convertErrorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/([?&](?:token|signature|sig|access_token|apikey|api_key|authorization)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .slice(0, 500);
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
  let published: PublishParseDocumentResult;
  try {
    published = await publishParseDocument({
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
  } catch (error) {
    if (options.signal.aborted) return stopTask(root, task);
    // 非中止失败落为 failed＋稳定诊断（与重解析同口径）：任务不再永久 converting，
    // 不阻塞新任务；已发布解析快照保留，修复后可离线重新转换。
    const diagnostic: ImportDiagnostic = {
      code: "pdf-convert-failed",
      severity: "fatal",
      stage: "convert",
      messageKey: "pdf.convert.failed",
      errorDetail: convertErrorDetail(error),
    };
    task.phase = "failed";
    task.diagnostic = diagnostic;
    await saveTask(root, task);
    return { outcome: "incomplete", task, diagnostic };
  }
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

/** 确定性 UUID 派生：同一输入沿用同一候选身份（v4 形状，非随机）。 */
function candidateIdentity(seed: string): string {
  const identity = createHash("sha256").update(seed).digest("hex");
  return `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(12, 15)}-8${identity.slice(15, 18)}-${identity.slice(18, 30)}`;
}

/** 候选身份按批次与本次基线确定性派生：同一基线重转换沿用同一候选，
 * 不复用首次导入的 revisionId（changeset 禁止 baseRevision 与 revisionId 相同）。 */
function reconvertIdentity(parseBatchId: string, baseRevision: string): string {
  return candidateIdentity(`reconvert:${parseBatchId}:${baseRevision}`);
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
  const revisionId = reconvertIdentity(task.parseBatchId, input.baseRevision);
  const { candidate } = await createParseMergeCandidate({
    root: opened.root,
    task,
    snapshot,
    baseRevision: input.baseRevision,
    revisionId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return candidate;
}

/** 恢复重解析／更新任务到合并候选（SPEC §8）：已发布快照纯离线重建候选，
 * 不重复下载、不推进 current；未完成任务沿用原 jobId 查询下载，绝不自动重传。 */
export async function resumePdfReparse(input: {
  root: string;
  parseBatchId: string;
  config?: BaiduPdfParseConfig;
  jobId?: string;
  signal?: AbortSignal;
  taskHooks?: TaskHooks;
  timing?: TaskTiming;
}): Promise<PdfReparseResult> {
  return withActive(input.root, input.signal, async ({ signal, setBatch }) => {
    const opened = await openProject(input.root);
    const tasks = await listBaiduPdfParseTasks(input.root);
    const task = tasks.find((entry) => entry.parseBatchId === input.parseBatchId);
    if (!task) throw new Error("PDF 云端任务不存在。");
    if (task.baseRevision === undefined)
      throw new Error("该任务不是重解析／更新任务，请使用首次导入恢复。");
    setBatch(task.parseBatchId);
    const options: ReparseContinueOptions = {
      signal,
      ...(input.config?.dispatcher === undefined ? {} : { dispatcher: input.config.dispatcher }),
    };
    const snapshot = await findBatchParseSnapshot(opened.root, task);
    if (snapshot) {
      task.parseSourceSnapshotId = snapshot.sourceSnapshotId;
      task.sanitizedSha256 = snapshot.sanitizedSha256;
      delete task.diagnostic;
      return continueToCandidate(opened.root, task, task.baseRevision, { snapshot }, options);
    }
    if (input.config === undefined)
      throw new Error("恢复未完成云端任务需要本机解析配置；已有解析快照时可离线重建候选。");
    const resumed = await executeResumePdfParse(
      {
        root: opened.root,
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
    if (resumed.outcome === "downloaded")
      return continueToCandidate(opened.root, resumed.task, task.baseRevision, { response: resumed.response }, options);
    return continueToCandidate(opened.root, resumed.task, task.baseRevision, { snapshot: resumed.snapshot }, options);
  });
}

/** 发布重解析／离线重转换候选（SPEC §8）：按批次重建同一确定性候选，
 * 应用显式冲突选择后发布；发布前复核 baseRevision 与任务记录一致，current 已变化时拒绝。 */
export async function publishParseCandidate(input: {
  root: string;
  parseBatchId: string;
  baseRevision: string;
  resolutions?: Array<{ conflictId: string; choice: "current" | "candidate" }>;
  signal?: AbortSignal;
}): Promise<ProjectRevisionRecord> {
  const opened = await openProject(input.root);
  const tasks = await listBaiduPdfParseTasks(input.root);
  const task = tasks.find((entry) => entry.parseBatchId === input.parseBatchId);
  if (!task) throw new Error("PDF 云端任务不存在。");
  if (task.baseRevision !== undefined && task.baseRevision !== input.baseRevision)
    throw new Error(`baseRevision 与任务记录不一致：候选基线为 ${task.baseRevision}，请求为 ${input.baseRevision}。`);
  const snapshot = await findBatchParseSnapshot(opened.root, task);
  if (!snapshot) throw new Error("解析快照缺失，不能发布候选；不自动重新上传。");
  const { candidate } = await createParseMergeCandidate({
    root: opened.root,
    task,
    snapshot,
    baseRevision: input.baseRevision,
    revisionId: task.baseRevision === undefined
      ? reconvertIdentity(task.parseBatchId, input.baseRevision)
      : task.candidateRevisionId ?? reconvertIdentity(task.parseBatchId, input.baseRevision),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let resolved = candidate;
  for (const resolution of input.resolutions ?? []) {
    resolved = resolveDocumentMergeCandidateConflict(resolved, resolution.conflictId, resolution.choice);
  }
  return publishDocumentMergeCandidate(resolved);
}