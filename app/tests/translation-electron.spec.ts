// 真实 Electron 翻译回归（SPEC-translation Testing Strategy，paper-30min-crd.2/crd.3）：
// 生产 preload、project:command IPC、Node utility process 与真实临时 v2 工程；
// 受控回环模型服务驱动按需启动、渐进阅读、语言切换不 reload、离线重开、
// 正文修正后的局部 stale 对照与显式更新。
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  AgentSettings,
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
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-electron-"));
  await launch();
});

test.afterEach(async () => {
  try {
    expect(errors).toEqual([]);
  } finally {
    await closeDesktopForCleanup();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

function invoke<T>(command: CoreCommand): Promise<T> {
  return page.evaluate((c) => window.desktop.invoke(c), command) as Promise<T>;
}

/** 两个英文单元的真实树：摘要＋正文段落，各一句。 */
function englishTree(paperId: string) {
  const ids = {
    section: randomUUID(),
    abstract: randomUUID(),
    abstractSentence: randomUUID(),
    body: randomUUID(),
    bodySentence: randomUUID(),
  };
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [ids.section]: {
        id: ids.section,
        parentSectionId: null,
        title: "1 Introduction",
        childSectionIds: [],
        unitIds: [ids.abstract, ids.body],
      },
    },
    units: {
      [ids.abstract]: {
        id: ids.abstract,
        sectionId: ids.section,
        kind: "abstract",
        sentenceIds: [ids.abstractSentence],
      },
      [ids.body]: { id: ids.body, sectionId: ids.section, kind: "paragraph", sentenceIds: [ids.bodySentence] },
    },
    sentences: {
      [ids.abstractSentence]: {
        id: ids.abstractSentence,
        unitId: ids.abstract,
        content: [{ kind: "text", text: "We study progressive reading of scientific papers." }],
      },
      [ids.bodySentence]: {
        id: ids.bodySentence,
        unitId: ids.body,
        content: [{ kind: "text", text: "Translations appear unit by unit while the task runs." }],
      },
    },
    atoms: {},
    blocks: [
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.abstract },
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.body },
    ],
  };
  return { tree, ids };
}

async function englishProject(name: string) {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
  const paperId = created.manifest.paper.id;
  const { tree, ids } = englishTree(paperId);
  const source = await page.evaluate(
    ({ root }) =>
      window.desktop.invoke<SourceSnapshotRecord>({
        type: "corePublishSource",
        root,
        files: { "document.html": new TextEncoder().encode("<html>paper</html>") },
        metadata: { kind: "arxiv", canonicalId: "2401.00001v1", title: "Progressive Reading" },
      }),
    { root: created.root },
  );
  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const revision = await page.evaluate(
    ({ root, sourceSnapshotId, files }) =>
      window.desktop.invoke<ProjectRevisionRecord>({
        type: "coreCommit",
        root,
        baseRevision: null,
        sourceSnapshotId,
        files,
      }),
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
  );
  return { created, revision, ids, tree, source };
}

async function openFolder(root: string) {
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
}

