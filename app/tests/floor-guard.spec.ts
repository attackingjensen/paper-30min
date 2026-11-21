import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const GUARD = path.resolve("scripts/floor-guard.mjs");
// 守卫检测字面量只在运行时拼装，避免测试源码本身触发 suppression 扫描。
const SUPPRESSION = "@ts-" + "ignore";
const EXPECT = "ex" + "pect";
const SKIP = ".s" + "kip";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-floor-guard-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function futureDate(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const BASE_CONSTRAINTS = [
  "# Constraints",
  "",
  "## Floor（始终阻断）",
  "",
  `- 禁止新增抑制注释: 不允许新增 ${SUPPRESSION}。`,
  "",
  "## Exceptions",
  "",
  "| ID | Rule | Path | Reason | Owner | Expires |",
  "|---|---|---|---|---|---|",
  "| W1 | knip types | app/src/shared/parsing.ts | 基线 | @attackingjensen | 2027-02-15 |",
  "",
].join("\n");

async function fixtureRepo() {
  git(sandbox, "init", "-q", "-b", "main");
  git(sandbox, "config", "user.email", "fixture@example.test");
  git(sandbox, "config", "user.name", "Fixture");
  await fs.writeFile(path.join(sandbox, "CONSTRAINTS.md"), BASE_CONSTRAINTS);
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "base");
}

function runGuard() {
  return spawnSync(process.execPath, [GUARD, "--base", "HEAD"], {
    cwd: sandbox,
    encoding: "utf8",
  });
}

async function appendException(line: string) {
  await fs.appendFile(path.join(sandbox, "CONSTRAINTS.md"), line + "\n");
}

function exceptionLine(overrides: { owner?: string; expires?: string } = {}) {
  const owner = overrides.owner ?? "@attackingjensen";
  const expires = overrides.expires ?? futureDate(30);
  return `| W3 | Dependency high（C5） | app/package-lock.json picomatch@4.0.7 | dev-only 无上游修复 | ${owner} | ${expires} |`;
}

test("floor-guard 要素齐全且在 90 天内的新例外行放行", async () => {
  await fixtureRepo();
  await appendException(exceptionLine());
  const result = runGuard();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("clean");
});

test("floor-guard 缺 owner 的新例外行仍拦截", async () => {
  await fixtureRepo();
  await appendException(exceptionLine({ owner: "" }));
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("new-exception");
});

test("floor-guard 已过期或超过 90 天的新例外行仍拦截", async () => {
  await fixtureRepo();
  await appendException(exceptionLine({ expires: "2020-01-01" }));
  expect(runGuard().status).toBe(1);
  await appendException(exceptionLine({ expires: futureDate(120) }));
  expect(runGuard().status).toBe(1);
});

test("floor-guard 非法日期或缺列的新例外行仍拦截", async () => {
  await fixtureRepo();
  await appendException(exceptionLine({ expires: "soon" }));
  expect(runGuard().status).toBe(1);
  await appendException("| W4 | rule | path | reason |");
  expect(runGuard().status).toBe(1);
});

test("floor-guard 首次创建 CONSTRAINTS 的 bootstrap 例外仍放行", async () => {
  git(sandbox, "init", "-q", "-b", "main");
  git(sandbox, "config", "user.email", "fixture@example.test");
  git(sandbox, "config", "user.name", "Fixture");
  await fs.writeFile(path.join(sandbox, "README.md"), "fixture\n");
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "base");
  await fs.writeFile(path.join(sandbox, "CONSTRAINTS.md"), BASE_CONSTRAINTS);
  const result = runGuard();
  expect(result.status).toBe(0);
});

test("floor-guard 细化后仍拦截产品源码的新抑制注释", async () => {
  await fixtureRepo();
  await appendException(exceptionLine());
  await fs.writeFile(path.join(sandbox, "src.ts"), `// ${SUPPRESSION}\nexport const x = 1;\n`);
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("silenced-checker");
});

