import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import {
  cropPdfPageRegions,
  type PdfCropRequest,
} from "../src/main/pdf/page-crop";
import { parseDocumentTree, validateDocumentAssets } from "../src/shared/document/tree";
import { testDocumentTree, testDocumentIds } from "./fixtures/document-tree";

const PAPER_ID = "00000000-0000-4000-8000-0000000000f0";

/** 300x200pt 单页 PDF：黑矩形 top-left (20,30)-(100,60)。 */
function inkPdf(pageDict = "/MediaBox [0 0 300 200]"): Buffer {
  const stream = "0 g 20 140 80 30 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R ${pageDict} /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function request(overrides: Partial<PdfCropRequest> = {}): PdfCropRequest {
  return {
    key: "page-1/b1",
    page: 1,
    pageWidth: 1200,
    pageHeight: 800,
    bbox: [80, 120, 400, 240],
    ...overrides,
  };
}

function inkPixels(png: Buffer): number {
  const image = PNG.sync.read(png);
  let ink = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] < 128) ink++;
  return ink;
}

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-page-crop-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("page-crop 可校准页面渲染真实区域裁剪图：内容寻址 PNG 且确定性", async () => {
  const result = await cropPdfPageRegions({ pdf: inkPdf(), requests: [request()] });
  expect(result.assets).toHaveLength(1);
  expect(result.warnings).toEqual([]);
  const crop = result.assets[0];
  expect(crop.key).toBe("page-1/b1");
  expect(crop.mime).toBe("image/png");
  expect(crop.path).toBe(`assets/${crop.sha256}.png`);
  // vendor 页 1200x800 → PDF 300x200pt；bbox (80,120)-(400,240) → 20x30pt 起 80x30pt。
  const image = PNG.sync.read(Buffer.from(crop.bytes));
  expect(image.width).toBe(160);
  expect(image.height).toBe(60);
  expect(inkPixels(Buffer.from(crop.bytes))).toBe(160 * 60);
  const again = await cropPdfPageRegions({ pdf: inkPdf(), requests: [request()] });
  expect(again.assets[0].sha256).toBe(crop.sha256);
  expect(Buffer.from(again.assets[0].bytes).equals(Buffer.from(crop.bytes))).toBe(true);
});

test("page-crop 旋转页拒绝区域校准：仅页级事实与 warning", async () => {
  const result = await cropPdfPageRegions({
    pdf: inkPdf("/MediaBox [0 0 300 200] /Rotate 90"),
    requests: [request()],
  });
  expect(result.assets).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0].code).toBe("pdf-crop-region-uncalibrated");
  expect(result.warnings[0].sourceAlias).toBe("page-1/b1");
});

test("page-crop CropBox 与 MediaBox 不重合时拒绝区域校准", async () => {
  const result = await cropPdfPageRegions({
    pdf: inkPdf("/MediaBox [0 0 300 200] /CropBox [10 10 290 190]"),
    requests: [request()],
  });
  expect(result.assets).toEqual([]);
  expect(result.warnings[0].code).toBe("pdf-crop-region-uncalibrated");
});

test("page-crop vendor 页与 PDF 页宽高比不符时拒绝区域校准", async () => {
  const result = await cropPdfPageRegions({
    pdf: inkPdf(),
    requests: [request({ pageHeight: 900 })],
  });
  expect(result.assets).toEqual([]);
  expect(result.warnings[0].code).toBe("pdf-crop-region-uncalibrated");
});

test("page-crop bbox 越界或缺失时拒绝区域校准，不产出虚假裁剪", async () => {
  const outside = await cropPdfPageRegions({
    pdf: inkPdf(),
    requests: [request({ bbox: [80, 120, 1300, 240] })],
  });
  expect(outside.assets).toEqual([]);
  expect(outside.warnings[0].code).toBe("pdf-crop-region-uncalibrated");
  const missing = await cropPdfPageRegions({
    pdf: inkPdf(),
    requests: [request({ bbox: null })],
  });
  expect(missing.assets).toEqual([]);
  expect(missing.warnings[0].code).toBe("pdf-crop-region-uncalibrated");
});

test("page-crop 像素预算超限的单个请求降级为 warning，不拖垮其他裁剪", async () => {
  // scale 为每 PDF pt 的设备像素：整页 300x200pt × 20 → 6000x4000 = 24M 像素，超 16M 预算。
  const huge = await cropPdfPageRegions({
    pdf: inkPdf(),
    requests: [
      request({ key: "page-1/big", bbox: [0, 0, 1200, 800], scale: 20 }),
      request({ key: "page-1/b1" }),
    ],
  });
  expect(huge.assets.map((asset) => asset.key)).toEqual(["page-1/b1"]);
  expect(huge.warnings).toHaveLength(1);
  expect(huge.warnings[0].code).toBe("pdf-crop-budget-exceeded");
  expect(huge.warnings[0].sourceAlias).toBe("page-1/big");
});

test("page-crop 相同区域去重：同页同 bbox 只登记一份内容寻址资产", async () => {
  const result = await cropPdfPageRegions({
    pdf: inkPdf(),
    requests: [request(), request({ key: "page-1/b2" })],
  });
  expect(result.assets).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

test("page-crop 损坏 PDF 不抛裸异常：全部请求页级降级", async () => {
  const result = await cropPdfPageRegions({
    pdf: Buffer.from("%PDF-1.7\nbroken document\n"),
    requests: [request()],
  });
  expect(result.assets).toEqual([]);
  expect(result.warnings[0].code).toBe("pdf-crop-region-uncalibrated");
});

test("document-core 公式块接受可选原页裁剪资产引用并纳入资产校验", () => {
  const tree = testDocumentTree(PAPER_ID);
  const formulaId = "00000000-0000-4000-8000-000000000006";
  const assetPath = `assets/${"a".repeat(64)}.png`;
  tree.blocks.push({
    id: formulaId,
    sectionId: testDocumentIds.section,
    kind: "formula",
    source: { format: "latex", value: "E = mc^2" },
    text: "E = mc^2",
    asset: { path: assetPath, sha256: "a".repeat(64), mime: "image/png" },
  });
  const parsed = parseDocumentTree(tree, PAPER_ID);
  const formula = parsed.blocks.find((block) => block.id === formulaId)!;
  expect(formula.kind).toBe("formula");
  if (formula.kind !== "formula") throw new Error("formula block missing");
  expect(formula.asset?.path).toBe(assetPath);
  expect(() => validateDocumentAssets(parsed, {})).toThrow(/资产/);
  expect(() =>
    validateDocumentAssets(parsed, { [assetPath]: "a".repeat(64) }),
  ).not.toThrow();
});

test("document-core 公式块资产路径与摘要不一致时拒绝", () => {
  const tree = testDocumentTree(PAPER_ID);
  tree.blocks.push({
    id: "00000000-0000-4000-8000-000000000006",
    sectionId: testDocumentIds.section,
    kind: "formula",
    source: { format: "text", value: "x+y" },
    text: "x+y",
    asset: { path: `assets/${"b".repeat(64)}.png`, sha256: "c".repeat(64), mime: "image/png" },
  });
  expect(() => parseDocumentTree(tree, PAPER_ID)).toThrow(/SHA-256/);
});
