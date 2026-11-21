import { defineConfig } from "@playwright/test";

export const testOutputRoot = process.env.PAPER30MIN_REAL_MODEL === "1" ? "test-results/real-model" : "test-results";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: `${testOutputRoot}/timing/full.json` }]],
  outputDir: testOutputRoot,
  use: {
    trace: process.env.PAPER30MIN_REAL_MODEL === "1" ? "off" : "retain-on-failure",
  },
});
