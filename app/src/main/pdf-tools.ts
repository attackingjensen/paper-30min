import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PdfTask } from "@embedpdf/models";
import type { PdfSource, Project } from "../shared/contracts.js";
import {
  citationLink,
  citationMarkdown,
  validateCitation,
  type Citation,
  type CitationRect,
} from "../shared/citations.js";
import { ProjectService } from "./project-service.js";

export function createPdfTools(
  root: string,
  projects: ProjectService,
  vision: boolean,
  active: () => boolean,
) {
  return [
    defineTool({
      name: "read_pdf",
      label: "读取 PDF 原文",
      description:
        "Read an actual PDF page or magnified region in the current project, independently of the viewer and parsing. Returns page count, available PDF text, a real PNG for vision models, and an application-issued citation link. Pages are 1-based; region is unrotated top-left PDF points, never viewport coordinates. Omit page to inspect page 1 and document metadata. Reuse returned links verbatim; never invent citation IDs. Scanned pages have no text layer (no OCR).",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Project-relative registered PDF path; normally text/paper.pdf",
        }),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        region: Type.Optional(
          Type.Object({
            x: Type.Number(),
            y: Type.Number(),
            width: Type.Number(),
            height: Type.Number(),
          }),
        ),
        scale: Type.Optional(
          Type.Number({
            minimum: 0.5,
            maximum: 4,
            description:
              "Pixels per PDF point; default 1.5 for pages, 3 for regions; maximum image edge 2048 pixels",
          }),
        ),
        sha256: Type.Optional(
          Type.String({
            description:
              "Expected PDF version from a previous read; reject replacement",
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
        const project = (await projects.dispatch({
          type: "refresh",
          root,
        })) as Project;
        const record = [
          project.manifest.paper,
          ...project.manifest.materials,
        ].find((item) => item.path === args.path);
        if (!record)
          throw new Error("PDF 身份不存在，请先将 PDF 加入工程材料。");
        const source = (await projects.dispatch({
          type: "readPdf",
          root,
          path: args.path,
        })) as PdfSource;
        check();
        if (
          source.sha256 !== record.sha256 ||
          (args.sha256 && source.sha256 !== args.sha256)
        )
          throw new Error("PDF 版本不一致，文件已被替换，不能读取旧引用。");
        const pageNumber = args.page ?? 1;
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1)
          throw new Error("PDF 页码必须是从 1 开始的整数。");
        const scale = args.scale ?? (args.region ? 3 : 1.5);
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
          const region: CitationRect | undefined = args.region && {
            origin: { x: args.region.x, y: args.region.y },
            size: { width: args.region.width, height: args.region.height },
          };
          const input = {
            sha256: source.sha256,
            kind: region ? ("region" as const) : ("page" as const),
            text: "",
            pages: [
              {
                page: pageNumber,
                width: page.size.width,
                height: page.size.height,
                rects: region ? [region] : [],
              },
            ],
          };
          validateCitation(input);
          const textRects = await task(engine.getPageTextRects(doc, page));
          const text = textRects
            .filter(
              ({ rect }) =>
                !region ||
                (rect.origin.x >= region.origin.x &&
                  rect.origin.y >= region.origin.y &&
                  rect.origin.x + rect.size.width <=
                    region.origin.x + region.size.width &&
                  rect.origin.y + rect.size.height <=
                    region.origin.y + region.size.height),
            )
            .map((item) => item.content)
            .join("\n");
          const size = region?.size ?? page.size;
          const actualScale = Math.min(
            scale,
            2048 / Math.max(size.width, size.height),
          );
          const image = vision
            ? await task(
                region
                  ? engine.renderPageRect(doc, page, region, {
                      scaleFactor: actualScale,
                      rotation: 0,
                      dpr: 1,
                    })
                  : engine.renderPage(doc, page, {
                      scaleFactor: actualScale,
                      rotation: 0,
                      dpr: 1,
                    }),
              )
            : undefined;
          check();
          const citation = (await projects.dispatch(
            { type: "createCitation", root, path: args.path, input },
            signal,
          )) as Citation;
          check();
          const info = {
            path: args.path,
            documentId: record.id,
            sha256: source.sha256,
            page: pageNumber,
            pageCount: doc.pages.length,
            citation,
            link: citationLink(citation.id),
            markdown: citationMarkdown(citation),
            source: "PDF 原文件；PDFium 渲染与文本层提取，未使用解析稿或 OCR",
            granularity: region ? "区域" : "页面",
            scale: image ? actualScale : undefined,
            image: image
              ? "实际 PNG 页图/裁切图，非原生 PDF 输入"
              : "当前模型未启用视觉输入，仅返回文本；如需核对图表请切换支持视觉输入的模型。",
            textStatus: text.trim()
              ? "仅提取完整落在读取区域内的文本块，阅读顺序与公式可能不完整，请核对图像。"
              : "此页或区域无可用文本层，可能为扫描页或纯图像；未执行 OCR。",
            text: text.slice(0, 24000),
            textTruncated: text.length > 24000,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(info) },
              ...(image
                ? [
                    {
                      type: "image" as const,
                      mimeType: "image/png",
                      data: image.toString("base64"),
                    },
                  ]
                : []),
            ],
            details: { pdf: { ...info, text: undefined } },
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