/** 受控翻译模型端点：按请求单元返回合法译文；可门控延迟以观察渐进发布。 */
function controlledServer(options: { hold?: Promise<void>; failUnit?: string }) {
  const calls: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((message) => message.role === "user");
    if (!userMessage) throw new Error("受控请求缺少 user 消息");
    const prompt = JSON.parse(userMessage.content) as {
      unit: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
    };
    calls.push(prompt.unit.unitId);
    if (options.hold) await options.hold;
    if (options.failUnit === prompt.unit.unitId) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "受控单元失败" } }));
      return;
    }
    const content = JSON.stringify({
      unitId: prompt.unit.unitId,
      sentences: prompt.unit.sentences.map((sentence) => ({
        sentenceId: sentence.sentenceId,
        content: `译文：${sentence.content}`,
      })),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  return { server, calls };
}

async function configureModel(endpoint: string) {
  await page.evaluate(async (url) => {
    const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
    await window.desktop.agent({
      type: "saveSettings",
      apiKey: "controlled-key",
      settings: {
        ...settings,
        services: settings.services.map((service) => ({ ...service, baseUrl: url })),
        models: settings.models.map((model) => ({ ...model, model: "controlled-translate" })),
      },
    });
  }, endpoint);
}

async function startServer(server: Server) {
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}

test("translation 语言切换渐进阅读：ready 译文、gap 原文回退、离线重开与不重复请求", async () => {
  const { created, ids } = await englishProject("翻译工程");
  const hold = Promise.withResolvers<void>();
  const { server, calls } = controlledServer({ hold: hold.promise });
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await expect(reader.locator(`[data-unit-id="${ids.abstract}"]`)).toContainText("We study progressive reading");

    // 首次切换到中文：立即进入语言视图，gap 句显示原文并标明未翻译。
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(reader).toHaveAttribute("data-language-view", "zh");
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "gap");
    await expect(abstractSentence).toContainText("We study progressive reading");
    await expect(abstractSentence.locator(".reader-translation-note")).toHaveText("未翻译");
    await expect(reader.locator(".reader-translation-status")).toContainText("可能产生模型费用");

    // 放行受控响应：两个单元渐进变为 ready，无需 reload。
    hold.resolve();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    const bodySentence = reader.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready");
    await expect(bodySentence).toContainText("译文：Translations appear unit by unit");
    expect(calls.sort()).toEqual([ids.abstract, ids.body].sort());

    // 切回原文再切中文：已有译文只切换视图，不重复请求。
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    await expect(reader).toHaveAttribute("data-language-view", "source");
    await expect(abstractSentence).toContainText("We study progressive reading");
    await expect(abstractSentence).not.toContainText("译文：");
    const before = calls.length;
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    expect(calls.length).toBe(before);

    // 离线重开：关闭应用、断开受控服务，已提交译文仍可读。
    await closeDesktopForCleanup();
    await stopServer(server);
    await launch();
    await openFolder(created.root);
    const reopened = page.locator(".full-reader");
    await expect(reopened).toBeVisible();
    await reopened.getByRole("button", { name: "中文", exact: true }).click();
    await expect(reopened.locator(`[data-sentence-id="${ids.abstractSentence}"]`)).toContainText(
      "译文：We study progressive reading",
      { timeout: 30000 },
    );
    await expect(reopened.locator(`[data-sentence-id="${ids.bodySentence}"]`)).toContainText("译文：Translations");
  } finally {
    hold.resolve();
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 单单元失败不阻塞其他单元：gap 保留原文与诊断，补试一次后仍失败不无限请求", async () => {
  const { created, ids } = await englishProject("缺口工程");
  const { server, calls } = controlledServer({ failUnit: ids.abstract });
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();

    // body 成功发布；abstract 首轮＋补试共两次后保留 gap。
    const bodySentence = reader.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "gap");
    await expect(abstractSentence).toContainText("We study progressive reading");
    await expect(reader.locator(".reader-translation-status")).toContainText("缺口");
    expect(calls.filter((id) => id === ids.abstract)).toHaveLength(2);
    expect(calls.filter((id) => id === ids.body)).toHaveLength(1);

    // 同会话同指纹再次打开：不再自动请求（crd.3 每会话限次）。
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    const before = calls.length;
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "gap");
    expect(calls.length).toBe(before);

    // 手动补译缺口：显式动作可再次发起（仍失败，但请求确实发出）。
    await reader.getByRole("button", { name: /补译缺口/ }).click();
    await expect(reader.locator(".reader-translation-status")).toContainText("缺口", { timeout: 30000 });
    expect(calls.length).toBe(before + 2);
    expect(calls.slice(before).every((id) => id === ids.abstract)).toBe(true);
  } finally {
    await stopServer(server);
  }
});

