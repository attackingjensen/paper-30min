import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { AgentSettings, ChatSession } from "../src/shared/contracts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let sandbox: string;
let desktop: ElectronApplication;
let desktopProcess: ReturnType<ElectronApplication["process"]>;
let page: Page;
let errors: string[];
const fixture = path.resolve("tests/fixtures/sample_paper.pdf");

// Playwright pierces the complete viewer's open shadow root through its public UI.
const pdfViewport = () => page.locator('.pdf-reader .bg-bg-app[style*="overflow: auto"]');
const pdfImage = () => pdfViewport().locator('img[style*="pointer-events: none"]').first();
const pdfPages = () => page.locator('[data-overlay-id="page-controls"]');
const pdfPage = () => pdfPages().locator("input");
const pdfZoom = () => page.getByRole("textbox", { name: "Set zoom", exact: true });

async function setPdfZoom(percent: string) {
  await pdfZoom().fill(percent);
  await pdfZoom().press("Enter");
  await expect(pdfZoom()).toHaveValue(percent);
}

async function jumpPdfPage(number: number) {
  await pdfPages().hover();
  await pdfPage().fill(String(number));
  await pdfPage().press("Enter");
  await expect(pdfPage()).toHaveValue(String(number));
  await expect
    .poll(async () => {
      const before = await pdfViewport().evaluate((e) => e.scrollTop);
      await page.waitForTimeout(100);
      return Math.abs(before - (await pdfViewport().evaluate((e) => e.scrollTop)));
    })
    .toBe(0);
  await expect(pdfPage()).toHaveValue(String(number));
}

async function expectPdfRendered() {
  await expect(pdfImage()).toBeVisible();
  await expect.poll(() => pdfImage().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
}

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
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (!visible) {
    // Windows runners can clamp the initial window to their 1024px desktop.
    // Resize the native window so later native-resize tests keep working.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
    // Keep browser input/clipboard APIs active without taking native desktop focus.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await expect
      .poll(
        async () => {
          const actual = await page.evaluate(() => [innerWidth, innerHeight]);
          if (actual[0] !== 1440 || actual[1] !== 960) {
            // Windows offscreen sizing can include the outer frame. Re-read after each
            // native resize instead of locking the viewport or weakening the assertion.
            await desktop.evaluate(
              ({ BrowserWindow }, expected) => {
                const window = BrowserWindow.getAllWindows()[0];
                const [width, height] = window.getContentSize();
                window.setContentSize(
                  width + expected.width - expected.actual[0],
                  height + expected.height - expected.actual[1],
                );
              },
              { width: 1440, height: 960, actual },
            );
          }
          return actual;
        },
        { timeout: 15000 },
      )
      .toEqual([1440, 960]);
  }
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible({ timeout: 30000 });
  expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(visible);
}

async function choose(selected: string | null) {
  // Only the operating-system chooser is substituted; the production preload, IPC,
  // Node utility process and disk operations run unchanged.
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: file === null,
      filePaths: file ? [file] : [],
    });
  }, selected);
}

async function preview(source: string, parent?: string, name = "研究工程") {
  await choose(source);
  await page.getByRole("button", { name: "从 PDF 新建工程", exact: true }).click();
  await page.getByLabel("工程名称", { exact: true }).fill(name);
  if (parent) {
    await choose(parent);
    await page.getByRole("button", { name: "选择位置", exact: true }).click();
  }
}

async function create(source: string, parent?: string, name = "研究工程") {
  await preview(source, parent, name);
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
}

async function readManifest(root: string) {
  return JSON.parse(await fs.readFile(path.join(root, "paper30min.json"), "utf8"));
}

async function closeDesktopForCleanup() {
  if (!desktopProcess || desktopProcess.exitCode !== null || desktopProcess.signalCode !== null) return;
  // Only teardown discards disposable drafts; normal close protection stays active.
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
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-desktop-"));
  await fs.mkdir(path.join(sandbox, "projects"));
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

test("解析设置加密保存 Token，损坏配置可清除恢复", async () => {
  const endpoint = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "解析模型", exact: true }).click();
  await page.getByLabel("百度任务地址", { exact: true }).fill(endpoint);
  await page.getByLabel("百度 Token", { exact: true }).fill("desktop-parsing-secret");
  await page.getByRole("button", { name: "保存解析配置" }).click();
  await expect(page.getByRole("status")).toContainText("解析配置已保存");
  await page.screenshot({ path: "test-results/parsing-settings.png" });
  await page.setViewportSize({ width: 650, height: 850 });
  await page.screenshot({ path: "test-results/parsing-settings-narrow.png", animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });
  expect(await fs.readFile(path.join(sandbox, "profile/parsing-settings.json"), "utf8")).not.toContain(
    "desktop-parsing-secret",
  );
  await fs.writeFile(path.join(sandbox, "profile/parsing-settings.json"), "damaged");
  await page.getByRole("button", { name: "返回工程", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "解析模型", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("解析配置无法读取");
  await page.getByRole("button", { name: "清除百度 Token", exact: true }).click();
  await page.getByRole("button", { name: "保存解析配置" }).click();
  await expect(page.getByRole("status")).toContainText("解析配置已保存");
});

test("窗口关闭保护保留草稿，测试清理自动放弃临时编辑", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const note = path.join(root, "notes/关闭.md");
  const original = "# 原始内容\n";
  await fs.writeFile(note, original);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "关闭.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await editor.press("Control+End");
  await fs.chmod(note, 0o444);
  await editor.pressSequentially("未保存草稿");
  await expect(page.getByRole("alert")).toContainText("保存失败");

  const prompt = await desktop.evaluate(
    ({ BrowserWindow, dialog }) =>
      new Promise<string>((resolve) => {
        dialog.showMessageBoxSync = (...args: unknown[]) => {
          const options = args.at(-1) as Electron.MessageBoxSyncOptions;
          resolve(options.message);
          return 0;
        };
        BrowserWindow.getAllWindows()[0].close();
      }),
  );
  expect(prompt).toBe("有未保存的文档，确定放弃编辑并关闭吗？");
  await expect(editor).toContainText("未保存草稿");

  await closeDesktopForCleanup();
  expect(desktopProcess.exitCode).toBe(0);
  await fs.chmod(note, 0o666);
  expect(await fs.readFile(note, "utf8")).toBe(original);
});

test.describe("多服务模型", () => {
  let requests: { path: string; key: string; model: string; reasoningEffort: string | undefined }[];
  let held: PromiseWithResolvers<void>;
  let server: Server;

  test.beforeEach(async () => {
    requests = [];
    held = Promise.withResolvers<void>();
    server = createServer(async (request, response) => {
      let raw = "";
      for await (const part of request) raw += part;
      const body: unknown = JSON.parse(raw);
      if (!body || typeof body !== "object" || !("model" in body) || typeof body.model !== "string") {
        throw new Error("受控模型请求缺少字符串 model");
      }
      const model = body.model;
      const reasoningEffort =
        "reasoning_effort" in body && typeof body.reasoning_effort === "string"
          ? body.reasoning_effort
          : undefined;
      const enableThinking = "enable_thinking" in body && body.enable_thinking === true;
      requests.push({
        path: request.url ?? "",
        key: request.headers.authorization ?? "",
        model,
        reasoningEffort,
      });
      if (model === "ultra-d") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "unsupported reasoning_effort ultra" },
          }),
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (delta: object, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: "multi",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      if (model === "reasoning-b") {
        emit({ reasoning_content: "先核对证据。" });
        await held.promise;
      } else if (enableThinking) emit({ reasoning_content: "继续分析。" });
      emit({ content: `来自 ${model}` });
      emit({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await create(fixture, path.join(sandbox, "projects"), "多模型工程");
    await page.evaluate(
      async ({ address }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...settings,
            services: [
              {
                id: "one",
                name: "共享服务",
                api: "openai-completions",
                baseUrl: `${address}/one`,
                hasKey: false,
              },
              {
                id: "two",
                name: "独立服务",
                api: "openai-completions",
                baseUrl: `${address}/two`,
                hasKey: false,
              },
            ],
            models: [
              {
                id: "a",
                serviceId: "one",
                name: "模型 A",
                model: "answer-a",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "low"],
                thinking: "off",
              },
              {
                id: "b",
                serviceId: "one",
                name: "模型 B",
                model: "reasoning-b",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "low"],
                thinking: "low",
              },
              {
                id: "c",
                serviceId: "two",
                name: "模型 C",
                model: "answer-c",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off"],
                thinking: "off",
              },
              {
                id: "d",
                serviceId: "one",
                name: "模型 D",
                model: "ultra-d",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "ultra"],
                thinking: "ultra",
              },
              {
                id: "e",
                serviceId: "one",
                name: "模型 E",
                model: "xhigh-e",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "xhigh"],
                thinking: "xhigh",
              },
              {
                id: "f",
                serviceId: "one",
                name: "模型 F",
                model: "max-f",
                contextWindow: 64000,
                maxTokens: 1024,
                availableThinking: ["off", "max"],
                thinking: "max",
              },
            ],
            selectedModelId: "a",
          },
          apiKeys: { one: "shared-secret", two: "isolated-secret" },
        });
      },
      { address },
    );
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(page.locator(".agent-service-choice")).toHaveCount(2);
    await expect(page.locator(".agent-model-row")).toHaveCount(5);
    await page.getByRole("button", { name: "返回工作台" }).click();
  });

  test.afterEach(async () => {
    held.resolve();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });

  test("模型选择、思考流与切换期间补充", async () => {
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 B");
    await page.screenshot({ path: "test-results/models-menu.png" });
    await page.getByRole("button", { name: /模型 B.*共享服务/ }).click();
    await expect(page.getByLabel("思考等级")).toHaveValue("low");
    await page.getByLabel("Agent 消息").fill("第一轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".thinking-card")).toBeVisible();
    const stop = page.getByRole("button", { name: "停止回复", exact: true });
    const supplement = page.getByRole("button", { name: "补充消息", exact: true });
    await expect(stop).toBeVisible();
    const stopGeometry = await stop.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.width, height: style.height, borderRadius: style.borderTopLeftRadius };
    });
    const supplementGeometry = await supplement.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.width, height: style.height, borderRadius: style.borderTopLeftRadius };
    });
    expect(stopGeometry).toEqual(supplementGeometry);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".process-chevron").first()).toHaveCSS("transition-property", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".thinking-card summary").click();
    await expect(page.locator(".thinking-content")).toHaveText("先核对证据。");
    await page.screenshot({ path: "test-results/thinking-expanded.png" });
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 A");
    await page.getByRole("button", { name: /模型 A.*共享服务/ }).click();
    await page.getByLabel("Agent 消息").fill("切换期间补充");
    await page.getByRole("button", { name: "补充消息" }).click();
    await expect(page.getByRole("alert")).toContainText("等待当前回复完成");
    held.resolve();
    await expect(stop).toHaveCount(0);
    await page.getByLabel("Agent 消息").fill("第二轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
    expect(requests.map((r) => [r.path, r.key, r.model])).toEqual([
      ["/one/chat/completions", "Bearer shared-secret", "reasoning-b"],
      ["/one/chat/completions", "Bearer shared-secret", "answer-a"],
    ]);
    expect(requests[0].reasoningEffort).toBe("low");
    await expect(page.locator(".thinking-card")).toHaveCount(1);
  });

  test("服务密钥与思考等级按所选模型路由", async () => {
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 C");
    await page.getByRole("button", { name: /模型 C.*独立服务/ }).click();
    await page.getByLabel("Agent 消息").fill("第三轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
    expect(requests[0].key).toBe("Bearer isolated-secret");
    expect(requests[0].path).toBe("/two/chat/completions");
    await expect(page.locator(".thinking-card")).toHaveCount(0);
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 D");
    await page.getByRole("button", { name: /模型 D.*共享服务/ }).click();
    await page.getByLabel("Agent 消息").fill("测试 ultra");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("alert")).toContainText("模型请求失败");
    expect(requests[1].reasoningEffort).toBe("ultra");
    expect(requests).toHaveLength(2);
    for (const [name, level] of [
      ["模型 E", "xhigh"],
      ["模型 F", "max"],
    ]) {
      await page.getByRole("button", { name: "选择模型" }).click();
      await page.getByLabel("搜索模型").fill(name);
      await page.getByRole("button", { name: new RegExp(`${name}.*共享服务`) }).click();
      await page.getByLabel("Agent 消息").fill(`测试 ${level}`);
      await page.getByRole("button", { name: "发送消息" }).click();
      await expect(page.locator(".chat-message.assistant").last()).toContainText(`来自 ${level}-`);
      expect(requests.at(-1)?.reasoningEffort).toBe(level);
    }
  });

  test("思考内容在会话重开和分支中保留", async () => {
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("模型 B");
    await page.getByRole("button", { name: /模型 B.*共享服务/ }).click();
    await page.getByLabel("Agent 消息").fill("第一轮");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".thinking-card")).toBeVisible();
    held.resolve();
    await expect(page.locator(".chat-message.assistant")).toContainText("来自 reasoning-b");
    const sessionId = await page.getByLabel("会话", { exact: true }).inputValue();
    await desktop.close();
    await launch();
    const sessions = await page.evaluate(
      async ({ root, sessionId }) =>
        window.desktop.agent<ChatSession>({
          type: "open",
          root,
          id: sessionId,
        }),
      { root: path.join(sandbox, "projects", "多模型工程"), sessionId },
    );
    expect(sessions.messages.some((message) => message.thinking === "先核对证据。")).toBe(true);
    const firstReply = sessions.messages.find((message) => message.thinking === "先核对证据。")!;
    const branch = await page.evaluate(
      async ({ root, sessionId, messageId }) =>
        window.desktop.agent<ChatSession>({
          type: "branch",
          root,
          id: sessionId,
          messageId,
        }),
      {
        root: path.join(sandbox, "projects", "多模型工程"),
        sessionId,
        messageId: firstReply.id,
      },
    );
    expect(branch.messages.some((message) => message.thinking === "先核对证据。")).toBe(true);
  });
});