test("floor-guard 拦截 Oxlint 抑制注释", async () => {
  await fixtureRepo();
  await appendException(exceptionLine());
  const suppression = "oxlint-" + "disable";
  await fs.writeFile(path.join(sandbox, "src.ts"), `// ${suppression}-next-line\nexport const x = 1;\n`);
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("silenced-checker");
});

test("floor-guard 已登记退役例外按文件豁免删除测试与移除断言", async () => {
  await fixtureRepo();
  await fs.mkdir(path.join(sandbox, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox, "tests/old.spec.ts"),
    'test("old", () => { expect(1).toBe(1); });\n',
  );
  await fs.writeFile(
    path.join(sandbox, "tests/old2.spec.ts"),
    'test("old2", () => { expect(2).toBe(2); });\n',
  );
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "tests");
  await appendException(
    `| W4 | 旧解析退役删除测试与断言 | \`tests/old.spec.ts\`、\`tests/old2.spec.ts\` | 被新链路取代 | @attackingjensen | ${futureDate(30)} |`,
  );
  await fs.rm(path.join(sandbox, "tests/old.spec.ts"));
  await fs.writeFile(path.join(sandbox, "tests/old2.spec.ts"), 'test("old2", () => { /* 断言随旧实现退役 */ });\n');
  const result = runGuard();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("clean");
});

test("floor-guard 未登记或过期的退役例外不豁免删除测试", async () => {
  await fixtureRepo();
  await fs.mkdir(path.join(sandbox, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox, "tests/old.spec.ts"),
    'test("old", () => { expect(1).toBe(1); });\n',
  );
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "tests");
  await appendException(
    `| W4 | 旧解析退役删除测试与断言 | \`tests/old.spec.ts\` | 被新链路取代 | @attackingjensen | ${futureDate(-1)} |`,
  );
  await fs.rm(path.join(sandbox, "tests/old.spec.ts"));
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("test-deleted");
});

test("floor-guard 棘轮收紧放行而放宽仍拦截", async () => {
  await fixtureRepo();
  await appendException(
    "| M1 | 默认回归环境跳过数 | `4` | 不得增长 | 基线 | @attackingjensen | " + futureDate(30) + " |",
  );
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "metric");
  const file = path.join(sandbox, "CONSTRAINTS.md");
  const tighten = (await fs.readFile(file, "utf8")).replace("`4`", "`3`");
  await fs.writeFile(file, tighten);
  expect(runGuard().status).toBe(0);
  const loosen = (await fs.readFile(file, "utf8")).replace("`3`", "`5`");
  await fs.writeFile(file, loosen);
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("threshold");
});

test("floor-guard 整文件纯重排不报断言移除，混入真实删除仍拦截", async () => {
  await fixtureRepo();
  const spec = path.join(sandbox, "sample.spec.ts");
  const original = `test("a", () => {\n  ${EXPECT}(1).toBe(1);\n});\ntest("b", () => {\n  ${EXPECT}(2).toBe(2);\n});\n`;
  await fs.writeFile(spec, original);
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "tests");
  // 纯重排：单行化，断言原样保留。
  await fs.writeFile(
    spec,
    `test("a", () => { ${EXPECT}(1).toBe(1); });\ntest("b", () => { ${EXPECT}(2).toBe(2); });\n`,
  );
  expect(runGuard().status).toBe(0);
  // 混入真实断言删除：整文件 canon 不再相等，必须拦截。
  await fs.writeFile(spec, `test("a", () => { ${EXPECT}(1).toBe(1); });\ntest("b", () => {});\n`);
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("assertion-removed");
});

test("floor-guard 重排豁免不掩盖同文件新增的抑制与跳过", async () => {
  await fixtureRepo();
  const spec = path.join(sandbox, "sample.spec.ts");
  await fs.writeFile(spec, `test("a", () => {\n  ${EXPECT}(1).toBe(1);\n});\n`);
  git(sandbox, "add", "-A");
  git(sandbox, "commit", "-qm", "tests");
  // 重排的同时新增跳过：canon 不相等，跳过仍被拦截。
  await fs.writeFile(spec, `test${SKIP}("a", () => { ${EXPECT}(1).toBe(1); });\n`);
  const result = runGuard();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("test-made-easier");
});
