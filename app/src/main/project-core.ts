import * as fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { renameManaged } from "./managed-rename.js";
import type {
  ArxivImportProgress,
  ManagedFileContent,
  ManagedFileRecord,
  ProjectCoreSnapshot,
  ProjectImportRecord,
  ProjectManifest,
  ProjectRevisionRecord,
  SourceSnapshotRecord,
} from "../shared/contracts.js";
import type { ArxivReference } from "../shared/arxiv.js";
import { parseImportDiagnostic } from "../shared/arxiv.js";
import {
  parseDocumentTree,
  validateDocumentAssets,
  type DocumentTree,
} from "../shared/document/tree.js";
import {
  createDocumentChangeset,
  parseDocumentChangeset,
  parseDocumentTombstones,
} from "../shared/document/changeset.js";

const manifestName = "paper30min.json";
const initialImportName = ".paper30min/imports/initial.json";
const requiredRevisionFiles = [
  "document.json",
  "source-base.json",
  "tombstones.json",
  "changeset.json",
];
const invalidName = /[<>:"/\\|?*]/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const jsonBudget = 1024 * 1024;
const documentJsonBudget = 64 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

export interface CreateProjectInput {
  parent: string;
  name: string;
}

export interface PublishSourceSnapshotInput {
  root: string;
  files: Readonly<Record<string, ManagedFileContent>>;
  metadata?: Record<string, unknown>;
}

export interface CommitRevisionInput {
  root: string;
  baseRevision: string | null;
  sourceSnapshotId: string;
  revisionId?: string;
  files: Readonly<Record<string, ManagedFileContent>>;
  metadata?: Record<string, unknown>;
}

type ProjectCommitPoint =
  | "project-manifest"
  | "import-record"
  | "source-content"
  | "revision-content"
  | "revision-metadata"
  | "before-current-replace";

interface ProjectCommitContext {
  sourceSnapshotId?: string;
  revisionId?: string;
}

export interface ProjectCommitHooks {
  onCommitPoint?: (
    point: ProjectCommitPoint,
    context: ProjectCommitContext,
  ) => void | Promise<void>;
}

interface NormalizedFile extends ManagedFileRecord {
  bytes: Uint8Array;
}

function validName(name: string) {
  if (
    !name ||
    name !== name.trim() ||
    invalidName.test(name) ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("名称不可为空，也不能包含路径分隔符或 Windows 保留字符。");
  }
}

function validRelativePath(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error("需要工程内相对路径，且不能包含父级穿越或反斜杠。");
  }
  value.split("/").forEach(validName);
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("工程数据必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error("工程清单包含缺失或不受支持的字段。");
}

function parseManifest(value: unknown): ProjectManifest {
  const manifest = objectValue(value);
  if (manifest.formatVersion === 1)
    throw new Error("这是 formatVersion: 1 旧格式工程，需要由旧格式处理流程打开。");
  if (manifest.formatVersion !== 2)
    throw new Error("工程清单格式不支持或已损坏。");
  exactKeys(manifest, ["formatVersion", "id", "name", "paper"]);
  if (typeof manifest.id !== "string" || !uuid.test(manifest.id))
    throw new Error("工程身份无效。");
  if (typeof manifest.name !== "string") throw new Error("工程名称无效。");
  validName(manifest.name);
  const paper = objectValue(manifest.paper);
  exactKeys(paper, ["currentRevision", "id"]);
  if (typeof paper.id !== "string" || !uuid.test(paper.id))
    throw new Error("主论文身份无效。");
  if (
    paper.currentRevision !== null &&
    (typeof paper.currentRevision !== "string" || !uuid.test(paper.currentRevision))
  ) {
    throw new Error("currentRevision 必须是 revision ID 或 null。");
  }
  return {
    formatVersion: 2,
    id: manifest.id,
    name: manifest.name,
    paper: {
      id: paper.id,
      currentRevision: paper.currentRevision,
    },
  };
}

function parseImportRecord(value: unknown, manifest: ProjectManifest): ProjectImportRecord {
  const record = objectValue(value);
  if (
    record.formatVersion !== 1 ||
    typeof record.id !== "string" ||
    !uuid.test(record.id) ||
    record.projectId !== manifest.id ||
    record.paperId !== manifest.paper.id
  ) {
    throw new Error("首次导入记录无效，或与工程及主论文身份不匹配。");
  }
  return {
    formatVersion: 1,
    id: record.id,
    projectId: manifest.id,
    paperId: manifest.paper.id,
    ...(record.arxiv === undefined ? {} : { arxiv: parseArxivImportProgress(record.arxiv) }),
  };
}

const importStages = ["resolve", "snapshot", "convert"] as const;
const importActions = ["fetch-snapshot", "convert", "pdf-fallback"] as const;

function parseArxivReferenceValue(value: unknown): ArxivReference {
  const record = objectValue(value);
  if (
    typeof record.baseId !== "string" ||
    typeof record.canonicalId !== "string" ||
    !(record.version === null || (typeof record.version === "number" && Number.isInteger(record.version) && record.version >= 1))
  ) {
    throw new Error("首次导入记录中的 arXiv 引用无效。");
  }
  return { baseId: record.baseId, version: record.version, canonicalId: record.canonicalId };
}


function parseArxivImportProgress(value: unknown): ArxivImportProgress {
  const record = objectValue(value);
  if (
    !importStages.includes(record.stage as (typeof importStages)[number]) ||
    !importActions.includes(record.nextAction as (typeof importActions)[number]) ||
    (record.sourceSnapshotId !== undefined &&
      (typeof record.sourceSnapshotId !== "string" || !uuid.test(record.sourceSnapshotId))) ||
    (record.candidateRevisionId !== undefined &&
      (typeof record.candidateRevisionId !== "string" || !uuid.test(record.candidateRevisionId))) ||
    (record.convertWarnings !== undefined && !Array.isArray(record.convertWarnings))
  ) {
    throw new Error("首次导入记录的 arXiv 进度无效。");
  }
  return {
    reference: parseArxivReferenceValue(record.reference),
    stage: record.stage as ArxivImportProgress["stage"],
    nextAction: record.nextAction as ArxivImportProgress["nextAction"],
    ...(record.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: record.sourceSnapshotId as string }),
    ...(record.candidateRevisionId === undefined ? {} : { candidateRevisionId: record.candidateRevisionId as string }),
    ...(record.convertWarnings === undefined ? {} : {
      convertWarnings: (record.convertWarnings as unknown[]).map(parseImportDiagnostic),
    }),
    ...(record.diagnostic === undefined ? {} : { diagnostic: parseImportDiagnostic(record.diagnostic) }),
  };
}

