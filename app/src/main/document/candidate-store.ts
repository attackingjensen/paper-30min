// 受管更新候选存储（SPEC-arxiv-import §8）：候选树、冲突解决与资产在构建时
// 一次性落盘；发布重载同一份字节，不重新转换——新增节点 UUID 不可重放，
// 重转换会产生与用户确认内容不同的候选，提交中断后也无法按同身份恢复。
// 存储位于 .paper30min/update-candidates/<revisionId>/，属受管内部文件，
// 不进入工程文件树；发布成功后保留，供中断恢复与追溯。
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ImportDiagnostic } from "../../shared/arxiv.js";
import { parseImportDiagnostic } from "../../shared/arxiv.js";
import type { ManagedFileRecord } from "../../shared/contracts.js";
import { parseDocumentTree } from "../../shared/document/tree.js";
import { parseDocumentChangeset, parseDocumentTombstones } from "../../shared/document/changeset.js";
import type { DocumentMergeResult, MergeChoice, MergeConflict } from "../../shared/document/merge.js";
import { resolveDocumentMergeConflict } from "../../shared/document/merge.js";
import { openProject, withProjectWriteLock } from "../project-core.js";
import { renameManaged } from "../managed-rename.js";
import type { DocumentMergeCandidate } from "./merge.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** 候选记录与单棵树沿用文档 JSON 预算；资产沿用 revision 资产预算。 */
const CANDIDATE_JSON_BUDGET = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 512 * 1024 * 1024;

type ManagedAsset = { bytes: Uint8Array; mime?: string };

interface StoredCandidateManifest {
  formatVersion: 1;
  revisionId: string;
  projectId: string;
  paperId: string;
  baseRevision: string;
  sourceSnapshotId: string;
  /** 冲突 id → 显式选择；未解决冲突不出现在表中。 */
  resolutions: Record<string, MergeChoice>;
  /** 构建时的转换警告（含获取阶段警告），发布结果原样回显。 */
  warnings: ImportDiagnostic[];
  /** 来源模块附加的 revision 元数据（arxiv 转换器版本与警告）。 */
  metadata?: Record<string, unknown>;
  trees: Array<{ name: string; sha256: string }>;
  /** 构建时记录的冲突（含双方内容），重载后仍可呈现与核对解决状态。 */
  conflicts: MergeConflict[];
  assets: ManagedFileRecord[];
  createdAt: string;
  /** 解决代际：每次落盘解决递增；派生树按代际命名，manifest 是唯一的原子切换点。 */
  generation?: number;
}

const TREE_NAMES = ["base", "current", "sourceBase", "document", "candidateTree", "changeset", "tombstones", "previousTombstones"] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function candidateDirectory(root: string, revisionId: string): string {
  if (!UUID.test(revisionId)) throw new Error("候选 revisionId 无效。");
  return path.join(root, ".paper30min", "update-candidates", revisionId);
}

