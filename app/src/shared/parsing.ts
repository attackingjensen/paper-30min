import type { DocumentRecord } from "./contracts.js";
import type { ImportDiagnostic } from "./arxiv.js";

export const defaultParsingSettings = {
  endpoint: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
  model: "PaddleOCR-VL-1.6",
  hasKey: false,
};
export interface ParsingSettings {
  endpoint: string;
  model: string;
  hasKey: boolean;
  keyError?: boolean;
}
export type ParsingPhase =
  | "preparing"
  | "submitting"
  | "unknown"
  | "querying"
  | "downloading"
  | "mapping"
  | "stopped"
  | "failed"
  | "remote-failed"
  | "candidate";
export interface ParsingRun {
  formatVersion: 1;
  batchId: string;
  projectId: string;
  document: DocumentRecord;
  endpoint: string;
  model: string;
  phase: ParsingPhase;
  jobId?: string;
  rawSha256?: string;
  candidate?: string;
  mappingSha256?: string;
  markdownSha256?: string;
  completedPages: number;
  pageCount: number;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  error?: string;
  busy?: boolean;
  stopping?: boolean;
}
export interface ParsedBlock {
  id: string;
  label: string;
  text: string; // Original parser excerpt; the editable Markdown remains authoritative.
  vendorIds: number[];
  images: string[];
  limitation: string;
}
export interface ParsingMapping {
  formatVersion: 1;
  projectId: string;
  batchId: string;
  document: DocumentRecord;
  rawSha256: string;
  blocks: ParsedBlock[];
  images: {
    path: string;
    sha256: string;
    page: number;
    vendorPath?: string;
    blockId?: string;
  }[];
}
export type ParsingCommand =
  | { type: "settings" }
  | {
      type: "saveSettings";
      settings: ParsingSettings;
      apiKey?: string;
      clearKey?: boolean;
    }
  | { type: "status"; root: string }
  | { type: "verify"; root: string; batchId: string }
  | { type: "delete"; root: string; batchId: string }
  | { type: "start"; root: string; documentId: string }
  | { type: "resume"; root: string; batchId: string; jobId?: string }
  | { type: "stop"; root: string; batchId: string };

/** Phase 3 PDF 云端任务：仅含恢复所需的非密事实，不保存 Token、代理或签名 URL。 */
export type PdfParseTaskPhase =
  | "preparing"
  | "submitting"
  | "unknown"
  | "querying"
  | "downloading"
  | "downloaded"
  | "converting"
  | "stopped"
  | "failed"
  | "remote-failed"
  | "candidate-complete";

export interface BaiduPdfParseOptions {
  useDocOrientationClassify: boolean;
  useDocUnwarping: boolean;
  useChartRecognition: boolean;
}

export interface PdfParseTaskRecord {
  formatVersion: 1;
  parseBatchId: string;
  projectId: string;
  paperId: string;
  parentSourceSnapshotId: string;
  pdfSha256: string;
  provider: "baidu-aistudio";
  model: "PaddleOCR-VL-1.6";
  endpoint: string;
  options: BaiduPdfParseOptions;
  phase: PdfParseTaskPhase;
  jobId?: string;
  /** 仅记录内存中下载响应的摘要；含密原始响应不写入任务目录。 */
  responseSha256?: string;
  /** 已发布解析快照与去敏后 result.jsonl 摘要；恢复据此跳过重复下载。 */
  parseSourceSnapshotId?: string;
  sanitizedSha256?: string;
  diagnostic?: ImportDiagnostic;
  createdAt: string;
  updatedAt: string;
}

export interface BaiduUploadConfirmationRequest {
  sourceSnapshotId: string;
  originalName: string;
  pdfSha256: string;
  pageCount: number;
  provider: "baidu-aistudio";
  model: "PaddleOCR-VL-1.6";
  endpoint: string;
  options: BaiduPdfParseOptions;
}

/** facts.json：规范化 vendor 页／块／几何与资产来源事实，不含 Paper30Min 节点身份。 */
export interface PdfParseAssetFact {
  vendorPath: string;
  path: string;
  sha256: string;
  size: number;
  mime: string;
}

export interface PdfParseBlockFact {
  blockId: number;
  label: string;
  order: number | null;
  groupId: number | null;
  bbox: [number, number, number, number] | null;
}

export interface PdfParsePageFact {
  page: number;
  width: number;
  height: number;
  modelSettings: Record<string, boolean | string[]>;
  blocks: PdfParseBlockFact[];
  assets: PdfParseAssetFact[];
}

export interface PdfParseFactsFile {
  formatVersion: 1;
  pageCount: number;
  pages: PdfParsePageFact[];
}
