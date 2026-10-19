import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { citationId, validateCitation, type Citation, type CitationDictionary, type UsedCitation, type CitationUse } from "../shared/citations.js";
import { markdownRenderer, markCitationUses } from "../shared/markdown-references.js";
import { isAnnotationLink, resolveAnnotationLink, annotationHref, rewriteAnnotationLinks } from "../shared/annotation-links.js";
import {
  prepareDocumentReferences,
  type DocumentReferenceProcessor,
} from "./document-references.js";
import type {
  Command,
  CreateInput,
  DocumentRecord,
  Manifest,
  Preferences,
  Project,
  ReadingState,
  MarkdownFile,
  MarkdownSave,
  LegacyLibrary,
  LegacyImportResult,
} from "../shared/contracts.js";

const manifestName = "paper30min.json";
const directories = ["map", "explanations", "text", "notes", "memories", "tmp"];
const invalidName = /[<>:"/\\|?*\x00-\x1f]/;
const readingName = ".paper30min-reading.json";
const citationName = ".paper30min-citations.json";
interface LegacyImportRecord {
  source: string;
  sha256: string;
  root: string;
  projectId: string;
}
export interface AgentFile {
  bytes: Buffer;
  version: string;
}
export type WriteScope = { candidateDirectory?: string };

function validateReading(value: ReadingState): ReadingState {
  if (
    !value ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 100 ||
    typeof value.active !== "string" ||
    !value.pdf ||
    typeof value.pdf !== "object" ||
    Array.isArray(value.pdf)
  )
    throw new Error("阅读位置文件已损坏。");
  for (const tab of value.tabs) {
    if (!tab || typeof tab.key !== "string" || typeof tab.title !== "string")
      throw new Error("文档标签无效。");
    if (tab.path) relativePath(tab.path);
    if (
      tab.markdown &&
      (!["read", "edit", "split"].includes(tab.markdown.mode) ||
        !Number.isFinite(tab.markdown.scroll) ||
        tab.markdown.scroll < 0 ||
        (tab.markdown.readScroll !== undefined &&
          (!Number.isFinite(tab.markdown.readScroll) ||
            tab.markdown.readScroll < 0)) ||
        !Number.isInteger(tab.markdown.cursor) ||
        tab.markdown.cursor < 0)
    )
      throw new Error("Markdown 阅读位置无效。");
  }
  for (const [file, p] of Object.entries(value.pdf)) {
    relativePath(file);
    if (
      !p ||
      !/^[a-f0-9]{64}$/.test(p.sha256) ||
      !Number.isInteger(p.page) ||
      p.page < 1 ||
      !Number.isFinite(p.x) ||
      p.x < 0 ||
      !Number.isFinite(p.y) ||
      p.y < 0 ||
      !Number.isFinite(p.zoom) ||
      p.zoom < 0.2 ||
      p.zoom > 60 ||
      (p.scrollStrategy !== undefined &&
        !["vertical", "horizontal"].includes(p.scrollStrategy)) ||
      (p.spreadMode !== undefined &&
        !["none", "odd", "even"].includes(p.spreadMode)) ||
      (p.rotation !== undefined &&
        (!Number.isInteger(p.rotation) || p.rotation < 0 || p.rotation > 3))
    )
      throw new Error("PDF 阅读位置无效。");
  }
  return value;
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

function relativePath(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  )
    throw new Error("需要工程内相对路径。");
  const parts = value.split("/");
  parts.forEach(validName);
  if (
    parts[0].toLowerCase() === manifestName ||
    parts[0].startsWith(".paper30min-")
  )
    throw new Error("不能操作工程清单或内部临时文件。");
  return value;
}

async function atomicJson(file: string, value: unknown, signal?: AbortSignal) {
  const temporary = path.join(
    path.dirname(file),
    `.paper30min-${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function digest(file: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}

async function checkPdf(file: string | FileHandle) {
  const handle = typeof file === "string" ? await fs.open(file, "r") : file;
  try {
    const bytes = Buffer.alloc(5);
    await handle.read(bytes, 0, 5, 0);
    if (bytes.toString() !== "%PDF-") throw new Error("所选文件不是 PDF。");
  } finally {
    if (typeof file === "string") await handle.close();
  }
}

function parseManifest(value: unknown): Manifest {
  const m = value as Manifest;
  const record = (r: DocumentRecord) => {
    if (
      !r ||
      typeof r.id !== "string" ||
      !r.id ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    )
      throw new Error("工程文档身份无效。");
    relativePath(r.path);
  };
  if (
    !m ||
    m.formatVersion !== 1 ||
    typeof m.id !== "string" ||
    !m.id ||
    typeof m.name !== "string" ||
    !Array.isArray(m.materials) ||
    !Array.isArray(m.explanations) ||
    !m.translations ||
    typeof m.translations !== "object" ||
    Array.isArray(m.translations)
  )
    throw new Error("工程清单格式不支持或已损坏。");
  record(m.paper);
  m.materials.forEach(record);
  if (
    new Set([m.paper, ...m.materials].map((r) => r.id)).size !==
    m.materials.length + 1
  )
    throw new Error("工程文档身份重复。");
  if (
    new Set([m.paper, ...m.materials].map((r) => r.path.toLowerCase())).size !==
    m.materials.length + 1
  )
    throw new Error("工程文档路径重复。");
  if (m.map !== null) relativePath(m.map);
  m.explanations.forEach(relativePath);
  Object.values(m.translations).forEach(relativePath);
  return m;
}

function ensureAvailablePath(
  manifest: Manifest,
  relative: string,
  ownId?: string,
) {
  if (
    [manifest.paper, ...manifest.materials].some(
      (record) =>
        record.id !== ownId &&
        record.path.toLowerCase() === relative.toLowerCase(),
    )
  ) {
    throw new Error("此路径已关联另一份文档，请选择该文档自己的文件。");
  }
}

export class ProjectService {
  private creation = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private configFile: string,
    private trashFile: (file: string) => Promise<void>,
    private references: DocumentReferenceProcessor = prepareDocumentReferences,
  ) {}

  async close() {
    for (const controller of this.creation.values()) controller.abort();
    await this.queue;
  }

  dispatch(command: Command, signal?: AbortSignal): Promise<unknown> {
    if (command.type === "cancelCreate") {
      this.creation.get(command.operationId)?.abort();
      return Promise.resolve();
    }
    if (command.type === "create" || command.type === "importLegacy") {
      const operationId = command.type === "create" ? command.input.operationId : command.operationId;
      if (this.creation.has(operationId))
        return Promise.reject(new Error("创建任务已存在。"));
      const controller = new AbortController();
      this.creation.set(operationId, controller);
      return this.serialize<unknown>(() =>
        command.type === "create"
          ? this.create(command.input, controller.signal)
          : this.importLegacy(command, controller.signal),
      ).finally(() => this.creation.delete(operationId));
    }
    return this.serialize(() => this.execute(command, signal));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private agentPath(root: string, absolute: string) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    relativePath(relative);
    if (relative.split("/").some((part) => part.startsWith(".")))
      throw new Error("Agent 不能访问工程内部文件。");
    return relative;
  }

  private async writablePath(
    root: string,
    relative: string,
    scope: WriteScope = {},
  ) {
    relativePath(relative);
    if (relative.split("/").some((part) => part.startsWith(".")))
      throw new Error("不能写入工程内部文件。");
    const lower = relative.toLowerCase();
    if (scope.candidateDirectory) {
      const candidate = relativePath(scope.candidateDirectory).toLowerCase();
      if (
        (!candidate.startsWith("text/candidates/") && !/^text\/[a-f0-9]{32}$/.test(candidate)) ||
        !lower.startsWith(candidate + "/") ||
        /\.pdf$/i.test(lower)
      )
        throw new Error("审阅只能写入指定的候选目录。");
    } else {
      const manifest = await this.manifest(root);
      if (
        (lower.startsWith("text/") && !/\.(md|markdown)$/.test(lower)) ||
        lower.startsWith("sources/") ||
        /\.pdf$/i.test(lower) ||
        [manifest.paper, ...manifest.materials].some(
          (record) => record.path.toLowerCase() === lower,
        )
      )
        throw new Error("原始材料、图片和出处字典不能作为自由成果覆盖。");
    }
  }

  readAgentFile(root: string, absolute: string): Promise<AgentFile> {
    return this.serialize(async () => {
      const relative = this.agentPath(root, absolute);
      const file = await this.resolve(root, relative);
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.size > 2 * 1024 * 1024 ||
          /\.pdf$/i.test(relative)
        )
          throw new Error(
            "read 支持 2 MiB 内普通文件；PDF 请使用论文读取工具。",
          );
        const bytes = await handle.readFile();
        if (bytes.length > 2 * 1024 * 1024)
          throw new Error("文件超过读取预算。");
        return {
          bytes,
          version: createHash("sha256").update(bytes).digest("hex"),
        };
      } finally {
        await handle.close();
      }
    });
  }

  writeAgentFile(
    root: string,
    absolute: string,
    text: string,
    version: string | null,
    signal: AbortSignal,
    scope: WriteScope = {},
  ): Promise<MarkdownSave> {
    return this.serialize(async () => {
      signal.throwIfAborted();
      const relative = this.agentPath(root, absolute);
      await this.writablePath(root, relative, scope);
      return this.saveText(root, relative, text, version, signal);
    });
  }

  readParsingFile(root: string, batchId: string, relative: string): Promise<Buffer> {
    return this.serialize(async () => {
      const file = await this.resolve(root, await this.parsingPath(root, batchId, relative));
      if ((await fs.stat(file)).size > 256 * 1024 * 1024) throw new Error("解析文件超过 256 MiB。");
      const bytes = await fs.readFile(file);
      if (bytes.length > 256 * 1024 * 1024) throw new Error("解析文件超过 256 MiB。");
      return bytes;
    });
  }

  parsingBatches(root: string): Promise<string[]> {
    return this.serialize(async () => {
      await this.manifest(root);
      const batches = new Set<string>();
      for (const directory of [".paper30min/parsing", "text/candidates"]) {
        let entries;
        try { entries = await fs.readdir(await this.resolve(root, directory), { withFileTypes: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
          try { await this.resolve(root, `${directory}/${entry.name}/run.json`); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (batches.has(entry.name)) throw new Error("解析批次记录重复，请保留现场检查。");
          batches.add(entry.name);
        }
      }
      return [...batches];
    });
  }

  deleteParsingBatch(root: string, batchId: string): Promise<void> {
    return this.serialize(async () => {
      const manifest = await this.manifest(root);
      const runPath = await this.parsingPath(root, batchId, "run.json");
      await this.resolve(root, runPath);
      const directories = runPath.startsWith("text/candidates/")
        ? [`text/candidates/${batchId}`]
        : [`text/${batchId}`, `.paper30min/parsing/${batchId}`];
      const targets: string[] = [];
      for (const directory of directories) {
        if ([manifest.paper, ...manifest.materials].some((record) =>
          record.path.toLowerCase().startsWith(directory.toLowerCase() + "/")))
          throw new Error("解析目录内有已登记的原始材料，不能删除。");
        try { targets.push(await this.resolve(root, directory)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      // Keep the task record until its visible output has been recycled. A failed
      // second move can be retried without losing the remaining task identity.
      for (const target of targets) await this.trashFile(target);
    });
  }

  private async parsingPath(root: string, batchId: string, relative: string) {
    if (!/^[a-f0-9]{32}$/.test(batchId)) throw new Error("解析批次 ID 无效。");
    relativePath(relative);
    if (relative.split("/").some((part) => part.startsWith(".")) || /\.pdf$/i.test(relative))
      throw new Error("解析产物路径无效。");
    // Existing batches keep their original paths, including unfinished runs.
    try {
      await this.resolve(root, `text/candidates/${batchId}/run.json`);
      return `text/candidates/${batchId}/${relative}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (relative === "candidate.md") return `text/${batchId}/paper.md`;
    if (relative.startsWith("images/")) return `text/${batchId}/${relative}`;
    return `.paper30min/parsing/${batchId}/${relative}`;
  }

  writeParsingFile(root: string, batchId: string, relative: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const target = await this.parsingPath(root, batchId, relative);
      await this.manifest(root);
      let parent = await fs.realpath(root);
      for (const part of target.split("/").slice(0, -1)) {
        parent = path.join(parent, part);
        try { await fs.mkdir(parent); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error("解析目录不能是链接。");
      }
      const destination = path.join(root, target);
      try {
        await this.resolve(root, target);
        if (relative !== "run.json") {
          const previous = await fs.readFile(destination);
          if (!previous.equals(Buffer.from(bytes))) throw new Error("已有候选产物已变化，不能覆盖；请保留现场并检查。");
          return target;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const temporary = path.join(parent, `.paper30min-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx");
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        signal?.throwIfAborted();
        if (relative === "run.json") await fs.rename(temporary, destination);
        else {
          try { await fs.link(temporary, destination); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await fs.readFile(await this.resolve(root, target))).equals(Buffer.from(bytes))) throw error;
          }
        }
      } finally { await fs.rm(temporary, { force: true }); }
      return target;
    });
  }

  private async preferences(): Promise<Preferences> {
    try {
      const p = JSON.parse(
        await fs.readFile(this.configFile, "utf8"),
      ) as Preferences;
      if (
        (p.defaultFolder !== null && typeof p.defaultFolder !== "string") ||
        !Array.isArray(p.recent) ||
        p.recent.some(
          (r) => typeof r.root !== "string" || typeof r.name !== "string",
        )
      )
        throw new Error("本机配置已损坏。");
      return p;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { defaultFolder: null, recent: [] };
      throw error;
    }
  }

  private async reading(root: string): Promise<ReadingState> {
    const file = path.join(root, readingName);
    try {
      if ((await fs.lstat(file)).isSymbolicLink())
        throw new Error("阅读位置文件不能为符号链接。");
      if ((await fs.stat(file)).size > 1024 * 1024)
        throw new Error("阅读位置文件过大。");
      return validateReading(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { tabs: [], active: "", pdf: {} };
      throw error;
    }
  }

  private async savePreferences(p: Preferences) {
    await fs.mkdir(path.dirname(this.configFile), { recursive: true });
    await atomicJson(this.configFile, p);
  }

  private async writableFolder(folder: string) {
    try {
      if (!path.isAbsolute(folder) || !(await fs.stat(folder)).isDirectory())
        throw new Error();
      await fs.access(folder, constants.W_OK);
      const probe = path.join(folder, `.paper30min-${randomUUID()}.tmp`);
      await fs.writeFile(probe, "", { flag: "wx" });
      await fs.unlink(probe);
    } catch {
      throw new Error("工程文件夹不存在或不可写，请重新选择保存位置。");
    }
  }

  private async remember(project: Project, defaultFolder?: string) {
    const p = await this.preferences();
    p.recent = [
      { root: project.root, name: project.manifest.name },
      ...p.recent.filter((r) => r.root !== project.root),
    ].slice(0, 20);
    if (defaultFolder !== undefined) p.defaultFolder = defaultFolder;
    await this.savePreferences(p);
  }

  private async create(
    input: CreateInput,
    signal: AbortSignal,
    imported?: { projectId: string; sha256: string; file: FileHandle },
  ): Promise<Project> {
    validName(input.name);
    await this.writableFolder(input.parent);
    await checkPdf(imported?.file ?? input.source);
    signal.throwIfAborted();
    const root = path.join(input.parent, input.name);
    // An exclusive mkdir establishes ownership: cleanup can never delete an existing project.
    try {
      await fs.mkdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("同名工程文件夹已存在，请修改名称或位置。");
      throw error;
    }
    try {
      for (const directory of directories)
        await fs.mkdir(path.join(root, directory));
      await fs.mkdir(path.join(root, ".pi", "sessions"), { recursive: true });
      const paperPath = "text/paper.pdf";
      const target = path.join(root, paperPath);
      await pipeline(
        imported
          ? imported.file.createReadStream({ start: 0, autoClose: false })
          : createReadStream(input.source),
        createWriteStream(target, { flags: "wx" }),
        { signal },
      );
      const sha256 = await digest(target, signal);
      if (imported && sha256 !== imported.sha256)
        throw new Error("导入期间源 PDF 已变化，请重试。");
      const manifest: Manifest = {
        formatVersion: 1,
        id: imported?.projectId ?? randomUUID(),
        name: input.name,
        paper: { id: randomUUID(), path: paperPath, sha256 },
        materials: [],
        map: null,
        explanations: [],
        translations: {},
      };
      signal.throwIfAborted();
      await atomicJson(path.join(root, manifestName), manifest);
      const project = await this.snapshot(root);
      signal.throwIfAborted();
      // Registration is the commit point. Late cancellation cannot undo a committed project.
      await this.remember(
        project,
        input.makeDefault ? input.parent : undefined,
      );
      return project;
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      if (signal.aborted) throw new Error("已取消创建工程。");
      throw error;
    }
  }

  private get importFile() {
    return path.join(path.dirname(this.configFile), "legacy-imports.json");
  }

  private async importRecords(): Promise<LegacyImportRecord[]> {
    try {
      if ((await fs.lstat(this.importFile)).isSymbolicLink())
        throw new Error("PDF 导入记录不能是符号链接。");
      const value = JSON.parse(await fs.readFile(this.importFile, "utf8"));
      if (value?.formatVersion !== 1 || !Array.isArray(value.records) ||
          value.records.some((r: LegacyImportRecord) =>
            !r || typeof r.source !== "string" || !path.isAbsolute(r.source) ||
            !/^[a-f0-9]{64}$/.test(r.sha256) || typeof r.root !== "string" ||
            !path.isAbsolute(r.root) || typeof r.projectId !== "string" || !r.projectId))
        throw new Error("PDF 导入记录已损坏，请保留该文件并检查本机配置。");
      return value.records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async legacyPath(root: string, relative = "") {
    if (!path.isAbsolute(root)) throw new Error("需要完整旧书库路径。");
    if (relative) relativePath(relative);
    const target = path.resolve(root, relative);
    let cursor = path.parse(target).root;
    for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink())
        throw new Error("旧书库路径不能包含符号链接或目录联接。");
    }
    return fs.realpath(target);
  }

  private async scanLegacy(root: string): Promise<LegacyLibrary> {
    root = await this.legacyPath(root);
    const attachments = await this.legacyPath(root, "attachments");
    const entries = await fs.readdir(attachments, { withFileTypes: true });
    const papers: LegacyLibrary["papers"] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const relative = `attachments/${entry.name}/pdf`;
      try {
        const source = await this.legacyPath(root, relative);
        if (!(await fs.stat(source)).isFile()) throw new Error("原始 PDF 不是普通文件。");
        await checkPdf(source);
        papers.push({ path: relative, name: `pdf-${entry.name}` });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        papers.push({ path: relative, name: `pdf-${entry.name}`, error: (error as Error).message });
      }
    }
    if (!papers.length) throw new Error("旧书库中没有可导入的原始 PDF。");
    return { root, papers };
  }

  private async importLegacy(
    input: Extract<Command, { type: "importLegacy" }>,
    signal: AbortSignal,
  ): Promise<LegacyImportResult> {
    if (!/^attachments\/[^/]+\/pdf$/.test(input.path))
      throw new Error("只允许导入旧书库的原始 PDF。");
    const source = await this.legacyPath(input.root, input.path);
    const parent = (await this.preferences()).defaultFolder;
    if (!parent) throw new Error("请先设置默认工程文件夹。");
    const sourceRoot = await fs.realpath(input.root);
    let destination: string;
    try { destination = await fs.realpath(parent); }
    catch { throw new Error("工程文件夹不存在或不可写，请重新选择保存位置。"); }
    const overlap = path.relative(sourceRoot, destination);
    if (!overlap || (!overlap.startsWith(".." + path.sep) && overlap !== ".." && !path.isAbsolute(overlap)))
      throw new Error("默认工程文件夹不能位于旧书库内，请重新选择。");
    await this.writableFolder(parent);
    const before = await fs.lstat(source);
    if (!before.isFile()) throw new Error("原始 PDF 不是普通文件。");
    const file = await fs.open(source, "r");
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
        throw new Error("源 PDF 路径已变化，请重试。");
      await checkPdf(file);
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
      const sha256 = hash.digest("hex");
      signal.throwIfAborted();
      const records = await this.importRecords();
      const previous = records.find((r) => r.source === source && r.sha256 === sha256);
      if (previous) {
        try {
          const project = await this.snapshot(previous.root);
          if (project.manifest.id === previous.projectId &&
              project.manifest.paper.sha256 === sha256 &&
              await digest(await this.resolve(previous.root, project.manifest.paper.path), signal) === sha256) {
            signal.throwIfAborted();
            await this.remember(project);
            return { root: project.root, name: project.manifest.name, existing: true };
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error("已有导入工程无法核验，请检查后重试：" + (error as Error).message);
        }
      }
      validName(input.name);
      let name = input.name;
      // Preserve interrupted/unrelated directories. A new suffix lets the same PDF retry safely.
      for (let index = 2; ; index++) {
        try { await fs.lstat(path.join(parent, name)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
        name = `${input.name} (${index})`;
      }
      const record: LegacyImportRecord = {
        source, sha256, root: path.join(parent, name), projectId: randomUUID(),
      };
      const index = previous ? records.indexOf(previous) : -1;
      if (index < 0) records.push(record);
      else records[index] = record;
      // Reserve identity before mkdir; a crash after manifest publication can be recognized on retry.
      await atomicJson(this.importFile, { formatVersion: 1, records }, signal);
      const project = await this.create({
        source, parent, name, makeDefault: false, operationId: input.operationId,
      }, signal, { projectId: record.projectId, sha256, file });
      return { root: project.root, name: project.manifest.name, existing: false };
    } finally {
      await file.close();
    }
  }

  private async manifest(root: string) {
    if (!path.isAbsolute(root)) throw new Error("需要完整工程路径。");
    const file = path.join(root, manifestName);
    if ((await fs.lstat(file)).isSymbolicLink())
      throw new Error("工程清单不能是符号链接。");
    return parseManifest(JSON.parse(await fs.readFile(file, "utf8")));
  }

  private async resolve(root: string, relative: string) {
    relativePath(relative);
    const realRoot = await fs.realpath(root);
    let cursor = realRoot;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      const entry = await fs.lstat(cursor);
      if (entry.isSymbolicLink())
        throw new Error("工程文件不能通过链接指向其他位置。");
    }
    return cursor;
  }

  private async snapshot(root: string): Promise<Project> {
    root = await fs.realpath(root);
    const manifest = await this.manifest(root);
    const files: Project["files"] = [];
    const walk = async (directory: string, prefix: string) => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (
          entry.isSymbolicLink() ||
          entry.name === manifestName ||
          entry.name.startsWith(".") ||
          entry.name === "node_modules"
        )
          continue;
        const relative = prefix + entry.name;
        files.push({ path: relative, directory: entry.isDirectory() });
        if (entry.isDirectory())
          await walk(path.join(directory, entry.name), relative + "/");
      }
    };
    await walk(root, "");
    files.sort((a, b) => a.path.localeCompare(b.path));
    const missing = [manifest.paper, ...manifest.materials]
      .filter((r) => !files.some((f) => !f.directory && f.path === r.path))
      .map((r) => r.id);
    return {
      root,
      manifest,
      files,
      missing,
      reading: await this.reading(root),
    };
  }

  private async copyMaterial(
    root: string,
    source: string,
  ): Promise<DocumentRecord> {
    const name = path.basename(source);
    validName(name);
    const relative = "text/" + name;
    await this.resolve(root, "text");
    const destination = path.join(root, relative);
    // Stream into a private temporary file before publishing; partial copies never become materials.
    const temporary = path.join(
      root,
      "text",
      `.paper30min-${randomUUID()}.tmp`,
    );
    try {
      await pipeline(
        createReadStream(source),
        createWriteStream(temporary, { flags: "wx" }),
      );
      const sha256 = await digest(temporary);
      await fs.link(temporary, destination);
      return { id: randomUUID(), path: relative, sha256 };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async markdown(
    root: string,
    relative: string,
  ): Promise<MarkdownFile> {
    if (!/\.(md|markdown)$/i.test(relative))
      throw new Error("请选择 Markdown 文档。");
    return this.textFile(root, relative);
  }

  private async textFile(
    root: string,
    relative: string,
    budget = 2 * 1024 * 1024,
  ): Promise<MarkdownFile> {
    const file = await this.resolve(root, relative);
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > budget)
        throw new Error(
          "Markdown 超过 2 MiB 编辑预算或不是文件，请在外部应用中打开。",
        );
      const bytes = await handle.readFile();
      if (bytes.length > budget)
        throw new Error("Markdown 超过编辑预算。");
      // Keep a UTF-8 BOM in the text so saving does not silently remove it.
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      return {
        text,
        version: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  }

  private async saveMarkdown(
    root: string,
    relative: string,
    text: string,
    version: string,
  ): Promise<MarkdownSave> {
    if (!/\.(md|markdown)$/i.test(relative))
      throw new Error("请选择 Markdown 文档。");
    await this.writablePath(root, relative);
    return this.saveText(root, relative, text, version);
  }

  private async saveText(
    root: string,
    relative: string,
    text: string,
    version: string | null,
    signal?: AbortSignal,
    budget = 2 * 1024 * 1024,
  ): Promise<MarkdownSave> {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > budget ||
      (version !== null && !/^[a-f0-9]{64}$/.test(version))
    )
      throw new Error("正文或保存基线无效，正文上限为 2 MiB。");
    if (/\.(md|markdown)$/i.test(relative))
      text = await this.references(root, text);
    if (Buffer.byteLength(text, "utf8") > budget)
      throw new Error("转换后的正文超过保存预算。");
    const readCurrent = async () => {
      try {
        return await this.textFile(root, relative, budget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const current = await readCurrent();
    if ((current?.version ?? null) !== version)
      return { saved: false, file: current };
    if (current && text === current.text) return { saved: true, file: current };
    let parent = root;
    for (const part of path.posix.dirname(relative).split("/")) {
      if (part === ".") continue;
      parent = path.join(parent, part);
      try {
        await fs.mkdir(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if ((await fs.lstat(parent)).isSymbolicLink())
        throw new Error("不能写入链接目录。");
    }
    const file = current
      ? await this.resolve(root, relative)
      : path.join(root, relative);
    if (current) await fs.access(file, constants.W_OK);
    const temporary = path.join(
      path.dirname(file),
      ".paper30min-" + randomUUID() + ".tmp",
    );
    try {
      const handle = await fs.open(
        temporary,
        "wx",
        current ? (await fs.stat(file)).mode : undefined,
      );
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const latest = await readCurrent();
      if ((latest?.version ?? null) !== version)
        return { saved: false, file: latest };
      // Recheck the path after staging; ordinary external edits are detected before replacement.
      if (current) await this.resolve(root, relative);
      signal?.throwIfAborted();
      if (current) await fs.rename(temporary, file);
      else {
        try {
          await fs.link(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            return { saved: false, file: await readCurrent() };
          throw error;
        }
      }
      return {
        saved: true,
        file: {
          text,
          version: createHash("sha256").update(text, "utf8").digest("hex"),
        },
      };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async movedLinkEdits(root: string, from: string, to: string) {
    const edits: { path: string; before: MarkdownFile; text: string; budget: number }[] = [];
    const rewrite = (text: string, base: string, nextBase = base) => rewriteAnnotationLinks(text, (href) => {
      let target;
      try { target = resolveAnnotationLink(href, base); } catch { return href; }
      if (target.path !== from && base === nextBase) return href;
      if (target.path === from) target.path = to;
      return annotationHref(target, nextBase);
    });
    for (const entry of (await this.snapshot(root)).files) {
      if (entry.directory || !/\.(md|markdown)$/i.test(entry.path) || /^sources\//i.test(entry.path)) continue;
      const before = await this.markdown(root, entry.path);
      const text = rewrite(before.text, entry.path, entry.path === from ? to : entry.path);
      if (text !== before.text) edits.push({ path: entry.path === from ? to : entry.path, before, text, budget: 2 * 1024 * 1024 });
    }
    const directory = ".pi/sessions";
    let sessions: string[];
    try { sessions = await fs.readdir(await this.resolve(root, directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return edits; throw error; }
    for (const name of sessions) {
      if (!name.endsWith(".jsonl")) continue;
      const relative = `${directory}/${name}`;
      const budget = 32 * 1024 * 1024;
      const before = await this.textFile(root, relative, budget);
      if (!/#annotation=/i.test(before.text)) continue;
      let changed = false;
      const text = before.text.split(/(?<=\n)/).map((line) => {
        if (!line.trim()) return line;
        const entry: unknown = JSON.parse(line);
        const update = (value: unknown): unknown => {
          if (typeof value === "string") {
            const next = rewrite(value, "");
            if (next !== value) changed = true;
            return next;
          }
          if (Array.isArray(value)) return value.map(update);
          if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, update(item)]));
          return value;
        };
        const rewritten = update(entry);
        return JSON.stringify(rewritten) !== JSON.stringify(entry)
          ? JSON.stringify(rewritten) + (line.endsWith("\n") ? "\n" : "") : line;
      }).join("");
      if (changed) edits.push({ path: relative, before, text, budget });
    }
    return edits;
  }

  private async execute(
    command: Exclude<Command, { type: "create" | "cancelCreate" | "importLegacy" }>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (command.type === "preferences") return this.preferences();
    if (command.type === "scanLegacy") return this.scanLegacy(command.root);
    if (command.type === "setDefault") {
      if (command.folder !== null) await this.writableFolder(command.folder);
      const p = await this.preferences();
      p.defaultFolder = command.folder;
      await this.savePreferences(p);
      return p;
    }
    const root = await fs.realpath(command.root);
    const m = await this.manifest(root);
    if (command.type === "savePdf") {
      const record = [m.paper, ...m.materials].find((r) => r.path === command.path);
      if (!record || !/\.pdf$/i.test(command.path)) throw new Error("只能保存已登记的工程 PDF。");
      const bytes = Buffer.from(command.bytes);
      if (!/^[a-f0-9]{64}$/.test(command.version) || bytes.length > 128 * 1024 * 1024 ||
          bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("PDF 保存内容或版本无效。");
      const file = await this.resolve(root, command.path);
      const unchanged = async () => {
        await this.resolve(root, command.path);
        if (await digest(file) !== command.version)
          throw new Error("PDF 已在外部修改，批注尚未保存。请保留当前窗口并导出副本，重新打开后核对。");
      };
      await unchanged();
      await fs.access(file, constants.W_OK);
      const temporary = path.join(path.dirname(file), `.paper30min-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx", (await fs.stat(file)).mode);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        await unchanged();
        signal?.throwIfAborted();
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      // Preserve provenance hashes; citation navigation follows document identity, not byte equality.
      return { sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    if (command.type === "createCitation" || command.type === "resolveCitation" || command.type === "pdfUses") {
      let dictionary: CitationDictionary = { formatVersion: 1, projectId: m.id, citations: {} };
      let citationError = "";
      try {
        const file = path.join(root, citationName);
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("引用字典不能是符号链接。");
        if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error("引用字典超过 32 MiB。");
        dictionary = JSON.parse(await fs.readFile(file, "utf8"));
        if (dictionary?.formatVersion !== 1 || dictionary.projectId !== m.id ||
            !dictionary.citations || typeof dictionary.citations !== "object" || Array.isArray(dictionary.citations))
          throw new Error("引用字典格式或工程身份无效。");
        for (const [id, item] of Object.entries(dictionary.citations)) {
          if (!item || !/^[a-f0-9]{32}$/.test(id) || item.id !== id || typeof item.documentId !== "string")
            throw new Error("引用字典已损坏。");
          validateCitation(item);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (command.type !== "pdfUses") throw error;
          citationError = (error as Error).message;
          dictionary = { formatVersion: 1, projectId: m.id, citations: {} };
        }
      }
      if (command.type === "pdfUses") {
        const record = [m.paper, ...m.materials].find((r) => r.path === command.path);
        await this.resolve(root, command.path);
        const annotations: CitationUse[] = [];
        const used = new Map<string, UsedCitation>();
        const { files } = await this.snapshot(root);
        for (const entry of files) {
          // text/ owns originals, parsed drafts and review candidates; sources/ owns dictionaries.
          if (entry.directory || !/\.(md|markdown)$/i.test(entry.path) || /^(text|sources)\//i.test(entry.path)) continue;
          let file: MarkdownFile;
          try { file = await this.markdown(root, entry.path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new Error(`无法读取引用使用位置（${entry.path}）：${(error as Error).message}`);
          }
          const tokens = markdownRenderer.parse(file.text.replace(/^\uFEFF/, ""), {});
          const heading = tokens.findIndex((token) => token.type === "heading_open");
          const title = heading >= 0 ? tokens[heading + 1].content : path.basename(entry.path);
          for (const use of markCitationUses(tokens, entry.path)) {
            if (isAnnotationLink(use.id)) {
              if (resolveAnnotationLink(use.id).path === command.path)
                annotations.push({ ...use, path: entry.path, title, version: file.version });
              continue;
            }
            const citation = dictionary.citations[use.id];
            if (!citation || citation.documentId !== record?.id) continue;
            let item = used.get(use.id);
            if (!item) { item = { citation, uses: [] }; used.set(use.id, item); }
            item.uses.push({ ...use, path: entry.path, title, version: file.version });
          }
        }
        return { citations: [...used.values()], annotations, citationError };
      }
      const existing = command.type === "resolveCitation" ? dictionary.citations[citationId(command.link)] : undefined;
      if (command.type === "resolveCitation" && !existing) throw new Error("找不到此引用，可能属于其他工程或字典已缺失。");
      const record = [m.paper, ...m.materials].find((r) => existing ? r.id === existing.documentId : command.type === "createCitation" && r.path === command.path);
      if (!record) throw new Error("引用对应的 PDF 身份不存在，请先将 PDF 加入工程材料。");
      const input = command.type === "createCitation" ? command.input : existing!;
      validateCitation(input);
      let file: string;
      try { file = await this.resolve(root, record.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("引用 PDF 已缺失，请重新关联原文件。");
        throw error;
      }
      if (!/\.pdf$/i.test(file)) throw new Error("引用目标必须是 PDF。");
      if (!existing && await digest(file, signal) !== input.sha256)
        throw new Error("PDF 已被替换或版本无法确认，请重新选择后创建引用。");
      if (existing) return { citation: existing, path: record.path };
      // Compare evidence, not object serialization or approximate geometry. Reuse
      // happens inside the project queue and only after verifying the current PDF.
      const reusable = Object.values(dictionary.citations).find((item) =>
        item.documentId === record.id && item.sha256 === input.sha256 &&
        item.kind === input.kind && item.text === input.text &&
        item.pages.length === input.pages.length && item.pages.every((p, i) => {
          const other = input.pages[i];
          return p.page === other.page && p.width === other.width && p.height === other.height &&
            p.rects.length === other.rects.length && p.rects.every((rect, j) => {
              const target = other.rects[j];
              return rect.origin.x === target.origin.x && rect.origin.y === target.origin.y &&
                rect.size.width === target.size.width && rect.size.height === target.size.height;
            });
        }));
      if (reusable) return reusable;
      const citation: Citation = { ...input, id: randomUUID().replaceAll("-", ""), documentId: record.id };
      dictionary.citations[citation.id] = citation;
      if (Buffer.byteLength(JSON.stringify(dictionary, null, 2) + "\n") > 32 * 1024 * 1024)
        throw new Error("引用字典超过 32 MiB，本次引用未保存。");
      // The project command queue serializes additions; staging + sync + rename keeps old data intact on interruption.
      await atomicJson(path.join(root, citationName), dictionary, signal);
      return citation;
    }
    if (
      command.type === "saveWorkspace" ||
      command.type === "savePdfPosition"
    ) {
      const state = await this.reading(root);
      if (command.type === "saveWorkspace") {
        state.tabs = command.tabs;
        state.active = command.active;
      } else {
        relativePath(command.path);
        state.pdf[command.path] = command.position;
      }
      await atomicJson(path.join(root, readingName), validateReading(state));
      return;
    }
    if (command.type === "readMarkdown")
      return this.markdown(root, command.path);
    if (command.type === "saveMarkdown")
      return this.saveMarkdown(
        root,
        command.path,
        command.text,
        command.version,
      );
    if (command.type === "createNote") {
      validName(command.name);
      const name = /\.(md|markdown)$/i.test(command.name)
        ? command.name
        : command.name + ".md";
      const directory = await this.resolve(root, "notes");
      await fs.writeFile(path.join(directory, name), "", { flag: "wx" });
      return "notes/" + name;
    }
    if (command.type === "readAsset") {
      const mime = (
        {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".avif": "image/avif",
        } as Record<string, string>
      )[path.extname(command.path).toLowerCase()];
      if (!mime) throw new Error("不支持的图片格式。");
      const file = await this.resolve(root, command.path);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
        throw new Error("图片超过 20 MiB 或不是文件。");
      const bytes = await fs.readFile(file);
      if (bytes.length > 20 * 1024 * 1024)
        throw new Error("图片超过读取预算。");
      return { bytes: new Uint8Array(bytes), mime };
    }
    if (command.type === "readPdf") {
      const file = await this.resolve(root, command.path);
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !/\.pdf$/i.test(file))
          throw new Error("请选择 PDF 文件。");
        if (stat.size > 128 * 1024 * 1024)
          throw new Error("PDF 超过 128 MiB 阅读预算，请在外部应用中打开。");
        const bytes = await handle.readFile();
        if (bytes.length > 128 * 1024 * 1024)
          throw new Error("PDF 超过阅读预算。");
        return {
          bytes: new Uint8Array(bytes),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } finally {
        await handle.close();
      }
    }
    if (command.type === "open") {
      const project = await this.snapshot(root);
      await this.remember(project);
      return project;
    }
    if (command.type === "refresh") return this.snapshot(root);
    if (command.type === "resolveFile" || command.type === "read") {
      const file = await this.resolve(root, command.path);
      if (!(await fs.stat(file)).isFile()) throw new Error("请选择文件。");
      if (command.type === "resolveFile") return file;
      if (!/\.(md|txt|json|csv|tsv|py|js|ts|yaml|yml)$/i.test(file))
        return null;
      if ((await fs.stat(file)).size > 2 * 1024 * 1024)
        throw new Error("文件过大，请在外部应用中打开。");
      return fs.readFile(file, "utf8");
    }
    if (command.type === "addMaterial") {
      ensureAvailablePath(m, "text/" + path.basename(command.source));
      const record = await this.copyMaterial(root, command.source);
      m.materials.push(record);
      try {
        await atomicJson(path.join(root, manifestName), m);
      } catch (error) {
        await fs.unlink(path.join(root, record.path));
        throw error;
      }
    }
    if (command.type === "move") {
      const source = await this.resolve(root, command.path);
      if (!(await fs.stat(source)).isFile())
        throw new Error("请选择需要改名或移动的文件。");
      relativePath(command.destination);
      if (command.path === command.destination) return this.snapshot(root);
      const ownId = [m.paper, ...m.materials].find(
        (record) => record.path === command.path,
      )?.id;
      ensureAvailablePath(m, command.destination, ownId);
      const parent = path.posix.dirname(command.destination);
      if (parent !== ".") await this.resolve(root, parent);
      const destination = path.join(root, command.destination);
      const edits = await this.movedLinkEdits(root, command.path, command.destination);
      await fs.link(source, destination);
      try {
        await fs.unlink(source);
      } catch (error) {
        await fs.unlink(destination);
        throw error;
      }
      const replace = (p: string) =>
        p === command.path ? command.destination : p;
      m.paper.path = replace(m.paper.path);
      m.materials.forEach((r) => (r.path = replace(r.path)));
      if (m.map) m.map = replace(m.map);
      m.explanations = m.explanations.map(replace);
      Object.keys(m.translations).forEach(
        (k) => (m.translations[k] = replace(m.translations[k])),
      );
      const applied: { edit: typeof edits[number]; version: string }[] = [];
      try {
        for (const edit of edits) {
          const result = await this.saveText(root, edit.path, edit.text, edit.before.version, signal, edit.budget);
          if (!result.saved) throw new Error(`文档已在外部变化，不能更新批注链接：${edit.path}`);
          applied.push({ edit, version: result.file.version });
        }
        await atomicJson(path.join(root, manifestName), m);
      } catch (error) {
        const failures: string[] = [];
        for (const { edit, version } of applied.reverse()) {
          try {
            const result = await this.saveText(root, edit.path, edit.before.text, version, undefined, edit.budget);
            if (!result.saved) failures.push(edit.path);
          } catch { failures.push(edit.path); }
        }
        await fs.link(destination, source);
        await fs.unlink(destination);
        if (failures.length) throw new Error(`移动未完成，部分文档发生外部变更，未覆盖：${failures.join("、")}`);
        throw error;
      }
    }
    if (command.type === "relink") {
      const record = [m.paper, ...m.materials].find((r) => r.id === command.id);
      if (!record) throw new Error("找不到文档身份。");
      if (!(await this.snapshot(root)).missing.includes(record.id))
        throw new Error("文档仍存在，无需重新关联。");
      const sha256 = await digest(command.source);
      if (sha256 !== record.sha256)
        throw new Error("文件内容与原文档不同，不能将其他文件关联为同一文档。");
      const relative = path
        .relative(root, await fs.realpath(command.source))
        .split(path.sep)
        .join("/");
      if (
        relative &&
        !relative.startsWith("../") &&
        !path.isAbsolute(relative)
      ) {
        await this.resolve(root, relative);
        ensureAvailablePath(m, relative, record.id);
        record.path = relative;
        await atomicJson(path.join(root, manifestName), m);
      } else {
        ensureAvailablePath(
          m,
          "text/" + path.basename(command.source),
          record.id,
        );
        const copied = await this.copyMaterial(root, command.source);
        record.path = copied.path;
        try {
          await atomicJson(path.join(root, manifestName), m);
        } catch (error) {
          await fs.unlink(path.join(root, copied.path));
          throw error;
        }
      }
    }
    if (command.type === "trash") {
      const record = m.materials.find((r) => r.id === command.id);
      if (!record) throw new Error("只能移出附加参考材料，工程论文不能移出。");
      const file = await this.resolve(root, record.path);
      await this.trashFile(file);
      m.materials = m.materials.filter((r) => r.id !== command.id);
      try {
        await atomicJson(path.join(root, manifestName), m);
      } catch {
        throw new Error(
          "文件已移入回收站，但清单保存失败。请从回收站恢复文件后刷新工程。",
        );
      }
    }
    return this.snapshot(root);
  }
}
