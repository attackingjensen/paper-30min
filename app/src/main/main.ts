import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  utilityProcess,
} from "electron";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command, Project, ProjectAsset } from "../shared/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "paper30min",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const profile = process.env.PAPER30MIN_PROFILE;
if (profile) app.setPath("userData", path.resolve(profile));
let window: BrowserWindow;
let worker: Electron.UtilityProcess;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
function request(command: Command | null): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker?.pid) {
      reject(new Error("工程进程不可用，请重启应用。"));
      return;
    }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage(command ? { id, command } : { id, shutdown: true });
  });
}

async function start() {
  await app.whenReady();
  protocol.handle("paper30min", async (incoming) => {
    const url = new URL(incoming.url);
    if (url.hostname === "project") {
      try {
        const asset = (await request({
          type: "readAsset",
          root: url.searchParams.get("root") ?? "",
          path: url.searchParams.get("path") ?? "",
        })) as ProjectAsset;
        return new Response(new Uint8Array(asset.bytes).buffer, {
          headers: {
            "Content-Type": asset.mime,
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'",
            "Cache-Control": "no-store",
          },
        });
      } catch {
        return new Response("Image unavailable", { status: 404 });
      }
    }
    const base = path.resolve(here, "../renderer");
    const file = path.resolve(base, "." + decodeURIComponent(url.pathname));
    if (url.hostname !== "app" || !file.startsWith(base + path.sep))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  Menu.setApplicationMenu(null);
  worker = utilityProcess.fork(
    path.join(here, "worker.js"),
    [path.join(app.getPath("userData"), "preferences.json")],
    { serviceName: "Paper30Min Project" },
  );
  worker.on("message", async (message) => {
    if (message.trash) {
      try {
        await shell.trashItem(message.trash.file);
        worker.postMessage({ id: message.trash.id, trashResult: true });
      } catch (error) {
        worker.postMessage({
          id: message.trash.id,
          trashResult: true,
          error: (error as Error).message,
        });
      }
      return;
    }
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) p?.reject(new Error(message.error));
    else p?.resolve(message.value);
  });
  worker.on("exit", () => {
    for (const p of pending.values())
      p.reject(new Error("工程进程已退出，请重启应用。"));
    pending.clear();
  });

  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("无效的窗口请求。");
  };
  let watcher: FSWatcher | undefined;
  let watchGeneration = 0;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  const stopWatching = () => {
    watcher?.close();
    watcher = undefined;
    clearTimeout(watchTimer);
  };
  ipcMain.handle("project:watch", async (event, root: string | null) => {
    trusted(event);
    const generation = ++watchGeneration;
    stopWatching();
    if (!root) return;
    const project = (await request({ type: "refresh", root })) as Project;
    if (generation !== watchGeneration) return;
    watcher = watch(project.root, { recursive: true }, (_event, filename) => {
      if (
        filename &&
        filename
          .toString()
          .split(/[\\/]/)
          .some((part) => part.startsWith(".") || part === "node_modules")
      )
        return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (!window.isDestroyed())
          window.webContents.send("project:changed", root);
      }, 120);
    });
    window.webContents.send("project:changed", root);
    watcher.on("error", (error) => {
      if (!window.isDestroyed())
        window.webContents.send(
          "project:changed",
          root,
          "文件监听失败：" + error.message,
        );
    });
  });
  ipcMain.handle("project:openLink", async (event, url: string) => {
    trusted(event);
    if (!/^https?:\/\//i.test(url))
      throw new Error("仅支持打开 HTTP/HTTPS 链接。");
    await shell.openExternal(url);
  });
  ipcMain.handle("project:command", (event, command: Command) => {
    trusted(event);
    return request(command);
  });
  ipcMain.handle("project:choose", async (event, kind: string) => {
    trusted(event);
    if (!["folder", "pdf", "material"].includes(kind))
      throw new Error("无效的选择类型。");
    const result = await dialog.showOpenDialog(window, {
      properties: kind === "folder" ? ["openDirectory"] : ["openFile"],
      filters:
        kind === "pdf" ? [{ name: "PDF", extensions: ["pdf"] }] : undefined,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(
    "project:openFile",
    async (event, root: string, relative: string) => {
      trusted(event);
      const file = (await request({
        type: "resolveFile",
        root,
        path: relative,
      })) as string;
      if (/\.(exe|com|bat|cmd|ps1|msi|vbs|js|lnk|url|scr)$/i.test(file)) {
        const choice = await dialog.showMessageBox(window, {
          type: "warning",
          message: "此文件可能执行程序，是否继续打开？",
          detail: file,
          buttons: ["取消", "打开"],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response !== 1) return;
      }
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },
  );

  function createWindow() {
    window = new BrowserWindow({
      title: "Paper30Min",
      width: 1440,
      height: 960,
      minWidth: 560,
      minHeight: 500,
      backgroundColor: "#f0f0f2",
      webPreferences: {
        preload: path.join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on("will-prevent-unload", (event) => {
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning",
        message: "有未保存的文档，确定放弃编辑并关闭吗？",
        buttons: ["继续编辑", "放弃并关闭"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice === 1) event.preventDefault();
    });
    window.on("closed", () => {
      ++watchGeneration;
      stopWatching();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    const devUrl = process.env.PAPER30MIN_DEV_URL;
    const appUrl = devUrl ?? "paper30min://app/index.html";
    // The native Viewer copies selections through the browser clipboard API.
    const canWriteClipboard = (
      contents: Electron.WebContents | null,
      permission: string,
      url: string,
    ) =>
      contents === window.webContents &&
      permission === "clipboard-sanitized-write" &&
      url === appUrl;
    window.webContents.session.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          canWriteClipboard(contents, permission, details.requestingUrl),
        ),
    );
    window.webContents.session.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        canWriteClipboard(contents, permission, details.requestingUrl ?? ""),
    );
    if (devUrl) void window.loadURL(devUrl);
    else void window.loadURL("paper30min://app/index.html");
  }
  await new Promise<void>((resolve) => worker.once("spawn", resolve));
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let shuttingDown = false;
  app.on("will-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void request(null)
      .catch((error) => console.error(error))
      .finally(() => {
        worker.kill();
        app.quit();
      });
  });
}

void start().catch((error) => {
  console.error(error);
  app.quit();
});
