#!/usr/bin/env node
// Exit 0: below threshold; 1: blocking findings; 2: unusable report or invocation.
import { readFileSync } from "node:fs";

const [tool, file, ...extra] = process.argv.slice(2);
if (!["semgrep", "axe", "depcruise"].includes(tool) || !file || extra.length) {
  console.error("quality-gate: usage: node quality-gate.mjs <semgrep|axe|depcruise> <report.json>");
  process.exit(2);
}

try {
  const report = JSON.parse(readFileSync(file, "utf8"));
  let levels;
  let allowed;
  let blocking;
  let blockingFindings = [];
  let completionDetail = "";
  if (tool === "semgrep") {
    if (!Array.isArray(report?.results) || !Array.isArray(report.errors)
        || report.errors.length || !Array.isArray(report.paths?.scanned)
        || !report.paths.scanned.length) {
      throw new Error("Incomplete scan");
    }
    levels = report.results.map(finding => finding?.extra?.severity);
    allowed = ["INFO", "WARNING", "ERROR", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
    blocking = ["ERROR", "HIGH", "CRITICAL"];
  } else if (tool === "axe") {
    // A browser error page can otherwise look like a successful accessibility scan.
    if (!Array.isArray(report) || !report.length
        || report.some(page => !Array.isArray(page?.violations)
          || typeof page.url !== "string" || !["http:", "https:"].includes(new URL(page.url).protocol))) {
      throw new Error("Incomplete scan");
    }
    levels = report.flatMap(page => page.violations.map(finding => finding?.impact));
    allowed = ["minor", "moderate", "serious", "critical"];
    blocking = ["serious", "critical"];
  } else {
    const summary = report?.summary;
    const extensions = summary?.environment?.extensionsFound;
    const transpilers = summary?.environment?.transpilersFound;
    if (!Array.isArray(report?.modules) || !report.modules.length
        || !Number.isInteger(summary?.totalCruised) || summary.totalCruised < 1
        || !Array.isArray(summary?.violations)
        || summary?.optionsUsed?.parser !== "swc"
        || !Array.isArray(extensions) || !Array.isArray(transpilers)
        || ![".ts", ".tsx", ".cts"].every(extension =>
          extensions.some(item => item?.extension === extension && item?.available === true))
        || !transpilers.some(item => item?.name === "swc" && item?.available === true)) {
      throw new Error("Incomplete or unsupported dependency scan");
    }
    levels = summary.violations.map(() => "ERROR");
    allowed = ["ERROR"];
    blocking = ["ERROR"];
    blockingFindings = summary.violations.map(violation =>
      violation?.rule?.name ?? "unnamed forbidden dependency");
    completionDetail = `depcruise: ${summary.totalCruised} modules scanned with SWC`;
  }
  if (levels.some(level => !allowed.includes(level))) {
    throw new Error("Unknown severity");
  }
  const count = levels.filter(level => blocking.includes(level)).length;
  console.log(`${tool}: ${levels.length} findings, ${count} blocking`);
  if (completionDetail) console.log(completionDetail);
  for (const finding of blockingFindings) console.error(`  ${finding}`);
  process.exitCode = count ? 1 : 0;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`quality-gate: unreadable, incomplete, or unsupported report: ${reason}`);
  process.exitCode = 2;
}
