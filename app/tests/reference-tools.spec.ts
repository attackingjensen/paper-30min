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
    expect(resolved).toMatchObject({ kind: "citation", status: "available", excerpt, excerptSource: "parser", comment: null,
      path: "text/paper.pdf", pages: [{ page: 1, width: 612, height: 792 }], block: { label: "text" } });
    const note = `# 理解\n\n模型采用编码器和解码器。[原文](${link})\n`;
    await call("write", { path: "notes/理解.md", content: note });
    expect(await fs.readFile(path.join(root, "notes/理解.md"), "utf8")).toBe(note);
    await call("read", { path: "notes/理解.md" });
    await fs.appendFile(path.join(root, "notes/理解.md"), "用户补充\n");
    const conflict = await call("edit", { path: "notes/理解.md", edits: [{ oldText: "# 理解", newText: "# 更新" }] });
    expect(conflict.details).toMatchObject({ failed: true, conflict: { current: note + "用户补充\n" } });
    const image = await call("read_pdf", { path: resolved.path, page: resolved.pages[0].page });
    expect(image.content[1].type).toBe("image");
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(before);
    const created = info(await call("create_annotation", { link, comment: "讨论：编码器与解码器的职责不同。" }));
    expect(created.link).toMatch(/^text\/paper.pdf#annotation=/);
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).not.toEqual(before);
    expect(info(await call("resolve_reference", { link }))).toMatchObject({ excerpt, status: "available" });
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
