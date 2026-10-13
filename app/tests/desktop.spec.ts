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
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AgentSettings, ChatSession } from "../src/shared/contracts";

let sandbox: string;
let desktop: ElectronApplication;
let page: Page;
let errors: string[];
const fixture = path.resolve("../legacy/v1/app/ui/samples/sample_paper.pdf");

// Playwright pierces the complete viewer's open shadow root through its public UI.
const pdfViewport = () =>
  page.locator('.pdf-reader .bg-bg-app[style*="overflow: auto"]');
const pdfImage = () =>
  pdfViewport().locator('img[style*="pointer-events: none"]').first();
const pdfPages = () => page.locator('[data-overlay-id="page-controls"]');
const pdfPage = () => pdfPages().locator("input");
const pdfZoom = () =>
  page.getByRole("textbox", { name: "Set zoom", exact: true });

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
      return Math.abs(
        before - (await pdfViewport().evaluate((e) => e.scrollTop)),
      );
    })
    .toBe(0);
  await expect(pdfPage()).toHaveValue(String(number));
}

async function expectPdfRendered() {
  await expect(pdfImage()).toBeVisible();
  await expect
    .poll(() =>
      pdfImage().evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(100);
}

async function launch() {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PAPER30MIN_PROFILE: path.join(sandbox, "profile"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ args: ["."], env });
  page = await desktop.firstWindow();
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByRole("heading", { name: "Paper30Min" })).toBeVisible();
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
  await page
    .getByRole("button", { name: "从 PDF 新建工程", exact: true })
    .click();
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
  return JSON.parse(
    await fs.readFile(path.join(root, "paper30min.json"), "utf8"),
  );
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
    await desktop?.close();
    // The sandbox is an exclusively created test directory, never a user-selected path.
    await fs.rm(sandbox, { recursive: true, force: true });
  }
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
    await page
      .getByLabel("模型端点")
      .fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel("模型名称").fill("controlled-model");
    await page.getByLabel("API 密钥", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "返回工作台" }).click();
    await expect(page.getByLabel("Agent 消息")).toHaveValue(
      "不附加论文，只问你好",
    );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText("真实流式");
    await page.getByLabel("Agent 消息").fill("补充一个问题");
    await page.getByRole("button", { name: "补充消息", exact: true }).click();
    await expect(page.locator(".queued-message")).toContainText("补充一个问题");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain("paper.pdf");
    const originalId = await page
      .getByLabel("会话", { exact: true })
      .inputValue();
    await page.getByRole("button", { name: "从此消息分支" }).nth(1).click();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    await expect(page.getByLabel("会话").locator("option")).toHaveCount(2);
    const branchId = await page
      .getByLabel("会话", { exact: true })
      .inputValue();
    await page.getByLabel("Agent 消息").fill("分支继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText(
      "真实流式回复完成。",
    );
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    await page.getByLabel("会话", { exact: true }).selectOption(originalId);
    await page.getByLabel("Agent 消息").fill("回到原会话继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText(
      "真实流式回复完成。",
    );
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
    expect(
      await fs.readFile(
        path.join(sandbox, "profile", "agent-settings.json"),
        "utf8",
      ),
    ).not.toContain(secret);
    const moved = path.join(parent, "搬迁后 Pi 工程");
    await desktop.close();
    await fs.rename(root, moved);
    await launch();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "Agent 模型", exact: true }).click();
    await expect(page.getByLabel("API 密钥", { exact: true })).toHaveAttribute(
      "placeholder",
      "已保存在本机，留空保留",
    );
    await page.getByRole("button", { name: "返回工程" }).click();
    await choose(moved);
    await page
      .getByRole("button", { name: "打开工程文件夹", exact: true })
      .click();
    await page.getByLabel("会话", { exact: true }).selectOption(branchId);
    await expect(page.locator(".chat-message")).toHaveCount(4);
    await page.getByLabel("Agent 消息").fill("重开后继续");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await expect(page.locator(".message-text").last()).toHaveText(
      "真实流式回复完成。",
    );
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(6);
    await page.screenshot({ path: "test-results/ste79-agent-desktop.png" });
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(560, 760),
    );
    await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
    await expect(page.getByLabel("Agent 消息")).toBeVisible();
    await expect(page.locator(".right-slot")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/ste79-agent-narrow.png" });
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(page.getByLabel("模型端点")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "test-results/ste79-settings-narrow.png" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Pi 并发会话隔离停止、失败恢复与代理，停滞关闭不拖住退出", async () => {
  const secret = "controlled-private-key";
  let tunneled = 0;
  let failNext = true;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const content = payload.messages
      .filter((m: { role: string }) => m.role === "user")
      .at(-1).content;
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
    const timer = setTimeout(
      () => {
        chunk(last.includes("停滞") ? "迟到内容不得落盘" : "已完成");
        chunk(null);
        response.end("data: [DONE]\n\n");
        timers.delete(timer);
      },
      last.includes("停滞") ? 3000 : 500,
    );
    timers.add(timer);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const proxy = createServer();
  const sockets = new Set<import("node:stream").Duplex>();
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
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const parent = path.join(sandbox, "projects");
    await create(fixture, parent, "并发会话工程");
    const root = path.join(parent, "并发会话工程");
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
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "controlled",
            proxy: "custom",
            proxyUrl: `http://127.0.0.1:${proxyPort}`,
          },
        });
      },
      { port, proxyPort, secret },
    );
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
    await expect(page.locator(".message-text").last()).toHaveText(
      "独立回复已完成",
    );
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("会话 A 停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
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
    await expect(page.locator(".message-text").last()).toHaveText(
      "独立回复已完成",
    );
    await page.waitForTimeout(3100);
    const all = await page.evaluate(
      (root) => window.desktop.agent<ChatSession[]>({ type: "list", root }),
      root,
    );
    expect(all.find((s) => s.id === a)?.messages.at(-1)?.text).toBe(
      "等待中的片段",
    );
    for (const file of await fs.readdir(path.join(root, ".pi", "sessions"))) {
      const raw = await fs.readFile(
        path.join(root, ".pi", "sessions", file),
        "utf8",
      );
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain("迟到内容不得落盘");
    }
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("关闭期间停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    await page.getByRole("button", { name: "所有工程", exact: true }).click();
    await create(fixture, undefined, "另一工程");
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await page.getByLabel("Agent 消息").fill("另一工程正常回复");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "独立回复已完成",
    );
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("窗口退出时停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    const started = Date.now();
    await desktop.close();
    expect(Date.now() - started).toBeLessThan(4000);
    await launch();
    await page.getByRole("button", { name: /^另一工程/ }).click();
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.getByLabel("Agent 消息").fill("进程异常停滞");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-text").last()).toHaveText(
      "等待中的片段",
    );
    await desktop.evaluate(({ app }) => {
      const target = app
        .getAppMetrics()
        .find((m) => m.name === "Paper30Min Project");
      if (!target) throw new Error("找不到测试工程进程");
      process.kill(target.pid);
    });
    await expect(page.locator(".agent-error")).toContainText("工程进程已退出");
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(0);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => proxy.close(() => r())),
    ]);
  }
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
      response.write(
        `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
      );
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
    await create(fixture, path.join(sandbox, "projects"));
    await fs.writeFile(
      path.join(sandbox, "profile", "agent-settings.json"),
      "{invalid",
    );
    for (const api of ["openai-responses", "anthropic-messages"] as const) {
      await page.getByRole("button", { name: "模型设置", exact: true }).click();
      if (api === "openai-responses")
        await expect(page.getByRole("status")).toContainText(
          "模型配置无法读取",
        );
      await page.getByLabel("接口协议").selectOption(api);
      await page
        .getByLabel("模型端点")
        .fill(
          `http://127.0.0.1:${port}${api === "anthropic-messages" ? "" : "/v1"}`,
        );
      await page.getByLabel("模型名称").fill("controlled");
      await page
        .getByLabel("API 密钥", { exact: true })
        .fill("controlled-protocol-key");
      await page.getByRole("button", { name: "保存配置" }).click();
      await expect(page.getByRole("status")).toHaveText("已保存");
      await page.getByRole("button", { name: "返回工作台" }).click();
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await page.getByLabel("Agent 消息").fill("基础文本");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.locator(".message-text").last()).toHaveText(
        api === "openai-responses" ? "Responses 回复" : "Anthropic 回复",
      );
      await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
        0,
      );
      await expect(page.locator(".agent-error")).toHaveCount(0);
    }
    expect(
      routes.map((route) => new URL(route, "http://localhost").pathname),
    ).toEqual(["/v1/responses", "/v1/messages"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.describe("真实模型验证", () => {
  test("用本机旧配置运行真实 Pi 基础消息并重开", async () => {
    test.skip(
      process.env.PAPER30MIN_REAL_MODEL !== "1",
      "需用户授权复用本机旧模型配置后显式运行。",
    );
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(
      path.join(
        os.homedir(),
        "AppData/Roaming/com.paper30min.reader/database/library.sqlite",
      ),
      { readOnly: true },
    );
    let model: { baseUrl: string; model: string; apiKey: string };
    try {
      model = JSON.parse(
        (
          db
            .prepare("SELECT value FROM settings WHERE key = 'model'")
            .get() as { value: string }
        ).value,
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
          baseUrl: model.baseUrl,
          model: model.model,
          maxTokens: 256,
          proxy: "direct",
        },
      });
    }, model);
    await page
      .getByLabel("Agent 消息")
      .fill("只用一句中文回答：你好。不要读取文件或调用工具。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".chat-message.assistant .message-text"),
    ).not.toHaveText("", { timeout: 60000 });
    await expect(page.getByRole("button", { name: "停止回复" })).toHaveCount(
      0,
      { timeout: 60000 },
    );
    await expect(page.locator(".agent-error")).toHaveCount(0);
    const reply = await page
      .locator(".chat-message.assistant .message-text")
      .innerText();
    const root = path.join(sandbox, "projects", "真实模型工程");
    for (const file of await fs.readdir(path.join(root, ".pi", "sessions")))
      expect(
        (
          await fs.readFile(path.join(root, ".pi", "sessions", file), "utf8")
        ).includes(model.apiKey),
      ).toBe(false);
    await desktop.close();
    await launch();
    await page.getByRole("button", { name: /真实模型工程/ }).click();
    await expect(
      page.locator(".chat-message.assistant .message-text"),
    ).toHaveText(reply);
  });
});

