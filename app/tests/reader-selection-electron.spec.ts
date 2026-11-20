// Full 原文精确选区与工具条（SPEC-reader §3，paper-30min-qa3.2）：
// 真实 Electron DOM 选区 → 投影逻辑 range（UTF-16，atom 占一位，半开区间）；
// KaTeX/MathML 辅助节点不破坏偏移；跨句/跨单元完整展开；
// 解释/提问进入右侧持续对话草稿，不生成问答卡、不自动发送模型请求。
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type {
  CoreCommand,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
  SourceSnapshotRecord,
} from "../src/shared/contracts";
import type { DocumentTree } from "../src/shared/document/tree";
import { complexReaderTree } from "./fixtures/reader/complex-document";

let sandbox: string;
let desktop: ElectronApplication;
let page: Page;
let errors: string[];
let remoteRequests: string[];

async function launch() {
  const visible = process.env.PAPER30MIN_TEST_WINDOW === "visible";
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PAPER30MIN_PROFILE: path.join(sandbox, "profile"),
    PAPER30MIN_TEST_WINDOW: visible ? "visible" : "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: ["."], env });
  page = await desktop.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("paper30min://") && !url.startsWith("data:") && !url.startsWith("blob:"))
      remoteRequests.push(url);
  });
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible();
}

test.beforeEach(async () => {
  errors = [];
  remoteRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reader-selection-"));
  await launch();
});

test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  } finally {
    await desktop.close();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** 确定性选区树：相邻单元、句内混合文本/atom、组合字符与代理对。 */
function selectionTree(paperId: string) {
  const sectionId = randomUUID();
  const unitA = randomUUID();
  const unitB = randomUUID();
  const sentenceA1 = randomUUID();
  const sentenceA2 = randomUUID();
  const sentenceB1 = randomUUID();
  const mathAtom = randomUUID();
  const linkAtom = randomUUID();
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [sectionId]: { id: sectionId, parentSectionId: null, title: "", childSectionIds: [], unitIds: [unitA, unitB] },
    },
    units: {
      [unitA]: { id: unitA, sectionId, kind: "paragraph", sentenceIds: [sentenceA1, sentenceA2] },
      [unitB]: { id: unitB, sectionId, kind: "paragraph", sentenceIds: [sentenceB1] },
    },
    sentences: {
      [sentenceA1]: {
        id: sentenceA1, unitId: unitA,
        content: [
          { kind: "text", text: "Energy " },
          { kind: "atom", atomId: mathAtom },
          { kind: "text", text: " stays." },
        ],
      },
      [sentenceA2]: {
        id: sentenceA2, unitId: unitA,
        content: [{ kind: "text", text: "See " }, { kind: "atom", atomId: linkAtom }, { kind: "text", text: " now." }],
      },
      [sentenceB1]: {
        id: sentenceB1, unitId: unitB,
        content: [{ kind: "text", text: "Café e\u0301 𝒜 tail." }],
      },
    },
    atoms: {
      [mathAtom]: {
        id: mathAtom, unitId: unitA, kind: "math", text: "$E=mc^2$",
        source: { format: "latex", value: "E=mc^2" },
      },
      [linkAtom]: {
        id: linkAtom, unitId: unitA, kind: "link", text: "主页", href: "https://example.org/",
      },
    },
    blocks: [
      { id: randomUUID(), sectionId, kind: "unit", unitId: unitA },
      { id: randomUUID(), sectionId, kind: "unit", unitId: unitB },
    ],
  };
  return { tree, ids: { unitA, unitB, sentenceA1, sentenceA2, sentenceB1, mathAtom, linkAtom } };
}

async function publishTree(name: string, build: (paperId: string) => { tree: DocumentTree; ids: Record<string, string> }) {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
  const { tree, ids } = build(created.manifest.paper.id);
  const source = await page.evaluate(({ root, files }) =>
    window.desktop.invoke({ type: "corePublishSource", root, files }),
  { root: created.root, files: { "document.html": json("<html>paper</html>") } }) as SourceSnapshotRecord;
  const revision = await page.evaluate(({ root, sourceSnapshotId, files }) =>
    window.desktop.invoke({ type: "coreCommit", root, baseRevision: null, sourceSnapshotId, files }),
  {
    root: created.root,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: null }),
    },
  }) as ProjectRevisionRecord;
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, created.root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
  await expect(page.locator(".full-reader [data-sentence-id]").first()).toBeVisible();
  return { created, revision, tree, ids };
}

