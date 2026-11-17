import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  createProject,
  openProject,
  readSourceSnapshot,
  readRevisionDocument,
  publishSourceSnapshot,
} from "../src/main/project-core";
import { convertLatexml, convertArxivSnapshot, type ConvertLatexmlResult } from "../src/main/arxiv/convert";
import { parseDocumentTree } from "../src/shared/document/tree";
import { projectSentenceText } from "../src/shared/document/anchor";
import type { ArxivAssetMapping, ArxivSourceMetadata } from "../src/main/arxiv/fetch";
import type { DocumentTree } from "../src/shared/document/tree";
import {
  latexmlDocument,
  abstractOnlyDocument,
  allExternalImagesDocument,
  allBlankMathDocument,
  FIG1_SRC,
  FIG2_SRC,
  absPageDocument,
  MISSING_TARGET_EXTRA,
  SVG_EXTRA,
  UNKNOWN_CONTENT_EXTRA,
  NESTED_TABLE_EXTRA,
} from "./fixtures/arxiv-latexml";

const HTML_URL = "http://127.0.0.1:9999/html/2401.01234v1";
const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assetMappings(): Record<string, ArxivAssetMapping> {
  const entries = [
    { src: FIG1_SRC, bytes: PNG1 },
    { src: FIG2_SRC, bytes: PNG2 },
  ].map(({ src, bytes }) => {
    const hash = sha(bytes);
    const mapping: ArxivAssetMapping = {
      originalUrl: new URL(src, HTML_URL).href,
      path: `assets/${hash}.png`,
      sha256: hash,
      size: bytes.byteLength,
      mime: "image/png",
    };
    return [mapping.path, mapping] as const;
  });
  return Object.fromEntries(entries);
}

function convert(html: string, assets = assetMappings()) {
  return convertLatexml({
    html: Buffer.from(html),
    paperId: randomUUID(),
    htmlUrl: HTML_URL,
    assets,
    assetBytes: Object.fromEntries(
      Object.values(assets).map((mapping) => [
        mapping.path,
        mapping.originalUrl.endsWith("overview.png") ? PNG1 : PNG2,
      ]),
    ),
  });
}

function okTree(result: ConvertLatexmlResult): DocumentTree {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.messageKey);
  return result.tree;
}

function okResult(result: ConvertLatexmlResult): Extract<ConvertLatexmlResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostic.messageKey);
  return result;
}

function unitText(tree: DocumentTree, unitId: string): string {
  return tree.units[unitId].sentenceIds
    .map((id) => projectSentenceText(tree, id))
    .join("\n");
}

function allUnitTexts(tree: DocumentTree): string[] {
  return Object.keys(tree.units).map((id) => unitText(tree, id));
}

function sectionByAlias(tree: DocumentTree, alias: string) {
  return Object.values(tree.sections).find(
    (section) => section.sourceAliases?.includes(alias),
  );
}

function unitByAlias(tree: DocumentTree, alias: string) {
  return Object.values(tree.units).find((unit) => unit.sourceAliases?.includes(alias));
}

