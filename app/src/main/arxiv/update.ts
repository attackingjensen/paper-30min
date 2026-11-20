// 新版本检查、同版重取与更新候选编排（SPEC-arxiv-import §8）。
// 只组合既有原语：fetchArxivSnapshot 同字节复用/异字节新建、
// convertArxivSnapshotTree 离线转换、document-core 三方合并与发布。
// 所有动作都是用户显式触发；候选确认发布前 current 不变，不做后台自动更新。
import { createHash } from "node:crypto";
import type { ArxivReference, ImportDiagnostic } from "../../shared/arxiv.js";
import type { ProjectRevisionRecord } from "../../shared/contracts.js";
import { openProject, readRevision, readSourceSnapshot } from "../project-core.js";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
  resolveDocumentMergeCandidateConflict,
  type DocumentMergeCandidate,
} from "../document/merge.js";
import { loadUpdateCandidate, storeUpdateCandidate } from "../document/candidate-store.js";
import { verificationInheritCommitHooks } from "../pdf/verification.js";
import { convertArxivSnapshotTree, convertLatexml } from "./convert.js";
import { fetchDiagnostic, type ArxivTransport } from "./fetch.js";
import { arxivLineageReference } from "./lineage.js";
import { fetchArxivSnapshot } from "./snapshot.js";
import { arxivVersionStatus, assertArxivVersionAvailable } from "./version.js";

const ABS_BUDGET_BYTES = 8 * 1024 * 1024;

function fatal(
  code: string,
  messageKey: string,
  stage: ImportDiagnostic["stage"],
  sourceUrl?: string,
): { ok: false; diagnostic: ImportDiagnostic } {
  return {
    ok: false,
    diagnostic: { code, severity: "fatal", stage, messageKey, ...(sourceUrl === undefined ? {} : { sourceUrl }) },
  };
}

/** current 的 arXiv 谱系（含 PDF 回退回溯）；无 current、无谱系或谱系损坏时返回诊断。 */
async function currentReference(root: string): Promise<
  | { ok: true; reference: ArxivReference & { version: number }; currentRevision: string }
  | { ok: false; diagnostic: ImportDiagnostic }
> {
  const opened = await openProject(root);
  const current = opened.manifest.paper.currentRevision;
  if (current === null)
    return fatal("arxiv-update-current-missing", "arxiv.update.currentMissing", "resolve");
  const revision = await readRevision(opened.root, current);
  let reference: ArxivReference | null;
  try {
    reference = await arxivLineageReference(opened.root, revision.sourceSnapshotId);
  } catch {
    reference = null;
  }
  if (reference === null || reference.version === null)
    return fatal("arxiv-update-source-invalid", "arxiv.update.sourceInvalid", "resolve");
  return { ok: true, reference: { ...reference, version: reference.version }, currentRevision: current };
}

interface UpdateNetworkInput {
  transport: ArxivTransport;
  baseUrl?: string;
  signal?: AbortSignal;
  allowFixtureLoopback?: boolean;
}

function endpoint(baseUrl: string | undefined, path: string): string {
  return `${(baseUrl ?? "https://arxiv.org").replace(/\/+$/, "")}${path}`;
}

async function fetchAbs(input: UpdateNetworkInput, url: string): Promise<
  { ok: true; html: string } | { ok: false; diagnostic: ImportDiagnostic }
> {
  try {
    const response = await input.transport(url, {
      budgetBytes: ABS_BUDGET_BYTES,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
    });
    return { ok: true, html: Buffer.from(response.bytes).toString("utf8") };
  } catch (error) {
    return { ok: false, diagnostic: fetchDiagnostic(error, url, "abs", "resolve") };
  }
}

