import type { DocumentTree } from "../../src/shared/document/tree";

export const testDocumentIds = {
  section: "00000000-0000-4000-8000-000000000001",
  unit: "00000000-0000-4000-8000-000000000002",
  sentence: "00000000-0000-4000-8000-000000000003",
  atom: "00000000-0000-4000-8000-000000000004",
  block: "00000000-0000-4000-8000-000000000005",
} as const;

export function testDocumentTree(paperId: string, title = "论文"): DocumentTree {
  return {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [testDocumentIds.section]: {
        id: testDocumentIds.section,
        parentSectionId: null,
        title,
        childSectionIds: [],
        unitIds: [testDocumentIds.unit],
      },
    },
    units: {
      [testDocumentIds.unit]: {
        id: testDocumentIds.unit,
        sectionId: testDocumentIds.section,
        kind: "paragraph",
        sentenceIds: [testDocumentIds.sentence],
      },
    },
    sentences: {
      [testDocumentIds.sentence]: {
        id: testDocumentIds.sentence,
        unitId: testDocumentIds.unit,
        content: [
          { kind: "text", text: "Dr. " },
          { kind: "atom", atomId: testDocumentIds.atom },
          { kind: "text", text: ` in ${title} remains one sentence.` },
        ],
      },
    },
    atoms: {
      [testDocumentIds.atom]: {
        id: testDocumentIds.atom,
        unitId: testDocumentIds.unit,
        kind: "math",
        text: "3.14",
        source: { format: "latex", value: "3.14" },
      },
    },
    blocks: [
      {
        id: testDocumentIds.block,
        sectionId: testDocumentIds.section,
        kind: "unit",
        unitId: testDocumentIds.unit,
      },
    ],
  };
}

export function testRevisionFiles(
  paperId: string,
  documentTitle: string,
  baseRevision: string | null = null,
  sourceTitle = documentTitle,
) {
  return {
    "document.json": Buffer.from(JSON.stringify(testDocumentTree(paperId, documentTitle))),
    "source-base.json": Buffer.from(JSON.stringify(testDocumentTree(paperId, sourceTitle))),
    "tombstones.json": Buffer.from("[]"),
    "changeset.json": Buffer.from(JSON.stringify({ baseRevision })),
  };
}
