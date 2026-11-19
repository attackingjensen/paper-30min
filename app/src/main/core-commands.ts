import { randomUUID } from "node:crypto";
import type { CoreCommand } from "../shared/contracts.js";
import { parseDocumentTree } from "../shared/document/tree.js";
import {
  commitRevision,
  createProject,
  openProject,
  publishSourceSnapshot,
  readRevision,
  readRevisionDocument,
  readSourceSnapshot,
} from "./project-core.js";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
  resolveDocumentMergeCandidateConflict,
} from "./document/merge.js";
import {
  createVerification,
  inheritVerificationSidecar,
  readVerificationRecords,
  recordPdfSourceEvidence,
} from "./pdf/verification.js";
import { snapshotLocalPdf } from "./pdf/snapshot.js";
import {
  listBaiduPdfParseTasks,
  stopBaiduPdfParse,
  type BaiduPdfParseConfig,
} from "./parsing/baidu-task.js";
import {
  importPdfToCurrent,
  publishParseCandidate,
  reconvertParseCandidate,
  reparsePdfToCandidate,
  resumePdfImport,
  resumePdfReparse,
} from "./parsing/pdf-import.js";
import type { DocumentMergeCandidate } from "./document/merge.js";
import type {
  PdfImportCommandResult,
  PdfReparseCommandResult,
} from "../shared/contracts.js";
import type { BaiduUploadConfirmationRequest } from "../shared/parsing.js";
import { readDiagnosticArray } from "../shared/arxiv.js";
import { importArxivPaper, prepareArxivPdfFallback, resumeArxivImport } from "./arxiv/import.js";
import { arxivFetch } from "./arxiv/transport.js";
import type { ArxivFetchOptions, ArxivFetchResponse, ArxivTransport } from "./arxiv/fetch.js";

/** 进行中的 arXiv 导入/恢复：operationId → 取消控制器（worker 进程内权威）。 */
const arxivOperations = new Map<string, AbortController>();

/** 受控 fixture 端点门控：仅测试环境 + 回环 baseUrl 才允许回环 http；
 * 生产命令即使携带 baseUrl 也无法访问本机/私网服务。 */
function fixtureGate(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || process.env.PAPER30MIN_TEST_WINDOW === undefined) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  } catch {
    return false;
  }
}

function arxivTransportFor(baseUrl: string | undefined, signal: AbortSignal): ArxivTransport {
  const allowFixtureLoopback = fixtureGate(baseUrl);
  return (url: string, options: ArxivFetchOptions): Promise<ArxivFetchResponse> =>
    arxivFetch(url, { ...options, signal, ...(allowFixtureLoopback ? { allowFixtureLoopback: true } : {}) });
}

const coreCommandTypes: Record<CoreCommand["type"], true> = {
  coreCreate: true,
  coreOpen: true,
  corePublishSource: true,
  coreCommit: true,
  coreReadSource: true,
  coreReadRevision: true,
  coreReadDocument: true,
  coreMergePublish: true,
  coreArxivImport: true,
  coreArxivResume: true,
  coreArxivPdfFallback: true,
  coreArxivCancel: true,
  corePdfSnapshot: true,
  corePdfTasks: true,
  corePdfStop: true,
  corePdfReconvert: true,
  corePdfPublishCandidate: true,
  corePdfImport: true,
  corePdfResume: true,
  corePdfReparse: true,
  corePdfResumeReparse: true,
  corePdfVerify: true,
  corePdfReadVerification: true,
  corePdfEvidence: true,
};

export function isCoreCommand(command: { type: string }): command is CoreCommand {
  return command.type in coreCommandTypes;
}

/** PDF 云端命令的进程内上下文：配置与确认由主进程／worker 注入，renderer 不持有。 */
export interface PdfCommandContext {
  config: BaiduPdfParseConfig;
  confirmUpload: (request: BaiduUploadConfirmationRequest) => boolean | Promise<boolean>;
  signal: AbortSignal;
}

