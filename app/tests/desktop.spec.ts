import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { connect } from "node:net";
import { PNG } from "pngjs";
import type { ParsingRun, ParsingMapping } from "../src/shared/parsing";
import type { AgentSettings, ChatSession, PdfSource } from "../src/shared/contracts";
import { seedParsing, seedBlockParsing } from "./review-fixture";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EmbedPdfContainer, AnnotationPlugin } from "@embedpdf/react-pdf-viewer";

async function nativeAnnotations() {
  return page.locator("embedpdf-container").evaluate(async (element) => {
    const registry = await (element as EmbedPdfContainer).registry;
    return registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").getAnnotations()
      .filter((item) => item.commitState !== "deleted").map((item) => item.object);
  });
}

async function expectAnnotationSelected(id?: string) {
  await expect.poll(() => page.locator("embedpdf-container").evaluate(async (element, wanted) => {
    const registry = await (element as EmbedPdfContainer).registry;
    const selected = registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").getSelectedAnnotations();
    return wanted ? selected.filter((a) => a.object.id === wanted).length : selected.length;
  }, id)).toBeGreaterThan(0);
}

async function nativeHighlight() {
  const count = (await nativeAnnotations()).length;
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.getByRole("button", { name: "高亮", exact: true }).first().click();
  const image = await pdfImage().boundingBox();
  await page.mouse.move(image!.x + 80, image!.y + 190);
  await page.mouse.down();
  await page.mouse.move(image!.x + 300, image!.y + 230, { steps: 20 });
  await page.mouse.up();
  await expect.poll(async () => (await nativeAnnotations()).length).toBe(count + 1);
}

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
let page: Page;
let errors: string[];
const fixture = path.resolve("../legacy/v1/app/ui/samples/sample_paper.pdf");

// Playwright pierces the complete viewer's open shadow root through its public UI.
const pdfViewport = () =>
  page.locator('.pdf-reader .bg-bg-app[style*="overflow: auto"]');
const pdfImage = () =>
  pdfViewport().locator('img[style*="pointer-events: none"]').first();
const pdfPages = () => page.locator('[data-overlay-id="page-controls"]');
const pdfPage = () => pdfPages().locator("input");
const pdfZoom = () =>
  page.getByRole("textbox", { name: "Set zoom", exact: true });

async function setPdfZoom(percent: string) {
  await pdfZoom().fill(percent);
  await pdfZoom().press("Enter");
  await expect(pdfZoom()).toHaveValue(percent);
}

async function jumpPdfPage(number: number) {
  await pdfPages().hover();
  await pdfPage().fill(String(number));
  await pdfPage().press("Enter");
  await expect(pdfPage()).toHaveValue(String(number));
  await expect
    .poll(async () => {
      const before = await pdfViewport().evaluate((e) => e.scrollTop);
      await page.waitForTimeout(100);
      return Math.abs(
        before - (await pdfViewport().evaluate((e) => e.scrollTop)),
      );
    })
    .toBe(0);
  await expect(pdfPage()).toHaveValue(String(number));
}

async function expectPdfRendered() {
  await expect(pdfImage()).toBeVisible();
  await expect
    .poll(() =>
      pdfImage().evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(100);
}

async function launch() {
  const visible = process.env.PAPER30MIN_TEST_WINDOW === "visible";
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PAPER30MIN_PROFILE: path.join(sandbox, "profile"),
    PAPER30MIN_TEST_WINDOW: visible ? "visible" : "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: ["."], env });
  desktopProcess = desktop.process();
  page = await desktop.firstWindow();
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (!visible) {
    // Windows runners can clamp the initial window to their 1024px desktop.
    // Resize the native window so later native-resize tests keep working.
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
    );
    // Keep browser input/clipboard APIs active without taking native desktop focus.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([1440, 960]);
  }
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible();
  expect(await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isVisible())).toBe(visible);
}

async function choose(selected: string | null) {
  // Only the operating-system chooser is substituted; the production preload, IPC,
  // Node utility process and disk operations run unchanged.
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: file === null,
      filePaths: file ? [file] : [],
    });
  }, selected);
}

async function preview(source: string, parent?: string, name = "研究工程") {
  await choose(source);
  await page
    .getByRole("button", { name: "从 PDF 新建工程", exact: true })
    .click();
  await page.getByLabel("工程名称", { exact: true }).fill(name);
  if (parent) {
    await choose(parent);
    await page.getByRole("button", { name: "选择位置", exact: true }).click();
  }
}

async function create(source: string, parent?: string, name = "研究工程", reviewed = false) {
  await preview(source, parent, name);
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  if (reviewed) {
    const root = await page.evaluate(() => window.desktop.invoke<{ defaultFolder: string }>({ type: "preferences" }));
    await seedParsing(path.join(parent ?? root.defaultFolder, name));
  }
}

async function readManifest(root: string) {
  return JSON.parse(
    await fs.readFile(path.join(root, "paper30min.json"), "utf8"),
  );
}

async function closeDesktopForCleanup() {
  if (
    !desktopProcess ||
    desktopProcess.exitCode !== null ||
    desktopProcess.signalCode !== null
  ) return;
  // Only teardown discards disposable drafts; normal close protection stays active.
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxSyncOptions;
      if (
        options.message !== "有未保存的文档，确定放弃编辑并关闭吗？" ||
        options.buttons?.[1] !== "放弃并关闭"
      ) throw new Error("测试清理遇到非预期的原生确认框。");
      return 1;
    };
  });
  await desktop.close();
}

test.beforeEach(async () => {
  errors = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-desktop-"));
  await fs.mkdir(path.join(sandbox, "projects"));
  if (process.env.PAPER30MIN_REAL_PARSING_CONFIG) {
    await fs.mkdir(path.join(sandbox, "profile"));
    await fs.copyFile(
      process.env.PAPER30MIN_REAL_PARSING_CONFIG,
      path.join(sandbox, "profile/parsing-settings.json"),
    );
    await fs.copyFile(
      path.join(
        path.dirname(process.env.PAPER30MIN_REAL_PARSING_CONFIG),
        "Local State",
      ),
      path.join(sandbox, "profile/Local State"),
    );
  }
  await launch();
});
test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    // The sandbox is an exclusively created test directory, never a user-selected path.
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("百度候选在停止、重开、下载恢复后保留图片和可点击块引用，搬迁后离线可读", async () => {
  test.setTimeout(120_000);
  let submits = 0;
  let downloads = 0;
  let done = false;
  const rows = (
    await fs.readFile(
      "../legacy/v1/app/src-tauri/tests/fixtures/aistudio/1512.03385.jsonl",
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const png = new PNG({ width: 20, height: 20 });
  png.data.fill(180);
  rows[0].result.layoutParsingResults[0].markdown = {
    text: "![服务图片](imgs/figure.png)",
    images: { "imgs/figure.png": PNG.sync.write(png).toString("base64") },
  };
  const raw = rows.map((row) => JSON.stringify(row)).join("\n");
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      submits++;
      for await (const _chunk of request) {
        /* Consume the real upload. */
      }
      response.end(JSON.stringify({ data: { jobId: "desktop-1" } }));
    } else if (request.url === "/jobs/desktop-1")
      response.end(
        JSON.stringify({
          data: done
            ? { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } }
            : { state: "running" },
        }),
      );
    else {
      downloads++;
      if (downloads === 1) {
        response.writeHead(503);
        response.end();
      } else response.end(raw);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/jobs`;
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "解析模型", exact: true }).click();
    await page.getByLabel("百度任务地址", { exact: true }).fill(endpoint);
    await page
      .getByLabel("百度 Token", { exact: true })
      .fill("desktop-parsing-secret");
    await page.getByRole("button", { name: "保存解析配置" }).click();
    await expect(page.getByRole("status")).toContainText("解析配置已保存");
    await page.screenshot({ path: "test-results/parsing-settings.png" });
    await page.setViewportSize({ width: 650, height: 850 });
    await page.screenshot({ path: "test-results/parsing-settings-narrow.png", animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 960 });
    expect(
      await fs.readFile(
        path.join(sandbox, "profile/parsing-settings.json"),
        "utf8",
      ),
    ).not.toContain("desktop-parsing-secret");
    await page.getByRole("button", { name: "返回工程" }).click();
    await create(
      path.resolve(
        "../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf",
      ),
      path.join(sandbox, "projects"),
    );
    const root = path.join(sandbox, "projects/研究工程");
    await page.getByRole("navigation", { name: "阅读导航" }).getByRole("button", { name: "论文解析", exact: true }).click();
    await expect(page.getByText("还没有解析正文", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/parsing-empty.png" });
    await page.getByRole("button", { name: "解析 PDF", exact: true }).click();
    await page.getByRole("button", { name: "上传并解析", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("云端处理中");
    await expect(page.getByRole("button", { name: "删除解析", exact: true })).toBeDisabled();
    const activeRuns = await page.evaluate(root => window.desktop.parsing<ParsingRun[]>({ type: "status", root }), root);
    await expect(page.evaluate(({ root, batchId }) => window.desktop.parsing({ type: "delete", root, batchId }),
      { root, batchId: activeRuns[0].batchId })).rejects.toThrow("先停止");
    await page.getByRole("button", { name: "停止解析" }).click();
    await expect(page.getByRole("status")).toContainText("已停止");
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /研究工程/ }).click();
    await expect(page.getByRole("status")).toContainText("已停止");
    done = true;
    await page.getByRole("button", { name: "恢复解析" }).click();
    await expect(page.getByRole("status")).toContainText("处理失败");
    await page.getByRole("button", { name: "恢复解析" }).click();
    await expect.poll(async () => (await page.evaluate(root => window.desktop.parsing<ParsingRun[]>({ type: "status", root }), root))[0],
      { timeout: 45_000 }).toMatchObject({ phase: "candidate" });
    await expect(page.getByRole("status")).toContainText("待 Agent 审阅");
    await expect(page.getByText("desktop-1", { exact: true })).not.toBeVisible();
    await page.getByText("任务详情", { exact: true }).click();
    await expect(page.getByText("desktop-1", { exact: true })).toBeVisible();
    await page.getByText("任务详情", { exact: true }).click();
    await page.screenshot({ path: "test-results/parsing-ready.png" });
    await page.getByRole("button", { name: "收起 Agent", exact: true }).click();
    await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
    await page.setViewportSize({ width: 650, height: 850 });
    await page.screenshot({ path: "test-results/parsing-ready-narrow.png", animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "展开左侧栏", exact: true }).click();
    await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
    expect(submits).toBe(1);
    const [run] = await page.evaluate(
      async (root) =>
        window.desktop.parsing<ParsingRun[]>({ type: "status", root }),
      root,
    );
    const mapping = JSON.parse(
      await fs.readFile(
        path.join(root, ".paper30min/parsing", run.batchId, "mapping.json"),
        "utf8",
      ),
    ) as ParsingMapping;
    const imagePath = path.join(root, "text", run.batchId, mapping.images[0].path);
    const originalImage = await fs.readFile(imagePath);
    await fs.writeFile(imagePath, "damaged");
    await page.getByRole("button", { name: "查看正文" }).click();
    await expect(page.getByRole("alert")).toContainText("候选图片缺失或已变化");
    await page.waitForTimeout(1800);
    await expect(page.getByRole("alert")).toContainText("候选图片缺失或已变化");
    await fs.writeFile(imagePath, originalImage);
    await fs.writeFile(path.join(sandbox, "profile/parsing-settings.json"), "damaged");
    await page.getByRole("button", { name: "查看正文" }).click();
    await expect(page.getByRole("group", { name: "Markdown 视图" })).toBeVisible();
    await expect(page.locator(".markdown-preview img").first()).toBeVisible();
    for (const label of ["text", "display_formula", "chart"]) {
      const block = mapping.blocks.find(
        (block) => block.label === label && block.citation.kind === "region",
      )!;
      await page
        .locator(
          `.markdown-preview a[href="paper://cite/${block.citation.id}"]`,
        )
        .first()
        .click();
      await expectPdfRendered();
      const highlights = page.locator(
        `[aria-label="引用高亮"] [data-citation-page="${block.citation.pages[0].page}"]`,
      );
      await expect(highlights).toHaveCount(
        block.citation.pages[0].rects.length,
      );
      await expect
        .poll(async () => {
          const mark = await highlights.first().boundingBox();
          const viewport = await pdfViewport().boundingBox();
          return (
            !!mark &&
            !!viewport &&
            mark.y + mark.height > viewport.y &&
            mark.y < viewport.y + viewport.height
          );
        })
        .toBe(true);
      await page
        .getByRole("tab", { name: path.basename(run!.candidate!), exact: true })
        .click();
      await expect(
        page.getByRole("group", { name: "Markdown 视图" }),
      ).toBeVisible();
    }
    await page.screenshot({ path: "test-results/ste82-candidate-desktop.png" });
    await page.getByRole("button", { name: "收起 Agent", exact: true }).click();
    await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
    await page.setViewportSize({ width: 650, height: 850 });
    await page.screenshot({ path: "test-results/ste82-candidate-narrow.png", animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const relocated = path.join(sandbox, "搬迁工程");
    await desktop.close();
    await fs.cp(root, relocated, { recursive: true });
    await fs.rm(root, { recursive: true });
    await launch();
    await choose(relocated);
    await page
      .getByRole("button", { name: "打开工程文件夹", exact: true })
      .click();
    await expect(page.locator(".markdown-preview")).toContainText("Deep Residual Learning for Image Recognition");
    await expect
      .poll(() =>
        page
          .locator(".markdown-preview img")
          .evaluateAll((images) =>
            images.every(
              (image) => (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    expect(
      await fs.readFile(path.join(relocated, run.candidate!), "utf8"),
    ).not.toContain(endpoint);
    const citationsBeforeDelete = await fs.readFile(path.join(relocated, ".paper30min-citations.json"), "utf8");
    const pdfBeforeDelete = await fs.readFile(path.join(relocated, "text/paper.pdf"));
    await page.getByRole("navigation", { name: "阅读导航" }).getByRole("button", { name: "论文解析", exact: true }).click();
    await page.getByRole("button", { name: "删除解析", exact: true }).click();
    const deleteDialog = page.getByRole("dialog", { name: "删除解析记录" });
    await deleteDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("button", { name: "查看正文", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除解析", exact: true }).click();
    await page.screenshot({ path: "test-results/parsing-delete.png" });
    await deleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByText("还没有解析正文", { exact: true })).toBeVisible();
    await expect(fs.stat(path.join(relocated, "text", run.batchId))).rejects.toThrow();
    await expect(fs.stat(path.join(relocated, ".paper30min/parsing", run.batchId))).rejects.toThrow();
    expect(await fs.readFile(path.join(relocated, ".paper30min-citations.json"), "utf8")).toBe(citationsBeforeDelete);
    expect(await fs.readFile(path.join(relocated, "text/paper.pdf"))).toEqual(pdfBeforeDelete);
    await desktop.close();
    await launch();
    await choose(relocated);
    await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
    await page.getByRole("navigation", { name: "阅读导航" }).getByRole("button", { name: "论文解析", exact: true }).click();
    await expect(page.getByText("还没有解析正文", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "解析模型", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("解析配置无法读取");
    await page.getByRole("button", { name: "清除百度 Token", exact: true }).click();
    await page.getByRole("button", { name: "保存解析配置", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("解析配置已保存");
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("真实百度服务生成可回查候选并记录格式与耗时", async () => {
  test.skip(
    !process.env.PAPER30MIN_REAL_PARSING_TOKEN &&
      !process.env.PAPER30MIN_REAL_PARSING_CONFIG &&
      !process.env.PAPER30MIN_REAL_PARSING_PROJECT,
    "需要本机百度配置或已有真实候选。",
  );
  test.setTimeout(300_000);
  if (process.env.PAPER30MIN_REAL_PARSING_TOKEN)
    await page.evaluate(async (token) => {
      const settings = await window.desktop.parsing<any>({ type: "settings" });
      return window.desktop.parsing<any>({
        type: "saveSettings",
        settings,
        apiKey: token,
      });
    }, process.env.PAPER30MIN_REAL_PARSING_TOKEN!);
  if (
    process.env.PAPER30MIN_REAL_PARSING_CONFIG ||
    process.env.PAPER30MIN_REAL_PARSING_TOKEN
  ) {
    const config = await page.evaluate(() =>
      window.desktop.parsing<any>({ type: "settings" }),
    );
    expect(config.hasKey).toBe(true);
    expect(config.keyError, "本机加密配置需能在此隔离配置目录解密").toBeFalsy();
  }
  let root = process.env.PAPER30MIN_REAL_PARSING_PROJECT;
  if (root) {
    await choose(root);
    await page
      .getByRole("button", { name: "打开工程文件夹", exact: true })
      .click();
  } else {
    await create(
      path.resolve(
        process.env.PAPER30MIN_REAL_PARSING_SOURCE ??
          "../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf",
      ),
      path.join(sandbox, "projects"),
    );
    root = path.join(sandbox, "projects/研究工程");
  }
  const output = path.resolve(
    process.env.PAPER30MIN_REAL_PARSING_OUTPUT ?? "tmp/ste82-real",
  );
  await fs.mkdir(output, { recursive: true });
  try {
    await page.getByRole("button", { name: "论文解析", exact: true }).click();
    const started = Date.now();
    if (process.env.PAPER30MIN_REAL_PARSING_PROJECT) {
      const existing = await page.evaluate(
        async (root) =>
          window.desktop.parsing<ParsingRun[]>({ type: "status", root }),
        root,
      );
      if (existing[0].phase !== "candidate")
        await page
          .getByRole("button", { name: "恢复解析", exact: true })
          .click();
    } else {
      await page.getByRole("button", { name: "解析 PDF", exact: true }).click();
      await page
        .getByRole("button", { name: "上传并解析", exact: true })
        .click();
      await expect
        .poll(async () => {
          const alert = page.locator(".parsing-panel [role=alert]");
          if (await alert.count()) return alert.innerText();
          const runs = await page.evaluate(
            async (root) =>
              window.desktop.parsing<ParsingRun[]>({ type: "status", root }),
            root,
          );
          return runs.length ? "started" : "";
        })
        .toBe("started");
    }
    let run: ParsingRun | undefined;
    await expect
      .poll(
        async () => {
          [run] = await page.evaluate(
            async (root) =>
              window.desktop.parsing<ParsingRun[]>({ type: "status", root }),
            root,
          );
          if (run && ["failed", "unknown", "remote-failed"].includes(run.phase))
            throw new Error(run.error ?? run.phase);
          return run?.phase;
        },
        { timeout: 240_000, intervals: [1500] },
      )
      .toBe("candidate");
    const mapping = JSON.parse(
      await fs.readFile(
        run!.candidate!.startsWith("text/candidates/")
          ? path.join(root, path.dirname(run!.candidate!), "mapping.json")
          : path.join(root, ".paper30min/parsing", run!.batchId, "mapping.json"),
        "utf8",
      ),
    ) as ParsingMapping;
    await page.getByRole("button", { name: "查看正文" }).click();
    await expect(page.locator(".markdown-preview")).toContainText("解析候选");
    await expect
      .poll(() =>
        page
          .locator(".markdown-preview img")
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every(
                (image) => (image as HTMLImageElement).naturalWidth > 0,
              ),
          ),
      )
      .toBe(true);
    for (const label of ["text", "display_formula", "chart"]) {
      const block = mapping.blocks.find(
        (block) =>
          block.label === label &&
          block.citation.kind === "region" &&
          (label !== "text" || block.text.length > 100),
      );
      if (!block) continue;
      await page
        .locator(
          `.markdown-preview a[href="paper://cite/${block.citation.id}"]`,
        )
        .first()
        .click();
      await expectPdfRendered();
      const highlights = page.locator(
        `[aria-label="引用高亮"] [data-citation-page="${block.citation.pages[0].page}"]`,
      );
      await expect(highlights).toHaveCount(
        block.citation.pages[0].rects.length,
      );
      await expect
        .poll(async () => {
          const mark = await highlights.first().boundingBox();
          const viewport = await pdfViewport().boundingBox();
          return (
            !!mark &&
            !!viewport &&
            mark.y + mark.height > viewport.y &&
            mark.y < viewport.y + viewport.height
          );
        })
        .toBe(true);
      await page.screenshot({
        path: path.join(output, `ste82-real-${label}.png`),
      });
      await page
        .getByRole("tab", { name: path.basename(run!.candidate!), exact: true })
        .click();
    }
    await fs.writeFile(
      path.join(output, "evidence.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          batchId: run!.batchId,
          documentSha256: run!.document.sha256,
          elapsedMs: run!.elapsedMs,
          verificationMs: Date.now() - started,
          reused: !!process.env.PAPER30MIN_REAL_PARSING_PROJECT,
          modelRequested: run!.model,
          pages: run!.pageCount,
          blocks: mapping.blocks.length,
          pageOnlyBlocks: mapping.blocks.filter(
            (block) => block.citation.kind === "page",
          ).length,
          regionBlocks: mapping.blocks.filter(
            (block) => block.citation.kind === "region",
          ).length,
          images: mapping.images.length,
          vendorImages: mapping.images.filter((image) => image.vendorPath)
            .length,
          labels: [...new Set(mapping.blocks.map((block) => block.label))],
        },
        null,
        2,
      ),
    );
    await page.screenshot({
      path: path.join(output, "ste82-real-candidate.png"),
    });
  } finally {
    await desktop.close();
    await fs.cp(root, path.join(output, `project-${Date.now()}`), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if (
      process.env.PAPER30MIN_REAL_PARSING_CONFIG ||
      process.env.PAPER30MIN_REAL_PARSING_TOKEN
    ) {
      await fs.copyFile(
        path.join(sandbox, "profile/parsing-settings.json"),
        path.join(output, "parsing-settings.json"),
      );
      await fs.copyFile(
        path.join(sandbox, "profile/Local State"),
        path.join(output, "Local State"),
      );
    }
  }
});

test("窗口关闭保护保留草稿，测试清理自动放弃临时编辑", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const note = path.join(root, "notes/关闭.md");
  const original = "# 原始内容\n";
  await fs.writeFile(note, original);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "关闭.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await editor.press("Control+End");
  await fs.chmod(note, 0o444);
  await editor.pressSequentially("未保存草稿");
  await expect(page.getByRole("alert")).toContainText("保存失败");

  const prompt = await desktop.evaluate(({ BrowserWindow, dialog }) =>
    new Promise<string>((resolve) => {
      dialog.showMessageBoxSync = (...args: unknown[]) => {
        const options = args.at(-1) as Electron.MessageBoxSyncOptions;
        resolve(options.message);
        return 0;
      };
      BrowserWindow.getAllWindows()[0].close();
    }),
  );
  expect(prompt).toBe("有未保存的文档，确定放弃编辑并关闭吗？");
  await expect(editor).toContainText("未保存草稿");

  await closeDesktopForCleanup();
  expect(desktopProcess.exitCode).toBe(0);
  await fs.chmod(note, 0o666);
  expect(await fs.readFile(note, "utf8")).toBe(original);
});

test("多服务模型选择、思考流与会话恢复", async () => {
  const requests: { path: string; key: string; model: string; body: any }[] =
    [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push({
      path: request.url ?? "",
      key: request.headers.authorization ?? "",
      model: body.model,
      body,
    });
    if (body.model === "ultra-d") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "unsupported reasoning_effort ultra" },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "multi",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (body.model === "reasoning-b") {
      emit({ reasoning_content: "先核对证据。" });
      await held;
    } else if (body.enable_thinking) emit({ reasoning_content: "继续分析。" });
    emit({ content: `来自 ${body.model}` });
    emit({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await create(fixture, path.join(sandbox, "projects"), "多模型工程", true);
    await page.evaluate(
      async ({ address }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...settings,
            services: [
              {
                id: "one",
                name: "共享服务",
                api: "openai-completions",
                baseUrl: `${address}/one`,
                hasKey: false,
              },
              {
                id: "two",
                name: "独立服务",
                api: "openai-completions",
                baseUrl: `${address}/two`,
                hasKey: false,
              },
            ],
            models: [
              {
                id: "a",
                serviceId: "one",
                name: "模型 A",
                model: "answer-a",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "low"],
                thinking: "off",
              },
              {
                id: "b",
                serviceId: "one",
                name: "模型 B",
                model: "reasoning-b",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "low"],
                thinking: "low",
              },
              {
                id: "c",
                serviceId: "two",
                name: "模型 C",
                model: "answer-c",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off"],
                thinking: "off",
              },
              {
                id: "d",
                serviceId: "one",
                name: "模型 D",
                model: "ultra-d",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "ultra"],
                thinking: "ultra",
              },
              {
                id: "e",
                serviceId: "one",
                name: "模型 E",
                model: "xhigh-e",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "xhigh"],
                thinking: "xhigh",
              },
              {
                id: "f",
                serviceId: "one",
                name: "模型 F",
                model: "max-f",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "max"],
                thinking: "max",
              },
            ],
            selectedModelId: "a",
          },
          apiKeys: { one: "shared-secret", two: "isolated-secret" },
        });
      },
      { address },
    );
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(page.locator(".agent-service-choice")).toHaveCount(2);
    await expect(page.locator(".agent-model-row")).toHaveCount(5);
    await page.getByRole("button", { name: "返回工作台" }).click();
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 B");
    await page.screenshot({ path: "test-results/models-menu.png" });
    await page.getByRole("button", { name: /模型 B.*共享服务/ }).click();
    await expect(page.getByLabel("思考等级")).toHaveValue("low");
    await page.getByLabel("Agent 消息").fill("第一轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".thinking-card")).toBeVisible();
    await page.locator(".thinking-card summary").click();
    await expect(page.locator(".thinking-content")).toHaveText("先核对证据。");
    await page.screenshot({ path: "test-results/thinking-expanded.png" });
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 A");
    await page.getByRole("button", { name: /模型 A.*共享服务/ }).click();
    await page.getByLabel("Agent 消息").fill("切换期间补充");
    await page.getByRole("button", { name: "补充消息" }).click();
    await expect(page.getByRole("alert")).toContainText("等待当前回复完成");
    release();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await page.getByLabel("Agent 消息").fill("第二轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
    expect(requests.slice(0, 2).map((r) => [r.path, r.key, r.model])).toEqual([
      ["/one/chat/completions", "Bearer shared-secret", "reasoning-b"],
      ["/one/chat/completions", "Bearer shared-secret", "answer-a"],
    ]);
    expect(requests[0].body.reasoning_effort).toBe("low");
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 C");
    await page.getByRole("button", { name: /模型 C.*独立服务/ }).click();
    await page.getByLabel("Agent 消息").fill("第三轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(3);
    expect(requests[2].key).toBe("Bearer isolated-secret");
    expect(requests[2].path).toBe("/two/chat/completions");
    expect(page.locator(".thinking-card")).toHaveCount(1);
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 D");
    await page.getByRole("button", { name: /模型 D.*共享服务/ }).click();
    await page.getByLabel("Agent 消息").fill("测试 ultra");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("alert")).toContainText("模型请求失败");
    expect(requests[3].body.reasoning_effort).toBe("ultra");
    expect(requests).toHaveLength(4);
    for (const [name, level] of [
      ["模型 E", "xhigh"],
      ["模型 F", "max"],
    ]) {
      await page.getByRole("button", { name: "选择模型" }).click();
      await page.getByLabel("搜索模型").fill(name);
      await page
        .getByRole("button", { name: new RegExp(`${name}.*共享服务`) })
        .click();
      await page.getByLabel("Agent 消息").fill(`测试 ${level}`);
      await page.getByRole("button", { name: "发送消息" }).click();
      await expect(
        page.locator(".chat-message.assistant").last(),
      ).toContainText(`来自 ${level}-`);
      expect(requests.at(-1)?.body.reasoning_effort).toBe(level);
    }
    const sessionId = await page
      .getByLabel("会话", { exact: true })
      .inputValue();
    await desktop.close();
    await launch();
    const sessions = await page.evaluate(
      async ({ root, sessionId }) =>
        window.desktop.agent<ChatSession>({
          type: "open",
          root,
          id: sessionId,
        }),
      { root: path.join(sandbox, "projects", "多模型工程"), sessionId },
    );
    expect(
      sessions.messages.some((message) => message.thinking === "先核对证据。"),
    ).toBe(true);
    const firstReply = sessions.messages.find(
      (message) => message.thinking === "先核对证据。",
    )!;
    const branch = await page.evaluate(
      async ({ root, sessionId, messageId }) =>
        window.desktop.agent<ChatSession>({
          type: "branch",
          root,
          id: sessionId,
          messageId,
        }),
      {
        root: path.join(sandbox, "projects", "多模型工程"),
        sessionId,
        messageId: firstReply.id,
      },
    );
    expect(
      branch.messages.some((message) => message.thinking === "先核对证据。"),
    ).toBe(true);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("百炼思考配置保持 system 角色，关闭档显式关闭且始终显示", async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.messages.some((message: any) => message.role === "developer")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = {
      content: `完成 ${requests.length}`,
      ...(body.enable_thinking ? { reasoning_content: "已核对。" } : {}),
    };
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = createServer();
  const sockets = new Set<import("node:stream").Duplex>();
  proxy.on("connect", (_request, client, head) => {
    const upstream = connect(
      (server.address() as { port: number }).port,
      "127.0.0.1",
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      },
    );
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => {
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "思考协议工程", true);
    await page.evaluate(
      async (port) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl =
          "http://dashscope.aliyuncs.com/compatible-mode/v1";
        settings.models[0] = {
          ...settings.models[0],
          model: "qwen3.8-max",
          availableThinking: ["off", "low", "medium", "high", "xhigh"],
          thinking: "high",
        };
        settings.proxy = "custom";
        settings.proxyUrl = `http://127.0.0.1:${port}`;
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: "controlled-thinking-key",
        });
      },
      (proxy.address() as { port: number }).port,
    );
    await page.getByLabel("Agent 消息").fill("你好");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("完成 1");
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].enable_thinking).toBe(true);
    expect(requests[0].reasoning_effort).toBe("high");
    await expect(page.locator(".thinking-card")).toHaveCount(1);
    await page.getByLabel("思考等级").selectOption("off");
    await page.getByLabel("Agent 消息").fill("继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("完成 2");
    expect(requests[1].enable_thinking).toBe(false);
    expect(requests[1].reasoning_effort).toBeUndefined();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page
      .locator(".agent-model-row button[aria-expanded]")
      .first()
      .click();
    await expect(page.getByText("生成参数", { exact: true })).toHaveCount(0);
    for (const level of ["low", "medium", "high", "xhigh"])
      await page.getByRole("checkbox", { name: level, exact: true }).uncheck();
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await page.getByRole("button", { name: "返回工作台" }).click();
    await expect(page.getByLabel("思考等级")).toBeVisible();
    await expect(page.getByLabel("思考等级")).toHaveValue("off");
    expect(
      await page
        .getByLabel("思考等级")
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe(
      await page
        .locator(".model-picker-trigger")
        .evaluate((el) => getComputedStyle(el).fontSize),
    );
    await page.getByLabel("Agent 消息").fill("不启用思考");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("完成 3");
    expect(requests[2].enable_thinking).toBe(false);
    await page.screenshot({ path: "test-results/thinking-off-control.png" });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  }
});

