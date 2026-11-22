import type { DocumentTree } from "../document/tree.js";

export type TranslationLanguage = "en" | "zh";

type InlinePart = DocumentTree["sentences"][string]["content"][number];

interface TranslationSentenceContent {
  sentenceId: string;
  content: InlinePart[];
}

export interface TranslationUnitContent {
  unitId: string;
  sentences: TranslationSentenceContent[];
}
