import type { PdfTextAnnoObject } from "@embedpdf/models";
import type { CitationPage } from "./citations.js";

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
  excerptSource: "selection" | "parser" | null;
  comment: string | null;
  annotation?: { id: string; type: string };
  block?: { id: string; label: string };
}

export interface AnnotationWrite {
  root: string;
  path: string;
  sha256: string;
  annotation: PdfTextAnnoObject;
}

/** null means the PDF is not open in the reader. Errors must never fall back. */
export type AnnotationWriter = (request: AnnotationWrite, signal?: AbortSignal) => Promise<{ sha256: string } | null>;