test("百炼思考配置保持 system 角色，关闭档显式关闭且始终显示", async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.messages.some((message: any) => message.role === "developer")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = {
      content: `完成 ${requests.length}`,
      ...(body.enable_thinking ? { reasoning_content: "已核对。" } : {}),
    };
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = createServer();
  const sockets = new Set<import("node:stream").Duplex>();
  proxy.on("connect", (_request, client, head) => {
    const upstream = connect((server.address() as { port: number }).port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => {
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "思考协议工程");
    await page.evaluate(
      async (port) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = "http://dashscope.aliyuncs.com/compatible-mode/v1";
        settings.models[0] = {
          ...settings.models[0],
          model: "qwen3.8-max",
          availableThinking: ["off", "low", "medium", "high", "xhigh"],
          thinking: "high",
        };
        settings.proxy = "custom";
        settings.proxyUrl = `http://127.0.0.1:${port}`;
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: "controlled-thinking-key",
        });
      },
      (proxy.address() as { port: number }).port,
    );
    await page.getByLabel("Agent 消息").fill("你好");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("完成 1");
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].enable_thinking).toBe(true);
    expect(requests[0].reasoning_effort).toBe("high");
    await expect(page.locator(".thinking-card")).toHaveCount(1);
    await page.getByLabel("思考等级").selectOption("off");
    await page.getByLabel("Agent 消息").fill("继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("完成 2");
    expect(requests[1].enable_thinking).toBe(false);
    expect(requests[1].reasoning_effort).toBeUndefined();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.locator(".agent-model-row button[aria-expanded]").first().click();
    await expect(page.getByText("生成参数", { exact: true })).toHaveCount(0);
    for (const level of ["low", "medium", "high", "xhigh"])
      await page.getByRole("checkbox", { name: level, exact: true }).uncheck();
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await page.getByRole("button", { name: "返回工作台" }).click();
    await expect(page.getByLabel("思考等级")).toBeVisible();
    await expect(page.getByLabel("思考等级")).toHaveValue("off");
    expect(await page.getByLabel("思考等级").evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      await page.locator(".model-picker-trigger").evaluate((el) => getComputedStyle(el).fontSize),
    );
    await page.getByLabel("Agent 消息").fill("不启用思考");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("完成 3");
    expect(requests[2].enable_thinking).toBe(false);
    await page.screenshot({ path: "test-results/thinking-off-control.png" });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  }
});

test("Exa 密钥设置支持加密保存、重开、独立恢复与清除", async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Agent 网络搜索", exact: true }).click();
  const keyInput = page.getByLabel("Exa API key", { exact: true });
  await expect(keyInput).toHaveAttribute("placeholder", "未配置，使用免费服务");
  await keyInput.fill("exa-settings-secret");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(keyInput).toHaveValue("");
  const file = path.join(sandbox, "profile", "agent-settings.json");
  expect(await fs.readFile(file, "utf8")).not.toContain("exa-settings-secret");
  await page.evaluate(() => window.desktop.agent({ type: "selectModel", modelId: "default" }));
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 网络搜索", exact: true }).click();
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveAttribute("placeholder", "已保存，留空保留");
  const publicSettings = await page.evaluate(() => window.desktop.agent<AgentSettings>({ type: "settings" }));
  expect(publicSettings.search?.hasKey).toBe(true);
  expect(JSON.stringify(publicSettings)).not.toContain("exa-settings-secret");
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 760));
  await page.getByLabel("Exa API key", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/ste100-settings-narrow.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await desktop.close();
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  stored.encryptedExaKey = "broken-key";
  stored.encryptedKeys.default = "broken-model-key";
  await fs.writeFile(file, JSON.stringify(stored));
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 网络搜索", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Exa 密钥无法读取");
  await page.getByLabel("移除 Exa 密钥").check();
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveAttribute("placeholder", "未配置，使用免费服务");
  expect(JSON.parse(await fs.readFile(file, "utf8")).encryptedExaKey).toBeUndefined();
  expect(JSON.parse(await fs.readFile(file, "utf8")).encryptedKeys.default).toBe("broken-model-key");
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByText("此密钥无法读取，请替换或移除。")).toBeVisible();
  await page.getByLabel("API 密钥", { exact: true }).fill("recovered-model-key");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await expect(page.getByText("此密钥无法读取，请替换或移除。")).toHaveCount(0);
});

test("旧单模型配置读取后保留加密密钥", async () => {
  const encryptedKey = await desktop.evaluate(({ safeStorage }) =>
    safeStorage.encryptString("legacy-secret").toString("base64"),
  );
  await desktop.close();
  const file = path.join(sandbox, "profile", "agent-settings.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      model: "legacy-model",
      contextWindow: 32000,
      maxTokens: 1024,
      proxy: "direct",
      proxyUrl: "",
      encryptedKey,
    }),
  );
  await launch();
  const before = await page.evaluate(() => window.desktop.agent<AgentSettings>({ type: "settings" }));
  expect(before.services[0].hasKey).toBe(true);
  expect(before.models[0].model).toBe("legacy-model");
  expect(JSON.parse(await fs.readFile(file, "utf8")).formatVersion).toBeUndefined();
  await page.evaluate(async (settings) => window.desktop.agent({ type: "saveSettings", settings }), before);
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  expect(stored.formatVersion).toBe(2);
  expect(stored.encryptedKeys.default).toBeTruthy();
  expect(JSON.stringify(stored)).not.toContain("legacy-secret");
});

