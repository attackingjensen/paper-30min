import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir:
    process.env.PAPER30MIN_REAL_MODEL === "1"
      ? "test-results/real-model"
      : "test-results",
  use: {
    trace:
      process.env.PAPER30MIN_REAL_MODEL === "1" ? "off" : "retain-on-failure",
  },
});
