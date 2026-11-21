// Full 阅读投影契约（SPEC-reader §1–2，paper-30min-qa3.1）：
// current 树是唯一输入；全部阅读块按真实顺序投影，锚点只用稳定 ID；
// 公式失败、缺图、未解析引用与危险 URL 都有可读降级，不隐藏单元。
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { parseDocumentTree } from "../src/shared/document/tree";
import { projectSentenceText } from "../src/shared/document/anchor";
import { buildReaderProjection } from "../src/shared/reader/projection";
import { complexReaderTree, dangerousLinkTree } from "./fixtures/reader/complex-document";

const paperId = randomUUID();

function projected() {
  const { tree, ids } = complexReaderTree(paperId);
  return { tree: parseDocumentTree(tree, paperId), ids };
}

test("reader 投影按 blocks 真实顺序输出全部阅读块，含摘要、附录、脚注与参考文献", () => {
  const { tree, ids } = projected();
  const projection = buildReaderProjection(tree);

  // 章节标题条目附着于触发块；内容块本身必须与 blocks 顺序一一对应。
  expect(projection.items.filter((item) => item.kind !== "section").map((item) => item.blockId)).toEqual(
    tree.blocks.map((block) => block.id),
  );
  const units = projection.items.flatMap((item) => (item.kind === "unit" ? [item.unitId] : []));
  expect(units).toContain(ids.abstract);
  expect(units).toContain(ids.footnote);
  expect(units).toContain(ids.reference);
  // 参考文献与脚注在附录末尾，但绝不被隐藏或重排。
  expect(units.indexOf(ids.footnote)).toBeLessThan(units.indexOf(ids.reference));
});

test("reader 投影章节标题按嵌套深度输出，正文块携带所属章节链", () => {
  const { tree, ids } = projected();
  const projection = buildReaderProjection(tree);

  const headings = projection.items.filter((item) => item.kind === "section");
  expect(headings.map((item) => item.kind === "section" && item.title)).toEqual(["", "2 方法", "附录 A 证明"]);
  expect(headings.map((item) => item.kind === "section" && item.depth)).toEqual([1, 2, 2]);
  const table = projection.items.find((item) => item.blockId === ids.table);
  expect(table?.kind === "table" && table.sectionId).toBe(ids.method);
});

test("reader 投影文本片段携带句子 ID 与 UTF-16 逻辑偏移，atom 占一个逻辑位置", () => {
  const { tree, ids } = projected();
  const projection = buildReaderProjection(tree);

  const abstract = projection.items.find((item) => item.kind === "unit" && item.unitId === ids.abstract);
  if (abstract?.kind !== "unit") throw new Error("摘要单元未投影");
  const sentence = abstract.sentences.find((s) => s.sentenceId === ids.inlineMathSentence)!;
  const atomPart = sentence.parts.find((part) => part.kind === "atom")!;
  expect(atomPart.kind === "atom" && atomPart.start).toBe("We study reading. Energy stays ".length);
  expect(atomPart.kind === "atom" && atomPart.end).toBe(atomPart.start + 1);
  const whole = sentence.parts.map((part) => (part.kind === "text" ? part.text : part.atom.text)).join("");
  expect(whole).toBe(projectSentenceText(tree, ids.inlineMathSentence));
});

test("reader 投影行内公式保留 atom ID 与来源 LaTeX，交叉引用区分已解析与未解析", () => {
  const { tree, ids } = projected();
  const projection = buildReaderProjection(tree);

  const intro = projection.items.find((item) => item.kind === "unit" && item.unitId === ids.intro);
  if (intro?.kind !== "unit") throw new Error("引言单元未投影");
  const atoms = intro.sentences
    .flatMap((s) => s.parts)
    .filter((part) => part.kind === "atom")
    .map((part) => part.kind === "atom" && part.atom);
  const abstractItem = projection.items.find((item) => item.kind === "unit" && item.unitId === ids.abstract);
  if (abstractItem?.kind !== "unit") throw new Error("摘要单元未投影");
  const math = abstractItem.sentences
    .flatMap((s) => s.parts)
    .find((part) => part.kind === "atom" && part.atom.id === ids.inlineMath);
  expect(math?.kind === "atom" && math.atom.kind === "math" && math.atom.source).toEqual({
    format: "latex",
    value: "E=mc^2",
  });
  const resolved = atoms.find((atom) => atom && atom.id === ids.resolvedRef);
  expect(resolved && resolved.kind === "cross-reference" && resolved.targetUnitId).toBe(ids.target);
  const unresolved = atoms.find((atom) => atom && atom.id === ids.unresolvedRef);
  expect(unresolved && unresolved.kind === "cross-reference" && unresolved.targetUnitId).toBeNull();
  expect(unresolved && unresolved.kind === "cross-reference" && unresolved.warning).toContain("S3.E9");
  const citation = atoms.find((atom) => atom && atom.id === ids.citation);
  expect(citation && citation.kind === "citation" && citation.targetUnitId).toBe(ids.reference);
});