test("Exa 密钥设置支持加密保存、重开、独立恢复与清除", async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Agent 网络搜索", exact: true })
    .click();
  const keyInput = page.getByLabel("Exa API key", { exact: true });
  await expect(keyInput).toHaveAttribute("placeholder", "未配置，使用免费服务");
  await keyInput.fill("exa-settings-secret");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(keyInput).toHaveValue("");
  const file = path.join(sandbox, "profile", "agent-settings.json");
  expect(await fs.readFile(file, "utf8")).not.toContain("exa-settings-secret");
  await page.evaluate(() =>
    window.desktop.agent({ type: "selectModel", modelId: "default" }),
  );
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "Agent 网络搜索", exact: true })
    .click();
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveAttribute(
    "placeholder",
    "已保存，留空保留",
  );
  const publicSettings = await page.evaluate(() =>
    window.desktop.agent<AgentSettings>({ type: "settings" }),
  );
  expect(publicSettings.search?.hasKey).toBe(true);
  expect(JSON.stringify(publicSettings)).not.toContain("exa-settings-secret");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(560, 760),
  );
  await page
    .getByLabel("Exa API key", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/ste100-settings-narrow.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await desktop.close();
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  stored.encryptedExaKey = "broken-key";
  stored.encryptedKeys.default = "broken-model-key";
  await fs.writeFile(file, JSON.stringify(stored));
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "Agent 网络搜索", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Exa 密钥无法读取");
  await page.getByLabel("移除 Exa 密钥").check();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveAttribute(
    "placeholder",
    "未配置，使用免费服务",
  );
  expect(
    JSON.parse(await fs.readFile(file, "utf8")).encryptedExaKey,
  ).toBeUndefined();
  expect(JSON.parse(await fs.readFile(file, "utf8")).encryptedKeys.default).toBe("broken-model-key");
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByText("此密钥无法读取，请替换或移除。")).toBeVisible();
  await page.getByLabel("API 密钥", { exact: true }).fill("recovered-model-key");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(page.getByText("此密钥无法读取，请替换或移除。")).toHaveCount(0);
});

test("旧单模型配置读取后保留加密密钥", async () => {
  const encryptedKey = await desktop.evaluate(({ safeStorage }) =>
    safeStorage.encryptString("legacy-secret").toString("base64"),
  );
  await desktop.close();
  const file = path.join(sandbox, "profile", "agent-settings.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      model: "legacy-model",
      contextWindow: 32000,
      maxTokens: 1024,
      proxy: "direct",
      proxyUrl: "",
      encryptedKey,
    }),
  );
  await launch();
  const before = await page.evaluate(() =>
    window.desktop.agent<AgentSettings>({ type: "settings" }),
  );
  expect(before.services[0].hasKey).toBe(true);
  expect(before.models[0].model).toBe("legacy-model");
  expect(
    JSON.parse(await fs.readFile(file, "utf8")).formatVersion,
  ).toBeUndefined();
  await page.evaluate(
    async (settings) =>
      window.desktop.agent({ type: "saveSettings", settings }),
    before,
  );
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  expect(stored.formatVersion).toBe(2);
  expect(stored.encryptedKeys.default).toBeTruthy();
  expect(JSON.stringify(stored)).not.toContain("legacy-secret");
});

