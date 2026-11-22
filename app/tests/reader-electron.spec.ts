// 真实 Electron Full 阅读器回归（SPEC-reader Testing Strategy，paper-30min-qa3.1）：
// 生产 preload、project:command IPC、Node utility process 与真实临时 v2 工程；
// 正文只来自 current revision 的 document.json，资产经 paper30min 协议受管读取。
// 恶意内容用例记录全部网络请求与 pageerror，断言零远端副作用。
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { PNG as PngCodec } from "pngjs";
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
let desktopProcess: ReturnType<ElectronApplication["process"]>;
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
  desktopProcess = desktop.process();
  page = await desktop.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("paper30min://") && !url.startsWith("data:") && !url.startsWith("blob:"))
      remoteRequests.push(url);
  });
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
}

async function closeDesktopForCleanup() {
  if (!desktopProcess || desktopProcess.exitCode !== null || desktopProcess.signalCode !== null) return;
  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxSyncOptions;
      if (options.message !== "有未保存的文档，确定放弃编辑并关闭吗？" || options.buttons?.[1] !== "放弃并关闭")
        throw new Error("测试清理遇到非预期的原生确认框。");
      return 1;
    };
  });
  await desktop.close();
}

test.beforeEach(async () => {
  errors = [];
  remoteRequests = [];
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-reader-electron-"));
  await launch();
});

test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    // The sandbox is an exclusively created test directory, never a user-selected path.
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

const create = (name: string) => invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });

async function publishSource(root: string, files: Record<string, Uint8Array>, metadata?: Record<string, unknown>) {
  return page.evaluate(
    ({ root, files, metadata }) => window.desktop.invoke({ type: "corePublishSource", root, files, metadata }),
    { root, files, metadata },
  ) as Promise<SourceSnapshotRecord>;
}

async function commit(
  root: string,
  baseRevision: string | null,
  sourceSnapshotId: string,
  files: Record<string, Uint8Array>,
) {
  return page.evaluate(
    ({ root, baseRevision, sourceSnapshotId, files }) =>
      window.desktop.invoke({ type: "coreCommit", root, baseRevision, sourceSnapshotId, files }),
    { root, baseRevision, sourceSnapshotId, files },
  ) as Promise<ProjectRevisionRecord>;
}

// 真实可解码 PNG：隐藏窗口下 naturalWidth>0 才是资产真实加载的证据。
const pngImage = new PngCodec({ width: 8, height: 6 });
pngImage.data.fill(0x66);
const PNG = PngCodec.sync.write(pngImage);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#dde"/></svg>',
);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 复杂 fixture ＋真实资产字节：树内资产路径/摘要与登记文件一致。 */
function complexFiles(paperId: string) {
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
  const files: Record<string, Uint8Array> = {
    "document.json": json(tree),
    "source-base.json": json(tree),
    "tombstones.json": json([]),
    "changeset.json": json({ baseRevision: null }),
    [`assets/${pngHash}.png`]: new Uint8Array(PNG),
    [`assets/${svgHash}.svg`]: new Uint8Array(SVG),
  };
  return { tree, ids, files };
}

async function complexProject(name: string) {
  const created = await create(name);
  const paperId = created.manifest.paper.id;
  const source = await publishSource(
    created.root,
    {
      "document.html": new TextEncoder().encode("<html>paper</html>"),
    },
    { kind: "arxiv", canonicalId: "2401.00001v1", title: "Reading Energy", authors: ["Author, A."] },
  );
  const { tree, ids, files } = complexFiles(paperId);
  const revision = await commit(created.root, null, source.sourceSnapshotId, files);
  return { created, revision, tree, ids };
}

async function openFolder(root: string) {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
}

