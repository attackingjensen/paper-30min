import type { Citation } from "./citations.js";
import type { DocumentRecord } from "./contracts.js";

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
  text: string;
  vendorIds: number[];
  citation: Citation;
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
