import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fetch, FormData, type Dispatcher } from "undici";
import {
  parseImportDiagnostic,
  type ImportDiagnostic,
} from "../../shared/arxiv.js";
import type {
  PdfParseSourceSnapshotRecord,
  PdfSourceSnapshotRecord,
} from "../../shared/contracts.js";
import type {
  BaiduPdfParseOptions,
  BaiduUploadConfirmationRequest,
  PdfParseTaskPhase,
  PdfParseTaskRecord,
} from "../../shared/parsing.js";
import { listSourceSnapshots, openProject, readSourceSnapshot } from "../project-core.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const JOB_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const STATUS_BUDGET = 1024 * 1024;
const RESULT_BUDGET = 256 * 1024 * 1024;
const TASK_BUDGET = 1024 * 1024;
const PROVIDER = "baidu-aistudio" as const;
const MODEL = "PaddleOCR-VL-1.6" as const;
const OPTIONS: BaiduPdfParseOptions = {
  useDocOrientationClassify: false,
  useDocUnwarping: false,
  useChartRecognition: false,
};
const PHASES = new Set<PdfParseTaskPhase>([
  "preparing",
  "submitting",
  "unknown",
  "querying",
  "downloading",
  "downloaded",
  "converting",
  "stopped",
  "failed",
  "remote-failed",
  "candidate-complete",
]);
const DEFINITE_REJECTIONS = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);

export interface BaiduPdfParseConfig {
  endpoint: string;
  model: typeof MODEL;
  apiKey: string;
  /** 代理由主进程机器配置构造；只存在于内存，不进入工程记录。 */
  dispatcher?: Dispatcher;
}

type BaiduPdfParseTaskPoint =
  | "submitting-persisted"
  | "job-persisted";

interface TaskHooks {
  onPoint?: (point: BaiduPdfParseTaskPoint) => void | Promise<void>;
}

interface TaskTiming {
  requestTimeoutMs?: number;
  queryWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ExecutionOptions {
  signal?: AbortSignal;
  hooks?: TaskHooks;
  timing?: TaskTiming;
}

interface ExecutionContext extends ExecutionOptions {
  root: string;
  config: BaiduPdfParseConfig;
  signal: AbortSignal;
  setBatch: (parseBatchId: string) => void;
}

class OperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperationError";
  }
}

/** 原始响应仅用于主进程内后续去敏，不属于 renderer / IPC 共享契约。 */
type PdfParseTaskResult =
  | { outcome: "cancelled" }
  | { outcome: "incomplete"; task: PdfParseTaskRecord }
  | {
      outcome: "downloaded";
      task: PdfParseTaskRecord;
      response: { bytes: Uint8Array; sha256: string };
    }
  | {
      outcome: "sanitized";
      task: PdfParseTaskRecord;
      snapshot: PdfParseSourceSnapshotRecord;
    };

const active = new Map<
  string,
  { controller: AbortController; parseBatchId: string | null }
>();

function activeKey(root: string) {
  return path.resolve(root).toLowerCase();
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OperationError("invalid-object");
  return value as Record<string, unknown>;
}

function checkedEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("百度任务地址无效。");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    !((url.protocol === "https:") || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.endsWith("/")
  )
    throw new Error("百度任务地址需要 HTTPS 且不包含凭据或查询参数；受控本机服务可用 HTTP。");
  return url.href;
}

function checkedConfig(config: BaiduPdfParseConfig): BaiduPdfParseConfig {
  const endpoint = checkedEndpoint(config.endpoint);
  if (config.model !== MODEL) throw new Error("PDF 云端解析模型不受支持。");
  if (!config.apiKey) throw new Error("缺少本机百度 Token；未发起上传或查询。");
  return { ...config, endpoint };
}

function diagnostic(code: string): ImportDiagnostic {
  const messageKeys: Record<string, string> = {
    "baidu-submit-rejected": "baidu.submit.rejected",
    "baidu-submit-unknown": "baidu.submit.unknown",
    "baidu-submit-receipt-invalid": "baidu.submit.receiptInvalid",
    "baidu-remote-failed": "baidu.remote.failed",
    "baidu-query-failed": "baidu.query.failed",
    "baidu-query-response-invalid": "baidu.query.responseInvalid",
    "baidu-query-wait-exceeded": "baidu.query.waitExceeded",
    "baidu-result-url-invalid": "baidu.result.urlInvalid",
    "baidu-download-failed": "baidu.download.failed",
    "baidu-result-digest-mismatch": "baidu.result.digestMismatch",
    "baidu-task-stopped": "baidu.task.stoppedRemoteMayContinue",
  };
  return {
    code,
    severity: "fatal",
    stage: "fetch",
    messageKey: messageKeys[code] ?? "baidu.task.recoverable",
  };
}

