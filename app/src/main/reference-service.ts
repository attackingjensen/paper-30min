import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PdfAnnotationName, PdfAnnotationSubtype, PdfAnnotationSubtypeName, type PdfTextAnnoObject } from "@embedpdf/models";
import type { PdfSource, Project } from "../shared/contracts.js";
import type { ResolvedCitation, CitationPage } from "../shared/citations.js";
import type { ParsingMapping, ParsingRun, ParsedBlock } from "../shared/parsing.js";
import { annotationHref, resolveAnnotationLink } from "../shared/annotation-links.js";
import type { AnnotationWriter, ReferenceRequest, ResolvedReference } from "../shared/references.js";
import type { ProjectService } from "./project-service.js";

async function openPdf(source: PdfSource) {
  const [{ init }, { PdfEngine, PdfiumNative }] = await Promise.all([
    import("@embedpdf/pdfium"), import("@embedpdf/engines/pdfium"),
  ]);
  const wasmBinary = await fs.readFile(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
  const engine = new PdfEngine(new PdfiumNative(await init({ wasmBinary })), {
    imageConverter: () => { throw new Error("引用读取不渲染图像，请使用 read_pdf。"); },
  });
  try {
    const doc = await engine.openDocumentBuffer({ id: randomUUID(), content: new Uint8Array(source.bytes).buffer },
      { normalizeRotation: true }).toPromise();
    return { engine, doc };
  } catch (error) {
    await engine.destroy().toPromise();
    throw error;
  }
}

export class ReferenceService {
  constructor(private projects: ProjectService, private writer?: AnnotationWriter) {}

  private async block(root: string, project: Project, citation: ResolvedCitation["citation"]): Promise<ParsedBlock | undefined> {
    for (const batch of await this.projects.parsingBatches(root)) {
      const run = JSON.parse((await this.projects.readParsingFile(root, batch, "run.json")).toString("utf8")) as ParsingRun;
      if (!run.mappingSha256 || run.document.id !== citation.documentId) continue;
      const bytes = await this.projects.readParsingFile(root, batch, "mapping.json");
      if (createHash("sha256").update(bytes).digest("hex") !== run.mappingSha256)
        throw new Error("解析映射已变化，不能使用其中的原文和块位置。");
      const mapping = JSON.parse(bytes.toString("utf8")) as ParsingMapping;
      if (mapping.projectId !== project.manifest.id || mapping.batchId !== batch ||
          mapping.document.id !== citation.documentId || !Array.isArray(mapping.blocks))
        throw new Error("解析映射的工程身份无效。");
      const block = mapping.blocks.find((item) => item.citation.id === citation.id);
      if (block) return block;
    }
  }

  async resolve(root: string, request: ReferenceRequest, signal?: AbortSignal): Promise<ResolvedReference> {
    signal?.throwIfAborted();
    const project = await this.projects.dispatch({ type: "refresh", root }) as Project;
    let pages: CitationPage[] = [];
    let excerpt: string | null = null;
    let excerptSource: ResolvedReference["excerptSource"] = null;
    let block: ParsedBlock | undefined;
    let target: { path: string; id: string } | undefined;
    let pdfPath: string;
    if (request.link.startsWith("paper://cite/")) {
      const resolved = await this.projects.dispatch({ type: "resolveCitation", root, link: request.link }) as ResolvedCitation;
      pdfPath = resolved.path;
      pages = resolved.citation.pages;
      if (resolved.citation.text) { excerpt = resolved.citation.text; excerptSource = "selection"; }
      block = await this.block(root, project, resolved.citation);
      if (block) {
        if (block.citation.documentId !== resolved.citation.documentId || JSON.stringify(block.citation.pages) !== JSON.stringify(pages))
          throw new Error("块位置与登记引用不一致。");
        if (!excerpt && block.text) { excerpt = block.text; excerptSource = "parser"; }
      }
    } else {
      target = resolveAnnotationLink(request.link, request.sourceDocument);
      pdfPath = target.path;
    }
    const record = [project.manifest.paper, ...project.manifest.materials].find((item) => item.path === pdfPath);
    if (!record) throw new Error("引用对应的 PDF 身份不存在，请先将 PDF 加入工程材料。");
    const source = await this.projects.dispatch({ type: "readPdf", root, path: pdfPath }) as PdfSource;
    const { engine, doc } = await openPdf(source);
    try {
      signal?.throwIfAborted();
      let annotation: ResolvedReference["annotation"];
      let comment: string | null = null;
      if (target) {
        // Native IDs are stored in the PDF, not in a parallel annotation index.
        const matches = [];
        for (const page of doc.pages) {
          signal?.throwIfAborted();
          for (const item of await engine.getPageAnnotations(doc, page).toPromise())
            if (item.id === target.id) matches.push({ item, page });
        }
        if (matches.length !== 1) throw new Error(matches.length ? "批注 ID 不唯一，无法确定目标。" : "找不到目标批注，可能已删除或 PDF 已被外部替换。");
        const { item, page } = matches[0];
        pages = [{ page: page.index + 1, width: page.size.width, height: page.size.height, rects: [item.rect] }];
        annotation = { id: item.id, type: PdfAnnotationSubtypeName[item.type] ?? String(item.type) };
        comment = item.contents ?? null;
      }
      for (const location of pages) {
        const page = doc.pages[location.page - 1];
        if (!page) throw new Error("引用页码与当前 PDF 不符。");
        if (Math.abs(page.size.width - location.width) > 0.01 || Math.abs(page.size.height - location.height) > 0.01)
          throw new Error("引用页面尺寸与当前 PDF 不符。");
      }
      signal?.throwIfAborted();
      return { kind: target ? "annotation" : "citation", status: "available", path: pdfPath,
        documentId: record.id, sha256: source.sha256, pages, excerpt, excerptSource, comment, annotation,
        ...(block ? { block: { id: block.id, label: block.label } } : {}) };
    } finally { await engine.destroy().toPromise(); }
  }

  async create(root: string, request: ReferenceRequest & { comment: string }, signal?: AbortSignal) {
    if (typeof request.comment !== "string" || !request.comment.trim() || request.comment.length > 100000)
      throw new Error("评论正文须为 1 至 100000 个字符。");
    const resolved = await this.resolve(root, request, signal);
    const page = resolved.pages[0];
    if (!resolved.block || resolved.pages.length !== 1 || !page.rects.length)
      throw new Error("定位不足：需要解析稿中已登记且具有可靠区域的块级引用，页级引用不能创建评论。");
    const anchor = page.rects[0];
    const width = Math.min(24, page.width);
    const height = Math.min(24, page.height);
    const annotation: PdfTextAnnoObject = { id: randomUUID(), type: PdfAnnotationSubtype.TEXT,
      pageIndex: page.page - 1, contents: request.comment, author: "Paper30Min Agent", name: PdfAnnotationName.Note,
      strokeColor: "#facc15", opacity: 1, flags: ["print"],
      rect: { origin: { x: Math.min(anchor.origin.x, page.width - width), y: Math.min(anchor.origin.y, page.height - height) },
        size: { width, height } } };
    signal?.throwIfAborted();
    const written = await this.writer?.({ root, path: resolved.path, sha256: resolved.sha256, annotation }, signal);
    if (!written) {
      const source = await this.projects.dispatch({ type: "readPdf", root, path: resolved.path }) as PdfSource;
      if (source.sha256 !== resolved.sha256) throw new Error("PDF 已在外部修改，请重读引用后重试。");
      const { engine, doc } = await openPdf(source);
      try {
        signal?.throwIfAborted();
        await engine.createPageAnnotation(doc, doc.pages[annotation.pageIndex], annotation).toPromise();
        const bytes = new Uint8Array(await engine.saveAsCopy(doc).toPromise());
        await this.projects.dispatch({ type: "savePdf", root, path: resolved.path, version: source.sha256, bytes }, signal);
      } finally { await engine.destroy().toPromise(); }
    }
    const link = annotationHref({ path: resolved.path, id: annotation.id });
    const persisted = await this.resolve(root, { link });
    if (persisted.comment !== request.comment) throw new Error("保存后的批注评论不一致，请核对 PDF。");
    return { link, markdown: `[PDF 第 ${page.page} 页批注](${link})`, path: resolved.path, annotationId: annotation.id };
  }
}
