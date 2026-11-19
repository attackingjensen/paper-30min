import { randomUUID } from "node:crypto";
import {
  commitRevision,
  openProject,
  readRevision,
  readRevisionAsset,
  readRevisionDocument,
  readRevisionTombstones,
  readSourceSnapshot,
  readSourceSnapshotAsset,
  validateRevisionAssetBudget,
} from "../project-core.js";
import {
  assertDocumentMergePublishable,
  mergeDocumentTrees,
  resolveDocumentMergeConflict,
  type DocumentMergeResult,
} from "../../shared/document/merge.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import { inheritVerificationSidecar } from "../pdf/verification.js";

type ManagedAsset = { bytes: Uint8Array; mime?: string };

export interface DocumentMergeCandidate extends DocumentMergeResult {
  root: string;
  sourceSnapshotId: string;
  assets: Record<string, ManagedAsset>;
  /** 来源模块附加的 revision 元数据（如 pdfParse 转换器版本与警告），随发布写入。 */
  metadata?: Record<string, unknown>;
}

function json(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

function assetPaths(trees: DocumentTree[]) {
  const paths = new Set<string>();
  for (const tree of trees) {
    for (const block of tree.blocks) {
      if (block.kind === "figure" && block.asset) paths.add(block.asset.path);
    }
  }
  return [...paths].sort();
}

async function loadCandidateAssets(
  result: DocumentMergeResult,
  root: string,
  sourceSnapshotId: string,
) {
  const [revision, snapshot] = await Promise.all([
    readRevision(root, result.baseRevision),
    readSourceSnapshot(root, sourceSnapshotId),
  ]);
  const selected: Array<{ relative: string; record: { path: string; size: number }; snapshot: boolean }> = [];
  for (const relative of assetPaths([result.base, result.current, result.sourceBase])) {
    const snapshotRecord = snapshot.files.find((file) => file.path === relative);
    const revisionRecord = revision.files.find((file) => file.path === relative);
    if (snapshotRecord) selected.push({ relative, record: snapshotRecord, snapshot: true });
    else if (revisionRecord) selected.push({ relative, record: revisionRecord, snapshot: false });
    else throw new Error(`合并输入引用的资产不存在：${relative}。`);
  }
  validateRevisionAssetBudget(selected.map((entry) => entry.record));

  const assets: Record<string, ManagedAsset> = {};
  for (const entry of selected) {
    assets[entry.relative] = entry.snapshot
      ? await readSourceSnapshotAsset(root, sourceSnapshotId, entry.relative)
      : await readRevisionAsset(root, result.baseRevision, entry.relative);
  }
  return assets;
}

export async function createDocumentMergeCandidate(input: {
  root: string;
  baseRevision: string;
  sourceSnapshotId: string;
  candidate: DocumentTree;
}): Promise<DocumentMergeCandidate> {
  const opened = await openProject(input.root);
  if (opened.manifest.paper.currentRevision !== input.baseRevision)
    throw new Error(`baseRevision 已变化：候选基线为 ${input.baseRevision}，current 为 ${opened.manifest.paper.currentRevision}。`);
  const root = opened.root;
  const [base, current, previousTombstones] = await Promise.all([
    readRevisionDocument(root, input.baseRevision, "source-base"),
    readRevisionDocument(root, input.baseRevision, "document"),
    readRevisionTombstones(root, input.baseRevision),
  ]);
  const result = mergeDocumentTrees({
    base,
    current,
    candidate: input.candidate,
    baseRevision: input.baseRevision,
    revisionId: randomUUID(),
    previousTombstones,
  });
  const assets = await loadCandidateAssets(result, root, input.sourceSnapshotId);
  return {
    ...result,
    root,
    sourceSnapshotId: input.sourceSnapshotId,
    assets,
  };
}

export function resolveDocumentMergeCandidateConflict(
  candidate: DocumentMergeCandidate,
  conflictId: string,
  choice: "current" | "candidate",
): DocumentMergeCandidate {
  return {
    ...resolveDocumentMergeConflict(candidate, conflictId, choice),
    root: candidate.root,
    sourceSnapshotId: candidate.sourceSnapshotId,
    assets: candidate.assets,
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
  };
}

export async function publishDocumentMergeCandidate(candidate: DocumentMergeCandidate) {
  const opened = await openProject(candidate.root);
  const currentRevision = opened.manifest.paper.currentRevision;
  if (!currentRevision) throw new Error("首次正文尚未提交，不能发布来源合并候选。");
  assertDocumentMergePublishable(candidate, currentRevision);

  // 核验继承先于 current 推进：新 current 生效时侧车已按 changeset 与 PDF 谱系生成。
  await inheritVerificationSidecar({
    root: candidate.root,
    baseRevision: candidate.baseRevision,
    revisionId: candidate.revisionId,
    sourceSnapshotId: candidate.sourceSnapshotId,
    document: candidate.document,
  });

  const assets: Record<string, ManagedAsset> = {};
  for (const relative of assetPaths([candidate.document, candidate.sourceBase])) {
    const asset = candidate.assets[relative];
    if (!asset) throw new Error(`合并候选缺少已引用资产：${relative}。`);
    assets[relative] = asset;
  }
  return commitRevision({
    root: candidate.root,
    baseRevision: candidate.baseRevision,
    sourceSnapshotId: candidate.sourceSnapshotId,
    revisionId: candidate.revisionId,
    files: {
      "document.json": json(candidate.document),
      "source-base.json": json(candidate.sourceBase),
      "tombstones.json": json(candidate.tombstones),
      "changeset.json": json(candidate.changeset),
      ...assets,
    },
    metadata: { normalizationVersion: 1, operation: "source-merge", ...candidate.metadata },
  });
}