test("单服务密钥损坏可独立恢复，协议切换校正该服务模型等级", async () => {
  const received: { path: string; key: string }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _part of request) {
      /* consume request */
    }
    received.push({
      path: request.url ?? "",
      key: request.headers.authorization ?? "",
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "key",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { content: "完成" }, finish_reason: null },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({ id: "key", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await create(fixture, path.join(sandbox, "projects"), "密钥恢复工程", true);
    await page.evaluate(
      async ({ base }) => {
        const original = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...original,
            services: [
              {
                id: "a",
                name: "服务 A",
                api: "openai-completions",
                baseUrl: `${base}/a`,
                hasKey: false,
              },
              {
                id: "b",
                name: "服务 B",
                api: "openai-completions",
                baseUrl: `${base}/b`,
                hasKey: false,
              },
            ],
            models: [
              {
                id: "a1",
                serviceId: "a",
                name: "A1",
                model: "a1",
                contextWindow: 32000,
                maxTokens: 1024,
                availableThinking: ["off", "ultra"],
                thinking: "ultra",
              },
              {
                id: "a2",
                serviceId: "a",
                name: "A2",
                model: "a2",
                contextWindow: 32000,
                maxTokens: 1024,
                availableThinking: ["high", "ultra"],
                thinking: "ultra",
              },
              {
                id: "b1",
                serviceId: "b",
                name: "B1",
                model: "b1",
                contextWindow: 32000,
                maxTokens: 1024,
                availableThinking: ["off"],
                thinking: "off",
              },
            ],
            selectedModelId: "b1",
          },
          apiKeys: { a: "old-a", b: "valid-b" },
        });
      },
      { base },
    );
    const file = path.join(sandbox, "profile", "agent-settings.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    const retained = stored.encryptedKeys.b;
    stored.encryptedKeys.a = "broken-key";
    await fs.writeFile(file, JSON.stringify(stored));
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "选择服务 服务 A" }).click();
    await expect(
      page.getByText("此密钥无法读取，请替换或移除。"),
    ).toBeVisible();
    await page.getByLabel("API 密钥", { exact: true }).fill("new-a");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    expect(JSON.parse(await fs.readFile(file, "utf8")).encryptedKeys.b).toBe(
      retained,
    );
    await page.getByRole("button", { name: "返回工作台" }).click();
    await page.getByLabel("Agent 消息").fill("服务 B");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("A1");
    await page.getByRole("button", { name: /A1.*服务 A/ }).click();
    await expect(page.getByRole("button", { name: "选择模型" })).toHaveText("A1");
    await page.getByLabel("思考等级").selectOption("off");
    await page.getByLabel("Agent 消息").fill("服务 A");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
    expect(received.map((item) => [item.path, item.key])).toEqual([
      ["/b/chat/completions", "Bearer valid-b"],
      ["/a/chat/completions", "Bearer new-a"],
    ]);
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "选择服务 服务 A" }).click();
    await page.getByLabel("接口协议").selectOption("openai-responses");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    const final = await page.evaluate(() =>
      window.desktop.agent<AgentSettings>({ type: "settings" }),
    );
    const adjusted = final.models.filter((model) => model.serviceId === "a");
    expect(adjusted.map((model) => [model.id, model.thinking])).toEqual([
      ["a1", "off"],
      ["a2", "high"],
    ]);
    expect(
      adjusted.every((model) => !model.availableThinking.includes("ultra")),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("模型设置在服务和模型间保留草稿并在重开后显示保存结果", async () => {
  await page.evaluate(async () => {
    const original = await window.desktop.agent<AgentSettings>({
      type: "settings",
    });
    await window.desktop.agent({
      type: "saveSettings",
      settings: {
        ...original,
        services: [
          {
            id: "a",
            name: "服务 A",
            api: "openai-completions",
            baseUrl: "https://a.example/v1",
            hasKey: false,
          },
          {
            id: "b",
            name: "服务 B",
            api: "openai-completions",
            baseUrl: "https://b.example/v1",
            hasKey: false,
          },
        ],
        models: [
          {
            id: "a1",
            serviceId: "a",
            name: "模型 A",
            model: "a-model",
            contextWindow: 32000,
            maxTokens: 1024,
            availableThinking: ["off"],
            thinking: "off",
          },
          {
            id: "a2",
            serviceId: "a",
            name: "备用模型",
            model: "spare-model",
            contextWindow: 32000,
            maxTokens: 1024,
            availableThinking: ["off"],
            thinking: "off",
          },
          {
            id: "b1",
            serviceId: "b",
            name: "模型 B",
            model: "b-model",
            contextWindow: 64000,
            maxTokens: 2048,
            availableThinking: ["off"],
            thinking: "off",
          },
        ],
        selectedModelId: "a1",
      },
    });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await page.getByLabel("模型端点").fill("https://a-updated.example/v1");
  await page.getByLabel("API 密钥", { exact: true }).fill("secret-a");
  await page.getByRole("button", { name: "编辑模型 模型 A" }).click();
  await page.getByLabel("模型显示名称").fill("模型 A 已编辑");
  await page.getByLabel("上下文预算", { exact: true }).fill("");

  await page.getByRole("button", { name: "选择服务 服务 B" }).click();
  await page.getByLabel("模型端点").fill("https://b-updated.example/v1");
  await page.getByLabel("API 密钥", { exact: true }).fill("secret-b");
  await page.getByRole("button", { name: "编辑模型 模型 B" }).click();
  await page.getByLabel("模型名称").fill("b-model-updated");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toContainText(
    "模型 A 已编辑 的预算无效",
  );

  await page.getByRole("button", { name: "选择服务 服务 A" }).click();
  await expect(page.getByLabel("模型端点")).toHaveValue(
    "https://a-updated.example/v1",
  );
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue(
    "secret-a",
  );
  await page.getByRole("button", { name: "编辑模型 模型 A 已编辑" }).click();
  await expect(page.getByLabel("模型显示名称")).toHaveValue("模型 A 已编辑");
  await expect(page.getByLabel("上下文预算", { exact: true })).toHaveValue("");
  await page.getByLabel("上下文预算", { exact: true }).fill("48000");
  await page
    .getByRole("button", { name: "删除模型 备用模型", exact: true })
    .click();
  await page
    .getByRole("button", { name: "编辑模型 模型 A 已编辑", exact: true })
    .click();
  await expect(page.getByLabel("上下文预算", { exact: true })).toHaveValue(
    "48000",
  );
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");

  await desktop.close();
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByLabel("模型端点")).toHaveValue(
    "https://a-updated.example/v1",
  );
  await page.getByRole("button", { name: "编辑模型 模型 A 已编辑" }).click();
  await expect(page.getByLabel("上下文预算", { exact: true })).toHaveValue(
    "48000",
  );
  await page.getByRole("button", { name: "选择服务 服务 B" }).click();
  await expect(page.getByLabel("模型端点")).toHaveValue(
    "https://b-updated.example/v1",
  );
  await page.getByRole("button", { name: "编辑模型 模型 B" }).click();
  await expect(page.getByLabel("模型名称")).toHaveValue("b-model-updated");
  const saved = await page.evaluate(() =>
    window.desktop.agent<AgentSettings>({ type: "settings" }),
  );
  expect(saved.services.every((service) => service.hasKey)).toBe(true);
});

test("Agent 回复排版、链接与历史阅读不被流式更新打断", async () => {
  let release: () => void = () => {};
  const continued = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = [
    "## 先看核心思路",
    "论文把 **局部信息** 与全局上下文结合起来。",
    "- 保留原始证据\n- 再比较实验结果",
    "公式为 $E = mc^2$。",
    "```python\nprint('paper')\n```",
    "| 方法 | 结果 |\n| --- | --- |\n| 基线 | 82.1 |",
    "[论文网页](https://example.org/paper)",
    "![不加载远程图片](https://example.org/tracker.png)",
    "<script>window.injected = true</script>",
    ...Array.from(
      { length: 20 },
      (_, i) =>
        `第 ${i + 1} 段：先定位证据，再核对原文，区分论文结论与自己的推测。`,
    ),
  ].join("\n\n");
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (text: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: "ui", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: text ? null : "stop" }] })}\n\n`,
      );
    chunk(answer);
    await continued;
    chunk("\n\n核查完成。");
    chunk(null);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await create(fixture, path.join(sandbox, "projects"), "阅读与思考", true);
    await expect(
      page.getByRole("heading", { name: "从一个问题开始" }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/agent-empty.png" });
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page
      .locator(".agent-model-row button[aria-expanded]")
      .first()
      .click();
    await page
      .getByLabel("模型端点")
      .fill(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      );
    await page.getByLabel("模型名称").fill("reading-model");
    const budget = page.getByLabel("上下文预算", { exact: true });
    const limit = page.getByLabel("输出上限", { exact: true });
    await budget.fill("");
    await expect(budget).toHaveValue("");
    await budget.pressSequentially("64000");
    await expect(budget).toHaveValue("64000");
    await limit.fill("");
    await expect(limit).toHaveValue("");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(limit).toHaveValue("");
    await expect(page.getByRole("status")).toHaveCount(0);
    await limit.pressSequentially("2048");
    await expect(limit).toHaveValue("2048");
    await page.getByLabel("API 密钥", { exact: true }).fill("ui-test-key");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await page.locator(".settings-canvas").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: "test-results/agent-settings.png" });
    await page
      .getByRole("button", { name: "编辑模型 reading-model", exact: true })
      .click();
    await expect(budget).toHaveValue("64000");
    await expect(limit).toHaveValue("2048");
    await page.getByRole("button", { name: "返回工作台" }).click();
    const composer = page.getByLabel("Agent 消息");
    await composer.fill("第一行第二行");
    await composer.press("Home");
    await composer.press("ArrowRight");
    await composer.press("ArrowRight");
    await composer.press("ArrowRight");
    await composer.press("Control+Enter");
    await expect(composer).toHaveValue("第一行\n第二行");
    await composer.pressSequentially("插入");
    await expect(composer).toHaveValue("第一行\n插入第二行");
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await page
      .getByLabel("Agent 消息")
      .fill("帮我梳理论文的核心思路。保留 **我的原始输入**。");
    await composer.press("Enter");
    await expect(page.locator(".chat-markdown h2")).toHaveText("先看核心思路");
    await expect(page.locator(".chat-message.assistant .chat-markdown strong")).toHaveText("局部信息");
    await expect(page.locator(".chat-markdown .katex")).toHaveCount(1);
    await expect(page.locator(".chat-markdown table")).toHaveCount(1);
    await expect(page.locator(".chat-markdown pre code")).toHaveText(
      "print('paper')\n",
    );
    await expect(
      page.locator(".chat-markdown img, .chat-markdown script"),
    ).toHaveCount(0);
    await expect(
      page.locator(".chat-message.user .message-text strong"),
    ).toHaveText("我的原始输入");
    const chat = page.locator(".chat");
    await chat.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(
      page.getByRole("button", { name: "回到最新消息" }),
    ).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(await chat.evaluate((el) => el.scrollTop)).toBe(0);
    await page.screenshot({ path: "test-results/agent-conversation.png" });
    await desktop.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        (globalThis as any).__openedLink = url;
      };
    });
    await page.getByRole("link", { name: "论文网页" }).click();
    expect(await desktop.evaluate(() => (globalThis as any).__openedLink)).toBe(
      "https://example.org/paper",
    );
    await page.getByRole("button", { name: "回到最新消息" }).click();
    await expect
      .poll(() =>
        chat.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThan(2);
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "从一个问题开始" }),
    ).toBeVisible();
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Pi 工具真实读取、修改、计算绘图、冲突与停止后重开", async () => {
  test.setTimeout(120000);
  let releaseThinking = () => {};
  const thinkingGate = new Promise<void>((resolve) => {
    releaseThinking = resolve;
  });
  const root = path.join(sandbox, "projects", "工具工程");
  const secret = "controlled-tool-secret-STE81-controlled";
  const plot =
    "$values = 1..4 | ForEach-Object { $_ * $_ }; $sum = ($values | Measure-Object -Sum).Sum; " +
    "Set-Content -LiteralPath notes/result.csv -Value ('sum,' + $sum); " +
    'Set-Content -LiteralPath notes/result.svg -Value \'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="white"/><polyline points="10,90 60,75 110,45 160,10" fill="none" stroke="green" stroke-width="4"/></svg>\'; Write-Output (\'sum=\' + $sum); ' +
    "$p = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -PassThru; Write-Output ('finished-child=' + $p.Id)";
  const actions = [
    { name: "read", args: { path: "notes/input.md" } },
    {
      name: "edit",
      args: {
        path: "notes/input.md",
        edits: [{ oldText: "score=2", newText: "score=3" }],
      },
    },
    {
      name: "write",
      args: {
        path: "notes/result.md",
        content: "# 计算结果\n\n![平方序列](result.svg)\n\n总和：30。",
      },
    },
    { name: "write", args: { path: "tmp/plot.ps1", content: plot } },
    { name: "bash", args: { command: "& ./tmp/plot.ps1" } },
    {
      name: "bash",
      args: {
        command: `1..2100 | ForEach-Object { 'line-' + $_ }; Write-Output $env:OPENAI_API_KEY; [Console]::Write(('${secret.slice(0, 15)}' + '${secret.slice(15)}')); exit 7`,
      },
    },
    { name: "write", args: { path: "text/paper.pdf", content: "bad" } },
    {
      name: "write",
      args: { path: "sources/dictionary.json", content: "bad" },
    },
    { name: "write", args: { path: "../escape.md", content: "bad" } },
    { name: "read", args: { path: "notes/input.md" } },
    {
      name: "edit",
      args: {
        path: "notes/input.md",
        edits: [{ oldText: "score=3", newText: "score=4" }],
      },
    },
    {
      name: "bash",
      args: {
        command:
          "$p = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -PassThru; Write-Output ('child=' + $p.Id); Start-Sleep -Seconds 40",
      },
    },
  ];
  let index = 0;
  const results: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const part of request) text += part;
    const payload = JSON.parse(text);
    const last = payload.messages.at(-1);
    if (last?.role === "tool") results.push(last);
    if (index === 10)
      await fs.writeFile(path.join(root, "notes/input.md"), "score=9\n");
    expect(payload.tools.map((tool: any) => tool.function.name).sort()).toEqual(
      [
        "bash",
        "create_annotation",
        "edit",
        "fetch_content",
        "get_search_content",
        "read",
        "read_pdf",
        "resolve_reference",
        "web_search",
        "write",
      ],
    );
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const action = actions[index++];
    const emit = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "tools",
          object: "chat.completion.chunk",
          model: "tool-model",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (action) {
      if (index === 1) {
        emit({
          reasoning_content: "先读取工程材料，再计算并核对结果。\n".repeat(18),
        });
        await thinkingGate;
      }
      emit({
        tool_calls: [
          {
            index: 0,
            id: "reused-tool-id",
            type: "function",
            function: {
              name: action.name,
              arguments: JSON.stringify(action.args),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: "任务完成" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "工具工程", true);
    await fs.writeFile(path.join(root, "notes/input.md"), "score=2\n");
    await page.evaluate(
      async ({ endpoint, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "tool-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: secret,
        });
      },
      {
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        secret,
      },
    );
    await page
      .getByLabel("Agent 消息")
      .fill(
        "读取并修改 input.md，计算平方总和、绘图；最后运行可停止的长任务。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const thinking = page.locator(".thinking-card").first();
    await thinking.locator("summary").click();
    releaseThinking();
    const shell = page
      .locator('[data-tool="bash"]')
      .filter({ has: page.locator(".tool-arguments", { hasText: "child=" }) });
    await expect(shell).toContainText("运行中", { timeout: 60000 });
    await expect(thinking).toHaveAttribute("open", "");
    await shell.locator("summary").click();
    await expect(shell.locator(".tool-output")).toContainText("child=", {
      timeout: 60000,
    });
    const child = Number(
      (await shell.locator(".tool-output").innerText()).match(
        /child=(\d+)/,
      )?.[1],
    );
    expect(child).toBeGreaterThan(0);
    await page.getByRole("button", { name: "停止回复" }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect
      .poll(() => {
        try {
          process.kill(child, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    expect(await fs.readFile(path.join(root, "notes/input.md"), "utf8")).toBe(
      "score=9\n",
    );
    expect(
      await fs.readFile(path.join(root, "notes/result.csv"), "utf8"),
    ).toContain("sum,30");
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(
      await fs.readFile(fixture),
    );
    await expect(
      fs.stat(path.join(sandbox, "projects/escape.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      results.find((result) => String(result.content).includes("sum=30")),
    ).toBeTruthy();
    const computeOutput = String(
      results.find((result) => String(result.content).includes("sum=30"))
        .content,
    );
    const finishedChild = Number(
      computeOutput.match(/finished-child=(\d+)/)?.[1],
    );
    expect(finishedChild).toBeGreaterThan(0);
    expect(() => process.kill(finishedChild, 0)).toThrow();
    const truncated = page.locator('[data-tool="bash"]').nth(1);
    await truncated.locator("summary").click();
    await expect(truncated.locator(".tool-output")).toContainText(
      "Command exited with code 7",
    );
    await expect(truncated.locator(".tool-output")).toContainText(
      "Showing lines",
    );
    const conflict = page.locator('[data-tool="edit"]').last();
    await conflict.locator("summary").click();
    await expect(conflict.locator(".tool-conflict")).toContainText("score=9");
    await expect(conflict.locator(".tool-conflict")).toContainText("score=4");
    const created = page.locator('[data-tool="write"]').first();
    await created.locator("summary").click();
    await expect(created.locator(".tool-diff")).toContainText("+总和：30");
    await created
      .getByRole("button", { name: "notes/result.md", exact: true })
      .click();
    await expect(page.locator(".markdown-preview img")).toBeVisible();
    await page.screenshot({ path: "test-results/pi-tools-desktop.png" });
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(560, 760),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(900);
    await expect(
      page.getByRole("button", { name: "展开 Agent" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "展开 Agent" }).click();
    await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/pi-tools-narrow.png" });
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /工具工程/ }).click();
    await expect(page.locator('[data-tool="read"]')).toHaveCount(2);
    await page.locator('[data-tool="read"]').first().locator("summary").click();
    await expect(page.locator('[data-tool="read"]').first()).toContainText(
      "score=2",
    );
    await expect(page.locator('[data-tool="bash"]').last()).toContainText(
      "已停止",
    );
    await expect(page.locator('[data-tool="edit"]').last()).toContainText(
      "失败",
    );
    const sessions = path.join(root, ".pi/sessions");
    for (const file of await fs.readdir(sessions)) {
      const saved = await fs.readFile(path.join(sessions, file), "utf8");
      expect(saved).not.toContain(secret);
      for (const line of saved.trim().split("\n")) {
        const output = JSON.parse(line).message?.details?.fullOutputPath;
        if (output) {
          const log = await fs.readFile(output, "utf8");
          expect(log).not.toContain(secret);
          expect(log).toContain("[已隐藏凭据]");
        }
      }
    }
  } finally {
    releaseThinking();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("模型含凭据的流中止或异常后，终态与持久会话仍脱敏", async () => {
  const secret = "controlled-terminal-secret-STE81";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `已返回 ${secret}` }, finish_reason: null }] })}\n\n`,
    );
    if (JSON.stringify(payload.messages.at(-1).content).includes("failure")) {
      // An invalid provider chunk ends the stream after a sensitive partial reply.
      response.end("data: {invalid-json}\n\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "终态工程", true);
    const root = path.join(sandbox, "projects", "终态工程");
    await page.evaluate(
      async ({ endpoint, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "terminal-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: secret,
        });
      },
      {
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        secret,
      },
    );
    for (const mode of ["cancel", "failure"]) {
      if (mode === "failure")
        await page.getByRole("button", { name: "新会话", exact: true }).click();
      await page.getByLabel("Agent 消息").fill(mode);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message-text").last()).toContainText(
        "[已隐藏凭据]",
      );
      if (mode === "cancel")
        await page.getByRole("button", { name: "停止回复" }).click();
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
        0,
      );
      const states = await page.evaluate(
        (root) => window.desktop.agent<ChatSession[]>({ type: "list", root }),
        root,
      );
      expect(JSON.stringify(states)).not.toContain(secret);
      expect(
        states
          .flatMap((state) => state.messages)
          .some(
            (message) =>
              message.status === (mode === "cancel" ? "aborted" : "error"),
          ),
      ).toBe(true);
      for (const file of await fs.readdir(path.join(root, ".pi/sessions"))) {
        const stored = await fs.readFile(
          path.join(root, ".pi/sessions", file),
          "utf8",
        );
        expect(stored).not.toContain(secret);
        expect(stored).toContain("[已隐藏凭据]");
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Agent 引用工具复用块链接写笔记，保存阅读器待存批注，重开后同一批注可定位", async () => {
  test.setTimeout(150000);
  await create(path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
    path.join(sandbox, "projects"), "引用工具工程");
  const root = path.join(sandbox, "projects", "引用工具工程");
  const { run, link } = await seedBlockParsing(root);
  await expectPdfRendered();
  await page.locator("embedpdf-container").evaluate(async (element) => {
    const registry = await (element as EmbedPdfContainer).registry;
    registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").createAnnotation(0,
      { id: "reader-existing", type: 1, pageIndex: 0, contents: "原有用户评论",
        rect: { origin: { x: 80, y: 250 }, size: { width: 24, height: 24 } } });
  });
  let step = 0;
  let created: { link: string; annotationId: string };
  const outputs: any[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const payload = JSON.parse(body);
    const last = payload.messages.at(-1);
    if (last?.role === "tool") {
      outputs.push(last);
      if (step === 5) created = JSON.parse(last.content);
    }
    const actions = [
      { name: "read", args: { path: run.candidate, offset: 3, limit: 3 } },
      { name: "bash", args: { command: "Get-ChildItem text -Recurse -Filter *.md | Select-String 'dominant' -Context 0,2" } },
      { name: "resolve_reference", args: { link } },
      { name: "write", args: { path: "notes/Agent笔记.md", content: `# 研究笔记\n\n模型采用编码器和解码器。[原文](${link})\n` } },
      { name: "create_annotation", args: { link, comment: "Agent 块级评论：请区分编码器和解码器。" } },
      { name: "resolve_reference", args: { link: created?.link } },
      { name: "resolve_reference", args: { link: "paper://cite/" + "0".repeat(32) } },
      { name: "create_annotation", args: { link: created?.link, comment: "不允许把批注当解析块" } },
      { name: "read_pdf", args: { path: "text/paper.pdf", page: 1 } },
    ];
    if (step === 4) {
      await page.locator("embedpdf-container").evaluate(async (element) => {
        const registry = await (element as EmbedPdfContainer).registry;
        registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading")
          .updateAnnotation(0, "reader-existing", { contents: "用户待保存评论也要保留" });
      });
    }
    const action = actions[step++];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = action ? { tool_calls: [{ index: 0, id: `references-${step}`, type: "function",
      function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { content: `已写入笔记。[原文](${link})` };
    for (const [value, finish] of [[delta, null], [{}, action ? "tool_calls" : "stop"]])
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.evaluate(async (endpoint) => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      settings.services[0].baseUrl = endpoint;
      settings.models[0].model = "reference-model";
      settings.models[0].vision = true;
      await window.desktop.agent({ type: "saveSettings", settings, apiKey: "controlled-reference-key" });
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByLabel("Agent 消息").fill("读搜解析稿，解释后写笔记，展开引用，创建评论并看原页。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 120000 });
    expect(created!.link).toContain("#annotation=");
    expect(outputs.some((item) => String(item.content).includes("找不到此引用"))).toBe(true);
    expect(outputs.some((item) => String(item.content).includes("定位不足"))).toBe(true);
    expect(await fs.readFile(path.join(root, "notes/Agent笔记.md"), "utf8")).toContain(link);
    const invoke = (href: string) => page.evaluate(({ root, link }) => window.desktop.invoke<any>({ type: "resolveReference", root, link }), { root, link: href });
    expect((await invoke(link)).manuscript).toMatchObject({ status: "matched", locations: [{ linkLine: 5 }] });
    expect((await invoke("text/paper.pdf#annotation=reader-existing")).comment).toBe("用户待保存评论也要保留");
    expect((await invoke(created!.link)).comment).toContain("Agent 块级评论");
    expect(await page.evaluate((root) => window.desktop.parsing({ type: "readiness", root }), root)).toMatchObject({ ready: true });
    await desktop.close(); await launch();
    await page.getByRole("button", { name: /引用工具工程/ }).click();
    await expectPdfRendered();
    await expect.poll(async () => (await nativeAnnotations()).map((item) => item.id)).toContain(created!.annotationId);
    expect((await invoke(created!.link)).comment).toContain("Agent 块级评论");
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    // Reuse the returned ordinary annotation link through the existing document navigation.
    await fs.writeFile(path.join(root, "notes/评论链接.md"), `[评论](../${created!.link})`);
    await page.getByRole("button", { name: "笔记", exact: true }).click();
    await expect(page.getByRole("button", { name: "评论链接.md", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "评论链接.md", exact: true }).click();
    await page.locator('.markdown-preview a[href*="#annotation="]').click();
    await expectAnnotationSelected(created!.annotationId);
    await page.screenshot({ path: "test-results/ste96-reference-tools.png" });
    expect(await page.evaluate((root) => window.desktop.parsing({ type: "readiness", root }), root)).toMatchObject({ ready: true });
    expect(errors).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Agent 创建评论遇到外部 PDF 修改明确失败并保留阅读器待存评论", async () => {
  await create(path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
    path.join(sandbox, "projects"), "评论冲突工程");
  const root = path.join(sandbox, "projects", "评论冲突工程");
  const { link } = await seedBlockParsing(root);
  await expectPdfRendered();
  let step = 0;
  let external: Buffer;
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* Consume the model request. */ }
    if (step === 0) {
      await page.locator("embedpdf-container").evaluate(async (element) => {
        const registry = await (element as EmbedPdfContainer).registry;
        registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").createAnnotation(0,
          { id: "pending-conflict", type: 1, pageIndex: 0, contents: "保留用户内存评论",
            rect: { origin: { x: 80, y: 250 }, size: { width: 24, height: 24 } } });
      });
      await fs.appendFile(path.join(root, "text/paper.pdf"), "\n% externally changed\n");
      external = await fs.readFile(path.join(root, "text/paper.pdf"));
    }
    const delta = step++ === 0 ? { tool_calls: [{ index: 0, id: "annotation-conflict", type: "function",
      function: { name: "create_annotation", arguments: JSON.stringify({ link, comment: "不能覆盖外部文件" }) } }] } : { content: "保存失败，未报告成功。" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [value, finish] of [[delta, null], [{}, step === 1 ? "tool_calls" : "stop"]])
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.evaluate(async (endpoint) => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      settings.services[0].baseUrl = endpoint; settings.models[0].model = "conflict-model";
      await window.desktop.agent({ type: "saveSettings", settings, apiKey: "controlled-conflict-key" });
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByLabel("Agent 消息").fill("给原文块创建评论。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const card = page.locator('[data-tool="create_annotation"]');
    await expect(card).toContainText("失败");
    await card.locator("summary").click();
    await expect(card).toContainText(/版本|外部修改/);
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(external!);
    expect((await nativeAnnotations()).find((item) => item.id === "pending-conflict")?.contents).toBe("保留用户内存评论");
    expect(await page.evaluate((root) => window.desktop.parsing({ type: "readiness", root }), root)).toMatchObject({ ready: false });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("引用工具真实模型读搜、解释、按要求写笔记和创建评论，普通问答不写成果", async () => {
  test.setTimeout(300000);
  test.skip(process.env.PAPER30MIN_REAL_MODEL !== "1" || !process.env.PAPER30MIN_REAL_PROFILE,
    "需显式提供真实模型加密配置目录；关闭 trace。");
  await desktop.close();
  for (const file of ["agent-settings.json", "Local State"])
    await fs.copyFile(path.join(process.env.PAPER30MIN_REAL_PROFILE!, file), path.join(sandbox, "profile", file));
  await launch();
  await create(path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
    path.join(sandbox, "projects"), "真实引用工程");
  const root = path.join(sandbox, "projects", "真实引用工程");
  const { run, link } = await seedBlockParsing(root);
  await page.evaluate(async () => {
    const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
    const selected = settings.models.find((model) => model.id === settings.selectedModelId)!;
    selected.vision = true; selected.thinking = "high";
    await window.desktop.agent({ type: "saveSettings", settings });
  });
  const send = async (text: string) => {
    await page.getByLabel("Agent 消息").fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 135000 });
    await expect(page.locator(".agent-error")).toHaveCount(0);
    return page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
  };
  await send(`请用 read 分段读取 ${run.candidate}，用 bash 搜索其中 dominant 段落并查看相邻引用链接，` +
    "用 resolve_reference 展开该链接，再按需 read_pdf 核对第1页。简要解释这段话，只回复并给出已有原文链接。");
  expect((await fs.readdir(path.join(root, "notes"))).filter((name) => name.endsWith(".md"))).toEqual([]);
  const states = await send("现在请将刚才解释写入 notes/研究笔记.md，直接复用原文块链接。" +
    "再在该块创建一条评论，讨论编码器和解码器的职责，使用 resolve_reference 读回保存的批注，回复批注链接。");
  const calls = states.flatMap((state) => state.messages.flatMap((message) => message.tools ?? []));
  for (const name of ["read", "bash", "resolve_reference", "read_pdf", "write", "create_annotation"])
    expect(calls.some((tool) => tool.name === name && tool.status === "done")).toBe(true);
  const created = calls.filter((tool) => tool.name === "create_annotation" && tool.status === "done").at(-1)!;
  const annotation = JSON.parse(created.output!);
  const resolved = await page.evaluate(({ root, link }) => window.desktop.invoke<any>({ type: "resolveReference", root, link }), { root, link: annotation.link });
  expect(resolved.comment.length).toBeGreaterThan(0);
  expect(await fs.readFile(path.join(root, "notes/研究笔记.md"), "utf8")).toContain(link);
  await page.screenshot({ path: "test-results/real-model/ste96-reference-tools.png" });
  await fs.writeFile("test-results/real-model/ste96-evidence.json", JSON.stringify({ states, resolved }, null, 2));
});

test("read_pdf 真实视觉模型核对双栏论文、公式图表与扫描页", async () => {
  test.setTimeout(240000);
  test.skip(process.env.PAPER30MIN_REAL_MODEL !== "1" || (!process.env.PAPER30MIN_REAL_CONFIG && !process.env.PAPER30MIN_REAL_PROFILE),
    "需显式提供本机真实视觉模型配置文件或加密配置目录，trace 必须关闭。");
  const model = process.env.PAPER30MIN_REAL_CONFIG
    ? JSON.parse(await fs.readFile(process.env.PAPER30MIN_REAL_CONFIG, "utf8")) : null;
  if (!model) {
    await desktop.close();
    // Windows safeStorage needs the source profile's encrypted master key at startup.
    for (const file of ["agent-settings.json", "Local State"])
      await fs.copyFile(path.join(process.env.PAPER30MIN_REAL_PROFILE!, file), path.join(sandbox, "profile", file));
    await launch();
  }
  await create(path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"),
    path.join(sandbox, "projects"), "真实 PDF 工程", true);
  const root = path.join(sandbox, "projects", "真实 PDF 工程");
  const scanPath = process.env.PAPER30MIN_REAL_SCAN;
  if (scanPath) await page.evaluate(({ root, source }) => window.desktop.invoke({ type: "addMaterial", root, source }), { root, source: scanPath });
  await page.evaluate(async (model) => {
    const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
    if (model) {
      settings.services[0].baseUrl = model.baseUrl;
      settings.models[0] = { ...settings.models[0], model: model.model, vision: true,
        thinking: "high", availableThinking: ["off", "high"], maxTokens: 8192 };
      settings.selectedModelId = settings.models[0].id;
    } else {
      const selected = settings.models.find((item) => item.id === settings.selectedModelId)!;
      if (!selected.vision || !selected.availableThinking.includes("high"))
        throw new Error("真实验证需要支持视觉输入和 high 思考强度的模型配置。");
      selected.thinking = "high";
    }
    settings.proxy = "direct";
    await window.desktop.agent({ type: "saveSettings", settings, ...(model ? { apiKey: model.apiKey } : {}) });
  }, model);
  const settings = await page.evaluate(() => window.desktop.agent<AgentSettings>({ type: "settings" }));
  const modelId = settings.models.find((item) => item.id === settings.selectedModelId)!.model;
  const scan = scanPath ? (await readManifest(root)).materials[0].path : null;
  await page.getByLabel("Agent 消息").fill(
    "请实际调用 read_pdf 核对 text/paper.pdf 第8页的翻译结果表，再读取第4页整页核对注意力公式。" +
    (scan ? `另读取参考材料 ${scan} 第1页，这是论文第3页的扫描图，无文本层，请依据图像解释编码器和解码器结构的区别。` : "") +
    "最终简要报告英德 BLEU 分数、注意力公式与结构区别，每项说明文件路径与页码；本工程尚无引用，不生成引用链接。禁止通过 read/bash/web_search 旁路读取资料。",
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 210000 });
  await expect(page.locator(".agent-error")).toHaveCount(0);
  const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
  const calls = states.flatMap((state) => state.messages.flatMap((message) => message.tools ?? []));
  const successful = calls.filter((tool) => tool.name === "read_pdf" && tool.status === "done");
  expect(successful.length).toBeGreaterThanOrEqual(scan ? 3 : 2);
  expect(successful.every((tool) => !(tool.arguments as any).region)).toBe(true);
  if (scan) expect(successful.some((tool) => (tool.arguments as any).path === scan)).toBe(true);
  for (const tool of successful) {
    const info = JSON.parse(tool.output!);
    expect(info).not.toHaveProperty("text");
    expect(info).not.toHaveProperty("textStatus");
    expect(info).not.toHaveProperty("textTruncated");
    for (const field of ["citation", "link", "markdown"]) expect(info).not.toHaveProperty(field);
    expect(info).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  }
  const reply = states.flatMap((state) => state.messages).filter((message) => message.role === "assistant").at(-1)!.text;
  expect(reply).toContain("28.4");
  const links = page.locator('.message-text a[href^="paper://cite/"]');
  await expect(links).toHaveCount(0);
  await page.screenshot({ path: "test-results/real-model/ste94-pdf.png" });
  await fs.writeFile("test-results/real-model/ste94-evidence.json", JSON.stringify({
    model: modelId, thinking: "high", reply, calls: successful.map((tool) => ({ args: tool.arguments, pdf: (tool.details as any).pdf })),
  }, null, 2));
  // Optional local setup retains only Electron-encrypted settings, never the input secret file.
  if (process.env.PAPER30MIN_REAL_SAVE_PROFILE) {
    await fs.mkdir(process.env.PAPER30MIN_REAL_SAVE_PROFILE, { recursive: true });
    for (const file of ["agent-settings.json", "Local State"])
      await fs.copyFile(path.join(sandbox, "profile", file), path.join(process.env.PAPER30MIN_REAL_SAVE_PROFILE, file));
  }
});

test("解析审阅可见、自动压缩、停止后新会话逐页续接，正文持续纠错", async () => {
  test.setTimeout(180000);
  const calls: { session: number; name: string; args: any }[] = [];
  const prompts: string[] = [];
  let step = 0;
  let session = 1;
  let compactions = 0;
  let holding = false;
  let overflow = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let waitingForSave = false;
  let resumeAfterSave: () => void = () => {};
  const annotationSaved = new Promise<void>((resolve) => { resumeAfterSave = resolve; });
  let batch: ParsingRun;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const payload = JSON.parse(raw);
    const summarizing = !payload.tools?.some((tool: any) => tool.function?.name === "complete_review_page");
    if (!summarizing && session === 2 && step === 1 && !overflow) {
      overflow = true;
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "prompt is too long: review-key", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: unknown, finish: string | null = null, usage?: object) => response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
    if (summarizing) {
      compactions++;
      emit({ content: "## Goal\n逐页核对解析稿。\n## Progress\n第 1 页已完成；从第 2 页继续，使用 complete_review_page 保存连续进度。修正保存在正文。" });
      emit({}, "stop", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    } else {
      const prompt = payload.messages.find((item: any) => item.role === "user")?.content;
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      if (step === 0) prompts.push(text);
      let call: { name: string; args: any } | undefined;
      if (session === 1) {
        if (step === 2) { waitingForSave = true; await annotationSaved; }
        call = [
          { name: "complete_review_page", args: { page: 2 } },
          { name: "read", args: { path: batch.candidate } },
          { name: "read_pdf", args: { path: "text/paper.pdf", page: 1 } },
          { name: "edit", args: { path: batch.candidate, edits: [{ oldText: "Original paragraph.", newText: "First corrected paragraph." }] } },
          { name: "complete_review_page", args: { page: 1 } },
          { name: "read_pdf", args: { path: "text/paper.pdf", page: 2 } },
          { name: "edit", args: { path: batch.candidate, edits: [{ oldText: "Second original.", newText: "Second corrected." }] } },
        ][step];
        if (step === 7) { holding = true; await held; }
      } else if (step === 0) call = { name: "read", args: { path: batch.candidate } };
      else if (step <= (batch.pageCount - 1) * 2) {
        const page = Math.floor((step - 1) / 2) + 2;
        call = step % 2 ? { name: "read_pdf", args: { path: "text/paper.pdf", page } }
          : { name: "complete_review_page", args: { page } };
      }
      if (call) {
        calls.push({ session, ...call });
        emit({ tool_calls: [{ index: 0, id: `review-${session}-${step}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
        emit({}, "tool_calls", { prompt_tokens: session === 1 && step === 4 ? 15000 : 1000, completion_tokens: 50, total_tokens: 1050 });
      } else { emit({ content: "审阅结束，修正已保存。" }); emit({}, "stop"); }
      step++;
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "审阅工程");
    const root = path.join(sandbox, "projects", "审阅工程");
    batch = await seedParsing(root, false);
    await fs.writeFile(path.join(root, batch.candidate!), "Original paragraph.\n\nSecond original.\n\n" + "Context for checking the manuscript. ".repeat(800));
    await page.evaluate(async ({ root, endpoint }) => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      settings.services[0].baseUrl = endpoint;
      settings.models[0] = { ...settings.models[0], model: "review-fixture", vision: true, contextWindow: 16000, maxTokens: 1024 };
      await window.desktop.agent({ type: "saveSettings", settings, apiKey: "review-key" });
      const conversation = await window.desktop.agent<ChatSession>({ type: "create", root });
      try { await window.desktop.agent({ type: "send", root, id: conversation.id, text: "绕过审阅" }); throw new Error("gate bypassed"); }
      catch (error) { if (!(error as Error).message.includes("审阅")) throw error; }
    }, { root, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    await page.getByRole("button", { name: "论文解析", exact: true }).first().click();
    await page.getByRole("button", { name: "开始审阅", exact: true }).click();
    await expect.poll(() => waitingForSave, { timeout: 45000 }).toBe(true);
    await page.evaluate(async (root) => {
      const source = await window.desktop.invoke<PdfSource>({ type: "readPdf", root, path: "text/paper.pdf" });
      const suffix = new TextEncoder().encode("\n% annotation save during review\n");
      const bytes = new Uint8Array(source.bytes.length + suffix.length);
      bytes.set(source.bytes); bytes.set(suffix, source.bytes.length);
      await window.desktop.invoke({ type: "savePdf", root, path: "text/paper.pdf", version: source.sha256, bytes });
    }, root);
    resumeAfterSave();
    await expect.poll(() => holding, { timeout: 45000 }).toBe(true);
    const progress = async () => JSON.parse(await fs.readFile(path.join(root, ".paper30min/parsing", batch.batchId, "run.json"), "utf8")) as ParsingRun;
    expect((await progress()).reviewedThroughPage).toBe(1);
    expect(compactions).toBeGreaterThan(0);
    await expect(page.getByLabel("会话", { exact: true })).toContainText("解析审阅");
    await expect(page.locator('[data-tool="complete_review_page"][data-status="error"]')).toHaveCount(1);
    await page.locator(".parsing-panel").getByRole("button", { name: "停止审阅", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    const firstSession = (await progress()).reviewSessionId;
    expect(await fs.readFile(path.join(root, batch.candidate!), "utf8")).toContain("Second corrected.");
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /审阅工程/ }).click();
    await expect(page.locator(".parsing-panel")).toContainText(`已审阅 1 / ${batch.pageCount} 页`);
    session = 2;
    step = 0;
    await page.locator(".parsing-panel").getByRole("button", { name: "继续审阅", exact: true }).click();
    await expect.poll(async () => (await progress()).reviewedThroughPage, { timeout: 60000 }).toBe(batch.pageCount);
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect((await progress()).reviewSessionId).not.toBe(firstSession);
    expect(overflow).toBe(true);
    expect(compactions).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".agent-error")).toHaveCount(0);
    expect(prompts[1]).toContain("从第 2 页开始");
    expect(calls.filter((call) => call.session === 2 && call.name === "read_pdf").map((call) => call.args.page))
      .toEqual(Array.from({ length: batch.pageCount - 1 }, (_, i) => i + 2));
    const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
    expect(states.filter((state) => state.reviewBatchId === batch.batchId)).toHaveLength(2);
    const histories = await fs.readdir(path.join(root, ".pi/sessions"));
    expect((await Promise.all(histories.map((file) => fs.readFile(path.join(root, ".pi/sessions", file), "utf8")))).some((text) => text.includes('"type":"compaction"'))).toBe(true);
    await page.getByRole("button", { name: "查看正文", exact: true }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator(".cm-content").press("Control+End");
    await page.keyboard.insertText("\nUser correction.\n");

    await expect.poll(() => fs.readFile(path.join(root, batch.candidate!), "utf8")).toContain("User correction.");
    expect((await progress()).reviewedThroughPage).toBe(batch.pageCount);
    await page.screenshot({ path: "test-results/ste83-reviewed-desktop.png", animations: "disabled" });
    await page.setViewportSize({ width: 760, height: 900 });
    await page.screenshot({ path: "test-results/ste83-reviewed-narrow.png", animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    resumeAfterSave();
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("read_pdf 经真实 Electron 和 Pi 传送完整页图，保留视口且不登记引用并可重开", async () => {
  let index = 0;
  const images: string[] = [];
  const results: any[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    const tools = payload.messages.filter((message: any) => message.role === "tool");
    if (tools.length > results.length) {
      const info = JSON.parse(tools.at(-1).content.split("\n")[0]);
      results.push(info);
    }
    const imageUrls = payload.messages.flatMap((message: any) => Array.isArray(message.content)
      ? message.content.flatMap((block: any) => block.type === "image_url" ? [block.image_url.url] : []) : []);
    for (const url of imageUrls) if (!images.includes(url)) images.push(url);
    const args = index === 0 ? { path: "text/paper.pdf", page: 1 }
      : index === 1 ? { path: "text/paper.pdf", page: 3, scale: 2 } : null;
    index++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = args ? { tool_calls: [{ index: 0, id: `pdf-${index}`, type: "function",
      function: { name: "read_pdf", arguments: JSON.stringify(args) } }] }
      : { content: "已核对 text/paper.pdf 第 1、3 页的公式图表；暂无可用引用。" };
    for (const [value, finish] of [[delta, null], [{}, args ? "tool_calls" : "stop"]])
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf");
    await create(source, path.join(sandbox, "projects"), "PDF 工具工程", true);
    const root = path.join(sandbox, "projects", "PDF 工具工程");
    const citationPath = path.join(root, ".paper30min-citations.json");
    const citationsBefore = await fs.readFile(citationPath, "utf8").catch(() => null);
    await expectPdfRendered();
    await jumpPdfPage(2);
    await setPdfZoom("125");
    await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
    await expect.poll(async () => JSON.parse(
      await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8"),
    ).pdf["text/paper.pdf"]).toMatchObject({ page: 2, zoom: 1.25 });
    const before = JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf;
    await page.evaluate(async (endpoint) => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      settings.services[0].baseUrl = endpoint;
      settings.models[0].model = "vision-fixture";
      settings.models[0].vision = true;
      await window.desktop.agent({ type: "saveSettings", settings, apiKey: "pdf-fixture-key" });
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByLabel("Agent 消息").fill("核对工程论文原页和公式图表，说明来源文件和页码。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text.chat-markdown").last()).toContainText("暂无可用引用");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).not.toHaveProperty("text");
      expect(result).not.toHaveProperty("textStatus");
      expect(result).not.toHaveProperty("textTruncated");
      for (const field of ["citation", "link", "markdown"]) expect(result).not.toHaveProperty(field);
    }
    expect(images).toHaveLength(2);
    const { PNG } = await import("pngjs");
    const crop = PNG.sync.read(Buffer.from(images[1].split(",")[1], "base64"));
    expect([crop.width, crop.height]).toEqual([1224, 1584]);
    expect(results[1]).toMatchObject({ path: "text/paper.pdf", page: 3, width: 612, height: 792, scale: 2 });
    expect(await fs.readFile(citationPath, "utf8").catch(() => null)).toBe(citationsBefore);
    expect(JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf).toEqual(before);
    await expect(page.getByRole("tab", { name: "paper.pdf", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-tool="read_pdf"][data-status="done"]')).toHaveCount(2);
    await expect(page.locator('.message-text a[href^="paper://cite/"]')).toHaveCount(0);
    await page.screenshot({ path: "test-results/ste94-read-only.png" });
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /PDF 工具工程/ }).click();
    await expect(page.locator('[data-tool="read_pdf"][data-status="done"]')).toHaveCount(2);
    await expect(page.locator(".message-text.chat-markdown").last()).toContainText("暂无可用引用");
    await expect(page.locator('.message-text a[href^="paper://cite/"]')).toHaveCount(0);
    const sessionFiles = await fs.readdir(path.join(root, ".pi/sessions"));
    const history = await fs.readFile(path.join(root, ".pi/sessions", sessionFiles[0]), "utf8");
    expect(history).toContain('"type":"image"');
    expect(await fs.readFile(citationPath, "utf8").catch(() => null)).toBe(citationsBefore);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Pi 普通对话可写入文件和运行 Shell", async () => {
  let index = 0;
  const server = createServer(async (request, response) => {
    for await (const _part of request) {
      /* consume the request body */
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const action =
      index++ === 0
        ? {
            name: "write",
            arguments: JSON.stringify({
              path: "notes/requested.md",
              content: "hello",
            }),
          }
        : index === 2
          ? {
              name: "bash",
              arguments: JSON.stringify({
                command: "Set-Content notes/requested.txt hello",
              }),
            }
          : null;
    const delta = action
      ? {
          tool_calls: [
            {
              index: 0,
              id: "normal-" + index,
              type: "function",
              function: action,
            },
          ],
        }
      : { content: "文件已生成" };
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "普通对话工程", true);
    await page.evaluate(
      async (endpoint) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "tool-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: "normal-key",
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page
      .getByLabel("Agent 消息")
      .fill(
        "请写入 notes/requested.md，并运行命令生成 notes/requested.txt，内容均为 hello。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("文件已生成");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(
      await fs.readdir(path.join(sandbox, "projects/普通对话工程/notes")),
    ).toEqual(["requested.md", "requested.txt"]);
    expect(await fs.readFile(path.join(sandbox, "projects/普通对话工程/notes/requested.md"), "utf8")).toBe("hello");
    expect((await fs.readFile(path.join(sandbox, "projects/普通对话工程/notes/requested.txt"), "utf8")).trim()).toBe("hello");
    await expect(page.locator('[data-tool="write"]')).toContainText("完成");
    await expect(page.locator('[data-tool="bash"]')).toContainText("完成");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("STE-95 真实模型使用来源、指定文档与产品 Skill", async () => {
  test.setTimeout(180000);
  test.skip(process.env.PAPER30MIN_REAL_MODEL !== "1" || !process.env.PAPER30MIN_REAL_PROFILE, "需真实模型隔离配置，关闭 trace。");
  await desktop.close();
  for (const file of ["agent-settings.json", "Local State"])
    await fs.copyFile(path.join(process.env.PAPER30MIN_REAL_PROFILE!, file), path.join(sandbox, "profile", file));
  await launch();
  await create(path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf"), path.join(sandbox, "projects"), "真实聊天材料");
  const root = path.join(sandbox, "projects/真实聊天材料");
  const { link } = await seedBlockParsing(root);
  await fs.writeFile(path.join(root, "notes/阅读问题.md"), "本轮只研究编码器和解码器的职责。核验词：松柏七号。");
  const input = page.getByLabel("Agent 消息");
  await input.fill("请按所选 Skill 的四段式结构简短解释选中原文，不超过300字。先 read 来源中的解析稿行号与指定笔记，包含笔记核验词和已有原文链接。材料不足如实说明；模板中的全文和图片并未预先提供，不调用旧版工具、不写文件。 ");
  await input.evaluate((element, link) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", `[选中原文](${link})`);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, link);
  await input.press("End"); await input.pressSequentially(" @阅读问题");
  await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
  await input.press("Enter"); await input.press("End"); await input.pressSequentially(" @深挖");
  await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(page.locator(".chat-attachments > span")).toHaveCount(3);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 135000 });
  await expect(page.locator(".agent-error")).toHaveCount(0);
  const states = await page.evaluate(root => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
  expect(states.flatMap(state => state.messages.flatMap(message => message.tools ?? [])).some(tool => tool.name === "read" && tool.status === "done")).toBe(true);
  const answer = states.flatMap(state => state.messages).filter(message => message.role === "assistant").map(message => message.text).join("\n");
  expect(answer).toContain("松柏七号");
  expect(answer).toContain(link);
  expect(answer).toContain("核心论点");
  await fs.writeFile("test-results/real-model/ste95-evidence.json", JSON.stringify(states, null, 2));
  await page.screenshot({ path: "test-results/real-model/ste95-chat.png" });
});

test("STE-95 聊天来源预览、去重、文档与 Skill 组合发送及历史重开", async () => {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  let reply = "";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "sources", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "sources", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "聊天材料");
    const root = path.join(parent, "聊天材料");
    const { link, run } = await seedBlockParsing(root);
    reply = `已核对[原文](${link})。\n\n\`\`\`json\n{"回答": "保留助手代码"}\n\`\`\``;
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes/问题(中文).md"), "不应自动发送的全文");
    await page.evaluate(async base => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      await window.desktop.agent({ type: "saveSettings", settings: { ...settings, services: [{ id: "sources", name: "受控模型", api: "openai-completions", baseUrl: base, hasKey: false }],
        models: [{ id: "sources", serviceId: "sources", name: "受控模型", model: "fixture", contextWindow: 32000, maxTokens: 1024, thinking: "off", availableThinking: ["off"] }], selectedModelId: "sources" }, apiKeys: { sources: "test-key" } });
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    const input = page.getByLabel("Agent 消息");
    await input.fill("解释这里 ");
    const paste = async (text: string) => input.evaluate((element, value) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, text);
    await paste(`[原文](${link}) [重复](${link})`);
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    await expect(input).toHaveValue("解释这里 原文 重复");
    await paste(` [**这个定理为什么成立**][r]\n\n[r]: ${link}\n[r]: paper://cite/${"0".repeat(32)}`);
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    await expect(input).toHaveValue(/这个定理为什么成立/);
    await page.locator(".chat-attachments button").first().click();
    await expect(page.getByRole("region", { name: "附件预览" })).toContainText(run.candidate!);
    await expect(page.getByRole("region", { name: "附件预览" })).toContainText("第 3–5 行（链接第 5 行）");
    await page.getByText("关闭预览", { exact: true }).click();
    await expectPdfRendered();
    await page.getByRole("button", { name: "引用", exact: true }).click();
    await page.getByRole("button", { name: "整页引用", exact: true }).click();
    await page.getByRole("button", { name: "引用加入聊天", exact: true }).click();
    await expect(page.locator(".chat-attachments > span")).toHaveCount(2);
    expect(await nativeAnnotations()).toHaveLength(0);
    await nativeHighlight();
    const annotationId = (await nativeAnnotations())[0].id;
    await page.locator("embedpdf-container").evaluate(async (element, id) => {
      const registry = await (element as EmbedPdfContainer).registry;
      registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").updateAnnotation(0, id, { contents: "发送当时的讨论" });
    }, annotationId);
    await page.getByRole("button", { name: "批注加入聊天", exact: true }).first().click();
    await expect(page.locator(".chat-attachments > span")).toHaveCount(3);
    await input.fill("解释这里 @问题");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await expect(input).toHaveValue("解释这里 ");
    await input.press("End");
    await input.pressSequentially("@深挖");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await expect(page.locator(".chat-attachments > span")).toHaveCount(5);
    await input.fill('解释这里\n\n```json\n{"问题": "保留用户代码"}\n```');
    await page.screenshot({ path: "test-results/ste95-composer.png" });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant")).toContainText("已核对");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(requests).toHaveLength(1);
    const sent = JSON.stringify(requests[0].messages.filter(message => message.role === "user"));
    expect(sent).toContain(run.candidate!);
    expect(sent).toContain("startLine");
    expect(sent).toContain("discussions");
    expect(sent).toContain("发送当时的讨论");
    expect(sent).toContain("问题(中文).md");
    expect(sent).not.toContain("不应自动发送的全文");
    expect(sent).toContain("SHA-256");
    expect(sent).toContain("你是一位资深研究员");
    expect(sent).not.toContain("image_url");
    await expect(page.locator(".chat-message.user")).not.toContainText("来源快照");
    await expect(page.locator(".chat-message.user")).not.toContainText("startLine");
    await expect(page.locator(".chat-message.user pre").first()).toHaveText('{"问题": "保留用户代码"}');
    await expect(page.locator(".chat-message.assistant pre")).toHaveText('{"回答": "保留助手代码"}');
    await expect(page.locator(".chat-message.user").getByRole("link", { name: "来源", exact: true })).toHaveCount(3);
    await page.screenshot({ path: "test-results/ste95-source-display.png" });
    await page.locator(".chat-message.user a").first().click();
    await expect(page.getByRole("tab", { name: "paper.pdf" })).toHaveAttribute("aria-selected", "true");
    await page.locator(".chat-message.assistant a").click();
    await page.locator("embedpdf-container").evaluate(async (element, id) => {
      const registry = await (element as EmbedPdfContainer).registry;
      registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").updateAnnotation(0, id, { contents: "讨论后来改写" });
    }, annotationId);
    await page.getByRole("button", { name: "笔记", exact: true }).click();
    await expect(page.getByRole("tab", { name: "笔记", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("embedpdf-container")).toHaveCount(0);
    await fs.writeFile(path.join(root, "notes/问题(中文).md"), "后来修改");
    const original = await page.locator(".chat-message.user .message-text").textContent();
    await desktop.close(); await launch();
    await page.getByRole("button", { name: /聊天材料/ }).click();
    await expect(page.locator(".chat-message.user .message-text")).toHaveText(original!);
    await page.getByRole("button", { name: "从此消息分支" }).nth(1).click();
    await expect(page.locator(".chat-message.user .message-text")).toHaveText(original!);
    await page.getByLabel("Agent 消息").fill("保留代码 ");
    await page.getByLabel("Agent 消息").evaluate((element, link) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", `\`${link}\`\n\n\`\`\`\n[代码](${link})\n\`\`\``);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, link);
    await expect(page.locator(".chat-attachments > span")).toHaveCount(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("STE-95 来源失败保留草稿，移除后可发送，停止和模型失败保留材料", async () => {
  let fail = false;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (fail) { response.writeHead(401); response.end("unauthorized"); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "stop", choices: [{ index: 0, delta: { content: "处理中" }, finish_reason: null }] })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "失败材料");
    const root = path.join(sandbox, "projects/失败材料");
    await page.evaluate(async base => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      await window.desktop.agent({ type: "saveSettings", settings: { ...settings, services: [{ id: "sources", name: "受控模型", api: "openai-completions", baseUrl: base, hasKey: false }],
        models: [{ id: "sources", serviceId: "sources", name: "受控模型", model: "fixture", contextWindow: 32000, maxTokens: 1024, thinking: "off", availableThinking: ["off"] }], selectedModelId: "sources" }, apiKeys: { sources: "test-key" } });
    }, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await expectPdfRendered();
    await page.getByRole("button", { name: "引用", exact: true }).click();
    await page.getByRole("button", { name: "整页引用", exact: true }).click();
    await page.getByRole("button", { name: "引用加入聊天", exact: true }).click();
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    await page.getByLabel("Agent 消息").fill("保留我的问题");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("解析");
    await expect(page.getByLabel("Agent 消息")).toHaveValue("保留我的问题");
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    expect(requests).toHaveLength(0);
    await seedParsing(root);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant")).toContainText("处理中");
    await page.getByRole("button", { name: "引用加入聊天", exact: true }).click();
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    await page.getByLabel("Agent 消息").fill("停止前排队的来源\n\n```python\nprint(1)");
    await page.getByRole("button", { name: "补充消息", exact: true }).click();
    await expect(page.locator(".queued-message")).toContainText("停止前排队的来源");
    await expect(page.locator(".queued-message")).not.toContainText("来源快照");
    await expect(page.locator(".queued-message pre")).toHaveText("print(1)");
    await expect(page.locator(".queued-message").getByRole("link", { name: "来源", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复", exact: true })).toHaveCount(0);
    await expect(page.locator(".chat-message.user").first()).not.toContainText("来源快照");
    await expect(page.locator(".chat-message.user").first().getByRole("link", { name: "来源", exact: true })).toHaveCount(1);
    await expect(page.locator(".chat-message.user").last()).toContainText("尚未送达模型");
    await fs.writeFile(path.join(root, "notes/即将移动.md"), "指定材料");
    await page.getByLabel("Agent 消息").fill("读取 @即将移动");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await page.getByLabel("Agent 消息").press("Enter");
    await fs.rename(path.join(root, "notes/即将移动.md"), path.join(root, "notes/已移动.md"));
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("指定文档已缺失或移动");
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "移除 notes/即将移动.md", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("");
    await page.getByLabel("Agent 消息").evaluate(element => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "https://example.com/a.pdf#annotation=note-1 paper://cite/" + "0".repeat(32) + "/extra");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(page.locator(".chat-attachments > span")).toHaveCount(0);
    await expect(page.getByLabel("Agent 消息")).toHaveValue(/https:\/\/example.com\/a.pdf#annotation=note-1 paper:\/\/cite\/0+\/extra/);
    await page.getByLabel("Agent 消息").fill("缺失来源 ");
    await page.getByLabel("Agent 消息").evaluate(element => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "[不存在](paper://cite/" + "0".repeat(32) + ")");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toBeVisible();
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "移除 不存在", exact: true }).click();
    fail = true;
    await page.getByRole("button", { name: "引用加入聊天", exact: true }).click();
    await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("认证失败");
    await expect(page.locator(".chat-message.user")).toHaveCount(3);
    await desktop.close(); await launch();
    await page.getByRole("button", { name: /失败材料/ }).click();
    await expect(page.locator(".chat-message.user")).toHaveCount(3);
    await expect(page.locator(".chat-message.user").last()).not.toContainText("来源快照");
    await expect(page.locator(".chat-message.user").last().getByRole("link", { name: "来源", exact: true })).toHaveCount(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Pi 原生对话流式回复、补充、分支及搬迁重开，密钥留本机", async () => {
  const secret = "controlled-test-key-STE79";
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    expect(request.headers.authorization).toBe("Bearer " + secret);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (text: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: "controlled-model", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: text ? null : "stop" }] })}\n\n`,
      );
    chunk("真实流式");
    await new Promise((r) => setTimeout(r, 1000));
    chunk("回复完成。");
    chunk(null);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "Pi 论文工程", true);
    const root = path.join(parent, "Pi 论文工程");
    await page.getByLabel("Agent 消息").fill("不附加论文，只问你好");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请先在设置中配置");
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page
      .getByLabel("模型端点")
      .fill(`http://127.0.0.1:${address.port}/v1`);
    await page
      .locator(".agent-model-row button[aria-expanded]")
      .first()
      .click();
    await page.getByLabel("模型名称").fill("controlled-model");
    await page.getByLabel("API 密钥", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "返回工作台" }).click();
    await expect(page.getByLabel("Agent 消息")).toHaveValue(
      "不附加论文，只问你好",
    );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("真实流式");
    await page.getByLabel("Agent 消息").fill("补充一个问题");
    await page.getByRole("button", { name: "补充消息", exact: true }).click();
    await expect(page.locator(".queued-message")).toContainText("补充一个问题");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    expect(requests).toHaveLength(2);
    const conversationMessages = requests.flatMap((request) =>
      request.messages.filter((message) => message.role !== "system"),
    );
    expect(JSON.stringify(conversationMessages)).not.toContain("paper.pdf");
    expect(conversationMessages.every((message) =>
      message.role === "user" || message.role === "assistant",
    )).toBe(true);
    const originalId = await page
      .getByLabel("会话", { exact: true })
      .inputValue();
    await page.getByRole("button", { name: "从此消息分支" }).nth(1).click();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    await expect(page.getByLabel("会话").locator("option")).toHaveCount(2);
    const branchId = await page
      .getByLabel("会话", { exact: true })
      .inputValue();
    await page.getByLabel("Agent 消息").fill("分支继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText(
      "真实流式回复完成。",
    );
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    await page.getByLabel("会话", { exact: true }).selectOption(originalId);
    await page.getByLabel("Agent 消息").fill("回到原会话继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText(
      "真实流式回复完成。",
    );
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(6);
    await page.getByLabel("会话", { exact: true }).selectOption(branchId);
    const sessionDir = path.join(root, ".pi", "sessions");
    const files = await fs.readdir(sessionDir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const raw = await fs.readFile(path.join(sessionDir, file), "utf8");
      expect(raw).not.toContain(secret);
      expect(JSON.parse(raw.split("\n")[0]).type).toBe("session");
    }
    expect(
      await fs.readFile(
        path.join(sandbox, "profile", "agent-settings.json"),
        "utf8",
      ),
    ).not.toContain(secret);
    const moved = path.join(parent, "搬迁后 Pi 工程");
    await desktop.close();
    await fs.rename(root, moved);
    await launch();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveAttribute(
      "placeholder",
      "已保存在本机，留空保留",
    );
    await page.getByRole("button", { name: "返回工程" }).click();
    await choose(moved);
    await page
      .getByRole("button", { name: "打开工程文件夹", exact: true })
      .click();
    await page.getByLabel("会话", { exact: true }).selectOption(branchId);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    await page.getByLabel("Agent 消息").fill("重开后继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText(
      "真实流式回复完成。",
    );
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(6);
    await page.screenshot({ path: "test-results/ste79-agent-desktop.png" });
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(560, 760),
    );
    await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
    await expect(page.getByLabel("Agent 消息")).toBeVisible();
    await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/ste79-agent-narrow.png" });
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(page.getByLabel("模型端点")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "test-results/ste79-settings-narrow.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Pi 并发会话隔离停止、失败恢复与代理，停滞关闭不拖住退出", async () => {
  const secret = "controlled-private-key";
  let tunneled = 0;
  let failNext = true;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const content = payload.messages
      .filter((m: { role: string }) => m.role === "user")
      .at(-1).content;
    const last =
      typeof content === "string"
        ? content
        : content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join("");
    if (last === "触发失败" && failNext) {
      failNext = false;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Invalid key " + secret,
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (text: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: "controlled", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: text ? null : "stop" }] })}\n\n`,
      );
    chunk(last.includes("停滞") ? "等待中的片段" : "独立回复");
    const timer = setTimeout(
      () => {
        chunk(last.includes("停滞") ? "迟到内容不得落盘" : "已完成");
        chunk(null);
        response.end("data: [DONE]\n\n");
        timers.delete(timer);
      },
      last.includes("停滞") ? 3000 : 500,
    );
    timers.add(timer);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const proxy = createServer();
  const sockets = new Set<import("node:stream").Duplex>();
  proxy.on("connect", (_request, client, head) => {
    tunneled++;
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    sockets.add(client);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => {
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "并发会话工程", true);
    const root = path.join(parent, "并发会话工程");
    await page.evaluate(
      async ({ port, proxyPort, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        await window.desktop.agent({
          type: "saveSettings",
          apiKey: secret,
          settings: {
            ...settings,
            services: settings.services.map((service) => ({
              ...service,
              baseUrl: `http://127.0.0.1:${port}/v1`,
            })),
            models: settings.models.map((model) => ({
              ...model,
              model: "controlled",
            })),
            proxy: "custom",
            proxyUrl: `http://127.0.0.1:${proxyPort}`,
          },
        });
      },
      { port, proxyPort, secret },
    );
    await page.getByLabel("Agent 消息").fill("触发失败");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("模型认证失败");
    expect(tunneled).toBeGreaterThan(0);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /并发会话工程/ }).click();
    await expect(page.locator(".chat-message small")).toHaveText("请求失败");
    await page.getByLabel("Agent 消息").fill("失败后继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "独立回复已完成",
    );
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("会话 A 停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    const a = await page.getByLabel("会话", { exact: true }).inputValue();
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("会话 B 正常");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const b = await page.getByLabel("会话", { exact: true }).inputValue();
    await page.getByLabel("会话", { exact: true }).selectOption(a);
    await page.getByRole("button", { name: "停止回复" }).click();
    await expect(page.locator(".chat-message small")).toHaveText("已停止");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await page.getByLabel("会话", { exact: true }).selectOption(b);
    await expect(page.locator(".message-text").last()).toHaveText(
      "独立回复已完成",
    );
    await page.waitForTimeout(3100);
    const all = await page.evaluate(
      (root) => window.desktop.agent<ChatSession[]>({ type: "list", root }),
      root,
    );
    expect(all.find((s) => s.id === a)?.messages.at(-1)?.text).toBe(
      "等待中的片段",
    );
    for (const file of await fs.readdir(path.join(root, ".pi", "sessions"))) {
      const raw = await fs.readFile(
        path.join(root, ".pi", "sessions", file),
        "utf8",
      );
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain("迟到内容不得落盘");
    }
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("关闭期间停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    await page.getByRole("button", { name: "所有工程", exact: true }).click();
    await create(fixture, undefined, "另一工程", true);
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await page.getByLabel("Agent 消息").fill("另一工程正常回复");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "独立回复已完成",
    );
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("窗口退出时停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    const started = Date.now();
    await desktop.close();
    expect(Date.now() - started).toBeLessThan(4000);
    await launch();
    await page.getByRole("button", { name: /^另一工程/ }).click();
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("进程异常停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    await desktop.evaluate(({ app }) => {
      const target = app
        .getAppMetrics()
        .find((m) => m.name === "Paper30Min Project");
      if (!target) throw new Error("找不到测试工程进程");
      process.kill(target.pid);
    });
    await expect(page.locator(".agent-error")).toContainText("工程进程已退出");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => proxy.close(() => r())),
    ]);
  }
});