test("reader Full 正文经真实 Electron 渲染全部章节、公式、表格、图片、脚注与参考文献", async () => {
  const { created, ids } = await complexProject("全文工程");
  await openFolder(created.root);

  const reader = page.locator(".full-reader");
  await expect(reader).toBeVisible();
  // 来源标题与作者来自已验证快照元数据。
  await expect(reader.getByRole("heading", { level: 1 })).toHaveText("Reading Energy");
  await expect(reader.locator(".reader-authors")).toContainText("Author, A.");
  // 章节与附录标题全部出现，顺序正确。
  await expect(reader.getByRole("heading", { name: "2 方法" })).toBeVisible();
  await expect(reader.getByRole("heading", { name: "附录 A 证明" })).toBeVisible();
  // 摘要、脚注、参考文献单元按稳定 ID 锚定。
  await expect(reader.locator(`[data-unit-id="${ids.abstract}"]`)).toContainText("We study reading.");
  await expect(reader.locator(`[data-unit-id="${ids.footnote}"]`)).toContainText("Footnote body");
  await expect(reader.locator(`[data-unit-id="${ids.reference}"]`)).toContainText("Journal of Reading");
  // 行内与独立公式经 KaTeX 渲染；失败公式保留来源与诊断，不留空白。
  await expect(reader.locator(`[data-atom-id="${ids.inlineMath}"] .katex`)).toBeVisible();
  await expect(reader.locator(`[data-block-id="${ids.displayFormula}"] .katex`)).toBeVisible();
  const failed = reader.locator(`[data-block-id="${ids.failedFormula}"]`);
  await expect(failed.locator(".reader-formula-source")).toContainText("\\frac{1{");
  await expect(failed.locator(".reader-warning")).toBeVisible();
  // MathML 公式按消毒内容渲染。
  await expect(reader.locator(`[data-block-id="${ids.mathmlFormula}"] math`)).toBeVisible();
  // 表格：caption、跨度与单元锚点。
  const table = reader.locator(`[data-block-id="${ids.table}"]`);
  await expect(table.locator("caption")).toContainText("Table 1");
  await expect(table.locator(`[data-unit-id="${ids.cellSpan}"]`)).toHaveAttribute("rowspan", "2");
  await expect(table.locator(`[data-unit-id="${ids.cellValue}"]`)).toHaveAttribute("colspan", "2");
  // 图片：本地资产真实加载；缺图保留警告占位。
  const figure = reader.locator(`[data-block-id="${ids.figure}"] img`);
  await expect(figure).toBeVisible();
  await expect.poll(() => figure.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(reader.locator(`[data-block-id="${ids.figure}"] figcaption`)).toContainText("Figure 1");
  await expect(reader.locator(`[data-block-id="${ids.missingFigure}"] .reader-warning`)).toContainText(
    "来源图片未随快照保存",
  );
  // raw block：消毒 HTML、文本与结构限制可见。
  const raw = reader.locator(`[data-block-id="${ids.rawBlock}"]`);
  await expect(raw.locator("blockquote")).toContainText("Quoted source line.");
  await expect(raw.locator(".reader-raw-limit")).toContainText("白名单投影");
  // 代码样 raw 保留空白与顺序。
  await expect(reader.locator(`[data-block-id="${ids.codeRaw}"] pre`)).toContainText("return x + 1");
  await page.screenshot({ path: "test-results/reader-full.png", fullPage: false });
});

test("reader UI 保持正文排版并复用来源与修正控件语义基线", async () => {
  const { created } = await complexProject("阅读器 UI 基线工程");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await expect(reader).toBeVisible();

  const sourceToggle = reader.getByRole("button", { name: /^来源与诊断/ });
  await expect(sourceToggle).toHaveClass(/\bbutton secondary/);
  const tokens = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      probe.style.color = "";
      return value;
    };
    const result = { text: resolve("--text"), borderStrong: resolve("--border-strong") };
    probe.remove();
    return result;
  });
  await expect
    .poll(() =>
      reader.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          color: style.color,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          maxWidth: style.maxWidth,
        };
      }),
    )
    .toEqual({ color: tokens.text, fontSize: "15px", lineHeight: "26.25px", maxWidth: "860px" });
  await expect
    .poll(() => sourceToggle.evaluate((element) => getComputedStyle(element).borderTopColor))
    .toBe(tokens.borderStrong);

  await sourceToggle.click();
  const allFilter = page.getByRole("button", { name: /^全部 \d+$/ });
  await expect(allFilter).toHaveClass(/\bbutton/);
  await expect(allFilter).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".source-panel")).toBeVisible();

  const correctionEntry = reader.locator(".reader-correct-entry").first();
  await expect(correctionEntry).toHaveClass(/\bbutton/);
  await correctionEntry.click();
  const correction = page.locator(".correction-host");
  await expect(correction).toBeVisible();
  await expect(correction.locator(".correction-text")).toHaveClass(/ui-input/);
  await expect(correction.getByRole("button", { name: "预览 changeset", exact: true })).toHaveClass(/\bbutton primary/);
  await page.screenshot({ path: "test-results/ou7-reader-controls.png", animations: "disabled" });
});

