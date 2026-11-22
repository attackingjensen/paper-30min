import { randomUUID } from "node:crypto";
import type { CoreCommand } from "../shared/contracts.js";
import { parseDocumentTree } from "../shared/document/tree.js";
import {
  commitRevision,
  createProject,
  openProject,
  publishSourceSnapshot,
  readRevision,
  readRevisionContext,
  readRevisionDocument,
  readSourceSnapshot,
} from "./project-core.js";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
  resolveDocumentMergeCandidateConflict,
} from "./document/merge.js";
import { previewDocumentCorrections, publishDocumentCorrections } from "./document/correction.js";
import { loadUpdateCandidate, resolveStoredCandidateConflict } from "./document/candidate-store.js";
import { createVerification, readVerificationRecords, verificationInheritCommitHooks } from "./pdf/verification.js";
import { snapshotLocalPdf } from "./pdf/snapshot.js";
import { importArxivPdfFallback } from "./pdf/fallback-import.js";
import { listBaiduPdfParseTasks, stopBaiduPdfParse, type BaiduPdfParseConfig } from "./parsing/baidu-task.js";
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
  ArxivPdfFallbackImportCommandResult,
  ArxivUpdateCandidateCommandResult,
  ArxivUpdateCheckCommandResult,
  ArxivUpdatePublishCommandResult,
  PdfImportCommandResult,
  PdfReparseCommandResult,
} from "../shared/contracts.js";
import type { BaiduUploadConfirmationRequest } from "../shared/parsing.js";
import { readDiagnosticArray, type ImportDiagnostic } from "../shared/arxiv.js";
import { importArxivPaper, prepareArxivPdfFallback, resumeArxivImport } from "./arxiv/import.js";
import {
  checkArxivUpdate,
  fetchArxivUpdateCandidate,
  publishArxivUpdateCandidate,
  refetchArxivSnapshot,
  reconvertArxivCandidate,
} from "./arxiv/update.js";
import { arxivFetch } from "./arxiv/transport.js";
import { isArxivFixtureEnvironment } from "./arxiv/fixture-command.js";
import type { ArxivFetchOptions, ArxivFetchResponse, ArxivTransport } from "./arxiv/fetch.js";

/** 进行中的 arXiv 导入/恢复：operationId → 取消控制器（worker 进程内权威）。 */
const arxivOperations = new Map<string, AbortController>();

/** 受控 fixture 端点门控：仅测试环境 + 回环 baseUrl 才允许回环 http；
 * 生产命令即使携带 baseUrl 也无法访问本机/私网服务。 */
