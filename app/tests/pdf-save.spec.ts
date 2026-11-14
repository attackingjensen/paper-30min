import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectService } from "../src/main/project-service";
import type { Project, PdfSource } from "../src/shared/contracts";

test("PDF 保存等待短暂读取释放，持续占用会失败且等待期间不覆盖外部修改", async () => {
  test.skip(process.platform !== "win32", "Windows 文件替换共享约束");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-save-"));
  const service = new ProjectService(path.join(directory, "preferences.json"), async () => {});
  try {
    const { root } = await service.dispatch({ type: "create", input: {
      source: path.resolve("../legacy/v1/app/ui/samples/sample_paper.pdf"), parent: directory,
      name: "保存", makeDefault: false, operationId: "save-test",
    } }) as Project;
    const file = path.join(root, "text/paper.pdf");
    for (const scenario of ["release", "held", "changed"] as const) {
      const source = await service.dispatch({ type: "readPdf", root, path: "text/paper.pdf" }) as PdfSource;
      const bytes = Buffer.concat([Buffer.from(source.bytes), Buffer.from("\n% saved")]);
      const reader = await fs.open(file, "r");
      let pending: Promise<unknown> | undefined;
      try {
        pending = service.dispatch({ type: "savePdf", root, path: "text/paper.pdf", bytes, version: source.sha256 });
        // Attach rejection handling immediately while deliberately holding the file.
        const outcome = pending.then(() => "saved", error => error as Error & { code?: string });
        if (scenario !== "held") {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (scenario === "changed") await fs.writeFile(file, Buffer.concat([Buffer.from(source.bytes), Buffer.from("\n% external")]));
          await reader.close();
        }
        const result = await outcome;
        if (scenario === "release") {
          expect(result).toBe("saved");
          expect(await fs.readFile(file)).toEqual(bytes);
        } else {
          expect(result).toBeInstanceOf(Error);
          if (scenario === "held") expect((result as NodeJS.ErrnoException).code).toBe("EPERM");
          else expect((result as Error).message).toContain("PDF 已在外部修改");
          expect(await fs.readFile(file)).toEqual(scenario === "held" ? Buffer.from(source.bytes) : Buffer.concat([Buffer.from(source.bytes), Buffer.from("\n% external")]));
        }
      } finally { await reader.close(); await pending?.catch(() => {}); }
      expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    }
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