test("单服务密钥损坏可独立恢复，协议切换校正该服务模型等级", async () => {
  const received: { path: string; key: string }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _part of request) {
      /* consume request */
    }
    received.push({
      path: request.url ?? "",
      key: request.headers.authorization ?? "",
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "key",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "完成" }, finish_reason: null }],
      })}\n\n` +
        `data: ${JSON.stringify({ id: "key", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await create(fixture, path.join(sandbox, "projects"), "密钥恢复工程");
    await page.evaluate(
      async ({ base }) => {
        const original = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...original,
            services: [
              {
                id: "a",
                name: "服务 A",
                api: "openai-completions",
                baseUrl: `${base}/a`,
                hasKey: false,
              },
              {
                id: "b",
                name: "服务 B",
                api: "openai-completions",
                baseUrl: `${base}/b`,
                hasKey: false,
              },
            ],
            models: [
              {
                id: "a1",
                serviceId: "a",
                name: "A1",
                model: "a1",
                contextWindow: 32000,
                maxTokens: 1024,
                availableThinking: ["off", "ultra"],
                thinking: "ultra",
              },
              {
                id: "a2",
                serviceId: "a",
                name: "A2",
                model: "a2",
                contextWindow: 32000,
                maxTokens: 1024,
                availableThinking: ["high", "ultra"],
                thinking: "ultra",
              },
              {
                id: "b1",
                serviceId: "b",
                name: "B1",
                model: "b1",
                contextWindow: 32000,
                maxTokens: 1024,
                availableThinking: ["off"],
                thinking: "off",
              },
            ],
            selectedModelId: "b1",
          },
          apiKeys: { a: "old-a", b: "valid-b" },
        });
      },
      { base },
    );
    const file = path.join(sandbox, "profile", "agent-settings.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    const retained = stored.encryptedKeys.b;
    stored.encryptedKeys.a = "broken-key";
    await fs.writeFile(file, JSON.stringify(stored));
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "选择服务 服务 A" }).click();
    await expect(page.getByText("此密钥无法读取，请替换或移除。")).toBeVisible();
    await page.getByLabel("API 密钥", { exact: true }).fill("new-a");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    expect(JSON.parse(await fs.readFile(file, "utf8")).encryptedKeys.b).toBe(retained);
    await page.getByRole("button", { name: "返回工作台" }).click();
    await page.getByLabel("Agent 消息").fill("服务 B");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await page.getByRole("button", { name: "选择模型" }).click();
    await page.getByLabel("搜索模型").fill("A1");
    await page.getByRole("button", { name: /A1.*服务 A/ }).click();
    await expect(page.getByRole("button", { name: "选择模型" })).toHaveText("A1");
    await page.getByLabel("思考等级").selectOption("off");
    await page.getByLabel("Agent 消息").fill("服务 A");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
    expect(received.map((item) => [item.path, item.key])).toEqual([
      ["/b/chat/completions", "Bearer valid-b"],
      ["/a/chat/completions", "Bearer new-a"],
    ]);
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "选择服务 服务 A" }).click();
    await page.getByLabel("接口协议").selectOption("openai-responses");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    const final = await page.evaluate(() => window.desktop.agent<AgentSettings>({ type: "settings" }));
    const adjusted = final.models.filter((model) => model.serviceId === "a");
    expect(adjusted.map((model) => [model.id, model.thinking])).toEqual([
      ["a1", "off"],
      ["a2", "high"],
    ]);
    expect(adjusted.every((model) => !model.availableThinking.includes("ultra"))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("模型设置在服务和模型间保留草稿并在重开后显示保存结果", async () => {
  await page.evaluate(async () => {
    const original = await window.desktop.agent<AgentSettings>({
      type: "settings",
    });
    await window.desktop.agent({
      type: "saveSettings",
      settings: {
        ...original,
        services: [
          {
            id: "a",
            name: "服务 A",
            api: "openai-completions",
            baseUrl: "https://a.example/v1",
            hasKey: false,
          },
          {
            id: "b",
            name: "服务 B",
            api: "openai-completions",
            baseUrl: "https://b.example/v1",
            hasKey: false,
          },
        ],
        models: [
          {
            id: "a1",
            serviceId: "a",
            name: "模型 A",
            model: "a-model",
            contextWindow: 32000,
            maxTokens: 1024,
            availableThinking: ["off"],
            thinking: "off",
          },
          {
            id: "a2",
            serviceId: "a",
            name: "备用模型",
            model: "spare-model",
            contextWindow: 32000,
            maxTokens: 1024,
            availableThinking: ["off"],
            thinking: "off",
          },
          {
            id: "b1",
            serviceId: "b",
            name: "模型 B",
            model: "b-model",
            contextWindow: 64000,
            maxTokens: 2048,
            availableThinking: ["off"],
            thinking: "off",
          },
        ],
        selectedModelId: "a1",
      },
    });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await page.getByLabel("模型端点").fill("https://a-updated.example/v1");
  await page.getByLabel("API 密钥", { exact: true }).fill("secret-a");
  await page.getByRole("button", { name: "编辑模型 模型 A" }).click();
  await page.getByLabel("模型显示名称").fill("模型 A 已编辑");
  await page.getByLabel("上下文预算", { exact: true }).fill("");

  await page.getByRole("button", { name: "选择服务 服务 B" }).click();
  await page.getByLabel("模型端点").fill("https://b-updated.example/v1");
  await page.getByLabel("API 密钥", { exact: true }).fill("secret-b");
  await page.getByRole("button", { name: "编辑模型 模型 B" }).click();
  await page.getByLabel("模型名称").fill("b-model-updated");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toContainText("模型 A 已编辑 的预算无效");

  await page.getByRole("button", { name: "选择服务 服务 A" }).click();
  await expect(page.getByLabel("模型端点")).toHaveValue("https://a-updated.example/v1");
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("secret-a");
  await page.getByRole("button", { name: "编辑模型 模型 A 已编辑" }).click();
  await expect(page.getByLabel("模型显示名称")).toHaveValue("模型 A 已编辑");
  await expect(page.getByLabel("上下文预算", { exact: true })).toHaveValue("");
  await page.getByLabel("上下文预算", { exact: true }).fill("48000");
  await page.getByRole("button", { name: "删除模型 备用模型", exact: true }).click();
  await page.getByRole("button", { name: "编辑模型 模型 A 已编辑", exact: true }).click();
  await expect(page.getByLabel("上下文预算", { exact: true })).toHaveValue("48000");
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");

  await desktop.close();
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByLabel("模型端点")).toHaveValue("https://a-updated.example/v1");
  await page.getByRole("button", { name: "编辑模型 模型 A 已编辑" }).click();
  await expect(page.getByLabel("上下文预算", { exact: true })).toHaveValue("48000");
  await page.getByRole("button", { name: "选择服务 服务 B" }).click();
  await expect(page.getByLabel("模型端点")).toHaveValue("https://b-updated.example/v1");
  await page.getByRole("button", { name: "编辑模型 模型 B" }).click();
  await expect(page.getByLabel("模型名称")).toHaveValue("b-model-updated");
  const saved = await page.evaluate(() => window.desktop.agent<AgentSettings>({ type: "settings" }));
  expect(saved.services.every((service) => service.hasKey)).toBe(true);
});

test("Agent 回复排版、链接与历史阅读不被流式更新打断", async () => {
  let release: () => void = () => {};
  const continued = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = [
    "## 先看核心思路",
    "论文把 **局部信息** 与全局上下文结合起来。",
    "- 保留原始证据\n- 再比较实验结果",
    "公式为 $E = mc^2$。",
    "```python\nprint('paper')\n```",
    "| 方法 | 结果 |\n| --- | --- |\n| 基线 | 82.1 |",
    "[论文网页](https://example.org/paper)",
    "![不加载远程图片](https://example.org/tracker.png)",
    "<script>window.injected = true</script>",
    ...Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段：先定位证据，再核对原文，区分论文结论与自己的推测。`),
  ].join("\n\n");
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (text: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: "ui", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: text ? null : "stop" }] })}\n\n`,
      );
    chunk(answer);
    await continued;
    chunk("\n\n核查完成。");
    chunk(null);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await create(fixture, path.join(sandbox, "projects"), "阅读与思考");
    await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
    await page.screenshot({ path: "test-results/agent-empty.png" });
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.locator(".agent-model-row button[aria-expanded]").first().click();
    await page.getByLabel("模型端点").fill(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    await page.getByLabel("模型名称").fill("reading-model");
    const budget = page.getByLabel("上下文预算", { exact: true });
    const limit = page.getByLabel("输出上限", { exact: true });
    await budget.fill("");
    await expect(budget).toHaveValue("");
    await budget.pressSequentially("64000");
    await expect(budget).toHaveValue("64000");
    await limit.fill("");
    await expect(limit).toHaveValue("");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(limit).toHaveValue("");
    await expect(page.getByRole("status")).toHaveCount(0);
    await limit.pressSequentially("2048");
    await expect(limit).toHaveValue("2048");
    await page.getByLabel("API 密钥", { exact: true }).fill("ui-test-key");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await page.locator(".settings-canvas").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: "test-results/agent-settings.png" });
    await page.getByRole("button", { name: "编辑模型 reading-model", exact: true }).click();
    await expect(budget).toHaveValue("64000");
    await expect(limit).toHaveValue("2048");
    await page.getByRole("button", { name: "返回工作台" }).click();
    const composer = page.getByLabel("Agent 消息");
    await composer.fill("第一行第二行");
    await composer.press("Home");
    await composer.press("ArrowRight");
    await composer.press("ArrowRight");
    await composer.press("ArrowRight");
    await composer.press("Control+Enter");
    await expect(composer).toHaveValue("第一行\n第二行");
    await composer.pressSequentially("插入");
    await expect(composer).toHaveValue("第一行\n插入第二行");
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await page.getByLabel("Agent 消息").fill("帮我梳理论文的核心思路。保留 **我的原始输入**。");
    await composer.press("Enter");
    await expect(page.locator(".chat-markdown h2")).toHaveText("先看核心思路");
    await expect(page.locator(".chat-message.assistant .chat-markdown strong")).toHaveText("局部信息");
    await expect(page.locator(".chat-markdown .katex")).toHaveCount(1);
    await expect(page.locator(".chat-markdown table")).toHaveCount(1);
    await expect(page.locator(".chat-markdown pre code")).toHaveText("print('paper')\n");
    await expect(page.locator(".chat-markdown img, .chat-markdown script")).toHaveCount(0);
    await expect(page.locator(".chat-message.user .message-text strong")).toHaveText("我的原始输入");
    const chat = page.locator(".chat");
    await chat.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(await chat.evaluate((el) => el.scrollTop)).toBe(0);
    await page.screenshot({ path: "test-results/agent-conversation.png" });
    await desktop.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        (globalThis as any).__openedLink = url;
      };
    });
    await page.getByRole("link", { name: "论文网页" }).click();
    expect(await desktop.evaluate(() => (globalThis as any).__openedLink)).toBe("https://example.org/paper");
    await page.getByRole("button", { name: "回到最新消息" }).click();
    await expect.poll(() => chat.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Pi 工具真实读取、修改、计算绘图与冲突重开", async () => {
  test.setTimeout(120000);
  let releaseThinking = () => {};
  const thinkingGate = new Promise<void>((resolve) => {
    releaseThinking = resolve;
  });
  const root = path.join(sandbox, "projects", "工具工程");
  const secret = "controlled-tool-secret-STE81-controlled";
  const plot =
    "$values = 1..4 | ForEach-Object { $_ * $_ }; $sum = ($values | Measure-Object -Sum).Sum; " +
    "Set-Content -LiteralPath notes/result.csv -Value ('sum,' + $sum); " +
    'Set-Content -LiteralPath notes/result.svg -Value \'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="white"/><polyline points="10,90 60,75 110,45 160,10" fill="none" stroke="green" stroke-width="4"/></svg>\'; Write-Output (\'sum=\' + $sum); ' +
    "$p = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -PassThru; Write-Output ('finished-child=' + $p.Id)";
  const actions = [
    { name: "read", args: { path: "notes/input.md" } },
    {
      name: "edit",
      args: {
        path: "notes/input.md",
        edits: [{ oldText: "score=2", newText: "score=3" }],
      },
    },
    {
      name: "write",
      args: {
        path: "notes/result.md",
        content: "# 计算结果\n\n![平方序列](result.svg)\n\n总和：30。",
      },
    },
    { name: "write", args: { path: "tmp/plot.ps1", content: plot } },
    { name: "bash", args: { command: "& ./tmp/plot.ps1" } },
    {
      name: "bash",
      args: {
        command: `1..2100 | ForEach-Object { 'line-' + $_ }; Write-Output $env:OPENAI_API_KEY; [Console]::Write(('${secret.slice(0, 15)}' + '${secret.slice(15)}')); exit 7`,
      },
    },
    { name: "write", args: { path: "text/paper.pdf", content: "bad" } },
    {
      name: "write",
      args: { path: "sources/dictionary.json", content: "bad" },
    },
    { name: "write", args: { path: "../escape.md", content: "bad" } },
    { name: "read", args: { path: "notes/input.md" } },
    {
      name: "edit",
      args: {
        path: "notes/input.md",
        edits: [{ oldText: "score=3", newText: "score=4" }],
      },
    },
  ];
  let index = 0;
  const results: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const part of request) text += part;
    const payload = JSON.parse(text);
    const last = payload.messages.at(-1);
    if (last?.role === "tool") results.push(last);
    if (index === 10) await fs.writeFile(path.join(root, "notes/input.md"), "score=9\n");
    expect(payload.tools.map((tool: { function: { name: string } }) => tool.function.name).sort()).toEqual([
      "bash",
      "edit",
      "fetch_content",
      "get_search_content",
      "read",
      "read_pdf",
      "web_search",
      "write",
    ]);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const action = actions[index++];
    const emit = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "tools",
          object: "chat.completion.chunk",
          model: "tool-model",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (action) {
      if (index === 1) {
        emit({
          reasoning_content: "先读取工程材料，再计算并核对结果。\n".repeat(18),
        });
        await thinkingGate;
      }
      emit({
        tool_calls: [
          {
            index: 0,
            id: "reused-tool-id",
            type: "function",
            function: {
              name: action.name,
              arguments: JSON.stringify(action.args),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: "任务完成" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "工具工程");
    await fs.writeFile(path.join(root, "notes/input.md"), "score=2\n");
    await page.evaluate(
      async ({ endpoint, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "tool-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: secret,
        });
      },
      {
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        secret,
      },
    );
    await page.getByLabel("Agent 消息").fill("读取并修改 input.md，计算平方总和、绘图；最后运行可停止的长任务。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const thinking = page.locator(".thinking-card").first();
    await thinking.locator("summary").click();
    releaseThinking();
    await expect(thinking).toHaveAttribute("open", "");
    await expect(page.locator(".message-text").last()).toHaveText("任务完成");
    expect(await fs.readFile(path.join(root, "notes/input.md"), "utf8")).toBe("score=9\n");
    expect(await fs.readFile(path.join(root, "notes/result.csv"), "utf8")).toContain("sum,30");
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(await fs.readFile(fixture));
    await expect(fs.stat(path.join(sandbox, "projects/escape.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(results.find((result) => String(result.content).includes("sum=30"))).toBeTruthy();
    const computeOutput = String(results.find((result) => String(result.content).includes("sum=30")).content);
    const finishedChild = Number(computeOutput.match(/finished-child=(\d+)/)?.[1]);
    expect(finishedChild).toBeGreaterThan(0);
    expect(() => process.kill(finishedChild, 0)).toThrow();
    const truncated = page.locator('[data-tool="bash"]').nth(1);
    await truncated.locator("summary").click();
    await expect(truncated.locator(".tool-output")).toContainText("Command exited with code 7");
    await expect(truncated.locator(".tool-output")).toContainText("Showing lines");
    const conflict = page.locator('[data-tool="edit"]').last();
    await conflict.locator("summary").click();
    await expect(conflict.locator(".tool-conflict")).toContainText("score=9");
    await expect(conflict.locator(".tool-conflict")).toContainText("score=4");
    const created = page.locator('[data-tool="write"]').first();
    await created.locator("summary").click();
    await expect(created.locator(".tool-diff")).toContainText("+总和：30");
    await created.getByRole("button", { name: "notes/result.md", exact: true }).click();
    await expect(page.locator(".markdown-preview img")).toBeVisible();
    await page.screenshot({ path: "test-results/pi-tools-desktop.png" });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 760));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(900);
    await expect(page.getByRole("button", { name: "展开 Agent" })).toBeVisible();
    await page.getByRole("button", { name: "展开 Agent" }).click();
    await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/pi-tools-narrow.png" });
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /工具工程/ }).click();
    await expect(page.locator('[data-tool="read"]')).toHaveCount(2);
    await page.locator('[data-tool="read"]').first().locator("summary").click();
    await expect(page.locator('[data-tool="read"]').first()).toContainText("score=2");
    await expect(page.locator('[data-tool="edit"]').last()).toContainText("失败");
    const sessions = path.join(root, ".pi/sessions");
    for (const file of await fs.readdir(sessions)) {
      const saved = await fs.readFile(path.join(sessions, file), "utf8");
      expect(saved).not.toContain(secret);
      for (const line of saved.trim().split("\n")) {
        const output = JSON.parse(line).message?.details?.fullOutputPath;
        if (output) {
          const log = await fs.readFile(output, "utf8");
          expect(log).not.toContain(secret);
          expect(log).toContain("[已隐藏凭据]");
        }
      }
    }
  } finally {
    releaseThinking();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Pi 长任务停止清理子进程并在重开后保留状态", async () => {
  test.setTimeout(120000);
  const root = path.join(sandbox, "projects", "工具工程");
  const secret = "controlled-tool-secret-STE81-controlled";
  const command =
    "$p = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 40' -PassThru; Write-Output ('child=' + $p.Id); Start-Sleep -Seconds 40";
  let index = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const part of request) text += part;
    const payload = JSON.parse(text);
    expect(payload.tools.map((tool: { function: { name: string } }) => tool.function.name).sort()).toEqual([
      "bash",
      "edit",
      "fetch_content",
      "get_search_content",
      "read",
      "read_pdf",
      "web_search",
      "write",
    ]);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const action = index++ === 0 ? { name: "bash", args: { command } } : undefined;
    const emit = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "tools",
          object: "chat.completion.chunk",
          model: "tool-model",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (action) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "reused-tool-id",
            type: "function",
            function: {
              name: action.name,
              arguments: JSON.stringify(action.args),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: "任务完成" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  try {
    await create(fixture, path.join(sandbox, "projects"), "工具工程");
    await page.evaluate(
      async ({ endpoint, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "tool-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: secret,
        });
      },
      {
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        secret,
      },
    );
    await page.getByLabel("Agent 消息").fill("运行可停止的长任务。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const shell = page
      .locator('[data-tool="bash"]')
      .filter({ has: page.locator(".tool-arguments", { hasText: "child=" }) });
    await expect(shell).toContainText("运行中", { timeout: 60000 });
    await shell.locator("summary").click();
    await expect(shell.locator(".tool-output")).toContainText("child=", {
      timeout: 60000,
    });
    const child = Number((await shell.locator(".tool-output").innerText()).match(/child=(\d+)/)?.[1]);
    expect(child).toBeGreaterThan(0);
    await page.getByRole("button", { name: "停止回复" }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect
      .poll(() => {
        try {
          process.kill(child, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /工具工程/ }).click();
    await expect(page.locator('[data-tool="bash"]').last()).toContainText("已停止");
    const sessions = path.join(root, ".pi/sessions");
    for (const file of await fs.readdir(sessions)) {
      const saved = await fs.readFile(path.join(sessions, file), "utf8");
      expect(saved).not.toContain(secret);
      for (const line of saved.trim().split("\n")) {
        const output = JSON.parse(line).message?.details?.fullOutputPath;
        if (output) {
          const log = await fs.readFile(output, "utf8");
          expect(log).not.toContain(secret);
          expect(log).toContain("[已隐藏凭据]");
        }
      }
    }
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test("模型含凭据的流中止或异常后，终态与持久会话仍脱敏", async () => {
  const secret = "controlled-terminal-secret-STE81";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `已返回 ${secret}` }, finish_reason: null }] })}\n\n`,
    );
    if (JSON.stringify(payload.messages.at(-1).content).includes("failure")) {
      // An invalid provider chunk ends the stream after a sensitive partial reply.
      response.end("data: {invalid-json}\n\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "终态工程");
    const root = path.join(sandbox, "projects", "终态工程");
    await page.evaluate(
      async ({ endpoint, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "terminal-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: secret,
        });
      },
      {
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        secret,
      },
    );
    for (const mode of ["cancel", "failure"]) {
      if (mode === "failure") await page.getByRole("button", { name: "新会话", exact: true }).click();
      await page.getByLabel("Agent 消息").fill(mode);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message-text").last()).toContainText("[已隐藏凭据]");
      if (mode === "cancel") await page.getByRole("button", { name: "停止回复" }).click();
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
      const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
      expect(JSON.stringify(states)).not.toContain(secret);
      expect(
        states
          .flatMap((state) => state.messages)
          .some((message) => message.status === (mode === "cancel" ? "aborted" : "error")),
      ).toBe(true);
      for (const file of await fs.readdir(path.join(root, ".pi/sessions"))) {
        const stored = await fs.readFile(path.join(root, ".pi/sessions", file), "utf8");
        expect(stored).not.toContain(secret);
        expect(stored).toContain("[已隐藏凭据]");
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("read_pdf 真实视觉模型核对双栏论文、公式图表与扫描页", async () => {
  test.setTimeout(240000);
  test.skip(
    process.env.PAPER30MIN_REAL_MODEL !== "1" ||
      (!process.env.PAPER30MIN_REAL_CONFIG && !process.env.PAPER30MIN_REAL_PROFILE),
    "需显式提供本机真实视觉模型配置文件或加密配置目录，trace 必须关闭。",
  );
  const model = process.env.PAPER30MIN_REAL_CONFIG
    ? JSON.parse(await fs.readFile(process.env.PAPER30MIN_REAL_CONFIG, "utf8"))
    : null;
  if (!model) {
    await desktop.close();
    // Windows safeStorage needs the source profile's encrypted master key at startup.
    for (const file of ["agent-settings.json", "Local State"])
      await fs.copyFile(path.join(process.env.PAPER30MIN_REAL_PROFILE!, file), path.join(sandbox, "profile", file));
    await launch();
  }
  await create(path.resolve("tests/fixtures/corpus/1706.03762.pdf"), path.join(sandbox, "projects"), "真实 PDF 工程");
  const root = path.join(sandbox, "projects", "真实 PDF 工程");
  const scanPath = process.env.PAPER30MIN_REAL_SCAN;
  const scan = scanPath ? `text/${path.basename(scanPath)}` : null;
  if (scanPath) await fs.copyFile(scanPath, path.join(root, scan!));
  await page.evaluate(async (model) => {
    const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
    if (model) {
      settings.services[0].baseUrl = model.baseUrl;
      settings.models[0] = {
        ...settings.models[0],
        model: model.model,
        vision: true,
        thinking: "high",
        availableThinking: ["off", "high"],
        maxTokens: 8192,
      };
      settings.selectedModelId = settings.models[0].id;
    } else {
      const selected = settings.models.find((item) => item.id === settings.selectedModelId)!;
      if (!selected.vision || !selected.availableThinking.includes("high"))
        throw new Error("真实验证需要支持视觉输入和 high 思考强度的模型配置。");
      selected.thinking = "high";
    }
    settings.proxy = "direct";
    await window.desktop.agent({ type: "saveSettings", settings, ...(model ? { apiKey: model.apiKey } : {}) });
  }, model);
  const settings = await page.evaluate(() => window.desktop.agent<AgentSettings>({ type: "settings" }));
  const modelId = settings.models.find((item) => item.id === settings.selectedModelId)!.model;
  await page
    .getByLabel("Agent 消息")
    .fill(
      "请实际调用 read_pdf 核对 text/paper.pdf 第8页的翻译结果表，再读取第4页整页核对注意力公式。" +
        (scan
          ? `另读取工程内扫描件 ${scan} 第1页，这是论文第3页的扫描图，无文本层，请依据图像解释编码器和解码器结构的区别。`
          : "") +
        "最终简要报告英德 BLEU 分数、注意力公式与结构区别，每项说明文件路径与页码。禁止通过 read/bash/web_search 旁路读取资料。",
    );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 210000 });
  await expect(page.locator(".agent-error")).toHaveCount(0);
  const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
  const calls = states.flatMap((state) => state.messages.flatMap((message) => message.tools ?? []));
  const successful = calls.filter((tool) => tool.name === "read_pdf" && tool.status === "done");
  expect(successful.length).toBeGreaterThanOrEqual(scan ? 3 : 2);
  expect(successful.every((tool) => !(tool.arguments as any).region)).toBe(true);
  if (scan) expect(successful.some((tool) => (tool.arguments as any).path === scan)).toBe(true);
  for (const tool of successful) {
    const info = JSON.parse(tool.output!);
    expect(info).not.toHaveProperty("text");
    expect(info).not.toHaveProperty("textStatus");
    expect(info).not.toHaveProperty("textTruncated");
    for (const field of ["link", "markdown"]) expect(info).not.toHaveProperty(field);
    expect(info).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  }
  const reply = states
    .flatMap((state) => state.messages)
    .filter((message) => message.role === "assistant")
    .at(-1)!.text;
  expect(reply).toContain("28.4");
  await page.screenshot({ path: "test-results/real-model/ste94-pdf.png" });
  await fs.writeFile(
    "test-results/real-model/ste94-evidence.json",
    JSON.stringify(
      {
        model: modelId,
        thinking: "high",
        reply,
        calls: successful.map((tool) => ({ args: tool.arguments, pdf: (tool.details as any).pdf })),
      },
      null,
      2,
    ),
  );
  // Optional local setup retains only Electron-encrypted settings, never the input secret file.
  if (process.env.PAPER30MIN_REAL_SAVE_PROFILE) {
    await fs.mkdir(process.env.PAPER30MIN_REAL_SAVE_PROFILE, { recursive: true });
    for (const file of ["agent-settings.json", "Local State"])
      await fs.copyFile(path.join(sandbox, "profile", file), path.join(process.env.PAPER30MIN_REAL_SAVE_PROFILE, file));
  }
});

test("read_pdf 经真实 Electron 和 Pi 传送完整页图，保留视口且不登记引用并可重开", async () => {
  let index = 0;
  const images: string[] = [];
  const results: any[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    const tools = payload.messages.filter((message: any) => message.role === "tool");
    if (tools.length > results.length) {
      const info = JSON.parse(tools.at(-1).content.split("\n")[0]);
      results.push(info);
    }
    const imageUrls = payload.messages.flatMap((message: any) =>
      Array.isArray(message.content)
        ? message.content.flatMap((block: any) => (block.type === "image_url" ? [block.image_url.url] : []))
        : [],
    );
    for (const url of imageUrls) if (!images.includes(url)) images.push(url);
    const args =
      index === 0
        ? { path: "text/paper.pdf", page: 1 }
        : index === 1
          ? { path: "text/paper.pdf", page: 3, scale: 2 }
          : null;
    index++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = args
      ? {
          tool_calls: [
            {
              index: 0,
              id: `pdf-${index}`,
              type: "function",
              function: { name: "read_pdf", arguments: JSON.stringify(args) },
            },
          ],
        }
      : { content: "已核对 text/paper.pdf 第 1、3 页的公式图表；暂无可用引用。" };
    for (const [value, finish] of [
      [delta, null],
      [{}, args ? "tool_calls" : "stop"],
    ])
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = path.resolve("tests/fixtures/corpus/1706.03762.pdf");
    await create(source, path.join(sandbox, "projects"), "PDF 工具工程");
    const root = path.join(sandbox, "projects", "PDF 工具工程");
    await expectPdfRendered();
    await jumpPdfPage(2);
    await setPdfZoom("125");
    await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
    await expect
      .poll(
        async () =>
          JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf["text/paper.pdf"],
      )
      .toMatchObject({ page: 2, zoom: 1.25 });
    const before = JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf;
    await page.evaluate(
      async (endpoint) => {
        const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "vision-fixture";
        settings.models[0].vision = true;
        await window.desktop.agent({ type: "saveSettings", settings, apiKey: "pdf-fixture-key" });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page.getByLabel("Agent 消息").fill("核对工程论文原页和公式图表，说明来源文件和页码。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text.chat-markdown").last()).toContainText("暂无可用引用");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).not.toHaveProperty("text");
      expect(result).not.toHaveProperty("textStatus");
      expect(result).not.toHaveProperty("textTruncated");
      for (const field of ["link", "markdown"]) expect(result).not.toHaveProperty(field);
    }
    expect(images).toHaveLength(2);
    const { PNG } = await import("pngjs");
    const crop = PNG.sync.read(Buffer.from(images[1].split(",")[1], "base64"));
    expect([crop.width, crop.height]).toEqual([1224, 1584]);
    expect(results[1]).toMatchObject({ path: "text/paper.pdf", page: 3, width: 612, height: 792, scale: 2 });
    expect(JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf).toEqual(before);
    await expect(page.getByRole("tab", { name: "paper.pdf", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-tool="read_pdf"][data-status="done"]')).toHaveCount(2);
    await page.screenshot({ path: "test-results/ste94-read-only.png" });
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /PDF 工具工程/ }).click();
    await expect(page.locator('[data-tool="read_pdf"][data-status="done"]')).toHaveCount(2);
    await expect(page.locator(".message-text.chat-markdown").last()).toContainText("暂无可用引用");
    const sessionFiles = await fs.readdir(path.join(root, ".pi/sessions"));
    const history = await fs.readFile(path.join(root, ".pi/sessions", sessionFiles[0]), "utf8");
    expect(history).toContain('"type":"image"');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Pi 普通对话可写入文件和运行 Shell", async () => {
  let index = 0;
  const server = createServer(async (request, response) => {
    for await (const _part of request) {
      /* consume the request body */
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const action =
      index++ === 0
        ? {
            name: "write",
            arguments: JSON.stringify({
              path: "notes/requested.md",
              content: "hello",
            }),
          }
        : index === 2
          ? {
              name: "bash",
              arguments: JSON.stringify({
                command: "Set-Content notes/requested.txt hello",
              }),
            }
          : null;
    const delta = action
      ? {
          tool_calls: [
            {
              index: 0,
              id: "normal-" + index,
              type: "function",
              function: action,
            },
          ],
        }
      : { content: "文件已生成" };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "普通对话工程");
    await page.evaluate(
      async (endpoint) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        settings.services[0].baseUrl = endpoint;
        settings.models[0].model = "tool-model";
        await window.desktop.agent({
          type: "saveSettings",
          settings,
          apiKey: "normal-key",
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page
      .getByLabel("Agent 消息")
      .fill("请写入 notes/requested.md，并运行命令生成 notes/requested.txt，内容均为 hello。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("文件已生成");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(await fs.readdir(path.join(sandbox, "projects/普通对话工程/notes"))).toEqual([
      "requested.md",
      "requested.txt",
    ]);
    expect(await fs.readFile(path.join(sandbox, "projects/普通对话工程/notes/requested.md"), "utf8")).toBe("hello");
    expect((await fs.readFile(path.join(sandbox, "projects/普通对话工程/notes/requested.txt"), "utf8")).trim()).toBe(
      "hello",
    );
    await expect(page.locator('[data-tool="write"]')).toContainText("完成");
    await expect(page.locator('[data-tool="bash"]')).toContainText("完成");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("STE-99 可编辑记忆 Skill 调用与文件会话重开", async () => {
  const requests: any[] = [];
  let root: string;
  let manuscript: string;
  let link: string;
  let mode: "card" | "chat" = "chat";
  let step = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    let calls: { name: string; args: unknown }[] = [];
    if (mode !== "chat" && step === 0) calls = [{ name: "read", args: { path: manuscript } }];
    if (mode === "card" && step === 1)
      calls = [
        {
          name: "write",
          args: {
            path: "memories/注意力机制.md",
            content: `# 注意力机制\n\n论文事实：该方法使用注意力。[原文](${link})\n\n讨论理解：值得关注信息之间的关联。\n\n待核实：扩展到其他任务的条件。`,
          },
        },
      ];
    step++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      response.write(`data: ${JSON.stringify({ id: "research", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (calls.length) {
      chunk({
        tool_calls: calls.map((call, index) => ({
          index,
          id: `research-${step}-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: mode === "card" ? "已整理 memories/注意力机制.md。" : "已完成本轮任务。" });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "研究成果");
    root = path.join(sandbox, "projects/研究成果");
    manuscript = "text/paper.md";
    link = "/text/paper.pdf";
    await fs.writeFile(
      path.join(root, manuscript),
      `# Attention Is All You Need\n\nThe dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.\n\n[原文](${link})\n`,
    );
    await page.evaluate(
      async (base) => {
        const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...settings,
            services: [{ id: "research", name: "受控模型", api: "openai-completions", baseUrl: base, hasKey: false }],
            models: [
              {
                id: "research",
                serviceId: "research",
                name: "受控模型",
                model: "fixture",
                contextWindow: 32000,
                maxTokens: 4096,
                thinking: "off",
                availableThinking: ["off"],
              },
            ],
            selectedModelId: "research",
          },
          apiKeys: { research: "test-key" },
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "产品 Skill", exact: true }).click();
    await page.getByLabel("产品 Skill", { exact: true }).selectOption("memory-card.md");
    const skill = page.getByLabel("提示词", { exact: true });
    const content = await skill.inputValue();
    await skill.fill(" ");
    await page.getByRole("button", { name: "保存提示词", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("不能为空");
    await expect(skill).toHaveValue(" ");
    await skill.fill(content + "\n本轮编辑核验：保留讨论适用条件。");
    await page.getByRole("button", { name: "保存提示词", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await page.getByRole("button", { name: "返回工作台", exact: true }).click();
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("这段方法的适用条件是什么？只讨论。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message.assistant")).toContainText("已完成本轮任务");
    expect(await fs.readdir(path.join(root, "memories"))).toEqual([]);
    mode = "card";
    step = 0;
    const input = page.getByLabel("Agent 消息");
    await input.fill("把刚才讨论的注意力机制整理为记忆卡片 @");
    await input.pressSequentially("记忆卡片");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant").last()).toContainText("已整理");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(JSON.stringify(requests.at(-1))).toContain("本轮编辑核验");
    const card = await fs.readFile(path.join(root, "memories/注意力机制.md"), "utf8");
    expect(card).toContain(link);
    const writeTool = page.locator('.tool-process[data-tool="write"]').last();
    await writeTool.locator("summary").click();
    await expect(writeTool.locator(".tool-diff")).toContainText("讨论理解");
    await writeTool.getByRole("button", { name: "memories/注意力机制.md", exact: true }).click();
    await expect(page.getByRole("tab", { name: "注意力机制.md", exact: true })).toBeVisible();
    await page.locator(".markdown-preview a").filter({ hasText: "原文" }).click();
    await expect(page.getByRole("tab", { name: "paper.pdf" })).toHaveAttribute("aria-selected", "true");
    const sessionId = await page.getByLabel("会话", { exact: true }).inputValue();
    await desktop.close();
    await launch();
    await choose(root);
    await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
    await page.getByLabel("会话", { exact: true }).selectOption(sessionId);
    await expect(page.locator(".chat-message.assistant").last()).toContainText("已整理");
    expect(await fs.readFile(path.join(root, "memories/注意力机制.md"), "utf8")).toBe(card);
    await page.getByRole("tab", { name: "注意力机制.md", exact: true }).click();
    await expect(page.locator(".markdown-preview")).toContainText("讨论理解");
    await page.screenshot({ path: "test-results/ste99-memory-card.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("STE-99 真实模型按需整理指定原文与讨论为记忆卡片", async () => {
  test.setTimeout(180000);
  test.skip(
    process.env.PAPER30MIN_REAL_MODEL !== "1" || !process.env.PAPER30MIN_REAL_PROFILE,
    "需真实模型隔离配置，关闭 trace。",
  );
  await desktop.close();
  for (const file of ["agent-settings.json", "Local State"])
    await fs.copyFile(path.join(process.env.PAPER30MIN_REAL_PROFILE!, file), path.join(sandbox, "profile", file));
  await launch();
  await create(path.resolve("tests/fixtures/corpus/1706.03762.pdf"), path.join(sandbox, "projects"), "真实聊天材料");
  const root = path.join(sandbox, "projects/真实聊天材料");
  await fs.writeFile(
    path.join(root, "text/paper.md"),
    "# Attention Is All You Need\n\nThe dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.\n\n[原文](/text/paper.pdf)\n",
  );
  await fs.writeFile(path.join(root, "notes/阅读问题.md"), "本轮只研究编码器和解码器的职责。核验词：松柏七号。");
  const input = page.getByLabel("Agent 消息");
  await input.fill(
    "请把阅读问题整理为 memories/编码器与解码器.md 记忆卡片。先 read 指定笔记和工程论文解析稿，保留笔记核验词；引用原文时写出文件路径与页码。论文事实、讨论理解和待核实问题应区分。只整理给出的范围，不假称已读完整论文。 ",
  );
  await input.press("End");
  await input.pressSequentially(" @阅读问题");
  await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await input.press("End");
  await input.pressSequentially(" @记忆卡片");
  await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(page.locator(".chat-attachments > span")).toHaveCount(2);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 135000 });
  await expect(page.locator(".agent-error")).toHaveCount(0);
  const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
  expect(
    states
      .flatMap((state) => state.messages.flatMap((message) => message.tools ?? []))
      .some((tool) => tool.name === "read" && tool.status === "done"),
  ).toBe(true);
  const answer = states
    .flatMap((state) => state.messages)
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  const card = await fs.readFile(path.join(root, "memories/编码器与解码器.md"), "utf8");
  expect(card).toContain("松柏七号");
  expect(card).toMatch(/text\/|第\s*\d+\s*页/);
  expect(answer).toContain("memories/");
  await fs.writeFile("test-results/real-model/ste99-evidence.json", JSON.stringify({ states, card }, null, 2));
  await page.screenshot({ path: "test-results/real-model/ste99-chat.png" });
});

test("STE-95 文档与 Skill 附件去重、组合发送及历史重开", async () => {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "attachments", choices: [{ index: 0, delta: { content: "已核对" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "attachments", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "聊天材料");
    const root = path.join(parent, "聊天材料");
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes/问题(中文).md"), "不应自动发送的全文");
    await page.evaluate(
      async (base) => {
        const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...settings,
            services: [
              { id: "attachments", name: "受控模型", api: "openai-completions", baseUrl: base, hasKey: false },
            ],
            models: [
              {
                id: "attachments",
                serviceId: "attachments",
                name: "受控模型",
                model: "fixture",
                contextWindow: 32000,
                maxTokens: 1024,
                thinking: "off",
                availableThinking: ["off"],
              },
            ],
            selectedModelId: "attachments",
          },
          apiKeys: { attachments: "test-key" },
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    const input = page.getByLabel("Agent 消息");
    await input.fill("解释这里 @问题");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await input.pressSequentially("@记忆卡片");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await input.pressSequentially("@问题");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await expect(page.locator(".chat-attachments > span")).toHaveCount(2);
    await input.fill('解释这里\n\n```json\n{"问题": "保留用户代码"}\n```');
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant")).toContainText("已核对");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    expect(requests).toHaveLength(1);
    const sent = JSON.stringify(requests[0].messages.filter((message) => message.role === "user"));
    expect(sent).toContain("问题(中文).md");
    expect(sent).not.toContain("不应自动发送的全文");
    expect(sent).toContain("# 记忆卡片");
    await expect(page.locator(".chat-message.user pre")).toHaveText('{"问题": "保留用户代码"}');
    const original = await page.locator(".chat-message.user .message-text").textContent();
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /聊天材料/ }).click();
    await expect(page.locator(".chat-message.user .message-text")).toHaveText(original!);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("STE-95 文档缺失报错、移除后发送及失败历史重开", async () => {
  let fail = false;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (fail) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "documents", choices: [{ index: 0, delta: { content: "已完成" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "documents", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await create(fixture, path.join(sandbox, "projects"), "文档附件");
    const root = path.join(sandbox, "projects/文档附件");
    await page.evaluate(
      async (base) => {
        const settings = await window.desktop.agent<AgentSettings>({ type: "settings" });
        await window.desktop.agent({
          type: "saveSettings",
          settings: {
            ...settings,
            services: [{ id: "documents", name: "受控模型", api: "openai-completions", baseUrl: base, hasKey: false }],
            models: [
              {
                id: "documents",
                serviceId: "documents",
                name: "受控模型",
                model: "fixture",
                contextWindow: 32000,
                maxTokens: 1024,
                thinking: "off",
                availableThinking: ["off"],
              },
            ],
            selectedModelId: "documents",
          },
          apiKeys: { documents: "test-key" },
        });
      },
      `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    );
    await fs.writeFile(path.join(root, "notes/即将移动.md"), "指定材料");
    const input = page.getByLabel("Agent 消息");
    await input.fill("读取 @即将移动");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await fs.rename(path.join(root, "notes/即将移动.md"), path.join(root, "notes/已移动.md"));
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("指定文档已缺失或移动");
    expect(requests).toHaveLength(0);
    await page.getByRole("button", { name: "移除 notes/即将移动.md", exact: true }).click();
    await input.fill("读取 @已移动");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant")).toContainText("已完成");
    expect(requests).toHaveLength(1);
    await input.fill("再次读取 @已移动");
    await expect(page.getByRole("listbox", { name: "选择文档或 Skill" }).getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    fail = true;
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("认证失败");
    expect(requests).toHaveLength(2);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /文档附件/ }).click();
    await expect(page.locator(".chat-message.user")).toHaveCount(2);
    await expect(page.locator(".chat-message.user").last()).toContainText("再次读取");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("旧 Pi 会话仅在显示层剥离来源快照", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const sessionDir = path.join(root, ".pi/sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const legacyText = [
    "请核对历史来源",
    "",
    `[来源](<paper://cite/${"0".repeat(32)}>)`,
    "",
    "发送时的来源快照（选区为关注范围；正文请按位置 read，按需 read_pdf）：",
    "",
    "```json",
    JSON.stringify({ kind: "citation", status: "available", path: "text/paper.pdf", sha256: "abc", pages: [] }),
    "```",
  ].join("\n");
  const session = SessionManager.create(root, sessionDir);
  session.appendMessage({ role: "user", content: legacyText, timestamp: Date.now() });
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /研究工程/ }).click();
  const message = page.locator(".chat-message.user .message-text");
  await expect(message).toContainText("请核对历史来源");
  await expect(message).not.toContainText("来源快照");
  await expect(message).not.toContainText('"kind"');
  await expect(message.getByRole("link", { name: "来源", exact: true })).toHaveCount(1);
  const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
  expect(JSON.stringify(states)).toContain("来源快照");
  expect(states.flatMap((state) => state.messages).some((message) => message.text.includes('"kind":"citation"'))).toBe(
    true,
  );
});

test("Pi 原生对话流式回复、补充、分支及搬迁重开，密钥留本机", async () => {
  const secret = "controlled-test-key-STE79";
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    expect(request.headers.authorization).toBe("Bearer " + secret);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (text: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: "controlled-model", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: text ? null : "stop" }] })}\n\n`,
      );
    chunk("真实流式");
    await new Promise((r) => setTimeout(r, 1000));
    chunk("回复完成。");
    chunk(null);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "Pi 论文工程");
    const root = path.join(parent, "Pi 论文工程");
    await page.getByLabel("Agent 消息").fill("不附加论文，只问你好");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请先在设置中配置");
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByLabel("模型端点").fill(`http://127.0.0.1:${address.port}/v1`);
    await page.locator(".agent-model-row button[aria-expanded]").first().click();
    await page.getByLabel("模型名称").fill("controlled-model");
    await page.getByLabel("API 密钥", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "返回工作台" }).click();
    await expect(page.getByLabel("Agent 消息")).toHaveValue("不附加论文，只问你好");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("真实流式");
    await page.getByLabel("Agent 消息").fill("补充一个问题");
    await page.getByRole("button", { name: "补充消息", exact: true }).click();
    await expect(page.locator(".queued-message")).toContainText("补充一个问题");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    expect(requests).toHaveLength(2);
    const conversationMessages = requests.flatMap((request) =>
      request.messages.filter((message) => message.role !== "system"),
    );
    expect(JSON.stringify(conversationMessages)).not.toContain("paper.pdf");
    expect(conversationMessages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
    const originalId = await page.getByLabel("会话", { exact: true }).inputValue();
    await page.getByRole("button", { name: "从此消息分支" }).nth(1).click();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    await expect(page.getByLabel("会话").locator("option")).toHaveCount(2);
    const branchId = await page.getByLabel("会话", { exact: true }).inputValue();
    await page.getByLabel("Agent 消息").fill("分支继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText("真实流式回复完成。");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    await page.getByLabel("会话", { exact: true }).selectOption(originalId);
    await page.getByLabel("Agent 消息").fill("回到原会话继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText("真实流式回复完成。");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(6);
    await page.getByLabel("会话", { exact: true }).selectOption(branchId);
    const sessionDir = path.join(root, ".pi", "sessions");
    const files = await fs.readdir(sessionDir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const raw = await fs.readFile(path.join(sessionDir, file), "utf8");
      expect(raw).not.toContain(secret);
      expect(JSON.parse(raw.split("\n")[0]).type).toBe("session");
    }
    expect(await fs.readFile(path.join(sandbox, "profile", "agent-settings.json"), "utf8")).not.toContain(secret);
    const moved = path.join(parent, "搬迁后 Pi 工程");
    await desktop.close();
    await fs.rename(root, moved);
    await launch();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveAttribute("placeholder", "已保存在本机，留空保留");
    await page.getByRole("button", { name: "返回工程" }).click();
    await choose(moved);
    await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
    await page.getByLabel("会话", { exact: true }).selectOption(branchId);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    await page.getByLabel("Agent 消息").fill("重开后继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText("真实流式回复完成。");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(6);
    await page.screenshot({ path: "test-results/ste79-agent-desktop.png" });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 760));
    await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
    await expect(page.getByLabel("Agent 消息")).toBeVisible();
    await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/ste79-agent-narrow.png" });
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(page.getByLabel("模型端点")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/ste79-settings-narrow.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test.describe("Pi 并发会话", () => {
  const secret = "controlled-private-key";
  let tunneled: number;
  let failNext: boolean;
  let timers: Set<NodeJS.Timeout>;
  let sockets: Set<Duplex>;
  let server: Server;
  let proxy: Server;
  let lateResponse: PromiseWithResolvers<void>;
  let lateResponseClosed: PromiseWithResolvers<void>;

  test.beforeEach(async () => {
    tunneled = 0;
    failNext = true;
    timers = new Set();
    sockets = new Set();
    lateResponse = Promise.withResolvers<void>();
    lateResponseClosed = Promise.withResolvers<void>();
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const content = payload.messages.filter((m: { role: string }) => m.role === "user").at(-1).content;
      const last =
        typeof content === "string"
          ? content
          : content
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text: string }) => c.text)
              .join("");
      if (last === "触发失败" && failNext) {
        failNext = false;
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Invalid key " + secret,
              type: "authentication_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (text: string | null) =>
        response.write(
          `data: ${JSON.stringify({ id: "controlled", choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: text ? null : "stop" }] })}\n\n`,
        );
      chunk(last.includes("停滞") ? "等待中的片段" : "独立回复");
      if (last.includes("停滞")) {
        // 停止会中止 socket，end 回调不保证触发；close 同时覆盖正常结束与中止。
        response.once("close", () => lateResponseClosed.resolve());
        await lateResponse.promise;
        chunk("迟到内容不得落盘");
        chunk(null);
        response.end("data: [DONE]\n\n");
        return;
      }
      const timer = setTimeout(() => {
        chunk("已完成");
        chunk(null);
        response.end("data: [DONE]\n\n");
        timers.delete(timer);
      }, 500);
      timers.add(timer);
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const port = (server.address() as { port: number }).port;
    proxy = createServer();
    proxy.on("connect", (_request, client, head) => {
      tunneled++;
      const upstream = connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      sockets.add(client);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => {
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      });
    });
    const proxyListening = Promise.withResolvers<void>();
    proxy.listen(0, "127.0.0.1", proxyListening.resolve);
    await proxyListening.promise;
    const proxyPort = (proxy.address() as { port: number }).port;
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "并发会话工程");
    await page.evaluate(
      async ({ port, proxyPort, secret }) => {
        const settings = await window.desktop.agent<AgentSettings>({
          type: "settings",
        });
        await window.desktop.agent({
          type: "saveSettings",
          apiKey: secret,
          settings: {
            ...settings,
            services: settings.services.map((service) => ({
              ...service,
              baseUrl: `http://127.0.0.1:${port}/v1`,
            })),
            models: settings.models.map((model) => ({
              ...model,
              model: "controlled",
            })),
            proxy: "custom",
            proxyUrl: `http://127.0.0.1:${proxyPort}`,
          },
        });
      },
      { port, proxyPort, secret },
    );
  });

  test.afterEach(async () => {
    lateResponse.resolve();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    proxy.closeAllConnections();
    const serverClosed = Promise.withResolvers<void>();
    const proxyClosed = Promise.withResolvers<void>();
    server.close(() => serverClosed.resolve());
    proxy.close(() => proxyClosed.resolve());
    await Promise.all([serverClosed.promise, proxyClosed.promise]);
  });

  test("失败恢复经代理持久化", async () => {
    await page.getByLabel("Agent 消息").fill("触发失败");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".agent-error")).toContainText("模型认证失败");
    expect(tunneled).toBeGreaterThan(0);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /并发会话工程/ }).click();
    await expect(page.locator(".chat-message small")).toHaveText("请求失败");
    await page.getByLabel("Agent 消息").fill("失败后继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("独立回复已完成");
  });

  test("停止会话后迟到响应不得落盘", async () => {
    const root = path.join(sandbox, "projects", "并发会话工程");
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("会话 A 停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("等待中的片段");
    const a = await page.getByLabel("会话", { exact: true }).inputValue();
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("会话 B 正常");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const b = await page.getByLabel("会话", { exact: true }).inputValue();
    await page.getByLabel("会话", { exact: true }).selectOption(a);
    await page.getByRole("button", { name: "停止回复" }).click();
    await expect(page.locator(".chat-message small")).toHaveText("已停止");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await page.getByLabel("会话", { exact: true }).selectOption(b);
    await expect(page.locator(".message-text").last()).toHaveText("独立回复已完成");
    lateResponse.resolve();
    await lateResponseClosed.promise;
    const all = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
    expect(all.find((s) => s.id === a)?.messages.at(-1)?.text).toBe("等待中的片段");
    for (const file of await fs.readdir(path.join(root, ".pi", "sessions"))) {
      const raw = await fs.readFile(path.join(root, ".pi", "sessions", file), "utf8");
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain("迟到内容不得落盘");
    }
  });

  test("工程隔离、停滞关闭与异常退出保持终态", async () => {
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("关闭期间停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("等待中的片段");
    await page.getByRole("button", { name: "所有工程", exact: true }).click();
    await create(fixture, undefined, "另一工程");
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await page.getByLabel("Agent 消息").fill("另一工程正常回复");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("独立回复已完成");
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("窗口退出时停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("等待中的片段");
    const closing = desktop.close();
    await expect.poll(() => desktopProcess.exitCode, { timeout: 4000 }).toBe(0);
    await closing;
    await launch();
    await page.getByRole("button", { name: /^另一工程/ }).click();
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("进程异常停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("等待中的片段");
    await desktop.evaluate(({ app }) => {
      const target = app.getAppMetrics().find((m) => m.name === "Paper30Min Project");
      if (!target) throw new Error("找不到测试工程进程");
      process.kill(target.pid);
    });
    await expect(page.locator(".agent-error")).toContainText("工程进程已退出");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
  });
});

test("Responses 与 Anthropic 文本协议及损坏配置恢复通过真实 Electron 接线", async () => {
  const routes: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the provider request. */
    }
    routes.push(request.url!);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: { type: string; [key: string]: unknown }) =>
      response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    if (request.url === "/v1/responses") {
      event({ type: "response.created", response: { id: "resp-test" } });
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg-test",
          role: "assistant",
          content: [],
        },
      });
      event({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Responses 回复",
      });
      event({
        type: "response.completed",
        response: {
          id: "resp-test",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
    } else {
      event({
        type: "message_start",
        message: {
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "controlled",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Anthropic 回复" },
      });
      event({ type: "content_block_stop", index: 0 });
      event({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      });
      event({ type: "message_stop" });
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await create(fixture, path.join(sandbox, "projects"), "研究工程");
    await fs.writeFile(path.join(sandbox, "profile", "agent-settings.json"), "{invalid");
    for (const api of ["openai-responses", "anthropic-messages"] as const) {
      await page.getByRole("button", { name: "模型设置", exact: true }).click();
      if (api === "openai-responses") await expect(page.getByRole("status")).toContainText("模型配置无法读取");
      await page.getByLabel("接口协议").selectOption(api);
      await page.getByLabel("模型端点").fill(`http://127.0.0.1:${port}${api === "anthropic-messages" ? "" : "/v1"}`);
      await page.locator(".agent-model-row button[aria-expanded]").first().click();
      await page.getByLabel("模型名称").fill("controlled");
      await page.getByLabel("API 密钥", { exact: true }).fill("controlled-protocol-key");
      await page.getByRole("button", { name: "保存配置" }).click();
      await expect(page.getByRole("status")).toHaveText("已保存");
      await page.getByRole("button", { name: "返回工作台" }).click();
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await page.getByLabel("Agent 消息").fill("基础文本");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message-text").last()).toHaveText(
        api === "openai-responses" ? "Responses 回复" : "Anthropic 回复",
      );
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
      await expect(page.locator(".agent-error")).toHaveCount(0);
    }
    expect(routes.map((route) => new URL(route, "http://localhost").pathname)).toEqual([
      "/v1/responses",
      "/v1/messages",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.describe("真实模型验证", () => {
  test("用本机旧配置运行真实 Pi 消息与工具任务并重开", async () => {
    test.setTimeout(180000);
    test.skip(process.env.PAPER30MIN_REAL_MODEL !== "1", "需用户授权复用本机旧模型配置后显式运行。");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(
      path.join(os.homedir(), "AppData/Roaming/com.paper30min.reader/database/library.sqlite"),
      { readOnly: true },
    );
    let model: { baseUrl: string; model: string; apiKey: string };
    try {
      model = JSON.parse(
        (db.prepare("SELECT value FROM settings WHERE key = 'model'").get() as { value: string }).value,
      );
    } finally {
      db.close();
    }
    expect(!!model.apiKey).toBe(true);
    await create(fixture, path.join(sandbox, "projects"), "真实模型工程");
    await page.evaluate(async (model) => {
      const settings = await window.desktop.agent<AgentSettings>({
        type: "settings",
      });
      await window.desktop.agent({
        type: "saveSettings",
        apiKey: model.apiKey,
        settings: {
          ...settings,
          services: settings.services.map((service) => ({
            ...service,
            baseUrl: model.baseUrl,
          })),
          models: settings.models.map((entry) => ({
            ...entry,
            model: model.model,
            maxTokens: 2048,
          })),
          proxy: "direct",
        },
      });
    }, model);
    await page.getByLabel("Agent 消息").fill("只用一句中文回答：你好。不要读取文件或调用工具。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant .message-text")).not.toHaveText("", { timeout: 60000 });
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 60000 });
    await expect(page.locator(".agent-error")).toHaveCount(0);
    const root = path.join(sandbox, "projects", "真实模型工程");
    if (process.env.PAPER30MIN_REAL_WEB === "1") {
      await page
        .getByLabel("Agent 消息")
        .fill(
          "请调研 Attention Is All You Need 的主要结果。使用 web_search 找到论文原始来源，再用 fetch_content 读取该网页，并用 get_search_content 在实际获取正文中查找 BLEU。用中文简短综合模型特点和 WMT 2014 英德 BLEU 结果，只引用你实际使用的一两个网页，不列出全部搜索结果。不要读取或修改工程文件。",
        );
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 120000 });
      await expect(page.locator(".agent-error")).toHaveCount(0);
      const states = await page.evaluate((root) => window.desktop.agent<ChatSession[]>({ type: "list", root }), root);
      const tools = states.flatMap((state) => state.messages.flatMap((message) => message.tools ?? []));
      for (const name of ["web_search", "fetch_content", "get_search_content"])
        expect(tools.some((tool) => tool.name === name && tool.status === "done")).toBe(true);
      await expect(page.locator(".chat-message.assistant .message-text").last()).toContainText("28.4");
      await expect(page.locator('.message-text a[href*="arxiv.org"]')).toHaveCount(1);
      const replies = await page.locator(".chat-message.assistant .message-text").allTextContents();
      await page.screenshot({ path: "test-results/real-model/ste100-web.png" });
      await desktop.close();
      await launch();
      await page.getByRole("button", { name: /真实模型工程/ }).click();
      await expect(page.locator(".chat-message.assistant .message-text")).toHaveText(replies);
      expect(await fs.readdir(path.join(root, "notes"))).toEqual([]);
      return;
    }
    await fs.writeFile(path.join(root, "notes/numbers.csv"), "value\n1\n2\n3\n4\n");
    await page
      .getByLabel("Agent 消息")
      .fill(
        "请执行一个小型计算任务：先用 read 读取 notes/numbers.csv，编写 tmp/calculate.ps1，用 bash（Windows PowerShell）运行脚本计算各数平方之和，将计算结果保存为 notes/calculation.csv（表头 metric,value，数据 sum_squares,真实结果）；用 write 保存 notes/calculation.md，正文包含计算结果。必须真实调用工具，不访问工程外文件，不读取 PDF。最后简短回复结果。",
      );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0, { timeout: 120000 });
    await expect(page.locator(".agent-error")).toHaveCount(0);
    expect(await fs.readFile(path.join(root, "notes/calculation.csv"), "utf8")).toContain("sum_squares,30");
    expect(await fs.readFile(path.join(root, "notes/calculation.md"), "utf8")).toContain("30");
    const tools = await page.evaluate(async (root) => {
      const states = await window.desktop.agent<ChatSession[]>({
        type: "list",
        root,
      });
      return states.flatMap((state) => state.messages.flatMap((message) => message.tools ?? []));
    }, root);
    for (const name of ["read", "write", "bash"])
      expect(tools.some((tool) => tool.name === name && tool.status === "done")).toBe(true);
    const replies = await page.locator(".chat-message.assistant .message-text").allTextContents();
    for (const file of await fs.readdir(path.join(root, ".pi", "sessions")))
      expect((await fs.readFile(path.join(root, ".pi", "sessions", file), "utf8")).includes(model.apiKey)).toBe(false);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /真实模型工程/ }).click();
    await expect(page.locator(".chat-message.assistant .message-text")).toHaveText(replies);
  });
});

