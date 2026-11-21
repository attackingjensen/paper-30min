import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { renameManaged } from "./managed-rename.js";
import { readRevisionAsset } from "./project-core.js";
import { readUpdateCandidateAsset } from "./document/candidate-store.js";
import type {
  Command,
  CoreCommand,
  CreateInput,
  DocumentRecord,
  Manifest,
  Preferences,
  Project,
  ReadingState,
  MarkdownFile,
  MarkdownSave,
} from "../shared/contracts.js";

const manifestName = "paper30min.json";
const directories = ["text", "notes", "memories", "tmp"];
const invalidName = /[<>:"/\\|?*]/;
const readingName = ".paper30min-reading.json";
export interface AgentFile {
  bytes: Buffer;
  version: string;
}

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
  if (value.reader !== undefined) {
    if (!value.reader || typeof value.reader !== "object" || Array.isArray(value.reader))
      throw new Error("Full 阅读位置无效。");
    for (const [tab, p] of Object.entries(value.reader)) {
      if (
        !tab ||
        !p ||
        typeof p.revisionId !== "string" ||
        !["source", "translation"].includes(p.view) ||
        !p.anchor ||
        typeof p.anchor.kind !== "string" ||
        (p.parentSectionId !== null && typeof p.parentSectionId !== "string") ||
        typeof p.excerpt !== "string" ||
        p.excerpt.length > 4096 ||
        !Number.isFinite(p.offsetWithinAnchor) ||
        !Number.isFinite(p.scrollTop) ||
        p.scrollTop < 0 ||
        typeof p.capturedAt !== "string"
      )
        throw new Error("Full 阅读位置无效。");
    }
  }
  return value;
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
    await renameManaged(temporary, file);
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
  if (value && typeof value === "object" && "formatVersion" in value && value.formatVersion === 2) {
    // 工作台只需要工程身份与名称；current 损坏不阻止打开工程，
    // 由 Full 阅读器呈现恢复状态。身份字段损坏仍按清单错误拒绝。
    const m = value as { id?: unknown; name?: unknown; paper?: { id?: unknown } };
    if (typeof m.id !== "string" || !m.id || typeof m.name !== "string" ||
        typeof m.paper?.id !== "string" || !m.paper.id)
      throw new Error("工程清单格式不支持或已损坏。");
    return {
      formatVersion: 1,
      id: m.id,
      name: m.name,
      paper: { id: m.paper.id, path: "", sha256: "0".repeat(64) },
    };
  }
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
    typeof m.name !== "string"
  )
    throw new Error("工程清单格式不支持或已损坏。");
  record(m.paper);
  return m;
}

function ensureAvailablePath(
  manifest: Manifest,
  relative: string,
  ownId?: string,
) {
  if (
    manifest.paper.id !== ownId &&
    manifest.paper.path.toLowerCase() === relative.toLowerCase()
  ) {
    throw new Error("此路径已关联另一份文档，请选择该文档自己的文件。");
  }
}

