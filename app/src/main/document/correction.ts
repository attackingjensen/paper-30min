// document-core 修正的磁盘编排（SPEC-document-core §6，paper-30min-qa3.4）：
// 预览读取真实 current/source-base/tombstones，在 staging 计算完整新树；
// 发布按同一命令序列重放（同一 revisionId 逐字节一致），经 commitRevision
// 复核 baseRevision 后原子推进 current。renderer 不直接写受管 JSON。
import { createHash, randomUUID } from "node:crypto";
import {
  commitRevision,
  openProject,
  readRevision,
  readRevisionAsset,
  readRevisionDocument,
  readRevisionTombstones,
  type ProjectCommitHooks,
} from "../project-core.js";
import { applyDocumentCorrections } from "./correction-engine.js";
import type { DocumentTree } from "../../shared/document/tree.js";

const MAX_ASSET_BYTES = 32 * 1024 * 1024;

function json(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

function referencedAssetPaths(tree: DocumentTree): string[] {
  const paths = new Set<string>();
  for (const block of tree.blocks)
    if ((block.kind === "figure" || block.kind === "formula") && block.asset)
      paths.add(block.asset.path);
  return [...paths].sort();
}

/** 修正预览：不写磁盘、不推进 current；返回可序列化树、changeset 与资产摘要。 */
export async function previewDocumentCorrections(input: {
  root: string;
  baseRevision: string;
  corrections: unknown[];
  revisionId?: string;
}) {
  const revisionId = input.revisionId ?? randomUUID();
  const opened = await openProject(input.root);
  if (opened.manifest.paper.currentRevision !== input.baseRevision)
    throw new Error(`baseRevision 已变化：修正基线为 ${input.baseRevision}，current 为 ${opened.manifest.paper.currentRevision}。`);
  const root = opened.root;
  const [base, previousTombstones] = await Promise.all([
    readRevisionDocument(root, input.baseRevision, "document"),
    readRevisionTombstones(root, input.baseRevision),
  ]);
  const result = applyDocumentCorrections({
    base,
    baseRevision: input.baseRevision,
    revisionId,
    previousTombstones,
    corrections: input.corrections,
  });
  const assets = Object.entries(result.assets).map(([relative, asset]) => ({
    path: relative,
    sha256: createHash("sha256").update(asset.bytes).digest("hex"),
    mime: asset.mime,
    size: asset.bytes.byteLength,
  }));
  return {
    baseRevision: input.baseRevision,
    revisionId,
    document: result.document,
    changeset: result.changeset,
    tombstones: result.tombstones,
    assets,
  };
}

/** 发布修正：重放同一命令序列生成完整新 revision；current 基线由 commitRevision
 * 在串行临界区内复核，基线变化时拒绝且不触碰已发布内容。 */
export async function publishDocumentCorrections(input: {
  root: string;
  baseRevision: string;
  revisionId: string;
  corrections: unknown[];
  /** 来源侧车钩子（核验继承等）由调用方注入；document 层不理解来源语义。 */
  hooks?: ProjectCommitHooks;
}) {
  const opened = await openProject(input.root);
  const root = opened.root;
  const currentRevision = opened.manifest.paper.currentRevision;
  if (!currentRevision) throw new Error("首次正文尚未发布，不能发布修正。");
  if (currentRevision !== input.baseRevision)
    throw new Error(`baseRevision 已变化：修正基线为 ${input.baseRevision}，current 为 ${currentRevision}。`);
  const [base, sourceBase, previousTombstones, revision] = await Promise.all([
    readRevisionDocument(root, input.baseRevision, "document"),
    readRevisionDocument(root, input.baseRevision, "source-base"),
    readRevisionTombstones(root, input.baseRevision),
    readRevision(root, input.baseRevision),
  ]);
  const result = applyDocumentCorrections({
    base,
    baseRevision: input.baseRevision,
    revisionId: input.revisionId,
    previousTombstones,
    corrections: input.corrections,
  });
  const files: Record<string, Uint8Array | { bytes: Uint8Array; mime?: string }> = {
    "document.json": json(result.document),
    "source-base.json": json(sourceBase),
    "tombstones.json": json(result.tombstones),
    "changeset.json": json(result.changeset),
  };
  for (const [relative, asset] of Object.entries(result.assets)) {
    if (asset.bytes.byteLength > MAX_ASSET_BYTES)
      throw new Error(`修正资产超过 32 MiB 预算：${relative}。`);
    files[relative] = { bytes: asset.bytes, mime: asset.mime };
  }
  // 两棵树引用资产的并集随 revision 发布；既有资产按基线登记读取，缺失即拒绝。
  for (const relative of [...referencedAssetPaths(result.document), ...referencedAssetPaths(sourceBase)]) {
    if (files[relative]) continue;
    const asset = await readRevisionAsset(root, input.baseRevision, relative);
    files[relative] = { bytes: new Uint8Array(asset.bytes), ...(asset.mime === undefined ? {} : { mime: asset.mime }) };
  }
  return commitRevision({
    root,
    baseRevision: input.baseRevision,
    sourceSnapshotId: revision.sourceSnapshotId,
    revisionId: input.revisionId,
    files,
    metadata: { normalizationVersion: 1, operation: "local-correction" },
  }, input.hooks ?? {});
}
