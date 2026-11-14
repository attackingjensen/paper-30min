import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectService } from "../src/main/project-service";
import { createPdfTools } from "../src/main/pdf-tools";
import { ReferenceService } from "../src/main/reference-service";
import type { PdfSource, Project, LegacyImportResult } from "../src/shared/contracts";
import { seedBlockParsing } from "./review-fixture";

async function annotate(projects: ProjectService, root: string) {
  const source = await projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as PdfSource;
  await projects.dispatch({ type: "savePdf", root, path: "text/paper.pdf", version: source.sha256,
    bytes: Buffer.concat([source.bytes, Buffer.from("\n% application annotation save\n")]) });
  return projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as Promise<PdfSource>;
}

test("连续批注保存后读取当前 PDF，已读取的可信版本仍可登记引用，外部改写不冒充批注", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-versions-"));
  const projects = new ProjectService(path.join(directory, "preferences.json"), async () => {});
  try {
    const { root } = await projects.dispatch({ type: "create", input: {
      source: path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
      parent: directory, name: "版本工程",
      makeDefault: false, operationId: "versions",
    } }) as Project;
    const first = await annotate(projects, root);
    const second = await annotate(projects, root);
    const tool = createPdfTools(root, projects, true, () => true)[0];
    const read = await tool.execute("old-call", { path: "text/paper.pdf", page: 1, sha256: first.sha256 } as any,
      undefined, undefined, {} as any);
    expect(JSON.parse((read.content[0] as any).text).sha256).toBe(second.sha256);
    expect(JSON.parse((read.content[0] as any).text)).not.toHaveProperty("citation");
    await annotate(projects, root);
    const input = { sha256: first.sha256, kind: "page" as const, text: "",
      pages: [{ page: 1, width: 612, height: 792, rects: [] }] };
    await projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input, sourceDocument: first.document });
    const { link } = await seedBlockParsing(root);
    const references = new ReferenceService(projects, async () => { await annotate(projects, root); return null; });
    const annotation = await references.create(root, { link, comment: "解析引用后又保存批注，仍保留双方内容" });
    expect((await references.resolve(root, { link: annotation.link })).comment).toBe("解析引用后又保存批注，仍保留双方内容");
    await fs.appendFile(path.join(root, "text/paper.pdf"), "\n% external edit\n");
    await expect(projects.dispatch({ type: "createCitation", root, path: "text/paper.pdf", input,
      sourceDocument: first.document })).rejects.toThrow("版本");
    const current = await projects.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as PdfSource;
    await expect(projects.dispatch({ type: "savePdf", root, path: "text/paper.pdf", version: second.sha256,
      bytes: current.bytes })).rejects.toThrow("外部修改");
  } finally { await projects.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("旧库导入在批注保存后仍幂等，重新关联接受已保存批注版本并拒绝其他文件", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-relink-"));
  const projects = new ProjectService(path.join(directory, "preferences.json"), async () => {});
  try {
    const legacy = path.join(directory, "legacy");
    const parent = path.join(directory, "projects");
    await fs.mkdir(path.join(legacy, "attachments/a"), { recursive: true });
    await fs.mkdir(parent);
    await fs.copyFile(path.resolve("tests/fixtures/long-150.pdf"), path.join(legacy, "attachments/a/pdf"));
    await projects.dispatch({ type: "setDefault", folder: parent });
    const command = { type: "importLegacy" as const, root: legacy, path: "attachments/a/pdf", name: "论文", operationId: "import" };
    const imported = await projects.dispatch(command) as LegacyImportResult;
    const saved = await annotate(projects, imported.root);
    const again = await projects.dispatch(command) as LegacyImportResult;
    expect(again).toMatchObject({ root: imported.root, existing: true });
    expect(await fs.readdir(parent)).toEqual(["论文"]);
    const moved = path.join(directory, "批注论文.pdf");
    await fs.rename(path.join(imported.root, "text/paper.pdf"), moved);
    const wrong = path.join(directory, "other.pdf");
    await fs.writeFile(wrong, Buffer.concat([saved.bytes, Buffer.from("\n% external change\n")]));
    await expect(projects.dispatch({ type: "relink", root: imported.root, id: saved.document!.id, source: wrong }))
      .rejects.toThrow("不同");
    const linked = await projects.dispatch({ type: "relink", root: imported.root, id: saved.document!.id, source: moved }) as Project;
    expect(await fs.readFile(path.join(linked.root, linked.manifest.paper.path))).toEqual(Buffer.from(saved.bytes));
    expect(linked.manifest.paper.id).toBe(saved.document!.id);
  } finally { await projects.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