function fixtureGate(baseUrl: string | undefined): boolean {
  if (
    baseUrl === undefined ||
    !isArxivFixtureEnvironment({
      baseUrl,
      testWindow: process.env.PAPER30MIN_TEST_WINDOW,
      isPackaged: process.env.PAPER30MIN_APP_IS_PACKAGED === "1",
    })
  )
    return false;
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
  coreReadRevisionContext: true,
  coreReadDocument: true,
  coreCorrectionPreview: true,
  coreCorrectionPublish: true,
  coreMergePublish: true,
  coreArxivImport: true,
  coreArxivResume: true,
  coreArxivPdfFallback: true,
  coreArxivPdfFallbackImport: true,
  coreArxivCancel: true,
  coreArxivCheckUpdate: true,
  coreArxivUpdateCandidate: true,
  coreArxivRefetch: true,
  coreArxivReconvert: true,
  coreArxivPublishCandidate: true,
  coreCandidateLoad: true,
  coreCandidateResolve: true,
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

export async function dispatchCoreCommand(command: CoreCommand, pdf?: PdfCommandContext): Promise<unknown> {
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
      let hooks = {};
      if (command.baseRevision !== null) {
        const content = command.files["document.json"];
        const bytes = content instanceof Uint8Array ? content : content?.bytes;
        if (!bytes) throw new Error("coreCommit 缺少 document.json，不能发布新 current。");
        const document = parseDocumentTree(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        hooks = verificationInheritCommitHooks({
          root: command.root,
          baseRevision: command.baseRevision,
          revisionId,
          sourceSnapshotId: command.sourceSnapshotId,
          document,
        });
      }
      return commitRevision(
        {
          root: command.root,
          baseRevision: command.baseRevision,
          sourceSnapshotId: command.sourceSnapshotId,
          revisionId,
          files: command.files,
          metadata: command.metadata,
        },
        hooks,
      );
    }
    case "coreReadSource":
      return readSourceSnapshot(command.root, command.sourceSnapshotId);
    case "coreReadRevision":
      return readRevision(command.root, command.revisionId);
    case "coreReadRevisionContext":
      return readRevisionContext(command.root, command.revisionId);
    case "coreReadDocument":
      return readRevisionDocument(command.root, command.revisionId, command.tree);
    case "coreCorrectionPreview":
      return previewDocumentCorrections({
        root: command.root,
        baseRevision: command.baseRevision,
        corrections: command.corrections,
        ...(command.revisionId === undefined ? {} : { revisionId: command.revisionId }),
      });
    case "coreCorrectionPublish": {
      const revision = await readRevision(command.root, command.baseRevision);
      // 钩子在临界区内需要修正后的树：先以基线树占位，发布重放完成后替换。
      let hookDocument = await readRevisionDocument(command.root, command.baseRevision, "document");
      const published = await publishDocumentCorrections({
        root: command.root,
        baseRevision: command.baseRevision,
        revisionId: command.revisionId,
        corrections: command.corrections,
        hooks: {
          onCommitPoint: async (point, context) => {
            if (point === "before-current-replace")
              hookDocument = await readRevisionDocument(command.root, command.revisionId, "document");
            await verificationInheritCommitHooks({
              root: command.root,
              baseRevision: command.baseRevision,
              revisionId: command.revisionId,
              sourceSnapshotId: revision.sourceSnapshotId,
              document: hookDocument,
            }).onCommitPoint?.(point, context);
          },
        },
      });
      return published;
    }
    case "coreCandidateLoad":
      return candidateSummary(
        await loadUpdateCandidate({
          root: command.root,
          revisionId: command.revisionId,
        }),
      );
    case "coreCandidateResolve":
      return candidateSummary(
        await resolveStoredCandidateConflict({
          root: command.root,
          revisionId: command.revisionId,
          conflictId: command.conflictId,
          choice: command.choice,
        }),
      );
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
    case "coreArxivPdfFallbackImport":
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
      const run =
        command.type === "coreArxivImport"
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
        if (arxivOperations.get(command.operationId) === controller) arxivOperations.delete(command.operationId);
      });
    }
    case "coreArxivCancel": {
      const controller = arxivOperations.get(command.operationId);
      controller?.abort();
      return Promise.resolve({ cancelled: controller !== undefined });
    }
    case "coreArxivCheckUpdate":
    case "coreArxivUpdateCandidate":
    case "coreArxivRefetch":
      return arxivUpdateNetworkCommand(command);
    case "coreArxivReconvert":
      return arxivCandidateCommand(
        reconvertArxivCandidate({
          root: command.root,
          sourceSnapshotId: command.sourceSnapshotId,
          baseRevision: command.baseRevision,
        }),
      );
    case "coreArxivPublishCandidate": {
      const published: ArxivUpdatePublishCommandResult = await publishArxivUpdateCandidate({
        root: command.root,
        revisionId: command.revisionId,
        sourceSnapshotId: command.sourceSnapshotId,
        baseRevision: command.baseRevision,
        ...(command.resolutions === undefined ? {} : { resolutions: command.resolutions }),
      });
      return published;
    }
    case "coreArxivPdfFallback":
      return openProject(command.root).then((opened) =>
        prepareArxivPdfFallback(opened, command.reason, command.baseUrl, command.baseRevision),
      );
    default: {
      // 穷尽校验：新增命令必须接线；已退役或伪造的命令（如 corePdfEvidence）显式拒绝。
      const retired: never = command;
      void retired;
      throw new Error("不支持的核心命令。");
    }
  }
}

async function mergePublish(command: Extract<CoreCommand, { type: "coreMergePublish" }>) {
  let candidate = await createDocumentMergeCandidate({
    root: command.root,
    baseRevision: command.baseRevision,
    sourceSnapshotId: command.sourceSnapshotId,
    candidate: command.candidate,
  });
  for (const resolution of command.resolutions ?? []) {
    candidate = resolveDocumentMergeCandidateConflict(candidate, resolution.conflictId, resolution.choice);
  }
  return publishDocumentMergeCandidate(
    candidate,
    verificationInheritCommitHooks({
      root: candidate.root,
      baseRevision: candidate.baseRevision,
      revisionId: candidate.revisionId,
      sourceSnapshotId: candidate.sourceSnapshotId,
      document: candidate.document,
    }),
  );
}

/** 候选摘要：剥离资产字节，只保留可经 IPC 序列化的树、changeset 与冲突。 */
function candidateSummary(candidate: DocumentMergeCandidate) {
  const { assets: _assets, metadata: _metadata, ...summary } = candidate;
  return summary;
}