test("Responses 与 Anthropic 文本协议及损坏配置恢复通过真实 Electron 接线", async () => {
  const routes: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the provider request. */
    }
    routes.push(request.url!);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: { type: string; [key: string]: unknown }) =>
      response.write(
        `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
      );
    if (request.url === "/v1/responses") {
      event({ type: "response.created", response: { id: "resp-test" } });
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg-test",
          role: "assistant",
          content: [],
        },
      });
      event({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Responses 回复",
      });
      event({
        type: "response.completed",
        response: {
          id: "resp-test",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
    } else {
      event({
        type: "message_start",
        message: {
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "controlled",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Anthropic 回复" },
      });
      event({ type: "content_block_stop", index: 0 });
      event({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      });
      event({ type: "message_stop" });
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await create(fixture, path.join(sandbox, "projects"), "研究工程", true);
    await fs.writeFile(
      path.join(sandbox, "profile", "agent-settings.json"),
      "{invalid",
    );
    for (const api of ["openai-responses", "anthropic-messages"] as const) {
      await page.getByRole("button", { name: "模型设置", exact: true }).click();
      if (api === "openai-responses")
        await expect(page.getByRole("status")).toContainText(
          "模型配置无法读取",
        );
      await page.getByLabel("接口协议").selectOption(api);
      await page
        .getByLabel("模型端点")
        .fill(
          `http://127.0.0.1:${port}${api === "anthropic-messages" ? "" : "/v1"}`,
        );
      await page
        .locator(".agent-model-row button[aria-expanded]")
        .first()
        .click();
      await page.getByLabel("模型名称").fill("controlled");
      await page
        .getByLabel("API 密钥", { exact: true })
        .fill("controlled-protocol-key");
      await page.getByRole("button", { name: "保存配置" }).click();
      await expect(page.getByRole("status")).toHaveText("已保存");
      await page.getByRole("button", { name: "返回工作台" }).click();
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await page.getByLabel("Agent 消息").fill("基础文本");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message-text").last()).toHaveText(
        api === "openai-responses" ? "Responses 回复" : "Anthropic 回复",
      );
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
        0,
      );
      await expect(page.locator(".agent-error")).toHaveCount(0);
    }
    expect(
      routes.map((route) => new URL(route, "http://localhost").pathname),
    ).toEqual(["/v1/responses", "/v1/messages"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.describe("真实模型验证", () => {
  test("用本机旧配置运行真实 Pi 消息与工具任务并重开", async () => {
    test.setTimeout(180000);
    test.skip(
      process.env.PAPER30MIN_REAL_MODEL !== "1",
      "需用户授权复用本机旧模型配置后显式运行。",
    );
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(
      path.join(
        os.homedir(),
        "AppData/Roaming/com.paper30min.reader/database/library.sqlite",
      ),
      { readOnly: true },
    );
    let model: { baseUrl: string; model: string; apiKey: string };
    try {
      model = JSON.parse(
        (
          db
            .prepare("SELECT value FROM settings WHERE key = 'model'")
            .get() as { value: string }
        ).value,
      );
    } finally {
      db.close();
    }
    expect(!!model.apiKey).toBe(true);
    await create(fixture, path.join(sandbox, "projects"), "真实模型工程", true);
    await page.evaluate(async (model) => {
      const settings = await window.desktop.agent<AgentSettings>({
        type: "settings",
      });
      await window.desktop.agent({
        type: "saveSettings",
        apiKey: model.apiKey,
        settings: {
          ...settings,
          services: settings.services.map((service) => ({
            ...service,
            baseUrl: model.baseUrl,
          })),
          models: settings.models.map((entry) => ({
            ...entry,
            model: model.model,
            maxTokens: 2048,
          })),
          proxy: "direct",
        },
      });
    }, model);
    await page
      .getByLabel("Agent 消息")
      .fill("只用一句中文回答：你好。不要读取文件或调用工具。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".chat-message.assistant .message-text"),
    ).not.toHaveText("", { timeout: 60000 });
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
      0,
      { timeout: 60000 },
    );
    await expect(page.locator(".agent-error")).toHaveCount(0);
    const root = path.join(sandbox, "projects", "真实模型工程");
    if (process.env.PAPER30MIN_REAL_WEB === "1") {
      await page
        .getByLabel("Agent 消息")
        .fill(
          "请调研 Attention Is All You Need 的主要结果。使用 web_search 找到论文原始来源，再用 fetch_content 读取该网页，并用 get_search_content 在实际获取正文中查找 BLEU。用中文简短综合模型特点和 WMT 2014 英德 BLEU 结果，只引用你实际使用的一两个网页，不列出全部搜索结果。不要读取或修改工程文件。",
        );
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "停止回复" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
        0,
        { timeout: 120000 },
      );
      await expect(page.locator(".agent-error")).toHaveCount(0);
      const states = await page.evaluate(
        (root) => window.desktop.agent<ChatSession[]>({ type: "list", root }),
        root,
      );
      const tools = states.flatMap((state) =>
        state.messages.flatMap((message) => message.tools ?? []),
      );
      for (const name of ["web_search", "fetch_content", "get_search_content"])
        expect(
          tools.some((tool) => tool.name === name && tool.status === "done"),
        ).toBe(true);
      await expect(
        page.locator(".chat-message.assistant .message-text").last(),
      ).toContainText("28.4");
      await expect(
        page.locator('.message-text a[href*="arxiv.org"]'),
      ).toHaveCount(1);
      const replies = await page
        .locator(".chat-message.assistant .message-text")
        .allTextContents();
      await page.screenshot({ path: "test-results/real-model/ste100-web.png" });
      await desktop.close();
      await launch();
      await page.getByRole("button", { name: /真实模型工程/ }).click();
      await expect(
        page.locator(".chat-message.assistant .message-text"),
      ).toHaveText(replies);
      expect(await fs.readdir(path.join(root, "notes"))).toEqual([]);
      return;
    }
    await fs.writeFile(
      path.join(root, "notes/numbers.csv"),
      "value\n1\n2\n3\n4\n",
    );
    await page
      .getByLabel("Agent 消息")
      .fill(
        "请执行一个小型计算任务：先用 read 读取 notes/numbers.csv，编写 tmp/calculate.ps1，用 bash（Windows PowerShell）运行脚本计算各数平方之和，将计算结果保存为 notes/calculation.csv（表头 metric,value，数据 sum_squares,真实结果）；用 write 保存 notes/calculation.md，正文包含计算结果。必须真实调用工具，不访问工程外文件，不读取 PDF。最后简短回复结果。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
      0,
      { timeout: 120000 },
    );
    await expect(page.locator(".agent-error")).toHaveCount(0);
    expect(
      await fs.readFile(path.join(root, "notes/calculation.csv"), "utf8"),
    ).toContain("sum_squares,30");
    expect(
      await fs.readFile(path.join(root, "notes/calculation.md"), "utf8"),
    ).toContain("30");
    const tools = await page.evaluate(async (root) => {
      const states = await window.desktop.agent<ChatSession[]>({
        type: "list",
        root,
      });
      return states.flatMap((state) =>
        state.messages.flatMap((message) => message.tools ?? []),
      );
    }, root);
    for (const name of ["read", "write", "bash"])
      expect(
        tools.some((tool) => tool.name === name && tool.status === "done"),
      ).toBe(true);
    const replies = await page
      .locator(".chat-message.assistant .message-text")
      .allTextContents();
    for (const file of await fs.readdir(path.join(root, ".pi", "sessions")))
      expect(
        (
          await fs.readFile(path.join(root, ".pi", "sessions", file), "utf8")
        ).includes(model.apiKey),
      ).toBe(false);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /真实模型工程/ }).click();
    await expect(
      page.locator(".chat-message.assistant .message-text"),
    ).toHaveText(replies);
  });
});

