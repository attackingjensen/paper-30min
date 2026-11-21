#!/usr/bin/env node
// Run the local dependency-cruiser CLI and reject empty or unsupported scans.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs", import.meta.url));
process.chdir(appRoot);
const report = "tmp/constraints/depcruise.json";
mkdirSync("tmp/constraints", { recursive: true });
rmSync(report, { force: true });

const scan = spawnSync(
  process.execPath,
  [cli, "--validate", ".dependency-cruiser.cjs", "--output-type=json", `--output-to=${report}`, "src"],
  { stdio: "inherit" },
);
if (scan.error) {
  console.error(`check-architecture: could not start dependency-cruiser: ${scan.error.message}`);
  process.exit(2);
}
if (scan.status === null || scan.status < 0 || scan.status > 1) {
  console.error(`check-architecture: dependency-cruiser failed with status ${scan.status ?? "unknown"}`);
  process.exit(2);
}
if (!existsSync(report)) {
  console.error("check-architecture: dependency-cruiser did not produce a report");
  process.exit(2);
}

const gate = spawnSync(process.execPath, ["scripts/quality-gate.mjs", "depcruise", report], { stdio: "inherit" });
if (gate.error) {
  console.error(`check-architecture: could not start quality gate: ${gate.error.message}`);
  process.exit(2);
}
process.exitCode = gate.status === 0 || gate.status === 1 ? gate.status : 2;
