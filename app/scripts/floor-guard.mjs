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
// 大基线变更（如全仓格式化）的 unified=0 diff 可超过默认 1MiB 管道缓冲；ENOBUFS 必须失败而非误读为干净。
const git = (args, { diffExit = false } = {}) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return diffExit && e.status === 1 && typeof e.stdout === "string" ? e.stdout : null;
  }
};
const bail = (msg) => {
  console.error("floor-guard: " + msg);
  process.exit(2);
};

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
const untracked = untrackedFiles
  .split("\n")
  .filter(Boolean)
  .map((f) => {
    const d = git(["diff", "--no-index", "--unified=0", "/dev/null", f], { diffExit: true });
    if (d === null) bail("could not diff untracked file " + f);
    return d;
  })
  .join("\n");
const diff = tracked + "\n" + untracked;

let ignoreText;
try {
  ignoreText = readFileSync(".constraintsignore", "utf8");
} catch (error) {
  if (error.code !== "ENOENT") bail("could not read .constraintsignore: " + error.message);
  ignoreText = "";
}
const ignoreRegexes = ignoreText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((pattern) => {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\0/g, ".*");
    return new RegExp("^" + source + "$");
  });
const ignored = (file) => ignoreRegexes.some((pattern) => pattern.test(file));

// Walk the diff. `---` and `+++` are headers only before the first `@@` hunk.
const added = [],
  removed = [],
  deleted = [],
  addedFiles = new Set();
const pathOf = (s) => s.replace(/^[ab]\//, "");
let file = "",
  oldFile = "",
  inHeader = false;
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
  } else if (line.startsWith("+")) added.push({ file, text: line.slice(1) });
  else if (line.startsWith("-")) removed.push({ file, text: line.slice(1) });
}