export type ArxivUpdateCheckResult =
  | {
      ok: true;
      current: ArxivReference;
      /** update-available：存在更高版本；up-to-date：已最新；withdrawn：最新版已撤稿。 */
      status: "update-available" | "up-to-date" | "withdrawn";
      latest: ArxivReference;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

/** 检查新版本（SPEC §8.1）：只获取 abs 元数据并比较固定版本；不下载 HTML/PDF、
 * 不生成候选、不推进 current。同版远端 HTML 字节变化不参与比较（§8.3）。 */
export async function checkArxivUpdate(input: UpdateNetworkInput & { root: string }): Promise<ArxivUpdateCheckResult> {
  const lineage = await currentReference(input.root);
  if (!lineage.ok) return lineage;
  const absUrl = endpoint(input.baseUrl, `/abs/${lineage.reference.baseId}`);
  const abs = await fetchAbs(input, absUrl);
  if (!abs.ok) return abs;
  const status = arxivVersionStatus(abs.html, lineage.reference, absUrl);
  if (!status.ok) return status;
  return {
    ok: true,
    current: lineage.reference,
    status: status.withdrawn ? "withdrawn" : status.upToDate ? "up-to-date" : "update-available",
    latest: status.latest,
  };
}

/** 确定性 UUID 派生（与 pdf-import 重转换同一形状）：同一快照与基线沿用同一候选身份。 */
function candidateIdentity(seed: string): string {
  const identity = createHash("sha256").update(seed).digest("hex");
  return `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(12, 15)}-8${identity.slice(15, 18)}-${identity.slice(18, 30)}`;
}

export type ArxivUpdateCandidateResult =
  | { ok: true; outcome: "candidate"; candidate: DocumentMergeCandidate; warnings: ImportDiagnostic[] }
  | { ok: false; diagnostic: ImportDiagnostic };

/** 候选构建入口的统一守卫：基线必须等于 current，选定快照必须属于同一
 * arXiv base ID 且携带有效固定版本（renderer 输入不可信，不能借 reconvert/publish
 * 并入其他来源或损坏谱系）。 */
async function assertCandidateBaseline(input: {
  root: string;
  sourceSnapshotId: string;
  baseRevision: string;
}): Promise<{ ok: true } | { ok: false; diagnostic: ImportDiagnostic }> {
  const lineage = await currentReference(input.root);
  if (!lineage.ok) return lineage;
  if (input.baseRevision !== lineage.currentRevision)
    return fatal(
      "arxiv-update-base-mismatch",
      `arxiv.update.baseMismatch:候选基线为 ${input.baseRevision}，current 为 ${lineage.currentRevision}。`,
      "resolve",
    );
  let snapshot;
  try {
    snapshot = await readSourceSnapshot(input.root, input.sourceSnapshotId);
  } catch {
    return fatal("arxiv-update-snapshot-missing", "arxiv.update.snapshotMissing", "resolve");
  }
  if (snapshot.kind !== "arxiv" || snapshot.baseId !== lineage.reference.baseId)
    return fatal("arxiv-update-identity-mismatch", "arxiv.update.identityMismatch", "resolve");
  if (
    typeof snapshot.version !== "number" || !Number.isInteger(snapshot.version) || snapshot.version < 1 ||
    (snapshot.canonicalId !== undefined && snapshot.canonicalId !== `${snapshot.baseId}v${snapshot.version}`)
  )
    return fatal("arxiv-update-source-invalid", "arxiv.update.sourceInvalid", "resolve");
  return { ok: true };
}

/** 快照 → 三方合并候选（SPEC §8.2/§8.4/§8.5 共用尾段）：离线转换后交由
 * document-core 与旧 source-base、current 合并；候选整体落盘后才返回——
 * 发布重载同一份字节，不重新转换（新增节点 UUID 不可重放）。不推进 current。 */
async function mergeCandidateFromSnapshot(input: {
  root: string;
  sourceSnapshotId: string;
  baseRevision: string;
  /** 获取阶段警告（外部资产未抓取等），随候选持久化供发布结果回显。 */
  fetchWarnings?: ImportDiagnostic[];
  /** 转换器升级注入（测试模拟未来版本）；生产默认当前转换器。 */
  converter?: typeof convertLatexml;
}): Promise<ArxivUpdateCandidateResult> {
  const guard = await assertCandidateBaseline(input);
  if (!guard.ok) return guard;
  const converted = await convertArxivSnapshotTree({
    root: input.root,
    sourceSnapshotId: input.sourceSnapshotId,
    ...(input.converter === undefined ? {} : { converter: input.converter }),
  });
  if (!converted.ok) return converted;
  const warnings = [...(input.fetchWarnings ?? []), ...converted.warnings];
  try {
    const merged = await createDocumentMergeCandidate({
      root: input.root,
      baseRevision: input.baseRevision,
      sourceSnapshotId: input.sourceSnapshotId,
      candidate: converted.tree,
      derivedAssets: converted.assetBytes,
      // 转换器版本纳入候选身份：升级后重转换形成新候选，不静默复用旧版本存储。
      revisionId: candidateIdentity(`arxiv-candidate:${input.sourceSnapshotId}:${input.baseRevision}:v${converted.converterVersion}`),
    });
    const candidate: DocumentMergeCandidate = {
      ...merged,
      metadata: {
        arxiv: { converterVersion: converted.converterVersion, warnings },
      },
    };
    const stored = await storeUpdateCandidate(candidate);
    const storedMeta = stored.metadata?.arxiv;
    const storedWarnings = storedMeta !== null && typeof storedMeta === "object" && "warnings" in storedMeta && Array.isArray(storedMeta.warnings)
      ? storedMeta.warnings as ImportDiagnostic[]
      : warnings;
    return { ok: true, outcome: "candidate", candidate: stored, warnings: storedWarnings };
  } catch (error) {
    return fatal(
      "arxiv-update-merge-failed",
      `arxiv.update.mergeFailed:${error instanceof Error ? error.message : String(error)}`,
      "convert",
    );
  }
}

/** 获取新版候选（SPEC §8.2）：用户显式选择后调用。目标必须同一 base ID、
 * 严格高于当前固定版本且非撤稿；同版刷新走 refetch，历史版本不借更新降级。
 * 快照获取与转换后走三方合并，确认发布前 current 不变。 */
export async function fetchArxivUpdateCandidate(
  input: UpdateNetworkInput & { root: string; baseRevision: string; reference: ArxivReference },
): Promise<ArxivUpdateCandidateResult> {
  const lineage = await currentReference(input.root);
  if (!lineage.ok) return lineage;
  const target = input.reference;
  if (target.version === null || !Number.isInteger(target.version) || target.version < 1)
    return fatal("arxiv-version-unpinned", "arxiv.version.unpinned", "resolve");
  if (target.baseId !== lineage.reference.baseId)
    return fatal("arxiv-update-identity-mismatch", "arxiv.update.identityMismatch", "resolve");
  if (target.version <= lineage.reference.version)
    return fatal("arxiv-update-version-not-newer", "arxiv.update.versionNotNewer", "resolve");
  if (input.baseRevision !== lineage.currentRevision)
    return fatal(
      "arxiv-update-base-mismatch",
      `arxiv.update.baseMismatch:候选基线为 ${input.baseRevision}，current 为 ${lineage.currentRevision}。`,
      "resolve",
    );
  const pinned = { ...target, version: target.version, canonicalId: `${target.baseId}v${target.version}` };
  // 获取 HTML 前只读目标版本 abs：撤稿/不存在版本不产生候选（§8.2、错误恢复契约）。
  const absUrl = endpoint(input.baseUrl, `/abs/${pinned.canonicalId}`);
  const abs = await fetchAbs(input, absUrl);
  if (!abs.ok) return abs;
  const available = assertArxivVersionAvailable(abs.html, pinned, absUrl);
  if (!available.ok) return available;
  const snapshot = await fetchArxivSnapshot({
    root: input.root,
    reference: pinned,
    transport: input.transport,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
  });
  if (!snapshot.ok) return snapshot;
  return mergeCandidateFromSnapshot({
    root: input.root,
    sourceSnapshotId: snapshot.snapshot.sourceSnapshotId,
    baseRevision: input.baseRevision,
    fetchWarnings: snapshot.warnings,
  });
}

export type ArxivRefetchResult =
  | {
      ok: true;
      /** reused：字节与已验证快照相同，不制造重复快照或候选（§8.4）。 */
      outcome: "reused";
      sourceSnapshotId: string;
      warnings: ImportDiagnostic[];
    }
  | { ok: true; outcome: "candidate"; candidate: DocumentMergeCandidate; warnings: ImportDiagnostic[] }
  | { ok: false; diagnostic: ImportDiagnostic };

/** 同版 HTML 重取（SPEC §8.4）：固定 current 谱系的 vN 重新获取 HTML 与资产。
 * 相同字节复用既有快照；不同字节建立新快照与候选，不覆盖旧快照与 current。 */
export async function refetchArxivSnapshot(
  input: UpdateNetworkInput & { root: string; baseRevision: string },
): Promise<ArxivRefetchResult> {
  const lineage = await currentReference(input.root);
  if (!lineage.ok) return lineage;
  if (input.baseRevision !== lineage.currentRevision)
    return fatal(
      "arxiv-update-base-mismatch",
      `arxiv.update.baseMismatch:候选基线为 ${input.baseRevision}，current 为 ${lineage.currentRevision}。`,
      "resolve",
    );
  const snapshot = await fetchArxivSnapshot({
    root: input.root,
    reference: lineage.reference,
    transport: input.transport,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
  });
  if (!snapshot.ok) return snapshot;
  if (snapshot.reused)
    return { ok: true, outcome: "reused", sourceSnapshotId: snapshot.snapshot.sourceSnapshotId, warnings: snapshot.warnings };
  return mergeCandidateFromSnapshot({
    root: input.root,
    sourceSnapshotId: snapshot.snapshot.sourceSnapshotId,
    baseRevision: input.baseRevision,
    fetchWarnings: snapshot.warnings,
  });
}

/** 重新转换既有快照（SPEC §8.5）：纯离线，无 transport 参数——不访问网络。
 * 使用快照原始内容与当前转换器生成候选；不伪造旧 source-base，不改写快照。 */
export async function reconvertArxivCandidate(input: {
  root: string;
  sourceSnapshotId: string;
  baseRevision: string;
  /** 转换器升级注入（SPEC §8.5）：未来转换器修复后重转换同一快照；
   * 生产命令不注入，默认当前转换器。版本纳入候选身份，升级产生新候选。 */
  converter?: typeof convertLatexml;
}): Promise<ArxivUpdateCandidateResult> {
  return mergeCandidateFromSnapshot({
    root: input.root,
    sourceSnapshotId: input.sourceSnapshotId,
    baseRevision: input.baseRevision,
    ...(input.converter === undefined ? {} : { converter: input.converter }),
  });
}

export type ArxivUpdatePublishResult =
  | { ok: true; revision: ProjectRevisionRecord; warnings: ImportDiagnostic[] }
  | { ok: false; diagnostic: ImportDiagnostic };

/** 确认发布更新候选（SPEC §8.7）：按用户确认的候选 revisionId 重载构建时落盘
 * 的同一候选（不重新转换——新增节点 UUID 不可重放，发布内容必须与预览一致），
 * 应用显式冲突选择后发布；发布前复核 baseRevision 与来源身份，current 已变化
 * 或未解决冲突时拒绝。 */
export async function publishArxivUpdateCandidate(input: {
  root: string;
  /** 用户确认的候选身份（构建结果携带）；来源与基线必须与候选存储一致。 */
  revisionId: string;
  sourceSnapshotId: string;
  baseRevision: string;
  resolutions?: Array<{ conflictId: string; choice: "current" | "candidate" }>;
}): Promise<ArxivUpdatePublishResult> {
  const guard = await assertCandidateBaseline(input);
  if (!guard.ok) return guard;
  const revisionId = input.revisionId;
  let candidate: DocumentMergeCandidate;
  let warnings: ImportDiagnostic[];
  try {
    candidate = await loadUpdateCandidate({ root: input.root, revisionId });
    const meta = candidate.metadata?.arxiv;
    warnings = meta !== null && typeof meta === "object" && "warnings" in meta && Array.isArray(meta.warnings)
      ? meta.warnings as ImportDiagnostic[]
      : [];
  } catch (error) {
    return fatal(
      "arxiv-update-candidate-missing",
      `arxiv.update.candidateMissing:${error instanceof Error ? error.message : String(error)}`,
      "resolve",
    );
  }
  if (candidate.sourceSnapshotId !== input.sourceSnapshotId || candidate.baseRevision !== input.baseRevision)
    return fatal("arxiv-update-candidate-mismatch", "arxiv.update.candidateMismatch", "resolve");
  try {
    for (const resolution of input.resolutions ?? [])
      candidate = resolveDocumentMergeCandidateConflict(candidate, resolution.conflictId, resolution.choice);
    const revision = await publishDocumentMergeCandidate(candidate, verificationInheritCommitHooks({
      root: candidate.root,
      baseRevision: candidate.baseRevision,
      revisionId: candidate.revisionId,
      sourceSnapshotId: candidate.sourceSnapshotId,
      document: candidate.document,
    }));
    return { ok: true, revision, warnings };
  } catch (error) {
    return fatal(
      "arxiv-update-publish-failed",
      `arxiv.update.publishFailed:${error instanceof Error ? error.message : String(error)}`,
      "publish",
    );
  }
}