test("从真实创建入口保存默认位置、复制 PDF，重启与搬迁后重开", async () => {
  const parent = path.join(sandbox, "projects");
  const source = path.join(sandbox, "外部论文.pdf");
  await fs.copyFile(fixture, source);
  const original = await fs.readFile(source);
  await preview(source, parent);
  await expect(page.getByTestId("project-preview")).toHaveText(path.join(parent, "研究工程"));
  await expect(page.getByLabel("将此位置设为默认工程文件夹")).toBeChecked();
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  const root = path.join(parent, "研究工程");
  const manifest = await readManifest(root);
  expect(manifest.paper.path).toBe("text/paper.pdf");
  expect(await fs.readFile(path.join(root, manifest.paper.path))).toEqual(original);
  expect(await fs.readFile(source)).toEqual(original);
  expect(JSON.stringify(manifest)).not.toContain(parent);
  await expect
    .poll(async () => (await fs.readdir(root)).sort())
    .toEqual([".paper30min-reading.json", ".pi", "memories", "notes", "paper30min.json", "text", "tmp"]);
  await fs.unlink(source);
  await fs.writeFile(path.join(root, "notes", "真实笔记.md"), "# 真实笔记\n\n从外部编辑器保存的内容。");
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "真实笔记.md", exact: true }).click();
  await expect(page.getByText("从外部编辑器保存的内容。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText(parent, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(page.getByRole("tab", { name: "真实笔记.md" })).toHaveAttribute("aria-selected", "true");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect((await readManifest(root)).paper.id).toBe(manifest.paper.id);
  const moved = path.join(sandbox, "搬迁后的工程");
  // Relocate a closed project, rather than racing its atomic reading-state writes.
  await desktop.close();
  await fs.cp(root, moved, { recursive: true });
  await launch();
  await choose(moved);
  await page.getByRole("button", { name: "打开工程文件夹", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect((await readManifest(moved)).paper).toEqual(manifest.paper);
  expect(await fs.readFile(path.join(moved, manifest.paper.path))).toEqual(original);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, undefined, "重启后新建");
  await expect(page.getByTestId("project-preview")).toHaveText(path.join(parent, "重启后新建"));
});

test("PDF 滚动与页码导航在笔记切换后保持位置", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await expect(pdfPages()).toContainText("2");
  await expectPdfRendered();
  await setPdfZoom("100");
  for (const offset of [300, 620]) {
    await pdfViewport().evaluate((e, y) => {
      e.scrollTop = y;
    }, offset);
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf[
            "text/paper.pdf"
          ]?.y;
        } catch (error) {
          // 首次滚动持久化前状态文件可能尚未创建；仅该情况继续等待。
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      })
      .toBe(offset);
    await page.getByRole("button", { name: "笔记", exact: true }).click();
    await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
    await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBe(offset);
  }
  await jumpPdfPage(1);
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBeLessThan(20);
  await jumpPdfPage(2);
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBeGreaterThan(700);
});

