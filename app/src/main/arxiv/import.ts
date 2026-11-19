// 首次导入、恢复与显式 PDF 回退交接的组合入口（SPEC-arxiv-import §6–7）。
// 只组合 project-core 与 document-core 的公开命令；不合并文档、不改写已发布 current。
import type { ArxivReference, ImportDiagnostic, PdfFallbackRequest } from "../../shared/arxiv.js";
import { readDiagnosticArray } from "../../shared/arxiv.js";
import type {
  ArxivImportProgress,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
} from "../../shared/contracts.js";
import {
  createProject,
  inspectImportCandidate,
  openProject,
  readRevision,
  readSourceSnapshot,
  updateArxivImportProgress,
  type ProjectCommitHooks,
} from "../project-core.js";
import { convertArxivSnapshot, type ArxivConvertPoint } from "./convert.js";
import type { ArxivTransport } from "./fetch.js";
import { parseArxivReference } from "./reference.js";
import { fetchArxivSnapshot } from "./snapshot.js";
import { resolveArxivVersion } from "./version.js";

const ABS_BUDGET_BYTES = 8 * 1024 * 1024;
/** revision 元数据中的 arXiv 转换记录（convertArxivSnapshot 发布时写入）。 */
interface ArxivRevisionMetadata {
  converterVersion?: number;
  warnings?: ImportDiagnostic[];
}

/** 从受管记录的开放元数据中读取诊断数组；完整校验，畸形条目剔除。 */
function persistedWarnings(record: Record<string, unknown>, key: string): ImportDiagnostic[] {
  return readDiagnosticArray(record[key]);
}

function revisionArxivMetadata(revision: ProjectRevisionRecord): ArxivRevisionMetadata {
  const value = revision.arxiv;
  if (value === null || typeof value !== "object") return {};
  const record: Record<string, unknown> = { ...value };
  return {
    ...(typeof record.converterVersion === "number" && Number.isInteger(record.converterVersion) && record.converterVersion >= 1
      ? { converterVersion: record.converterVersion } : {}),
    warnings: readDiagnosticArray(record.warnings),
  };
}

export interface ArxivImportProgressHooks {
  /** project-core 提交点故障注入（source-content / before-current-replace 等）。 */
  onCommitPoint?: ProjectCommitHooks["onCommitPoint"];
  /** 转换阶段故障注入（candidate-built / before-publish）。 */
  onConvertPoint?: (point: ArxivConvertPoint) => void | Promise<void>;
}

export interface ImportArxivPaperInput {
  parent: string;
  name: string;
  /** 用户输入的裸 ID、arXiv: 前缀或官方 URL；可无版本。 */
  input: string;
  transport: ArxivTransport;
  /** 端点基址注入点：生产默认 https://arxiv.org；受控测试映射到本地 fixtures。 */
  baseUrl?: string;
  signal?: AbortSignal;
  hooks?: ArxivImportProgressHooks;
  /** 受控 fixture 端点（回环 http）专用；生产命令不得开启。 */
  allowFixtureLoopback?: boolean;
}

export interface ResumeArxivImportInput {
  root: string;
  /** 恢复快照阶段需要 transport；纯离线重新转换可省略。 */
  transport?: ArxivTransport;
  baseUrl?: string;
  signal?: AbortSignal;
  hooks?: ArxivImportProgressHooks;
  /** 受控 fixture 端点（回环 http）专用；生产命令不得开启。 */
  allowFixtureLoopback?: boolean;
}

export type ArxivImportResult =
  | {
      ok: true;
      root: string;
      reference: ArxivReference;
      revision: ProjectRevisionRecord;
      warnings: ImportDiagnostic[];
    }
  | { ok: false; root: string; diagnostic: ImportDiagnostic };

export type PdfFallbackResult =
  | { ok: true; request: PdfFallbackRequest }
  | { ok: false; diagnostic: ImportDiagnostic };

function fatal(
  code: string,
  messageKey: string,
  stage: ImportDiagnostic["stage"],
  sourceUrl?: string,
): ImportDiagnostic {
  return { code, severity: "fatal", stage, messageKey, ...(sourceUrl === undefined ? {} : { sourceUrl }) };
}

function endpointUrl(baseUrl: string | undefined, endpoint: "abs" | "html" | "pdf", reference: ArxivReference): string {
  const base = (baseUrl ?? "https://arxiv.org").replace(/\/+$/, "");
  const id = reference.version === null ? reference.baseId : reference.canonicalId;
  return `${base}/${endpoint}/${id}`;
}

