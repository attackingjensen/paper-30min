import { contextBridge, ipcRenderer } from "electron";
import type { Command, Desktop } from "../shared/contracts.js";

const desktop: Desktop = {
  invoke: <T,>(command: Command) =>
    ipcRenderer.invoke("project:command", command) as Promise<T>,
  choose: (kind) => ipcRenderer.invoke("project:choose", kind),
  openFile: (root, path) => ipcRenderer.invoke("project:openFile", root, path),
};
contextBridge.exposeInMainWorld("desktop", desktop);
