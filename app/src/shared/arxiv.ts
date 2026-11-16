// arxiv-import 共享契约（SPEC-arxiv-import.md Code Style）。
// 纯类型，不得导入 Node 或 React 模块。

export interface ArxivReference {
  baseId: string;
  version: number | null;
  canonicalId: string;
}

export interface PdfFallbackRequest {
  kind: "arxiv-pdf";
  baseId: string;
  version: number;
  absUrl: string;
  pdfUrl: string;
  reasonCode: string;
  baseRevision: string | null;
}

export interface ImportDiagnostic {
  code: string;
  severity: "warning" | "fatal";
  stage: "resolve" | "fetch" | "snapshot" | "convert" | "validate" | "publish";
  messageKey: string;
  sourceAlias?: string;
  sourceUrl?: string;
}
