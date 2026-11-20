// 原文修正宿主真实 Electron 回归（SPEC-reader §8，paper-30min-qa3.4）：
// 默认只读、显式单元修正、atom 受保护占位、changeset 预览、草稿取消与基线保护；
// 发布经生产 IPC 重放同一命令，current 原子推进，source-base 不含本地修正。
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
import { randomUUID } from "node:crypto";
import type {
  CoreCommand,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
  SourceSnapshotRecord,
} from "../src/shared/contracts";
import type { DocumentTree } from "../src/shared/document/tree";
import { unitEditText } from "../src/shared/document/correction";

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
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
  desktopProcess = desktop.process();
  page = await desktop.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("paper30min://") && !url.startsWith("data:") && !url.startsWith("blob:"))
      remoteRequests.push(url);
  });
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible();
}

async function closeDesktopForCleanup() {
  if (
    !desktopProcess ||
    desktopProcess.exitCode !== null ||
    desktopProcess.signalCode !== null
  ) return;
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxSyncOptions;
      if (
        options.message !== "有未保存的文档，确定放弃编辑并关闭吗？" ||
        options.buttons?.[1] !== "放弃并关闭"
      ) throw new Error("测试清理遇到非预期的原生确认框。");
      return 1;
    };
  });
  await desktop.close();
}

test.beforeEach(async () => {
  errors = [];
  remoteRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reader-correction-"));
  await launch();
});

test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

/** 简单两单元工程：第一段含行内公式 atom，第二段纯文本。 */
function correctionTree(paperId: string) {
  const section = randomUUID();
  const unitA = randomUUID();
  const unitB = randomUUID();
  const sentenceA = randomUUID();
  const sentenceB = randomUUID();
  const atom = randomUUID();
  const blockA = randomUUID();
  const blockB = randomUUID();
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [section]: { id: section, parentSectionId: null, title: "正文", childSectionIds: [], unitIds: [unitA, unitB] },
    },
    units: {
      [unitA]: { id: unitA, sectionId: section, kind: "paragraph", sentenceIds: [sentenceA] },
      [unitB]: { id: unitB, sectionId: section, kind: "paragraph", sentenceIds: [sentenceB] },
    },
    sentences: {
      [sentenceA]: {
        id: sentenceA, unitId: unitA,
        content: [
          { kind: "text", text: "Energy equals " },
          { kind: "atom", atomId: atom },
          { kind: "text", text: " in this study." },
        ],
      },
      [sentenceB]: {
        id: sentenceB, unitId: unitB,
        content: [{ kind: "text", text: "Second paragraph stays plain." }],
      },
    },
    atoms: {
      [atom]: { id: atom, unitId: unitA, kind: "math", text: "E=mc²", source: { format: "latex", value: "E=mc^2" } },
    },
    blocks: [
      { id: blockA, sectionId: section, kind: "unit", unitId: unitA },
      { id: blockB, sectionId: section, kind: "unit", unitId: unitB },
    ],
  };
  return { tree, ids: { section, unitA, unitB, sentenceA, sentenceB, atom, blockA, blockB } };
}

async function correctionProject(name: string) {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
  const { tree, ids } = correctionTree(created.manifest.paper.id);
  const source = await page.evaluate<SourceSnapshotRecord, { root: string }>(({ root }) =>
    window.desktop.invoke({
      type: "corePublishSource",
      root,
      files: { "document.html": new TextEncoder().encode("<html>paper</html>") },
      metadata: { kind: "arxiv", canonicalId: "2401.00002v1", title: "Correction Study" },
    }), { root: created.root });
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const revision = await page.evaluate<ProjectRevisionRecord, { root: string; sourceSnapshotId: string; files: Record<string, Uint8Array> }>(({ root, sourceSnapshotId, files }) =>
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
  });
  return { created, revision, tree, ids, source };
}

async function openFolder(root: string) {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
}

