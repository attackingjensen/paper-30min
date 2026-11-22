import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { AgentSettings, ChatSession } from "../src/shared/contracts";
import {
  sandbox,
  desktop,
  desktopProcess,
  page,
  fixture,
  create,
  launch,
  registerDesktopFixture,
} from "./desktop-fixture";

registerDesktopFixture();

test("Pi 工具真实读取、修改、计算绘图与冲突重开", async () => {
  test.setTimeout(120000);
  const thinkingGate = Promise.withResolvers<void>();
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
  const results: { content?: unknown }[] = [];
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
        await thinkingGate.promise;
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
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
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
    thinkingGate.resolve();
    await expect(thinking).toHaveAttribute("open", "");
    await expect(page.locator(".message-text").last()).toHaveText("任务完成");
    expect(await fs.readFile(path.join(root, "notes/input.md"), "utf8")).toBe("score=9\n");
    expect(await fs.readFile(path.join(root, "notes/result.csv"), "utf8")).toContain("sum,30");
    expect(await fs.readFile(path.join(root, "text/paper.pdf"))).toEqual(await fs.readFile(fixture));
    await expect(fs.stat(path.join(sandbox, "projects/escape.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const computeResult = results.find((result) => String(result.content).includes("sum=30"));
    expect(computeResult).toBeTruthy();
    if (!computeResult) throw new Error("未记录平方计算工具结果");
    const computeOutput = String(computeResult.content);
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
    thinkingGate.resolve();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
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
    await page.getByLabel("Agent 消息").fill("迟到响应后的客户端屏障");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "停止回复", exact: true })).toHaveCount(0);
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