test("arxiv-import 转换核心：章节/附录结构、来源别名与阅读顺序进入规范树", () => {
  const result = convert(latexmlDocument());
  const tree = okTree(result);
  parseDocumentTree(tree, tree.paperId);

  const intro = sectionByAlias(tree, "S1")!;
  const method = sectionByAlias(tree, "S2")!;
  const conclusion = sectionByAlias(tree, "S3")!;
  const appendix = sectionByAlias(tree, "A1")!;
  const details = sectionByAlias(tree, "A1.SS1")!;
  const bib = sectionByAlias(tree, "bib")!;
  expect(intro.title).toBe("Introduction");
  expect(method.title).toBe("Method");
  expect(appendix.title).toBe("Proofs");
  expect(details.parentSectionId).toBe(appendix.id);
  expect(appendix.childSectionIds).toEqual([details.id]);
  expect(bib.title).toBe("References");

  // 标题/作者不重复进入正文；摘要以 abstract unit 保留。
  const texts = allUnitTexts(tree);
  expect(texts.filter((text) => text === "Fixture Study of Energy")).toHaveLength(0);
  expect(texts.filter((text) => text.includes("Ada Lovelace"))).toHaveLength(0);
  const abstract = Object.values(tree.units).find((unit) => unit.kind === "abstract")!;
  expect(unitText(tree, abstract.id)).toContain("We study energy and mass.");

  // 阅读顺序：每个章节的首个直属单元在 blocks 展平顺序中的位置（Intro → Method → Conclusion → 附录 → 参考文献）。
  const order = tree.blocks.flatMap((block) => {
    if (block.kind === "unit") return [tree.units[block.unitId].sectionId];
    if (block.kind === "figure")
      return block.captionUnitId ? [tree.units[block.captionUnitId].sectionId] : [];
    if (block.kind === "table")
      return [tree.units[block.rows[0][0].unitId].sectionId];
    return [];
  });
  const firstIndex = (sectionId: string) => order.indexOf(sectionId);
  expect(firstIndex(intro.id)).toBeLessThan(firstIndex(method.id));
  expect(firstIndex(method.id)).toBeLessThan(firstIndex(conclusion.id));
  // 附录容器自身无直属单元；以其子章节首个单元的位置代表附录在閱讀流中的起点。
  expect(firstIndex(conclusion.id)).toBeLessThan(firstIndex(details.id));
  expect(firstIndex(details.id)).toBeLessThan(firstIndex(bib.id));

  // 列表项与定理进入树；重复段落保留两次。
  const listItem = unitByAlias(tree, "S1.I1.i1")!;
  expect(listItem.kind).toBe("list-item");
  expect(unitText(tree, listItem.id)).toBe("First item.");
  expect(texts.some((text) => text.includes("Every right triangle satisfies"))).toBe(true);
  expect(texts.filter((text) => text.includes("We repeat the claim"))).toHaveLength(1);
  const repeated = Object.values(tree.units).find((unit) =>
    unitText(tree, unit.id).includes("We repeat the claim"))!;
  expect(repeated.sentenceIds.length).toBe(2);

  // 参考文献条目成为 reference unit。
  const reference = unitByAlias(tree, "bib.bib1")!;
  expect(reference.kind).toBe("reference");
  expect(unitText(tree, reference.id)).toContain("A study of energy");

  // 非正文元素被明确忽略，不产生任何脚本/样式文本。
  expect(texts.some((text) => text.includes("window.track"))).toBe(false);
  expect(texts.some((text) => text.includes("color: red"))).toBe(false);
});

test("arxiv-import 公式：alttext/TeX 优先，仅 MathML 时仍有可读文本，公式块保留编号别名", () => {
  const tree = okTree(convert(latexmlDocument()));

  const inlineMath = Object.values(tree.atoms).filter((atom) => atom.kind === "math");
  const energy = inlineMath.find((atom) => atom.text === "E=mc^{2}")!;
  expect(energy.source).toEqual({ format: "latex", value: "E=mc^{2}" });
  const mathmlOnly = inlineMath.find((atom) => atom.source.format === "text")!;
  expect(mathmlOnly.text).toContain("x");
  expect(mathmlOnly.text).toContain("1");
  expect(mathmlOnly.text.length).toBeGreaterThan(1);

  const formula = tree.blocks.find((block) => block.kind === "formula")!;
  if (formula.kind !== "formula") throw new Error("formula block missing");
  expect(formula.source).toEqual({ format: "latex", value: "a^{2}+b^{2}=c^{2}" });
  expect(formula.text).toContain("(1)");
  expect(formula.text).toContain("a^{2}+b^{2}=c^{2}");
  expect(formula.sourceAliases).toContain("S2.E1");

  // 引用公式编号的 ltx_ref 解析到公式块锚定单元。
  const crossRefs = Object.values(tree.atoms).filter((atom) => atom.kind === "cross-reference");
  const equationRef = crossRefs.find((atom) => atom.sourceTarget === "S2.E1")!;
  expect(equationRef.targetUnitId).not.toBeNull();
  expect(tree.units[equationRef.targetUnitId!]).toBeDefined();
});