test("reader 默认只读：显式修正入口编辑单元，预览 changeset 后发布新 revision", async () => {
  const { created, ids, tree, revision } = await correctionProject("单元修正");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await expect(reader).toBeVisible();
  // 默认只读：没有 contentEditable 正文。
  expect(await reader.locator("[contenteditable]").count()).toBe(0);
  const unit = reader.locator(`[data-unit-id="${ids.unitA}"]`);
  await unit.getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  await expect(host).toBeVisible();
  const textarea = host.locator(".correction-text");
  const original = unitEditText(tree, ids.unitA);
  await expect(textarea).toHaveValue(original);
  // 修改文字但保留 atom 占位。
  await textarea.fill(original.replace("in this study.", "in this corrected study."));
  await host.getByRole("button", { name: "预览 changeset" }).click();
  const preview = host.locator(".correction-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("内容变化");
  // 预览不推进 current：仍等于初始 revision。
  const before = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  expect(before.currentRevision?.revisionId).toBe(revision.revisionId);
  await host.getByRole("button", { name: "确认发布新 revision" }).click();
  await expect(host).toHaveCount(0);
  await expect(reader.locator(`[data-unit-id="${ids.unitA}"]`)).toContainText("in this corrected study.");
  const after = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  expect(after.currentRevision?.revisionId).not.toBe(before.currentRevision?.revisionId);
  // atom 保留：KaTeX 仍渲染，ID 不变。
  await expect(reader.locator(`[data-atom-id="${ids.atom}"] .katex`)).toBeVisible();
  // source-base 不含本地修正。
  const sourceBase = await invoke<DocumentTree>({
    type: "coreReadDocument", root: created.root,
    revisionId: after.currentRevision!.revisionId, tree: "source-base",
  });
  expect(unitEditText(sourceBase, ids.unitA)).toBe(original);
  await page.screenshot({ path: "test-results/reader-correction-published.png", fullPage: false });
});

test("reader 修正文本丢失 atom 占位被拒绝；草稿保留，取消不修改 current", async () => {
  const { created, ids, revision } = await correctionProject("占位保护");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  const unit = reader.locator(`[data-unit-id="${ids.unitA}"]`);
  await unit.getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  await host.locator(".correction-text").fill("No placeholder at all.");
  await host.getByRole("button", { name: "预览 changeset" }).click();
  await expect(host.locator(".correction-error")).toContainText("占位");
  // current 未变。
  const current = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  expect(current.currentRevision?.revisionId).toBe(revision.revisionId);
  // 取消修正：草稿清空，正文仍是原文。
  await host.getByRole("button", { name: "取消修正" }).click();
  await expect(host).toHaveCount(0);
  await expect(unit).toContainText("in this study.");
  const afterCancel = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  expect(afterCancel.currentRevision?.revisionId).toBe(revision.revisionId);
});

test("reader atom 单独修正入口：同类型内容修正保留 ID，类型不可在编辑器改变", async () => {
  const { created, ids } = await correctionProject("原子修正");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.locator(`[data-unit-id="${ids.unitA}"]`).getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  await host.locator(".correction-atom-row").getByRole("button", { name: "修正原子" }).click();
  const editor = host.locator(".correction-atom-editor");
  await expect(editor).toContainText("类型不可在此改变");
  await editor.locator("textarea").fill("E=mc^3");
  await editor.getByRole("button", { name: "保存原子修正" }).click();
  await host.getByRole("button", { name: "预览 changeset" }).click();
  await expect(host.locator(".correction-preview")).toBeVisible();
  await host.getByRole("button", { name: "确认发布新 revision" }).click();
  await expect(host).toHaveCount(0);
  // atom ID 保留，来源表示已更新。
  const atom = reader.locator(`[data-atom-id="${ids.atom}"]`);
  await expect(atom).toBeVisible();
  const current = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  const document = await invoke<DocumentTree>({
    type: "coreReadDocument", root: created.root,
    revisionId: current.currentRevision!.revisionId, tree: "document",
  });
  expect(document.atoms[ids.atom]).toMatchObject({
    kind: "math", source: { format: "latex", value: "E=mc^3" },
  });
});

test("reader 基线被外部推进后修正发布被拒绝，草稿保留且正文仍可读", async () => {
  const { created, ids, revision, source, tree } = await correctionProject("基线竞争");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.locator(`[data-unit-id="${ids.unitB}"]`).getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  await host.locator(".correction-text").fill("Second paragraph edited locally.");
  await host.getByRole("button", { name: "预览 changeset" }).click();
  await expect(host.locator(".correction-preview")).toBeVisible();
  // 另一操作经 IPC 推进 current（模拟外部更新）。
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const advanced = await page.evaluate<ProjectRevisionRecord, { root: string; baseRevision: string; sourceSnapshotId: string; files: Record<string, Uint8Array> }>(({ root, baseRevision, sourceSnapshotId, files }) =>
    window.desktop.invoke({ type: "coreCommit", root, baseRevision, sourceSnapshotId, files }),
  {
    root: created.root,
    baseRevision: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree),
      "source-base.json": json(tree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  // 等待 reader 按新 current 完成重读（watchProject → epoch 刷新）：
  // 修正宿主检测到基线变化后主动禁止发布并保留草稿（SPEC §8.6）。
  await expect(reader).toHaveAttribute("data-revision-id", advanced.revisionId, { timeout: 15000 });
  await expect(host.getByRole("button", { name: "确认发布新 revision" })).toBeDisabled();
  await expect(host.locator(".correction-error").filter({ hasText: "基线已变化" })).toBeVisible();
  // 草稿保留：文本仍在编辑器中；current 是外部推进的结果。
  await expect(host.locator(".correction-text")).toHaveValue("Second paragraph edited locally.");
  const current = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  expect(current.currentRevision?.revisionId).toBe(advanced.revisionId);
  await expect(reader.locator(`[data-unit-id="${ids.unitB}"]`)).toContainText("Second paragraph stays plain.");
});

test("reader 删除单元经预览发布：旧锚点退役，正文其余单元不受影响", async () => {
  const { created, ids } = await correctionProject("删除单元");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.locator(`[data-unit-id="${ids.unitB}"]`).getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  await host.getByRole("button", { name: "删除该单元" }).click();
  await expect(host.locator(".correction-pending")).toContainText("unit-delete");
  await host.getByRole("button", { name: "预览 changeset" }).click();
  await expect(host.locator(".correction-preview")).toContainText("删除");
  await expect(host.locator(".correction-removed-note")).toContainText("tombstone");
  await host.getByRole("button", { name: "确认发布新 revision" }).click();
  await expect(host).toHaveCount(0);
  await expect(reader.locator(`[data-unit-id="${ids.unitB}"]`)).toHaveCount(0);
  await expect(reader.locator(`[data-unit-id="${ids.unitA}"]`)).toContainText("Energy equals");
  const current = await invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: created.root });
  const context = await invoke<{ tombstones: Array<{ nodeId: string }> }>({
    type: "coreReadRevisionContext", root: created.root, revisionId: current.currentRevision!.revisionId,
  });
  expect(context.tombstones.some((entry) => entry.nodeId === ids.unitB)).toBe(true);
});

test("reader 切换修正目标不串草稿：B 单元不会收到 A 的编辑", async () => {
  const { created, ids } = await correctionProject("目标切换");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  // 在 A 上编辑但不发布。
  await reader.locator(`[data-unit-id="${ids.unitA}"]`).getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  await host.locator(".correction-text").fill("Draft meant for unit A only.");
  // 直接切换到 B：宿主按目标重挂载，B 显示自己的原文而非 A 的草稿。
  await reader.locator(`[data-unit-id="${ids.unitB}"]`).getByRole("button", { name: /修正单元/ }).click();
  await expect(host.locator(".correction-text")).toHaveValue("Second paragraph stays plain.");
  await expect(host.locator(".correction-text")).not.toHaveValue("Draft meant for unit A only.");
});

test("reader 先改字再拆分/删除可预览发布：结构命令以中间文本为预期", async () => {
  const { created, ids } = await correctionProject("改字再拆分");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.locator(`[data-unit-id="${ids.unitB}"]`).getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  // 先编辑文字，再用空行拆成两段。
  await host.locator(".correction-text").fill("First edited part.\n\nSecond edited part.");
  await host.getByRole("button", { name: "按空行拆分为多单元" }).click();
  await expect(host.locator(".correction-pending")).toContainText("unit-split");
  await host.getByRole("button", { name: "预览 changeset" }).click();
  await expect(host.locator(".correction-preview")).toBeVisible();
  await expect(host.locator(".correction-error")).toHaveCount(0);
  await host.getByRole("button", { name: "确认发布新 revision" }).click();
  await expect(host).toHaveCount(0);
  await expect(reader).toContainText("First edited part.");
  await expect(reader).toContainText("Second edited part.");
});

test("reader 外部推进发生在预览之前：草稿仍保留，基线变化禁止发布", async () => {
  const { created, ids, revision, source, tree } = await correctionProject("预览前推进");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.locator(`[data-unit-id="${ids.unitB}"]`).getByRole("button", { name: /修正单元/ }).click();
  const host = reader.locator(".correction-host");
  // 只编辑、不预览。
  await host.locator(".correction-text").fill("Edited before any preview.");
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const advanced = await page.evaluate<ProjectRevisionRecord, { root: string; baseRevision: string; sourceSnapshotId: string; files: Record<string, Uint8Array> }>(({ root, baseRevision, sourceSnapshotId, files }) =>
    window.desktop.invoke({ type: "coreCommit", root, baseRevision, sourceSnapshotId, files }),
  {
    root: created.root, baseRevision: revision.revisionId, sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(tree), "source-base.json": json(tree),
      "tombstones.json": json([]), "changeset.json": json({ baseRevision: revision.revisionId }),
    },
  });
  await expect(reader).toHaveAttribute("data-revision-id", advanced.revisionId, { timeout: 15000 });
  // 草稿文本保留，发布被禁止。
  await expect(host.locator(".correction-text")).toHaveValue("Edited before any preview.");
  await expect(host.getByRole("button", { name: "确认发布新 revision" })).toBeDisabled();
  await expect(host.locator(".correction-error").filter({ hasText: "基线已变化" })).toBeVisible();
});