function convertHooks(hooks: ArxivImportProgressHooks | undefined) {
  return {
    ...(hooks?.onConvertPoint === undefined ? {} : { onConvertPoint: hooks.onConvertPoint }),
    ...(hooks?.onCommitPoint === undefined ? {} : { commitHooks: { onCommitPoint: hooks.onCommitPoint } }),
  };
}

/** 快照阶段之后的转换与发布；进度记录只补做未完成阶段。
 * 候选构建后先持久化 revisionId 与警告：current 推进中断时恢复沿用同一候选。 */
async function convertAndRecord(
  root: string,
  progress: ArxivImportProgress,
  sourceSnapshotId: string,
  fetchWarnings: ImportDiagnostic[],
  hooks: ArxivImportProgressHooks | undefined,
  completePublished = false,
): Promise<ArxivImportResult> {
  // 候选身份在本次调用内跟踪：持久化失败或提交中断后，失败记录仍携带它。
  let candidateRevisionId = progress.candidateRevisionId;
  let convertWarnings = progress.convertWarnings;
  const result = await convertArxivSnapshot({
    root,
    sourceSnapshotId,
    ...(candidateRevisionId === undefined ? {} : { revisionId: candidateRevisionId }),
    ...(completePublished && candidateRevisionId !== undefined ? { completePublished: true } : {}),
    onCandidateBuilt: async (candidate) => {
      candidateRevisionId = candidate.revisionId;
      convertWarnings = candidate.warnings;
      await updateArxivImportProgress(root, {
        ...progress,
        stage: "convert",
        sourceSnapshotId,
        candidateRevisionId: candidate.revisionId,
        convertWarnings: candidate.warnings,
        nextAction: "convert",
      });
    },
    hooks: convertHooks(hooks),
  });
  if (!result.ok) {
    try {
      await updateArxivImportProgress(root, {
        ...progress,
        stage: candidateRevisionId === undefined ? "snapshot" : "convert",
        sourceSnapshotId,
        ...(candidateRevisionId === undefined ? {} : { candidateRevisionId }),
        ...(convertWarnings === undefined ? {} : { convertWarnings }),
        diagnostic: result.diagnostic,
        nextAction: "convert",
      });
    } catch {
      // 失败记录写入也失败（持续磁盘故障/current 已被推进）：
      // 仍返回结构化诊断，不让原始异常穿透 IPC；现场保留可恢复。
    }
    return { ok: false, root, diagnostic: result.diagnostic };
  }
  return {
    ok: true,
    root,
    reference: progress.reference,
    revision: result.revision,
    warnings: [...fetchWarnings, ...result.warnings],
  };
}

/** 获取并发布快照，然后转换发布首个 current；失败保留工程与恢复记录。 */
async function fetchConvertPipeline(
  root: string,
  progress: ArxivImportProgress,
  input: { transport: ArxivTransport; baseUrl?: string; signal?: AbortSignal; hooks?: ArxivImportProgressHooks; allowFixtureLoopback?: boolean },
): Promise<ArxivImportResult> {
  if (progress.reference.version === null)
    return { ok: false, root, diagnostic: fatal("arxiv-version-unpinned", "arxiv.version.unpinned", "resolve") };
  const snapshot = await fetchArxivSnapshot({
    root,
    reference: progress.reference,
    transport: input.transport,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.hooks?.onCommitPoint === undefined ? {} : { hooks: { onCommitPoint: input.hooks.onCommitPoint } }),
    ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
  });
  if (!snapshot.ok) {
    try {
      await updateArxivImportProgress(root, {
        ...progress,
        stage: "resolve",
        diagnostic: snapshot.diagnostic,
        nextAction: "fetch-snapshot",
      });
    } catch {
      // 失败记录写入也失败：保留原结构化诊断，不让异常穿透。
    }
    return { ok: false, root, diagnostic: snapshot.diagnostic };
  }
  const advanced: ArxivImportProgress = {
    reference: progress.reference,
    stage: "snapshot",
    sourceSnapshotId: snapshot.snapshot.sourceSnapshotId,
    nextAction: "convert",
  };
  try {
    await updateArxivImportProgress(root, advanced);
  } catch (error) {
    // 快照已发布但进度记录写入失败：结构化诊断，现场保留可恢复。
    return {
      ok: false,
      root,
      diagnostic: fatal(
        "arxiv-import-progress-failed",
        `arxiv.import.progressFailed:${error instanceof Error ? error.message : String(error)}`,
        "snapshot",
      ),
    };
  }
  return convertAndRecord(root, advanced, snapshot.snapshot.sourceSnapshotId, snapshot.warnings, input.hooks);
}

