import { expect, type Page } from "@playwright/test";

/** 启动后首屏断言：离屏/慢 runner 上渲染首帧可能迟到，统一放宽到 30s。 */
export async function expectAppReady(page: Page) {
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
}