test("arxiv-import 图表：图片本地资产引用、caption 单元与表格行列跨度", () => {
  const tree = okTree(convert(latexmlDocument()));

  const figures = tree.blocks.filter((block) => block.kind === "figure");
  expect(figures.length).toBe(2);
  for (const figure of figures) {
    if (figure.kind !== "figure") continue;
    expect(figure.asset).not.toBeNull();
    expect(figure.asset!.path).toBe(`assets/${figure.asset!.sha256}.png`);
    expect(figure.asset!.mime).toBe("image/png");
    expect(figure.captionUnitId).not.toBeNull();
  }
  const fig1 = figures.find((figure) => figure.sourceAliases?.includes("S2.F1"))!;
  if (fig1.kind !== "figure") throw new Error("figure missing");
  expect(fig1.asset!.sha256).toBe(sha(PNG1));
  expect(unitText(tree, fig1.captionUnitId!)).toBe("System overview.");
  expect(tree.units[fig1.captionUnitId!].kind).toBe("caption");

  const table = tree.blocks.find(
    (block) => block.kind === "table" && block.sourceAliases?.includes("S2.T1"),
  )!;
  if (table.kind !== "table") throw new Error("table missing");
  expect(unitText(tree, table.captionUnitId!)).toBe("Measured results.");
  expect(table.rows.length).toBe(2);
  expect(table.rows[0].length).toBe(2);
  expect(table.rows[0][0].rowSpan).toBe(2);
  expect(table.rows[1].length).toBe(1);
  expect(unitText(tree, table.rows[0][0].unitId)).toBe("Alpha");
  expect(tree.units[table.rows[0][1].unitId].kind).toBe("table-cell");
});

test("arxiv-import 交叉引用：图/公式/文献解析到规范节点，脚注成为 footnote unit 与引用原子", () => {
  const tree = okTree(convert(latexmlDocument()));

  const crossRefs = Object.values(tree.atoms).filter((atom) => atom.kind === "cross-reference");
  const figureRef = crossRefs.find((atom) => atom.sourceTarget === "S2.F1")!;
  const fig1 = tree.blocks.find(
    (block) => block.kind === "figure" && block.sourceAliases?.includes("S2.F1"),
  )!;
  if (fig1.kind !== "figure") throw new Error("figure missing");
  expect(figureRef.targetUnitId).toBe(fig1.captionUnitId);

  const citation = Object.values(tree.atoms).find((atom) => atom.kind === "citation")!;
  expect(citation.text).toContain("[1]");
  const bibUnit = unitByAlias(tree, "bib.bib1")!;
  expect(citation.sourceAliases).toContain("bib.bib1");
  expect(unitText(tree, bibUnit.id)).toContain("A study of energy");

  const footnoteRef = Object.values(tree.atoms).find((atom) => atom.kind === "footnote-reference")!;
  const footnoteUnit = tree.units[footnoteRef.targetUnitId];
  expect(footnoteUnit.kind).toBe("footnote");
  expect(unitText(tree, footnoteUnit.id)).toBe("A footnote about units.");

  const link = Object.values(tree.atoms).find((atom) => atom.kind === "link")!;
  expect(link.href).toBe("https://example.org/data");
  expect(link.text).toBe("open data");
});

test("arxiv-import 缺失引用目标：保留显示文本与 sourceTarget，记 warning 不冒充已解析", () => {
  const result = convert(latexmlDocument({ extra: MISSING_TARGET_EXTRA }));
  if (!result.ok) throw new Error(result.diagnostic.messageKey);
  const tree = result.tree;
  const unresolved = Object.values(tree.atoms).find(
    (atom) => atom.kind === "cross-reference" && atom.sourceTarget === "S2.E9",
  )!;
  if (unresolved.kind !== "cross-reference") throw new Error("atom missing");
  expect(unresolved.targetUnitId).toBeNull();
  expect(unresolved.text).toContain("Equation 9");
  expect(result.warnings.some((warning) =>
    warning.severity === "warning" && warning.sourceAlias === "S2.E9")).toBe(true);
});

