// Full 阅读位置捕获与恢复（SPEC-reader §5，paper-30min-qa3.3）：
// 真实 Electron：滚动捕获→重开按锚点恢复（不用旧 scrollTop）；
// resize 以锚点重定位；revision removed 显式失效提示＋父 section 回退；
// moved 恢复原锚点；用户滚动后迟到恢复不得覆盖新位置。
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
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
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
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
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
}

test.beforeEach(async () => {
  errors = [];
  remoteRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reader-position-"));
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

/** 长文档 fixture：复杂树正文后追加足量段落，保证可滚动。 */
function longTree(paperId: string) {
  const { tree, ids } = complexReaderTree(paperId);
  for (const block of tree.blocks)
    if (block.kind === "figure") {
      block.asset = null;
      block.warning = "位置用例不登记图片资产。";
    }
  const filler: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const unitId = randomUUID();
    const sentenceId = randomUUID();
    tree.sentences[sentenceId] = {
      id: sentenceId,
      unitId,
      content: [{ kind: "text", text: `Filler paragraph ${index}. `.repeat(6) }],
    };
    tree.units[unitId] = { id: unitId, sectionId: ids.body, kind: "paragraph", sentenceIds: [sentenceId] };
    tree.sections[ids.body].unitIds.push(unitId);
    tree.blocks.push({ id: randomUUID(), sectionId: ids.body, kind: "unit", unitId });
    filler.push(unitId);
  }
  return { tree, ids, filler };
}

async function publish(name: string) {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
  const { tree, ids, filler } = longTree(created.manifest.paper.id);
  const source = (await page.evaluate(
    ({ root, files }) => window.desktop.invoke({ type: "corePublishSource", root, files }),
    { root: created.root, files: { "document.html": json("<html>paper</html>") } },
  )) as SourceSnapshotRecord;
  const revision = (await page.evaluate(
    ({ root, sourceSnapshotId, files }) =>
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
    },
  )) as ProjectRevisionRecord;
  await openFolder(created.root);
  return { created, revision, tree, ids, filler };
}

async function openFolder(root: string) {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
  await expect(page.locator(".full-reader [data-sentence-id]").first()).toBeVisible();
}

/** 提交新 revision（changeset 占位由工程进程按树差异生成）。 */
async function commitNext(root: string, base: ProjectRevisionRecord, tree: DocumentTree, tombstones: unknown[] = []) {
  return page.evaluate(
    ({ root, baseRevision, sourceSnapshotId, files }) =>
      window.desktop.invoke({ type: "coreCommit", root, baseRevision, sourceSnapshotId, files }),
    {
      root,
      baseRevision: base.revisionId,
      sourceSnapshotId: base.sourceSnapshotId,
      files: {
        "document.json": json(tree),
        "source-base.json": json(tree),
        "tombstones.json": json(tombstones),
        "changeset.json": json({ baseRevision: base.revisionId }),
      },
    },
  ) as Promise<ProjectRevisionRecord>;
}

const scrollTop = () => page.locator(".main").evaluate((element) => element.scrollTop);

async function scrollToUnit(unitId: string) {
  // 布局未稳定（字体/公式度量）时一次 scrollTo 可能被钳制或随后漂移：
  // 重复对齐直到目标真的落在容器顶部附近，再等捕获防抖落盘。
  const target = page.locator(`.full-reader [data-unit-id="${unitId}"]`);
  await expect(target).toBeAttached();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const settled = await target.evaluate((element) => {
      const container = document.querySelector(".main")!;
      const rect = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (Math.abs(rect) > 2) {
        container.scrollTo({ top: container.scrollTop + rect, behavior: "instant" });
        return false;
      }
      return container.scrollTop > 0;
    });
    if (settled) break;
    await page.waitForTimeout(100);
  }
  // 前置条件必须成立：目标落顶（或尾部钳制）且已离开文首，否则显式失败。
  const geometry = await target.evaluate((element) => {
    const container = document.querySelector(".main")!;
    return {
      rect: element.getBoundingClientRect().top - container.getBoundingClientRect().top,
      top: container.scrollTop,
      max: container.scrollHeight - container.clientHeight,
    };
  });
  expect(Math.abs(geometry.rect) <= 2 || (geometry.top >= geometry.max - 2 && geometry.rect > 0)).toBe(true);
  expect(geometry.top).toBeGreaterThan(0);
  // 等待捕获防抖落盘。
  await page.waitForTimeout(400);
}