test("PDF 光标选区复制与区域截取使用统一选中色", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  await expectPdfRendered();
  const pdfColors = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      probe.style.color = "";
      return value;
    };
    const colors = { text: resolve("--text"), accent: resolve("--accent") };
    probe.remove();
    return colors;
  });
  const cursorMode = page.getByRole("button", { name: "光标模式", exact: true });
  const cursorSelected = await cursorMode.evaluate((element) => element.classList.contains("bg-interactive-selected"));
  await expect(cursorMode).toHaveCSS("color", cursorSelected ? pdfColors.accent : pdfColors.text);
  await expect(page.getByRole("button", { name: "批注", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "高亮", exact: true })).toHaveCount(0);
  await setPdfZoom("100");
  await page.screenshot({ path: "test-results/pdf-desktop.png" });
  await cursorMode.click();
  await expect(cursorMode).toHaveCSS("color", pdfColors.accent);
  const bounds = (await pdfImage().boundingBox())!;
  await page.mouse.move(bounds.x + 75, bounds.y + 48);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 290, bounds.y + 48, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  const selectionRect = page.locator('[style*="mix-blend-mode: multiply"][style*="isolation: isolate"] > div').first();
  await expect(selectionRect).toBeVisible();
  const expectedSelection = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "color-mix(in srgb, var(--accent) 28%, transparent)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await expect(selectionRect).toHaveCSS("background-color", expectedSelection);
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toContain("SampleNet");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+S");
  await page.mouse.move(bounds.x + 72, bounds.y + 140);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 290, bounds.y + 240, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText("截取的PDF区域", { exact: true })).toBeVisible();
  const region = page.getByRole("img", {
    name: "Captured PDF area",
    exact: true,
  });
  await expect(region).toBeVisible();
  await expect.poll(() => region.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThanOrEqual(218);
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test("PDF 缩放、关闭重开与重启恢复阅读位置", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const originalPdf = await fs.readFile(path.join(root, "text/paper.pdf"));
  await expectPdfRendered();
  await jumpPdfPage(2);
  await setPdfZoom("150");
  await expect(pdfPage()).toHaveValue("2");
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf["text/paper.pdf"]?.zoom,
    )
    .toBe(1.5);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
  await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
  expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(originalPdf);
});

