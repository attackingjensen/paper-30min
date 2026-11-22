// 真实 Electron 翻译回归（SPEC-translation Testing Strategy，paper-30min-crd.2）：
// 生产 preload、project:command IPC、Node utility process 与真实临时 v2 工程；
// 受控回环模型服务驱动按需启动、渐进阅读、语言切换不 reload、离线重开。
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
  return { created, revision, ids };
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

    // 再次显式切换是新的按需请求：只重试 gap（abstract 首轮＋补试两次），
    // 已保存 body 不重发。打开缺口的每会话指纹限次由 crd.3 承担。
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    const before = calls.length;
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(reader.locator(".reader-translation-status")).toContainText("缺口", { timeout: 30000 });
    expect(calls.length).toBe(before + 2);
    expect(calls.slice(before).every((id) => id === ids.abstract)).toBe(true);
  } finally {
    await stopServer(server);
  }
});