test("从真实创建入口保存默认位置、复制 PDF，重启与搬迁后重开", async () => {
  const parent = path.join(sandbox, "projects");
  const source = path.join(sandbox, "外部论文.pdf");
  await fs.copyFile(fixture, source);
  const original = await fs.readFile(source);
  await preview(source, parent);
  await expect(page.getByTestId("project-preview")).toHaveText(
    path.join(parent, "研究工程"),
  );
  await expect(page.getByLabel("将此位置设为默认工程文件夹")).toBeChecked();
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  const root = path.join(parent, "研究工程");
  const manifest = await readManifest(root);
  expect(manifest.paper.path).toBe("text/paper.pdf");
  expect(await fs.readFile(path.join(root, manifest.paper.path))).toEqual(
    original,
  );
  expect(await fs.readFile(source)).toEqual(original);
  expect(JSON.stringify(manifest)).not.toContain(parent);
  expect((await fs.readdir(root)).sort()).toEqual([
    ".paper30min-reading.json",
    ".pi",
    "explanations",
    "map",
    "memories",
    "notes",
    "paper30min.json",
    "text",
    "tmp",
  ]);
  await fs.unlink(source);
  await fs.writeFile(
    path.join(root, "notes", "真实笔记.md"),
    "# 真实笔记\n\n从外部编辑器保存的内容。",
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "真实笔记.md", exact: true }).click();
  await expect(
    page.getByText("从外部编辑器保存的内容。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText(parent, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(page.getByRole("tab", { name: "真实笔记.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect((await readManifest(root)).paper.id).toBe(manifest.paper.id);
  const moved = path.join(sandbox, "搬迁后的工程");
  await fs.cp(root, moved, { recursive: true });
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await choose(moved);
  await page
    .getByRole("button", { name: "打开工程文件夹", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect((await readManifest(moved)).paper).toEqual(manifest.paper);
  expect(await fs.readFile(path.join(moved, manifest.paper.path))).toEqual(
    original,
  );
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, undefined, "重启后新建");
  await expect(page.getByTestId("project-preview")).toHaveText(
    path.join(parent, "重启后新建"),
  );
});

test("真实 PDF 导航、缩放、选区与关闭重开位置", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  await expect(pdfPages()).toContainText("2");
  await expectPdfRendered();
  await setPdfZoom("100");
  await page.screenshot({ path: "test-results/pdf-desktop.png" });
  for (const offset of [300, 620]) {
    await pdfViewport().evaluate((e, y) => {
      e.scrollTop = y;
    }, offset);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await fs.readFile(
              path.join(root, ".paper30min-reading.json"),
              "utf8",
            ),
          ).pdf["text/paper.pdf"]?.y,
      )
      .toBe(offset);
    await page.getByRole("button", { name: "阅读地图", exact: true }).click();
    await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
    await expect
      .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
      .toBe(offset);
  }
  await jumpPdfPage(1);
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
    .toBeLessThan(20);
  await page.getByRole("button", { name: "光标模式", exact: true }).click();
  const bounds = (await pdfImage().boundingBox())!;
  await page.mouse.move(bounds.x + 75, bounds.y + 48);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 290, bounds.y + 48, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "复制", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await expect
    .poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain("SampleNet");
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
  await expect
    .poll(() => region.evaluate((e: HTMLImageElement) => e.naturalWidth))
    .toBeGreaterThanOrEqual(218);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await jumpPdfPage(2);
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
    .toBeGreaterThan(700);
  await setPdfZoom("150");
  await expect(pdfPage()).toHaveValue("2");
  await expect
    .poll(
      async () =>
        JSON.parse(
          await fs.readFile(
            path.join(root, ".paper30min-reading.json"),
            "utf8",
          ),
        ).pdf["text/paper.pdf"]?.zoom,
    )
    .toBe(1.5);
  await page.getByRole("button", { name: "阅读地图", exact: true }).click();
  await page.getByRole("tab", { name: "paper.pdf", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfPage()).toHaveValue("2");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await expect(pdfPage()).toHaveValue("2");
  await expect(pdfZoom()).toHaveValue("150");
});