test("真实 Ctrl+滚轮仅缩放 PDF，缩放和位置在重开后保留", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expectPdfRendered();
  await setPdfZoom("100");
  await jumpPdfPage(2);
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollTop)).toBeGreaterThan(700);
  const scale = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  );
  const viewport = pdfViewport();
  await viewport.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -180);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await pdfZoom().inputValue())).toBeGreaterThan(100);
  expect(
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),
  ).toBe(scale);
  const root = path.join(parent, "研究工程");
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf["text/paper.pdf"]?.zoom,
    )
    .toBeGreaterThan(1);
  const zoom = await pdfZoom().inputValue();
  await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue(zoom);
  await expect(pdfPage()).toHaveValue("2");
});

test("完整 Viewer 的 400% 缩放、水平滚动、双页与旋转在重开后恢复", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expectPdfRendered();
  const root = path.join(parent, "研究工程");
  const reading = async () =>
    JSON.parse(await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8")).pdf["text/paper.pdf"];
  await setPdfZoom("400");
  await expect.poll(async () => (await reading())?.zoom).toBe(4);
  await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue("400");
  await setPdfZoom("100");
  for (const name of ["水平滚动", "双页视图", "顺时针旋转"]) {
    await page.getByRole("button", { name: "页面设置", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  await expect
    .poll(async () => {
      const saved = await reading();
      return {
        strategy: saved?.scrollStrategy,
        spread: saved?.spreadMode,
        rotation: saved?.rotation,
      };
    })
    .toEqual({ strategy: "horizontal", spread: "odd", rotation: 1 });
  await pdfViewport().evaluate((e) => {
    e.scrollLeft = 300;
  });
  await expect.poll(async () => (await reading())?.x).toBe(300);
  await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue("100");
  await expect.poll(() => pdfViewport().evaluate((e) => e.scrollLeft)).toBe(300);
  await expect.poll(async () => (await pdfImage().boundingBox())!.width).toBeGreaterThan(700);
  await page.getByRole("button", { name: "页面设置", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "水平滚动", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "test-results/pdf-horizontal-spread-rotated.png",
  });
});

test("中文参考 PDF、无文本层、加密和损坏文件显式反馈", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expect(pdfPages()).toContainText("2");
  const root = path.join(parent, "研究工程");
  const add = async (file: string, name: string) => {
    await fs.copyFile(file, path.join(root, "text", name));
    await page.getByRole("button", { name: "工程文件", exact: true }).click();
    await page.getByRole("button", { name: "刷新工程", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  await add(path.resolve("tests/fixtures/pdfparse_scanned_blank.pdf"), "扫描材料.pdf");
  await expectPdfRendered();
  await add(path.resolve("tests/fixtures/encrypted.pdf"), "encrypted.pdf");
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();
  await page.getByPlaceholder("请输入文件密码").fill("wrong");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.getByText("密码错误，请检查后重新输入。", { exact: true })).toBeVisible();
  await page.getByPlaceholder("请输入文件密码").fill("paper30min-test");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expectPdfRendered();
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  const corrupt = path.join(sandbox, "损坏.pdf");
  await fs.writeFile(corrupt, "%PDF-1.7\nbroken document\n");
  await create(corrupt, parent, "损坏论文");
  await page.getByRole("button", { name: "阅读导航", exact: true }).click();
  await expect(page.getByText("文件加载出错", { exact: true })).toBeVisible();
  const large = path.join(parent, "损坏论文/text/paper.pdf");
  const handle = await fs.open(large, "r+");
  await handle.truncate(129 * 1024 * 1024);
  await handle.close();
  await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("128 MiB");
});

test("150 页文档按视口渲染，反复关闭释放并在窄窗口阅读", async () => {
  await create(path.resolve("tests/fixtures/long-150.pdf"), path.join(sandbox, "projects"));
  await expect(pdfPages()).toContainText("150");
  const viewport = pdfViewport();
  await expectPdfRendered();
  await setPdfZoom("100");
  const client = await page.context().newCDPSession(page);
  await client.send("HeapProfiler.collectGarbage");
  const before = await desktop.evaluate(async ({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === "Tab")
      .map((m) => m.memory.workingSetSize),
  );
  for (let cycle = 0; cycle < 6; cycle++) {
    await jumpPdfPage(145 - cycle);
    await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBeGreaterThan(100_000);
    await expect.poll(() => viewport.locator('img[style*="pointer-events: none"]').count()).toBeLessThanOrEqual(10);
    await page.getByRole("button", { name: "关闭 paper.pdf", exact: true }).click();
    await expect(viewport).toHaveCount(0);
    await expect.poll(() => page.workers().length).toBe(0);
    await page.getByRole("button", { name: "原始论文", exact: true }).click();
    await expect(pdfPages()).toContainText("150");
    await expectPdfRendered();
    await expect(pdfPage()).toHaveValue(String(145 - cycle));
  }
  await client.send("HeapProfiler.collectGarbage");
  const after = await desktop.evaluate(async ({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === "Tab")
      .map((m) => m.memory.workingSetSize),
  );
  console.log("PDF renderer working set KiB", { before, after });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 760));
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await expect.poll(() => page.locator(".sidebar-slot").evaluate((e) => e.getBoundingClientRect().width)).toBe(0);
  await expect(viewport).toBeVisible();
  await expectPdfRendered();
  await page.screenshot({ path: "test-results/pdf-narrow.png" });
});

test("默认位置与单次位置独立，同名目录和不可用默认位置明确失败", async () => {
  const first = path.join(sandbox, "projects");
  const second = path.join(sandbox, "其他位置");
  await fs.mkdir(second);
  await create(fixture, first, "第一工程");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await choose(second);
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(page.getByText(second, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  expect((await readManifest(path.join(first, "第一工程"))).name).toBe("第一工程");
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, first, "第二工程");
  await expect(page.getByLabel("将此位置设为默认工程文件夹")).not.toBeChecked();
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect(JSON.parse(await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8")).defaultFolder).toBe(
    second,
  );
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, first, "第一工程");
  const before = await fs.readFile(path.join(first, "第一工程/paper30min.json"));
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("同名工程文件夹已存在");
  expect(await fs.readFile(path.join(first, "第一工程/paper30min.json"))).toEqual(before);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await fs.rmdir(second);
  await preview(fixture, undefined, "不可用位置");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("重新选择保存位置");
  expect(await fs.readdir(first)).toEqual(expect.arrayContaining(["第一工程", "第二工程"]));
  expect(JSON.parse(await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8")).recent).toHaveLength(2);
});

test("选择取消、复制源消失和复制中取消均不登记工程或遗留产物", async () => {
  await choose(null);
  await page.getByRole("button", { name: "从 PDF 新建工程", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const source = path.join(sandbox, "即将消失.pdf");
  const parent = path.join(sandbox, "projects");
  await fs.copyFile(fixture, source);
  await preview(source, parent, "复制失败");
  await fs.unlink(source);
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await fs.readdir(parent)).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const large = path.join(sandbox, "大论文.pdf");
  await fs.mkdir(path.join(sandbox, "profile/preferences.json"));
  await preview(fixture, parent, "登记失败");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await fs.readdir(parent)).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await fs.rmdir(path.join(sandbox, "profile/preferences.json"));
  const file = await fs.open(large, "w");
  await file.write("%PDF-1.7\n");
  await file.truncate(1024 * 1024 * 1024);
  await file.close();
  await preview(large, parent, "取消工程");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect.poll(() => fs.readdir(parent)).toContain("取消工程");
  await page.getByRole("button", { name: "取消创建", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已取消创建工程");
  expect(await fs.readdir(parent)).toEqual([]);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建工程", exact: true })).toBeEnabled();
  await expect(page.getByText("尚无最近工程", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await preview(large, parent, "退出时取消");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect.poll(() => fs.readdir(parent)).toContain("退出时取消");
  await desktop.close();
  expect(await fs.readdir(parent)).toEqual([]);
  await launch();
  await expect(page.getByText("尚无最近工程", { exact: true })).toBeVisible();
});

test("普通文件与工程论文改名移动保留内容并更新清单", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await fs.mkdir(path.join(root, "notes/归档"), { recursive: true });
  await fs.writeFile(path.join(root, "notes/草稿.md"), "移动前内容");
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "草稿.md", exact: true }).click();
  await page.getByRole("button", { name: "改名或移动", exact: true }).click();
  await page.getByLabel("工程内相对路径").fill("notes/归档/草稿.md");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("tab", { name: "草稿.md", exact: true })).toBeVisible();
  expect(await fs.readFile(path.join(root, "notes/归档/草稿.md"), "utf8")).toBe("移动前内容");
  expect(await fs.stat(path.join(root, "notes/草稿.md")).catch(() => null)).toBeNull();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await page.getByRole("button", { name: "改名或移动", exact: true }).click();
  await page.getByLabel("工程内相对路径").fill("text/工程论文.pdf");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("tab", { name: "工程论文.pdf", exact: true })).toBeVisible();
  expect((await readManifest(root)).paper.path).toBe("text/工程论文.pdf");
  expect(await fs.readFile(path.join(root, "text/工程论文.pdf"))).toEqual(await fs.readFile(fixture));
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(page.getByRole("tab", { name: "工程论文.pdf", exact: true })).toBeVisible();
  await expectPdfRendered();
});

test("侧栏拖拽跟手、限制中栏宽度并在收放和重启后恢复", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  let left = page.getByRole("separator", { name: "调整左侧栏宽度" });
  let right = page.getByRole("separator", { name: "调整 Agent 宽度" });
  async function drag(handle: typeof left, distance: number) {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + distance, y, { steps: 6 });
  }
  await drag(left, 60);
  // Observe the layout while the pointer is still held, before any animation could finish.
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  expect((await page.locator(".sidebar-slot").boundingBox())!.width).toBe(292);
  await page.mouse.up();
  await drag(right, -120);
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  expect((await page.locator(".right-slot").boundingBox())!.width).toBe(456);
  await page.mouse.up();
  await page.screenshot({ path: "test-results/workbench-resized.png" });
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await page.getByRole("button", { name: "展开左侧栏", exact: true }).click();
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  await page.getByRole("button", { name: "收起 Agent", exact: true }).click();
  await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /^研究工程/ }).click();
  left = page.getByRole("separator", { name: "调整左侧栏宽度" });
  right = page.getByRole("separator", { name: "调整 Agent 宽度" });
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 780 }),
  );
  await expect.poll(async () => (await page.locator(".main").boundingBox())!.width).toBeGreaterThanOrEqual(360);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 940 }),
  );
  await expect(left).toHaveAttribute("aria-valuenow", "292");
  await expect(right).toHaveAttribute("aria-valuenow", "456");
  await left.focus();
  await page.keyboard.press("Home");
  await expect(left).toHaveAttribute("aria-valuenow", "155");
  await drag(right, -1000);
  await page.mouse.up();
  await expect(right).toHaveAttribute("aria-valuenow", "560");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 560, height: 780 }),
  );
  await expect(right).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "从一个问题开始" })).toBeVisible();
  await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/workbench-resized-narrow.png" });
});

