import type { DocumentRecord } from "./contracts.js";

export function isKnownPdfVersion(document: DocumentRecord, sha256: string) {
  return sha256 === document.sha256 || sha256 === document.annotationSha256;
}