test("真实 Ctrl+滚轮仅缩放 PDF，缩放和位置在重开后保留", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expectPdfRendered();
  await setPdfZoom("100");
  await jumpPdfPage(2);
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollTop))
    .toBeGreaterThan(700);
  const scale = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  );
  const viewport = pdfViewport();
  await viewport.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -180);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => Number(await pdfZoom().inputValue()))
    .toBeGreaterThan(100);
  expect(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
  ).toBe(scale);
  const root = path.join(parent, "研究工程");
  await expect
    .poll(
      async () =>
        JSON.parse(
          await fs.readFile(
            path.join(root, ".paper30min-reading.json"),
            "utf8",
          ),
        ).pdf["text/paper.pdf"]?.zoom,
    )
    .toBeGreaterThan(1);
  const zoom = await pdfZoom().inputValue();
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
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
    JSON.parse(
      await fs.readFile(path.join(root, ".paper30min-reading.json"), "utf8"),
    ).pdf["text/paper.pdf"];
  await setPdfZoom("400");
  await expect.poll(async () => (await reading())?.zoom).toBe(4);
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(pdfZoom()).toHaveValue("100");
  await expect
    .poll(() => pdfViewport().evaluate((e) => e.scrollLeft))
    .toBe(300);
  await expect
    .poll(async () => (await pdfImage().boundingBox())!.width)
    .toBeGreaterThan(700);
  await page.getByRole("button", { name: "页面设置", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "水平滚动", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "test-results/pdf-horizontal-spread-rotated.png",
  });
});

