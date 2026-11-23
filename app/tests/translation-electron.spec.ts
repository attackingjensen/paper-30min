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
function controlledServer(options: {
  hold?: Promise<void>;
  holdUnit?: Map<string, Promise<void>>;
  failUnit?: string;
  /** 译文前缀（默认“译文：”）：重译回归用不同前缀制造可观察的新内容与缓存键变化。 */
  prefix?: string;
}) {
  const prefix = options.prefix ?? "译文：";
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
        paperTitle: prompt.paperTitle == null ? null : `${prefix}${prompt.paperTitle}`,
        sections: (prompt.sections ?? []).map((section) => ({
          sectionId: section.sectionId,
          title: `${prefix}${section.title}`,
        })),
        rawBlocks: (prompt.rawBlocks ?? []).map((block) => ({
          blockId: block.blockId,
          text: `${prefix}${block.text}`,
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
        content: `${prefix}${sentence.content}`,
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

async function configureModel(endpoint: string, model = "controlled-translate") {
  await page.evaluate(
    async ({ url, modelName }) => {
      const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
      await window.desktop.agent({
        type: "saveSettings",
        apiKey: "controlled-key",
        settings: {
          ...settings,
          services: settings.services.map((service) => ({ ...service, baseUrl: url })),
          models: settings.models.map((entry) => ({ ...entry, model: modelName })),
        },
      });
    },
    { url: endpoint, modelName: model },
  );
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

test("translation 全文重译单独确认：取消零请求，确认后逐单元原子替换 ready", async () => {
  const { created, ids, revision } = await englishProject("全文重译工程");
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
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await expect(abstractSentence).toContainText("译文：We study progressive reading");
    await waitTranslationIdle(created.root, revision.revisionId);
    const callsAfterGenerate = calls.length;
    const metaAfterGenerate = metaCalls.length;
    const revisionBefore = await invoke<{ translationRevision: string | null }>({
      type: "coreTranslationRead",
      root: created.root,
      revisionId: revision.revisionId,
      language: "zh",
    });

    // 取消前先切到缓存未命中的新模型/端点：若取消误启动重译，请求必然可观察。
    const cancelProbe = controlledServer({ prefix: "取消探针：" });
    const cancelProbeEndpoint = await startServer(cancelProbe.server);
    try {
      await configureModel(cancelProbeEndpoint, "controlled-translate-cancel");
      await reader.getByRole("button", { name: "重译全文", exact: true }).click();
      const confirm = reader.getByRole("alertdialog", { name: "全文重译确认" });
      await expect(confirm).toContainText("可能产生较高模型费用");
      await confirm.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirm).toHaveCount(0);
      // unit 与 meta 均零请求，translationRevision 不变，译文不变。
      expect(cancelProbe.calls).toEqual([]);
      expect(cancelProbe.metaCalls).toEqual([]);
      expect(calls.length).toBe(callsAfterGenerate);
      expect(metaCalls.length).toBe(metaAfterGenerate);
      const revisionAfterCancel = await invoke<{ translationRevision: string | null }>({
        type: "coreTranslationRead",
        root: created.root,
        revisionId: revision.revisionId,
        language: "zh",
      });
      expect(revisionAfterCancel.translationRevision).toBe(revisionBefore.translationRevision);
      await expect(abstractSentence).toContainText("译文：We study progressive reading");
    } finally {
      await stopServer(cancelProbe.server).catch(() => undefined);
    }

    // 确认：切换到新模型（SPEC §8.4 改变模型场景）重译；缓存键含模型，真实重新请求。
    const retranslate = controlledServer({ prefix: "重译：" });
    const retranslateEndpoint = await startServer(retranslate.server);
    try {
      await configureModel(retranslateEndpoint, "controlled-translate-v2");
      await reader.getByRole("button", { name: "重译全文", exact: true }).click();
      await reader
        .getByRole("alertdialog", { name: "全文重译确认" })
        .getByRole("button", { name: "确认全文重译", exact: true })
        .click();
      await expect(abstractSentence).toContainText("重译：We study progressive reading", { timeout: 30000 });
      await expect(bodySentence).toContainText("重译：Translations appear unit by unit");
      await expect(reader.locator("[data-paper-title]")).toContainText("重译：Progressive Reading");
      await waitTranslationIdle(created.root, revision.revisionId);
      // 两个单元整单元重译（各一次请求），元数据一次覆盖标题/section/raw。
      expect(retranslate.calls.filter((unitId) => unitId === ids.abstract)).toHaveLength(1);
      expect(retranslate.calls.filter((unitId) => unitId === ids.body)).toHaveLength(1);
      expect(retranslate.metaCalls).toHaveLength(1);
      await expect(reader.locator(".reader-translation-status")).toContainText("全文重译完成");
    } finally {
      await stopServer(retranslate.server).catch(() => undefined);
    }
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 单元重译入口：只替换目标单元；失败单元保留旧 ready 不制造新 gap", async () => {
  const { created, ids, revision } = await englishProject("单元重译工程");
  const { server } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const abstractUnit = reader.locator(`[data-unit-id="${ids.abstract}"]`);
    const bodyUnit = reader.locator(`[data-unit-id="${ids.body}"]`);
    const bodySentence = reader.locator(`[data-sentence-id="${ids.bodySentence}"]`);
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await waitTranslationIdle(created.root, revision.revisionId);
    // 语言视图逐单元提供重译入口；原文视图不提供。
    await expect(bodyUnit.getByRole("button", { name: /重译单元/ })).toBeVisible();
    await reader.getByRole("button", { name: "原文", exact: true }).click();
    await expect(bodyUnit.getByRole("button", { name: /重译单元/ })).toHaveCount(0);
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(bodySentence).toHaveAttribute("data-translation-status", "ready", { timeout: 30000 });
    await waitTranslationIdle(created.root, revision.revisionId);

    // 成功路径：切换新模型只重译 body 单元（缓存键含模型，真实请求），abstract 保留旧译文。
    const ok = controlledServer({ prefix: "重译：" });
    const okEndpoint = await startServer(ok.server);
    try {
      await configureModel(okEndpoint, "controlled-translate-v2");
      await bodyUnit.getByRole("button", { name: /重译单元/ }).click();
      await expect(bodySentence).toContainText("重译：Translations appear unit by unit", { timeout: 30000 });
      await waitTranslationIdle(created.root, revision.revisionId);
      expect(ok.calls).toEqual([ids.body]);
      await expect(abstractUnit).toContainText("译文：We study progressive reading");
      await expect(reader.locator(".reader-translation-status")).toContainText("单元重译完成");
    } finally {
      await stopServer(ok.server).catch(() => undefined);
    }

    // 失败路径：再换模型使请求真实发出；body 首轮＋补试均失败，旧 ready 保留，不制造新 gap。
    const failing = controlledServer({ prefix: "再译：", failUnit: ids.body });
    const failEndpoint = await startServer(failing.server);
    try {
      await configureModel(failEndpoint, "controlled-translate-v3");
      await bodyUnit.getByRole("button", { name: /重译单元/ }).click();
      await expect(reader.locator(".reader-translation-status")).toContainText("1 个单元重译失败，旧译文保留", {
        timeout: 30000,
      });
      await waitTranslationIdle(created.root, revision.revisionId);
      expect(failing.calls.filter((unitId) => unitId === ids.body)).toHaveLength(2);
      await expect(bodySentence).toHaveAttribute("data-translation-status", "ready");
      await expect(bodySentence).toContainText("重译：Translations appear unit by unit");
    } finally {
      await stopServer(failing.server).catch(() => undefined);
    }
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 在途任务期间的显式重译不被静默丢弃：busy 明确返回，落定后可完成", async () => {
  const { created, ids, revision, tree, source } = await englishProject("重译排队工程", { long: true });
  const { server } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    await expect(reader.locator(`[data-unit-id="${ids.body}"]`)).toContainText(
      "译文：Translations appear unit by unit",
      {
        timeout: 30000,
      },
    );
    await waitTranslationIdle(created.root, revision.revisionId);

    // 追加新句并发布新 current：再次生成只处理该 gap（挂起），制造确定的在途窗口。
    const added = randomUUID();
    const withAdded: DocumentTree = {
      ...tree,
      units: {
        ...tree.units,
        [ids.abstract]: { ...tree.units[ids.abstract], sentenceIds: [...tree.units[ids.abstract].sentenceIds, added] },
      },
      sentences: {
        ...tree.sentences,
        [added]: {
          id: added,
          unitId: ids.abstract,
          content: [{ kind: "text", text: "A newly added sentence awaits translation." }],
        },
      },
    };
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const second = await page.evaluate(
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
          "document.json": json(withAdded),
          "source-base.json": json(withAdded),
          "tombstones.json": json([]),
          "changeset.json": json({ baseRevision: revision.revisionId }),
        },
      },
    );
    const gapHold = Promise.withResolvers<void>();
    const held = controlledServer({
      prefix: "二次生成：",
      hold: gapHold.promise,
      holdUnit: new Map([[ids.abstract, gapHold.promise]]),
    });
    const heldEndpoint = await startServer(held.server);
    const queued = controlledServer({ prefix: "排队重译：" });
    const queuedEndpoint = await startServer(queued.server);
    try {
      await configureModel(heldEndpoint, "controlled-translate-second");
      await expect(reader).toHaveAttribute("data-revision-id", second.revisionId, { timeout: 30000 });
      // 直接经命令面启动挂起的 generate（不依赖 UI busy 渲染时序）。
      const generatePromise = invoke<{ status: string }>({
        type: "coreTranslationStart",
        root: created.root,
        language: "zh",
        expectedBaseRevision: second.revisionId,
      });
      await expect.poll(() => held.calls.length + held.metaCalls.length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
      // 在途期间发起两个单元重译：主进程以 busy 明确返回（不静默丢弃、不悬挂）。
      const busyA = await invoke<{ status: string; reason?: string }>({
        type: "coreTranslationRetranslate",
        root: created.root,
        language: "zh",
        scope: { kind: "unit", unitId: ids.abstract },
        expectedBaseRevision: second.revisionId,
      });
      const busyB = await invoke<{ status: string; reason?: string }>({
        type: "coreTranslationRetranslate",
        root: created.root,
        language: "zh",
        scope: { kind: "unit", unitId: ids.body },
        expectedBaseRevision: second.revisionId,
      });
      expect(busyA).toMatchObject({ status: "skipped", reason: "busy" });
      expect(busyB).toMatchObject({ status: "skipped", reason: "busy" });
      // 放行 generate 并落定。
      gapHold.resolve();
      await generatePromise;
      await waitTranslationIdle(created.root, second.revisionId);
      // 落定后显式重译可完成：两个单元都被整单元重译（renderer 排队动作即在此后执行）。
      await configureModel(queuedEndpoint, "controlled-translate-queue");
      const doneA = await invoke<{ status: string }>({
        type: "coreTranslationRetranslate",
        root: created.root,
        language: "zh",
        scope: { kind: "unit", unitId: ids.abstract },
        expectedBaseRevision: second.revisionId,
      });
      const doneB = await invoke<{ status: string }>({
        type: "coreTranslationRetranslate",
        root: created.root,
        language: "zh",
        scope: { kind: "unit", unitId: ids.body },
        expectedBaseRevision: second.revisionId,
      });
      expect(doneA).toMatchObject({ status: "finished" });
      expect(doneB).toMatchObject({ status: "finished" });
      expect(queued.calls).toEqual([ids.abstract, ids.body]);
      // 命令面确定性验证重译结果（renderer DOM 渐进刷新由其他用例覆盖，避免 CI 刷新时序抖动）。
      const afterRetranslate = await invoke<{
        units: Array<{
          unitId: string;
          sentences: Array<{ status: string; content: Array<{ kind: string; text?: string }> | null }>;
        }>;
      }>({ type: "coreTranslationRead", root: created.root, revisionId: second.revisionId, language: "zh" });
      const abstractProjection = afterRetranslate.units.find((unit) => unit.unitId === ids.abstract)!;
      const bodyProjection = afterRetranslate.units.find((unit) => unit.unitId === ids.body)!;
      expect(abstractProjection.sentences[0].content?.[0]).toMatchObject({
        kind: "text",
        text: "排队重译：We study progressive reading of scientific papers.",
      });
      expect(bodyProjection.sentences[0].content?.[0]).toMatchObject({
        kind: "text",
        text: "排队重译：Translations appear unit by unit while the task runs.",
      });
    } finally {
      gapHold.resolve();
      await stopServer(held.server).catch(() => undefined);
      await stopServer(queued.server).catch(() => undefined);
    }
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 全文重译确认期间正文推进：确认按新 current 复核，旧授权不跨 revision 收费", async () => {
  const { created, ids, revision, tree, source } = await englishProject("重译确认revision工程");
  const { server } = controlledServer({});
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
    await waitTranslationIdle(created.root, revision.revisionId);

    // 打开全文重译确认框后发布新 current（正文句变化）。
    await reader.getByRole("button", { name: "重译全文", exact: true }).click();
    const confirm = reader.getByRole("alertdialog", { name: "全文重译确认" });
    await expect(confirm).toBeVisible();
    const changed: DocumentTree = {
      ...tree,
      sentences: {
        ...tree.sentences,
        [ids.bodySentence]: {
          ...tree.sentences[ids.bodySentence],
          content: [{ kind: "text", text: "Translations appear unit by unit while the task runs, now revised." }],
        },
      },
    };
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const second = await page.evaluate(
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
    // 核心契约（命令面确定性）：旧 expectedBaseRevision 的重译被主进程复核拒绝，零请求，
    // 旧授权不跨 revision 收费。确认框随 revision 推进关闭由 renderer 身份守卫承担（DOM 刷新时序见其他用例）。
    const probe = controlledServer({ prefix: "越权探针：" });
    const probeEndpoint = await startServer(probe.server);
    try {
      await configureModel(probeEndpoint, "controlled-translate-stale");
      const stale = await invoke<{ status: string; reason?: string }>({
        type: "coreTranslationRetranslate",
        root: created.root,
        language: "zh",
        scope: { kind: "full" },
        expectedBaseRevision: revision.revisionId,
      });
      expect(stale).toMatchObject({ status: "skipped", reason: "revision-changed" });
      expect(probe.calls).toEqual([]);
      expect(probe.metaCalls).toEqual([]);
      // 按新 current 重新发起可正常重译（命令面），译文按新原文整单元替换。
      const fresh = await invoke<{ status: string }>({
        type: "coreTranslationRetranslate",
        root: created.root,
        language: "zh",
        scope: { kind: "full" },
        expectedBaseRevision: second.revisionId,
      });
      expect(fresh).toMatchObject({ status: "finished" });
      await waitTranslationIdle(created.root, second.revisionId);
      const afterFresh = await invoke<{
        units: Array<{ unitId: string; sentences: Array<{ content: Array<{ kind: string; text?: string }> | null }> }>;
      }>({ type: "coreTranslationRead", root: created.root, revisionId: second.revisionId, language: "zh" });
      const bodyProjection = afterFresh.units.find((unit) => unit.unitId === ids.body)!;
      expect(bodyProjection.sentences[0].content?.[0]).toMatchObject({
        kind: "text",
        text: "越权探针：Translations appear unit by unit while the task runs, now revised.",
      });
    } finally {
      await stopServer(probe.server).catch(() => undefined);
    }
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});

test("translation 表格单元与表标题提供重译入口：单元级替换不影响其他单元", async () => {
  const created = await invoke<ProjectCoreSnapshot>({ type: "coreCreate", parent: sandbox, name: "表格重译工程" });
  const paperId = created.manifest.paper.id;
  const ids = {
    section: randomUUID(),
    body: randomUUID(),
    bodySentence: randomUUID(),
    caption: randomUUID(),
    captionSentence: randomUUID(),
    cell: randomUUID(),
    cellSentence: randomUUID(),
  };
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [ids.section]: {
        id: ids.section,
        parentSectionId: null,
        title: "1 Results",
        childSectionIds: [],
        unitIds: [ids.body, ids.caption, ids.cell],
      },
    },
    units: {
      [ids.body]: { id: ids.body, sectionId: ids.section, kind: "paragraph", sentenceIds: [ids.bodySentence] },
      [ids.caption]: { id: ids.caption, sectionId: ids.section, kind: "caption", sentenceIds: [ids.captionSentence] },
      [ids.cell]: { id: ids.cell, sectionId: ids.section, kind: "table-cell", sentenceIds: [ids.cellSentence] },
    },
    sentences: {
      [ids.bodySentence]: {
        id: ids.bodySentence,
        unitId: ids.body,
        content: [{ kind: "text", text: "The results are summarized below." }],
      },
      [ids.captionSentence]: {
        id: ids.captionSentence,
        unitId: ids.caption,
        content: [{ kind: "text", text: "Table 1: measured accuracy." }],
      },
      [ids.cellSentence]: {
        id: ids.cellSentence,
        unitId: ids.cell,
        content: [{ kind: "text", text: "0.98" }],
      },
    },
    atoms: {},
    blocks: [
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.body },
      {
        id: randomUUID(),
        sectionId: ids.section,
        kind: "table",
        captionUnitId: ids.caption,
        rows: [[{ unitId: ids.cell, rowSpan: 1, columnSpan: 1 }]],
      },
    ],
  };
  const source = await page.evaluate(
    ({ root }) =>
      window.desktop.invoke<SourceSnapshotRecord>({
        type: "corePublishSource",
        root,
        files: { "document.html": new TextEncoder().encode("<html>paper</html>") },
        metadata: { kind: "arxiv", canonicalId: "2401.00009v1", title: "Table Retranslation" },
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
  const { server } = controlledServer({});
  const endpoint = await startServer(server);
  try {
    await configureModel(endpoint);
    await openFolder(created.root);
    const reader = page.locator(".full-reader");
    await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "中文", exact: true }).click();
    const cellUnit = reader.locator(`[data-unit-id="${ids.cell}"]`);
    const captionUnit = reader.locator(`[data-unit-id="${ids.caption}"]`);
    const bodyUnit = reader.locator(`[data-unit-id="${ids.body}"]`);
    await expect(cellUnit).toContainText("译文：0.98", { timeout: 30000 });
    await waitTranslationIdle(created.root, revision.revisionId);
    // 表格单元与表标题都有重译入口。
    await expect(cellUnit.getByRole("button", { name: /重译单元/ })).toBeVisible();
    await expect(captionUnit.getByRole("button", { name: /重译单元/ })).toBeVisible();

    const ok = controlledServer({ prefix: "重译：" });
    const okEndpoint = await startServer(ok.server);
    try {
      await configureModel(okEndpoint, "controlled-translate-v2");
      await cellUnit.getByRole("button", { name: /重译单元/ }).click();
      await expect(cellUnit).toContainText("重译：0.98", { timeout: 30000 });
      await waitTranslationIdle(created.root, revision.revisionId);
      expect(ok.calls).toEqual([ids.cell]);
      // 表标题与正文单元不受影响。
      await expect(captionUnit).toContainText("译文：Table 1: measured accuracy.");
      await expect(bodyUnit).toContainText("译文：The results are summarized below.");
    } finally {
      await stopServer(ok.server).catch(() => undefined);
    }
  } finally {
    await stopServer(server).catch(() => undefined);
  }
});