/** 原子更新首次导入记录的 arXiv 进度；身份字段由 project-core 保持权威。 */
export async function updateArxivImportProgress(
  root: string,
  progress: ArxivImportProgress,
): Promise<void> {
  const canonical = await canonicalRoot(root);
  return serialized(canonical, async () => {
    const { manifest } = await readManifest(canonical);
    if (manifest.paper.currentRevision !== null)
      throw new Error("current 已存在，首次导入进度不再可写。");
    const record = parseImportRecord(
      (await readManagedJson(canonical, initialImportName, "首次导入记录")).value,
      manifest,
    );
    await atomicJson(path.join(canonical, initialImportName), { ...record, arxiv: progress });
  });
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateAssetPath(relative: string, expectedHash: string) {
  const match = /^assets\/([a-f0-9]{64})\.[^/]+$/.exec(relative);
  if (!match || match[1] !== expectedHash)
    throw new Error("受管资产必须位于 assets/<sha256>.<ext>，且文件名摘要与实际内容一致。");
}

function validMime(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9!#$&^.*+-]*\/[a-z0-9][a-z0-9!#$&^.*+-]*$/i.test(value);
}

function parseManagedFileRecord(
  value: unknown,
  kind: "source" | "revision",
): ManagedFileRecord {
  const record = objectValue(value);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !["path", "sha256", "size", "mime"].includes(key)) ||
    ["path", "sha256", "size"].some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("受管文件摘要记录包含缺失或不受支持的字段。");
  }
  if (typeof record.path !== "string") throw new Error("受管文件路径无效。");
  validRelativePath(record.path);
  if (kind === "source" && record.path.normalize("NFC").toLowerCase() === "snapshot.json")
    throw new Error("snapshot.json 是来源快照保留文件名，不能重复登记或覆盖。");
  if (
    typeof record.sha256 !== "string" ||
    !sha256.test(record.sha256) ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    (record.mime !== undefined && !validMime(record.mime))
  ) {
    throw new Error("受管文件摘要、大小或 MIME 无效。");
  }
  if (record.path.startsWith("assets/")) validateAssetPath(record.path, record.sha256);
  return {
    path: record.path,
    sha256: record.sha256,
    size: record.size,
    ...(record.mime === undefined ? {} : { mime: record.mime }),
  };
}

const maximumAssetBytes = 32 * 1024 * 1024;
const maximumRevisionAssetBytes = 512 * 1024 * 1024;

export function validateRevisionAssetBudget(
  files: Array<Pick<ManagedFileRecord, "path" | "size">>,
) {
  let total = 0;
  for (const file of files) {
    if (!file.path.startsWith("assets/")) continue;
    if (file.size > maximumAssetBytes)
      throw new Error(`单个资产超过 32 MiB 预算：${file.path}。`);
    total += file.size;
    if (total > maximumRevisionAssetBytes)
      throw new Error("revision 引用资产总量超过 512 MiB 预算。");
  }
}

