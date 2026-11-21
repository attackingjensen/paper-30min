import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHECK = path.resolve("scripts/check-architecture.mjs");
const CONFIG = path.resolve(".dependency-cruiser.cjs");

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-architecture-gate-"));
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

// 在隔离 app 根内运行真实 check-architecture.mjs：复制生产脚本与 11 条规则配置，
// node_modules junction 指向真实依赖；报告路径与退出语义与生产一致。
async function runArchitectureGate() {
  const appRoot = path.join(sandbox, "app");
  await fs.mkdir(path.join(appRoot, "scripts"), { recursive: true });
  await fs.copyFile(CHECK, path.join(appRoot, "scripts", "check-architecture.mjs"));
  await fs.copyFile(path.resolve("scripts/quality-gate.mjs"), path.join(appRoot, "scripts", "quality-gate.mjs"));
  await fs.copyFile(CONFIG, path.join(appRoot, ".dependency-cruiser.cjs"));
  await fs.symlink(path.resolve("node_modules"), path.join(appRoot, "node_modules"), "junction");
  return spawnSync(process.execPath, [path.join(appRoot, "scripts", "check-architecture.mjs")], {
    cwd: appRoot,
    encoding: "utf8",
  });
}

test("架构 11 条边界逐条阻断：type-only、动态 import、点段路径与 preload 特例均按解析路径判定", async () => {
  await writeFixtures({
    "app/src/renderer/invalid-main.ts": 'import type { MainThing } from "../main/main.js";\nexport type RendererThing = MainThing;\n',
    "app/src/renderer/nested/deep/invalid-main.ts": 'import { main } from "../../../main/main.js";\nexport const value = main;\n',
    "app/src/renderer/invalid-dot-segment.ts": 'import { main } from "../renderer/../main/main.js";\nexport const value = main;\n',
    "app/src/renderer/invalid-dynamic.ts": 'export const load = () => import("../main/main.js");\n',
    "app/src/renderer/invalid-node.ts": 'import fs from "node:fs";\nexport const value = fs;\n',
    "app/src/renderer/invalid-electron.ts": 'import { app } from "electron";\nexport const value = app;\n',
    "app/src/main/main.ts": 'export const main = 1;\n',
    "app/src/main/invalid-renderer.ts": 'import { view } from "../renderer/view.js";\nexport const value = view;\n',
    "app/src/main/invalid-preload.ts": 'import "./preload.cts";\n',
    "app/src/main/invalid-preload-dot-segment.ts": 'import "./sub/../preload.cts";\n',
    "app/src/main/sub/placeholder.ts": 'export const placeholder = 1;\n',
    "app/src/main/preload.cts": 'import path from "node:path";\nimport { worker } from "./worker.js";\nimport { workerAgain } from "../main/worker.js";\nimport { view } from "../renderer/view.js";\nexport const value = [path, worker, workerAgain, view];\n',
    "app/src/main/worker.ts": 'export const worker = 1;\n',
    "app/src/main/document/invalid-source.ts": 'import { snapshot } from "../pdf/snapshot.js";\nexport const value = snapshot;\n',
    "app/src/main/pdf/snapshot.ts": 'export const snapshot = 1;\n',
    "app/src/shared/invalid-process.ts": 'import { main } from "../main/main.js";\nexport const value = main;\n',
    "app/src/shared/invalid-node.ts": 'import path from "path";\nexport const value = path;\n',
    "app/src/shared/invalid-electron.ts": 'import type { BrowserWindow } from "electron";\nexport type WindowType = BrowserWindow;\n',
    "app/src/renderer/view.ts": 'export const view = 1;\n',
  });

  const result = await runArchitectureGate();
  expect(result.status).toBe(1);
  for (const rule of [
    "renderer-cannot-import-main",
    "main-cannot-import-renderer",
    "shared-cannot-import-process-code",
    "renderer-cannot-use-privileged-runtime",
    "renderer-cannot-import-electron",
    "shared-cannot-use-privileged-runtime",
    "shared-cannot-import-electron",
    "preload-cannot-import-main-implementation",
    "preload-cannot-use-node",
    "main-cannot-import-preload-bundle",
    "document-cannot-import-source-modules",
  ]) {
    expect(result.stderr).toContain(rule);
  }
});

test("架构干净样本零违规：shared 内同名目录、preload 合法导入与 src 根 preload 不误报", async () => {
  await writeFixtures({
    "app/src/preload.cts": 'export const rootPreload = 1;\n',
    "app/src/renderer/clean.ts": 'import type { Contract } from "../shared/contracts.js";\nimport { helper } from "../shared/main/utils.js";\nexport const value = [helper] as Contract[];\n',
    "app/src/main/clean.ts": 'import { contract } from "../shared/contracts.js";\nimport { view } from "../shared/renderer/view.js";\nimport { rootPreload } from "../preload.cts";\nexport const value = [contract, view, rootPreload];\n',
    "app/src/main/preload.cts": 'import { contextBridge } from "electron";\nimport { contract } from "../shared/contracts.js";\nexport const value = [contextBridge, contract];\n',
    "app/src/main/document/clean.ts": 'import { pdf } from "../../shared/pdf/helpers.js";\nimport { arxiv } from "../../shared/arxiv.js";\nexport const value = [pdf, arxiv];\n',
    "app/src/shared/clean.ts": 'import { helper } from "./main/utils.js";\nimport { renderer } from "./renderer/view.js";\nexport const value = [helper, renderer];\n',
    "app/src/shared/contracts.ts": 'export type Contract = unknown;\n',
    "app/src/shared/main/utils.ts": 'export const helper = 1;\n',
    "app/src/shared/renderer/view.ts": 'export const view = 1;\n',
    "app/src/shared/pdf/helpers.ts": 'export const pdf = 1;\n',
    "app/src/shared/arxiv.ts": 'export const arxiv = 1;\n',
  });

  const result = await runArchitectureGate();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("0 findings, 0 blocking");
  expect(result.stdout).toContain("modules scanned with SWC");
});

test("架构空扫描按检查不可用阻断", async () => {
  await writeFixtures({ "app/src/placeholder.txt": "not a module\n" });
  const result = await runArchitectureGate();
  expect(result.status).toBe(2);
});
