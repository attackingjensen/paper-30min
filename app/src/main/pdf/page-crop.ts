import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import type { PdfDocumentObject, PdfTask } from "@embedpdf/models";
import type { ImportDiagnostic } from "../../shared/arxiv.js";
import { validateRevisionAssetBudget } from "../project-core.js";

/** 原页裁切（SPEC-pdf-import §4.6/§6.7）：仅无旋转、CropBox=MediaBox、
 * 宽高比可校准且 bbox 有效的页面产出候选裁剪图；不可校准时只声明页级事实。
 * 派生资产由调用方写入候选 revision，本模块不回写原始 PDF 或解析快照。 */

const PIXEL_BUDGET = 16_000_000;
/** 每 PDF pt 的设备像素；未指定时按此倍率渲染。 */
const DEFAULT_SCALE = 2;
/** 宽高比相对容差：过滤浮点噪声，不放宽真实几何差异。 */
const ASPECT_TOLERANCE = 0.005;
const BOX_EPSILON = 0.01;

export interface PdfCropRequest {
  /** 块来源别名（page-N/bM）；诊断与资产归属键。 */
  key: string;
  /** 1 起始页码。 */
  page: number;
  /** vendor 解析页像素尺寸。 */
  pageWidth: number;
  pageHeight: number;
  /** vendor top-left 坐标 [x0, y0, x1, y1]；null 表示无区域事实。 */
  bbox: [number, number, number, number] | null;
  /** 每 PDF pt 设备像素；缺省 2。 */
  scale?: number;
}

export interface PdfCropAsset {
  key: string;
  path: string;
  sha256: string;
  mime: "image/png";
  bytes: Uint8Array;
}

export interface PdfCropResult {
  assets: PdfCropAsset[];
  /** key（每个块别名）→ 资产；同区域别名共享同一内容寻址资产，assets 仍按内容去重。 */
  assetByKey: Map<string, PdfCropAsset>;
  warnings: ImportDiagnostic[];
}

const MESSAGE_KEYS: Record<string, string> = {
  "pdf-crop-region-uncalibrated": "pdf.crop.regionUncalibrated",
  "pdf-crop-budget-exceeded": "pdf.crop.budgetExceeded",
  "pdf-crop-render-failed": "pdf.crop.renderFailed",
};

function warning(code: string, key: string): ImportDiagnostic {
  return {
    code,
    severity: "warning",
    stage: "convert",
    messageKey: MESSAGE_KEYS[code],
    sourceAlias: key,
  };
}

interface PageBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxEquals(a: PageBox, b: PageBox): boolean {
  return (
    Math.abs(a.left - b.left) <= BOX_EPSILON &&
    Math.abs(a.top - b.top) <= BOX_EPSILON &&
    Math.abs(a.right - b.right) <= BOX_EPSILON &&
    Math.abs(a.bottom - b.bottom) <= BOX_EPSILON
  );
}

/** 区域可校准判定：任一事实缺失或不一致都拒绝，不产出虚假区域保证。 */
function calibrate(
  request: PdfCropRequest,
  page: {
    size: { width: number; height: number };
    rotation: number;
    boxes?: { media: PageBox; crop: PageBox };
  },
): { x: number; y: number; width: number; height: number } | null {
  if (page.rotation !== 0 || !page.boxes) return null;
  if (!boxEquals(page.boxes.media, page.boxes.crop)) return null;
  const { width: pdfWidth, height: pdfHeight } = page.size;
  if (!(pdfWidth > 0) || !(pdfHeight > 0)) return null;
  const vendorAspect = request.pageWidth / request.pageHeight;
  const pdfAspect = pdfWidth / pdfHeight;
  if (!Number.isFinite(vendorAspect) || Math.abs(vendorAspect - pdfAspect) > ASPECT_TOLERANCE * pdfAspect) return null;
  const bbox = request.bbox;
  if (
    !bbox ||
    !bbox.every((coordinate) => Number.isFinite(coordinate)) ||
    bbox[0] < 0 ||
    bbox[1] < 0 ||
    bbox[2] > request.pageWidth ||
    bbox[3] > request.pageHeight ||
    bbox[2] <= bbox[0] ||
    bbox[3] <= bbox[1]
  )
    return null;
  const scaleX = pdfWidth / request.pageWidth;
  const scaleY = pdfHeight / request.pageHeight;
  return {
    x: bbox[0] * scaleX,
    y: bbox[1] * scaleY,
    width: (bbox[2] - bbox[0]) * scaleX,
    height: (bbox[3] - bbox[1]) * scaleY,
  };
}

