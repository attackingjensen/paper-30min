import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PdfTask } from "@embedpdf/models";
import type { PdfSource } from "../shared/contracts.js";
import { ProjectService } from "./project-service.js";
import { listSourceSnapshots } from "./project-core.js";
import { recordReadPdfEvidence } from "./pdf/verification.js";

/** v2 工程（formatVersion 2）的只读 PDF 适配：权威在 project-core 来源快照，
 * 按实际文件摘要匹配已发布 PDF 快照并读取受管字节；不经过旧工作台的 v1 清单假设。
 * v1 工程仍走 ProjectService.readPdf 原路径。 */
async function readPdfSource(root: string, relative: string, projects: ProjectService): Promise<PdfSource> {
  if (relative.includes("\\") || path.posix.isAbsolute(relative))
    throw new Error("需要工程内相对路径。");
  const manifestPath = path.join(root, "paper30min.json");
  if ((await fs.lstat(manifestPath)).isSymbolicLink())
    throw new Error("工程清单不能是符号链接。");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { formatVersion?: unknown };
  if (manifest.formatVersion !== 2)
    return (await projects.dispatch({ type: "readPdf", root, path: relative })) as PdfSource;
  let cursor = await fs.realpath(root);
  for (const part of relative.split("/")) {
    if (part === "." || part === ".." || part === "")
      throw new Error("需要工程内相对路径。");
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink())
      throw new Error("工程文件不能通过链接指向其他位置。");
  }
  const handle = await fs.open(cursor, "r");
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !/\.pdf$/i.test(cursor))
      throw new Error("请选择 PDF 文件。");
    if (stat.size > 128 * 1024 * 1024)
      throw new Error("PDF 超过 128 MiB 阅读预算，请在外部应用中打开。");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // 工作文件与已发布快照字节一致时读取受管副本（快照登记摘要已由 project-core 校验）。
  for (const snapshot of await listSourceSnapshots(root)) {
    if (snapshot.kind !== "pdf" || snapshot.sha256 !== sha256) continue;
    const managed = await fs.readFile(path.join(root, snapshot.path, "paper.pdf"));
    return { bytes: new Uint8Array(managed), sha256 };
  }
  return { bytes: new Uint8Array(bytes), sha256 };
}

export function createPdfTools(
  root: string,
  projects: ProjectService,
  vision: boolean,
  active: () => boolean,
  /** Agent 会话权威身份：证据绑定该 session 与工具调用 id；缺省时不签发证据。 */
  session?: { sessionId: string },
) {
  return [
    defineTool({
      name: "read_pdf",
      label: "查看 PDF 图像",
      description:
        "Visually inspect a complete PDF page in the current project, independently of the viewer and parsing. Requires a vision-enabled model. Returns a real full-page PNG, project-relative path and document ID, PDF version, page number and count, width and height in PDF points, and actual rendering scale. When the PDF matches a published source snapshot, also returns evidenceId issued by the main process for this exact rendered page; cite it when recording agent verification. Pages are 1-based. Omit page to inspect page 1. No region cropping, PDF text extraction or OCR. Read the parsed manuscript for document text.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Project-relative PDF path; normally text/paper.pdf",
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
      async execute(id, args, signal) {
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
        const source = await readPdfSource(root, args.path, projects);
        const record = source.document;
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
          // 证据与实际提供的页面字节同调用签发：摘要取本次渲染的真实 PNG。
          const evidence = session
            ? await recordReadPdfEvidence({
                root,
                pdfSha256: source.sha256,
                page: pageNumber,
                png: image,
                sessionId: session.sessionId,
                taskId: id,
              })
            : null;
          check();
          const info = {
            path: args.path,
            documentId: record?.id ?? args.path,
            sha256: source.sha256,
            page: pageNumber,
            pageCount: doc.pages.length,
            width: size.width,
            height: size.height,
            source: "PDF 原文件；PDFium 渲染，未提取文本层，未使用解析稿或 OCR",
            granularity: "页面",
            scale: actualScale,
            image: "实际 PNG 整页图，非原生 PDF 输入",
            ...(evidence ? { evidenceId: evidence.evidenceId } : {}),
          };
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
