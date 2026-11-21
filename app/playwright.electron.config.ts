import { defineConfig } from "@playwright/test";
import baseConfig, { testOutputRoot } from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: [/.*-electron\.spec\.ts$/, /.*desktop\.spec\.ts$/],
  workers: 1,
  reporter: [["list"], ["json", { outputFile: `${testOutputRoot}/timing/electron.json` }], ["html", { open: "never" }]],
  outputDir: `${testOutputRoot}/electron`,
});