/**
 * 首次导入（SPEC §6）：本地校验引用→创建工程与恢复记录→abs 固定版本→
 * 快照→转换→原子推进 current。任何阶段失败都保留工程与诊断，不请求 PDF。
 */
export async function importArxivPaper(input: ImportArxivPaperInput): Promise<ArxivImportResult> {
  const parsed = parseArxivReference(input.input);
  if (!parsed.ok) return { ok: false, root: "", diagnostic: parsed.diagnostic };

  let created: ProjectCoreSnapshot;
  try {
    created = await createProject(
      { parent: input.parent, name: input.name },
      input.hooks?.onCommitPoint === undefined ? {} : { onCommitPoint: input.hooks.onCommitPoint },
    );
  } catch (error) {
    return {
      ok: false,
      root: "",
      diagnostic: fatal(
        "arxiv-import-create-failed",
        `arxiv.import.createFailed:${error instanceof Error ? error.message : String(error)}`,
        "resolve",
      ),
    };
  }
  const root = created.root;
  const absUrl = endpointUrl(input.baseUrl, "abs", parsed.reference);
  const resolved = await resolveArxivVersion(parsed.reference, async (url) => {
    const response = await input.transport(url, {
      budgetBytes: ABS_BUDGET_BYTES,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
    });
    return Buffer.from(response.bytes).toString("utf8");
  }, absUrl);
  if (!resolved.ok) {
    const diagnostic = resolved.diagnostic;
    try {
      await updateArxivImportProgress(root, {
        reference: parsed.reference,
        stage: "resolve",
        diagnostic,
        nextAction: "fetch-snapshot",
      });
    } catch {
      // 失败记录写入也失败：保留原结构化诊断。
    }
    return { ok: false, root, diagnostic };
  }
  const progress: ArxivImportProgress = {
    reference: resolved.reference,
    stage: "resolve",
    nextAction: "fetch-snapshot",
  };
  try {
    await updateArxivImportProgress(root, progress);
  } catch (error) {
    return {
      ok: false,
      root,
      diagnostic: fatal(
        "arxiv-import-progress-failed",
        `arxiv.import.progressFailed:${error instanceof Error ? error.message : String(error)}`,
        "resolve",
      ),
    };
  }
  return fetchConvertPipeline(root, progress, input);
}

/**
 * 恢复首次导入：只补做未完成阶段；已验证快照按摘要复用，不重复产生同内容身份。
 * current 已存在时幂等返回既有 revision；离线重新转换不需要 transport。
 */
