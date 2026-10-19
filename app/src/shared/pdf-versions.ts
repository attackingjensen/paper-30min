import type { DocumentRecord, PdfSource } from "./contracts.js";

export function isKnownPdfVersion(document: DocumentRecord, sha256: string) {
  return sha256 === document.sha256 || sha256 === document.annotationSha256;
}

/** Byte equality is sufficient; changed bytes require a trusted annotation lineage on both snapshots. */
export function canReusePdfEvidence(source: Pick<PdfSource, "sha256" | "document">,
  current: Pick<PdfSource, "sha256" | "document">) {
  const before = source.document;
  const after = current.document;
  if (before && after && (before.id !== after.id || before.sha256 !== after.sha256)) return false;
  if (source.sha256 === current.sha256) return true;
  return !!before && !!after && before.id === after.id && before.sha256 === after.sha256 &&
    isKnownPdfVersion(before, source.sha256) && isKnownPdfVersion(after, current.sha256);
}
