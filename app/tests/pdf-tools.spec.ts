import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import { ProjectService } from "../src/main/project-service";
import { createPdfTools } from "../src/main/pdf-tools";
import type { Project } from "../src/shared/contracts";

test("旋转页按阅读器的未旋转坐标返回尺寸和图像", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-rotated-"),
  );
  const service = new ProjectService(
    path.join(directory, "config.json"),
    async () => {},
  );
  try {
    // A black rectangle at (20, 30) in top-left coordinates, with page rotation metadata.
    const stream = "0 g 20 140 80 30 re f";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Rotate 90 /Contents 4 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join(
        "",
      )}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const source = path.join(directory, "rotated.pdf");
    await fs.writeFile(source, pdf);
    const { root } = (await service.dispatch({
      type: "create",
      input: {
        source,
        parent: directory,
        name: "rotated",
        makeDefault: false,
        operationId: "rotation",
      },
    })) as Project;
    const result = await createPdfTools(
      root,
      service,
      true,
      () => true,
    )[0].execute(
      "rotated",
      {
        path: "text/paper.pdf",
      },
      undefined,
      undefined,
      {} as any,
    );
    const info = JSON.parse((result.content[0] as any).text);
    expect(info).toMatchObject({ width: 300, height: 200 });
    const image = PNG.sync.read(
      Buffer.from((result.content[1] as any).data, "base64"),
    );
    let ink = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (image.data[i] < 128) ink++;
    expect(ink).toBeGreaterThan(1000);
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("read_pdf 只读完整页图与定位信息，不登记引用或依赖阅读器和解析稿", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-"));
  const service = new ProjectService(
    path.join(directory, "config.json"),
    async () => {},
  );
  try {
    const project = (await service.dispatch({
      type: "create",
      input: {
        source: path.resolve(
          "../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf",
        ),
        parent: directory,
        name: "project",
        makeDefault: false,
        operationId: "pdf",
      },
    })) as Project;
    const root = project.root;
    let active = true;
    const readPages: { documentId: string; page: number }[] = [];
    const tool = createPdfTools(root, service, true, () => active,
      (documentId, page) => readPages.push({ documentId, page }))[0];
    const run = (args: any, signal?: AbortSignal) =>
      tool.execute(
        "call",
        { path: "text/paper.pdf", ...args },
        signal,
        undefined,
        {} as any,
      );
    const before = await fs
      .readFile(path.join(root, ".paper30min-reading.json"), "utf8")
      .catch(() => null);
    const citationPath = path.join(root, ".paper30min-citations.json");
    const beforeCitations = await fs.readFile(citationPath, "utf8").catch(() => null);
    const page = await run({});
    const info = JSON.parse((page.content[0] as any).text);
    expect(info).not.toHaveProperty("text");
    expect(info).not.toHaveProperty("textStatus");
    expect(info).not.toHaveProperty("textTruncated");
    expect(info.pageCount).toBeGreaterThan(1);
    expect(info.granularity).toBe("页面");
    expect(info).toMatchObject({ path: "text/paper.pdf", documentId: project.manifest.paper.id,
      page: 1, width: 612, height: 792, scale: 1.5 });
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const field of ["citation", "link", "markdown"]) expect(info).not.toHaveProperty(field);
    const image = PNG.sync.read(
      Buffer.from((page.content[1] as any).data, "base64"),
    );
    expect(image.width).toBeGreaterThan(600);
    expect(new Set(image.data).size).toBeGreaterThan(30);
    const args = {
      page: 1,
      scale: 3,
    };
    const enlarged = await run(args);
    const enlargedInfo = JSON.parse((enlarged.content[0] as any).text);
    const crop = PNG.sync.read(
      Buffer.from((enlarged.content[1] as any).data, "base64"),
    );
    expect([crop.width, crop.height]).toEqual([1583, 2048]);
    expect(enlargedInfo).toMatchObject({ width: 612, height: 792, scale: 2048 / 792 });
    const repeated = await run(args);
    expect(JSON.parse((repeated.content[0] as any).text)).toEqual(enlargedInfo);
    const reopened = new ProjectService(
      path.join(directory, "config2.json"),
      async () => {},
    );
    try {
      const again = await createPdfTools(
        root,
        reopened,
        true,
        () => true,
      )[0].execute(
        "reopen",
        { path: "text/paper.pdf", ...args },
        undefined,
        undefined,
        {} as any,
      );
      expect(JSON.parse((again.content[0] as any).text)).toEqual(enlargedInfo);
    } finally {
      await reopened.close();
    }
    expect(await fs.readFile(citationPath, "utf8").catch(() => null)).toBe(beforeCitations);
    expect(readPages).toEqual(Array.from({ length: 3 }, () => ({ documentId: info.documentId, page: 1 })));
    expect(
      await fs
        .readFile(path.join(root, ".paper30min-reading.json"), "utf8")
        .catch(() => null),
    ).toBe(before);
    await expect(run({ page: 999 })).rejects.toThrow("越界");
    await expect(run({ path: "../outside.pdf" })).rejects.toThrow("路径");
    await expect(
      createPdfTools(root, service, false, () => true)[0].execute(
        "text",
        { path: "text/paper.pdf", page: 2 },
        undefined,
        undefined,
        {} as any,
      ),
    ).rejects.toThrow("视觉输入");
    expect(
      await fs.readFile(citationPath, "utf8").catch(() => null),
    ).toBe(beforeCitations);
    const canceled = new AbortController();
    canceled.abort();
    await expect(run({}, canceled.signal)).rejects.toThrow();
    active = false;
    await expect(run({})).rejects.toThrow("任务已停止");
    active = true;
    await fs.copyFile(
      path.resolve("tests/fixtures/long-150.pdf"),
      path.join(root, "text/paper.pdf"),
    );
    const current = await run({});
    expect(current.content.some((item) => item.type === "image")).toBe(true);
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("公式页和扫描页均只返回实际图像与定位信息，取消不返回迟到图像", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-scan-"),
  );
  const service = new ProjectService(
    path.join(directory, "config.json"),
    async () => {},
  );
  try {
    const { root } = (await service.dispatch({
      type: "create",
      input: {
        source: path.resolve(
          "../legacy/v1/app/src-tauri/tests/fixtures/pdfparse_formula_graphics.pdf",
        ),
        parent: directory,
        name: "scan",
        makeDefault: false,
        operationId: "scan",
      },
    })) as Project;
    const tool = createPdfTools(root, service, true, () => true)[0];
    const args = {
      path: "text/paper.pdf",
    };
    const invoke = (value: any, signal?: AbortSignal) =>
      tool.execute("scan", value, signal, undefined, {} as any);
    const result = await invoke({ ...args, page: 1 });
    const info = JSON.parse((result.content[0] as any).text);
    expect(info).not.toHaveProperty("text");
    const formulaImage = PNG.sync.read(
      Buffer.from((result.content[1] as any).data, "base64"),
    );
    // The fixture uses a 612 × 792 point page, rendered at the default 1.5 scale.
    expect([formulaImage.width, formulaImage.height]).toEqual([918, 1188]);
    let ink = 0;
    for (let i = 0; i < formulaImage.data.length; i += 4)
      if (formulaImage.data[i] < 128) ink++;
    expect(ink).toBeGreaterThan(500);
    const added = (await service.dispatch({
      type: "addMaterial",
      root,
      source: path.resolve(
        "../legacy/v1/app/src-tauri/tests/fixtures/pdfparse_scanned_blank.pdf",
      ),
    })) as Project;
    const scan = await invoke({ path: added.manifest.materials[0].path });
    const scanInfo = JSON.parse((scan.content[0] as any).text);
    expect(scanInfo).not.toHaveProperty("text");
    expect(scanInfo).not.toHaveProperty("textStatus");
    expect(scan.content[1].type).toBe("image");
    const before = await fs.readFile(
      path.join(root, ".paper30min-citations.json"),
      "utf8",
    ).catch(() => null);
    const controller = new AbortController();
    const stopped = invoke(
      { ...args, page: 2 },
      controller.signal,
    );
    controller.abort();
    await expect(stopped).rejects.toThrow();
    expect(
      await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8").catch(() => null),
    ).toBe(before);
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