function parseTaskDiagnostic(value: unknown): ImportDiagnostic {
  const record = objectValue(value);
  if (Object.keys(record).some((key) => !["code", "severity", "stage", "messageKey"].includes(key)))
    throw new Error("PDF 任务诊断包含不允许持久化的字段。");
  return parseImportDiagnostic(record);
}

function parseTask(value: unknown, projectId: string, paperId: string): PdfParseTaskRecord {
  const record = objectValue(value);
  if (
    record.formatVersion !== 1 ||
    typeof record.parseBatchId !== "string" ||
    !UUID.test(record.parseBatchId) ||
    record.projectId !== projectId ||
    record.paperId !== paperId ||
    typeof record.parentSourceSnapshotId !== "string" ||
    !UUID.test(record.parentSourceSnapshotId) ||
    typeof record.pdfSha256 !== "string" ||
    !SHA256.test(record.pdfSha256) ||
    record.provider !== PROVIDER ||
    record.model !== MODEL ||
    typeof record.endpoint !== "string" ||
    checkedEndpoint(record.endpoint) !== record.endpoint ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as PdfParseTaskPhase) ||
    (record.jobId !== undefined &&
      (typeof record.jobId !== "string" || !JOB_ID.test(record.jobId))) ||
    (record.responseSha256 !== undefined &&
      (typeof record.responseSha256 !== "string" || !SHA256.test(record.responseSha256))) ||
    (record.parseSourceSnapshotId !== undefined &&
      (typeof record.parseSourceSnapshotId !== "string" || !UUID.test(record.parseSourceSnapshotId))) ||
    (record.sanitizedSha256 !== undefined &&
      (typeof record.sanitizedSha256 !== "string" || !SHA256.test(record.sanitizedSha256))) ||
    (record.parseSourceSnapshotId === undefined) !== (record.sanitizedSha256 === undefined) ||
    (record.parseSourceSnapshotId !== undefined && record.jobId === undefined) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    throw new Error("PDF 云端任务记录无效，或与工程身份不匹配。");
  const options = objectValue(record.options);
  if (
    options.useDocOrientationClassify !== false ||
    options.useDocUnwarping !== false ||
    options.useChartRecognition !== false ||
    Object.keys(options).length !== 3
  )
    throw new Error("PDF 云端任务解析选项已变化或不受支持。");
  if (record.responseSha256 !== undefined && record.jobId === undefined)
    throw new Error("PDF 云端任务缺少原任务号，不能校验响应。");
  return {
    formatVersion: 1,
    parseBatchId: record.parseBatchId,
    projectId,
    paperId,
    parentSourceSnapshotId: record.parentSourceSnapshotId,
    pdfSha256: record.pdfSha256,
    provider: PROVIDER,
    model: MODEL,
    endpoint: record.endpoint,
    options: { ...OPTIONS },
    phase: record.phase as PdfParseTaskPhase,
    ...(record.jobId === undefined ? {} : { jobId: record.jobId as string }),
    ...(record.responseSha256 === undefined
      ? {}
      : { responseSha256: record.responseSha256 as string }),
    ...(record.parseSourceSnapshotId === undefined
      ? {}
      : {
          parseSourceSnapshotId: record.parseSourceSnapshotId as string,
          sanitizedSha256: record.sanitizedSha256 as string,
        }),
    ...(record.diagnostic === undefined
      ? {}
      : { diagnostic: parseTaskDiagnostic(record.diagnostic) }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

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
      throw new Error("PDF 任务目录不能通过链接或普通文件访问。");
  }
  return target;
}

export async function saveTask(root: string, task: PdfParseTaskRecord) {
  const directory = await managedDirectory(
    root,
    `.paper30min/parsing/${task.parseBatchId}`,
    true,
  );
  if (!directory) throw new Error("PDF 任务目录不可用。");
  const bytes = Buffer.from(JSON.stringify(task, null, 2) + "\n");
  if (bytes.byteLength > TASK_BUDGET) throw new Error("PDF 任务记录超过 1 MiB 预算。");
  task.updatedAt = new Date().toISOString();
  const destination = path.join(directory, "task.json");
  const temporary = path.join(directory, `.paper30min-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(Buffer.from(JSON.stringify(task, null, 2) + "\n"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readTask(root: string, parseBatchId: string, projectId: string, paperId: string) {
  if (!UUID.test(parseBatchId)) throw new Error("PDF 解析批次 ID 无效。");
  const directory = await managedDirectory(root, `.paper30min/parsing/${parseBatchId}`, false);
  if (!directory) throw new Error("PDF 云端任务不存在。");
  const file = path.join(directory, "task.json");
  const entry = await fs.lstat(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > TASK_BUDGET)
    throw new Error("PDF 云端任务记录无效或超过读取预算。");
  const bytes = await fs.readFile(file);
  if (bytes.byteLength > TASK_BUDGET) throw new Error("PDF 云端任务记录超过读取预算。");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("PDF 云端任务记录损坏；请保留现场检查。");
  }
  return parseTask(value, projectId, paperId);
}

async function listTasks(root: string, projectId: string, paperId: string) {
  const directory = await managedDirectory(root, ".paper30min/parsing", false);
  if (!directory) return [];
  const tasks: PdfParseTaskRecord[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!UUID.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("PDF 任务目录不能是链接或普通文件。");
    try {
      tasks.push(await readTask(root, entry.name, projectId, paperId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return tasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function recoveredPhase(task: PdfParseTaskRecord): PdfParseTaskRecord {
  if (task.phase !== "preparing" && task.phase !== "submitting") return task;
  return { ...task, phase: "unknown" };
}

async function loadPdf(root: string, sourceSnapshotId: string) {
  const source = await readSourceSnapshot(root, sourceSnapshotId);
  if (
    source.kind !== "pdf" ||
    typeof source.sha256 !== "string" ||
    !SHA256.test(source.sha256) ||
    typeof source.originalName !== "string" ||
    !source.originalName ||
    !Number.isSafeInteger(source.pageCount) ||
    (source.pageCount as number) < 1 ||
    (source.pageCount as number) > 1000
  )
    throw new Error("来源快照不是可上传的有效 PDF。");
  const [file, ...rest] = source.files;
  if (rest.length || file?.path !== "paper.pdf" || file.sha256 !== source.sha256)
    throw new Error("PDF 来源快照的文件登记不完整。");
  const bytes = await fs.readFile(path.join(root, source.path, "paper.pdf"));
  if (bytes.byteLength !== file.size || hash(bytes) !== source.sha256)
    throw new Error("PDF 字节或摘要已变化，任务已失效。");
  return { source: source as PdfSourceSnapshotRecord, bytes };
}

/** 找回本批次已发布的解析快照：任务已关联时直接读取；发布后崩溃丢失关联时按批次扫描。
 * 快照与任务谱系或摘要不符立即抛错保留现场，不静默采用另一份结果。 */
export async function findBatchParseSnapshot(
  root: string,
  task: PdfParseTaskRecord,
): Promise<PdfParseSourceSnapshotRecord | undefined> {
  let candidate: PdfParseSourceSnapshotRecord | undefined;
  if (task.parseSourceSnapshotId !== undefined) {
    candidate = (await readSourceSnapshot(root, task.parseSourceSnapshotId)) as PdfParseSourceSnapshotRecord;
  } else if (task.responseSha256 !== undefined) {
    for (const snapshot of await listSourceSnapshots(root)) {
      if (snapshot.kind === "pdf-parse" && snapshot.parseBatchId === task.parseBatchId) {
        candidate = snapshot as PdfParseSourceSnapshotRecord;
        break;
      }
    }
  }
  if (!candidate) return undefined;
  const resultFile = candidate.files.find((file) => file.path === "result.jsonl");
  if (
    candidate.kind !== "pdf-parse" ||
    candidate.parentSourceSnapshotId !== task.parentSourceSnapshotId ||
    candidate.parseBatchId !== task.parseBatchId ||
    candidate.provider !== PROVIDER ||
    candidate.model !== MODEL ||
    candidate.jobId !== task.jobId ||
    candidate.responseSha256 !== task.responseSha256 ||
    typeof candidate.sanitizedSha256 !== "string" ||
    !SHA256.test(candidate.sanitizedSha256) ||
    resultFile?.sha256 !== candidate.sanitizedSha256
  )
    throw new Error("解析快照与任务记录不符，保留现场，不能采用另一份结果。");
  return candidate;
}

function assertNoBlockingTask(tasks: PdfParseTaskRecord[]) {
  const blocking = tasks.some(
    (task) => !["failed", "remote-failed", "candidate-complete"].includes(task.phase),
  );
  if (blocking)
    throw new Error("尚有提交结果不明或未完成的云端任务，请先恢复原任务，避免重复付费。");
}

export function resultResource(value: string, endpointValue: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OperationError("baidu-result-url-invalid");
  }
  const endpoint = new URL(endpointValue);
  const approvedBaiduHost =
    url.protocol === "https:" &&
    (!url.port || url.port === "443") &&
    (url.hostname === "paddleocr.aistudio-app.com" || url.hostname.endsWith(".bcebos.com"));
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(url.origin === endpoint.origin || approvedBaiduHost)
  )
    throw new OperationError("baidu-result-url-invalid");
  return url.href;
}

async function requestBytes(
  url: string,
  limit: number,
  kind: "submit" | "query" | "download",
  context: ExecutionContext,
  init: { method?: string; body?: FormData; headers?: Record<string, string> } = {},
) {
  const failureCode =
    kind === "submit"
      ? "baidu-submit-unknown"
      : kind === "query"
        ? "baidu-query-failed"
        : "baidu-download-failed";
  const timeout = AbortSignal.timeout(context.timing?.requestTimeoutMs ?? 120_000);
  const signal = kind === "submit"
    ? timeout
    : AbortSignal.any([context.signal, timeout]);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      ...(context.config.dispatcher === undefined
        ? {}
        : { dispatcher: context.config.dispatcher }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (kind === "submit" && DEFINITE_REJECTIONS.has(response.status))
        throw new OperationError("baidu-submit-rejected");
      throw new OperationError(failureCode);
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limit)
    ) {
      await response.body?.cancel();
      throw new OperationError(failureCode);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > limit) {
        await response.body?.cancel();
        throw new OperationError(failureCode);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError(failureCode);
  }
}

async function apiData(
  url: string,
  kind: "submit" | "query",
  context: ExecutionContext,
  init: { method?: string; body?: FormData } = {},
) {
  const bytes = await requestBytes(url, STATUS_BUDGET, kind, context, {
    ...init,
    headers: { Authorization: `Bearer ${context.config.apiKey}` },
  });
  try {
    const value = objectValue(JSON.parse(bytes.toString("utf8")));
    if ((value.code !== undefined && value.code !== 0) || value.data === undefined)
      throw new Error("provider envelope rejected");
    return objectValue(value.data);
  } catch {
    throw new OperationError(
      kind === "submit" ? "baidu-submit-receipt-invalid" : "baidu-query-response-invalid",
    );
  }
}

async function incomplete(
  task: PdfParseTaskRecord,
  code: string,
  phase: PdfParseTaskPhase,
  root: string,
): Promise<PdfParseTaskResult> {
  task.phase = phase;
  task.diagnostic = diagnostic(code);
  await saveTask(root, task);
  return { outcome: "incomplete", task };
}

async function submit(
  task: PdfParseTaskRecord,
  pdf: Uint8Array,
  context: ExecutionContext,
): Promise<PdfParseTaskResult | undefined> {
  const form = new FormData();
  form.set("model", task.model);
  form.set("optionalPayload", JSON.stringify(OPTIONS));
  form.set("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "paper.pdf");
  task.phase = "submitting";
  await saveTask(context.root, task);
  await context.hooks?.onPoint?.("submitting-persisted");
  context.signal.throwIfAborted();

  let jobId: string;
  try {
    const data = await apiData(task.endpoint, "submit", context, { method: "POST", body: form });
    if (typeof data.jobId !== "string" || !JOB_ID.test(data.jobId))
      throw new OperationError("baidu-submit-receipt-invalid");
    jobId = data.jobId;
  } catch (error) {
    const code = error instanceof OperationError ? error.code : "baidu-submit-receipt-invalid";
    return incomplete(
      task,
      code,
      code === "baidu-submit-rejected" ? "failed" : "unknown",
      context.root,
    );
  }
  task.jobId = jobId;
  task.phase = "querying";
  delete task.diagnostic;
  await saveTask(context.root, task);
  await context.hooks?.onPoint?.("job-persisted");
  return undefined;
}

async function queryAndDownload(
  task: PdfParseTaskRecord,
  context: ExecutionContext,
): Promise<PdfParseTaskResult> {
  try {
    if (!task.jobId) throw new Error("已受理任务缺少任务号。");
    if (task.phase !== "querying") {
      task.phase = "querying";
      await saveTask(context.root, task);
    }
    const now = context.timing?.now ?? Date.now;
    const sleep = context.timing?.sleep ?? ((ms: number, signal?: AbortSignal) =>
      delay(ms, undefined, { signal }));
    const deadline = now() + (context.timing?.queryWaitMs ?? 30 * 60_000);
    let downloadUrl: string;
    for (;;) {
      context.signal.throwIfAborted();
      const data = await apiData(`${task.endpoint}/${task.jobId}`, "query", context);
      if (data.state === "failed") throw new OperationError("baidu-remote-failed");
      if (data.state === "done") {
        let urls: Record<string, unknown>;
        try {
          urls = objectValue(data.resultUrl);
        } catch {
          throw new OperationError("baidu-query-response-invalid");
        }
        if (typeof urls.jsonUrl !== "string")
          throw new OperationError("baidu-query-response-invalid");
        downloadUrl = resultResource(urls.jsonUrl, task.endpoint);
        break;
      }
      if (data.state !== "pending" && data.state !== "running")
        throw new OperationError("baidu-query-response-invalid");
      if (now() >= deadline) throw new OperationError("baidu-query-wait-exceeded");
      await sleep(context.timing?.pollIntervalMs ?? 1500, context.signal);
    }

    task.phase = "downloading";
    await saveTask(context.root, task);
    const bytes = await requestBytes(downloadUrl, RESULT_BUDGET, "download", context);
    const responseSha256 = hash(bytes);
    if (task.responseSha256 !== undefined && task.responseSha256 !== responseSha256)
      throw new OperationError("baidu-result-digest-mismatch");
    task.responseSha256 = responseSha256;
    task.phase = "downloaded";
    delete task.diagnostic;
    await saveTask(context.root, task);
    return {
      outcome: "downloaded",
      task,
      response: { bytes, sha256: responseSha256 },
    };
  } catch (error) {
    if (error instanceof OperationError && error.code === "baidu-remote-failed")
      return incomplete(task, error.code, "remote-failed", context.root);
    if (context.signal.aborted)
      return incomplete(task, "baidu-task-stopped", "stopped", context.root);
    if (!(error instanceof OperationError)) throw error;
    const phase = error.code === "baidu-result-digest-mismatch" ? "downloading" : task.phase;
    return incomplete(task, error.code, phase, context.root);
  }
}

async function runAcceptedTask(
  task: PdfParseTaskRecord,
  context: ExecutionContext,
): Promise<PdfParseTaskResult> {
  if (context.signal.aborted)
    return incomplete(task, "baidu-task-stopped", "stopped", context.root);
  return queryAndDownload(task, context);
}

async function withActive<T>(
  root: string,
  externalSignal: AbortSignal | undefined,
  operation: (context: {
    signal: AbortSignal;
    setBatch: (parseBatchId: string) => void;
  }) => Promise<T>,
): Promise<T> {
  const key = activeKey(root);
  if (active.has(key)) throw new Error("工程已有 PDF 云端任务正在本机运行。");
  const controller = new AbortController();
  const entry: { controller: AbortController; parseBatchId: string | null } = {
    controller,
    parseBatchId: null,
  };
  active.set(key, entry);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await operation({
      signal: controller.signal,
      setBatch: (parseBatchId) => {
        entry.parseBatchId = parseBatchId;
      },
    });
  } finally {
    externalSignal?.removeEventListener("abort", abort);
    if (active.get(key) === entry) active.delete(key);
  }
}

export async function listBaiduPdfParseTasks(root: string): Promise<PdfParseTaskRecord[]> {
  const opened = await openProject(root);
  const tasks = await listTasks(opened.root, opened.manifest.id, opened.manifest.paper.id);
  return tasks.map(recoveredPhase);
}

export function stopBaiduPdfParse(root: string, parseBatchId: string): boolean {
  const task = active.get(activeKey(root));
  if (!task || task.parseBatchId !== parseBatchId) return false;
  task.controller.abort();
  return true;
}

export async function startBaiduPdfParse(input: {
  root: string;
  sourceSnapshotId: string;
  config: BaiduPdfParseConfig;
  confirmUpload: (
    request: BaiduUploadConfirmationRequest,
  ) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  hooks?: TaskHooks;
  timing?: TaskTiming;
}): Promise<PdfParseTaskResult> {
  return withActive(input.root, input.signal, async ({ signal, setBatch }) => {
    const opened = await openProject(input.root);
    const tasks = await listTasks(opened.root, opened.manifest.id, opened.manifest.paper.id);
    assertNoBlockingTask(tasks);
    const config = checkedConfig(input.config);
    const { source, bytes } = await loadPdf(opened.root, input.sourceSnapshotId);
    const confirmed = await input.confirmUpload({
      sourceSnapshotId: source.sourceSnapshotId,
      originalName: source.originalName,
      pdfSha256: source.sha256,
      pageCount: source.pageCount,
      provider: PROVIDER,
      model: MODEL,
      endpoint: config.endpoint,
      options: { ...OPTIONS },
    });
    if (!confirmed) return { outcome: "cancelled" };

    const now = new Date().toISOString();
    const task: PdfParseTaskRecord = {
      formatVersion: 1,
      parseBatchId: randomUUID(),
      projectId: opened.manifest.id,
      paperId: opened.manifest.paper.id,
      parentSourceSnapshotId: source.sourceSnapshotId,
      pdfSha256: source.sha256,
      provider: PROVIDER,
      model: MODEL,
      endpoint: config.endpoint,
      options: { ...OPTIONS },
      phase: "preparing",
      createdAt: now,
      updatedAt: now,
    };
    setBatch(task.parseBatchId);
    await saveTask(opened.root, task);
    const context: ExecutionContext = {
      root: opened.root,
      config,
      signal,
      setBatch,
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
      ...(input.timing === undefined ? {} : { timing: input.timing }),
    };
    const submitted = await submit(task, bytes, context);
    if (submitted) return submitted;
    return runAcceptedTask(task, context);
  });
}

export async function resumeBaiduPdfParse(input: {
  root: string;
  parseBatchId: string;
  config: BaiduPdfParseConfig;
  jobId?: string;
  signal?: AbortSignal;
  hooks?: TaskHooks;
  timing?: TaskTiming;
}): Promise<PdfParseTaskResult> {
  return withActive(input.root, input.signal, async ({ signal, setBatch }) => {
    const opened = await openProject(input.root);
    const config = checkedConfig(input.config);
    let task = recoveredPhase(await readTask(
      opened.root,
      input.parseBatchId,
      opened.manifest.id,
      opened.manifest.paper.id,
    ));
    setBatch(task.parseBatchId);
    if (["failed", "remote-failed", "candidate-complete"].includes(task.phase))
      throw new Error("此任务已结束，不能作为未完成任务恢复。");
    if (task.endpoint !== config.endpoint || task.model !== config.model)
      throw new Error("恢复必须使用原 endpoint、模型与解析选项，不能改传新任务。");
    const { source } = await loadPdf(opened.root, task.parentSourceSnapshotId);
    if (source.sha256 !== task.pdfSha256)
      throw new Error("PDF 摘要已变化，不能恢复此云端任务。");
    if (!task.jobId) {
      if (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId))
        throw new Error("提交结果不明，请提供百度控制台任务号；不能自动重传。");
      task.jobId = input.jobId;
    } else if (input.jobId !== undefined && input.jobId !== task.jobId) {
      throw new Error("不能把原任务改关联到另一个任务号。");
    }
    const sanitized = await findBatchParseSnapshot(opened.root, task);
    if (sanitized) {
      task.parseSourceSnapshotId = sanitized.sourceSnapshotId;
      task.sanitizedSha256 = sanitized.sanitizedSha256;
      delete task.diagnostic;
      await saveTask(opened.root, task);
      return { outcome: "sanitized", task, snapshot: sanitized };
    }
    task.phase = "querying";
    delete task.diagnostic;
    await saveTask(opened.root, task);
    const context: ExecutionContext = {
      root: opened.root,
      config,
      signal,
      setBatch,
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
      ...(input.timing === undefined ? {} : { timing: input.timing }),
    };
    return runAcceptedTask(task, context);
  });
}
