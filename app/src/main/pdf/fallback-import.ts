import type { ImportDiagnostic, PdfFallbackRequest } from "../../shared/arxiv.js";
import type { ArxivTransport } from "../arxiv/fetch.js";
import { listSourceSnapshots, openProject, readRevision, readSourceSnapshot } from "../project-core.js";
import type { BaiduPdfParseConfig } from "../parsing/baidu-task.js";
import {
  importPdfToCurrent,
  reparsePdfToCandidate,
  type PdfImportResult,
  type PdfReparseResult,
} from "../parsing/pdf-import.js";
import type { BaiduUploadConfirmationRequest } from "../../shared/parsing.js";
import { snapshotArxivPdf } from "./snapshot.js";

/** 组合交接结果：下载/快照阶段失败发生在云端任务创建之前，无任务记录可附；
 * 首次导入走 PdfImportResult，更新场景走重解析候选 PdfReparseResult。 */
export type ArxivPdfFallbackImportResult =
  | { outcome: "snapshot-failed"; diagnostic: ImportDiagnostic }
  | PdfImportResult
  | PdfReparseResult;

function mismatch(root: string): never {
  throw new Error(`回退交接与工程现场不符（${root}）：拒绝下载其他版本或绕过基线。`);
}

/** 交接请求必须与工程谱系一致（SPEC-pdf-import §3.4、§7）：首次导入比对
 * 导入记录的固定版本；更新场景比对当前 revision 的 arXiv 来源与 baseRevision。
 * renderer 传来的请求不可信，主进程重新核验后才访问网络。 */
async function assertHandoffMatchesProject(root: string, request: PdfFallbackRequest): Promise<void> {
  const opened = await openProject(root);
  const current = opened.manifest.paper.currentRevision;
  if (request.baseRevision === null) {
    if (current !== null) mismatch(root);
    const progress = opened.importRecord?.arxiv;
    const reference = progress?.reference;
    if (
      !reference ||
      reference.baseId !== request.baseId ||
      reference.version !== request.version
    )
      mismatch(root);
    return;
  }
  if (current === null || current !== request.baseRevision) mismatch(root);
  const revision = await readRevision(opened.root, current);
  const snapshot = await readSourceSnapshot(opened.root, revision.sourceSnapshotId);
  if (
    snapshot.kind !== "arxiv" ||
    snapshot.baseId !== request.baseId ||
    snapshot.version !== request.version
  )
    mismatch(root);
}

/** 同固定版本谱系的既有 PDF 快照直接复用（SPEC §3.5 摘要复用）：
 * 拒绝上传后重试不重复下载；谱系不符的快照不会被误用。 */
async function reusableArxivPdfSnapshot(
  root: string,
  request: PdfFallbackRequest,
): Promise<string | undefined> {
  for (const existing of await listSourceSnapshots(root)) {
    if (existing.kind !== "pdf") continue;
    const arxiv = existing.arxiv;
    if (
      typeof arxiv === "object" && arxiv !== null &&
      "baseId" in arxiv && arxiv.baseId === request.baseId &&
      "version" in arxiv && arxiv.version === request.version
    )
      return existing.sourceSnapshotId;
  }
  return undefined;
}

/** arXiv 固定版本 PDF 回退组合入口（SPEC-pdf-import §3.4、Testing Strategy 第 6 条）：
 * 同一工程与 paper.id 内下载固定 vN PDF 形成不可变快照，随后走首次导入／更新
 * 的既有云端链路。上传确认沿用显式应答：确认前零 POST；拒绝时 PDF 快照保留，
 * 重试不重复下载同字节来源。下载失败不创建云端任务、不产生费用。 */
export async function importArxivPdfFallback(input: {
  root: string;
  request: PdfFallbackRequest;
  transport: ArxivTransport;
  config: BaiduPdfParseConfig;
  confirmUpload: (request: BaiduUploadConfirmationRequest) => boolean | Promise<boolean>;
  signal: AbortSignal;
  allowFixtureLoopback?: boolean;
}): Promise<ArxivPdfFallbackImportResult> {
  if (input.request.kind !== "arxiv-pdf")
    throw new Error("回退交接必须是 arxiv-pdf 请求。");
  await assertHandoffMatchesProject(input.root, input.request);
  const reused = await reusableArxivPdfSnapshot(input.root, input.request);
  let sourceSnapshotId: string;
  if (reused !== undefined) {
    sourceSnapshotId = reused;
  } else {
    const snapshot = await snapshotArxivPdf({
      root: input.root,
      request: input.request,
      transport: input.transport,
      signal: input.signal,
      ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
    });
    if (!snapshot.ok) return { outcome: "snapshot-failed", diagnostic: snapshot.diagnostic };
    sourceSnapshotId = snapshot.snapshot.sourceSnapshotId;
  }
  input.signal.throwIfAborted();
  if (input.request.baseRevision === null) {
    return importPdfToCurrent({
      root: input.root,
      sourceSnapshotId,
      config: input.config,
      confirmUpload: input.confirmUpload,
      signal: input.signal,
    });
  }
  // 更新场景：current 已可读，回退结果走重解析候选而不是覆盖 current。
  return reparsePdfToCandidate({
    root: input.root,
    sourceSnapshotId,
    baseRevision: input.request.baseRevision,
    config: input.config,
    confirmUpload: input.confirmUpload,
    signal: input.signal,
  });
}