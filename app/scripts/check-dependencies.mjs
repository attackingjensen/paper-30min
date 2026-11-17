#!/usr/bin/env node
// Run OSV, then apply the high/critical threshold without hiding scanner failures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
process.chdir(appRoot);
const report = "tmp/constraints/osv-results.json";
mkdirSync("tmp/constraints", { recursive: true });
rmSync(report, { force: true });

const scan = spawnSync(
  "osv-scanner",
  [
    "scan",
    "source",
    "--lockfile=package-lock.json",
    "--format=json",
    "--all-packages",
    `--output-file=${report}`,
    "--verbosity=error",
  ],
  { stdio: "inherit" },
);

if (scan.error) {
  console.error(`check-dependencies: could not start osv-scanner: ${scan.error.message}`);
  process.exit(2);
}
if (scan.status === null || scan.status < 0 || scan.status > 1) {
  console.error(`check-dependencies: osv-scanner failed with status ${scan.status ?? "unknown"}`);
  process.exit(2);
}
if (!existsSync(report)) {
  console.error("check-dependencies: osv-scanner did not produce a report");
  process.exit(2);
}

const gate = spawnSync(
  process.execPath,
  ["scripts/quality-gate.mjs", "osv", report],
  { stdio: "inherit" },
);
if (gate.error) {
  console.error(`check-dependencies: could not start quality gate: ${gate.error.message}`);
  process.exit(2);
}
process.exitCode = gate.status === 0 || gate.status === 1 ? gate.status : 2;
