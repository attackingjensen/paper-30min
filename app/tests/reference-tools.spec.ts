import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProjectService } from "../src/main/project-service";
import { ReferenceService } from "../src/main/reference-service";
import { createReferenceTools } from "../src/main/reference-tools";
import { createProjectTools } from "../src/main/agent-tools";
import { createPdfTools } from "../src/main/pdf-tools";
import { annotationHref } from "../src/shared/annotation-links";
import type { Citation } from "../src/shared/citations";
import type { Project } from "../src/shared/contracts";
import { seedBlockParsing } from "./review-fixture";
import { PdfAnnotationSubtype, PdfAnnotationReplyType, type PdfAnnotationObject } from "@embedpdf/models";

test("引用按当前解析稿行号读取，选区和原生多级评论关联同段且保存重开后完整展开", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-context-"));
  const projects = new ProjectService(path.join(directory, "preferences.json"), async () => {});
  try {
    const { root } = await projects.dispatch({ type: "create", input: {
      source: path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
      parent: directory, name: "context", makeDefault: false, operationId: "context",
    } }) as Project;
    const { run, link } = await seedBlockParsing(root);
    const references = new ReferenceService(projects);
    const manuscript = path.join(root, run.candidate!);
    await fs.writeFile(manuscript, `# 校对稿\n\n新增说明。\n\n校对后的当前原文。\n\n[原文](${link})\n`);
    await fs.writeFile(path.join(root, "notes/copied.md"), `[复用](${link})`);
    const located = await references.resolve(root, { link });
    expect(located.manuscript).toMatchObject({ status: "matched", locations: [{ path: run.candidate, linkLine: 7, startLine: 5, endLine: 7 }] });
    expect(located.excerpt).toBeNull();
    const read = createProjectTools(root, projects, () => true, []).find(t => t.name === "read")!;
    const result = await read.execute("read", { path: run.candidate, offset: 5, limit: 3 }, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("校对后的当前原文") });
    const source = await projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as any;
    const input = { sha256: source.sha256, kind: "text" as const, text: "关注的一句话", pages: [{ page: 1, width: 612, height: 792,
      rects: [{ origin: { x: 150, y: 418 }, size: { width: 100, height: 8 } }] }] };
    const manual = await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input }) as Citation;
    const manualLink = `paper://cite/${manual.id}`;
    expect((await references.resolve(root, { link: manualLink })).manuscript.locations[0].link).toBe(link);
    expect(manual).not.toHaveProperty("sha256");

    const { init } = await import("@embedpdf/pdfium");
    const { PdfEngine, PdfiumNative } = await import("@embedpdf/engines/pdfium");
    const engine = new PdfEngine(new PdfiumNative(await init({ wasmBinary: await fs.readFile(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm"))) })),
      { imageConverter: () => { throw new Error("not rendering"); } });
    try {
      const doc = await engine.openDocumentBuffer({ id: "discussion-fixture", content: new Uint8Array(source.bytes).buffer }, { normalizeRotation: true }).toPromise();
      const rect = { origin: { x: 150, y: 418 }, size: { width: 20, height: 10 } };
      const items: PdfAnnotationObject[] = [
        { id: "underline-root", pageIndex: 0, type: PdfAnnotationSubtype.UNDERLINE, rect, segmentRects: [rect], strokeColor: "#000000", opacity: 1 },
        { id: "comment", pageIndex: 0, type: PdfAnnotationSubtype.TEXT, rect, contents: "第一条评论", author: "用户", inReplyToId: "underline-root", replyType: PdfAnnotationReplyType.Reply },
        { id: "followup", pageIndex: 0, type: PdfAnnotationSubtype.TEXT, rect, contents: "追评", author: "用户", inReplyToId: "comment", replyType: PdfAnnotationReplyType.Reply },
        { id: "independent", pageIndex: 0, type: PdfAnnotationSubtype.TEXT, rect, contents: "同位置独立评论" },
      ];
      for (const item of items) await engine.createPageAnnotation(doc, doc.pages[0], item).toPromise();
      await projects.dispatch({ type: "savePdf", root, path: "text/paper.pdf", version: source.sha256, bytes: new Uint8Array(await engine.saveAsCopy(doc).toPromise()) });
      const linked = await references.resolve(root, { link: "text/paper.pdf#annotation=followup" });
      expect(linked.manuscript.locations[0].linkLine).toBe(7);
      expect(linked.discussions).toHaveLength(2);
      expect(linked.discussions.find(d => d.rootId === "underline-root")!.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "comment", parentId: "underline-root", comment: "第一条评论" }),
        expect.objectContaining({ id: "followup", parentId: "comment", comment: "追评", target: true }),
      ]));
      expect((await references.resolve(root, { link })).discussions).toHaveLength(2);
      const current = await projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as any;
      expect((await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input: { ...input, sha256: current.sha256 } }) as Citation).id).toBe(manual.id);
      await expect(projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input: { ...input, sha256: "0".repeat(64) } })).rejects.toThrow("版本");
      await engine.createPageAnnotation(doc, doc.pages[0], { id: "later", pageIndex: 0, type: PdfAnnotationSubtype.TEXT, rect,
        contents: "后续追加", inReplyToId: "followup" }).toPromise();
      await projects.dispatch({ type: "savePdf", root, path: "text/paper.pdf", version: current.sha256, bytes: new Uint8Array(await engine.saveAsCopy(doc).toPromise()) });
      expect((await new ReferenceService(projects).resolve(root, { link: "text/paper.pdf#annotation=underline-root" })).discussions[0].entries)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: "later", parentId: "followup", comment: "后续追加" })]));
      // A damaged reply graph must preserve its IDs but cannot claim a manuscript match.
      await engine.updatePageAnnotation(doc, doc.pages[0], { ...items[0], inReplyToId: "followup" }).toPromise();
      let saved = await projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as any;
      await projects.dispatch({ type: "savePdf", root, path: "text/paper.pdf", version: saved.sha256, bytes: new Uint8Array(await engine.saveAsCopy(doc).toPromise()) });
      const cycle = await references.resolve(root, { link: "text/paper.pdf#annotation=followup" });
      expect(cycle.manuscript.status).toBe("unmatched");
      expect(cycle.discussions).toMatchObject([{ rootId: null, status: "cycle", entries: expect.arrayContaining([
        expect.objectContaining({ id: "followup", parentId: "comment", target: true }),
      ]) }]);
    } finally { await engine.destroy().toPromise(); }
    await fs.appendFile(manuscript, `\n[再次出现](${link})\n`);
    expect((await references.resolve(root, { link })).manuscript.status).toBe("ambiguous");
    await fs.writeFile(manuscript, `# 已删来源\n\n代码中的链接不能作为原文：\n\n\`[原文](${link})\`\n`);
    expect((await references.resolve(root, { link })).manuscript).toMatchObject({ status: "unmatched", locations: [] });
    await fs.writeFile(manuscript, `$$\na=b\n\nc=d\n$$\n\n[原文](${link})\n`);
    expect((await references.resolve(root, { link })).manuscript.locations[0]).toMatchObject({ startLine: 1, endLine: 7, linkLine: 7 });
    await fs.writeFile(manuscript, `## 原文标题\n\n[原文](${link})\n`);
    expect((await references.resolve(root, { link })).manuscript.locations[0]).toMatchObject({ startLine: 1, endLine: 3, linkLine: 3 });
    await fs.writeFile(manuscript, `Text \`code\ncontinued\` [原文](${link})\n`);
    expect((await references.resolve(root, { link })).manuscript.locations[0]).toMatchObject({ startLine: 1, endLine: 2, linkLine: 2 });
    await fs.writeFile(manuscript, `| A | B |\n| --- | --- |\n| x | y [原文](${link}) |\n`);
    expect((await references.resolve(root, { link })).manuscript.locations[0]).toMatchObject({ startLine: 1, endLine: 3, linkLine: 3 });
    await fs.writeFile(manuscript, `    indented code\n    second line\n\n[原文](${link})\n`);
    expect((await references.resolve(root, { link })).manuscript.locations[0]).toMatchObject({ startLine: 1, endLine: 4, linkLine: 4 });
    // Add a second parser block and exercise a selection spanning both paragraphs.
    const mappingPath = path.join(root, ".paper30min/parsing", run.batchId, "mapping.json");
    const mapping = JSON.parse(await fs.readFile(mappingPath, "utf8"));
    const currentSource = await projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as any;
    const second = await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input: {
      sha256: currentSource.sha256, text: "", kind: "region", pages: [{ page: 1, width: 612, height: 792,
        rects: [{ origin: { x: 144, y: 450 }, size: { width: 325, height: 18 } }] }],
    } }) as Citation;
    mapping.blocks.push({ ...mapping.blocks[0], id: "second", citation: second });
    const saveMapping = async () => {
      const bytes = Buffer.from(JSON.stringify(mapping));
      await fs.writeFile(mappingPath, bytes);
      run.mappingSha256 = createHash("sha256").update(bytes).digest("hex");
      await fs.writeFile(path.join(root, ".paper30min/parsing", run.batchId, "run.json"), JSON.stringify(run));
    };
    await saveMapping();
    await fs.writeFile(manuscript, `第一段\n\n[原文](${link})\n\n第二段\n\n[原文](paper://cite/${second.id})\n`);
    const spanning = await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input: {
      ...input, sha256: currentSource.sha256, pages: [{ page: 1, width: 612, height: 792,
        rects: [{ origin: { x: 150, y: 418 }, size: { width: 100, height: 45 } }] }],
    } }) as Citation;
    expect((await references.resolve(root, { link: `paper://cite/${spanning.id}` })).manuscript).toMatchObject({ status: "multiple",
      locations: [{ linkLine: 3 }, { linkLine: 7 }] });
    mapping.blocks[1].citation.pages = mapping.blocks[0].citation.pages;
    await saveMapping();
    expect((await references.resolve(root, { link: manualLink })).manuscript.status).toBe("ambiguous");
    // A legacy dictionary hash does not invalidate an existing ID or prevent reuse.
    const dictionaryPath = path.join(root, ".paper30min-citations.json");
    const dictionary = JSON.parse(await fs.readFile(dictionaryPath, "utf8"));
    dictionary.citations[manual.id].sha256 = source.sha256;
    await fs.writeFile(dictionaryPath, JSON.stringify(dictionary));
    expect((await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input: { ...input, sha256: currentSource.sha256 } }) as Citation).id).toBe(manual.id);
  } finally { await projects.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Agent 分段读搜解析稿、直接复用块链接写笔记、展开引用并按需看原页和保存评论", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-references-"));
  let projects = new ProjectService(path.join(directory, "preferences.json"), async () => {});
  try {
    const project = await projects.dispatch({ type: "create", input: {
      source: path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
      parent: directory, name: "引用工程（中文）", makeDefault: false, operationId: "references",
    } }) as Project;
    const { root } = project;
    const { run, link, excerpt } = await seedBlockParsing(root);
    const tools = [...createProjectTools(root, projects, () => true, []),
      ...createReferenceTools(root, new ReferenceService(projects), () => true),
      ...createPdfTools(root, projects, true, () => true)];
    const call = async (name: string, args: any) => tools.find((tool) => tool.name === name)!
      .execute("reference-test", args, undefined, undefined, {} as any);
    const info = (result: any) => JSON.parse(result.content[0].text);
    const read = await call("read", { path: run.candidate, offset: 3, limit: 3 });
    expect((read.content[0] as any).text).toContain(excerpt);
    expect((read.content[0] as any).text).toContain(link);
    const searched = await call("bash", { command: "Get-ChildItem text -Recurse -Filter *.md | Select-String 'dominant' -Context 0,2" });
    expect((searched.content[0] as any).text).toContain(link);
    const before = await fs.readFile(path.join(root, "text/paper.pdf"));
    const resolved = info(await call("resolve_reference", { link }));
    expect(resolved).toMatchObject({ kind: "citation", status: "available", excerpt: null, excerptSource: null, comment: null,
      manuscript: { status: "matched", locations: [{ path: run.candidate, linkLine: 5, startLine: 3, endLine: 5 }] },
      path: "text/paper.pdf", pages: [{ page: 1, width: 612, height: 792 }], block: { label: "text" } });
    const note = `# 理解\n\n模型采用编码器和解码器。[原文](${link})\n`;
    await call("write", { path: "notes/理解.md", content: note });
    expect(await fs.readFile(path.join(root, "notes/理解.md"), "utf8")).toBe(note);
    await call("read", { path: "notes/理解.md" });
    await fs.appendFile(path.join(root, "notes/理解.md"), "用户补充\n");
    const conflict = await call("edit", { path: "notes/理解.md", edits: [{ oldText: "# 理解", newText: "# 更新" }] });
    expect(conflict.details).toMatchObject({ failed: true, conflict: { current: note + "用户补充\n" } });
    const citationPath = path.join(root, ".paper30min-citations.json");
    const citations = await fs.readFile(citationPath, "utf8");
    const image = await call("read_pdf", { path: resolved.path, page: resolved.pages[0].page });
    expect(image.content[1].type).toBe("image");
    expect(await fs.readFile(citationPath, "utf8")).toBe(citations);
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(before);
    const created = info(await call("create_annotation", { link, comment: "讨论：编码器与解码器的职责不同。" }));
    expect(created.link).toMatch(/^text\/paper.pdf#annotation=/);
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).not.toEqual(before);
    expect(info(await call("resolve_reference", { link }))).toMatchObject({ excerpt: null, status: "available",
      discussions: [{ rootId: created.annotationId, entries: [{ comment: "讨论：编码器与解码器的职责不同。" }] }] });
    expect(info(await call("resolve_reference", { link: created.link }))).toMatchObject({ kind: "annotation", excerpt: null,
      excerptSource: null, comment: "讨论：编码器与解码器的职责不同。", annotation: { id: created.annotationId, type: "text" } });
    await projects.close();
    projects = new ProjectService(path.join(directory, "reopened.json"), async () => {});
    const reopened = new ReferenceService(projects);
    const second = await reopened.create(root, { link, comment: "第二条评论" });
    expect((await reopened.resolve(root, { link: created.link })).comment).toContain("编码器与解码器");
    expect((await reopened.resolve(root, { link: second.link })).comment).toBe("第二条评论");
    await projects.dispatch({ type: "move", root, path: "text/paper.pdf", destination: "text/论文（甲）.pdf" });
    const relative = annotationHref({ path: "text/论文（甲）.pdf", id: created.annotationId }, "notes/理解.md");
    expect((await reopened.resolve(root, { link: relative, sourceDocument: "notes/理解.md" })).path).toBe("text/论文（甲）.pdf");
    await expect(reopened.resolve(root, { link: relative })).rejects.toThrow("超出工程");
    await expect(reopened.resolve(root, { link: relative, sourceDocument: "../outside.md" })).rejects.toThrow("来源文档");
    await expect(reopened.resolve(root, { link: "paper://cite/" + "0".repeat(32) })).rejects.toThrow("找不到");
    await expect(reopened.resolve(root, { link: "text/论文（甲）.pdf#annotation=absent" })).rejects.toThrow("找不到目标批注");
    const material = await projects.dispatch({ type: "addMaterial", root, source: path.resolve("tests/fixtures/long-150.pdf") }) as Project;
    await expect(reopened.resolve(root, { link: annotationHref({ path: material.manifest.materials[0].path, id: created.annotationId }) })).rejects.toThrow("找不到目标批注");
    await fs.unlink(path.join(root, "text/论文（甲）.pdf"));
    await expect(reopened.resolve(root, { link })).rejects.toThrow("缺失");
  } finally { await projects.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("引用定位不符、页级引用与取消不会创建评论，手动摘录和空摘录明确区分", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reference-errors-"));
  const projects = new ProjectService(path.join(directory, "config.json"), async () => {});
  try {
    const { root } = await projects.dispatch({ type: "create", input: { source: path.resolve("tests/fixtures/long-150.pdf"),
      parent: directory, name: "errors", makeDefault: false, operationId: "errors" } }) as Project;
    const bytes = await fs.readFile(path.join(root, "text/paper.pdf"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const references = new ReferenceService(projects);
    const make = async (input: any) => {
      const citation = await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf",
        input: { sha256, text: "", kind: "page", pages: [{ page: 1, width: 612, height: 792, rects: [] }], ...input } }) as Citation;
      return `paper://cite/${citation.id}`;
    };
    const page = await make({});
    expect((await references.resolve(root, { link: page })).excerpt).toBeNull();
    await expect(references.create(root, { link: page, comment: "不猜块位置" })).rejects.toThrow("定位不足");
    const manual = await make({ kind: "text", text: "用户实际选中的摘录", pages: [{ page: 1, width: 612, height: 792,
      rects: [{ origin: { x: 20, y: 30 }, size: { width: 100, height: 40 } }] }] });
    expect(await references.resolve(root, { link: manual })).toMatchObject({ excerpt: "用户实际选中的摘录", excerptSource: "selection" });
    await expect(references.resolve(root, { link: await make({ pages: [{ page: 151, width: 612, height: 792, rects: [] }] }) })).rejects.toThrow("页码");
    await expect(references.resolve(root, { link: await make({ pages: [{ page: 1, width: 600, height: 792, rects: [] }] }) })).rejects.toThrow("尺寸");
    const controller = new AbortController(); controller.abort();
    await expect(references.create(root, { link: manual, comment: "cancel" }, controller.signal)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(bytes);
  } finally { await projects.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
