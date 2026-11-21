import { randomUUID } from "node:crypto";
import type { DocumentTree } from "../../../src/shared/document/tree";

type UnitKind = DocumentTree["units"][string]["kind"];
type InlinePart = DocumentTree["sentences"][string]["content"][number];
type Block = DocumentTree["blocks"][number];

/** Full 阅读器复杂内容 fixture（SPEC-reader Testing Strategy）：
 * 章节＋附录、摘要、行内/独立公式（含失败 LaTeX 与 MathML）、跨行列表格、
 * 本地位图与 SVG 图、缺图警告、脚注、参考文献、raw block、代码样 raw、
 * 已解析/未解析交叉引用与外链原子。全部 ID 稳定可断言；
 * 资产 sha256 留空，由测试按登记字节回填。 */
export function complexReaderTree(paperId: string) {
  const ids: Record<string, string> = {
    body: randomUUID(),
    method: randomUUID(),
    appendix: randomUUID(),
    abstract: randomUUID(),
    intro: randomUUID(),
    inlineMathSentence: randomUUID(),
    inlineMath: randomUUID(),
    citation: randomUUID(),
    footnoteRef: randomUUID(),
    resolvedRef: randomUUID(),
    unresolvedRef: randomUUID(),
    safeLink: randomUUID(),
    displayFormula: randomUUID(),
    failedFormula: randomUUID(),
    mathmlFormula: randomUUID(),
    tableCaption: randomUUID(),
    cellHeaderA: randomUUID(),
    cellHeaderB: randomUUID(),
    cellSpan: randomUUID(),
    cellValue: randomUUID(),
    table: randomUUID(),
    figure: randomUUID(),
    figureCaption: randomUUID(),
    svgFigure: randomUUID(),
    missingFigure: randomUUID(),
    codeRaw: randomUUID(),
    rawBlock: randomUUID(),
    footnote: randomUUID(),
    reference: randomUUID(),
    target: randomUUID(),
    longUnit: randomUUID(),
  };
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {},
    units: {},
    sentences: {},
    atoms: {},
    blocks: [],
  };
  const section = (id: string, parentSectionId: string | null, title: string, childSectionIds: string[] = []) => {
    tree.sections[id] = { id, parentSectionId, title, childSectionIds, unitIds: [] };
  };
  section(ids.body, null, "", [ids.method, ids.appendix]);
  section(ids.method, ids.body, "2 方法", []);
  section(ids.appendix, ids.body, "附录 A 证明", []);

  const unit = (sectionId: string, kind: UnitKind, sentences: InlinePart[][]) => {
    const unitId = randomUUID();
    const sentenceIds: string[] = [];
    for (const content of sentences) {
      const sentenceId = randomUUID();
      sentenceIds.push(sentenceId);
      tree.sentences[sentenceId] = { id: sentenceId, unitId, content };
      for (const part of content) {
        if (part.kind !== "atom") continue;
        const atom = tree.atoms[part.atomId];
        if (atom) atom.unitId = unitId;
      }
    }
    tree.units[unitId] = { id: unitId, sectionId, kind, sentenceIds };
    tree.sections[sectionId].unitIds.push(unitId);
    tree.blocks.push({ id: randomUUID(), sectionId, kind: "unit", unitId });
    return unitId;
  };
  const block = (value: Block) => {
    tree.blocks.push(value);
    return value.id;
  };

  // 摘要与引言（含行内公式、引文、脚注引用、已解析/未解析交叉引用、外链）。
  ids.abstract = unit(ids.body, "abstract", [
    [
      { kind: "text", text: "We study reading. Energy stays " },
      { kind: "atom", atomId: ids.inlineMath },
      { kind: "text", text: " throughout." },
    ],
  ]);
  tree.atoms[ids.inlineMath] = {
    id: ids.inlineMath,
    unitId: ids.abstract,
    kind: "math",
    text: "$E=mc^2$",
    source: { format: "latex", value: "E=mc^2" },
  };
  ids.inlineMathSentence = tree.units[ids.abstract].sentenceIds[0];

  tree.atoms[ids.unresolvedRef] = {
    id: ids.unresolvedRef,
    unitId: "",
    kind: "cross-reference",
    text: "Eq. (9)",
    targetUnitId: null,
    sourceTarget: "S3.E9",
  };
  tree.atoms[ids.safeLink] = {
    id: ids.safeLink,
    unitId: "",
    kind: "link",
    text: "项目主页",
    href: "https://example.org/project",
  };
  ids.intro = unit(ids.body, "paragraph", [
    [
      { kind: "text", text: "Prior work " },
      { kind: "atom", atomId: ids.citation },
      { kind: "text", text: " inspires this" },
      { kind: "atom", atomId: ids.footnoteRef },
      { kind: "text", text: "." },
    ],
    [
      { kind: "text", text: "See " },
      { kind: "atom", atomId: ids.resolvedRef },
      { kind: "text", text: " and " },
      { kind: "atom", atomId: ids.unresolvedRef },
      { kind: "text", text: " or visit " },
      { kind: "atom", atomId: ids.safeLink },
      { kind: "text", text: "." },
    ],
  ]);

  // 独立公式：编号文本、失败 LaTeX、MathML。
  ids.displayFormula = block({
    id: randomUUID(),
    sectionId: ids.body,
    kind: "formula",
    source: { format: "latex", value: "\\int_0^1 x^2 \\, dx = \\frac{1}{3}" },
    text: "(1)  ∫₀¹ x² dx = 1/3",
  });
  ids.failedFormula = block({
    id: randomUUID(),
    sectionId: ids.body,
    kind: "formula",
    source: { format: "latex", value: "\\frac{1{" },
    text: "(2)  \\frac{1{",
  });
  ids.mathmlFormula = block({
    id: randomUUID(),
    sectionId: ids.body,
    kind: "formula",
    source: {
      format: "mathml",
      value: "<math><mrow><mi>a</mi><mo>+</mo><mn>1</mn></mrow></math>",
    },
    text: "(3)  a + 1",
  });

  // 方法章节：目标段落＋跨行列表格。
  ids.target = unit(ids.method, "paragraph", [[{ kind: "text", text: "This is the jump target paragraph." }]]);
  ids.tableCaption = unit(ids.method, "caption", [[{ kind: "text", text: "Table 1: results with spans." }]]);
  ids.cellHeaderA = unit(ids.method, "table-cell", [[{ kind: "text", text: "Metric" }]]);
  ids.cellHeaderB = unit(ids.method, "table-cell", [[{ kind: "text", text: "Value" }]]);
  ids.cellSpan = unit(ids.method, "table-cell", [[{ kind: "text", text: "merged across rows" }]]);
  ids.cellValue = unit(ids.method, "table-cell", [[{ kind: "text", text: "0.98" }]]);
  // 表格单元统一随表格块进入阅读流，不作为独立 unit 块重复出现。
  tree.blocks = tree.blocks.filter(
    (entry) =>
      entry.kind !== "unit" ||
      ![ids.tableCaption, ids.cellHeaderA, ids.cellHeaderB, ids.cellSpan, ids.cellValue].includes(entry.unitId),
  );
  ids.table = block({
    id: randomUUID(),
    sectionId: ids.method,
    kind: "table",
    captionUnitId: ids.tableCaption,
    rows: [
      [
        { unitId: ids.cellHeaderA, rowSpan: 1, columnSpan: 1 },
        { unitId: ids.cellHeaderB, rowSpan: 1, columnSpan: 1 },
        { unitId: ids.cellSpan, rowSpan: 2, columnSpan: 1 },
      ],
      [{ unitId: ids.cellValue, rowSpan: 1, columnSpan: 2 }],
    ],
  });

  // 图片：位图＋caption、SVG、缺图警告。资产路径按树契约以 SHA-256 命名；
  // 测试登记真实字节后把 sha256 回填为实际摘要。
  ids.figureCaption = unit(ids.method, "caption", [[{ kind: "text", text: "Figure 1: architecture overview." }]]);
  tree.blocks = tree.blocks.filter((entry) => entry.kind !== "unit" || entry.unitId !== ids.figureCaption);
  ids.figure = block({
    id: randomUUID(),
    sectionId: ids.method,
    kind: "figure",
    asset: { path: `assets/${"a".repeat(64)}.png`, sha256: "a".repeat(64), mime: "image/png" },
    captionUnitId: ids.figureCaption,
  });
  ids.svgFigure = block({
    id: randomUUID(),
    sectionId: ids.method,
    kind: "figure",
    asset: { path: `assets/${"b".repeat(64)}.svg`, sha256: "b".repeat(64), mime: "image/svg+xml" },
    captionUnitId: null,
  });
  ids.missingFigure = block({
    id: randomUUID(),
    sectionId: ids.method,
    kind: "figure",
    asset: null,
    captionUnitId: null,
    warning: "来源图片未随快照保存。",
  });

  // raw block：代码样受控文本与结构限制说明。
  ids.codeRaw = block({
    id: randomUUID(),
    sectionId: ids.method,
    kind: "raw",
    html: "<pre><code>def f(x):\n    return x + 1</code></pre>",
    text: "def f(x):\n    return x + 1",
    limitations: ["来源为代码摘录，仅保留受控文本投影。"],
  });
  ids.rawBlock = block({
    id: randomUUID(),
    sectionId: ids.method,
    kind: "raw",
    html: "<blockquote><p>Quoted <strong>source</strong> line.</p></blockquote>",
    text: "Quoted source line.",
    limitations: ["复杂排版按白名单投影，交互结构未保留。"],
  });

  // 附录：脚注、参考文献、超长不可断行内容。
  ids.footnote = unit(ids.appendix, "footnote", [[{ kind: "text", text: "Footnote body explains the caveat." }]]);
  ids.reference = unit(ids.appendix, "reference", [
    [{ kind: "text", text: "[7] Author, A. (2024). A cited paper. Journal of Reading." }],
  ]);
  ids.longUnit = unit(ids.appendix, "paragraph", [
    [
      { kind: "text", text: "Supercalifragilisticexpialidocious".repeat(8) },
      { kind: "text", text: " 这是一段用于验证窄窗格换行的中文正文，包含标点、组合字符 e\u0301 与代理对 𝒜。" },
    ],
  ]);
  // 目标单元全部创建后再登记引用原子，保证树校验时目标已存在。
  tree.atoms[ids.citation] = {
    id: ids.citation,
    unitId: ids.intro,
    kind: "citation",
    text: "[7]",
    targetUnitId: ids.reference,
  };
  tree.atoms[ids.footnoteRef] = {
    id: ids.footnoteRef,
    unitId: ids.intro,
    kind: "footnote-reference",
    text: "1",
    targetUnitId: ids.footnote,
  };
  tree.atoms[ids.resolvedRef] = {
    id: ids.resolvedRef,
    unitId: ids.intro,
    kind: "cross-reference",
    text: "Section 2",
    targetUnitId: ids.target,
  };

  return { tree, ids };
}

/** 危险协议链接 fixture：绕过树校验直接构造，用于投影层防御测试。 */
export function dangerousLinkTree(paperId: string): DocumentTree {
  const sectionId = randomUUID();
  const unitId = randomUUID();
  const sentenceId = randomUUID();
  const atomId = randomUUID();
  return {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [sectionId]: { id: sectionId, parentSectionId: null, title: "", childSectionIds: [], unitIds: [unitId] },
    },
    units: {
      [unitId]: { id: unitId, sectionId, kind: "paragraph", sentenceIds: [sentenceId] },
    },
    sentences: {
      [sentenceId]: {
        id: sentenceId,
        unitId,
        content: [
          { kind: "text", text: "click " },
          { kind: "atom", atomId },
        ],
      },
    },
    atoms: {
      [atomId]: { id: atomId, unitId, kind: "link", text: "危险链接", href: "javascript:alert(1)" },
    },
    blocks: [{ id: randomUUID(), sectionId, kind: "unit", unitId }],
  };
}