export async function resumeArxivImport(input: ResumeArxivImportInput): Promise<ArxivImportResult> {
  const opened = await openProject(input.root);
  const root = opened.root;
  if (opened.manifest.paper.currentRevision !== null) {
    const revision = await readRevision(root, opened.manifest.paper.currentRevision);
    const snapshot = await readSourceSnapshot(root, revision.sourceSnapshotId);
    if (snapshot.kind !== "arxiv" || typeof snapshot.baseId !== "string" || typeof snapshot.version !== "number")
      return { ok: false, root, diagnostic: fatal("arxiv-import-source-invalid", "arxiv.import.sourceInvalid", "resolve") };
    let persisted: ArxivRevisionMetadata;
    let snapshotWarnings: ImportDiagnostic[];
    try {
      persisted = revisionArxivMetadata(revision);
      snapshotWarnings = persistedWarnings(snapshot, "warnings");
    } catch (error) {
      return {
        ok: false,
        root,
        diagnostic: fatal(
          "arxiv-import-record-corrupt",
          `arxiv.import.recordCorrupt:${error instanceof Error ? error.message : String(error)}`,
          "convert",
        ),
      };
    }
    return {
      ok: true,
      root,
      reference: {
        baseId: snapshot.baseId,
        version: snapshot.version,
        canonicalId: typeof snapshot.canonicalId === "string" ? snapshot.canonicalId : `${snapshot.baseId}v${snapshot.version}`,
      },
      revision,
      warnings: [...snapshotWarnings, ...(persisted.warnings ?? [])],
    };
  }
  const progress = opened.importRecord?.arxiv;
  if (!progress)
    return { ok: false, root, diagnostic: fatal("arxiv-import-progress-missing", "arxiv.import.progressMissing", "resolve") };
  if ((progress.stage === "snapshot" || progress.stage === "convert") && progress.sourceSnapshotId !== undefined) {
    const snapshot = await readSourceSnapshot(root, progress.sourceSnapshotId);
    let fetchWarnings: ImportDiagnostic[];
    try {
      fetchWarnings = persistedWarnings(snapshot, "warnings");
    } catch (error) {
      return {
        ok: false,
        root,
        diagnostic: fatal(
          "arxiv-import-record-corrupt",
          `arxiv.import.recordCorrupt:${error instanceof Error ? error.message : String(error)}`,
          "convert",
        ),
      };
    }
    // 候选状态探测与残留清理在 project-core 串行临界区内执行：
    // published → 只补 current 推进；residual/absent → 按同一身份重新转换发布。
    let published = false;
    if (progress.candidateRevisionId !== undefined) {
      let state: "published" | "residual" | "absent";
      try {
        state = await inspectImportCandidate(root, progress.candidateRevisionId);
      } catch (error) {
        return {
          ok: false,
          root,
          diagnostic: fatal(
            "arxiv-import-candidate-inspect-failed",
            `arxiv.import.candidateInspectFailed:${error instanceof Error ? error.message : String(error)}`,
            "convert",
          ),
        };
      }
      published = state === "published";
    }
    return convertAndRecord(root, progress, progress.sourceSnapshotId, fetchWarnings, input.hooks, published);
  }
  if (input.transport === undefined)
    return {
      ok: false,
      root,
      diagnostic: fatal("arxiv-import-transport-required", "arxiv.import.transportRequired", "fetch"),
    };
  return fetchConvertPipeline(root, progress, {
    transport: input.transport,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
  });
}

/**
 * 显式 PDF 回退交接（SPEC §7）：仅在用户确认后调用；只生成交接数据，
 * 不请求 PDF、不调用云解析、不改变工程与 current。
 * 首次导入 baseRevision=null；更新场景必须携带调用方读取时的 baseRevision，
 * 与 current 不一致即拒绝（stale base），身份取自 current 的 arXiv 来源快照。
 */
export async function prepareArxivPdfFallback(
  opened: ProjectCoreSnapshot,
  reason: ImportDiagnostic,
  baseUrl?: string,
  baseRevision?: string | null,
): Promise<PdfFallbackResult> {
  // 以最新清单裁决 stale base：调用方持有的 opened 可能已过期。
  const latest = await openProject(opened.root);
  const current = latest.manifest.paper.currentRevision;
  let reference: ArxivReference;
  let handoffBase: string | null;
  if (current === null) {
    const progress = latest.importRecord?.arxiv;
    const version = progress?.reference.version;
    if (!progress || version === null || version === undefined)
      return { ok: false, diagnostic: fatal("arxiv-fallback-unpinned", "arxiv.fallback.unpinned", "resolve") };
    if (baseRevision !== undefined && baseRevision !== null)
      return { ok: false, diagnostic: fatal("arxiv-fallback-base-mismatch", "arxiv.fallback.baseMismatch", "resolve") };
    reference = progress.reference;
    handoffBase = null;
  } else {
    if (baseRevision !== current)
      return { ok: false, diagnostic: fatal("arxiv-fallback-base-mismatch", "arxiv.fallback.baseMismatch", "resolve") };
    const revision = await readRevision(latest.root, current);
    const snapshot = await readSourceSnapshot(latest.root, revision.sourceSnapshotId);
    if (snapshot.kind !== "arxiv" || typeof snapshot.baseId !== "string" || typeof snapshot.version !== "number")
      return { ok: false, diagnostic: fatal("arxiv-fallback-source-invalid", "arxiv.fallback.sourceInvalid", "resolve") };
    reference = {
      baseId: snapshot.baseId,
      version: snapshot.version,
      canonicalId: typeof snapshot.canonicalId === "string" ? snapshot.canonicalId : `${snapshot.baseId}v${snapshot.version}`,
    };
    handoffBase = current;
  }
  return {
    ok: true,
    request: {
      kind: "arxiv-pdf",
      baseId: reference.baseId,
      version: reference.version as number,
      // 交接只携带身份事实；下载 URL 由主进程在 snapshotArxivPdf 重建。
      reasonCode: reason.code,
      baseRevision: handoffBase,
    },
  };
}