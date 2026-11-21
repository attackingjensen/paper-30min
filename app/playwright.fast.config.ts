import { defineConfig } from "@playwright/test";
import baseConfig, { testOutputRoot } from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testIgnore: [/.*-electron\.spec\.ts$/, /.*desktop\.spec\.ts$/],
  workers: 4,
  reporter: [["list"], ["json", { outputFile: `${testOutputRoot}/timing/non-electron.json` }]],
  outputDir: `${testOutputRoot}/non-electron`,
});