test("translation 正文修正后局部 stale：旧译文可对照最新原文，显式更新只替换目标句", async () => {
  const { created, ids, tree, revision } = await englishProject("局部stale工程");
  const { server, calls } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    const bodySentence = reader.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready");
    expect(calls.sort()).toEqual([ids.abstract, ids.body].sort());

    // 显式修正 abstract 单元文字（保留句边界与 atom）：发布新 current。
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    const unit = reader.locator(`[data-unit-id="${ids.abstract}"]`);
    await unit.getByRole("button", { name: /修正单元/ }).click();
    const host = reader.locator(".correction-host");
    const original = unitEditText(tree, ids.abstract);
    await host.locator(".correction-text").fill(original.replace("progressive reading", "progressive close reading"));
    await host.getByRole("button", { name: "预览 changeset" }).click();
    await expect(host.locator(".correction-preview")).toBeVisible();
    await host.getByRole("button", { name: "确认发布新 revision" }).click();
    await expect(host).toHaveCount(0);
    await expect(unit).toContainText("progressive close reading", { timeout: 15000 });

    // 语言视图保持：迁移后仅 abstract 句 stale，body 仍 ready；不自动重译。
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "stale", { timeout: 15000 });
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    await expect(abstractSentence.locator(".reader-translation-note.stale")).toHaveText("已过期");
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready");
    const beforeUpdate = calls.length;

    // 对照最新原文：展开后显示修正后的原句（原文锚点）。
    await abstractSentence.getByRole("button", { name: "查看最新原文" }).click();
    const comparison = abstractSentence.locator(".reader-stale-source");
    await expect(comparison).toContainText("progressive close reading");
    await abstractSentence.getByRole("button", { name: "收起原文" }).click();
    await expect(comparison).toHaveCount(0);

    // 显式更新过期译文：只请求 stale 句，body 不重发。
    await reader.getByRole("button", { name: /更新过期译文/ }).click();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(abstractSentence).toContainText("译文：We study progressive close reading");
    await expect(bodySentence).toContainText("译文：Translations appear unit by unit");
    expect(calls.length).toBe(beforeUpdate + 1);
    expect(calls[calls.length - 1]).toBe(ids.abstract);

    // 离线重开：更新后的译文与 ready 状态持久可读。
    await closeDesktopForCleanup();
    await stopServer(server);
    await launch();
    await openFolder(created.root);
    const reopened = page.locator(".full-reader");
    await expect(reopened).toBeVisible();
    await reopened.getByRole("button", { name: "中文", exact: true }).click();
    await expect(reopened.locator(`[data-sentence-id="${ids.abstractSentence}"]`)).toContainText(
      "译文：We study progressive close reading",
      { timeout: 30000 },
    );
    await expect(reopened.locator(`[data-sentence-id="${ids.bodySentence}"]`)).toHaveAttribute(
      "data-translation-status",
      "ready",
    );
    expect(revision.revisionId).toBeTruthy();
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

/** 在译文句内设置真实 DOM 选区（文本片段按 data-start 定位）。 */
async function selectTranslated(sentenceId: string, start: number, from: number, to: number) {
  const sentence = page.locator(`[data-sentence-id="${sentenceId}"]`);
  await sentence.scrollIntoViewIfNeeded();
  await page.evaluate(
    ({ sentenceId, start, from, to }) => {
      const span = document.querySelector(`[data-sentence-id="${sentenceId}"] [data-start="${start}"]`);
      if (!span?.firstChild) throw new Error(`译文片段不存在：${start}`);
      const range = document.createRange();
      range.setStart(span.firstChild, from);
      range.setEnd(span.firstChild, to);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector(".full-reader")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { sentenceId, start, from, to },
  );
}

test("translation 译文精确选区：quote 来自译文投影，gap 原文不冒充译文 range", async () => {
  const { created, ids } = await englishProject("译文选区工程");
  const { server } = controlledServer({ failUnit: ids.body });
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(reader.locator(`[data-sentence-id="${ids.bodySentence}"]`)).toHaveAttribute(
      "data-translation-status",
      "gap",
      { timeout: 30000 },
    );

    // ready 译文句内选区："译文：We study progressive reading of scientific papers."
    // 偏移 3..9 = "We stu"：quote 必须是译文逻辑文本，不是原文偏移互换。
    await selectTranslated(ids.abstractSentence, 0, 3, 9);
    const toolbar = page.locator(".reader-selection-toolbar");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "解释" }).click();
    const composer = page.getByRole("textbox", { name: "Agent 消息" });
    await expect(composer).toContainText("请解释以下译文选区：");
    const value = await composer.inputValue();
    expect(value.split("\n").find((line) => line.startsWith("> "))).toBe("> We stu");

    // gap 句显示原文但不在译文选区集：选中它不产出译文工具条。
    await page.evaluate(
      ({ sentenceId }) => {
        const span = document.querySelector(`[data-sentence-id="${sentenceId}"] [data-start="0"]`);
        if (!span?.firstChild) throw new Error("gap 原文片段不存在");
        const range = document.createRange();
        range.setStart(span.firstChild, 0);
        range.setEnd(span.firstChild, 12);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.querySelector(".full-reader")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      },
      { sentenceId: ids.bodySentence },
    );
    await expect(toolbar).toHaveCount(0);

    // 切回原文：同一 DOM 交互恢复原文精确选区（原文 quote，不是译文）。
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    await selectTranslated(ids.abstractSentence, 0, 3, 9);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "提问" }).click();
    await expect(composer).toContainText("关于以下原文选区，我想提问：");
    const sourceValue = await composer.inputValue();
    expect(
      sourceValue
        .split("\n")
        .filter((line) => line.startsWith("> "))
        .at(-1),
    ).toBe("> study ");
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});
