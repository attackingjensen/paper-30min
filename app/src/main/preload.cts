import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentCommand,
  ChatSession,
  Command,
  Desktop,
} from "../shared/contracts.js";

const desktop: Desktop = {
  agent: <T,>(command: AgentCommand) =>
    ipcRenderer.invoke("agent:command", command) as Promise<T>,
  watchAgent: (listener) => {
    const changed = (_event: Electron.IpcRendererEvent, state: ChatSession) =>
      listener(state);
    ipcRenderer.on("agent:changed", changed);
    return () => ipcRenderer.removeListener("agent:changed", changed);
  },
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