/** §8 网络动作（检查新版／更新候选／同版重取）：与首次导入共用 operationId
 * 取消注册与受控 transport 门控；coreArxivCancel 可取消进行中的动作。 */
async function arxivUpdateNetworkCommand(
  command: Extract<CoreCommand, { type: "coreArxivCheckUpdate" | "coreArxivUpdateCandidate" | "coreArxivRefetch" }>,
): Promise<ArxivUpdateCheckCommandResult | ArxivUpdateCandidateCommandResult> {
  if (arxivOperations.has(command.operationId)) throw new Error(`arXiv 操作已在进行中：${command.operationId}`);
  const controller = new AbortController();
  arxivOperations.set(command.operationId, controller);
  const network = {
    transport: arxivTransportFor(command.baseUrl, controller.signal),
    signal: controller.signal,
    ...(command.baseUrl === undefined ? {} : { baseUrl: command.baseUrl }),
    ...(fixtureGate(command.baseUrl) ? { allowFixtureLoopback: true } : {}),
  };
  const run =
    command.type === "coreArxivCheckUpdate"
      ? checkArxivUpdate({ root: command.root, ...network })
      : arxivCandidateCommand(
          command.type === "coreArxivUpdateCandidate"
            ? fetchArxivUpdateCandidate({
                root: command.root,
                reference: command.reference,
                baseRevision: command.baseRevision,
                ...network,
              })
            : refetchArxivSnapshot({ root: command.root, baseRevision: command.baseRevision, ...network }),
        );
  try {
    return await run;
  } finally {
    if (arxivOperations.get(command.operationId) === controller) arxivOperations.delete(command.operationId);
  }
}

/** 候选结果经 IPC：剥离资产字节，保留树、changeset、冲突与警告。 */
async function arxivCandidateCommand(
  run: Promise<
    | { ok: true; outcome: "candidate"; candidate: DocumentMergeCandidate; warnings: ImportDiagnostic[] }
    | { ok: true; outcome: "reused"; sourceSnapshotId: string; warnings: ImportDiagnostic[] }
    | { ok: false; diagnostic: ImportDiagnostic }
  >,
): Promise<ArxivUpdateCandidateCommandResult> {
  const result = await run;
  if (!result.ok) return result;
  if (result.outcome === "reused")
    return { ok: true, outcome: "reused", sourceSnapshotId: result.sourceSnapshotId, warnings: result.warnings };
  return { ok: true, outcome: "candidate", candidate: candidateSummary(result.candidate), warnings: result.warnings };
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
      metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>).warnings : undefined,
    ),
  };
}

/** 云端导入／恢复／重解析命令：配置、确认与取消信号由 worker 注入；
 * 缺少配置时明确拒绝，绝不发起上传。 */
async function pdfCloudCommand(
  command: Extract<
    CoreCommand,
    | { type: "coreArxivPdfFallbackImport" }
    | { type: "corePdfImport" }
    | { type: "corePdfResume" }
    | { type: "corePdfReparse" }
    | { type: "corePdfResumeReparse" }
  >,
  pdf: PdfCommandContext | undefined,
): Promise<ArxivPdfFallbackImportCommandResult | PdfImportCommandResult | PdfReparseCommandResult> {
  if (!pdf) throw new Error("PDF 云端命令缺少本机解析配置；请在解析设置中保存后重试。");
  const base = { root: command.root, config: pdf.config, signal: pdf.signal };
  if (command.type === "coreArxivPdfFallbackImport") {
    const result = await importArxivPdfFallback({
      root: command.root,
      request: command.request,
      transport: arxivTransportFor(command.baseUrl, pdf.signal),
      // baseUrl 只在受控 fixture 门控下传入；生产命令携带的 baseUrl 不生效。
      ...(fixtureGate(command.baseUrl) ? { baseUrl: command.baseUrl } : {}),
      config: pdf.config,
      confirmUpload: pdf.confirmUpload,
      signal: pdf.signal,
      ...(fixtureGate(command.baseUrl) ? { allowFixtureLoopback: true } : {}),
    });
    return result.outcome === "candidate" ? { ...result, candidate: candidateSummary(result.candidate) } : result;
  }
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
    return result.outcome === "candidate" ? { ...result, candidate: candidateSummary(result.candidate) } : result;
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
  return result.outcome === "candidate" ? { ...result, candidate: candidateSummary(result.candidate) } : result;
}