test("reader 滚动位置按锚点捕获，重开后恢复到同一单元而非旧 scrollTop", async () => {
  const { created, filler } = await publish("位置重开工程");
  const target = filler[20];
  await scrollToUnit(target);
  const before = await scrollTop();
  expect(before).toBeGreaterThan(0);
  // 持久化文件携带逻辑锚点（不是像素权威）。
  const reading = JSON.parse(await fs.readFile(path.join(created.root, ".paper30min-reading.json"), "utf8")) as {
    reader?: Record<string, { anchor: { kind: string; unitId?: string }; scrollTop: number }>;
  };
  expect(reading.reader?.paper?.anchor).toEqual({ kind: "unit", unitId: target });

  // 回到所有工程再重开：FullReader 卸载（卸载捕获落盘）后重新挂载恢复。
  await page.getByRole("button", { name: "所有工程" }).click();
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, created.root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
  await expect(page.locator(".full-reader [data-sentence-id]").first()).toBeVisible();
  const unitRect = () =>
    page.locator(`.full-reader [data-unit-id="${target}"]`).evaluate((element) => {
      const container = document.querySelector(".main")!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
  // 目标单元回到视口顶部附近（±40px 容差），不是文首；恢复窗口含布局兜底。
  await expect.poll(async () => Math.abs(await unitRect()), { timeout: 10000 }).toBeLessThan(40);
  expect(await scrollTop()).toBeGreaterThan(0);
});

test("reader resize 后以当前锚点重定位，不追求旧绝对像素", async () => {
  const { filler } = await publish("位置缩放工程");
  const target = filler[25];
  await scrollToUnit(target);
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: size.width, height: Math.max(300, size.height - 220) });
  const unitRect = () =>
    page.locator(`.full-reader [data-unit-id="${target}"]`).evaluate((element) => {
      const container = document.querySelector(".main")!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
  await expect.poll(async () => Math.abs(await unitRect()), { timeout: 10000 }).toBeLessThan(60);
});

test("reader revision 删除目标单元：显式失效提示＋摘录＋回到父 section，不静默重挂", async () => {
  const { created, revision, tree, ids, filler } = await publish("位置删除工程");
  const target = filler[20];
  await scrollToUnit(target);
  // 删除目标单元（含句子/块）；相似文本的相邻 filler 仍在。
  const next = structuredClone(tree);
  const unit = next.units[target];
  for (const sentenceId of unit.sentenceIds) delete next.sentences[sentenceId];
  delete next.units[target];
  next.sections[ids.body].unitIds = next.sections[ids.body].unitIds.filter((id) => id !== target);
  next.blocks = next.blocks.filter((b) => !(b.kind === "unit" && b.unitId === target));
  const tombstones = [
    {
      nodeType: "unit",
      nodeId: target,
      lastRevision: revision.revisionId,
      excerpt: "Filler paragraph 20.",
      reason: "removed",
    },
  ];
  const nextRevision = await commitNext(created.root, revision, next, tombstones);
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(page.locator(".full-reader")).toHaveAttribute("data-revision-id", nextRevision.revisionId);
  const notice = page.locator(".reader-position-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("原阅读位置已失效");
  await expect(notice.locator(".reader-position-excerpt")).toContainText("Filler paragraph 20");
  // 回退到父 section（body 无标题，回退表现为文首区域），不挂到相似 filler。
  await expect.poll(scrollTop, { timeout: 8000 }).toBeLessThan(200);
  expect(await page.locator(`.full-reader [data-unit-id="${target}"]`).count()).toBe(0);
});

test("reader revision 移动目标单元（moved）：仍恢复原锚点", async () => {
  const { created, revision, tree, filler } = await publish("位置移动工程");
  const target = filler[15];
  await scrollToUnit(target);
  // 在目标前插入新单元：目标 moved，身份不变。
  const next = structuredClone(tree);
  const unitId = randomUUID();
  const sentenceId = randomUUID();
  next.sentences[sentenceId] = {
    id: sentenceId,
    unitId,
    content: [{ kind: "text", text: "Inserted lead. ".repeat(10) }],
  };
  next.units[unitId] = {
    id: unitId,
    sectionId: tree.blocks[0].sectionId,
    kind: "paragraph",
    sentenceIds: [sentenceId],
  };
  next.sections[tree.blocks[0].sectionId].unitIds.unshift(unitId);
  next.blocks.unshift({ id: randomUUID(), sectionId: tree.blocks[0].sectionId, kind: "unit", unitId });
  const nextRevision = await commitNext(created.root, revision, next);
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(page.locator(".full-reader")).toHaveAttribute("data-revision-id", nextRevision.revisionId);
  // 恢复窗口含字体/公式度量漂移的兜底核对（最长 8s）：轮询直到几何稳定，
  // 窗口覆盖整个恢复期，避免慢 runner 上采样落在对齐之前。
  await expect(page.locator(".reader-position-notice")).toHaveCount(0);
  let geometry = { rect: Number.NaN, scrollTop: 0, maxScroll: 0 };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(500);
    geometry = await page.locator(`.full-reader [data-unit-id="${target}"]`).evaluate((element) => {
      const container = document.querySelector(".main") as HTMLElement;
      const rect = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
      return { rect, scrollTop: container.scrollTop, maxScroll: container.scrollHeight - container.clientHeight };
    });
    const atTop = Math.abs(geometry.rect) < 60;
    const clampedAtEnd = geometry.scrollTop >= geometry.maxScroll - 2 && geometry.rect > 0;
    if (atTop || clampedAtEnd) break;
  }
  // 目标单元身份不变且被恢复到视口顶部附近；若锚点偏移落在滚动尾部
  // 不可达区域，则停在最大可滚动位置（浏览器钳制），不得回到文首。
  const atTop = Math.abs(geometry.rect) < 60;
  const clampedAtEnd = geometry.scrollTop >= geometry.maxScroll - 2 && geometry.rect > 0;
  expect(atTop || clampedAtEnd).toBe(true);
  expect(geometry.scrollTop).toBeGreaterThan(0);
});

test("reader 用户滚动后迟到的恢复结果不覆盖新位置", async () => {
  const { filler } = await publish("位置抢占工程");
  const target = filler[20];
  await scrollToUnit(target);
  // 刷新触发恢复流程；等待恢复把目标带回视口后再真实滚轮向上滚动，
  // 迟到恢复必须让位（避免滚轮落在恢复对齐之前被覆盖的竞态）。
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(page.locator(`.full-reader [data-unit-id="${target}"]`)).toBeInViewport({ timeout: 15000 });
  const box = (await page.locator(".main").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // 真实用户输入优先：滚轮（重发防丢帧）→ 键盘 Home。
  // 离屏 runner 输入管线可能整段不派发（CI trace 证实 wheel/keydown 均无事件）：
  // 显式降级为主线程滚动＋合成 wheel 事件驱动产品用户意图路径，附件记录降级。
  await page.locator(".main").evaluate((container) => {
    let count = 0;
    const record = () => {
      count += 1;
      container.dataset.readerInputEventCount = String(count);
    };
    container.addEventListener("wheel", record);
    container.addEventListener("scroll", record);
    window.addEventListener("keydown", record);
  });
  const inputEventCount = async () =>
    Number((await page.locator(".main").getAttribute("data-reader-input-event-count")) ?? 0);
  let mode = "wheel";
  let reached = false;
  for (let attempt = 0; attempt < 3 && !reached; attempt += 1) {
    const before = await inputEventCount();
    await page.mouse.wheel(0, -100000);
    try {
      await expect.poll(scrollTop, { timeout: 1500 }).toBe(0);
      await expect.poll(inputEventCount, { timeout: 500 }).toBeGreaterThan(before);
      reached = true;
    } catch {
      /* 重发滚轮 */
    }
  }
  if (!reached) {
    mode = "keyboard";
    await page.locator(".main").click({ position: { x: 10, y: 10 } });
    const before = await inputEventCount();
    await page.keyboard.press("Home");
    try {
      await expect.poll(scrollTop, { timeout: 3000 }).toBe(0);
      await expect.poll(inputEventCount, { timeout: 500 }).toBeGreaterThan(before);
      reached = true;
    } catch {
      /* 降级 */
    }
  }
  if (!reached) {
    mode = "synthetic-fallback";
    await page.locator(".main").evaluate((container) => {
      container.scrollTo({ top: 0, behavior: "instant" });
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100000, bubbles: true }));
    });
    await expect.poll(scrollTop, { timeout: 3000 }).toBe(0);
  }
  await test.info().attach("user-input-mode", { body: Buffer.from(mode), contentType: "text/plain" });
  // 用户意图成立后，恢复窗口内的兜底核对不得把位置拉回。
  await page.waitForTimeout(1200);
  expect(await scrollTop()).toBe(0);
});

test("reader 恢复窗口内点击交叉引用：定位目标不被兜底核对拉回旧锚点", async () => {
  const { ids, filler } = await publish("恢复期导航工程");
  const target = filler[20];
  await scrollToUnit(target);
  // 刷新触发 8s 恢复窗口；窗口内真实点击交叉引用跳转到前文目标。
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(page.locator(`.full-reader [data-unit-id="${target}"]`)).toBeInViewport({ timeout: 15000 });
  await page.locator(`.full-reader [data-atom-id="${ids.resolvedRef}"]`).click();
  const jumpTarget = page.locator(`.full-reader [data-unit-id="${ids.target}"]`);
  await expect(jumpTarget).toBeInViewport();
  // 跨过多个兜底核对周期（400ms interval）：导航结果必须保持。
  await page.waitForTimeout(1500);
  await expect(jumpTarget).toBeInViewport();
  const rect = await jumpTarget.evaluate((element) => {
    const container = document.querySelector(".main")!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  expect(Math.abs(rect)).toBeLessThan(120);
});
