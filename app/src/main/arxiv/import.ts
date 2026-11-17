// 首次导入、恢复与显式 PDF 回退交接的组合入口（SPEC-arxiv-import §6–7）。
// 只组合 project-core 与 document-core 的公开命令；不合并文档、不改写已发布 current。
import type { ArxivReference, ImportDiagnostic, PdfFallbackRequest } from "../../shared/arxiv.js";
import type {
  ArxivImportProgress,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
} from "../../shared/contracts.js";
import {
  createProject,
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
}

export interface ResumeArxivImportInput {
  root: string;
  /** 恢复快照阶段需要 transport；纯离线重新转换可省略。 */
  transport?: ArxivTransport;
  baseUrl?: string;
  signal?: AbortSignal;
  hooks?: ArxivImportProgressHooks;
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

/** 快照阶段之后的转换与发布；进度记录只补做未完成阶段。 */
async function convertAndRecord(
  root: string,
  progress: ArxivImportProgress,
  sourceSnapshotId: string,
  fetchWarnings: ImportDiagnostic[],
  hooks: ArxivImportProgressHooks | undefined,
): Promise<ArxivImportResult> {
  const result = await convertArxivSnapshot({
    root,
    sourceSnapshotId,
    hooks: convertHooks(hooks),
  });
  if (!result.ok) {
    await updateArxivImportProgress(root, {
      ...progress,
      stage: "snapshot",
      sourceSnapshotId,
      diagnostic: result.diagnostic,
      nextAction: "convert",
    });
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
  input: { transport: ArxivTransport; baseUrl?: string; signal?: AbortSignal; hooks?: ArxivImportProgressHooks },
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
  });
  if (!snapshot.ok) {
    await updateArxivImportProgress(root, {
      ...progress,
      stage: "resolve",
      diagnostic: snapshot.diagnostic,
      nextAction: "fetch-snapshot",
    });
    return { ok: false, root, diagnostic: snapshot.diagnostic };
  }
  const advanced: ArxivImportProgress = {
    reference: progress.reference,
    stage: "snapshot",
    sourceSnapshotId: snapshot.snapshot.sourceSnapshotId,
    nextAction: "convert",
  };
  await updateArxivImportProgress(root, advanced);
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
    });
    return Buffer.from(response.bytes).toString("utf8");
  }, absUrl);
  if (!resolved.ok) {
    const diagnostic =
      resolved.diagnostic.code === "arxiv-abs-fetch-failed"
        ? fatal("arxiv-abs-fetch-failed", "arxiv.abs.fetchFailed", "resolve", absUrl)
        : resolved.diagnostic;
    await updateArxivImportProgress(root, {
      reference: parsed.reference,
      stage: "resolve",
      diagnostic,
      nextAction: "fetch-snapshot",
    });
    return { ok: false, root, diagnostic };
  }
  const progress: ArxivImportProgress = {
    reference: resolved.reference,
    stage: "resolve",
    nextAction: "fetch-snapshot",
  };
  await updateArxivImportProgress(root, progress);
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
    return {
      ok: true,
      root,
      reference: {
        baseId: snapshot.baseId,
        version: snapshot.version,
        canonicalId: typeof snapshot.canonicalId === "string" ? snapshot.canonicalId : `${snapshot.baseId}v${snapshot.version}`,
      },
      revision,
      warnings: [],
    };
  }
  const progress = opened.importRecord?.arxiv;
  if (!progress)
    return { ok: false, root, diagnostic: fatal("arxiv-import-progress-missing", "arxiv.import.progressMissing", "resolve") };
  if (progress.stage === "snapshot" && progress.sourceSnapshotId !== undefined)
    return convertAndRecord(root, progress, progress.sourceSnapshotId, [], input.hooks);
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
  });
}

/**
 * 显式 PDF 回退交接（SPEC §7）：仅在用户确认后调用；只生成交接数据，
 * 不请求 PDF、不调用云解析、不改变工程与 current。版本未固定或 current
 * 已可读时拒绝——更新场景的 PDF 候选走 pdf-import 的候选协议。
 */
export function prepareArxivPdfFallback(
  opened: ProjectCoreSnapshot,
  reason: ImportDiagnostic,
  baseUrl?: string,
): PdfFallbackResult {
  const progress = opened.importRecord?.arxiv;
  const version = progress?.reference.version;
  if (!progress || version === null || version === undefined)
    return { ok: false, diagnostic: fatal("arxiv-fallback-unpinned", "arxiv.fallback.unpinned", "resolve") };
  if (opened.manifest.paper.currentRevision !== null)
    return { ok: false, diagnostic: fatal("arxiv-fallback-current-exists", "arxiv.fallback.currentExists", "resolve") };
  const reference = progress.reference;
  return {
    ok: true,
    request: {
      kind: "arxiv-pdf",
      baseId: reference.baseId,
      version,
      absUrl: endpointUrl(baseUrl, "abs", reference),
      pdfUrl: endpointUrl(baseUrl, "pdf", reference),
      reasonCode: reason.code,
      baseRevision: null,
    },
  };
}