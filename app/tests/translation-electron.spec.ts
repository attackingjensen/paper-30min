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

/** 两个英文单元的真实树：摘要＋正文段落，各一句。long：摘要多句使正文可滚出首屏。 */
function englishTree(paperId: string, options: { long?: boolean } = {}) {
  const ids = {
    section: randomUUID(),
    abstract: randomUUID(),
    abstractSentence: randomUUID(),
    body: randomUUID(),
    bodySentence: randomUUID(),
    rawBlock: randomUUID(),
  };
  const abstractSentenceIds = [ids.abstractSentence];
  const sentences: DocumentTree["sentences"] = {
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
  };
  if (options.long) {
    for (let index = 0; index < 14; index++) {
      const sentenceId = randomUUID();
      abstractSentenceIds.push(sentenceId);
      sentences[sentenceId] = {
        id: sentenceId,
        unitId: ids.abstract,
        content: [
          {
            kind: "text",
            text: `Background sentence ${index} explains the reading pipeline in considerable detail so that the abstract spans well beyond a single viewport height.`,
          },
        ],
      };
    }
  }
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
        sentenceIds: abstractSentenceIds,
      },
      [ids.body]: { id: ids.body, sectionId: ids.section, kind: "paragraph", sentenceIds: [ids.bodySentence] },
    },
    sentences,
    atoms: {},
    blocks: [
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.abstract },
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.body },
      {
        id: ids.rawBlock,
        sectionId: ids.section,
        kind: "raw",
        html: "<blockquote><p>Quoted <strong>source</strong> line.</p></blockquote>",
        text: "Quoted source line.",
        limitations: ["复杂排版按白名单投影，交互结构未保留。"],
      },
    ],
  };
  return { tree, ids };
}

async function englishProject(name: string, options: { long?: boolean } = {}) {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name });
  const paperId = created.manifest.paper.id;
  const { tree, ids } = englishTree(paperId, options);
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

/** 受控翻译模型端点：按请求单元返回合法译文；可门控延迟以观察渐进发布。
 * hold：全局门控；holdUnit：按单元独立门控（验证逐单元渐进可见）。 */
function controlledServer(options: { hold?: Promise<void>; holdUnit?: Map<string, Promise<void>>; failUnit?: string }) {
  const calls: string[] = [];
  const metaCalls: string[] = [];
  const server: Server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((message) => message.role === "user");
    if (!userMessage) throw new Error("受控请求缺少 user 消息");
    const prompt = JSON.parse(userMessage.content) as {
      unit?: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
      paperTitle?: string | null;
      sections?: Array<{ sectionId: string; title: string }>;
      rawBlocks?: Array<{ blockId: string; text: string }>;
    };
    if (!prompt.unit) {
      metaCalls.push("meta");
      if (options.hold) await options.hold;
      const metaContent = JSON.stringify({
        paperTitle: prompt.paperTitle == null ? null : `译文：${prompt.paperTitle}`,
        sections: (prompt.sections ?? []).map((section) => ({
          sectionId: section.sectionId,
          title: `译文：${section.title}`,
        })),
        rawBlocks: (prompt.rawBlocks ?? []).map((block) => ({
          blockId: block.blockId,
          text: `译文：${block.text}`,
        })),
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: { content: metaContent }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    calls.push(prompt.unit.unitId);
    if (options.hold) await options.hold;
    const unitHold = options.holdUnit?.get(prompt.unit.unitId);
    if (unitHold) await unitHold;
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
  return { server, calls, metaCalls };
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

/** 等主进程翻译任务真正落定（running=false），避免显式动作被 busy-skip。 */
async function waitTranslationIdle(root: string, revisionId: string) {
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ r, rev }) =>
            window.desktop
              .invoke<{ running?: boolean }>({ type: "coreTranslationRead", root: r, revisionId: rev, language: "zh" })
              .then((p) => p.running === true),
          { r: root, rev: revisionId },
        ),
      { timeout: 30000 },
    )
    .toBe(false);
}

