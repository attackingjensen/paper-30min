import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PdfAnnotationName, PdfAnnotationSubtype, PdfAnnotationSubtypeName, type PdfTextAnnoObject, type PdfAnnotationObject } from "@embedpdf/models";
import type { PdfSource, Project } from "../shared/contracts.js";
import type { ResolvedCitation, CitationPage } from "../shared/citations.js";
import type { ParsingMapping, ParsingRun, ParsedBlock } from "../shared/parsing.js";
import { annotationHref, resolveAnnotationLink } from "../shared/annotation-links.js";
import type { AnnotationWriter, ReferenceRequest, ResolvedReference } from "../shared/references.js";
import type { ProjectService } from "./project-service.js";
import { canReusePdfEvidence } from "../shared/pdf-versions.js";
import { matchBlocks, manuscriptLocations } from "./reference-context.js";

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

  private async mappings(root: string, project: Project, document: NonNullable<PdfSource["document"]>) {
    const result: { run: ParsingRun; blocks: ParsedBlock[] }[] = [];
    for (const batch of await this.projects.parsingBatches(root)) {
      const run = JSON.parse((await this.projects.readParsingFile(root, batch, "run.json")).toString("utf8")) as ParsingRun;
      if (!run.mappingSha256 || run.phase !== "candidate" || run.document.id !== document.id || run.document.sha256 !== document.sha256) continue;
      const bytes = await this.projects.readParsingFile(root, batch, "mapping.json");
      if (createHash("sha256").update(bytes).digest("hex") !== run.mappingSha256)
        throw new Error("解析映射已变化，不能使用其中的原文和块位置。");
      const mapping = JSON.parse(bytes.toString("utf8")) as ParsingMapping;
      if (mapping.projectId !== project.manifest.id || mapping.batchId !== batch ||
          mapping.document.id !== document.id || !Array.isArray(mapping.blocks))
        throw new Error("解析映射的工程身份无效。");
      result.push({ run, blocks: mapping.blocks });
    }
    return result.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  }

  async resolve(root: string, request: ReferenceRequest, signal?: AbortSignal) {
    return (await this.resolveSource(root, request, signal)).reference;
  }

  private async resolveSource(root: string, request: ReferenceRequest, signal?: AbortSignal): Promise<{ reference: ResolvedReference; source: PdfSource }> {
    signal?.throwIfAborted();
    const project = await this.projects.dispatch({ type: "refresh", root }) as Project;
    let pages: CitationPage[] = [];
    let excerpt: string | null = null;
    let excerptSource: ResolvedReference["excerptSource"] = null;
    let block: ParsedBlock | undefined;
    let target: { path: string; id: string } | undefined;
    let expectedDocumentId: string | undefined;
    let citation: ResolvedCitation["citation"] | undefined;
    let pdfPath: string;
    if (request.link.startsWith("paper://cite/")) {
      const resolved = await this.projects.dispatch({ type: "resolveCitation", root, link: request.link }) as ResolvedCitation;
      pdfPath = resolved.path;
      expectedDocumentId = resolved.citation.documentId;
      citation = resolved.citation;
      pages = resolved.citation.pages;
      if (resolved.citation.text) { excerpt = resolved.citation.text; excerptSource = "selection"; }
    } else {
      target = resolveAnnotationLink(request.link, request.sourceDocument);
      pdfPath = target.path;
    }
    const source = await this.projects.dispatch({ type: "readPdf", root, path: pdfPath }) as PdfSource;
    const record = source.document;
    if (!record) throw new Error("引用对应的 PDF 身份不存在，请先将 PDF 加入工程材料。");
    if (expectedDocumentId && record.id !== expectedDocumentId) throw new Error("引用对应的 PDF 身份已变化。");
    const mappings = await this.mappings(root, project, record);
    const mapped = citation && mappings.find(m => m.blocks.some(b => b.citation.id === citation!.id));
    const mapping = mapped || mappings[0];
    block = mapped?.blocks.find(b => b.citation.id === citation!.id);
    if (block && JSON.stringify(block.citation.pages) !== JSON.stringify(pages)) throw new Error("块位置与登记引用不一致。");
    const { engine, doc } = await openPdf(source);
    try {
      signal?.throwIfAborted();
      let annotation: ResolvedReference["annotation"];
      let comment: string | null = null;
      const warnings: string[] = [];
      const annotations: PdfAnnotationObject[] = [];
      for (const page of doc.pages) {
        signal?.throwIfAborted();
        annotations.push(...await engine.getPageAnnotations(doc, page).toPromise());
      }
      const byId = new Map<string, PdfAnnotationObject>();
      for (const item of annotations) {
        if (byId.has(item.id)) throw new Error("批注 ID 不唯一，无法确定讨论关系。");
        byId.set(item.id, item);
      }
      const rootOf = (item: PdfAnnotationObject) => {
        const visited = new Set<string>();
        while (item.inReplyToId) {
          if (visited.has(item.id)) {
            warnings.push(`批注 ${item.id} 的回复关系成环。`);
            return { key: `cycle:${[...visited].slice([...visited].indexOf(item.id)).sort()[0]}`, status: "cycle" as const };
          }
          visited.add(item.id);
          const parent = byId.get(item.inReplyToId);
          if (!parent) {
            warnings.push(`批注 ${item.id} 的父批注 ${item.inReplyToId} 缺失。`);
            return { key: `missing:${item.inReplyToId}`, status: "missing-parent" as const };
          }
          item = parent;
        }
        return { key: item.id, root: item, status: "complete" as const };
      };
      const annotationPages = (item: PdfAnnotationObject): CitationPage[] => {
        const p = doc.pages[item.pageIndex];
        const rects = "segmentRects" in item && Array.isArray(item.segmentRects) && item.segmentRects.length ? item.segmentRects : [item.rect];
        return [{ page: p.index + 1, width: p.size.width, height: p.size.height, rects }];
      };
      let targetRoot: PdfAnnotationObject | undefined;
      let targetGroup: string | undefined;
      if (target) {
        // Native IDs are stored in the PDF, not in a parallel annotation index.
        const item = byId.get(target.id);
        if (!item) throw new Error("找不到目标批注，可能已删除或 PDF 已被外部替换。");
        const relation = rootOf(item);
        targetRoot = relation.root;
        targetGroup = relation.key;
        pages = annotationPages(targetRoot ?? item);
        annotation = { id: item.id, type: PdfAnnotationSubtypeName[item.type] ?? String(item.type) };
        comment = item.contents ?? null;
      }
      const matches = block ? { blocks: [block], ambiguous: false } : matchBlocks(target && !targetRoot ? [] : mapping?.blocks ?? [], pages);
      const manuscript: ResolvedReference["manuscript"] = { status: "unmatched", locations: [] };
      if (mapping && matches.blocks.length) {
        try {
          const body = await this.projects.readParsingFile(root, mapping.run.batchId, "candidate.md");
          const manuscriptPath = mapping.run.candidate;
          if (!manuscriptPath || ![ `text/${mapping.run.batchId}/paper.md`, `text/candidates/${mapping.run.batchId}/candidate.md` ].includes(manuscriptPath))
            throw new Error("解析稿路径无效。");
          manuscript.locations = manuscriptLocations(body.toString("utf8"), manuscriptPath, matches.blocks);
          const ids = new Set(manuscript.locations.map(l => l.blockId));
          manuscript.status = matches.ambiguous || manuscript.locations.length > ids.size ? "ambiguous" : ids.size > 1 ? "multiple" : ids.size === 1 ? "matched" : "unmatched";
          if (ids.size < matches.blocks.length) {
            manuscript.reason = "部分或全部块链接已不在当前解析稿中；不返回解析时的旧正文。";
            if (ids.size) manuscript.status = "ambiguous";
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          manuscript.reason = "对应解析稿文件已缺失。";
        }
      } else manuscript.reason = "没有可关联的解析块；可按 PDF 页码核对，不猜测正文位置。";
      const groups = new Map<string, { root?: PdfAnnotationObject; status: "complete" | "missing-parent" | "cycle"; entries: PdfAnnotationObject[] }>();
      for (const item of annotations) {
        const relation = rootOf(item);
        const group = groups.get(relation.key) ?? { root: relation.root, status: relation.status, entries: [] };
        group.entries.push(item); groups.set(relation.key, group);
      }
      const discussions: ResolvedReference["discussions"] = [];
      for (const [key, group] of groups) {
        const associated = matchBlocks(matches.blocks, group.root ? annotationPages(group.root) : []);
        if (key !== targetGroup && !associated.blocks.length) continue;
        if (!group.entries.some(item => item.contents?.trim()) && key !== targetGroup) continue;
        discussions.push({ rootId: group.root?.id ?? null, status: group.status, blockIds: associated.blocks.map(b => b.id), entries: group.entries.map(item => ({
          id: item.id, parentId: item.inReplyToId, replyType: item.replyType,
          type: PdfAnnotationSubtypeName[item.type] ?? String(item.type), comment: item.contents ?? null,
          author: item.author, target: item.id === target?.id,
        })) });
      }
      for (const location of pages) {
        const page = doc.pages[location.page - 1];
        if (!page) throw new Error("引用页码与当前 PDF 不符。");
        if (Math.abs(page.size.width - location.width) > 0.01 || Math.abs(page.size.height - location.height) > 0.01)
          throw new Error("引用页面尺寸与当前 PDF 不符。");
      }
      signal?.throwIfAborted();
      return { source, reference: { kind: target ? "annotation" : "citation", status: "available", path: pdfPath,
        documentId: record.id, sha256: source.sha256, pages, excerpt, excerptSource, comment, annotation,
        manuscript, discussions, warnings: [...new Set(warnings)],
        ...(block ? { block: { id: block.id, label: block.label } } : {}) } };
    } finally { await engine.destroy().toPromise(); }
  }

  async create(root: string, request: ReferenceRequest & { comment: string }, signal?: AbortSignal) {
    if (typeof request.comment !== "string" || !request.comment.trim() || request.comment.length > 100000)
      throw new Error("评论正文须为 1 至 100000 个字符。");
    const { reference: resolved, source: resolvedSource } = await this.resolveSource(root, request, signal);
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
    const written = await this.writer?.({ root, path: resolved.path, sha256: resolved.sha256,
      document: resolvedSource.document, annotation }, signal);
    if (!written) {
      const source = await this.projects.dispatch({ type: "readPdf", root, path: resolved.path }) as PdfSource;
      if (!canReusePdfEvidence(resolvedSource, source)) throw new Error("PDF 已在外部修改，请重读引用后重试。");
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
