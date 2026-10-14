import type { CitationInput } from "./citations.js";

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
  materials: DocumentRecord[];
  map: string | null;
  explanations: string[];
  translations: Record<string, string>;
}

export interface FileEntry {
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
  sha256: string;
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
  | { type: "addMaterial"; root: string; source: string }
  | { type: "move"; root: string; path: string; destination: string }
  | { type: "relink"; root: string; id: string; source: string }
  | { type: "trash"; root: string; id: string }
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
  | { type: "createCitation"; root: string; path: string; input: CitationInput }
  | { type: "resolveCitation"; root: string; link: string }
  | { type: "saveWorkspace"; root: string; tabs: DocumentTab[]; active: string }
  | {
      type: "savePdfPosition";
      root: string;
      path: string;
      position: PdfPosition;
    }
  | { type: "resolveFile"; root: string; path: string };

export interface Desktop {
  agent<T>(command: AgentCommand): Promise<T>;
  watchAgent(listener: (state: ChatSession) => void): () => void;
  invoke<T>(command: Command): Promise<T>;
  choose(kind: "pdf" | "folder" | "material"): Promise<string | null>;
  watchProject(root: string, listener: (error?: string) => void): () => void;
  openLink(url: string): Promise<void>;
  openFile(root: string, path: string): Promise<void>;
}

export type AgentApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
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
export interface AgentServiceSettings {
  id: string;
  name: string;
  api: AgentApi;
  baseUrl: string;
  hasKey: boolean;
  keyError?: boolean;
}
export interface AgentModelSettings {
  id: string;
  serviceId: string;
  name: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  availableThinking: ThinkingLevel[];
  thinking: ThinkingLevel;
}
export interface AgentSettings {
  services: AgentServiceSettings[];
  models: AgentModelSettings[];
  selectedModelId: string;
  proxy: "direct" | "environment" | "custom";
  proxyUrl: string;
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
}
export type AgentCommand =
  | { type: "settings" }
  | {
      type: "saveSettings";
      settings: AgentSettings;
      apiKeys?: Record<string, string>;
      clearKeyIds?: string[];
      apiKey?: string;
      clearKey?: boolean;
    }
  | { type: "selectModel"; modelId: string; thinking?: ThinkingLevel }
  | { type: "list"; root: string }
  | { type: "create"; root: string }
  | { type: "open"; root: string; id: string }
  | { type: "branch"; root: string; id: string; messageId: string }
  | { type: "send"; root: string; id: string; text: string }
  | { type: "stop"; root: string; id: string };