test("从真实创建入口保存默认位置、复制 PDF，重启与搬迁后重开", async () => {
  const parent = path.join(sandbox, "projects");
  const source = path.join(sandbox, "外部论文.pdf");
  await fs.copyFile(fixture, source);
  const original = await fs.readFile(source);
  await preview(source, parent);
  await expect(page.getByTestId("project-preview")).toHaveText(
    path.join(parent, "研究工程"),
  );
  await expect(page.getByLabel("将此位置设为默认工程文件夹")).toBeChecked();
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  const root = path.join(parent, "研究工程");
  const manifest = await readManifest(root);
  expect(manifest.paper.path).toBe("text/paper.pdf");
  expect(await fs.readFile(path.join(root, manifest.paper.path))).toEqual(
    original,
  );
  expect(await fs.readFile(source)).toEqual(original);
  expect(JSON.stringify(manifest)).not.toContain(parent);
  await expect.poll(async () => (await fs.readdir(root)).sort()).toEqual([
    ".paper30min-reading.json",
    ".pi",
    "explanations",
    "map",
    "memories",
    "notes",
    "paper30min.json",
    "text",
    "tmp",
  ]);
  await fs.unlink(source);
  await fs.writeFile(
    path.join(root, "notes", "真实笔记.md"),
    "# 真实笔记\n\n从外部编辑器保存的内容。",
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "真实笔记.md", exact: true }).click();
  await expect(
    page.getByText("从外部编辑器保存的内容。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText(parent, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(page.getByRole("tab", { name: "真实笔记.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect((await readManifest(root)).paper.id).toBe(manifest.paper.id);
  const moved = path.join(sandbox, "搬迁后的工程");
  // Relocate a closed project, rather than racing its atomic reading-state writes.
  await desktop.close();
  await fs.cp(root, moved, { recursive: true });
  await launch();
  await choose(moved);
  await page
    .getByRole("button", { name: "打开工程文件夹", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect((await readManifest(moved)).paper).toEqual(manifest.paper);
  expect(await fs.readFile(path.join(moved, manifest.paper.path))).toEqual(
    original,
  );
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, undefined, "重启后新建");
  await expect(page.getByTestId("project-preview")).toHaveText(
    path.join(parent, "重启后新建"),
  );
});

test("真实 PDF 导航、缩放、选区与关闭重开位置", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await expect(pdfPages()).toContainText("2");
  await expectPdfRendered();
  await setPdfZoom("100");
  await page.screenshot({ path: "test-results/pdf-desktop.png" });
  for (const offset of [300, 620]) {
    await pdfViewport().evaluate((e, y) => {
      e.scrollTop = y;
    }, offset);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await fs.readFile(
              path.join(root, ".paper30min-reading.json"),
              "utf8",
            ),
          ).pdf["text/paper.pdf"]?.y,
      )
      .toBe(offset);
    await page.getByRole("button", { name: "阅读地图", exact: true }).click();
    await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
    await expect
      .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
      .toBe(offset);
  }
  await jumpPdfPage(1);
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
    .toBeLessThan(20);
  await page.getByRole("button", { name: "光标模式", exact: true }).click();
  const bounds = (await pdfImage().boundingBox())!;
  await page.mouse.move(bounds.x + 75, bounds.y + 48);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 290, bounds.y + 48, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "复制", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await expect
    .poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain("SampleNet");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+S");
  await page.mouse.move(bounds.x + 72, bounds.y + 140);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 290, bounds.y + 240, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText("截取的PDF区域", { exact: true })).toBeVisible();
  const region = page.getByRole("img", {
    name: "Captured PDF area",
    exact: true,
  });
  await expect(region).toBeVisible();
  await expect
    .poll(() => region.evaluate((e: HTMLImageElement) => e.naturalWidth))
    .toBeGreaterThanOrEqual(218);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await jumpPdfPage(2);
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
    .toBeGreaterThan(700);
  await setPdfZoom("150");
  await expect(pdfPage()).toHaveValue("2");
  await expect
    .poll(
      async () =>
        JSON.parse(
          await fs.readFile(
            path.join(root, ".paper30min-reading.json"),
            "utf8",
          ),
        ).pdf["text/paper.pdf"]?.zoom,
    )
    .toBe(1.5);
  await page.getByRole("button", { name: "阅读地图", exact: true }).click();
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await page.evaluate(async (root) => {
    const source = await window.desktop.invoke<PdfSource>({ type: "readPdf", root, path: "text/paper.pdf" });
    const suffix = new TextEncoder().encode("\n% annotation saved without moving viewport\n");
    const bytes = new Uint8Array(source.bytes.length + suffix.length);
    bytes.set(source.bytes); bytes.set(suffix, source.bytes.length);
    await window.desktop.invoke({ type: "savePdf", root, path: "text/paper.pdf", version: source.sha256, bytes });
  }, root);
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
});

test("真实 Ctrl+滚轮仅缩放 PDF，缩放和位置在重开后保留", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expectPdfRendered();
  await setPdfZoom("100");
  await jumpPdfPage(2);
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
    .toBeGreaterThan(700);
  const scale = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  );
  const viewport = pdfViewport();
  await viewport.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -180);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => Number(await pdfZoom().inputValue()))
    .toBeGreaterThan(100);
  expect(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
  ).toBe(scale);
  const root = path.join(parent, "研究工程");
  await expect
    .poll(
      async () =>
        JSON.parse(
          await fs.readFile(
            path.join(root, ".paper30min-reading.json"),
            "utf8",
          ),
        ).pdf["text/paper.pdf"]?.zoom,
    )
    .toBeGreaterThan(1);
  const zoom = await pdfZoom().inputValue();
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue(zoom);
  await expect(pdfPage()).toHaveValue("2");
});

test("完整 Viewer 的 400% 缩放、水平滚动、双页与旋转在重开后恢复", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expectPdfRendered();
  const root = path.join(parent, "研究工程");
  const reading = async () =>
    JSON.parse(
      await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8"),
    ).pdf["text/paper.pdf"];
  await setPdfZoom("400");
  await expect.poll(async () => (await reading())?.zoom).toBe(4);
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue("400");
  await setPdfZoom("100");
  for (const name of ["水平滚动", "双页视图", "顺时针旋转"]) {
    await page.getByRole("button", { name: "页面设置", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  await expect
    .poll(async () => {
      const saved = await reading();
      return {
        strategy: saved?.scrollStrategy,
        spread: saved?.spreadMode,
        rotation: saved?.rotation,
      };
    })
    .toEqual({ strategy: "horizontal", spread: "odd", rotation: 1 });
  await pdfViewport().evaluate((e) => {
    e.scrollLeft = 300;
  });
  await expect.poll(async () => (await reading())?.x).toBe(300);
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue("100");
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollLeft))
    .toBe(300);
  await expect
    .poll(async () => (await pdfImage().boundingBox())!.width)
    .toBeGreaterThan(700);
  await page.getByRole("button", { name: "页面设置", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "水平滚动", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "test-results/pdf-horizontal-spread-rotated.png",
  });
});

