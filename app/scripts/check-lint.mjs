#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(appRoot, "..");
const cli = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));
let config = path.join(repositoryRoot, ".oxlintrc.json");
let target = repositoryRoot;
let typeAware = false;
const args = process.argv.slice(2);

function usage() {
  console.error("check-lint: usage: node scripts/check-lint.mjs [--type-aware] [--config path] [--target path]");
  process.exit(2);
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--type-aware") {
    typeAware = true;
  } else if (arg === "--config" || arg === "--target") {
    const value = args[++index];
    if (!value) usage();
    if (arg === "--config") config = path.resolve(value);
    else target = path.resolve(value);
  } else {
    usage();
  }
}

if (typeAware) {
  try {
    await import("tsrs");
  } catch {
    console.error("check-lint: tsrs is required for type-aware linting");
    process.exit(2);
  }
}

const scanArgs = [cli, "--config", config, "--format=json"];
if (typeAware) scanArgs.push("--type-aware");
else scanArgs.push("--allow", "typescript/no-floating-promises");
scanArgs.push(target);

const scan = spawnSync(process.execPath, scanArgs, {
  cwd: appRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

function fail(reason) {
  console.error(`check-lint: ${reason}`);
  const detail = (scan.stderr || scan.stdout)?.trim();
  if (detail) console.error(detail.slice(0, 4000));
  process.exitCode = 2;
}

if (scan.error) {
  fail(scan.error.message);
} else if (scan.status !== 0 && scan.status !== 1) {
  fail(`oxlint failed with status ${scan.status ?? "unknown"}`);
} else {
  try {
    const report = JSON.parse(scan.stdout);
    const diagnostics = report?.diagnostics;
    const valid = Number.isInteger(report?.number_of_files) && report.number_of_files >= 1
      && Number.isInteger(report?.number_of_rules) && report.number_of_rules >= 1
      && Array.isArray(diagnostics)
      && diagnostics.every(diagnostic => typeof diagnostic?.message === "string"
        && typeof diagnostic?.code === "string" && typeof diagnostic?.filename === "string"
        && ["error", "warning"].includes(diagnostic?.severity));
    if (!valid || (scan.status === 1 && diagnostics.length === 0)) {
      fail("oxlint returned an empty, incomplete, or unsupported report");
    } else {
      console.log(`oxlint: ${report.number_of_files} files, ${report.number_of_rules} rules, ${diagnostics.length} findings${typeAware ? " (type-aware)" : ""}`);
      for (const diagnostic of diagnostics) {
        const span = diagnostic.labels?.[0]?.span;
        const location = `${diagnostic.filename}:${span?.line ?? 0}:${span?.column ?? 0}`;
        const help = diagnostic.help && diagnostic.help !== diagnostic.message ? ` — ${diagnostic.help}` : "";
        console.error(`${location} ${diagnostic.code} ${diagnostic.message}${help}`);
      }
      process.exitCode = diagnostics.length ? 1 : 0;
    }
  } catch {
    fail("oxlint did not return a readable JSON report");
  }
}
