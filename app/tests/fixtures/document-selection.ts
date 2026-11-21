import type { DocumentTree } from "../../src/shared/document/tree";
import { testDocumentIds, testDocumentTree } from "./document-tree";

export const selectionIds = {
  ...testDocumentIds,
  secondSentence: "00000000-0000-4000-8000-000000000006",
  secondUnit: "00000000-0000-4000-8000-000000000007",
  thirdSentence: "00000000-0000-4000-8000-000000000008",
  secondBlock: "00000000-0000-4000-8000-000000000009",
} as const;

export function testSelectionTree(paperId: string): DocumentTree {
  const tree = testDocumentTree(paperId, "论文");
  tree.units[selectionIds.unit].sentenceIds = [selectionIds.sentence, selectionIds.secondSentence];
  tree.sentences[selectionIds.secondSentence] = {
    id: selectionIds.secondSentence,
    unitId: selectionIds.unit,
    content: [{ kind: "text", text: "Second 😀 é sentence." }],
  };
  tree.units[selectionIds.secondUnit] = {
    id: selectionIds.secondUnit,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [selectionIds.thirdSentence],
  };
  tree.sentences[selectionIds.thirdSentence] = {
    id: selectionIds.thirdSentence,
    unitId: selectionIds.secondUnit,
    content: [{ kind: "text", text: "Next unit." }],
  };
  tree.sections[selectionIds.section].unitIds = [selectionIds.unit, selectionIds.secondUnit];
  tree.blocks.push({
    id: selectionIds.secondBlock,
    sectionId: selectionIds.section,
    kind: "unit",
    unitId: selectionIds.secondUnit,
  });
  return tree;
}