test("中文参考 PDF、无文本层、加密和损坏文件显式反馈", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expect(pdfPages()).toContainText("2");
  const add = async (file: string, name: string) => {
    await page.getByRole("button", { name: "相关材料", exact: true }).click();
    await choose(file);
    await page.getByRole("button", { name: "添加材料", exact: true }).click();
    await page
      .getByRole("button", { name: `${name} text/${name}`, exact: true })
      .click();
  };
  const chinese = path.join(sandbox, "扫描材料.pdf");
  await fs.copyFile(
    path.resolve(
      "../legacy/v1/app/src-tauri/tests/fixtures/pdfparse_scanned_blank.pdf",
    ),
    chinese,
  );
  await add(chinese, "扫描材料.pdf");
  await expectPdfRendered();
  await add(path.resolve("tests/fixtures/encrypted.pdf"), "encrypted.pdf");
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();
  await page.getByPlaceholder("请输入文件密码").fill("wrong");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(
    page.getByText("密码错误，请检查后重新输入。", { exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("请输入文件密码").fill("paper30min-test");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expectPdfRendered();
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  const corrupt = path.join(sandbox, "损坏.pdf");
  await fs.writeFile(corrupt, "%PDF-1.7\nbroken document\n");
  await create(corrupt, parent, "损坏论文");
  await expect(page.getByText("文件加载出错", { exact: true })).toBeVisible();
  const large = path.join(parent, "损坏论文/text/paper.pdf");
  const handle = await fs.open(large, "r+");
  await handle.truncate(129 * 1024 * 1024);
  await handle.close();
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("128 MiB");
});

test("150 页文档按视口渲染，反复关闭释放并在窄窗口阅读", async () => {
  await create(
    path.resolve("tests/fixtures/long-150.pdf"),
    path.join(sandbox, "projects"),
  );
  await expect(pdfPages()).toContainText("150");
  const viewport = pdfViewport();
  await expectPdfRendered();
  await setPdfZoom("100");
  const client = await page.context().newCDPSession(page);
  await client.send("HeapProfiler.collectGarbage");
  const before = await desktop.evaluate(async ({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === "Tab")
      .map((m) => m.memory.workingSetSize),
  );
  for (let cycle = 0; cycle < 6; cycle++) {
    await jumpPdfPage(145 - cycle);
    await expect
      .poll(() => viewport.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(100_000);
    await expect
      .poll(() =>
        viewport.locator('img[style*="pointer-events: none"]').count(),
      )
      .toBeLessThanOrEqual(10);
    await page
      .getByRole("button", { name: "关闭 paper.pdf", exact: true })
      .click();
    await expect(viewport).toHaveCount(0);
    await expect.poll(() => page.workers().length).toBe(0);
    await page.getByRole("button", { name: "原始论文", exact: true }).click();
    await expect(pdfPages()).toContainText("150");
    await expectPdfRendered();
    await expect(pdfPage()).toHaveValue(String(145 - cycle));
  }
  await client.send("HeapProfiler.collectGarbage");
  const after = await desktop.evaluate(async ({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === "Tab")
      .map((m) => m.memory.workingSetSize),
  );
  console.log("PDF renderer working set KiB", { before, after });
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(560, 760),
  );
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".sidebar-slot")
        .evaluate((e) => e.getBoundingClientRect().width),
    )
    .toBe(0);
  await expect(viewport).toBeVisible();
  await expectPdfRendered();
  await page.screenshot({ path: "test-results/pdf-narrow.png" });
});

test("旧 PDF 批量导入只复制原文，保留冲突目录并在重开后幂等重试", async () => {
  const parent = path.join(sandbox, "projects");
  const legacy = path.join(sandbox, "旧书库");
  for (const id of ["a", "b", "c"]) {
    await fs.mkdir(path.join(legacy, "attachments", id), { recursive: true });
    await fs.copyFile(fixture, path.join(legacy, "attachments", id, "pdf"));
  }
  await fs.writeFile(path.join(legacy, "attachments/c/pdf"), "not a PDF");
  await fs.writeFile(path.join(legacy, "attachments/a/card.png"), "old image");
  await fs.copyFile(fixture, path.join(legacy, "attachments/a/pdf.old"));
  await fs.mkdir(path.join(legacy, "database"));
  await fs.writeFile(path.join(legacy, "database/library.sqlite"), "unreadable old metadata");
  await fs.mkdir(path.join(parent, "pdf-a"));
  await fs.writeFile(path.join(parent, "pdf-a/keep.txt"), "do not overwrite");

  await page.getByRole("button", { name: "导入旧 PDF", exact: true }).click();
  await expect(page.getByText("请先设置默认工程文件夹", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭导入", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await choose(parent);
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await page.getByRole("button", { name: "返回工程", exact: true }).click();
  await page.getByRole("button", { name: "导入旧 PDF", exact: true }).click();
  await choose(legacy);
  await page.getByRole("button", { name: "选择旧书库", exact: true }).click();
  await expect(page.getByLabel("工程名称 1", { exact: true })).toHaveValue("pdf-a");
  await page.getByLabel("工程名称 2", { exact: true }).fill("第二篇");
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试未完成项", exact: true })).toBeEnabled();
  await expect(page.getByText("已创建", { exact: true })).toHaveCount(2);
  await expect(page.getByText("失败", { exact: true })).toHaveCount(1);
  expect(await fs.readFile(path.join(parent, "pdf-a/keep.txt"), "utf8")).toBe("do not overwrite");
  const original = await fs.readFile(fixture);
  const first = path.join(parent, "pdf-a (2)");
  for (const root of [first, path.join(parent, "第二篇")]) {
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(original);
    expect(await fs.readdir(path.join(root, "text"))).toEqual(["paper.pdf"]);
    for (const folder of ["notes", "map", "explanations", ".pi/sessions"])
      expect(await fs.readdir(path.join(root, folder))).toEqual([]);
    expect(await readManifest(root)).toMatchObject({ map: null, materials: [], explanations: [], translations: {} });
  }
  await page.screenshot({ path: "test-results/legacy-import-desktop.png" });
  await page.setViewportSize({ width: 600, height: 760 });
  await page.screenshot({ path: "test-results/legacy-import-narrow.png" });
  expect(await page.locator('[aria-label="导入旧 PDF"]').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(await page.getByRole("dialog", { name: "导入旧 PDF", exact: true }).evaluate((e) => {
    const box = e.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth;
  })).toBe(true);
  await fs.copyFile(fixture, path.join(legacy, "attachments/c/pdf"));
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: "导入旧 PDF", exact: true }).click();
  await choose(legacy);
  await page.getByRole("button", { name: "选择旧书库", exact: true }).click();
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText("已存在", { exact: true })).toHaveCount(2);
  await expect(page.getByText("已创建", { exact: true })).toHaveCount(1);
  expect((await fs.readdir(parent)).sort()).toEqual(["pdf-a", "pdf-a (2)", "pdf-c", "第二篇"].sort());
  expect(await fs.readFile(path.join(legacy, "attachments/a/pdf"))).toEqual(original);
  expect(await fs.readFile(path.join(legacy, "database/library.sqlite"), "utf8")).toBe("unreadable old metadata");
  expect(await fs.readFile(path.join(legacy, "attachments/a/card.png"), "utf8")).toBe("old image");
  await fs.rename(legacy, path.join(sandbox, "旧库已移动"));
  await page.getByRole("button", { name: "打开 pdf-a (2)", exact: true }).click();
  await expectPdfRendered();
});

test("旧 PDF 导入报告空库、危险路径、消失源文件和不可用默认位置", async () => {
  const parent = path.join(sandbox, "projects");
  const legacy = path.join(sandbox, "旧书库");
  const outside = path.join(sandbox, "外部论文");
  await fs.mkdir(path.join(legacy, "attachments"), { recursive: true });
  await fs.mkdir(outside);
  await fs.copyFile(fixture, path.join(outside, "pdf"));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await choose(parent);
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await page.getByRole("button", { name: "导入旧 PDF", exact: true }).click();
  await choose(legacy);
  await page.getByRole("button", { name: "选择旧书库", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("没有可导入");
  await fs.symlink(outside, path.join(legacy, "attachments/escape"), "junction");
  await fs.mkdir(path.join(legacy, "attachments/valid"));
  await fs.copyFile(fixture, path.join(legacy, "attachments/valid/pdf"));
  await page.getByRole("button", { name: "选择旧书库", exact: true }).click();
  await expect(page.locator(".legacy-items")).toContainText("符号链接或目录联接");
  await fs.unlink(path.join(legacy, "attachments/valid/pdf"));
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText("失败", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "重试未完成项", exact: true })).toBeEnabled();
  expect(await fs.readdir(parent)).toEqual([]);
  expect(await fs.readFile(path.join(outside, "pdf"))).toEqual(await fs.readFile(fixture));
  expect(await page.evaluate(async (root) => {
    try { await window.desktop.invoke({ type: "importLegacy", root, path: "attachments/../pdf", name: "越界", operationId: "unsafe" }); }
    catch (error) { return (error as Error).message; }
  }, legacy)).toContain("不能");
  await fs.copyFile(fixture, path.join(legacy, "attachments/valid/pdf"));
  await fs.rmdir(parent);
  await page.getByRole("button", { name: "重试未完成项", exact: true }).click();
  await expect(page.locator(".legacy-items")).toContainText("重新选择保存位置");
  await expect(page.getByRole("button", { name: "重试未完成项", exact: true })).toBeEnabled();
});

test("旧 PDF 导入停止清理当前项，进程中断保留残留并可继续", async () => {
  const parent = path.join(sandbox, "projects");
  const legacy = path.join(sandbox, "旧书库");
  for (const id of ["a", "z"]) await fs.mkdir(path.join(legacy, "attachments", id), { recursive: true });
  await fs.copyFile(fixture, path.join(legacy, "attachments/a/pdf"));
  const large = await fs.open(path.join(legacy, "attachments/z/pdf"), "w");
  await large.write(await fs.readFile(fixture));
  await large.truncate(1024 * 1024 * 1024);
  await large.close();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await choose(parent);
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await page.getByRole("button", { name: "导入旧 PDF", exact: true }).click();
  await choose(legacy);
  await page.getByRole("button", { name: "选择旧书库", exact: true }).click();
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect.poll(() => fs.readdir(parent), { intervals: [10] }).toContain("pdf-z");
  await page.getByRole("button", { name: "停止导入", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试未完成项", exact: true })).toBeEnabled();
  expect(await fs.readdir(parent)).toEqual(["pdf-a"]);
  await page.getByRole("button", { name: "重试未完成项", exact: true }).click();
  await expect.poll(() => fs.readdir(parent), { intervals: [10] }).toContain("pdf-z");
  await desktop.evaluate(({ app }) => {
    const target = app.getAppMetrics().find((metric) => metric.name === "Paper30Min Project");
    if (!target) throw new Error("找不到测试工程进程");
    process.kill(target.pid);
  });
  await expect(page.getByRole("button", { name: "重试未完成项", exact: true })).toBeEnabled();
  const interrupted = path.join(parent, "pdf-z");
  expect(await fs.stat(interrupted)).toBeTruthy();
  await fs.writeFile(path.join(interrupted, "keep.txt"), "interrupted directory");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: "导入旧 PDF", exact: true }).click();
  await choose(legacy);
  await page.getByRole("button", { name: "选择旧书库", exact: true }).click();
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText("已存在", { exact: true })).toHaveCount(1);
  await expect(page.getByText("已创建", { exact: true })).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "关闭导入", exact: true })).toBeEnabled();
  expect(await fs.readFile(path.join(interrupted, "keep.txt"), "utf8")).toBe("interrupted directory");
  expect((await fs.stat(path.join(parent, "pdf-z (2)/text/paper.pdf"))).size).toBe(1024 * 1024 * 1024);
  expect(JSON.parse(await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8")).recent).toHaveLength(2);
});

test("默认位置与单次位置独立，同名目录和不可用默认位置明确失败", async () => {
  const first = path.join(sandbox, "projects");
  const second = path.join(sandbox, "其他位置");
  await fs.mkdir(second);
  await create(fixture, first, "第一工程");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await choose(second);
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(page.getByText(second, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  expect((await readManifest(path.join(first, "第一工程"))).name).toBe(
    "第一工程",
  );
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, first, "第二工程");
  await expect(page.getByLabel("将此位置设为默认工程文件夹")).not.toBeChecked();
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect(
    JSON.parse(
      await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8"),
    ).defaultFolder,
  ).toBe(second);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, first, "第一工程");
  const before = await fs.readFile(
    path.join(first, "第一工程/paper30min.json"),
  );
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("同名工程文件夹已存在");
  expect(
    await fs.readFile(path.join(first, "第一工程/paper30min.json")),
  ).toEqual(before);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await fs.rmdir(second);
  await preview(fixture, undefined, "不可用位置");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("重新选择保存位置");
  expect(await fs.readdir(first)).toEqual(
    expect.arrayContaining(["第一工程", "第二工程"]),
  );
  expect(
    JSON.parse(
      await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8"),
    ).recent,
  ).toHaveLength(2);
});

test("选择取消、复制源消失和复制中取消均不登记工程或遗留产物", async () => {
  await choose(null);
  await page
    .getByRole("button", { name: "从 PDF 新建工程", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const source = path.join(sandbox, "即将消失.pdf");
  const parent = path.join(sandbox, "projects");
  await fs.copyFile(fixture, source);
  await preview(source, parent, "复制失败");
  await fs.unlink(source);
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await fs.readdir(parent)).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const large = path.join(sandbox, "大论文.pdf");
  await fs.mkdir(path.join(sandbox, "profile/preferences.json"));
  await preview(fixture, parent, "登记失败");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await fs.readdir(parent)).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await fs.rmdir(path.join(sandbox, "profile/preferences.json"));
  const file = await fs.open(large, "w");
  await file.write("%PDF-1.7\n");
  await file.truncate(1024 * 1024 * 1024);
  await file.close();
  await preview(large, parent, "取消工程");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect.poll(() => fs.readdir(parent)).toContain("取消工程");
  await page.getByRole("button", { name: "取消创建", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已取消创建工程");
  expect(await fs.readdir(parent)).toEqual([]);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "创建工程", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("尚无最近工程", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await preview(large, parent, "退出时取消");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect.poll(() => fs.readdir(parent)).toContain("退出时取消");
  await desktop.close();
  expect(await fs.readdir(parent)).toEqual([]);
  await launch();
  await expect(page.getByText("尚无最近工程", { exact: true })).toBeVisible();
});

test("材料真实添加、改名移动、重新关联与系统回收站，工程论文身份固定", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const paper = (await readManifest(root)).paper;
  await page.getByRole("button", { name: "相关材料", exact: true }).click();
  const source = path.join(sandbox, "参考材料.txt");
  await fs.writeFile(source, "与论文有关的真实材料");
  await choose(source);
  await page.getByRole("button", { name: "添加材料", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "参考材料.txt text/参考材料.txt",
      exact: true,
    }),
  ).toBeVisible();
  let manifest = await readManifest(root);
  const id = manifest.materials[0].id;
  expect(
    await fs.readFile(path.join(root, manifest.materials[0].path), "utf8"),
  ).toBe("与论文有关的真实材料");
  await page
    .getByRole("button", { name: "改名或移动 text/参考材料.txt", exact: true })
    .click();
  await page.getByLabel("工程内相对路径").fill("notes/改名材料.txt");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /改名材料.txt/ }).first(),
  ).toBeVisible();
  manifest = await readManifest(root);
  expect(manifest.materials[0]).toMatchObject({
    id,
    path: "notes/改名材料.txt",
  });
  await fs.rename(
    path.join(root, "notes/改名材料.txt"),
    path.join(root, "notes/外部移动.txt"),
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新关联", exact: true }),
  ).toBeVisible();
  await choose(path.join(root, "notes/外部移动.txt"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移出 notes/外部移动.txt", exact: true }),
  ).toBeVisible();
  expect((await readManifest(root)).materials[0]).toMatchObject({
    id,
    path: "notes/外部移动.txt",
  });
  await page
    .getByRole("button", { name: "移出 notes/外部移动.txt", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("相关引用将失效");
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await readManifest(root)).materials).toEqual([]);
  await expect(
    fs.stat(path.join(root, "notes/外部移动.txt")),
  ).rejects.toThrow();
  expect(await fs.readFile(source, "utf8")).toBe("与论文有关的真实材料");
  await page
    .getByRole("button", { name: "改名或移动 text/paper.pdf", exact: true })
    .click();
  await page.getByLabel("工程内相对路径").fill("text/工程论文.pdf");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "改名或移动 text/工程论文.pdf",
      exact: true,
    }),
  ).toBeVisible();
  expect((await readManifest(root)).paper).toEqual({
    ...paper,
    path: "text/工程论文.pdf",
  });
  await fs.rename(
    path.join(root, "text/工程论文.pdf"),
    path.join(root, "text/外部改名.pdf"),
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  const wrong = path.join(sandbox, "另一论文.pdf");
  await fs.writeFile(wrong, "%PDF-1.7\n另一份内容");
  await choose(wrong);
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("文件内容与原文档不同");
  await choose(path.join(root, "text/外部改名.pdf"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "改名或移动 text/外部改名.pdf",
      exact: true,
    }),
  ).toBeVisible();
  expect((await readManifest(root)).paper.id).toBe(paper.id);
  await expect(page.getByRole("button", { name: /^移出 / })).toHaveCount(0);
});

test("重新关联拒绝其他文档已占用的路径，失败后工程仍可重开", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const reference = path.join(sandbox, "相同内容参考.pdf");
  await fs.copyFile(fixture, reference);
  await page.getByRole("button", { name: "相关材料", exact: true }).click();
  await choose(reference);
  await page.getByRole("button", { name: "添加材料", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "移出 text/相同内容参考.pdf",
      exact: true,
    }),
  ).toBeVisible();
  const before = await fs.readFile(path.join(root, "paper30min.json"), "utf8");
  await fs.rename(
    path.join(root, "text/paper.pdf"),
    path.join(root, "text/外部改名.pdf"),
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await choose(path.join(root, "text/相同内容参考.pdf"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已关联另一份文档");
  expect(await fs.readFile(path.join(root, "paper30min.json"), "utf8")).toBe(
    before,
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新关联", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await choose(root);
  await page
    .getByRole("button", { name: "打开工程文件夹", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "相关材料", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(page.getByRole("heading", { name: "找不到文件" })).toBeVisible();
  await choose(path.join(root, "text/外部改名.pdf"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(page.getByRole("tab", { name: "外部改名.pdf" })).toBeVisible();
  await expect(pdfPages()).toContainText("2");
  const after = await readManifest(root);
  expect(after.paper.id).toBe(JSON.parse(before).paper.id);
  expect(after.materials[0].path).toBe("text/相同内容参考.pdf");
});

test("侧栏拖拽跟手、限制中栏宽度并在收放和重启后恢复", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  let left = page.getByRole("separator", { name: "调整左侧栏宽度" });
  let right = page.getByRole("separator", { name: "调整 Agent 宽度" });
  async function drag(handle: typeof left, distance: number) {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + distance, y, { steps: 6 });
  }
  await drag(left, 60);
  // Observe the layout while the pointer is still held, before any animation could finish.
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  expect((await page.locator(".sidebar-slot").boundingBox())!.width).toBe(292);
  await page.mouse.up();
  await drag(right, -120);
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  expect((await page.locator(".right-slot").boundingBox())!.width).toBe(456);
  await page.mouse.up();
  await page.screenshot({ path: "test-results/workbench-resized.png" });
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await page.getByRole("button", { name: "展开左侧栏", exact: true }).click();
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  await page.getByRole("button", { name: "收起 Agent", exact: true }).click();
  await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /^研究工程/ }).click();
  left = page.getByRole("separator", { name: "调整左侧栏宽度" });
  right = page.getByRole("separator", { name: "调整 Agent 宽度" });
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 780 }),
  );
  await expect
    .poll(async () => (await page.locator(".main").boundingBox())!.width)
    .toBeGreaterThanOrEqual(360);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 940 }),
  );
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  await left.focus();
  await page.keyboard.press("Home");
  await expect(left).toHaveAttribute("aria-valuenow", "155");
  await drag(right, -1000);
  await page.mouse.up();
  await expect(right).toHaveAttribute("aria-valuenow", "560");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 560, height: 780 }),
  );
  await expect(right).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "从一个问题开始" }),
  ).toBeVisible();
  await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/workbench-resized-narrow.png" });
});

test("工作台真实文件树、标签复用与设置返回，桌面和窄窗口布局", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  await fs.writeFile(
    path.join(root, "notes/这是一个用来核对长标题省略与标签固定宽度的笔记.md"),
    "# 工程笔记\n\n真实文件",
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await page.getByRole("button", { name: "工程文件", exact: true }).click();
  await page
    .getByRole("button", {
      name: "这是一个用来核对长标题省略与标签固定宽度的笔记.md",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "这是一个用来核对长标题省略与标签固定宽度的笔记.md",
      exact: true,
    })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab").last()).toHaveCSS("overflow", "hidden");
  await page.screenshot({ path: "test-results/workbench-desktop.png" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "解析模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "解析模型" })).toBeVisible();
  await page.screenshot({ path: "test-results/settings-desktop.png" });
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(page.getByRole("tab").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 560, height: 780 }),
  );
  await expect(
    page.getByRole("button", { name: "展开 Agent", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workbench-narrow.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "工程文件" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "展开左侧栏", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "工程文件" }),
  ).toBeVisible();
});

