import { test, expect } from "@playwright/test";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AgentSettings, ChatSession } from "../src/shared/contracts";
import { sandbox, desktop, page, fixture, create, launch, registerDesktopFixture } from "./desktop-fixture";

registerDesktopFixture();

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
        "reasoning_effort" in body && typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
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
