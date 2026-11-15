import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectService } from "../src/main/project-service";
import type { PdfSource, Project, LegacyImportResult } from "../src/shared/contracts";

test("旧库导入幂等，重新关联接受原文件并拒绝其他文件", async () => {
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
    const saved = await projects.dispatch({ type: "readPdf", root: imported.root, path: "text/paper.pdf" }) as PdfSource;
    const again = await projects.dispatch(command) as LegacyImportResult;
    expect(again).toMatchObject({ root: imported.root, existing: true });
    expect(await fs.readdir(parent)).toEqual(["论文"]);
    const moved = path.join(directory, "论文.pdf");
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