test("translation 语言切换渐进阅读：ready 译文、gap 原文回退、离线重开与不重复请求", async () => {
  const { created, ids } = await englishProject("翻译工程", { long: true });
  const abstractHold = Promise.withResolvers<void>();
  const bodyHold = Promise.withResolvers<void>();
  const { server, calls, metaCalls } = controlledServer({
    holdUnit: new Map([
      [ids.abstract, abstractHold.promise],
      [ids.body, bodyHold.promise],
    ]),
  });
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

    // 逐单元渐进：先放行 abstract，body 仍在途——abstract 立即可读，body 保持 gap 原文。
    abstractHold.resolve();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    const bodySentence = reader.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(bodySentence).toHaveAttribute("data-translation-status", "gap");
    await expect(bodySentence).toContainText("Translations appear unit by unit");
    // 阅读位置稳定：滚到接近文末，使 body 单元成为视口锚点（摘要在上方）；
    // 放行 body 后上方摘要译文已就绪、body 自身长度变化由锚点重对齐吸收。
    const readerBox = (await reader.boundingBox())!;
    await page.mouse.move(readerBox.x + readerBox.width / 2, readerBox.y + readerBox.height / 2);
    await page.mouse.wheel(0, 100000);
    await page.waitForTimeout(300);
    const anchorBefore = await page.evaluate(() => {
      const container = document.querySelector(".full-reader")!.parentElement!;
      const containerTop = container.getBoundingClientRect().top;
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-unit-id], [data-section-id]"))) {
        const rect = element.getBoundingClientRect();
        if (rect.height === 0 || rect.bottom <= containerTop + 1) continue;
        return {
          id: element.getAttribute("data-unit-id") ?? element.getAttribute("data-section-id"),
          rel: rect.top - containerTop,
        };
      }
      throw new Error("无可见锚点");
    });
    bodyHold.resolve();
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(bodySentence).toContainText("译文：Translations appear unit by unit");
    await page.waitForTimeout(300);
    const anchorAfter = await page.evaluate((anchorId) => {
      const container = document.querySelector(".full-reader")!.parentElement!;
      const element = document.querySelector(`[data-unit-id="${anchorId}"], [data-section-id="${anchorId}"]`)!;
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    }, anchorBefore.id);
    expect(Math.abs(anchorAfter - anchorBefore.rel)).toBeLessThanOrEqual(4);
    expect(calls.sort()).toEqual([ids.abstract, ids.body].sort());
    expect(metaCalls).toHaveLength(1);

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
    abstractHold.resolve();
    bodyHold.resolve();
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 单单元失败不阻塞其他单元：gap 保留原文与诊断，补试一次后仍失败不无限请求", async () => {
  const { created, ids } = await englishProject("缺口工程");
  const { server, calls, metaCalls } = controlledServer({ failUnit: ids.abstract });
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
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "gap");
    // 等语言切换的 generate 完全落定：同指纹限次返回 skipped，状态为缺口摘要
    // （而非在途的"可能产生模型费用"），此时 busy 已解除，显式动作不会被 busy-skip。
    await expect(reader.locator(".reader-translation-status")).toContainText("个单元暂为缺口", { timeout: 30000 });
    // 旧停止指纹不含 meta：重开按新口径对正文 gap 补试一次；meta 首轮已 ready 不重发。
    expect(metaCalls.length).toBe(1);

    // 手动补译缺口：显式动作可再次发起（仍失败，但请求确实发出）。
    const before = calls.length;
    await reader.getByRole("button", { name: /补译缺口/ }).click();
    await expect(reader.locator(".reader-translation-status")).toContainText("补译完成", { timeout: 30000 });
    await expect(reader.locator(".reader-translation-status")).toContainText("缺口", { timeout: 30000 });
    // 元数据已 ready：补译只重试 gap 单元（首轮＋补试），不重发 meta。
    expect(calls.length).toBe(before + 2);
    expect(calls.slice(before).every((id) => id === ids.abstract)).toBe(true);
  } finally {
    await stopServer(server);
  }
});