export async function cropPdfPageRegions(input: {
  pdf: Uint8Array;
  requests: PdfCropRequest[];
  signal?: AbortSignal;
  /** 渲染失败注入（测试与故障演练）；生产路径不设置。 */
  renderFailure?: (key: string) => boolean;
}): Promise<PdfCropResult> {
  const assets: PdfCropAsset[] = [];
  const warnings: ImportDiagnostic[] = [];
  const assetByKey = new Map<string, PdfCropAsset>();
  if (!input.requests.length) return { assets, assetByKey, warnings };
  const uncalibrated = (key: string) => {
    warnings.push(warning("pdf-crop-region-uncalibrated", key));
  };
  const wasmBinary = await fs.readFile(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
  const [{ init }, { PdfEngine, PdfiumNative }] = await Promise.all([
    import("@embedpdf/pdfium"),
    import("@embedpdf/engines/pdfium"),
  ]);
  input.signal?.throwIfAborted();
  // 每次调用独占 PDFium 实例；不缓存页面图像，派生资产以内容摘要寻址。
  const engine = new PdfEngine(new PdfiumNative(await init({ wasmBinary })), {
    imageConverter: async (getImage) => {
      input.signal?.throwIfAborted();
      const image = getImage();
      const png = new PNG({ width: image.width, height: image.height });
      png.data = Buffer.from(image.data);
      return PNG.sync.write(png);
    },
  });
  try {
    const task = <T>(value: PdfTask<T>) => value.toPromise();
    let doc: PdfDocumentObject;
    try {
      doc = await task(
        engine.openDocumentBuffer(
          {
            id: randomUUID(),
            content: input.pdf.buffer.slice(
              input.pdf.byteOffset,
              input.pdf.byteOffset + input.pdf.byteLength,
            ) as ArrayBuffer,
          },
          // 不做旋转归一化：旋转页必须按原始事实拒绝校准。
          { normalizeRotation: false },
        ),
      );
    } catch {
      for (const request of input.requests) uncalibrated(request.key);
      return { assets, assetByKey, warnings };
    }
    const byPath = new Map<string, PdfCropAsset>();
    for (const request of input.requests) {
      input.signal?.throwIfAborted();
      const page = doc.pages[request.page - 1];
      if (!page) {
        uncalibrated(request.key);
        continue;
      }
      const rect = calibrate(request, page);
      if (!rect) {
        uncalibrated(request.key);
        continue;
      }
      const scale = request.scale ?? DEFAULT_SCALE;
      if (!Number.isFinite(scale) || scale <= 0) {
        uncalibrated(request.key);
        continue;
      }
      const deviceWidth = Math.max(1, Math.round(rect.width * scale));
      const deviceHeight = Math.max(1, Math.round(rect.height * scale));
      if (deviceWidth * deviceHeight > PIXEL_BUDGET) {
        warnings.push(warning("pdf-crop-budget-exceeded", request.key));
        continue;
      }
      let png: Uint8Array;
      try {
        input.signal?.throwIfAborted();
        if (input.renderFailure?.(request.key)) throw new Error("pdf-crop-render-failed");
        png = await task(
          engine.renderPageRect(
            doc,
            page,
            {
              origin: { x: rect.x, y: rect.y },
              size: { width: rect.width, height: rect.height },
            },
            { scaleFactor: scale, rotation: 0, dpr: 1 },
          ),
        );
      } catch {
        // 单请求渲染失败降级 warning，不拖垮整篇导入；本机中断继续抛出。
        input.signal?.throwIfAborted();
        warnings.push(warning("pdf-crop-render-failed", request.key));
        continue;
      }
      const sha256 = createHash("sha256").update(png).digest("hex");
      const relative = `assets/${sha256}.png`;
      const shared = byPath.get(relative);
      if (shared) {
        // 相同区域不同块别名：共享同一内容寻址资产，只登记一次，但每个别名都可引用。
        assetByKey.set(request.key, shared);
        continue;
      }
      try {
        validateRevisionAssetBudget([
          ...[...byPath.values()].map((entry) => ({ path: entry.path, size: entry.bytes.byteLength })),
          { path: relative, size: png.byteLength },
        ]);
      } catch {
        warnings.push(warning("pdf-crop-budget-exceeded", request.key));
        continue;
      }
      const asset: PdfCropAsset = {
        key: request.key,
        path: relative,
        sha256,
        mime: "image/png",
        bytes: new Uint8Array(png),
      };
      byPath.set(relative, asset);
      assetByKey.set(request.key, asset);
      assets.push(asset);
    }
    return { assets, assetByKey, warnings };
  } finally {
    try {
      await engine.closeAllDocuments().toPromise();
    } finally {
      await engine.destroy().toPromise();
    }
  }
}
