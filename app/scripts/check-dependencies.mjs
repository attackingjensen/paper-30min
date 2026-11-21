#!/usr/bin/env node
// npm supplies advisory data and the audit-level exit code; validate report completeness here.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const output = "tmp/constraints/npm-audit.json";
mkdirSync("tmp/constraints", { recursive: true });
rmSync(output, { force: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("check-dependencies: run through npm so the npm CLI is available");
  process.exit(2);
}
const audit = spawnSync(
  process.execPath,
  [npmCli, "audit", "--audit-level=high", "--json"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);

if (audit.error) {
  console.error(`check-dependencies: could not start npm audit: ${audit.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("check-dependencies: npm audit did not produce a JSON report");
  process.exit(2);
}

const counts = report?.metadata?.vulnerabilities;
const dependencyTotal = report?.metadata?.dependencies?.total;
const vulnerabilities = Object.values(report?.vulnerabilities ?? {});
const severities = ["info", "low", "moderate", "high", "critical"];
const valid = audit.status === 0 || audit.status === 1
  ? Number.isInteger(dependencyTotal) && dependencyTotal >= 1
    && severities.every(level => Number.isInteger(counts?.[level]) && counts[level] >= 0)
    && vulnerabilities.every(finding => severities.includes(finding?.severity))
  : false;

if (!valid) {
  console.error(`check-dependencies: npm audit failed or returned an incomplete report (status ${audit.status ?? "unknown"})`);
  process.exit(2);
}

writeFileSync(output, audit.stdout);
const high = counts.high + counts.critical;
console.log(`npm audit: ${dependencyTotal} dependencies, ${counts.low + counts.moderate} low/moderate, ${high} high/critical`);
if (high) process.exitCode = 1;
else if (audit.status !== 0) {
  console.error("check-dependencies: npm audit failed below the blocking severity threshold");
  process.exitCode = 2;
}