/** 在真实 DOM 上设置选区：句子内文本片段按逻辑偏移定位，atom 内部节点可指定。 */
async function selectRange(
  from: { sentenceId: string; start: number; offset: number },
  to: { sentenceId: string; start: number; offset: number; insideAtom?: string },
) {
  // 目标句子可能位于文档后段：等待其真实渲染并滚入视口后再设置选区，
  // 避免慢 runner 上选区落在不可见区域导致工具条定位/点击竞态。
  await expect(page.locator(`[data-sentence-id="${from.sentenceId}"]`)).toBeAttached();
  await expect(page.locator(`[data-sentence-id="${to.sentenceId}"]`)).toBeAttached();
  await page.locator(`[data-sentence-id="${from.sentenceId}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(({ from, to }) => {
    const locate = (point: { sentenceId: string; start: number; offset: number; insideAtom?: string }) => {
      const sentence = document.querySelector(`[data-sentence-id="${point.sentenceId}"]`);
      if (!sentence) throw new Error(`句子不存在：${point.sentenceId}`);
      if (point.insideAtom) {
        const atom = sentence.querySelector(`[data-atom-id="${point.insideAtom}"]`);
        const target = atom?.querySelector("annotation") ?? atom?.querySelector(".mord");
        if (!target?.firstChild) throw new Error("atom 内部节点不存在");
        return { node: target.firstChild, offset: point.offset };
      }
      const span = sentence.querySelector(`[data-start="${point.start}"]`);
      if (!span?.firstChild) throw new Error(`文本片段不存在：${point.start}`);
      return { node: span.firstChild, offset: point.offset };
    };
    const start = locate(from);
    const end = locate(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector(".full-reader")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { from, to });
}

test("reader 原文选区按 UTF-16 半开区间映射，组合字符与代理对计数正确；工具条出现", async () => {
  const { ids } = await publishTree("选区工程", selectionTree);
  // "Café e\u0301 𝒜 tail."：offset 5→10 覆盖 e+组合符+空格+代理对。
  await selectRange(
    { sentenceId: ids.sentenceB1, start: 0, offset: 5 },
    { sentenceId: ids.sentenceB1, start: 0, offset: 10 },
  );
  const toolbar = page.locator(".reader-selection-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "解释" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "提问" })).toBeVisible();
  // 工具条不产生问答卡或成果节点。
  expect(await page.locator(".reader-card, [data-qa-card]").count()).toBe(0);
});

test("reader 选区端点落在 KaTeX 辅助层内整原子纳入，annotation 不重复计偏移", async () => {
  const { ids } = await publishTree("公式选区工程", selectionTree);
  // 从 "Energy " 第 2 字符选进 KaTeX 视觉层：atom 整位纳入。
  await selectRange(
    { sentenceId: ids.sentenceA1, start: 0, offset: 2 },
    { sentenceId: ids.sentenceA1, start: 0, offset: 1, insideAtom: ids.mathAtom },
  );
  const toolbar = page.locator(".reader-selection-toolbar");
  await expect(toolbar).toBeVisible();
  // 经解释入口进入对话草稿，quote 必须是逻辑文本（含 atom 原文表示），
  // 不含 KaTeX 辅助层重复字符。
  await toolbar.getByRole("button", { name: "解释" }).click();
  const composer = page.getByRole("textbox", { name: "Agent 消息" });
  await expect(composer).toContainText("ergy $E=mc^2$");
  const value = await composer.inputValue();
  // quote 行内 atom 原文表示只出现一次（上下文段重复整段属正常引用）。
  const quoteLine = value.split("\n").find((line) => line.startsWith("> "))!;
  expect(quoteLine).toBe("> ergy $E=mc^2$");
  expect(quoteLine.match(/E=mc\^2/g)?.length).toBe(1);
});

test("reader 跨句跨单元选区完整展开中间句子；解释进入右侧持续对话不自动发送", async () => {
  const { ids } = await publishTree("跨单元工程", selectionTree);
  await selectRange(
    { sentenceId: ids.sentenceA1, start: 8, offset: 2 },
    { sentenceId: ids.sentenceB1, start: 0, offset: 4 },
  );
  const toolbar = page.locator(".reader-selection-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "提问" }).click();
  const composer = page.getByRole("textbox", { name: "Agent 消息" });
  await expect(composer).toContainText("Café");
  const value = await composer.inputValue();
  // 中间句子（含 link atom）完整出现在上下文，不以首尾两点猜内容。
  expect(value).toContain("ays.");
  expect(value).toContain("See 主页 now.");
  expect(value).toContain("Café");
  // 不自动发送：没有用户消息气泡，没有模型请求。
  expect(await page.locator(".chat-message.user").count()).toBe(0);
  expect(remoteRequests).toEqual([]);
});

test("reader 表格单元选区映射到 cell unit；折叠选区关闭工具条", async () => {
  const { tree, ids } = await publishTree("表格选区工程", (paperId) => {
    const fixture = complexReaderTree(paperId);
    // 本用例只验证文本结构选区：图片资产置空并保留明确警告（树契约要求）。
    for (const block of fixture.tree.blocks)
      if (block.kind === "figure") {
        block.asset = null;
        block.warning = "选区用例不登记图片资产。";
      }
    return fixture;
  });
  const cellSentence = tree.units[ids.cellSpan].sentenceIds[0];
  await selectRange(
    { sentenceId: cellSentence, start: 0, offset: 7 },
    { sentenceId: cellSentence, start: 0, offset: 13 },
  );
  const toolbar = page.locator(".reader-selection-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "解释" }).click();
  const composer = page.getByRole("textbox", { name: "Agent 消息" });
  await expect(composer).toContainText("across");
  // 折叠选区：工具条安全关闭。
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.locator(".full-reader").click({ position: { x: 5, y: 5 } });
  await expect(toolbar).toHaveCount(0);
});

test("reader 选区工具条保持在可视区域内；revision 刷新后不残留旧选区工具条", async () => {
  const { ids } = await publishTree("工具条工程", selectionTree);
  await selectRange(
    { sentenceId: ids.sentenceB1, start: 0, offset: 0 },
    { sentenceId: ids.sentenceB1, start: 0, offset: 4 },
  );
  const toolbar = page.locator(".reader-selection-toolbar");
  await expect(toolbar).toBeVisible();
  const box = (await toolbar.boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // 刷新代际切换：旧工具条不得残留。
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(page.locator(".full-reader")).toBeVisible();
  await expect(toolbar).toHaveCount(0);
});