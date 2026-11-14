import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PdfTask } from "@embedpdf/models";
import type { PdfSource } from "../shared/contracts.js";
import { ProjectService } from "./project-service.js";

export function createPdfTools(
  root: string,
  projects: ProjectService,
  vision: boolean,
  active: () => boolean,
  onRead?: (documentId: string, page: number) => void,
) {
  return [
    defineTool({
      name: "read_pdf",
      label: "查看 PDF 图像",
      description:
        "Visually inspect a complete PDF page in the current project, independently of the viewer and parsing. Requires a vision-enabled model. Returns a real full-page PNG, registered path and document ID, PDF version, page number and count, width and height in PDF points, and actual rendering scale. Pages are 1-based. Omit page to inspect page 1. Does not create or return citations or links. No region cropping, PDF text extraction or OCR. Read the parsed manuscript for document text and reuse its existing citation links when available; never invent links, citation IDs or coordinates.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Project-relative registered PDF path; normally text/paper.pdf",
        }),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        scale: Type.Optional(
          Type.Number({
            minimum: 0.5,
            maximum: 4,
            description:
              "Pixels per PDF point; default 1.5; maximum image edge 2048 pixels. Always renders the complete page.",
          }),
        ),
      }),
      async execute(_id, args, signal) {
        const check = () => {
          signal?.throwIfAborted();
          if (!active()) throw new Error("任务已停止。");
        };
        const task = async <T>(value: PdfTask<T>) => {
          const abort = () => value.abort({ code: 0, message: "任务已停止。" });
          signal?.addEventListener("abort", abort, { once: true });
          try {
            check();
            const result = await value.toPromise();
            check();
            return result;
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        };
        check();
        if (!vision)
          throw new Error(
            "read_pdf 需要支持视觉输入的模型，请切换模型并启用视觉输入；不提供文本层降级。",
          );
        const source = (await projects.dispatch({
          type: "readPdf",
          root,
          path: args.path,
        })) as PdfSource;
        const record = source.document;
        if (!record)
          throw new Error("PDF 身份不存在，请先将 PDF 加入工程材料。");
        check();
        const pageNumber = args.page ?? 1;
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1)
          throw new Error("PDF 页码必须是从 1 开始的整数。");
        const scale = args.scale ?? 1.5;
        if (!Number.isFinite(scale) || scale < 0.5 || scale > 4)
          throw new Error("图像放大比例必须在 0.5 到 4 之间。");
        const wasmBinary = await fs.readFile(
          new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
        );
        const [{ init }, { PdfEngine, PdfiumNative }] = await Promise.all([
          import("@embedpdf/pdfium"),
          import("@embedpdf/engines/pdfium"),
        ]);
        check();
        // Each call owns its PDFium instance and images. Nothing survives project
        // switches, and no stale page-image cache can outlive a PDF version.
        const engine = new PdfEngine(
          new PdfiumNative(await init({ wasmBinary })),
          {
            imageConverter: async (getImage) => {
              check();
              const image = getImage();
              const png = new PNG({ width: image.width, height: image.height });
              png.data = Buffer.from(image.data);
              return PNG.sync.write(png);
            },
          },
        );
        try {
          const doc = await task(
            engine.openDocumentBuffer(
              {
                id: randomUUID(),
                content: source.bytes.buffer.slice(
                  source.bytes.byteOffset,
                  source.bytes.byteOffset + source.bytes.byteLength,
                ) as ArrayBuffer,
              },
              { normalizeRotation: true },
            ),
          ).catch((error: Error) => {
            check();
            throw new Error(
              `PDF 打开失败（文件可能损坏或需要密码）：${error.message}`,
            );
          });
          const page = doc.pages[pageNumber - 1];
          if (!page)
            throw new Error(`PDF 页码越界：共 ${doc.pages.length} 页。`);
          const size = page.size;
          const actualScale = Math.min(
            scale,
            2048 / Math.max(size.width, size.height),
          );
          const image = await task(
            engine.renderPage(doc, page, {
              scaleFactor: actualScale,
              rotation: 0,
              dpr: 1,
            }),
          );
          check();
          const info = {
            path: args.path,
            documentId: record.id,
            sha256: source.sha256,
            page: pageNumber,
            pageCount: doc.pages.length,
            width: size.width,
            height: size.height,
            source: "PDF 原文件；PDFium 渲染，未提取文本层，未使用解析稿或 OCR",
            granularity: "页面",
            scale: actualScale,
            image: "实际 PNG 整页图，非原生 PDF 输入",
          };
          onRead?.(record.id, pageNumber);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(info) },
              {
                type: "image" as const,
                mimeType: "image/png",
                data: image.toString("base64"),
              },
            ],
            details: { pdf: info },
          };
        } finally {
          try {
            await engine.closeAllDocuments().toPromise();
          } finally {
            await engine.destroy().toPromise();
          }
        }
      },
    }),
  ];
}
