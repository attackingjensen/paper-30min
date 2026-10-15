import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { fromMarkdown } from "mdast-util-from-markdown";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import type { PdfSource } from "../shared/contracts.js";
import type { Citation, CitationRect } from "../shared/citations.js";
import type {
  ParsingRun,
  ParsingMapping,
  ParsedBlock,
} from "../shared/parsing.js";
import { ProjectService } from "./project-service.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function openPdf(source: PdfSource) {
  const [{ init }, { PdfEngine, PdfiumNative }] = await Promise.all([
    import("@embedpdf/pdfium"),
    import("@embedpdf/engines/pdfium"),
  ]);
  const wasmBinary = await fs.readFile(
    new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
  );
  const engine = new PdfEngine(new PdfiumNative(await init({ wasmBinary })), {
    imageConverter: async (getImage) => {
      const image = getImage();
      const png = new PNG({ width: image.width, height: image.height });
      png.data = Buffer.from(image.data);
      return PNG.sync.write(png);
    },
  });
  try {
    const doc = await engine
      .openDocumentBuffer(
        { id: randomUUID(), content: new Uint8Array(source.bytes).buffer },
        { normalizeRotation: true },
      )
      .toPromise();
    if (!doc.pages.length || doc.pages.length > 1000)
      throw new Error("解析 PDF 页数须为 1 至 1000 页。");
    return { engine, doc };
  } catch (error) {
    await engine.destroy().toPromise();
    throw error;
  }
}

export async function checkParsingPdf(source: PdfSource) {
  const { engine, doc } = await openPdf(source);
  try {
    return doc.pages.length;
  } finally {
    await engine.destroy().toPromise();
  }
}