test("arxiv-import 确定性：同快照同算法版本两次转换产生一致的规范内容", () => {
  const html = latexmlDocument();
  const paperId = randomUUID();
  const input = {
    html: Buffer.from(html),
    paperId,
    htmlUrl: HTML_URL,
    assets: assetMappings(),
    assetBytes: { [`assets/${sha(PNG1)}.png`]: PNG1, [`assets/${sha(PNG2)}.png`]: PNG2 },
  };
  const first = convertLatexml(input);
  const second = convertLatexml(input);
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  // ID 由 document-core 每次分配（SPEC §4.3）；确定性指规范内容：结构、顺序、文本与来源表示。
  expect(JSON.stringify(canonicalContent(second.tree))).toBe(JSON.stringify(canonicalContent(first.tree)));
  expect(second.converterVersion).toBe(first.converterVersion);
});

/** 去掉随机 ID 与内部引用后的规范内容投影，用于确定性比较。 */
function canonicalContent(tree: DocumentTree): unknown {
  const sectionOrder = Object.keys(tree.sections);
  const unitOrder = Object.keys(tree.units);
  const sectionIndex = new Map(sectionOrder.map((id, index) => [id, index]));
  const unitIndex = new Map(unitOrder.map((id, index) => [id, index]));
  const sentenceText = (sentenceId: string): unknown =>
    tree.sentences[sentenceId].content.map((part) => {
      if (part.kind === "text") return part.text;
      const { id: _id, unitId: _unitId, ...atom } = tree.atoms[part.atomId];
      if ("targetUnitId" in atom && atom.targetUnitId)
        return { ...atom, targetUnitId: unitIndex.get(atom.targetUnitId) };
      return atom;
    });
  return {
    sections: sectionOrder.map((id) => ({
      title: tree.sections[id].title,
      parent: tree.sections[id].parentSectionId ? sectionIndex.get(tree.sections[id].parentSectionId!) : null,
      aliases: tree.sections[id].sourceAliases ?? [],
      units: tree.sections[id].unitIds.map((unitId) => unitIndex.get(unitId)),
    })),
    units: unitOrder.map((id) => ({
      kind: tree.units[id].kind,
      aliases: tree.units[id].sourceAliases ?? [],
      sentences: tree.units[id].sentenceIds.map(sentenceText),
    })),
    blocks: tree.blocks.map((block) => {
      const base = { kind: block.kind, section: sectionIndex.get(block.sectionId), aliases: block.sourceAliases ?? [] };
      if (block.kind === "unit") return { ...base, unit: unitIndex.get(block.unitId) };
      if (block.kind === "figure") return { ...base, asset: block.asset, caption: block.captionUnitId ? unitIndex.get(block.captionUnitId) : null, warning: block.warning ?? null };
      if (block.kind === "table") return { ...base, caption: block.captionUnitId ? unitIndex.get(block.captionUnitId) : null, rows: block.rows.map((row) => row.map((cell) => ({ unit: unitIndex.get(cell.unitId), rowSpan: cell.rowSpan, columnSpan: cell.columnSpan }))) };
      if (block.kind === "formula") return { ...base, source: block.source, text: block.text };
      return { ...base, html: block.html, text: block.text, limitations: block.limitations };
    }),
  };
}

let sandbox: string;
let root: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-arxiv-convert-"));
  const created = await createProject({ parent: sandbox, name: "arxiv 转换工程" });
  root = created.root;
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function publishFixtureSnapshot(html: string) {
  const mappings = assetMappings();
  const files: Record<string, { bytes: Uint8Array; mime?: string }> = {
    "abs.html": { bytes: Buffer.from("<html><head><title>Fixture</title></head><body>abs</body></html>") },
    "document.html": { bytes: Buffer.from(html), mime: "text/html" },
  };
  for (const [relative, mapping] of Object.entries(mappings)) {
    files[relative] = {
      bytes: mapping.originalUrl.endsWith("overview.png") ? PNG1 : PNG2,
      mime: "image/png",
    };
  }
  const metadata: ArxivSourceMetadata = {
    kind: "arxiv",
    baseId: "2401.01234",
    version: 1,
    canonicalId: "2401.01234v1",
    absUrl: "http://127.0.0.1:9999/abs/2401.01234v1",
    htmlUrl: HTML_URL,
    title: "Fixture Study of Energy",
    authors: ["Ada Lovelace"],
    versionDate: null,
    licenseUrl: null,
    fetchedAt: new Date().toISOString(),
    assets: mappings,
  };
  return publishSourceSnapshot({ root, files, metadata: { ...metadata } });
}

