import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentCommand,
  ChatSession,
  Command,
  Desktop,
} from "../shared/contracts.js";
import type { ParsingCommand } from "../shared/parsing.js";
import type { AnnotationWrite } from "../shared/references.js";

let annotationWriter: Parameters<Desktop["handleAnnotationWrite"]>[0] | undefined;
const annotationWrites = new Map<number, AbortController>();
ipcRenderer.on("pdf:annotation-cancel", (_event, id: number) => annotationWrites.get(id)?.abort());
ipcRenderer.on("pdf:annotation-write", async (_event, id: number, request: AnnotationWrite) => {
  const controller = new AbortController();
  annotationWrites.set(id, controller);
  try {
    const value = await annotationWriter?.(request, () => controller.signal.throwIfAborted()) ?? null;
    ipcRenderer.send("pdf:annotation-result", { id, value });
  } catch (error) {
    ipcRenderer.send("pdf:annotation-result", { id, error: (error as Error).message });
  } finally { annotationWrites.delete(id); }
});

const desktop: Desktop = {
  handleAnnotationWrite: (writer) => {
    annotationWriter = writer;
    return () => { if (annotationWriter === writer) annotationWriter = undefined; };
  },
  parsing: <T,>(command: ParsingCommand) =>
    ipcRenderer.invoke("parsing:command", command) as Promise<T>,
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