export async function buildCandidate({
  root,
  run,
  source,
  raw,
  projects,
  signal,
  download,
  progress,
}: {
  root: string;
  run: ParsingRun;
  source: PdfSource;
  raw: Buffer;
  projects: ProjectService;
  signal: AbortSignal;
  download: (url: string) => Promise<Buffer>;
  progress: (completed: number, count: number) => Promise<void>;
}) {
  const pages: any[] = [];
  const seen = new Set<string>();
  for (const line of raw
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error("百度原始结果不是有效 JSONL。");
    }
    const list = row.result?.layoutParsingResults;
    const info = row.result?.dataInfo;
    if (
      (row.errorCode !== undefined && row.errorCode !== 0) ||
      !Array.isArray(list) ||
      info?.type !== "pdf" ||
      info.numPages !== list.length ||
      !Array.isArray(info.pages) ||
      info.pages.length !== list.length
    )
      throw new Error("百度 JSONL 缺少完整的批次页数和页面信息。");
    for (const [index, page] of list.entries()) {
      const data = page.prunedResult;
      if (
        !data ||
        data.width !== info.pages[index].width ||
        data.height !== info.pages[index].height ||
        !Number.isFinite(data.width) ||
        !Number.isFinite(data.height) ||
        data.width <= 0 ||
        data.height <= 0 ||
        !Array.isArray(data.parsing_res_list) ||
        data.parsing_res_list.length > 10000
      )
        throw new Error("百度页面尺寸或块列表无效。");
      const digest = hash(Buffer.from(JSON.stringify(data)));
      if (
        seen.has(digest) &&
        data.parsing_res_list.some((block: any) => block.block_content?.trim())
      )
        throw new Error("百度返回了重复的非空页面。");
      seen.add(digest);
      pages.push(page);
    }
  }
  const { engine, doc } = await openPdf(source);
  try {
    if (pages.length !== doc.pages.length)
      throw new Error("百度返回页数与原 PDF 不完整匹配。");
    const mapping: ParsingMapping = {
      formatVersion: 1,
      projectId: run.projectId,
      batchId: run.batchId,
      document: run.document,
      rawSha256: hash(raw),
      blocks: [],
      images: [],
    };
    const markdown: string[] = [
      "# 解析候选",
      "",
      "> 待 Agent 审阅；OCR 正文与区域可能存在误差。",
      "",
    ];
    const tableMarkdown = new TurndownService();
    tableMarkdown.use(tables);
    let totalImages = 0;
    const saveImage = async (
      bytes: Buffer,
      page: number,
      metadata: { vendorPath?: string; blockId?: string } = {},
    ) => {
      signal.throwIfAborted();
      totalImages += bytes.length;
      if (bytes.length > 32 * 1024 * 1024 || totalImages > 256 * 1024 * 1024)
        throw new Error("解析图片超过本机大小预算。");
      let extension: string;
      if (
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ) {
        if (
          bytes.length < 24 ||
          bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000
        )
          throw new Error("解析图片尺寸超过预算。");
        PNG.sync.read(bytes);
        extension = "png";
      } else if (
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255 &&
        bytes.at(-2) === 255 &&
        bytes.at(-1) === 217
      )
        extension = "jpg";
      else throw new Error("解析图片需要完整 PNG 或 JPEG。");
      const sha256 = hash(bytes);
      const file = `images/${sha256}.${extension}`;
      await projects.writeParsingFile(root, run.batchId, file, bytes, signal);
      mapping.images.push({ path: file, sha256, page, ...metadata });
      return file;
    };
    for (const [pageIndex, vendorPage] of pages.entries()) {
      signal.throwIfAborted();
      const page = doc.pages[pageIndex];
      const data = vendorPage.prunedResult;
      const pageNumber = pageIndex + 1;
      const images = new Map<string, string>();
      if (vendorPage.markdown?.images != null) {
        if (
          typeof vendorPage.markdown.images !== "object" ||
          Array.isArray(vendorPage.markdown.images)
        )
          throw new Error("百度图片清单无效。");
        for (const [vendorPath, value] of Object.entries(
          vendorPage.markdown.images,
        )) {
          if (typeof value !== "string") throw new Error("百度图片内容无效。");
          const bytes = /^https?:\/\//i.test(value)
            ? await download(value)
            : Buffer.from(
                value.replace(/^data:image\/\w+;base64,/, ""),
                "base64",
              );
          images.set(
            vendorPath,
            await saveImage(bytes, pageNumber, { vendorPath }),
          );
        }
      }
      // Rewrite only parsed image nodes. Code examples and ordinary links stay intact.
      const localImages = (text: string, used?: string[]) => {
        const tree = fromMarkdown(text);
        const edits: { start: number; end: number; text: string }[] = [];
        const definitions = new Map<string, string>();
        const walk = (node: any, visit: (node: any) => void) => {
          visit(node);
          node.children?.forEach((child: any) => walk(child, visit));
        };
        walk(tree, (node) => {
          if (node.type === "definition")
            definitions.set(node.identifier, node.url);
        });
        walk(tree, (node) => {
          if (node.type !== "image" && node.type !== "imageReference") return;
          const url =
            node.type === "image" ? node.url : definitions.get(node.identifier);
          const image = images.get(url);
          if (!image)
            throw new Error("正文图片未在百度图片清单中找到，候选尚不完整。");
          if (used && !used.includes(image)) used.push(image);
          edits.push({
            start: node.position.start.offset,
            end: node.position.end.offset,
            text: `![${String(node.alt ?? "图片").replace(/[\[\]\\]/g, "\\$&")}](${image})`,
          });
        });
        for (const edit of edits.sort((a, b) => b.start - a.start))
          text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        return text;
      };
      if (typeof vendorPage.markdown?.text === "string")
        await projects.writeParsingFile(
          root,
          run.batchId,
          `page-${pageNumber}.md`,
          Buffer.from(localImages(vendorPage.markdown.text)),
          signal,
        );
      const groups: any[][] = [];
      const grouped = new Map<number, any[]>();
      const ids = new Set<number>();
      let previousOrder = -1;
      for (const item of data.parsing_res_list) {
        if (
          !Number.isSafeInteger(item.block_id) ||
          item.block_id < 0 ||
          ids.has(item.block_id) ||
          typeof item.block_label !== "string" ||
          typeof item.block_content !== "string"
        )
          throw new Error("百度块身份、标签或正文无效。");
        ids.add(item.block_id);
        if (item.block_order != null) {
          if (
            !Number.isSafeInteger(item.block_order) ||
            item.block_order <= previousOrder
          )
            throw new Error("百度块阅读顺序无效。");
          previousOrder = item.block_order;
        }
        const group =
          Number.isSafeInteger(item.group_id) && item.group_id >= 0
            ? grouped.get(item.group_id)
            : undefined;
        if (group) {
          if (group[0].block_label !== item.block_label)
            throw new Error("百度同一分组混用了不同块类型。");
          group.push(item);
        } else {
          const created = [item];
          groups.push(created);
          if (Number.isSafeInteger(item.group_id) && item.group_id >= 0)
            grouped.set(item.group_id, created);
        }
      }
      markdown.push(`## 第 ${pageNumber} 页`, "");
      const crop = page.boxes?.crop;
      const media = page.boxes?.media;
      const calibrated =
        page.rotation === 0 &&
        crop &&
        media &&
        crop.left === 0 &&
        crop.bottom === 0 &&
        media.left === 0 &&
        media.bottom === 0 &&
        crop.right === media.right &&
        crop.top === media.top &&
        data.model_settings?.use_doc_preprocessor === false &&
        Math.abs(
          data.width / data.height / (page.size.width / page.size.height) - 1,
        ) < 0.002;
      for (const group of groups) {
        signal.throwIfAborted();
        const first = group[0];
        const text = group
          .map((item) => item.block_content)
          .filter(Boolean)
          .join("\n");
        const visual = ["image", "chart", "table", "display_formula"].includes(
          first.block_label,
        );
        if (!text.trim() && !visual) continue;
        const rects: CitationRect[] = [];
        if (calibrated)
          for (const item of group) {
            const b = item.block_bbox;
            if (
              !Array.isArray(b) ||
              b.length !== 4 ||
              !b.every(Number.isFinite) ||
              b[0] < 0 ||
              b[1] < 0 ||
              b[2] <= b[0] ||
              b[3] <= b[1] ||
              b[2] > data.width ||
              b[3] > data.height
            )
              break;
            rects.push({
              origin: {
                x: (b[0] / data.width) * page.size.width,
                y: (b[1] / data.height) * page.size.height,
              },
              size: {
                width: ((b[2] - b[0]) / data.width) * page.size.width,
                height: ((b[3] - b[1]) / data.height) * page.size.height,
              },
            });
          }
        if (rects.length !== group.length) rects.length = 0;
        const id = `${run.batchId}:p${pageNumber}:b${first.block_id}`;
        const citation = (await projects.dispatch(
          {
            type: "createCitation",
            root,
            path: run.document.path,
            input: {
              sha256: run.document.sha256,
              text: "",
              kind: rects.length ? "region" : "page",
              pages: [
                {
                  page: pageNumber,
                  width: page.size.width,
                  height: page.size.height,
                  rects,
                },
              ],
            },
          },
          signal,
        )) as Citation;
        const block: ParsedBlock = {
          id,
          label: first.block_label,
          text,
          vendorIds: group.map((item) => item.block_id),
          citation,
          images: [],
          limitation: rects.length
            ? "OCR 块区域，非逐字精确选区"
            : "坐标未通过校准，仅页级定位",
        };
        const htmlTable =
          first.block_label === "table" && text.trim().startsWith("<");
        const body = localImages(
          htmlTable ? tableMarkdown.turndown(text) : text,
          block.images,
        );
        const cropped: string[] = [];
        if (visual && rects.length)
          for (const region of rects) {
            const task = engine.renderPageRect(doc, page, region, {
              scaleFactor: Math.min(
                2,
                2048 / Math.max(region.size.width, region.size.height),
              ),
              rotation: 0,
              dpr: 1,
            });
            const abort = () =>
              task.abort({ code: 0, message: "已停止解析。" });
            signal.addEventListener("abort", abort, { once: true });
            try {
              const image = await saveImage(
                Buffer.from(await task.toPromise()),
                pageNumber,
                { blockId: id },
              );
              block.images.push(image);
              cropped.push(image);
            } finally {
              signal.removeEventListener("abort", abort);
            }
          }
        mapping.blocks.push(block);
        markdown.push(
          `块 ID：${id}`,
          "",
          `[${rects.length ? "块级引用" : "页级引用"} · 第 ${pageNumber} 页](paper://cite/${citation.id})`,
          "",
        );
        if (["doc_title", "paragraph_title"].includes(first.block_label))
          markdown.push(`### ${body.replace(/\s+/g, " ")}`, "");
        else if (htmlTable)
          markdown.push(
            body,
            "",
            "> 表格结构以原图为准；原始表格保存在块 JSON 中。",
            "",
          );
        else if (text) markdown.push(body, "");
        for (const image of cropped)
          markdown.push(
            `![第 ${pageNumber} 页 ${first.block_label} 原图](${image})`,
            "",
          );
        if (!rects.length) markdown.push("> 仅页级定位，未生成推测区域。", "");
      }
      // Preserve every vendor image even when its relation to a block is unavailable.
      for (const [vendorPath, image] of images)
        markdown.push(
          `![第 ${pageNumber} 页解析图片](${image})`,
          "",
          `图片来源：${vendorPath.replace(/[\r\n]/g, " ")}（页级关联）`,
          "",
        );
      await progress(pageNumber, pages.length);
    }
    const body = markdown.join("\n");
    if (Buffer.byteLength(body) > 2 * 1024 * 1024)
      throw new Error("候选正文超过当前 2 MiB 阅读预算，原始结果已保存。");
    return { mapping, markdown: body };
  } finally {
    await engine.destroy().toPromise();
  }
}
