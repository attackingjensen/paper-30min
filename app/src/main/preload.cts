import { contextBridge, ipcRenderer } from "electron";
import type { Command, Desktop } from "../shared/contracts.js";

const desktop: Desktop = {
  invoke: <T,>(command: Command) =>
    ipcRenderer.invoke("project:command", command) as Promise<T>,
  watchProject: (root, listener) => {
    const changed = (
      _event: Electron.IpcRendererEvent,
      changedRoot: string,
      error?: string,
    ) => {
      if (changedRoot === root) listener(error);
    };
    ipcRenderer.on("project:changed", changed);
    void ipcRenderer
      .invoke("project:watch", root)
      .catch((error) => listener(error.message));
    return () => {
      ipcRenderer.removeListener("project:changed", changed);
      void ipcRenderer.invoke("project:watch", null).catch(() => {});
    };
  },
  openLink: (url) => ipcRenderer.invoke("project:openLink", url),
  choose: (kind) => ipcRenderer.invoke("project:choose", kind),
  openFile: (root, path) => ipcRenderer.invoke("project:openFile", root, path),
};
contextBridge.exposeInMainWorld("desktop", desktop);
