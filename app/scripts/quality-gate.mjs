#!/usr/bin/env node
// Exit 0: below threshold; 1: blocking findings; 2: unusable report or invocation.
import { readFileSync } from "node:fs";

const [tool, file, ...extra] = process.argv.slice(2);
if (tool !== "depcruise" || !file || extra.length) {
  console.error("quality-gate: usage: node quality-gate.mjs depcruise <report.json>");
  process.exit(2);
}

try {
  const report = JSON.parse(readFileSync(file, "utf8"));
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
  const levels = summary.violations.map(() => "ERROR");
  const blockingFindings = summary.violations.map(violation =>
    violation?.rule?.name ?? "unnamed forbidden dependency");
  console.log(`depcruise: ${levels.length} findings, ${levels.length} blocking`);
  console.log(`depcruise: ${summary.totalCruised} modules scanned with SWC`);
  for (const finding of blockingFindings) console.error(`  ${finding}`);
  process.exitCode = levels.length ? 1 : 0;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`quality-gate: unreadable, incomplete, or unsupported report: ${reason}`);
  process.exitCode = 2;
}
