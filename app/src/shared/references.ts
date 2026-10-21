import type { PdfTextAnnoObject } from "@embedpdf/models";
import type { CitationPage } from "./citations.js";
import type { DocumentRecord } from "./contracts.js";

export interface ReferenceRequest {
  link: string;
  /** Empty denotes a chat link relative to the project root. */
  sourceDocument?: string;
}

export interface ResolvedReference {
  kind: "citation" | "annotation";
  status: "available";
  path: string;
  documentId: string;
  sha256: string;
  pages: CitationPage[];
  excerpt: string | null;
  excerptSource: "selection" | null;
  comment: string | null;
  annotation?: { id: string; type: string };
  block?: { id: string; label: string };
  manuscript: {
    status: "matched" | "multiple" | "ambiguous" | "unmatched";
    locations: { blockId: string; link: string; path: string; linkLine: number; startLine: number; endLine: number }[];
    reason?: string;
  };
  discussions: {
    rootId: string | null;
    status: "complete" | "missing-parent" | "cycle";
    blockIds: string[];
    entries: { id: string; parentId?: string; replyType?: number; type: string; comment: string | null; author?: string; target: boolean }[];
  }[];
  warnings: string[];
}

export interface AnnotationWrite {
  root: string;
  path: string;
  sha256: string;
  document?: DocumentRecord;
  annotation: PdfTextAnnoObject;
}

/** null means the PDF is not open in the reader. Errors must never fall back. */
export type AnnotationWriter = (request: AnnotationWrite, signal?: AbortSignal) => Promise<{ sha256: string } | null>;
