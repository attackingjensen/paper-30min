import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createLocalPowerShellOperations,
  generateUnifiedPatch,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ProjectService,
  type AgentFile,
  type WriteScope,
} from "./project-service.js";

export function redact(value: string, secrets: string[]) {
  for (const secret of secrets.filter(Boolean))
    value = value.split(secret).join("[已隐藏凭据]");
  return value;
}
export function redactData<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((item) => redactData(item, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactData(item, secrets),
      ]),
    ) as T;
  return value;
}

// A non-inheritable job handle held by the shell makes all descendants exit when
// the shell exits, including detached children. Windows x64 is the client target.
const jobBootstrap = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Paper30MinJob {
  [StructLayout(LayoutKind.Explicit, Size=144)]
  public struct Limits { [FieldOffset(16)] public uint Flags; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Limits l, uint s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static IntPtr Handle;
  public static void Attach() {
    if (IntPtr.Size != 8) throw new Exception("Windows x64 required");
    Handle = CreateJobObject(IntPtr.Zero, null);
    var limits = new Limits { Flags = 0x2000 };
    if (Handle == IntPtr.Zero || !SetInformationJobObject(Handle, 9, ref limits, 144) ||
        !AssignProcessToJobObject(Handle, GetCurrentProcess()))
      throw new Exception("Cannot establish process job: " + Marshal.GetLastWin32Error());
  }
}
'@
[Paper30MinJob]::Attach()
`;

export function createProjectTools(
  root: string,
  service: ProjectService,
  active: () => boolean,
  secrets: string[],
  scope: WriteScope = {},
): ToolDefinition[] {
  const baselines = new Map<string, AgentFile>();
  const key = (file: string) => path.resolve(file).toLowerCase();
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!active()) throw new Error("任务已停止。");
  };
  const read = async (file: string) => {
    check();
    const value = await service.readAgentFile(root, file);
    check();
    try {
      new TextDecoder("utf8", { fatal: true }).decode(value.bytes);
    } catch {
      throw new Error("read 当前支持 UTF-8 文本，二进制材料请在阅读器中查看。");
    }
    baselines.set(key(file), value);
    return value.bytes;
  };
  const write = async (file: string, content: string, signal: AbortSignal) => {
    check(signal);
    const baseline = baselines.get(key(file));
    const saved = await service.writeAgentFile(
      root,
      file,
      content,
      baseline?.version ?? null,
      signal,
      scope,
    );
    if (!saved.saved) {
      const error = new Error(
        "文件基线已改变，必须先 read 重读；本次内容未覆盖磁盘。",
      );
      Object.assign(error, {
        conflict: {
          path: path.relative(root, file).split(path.sep).join("/"),
          base: baseline?.bytes.toString("utf8") ?? null,
          current: saved.file?.text ?? null,
          proposed: content,
        },
      });
      throw error;
    }
    baselines.set(key(file), {
      bytes: Buffer.from(saved.file.text),
      version: saved.file.version,
    });
    return {
      path: path.relative(root, file).split(path.sep).join("/"),
      patch: generateUnifiedPatch(
        path.relative(root, file),
        baseline?.bytes.toString("utf8") ?? "",
        saved.file.text,
      ).slice(0, 50000),
    };
  };
  const reader = createReadToolDefinition(root, {
    operations: {
      readFile: read,
      access: async () => {
        check();
      },
    },
  });
  reader.description =
    "Read a UTF-8 text file within the current project (maximum 2 MiB). Supports offset and limit; output is truncated by Pi. PDF/image tools are delivered separately.";
  // Each invocation carries its own cancellation signal and write callback.
  const mutations = [
    createWriteToolDefinition(root),
    createEditToolDefinition(root),
  ].map((definition) => ({
    ...definition,
    async execute(
      id: string,
      args: any,
      signal: AbortSignal | undefined,
      update: any,
      context: any,
    ) {
      let change: { path: string; patch: string } | undefined;
      try {
        check(signal);
        const controller = signal ?? new AbortController().signal;
        const operations = {
          writeFile: async (file: string, content: string) => {
            change = await write(file, content, controller);
          },
        };
        const native =
          definition.name === "write"
            ? createWriteToolDefinition(root, {
                operations: {
                  ...operations,
                  mkdir: async () => {
                    check(signal);
                  },
                },
              })
            : createEditToolDefinition(root, {
                operations: {
                  ...operations,
                  access: async () => {
                    check(signal);
                  },
                  readFile: editorRead,
                },
              });
        const result = await native.execute(id, args, signal, update, context);
        return redactData(
          { ...result, details: { ...result.details, change } },
          secrets,
        );
      } catch (error) {
        const conflict = (error as Error & { conflict?: unknown }).conflict;
        return {
          content: [
            {
              type: "text" as const,
              text: redact((error as Error).message, secrets),
            },
          ],
          details: redactData({ failed: true, conflict, change }, secrets),
        };
      }
    },
  }));
  async function editorRead(file: string) {
    check();
    const baseline = baselines.get(key(file));
    if (!baseline) throw new Error("edit 前必须先 read 文件。");
    return baseline.bytes;
  }
  const nativeShell = createLocalPowerShellOperations();
  const shell = createBashToolDefinition(root, {
    exposeSessionEnvironment: false,
    operations: {
      exec: async (command, cwd, options) => {
        check(options.signal);
        if (process.platform !== "win32")
          throw new Error("Shell 当前仅支持 Windows。");
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PSMODULEPATH|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(
              name,
            ),
          ),
        );
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const flush = (final = false) => {
          // Consume complete secrets before retaining an unmatched tail prefix;
          // a secret may itself end with its prefix (for example, abcab).
          let offset = 0;
          let text = "";
          const keys = secrets
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);
          while (offset < pending.length) {
            const match = keys.find((key) => pending.startsWith(key, offset));
            if (match) {
              text += "[已隐藏凭据]";
              offset += match.length;
            } else if (
              !final &&
              keys.some(
                (key) =>
                  key.length > pending.length - offset &&
                  key.startsWith(pending.slice(offset)),
              )
            )
              break;
            else text += pending[offset++];
          }
          pending = pending.slice(offset);
          if (text) options.onData(Buffer.from(text));
        };
        try {
          return await nativeShell.exec(
            `$ErrorActionPreference = 'Stop'\n${jobBootstrap}\n${command}`,
            cwd,
            {
              ...options,
              env,
              timeout: options.timeout ?? 120,
              onData: (data) => {
                pending += decoder.write(data);
                flush();
              },
            },
          );
        } finally {
          pending += decoder.end();
          flush(true);
        }
      },
    },
  });
  shell.description =
    shell.description.replace("bash", "Windows PowerShell") +
    " Trusted host execution, no filesystem sandbox. Use scripts only for the user's explicit task. Do not overwrite protected text/, sources/, PDFs or internal files; use write/edit for document mutations. Keep subprocesses in the foreground. No credentials are provided.";
  shell.promptSnippet = "Run a Windows PowerShell command";
  shell.promptGuidelines = [
    "Commands use PowerShell syntax, not Bash. Working directory is the current project.",
  ];
  return [reader, ...mutations, shell].map((definition) => ({
    ...definition,
    async execute(
      id: string,
      args: any,
      signal: AbortSignal | undefined,
      update: any,
      context: any,
    ) {
      check(signal);
      const before =
        definition.name === "bash"
          ? ((await service.dispatch({ type: "refresh", root })) as {
              files: { path: string }[];
            })
          : undefined;
      const result = await definition.execute(
        id,
        args,
        signal,
        update
          ? (value: unknown) => {
              if (active()) update(redactData(value, secrets));
            }
          : undefined,
        context,
      );
      if (before && active()) {
        const after = (await service.dispatch({ type: "refresh", root })) as {
          files: { path: string; directory: boolean }[];
        };
        const old = new Set(before.files.map((file) => file.path));
        return redactData(
          {
            ...result,
            details: {
              ...result.details,
              artifacts: after.files
                .filter((file) => !file.directory && !old.has(file.path))
                .map((file) => file.path),
            },
          },
          secrets,
        );
      }
      return redactData(result, secrets);
    },
  })) as ToolDefinition[];
}