test("reader 内部引用点击定位目标并聚焦；未解析引用保留文本与警告；外链走受控入口", async () => {
  const { created, ids } = await complexProject("引用工程");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");

  // 脚注引用 → 脚注单元：滚动进入视口并获得可辨识焦点。
  await reader.locator(`[data-atom-id="${ids.footnoteRef}"]`).click();
  const footnote = reader.locator(`[data-unit-id="${ids.footnote}"]`);
  await expect(footnote).toBeInViewport();
  await expect(footnote).toHaveClass(/reader-jump-target/);
  // 交叉引用 → 目标段落。
  await reader.locator(`[data-atom-id="${ids.resolvedRef}"]`).click();
  await expect(reader.locator(`[data-unit-id="${ids.target}"]`)).toBeInViewport();
  // 引文 → 参考文献。
  await reader.locator(`[data-atom-id="${ids.citation}"]`).click();
  await expect(reader.locator(`[data-unit-id="${ids.reference}"]`)).toBeInViewport();
  // 未解析引用：不可跳转，保留显示文本与警告。
  const unresolved = reader.locator(`[data-atom-id="${ids.unresolvedRef}"]`);
  await expect(unresolved).toContainText("Eq. (9)");
  await expect(unresolved.locator(".reader-warning")).toContainText("S3.E9");
  expect(await unresolved.evaluate((el) => el.tagName)).not.toBe("BUTTON");
  // 外链：受控系统打开入口，不在正文内嵌网页。
  let opened = "";
  await desktop.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      (globalThis as Record<string, unknown>).__opened = url;
    };
  });
  await reader.locator(`[data-atom-id="${ids.safeLink}"]`).click();
  opened = await desktop.evaluate(() => ((globalThis as Record<string, unknown>).__opened as string) ?? "");
  expect(opened).toBe("https://example.org/project");
});