function validateManagedFileList<T extends ManagedFileRecord>(
  files: T[],
  kind: "source" | "revision",
) {
  const paths = new Set<string>();
  for (const file of files) {
    const portable = file.path.normalize("NFC").toLowerCase();
    if (paths.has(portable)) throw new Error("受管文件路径重复或在搬迁后会发生冲突。");
    paths.add(portable);
  }
  if (kind === "revision") {
    validateRevisionAssetBudget(files);
    const missing = requiredRevisionFiles.filter((required) =>
      !files.some((file) => file.path === required)
    );
    if (missing.length) throw new Error(`revision 缺少必需正文文件：${missing.join("、")}。`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeFiles(
  input: Readonly<Record<string, ManagedFileContent>>,
  kind: "source" | "revision",
): NormalizedFile[] {
  const entries = Object.entries(objectValue(input));
  if (!entries.length) throw new Error("受管内容至少需要一个文件。");
  const files = entries.map(([relative, content]) => {
    let bytes: unknown = content;
    let mime: unknown;
    if (!(content instanceof Uint8Array)) {
      if (!content || typeof content !== "object" || Array.isArray(content))
        throw new Error("受管文件内容必须是字节数组或带 MIME 的字节输入。");
      const input = content as { bytes?: unknown; mime?: unknown };
      bytes = input.bytes;
      mime = input.mime;
    }
    if (!(bytes instanceof Uint8Array)) throw new Error("受管文件内容必须是字节数组。");
    const record = parseManagedFileRecord({
      path: relative,
      sha256: digest(bytes),
      size: bytes.byteLength,
      ...(mime === undefined ? {} : { mime }),
    }, kind);
    return { ...record, bytes };
  });
  const validated = validateManagedFileList(files, kind);

  if (kind === "revision") {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const required of requiredRevisionFiles) {
      const file = validated.find((candidate) => candidate.path === required)!;
      if (file.bytes.byteLength > documentJsonBudget)
        throw new Error(`revision JSON 超过 64 MiB 预算：${required}。`);
      try {
        JSON.parse(decoder.decode(file.bytes));
      } catch {
        throw new Error(`revision 必需 JSON 文件无效：${required}。`);
      }
    }
  }
  return validated;
}

function validateRevisionDocumentTrees(
  documentValue: unknown,
  sourceBaseValue: unknown,
  files: ManagedFileRecord[],
  paperId: string,
) {
  const document = parseDocumentTree(documentValue, paperId);
  const sourceBase = parseDocumentTree(sourceBaseValue, paperId);
  const assetHashes = Object.fromEntries(
    files.filter((file) => file.path.startsWith("assets/"))
      .map((file) => [file.path, file.sha256]),
  );
  validateDocumentAssets(document, assetHashes);
  validateDocumentAssets(sourceBase, assetHashes);
  return { document, sourceBase };
}

function validateBufferedRevisionTrees(files: NormalizedFile[], paperId: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const read = (relative: string) => JSON.parse(decoder.decode(
    files.find((file) => file.path === relative)!.bytes,
  )) as unknown;
  return validateRevisionDocumentTrees(
    read("document.json"),
    read("source-base.json"),
    files,
    paperId,
  );
}

function materializeRevisionChangeset(
  files: NormalizedFile[],
  revisionId: string,
  baseDocument: DocumentTree | null,
  baseRevision: string | null,
  currentDocument: DocumentTree,
) {
  const expected = createDocumentChangeset({
    base: baseDocument,
    current: currentDocument,
    baseRevision,
    revisionId,
  });
  const file = files.find((candidate) => candidate.path === "changeset.json")!;
  const supplied = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as unknown;
  const placeholder = supplied !== null && typeof supplied === "object" && !Array.isArray(supplied) &&
    Object.keys(supplied).length === 1 && Object.hasOwn(supplied, "baseRevision") &&
    (supplied as { baseRevision?: unknown }).baseRevision === baseRevision;
  if (!placeholder) {
    const actual = parseDocumentChangeset(supplied);
    if (!isDeepStrictEqual(actual, expected))
      throw new Error("changeset 与 baseRevision、revisionId 或候选文档树不一致，拒绝发布。");
    return files;
  }
  const bytes = Buffer.from(JSON.stringify(expected));
  return files.map((candidate) => candidate.path === "changeset.json"
    ? { ...candidate, bytes, sha256: digest(bytes), size: bytes.byteLength }
    : candidate);
}

function normalizeMetadata(
  input: Record<string, unknown> | undefined,
  reserved: string[],
): Record<string, unknown> {
  const metadata = objectValue(input ?? {});
  for (const key of reserved) {
    if (Object.hasOwn(metadata, key))
      throw new Error(`来源或 revision 元数据不能覆盖工程核字段：${key}。`);
  }
  const ancestors = new Set<object>();
  const visit = (value: unknown) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object")
      throw new Error("来源或 revision 元数据必须是可无损序列化的 JSON。");
    if (ancestors.has(value)) throw new Error("来源或 revision 元数据不能包含循环引用。");
    ancestors.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("来源或 revision 元数据只接受普通 JSON 对象。");
      for (const child of Object.values(value)) visit(child);
    }
    ancestors.delete(value);
  };
  visit(metadata);
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

function parseFileRecords(value: unknown, kind: "source" | "revision"): ManagedFileRecord[] {
  if (!Array.isArray(value) || !value.length) throw new Error("受管文件摘要清单无效。");
  return validateManagedFileList(
    value.map((item) => parseManagedFileRecord(item, kind)),
    kind,
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function parseSourceSnapshot(
  value: unknown,
  manifest: ProjectManifest,
  sourceSnapshotId: string,
): SourceSnapshotRecord {
  const record = objectValue(value);
  if (
    record.formatVersion !== 1 ||
    record.sourceSnapshotId !== sourceSnapshotId ||
    record.projectId !== manifest.id ||
    record.paperId !== manifest.paper.id ||
    record.path !== `sources/${sourceSnapshotId}` ||
    !validTimestamp(record.createdAt)
  ) {
    throw new Error("来源快照元数据无效，或与工程及主论文身份不匹配。");
  }
  return {
    ...record,
    formatVersion: 1,
    sourceSnapshotId,
    projectId: manifest.id,
    paperId: manifest.paper.id,
    path: `sources/${sourceSnapshotId}`,
    files: parseFileRecords(record.files, "source"),
    createdAt: record.createdAt,
  };
}

function parseRevision(
  value: unknown,
  manifest: ProjectManifest,
  revisionId: string,
): ProjectRevisionRecord {
  const record = objectValue(value);
  if (
    record.formatVersion !== 1 ||
    record.revisionId !== revisionId ||
    record.projectId !== manifest.id ||
    record.paperId !== manifest.paper.id ||
    typeof record.sourceSnapshotId !== "string" ||
    !uuid.test(record.sourceSnapshotId) ||
    (record.baseRevision !== null &&
      (typeof record.baseRevision !== "string" || !uuid.test(record.baseRevision))) ||
    record.path !== `paper/revisions/${revisionId}` ||
    !validTimestamp(record.committedAt)
  ) {
    throw new Error("revision 元数据无效，或与工程及主论文身份不匹配。");
  }
  return {
    ...record,
    formatVersion: 1,
    revisionId,
    projectId: manifest.id,
    paperId: manifest.paper.id,
    sourceSnapshotId: record.sourceSnapshotId,
    baseRevision: record.baseRevision,
    path: `paper/revisions/${revisionId}`,
    files: parseFileRecords(record.files, "revision"),
    committedAt: record.committedAt,
  };
}

async function atomicJson(
  file: string,
  value: unknown,
  beforeReplace?: () => void | Promise<void>,
) {
  const text = JSON.stringify(value, null, 2) + "\n";
  const bytes = Buffer.from(text);
  if (bytes.length > jsonBudget)
    throw new Error("工程 JSON 元数据超过 1 MiB 写入预算，受管内容尚未发布。");
  const temporary = path.join(path.dirname(file), `.paper30min-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeReplace?.();
    await renameManaged(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function managedPath(root: string, relative: string) {
  validRelativePath(relative);
  let target = root;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    if ((await fs.lstat(target)).isSymbolicLink())
      throw new Error("受管工程文件不能通过符号链接或目录联接访问。");
  }
  return target;
}

async function ensureManagedDirectory(root: string, relative: string) {
  validRelativePath(relative);
  let target = root;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    let entry;
    try {
      entry = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(target);
      entry = await fs.lstat(target);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("受管工程目录不能通过符号链接、目录联接或普通文件访问。");
  }
  return target;
}

async function readJsonFile(file: string, description: string, budget = jsonBudget) {
  const budgetLabel = budget === documentJsonBudget ? "64 MiB" : "1 MiB";
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > budget)
      throw new Error(`工程 JSON 文件超过 ${budgetLabel} 读取预算或不是普通文件。`);
    const bytes = await handle.readFile();
    if (bytes.length > budget) throw new Error(`工程 JSON 文件超过 ${budgetLabel} 读取预算。`);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { value: JSON.parse(text) as unknown, bytes };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        throw new Error(`${description}损坏或不是有效 UTF-8，请保留现场并恢复有效版本。`, {
          cause: error,
        });
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function readManagedJson(
  root: string,
  relative: string,
  description: string,
  budget = jsonBudget,
) {
  return readJsonFile(await managedPath(root, relative), description, budget);
}

async function readManifest(root: string) {
  try {
    const { value, bytes } = await readManagedJson(root, manifestName, "工程清单");
    return { manifest: parseManifest(value), bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("工程清单不存在；目录可能尚未完成创建或已被移除，请保留现场并重新选择工程。", {
        cause: error,
      });
    throw error;
  }
}

async function canonicalRoot(root: string) {
  if (!path.isAbsolute(root)) throw new Error("需要完整工程路径。");
  try {
    return await fs.realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("找不到工程目录；若工程已搬迁，请选择搬迁后的新位置。", { cause: error });
    throw error;
  }
}

async function listDiskFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("受管内容不能包含符号链接或目录联接。");
    const relative = prefix + entry.name;
    if (entry.isDirectory()) {
      files.push(...await listDiskFiles(path.join(directory, entry.name), relative + "/"));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error("受管内容只能包含普通文件和目录。");
    }
  }
  return files;
}

async function verifyDirectory(
  directory: string,
  files: ManagedFileRecord[],
  additionalFiles: string[] = [],
) {
  const expected = [...files.map((file) => file.path), ...additionalFiles].sort();
  const actual = (await listDiskFiles(directory)).sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index]))
    throw new Error("受管内容文件清单不完整，或包含未登记文件。");
  for (const record of files) {
    const file = path.join(directory, ...record.path.split("/"));
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("受管内容不是普通文件。");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(file)) {
      size += chunk.length;
      hash.update(chunk);
    }
    if (size !== record.size || hash.digest("hex") !== record.sha256)
      throw new Error(`受管内容摘要不符或完整性校验失败：${record.path}。`);
  }
}

async function writeFiles(directory: string, files: NormalizedFile[]) {
  for (const record of files) {
    const parts = record.path.split("/");
    const file = path.join(directory, ...parts);
    const parent = parts.slice(0, -1).join("/");
    if (parent) await ensureManagedDirectory(directory, parent);
    const handle = await fs.open(file, "wx");
    try {
      await handle.writeFile(record.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await verifyDirectory(directory, files);
}

function fileRecords(files: NormalizedFile[]): ManagedFileRecord[] {
  return files.map(({ path: relative, sha256: hash, size, mime }) => ({
    path: relative,
    sha256: hash,
    size,
    ...(mime === undefined ? {} : { mime }),
  }));
}

async function stageFiles(root: string, name: string, files: NormalizedFile[]) {
  const parent = await ensureManagedDirectory(root, ".paper30min/staging");
  const operation = path.join(parent, randomUUID());
  await fs.mkdir(operation);
  const staged = path.join(operation, name);
  await fs.mkdir(staged);
  await writeFiles(staged, files);
  return staged;
}

async function assertMissing(file: string) {
  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("受管快照或 revision 已存在，拒绝覆盖不可变内容。");
}

async function loadSourceSnapshot(
  root: string,
  manifest: ProjectManifest,
  sourceSnapshotId: string,
) {
  if (!uuid.test(sourceSnapshotId)) throw new Error("sourceSnapshotId 无效。");
  try {
    const relative = `sources/${sourceSnapshotId}`;
    const { value } = await readManagedJson(root, `${relative}/snapshot.json`, "来源快照元数据");
    const snapshot = parseSourceSnapshot(value, manifest, sourceSnapshotId);
    await verifyDirectory(
      await managedPath(root, relative),
      snapshot.files,
      ["snapshot.json"],
    );
    return snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`来源快照不存在或缺少必需文件：${sourceSnapshotId}。`, { cause: error });
    throw error;
  }
}

async function loadRevisionContent(root: string, manifest: ProjectManifest, revisionId: string) {
  if (!uuid.test(revisionId)) throw new Error("revisionId 无效。");
  try {
    const { value } = await readManagedJson(
      root,
      `.paper30min/revisions/${revisionId}/revision.json`,
      "revision 元数据",
    );
    const revision = parseRevision(value, manifest, revisionId);
    await verifyDirectory(await managedPath(root, revision.path), revision.files);
    const [documentResult, sourceBaseResult, tombstonesResult, changesetResult] = await Promise.all([
      readManagedJson(
        root,
        `${revision.path}/document.json`,
        "current 文档树",
        documentJsonBudget,
      ),
      readManagedJson(
        root,
        `${revision.path}/source-base.json`,
        "source-base 文档树",
        documentJsonBudget,
      ),
      readManagedJson(
        root,
        `${revision.path}/tombstones.json`,
        "revision tombstones",
        documentJsonBudget,
      ),
      readManagedJson(
        root,
        `${revision.path}/changeset.json`,
        "revision changeset",
        documentJsonBudget,
      ),
    ]);
    const documents = validateRevisionDocumentTrees(
      documentResult.value,
      sourceBaseResult.value,
      revision.files,
      manifest.paper.id,
    );
    const tombstones = parseDocumentTombstones(tombstonesResult.value, documents.document);
    const changeset = parseDocumentChangeset(changesetResult.value);
    if (changeset.baseRevision !== revision.baseRevision || changeset.revisionId !== revision.revisionId)
      throw new Error("changeset 的 baseRevision 或 revisionId 与 revision 元数据不一致。");
    return { revision, documents, tombstones, changeset };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`revision 不存在或内容不完整：${revisionId}；请保留现场并恢复候选或有效工程。`, {
        cause: error,
      });
    throw error;
  }
}

async function loadRevision(root: string, manifest: ProjectManifest, revisionId: string) {
  return (await loadRevisionContent(root, manifest, revisionId)).revision;
}

async function inspectProject(root: string) {
  const { manifest, bytes } = await readManifest(root);
  let importRecord: ProjectImportRecord | null = null;
  if (manifest.paper.currentRevision === null) {
    try {
      importRecord = parseImportRecord(
        (await readManagedJson(root, initialImportName, "首次导入记录")).value,
        manifest,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!importRecord)
      throw new Error("工程 currentRevision 为空，但缺少有效的首次导入记录，工程不完整。");
  }
  const currentRevision = manifest.paper.currentRevision
    ? await loadRevision(root, manifest, manifest.paper.currentRevision)
    : null;
  return {
    snapshot: { root, manifest, importRecord, currentRevision } satisfies ProjectCoreSnapshot,
    manifestBytes: bytes,
  };
}

async function serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(root) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  writeQueues.set(root, tail);
  try {
    return await result;
  } finally {
    if (writeQueues.get(root) === tail) writeQueues.delete(root);
  }
}

/** 工程级写锁：与 commitRevision 等提交路径共用同一 per-root 串行队列。
 * 侧车等受管旁路写入必须经此与 current 推进互斥；root 需为规范路径。 */
export function withProjectWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return serialized(root, operation);
}

async function writableParent(parent: string) {
  try {
    if (!path.isAbsolute(parent) || !(await fs.stat(parent)).isDirectory()) throw new Error();
    await fs.access(parent, constants.W_OK);
    const probe = path.join(parent, `.paper30min-${randomUUID()}.tmp`);
    await fs.writeFile(probe, "", { flag: "wx" });
    await fs.unlink(probe);
  } catch {
    throw new Error("工程文件夹不存在或不可写，请重新选择保存位置。");
  }
}

export async function createProject(
  input: CreateProjectInput,
  hooks: ProjectCommitHooks = {},
): Promise<ProjectCoreSnapshot> {
  validName(input.name);
  await writableParent(input.parent);
  const root = path.join(input.parent, input.name);
  try {
    await fs.mkdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("同名工程文件夹已存在，请修改名称或位置。");
    throw error;
  }

  await hooks.onCommitPoint?.("project-manifest", {});
  const manifest: ProjectManifest = {
    formatVersion: 2,
    id: randomUUID(),
    name: input.name,
    paper: { id: randomUUID(), currentRevision: null },
  };
  const importRecord: ProjectImportRecord = {
    formatVersion: 1,
    id: randomUUID(),
    projectId: manifest.id,
    paperId: manifest.paper.id,
  };
  const importFile = path.join(root, initialImportName);
  await fs.mkdir(path.dirname(importFile), { recursive: true });
  await atomicJson(path.join(root, manifestName), manifest);
  await hooks.onCommitPoint?.("import-record", {});
  await atomicJson(importFile, importRecord);
  return { root, manifest, importRecord, currentRevision: null };
}

export async function openProject(root: string): Promise<ProjectCoreSnapshot> {
  return (await inspectProject(await canonicalRoot(root))).snapshot;
}

export async function readSourceSnapshot(root: string, sourceSnapshotId: string) {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  return loadSourceSnapshot(root, manifest, sourceSnapshotId);
}

/** 列出全部已发布来源快照；每个快照均经清单与摘要校验，不按文件名猜测发布。 */
export async function listSourceSnapshots(root: string): Promise<SourceSnapshotRecord[]> {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  const sources = path.join(root, "sources");
  let entries;
  try {
    entries = await fs.readdir(sources, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshots: SourceSnapshotRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    snapshots.push(await loadSourceSnapshot(root, manifest, entry.name));
  }
  return snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readRevision(root: string, revisionId: string) {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  return loadRevision(root, manifest, revisionId);
}

/** Full 阅读器恢复所需侧车：与元数据同一次校验读取 changeset 与 tombstones。 */
export async function readRevisionContext(root: string, revisionId: string) {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  const { revision, tombstones, changeset } = await loadRevisionContent(root, manifest, revisionId);
  return { revision, changeset, tombstones };
}

export async function readRevisionDocument(
  root: string,
  revisionId: string,
  kind: "document" | "source-base",
): Promise<DocumentTree> {
  if (kind !== "document" && kind !== "source-base")
    throw new Error("文档树读取类型必须是 document 或 source-base。");
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  const { documents } = await loadRevisionContent(root, manifest, revisionId);
  return kind === "document" ? documents.document : documents.sourceBase;
}

export async function readRevisionTombstones(root: string, revisionId: string) {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  return (await loadRevisionContent(root, manifest, revisionId)).tombstones;
}

async function readManagedAsset(
  root: string,
  files: ManagedFileRecord[],
  directory: string,
  relative: string,
) {
  if (!relative.startsWith("assets/")) throw new Error("只能读取受管 assets 内容。");
  const record = files.find((file) => file.path === relative);
  if (!record) throw new Error(`受管资产未登记：${relative}。`);
  const bytes = await fs.readFile(await managedPath(root, `${directory}/${relative}`));
  if (bytes.byteLength !== record.size || digest(bytes) !== record.sha256)
    throw new Error(`受管资产摘要不符：${relative}。`);
  return {
    bytes,
    ...(record.mime === undefined ? {} : { mime: record.mime }),
  };
}

export async function readSourceSnapshotAsset(
  root: string,
  sourceSnapshotId: string,
  relative: string,
) {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  const snapshot = await loadSourceSnapshot(root, manifest, sourceSnapshotId);
  return readManagedAsset(root, snapshot.files, snapshot.path, relative);
}

export async function readRevisionAsset(
  root: string,
  revisionId: string,
  relative: string,
) {
  root = await canonicalRoot(root);
  const { manifest } = await readManifest(root);
  const { revision } = await loadRevisionContent(root, manifest, revisionId);
  return readManagedAsset(root, revision.files, revision.path, relative);
}

export async function publishSourceSnapshot(
  input: PublishSourceSnapshotInput,
  hooks: ProjectCommitHooks = {},
): Promise<SourceSnapshotRecord> {
  const files = normalizeFiles(input.files, "source");
  const metadata = normalizeMetadata(input.metadata, [
    "formatVersion",
    "sourceSnapshotId",
    "projectId",
    "paperId",
    "path",
    "files",
    "createdAt",
  ]);
  const root = await canonicalRoot(input.root);
  return serialized(root, async () => {
    const { manifest } = await readManifest(root);
    const sourceSnapshotId = randomUUID();
    const staged = await stageFiles(root, "source", files);
    const snapshot: SourceSnapshotRecord = {
      ...metadata,
      formatVersion: 1,
      sourceSnapshotId,
      projectId: manifest.id,
      paperId: manifest.paper.id,
      path: `sources/${sourceSnapshotId}`,
      files: fileRecords(files),
      createdAt: new Date().toISOString(),
    };
    await atomicJson(path.join(staged, "snapshot.json"), snapshot);
    await verifyDirectory(staged, files, ["snapshot.json"]);
    await hooks.onCommitPoint?.("source-content", { sourceSnapshotId });

    const sources = await ensureManagedDirectory(root, "sources");
    const target = path.join(sources, sourceSnapshotId);
    await assertMissing(target);
    await renameManaged(staged, target);
    const latest = await readManifest(root);
    if (
      latest.manifest.id !== manifest.id ||
      latest.manifest.paper.id !== manifest.paper.id
    ) {
      throw new Error("工程或主论文身份在来源发布期间发生变化，拒绝把快照报告为当前工程内容。");
    }
    return loadSourceSnapshot(root, latest.manifest, sourceSnapshotId);
  });
}

export async function commitRevision(
  input: CommitRevisionInput,
  hooks: ProjectCommitHooks = {},
): Promise<ProjectRevisionRecord> {
  if (input.baseRevision !== null && !uuid.test(input.baseRevision))
    throw new Error("baseRevision 必须是 revision ID 或 null。");
  if (input.revisionId !== undefined && !uuid.test(input.revisionId))
    throw new Error("revisionId 必须是有效 UUID。");
  let files = normalizeFiles(input.files, "revision");
  const metadata = normalizeMetadata(input.metadata, [
    "formatVersion",
    "revisionId",
    "projectId",
    "paperId",
    "sourceSnapshotId",
    "baseRevision",
    "path",
    "files",
    "committedAt",
  ]);
  const root = await canonicalRoot(input.root);
  return serialized(root, async () => {
    const initial = await inspectProject(root);
    const manifest = initial.snapshot.manifest;
    const current = manifest.paper.currentRevision;
    if (current !== input.baseRevision)
      throw new Error(`baseRevision 已过期：读取基线为 ${input.baseRevision}，current 为 ${current}。`);
    await loadSourceSnapshot(root, manifest, input.sourceSnapshotId);
    const baseDocument = input.baseRevision
      ? (await loadRevisionContent(root, manifest, input.baseRevision)).documents.document
      : null;
    const documents = validateBufferedRevisionTrees(files, manifest.paper.id);

    const revisionId = input.revisionId ?? randomUUID();
    files = materializeRevisionChangeset(
      files,
      revisionId,
      baseDocument,
      input.baseRevision,
      documents.document,
    );
    const staged = await stageFiles(root, "revision", files);
    const revisionPath = `paper/revisions/${revisionId}`;
    const revisions = await ensureManagedDirectory(root, "paper/revisions");
    const target = path.join(revisions, revisionId);
    let existingRevision: ProjectRevisionRecord | null = null;
    const targetExists = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (targetExists) {
      await verifyDirectory(target, files);
      try {
        existingRevision = parseRevision((await readManagedJson(
          root,
          `.paper30min/revisions/${revisionId}/revision.json`,
          "revision 元数据",
        )).value, manifest, revisionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      await renameManaged(staged, target);
      await verifyDirectory(target, files);
    }
    await hooks.onCommitPoint?.("revision-content", { revisionId });

    const revision: ProjectRevisionRecord = {
      ...metadata,
      formatVersion: 1,
      revisionId,
      projectId: manifest.id,
      paperId: manifest.paper.id,
      sourceSnapshotId: input.sourceSnapshotId,
      baseRevision: input.baseRevision,
      path: revisionPath,
      files: fileRecords(files),
      committedAt: existingRevision?.committedAt ?? new Date().toISOString(),
    };
    if (existingRevision && !isDeepStrictEqual(revision, existingRevision))
      throw new Error("相同 revisionId 的残留候选与本次提交不一致，拒绝覆盖不可变内容。");
    await ensureManagedDirectory(root, ".paper30min/revisions");
    const metadataDirectory = await ensureManagedDirectory(
      root,
      `.paper30min/revisions/${revisionId}`,
    );
    if (!existingRevision)
      await atomicJson(path.join(metadataDirectory, "revision.json"), revision);
    await hooks.onCommitPoint?.("revision-metadata", { revisionId });

    const nextManifest: ProjectManifest = {
      ...manifest,
      paper: { ...manifest.paper, currentRevision: revisionId },
    };
    await atomicJson(path.join(root, manifestName), nextManifest, async () => {
      const latest = await readManifest(root);
      if (!latest.bytes.equals(initial.manifestBytes))
        throw new Error("工程清单在提交期间发生变化，拒绝覆盖 current；候选已保留。");
      if (latest.manifest.paper.currentRevision !== input.baseRevision)
        throw new Error("current 基线在提交期间发生变化，拒绝发布；候选已保留。");
      await loadSourceSnapshot(root, latest.manifest, input.sourceSnapshotId);
      if (input.baseRevision)
        await loadRevision(root, latest.manifest, input.baseRevision);
      await loadRevision(root, latest.manifest, revisionId);
      await hooks.onCommitPoint?.("before-current-replace", { revisionId });
    });
    return revision;
  });
}

/**
 * 完成已完整发布但 current 未推进的候选（首次导入恢复专用）：
 * 逐文件核验磁盘内容与登记摘要一致后，只原子推进 current 指针，
 * 不重新转换、不新建 revision、不改写任何已发布字节。
 * 候选不存在、内容不符或基线已变化时拒绝，保留现场。
 */
export async function completePublishedRevision(
  root: string,
  revisionId: string,
  hooks: ProjectCommitHooks = {},
  /** 来源模块元数据校验：在串行临界区内、current 替换前执行；
   * 抛错即拒绝推进，避免"返回失败但 current 已推进"的矛盾状态。 */
  validateMetadata?: (revision: ProjectRevisionRecord) => void,
): Promise<ProjectRevisionRecord> {
  root = await canonicalRoot(root);
  return serialized(root, async () => {
    const initial = await readManifest(root);
    const { manifest } = initial;
    if (manifest.paper.currentRevision !== null)
      throw new Error("current 已存在，不能按首次导入候选推进。");
    const revision = await loadRevision(root, manifest, revisionId);
    if (revision.baseRevision !== null)
      throw new Error("候选不是首次导入 revision，拒绝按空基线推进。");
    await loadSourceSnapshot(root, manifest, revision.sourceSnapshotId);
    await verifyDirectory(await managedPath(root, revision.path), revision.files);
    validateMetadata?.(revision);
    const nextManifest: ProjectManifest = {
      ...manifest,
      paper: { ...manifest.paper, currentRevision: revisionId },
    };
    await atomicJson(path.join(root, manifestName), nextManifest, async () => {
      const latest = await readManifest(root);
      if (!latest.bytes.equals(initial.bytes))
        throw new Error("工程清单在提交期间发生变化，拒绝覆盖 current；候选已保留。");
      if (latest.manifest.paper.currentRevision !== null)
        throw new Error("current 基线在提交期间发生变化，拒绝发布；候选已保留。");
      // 与 commitRevision 同序复核：来源快照与候选内容在提交窗口内未被外部篡改。
      const recheck = async (): Promise<void> => {
        const current = await loadRevision(root, latest.manifest, revisionId);
        // 重载记录必须与初始记录完全一致：换源、改警告/版本/时间都拒绝。
        if (!isDeepStrictEqual(current, revision))
          throw new Error("候选 revision 元数据在提交期间发生变化，拒绝推进 current。");
        if (current.baseRevision !== null)
          throw new Error("候选基线在提交期间发生变化，拒绝推进 current。");
        await loadSourceSnapshot(root, latest.manifest, current.sourceSnapshotId);
        validateMetadata?.(current);
      };
      await recheck();
      await hooks.onCommitPoint?.("before-current-replace", { revisionId });
      // 注入点/外部写入可能发生在复核之后：替换前再核验一次。
      await recheck();
    });
    return revision;
  });
}

/**
 * 首次导入恢复的候选状态探测与残留清理（串行临界区内执行）：
 * - 内容目录与元数据都在 → "published"，调用方只补 current 推进；
 * - 仅内容目录存在、元数据 ENOENT → 受管残留候选，清除内容目录后返回 "residual"；
 * - 都不存在 → "absent"，调用方重新转换发布。
 * 探测只把 ENOENT 视为不存在；其他文件系统错误 fail closed。
 * 清理前重读清单确认 current 仍为空，且元数据确实缺失，绝不删除已发布内容。
 */
export async function inspectImportCandidate(
  root: string,
  revisionId: string,
): Promise<"published" | "residual" | "absent"> {
  root = await canonicalRoot(root);
  return serialized(root, async () => {
    const { manifest } = await readManifest(root);
    if (manifest.paper.currentRevision !== null)
      throw new Error("current 已存在，首次导入候选不再可探测或清理。");
    if (!uuid.test(revisionId)) throw new Error("candidateRevisionId 无效。");
    const contentDir = path.join(root, "paper", "revisions", revisionId);
    const metadataFile = path.join(root, ".paper30min", "revisions", revisionId, "revision.json");
    const exists = async (target: string): Promise<boolean> => {
      try {
        await fs.access(target);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    const hasContent = await exists(contentDir);
    const hasMetadata = await exists(metadataFile);
    if (hasContent && hasMetadata) return "published";
    if (!hasContent) return "absent";
    // 仅内容无元数据：锁内再次确认 current 为空且元数据仍缺失，才清除残留。
    const latest = await readManifest(root);
    if (latest.manifest.paper.currentRevision !== null)
      throw new Error("current 已被推进，拒绝清理候选内容。");
    if (await exists(metadataFile))
      throw new Error("候选元数据已出现，拒绝按残留清理。");
    await fs.rm(contentDir, { recursive: true, force: true });
    return "residual";
  });
}