test("arxiv-import 快照转换发布：从受管快照离线转换，document 与 source-base 一致，current 推进", async () => {
  const snapshot = await publishFixtureSnapshot(latexmlDocument());
  const result = await convertArxivSnapshot({ root, sourceSnapshotId: snapshot.sourceSnapshotId });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const opened = await openProject(root);
  expect(opened.manifest.paper.currentRevision).toBe(result.revision.revisionId);

  const document = await readRevisionDocument(root, result.revision.revisionId, "document");
  const sourceBase = await readRevisionDocument(root, result.revision.revisionId, "source-base");
  expect(JSON.stringify(sourceBase)).toBe(JSON.stringify(document));
  expect(document.paperId).toBe(opened.manifest.paper.id);
  parseDocumentTree(document, opened.manifest.paper.id);

  // 快照字节不因转换而改变。
  const after = await readSourceSnapshot(root, snapshot.sourceSnapshotId);
  expect(after.files).toEqual(snapshot.files);

  // 二次转换同一快照：内容一致但生成新 revision 身份，不原地改写已发布 revision。
  const again = await convertArxivSnapshot({ root, sourceSnapshotId: snapshot.sourceSnapshotId });
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.revision.revisionId).not.toBe(result.revision.revisionId);
  const documentAgain = await readRevisionDocument(root, again.revision.revisionId, "document");
  expect(allUnitTexts(documentAgain)).toEqual(allUnitTexts(document));
});

test("arxiv-import 转换失败不发布：abs 冒充正文时 current 保持为空，快照保留", async () => {
  const snapshot = await publishFixtureSnapshot(absPageDocument());
  const result = await convertArxivSnapshot({ root, sourceSnapshotId: snapshot.sourceSnapshotId });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostic.severity).toBe("fatal");
  expect(result.diagnostic.stage).toBe("convert");
  const opened = await openProject(root);
  expect(opened.manifest.paper.currentRevision).toBeNull();
  await expect(readSourceSnapshot(root, snapshot.sourceSnapshotId)).resolves.toBeDefined();
});

test("arxiv-import 系统性失败：全部图片缺失或全部公式不可读时拒绝发布，不拆成局部 warning", () => {
  const external = convert(allExternalImagesDocument(), {});
  expect(external.ok).toBe(false);
  if (!external.ok) {
    expect(external.diagnostic.code).toBe("arxiv-convert-figure-systemic");
    expect(external.diagnostic.severity).toBe("fatal");
  }
  const blankMath = convert(allBlankMathDocument(), {});
  expect(blankMath.ok).toBe(false);
  if (!blankMath.ok) expect(blankMath.diagnostic.code).toBe("arxiv-convert-math-systemic");
});

test("arxiv-import 局部降级：单张外部图片保留 caption 与占位 warning，正文仍可发布", () => {
  const html = latexmlDocument().replace(
    `src="${FIG2_SRC}"`,
    `src="https://cdn.example.org/external.png"`,
  );
  const result = okResult(convert(html));
  const tree = result.tree;
  const figures = tree.blocks.filter((block) => block.kind === "figure");
  const missing = figures.find((block) => block.kind === "figure" && block.asset === null);
  expect(missing).toBeDefined();
  if (missing?.kind === "figure") {
    expect(missing.warning).toBeTruthy();
    expect(missing.captionUnitId).not.toBeNull();
    expect(unitText(tree, missing.captionUnitId!)).toBe("Second plot.");
  }
  expect(result.warnings.some((warning) => warning.code === "arxiv-convert-asset-missing")).toBe(true);
});