test("reader 投影危险协议链接降级为不可点击文本并保留警告", () => {
  const tree = dangerousLinkTree(paperId);
  const projection = buildReaderProjection(tree);
  const unit = projection.items.find((item) => item.kind === "unit");
  if (unit?.kind !== "unit") throw new Error("单元未投影");
  const link = unit.sentences.flatMap((s) => s.parts).find((part) => part.kind === "atom");
  if (link?.kind !== "atom" || link.atom.kind !== "link") throw new Error("链接原子未投影");
  expect(link.atom.href).toBeNull();
  expect(link.atom.warning).toBeTruthy();
  expect(link.atom.text).toBe("危险链接");
});

test("reader 投影独立公式保留编号文本与来源；表格保留行列跨度与单元锚点", () => {
  const { tree, ids } = projected();
  const projection = buildReaderProjection(tree);

  const formula = projection.items.find((item) => item.blockId === ids.displayFormula);
  expect(formula?.kind === "formula" && formula.source.format).toBe("latex");
  expect(formula?.kind === "formula" && formula.text).toContain("(1)");
  const table = projection.items.find((item) => item.blockId === ids.table);
  if (table?.kind !== "table") throw new Error("表格未投影");
  expect(table.captionUnitId).toBe(ids.tableCaption);
  expect(table.rows[0][2]).toMatchObject({ unitId: ids.cellSpan, rowSpan: 2, columnSpan: 1 });
  expect(table.rows[1][0]).toMatchObject({ unitId: ids.cellValue, columnSpan: 2 });
  // 单元格文字仍是可投影单元，映射到自身 unit。
  const cell = table.cells[ids.cellValue];
  expect(cell.unitId).toBe(ids.cellValue);
  expect(cell.sentences.length).toBeGreaterThan(0);
});

test("reader 投影图片区分本地资产、caption 与缺失警告；raw block 保留 html、文本与限制", () => {
  const { tree, ids } = projected();
  const projection = buildReaderProjection(tree);

  const figure = projection.items.find((item) => item.blockId === ids.figure);
  expect(figure?.kind === "figure" && figure.asset?.path).toBe(`assets/${"a".repeat(64)}.png`);
  expect(figure?.kind === "figure" && figure.captionUnitId).toBe(ids.figureCaption);
  const missing = projection.items.find((item) => item.blockId === ids.missingFigure);
  expect(missing?.kind === "figure" && missing.asset).toBeNull();
  expect(missing?.kind === "figure" && missing.warning).toBe("来源图片未随快照保存。");
  const raw = projection.items.find((item) => item.blockId === ids.rawBlock);
  expect(raw?.kind === "raw" && raw.html).toContain("<blockquote>");
  expect(raw?.kind === "raw" && raw.text).toBe("Quoted source line.");
  expect(raw?.kind === "raw" && raw.limitations.length).toBeGreaterThan(0);
});

test("reader 投影每个文本片段可追溯到稳定句子/单元/块 ID，不产生下标锚点", () => {
  const { tree } = projected();
  const projection = buildReaderProjection(tree);
  for (const item of projection.items) {
    expect(item.blockId).toMatch(/^[0-9a-f-]{36}$/);
    if (item.kind !== "unit") continue;
    for (const sentence of item.sentences) {
      expect(tree.sentences[sentence.sentenceId]).toBeDefined();
      expect(sentence.unitId).toBe(item.unitId);
    }
  }
});
