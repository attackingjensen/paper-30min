import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export let sandbox: string;
export let desktop: ElectronApplication;
export let desktopProcess: ReturnType<ElectronApplication["process"]>;
export let page: Page;
let errors: string[];
export const fixture = path.resolve("tests/fixtures/sample_paper.pdf");

// Playwright pierces the complete viewer's open shadow root through its public UI.
export const pdfViewport = () => page.locator('.pdf-reader .bg-bg-app[style*="overflow: auto"]');
export const pdfImage = () => pdfViewport().locator('img[style*="pointer-events: none"]').first();
export const pdfPages = () => page.locator('[data-overlay-id="page-controls"]');
export const pdfPage = () => pdfPages().locator("input");
export const pdfZoom = () => page.getByRole("textbox", { name: "Set zoom", exact: true });

export async function setPdfZoom(percent: string) {
  await pdfZoom().fill(percent);
  await pdfZoom().press("Enter");
  await expect(pdfZoom()).toHaveValue(percent);
}

export async function jumpPdfPage(number: number) {
  await pdfPages().hover();
  await pdfPage().fill(String(number));
  await pdfPage().press("Enter");
  await expect(pdfPage()).toHaveValue(String(number));
  await expect
    .poll(async () => {
      const before = await pdfViewport().evaluate((e) => e.scrollTop);
      await page.waitForTimeout(100);
      return Math.abs(before - (await pdfViewport().evaluate((e) => e.scrollTop)));
    })
    .toBe(0);
  await expect(pdfPage()).toHaveValue(String(number));
}

export async function expectPdfRendered() {
  await expect(pdfImage()).toBeVisible();
  await expect.poll(() => pdfImage().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
}

export async function launch() {
  const visible = process.env.PAPER30MIN_TEST_WINDOW === "visible";
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
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
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
    // Keep browser input/clipboard APIs active without taking native desktop focus.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect
      .poll(
        async () => {
          const actual = await page.evaluate(() => [innerWidth, innerHeight]);
          if (actual[0] !== 1440 || actual[1] !== 960) {
            // Windows offscreen sizing can include the outer frame. Re-read after each
            // native resize instead of locking the viewport or weakening the assertion.
            await desktop.evaluate(
              ({ BrowserWindow }, expected) => {
                const window = BrowserWindow.getAllWindows()[0];
                const [width, height] = window.getContentSize();
                window.setContentSize(
                  width + expected.width - expected.actual[0],
                  height + expected.height - expected.actual[1],
                );
              },
              { width: 1440, height: 960, actual },
            );
          }
          return actual;
        },
        { timeout: 15000 },
      )
      .toEqual([1440, 960]);
  }
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
  expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(visible);
}

export async function choose(selected: string | null) {
  // Only the operating-system chooser is substituted; the production preload, IPC,
  // Node utility process and disk operations run unchanged.
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: file === null,
      filePaths: file ? [file] : [],
    });
  }, selected);
}

export async function preview(source: string, parent?: string, name = "研究工程") {
  await choose(source);
  await page.getByRole("button", { name: "从 PDF 新建工程", exact: true }).click();
  await page.getByLabel("工程名称", { exact: true }).fill(name);
  if (parent) {
    await choose(parent);
    await page.getByRole("button", { name: "选择位置", exact: true }).click();
  }
}

export async function create(source: string, parent?: string, name = "研究工程") {
  await preview(source, parent, name);
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
}

export async function readManifest(root: string) {
  return JSON.parse(await fs.readFile(path.join(root, "paper30min.json"), "utf8"));
}

export async function closeDesktopForCleanup() {
  if (!desktopProcess || desktopProcess.exitCode !== null || desktopProcess.signalCode !== null) return;
  // Only teardown discards disposable drafts; normal close protection stays active.
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxSyncOptions;
      if (options.message !== "有未保存的文档，确定放弃编辑并关闭吗？" || options.buttons?.[1] !== "放弃并关闭")
        throw new Error("测试清理遇到非预期的原生确认框。");
      return 1;
    };
  });
  await desktop.close();
}

export function registerDesktopFixture() {
  test.beforeEach(async () => {
    errors = [];
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-desktop-"));
    await fs.mkdir(path.join(sandbox, "projects"));
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
}
