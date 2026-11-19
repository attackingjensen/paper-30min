import type {
  BaiduPdfParseOptions,
  BaiduUploadConfirmationRequest,
  ParsingCommand,
  PdfParseTaskRecord,
} from "./parsing.js";
import type { ArxivReference, ImportDiagnostic, PdfFallbackRequest } from "./arxiv.js";

import type { ChatAttachment } from "./chat-input.js";
import type { DocumentTree } from "./document/tree.js";
import type { DocumentMergeResult } from "./document/merge.js";
import type { VerificationActorInput } from "./verification.js";

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
  /** arXiv 首次导入进度（SPEC §6）；其他来源可为空。 */
  arxiv?: ArxivImportProgress;
}

/** 首次导入恢复记录：目标版本、已完成快照、诊断与下一可行动作；不记录凭据。 */
export interface ArxivImportProgress {
  reference: ArxivReference;
  stage: "resolve" | "snapshot" | "convert";
  sourceSnapshotId?: string;
  /** 转换已构建候选但 current 未推进时持久化：恢复沿用同一 revisionId 幂等完成提交。 */
  candidateRevisionId?: string;
  /** 候选构建时的转换警告；随恢复记录持久化，重开可继续呈现。 */
  convertWarnings?: ImportDiagnostic[];
  diagnostic?: ImportDiagnostic;
  nextAction: "fetch-snapshot" | "convert" | "pdf-fallback";
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

interface PdfSourceFacts {
  kind: "pdf";
  sha256: string;
  pageCount: number;
  originalName: string;
  arxiv?: { baseId: string; version: number; pdfUrl: string };
}

export type PdfSourceSnapshotRecord = SourceSnapshotRecord & PdfSourceFacts;

/** 不可变解析快照的被接受来源事实（SPEC-pdf-import 快照契约）；不含签名 URL 或凭据。 */
interface PdfParseSourceFacts {
  kind: "pdf-parse";
  parentSourceSnapshotId: string;
  parseBatchId: string;
  provider: "baidu-aistudio";
  model: "PaddleOCR-VL-1.6";
  jobId: string;
  options: BaiduPdfParseOptions;
  pageCount: number;
  /** 下载前原始响应摘要；原始字节本身不持久化。 */
  responseSha256: string;
  /** 去敏并本地化后 result.jsonl 的摘要。 */
  sanitizedSha256: string;
  sanitization: { replaced: number; missing: number; dropped: number };
  diagnostics: ImportDiagnostic[];
}

export type PdfParseSourceSnapshotRecord = SourceSnapshotRecord & PdfParseSourceFacts;

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

export type ManagedFileContent = Uint8Array | { bytes: Uint8Array; mime?: string };

export type CoreCommand =
  | { type: "coreCreate"; parent: string; name: string }
  | { type: "coreOpen"; root: string }
  | {
      type: "corePublishSource";
      root: string;
      files: Record<string, ManagedFileContent>;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "coreCommit";
      root: string;
      baseRevision: string | null;
      sourceSnapshotId: string;
      revisionId?: string;
      files: Record<string, ManagedFileContent>;
      metadata?: Record<string, unknown>;
    }
  | { type: "coreReadSource"; root: string; sourceSnapshotId: string }
  | { type: "coreReadRevision"; root: string; revisionId: string }
  | {
      type: "coreReadDocument";
      root: string;
      revisionId: string;
      tree: "document" | "source-base";
    }
  | {
      type: "coreMergePublish";
      root: string;
      baseRevision: string;
      sourceSnapshotId: string;
      candidate: DocumentTree;
      resolutions?: Array<{
        conflictId: string;
        choice: "current" | "candidate";
      }>;
    }
  | { type: "corePdfSnapshot"; root: string; source: string }
  | { type: "corePdfTasks"; root: string }
  | { type: "corePdfStop"; root: string; parseBatchId: string }
  | {
      type: "corePdfReconvert";
      root: string;
      parseBatchId: string;
      baseRevision: string;
    }
  | {
      type: "corePdfPublishCandidate";
      root: string;
      parseBatchId: string;
      /** 发布前复核的基线；重解析任务必须等于任务记录的 baseRevision。 */
      baseRevision: string;
      resolutions?: Array<{ conflictId: string; choice: "current" | "candidate" }>;
    }
  | {
      type: "corePdfImport";
      root: string;
      sourceSnapshotId: string;
      /** 调用方生成的操作身份：上传确认据此定位；停止通过 root 与 parseBatchId 定位。 */
      operationId: string;
    }
  | {
      type: "corePdfResume";
      root: string;
      parseBatchId: string;
      operationId: string;
      jobId?: string;
    }
  | {
      type: "corePdfReparse";
      root: string;
      sourceSnapshotId: string;
      baseRevision: string;
      operationId: string;
    }
  | {
      type: "corePdfResumeReparse";
      root: string;
      parseBatchId: string;
      operationId: string;
      jobId?: string;
    }
  | {
      type: "corePdfVerify";
      root: string;
      expectedRevisionId: string;
      anchor: unknown;
      actor: VerificationActorInput;
    }
  | { type: "corePdfReadVerification"; root: string; revisionId: string }
  | {
      type: "coreArxivImport";
      parent: string;
      name: string;
      input: string;
      /** 调用方生成的操作身份：coreArxivCancel 据此取消进行中的导入。 */
      operationId: string;
      /** 受控端点基址（spec Commands）：生产省略即 https://arxiv.org；
       * 回环基址仅在主进程测试环境显式允许时才生效，生产无法访问本机服务。 */
      baseUrl?: string;
    }
  | { type: "coreArxivResume"; root: string; operationId: string; baseUrl?: string }
  | { type: "coreArxivCancel"; operationId: string }
  | {
      type: "coreArxivPdfFallback";
      root: string;
      reason: ImportDiagnostic;
      baseUrl?: string;
      /** 更新场景必须携带调用方读取时的 current；首次导入省略或 null。 */
      baseRevision?: string | null;
    }
  | {
      type: "coreArxivPdfFallbackImport";
      root: string;
      /** prepareArxivPdfFallback 产出的固定版本交接；主进程重新核验 baseRevision。 */
      request: PdfFallbackRequest;
      /** 调用方生成的操作身份：上传确认与取消据此定位。 */
      operationId: string;
      /** 受控端点基址（同 coreArxivImport）：生产省略即 https://arxiv.org。 */
      baseUrl?: string;
    };

/** arXiv 组合入口经生产 IPC 的结果（SPEC-arxiv-import §6–7）。 */
export type ArxivImportCommandResult =
  | {
      ok: true;
      root: string;
      reference: ArxivReference;
      revision: ProjectRevisionRecord;
      warnings: ImportDiagnostic[];
    }
  | { ok: false; root: string; diagnostic: ImportDiagnostic };

export type ArxivPdfFallbackCommandResult =
  | { ok: true; request: PdfFallbackRequest }
  | { ok: false; diagnostic: ImportDiagnostic };

/** 主进程注入的本机解析配置：Token 与代理只存在于进程内存，不经 renderer。
 * custom 代理必须携带 proxyUrl；direct／environment 不接受 proxyUrl。 */
export type PdfImportMachineConfig = {
  endpoint: string;
  model: "PaddleOCR-VL-1.6";
  apiKey: string;
} & (
  | { proxy?: "direct" | "environment"; proxyUrl?: never }
  | { proxy: "custom"; proxyUrl: string }
);

/** worker 命令包装：与 agent／parsing 先例一致，config 由主进程附加。 */
export type PdfImportWorkerCommand = {
  type: "pdfImport";
  command: Extract<
    CoreCommand,
    | { type: "corePdfImport" }
    | { type: "corePdfResume" }
    | { type: "corePdfReparse" }
    | { type: "corePdfResumeReparse" }
    | { type: "coreArxivPdfFallbackImport" }
  >;
  config: PdfImportMachineConfig;
};

/** 经生产 IPC 的候选摘要：树、changeset 与冲突可序列化；资产字节留在工程进程。 */
type PdfMergeCandidateSummary = DocumentMergeResult & {
  root: string;
  sourceSnapshotId: string;
};

/** PDF 首次导入／恢复经生产 IPC 的结果；诊断只含 code 与 messageKey，不含凭据或原始响应。 */
export type PdfImportCommandResult =
  | { outcome: "cancelled" }
  | { outcome: "incomplete"; task: PdfParseTaskRecord; diagnostic: ImportDiagnostic }
  | { outcome: "stopped"; task: PdfParseTaskRecord }
  | {
      outcome: "published";
      task: PdfParseTaskRecord;
      revision: ProjectRevisionRecord;
      warnings: ImportDiagnostic[];
    };

/** 重解析／更新／离线重转换经生产 IPC 的候选结果；不携带资产字节。 */
export type PdfReparseCommandResult =
  | { outcome: "cancelled" }
  | { outcome: "incomplete"; task: PdfParseTaskRecord; diagnostic: ImportDiagnostic }
  | { outcome: "stopped"; task: PdfParseTaskRecord }
  | {
      outcome: "candidate";
      task: PdfParseTaskRecord;
      candidate: PdfMergeCandidateSummary;
      warnings: ImportDiagnostic[];
    };

/** arXiv PDF 回退组合交接经生产 IPC 的结果；下载失败发生在云端任务创建前。 */
export type ArxivPdfFallbackImportCommandResult =
  | { outcome: "snapshot-failed"; diagnostic: ImportDiagnostic }
  | PdfImportCommandResult
  | PdfReparseCommandResult;

/** 上传确认请求：worker → 主进程 → renderer 显式确认 → 原路返回。
 * confirmationId 为每次确认往返的独立随机身份；应答须同时匹配 operationId 与
 * confirmationId，旧确认的迟到应答不得命中同 ID 的新操作。 */
export interface PdfUploadConfirmation {
  operationId: string;
  confirmationId: string;
  request: BaiduUploadConfirmationRequest;
}

/** 上传确认应答：renderer 显式确认或拒绝；只有 confirmed === true 才发起上传。 */
export interface PdfUploadConfirmationReply {
  operationId: string;
  confirmationId: string;
  confirmed: boolean;
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
  | { type: "resolveFile"; root: string; path: string }
  | CoreCommand;

export interface Desktop {
  parsing<T>(command: ParsingCommand): Promise<T>;
  agent<T>(command: AgentCommand): Promise<T>;
  watchAgent(listener: (state: ChatSession) => void): () => void;
  invoke<T>(command: Command): Promise<T>;
  choose(kind: "pdf" | "folder"): Promise<string | null>;
  watchProject(root: string, listener: (error?: string) => void): () => void;
  openLink(url: string): Promise<void>;
  openFile(root: string, path: string): Promise<void>;
  /** 订阅 worker 发起的上传确认请求；返回取消订阅函数。 */
  watchPdfUploadConfirm(listener: (confirmation: PdfUploadConfirmation) => void): () => void;
  /** renderer 显式确认或拒绝上传；未应答前 worker 不发起 POST。 */
  replyPdfUploadConfirm(reply: PdfUploadConfirmationReply): Promise<void>;
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