// 排版不变归一：去空白与成对括号、去尾逗号/分号、union 竖线、引号风格与可去转义、
// JSX 显式空格；markdown 表格对齐填充（:---:）归一为 ---。
// 两级豁免只作用于「删除行」检测：整文件 canon 相等 → 全文件删行豁免；否则删行 canon
// 原样出现在某条新增行 canon 中（如多行调用被收成单行）视为重排。新增行始终逐行严检，
// 重排不能掩盖新引入的抑制/跳过/未完成标记。
const formatCanon = (t) =>
  t
    .replace(/\s+/g, "")
    .replace(/[,;](?=[)\]}]|$)/g, "")
    .replace(/[()]/g, "")
    .replace(/\|/g, "")
    .replace(/\\(["'`])/g, "$1")
    .replace(/'/g, '"')
    .replace(/\{""\}/g, "")
    .replace(/:?-{3,}:?/g, "---");
const reflowedFiles = new Set();
for (const f of new Set([...added, ...removed].map((l) => l.file))) {
  if (!f || addedFiles.has(f) || deleted.includes(f)) continue;
  const before = git(["show", `${mergeBase}:${f}`]);
  if (before === null) continue;
  let after;
  try {
    after = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (formatCanon(before) === formatCanon(after)) reflowedFiles.add(f);
}
const addedCanonByFile = new Map();
for (const { file: f, text } of added) {
  let list = addedCanonByFile.get(f);
  if (!list) addedCanonByFile.set(f, (list = []));
  list.push(formatCanon(text));
}
// 删行 canon 若原样出现在某条新增行 canon 中（如多行调用被收成单行），视为重排而非删除。
const reflowedLine = (f, text) => {
  if (reflowedFiles.has(f)) return true;
  const c = formatCanon(text);
  if (!c) return false;
  return (addedCanonByFile.get(f) ?? []).some((a) => a.includes(c));
};
const removedCanonByFile = new Map();
for (const { file: f, text } of removed) {
  let list = removedCanonByFile.get(f);
  if (!list) removedCanonByFile.set(f, (list = []));
  list.push(formatCanon(text));
}
// 新增行 canon 若原样出现在某条删除行 canon 中，说明内容基线已有、只是重排呈现，豁免；
// 基线没有的新内容（新抑制/跳过/未完成标记）仍逐行严检。
const reflowedAdded = (f, text) => {
  if (reflowedFiles.has(f)) return true;
  const c = formatCanon(text);
  if (!c) return false;
  return (removedCanonByFile.get(f) ?? []).some((r) => r.includes(c));
};

const findings = [];
const flag = (rule, f, text) => {
  if (!ignored(f)) findings.push({ rule, file: f, text: text.trim().slice(0, 120) });
};
const isTest = (f) => /\.(test|spec)\.|_test\.|test_/.test(f);
const isConstraints = (f) => f.endsWith("CONSTRAINTS.md");

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

// 已登记退役例外（CONSTRAINTS Exceptions）：Rule 含「退役」且 Path 反引号列出具体
// 测试文件的 W/E 行，按文件豁免 test-deleted / assertion-removed。登记要素仍须通过
// exceptionRegistered 验证；其他 finding 类型不受影响，到期后豁免自动失效。
const retirementWaivers = (() => {
  let text;
  try {
    text = readFileSync("CONSTRAINTS.md", "utf8");
  } catch {
    return [];
  }
  const waivers = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\| *(W|E)\d+ *\|/.test(line) || !exceptionRegistered(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (!cells[2] || !cells[2].includes("退役")) continue;
    for (const match of cells[3].matchAll(/`([^`]+)`/g)) {
      if (isTest(match[1])) waivers.push(match[1]);
    }
  }
  return waivers;
})();

const SUPPRESSIONS =
  /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|oxlint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
// TODO 桩检测只对代码/脚本文件生效；文档与提示词里作为名词提及 TODO 不构成未完成桩。
const isCode = (f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|sh|ps1|vue|svelte)$/.test(f);
const STUBS =
  /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bpass\s*# *stub/;
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
  if (!addedFiles.has(file) && file === ".constraintsignore" && text.trim() && !text.trim().startsWith("#")) {
    flag("new-ignore-path", file, text);
  }
  if (
    !addedFiles.has(file) &&
    file === ".gitleaks.toml" &&
    /^\s*(?:\[{1,2}[^\]]*allowlist[^\]]*\]{1,2}|paths\s*=|regexes\s*=|stopwords\s*=|\[\[rules\]\]|'''.*''',?\s*$)/i.test(
      text,
    )
  ) {
    flag("new-scan-exclusion", file, text);
  }
  if (reflowedAdded(file, text)) continue;
  const suppression = text.match(SUPPRESSIONS);
  if (suppression) flag("silenced-checker", file, suppression[0]);
  if (STUBS.test(text) || (isCode(file) && /\bTODO\b/.test(text))) flag("unfinished-work", file, text);
  if (SKIPS.test(text)) flag("test-made-easier", file, text);
}

for (const f of deleted) if (isTest(f) && !retirementWaivers.includes(f)) flag("test-deleted", f, "file deleted");
for (const { file, text } of removed) {
  if (
    isTest(file) &&
    !deleted.includes(file) &&
    !retirementWaivers.includes(file) &&
    /\b(expect|assert|should)\b/.test(text) &&
    !reflowedLine(file, text)
  ) {
    flag("assertion-removed", file, text);
  }
}

// A rule is a floor bullet or a table row, identified by its stable label / first cell.
// 删除检测只覆盖「## Floor」章节的 bullet 与表格行；其余章节的文档性 bullet 改写不视为规则移除，
// 阈值棘轮仍对全部规则行生效。章节归属按基线文件内容判定，防止同一次改动挪动章节标题绕过检测。
const ruleKey = (t) => {
  const s = t.trim();
  if (s.startsWith("|"))
    return (
      s
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)[0] ?? ""
    );
  if (/^[-*] /.test(s)) return s.slice(2).split(":")[0].trim();
  return null;
};
const floorRuleKeys = (() => {
  // 基线无 CONSTRAINTS.md（bootstrap）时 git show 失败返回 null：无既有规则可删，返回空集。
  const text = git(["show", `${mergeBase}:CONSTRAINTS.md`]);
  if (text === null) return new Set();
  const keys = new Set();
  let inFloor = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      inFloor = heading[1].trim().startsWith("Floor");
      continue;
    }
    if (inFloor) {
      const key = ruleKey(line);
      if (key !== null) keys.add(key);
    }
  }
  return keys;
})();
const isException = (t) => /^\| *(W|E)\d+ *\|/.test(t.trim());
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop|不得下降|至少)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed|不得增长|不超过)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(?:\|\s*)?(or more|or higher|must not fall|must not drop|不得下降|不许下降)/;
const MAX_AFTER = /^\s*\S*\s*(?:\|\s*)?(or less|or lower|must not grow|must not exceed|不得增长|不许增长)/;
const thresholds = (t) => {
  const out = [],
    re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const dir =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? "min"
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? "max"
          : null;
    out.push({ n: Number(m[0]), dir });
  }
  return out;
};
// 删除检测只覆盖基线 Floor 章节的规则；阈值棘轮仍对全部规则行（含例外/测量表）生效。
const removedRules = removed.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
const addedRules = added.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
for (const r of removedRules) {
  const a = addedRules.find((x) => ruleKey(x.text) === ruleKey(r.text));
  if (reflowedLine(r.file, r.text)) continue;
  if (!a) {
    if (!isException(r.text) && floorRuleKeys.has(ruleKey(r.text))) flag("rule-removed", r.file, r.text);
    continue;
  }
  const before = thresholds(r.text),
    after = thresholds(a.text);
  let verdict = null;
  for (const dir of ["min", "max", null]) {
    const was = before.filter((x) => x.dir === dir),
      now = after.filter((x) => x.dir === dir);
    was.forEach((b, i) => {
      const n = now[i];
      if (verdict) return;
      // 棘轮收紧放行：max 上限变小、min 下限变大、无方向计数（豁免/跳过数）变小
      // 都是提高标准；数字消失只在归零语义下放行（如「除 W1」豁免移除）。
      if (!n) {
        if (dir === null && b.n > 0 && /除\s*W\d+|豁免/.test(r.text)) return;
        verdict = "threshold-removed";
      } else if (n.n === b.n) return;
      else if (dir === "min" ? n.n > b.n : dir === "max" ? n.n < b.n : n.n < b.n) return;
      else verdict = dir ? "threshold-loosened" : "threshold-changed";
    });
  }
  if (verdict) flag(verdict, r.file, r.text + "  ->  " + a.text);
}

if (findings.length === 0) {
  console.log("floor-guard: clean");
  process.exit(0);
}
console.error("floor-guard: " + findings.length + " floor violation(s):");
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
if (findings.some((f) => f.rule === "rule-removed")) {
  console.error(
    "\nA rule-removed finding can also mean the rule's label changed: rename a rule in one commit and change its thresholds in another.",
  );
}
if (findings.some((f) => f.rule === "threshold-removed")) {
  console.error(
    "\nA threshold-removed finding can also mean a number gained or lost its direction words: compare the two lines before assuming a threshold was deleted.",
  );
}
console.error("\nEach is a move that lowers the bar. Fix the code, or route it through a tracked exception.");
process.exit(1);
