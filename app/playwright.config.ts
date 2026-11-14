import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir:
    process.env.PAPER30MIN_REAL_MODEL === "1" ||
    process.env.PAPER30MIN_REAL_PARSING_CONFIG ||
    process.env.PAPER30MIN_REAL_PARSING_TOKEN ||
    process.env.PAPER30MIN_REAL_PARSING_PROJECT
      ? "test-results/real-model"
      : "test-results",
  use: {
    trace:
      process.env.PAPER30MIN_REAL_MODEL === "1" ||
      process.env.PAPER30MIN_REAL_PARSING_CONFIG ||
      process.env.PAPER30MIN_REAL_PARSING_TOKEN ||
      process.env.PAPER30MIN_REAL_PARSING_PROJECT
        ? "off"
        : "retain-on-failure",
  },
});