export class ProjectService {
  private creation = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private configFile: string) {}

  async close() {
    for (const controller of this.creation.values()) controller.abort();
    await this.queue;
  }

  dispatch(command: Exclude<Command, CoreCommand>, signal?: AbortSignal): Promise<unknown> {
    if (command.type === "cancelCreate") {
      this.creation.get(command.operationId)?.abort();
      return Promise.resolve();
    }
    if (command.type === "create") {
      const operationId = command.input.operationId;
      if (this.creation.has(operationId))
        return Promise.reject(new Error("创建任务已存在。"));
      const controller = new AbortController();
      this.creation.set(operationId, controller);
      return this.serialize<unknown>(() =>
        this.create(command.input, controller.signal),
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
  ) {
    relativePath(relative);
    if (relative.split("/").some((part) => part.startsWith(".")))
      throw new Error("不能写入工程内部文件。");
    const lower = relative.toLowerCase();
    const manifest = await this.manifest(root);
    if (
      (lower.startsWith("text/") && !/\.(md|markdown)$/.test(lower)) ||
      lower.startsWith("sources/") ||
      lower.startsWith("paper/revisions/") ||
      lower === "paper" ||
      /\.pdf$/i.test(lower) ||
      (manifest.paper.path !== "" && manifest.paper.path.toLowerCase() === lower)
    )
      throw new Error("原始论文、图片和内部文件不能作为自由成果覆盖。");
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
  ): Promise<MarkdownSave> {
    return this.serialize(async () => {
      signal.throwIfAborted();
      const relative = this.agentPath(root, absolute);
      await this.writablePath(root, relative);
      return this.saveText(root, relative, text, version, signal);
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
  ): Promise<Project> {
    validName(input.name);
    await this.writableFolder(input.parent);
    await checkPdf(input.source);
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
        createReadStream(input.source),
        createWriteStream(target, { flags: "wx" }),
        { signal },
      );
      const sha256 = await digest(target, signal);
      const manifest: Manifest = {
        formatVersion: 1,
        id: randomUUID(),
        name: input.name,
        paper: { id: randomUUID(), path: paperPath, sha256 },
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
    // v2 虚拟论文入口没有文件路径；正文可用性由 coreOpen/current 决定。
    const missing = [manifest.paper]
      .filter((r) => r.path !== "" && !files.some((f) => !f.directory && f.path === r.path))
      .map((r) => r.id);
    return {
      root,
      manifest,
      files,
      missing,
      reading: await this.reading(root),
    };
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
      if (current) await renameManaged(temporary, file);
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

  private async execute(
    command: Exclude<Command, CoreCommand | { type: "create" | "cancelCreate" }>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (command.type === "preferences") return this.preferences();
    if (command.type === "setDefault") {
      if (command.folder !== null) await this.writableFolder(command.folder);
      const p = await this.preferences();
      p.defaultFolder = command.folder;
      await this.savePreferences(p);
      return p;
    }
    const root = await fs.realpath(command.root);
    const m = await this.manifest(root);
    if (
      command.type === "saveWorkspace" ||
      command.type === "savePdfPosition" ||
      command.type === "saveReaderPosition"
    ) {
      const state = await this.reading(root);
      if (command.type === "saveWorkspace") {
        state.tabs = command.tabs;
        state.active = command.active;
      } else if (command.type === "saveReaderPosition") {
        (state.reader ??= {})[command.tab] = command.position;
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
      await fs.mkdir(path.join(root, "notes"), { recursive: true });
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
      // v2 revision 资产走受管读取：登记、摘要与预算由 project-core 校验。
      const revisionAsset = /^paper\/revisions\/([0-9a-f-]{36})\/(assets\/.+)$/.exec(command.path);
      if (revisionAsset) {
        const asset = await readRevisionAsset(root, revisionAsset[1], revisionAsset[2]);
        return { bytes: new Uint8Array(asset.bytes), mime: asset.mime ?? mime };
      }
      // 更新候选资产（冲突预览）：受管内部存储，登记与摘要同 revision 口径。
      const candidateAsset = /^update-candidates\/([0-9a-f-]{36})\/(assets\/.+)$/.exec(command.path);
      if (candidateAsset) {
        const asset = await readUpdateCandidateAsset({
          root, revisionId: candidateAsset[1], path: candidateAsset[2],
        });
        return { bytes: new Uint8Array(asset.bytes), mime: asset.mime ?? mime };
      }
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
          document: m.paper.path !== "" && m.paper.path === command.path ? m.paper : undefined,
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
    if (command.type === "move") {
      const source = await this.resolve(root, command.path);
      if (!(await fs.stat(source)).isFile())
        throw new Error("请选择需要改名或移动的文件。");
      relativePath(command.destination);
      if (command.path === command.destination) return this.snapshot(root);
      // v2 受管正文与来源不可改名移动；revision 身份由 project-core 命令推进。
      if (
        command.path.startsWith("paper/revisions/") ||
        command.path.startsWith("sources/") ||
        command.destination.startsWith("paper/revisions/") ||
        command.destination.startsWith("sources/")
      )
        throw new Error("受管正文与来源快照不能改名或移动。");
      const ownId = m.paper.path !== "" && m.paper.path === command.path ? m.paper.id : undefined;
      ensureAvailablePath(m, command.destination, ownId);
      const parent = path.posix.dirname(command.destination);
      if (parent !== ".") await this.resolve(root, parent);
      const destination = path.join(root, command.destination);
      await fs.link(source, destination);
      try {
        await fs.unlink(source);
      } catch (error) {
        await fs.unlink(destination);
        throw error;
      }
      if (m.paper.path !== "") {
        if (m.paper.path === command.path) m.paper.path = command.destination;
        try {
          await atomicJson(path.join(root, manifestName), m);
        } catch (error) {
          await fs.link(destination, source);
          await fs.unlink(destination);
          throw error;
        }
      }
    }
    return this.snapshot(root);
  }
}