test("translation 正文修正后局部 stale：旧译文可对照最新原文，显式更新只替换目标句", async () => {
  const { created, ids, tree, revision } = await englishProject("局部stale工程");
  const { server, calls, metaCalls } = controlledServer({});
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
    expect(metaCalls).toHaveLength(1);

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
    await waitTranslationIdle(created.root, revision.revisionId);
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

test("translation 语言直接互切：旧语言译文不冒充新视图，读取期间显示原文锚点", async () => {
  const { created, ids } = await englishProject("语言互切工程");
  const { server, calls } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    const before = calls.length;

    // 中文 → English 直接互切：源语言即英文，不创建任务；
    // 旧中文投影立即退出渲染，不得以 English 视图显示中文 ready 译文。
    await reader.getByRole("button", { name: "English", exact: true }).click();
    await expect(reader).toHaveAttribute("data-language-view", "en");
    await expect(abstractSentence).not.toContainText("译文：");
    await expect(reader.locator(".reader-translation-status")).toContainText("目标语言与原文相同");
    expect(calls.length).toBe(before);

    // 切回中文：已有译文只切换视图，不重复请求。
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toContainText("译文：We study progressive reading", { timeout: 30000 });
    expect(calls.length).toBe(before);
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 跨旧译文与最新原文对照区的选区不产出译文工具条", async () => {
  const { created, ids, tree } = await englishProject("跨界选区工程");
  const { server } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });

    // 修正原文发布新 current：abstract 句 stale，展开最新原文对照区。
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
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "stale", { timeout: 15000 });
    await abstractSentence.getByRole("button", { name: "查看最新原文" }).click();
    const comparison = abstractSentence.locator(".reader-stale-source");
    await expect(comparison).toContainText("progressive close reading");

    // 选区从旧译文片段开始、在对照区原文结束：共同祖先在对照区外，仍须拒绝。
    await page.evaluate((sentenceId) => {
      const sentence = document.querySelector(`[data-sentence-id="${sentenceId}"]`)!;
      const translated = sentence.querySelector('[data-start="0"]')!;
      const source = sentence.querySelector("[data-stale-source] [data-start]")!;
      if (!translated.firstChild || !source.firstChild) throw new Error("选区端点片段不存在");
      const range = document.createRange();
      range.setStart(translated.firstChild, 0);
      range.setEnd(source.firstChild, Math.min(10, source.firstChild.textContent?.length ?? 0));
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector(".full-reader")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, ids.abstractSentence);
    await expect(page.locator(".reader-selection-toolbar")).toHaveCount(0);
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 离线重开 ready＋stale＋gap 混合投影：各状态可读，gap 不触发恢复请求", async () => {
  const { created, ids, tree, revision } = await englishProject("混合离线工程");
  const { server } = controlledServer({ failUnit: ids.body });
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
    await expect(bodySentence).toHaveAttribute("data-translation-status", "gap", { timeout: 30000 });
    // 等首轮＋自动补试落定（task finished）：避免关闭应用与在途补试的计数竞态。
    await expect(reader.locator(".reader-translation-status")).toContainText("缺口", { timeout: 30000 });

    // 修正 abstract 原文：迁移后 abstract stale、body 仍 gap。
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
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "stale", { timeout: 15000 });
    await expect(bodySentence).toHaveAttribute("data-translation-status", "gap");
    await expect(reader.getByRole("button", { name: "中文", exact: true })).toBeEnabled({ timeout: 30000 });
    // 等当前 revision 的首次 generate（含自动补试）落定并持久化指纹。
    await waitTranslationIdle(created.root, revision.revisionId);

    // 第一次重开：消费该 revision 的首次自动尝试（指纹落盘）。
    const endpointPort = (server.address() as { port: number }).port;
    await closeDesktopForCleanup();
    await launch();
    await openFolder(created.root);
    await page.locator(".full-reader").getByRole("button", { name: "中文", exact: true }).click();
    await waitTranslationIdle(created.root, revision.revisionId);
    await closeDesktopForCleanup();
    await stopServer(server);

    // 第二次重开（指纹已落盘）：断开受控服务后 stale 旧译文与 gap 原文仍可读，
    // 且不得对正文 gap 发起恢复请求。
    await launch();
    await openFolder(created.root);
    const reopened = page.locator(".full-reader");
    await expect(reopened).toBeVisible();
    await reopened.getByRole("button", { name: "中文", exact: true }).click();
    const reopenedAbstract = reopened.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    await expect(reopenedAbstract).toHaveAttribute("data-translation-status", "stale", { timeout: 30000 });
    await expect(reopenedAbstract).toContainText("译文：We study progressive reading");
    await expect(reopenedAbstract.locator(".reader-translation-note.stale")).toHaveText("已过期");
    const reopenedBody = reopened.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(reopenedBody).toHaveAttribute("data-translation-status", "gap");
    await expect(reopenedBody).toContainText("Translations appear unit by unit");
    // 重开后新进程不得对正文 gap 发起恢复请求（单元指纹限次跨重启生效）；
    // 标题 stale 属新 revision 的首次显式语言选择，至多一次 meta 尝试，不计正文恢复。
    const { server: probeServer, calls: probeCalls } = controlledServer({});
    const listening = Promise.withResolvers<void>();
    probeServer.listen(endpointPort, "127.0.0.1", listening.resolve);
    await listening.promise;
    await page.waitForTimeout(1500);
    // 标题 stale 至多触发一次 meta 尝试（新 revision 首次语言选择），正文恢复必须为零。
    const metaAttempts = probeCalls.filter((id) => id === "meta").length;
    expect(metaAttempts).toBeLessThanOrEqual(1);
    probeCalls.splice(0, probeCalls.length, ...probeCalls.filter((id) => id !== "meta"));
    expect(probeCalls.length).toBe(0);
    await stopServer(probeServer);
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 用户停止：未发送批次取消，合法完成项保留，同指纹不再自动请求", async () => {
  const { created, ids, revision } = await englishProject("停止工程");
  const abstractHold = Promise.withResolvers<void>();
  const bodyHold = Promise.withResolvers<void>();
  const { server, calls } = controlledServer({
    holdUnit: new Map([
      [ids.abstract, abstractHold.promise],
      [ids.body, bodyHold.promise],
    ]),
  });
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const abstractSentence = reader.locator(`[data-sentence-id="${ids.abstractSentence}"]`);
    const bodySentence = reader.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(reader.locator(".reader-translation-status")).toContainText("可能产生模型费用");

    // 放行 abstract 使其合法完成；body 仍在途时停止。
    abstractHold.resolve();
    await expect(abstractSentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await reader.getByRole("button", { name: "停止翻译" }).click();
    await expect(reader.locator(".reader-translation-status")).toContainText("已停止翻译", { timeout: 30000 });
    // 合法完成项保留；body 未发送/被取消，保持 gap 原文。
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    await expect(bodySentence).toHaveAttribute("data-translation-status", "gap");
    const afterStop = calls.length;

    // 停止后切回再切中文：同指纹不再自动请求。
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(abstractSentence).toContainText("译文：We study progressive reading", { timeout: 30000 });
    // 等主进程任务真正落定（running=false），避免显式补译被 busy-skip。
    await waitTranslationIdle(created.root, revision.revisionId);
    expect(calls.length).toBe(afterStop);

    // 手动补译缺口仍可显式发起。
    bodyHold.resolve();
    await reader.getByRole("button", { name: /补译缺口/ }).click();
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    expect(calls.length).toBeGreaterThan(afterStop);
  } finally {
    abstractHold.resolve();
    bodyHold.resolve();
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 语言视图显示标题与 raw 文本投影；标题修正后仅标题 stale", async () => {
  const { created, ids, tree, revision, source } = await englishProject("标题视图工程");
  const { server, calls, metaCalls } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(reader.locator(`[data-sentence-id="${ids.bodySentence}"]`)).toHaveAttribute(
      "data-translation-status",
      "ready",
      { timeout: 30000 },
    );
    // 论文标题、section 标题与 raw 文本投影进入语言视图。
    await expect(reader.locator("[data-paper-title]")).toContainText("译文：Progressive Reading");
    await expect(reader.locator(`[data-section-id="${ids.section}"]`)).toContainText("译文：1 Introduction");
    const rawTranslation = reader.locator(`[data-block-id="${ids.rawBlock}"] .reader-raw-translation`);
    await expect(rawTranslation).toHaveAttribute("data-raw-translation-status", "ready");
    await expect(rawTranslation).toContainText("译文：Quoted source line.");
    await expect(rawTranslation).toContainText("raw 仅文本投影");
    expect(metaCalls).toHaveLength(1);

    // 标题修正发布新 current：仅标题 stale，正文句与 raw 不受影响。
    const changed: DocumentTree = {
      ...tree,
      sections: {
        ...tree.sections,
        [ids.section]: { ...tree.sections[ids.section], title: "1 Introduction and Motivation" },
      },
    };
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    await page.evaluate(
      ({ root, baseRevision, sourceSnapshotId, files }) =>
        window.desktop.invoke<ProjectRevisionRecord>({
          type: "coreCommit",
          root,
          baseRevision,
          sourceSnapshotId,
          files,
        }),
      {
        root: created.root,
        baseRevision: revision.revisionId,
        sourceSnapshotId: source.sourceSnapshotId,
        files: {
          "document.json": json(changed),
          "source-base.json": json(changed),
          "tombstones.json": json([]),
          "changeset.json": json({ baseRevision: revision.revisionId }),
        },
      },
    );
    const sectionHeading = reader.locator(`[data-section-id="${ids.section}"]`);
    await expect(sectionHeading.locator(".reader-translation-note.stale")).toHaveText("已过期", { timeout: 15000 });
    await expect(sectionHeading).toContainText("译文：1 Introduction");
    await expect(reader.locator(`[data-sentence-id="${ids.bodySentence}"]`)).toHaveAttribute(
      "data-translation-status",
      "ready",
    );
    await expect(rawTranslation).toHaveAttribute("data-raw-translation-status", "ready");

    // 显式更新过期译文：标题恢复 ready，正文不重发。
    const beforeUpdate = calls.length;
    const beforeMetaUpdate = metaCalls.length;
    await reader.getByRole("button", { name: /更新过期译文/ }).click();
    await expect(sectionHeading).toContainText("译文：1 Introduction and Motivation", { timeout: 30000 });
    await expect(sectionHeading.locator(".reader-translation-note.stale")).toHaveCount(0);
    expect(calls.length).toBe(beforeUpdate);
    expect(metaCalls.length).toBe(beforeMetaUpdate + 1);
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});