test("工作台真实文件树、标签复用与设置返回，桌面和窄窗口布局", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  await fs.writeFile(
    path.join(root, "notes/这是一个用来核对长标题省略与标签固定宽度的笔记.md"),
    "# 工程笔记\n\n真实文件",
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await page.getByRole("button", { name: "工程文件", exact: true }).click();
  await page
    .getByRole("button", {
      name: "这是一个用来核对长标题省略与标签固定宽度的笔记.md",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "这是一个用来核对长标题省略与标签固定宽度的笔记.md",
      exact: true,
    })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab").last()).toHaveCSS("overflow", "hidden");
  await page.screenshot({ path: "test-results/workbench-desktop.png" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "解析模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "解析模型" })).toBeVisible();
  await page.screenshot({ path: "test-results/settings-desktop.png" });
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(page.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 560, height: 780 }),
  );
  await expect(page.getByRole("button", { name: "展开 Agent", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/workbench-narrow.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "工程文件" })).toHaveCount(0);
  await page.getByRole("button", { name: "展开左侧栏", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "工程文件" })).toBeVisible();
});

test("Markdown 三种视图、真实文件保真、图片公式与多标签草稿", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const original =
    "\uFEFF---\r\ntitle: 测试\r\n---\n<!-- 保留注释 -->\r\n\r\n# 原始笔记\r\n\r\n公式 $x^2$。\r\n\r\n![图片](../text/图(1).svg)\r\n\r\n[另一篇](另一篇(1).md)\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n末尾空格  \r\n下一行\n";
  await fs.writeFile(path.join(root, "notes/原始.md"), original);
  await fs.writeFile(path.join(root, "notes/另一篇(1).md"), "# 另一篇\n");
  await fs.writeFile(
    path.join(root, "text/图(1).svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="purple"/></svg>',
  );
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "原始.md", exact: true }).click();
  await expect(page.locator(".markdown-preview .katex")).toBeVisible();
  await expect
    .poll(() => page.getByRole("img", { name: "图片", exact: true }).evaluate((e: HTMLImageElement) => e.naturalWidth))
    .toBe(100);
  const markdownTokens = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      probe.style.color = "";
      return value;
    };
    const result = { accentInk: resolve("--accent-ink"), accentSoft: resolve("--accent-soft") };
    probe.remove();
    return result;
  });
  await expect(page.locator(".markdown-preview a")).toHaveCSS("color", markdownTokens.accentInk);
  await page.getByRole("link", { name: "另一篇", exact: true }).click();
  await expect(page.getByRole("tab", { name: "另一篇(1).md" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "原始.md", exact: true }).click();
  const editMode = page.getByRole("button", { name: "编辑", exact: true });
  await editMode.click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await expect(editMode).toHaveClass(/\bbutton/);
  await expect(editMode).toHaveAttribute("aria-pressed", "true");
  await editor.press("Control+A");
  const editorSelection = page.locator(".cm-selectionBackground").first();
  await expect(editorSelection).toBeVisible();
  await expect(editorSelection).toHaveCSS("background-color", markdownTokens.accentSoft);
  await editor.press("ArrowRight");
  await editor.press("Control+Home");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("End");
  await editor.press("Delete");
  await editor.press("Control+z");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await editor.press("Control+End");
  await editor.pressSequentially("用户补充");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator(".markdown-preview")).toContainText("用户补充");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(editor).toContainText("用户补充");
  await page.getByRole("tab", { name: "另一篇(1).md" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await editor.press("Control+End");
  await editor.pressSequentially("独立草稿");
  await page.getByRole("tab", { name: /原始.md/ }).click();
  await expect(editor).toContainText("用户补充");

  await expect.poll(() => fs.readFile(path.join(root, "notes/原始.md"), "utf8")).toBe(original + "用户补充");
  await page.getByRole("tab", { name: /另一篇/ }).click();

  await expect.poll(() => fs.readFile(path.join(root, "notes/另一篇(1).md"), "utf8")).toBe("# 另一篇\n独立草稿");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await page.getByRole("tab", { name: /原始.md/ }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 源码", exact: true })).toContainText("用户补充");
});

test("Markdown 外部变更自动同步，冲突与文件消失保留用户输入", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByLabel("笔记名称").fill("协作.md");
  await page.getByRole("button", { name: "创建笔记", exact: true }).click();
  const note = path.join(root, "notes/协作.md");
  await expect(page.getByRole("dialog", { name: "新建笔记", exact: true })).toHaveCount(0);
  await expect(page.locator(".markdown-preview")).toBeVisible();
  await fs.writeFile(note, "# Agent 首次写入\n");
  await expect(page.locator(".markdown-preview")).toContainText("Agent 首次写入");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+End");
  await editor.pressSequentially("用户未保存内容");
  await fs.writeFile(note, "# Agent 再次修改\n");
  await expect(page.getByText("文档已在外部修改。你的编辑已保留，尚未覆盖磁盘文件。")).toBeVisible();
  await expect(editor).toContainText("用户未保存内容");
  await page.getByRole("button", { name: "查看双方内容", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "当前磁盘内容", exact: true })).toHaveValue("# Agent 再次修改\n");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await fs.writeFile(note, "# 第三次外部更新\n");
  await expect(page.getByRole("textbox", { name: "当前磁盘内容", exact: true })).toHaveValue("# 第三次外部更新\n");
  await fs.rename(note, path.join(root, "notes/外部改名.md"));
  await page.getByRole("button", { name: "工程文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "外部改名.md", exact: true })).toBeVisible();
  await expect(editor).toContainText("用户未保存内容");
  await expect(page.getByRole("alert").first()).toContainText("文件已被删除或移动");
  await page.getByRole("button", { name: "关闭 协作.md", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "放弃未保存的编辑", exact: true });
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toBeVisible();
  // Clear the draft through the explicit discard confirmation for test shutdown.
  await page.getByRole("button", { name: "关闭 协作.md", exact: true }).click();
  await discard.getByRole("button", { name: "放弃并离开", exact: true }).click();
});

test("Markdown 组合输入、撤销与保存失败不破坏原文件", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  const note = path.join(root, "notes/输入.md");
  await fs.writeFile(note, "# 中文输入\r\n原文\r\n");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "输入.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "中文组合",
    selectionStart: 4,
    selectionEnd: 4,
  });
  await page.waitForTimeout(800);
  expect(await fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
  await cdp.send("Input.insertText", { text: "中文组合" });
  await expect(editor).toContainText("中文组合");
  await expect.poll(() => fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n中文组合");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await page.screenshot({ path: "test-results/markdown-split.png" });
  await editor.press("Control+z");
  await expect(editor).not.toContainText("中文组合");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await editor.press("Control+End");
  await expect.poll(() => fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
  await fs.chmod(note, 0o444);
  await editor.pressSequentially("恢复输入");
  try {
    await expect(page.getByRole("alert")).toContainText("保存失败");
    expect(await fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
    await expect(editor).toContainText("恢复输入");
  } finally {
    await fs.chmod(note, 0o666);
  }

  await page.getByRole("button", { name: "重试自动保存", exact: true }).click();
  await expect.poll(() => fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n恢复输入");
  await cdp.detach();
});

test("Markdown 长文视图往返和两个工程的同路径位置独立", async () => {
  const parent = path.join(sandbox, "projects");
  const longNote = Array.from({ length: 100 }, (_, i) => "## 第 " + i + " 段\n\n正文段落\n\n").join("");
  await create(fixture, parent, "工程甲");
  const a = path.join(parent, "工程甲");
  await fs.writeFile(path.join(a, "notes/同名.md"), longNote);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "同名.md", exact: true }).click();
  const previewPane = page.locator(".markdown-preview");
  await previewPane.hover();
  await page.mouse.wheel(0, 650);
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBeGreaterThan(400);
  const scroll = await previewPane.evaluate((e) => e.scrollTop);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(scroll);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await create(fixture, undefined, "工程乙");
  const b = path.join(parent, "工程乙");
  await fs.writeFile(path.join(b, "notes/同名.md"), longNote);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "同名.md", exact: true }).click();
  await expect(previewPane).toBeVisible();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /工程甲/ }).click();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(scroll);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /工程乙/ }).click();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(0);
});

