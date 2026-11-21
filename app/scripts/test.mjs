#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const args = process.argv.slice(2);

for (const config of ["playwright.fast.config.ts", "playwright.electron.config.ts"]) {
  const result = spawnSync(
    process.execPath,
    [cli, "test", `--config=${config}`, ...args],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 2);
}
