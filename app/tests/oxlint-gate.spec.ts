import { test, expect } from "@playwright/test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GATE = path.resolve("scripts/check-lint.mjs");
const CONFIG = path.resolve("../.oxlintrc.json");

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-oxlint-gate-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function writeFixtures(fixtures: Record<string, string>) {
  for (const [name, content] of Object.entries(fixtures)) {
    const target = path.join(sandbox, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

async function useProjectConfig() {
  const config = path.join(sandbox, ".oxlintrc.json");
  await fs.copyFile(CONFIG, config);
  return config;
}

function runGate(config: string, target = sandbox, typeAware = false) {
  const args = [GATE, "--config", config, "--target", target];
  if (typeAware) args.push("--type-aware");
  return spawnSync(process.execPath, args, { cwd: sandbox, encoding: "utf8" });
}

function diagnostics(result: SpawnSyncReturns<string>) {
  return result.stderr.trim().split(/\r?\n/).filter(Boolean);
}

test("Oxlint correctness 与 Hooks 阳性样本阻断", async () => {
  const config = await useProjectConfig();
  await writeFixtures({
    "app/src/renderer/invalid-hook.tsx": `import { useState } from "react";
const unused = 1;
export function Bad({ flag }: { flag: boolean }) {
  if (flag) useState(0);
  return null;
}
`,
  });

  const result = runGate(config);
  const lines = diagnostics(result);
  expect(result.status).toBe(1);
  expect(lines.some((line) => line.includes("eslint(no-unused-vars)"))).toBe(true);
  expect(lines.some((line) => line.includes("react-hooks(rules-of-hooks)"))).toBe(true);
});

test("Oxlint 空扫描按检查不可用阻断", async () => {
  const config = await useProjectConfig();
  const empty = path.join(sandbox, "empty");
  await fs.mkdir(empty);
  const result = runGate(config, empty);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("No files found to lint");
});

test("Oxlint 无效配置按检查不可用阻断", async () => {
  const config = path.join(sandbox, "invalid.json");
  await fs.writeFile(config, "{\n", "utf8");
  const result = runGate(config);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Failed to parse oxlint configuration file");
});

test("Oxlint floating Promise 阳性样本阻断且 void 显式忽略通过", async () => {
  const config = await useProjectConfig();
  await writeFixtures({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
      },
      include: ["app/src"],
    }),
    "app/src/floating.ts": 'export async function load() {\n  Promise.resolve("value");\n}\n',
    "app/src/clean.ts": 'export function load() {\n  void Promise.resolve("value");\n}\n',
  });

  const result = runGate(config, sandbox, true);
  const lines = diagnostics(result);
  expect(result.status).toBe(1);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("app/src/floating.ts");
  expect(lines[0]).toContain("typescript(no-floating-promises)");
});