test("PDF 引用复制、原生粘贴撤销、定位高亮与标签往返", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await expectPdfRendered();
  await setPdfZoom("100");
  await page.getByRole("button", { name: "引用", exact: true }).click();
  await page.getByRole("button", { name: "框选引用", exact: true }).click();
  const image = await pdfImage().boundingBox();
  expect(image).not.toBeNull();
  const start = { x: image!.x + 60, y: image!.y + 80 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 160, start.y + 50, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("status")).toContainText("区域已选中");
  const dictionaryFile = path.join(root, ".paper30min-citations.json");
  await expect(fs.access(dictionaryFile)).rejects.toThrow();
  // Reselect replaces temporary geometry; neither selection nor cancellation publishes a link.
  await page.getByRole("button", { name: "框选引用", exact: true }).click();
  await expect(page.locator("[data-citation-page]")).toHaveCount(0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-citation-page]")).toHaveCount(0);
  await expect(fs.access(dictionaryFile)).rejects.toThrow();
  await page.getByRole("button", { name: "框选引用", exact: true }).click();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 90, start.y + 40, { steps: 5 });
  await expect(page.locator("[data-citation-page]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-citation-page]")).toHaveCount(0);
  await page.getByRole("button", { name: "框选引用", exact: true }).click();
  await page.getByRole("button", { name: "取消引用选择", exact: true }).first().click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "框选引用", exact: true }).click();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 160, start.y + 50, { steps: 10 });
  await page.mouse.up();
  await page.screenshot({ path: "test-results/citation-toolbar-preview.png" });
  await page.mouse.click(start.x + 30, start.y + 15, { button: "right" });
  await page.getByRole("menuitem", { name: "复制引用链接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制引用链接");
  const link = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  expect(link).toMatch(/^\[PDF 第 1 页\]\(paper:\/\/cite\/[a-f0-9]{32}\)$/);
  const dictionary = JSON.parse(await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8"));
  expect(Object.keys(dictionary.citations)).toHaveLength(1);
  const source: any = Object.values(dictionary.citations)[0];
  expect(source.kind).toBe("region");
  expect(source.pages[0].rects[0].origin.x).toBeCloseTo(60, 0);
  expect(source.pages[0].rects[0].size.width).toBeCloseTo(160, 0);
  await fs.writeFile(path.join(root, "notes/引用.md"), "草稿开始\n\n");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "引用.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await editor.press("Control+End");
  await editor.press("Control+v");
  await expect(editor).toContainText("paper://cite/");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("paper://cite/");
  await editor.press("Control+v");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await page.getByRole("link", { name: "PDF 第 1 页", exact: true }).click();
  await expectPdfRendered();
  await expect(page.locator("[data-citation-page]").first()).toBeVisible();
  const mark = page.locator('[aria-label="引用高亮"] [data-citation-page="1"]');
  await expect(mark).toHaveCount(1);
  await expect.poll(async () => {
    const [rect, pdf] = await Promise.all([mark.boundingBox(), pdfImage().boundingBox()]);
    return rect && pdf ? rect.x - pdf.x : undefined;
  }).toBeCloseTo(60, 0);
  await expect.poll(async () => {
    const [rect, pdf] = await Promise.all([mark.boundingBox(), pdfImage().boundingBox()]);
    return rect && pdf ? rect.y - pdf.y : undefined;
  }).toBeCloseTo(80, 0);
  await setPdfZoom("150");
  await expect.poll(async () => (await mark.boundingBox())?.width).toBeCloseTo(240, 0);
  for (const name of ["水平滚动", "双页视图", "顺时针旋转"]) {
    await page.getByRole("button", { name: "页面设置", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  await expect.poll(async () => (await mark.boundingBox())?.height).toBeCloseTo(240, 0);
  await expect.poll(async () => {
    const marked = await mark.boundingBox();
    const image = await pdfImage().boundingBox();
    return marked && image ? marked.x - image.x : undefined;
  }).toBeCloseTo((source.pages[0].height - 130) * 1.5, 0);
  await pdfViewport().evaluate((element) => { element.scrollLeft = 500; element.scrollTop = 0; });
  await expect.poll(async () => {
    const marked = await mark.boundingBox();
    const image = await pdfImage().boundingBox();
    return marked && image ? marked.y - image.y : undefined;
  }).toBeCloseTo(60 * 1.5, 0);
  await page.screenshot({ path: "test-results/citation-rotated.png" });
  await page.getByRole("tab", { name: "引用.md", exact: true }).click();
  await expect(editor).toContainText(link);
  await editor.getByText(/paper:\/\/cite\//).click({ modifiers: ["Control"] });
  await expect(page.locator("[data-citation-page]").first()).toBeVisible();
  await page.getByRole("tab", { name: "引用.md", exact: true }).click();

  await expect.poll(() => fs.readFile(path.join(root, "notes/引用.md"), "utf8")).toContain(link);
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await page.getByRole("link", { name: "PDF 第 1 页", exact: true }).click();
  await expect(page.locator("[data-citation-page]").first()).toBeVisible();
});

test("PDF 初始化期间连续点击引用保留最新目标", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const manifest = await readManifest(root);
  const links = await page.evaluate(async ({ root, sha256 }) => {
    const ids = await Promise.all([1, 2].map((page) => window.desktop.invoke<{ id: string }>({
      type: "createCitation", root, path: "text/paper.pdf", input: { sha256, kind: "region", text: "",
        pages: [{ page, width: 612, height: 792, rects: [{ origin: { x: 50, y: 160 }, size: { width: 180, height: 12 } }] }] },
    })));
    return ids.map(({ id }, i) => `[目标${i + 1}](paper://cite/${id})`).join("\n\n");
  }, { root, sha256: manifest.paper.sha256 });
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  const sessionDir = path.join(root, ".pi/sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const session = SessionManager.create(root, sessionDir);
  session.appendMessage({ role: "user", content: "请提供两个出处", timestamp: Date.now() });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: links }],
    api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  // Delay the actual browser worker transport, retaining real PDF/plugin initialization.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage as (this: Worker, message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void;
    const pending: (() => void)[] = [];
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      pending.push(() => original.call(this, message, options));
    };
    window.addEventListener("release-pdf-workers", () => {
      Worker.prototype.postMessage = original;
      for (const send of pending) send();
    }, { once: true });
  });
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(page.locator("embedpdf-container")).toHaveCount(1);
  await page.locator(".chat-message").getByRole("link", { name: "目标1", exact: true }).click();
  await page.locator(".chat-message").getByRole("link", { name: "目标2", exact: true }).click();
  await expect(pdfImage()).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("release-pdf-workers")));
  await expectPdfRendered();
  await expect(pdfPage()).toHaveValue("2");
  await expect(page.locator("[data-citation-page]")).toHaveAttribute("data-citation-page", "2");
  await page.locator(".chat-message").getByRole("link", { name: "目标1", exact: true }).click();
  await expect(pdfPage()).toHaveValue("1");
  await expect(page.locator("[data-citation-page]")).toHaveAttribute("data-citation-page", "1");
});

test("同一阅读器共用批注与无痕引用，保存后可继续取证且反查不丢内存批注", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  await expectPdfRendered();
  await expect(page.getByRole("group", { name: "PDF 引用模式" })).toHaveCount(0);
  const original = await fs.readFile(path.join(root, "text/paper.pdf"));
  await page.getByRole("button", { name: "引用", exact: true }).click();
  await page.getByRole("button", { name: "整页引用", exact: true }).click();
  await page.getByRole("button", { name: "复制引用链接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制引用链接");
  const invisible = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  expect(invisible).toContain("paper://cite/");
  expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(original);
  expect(await nativeAnnotations()).toHaveLength(0);
  await fs.writeFile(path.join(root, "notes/混合.md"), `# 混合笔记\n\n${invisible}\n`);
  await nativeHighlight();
  const before = (await nativeAnnotations())[0];
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  const list = page.getByRole("complementary", { name: "文档引用使用位置" });
  await list.getByRole("button", { name: /整页引用/ }).click();
  expect((await nativeAnnotations())[0].id).toBe(before.id);
  await page.getByRole("button", { name: "关闭文档引用列表", exact: true }).click();
  await page.getByRole("button", { name: "复制批注链接", exact: true }).first().click();
  await expect(page.getByRole("status")).toContainText("已复制 1 个批注链接");
  const annotation = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  await fs.appendFile(path.join(root, "notes/混合.md"), annotation.replace("text/paper.pdf", "../text/paper.pdf"));
  await page.getByRole("button", { name: "引用", exact: true }).click();
  await page.getByRole("button", { name: "整页引用", exact: true }).click();
  await page.locator("embedpdf-container").evaluate(async (element, id) => {
    const registry = await (element as EmbedPdfContainer).registry;
    registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").updateAnnotation(0, id, { contents: "Saved alongside citation" });
  }, before.id);
  await page.getByRole("button", { name: "复制引用链接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制引用链接");
  const after = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  const dictionary = JSON.parse(await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8"));
  expect(dictionary.citations[after.match(/cite\/([a-f0-9]+)/)![1]]).not.toHaveProperty("sha256");

  expect(after).toContain("paper://cite/");
  expect(after).toBe(invisible);
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  await expect(list.locator("section")).toHaveCount(2);
  await expect(list).toContainText("整页引用");
  await expect(list).toContainText("原生批注 · 第 1 页");
  await expect(page.locator("[data-document-citation], [data-citation-uses-page]")).toHaveCount(0);
  await list.getByRole("button", { name: /原生批注 · 第/ }).click();
  await expectAnnotationSelected();
  await list.locator("section").filter({ hasText: "原生批注" }).getByRole("button", { name: /混合笔记/ }).click();
  await expect(page.locator(".citation-use-target")).toContainText("PDF 第 1 页批注");
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expectPdfRendered();
});

test("原生批注跨行高亮保存到工程 PDF，重开保持链接身份", async () => {
  test.setTimeout(90_000);
  await create(fixture, path.join(sandbox, "projects"));
  await expectPdfRendered();
  await expectPdfRendered();
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.getByRole("button", { name: "高亮", exact: true }).first().click();
  const image = await pdfImage().boundingBox();
  await page.mouse.move(image!.x + 80, image!.y + 190);
  await page.mouse.down();
  await page.mouse.move(image!.x + 300, image!.y + 230, { steps: 20 });
  await page.mouse.up();
  await page.getByRole("button", { name: "复制批注链接", exact: true }).first().click();
  await expect(page.getByRole("status")).toContainText("已复制 1 个批注链接");
  const markdown = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  expect(markdown).toMatch(/text\/paper\.pdf#annotation=[^)]/);
  const root = path.join(sandbox, "projects/研究工程");
  await expect(fs.readFile(path.join(root, ".paper30min-citations.json"))).rejects.toThrow();
  await page.getByLabel("Agent 消息").press("Control+v");
  await expect(page.getByLabel("Agent 消息")).toHaveValue("PDF 第 1 页批注");
  await expect(page.locator(".chat-attachments > span")).toHaveCount(1);
  await expect(page.locator(".chat-attachments button").first()).toHaveAttribute("title", markdown.match(/\]\((.*)\)$/)![1]);
  await fs.writeFile(path.join(root, "notes/批注.md"), "# 我的笔记\n\n");
  await fs.mkdir(path.join(root, "map/deep"));
  const deepLink = markdown.replace("text/paper.pdf", "../../text/paper.pdf");
  await fs.writeFile(path.join(root, "map/deep/另一篇.md"), `# 第二篇\n\n${deepLink}\n\n再次使用 ${deepLink}\n`);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "批注.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await editor.press("Control+End");
  await editor.press("Control+v");
  await expect(editor).toContainText("../text/paper.pdf#annotation=");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("#annotation=");
  await editor.press("Control+v");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await page.locator('.markdown-preview a[href*="#annotation="]').click();
  await expectAnnotationSelected();
  await page.getByRole("tab", { name: "批注.md", exact: true }).click();
  await expect(editor).toContainText("../text/paper.pdf#annotation=");

  await page.locator('.markdown-preview a[href*="#annotation="]').click();
  await expectAnnotationSelected();
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  const uses = page.getByRole("complementary", { name: "文档引用使用位置" });
  await expect(uses.locator("section > button:not(.citation-source)")).toHaveCount(3);
  await uses.getByRole("button", { name: /第二篇/ }).nth(1).click();
  await expect(page.locator(".citation-use-target")).toContainText("PDF 第 1 页批注");
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expectPdfRendered();
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "批注.md", exact: true }).click();
  await page.locator('.markdown-preview a[href*="#annotation="]').first().click();
  await expectAnnotationSelected();
  const reopened = await nativeAnnotations();
  expect(reopened).toHaveLength(1);
  expect(reopened[0].id).toBe(decodeURIComponent(markdown.match(/#annotation=([^)]*)/)![1]));
  expect("segmentRects" in reopened[0] && reopened[0].segmentRects!.length).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: "test-results/native-annotation-reopened.png" });
});

test("原生批注在 Markdown 与已有会话中随 PDF 和文档移动更新，移除链接不删除批注", async () => {
  test.setTimeout(120_000);
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  await expectPdfRendered();
  await expectPdfRendered();
  await nativeHighlight();
  await page.getByRole("button", { name: "复制批注链接", exact: true }).first().click();
  await expect(page.getByRole("status")).toContainText("已复制 1 个批注链接");
  const markdown = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  const id = decodeURIComponent(markdown.match(/#annotation=([^)]*)/)![1]);
  const relative = markdown.replace("text/paper.pdf", "../text/paper.pdf");
  const href = relative.match(/\]\((.*)\)$/)![1];
  await fs.writeFile(path.join(root, "notes/甲.md"), `# 甲\n\n${relative}\n\n[再次][a\\]]\n\n[a\\]]: ${href}\n`);
  await fs.mkdir(path.join(root, "map/deep"));
  const sessionDir = path.join(root, ".pi/sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: markdown, timestamp: Date.now() });
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /研究工程/ }).click();
  const chatLink = page.locator('.chat-message a[href*="#annotation="]');
  await expect(chatLink).toHaveCount(1);
  await chatLink.click();
  await expectAnnotationSelected();
  await page.getByRole("button", { name: "改名或移动", exact: true }).click();
  await page.getByLabel("工程内相对路径").fill("text/批注 甲.pdf");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("tab", { name: "批注 甲.pdf", exact: true })).toBeVisible();
  await expect(chatLink).toHaveAttribute("href", new RegExp("text/%E6%89%B9%E6%B3%A8%20%E7%94%B2\\.pdf#annotation="));
  expect(await fs.readFile(manager.getSessionFile()!, "utf8")).toContain("%E6%89%B9%E6%B3%A8%20%E7%94%B2.pdf#annotation=");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "甲.md", exact: true }).click();
  await page.getByRole("button", { name: "改名或移动", exact: true }).click();
  await page.getByLabel("工程内相对路径").fill("map/deep/移动.md");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("tab", { name: "移动.md", exact: true })).toBeVisible();
  const moved = await fs.readFile(path.join(root, "map/deep/移动.md"), "utf8");
  expect(moved).toContain("../../text/%E6%89%B9%E6%B3%A8%20%E7%94%B2.pdf#annotation=" + id);
  expect(moved).toContain("[a\\]]: ../../text/");
  await expect(page.locator('.markdown-preview a[href*="#annotation="]')).toHaveCount(2);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown 源码", exact: true }).locator(".cm-line")
    .filter({ hasText: "[再次][a\\]]" }).click({ modifiers: ["Control"] });
  await expectAnnotationSelected();
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "文档引用使用位置" }).locator("section > button:not(.citation-source)")).toHaveCount(2);
  await fs.writeFile(path.join(root, "map/deep/移动.md"), "# 已移除链接\n");
  await expect(page.getByRole("complementary", { name: "文档引用使用位置" })).toContainText("没有文档使用此批注");
  expect((await nativeAnnotations()).map((a) => a.id)).toContain(id);
  await fs.rename(path.join(root, "text/批注 甲.pdf"), path.join(root, "text/external.pdf"));
  await chatLink.click();
  await expect(page.getByRole("alert").filter({ hasText: "批注 PDF 已缺失或移动" })).toBeVisible();
});

test("原生批注保存保护外部版本、失败现场和并发写入，旧引用在保存批注后仍可解析", async () => {
  test.setTimeout(120_000);
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const manifest = await readManifest(root);
  const old = await page.evaluate(({ root, sha256 }) => window.desktop.invoke<{ id: string }>({ type: "createCitation", root, path: "text/paper.pdf",
    input: { sha256, kind: "page", text: "", pages: [{ page: 1, width: 612, height: 792, rects: [] }] } }), { root, sha256: manifest.paper.sha256 });
  await expectPdfRendered();
  await expectPdfRendered();
  await nativeHighlight();
  const file = path.join(root, "text/paper.pdf");
  const original = await fs.readFile(file);
  const external = Buffer.concat([original, Buffer.from("\n% external edit\n")]);
  await fs.writeFile(file, external);
  await expect(page.getByRole("alert").filter({ hasText: "批注保存失败" })).toBeVisible();
  expect(await fs.readFile(file)).toEqual(external);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await expect(page.locator(".notice.error").filter({ hasText: "PDF 自动保存失败" })).toBeVisible();
  await expect(page.locator(".pdf-reader")).toBeVisible();
  await fs.writeFile(file, original);
  await page.getByRole("button", { name: "重试自动保存", exact: true }).click();
  // Leaving the reader waits for its pending save; polling the PDF can itself
  // prevent Windows from replacing it while the test holds a read handle.
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await expect(page.locator(".pdf-reader")).not.toBeVisible();
  expect((await fs.readFile(file)).equals(original)).toBe(false);
  expect(await page.evaluate(({ root, id }) => window.desktop.invoke<{ path: string }>({ type: "resolveCitation", root, link: "paper://cite/" + id }), { root, id: old.id })).toMatchObject({ path: "text/paper.pdf" });
  const source = await page.evaluate((root) => window.desktop.invoke<{ bytes: Uint8Array; sha256: string }>({ type: "readPdf", root, path: "text/paper.pdf" }), root);
  const outcomes = await page.evaluate(async ({ root, bytes, sha256 }) => {
    const first = new Uint8Array([...Object.values(bytes), ...new TextEncoder().encode("\n% first save\n")]);
    const second = new Uint8Array([...Object.values(bytes), ...new TextEncoder().encode("\n% second save\n")]);
    return Promise.allSettled([first, second].map((value) => window.desktop.invoke({ type: "savePdf", root, path: "text/paper.pdf", bytes: value, version: sha256 })));
  }, { root, ...source });
  expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
  expect((await fs.readFile(file)).subarray(-14).toString()).toBe("\n% first save\n");
  await fs.writeFile(path.join(root, "notes/保存前出处.md"), `[保存前出处](paper://cite/${old.id})`);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "保存前出处.md", exact: true }).click();
  await page.getByRole("link", { name: "保存前出处", exact: true }).click();
  await expectPdfRendered();
  await expectPdfRendered();

});