test("reader 恶意内容零网络零脚本：危险链接、raw 注入与远端资源全部被隔离", async () => {
  const created = await create("恶意工程");
  const paperId = created.manifest.paper.id;
  const source = await publishSource(created.root, {
    "document.html": new TextEncoder().encode("<html>paper</html>"),
  });
  // 受损 current：磁盘 document.json 含危险协议 href，主进程读取校验拒绝。
  // 契约要求显示损坏/恢复状态，不渲染伪正文，也不执行任何内容。
  const sectionId = randomUUID();
  const unitId = randomUUID();
  const sentenceId = randomUUID();
  const linkAtom = randomUUID();
  const rawBlock = randomUUID();
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [sectionId]: { id: sectionId, parentSectionId: null, title: "", childSectionIds: [], unitIds: [unitId] },
    },
    units: { [unitId]: { id: unitId, sectionId, kind: "paragraph", sentenceIds: [sentenceId] } },
    sentences: {
      [sentenceId]: {
        id: sentenceId,
        unitId,
        content: [
          { kind: "text", text: "危险 " },
          { kind: "atom", atomId: linkAtom },
        ],
      },
    },
    atoms: {
      [linkAtom]: { id: linkAtom, unitId, kind: "link", text: "点我", href: "https://example.org/safe" },
    },
    blocks: [
      { id: randomUUID(), sectionId, kind: "unit", unitId },
      {
        id: rawBlock,
        sectionId,
        kind: "raw",
        html: "<p>safe</p>",
        text: "safe",
        limitations: ["受控投影"],
      },
    ],
  };
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const revision = await commit(created.root, null, source.sourceSnapshotId, {
    "document.json": json(tree),
    "source-base.json": json(tree),
    "tombstones.json": json([]),
    "changeset.json": json({ baseRevision: null }),
  });
  const evil = structuredClone(tree) as DocumentTree;
  const atom = evil.atoms[linkAtom];
  if (atom.kind !== "link") throw new Error("fixture 链接原子类型错误");
  atom.href = "javascript:window.__pwned=1";
  const evilBytes = Buffer.from(JSON.stringify(evil));
  const documentFile = path.join(created.root, revision.path, "document.json");
  await fs.writeFile(documentFile, evilBytes);
  const metaFile = path.join(created.root, ".paper30min", "revisions", revision.revisionId, "revision.json");
  const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
  const record = meta.files.find((file: { path: string }) => file.path === "document.json");
  record.sha256 = sha256(evilBytes);
  record.size = evilBytes.byteLength;
  await fs.writeFile(metaFile, JSON.stringify(meta));

  await openFolder(created.root);
  // 损坏状态可见，不渲染正文；零远端请求、零脚本执行。
  await expect(page.locator(".full-reader-empty[role='alert']")).toContainText("正文不可读");
  expect(await page.locator(".full-reader [data-block-id]").count()).toBe(0);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  expect(remoteRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("reader 受损 raw HTML 不渲染不执行：白名单拒绝后显示恢复状态，零网络零脚本", async () => {
  const { created, revision, ids } = await complexProject("消毒工程");
  // 受损字节绕过提交校验到达磁盘：raw html 换成脚本＋事件＋远端资源变体，
  // 重算登记摘要使字节校验通过；document-core 读取白名单必须拒绝，
  // 阅读器显示恢复状态而不是渲染或执行任何恶意内容。
  const documentFile = path.join(created.root, revision.path, "document.json");
  const tree = JSON.parse(await fs.readFile(documentFile, "utf8")) as DocumentTree;
  const raw = tree.blocks.find((block) => block.id === ids.rawBlock);
  if (raw?.kind !== "raw") throw new Error("fixture raw 块缺失");
  raw.html =
    "<p>safe</p><script>window.__pwned=1</script>" +
    '<img src="https://evil.example.org/track.png">' +
    '<iframe src="https://evil.example.org/frame"></iframe>' +
    '<p onclick="window.__pwned=2">click</p>';
  const evilBytes = Buffer.from(JSON.stringify(tree));
  await fs.writeFile(documentFile, evilBytes);
  const metaFile = path.join(created.root, ".paper30min", "revisions", revision.revisionId, "revision.json");
  const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
  const record = meta.files.find((file: { path: string }) => file.path === "document.json");
  record.sha256 = sha256(evilBytes);
  record.size = evilBytes.byteLength;
  await fs.writeFile(metaFile, JSON.stringify(meta));

  await openFolder(created.root);
  await expect(page.locator(".full-reader-empty[role='alert']")).toContainText("正文不可读");
  expect(await page.locator(".full-reader [data-block-id]").count()).toBe(0);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  expect(remoteRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("reader 宽表与长公式在自身容器滚动，窄窗格不产生整页横向溢出", async () => {
  const { created, ids } = await complexProject("溢出工程");
  await openFolder(created.root);
  const reader = page.locator(".full-reader");
  await expect(reader.locator(`[data-block-id="${ids.table}"]`)).toBeVisible();

  // 窄窗格：收起两侧栏并缩小窗口，正文容器不得横向溢出。
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await page.getByRole("button", { name: "收起 Agent", exact: true }).click();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 560, height: 780 }),
  );
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const mainOverflow = await page.locator(".main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(mainOverflow).toBe(true);
  // 长英文/CJK/组合字符段落完整可见（换行而非裁切）。
  await expect(reader.locator(`[data-unit-id="${ids.longUnit}"]`)).toContainText("代理对 𝒜");
  await page.screenshot({ path: "test-results/reader-narrow.png" });
});

test("reader current 为空显示导入恢复状态；重开后正文与阅读入口仍在", async () => {
  const created = await create("空工程");
  await openFolder(created.root);
  // current 为空：不渲染伪正文，显示导入状态。
  await expect(page.locator(".full-reader-empty")).toBeVisible();
  await expect(page.locator(".full-reader-empty")).toContainText("尚未");
  expect(await page.locator(".full-reader [data-block-id]").count()).toBe(0);

  // 提交 current 后刷新，正文可读。
  const paperId = created.manifest.paper.id;
  const source = await publishSource(created.root, {
    "document.html": new TextEncoder().encode("<html>paper</html>"),
  });
  const { files } = complexFiles(paperId);
  await commit(created.root, null, source.sourceSnapshotId, files);
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(page.locator(".full-reader")).toBeVisible();

  // 关闭重开：同一工程正文仍从 current 渲染。
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /^空工程/ }).click();
  await expect(page.locator(".full-reader")).toBeVisible();
  await expect(page.locator(".full-reader").getByRole("heading", { name: "2 方法" })).toBeVisible();
});
