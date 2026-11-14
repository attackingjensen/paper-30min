import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ProjectCoreSnapshot,
  ProjectImportRecord,
  ProjectManifest,
} from "../shared/contracts.js";

const manifestName = "paper30min.json";
const initialImportName = ".paper30min/imports/initial.json";
const invalidName = /[<>:"/\\|?*\x00-\x1f]/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CreateProjectInput {
  parent: string;
  name: string;
}

function validName(name: string) {
  if (
    !name ||
    name !== name.trim() ||
    invalidName.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("名称不可为空，也不能包含路径分隔符或 Windows 保留字符。");
  }
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
  };
}

async function atomicJson(file: string, value: unknown) {
  const temporary = path.join(path.dirname(file), `.paper30min-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function managedPath(root: string, relative: string) {
  let target = root;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    if ((await fs.lstat(target)).isSymbolicLink())
      throw new Error("受管工程文件不能通过符号链接或目录联接访问。");
  }
  return target;
}

async function readJson(file: string) {
  if ((await fs.stat(file)).size > 1024 * 1024)
    throw new Error("工程 JSON 文件超过 1 MiB 读取预算。");
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
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

export async function createProject(input: CreateProjectInput): Promise<ProjectCoreSnapshot> {
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
  await atomicJson(importFile, importRecord);
  return { root, manifest, importRecord };
}

export async function openProject(root: string): Promise<ProjectCoreSnapshot> {
  if (!path.isAbsolute(root)) throw new Error("需要完整工程路径。");
  root = await fs.realpath(root);
  const manifest = parseManifest(
    await readJson(await managedPath(root, manifestName)),
  );
  let importRecord: ProjectImportRecord | null = null;
  try {
    importRecord = parseImportRecord(
      await readJson(await managedPath(root, initialImportName)),
      manifest,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (manifest.paper.currentRevision === null && !importRecord)
    throw new Error("工程 currentRevision 为空，但缺少有效的首次导入记录，工程不完整。");
  return { root, manifest, importRecord };
}
