import type { ParsingCommand } from "./parsing.js";
import type { ChatAttachment } from "./chat-input.js";

export interface DocumentRecord {
  id: string;
  path: string;
  sha256: string;
}

export interface Manifest {
  formatVersion: 1;
  id: string;
  name: string;
  paper: DocumentRecord;
}

export interface ProjectManifest {
  formatVersion: 2;
  id: string;
  name: string;
  paper: {
    id: string;
    currentRevision: string | null;
  };
}

export interface ProjectImportRecord {
  formatVersion: 1;
  id: string;
  projectId: string;
  paperId: string;
}

export interface ManagedFileRecord {
  path: string;
  sha256: string;
  size: number;
  mime?: string;
}

export type SourceSnapshotRecord = Record<string, unknown> & {
  formatVersion: 1;
  sourceSnapshotId: string;
  projectId: string;
  paperId: string;
  path: string;
  files: ManagedFileRecord[];
  createdAt: string;
};

export type ProjectRevisionRecord = Record<string, unknown> & {
  formatVersion: 1;
  revisionId: string;
  projectId: string;
  paperId: string;
  sourceSnapshotId: string;
  baseRevision: string | null;
  path: string;
  files: ManagedFileRecord[];
  committedAt: string;
};

export interface ProjectCoreSnapshot {
  root: string;
  manifest: ProjectManifest;
  importRecord: ProjectImportRecord | null;
  currentRevision: ProjectRevisionRecord | null;
}

interface FileEntry {
  path: string;
  directory: boolean;
}
export interface Project {
  root: string;
  manifest: Manifest;
  files: FileEntry[];
  missing: string[];
  reading: ReadingState;
}
export interface DocumentTab {
  key: string;
  title: string;
  path?: string;
  markdown?: {
    mode: "read" | "edit" | "split";
    scroll: number;
    readScroll?: number;
    cursor: number;
  };
}
export interface MarkdownFile {
  text: string;
  version: string;
}
export type MarkdownSave =
  | { saved: true; file: MarkdownFile }
  | { saved: false; file: MarkdownFile | null };
export interface ProjectAsset {
  bytes: Uint8Array;
  mime: string;
}
export interface PdfPosition {
  page: number;
  x: number;
  y: number;
  zoom: number;
  scrollStrategy?: "vertical" | "horizontal";
  spreadMode?: "none" | "odd" | "even";
  rotation?: 0 | 1 | 2 | 3;
}
export interface ReadingState {
  tabs: DocumentTab[];
  active: string;
  pdf: Record<string, PdfPosition>;
}
export interface PdfSource {
  bytes: Uint8Array;
  sha256: string;
  /** Registered identity captured in the same project operation as the bytes. */
  document?: DocumentRecord;
}
export interface Preferences {
  defaultFolder: string | null;
  recent: { root: string; name: string }[];
}
export interface CreateInput {
  source: string;
  parent: string;
  name: string;
  makeDefault: boolean;
  operationId: string;
}
export type Command =
  | { type: "preferences" }
  | { type: "setDefault"; folder: string | null }
  | { type: "create"; input: CreateInput }
  | { type: "cancelCreate"; operationId: string }
  | { type: "open"; root: string }
  | { type: "refresh"; root: string }
  | { type: "move"; root: string; path: string; destination: string }
  | { type: "read"; root: string; path: string }
  | { type: "readMarkdown"; root: string; path: string }
  | {
      type: "saveMarkdown";
      root: string;
      path: string;
      text: string;
      version: string;
    }
  | { type: "createNote"; root: string; name: string }
  | { type: "readAsset"; root: string; path: string }
  | { type: "readPdf"; root: string; path: string }
  | { type: "saveWorkspace"; root: string; tabs: DocumentTab[]; active: string }
  | {
      type: "savePdfPosition";
      root: string;
      path: string;
      position: PdfPosition;
    }
  | { type: "resolveFile"; root: string; path: string };

export interface Desktop {
  parsing<T>(command: ParsingCommand): Promise<T>;
  agent<T>(command: AgentCommand): Promise<T>;
  watchAgent(listener: (state: ChatSession) => void): () => void;
  invoke<T>(command: Command): Promise<T>;
  choose(kind: "pdf" | "folder"): Promise<string | null>;
  watchProject(root: string, listener: (error?: string) => void): () => void;
  openLink(url: string): Promise<void>;
  openFile(root: string, path: string): Promise<void>;
}

export type AgentApi =
  "openai-completions" | "openai-responses" | "anthropic-messages";
export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const thinkingLevels: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
interface AgentServiceSettings {
  id: string;
  name: string;
  api: AgentApi;
  baseUrl: string;
  hasKey: boolean;
  keyError?: boolean;
}
interface AgentModelSettings {
  id: string;
  serviceId: string;
  name: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  availableThinking: ThinkingLevel[];
  thinking: ThinkingLevel;
  vision?: boolean;
}
export interface AgentSettings {
  services: AgentServiceSettings[];
  models: AgentModelSettings[];
  selectedModelId: string;
  proxy: "direct" | "environment" | "custom";
  proxyUrl: string;
  search?: { hasKey: boolean; keyError?: boolean };
}
export const defaultAgentSettings: AgentSettings = {
  services: [
    {
      id: "default",
      name: "默认服务",
      api: "openai-completions",
      baseUrl: "",
      hasKey: false,
    },
  ],
  models: [
    {
      id: "default",
      serviceId: "default",
      name: "",
      model: "",
      contextWindow: 128000,
      maxTokens: 4096,
      availableThinking: ["off"],
      thinking: "off",
    },
  ],
  selectedModelId: "default",
  proxy: "direct",
  proxyUrl: "",
};
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  status?: "error" | "aborted";
  tools?: ChatTool[];
}
export interface ChatTool {
  id: string;
  name: string;
  arguments: unknown;
  status: "running" | "done" | "error" | "aborted";
  output: string;
  details?: unknown;
}
export interface ChatSession {
  root: string;
  id: string;
  title: string;
  messages: ChatMessage[];
  busy: boolean;
  stopping: boolean;
  queued: string[];
  error?: string;
  revision: number;
  compacting?: boolean;
}
export type AgentCommand =
  | { type: "settings" }
  | { type: "listSkills" }
  | { type: "saveSkill"; id: string; content: string; version: string }
  | {
      type: "saveSettings";
      settings: AgentSettings;
      apiKeys?: Record<string, string>;
      clearKeyIds?: string[];
      apiKey?: string;
      clearKey?: boolean;
      exaApiKey?: string;
      clearExaKey?: boolean;
    }
  | { type: "selectModel"; modelId: string; thinking?: ThinkingLevel }
  | { type: "list"; root: string }
  | { type: "materials"; root: string }
  | { type: "create"; root: string }
  | { type: "open"; root: string; id: string }
  | { type: "branch"; root: string; id: string; messageId: string }
  | {
      type: "send";
      root: string;
      id: string;
      text: string;
      attachments?: ChatAttachment[];
    }
  | { type: "stop"; root: string; id: string };
