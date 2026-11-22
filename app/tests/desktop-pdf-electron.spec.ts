import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  sandbox,
  desktop,
  page,
  fixture,
  pdfViewport,
  pdfImage,
  pdfPages,
  pdfPage,
  pdfZoom,
  setPdfZoom,
  jumpPdfPage,
  expectPdfRendered,
  create,
  launch,
  registerDesktopFixture,
} from "./desktop-fixture";

registerDesktopFixture();

test("PDF 滚动与页码导航在笔记切换后保持位置", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await expect(pdfPages()).toContainText("2");
  await expectPdfRendered();
  await setPdfZoom("100");
  for (const offset of [300, 620]) {
    await pdfViewport().evaluate((e, y) => {
      e.scrollTop = y;
    }, offset);
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf[
            "text/paper.pdf"
          ]?.y;
        } catch (error) {
          // 首次滚动持久化前状态文件可能尚未创建；仅该情况继续等待。
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      })
      .toBe(offset);
    await page.getByRole("button", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
    await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBe(offset);
  }
  await jumpPdfPage(1);
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBeLessThan(20);
  await jumpPdfPage(2);
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBeGreaterThan(700);
});

test("PDF 光标选区复制与区域截取使用统一选中色", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  await expectPdfRendered();
  const pdfColors = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      probe.style.color = "";
      return value;
    };
    const colors = { text: resolve("--text"), accent: resolve("--accent") };
    probe.remove();
    return colors;
  });
  const cursorMode = page.getByRole("button", { name: "光标模式", exact: true });
  const cursorSelected = await cursorMode.evaluate((element) => element.classList.contains("bg-interactive-selected"));
  await expect(cursorMode).toHaveCSS("color", cursorSelected ? pdfColors.accent : pdfColors.text);
  await expect(page.getByRole("button", { name: "批注", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "高亮", exact: true })).toHaveCount(0);
  await setPdfZoom("100");
  await page.screenshot({ path: "test-results/pdf-desktop.png" });
  await cursorMode.click();
  await expect(cursorMode).toHaveCSS("color", pdfColors.accent);
  const bounds = (await pdfImage().boundingBox())!;
  await page.mouse.move(bounds.x + 75, bounds.y + 48);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 290, bounds.y + 48, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  const selectionRect = page.locator('[style*="mix-blend-mode: multiply"][style*="isolation: isolate"] > div').first();
  await expect(selectionRect).toBeVisible();
  const expectedSelection = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "color-mix(in srgb, var(--accent) 28%, transparent)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await expect(selectionRect).toHaveCSS("background-color", expectedSelection);
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toContain("SampleNet");
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
  await expect.poll(() => region.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThanOrEqual(218);
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test("PDF 缩放、关闭重开与重启恢复阅读位置", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const originalPdf = await fs.readFile(path.join(root, "text/paper.pdf"));
  await expectPdfRendered();
  await jumpPdfPage(2);
  await setPdfZoom("150");
  await expect(pdfPage()).toHaveValue("2");
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf["text/paper.pdf"]?.zoom,
    )
    .toBe(1.5);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
  await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
  expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(originalPdf);
});