async function readJson(file: string, description: string): Promise<unknown> {
  const entry = await fs.lstat(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > CANDIDATE_JSON_BUDGET)
    throw new Error(`${description}无效或超过读取预算。`);
  const bytes = await fs.readFile(file);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function writeBytesAtomic(file: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > CANDIDATE_JSON_BUDGET) throw new Error("候选记录超过写入预算。");
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameManaged(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeBytesAtomic(file, Buffer.from(JSON.stringify(value)));
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("候选记录无效。");
  return value as Record<string, unknown>;
}

function parseManifest(value: unknown, revisionId: string): StoredCandidateManifest {
  const record = objectValue(value);
  if (
    record.formatVersion !== 1 ||
    record.revisionId !== revisionId ||
    typeof record.projectId !== "string" ||
    typeof record.paperId !== "string" ||
    typeof record.baseRevision !== "string" || !UUID.test(record.baseRevision) ||
    typeof record.sourceSnapshotId !== "string" || !UUID.test(record.sourceSnapshotId) ||
    typeof record.createdAt !== "string"
  )
    throw new Error("候选记录无效。");
  const resolutions: Record<string, MergeChoice> = {};
  for (const [id, choice] of Object.entries(objectValue(record.resolutions))) {
    if (choice !== "current" && choice !== "candidate") throw new Error("候选冲突解决记录无效。");
    resolutions[id] = choice;
  }
  const warnings = Array.isArray(record.warnings) ? record.warnings.map(parseImportDiagnostic) : (() => { throw new Error("候选警告记录无效。"); })();
  const trees = Array.isArray(record.trees)
    ? (record.trees as unknown[]).map((entry) => {
        const item = objectValue(entry);
        if (typeof item.name !== "string" || !(TREE_NAMES as readonly string[]).includes(item.name) ||
            typeof item.sha256 !== "string" || !SHA256.test(item.sha256))
          throw new Error("候选树登记无效。");
        return { name: item.name, sha256: item.sha256 };
      })
    : (() => { throw new Error("候选树登记无效。"); })();
  if (trees.length !== TREE_NAMES.length || new Set(trees.map((tree) => tree.name)).size !== TREE_NAMES.length)
    throw new Error("候选树登记不完整。");
  const assets = Array.isArray(record.assets)
    ? (record.assets as unknown[]).map((entry) => {
        const item = objectValue(entry);
        if (typeof item.path !== "string" || !/^assets\/[a-f0-9]{64}\.[^/]+$/.test(item.path) ||
            typeof item.sha256 !== "string" || !SHA256.test(item.sha256) ||
            typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 ||
            (item.mime !== undefined && typeof item.mime !== "string"))
          throw new Error("候选资产登记无效。");
        return {
          path: item.path,
          sha256: item.sha256,
          size: item.size,
          ...(item.mime === undefined ? {} : { mime: item.mime }),
        };
      })
    : (() => { throw new Error("候选资产登记无效。"); })();
  // 登记本身也执行硬预算与路径唯一性：损坏 manifest 不得诱导无界读取。
  let declaredTotal = 0;
  const declaredPaths = new Set<string>();
  for (const asset of assets) {
    if (declaredPaths.has(asset.path)) throw new Error("候选资产登记路径重复。");
    declaredPaths.add(asset.path);
    if (asset.size > MAX_ASSET_BYTES) throw new Error(`候选资产登记超过 32 MiB 预算：${asset.path}。`);
    declaredTotal += asset.size;
    if (declaredTotal > MAX_TOTAL_ASSET_BYTES) throw new Error("候选资产登记总量超过 512 MiB 预算。");
  }
  const conflicts = Array.isArray(record.conflicts)
    ? (record.conflicts as unknown[]).map((entry) => {
        const item = objectValue(entry);
        if (typeof item.id !== "string" ||
            (item.type !== "content" && item.type !== "deletion" && item.type !== "order" &&
             item.type !== "structure" && item.type !== "asset") ||
            !Array.isArray(item.anchors))
          throw new Error("候选冲突记录无效。");
        return item as unknown as MergeConflict;
      })
    : (() => { throw new Error("候选冲突记录无效。"); })();
  return {
    formatVersion: 1,
    conflicts,
    revisionId,
    projectId: record.projectId,
    paperId: record.paperId,
    baseRevision: record.baseRevision,
    sourceSnapshotId: record.sourceSnapshotId,
    resolutions,
    warnings,
    ...(record.metadata === undefined ? {} : { metadata: objectValue(record.metadata) }),
    trees,
    assets,
    createdAt: record.createdAt,
    ...(record.generation === undefined ? {} : {
      generation: typeof record.generation === "number" && Number.isSafeInteger(record.generation) && record.generation >= 0
        ? record.generation
        : (() => { throw new Error("候选解决代际无效。"); })(),
    }),
  };
}

/** 候选落盘（构建时一次性写入）：树、changeset、tombstones、冲突解决与资产字节。
 * 同一 revisionId 已存在时核验身份与基线后直接复用存储字节——转换器为新增
 * 节点分配随机 UUID，重建内容不可逐字节重放，存储才是候选的权威内容。
 * 返回落盘候选（首次写入即本次构建；已存在即既有存储）。 */
export async function storeUpdateCandidate(candidate: DocumentMergeCandidate): Promise<DocumentMergeCandidate> {
  const opened = await openProject(candidate.root);
  const root = opened.root;
  const directory = candidateDirectory(root, candidate.revisionId);
  const trees: Record<string, unknown> = {
    base: candidate.base,
    current: candidate.current,
    sourceBase: candidate.sourceBase,
    document: candidate.document,
    candidateTree: candidate.candidateTree,
    changeset: candidate.changeset,
    tombstones: candidate.tombstones,
    previousTombstones: candidate.previousTombstones,
  };
  const treeRecords = TREE_NAMES.map((name) => {
    const bytes = Buffer.from(JSON.stringify(trees[name]));
    if (bytes.byteLength > CANDIDATE_JSON_BUDGET) throw new Error(`候选树超过 64 MiB 写入预算：${name}。`);
    return { name, sha256: sha256(bytes), bytes };
  });
  const assetEntries = Object.entries(candidate.assets).sort(([a], [b]) => a.localeCompare(b));
  let total = 0;
  const assetRecords: ManagedFileRecord[] = [];
  for (const [relative, asset] of assetEntries) {
    if (!/^assets\/[a-f0-9]{64}\.[^/]+$/.test(relative) || sha256(asset.bytes) !== relative.slice(7, 71))
      throw new Error(`候选资产路径与内容摘要不一致：${relative}。`);
    if (asset.bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`候选资产超过 32 MiB 预算：${relative}。`);
    total += asset.bytes.byteLength;
    if (total > MAX_TOTAL_ASSET_BYTES) throw new Error("候选引用资产总量超过 512 MiB 预算。");
    assetRecords.push({ path: relative, sha256: sha256(asset.bytes), size: asset.bytes.byteLength, ...(asset.mime === undefined ? {} : { mime: asset.mime }) });
  }
  const manifest: StoredCandidateManifest = {
    formatVersion: 1,
    revisionId: candidate.revisionId,
    projectId: opened.manifest.id,
    paperId: opened.manifest.paper.id,
    baseRevision: candidate.baseRevision,
    sourceSnapshotId: candidate.sourceSnapshotId,
    resolutions: candidate.resolutions,
    conflicts: candidate.conflicts,
    warnings: candidateWarnings(candidate),
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    trees: treeRecords.map(({ name, sha256: hash }) => ({ name, sha256: hash })),
    assets: assetRecords,
    createdAt: new Date().toISOString(),
  };
  return withProjectWriteLock(root, async () => {
    const existing = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      // 同身份候选已存在：身份与基线必须一致；内容以存储为准，不覆盖。
      const stored = await loadStoredCandidate(root, candidate.revisionId);
      if (
        stored.manifest.baseRevision !== manifest.baseRevision ||
        stored.manifest.sourceSnapshotId !== manifest.sourceSnapshotId ||
        stored.manifest.projectId !== manifest.projectId ||
        stored.manifest.paperId !== manifest.paperId
      )
        throw new Error(`同一候选身份的来源或基线不一致，拒绝复用：${candidate.revisionId}。`);
      return rebuildFromStored(root, stored);
    }
    await fs.mkdir(path.join(root, ".paper30min", "update-candidates"), { recursive: true });
    const staging = path.join(root, ".paper30min", "staging", `candidate-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      for (const { name, bytes } of treeRecords) await fs.writeFile(path.join(staging, `${name}.json`), bytes);
      for (const [relative, asset] of assetEntries) {
        const target = path.join(staging, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, asset.bytes);
      }
      await writeJsonAtomic(path.join(staging, "candidate.json"), manifest);
      await renameManaged(staging, directory);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return candidate;
  });
}

function candidateWarnings(candidate: DocumentMergeCandidate): ImportDiagnostic[] {
  const meta = candidate.metadata?.arxiv;
  if (meta === null || typeof meta !== "object" || !("warnings" in meta) || !Array.isArray(meta.warnings)) return [];
  return meta.warnings.map(parseImportDiagnostic);
}

interface StoredCandidate {
  manifest: StoredCandidateManifest;
  trees: Record<(typeof TREE_NAMES)[number], unknown>;
  assets: Record<string, ManagedAsset>;
}

/** 派生树文件名：构建代际（0）用原名，解决代际 g 用 name.g.json。
 * 代际文件不可变；manifest 是唯一原子切换点，崩溃不会留下半代际。 */
function treeFileName(name: string, generation: number): string {
  return generation === 0 ? `${name}.json` : `${name}.${generation}.json`;
}

async function loadStoredTrees(root: string, revisionId: string): Promise<{
  manifest: StoredCandidateManifest;
  trees: Record<(typeof TREE_NAMES)[number], unknown>;
}> {
  const directory = candidateDirectory(root, revisionId);
  const manifest = parseManifest(await readJson(path.join(directory, "candidate.json"), "候选记录"), revisionId);
  const generation = manifest.generation ?? 0;
  const trees = {} as Record<(typeof TREE_NAMES)[number], unknown>;
  for (const record of manifest.trees) {
    const file = path.join(directory, treeFileName(record.name, generation));
    // 读取前核验 regular file 与大小预算：损坏/替换的大文件不得先造成无界分配。
    const entry = await fs.lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > CANDIDATE_JSON_BUDGET)
      throw new Error(`候选树无效或超过读取预算：${record.name}。`);
    const bytes = await fs.readFile(file);
    if (bytes.byteLength > CANDIDATE_JSON_BUDGET || sha256(bytes) !== record.sha256)
      throw new Error(`候选树摘要不符：${record.name}。`);
    trees[record.name as (typeof TREE_NAMES)[number]] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  return { manifest, trees };
}

async function loadStoredAssets(root: string, revisionId: string, manifest: StoredCandidateManifest): Promise<Record<string, ManagedAsset>> {
  const directory = candidateDirectory(root, revisionId);
  const assets: Record<string, ManagedAsset> = {};
  for (const record of manifest.assets) {
    const file = path.join(directory, record.path);
    const entry = await fs.lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== record.size || record.size > MAX_ASSET_BYTES)
      throw new Error(`候选资产不可读或超过预算：${record.path}。`);
    const bytes = await fs.readFile(file);
    if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256)
      throw new Error(`候选资产摘要不符：${record.path}。`);
    assets[record.path] = { bytes, ...(record.mime === undefined ? {} : { mime: record.mime }) };
  }
  return assets;
}

async function loadStoredCandidate(root: string, revisionId: string): Promise<StoredCandidate> {
  const { manifest, trees } = await loadStoredTrees(root, revisionId);
  const assets = await loadStoredAssets(root, revisionId, manifest);
  return { manifest, trees, assets };
}

/** 重载已存储候选为可发布对象：树与资产来自落盘字节，不重新转换。
 * 冲突解决状态以存储为准；发布前 current 基线复核由调用方与发布路径执行。 */
export async function loadUpdateCandidate(input: {
  root: string;
  revisionId: string;
}): Promise<DocumentMergeCandidate> {
  const opened = await openProject(input.root);
  const stored = await loadStoredCandidate(opened.root, input.revisionId);
  if (stored.manifest.projectId !== opened.manifest.id || stored.manifest.paperId !== opened.manifest.paper.id)
    throw new Error("候选不属于当前工程。");
  return rebuildFromStored(opened.root, stored);
}

/** 从已核验的存储字节重建候选对象：树经 schema 校验，资产按登记摘要读取。 */
function rebuildFromStored(root: string, stored: StoredCandidate): DocumentMergeCandidate {
  const { manifest, trees } = stored;
  const paperId = manifest.paperId;
  const base = parseDocumentTree(trees.base, paperId);
  const current = parseDocumentTree(trees.current, paperId);
  const sourceBase = parseDocumentTree(trees.sourceBase, paperId);
  const document = parseDocumentTree(trees.document, paperId);
  const candidateTree = parseDocumentTree(trees.candidateTree, paperId);
  const changeset = parseDocumentChangeset(trees.changeset);
  const tombstones = parseDocumentTombstones(trees.tombstones, document);
  const previousTombstones = parseDocumentTombstones(trees.previousTombstones, current);
  const result: DocumentMergeResult = {
    baseRevision: manifest.baseRevision,
    revisionId: manifest.revisionId,
    base,
    current,
    sourceBase,
    document,
    candidateTree,
    changeset,
    tombstones,
    previousTombstones,
    conflicts: manifest.conflicts,
    resolutions: manifest.resolutions,
  };
  return {
    ...result,
    root,
    sourceSnapshotId: manifest.sourceSnapshotId,
    assets: stored.assets,
    ...(manifest.metadata === undefined ? {} : { metadata: manifest.metadata }),
  };
}

/** 冲突解决显式落盘（SPEC-reader §9.6）：在工程写锁内加载最新代际、重算合并树，
 * 派生树写入新的不可变代际文件，最后原子替换 manifest 完成切换——崩溃只会留下
 * 完整旧代际或完整新代际。并发解决串行化，不互相覆盖；current 不被解决动作推进。 */
export async function resolveStoredCandidateConflict(input: {
  root: string;
  revisionId: string;
  conflictId: string;
  choice: MergeChoice;
}): Promise<DocumentMergeCandidate> {
  const opened = await openProject(input.root);
  const root = opened.root;
  return withProjectWriteLock(root, async () => {
    // 锁内只读树（不读资产）：解决不需要资产字节，避免全量资产 I/O。
    const stored = await loadStoredTrees(root, input.revisionId);
    if (stored.manifest.projectId !== opened.manifest.id || stored.manifest.paperId !== opened.manifest.paper.id)
      throw new Error("候选不属于当前工程。");
    const candidate = rebuildFromStored(root, { ...stored, assets: {} });
    const resolved = resolveDocumentMergeConflict(candidate, input.conflictId, input.choice);
    const generation = (stored.manifest.generation ?? 0) + 1;
    const trees: Record<string, unknown> = {
      base: resolved.base,
      current: resolved.current,
      sourceBase: resolved.sourceBase,
      document: resolved.document,
      candidateTree: resolved.candidateTree,
      changeset: resolved.changeset,
      tombstones: resolved.tombstones,
      previousTombstones: resolved.previousTombstones,
    };
    const treeRecords = TREE_NAMES.map((name) => {
      const bytes = Buffer.from(JSON.stringify(trees[name]));
      if (bytes.byteLength > CANDIDATE_JSON_BUDGET) throw new Error(`候选树超过 64 MiB 写入预算：${name}。`);
      return { name, sha256: sha256(bytes), bytes };
    });
    const manifest: StoredCandidateManifest = {
      ...stored.manifest,
      generation,
      resolutions: resolved.resolutions,
      trees: treeRecords.map(({ name, sha256: hash }) => ({ name, sha256: hash })),
    };
    const directory = candidateDirectory(root, input.revisionId);
    // 先写全部新代际文件（不可变、带摘要），再原子切换 manifest：
    // 中途失败时旧 manifest 仍指向完整旧代际，候选与已落盘解决保持可读。
    for (const { name, bytes } of treeRecords)
      await writeBytesAtomic(path.join(directory, treeFileName(name, generation)), bytes);
    await writeJsonAtomic(path.join(directory, "candidate.json"), manifest);
    const assets = await loadStoredAssets(root, input.revisionId, manifest);
    return {
      ...resolved,
      root,
      sourceSnapshotId: candidate.sourceSnapshotId,
      assets,
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    };
  });
}

/** 候选资产受管读取（冲突预览用）：登记、摘要与预算与 revision 资产同口径。 */
export async function readUpdateCandidateAsset(input: {
  root: string;
  revisionId: string;
  path: string;
}): Promise<{ bytes: Uint8Array; mime?: string }> {
  if (!input.path.startsWith("assets/")) throw new Error("只能读取候选受管 assets 内容。");
  const opened = await openProject(input.root);
  const root = opened.root;
  // 只读 manifest 与请求的单个资产：预览一张图不触发全量资产 I/O。
  const directory = candidateDirectory(root, input.revisionId);
  const manifest = parseManifest(await readJson(path.join(directory, "candidate.json"), "候选记录"), input.revisionId);
  if (manifest.projectId !== opened.manifest.id || manifest.paperId !== opened.manifest.paper.id)
    throw new Error("候选不属于当前工程。");
  const record = manifest.assets.find((asset) => asset.path === input.path);
  if (!record) throw new Error(`候选资产未登记：${input.path}。`);
  const file = path.join(directory, record.path);
  const entry = await fs.lstat(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== record.size || record.size > MAX_ASSET_BYTES)
    throw new Error(`候选资产不可读或超过预算：${input.path}。`);
  const bytes = await fs.readFile(file);
  if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256)
    throw new Error(`候选资产摘要不符：${input.path}。`);
  return { bytes, ...(record.mime === undefined ? {} : { mime: record.mime }) };
}

