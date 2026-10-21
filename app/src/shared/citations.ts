/** EmbedPDF page space: unrotated, top-left origin, PDF points; pages are 1-based. */
export interface CitationRect {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}
export interface CitationPage {
  page: number;
  width: number;
  height: number;
  rects: CitationRect[];
}
export interface CitationInput {
  sha256: string;
  kind: "text" | "region" | "page";
  pages: CitationPage[];
  text: string;
}
export interface Citation extends Omit<CitationInput, "sha256"> {
  id: string;
  documentId: string;
}
export interface ResolvedCitation {
  citation: Citation;
  path: string;
}
export interface CitationUse {
  id: string;
  path: string;
  title: string;
  context: string;
  line: number;
  occurrence: number;
  version: string;
}
export interface UsedCitation {
  citation: Citation;
  uses: CitationUse[];
}
export interface CitationDictionary {
  formatVersion: 1;
  projectId: string;
  citations: Record<string, Citation>;
}
export function citationId(link: string): string {
  const match = /^paper:\/\/cite\/([a-f0-9]{32})$/.exec(link);
  if (!match) throw new Error("引用链接格式无效。");
  return match[1];
}
export function citationLink(id: string): string {
  return `paper://cite/${id}`;
}
export function citationMarkdown(citation: Citation): string {
  const text = Array.from(citation.text.trim().replace(/\s+/g, " "));
  const label = (text.length
    ? text.slice(0, 25).join("") + (text.length > 25 ? "…" : "")
    : `PDF 第 ${citation.pages.map((p) => p.page).join("、")} 页`)
    .replace(/[\\`*{}\[\]()<>!_~&$]/g, "\\$&");
  return `[${label}](${citationLink(citation.id)})`;
}
export function validateCitation(input: Omit<CitationInput, "sha256">): void {
  if (!input ||
      !["text", "region", "page"].includes(input.kind) ||
      typeof input.text !== "string" || input.text.length > 100000 ||
      !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 1000)
    throw new Error("引用数据无效。");
  let previous = 0;
  for (const p of input.pages) {
    if (!p || !Number.isSafeInteger(p.page) || p.page <= previous ||
        !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0 ||
        !Array.isArray(p.rects) || p.rects.length > 10000 ||
        (input.kind === "page" ? p.rects.length !== 0 : p.rects.length === 0))
      throw new Error("引用页码或区域无效。");
    previous = p.page;
    for (const r of p.rects) {
      if (!r?.origin || !r.size ||
          ![r.origin.x, r.origin.y, r.size.width, r.size.height].every(Number.isFinite) ||
          r.origin.x < 0 || r.origin.y < 0 || r.size.width <= 0 || r.size.height <= 0 ||
          r.origin.x + r.size.width > p.width + 0.01 || r.origin.y + r.size.height > p.height + 0.01)
        throw new Error("引用区域超出 PDF 页面。");
    }
  }
}

export interface PdfUses {
  citations: UsedCitation[];
  annotations: CitationUse[];
  citationError: string;
}
