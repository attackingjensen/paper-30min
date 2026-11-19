import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const GATE = path.resolve("scripts/quality-gate.mjs");
const ADVISORY = "GHSA-fc5q-39xc-vjpf";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-osv-gate-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function futureDate(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function exception(overrides: Record<string, unknown> = {}) {
  return {
    id: "W3",
    advisory: ADVISORY,
    package: "picomatch",
    version: "4.0.7",
    owner: "@attackingjensen",
    expires: futureDate(30),
    reason: "dev-only transitive dependency, no upstream fix",
    ...overrides,
  };
}

function report(packages: Array<{
  name: string;
  version: string;
  vulns: Array<{ id: string; severity: string }>;
}>) {
  return {
    results: [{
      source: { path: "fixture/package-lock.json" },
      packages: packages.map((entry) => ({
        package: { name: entry.name, version: entry.version },
        vulnerabilities: entry.vulns.map((vuln) => ({
          id: vuln.id,
          database_specific: { severity: vuln.severity },
        })),
      })),
    }],
  };
}

const picomatchHigh = report([
  { name: "picomatch", version: "4.0.7", vulns: [{ id: ADVISORY, severity: "HIGH" }] },
]);

async function runGate(value: unknown, exceptions?: unknown) {
  const reportPath = path.join(sandbox, "osv.json");
  await fs.writeFile(reportPath, JSON.stringify(value));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PAPER30MIN_OSV_EXCEPTIONS;
  if (exceptions !== undefined) {
    const configPath = path.join(sandbox, "exceptions.json");
    await fs.writeFile(
      configPath,
      typeof exceptions === "string" ? exceptions : JSON.stringify(exceptions),
    );
    env.PAPER30MIN_OSV_EXCEPTIONS = configPath;
  }
  return spawnSync(process.execPath, [GATE, "osv", reportPath], { encoding: "utf8", env });
}

test("osv-gate 登记有效的例外放行精确匹配的高危 finding 并保持可见", async () => {
  const result = await runGate(picomatchHigh, [exception()]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("0 blocking");
  expect(result.stdout).toContain("excepted");
  expect(result.stdout).toContain(ADVISORY);
});

test("osv-gate 例外只匹配登记版本，版本变化重新阻断", async () => {
  const bumped = report([
    { name: "picomatch", version: "4.0.8", vulns: [{ id: ADVISORY, severity: "HIGH" }] },
  ]);
  const result = await runGate(bumped, [exception()]);
  expect(result.status).toBe(1);
});

test("osv-gate 例外只匹配登记公告，同包新公告重新阻断", async () => {
  const other = report([
    { name: "picomatch", version: "4.0.7", vulns: [{ id: "GHSA-0000-0000-0000", severity: "HIGH" }] },
  ]);
  const result = await runGate(other, [exception()]);
  expect(result.status).toBe(1);
});

test("osv-gate 过期例外不再放行", async () => {
  const result = await runGate(picomatchHigh, [exception({ expires: "2020-01-01" })]);
  expect(result.status).toBe(1);
  expect(result.stderr + result.stdout).toContain("expired");
});

test("osv-gate 例外不豁免其他包的高危 finding", async () => {
  const mixed = report([
    { name: "picomatch", version: "4.0.7", vulns: [{ id: ADVISORY, severity: "HIGH" }] },
    { name: "other-lib", version: "1.0.0", vulns: [{ id: "GHSA-1111-1111-1111", severity: "CRITICAL" }] },
  ]);
  const result = await runGate(mixed, [exception()]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("other-lib@1.0.0");
  expect(result.stderr).not.toContain(`picomatch@4.0.7 ${ADVISORY}`);
});

test("osv-gate 损坏或缺要素的例外配置 fail-closed", async () => {
  const broken = await runGate(picomatchHigh, "{ not json");
  expect(broken.status).toBe(2);
  const missingFields = await runGate(picomatchHigh, [{ id: "W3" }]);
  expect(missingFields.status).toBe(2);
  const badDate = await runGate(picomatchHigh, [exception({ expires: "soon" })]);
  expect(badDate.status).toBe(2);
  const emptyConfig = await runGate(picomatchHigh, []);
  expect(emptyConfig.status).toBe(1);
});

test("osv-gate 显式指向缺失的例外配置按不可用处理", async () => {
  const reportPath = path.join(sandbox, "osv.json");
  await fs.writeFile(reportPath, JSON.stringify(picomatchHigh));
  const result = spawnSync(process.execPath, [GATE, "osv", reportPath], {
    encoding: "utf8",
    env: { ...process.env, PAPER30MIN_OSV_EXCEPTIONS: path.join(sandbox, "absent.json") },
  });
  expect(result.status).toBe(2);
});

test("osv-gate 无例外配置时高危照旧阻断，低危不阻断", async () => {
  const blocked = await runGate(picomatchHigh, []);
  expect(blocked.status).toBe(1);
  const low = report([
    { name: "katex", version: "0.16.0", vulns: [{ id: "GHSA-2222-2222-2222", severity: "LOW" }] },
    { name: "minimatch", version: "9.0.0", vulns: [{ id: "GHSA-3333-3333-3333", severity: "MODERATE" }] },
  ]);
  const measured = await runGate(low, []);
  expect(measured.status).toBe(0);
  expect(measured.stdout).toContain("2 findings, 0 blocking");
});

test("osv-gate 未知严重度与空扫描仍 fail-closed", async () => {
  const unknown = report([
    { name: "picomatch", version: "4.0.7", vulns: [{ id: ADVISORY, severity: "UNKNOWN" }] },
  ]);
  expect((await runGate(unknown, [exception()])).status).toBe(2);
  expect((await runGate({ results: [] })).status).toBe(2);
});