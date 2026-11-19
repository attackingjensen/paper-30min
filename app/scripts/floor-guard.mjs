#!/usr/bin/env node
// floor-guard.mjs — diff-scoped enforcement of the CONSTRAINTS.md floor.
// Adapted from NexusKit constraint-driven-development/references/floor-guard.md.
// Usage: node floor-guard.mjs [--base <ref>]   (default base: origin/main)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = (() => {
  const i = process.argv.indexOf("--base");
  return i > -1 ? process.argv[i + 1] : "origin/main";
})();

// `git diff --no-index` exits 1 whenever the two sides differ, which is the normal case for a
// new file, so that output is kept. Any other failure is null, and null never reads as clean.
const git = (args, { diffExit = false } = {}) => {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return diffExit && e.status === 1 && typeof e.stdout === "string" ? e.stdout : null; }
};
const bail = (msg) => { console.error("floor-guard: " + msg); process.exit(2); };

// Run from the top of the work tree so untracked files outside app/ are included too.
const top = git(["rev-parse", "--show-toplevel"])?.trim();
if (!top) bail("not inside a git work tree");
process.chdir(top);

const mergeBase = git(["merge-base", base, "HEAD"])?.trim();
if (!mergeBase) bail("no merge base against " + base);

const tracked = git(["diff", "--unified=0", mergeBase, "--"]);
if (tracked === null) bail("could not diff against " + base);
const untrackedFiles = git(["ls-files", "--others", "--exclude-standard"]);
if (untrackedFiles === null) bail("could not list untracked files");
const untracked = untrackedFiles.split("\n").filter(Boolean).map((f) => {
  const d = git(["diff", "--no-index", "--unified=0", "/dev/null", f], { diffExit: true });
  if (d === null) bail("could not diff untracked file " + f);
  return d;
}).join("\n");
const diff = tracked + "\n" + untracked;

let ignoreText;
try {
  ignoreText = readFileSync(".constraintsignore", "utf8");
} catch (error) {
  if (error.code !== "ENOENT") bail("could not read .constraintsignore: " + error.message);
  ignoreText = "";
}
const ignoreRegexes = ignoreText.split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith("#"))
  .map(pattern => {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\0/g, ".*");
    return new RegExp("^" + source + "$");
  });
const ignored = (file) => ignoreRegexes.some(pattern => pattern.test(file));

// Walk the diff. `---` and `+++` are headers only before the first `@@` hunk.
const added = [], removed = [], deleted = [], addedFiles = new Set();
const pathOf = (s) => s.replace(/^[ab]\//, "");
let file = "", oldFile = "", inHeader = false;
for (const line of diff.split("\n")) {
  if (line.startsWith("diff ")) inHeader = true;
  else if (line.startsWith("@@")) inHeader = false;
  else if (inHeader) {
    if (line.startsWith("--- ")) oldFile = pathOf(line.slice(4));
    else if (line.startsWith("+++ ")) {
      const newFile = pathOf(line.slice(4));
      file = newFile === "/dev/null" ? oldFile : newFile;
      if (newFile === "/dev/null") deleted.push(file);
      if (oldFile === "/dev/null" && newFile !== "/dev/null") addedFiles.add(file);
    }
  }
  else if (line.startsWith("+")) added.push({ file, text: line.slice(1) });
  else if (line.startsWith("-")) removed.push({ file, text: line.slice(1) });
}

const findings = [];
const flag = (rule, f, text) => {
  if (!ignored(f)) findings.push({ rule, file: f, text: text.trim().slice(0, 120) });
};
const isTest = (f) => /\.(test|spec)\.|_test\.|test_/.test(f);
const isConstraints = (f) => /CONSTRAINTS\.md$/.test(f);

// 登记要素验证（CONSTRAINTS 失败与例外策略）：例外行须有非空 owner 与未来且 ≤90 天的
// 到期日（| ID | Rule | Path | Reason | Owner | Expires |）。要素缺失、过期或超期仍拦截。
const exceptionRegistered = (text) => {
  const cells = text.split("|").map((cell) => cell.trim());
  if (cells.length < 7) return false;
  const owner = cells[5];
  const expires = cells[6];
  if (!owner || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return false;
  const today = new Date().toISOString().slice(0, 10);
  const days = (Date.parse(expires) - Date.parse(today)) / 86_400_000;
  return expires > today && days <= 90;
};

const SUPPRESSIONS = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
const STUBS = /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/;
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/;

for (const { file, text } of added) {
  // CONSTRAINTS.md names the patterns as documentation. Only its exception rows are line-checked:
  // the file's initial, reviewed creation is the bootstrap; later additions pass only when the
  // registration elements validate (owner + future expiry within 90 days), otherwise they flag.
  if (isConstraints(file)) {
    if (!addedFiles.has(file) && /^\| *(W|E)\d+ *\|/.test(text) && !exceptionRegistered(text))
      flag("new-exception", file, text);
    continue;
  }
  if (!addedFiles.has(file) && file === ".constraintsignore"
      && text.trim() && !text.trim().startsWith("#")) {
    flag("new-ignore-path", file, text);
  }
  if (!addedFiles.has(file) && file === ".gitleaks.toml"
      && /^\s*(?:\[{1,2}[^\]]*allowlist[^\]]*\]{1,2}|paths\s*=|regexes\s*=|stopwords\s*=|\[\[rules\]\]|'''.*''',?\s*$)/i.test(text)) {
    flag("new-scan-exclusion", file, text);
  }
  const suppression = text.match(SUPPRESSIONS);
  if (suppression) flag("silenced-checker", file, suppression[0]);
  if (STUBS.test(text)) flag("unfinished-work", file, text);
  if (SKIPS.test(text)) flag("test-made-easier", file, text);
}