test("arxiv-import 内联 SVG：不执行内容，降级为占位与 warning，caption 保留", () => {
  const result = okResult(convert(latexmlDocument({ extra: SVG_EXTRA })));
  const tree = result.tree;
  const svgFigure = tree.blocks.find(
    (block) => block.kind === "figure" && block.sourceAliases?.includes("S2.F3"),
  );
  expect(svgFigure).toBeDefined();
  if (svgFigure?.kind === "figure") {
    expect(svgFigure.asset).toBeNull();
    expect(svgFigure.warning).toBeTruthy();
    expect(unitText(tree, svgFigure.captionUnitId!)).toBe("Inline vector plot.");
  }
  // SVG 内的脚本不得进入任何文本投影或 raw html。
  const serialized = JSON.stringify(tree);
  expect(serialized).not.toContain("alert(1)");
  expect(result.warnings.some((warning) => warning.code === "arxiv-convert-svg-inline")).toBe(true);
});

test("arxiv-import 未知可见内容：结构化降级为 raw block 且保留文本，不静默丢弃", () => {
  const result = convert(latexmlDocument({ extra: UNKNOWN_CONTENT_EXTRA }));
  const tree = okTree(result);
  const raw = tree.blocks.find((block) => block.kind === "raw");
  expect(raw).toBeDefined();
  if (raw?.kind === "raw") {
    expect(raw.text).toContain("Unrecognized visible content.");
    expect(raw.limitations.length).toBeGreaterThan(0);
    expect(raw.html).not.toContain("ltx_custom_block");
  }
});

test("arxiv-import 嵌套表格：无法无损表达时 raw 降级并保留全部单元格文本", () => {
  const result = okResult(convert(latexmlDocument({ extra: NESTED_TABLE_EXTRA })));
  const tree = result.tree;
  const raw = tree.blocks.find(
    (block) => block.kind === "raw" && block.sourceAliases?.includes("S2.T2"),
  );
  expect(raw).toBeDefined();
  if (raw?.kind === "raw") {
    expect(raw.text).toContain("outer");
    expect(raw.text).toContain("inner");
    expect(raw.limitations).toContain("arxiv.convert.tableLossy");
  }
  expect(result.warnings.some((warning) => warning.code === "arxiv-convert-table-lossy")).toBe(true);
});

test("arxiv-import 只有摘要没有正文：拒绝宣称可读", () => {
  const result = convert(abstractOnlyDocument(), {});
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-convert-body-missing");
});

test("arxiv-import 危险链接：javascript/data URL 不进入运行时，仅保留文本与 warning", () => {
  const html = latexmlDocument().replace(
    `<a href="https://example.org/data" class="ltx_ref ltx_url">open data</a>`,
    `<a href="javascript:alert(1)" class="ltx_ref ltx_url">open data</a>`,
  );
  const result = okResult(convert(html));
  const tree = result.tree;
  const links = Object.values(tree.atoms).filter((atom) => atom.kind === "link");
  expect(links).toHaveLength(0);
  expect(allUnitTexts(tree).some((text) => text.includes("open data"))).toBe(true);
  expect(result.warnings.some((warning) => warning.code === "arxiv-convert-link-blocked")).toBe(true);
});

test("arxiv-import 资产摘要不符：拒绝发布而不是引用错误字节", () => {
  const assets = assetMappings();
  const firstPath = Object.keys(assets)[0];
  const result = convertLatexml({
    html: Buffer.from(latexmlDocument()),
    paperId: randomUUID(),
    htmlUrl: HTML_URL,
    assets,
    assetBytes: {
      ...Object.fromEntries(Object.values(assets).map((mapping) => [
        mapping.path,
        mapping.originalUrl.endsWith("overview.png") ? PNG1 : PNG2,
      ])),
      [firstPath]: Buffer.from("tampered"),
    },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.code).toBe("arxiv-convert-asset-digest");
});