test("中文参考 PDF、无文本层、加密和损坏文件显式反馈", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  await expect(pdfPages()).toContainText("2");
  const add = async (file: string, name: string) => {
    await page.getByRole("button", { name: "相关材料", exact: true }).click();
    await choose(file);
    await page.getByRole("button", { name: "添加材料", exact: true }).click();
    await page
      .getByRole("button", { name: `${name} text/${name}`, exact: true })
      .click();
  };
  const chinese = path.join(sandbox, "扫描材料.pdf");
  await fs.copyFile(
    path.resolve(
      "../legacy/v1/app/src-tauri/tests/fixtures/pdfparse_scanned_blank.pdf",
    ),
    chinese,
  );
  await add(chinese, "扫描材料.pdf");
  await expectPdfRendered();
  await add(path.resolve("tests/fixtures/encrypted.pdf"), "encrypted.pdf");
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();
  await page.getByPlaceholder("请输入文件密码").fill("wrong");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(
    page.getByText("密码错误，请检查后重新输入。", { exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("请输入文件密码").fill("paper30min-test");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expectPdfRendered();
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  const corrupt = path.join(sandbox, "损坏.pdf");
  await fs.writeFile(corrupt, "%PDF-1.7\nbroken document\n");
  await create(corrupt, parent, "损坏论文");
  await expect(page.getByText("文件加载出错", { exact: true })).toBeVisible();
  const large = path.join(parent, "损坏论文/text/paper.pdf");
  const handle = await fs.open(large, "r+");
  await handle.truncate(129 * 1024 * 1024);
  await handle.close();
  await page
    .getByRole("button", { name: "关闭 paper.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("128 MiB");
});

test("150 页文档按视口渲染，反复关闭释放并在窄窗口阅读", async () => {
  await create(
    path.resolve("tests/fixtures/long-150.pdf"),
    path.join(sandbox, "projects"),
  );
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
    await expect
      .poll(() => viewport.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(100_000);
    await expect
      .poll(() =>
        viewport.locator('img[style*="pointer-events: none"]').count(),
      )
      .toBeLessThanOrEqual(10);
    await page
      .getByRole("button", { name: "关闭 paper.pdf", exact: true })
      .click();
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
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(560, 760),
  );
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".sidebar-slot")
        .evaluate((e) => e.getBoundingClientRect().width),
    )
    .toBe(0);
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
  expect((await readManifest(path.join(first, "第一工程"))).name).toBe(
    "第一工程",
  );
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, first, "第二工程");
  await expect(page.getByLabel("将此位置设为默认工程文件夹")).not.toBeChecked();
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("tab", { name: "paper.pdf" })).toBeVisible();
  expect(
    JSON.parse(
      await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8"),
    ).defaultFolder,
  ).toBe(second);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await preview(fixture, first, "第一工程");
  const before = await fs.readFile(
    path.join(first, "第一工程/paper30min.json"),
  );
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("同名工程文件夹已存在");
  expect(
    await fs.readFile(path.join(first, "第一工程/paper30min.json")),
  ).toEqual(before);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await fs.rmdir(second);
  await preview(fixture, undefined, "不可用位置");
  await page.getByRole("button", { name: "创建工程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("重新选择保存位置");
  expect(await fs.readdir(first)).toEqual(
    expect.arrayContaining(["第一工程", "第二工程"]),
  );
  expect(
    JSON.parse(
      await fs.readFile(path.join(sandbox, "profile/preferences.json"), "utf8"),
    ).recent,
  ).toHaveLength(2);
});

test("选择取消、复制源消失和复制中取消均不登记工程或遗留产物", async () => {
  await choose(null);
  await page
    .getByRole("button", { name: "从 PDF 新建工程", exact: true })
    .click();
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
  await expect(
    page.getByRole("button", { name: "创建工程", exact: true }),
  ).toBeEnabled();
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

test("材料真实添加、改名移动、重新关联与系统回收站，工程论文身份固定", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const paper = (await readManifest(root)).paper;
  await page.getByRole("button", { name: "相关材料", exact: true }).click();
  const source = path.join(sandbox, "参考材料.txt");
  await fs.writeFile(source, "与论文有关的真实材料");
  await choose(source);
  await page.getByRole("button", { name: "添加材料", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "参考材料.txt text/参考材料.txt",
      exact: true,
    }),
  ).toBeVisible();
  let manifest = await readManifest(root);
  const id = manifest.materials[0].id;
  expect(
    await fs.readFile(path.join(root, manifest.materials[0].path), "utf8"),
  ).toBe("与论文有关的真实材料");
  await page
    .getByRole("button", { name: "改名或移动 text/参考材料.txt", exact: true })
    .click();
  await page.getByLabel("工程内相对路径").fill("notes/改名材料.txt");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /改名材料.txt/ }).first(),
  ).toBeVisible();
  manifest = await readManifest(root);
  expect(manifest.materials[0]).toMatchObject({
    id,
    path: "notes/改名材料.txt",
  });
  await fs.rename(
    path.join(root, "notes/改名材料.txt"),
    path.join(root, "notes/外部移动.txt"),
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新关联", exact: true }),
  ).toBeVisible();
  await choose(path.join(root, "notes/外部移动.txt"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移出 notes/外部移动.txt", exact: true }),
  ).toBeVisible();
  expect((await readManifest(root)).materials[0]).toMatchObject({
    id,
    path: "notes/外部移动.txt",
  });
  await page
    .getByRole("button", { name: "移出 notes/外部移动.txt", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("相关引用将失效");
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await readManifest(root)).materials).toEqual([]);
  await expect(
    fs.stat(path.join(root, "notes/外部移动.txt")),
  ).rejects.toThrow();
  expect(await fs.readFile(source, "utf8")).toBe("与论文有关的真实材料");
  await page
    .getByRole("button", { name: "改名或移动 text/paper.pdf", exact: true })
    .click();
  await page.getByLabel("工程内相对路径").fill("text/工程论文.pdf");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "改名或移动 text/工程论文.pdf",
      exact: true,
    }),
  ).toBeVisible();
  expect((await readManifest(root)).paper).toEqual({
    ...paper,
    path: "text/工程论文.pdf",
  });
  await fs.rename(
    path.join(root, "text/工程论文.pdf"),
    path.join(root, "text/外部改名.pdf"),
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  const wrong = path.join(sandbox, "另一论文.pdf");
  await fs.writeFile(wrong, "%PDF-1.7\n另一份内容");
  await choose(wrong);
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("文件内容与原文档不同");
  await choose(path.join(root, "text/外部改名.pdf"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "改名或移动 text/外部改名.pdf",
      exact: true,
    }),
  ).toBeVisible();
  expect((await readManifest(root)).paper.id).toBe(paper.id);
  await expect(page.getByRole("button", { name: /^移出 / })).toHaveCount(0);
});