for (const f of deleted) if (isTest(f)) flag("test-deleted", f, "file deleted");
for (const { file, text } of removed) {
  if (isTest(file) && !deleted.includes(file) && /\b(expect|assert|should)\b/.test(text)) {
    flag("assertion-removed", file, text);
  }
}

// A rule is a floor bullet or a table row, identified by its stable label / first cell.
const ruleKey = (t) => {
  const s = t.trim();
  if (s.startsWith("|")) return s.split("|").map(c => c.trim()).filter(Boolean)[0] ?? "";
  if (/^[-*] /.test(s)) return s.slice(2).split(":")[0].trim();
  return null;
};
const isException = (t) => /^\| *(W|E)\d+ *\|/.test(t.trim());
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop|不得下降|至少)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed|不得增长|不超过)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(?:\|\s*)?(or more|or higher|must not fall|must not drop|不得下降|不许下降)/;
const MAX_AFTER = /^\s*\S*\s*(?:\|\s*)?(or less|or lower|must not grow|must not exceed|不得增长|不许增长)/;
const thresholds = (t) => {
  const out = [], re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const dir = MIN_BEFORE.test(before) || MIN_AFTER.test(after) ? "min"
      : MAX_BEFORE.test(before) || MAX_AFTER.test(after) ? "max" : null;
    out.push({ n: Number(m[0]), dir });
  }
  return out;
};
const removedRules = removed.filter(l => isConstraints(l.file) && ruleKey(l.text) !== null);
const addedRules = added.filter(l => isConstraints(l.file) && ruleKey(l.text) !== null);
for (const r of removedRules) {
  const a = addedRules.find(x => ruleKey(x.text) === ruleKey(r.text));
  if (!a) {
    if (!isException(r.text)) flag("rule-removed", r.file, r.text);
    continue;
  }
  const before = thresholds(r.text), after = thresholds(a.text);
  let verdict = null;
  for (const dir of ["min", "max", null]) {
    const was = before.filter(x => x.dir === dir), now = after.filter(x => x.dir === dir);
    was.forEach((b, i) => {
      const n = now[i];
      if (verdict) return;
      if (!n) verdict = "threshold-removed";
      else if (n.n === b.n) return;
      else if (dir === "min" ? n.n < b.n : dir === "max" ? n.n > b.n : true) {
        verdict = dir ? "threshold-loosened" : "threshold-changed";
      }
    });
  }
  if (verdict) flag(verdict, r.file, r.text + "  ->  " + a.text);
}

if (findings.length === 0) { console.log("floor-guard: clean"); process.exit(0); }
console.error("floor-guard: " + findings.length + " floor violation(s):");
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
if (findings.some(f => f.rule === "rule-removed")) {
  console.error("\nA rule-removed finding can also mean the rule's label changed: rename a rule in one commit and change its thresholds in another.");
}
if (findings.some(f => f.rule === "threshold-removed")) {
  console.error("\nA threshold-removed finding can also mean a number gained or lost its direction words: compare the two lines before assuming a threshold was deleted.");
}
console.error("\nEach is a move that lowers the bar. Fix the code, or route it through a tracked exception.");
process.exit(1);