test("批注提交期间继续编辑，较新评论也写入 PDF", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  await expectPdfRendered();
  // Reproduce a new edit after PDFium writes the old snapshot, before SDK cleanup.
  await page.locator("embedpdf-container").evaluate(async (element) => {
    const registry = await (element as EmbedPdfContainer).registry;
    const api = registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading");
    const off = api.onAnnotationEvent((event) => {
      if (event.type !== "create" || !event.committed) return;
      off();
      api.updateAnnotation(event.pageIndex, event.annotation.id, { contents: "Edit during commit" });
    });
  });
  await nativeHighlight();
  await expect.poll(async () => (await nativeAnnotations())[0]?.contents).toBe("Edit during commit");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await expect(page.getByRole("tab", { name: "笔记", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expectPdfRendered();
  await expect.poll(async () => (await nativeAnnotations())[0]?.contents).toBe("Edit during commit");
  const restoredId = (await nativeAnnotations())[0].id;
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.locator("embedpdf-container").evaluate(async (element, id) => {
    const registry = await (element as EmbedPdfContainer).registry;
    registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").selectAnnotation(0, id);
    const original = Worker.prototype.postMessage as (this: Worker, message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void;
    const pending: (() => void)[] = [];
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      pending.push(() => original.call(this, message, options));
    };
    window.addEventListener("release-pdf-delete", () => {
      Worker.prototype.postMessage = original;
      for (const send of pending) send();
    }, { once: true });
  }, restoredId);
  try {
    await page.getByRole("button", { name: "删除选中的批注", exact: true }).click();
    // Hold the real worker beyond the autosave debounce, then undo in flight.
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    expect((await nativeAnnotations()).map((item) => item.id)).toContain(restoredId);
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event("release-pdf-delete")));
  }
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await expect(page.getByRole("tab", { name: "笔记", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expectPdfRendered();
  await expect.poll(async () => (await nativeAnnotations()).find((item) => item.id === restoredId)?.contents).toBe("Edit during commit");

});

test("原生批注真实论文渲染、原生评论与窄窗口可操作", async () => {
  const source = path.resolve("../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1706.03762.pdf");
  await create(source, path.join(sandbox, "projects"));
  await expectPdfRendered();
  await expectPdfRendered();
  await setPdfZoom("75");
  await expect.poll(async () => Math.round((await pdfImage().boundingBox())!.width)).toBe(459);
  const raster = PNG.sync.read(await pdfImage().screenshot());
  let ink = 0;
  for (let i = 0; i < raster.data.length; i += 4)
    if (raster.data[i] < 140 && raster.data[i + 1] < 140 && raster.data[i + 2] < 140) ink++;
  expect(ink).toBeGreaterThan(3000);
  const existingIds = (await nativeAnnotations()).map((item) => item.id);
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.getByRole("button", { name: "高亮", exact: true }).first().click();
  const image = await pdfImage().boundingBox();
  // Independent pdftotext geometry: title x=211..400, y=150..166 at 75% zoom.
  await page.mouse.move(image!.x + 160, image!.y + 118);
  await page.mouse.down(); await page.mouse.move(image!.x + 297, image!.y + 118, { steps: 15 }); await page.mouse.up();
  await expect.poll(async () => (await nativeAnnotations()).filter((item) => !existingIds.includes(item.id)).length).toBe(1);
  const id = (await nativeAnnotations()).find((item) => !existingIds.includes(item.id))!.id;
  await page.getByRole("button", { name: "评论", exact: true }).last().click();
  await page.getByPlaceholder("新增评论...", { exact: true }).fill("Real paper comment");
  await page.getByPlaceholder("新增评论...", { exact: true }).press("Enter");
  await expect.poll(async () => (await nativeAnnotations()).find((item) => item.id === id)?.contents).toBe("Real paper comment");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await expect(page.getByRole("tab", { name: "笔记", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expectPdfRendered();
  await expect.poll(async () => (await nativeAnnotations()).find((item) => item.id === id)?.contents).toBe("Real paper comment");
  await expect(page.locator(".annotation-actions")).toHaveCount(0);
  await page.screenshot({ path: "test-results/native-real-paper-desktop.png" });
  await page.getByRole("button", { name: "收起 Agent", exact: true }).click();
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await page.setViewportSize({ width: 560, height: 780 });
  await expect(page.getByRole("button", { name: "文档引用使用位置", exact: true })).toBeVisible();
  await expectPdfRendered();
  await page.screenshot({ path: "test-results/native-real-paper-narrow.png" });
});

test("原生批注跨页选字产生逐页链接，下划线、重叠、评论编辑和删除保留明确身份", async () => {
  test.setTimeout(120_000);
  const stream = "BT /F1 14 Tf 50 190 Td (First line annotation evidence.) Tj 0 -25 Td (Second line spans native annotations.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 250] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 250] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const source = path.join(sandbox, "cross-page.pdf");
  await fs.writeFile(source, pdf);
  await create(source, path.join(sandbox, "projects"));
  await expectPdfRendered();
  await expectPdfRendered();
  await setPdfZoom("100");
  await page.getByRole("button", { name: "批注", exact: true }).click();
  const images = pdfViewport().locator('img[style*="pointer-events: none"]');
  await expect(images).toHaveCount(2);
  await expect.poll(async () => Math.round((await images.nth(0).boundingBox())!.width)).toBe(600);
  const first = await images.nth(0).boundingBox();
  const second = await images.nth(1).boundingBox();
  await page.getByRole("button", { name: "下划线", exact: true }).first().click();
  await page.mouse.move(first!.x + 60, first!.y + 55);
  await page.mouse.down(); await page.mouse.move(first!.x + 200, first!.y + 55, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await nativeAnnotations()).length).toBe(1);
  const underline = (await nativeAnnotations())[0];
  await page.mouse.click(first!.x + 500, first!.y + 200);
  await page.getByRole("button", { name: "高亮", exact: true }).first().click();
  await page.mouse.move(first!.x + 60, first!.y + 80);
  await page.mouse.down();
  await page.mouse.move(second!.x + 220, second!.y + 80, { steps: 30 });
  await page.mouse.up();
  await expect.poll(async () => (await nativeAnnotations()).length).toBe(3);
  const annotations = (await nativeAnnotations()).filter((item) => item.id !== underline.id);
  expect(annotations.map((a) => a.pageIndex)).toEqual([0, 1]);
  // The SDK's public multi-selection keeps both per-page IDs, without inventing a shared one.
  await page.locator("embedpdf-container").evaluate(async (element, ids) => {
    const registry = await (element as EmbedPdfContainer).registry;
    registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading").setSelection(ids);
  }, annotations.map((a) => a.id));
  await page.getByRole("button", { name: "复制批注链接", exact: true }).first().click();
  await expect(page.getByRole("status")).toContainText("已复制 2 个批注链接");
  const links = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  expect(links.split("\n")).toHaveLength(2);
  expect(links).toContain("PDF 第 1 页批注"); expect(links).toContain("PDF 第 2 页批注");
  await page.locator("embedpdf-container").evaluate(async (element, target) => {
    const registry = await (element as EmbedPdfContainer).registry;
    const api = registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading");
    api.selectAnnotation(target.pageIndex, target.id);
    api.updateAnnotation(target.pageIndex, target.id, { contents: "A durable comment", strokeColor: "#ff0000" });
  }, annotations[0]);
  await page.locator("embedpdf-container").evaluate(async (element, target) => {
    const registry = await (element as EmbedPdfContainer).registry;
    registry.getPlugin<AnnotationPlugin>("annotation")!.provides().forDocument("reading")
      .updateAnnotation(0, target.id, { rect: { ...target.rect, origin: { ...target.rect.origin, y: target.rect.origin.y + 25 } },
        segmentRects: (target as { segmentRects: typeof target.rect[] }).segmentRects.map((rect) => ({ ...rect, origin: { ...rect.origin, y: rect.origin.y + 25 } })) });
  }, underline);
  const root = path.join(sandbox, "projects/研究工程");
  await fs.writeFile(path.join(root, "notes/跨页.md"), links.replaceAll("text/paper.pdf", "../text/paper.pdf"));
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "跨页.md", exact: true }).click();
  await page.locator('.markdown-preview a[href*="#annotation="]').nth(0).click();
  await expect(pdfPage()).toHaveValue("1");
  await expectAnnotationSelected();
  expect((await nativeAnnotations()).find((a) => a.id === annotations[0].id)?.contents).toBe("A durable comment");
  expect((await nativeAnnotations()).find((a) => a.id === annotations[0].id)).toMatchObject({ strokeColor: "#ff0000" });
  await page.getByRole("button", { name: "删除选中的批注", exact: true }).click();
  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await nativeAnnotations()).map((item) => item.id)).toContain(annotations[0].id);
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect.poll(async () => (await nativeAnnotations()).map((item) => item.id)).not.toContain(annotations[0].id);
  await page.getByRole("tab", { name: "跨页.md", exact: true }).click();
  await page.locator('.markdown-preview a[href*="#annotation="]').nth(0).click();
  await expect(page.getByRole("status")).toContainText("找不到目标批注");
  await page.getByRole("tab", { name: "跨页.md", exact: true }).click();
  await page.locator('.markdown-preview a[href*="#annotation="]').nth(1).click();
  // Both short pages fit in the viewport; assert the actual selected page-2 annotation.
  await expectAnnotationSelected(annotations[1].id);
  await page.screenshot({ path: "test-results/native-annotation-cross-page.png" });
});

test("文字多行引用保留原句与多个区域，整页引用不伪装精确高亮", async () => {
  const file = path.join(sandbox, "text-selection.pdf");
  // Independently authored page geometry: two 14pt text lines, baselines y=100/130 from top.
  const content = "BT /F1 14 Tf 50 700 Td (Citation alpha [one] \\(two\\).) Tj 0 -30 Td (Second line evidence.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await fs.writeFile(file, pdf);
  await create(file, path.join(sandbox, "projects"));
  await expectPdfRendered();
  await setPdfZoom("100");
  await page.getByRole("button", { name: "光标模式", exact: true }).click();
  const image = await pdfImage().boundingBox();
  await page.mouse.move(image!.x + 50, image!.y + 95);
  await page.mouse.down();
  await page.mouse.move(image!.x + 190, image!.y + 125, { steps: 15 });
  await page.mouse.up();
  await page.screenshot({ path: "test-results/citation-text-selection.png" });
  await page.mouse.click(image!.x + 90, image!.y + 95, { button: "right" });
  await page.getByRole("menuitem", { name: "复制引用链接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制引用链接");
  const markdown = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  expect(markdown).toMatch(/^\[Citation alpha \\\[one\\\] \\\(two…\]\(paper:\/\/cite\/[a-f0-9]{32}\)$/);
  const root = path.join(sandbox, "projects/研究工程");
  const dictionary = JSON.parse(await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8"));
  const citation: any = Object.values(dictionary.citations)[0];
  expect(citation.kind).toBe("text");
  expect(citation.pages[0].rects.length).toBeGreaterThanOrEqual(2);
  expect(citation.text).toContain("Second line evidence.");
  await page.getByRole("button", { name: "引用", exact: true }).click();
  await page.getByRole("button", { name: "整页引用", exact: true }).click();
  await page.getByRole("button", { name: "复制引用链接", exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).not.toBe(markdown);
  const pageLink = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  await fs.writeFile(path.join(root, "notes/原句.md"), markdown + "\n\n" + pageLink);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "原句.md", exact: true }).click();
  await expect(page.getByRole("link", { name: "Citation alpha [one] (two…", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "PDF 第 1 页", exact: true }).click();
  await expectPdfRendered();
  await expect(page.locator('[data-citation-page]')).toHaveCount(0);
});

test("引用字典并发新增、跨页区域、搬迁改名与明确失效", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  let root = path.join(parent, "研究工程");
  const manifest = await readManifest(root);
  const input = { sha256: manifest.paper.sha256, kind: "text" as const, text: "中文 [括号] (测试) *内容*",
    pages: [1, 2].map((p) => ({ page: p, width: 612, height: 792, rects: [
      { origin: { x: 50, y: 60 }, size: { width: 180, height: 12 } },
      { origin: { x: 50, y: 80 }, size: { width: 95, height: 12 } },
    ] })) };
  const created = await page.evaluate(async ({ root, input }) => Promise.all(Array.from({ length: 12 }, (_, i) =>
    window.desktop.invoke<any>({ type: "createCitation", root, path: "text/paper.pdf", input: { ...input, text: input.text + Math.floor(i / 2) } }))), { root, input });
  expect(new Set(created.map((c) => c.id)).size).toBe(6);
  expect(created[0].id).toBe(created[1].id);
  const dictionaryPath = () => path.join(root, ".paper30min-citations.json");
  expect(Object.keys(JSON.parse(await fs.readFile(dictionaryPath(), "utf8")).citations)).toHaveLength(6);
  const reuse = await page.evaluate(async ({ root, input }) => {
    const create = (value: typeof input | { sha256: string; kind: "region" | "page"; text: string; pages: typeof input.pages }) =>
      window.desktop.invoke<any>({ type: "createCitation", root, path: "text/paper.pdf", input: value });
    const region = { ...input, kind: "region" as const, text: "", pages: [input.pages[0]] };
    const first = await create(region);
    const repeated = await create(region);
    const adjusted = structuredClone(region);
    adjusted.pages[0].rects[0].origin.x += 0.001;
    const different = await create(adjusted);
    const wholePage = { ...region, kind: "page" as const, pages: [{ ...input.pages[0], rects: [] }] };
    const whole = await create(wholePage);
    const wholeRepeated = await create(wholePage);
    const otherPage = await create({ ...wholePage, pages: [{ ...wholePage.pages[0], page: 2 }] });
    return { first, repeated, different, whole, wholeRepeated, otherPage };
  }, { root, input });
  expect(reuse.first.id).toBe(reuse.repeated.id);
  expect(reuse.different.id).not.toBe(reuse.first.id);
  expect(reuse.whole.id).toBe(reuse.wholeRepeated.id);
  expect(reuse.otherPage.id).not.toBe(reuse.whole.id);
  const original = await fs.readFile(dictionaryPath(), "utf8");
  expect(Object.keys(JSON.parse(original).citations)).toHaveLength(10);
  const link = `paper://cite/${created[0].id}`;
  const resolve = () => page.evaluate(({ root, link }) => window.desktop.invoke<any>({ type: "resolveCitation", root, link }), { root, link });
  expect((await resolve()).citation.pages).toEqual(input.pages);
  await page.evaluate(({ root }) => window.desktop.invoke({ type: "move", root, path: "text/paper.pdf", destination: "text/改名.pdf" }), { root });
  expect((await resolve()).path).toBe("text/改名.pdf");
  await fs.rename(path.join(root, "text/改名.pdf"), path.join(root, "text/外部移动.pdf"));
  await expect(resolve()).rejects.toThrow("缺失");
  await page.evaluate(({ root, id }) => window.desktop.invoke({ type: "relink", root, id, source: root + "/text/外部移动.pdf" }), { root, id: manifest.paper.id });
  expect((await resolve()).path).toBe("text/外部移动.pdf");
  await desktop.close();
  const moved = path.join(parent, "已搬迁");
  await fs.rename(root, moved);
  root = moved;
  // A crashed staging write is not a published dictionary.
  await fs.writeFile(path.join(root, ".paper30min-interrupted.tmp"), "{broken");
  await launch();
  expect((await resolve()).citation.id).toBe(created[0].id);
  const repeatAfterRestart = () => page.evaluate(({ root, input }) =>
    window.desktop.invoke<any>({ type: "createCitation", root, path: "text/外部移动.pdf", input: { ...input, text: input.text + "0" } }), { root, input });
  expect((await repeatAfterRestart()).id).toBe(created[0].id);
  expect(await fs.readFile(dictionaryPath(), "utf8")).toBe(original);
  await fs.appendFile(path.join(root, "text/外部移动.pdf"), "\nchanged");
  await expect(repeatAfterRestart()).rejects.toThrow("替换");
  expect((await resolve()).citation.id).toBe(created[0].id);
  await expect(page.evaluate(({ root }) => window.desktop.invoke({ type: "resolveCitation", root, link: "paper://cite/" + "0".repeat(32) }), { root })).rejects.toThrow("找不到此引用");
  expect(await fs.readFile(dictionaryPath(), "utf8")).toBe(original);
  await fs.writeFile(dictionaryPath(), "{broken");
  await expect(page.evaluate(({ root, input }) => window.desktop.invoke({ type: "createCitation", root, path: "text/外部移动.pdf", input }), { root, input })).rejects.toThrow();
  expect(await fs.readFile(dictionaryPath(), "utf8")).toBe("{broken");
});

test("PDF 无痕引用侧边反查、临时定位、外部更新与重开", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await expectPdfRendered();
  const manifest = await readManifest(root);
  const pdfBefore = await fs.readFile(path.join(root, "text/paper.pdf"));
  const input = { sha256: manifest.paper.sha256, kind: "text" as const, text: "两行跨页证据",
    pages: [1, 2].map((page) => ({ page, width: 612, height: 792, rects: [
      { origin: { x: 50, y: 160 }, size: { width: 180, height: 12 } },
      { origin: { x: 50, y: 180 }, size: { width: 100, height: 12 } },
    ] })) };
  const citations = await page.evaluate(async ({ root, input }) => {
    const make = (value: typeof input | { sha256: string; kind: "page" | "region"; text: string; pages: typeof input.pages }) =>
      window.desktop.invoke<any>({ type: "createCitation", root, path: "text/paper.pdf", input: value });
    return [await make(input), await make({ ...input, kind: "region", text: "", pages: [input.pages[0]] }),
      await make({ ...input, kind: "page", text: "", pages: [{ ...input.pages[0], rects: [] }] })];
  }, { root, input });
  const [textCitation, regionCitation, unused] = citations;
  const link = `paper://cite/${textCitation.id}`;
  const regionLink = `paper://cite/${regionCitation.id}`;
  const unusedLink = `paper://cite/${unused.id}`;
  const uses = () => page.evaluate(({ root }) => window.desktop.invoke<{ citations: any[] }>({ type: "pdfUses", root, path: "text/paper.pdf" }).then((result) => result.citations), { root });
  await fs.mkdir(path.join(root, ".pi/sessions"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi/sessions/chat.jsonl"), JSON.stringify({ role: "user", content: unusedLink }));
  await fs.writeFile(path.join(root, "text/parsed.md"), Array(100).fill(`[解析预建](${unusedLink})`).join("\n"));
  await fs.writeFile(path.join(root, "notes/示例.md"), `代码 \`[不是使用](${unusedLink})\`\n\n\`\`\`md\n[也不是](${unusedLink})\n\`\`\`\n`);
  expect(await uses()).toEqual([]);
  await expect(page.locator("[data-citation-uses-page]")).toHaveCount(0);
  const noteA = `# 第一篇\n\n${"填充段落。\n\n".repeat(35)}第一处 [证据](${link})\n\n第二处 [证据](${link})\n`;
  await fs.writeFile(path.join(root, "notes/甲.md"), noteA);
  await fs.writeFile(path.join(root, "notes/乙.md"), `# 第二篇\n\n[证据](${link}) 和 [重叠区域](${regionLink})\n`);
  await expect.poll(async () => (await uses()).map((item) => item.uses.length).sort()).toEqual([1, 3]);
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  const list = page.getByRole("complementary", { name: "文档引用使用位置" });
  const useButtons = list.locator("section > button:not(.citation-source)");
  await expect(useButtons).toHaveCount(4);
  await expect(list).toContainText("第一篇");
  await expect(list).toContainText("第二篇");
  await expect(page.locator("[data-document-citation], [data-citation-uses-page]")).toHaveCount(0);
  await list.getByRole("button", { name: /文字引用/ }).click();
  await expect(page.locator("[data-citation-page]")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await pdfViewport().click({ position: { x: 40, y: 300 } });
  await expect(page.locator("[data-citation-page]")).toHaveCount(4);
  await expect(page.locator(".citation-return, .annotation-actions")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "已定位" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/citation-uses.png" });
  const position = await pdfViewport().evaluate((e) => e.scrollTop);
  await list.getByRole("button").filter({ hasText: "第二处" }).click();
  await expect(page.locator(".citation-use-target")).toHaveAttribute("data-citation-use", `${textCitation.id}:1`);
  await expect(page.locator(".citation-use-target")).toBeInViewport();
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expect(page.locator("[data-citation-page]")).toHaveCount(0);
  await expectPdfRendered();
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBeCloseTo(position, 0);
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  await fs.copyFile(path.join(root, "notes/甲.md"), path.join(root, "notes/复制.md"));
  await expect(list.locator("section > button:not(.citation-source)")).toHaveCount(6);
  await fs.unlink(path.join(root, "notes/复制.md"));
  await expect(list.locator("section > button:not(.citation-source)")).toHaveCount(4);
  await list.getByRole("button").filter({ hasText: "第二处" }).click();
  await page.getByRole("tab", { name: "paper.pdf" }).click();
  await jumpPdfPage(2);
  await page.getByRole("tab", { name: "甲.md", exact: true }).click();
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expectPdfRendered();
  await expect(pdfPage()).toHaveValue("2");
  await expect(page.locator("[data-citation-page]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "文档引用使用位置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  await expect(list.locator("section > button:not(.citation-source)")).toHaveCount(4);
  await fs.rename(path.join(root, "notes/甲.md"), path.join(root, "map/移动.md"));
  await expect(list).toContainText("map/移动.md");
  await fs.writeFile(path.join(root, "notes/乙.md"), "# 第二篇\n\n删除所有引用\n");
  await expect(list.locator("section > button:not(.citation-source)")).toHaveCount(2);
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expectPdfRendered();
  await expect(page.getByRole("button", { name: "文档引用使用位置", exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, "map/移动.md"), "# 无引用\n");
  await expect(page.locator("[data-citation-uses-page]")).toHaveCount(0);
  expect(await uses()).toEqual([]);
  expect(Object.keys(JSON.parse(await fs.readFile(path.join(root, ".paper30min-citations.json"), "utf8")).citations)).toHaveLength(3);
  expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(pdfBefore);
});

test("文档反查读取自动保存结果，整页引用与失效字典明确处理", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const manifest = await readManifest(root);
  const citation = await page.evaluate(({ root, sha256 }) => window.desktop.invoke<any>({
    type: "createCitation", root, path: "text/paper.pdf", input: { sha256, kind: "page", text: "",
      pages: [{ page: 1, width: 612, height: 792, rects: [] }] },
  }), { root, sha256: manifest.paper.sha256 });
  const link = `paper://cite/${citation.id}`;
  await fs.writeFile(path.join(root, "notes/稿.md"), `\uFEFF# 我的文档\r\n\r\n[页证据][ref]\r\n\r\n[ref]: ${link}\r\n`);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "稿.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("AUTOSAVED");
  await expect.poll(() => fs.readFile(path.join(root, "notes/稿.md"), "utf8")).toContain("AUTOSAVED");
  await page.getByRole("tab", { name: "paper.pdf" }).click();
  await expectPdfRendered();
  await expect(page.locator("[data-document-citation]")).toHaveCount(0);
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  const list = page.getByRole("complementary", { name: "文档引用使用位置" });
  await expect(list).toContainText("整页引用");
  await list.getByRole("button").filter({ hasText: "我的文档" }).click();
  await expect(page.locator(".citation-use-target")).toHaveText("页证据");
  await expect(page.locator(".markdown-preview")).toContainText("AUTOSAVED");

  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  await list.getByRole("button").filter({ hasText: "我的文档" }).click();
  await expect(page.locator(".citation-use-target")).toHaveText("页证据");
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expect(page.locator("[data-citation-uses-page]")).toHaveCount(0);
  await page.getByRole("button", { name: "文档引用使用位置", exact: true }).click();
  await expect(list.locator("section")).toHaveCount(1);
  const dictionary = path.join(root, ".paper30min-citations.json");
  const original = await fs.readFile(dictionary, "utf8");
  await fs.writeFile(dictionary, "{broken");
  await expect(page.getByRole("alert")).toContainText("文档引用加载失败");
  await expect(page.locator("[data-citation-uses-page]")).toHaveCount(0);
  await expect(list.locator("section")).toHaveCount(0);
  await fs.writeFile(dictionary, original);
  await expect(list.locator("section")).toHaveCount(1);
  await expect(page.locator("[data-citation-uses-page]")).toHaveCount(0);
  await fs.appendFile(path.join(root, "text/paper.pdf"), "\nchanged");
  await expect(page.getByRole("alert").filter({ hasText: "已重新载入" })).toBeVisible();
  await expect(list.locator("section")).toHaveCount(1);
  await expect(page.locator("[data-citation-uses-page]")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "文档引用加载失败" })).toHaveCount(0);
});

test("Markdown 三种视图、真实文件保真、图片公式与多标签草稿", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const original =
    "\uFEFF---\r\ntitle: 测试\r\n---\n<!-- 保留注释 -->\r\n\r\n# 原始笔记\r\n\r\n公式 $x^2$。\r\n\r\n![图片](../text/图(1).svg)\r\n\r\n[另一篇](另一篇(1).md)\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n末尾空格  \r\n下一行\n";
  await fs.writeFile(path.join(root, "notes/原始.md"), original);
  await fs.writeFile(path.join(root, "notes/另一篇(1).md"), "# 另一篇\n");
  await fs.writeFile(
    path.join(root, "text/图(1).svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="purple"/></svg>',
  );
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "原始.md", exact: true }).click();
  await expect(page.locator(".markdown-preview .katex")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "图片", exact: true })
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBe(100);
  await page.getByRole("link", { name: "另一篇", exact: true }).click();
  await expect(page.getByRole("tab", { name: "另一篇(1).md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "原始.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+Home");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("End");
  await editor.press("Delete");
  await editor.press("Control+z");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await editor.press("Control+End");
  await editor.pressSequentially("用户补充");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator(".markdown-preview")).toContainText("用户补充");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(editor).toContainText("用户补充");
  await page.getByRole("tab", { name: "另一篇(1).md" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await editor.press("Control+End");
  await editor.pressSequentially("独立草稿");
  await page.getByRole("tab", { name: /原始.md/ }).click();
  await expect(editor).toContainText("用户补充");

  await expect
    .poll(() => fs.readFile(path.join(root, "notes/原始.md"), "utf8"))
    .toBe(original + "用户补充");
  await page.getByRole("tab", { name: /另一篇/ }).click();

  await expect
    .poll(() => fs.readFile(path.join(root, "notes/另一篇(1).md"), "utf8"))
    .toBe("# 另一篇\n独立草稿");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await page.getByRole("tab", { name: /原始.md/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码", exact: true }),
  ).toContainText("用户补充");
});

test("Markdown 外部变更自动同步，冲突与文件消失保留用户输入", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByLabel("笔记名称").fill("协作.md");
  await page.getByRole("button", { name: "创建笔记", exact: true }).click();
  const note = path.join(root, "notes/协作.md");
  await fs.writeFile(note, "# Agent 首次写入\n");
  await expect(page.locator(".markdown-preview")).toContainText(
    "Agent 首次写入",
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+End");
  await editor.pressSequentially("用户未保存内容");
  await fs.writeFile(note, "# Agent 再次修改\n");
  await expect(
    page.getByText("文档已在外部修改。你的编辑已保留，尚未覆盖磁盘文件。"),
  ).toBeVisible();
  await expect(editor).toContainText("用户未保存内容");
  await page.getByRole("button", { name: "查看双方内容", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "当前磁盘内容", exact: true }),
  ).toHaveValue("# Agent 再次修改\n");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await fs.writeFile(note, "# 第三次外部更新\n");
  await expect(
    page.getByRole("textbox", { name: "当前磁盘内容", exact: true }),
  ).toHaveValue("# 第三次外部更新\n");
  await fs.rename(note, path.join(root, "notes/外部改名.md"));
  await page.getByRole("button", { name: "工程文件", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "外部改名.md", exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("用户未保存内容");
  await expect(page.getByRole("alert").first()).toContainText(
    "文件已被删除或移动",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭 协作.md", exact: true }).click();
  await expect(editor).toBeVisible();
  // Clear the draft through the explicit discard confirmation for test shutdown.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭 协作.md", exact: true }).click();
});

test("Markdown 组合输入、撤销与保存失败不破坏原文件", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const note = path.join(root, "notes/输入.md");
  await fs.writeFile(note, "# 中文输入\r\n原文\r\n");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "输入.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "中文组合",
    selectionStart: 4,
    selectionEnd: 4,
  });
  await page.waitForTimeout(800);
  expect(await fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
  await cdp.send("Input.insertText", { text: "中文组合" });
  await expect(editor).toContainText("中文组合");
  await expect.poll(() => fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n中文组合");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await page.screenshot({ path: "test-results/markdown-split.png" });
  await editor.press("Control+z");
  await expect(editor).not.toContainText("中文组合");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await editor.press("Control+End");
  await expect.poll(() => fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
  await fs.chmod(note, 0o444);
  await editor.pressSequentially("恢复输入");
  try {

    await expect(page.getByRole("alert")).toContainText("保存失败");
    expect(await fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
    await expect(editor).toContainText("恢复输入");
  } finally {
    await fs.chmod(note, 0o666);
  }

  await page.getByRole("button", { name: "重试自动保存", exact: true }).click();
  await expect
    .poll(() => fs.readFile(note, "utf8"))
    .toBe("# 中文输入\r\n原文\r\n恢复输入");
  await cdp.detach();
});

test("Markdown 长文视图往返和两个工程的同路径位置独立", async () => {
  const parent = path.join(sandbox, "projects");
  const longNote = Array.from(
    { length: 100 },
    (_, i) => "## 第 " + i + " 段\n\n正文段落\n\n",
  ).join("");
  await create(fixture, parent, "工程甲");
  const a = path.join(parent, "工程甲");
  await fs.writeFile(path.join(a, "notes/同名.md"), longNote);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "同名.md", exact: true }).click();
  const previewPane = page.locator(".markdown-preview");
  await previewPane.hover();
  await page.mouse.wheel(0, 650);
  await expect
    .poll(() => previewPane.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(400);
  const scroll = await previewPane.evaluate((e) => e.scrollTop);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect
    .poll(() => previewPane.evaluate((e) => e.scrollTop))
    .toBe(scroll);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await create(fixture, undefined, "工程乙");
  const b = path.join(parent, "工程乙");
  await fs.writeFile(path.join(b, "notes/同名.md"), longNote);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "同名.md", exact: true }).click();
  await expect(previewPane).toBeVisible();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /工程甲/ }).click();
  await expect
    .poll(() => previewPane.evaluate((e) => e.scrollTop))
    .toBe(scroll);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /工程乙/ }).click();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(0);
});
