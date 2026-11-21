import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const GATE = path.resolve("scripts/check-dependencies.mjs");

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-npm-audit-gate-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

type Severity = "info" | "low" | "moderate" | "high" | "critical";

function report(severity?: Severity, dependencyTotal = 1) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  if (severity) {
    counts[severity] = 1;
    counts.total = 1;
  }
  return {
    auditReportVersion: 2,
    vulnerabilities: severity ? { fixture: { name: "fixture", severity } } : {},
    metadata: {
      vulnerabilities: counts,
      dependencies: { total: dependencyTotal },
    },
  };
}

async function runGate(value: unknown = report(), status = 0, raw?: string) {
  const npmCli = path.join(sandbox, "npm-cli.mjs");
  const output = raw ?? JSON.stringify(value);
  await fs.writeFile(npmCli, `process.stdout.write(${JSON.stringify(output)}); process.exit(${status});\n`);
  return spawnSync(process.execPath, [GATE], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, npm_execpath: npmCli },
  });
}

test("npm-audit high/critical finding 阻断", async () => {
  const result = await runGate(report("critical"), 1);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("1 high/critical");
});

test("npm-audit 元数据与 finding 不一致时 fail-closed", async () => {
  const value = {
    ...report("low"),
    vulnerabilities: { fixture: { name: "fixture", severity: "high" } },
  };
  const result = await runGate(value);
  expect(result.status).toBe(2);
});

test("npm-audit 缺失 finding 清单时 fail-closed", async () => {
  const value = { auditReportVersion: 2, metadata: report().metadata };
  const result = await runGate(value);
  expect(result.status).toBe(2);
});

test("npm-audit 仅 low/moderate finding 不阻断", async () => {
  const result = await runGate(report("moderate"));
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("1 low/moderate");
});

test("npm-audit 非空依赖树上的零 finding 通过", async () => {
  const result = await runGate(report());
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("0 high/critical");
});

test("npm-audit 非 JSON 报告按不可用处理", async () => {
  const result = await runGate(undefined, 0, "{ not json");
  expect(result.status).toBe(2);
});

test("npm-audit 空依赖清单不能冒充有效扫描", async () => {
  const result = await runGate(report("low", 0));
  expect(result.status).toBe(2);
});

test("npm-audit 未知严重度 fail-closed", async () => {
  const value = {
    ...report("low"),
    vulnerabilities: { fixture: { name: "fixture", severity: "unexpected" } },
  };
  const result = await runGate(value);
  expect(result.status).toBe(2);
});

test("npm-audit 不完整严重度元数据 fail-closed", async () => {
  const value = {
    ...report("low"),
    metadata: { dependencies: { total: 1 } },
  };
  const result = await runGate(value);
  expect(result.status).toBe(2);
});

test("npm-audit 非零扫描状态不能由无高危报告掩盖", async () => {
  const result = await runGate(report("low"), 1);
  expect(result.status).toBe(2);
});
