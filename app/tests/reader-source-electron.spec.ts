// 来源诊断面板真实 Electron 回归（SPEC-reader §7，paper-30min-qa3.4）：
// 非评分化事实、锚定诊断筛选与定位、核验四态；诊断不阻塞阅读与选区入口。
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { expectAppReady } from "./electron-launch";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PNG as PngCodec } from "pngjs";
import type {
  CoreCommand,
  ProjectCoreSnapshot,
  ProjectRevisionRecord,
  SourceSnapshotRecord,
} from "../src/shared/contracts";
import { complexReaderTree } from "./fixtures/reader/complex-document";

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
  await expectAppReady(page);
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
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reader-source-"));
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

const pngImage = new PngCodec({ width: 8, height: 6 });
pngImage.data.fill(0x66);
const PNG = PngCodec.sync.write(pngImage);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#dde"/></svg>',
);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function complexProject(name: string) {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
  const paperId = created.manifest.paper.id;
  const source = await page.evaluate<SourceSnapshotRecord, { root: string }>(({ root }) =>
    window.desktop.invoke({
      type: "corePublishSource",
      root,
      files: { "document.html": new TextEncoder().encode("<html>paper</html>") },
      metadata: {
        kind: "arxiv",
        baseId: "2401.00001",
        version: 1,
        canonicalId: "2401.00001v1",
        title: "Reading Energy",
        authors: ["Author, A."],
        fetchedAt: "2026-11-01T00:00:00.000Z",
        warnings: [{
          code: "arxiv-asset-missing",
          severity: "warning",
          stage: "fetch",
          messageKey: "arxiv.fetch.assetMissing",
          sourceAlias: "S2.F3",
        }],
      },
    }), { root: created.root });
  const { tree, ids } = complexReaderTree(paperId);
  const pngHash = sha256(PNG);
  const svgHash = sha256(SVG);
  for (const block of tree.blocks) {
    if (block.kind !== "figure" || !block.asset) continue;
    const [bytes, mime] = block.asset.mime === "image/png" ? [PNG, "image/png"] : [SVG, "image/svg+xml"];
    const hash = sha256(bytes);
    block.asset = { path: `assets/${hash}.${mime === "image/png" ? "png" : "svg"}`, sha256: hash, mime };
  }
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
      [`assets/${pngHash}.png`]: new Uint8Array(PNG),
      [`assets/${svgHash}.svg`]: new Uint8Array(SVG),
    },
  });
  return { created, revision, tree, ids };
}

async function openFolder(root: string) {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
}

test("reader 来源面板展示固定版本事实与来源警告，不出现评分化结论", async () => {
  const { created } = await complexProject("来源事实");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await expect(reader).toBeVisible();
  await reader.getByRole("button", { name: /来源与诊断/ }).click();
  const panel = reader.locator(".source-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("2401.00001v1");
  await expect(panel).toContainText("2026-11-01T00:00:00.000Z");
  await expect(panel).toContainText("arxiv-asset-missing");
  await expect(panel).toContainText("arxiv.fetch.assetMissing");
  // 非评分化：不出现质量分数或“全文已验证”式结论。
  await expect(panel).not.toContainText("正确率");
  await expect(panel).not.toContainText("质量优秀");
  await expect(panel).not.toContainText("全文已验证");
  await page.screenshot({ path: "test-results/reader-source-panel.png", fullPage: false });
});

test("reader 正文诊断按代码筛选并定位受影响块；阅读与选区入口不受阻塞", async () => {
  const { created, ids } = await complexProject("诊断定位");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.getByRole("button", { name: /来源与诊断/ }).click();
  const panel = reader.locator(".source-panel");
  // 缺图、未解析引用、raw 限制与公式失败都在诊断汇总中。
  await expect(panel).toContainText("figure-missing");
  await expect(panel).toContainText("reference-unresolved");
  await expect(panel).toContainText("raw-limited");
  await expect(panel).toContainText("formula-render-failed");
  // 筛选缺图诊断：只剩受影响块条目。
  await panel.locator(".source-filter").getByRole("button", { name: /figure-missing/ }).click();
  const items = panel.locator(".source-diagnostics li");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("来源图片未随快照保存");
  // 点击诊断定位到缺图块并聚焦。
  await items.first().locator("button").click();
  const missing = reader.locator(`[data-block-id="${ids.missingFigure}"]`);
  await expect(missing).toBeInViewport();
  await expect(missing).toHaveClass(/reader-jump-target/);
  // 诊断不阻塞阅读：正文仍在，选区工具条入口可用。
  await expect(reader.locator(`[data-unit-id="${ids.abstract}"]`)).toContainText("We study reading.");
  const abstract = reader.locator(`[data-unit-id="${ids.abstract}"]`);
  await abstract.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(reader.locator(".reader-selection-toolbar")).toBeVisible();
});

test("reader 无核验记录时面板如实显示无记录，不伪造已验证状态", async () => {
  const { created } = await complexProject("无核验");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await reader.getByRole("button", { name: /来源与诊断/ }).click();
  const panel = reader.locator(".source-panel");
  await expect(panel).toContainText("无核验记录");
  await expect(panel.locator(".source-verification-unrecorded")).toBeVisible();
  await expect(panel).toContainText("不代表全文质量结论");
});