test("UI 创建工程弹窗圈定焦点并在 Escape 后恢复触发按钮", async () => {
  const trigger = page.getByRole("button", { name: "从 PDF 新建工程", exact: true });
  await choose(fixture);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建工程", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("工程名称", { exact: true })).toBeFocused();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThan(2);
  await page.screenshot({ path: "test-results/ou7-create-dialog.png" });
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const current = document.querySelector('dialog, [role="dialog"]');
        const active = document.activeElement;
        // Chromium 原生 dialog 循环焦点会经过 body；背景可交互控件仍不得获得焦点。
        return active === document.body || (!!current && current.contains(active));
      }),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("UI 未保存 Markdown 关闭标签经 renderer 确认", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const root = path.join(sandbox, "projects/研究工程");
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByLabel("笔记名称").fill("确认.md");
  await page.getByRole("button", { name: "创建笔记", exact: true }).click();
  const note = path.join(root, "notes/确认.md");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await editor.press("Control+End");
  await editor.pressSequentially("未保存草稿");
  await fs.writeFile(note, "# 外部版本\n");
  await expect(page.getByText("文档已在外部修改。你的编辑已保留，尚未覆盖磁盘文件。")).toBeVisible();

  const close = page.getByRole("button", { name: "关闭 确认.md", exact: true });
  const dialog = page.getByRole("dialog", { name: "放弃未保存的编辑", exact: true });
  await close.click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "test-results/ou7-unsaved-confirm.png" });
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toContainText("未保存草稿");
  await close.click();
  await dialog.getByRole("button", { name: "放弃并离开", exact: true }).click();
  await expect(close).toHaveCount(0);
});

test("UI 未保存提示词重新载入与离开经 renderer 确认", async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "产品 Skill", exact: true }).click();
  const skill = page.getByLabel("提示词", { exact: true });
  await expect(skill).toBeEnabled();
  const original = await skill.inputValue();
  const edited = original + "\n临时修改";
  await skill.fill(edited);

  const reload = page.getByRole("button", { name: "重新载入提示词", exact: true });
  const dialog = page.getByRole("dialog", { name: "未保存的提示词", exact: true });
  await reload.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(skill).toHaveValue(edited);
  await reload.click();
  // 离屏 Windows CI 可暂停动画帧；焦点恢复仍必须在重载完成后发生。
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  await dialog.getByRole("button", { name: "放弃并重新载入", exact: true }).click();
  await expect(skill).toHaveValue(original);
  await expect(reload).toBeFocused();

  await skill.fill(edited);
  const parsing = page.getByRole("button", { name: "解析模型", exact: true });
  await parsing.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(skill).toHaveValue(edited);
  await parsing.click();
  await dialog.getByRole("button", { name: "放弃并离开", exact: true }).click();
  await expect(page.getByLabel("百度任务地址", { exact: true })).toBeVisible();
});

test("UI Select 键盘选择与统一浮层语义色", async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "代理配置", exact: true }).click();
  const proxy = page.getByLabel("连接方式", { exact: true });
  await proxy.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(proxy).toHaveValue("environment");
  await expect(page.getByText("使用应用启动时的环境代理配置。")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(proxy).toHaveValue("custom");
  await expect(page.getByLabel("代理地址", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑服务名称", exact: true })).toHaveCSS("width", "32px");
  const api = page.getByLabel("接口协议", { exact: true });
  await expect(api).toHaveValue("openai-completions");
  await api.click();
  const pickerColors = await api.evaluate((element) => {
    const style = getComputedStyle(element, "::picker(select)");
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
  });
  const tokens = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      probe.style.color = "";
      return value;
    };
    const result = {
      surface: resolve("--surface"),
      textSecondary: resolve("--text-secondary"),
      borderStrong: resolve("--border-strong"),
    };
    probe.remove();
    return result;
  });
  expect(pickerColors.background).toBe(tokens.surface);
  expect(pickerColors.color).toBe(tokens.textSecondary);
  expect(pickerColors.border).toBe(tokens.borderStrong);
  // 鼠标点开时焦点已在选中项，一次 ArrowDown 即移到下一项。
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(api).toHaveValue("openai-responses");
  await page.screenshot({ path: "test-results/ou7-agent-settings.png" });
  await page.setViewportSize({ width: 560, height: 780 });
  await api.click();
  const overflow = await api.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { doc: document.documentElement.scrollWidth <= innerWidth, triggerRight: rect.right <= innerWidth };
  });
  expect(overflow.doc).toBe(true);
  expect(overflow.triggerRight).toBe(true);
  await page.screenshot({ path: "test-results/ou7-agent-settings-narrow.png", animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });
});

test("UI Field 原生校验错误与控件关联", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const name = page.getByLabel("笔记名称", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("");
  await page.getByRole("button", { name: "创建笔记", exact: true }).click();

  const error = page.getByText("请输入笔记名称。", { exact: true });
  await expect(error).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  const errorId = await error.getAttribute("id");
  expect(errorId).not.toBeNull();
  await expect(name).toHaveAttribute("aria-describedby", new RegExp(errorId!));
  await name.fill("修正名称");
  await expect(error).toBeHidden();
});

test("UI 工作台选中态与装饰图标消费统一语义色", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  const tokens = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      probe.style.color = "";
      return value;
    };
    const result = {
      accentInk: resolve("--accent-ink"),
      accentSoft: resolve("--accent-soft"),
      surfaceSelected: resolve("--surface-selected"),
      text: resolve("--text"),
    };
    probe.remove();
    return result;
  });
  const avatar = page.locator(".avatar");
  await expect(avatar).toHaveCSS("background-color", tokens.accentSoft);
  await expect(avatar).toHaveCSS("color", tokens.accentInk);
  const selectedNav = page.locator(".nav.selected").first();
  await expect(selectedNav).toHaveCSS("color", tokens.text);
  await expect(selectedNav).toHaveCSS("background-color", tokens.surfaceSelected);
  await expect(page.locator('.file-tab.active > button[role="tab"] svg')).toHaveCSS("color", tokens.accentInk);
});

test("UI reduced-motion 与三种窗口宽度保持焦点和布局", async () => {
  await create(fixture, path.join(sandbox, "projects"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await choose(fixture);
  const trigger = page.getByRole("button", { name: "从 PDF 新建工程", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建工程", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("animation-name", "none");
  await expect(dialog.getByRole("button", { name: "创建工程", exact: true })).toHaveCSS("transition-property", "none");
  await expect(page.locator(".sidebar-slot")).toHaveCSS("transition-property", "none");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  for (const [width, height] of [
    [1440, 960],
    [1000, 780],
    [560, 780],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expectPdfRendered();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".main")).toBeVisible();
    await page.screenshot({ path: `test-results/ou7-workbench-${width}.png`, animations: "disabled" });
  }
});
