import type { CoreCommand } from "../shared/contracts.js";
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
};

export function isCoreCommand(command: { type: string }): command is CoreCommand {
  return command.type in coreCommandTypes;
}

export function dispatchCoreCommand(command: CoreCommand): Promise<unknown> {
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
    case "coreCommit":
      return commitRevision({
        root: command.root,
        baseRevision: command.baseRevision,
        sourceSnapshotId: command.sourceSnapshotId,
        revisionId: command.revisionId,
        files: command.files,
        metadata: command.metadata,
      });
    case "coreReadSource":
      return readSourceSnapshot(command.root, command.sourceSnapshotId);
    case "coreReadRevision":
      return readRevision(command.root, command.revisionId);
    case "coreReadDocument":
      return readRevisionDocument(command.root, command.revisionId, command.tree);
    case "coreMergePublish":
      return mergePublish(command);
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