test("重新关联拒绝其他文档已占用的路径，失败后工程仍可重开", async () => {
  const parent = path.join(sandbox, "projects");
  await create(fixture, parent);
  const root = path.join(parent, "研究工程");
  const reference = path.join(sandbox, "相同内容参考.pdf");
  await fs.copyFile(fixture, reference);
  await page.getByRole("button", { name: "相关材料", exact: true }).click();
  await choose(reference);
  await page.getByRole("button", { name: "添加材料", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "移出 text/相同内容参考.pdf",
      exact: true,
    }),
  ).toBeVisible();
  const before = await fs.readFile(path.join(root, "paper30min.json"), "utf8");
  await fs.rename(
    path.join(root, "text/paper.pdf"),
    path.join(root, "text/外部改名.pdf"),
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await choose(path.join(root, "text/相同内容参考.pdf"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已关联另一份文档");
  expect(await fs.readFile(path.join(root, "paper30min.json"), "utf8")).toBe(
    before,
  );
  await page.getByRole("button", { name: "刷新工程", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新关联", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await choose(root);
  await page
    .getByRole("button", { name: "打开工程文件夹", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "相关材料", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "原始论文", exact: true }).click();
  await expect(page.getByRole("heading", { name: "找不到文件" })).toBeVisible();
  await choose(path.join(root, "text/外部改名.pdf"));
  await page.getByRole("button", { name: "重新关联", exact: true }).click();
  await expect(page.getByRole("tab", { name: "外部改名.pdf" })).toBeVisible();
  await expect(pdfPages()).toContainText("2");
  const after = await readManifest(root);
  expect(after.paper.id).toBe(JSON.parse(before).paper.id);
  expect(after.materials[0].path).toBe("text/相同内容参考.pdf");
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
  await expect
    .poll(async () => (await page.locator(".main").boundingBox())!.width)
    .toBeGreaterThanOrEqual(360);
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "展开 Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "尚无消息" })).toBeVisible();
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
  await expect(page.getByRole("tab").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 560, height: 780 }),
  );
  await expect(
    page.getByRole("button", { name: "展开 Agent", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workbench-narrow.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "收起左侧栏", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "工程文件" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "展开左侧栏", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "工程文件" }),
  ).toBeVisible();
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
    .poll(() =>
      page
        .getByRole("img", { name: "图片", exact: true })
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBe(100);
  await page.getByRole("link", { name: "另一篇", exact: true }).click();
  await expect(page.getByRole("tab", { name: "另一篇(1).md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "原始.md", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+Home");
  await editor.press("ArrowDown");
  await editor.press("ArrowDown");
  await editor.press("End");
  await editor.press("Delete");
  await editor.press("Control+z");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
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
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() => fs.readFile(path.join(root, "notes/原始.md"), "utf8"))
    .toBe(original + "用户补充");
  await page.getByRole("tab", { name: /另一篇/ }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() => fs.readFile(path.join(root, "notes/另一篇(1).md"), "utf8"))
    .toBe("# 另一篇\n独立草稿");
  await desktop.close();
  await launch();
  await page.getByRole("button", { name: /研究工程/ }).click();
  await page.getByRole("tab", { name: /原始.md/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码", exact: true }),
  ).toContainText("用户补充");
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
  await fs.writeFile(note, "# Agent 首次写入\n");
  await expect(page.locator(".markdown-preview")).toContainText(
    "Agent 首次写入",
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown 源码",
    exact: true,
  });
  await editor.press("Control+End");
  await editor.pressSequentially("用户未保存内容");
  await fs.writeFile(note, "# Agent 再次修改\n");
  await expect(
    page.getByText("文档已在外部修改。你的编辑已保留，尚未覆盖磁盘文件。"),
  ).toBeVisible();
  await expect(editor).toContainText("用户未保存内容");
  await page.getByRole("button", { name: "查看双方内容", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "当前磁盘内容", exact: true }),
  ).toHaveValue("# Agent 再次修改\n");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await fs.writeFile(note, "# 第三次外部更新\n");
  await expect(
    page.getByRole("textbox", { name: "当前磁盘内容", exact: true }),
  ).toHaveValue("# 第三次外部更新\n");
  await fs.rename(note, path.join(root, "notes/外部改名.md"));
  await page.getByRole("button", { name: "工程文件", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "外部改名.md", exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("用户未保存内容");
  await expect(page.getByRole("alert").first()).toContainText(
    "文件已被删除或移动",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭 协作.md", exact: true }).click();
  await expect(editor).toBeVisible();
  // Clear the draft through the explicit discard confirmation for test shutdown.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭 协作.md", exact: true }).click();
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
  await cdp.send("Input.insertText", { text: "中文组合" });
  await expect(editor).toContainText("中文组合");
  await page.getByRole("button", { name: "分屏", exact: true }).click();
  await page.screenshot({ path: "test-results/markdown-split.png" });
  await editor.press("Control+z");
  await expect(editor).not.toContainText("中文组合");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await editor.press("Control+End");
  await editor.pressSequentially("恢复输入");
  await fs.chmod(note, 0o444);
  try {
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("保存失败");
    expect(await fs.readFile(note, "utf8")).toBe("# 中文输入\r\n原文\r\n");
    await expect(editor).toContainText("恢复输入");
  } finally {
    await fs.chmod(note, 0o666);
  }
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() => fs.readFile(note, "utf8"))
    .toBe("# 中文输入\r\n原文\r\n恢复输入");
  await cdp.detach();
});

test("Markdown 长文视图往返和两个工程的同路径位置独立", async () => {
  const parent = path.join(sandbox, "projects");
  const longNote = Array.from(
    { length: 100 },
    (_, i) => "## 第 " + i + " 段\n\n正文段落\n\n",
  ).join("");
  await create(fixture, parent, "工程甲");
  const a = path.join(parent, "工程甲");
  await fs.writeFile(path.join(a, "notes/同名.md"), longNote);
  await page.getByRole("button", { name: "笔记", exact: true }).click();
  await page.getByRole("button", { name: "同名.md", exact: true }).click();
  const previewPane = page.locator(".markdown-preview");
  await previewPane.hover();
  await page.mouse.wheel(0, 650);
  await expect
    .poll(() => previewPane.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(400);
  const scroll = await previewPane.evaluate((e) => e.scrollTop);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect
    .poll(() => previewPane.evaluate((e) => e.scrollTop))
    .toBe(scroll);
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
  await expect
    .poll(() => previewPane.evaluate((e) => e.scrollTop))
    .toBe(scroll);
  await page.getByRole("button", { name: "所有工程", exact: true }).click();
  await page.getByRole("button", { name: /工程乙/ }).click();
  await expect.poll(() => previewPane.evaluate((e) => e.scrollTop)).toBe(0);
});
