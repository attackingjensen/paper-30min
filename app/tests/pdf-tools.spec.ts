import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import { ProjectService } from "../src/main/project-service";
import { createPdfTools } from "../src/main/pdf-tools";
import type { Project } from "../src/shared/contracts";

test("旋转页按阅读器的未旋转坐标取证并登记可回查的尺寸", async () => {
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
        region: { x: 10, y: 20, width: 120, height: 60 },
      },
      undefined,
      undefined,
      {} as any,
    );
    const info = JSON.parse((result.content[0] as any).text);
    expect(info.citation.pages[0]).toMatchObject({ width: 300, height: 200 });
    const image = PNG.sync.read(
      Buffer.from((result.content[1] as any).data, "base64"),
    );
    let ink = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (image.data[i] < 128) ink++;
    expect(ink).toBeGreaterThan(1000);
    const resolved = (await service.dispatch({
      type: "resolveCitation",
      root,
      link: info.link,
    })) as any;
    expect(resolved.citation.pages[0]).toMatchObject({
      width: 300,
      height: 200,
    });
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("read_pdf 返回实际页图、放大区域及持久引用，不依赖阅读器或解析稿", async () => {
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
    const tool = createPdfTools(root, service, true, () => active)[0];
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
    const page = await run({});
    const info = JSON.parse((page.content[0] as any).text);
    expect(info.text).toContain("Attention Is All You Need");
    expect(info.pageCount).toBeGreaterThan(1);
    expect(info.granularity).toBe("页面");
    const image = PNG.sync.read(
      Buffer.from((page.content[1] as any).data, "base64"),
    );
    expect(image.width).toBeGreaterThan(600);
    expect(new Set(image.data).size).toBeGreaterThan(30);
    const args = {
      page: 1,
      region: { x: 80, y: 60, width: 300, height: 120 },
      scale: 3,
      sha256: info.sha256,
    };
    const region = await run(args);
    const regionInfo = JSON.parse((region.content[0] as any).text);
    const crop = PNG.sync.read(
      Buffer.from((region.content[1] as any).data, "base64"),
    );
    expect([crop.width, crop.height]).toEqual([900, 360]);
    const resolved = (await service.dispatch({
      type: "resolveCitation",
      root,
      link: regionInfo.link,
    })) as any;
    expect(resolved.citation.pages[0].rects).toEqual([
      { origin: { x: 80, y: 60 }, size: { width: 300, height: 120 } },
    ]);
    const repeated = await run(args);
    expect(JSON.parse((repeated.content[0] as any).text).link).toBe(
      regionInfo.link,
    );
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
      expect(JSON.parse((again.content[0] as any).text).link).toBe(
        regionInfo.link,
      );
    } finally {
      await reopened.close();
    }
    const dictionary = await fs.readFile(
      path.join(root, ".paper30min-citations.json"),
      "utf8",
    );
    expect(dictionary).not.toContain("base64");
    expect(dictionary.length).toBeLessThan(5000);
    expect(
      await fs
        .readFile(path.join(root, ".paper30min-reading.json"), "utf8")
        .catch(() => null),
    ).toBe(before);
    await expect(run({ page: 999 })).rejects.toThrow("越界");
    await expect(
      run({ region: { x: -1, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow("区域");
    await expect(run({ sha256: "0".repeat(64) })).rejects.toThrow("版本");
    await expect(run({ path: "../outside.pdf" })).rejects.toThrow("身份");
    const textOnly = await createPdfTools(
      root,
      service,
      false,
      () => true,
    )[0].execute(
      "text",
      { path: "text/paper.pdf" },
      undefined,
      undefined,
      {} as any,
    );
    expect(textOnly.content).toHaveLength(1);
    expect((textOnly.content[0] as any).text).toContain("未启用视觉");
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
    await expect(run({})).rejects.toThrow("版本");
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("扫描页只返回实际图像；区域文字和图片保持同一取证位置，取消不登记迟到引用", async () => {
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
      region: { x: 180, y: 425, width: 250, height: 65 },
    };
    const invoke = (value: any, signal?: AbortSignal) =>
      tool.execute("scan", value, signal, undefined, {} as any);
    const result = await invoke({ ...args, page: 1 });
    const info = JSON.parse((result.content[0] as any).text);
    expect(info.text).toBe("");
    const formulaImage = PNG.sync.read(
      Buffer.from((result.content[1] as any).data, "base64"),
    );
    expect([formulaImage.width, formulaImage.height]).toEqual([750, 195]);
    let ink = 0;
    for (let i = 0; i < formulaImage.data.length; i += 4)
      if (formulaImage.data[i] < 128) ink++;
    expect(ink).toBeGreaterThan(500);
    const full = await invoke({ path: args.path });
    expect(JSON.parse((full.content[0] as any).text).text).toContain(
      "Formula Graphics Fixture",
    );
    const added = (await service.dispatch({
      type: "addMaterial",
      root,
      source: path.resolve(
        "../legacy/v1/app/src-tauri/tests/fixtures/pdfparse_scanned_blank.pdf",
      ),
    })) as Project;
    const scan = await invoke({ path: added.manifest.materials[0].path });
    const scanInfo = JSON.parse((scan.content[0] as any).text);
    expect(scanInfo.text).toBe("");
    expect(scanInfo.textStatus).toContain("无可用文本层");
    expect(scan.content[1].type).toBe("image");
    const before = await fs.readFile(
      path.join(root, ".paper30min-citations.json"),
      "utf8",
    );
    const controller = new AbortController();
    const stopped = invoke(
      { ...args, page: 1, region: { x: 0, y: 0, width: 100, height: 100 } },
      controller.signal,
    );
    controller.abort();
    await expect(stopped).rejects.toThrow();
    expect(
      await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8"),
    ).toBe(before);
    // A canceled queued registration must not mutate the dictionary later.
    await expect(
      service.dispatch(
        {
          type: "createCitation",
          root,
          path: args.path,
          input: {
            ...info.citation,
            pages: [
              {
                ...info.citation.pages[0],
                rects: [
                  { origin: { x: 1, y: 1 }, size: { width: 50, height: 50 } },
                ],
              },
            ],
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(
      await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8"),
    ).toBe(before);
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