export async function dispatchCoreCommand(
  command: CoreCommand,
  pdf?: PdfCommandContext,
): Promise<unknown> {
  switch (command.type) {
    case "coreCreate":
      return createProject({ parent: command.parent, name: command.name });
    case "coreOpen":
      return openProject(command.root);
    case "corePublishSource":
      return publishSourceSnapshot({
        root: command.root,
        files: command.files,
        metadata: command.metadata,
      });
    case "coreCommit": {
      const revisionId = command.revisionId ?? randomUUID();
      if (command.baseRevision !== null) {
        // 核验继承先于 current 推进（SPEC-pdf-import §11）；无旧核验记录时为空操作。
        const content = command.files["document.json"];
        const bytes = content instanceof Uint8Array ? content : content?.bytes;
        if (!bytes) throw new Error("coreCommit 缺少 document.json，不能发布新 current。");
        const document = parseDocumentTree(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        await inheritVerificationSidecar({
          root: command.root,
          baseRevision: command.baseRevision,
          revisionId,
          sourceSnapshotId: command.sourceSnapshotId,
          document,
        });
      }
      return commitRevision({
        root: command.root,
        baseRevision: command.baseRevision,
        sourceSnapshotId: command.sourceSnapshotId,
        revisionId,
        files: command.files,
        metadata: command.metadata,
      });
    }
    case "coreReadSource":
      return readSourceSnapshot(command.root, command.sourceSnapshotId);
    case "coreReadRevision":
      return readRevision(command.root, command.revisionId);
    case "coreReadDocument":
      return readRevisionDocument(command.root, command.revisionId, command.tree);
    case "coreMergePublish":
      return mergePublish(command);
    case "corePdfSnapshot":
      return snapshotLocalPdf({ root: command.root, source: command.source });
    case "corePdfTasks":
      return listBaiduPdfParseTasks(command.root);
    case "corePdfStop":
      return { stopped: stopBaiduPdfParse(command.root, command.parseBatchId) };
    case "corePdfReconvert":
      return pdfReconvert(command);
    case "corePdfPublishCandidate":
      return publishParseCandidate({
        root: command.root,
        parseBatchId: command.parseBatchId,
        baseRevision: command.baseRevision,
        ...(command.resolutions === undefined ? {} : { resolutions: command.resolutions }),
      });
    case "corePdfVerify":
      return createVerification({
        root: command.root,
        expectedRevisionId: command.expectedRevisionId,
        anchor: command.anchor,
        actor: command.actor,
      });
    case "corePdfReadVerification":
      return readVerificationRecords(command.root, command.revisionId);
    case "corePdfEvidence":
      return recordPdfSourceEvidence({
        root: command.root,
        pdfSnapshotId: command.pdfSnapshotId,
        pages: command.pages,
        sessionId: command.sessionId,
        taskId: command.taskId,
        contentSha256: command.contentSha256,
      });
    case "corePdfImport":
    case "corePdfResume":
    case "corePdfReparse":
    case "corePdfResumeReparse":
      return pdfCloudCommand(command, pdf);
    case "coreArxivImport":
    case "coreArxivResume": {
      if (arxivOperations.has(command.operationId))
        return Promise.reject(new Error(`arXiv 操作已在进行中：${command.operationId}`));
      const controller = new AbortController();
      arxivOperations.set(command.operationId, controller);
      const transport = arxivTransportFor(command.baseUrl, controller.signal);
      const run = command.type === "coreArxivImport"
        ? importArxivPaper({
            parent: command.parent,
            name: command.name,
            input: command.input,
            transport,
            signal: controller.signal,
            ...(command.baseUrl === undefined ? {} : { baseUrl: command.baseUrl }),
            ...(fixtureGate(command.baseUrl) ? { allowFixtureLoopback: true } : {}),
          })
        : resumeArxivImport({
            root: command.root,
            transport,
            signal: controller.signal,
            ...(command.baseUrl === undefined ? {} : { baseUrl: command.baseUrl }),
            ...(fixtureGate(command.baseUrl) ? { allowFixtureLoopback: true } : {}),
          });
      return run.finally(() => {
        // 仅删除本次注册的控制器，避免误删同 ID 的后续操作。
        if (arxivOperations.get(command.operationId) === controller)
          arxivOperations.delete(command.operationId);
      });
    }
    case "coreArxivCancel": {
      const controller = arxivOperations.get(command.operationId);
      controller?.abort();
      return Promise.resolve({ cancelled: controller !== undefined });
    }
    case "coreArxivPdfFallback":
      return openProject(command.root).then((opened) =>
        prepareArxivPdfFallback(opened, command.reason, command.baseUrl, command.baseRevision),
      );
  }
}

async function mergePublish(
  command: Extract<CoreCommand, { type: "coreMergePublish" }>,
) {
  let candidate = await createDocumentMergeCandidate({
    root: command.root,
    baseRevision: command.baseRevision,
    sourceSnapshotId: command.sourceSnapshotId,
    candidate: command.candidate,
  });
  for (const resolution of command.resolutions ?? []) {
    candidate = resolveDocumentMergeCandidateConflict(
      candidate,
      resolution.conflictId,
      resolution.choice,
    );
  }
  return publishDocumentMergeCandidate(candidate);
}

/** 候选摘要：剥离资产字节，只保留可经 IPC 序列化的树、changeset 与冲突。 */
function candidateSummary(candidate: DocumentMergeCandidate) {
  const { assets: _assets, metadata: _metadata, ...summary } = candidate;
  return summary;
}

async function pdfReconvert(
  command: Extract<CoreCommand, { type: "corePdfReconvert" }>,
): Promise<PdfReparseCommandResult> {
  const candidate = await reconvertParseCandidate({
    root: command.root,
    parseBatchId: command.parseBatchId,
    baseRevision: command.baseRevision,
  });
  const tasks = await listBaiduPdfParseTasks(command.root);
  const task = tasks.find((entry) => entry.parseBatchId === command.parseBatchId);
  if (!task) throw new Error("PDF 云端任务不存在。");
  const metadata = candidate.metadata?.pdfParse;
  return {
    outcome: "candidate",
    task,
    candidate: candidateSummary(candidate),
    warnings: readDiagnosticArray(
      metadata !== null && typeof metadata === "object"
        ? (metadata as Record<string, unknown>).warnings
        : undefined,
    ),
  };
}

/** 云端导入／恢复／重解析命令：配置、确认与取消信号由 worker 注入；
 * 缺少配置时明确拒绝，绝不发起上传。 */
async function pdfCloudCommand(
  command: Extract<
    CoreCommand,
    | { type: "corePdfImport" }
    | { type: "corePdfResume" }
    | { type: "corePdfReparse" }
    | { type: "corePdfResumeReparse" }
  >,
  pdf: PdfCommandContext | undefined,
): Promise<PdfImportCommandResult | PdfReparseCommandResult> {
  if (!pdf) throw new Error("PDF 云端命令缺少本机解析配置；请在解析设置中保存后重试。");
  const base = { root: command.root, config: pdf.config, signal: pdf.signal };
  if (command.type === "corePdfImport") {
    return importPdfToCurrent({
      ...base,
      sourceSnapshotId: command.sourceSnapshotId,
      confirmUpload: pdf.confirmUpload,
    });
  }
  if (command.type === "corePdfReparse") {
    const result = await reparsePdfToCandidate({
      ...base,
      sourceSnapshotId: command.sourceSnapshotId,
      baseRevision: command.baseRevision,
      confirmUpload: pdf.confirmUpload,
    });
    return result.outcome === "candidate"
      ? { ...result, candidate: candidateSummary(result.candidate) }
      : result;
  }
  if (command.type === "corePdfResume") {
    return resumePdfImport({
      ...base,
      parseBatchId: command.parseBatchId,
      ...(command.jobId === undefined ? {} : { jobId: command.jobId }),
    });
  }
  const result = await resumePdfReparse({
    ...base,
    parseBatchId: command.parseBatchId,
    ...(command.jobId === undefined ? {} : { jobId: command.jobId }),
  });
  return result.outcome === "candidate"
    ? { ...result, candidate: candidateSummary(result.candidate) }
    : result;
}