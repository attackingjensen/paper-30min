import { test, expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWebTools } from "../src/main/web-tools";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function exa(reply: object, requests: any[] = []) {
  // Substitute only Exa's HTTP boundary; Pi's MCP protocol runs unchanged.
  return async (url: any, init: any) => {
    const request = JSON.parse(init.body);
    requests.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
      request,
    });
    if (!request.id) return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "exa-fixture", version: "1" },
            }
          : reply,
    });
  };
}

const invoke = async (
  tools: ReturnType<typeof createWebTools>,
  name: string,
  args: any,
  signal?: AbortSignal,
) =>
  tools
    .find((tool) => tool.name === name)!
    .execute("call", args, signal, undefined, {} as any);

test("网络资料支持正文分段查阅、会话重开及隔离，密钥只进入请求头", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-web-"));
  try {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({
      role: "user",
      content: "调研",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [],
      timestamp: Date.now(),
    } as any);
    const requests: any[] = [];
    const text =
      "# Actual article\nURL: https://example.org/paper\n" +
      "研究正文。".repeat(3500) +
      "独立验证结果为 28.4 BLEU。secret-exa";
    const tools = createWebTools(
      manager,
      exa({ content: [{ type: "text", text }] }, requests),
      { key: "secret-exa" },
      ["secret-exa"],
      () => true,
    );
    const fetched = await invoke(tools, "fetch_content", {
      url: "https://example.org/paper",
    });
    expect(fetched.content[0]).not.toHaveProperty(
      "text",
      expect.stringContaining("28.4"),
    );
    expect(JSON.stringify(fetched)).not.toContain("secret-exa");
    const responseId = (fetched.details as any).webContent.responseId;
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "fetch_content",
      ...fetched,
      details: fetched.details as any,
      isError: false,
      timestamp: Date.now(),
    });
    const reopened = SessionManager.open(manager.getSessionFile()!, dir);
    const reading = createWebTools(reopened, exa({}), {}, [], () => true);
    const passage = await invoke(reading, "get_search_content", {
      responseId,
      findText: "28.4 BLEU",
    });
    expect((passage.content[0] as any).text).toContain(
      "独立验证结果为 28.4 BLEU",
    );
    const slice = await invoke(reading, "get_search_content", {
      responseId,
      offset: 12000,
      limit: 1000,
    });
    expect((slice.details as any).nextOffset).toBe(13000);
    const other = createWebTools(
      SessionManager.inMemory(dir),
      exa({}),
      {},
      [],
      () => true,
    );
    await expect(
      invoke(other, "get_search_content", { responseId }),
    ).rejects.toThrow("当前会话");
    const call = requests.find((item) => item.request.method === "tools/call");
    expect(call.headers["x-api-key"]).toBe("secret-exa");
    expect(call.url).not.toContain("secret-exa");
    expect(call.request.params.arguments).toEqual({
      urls: ["https://example.org/paper"],
      maxCharacters: 100000,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("搜索返回可核查摘录，免费入口、无结果、认证与正常响应内限流均可区分", async () => {
  const manager = SessionManager.inMemory();
  const requests: any[] = [];
  const make = (reply: object) =>
    createWebTools(manager, exa(reply, requests), {}, [], () => true);
  const found = await invoke(
    make({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              {
                title: "论文",
                url: "https://arxiv.org/abs/1706.03762",
                text: "实际摘录",
              },
            ],
          }),
        },
      ],
    }),
    "web_search",
    { query: "attention paper", numResults: 2 },
  );
  expect((found.content[0] as any).text).toContain("仅为搜索摘录");
  expect((found.content[0] as any).text).toContain(
    "https://arxiv.org/abs/1706.03762",
  );
  expect(requests.every((item) => !item.headers["x-api-key"])).toBe(true);
  const empty = await invoke(
    make({ content: [{ type: "text", text: '{"results":[]}' }] }),
    "web_search",
    { query: "no results" },
  );
  expect((empty.content[0] as any).text).toContain("没有找到");
  await expect(
    invoke(
      make({
        _meta: { "ai.exa/rateLimited": true },
        content: [{ type: "text", text: "limit" }],
      }),
      "web_search",
      { query: "test" },
    ),
  ).rejects.toThrow("限流");
  await expect(
    invoke(
      make({
        isError: true,
        content: [{ type: "text", text: "401 invalid API key" }],
      }),
      "web_search",
      { query: "test" },
    ),
  ).rejects.toThrow("认证失败");
  const rejected = createWebTools(
    manager,
    async () => new Response("Unauthorized", { status: 401 }),
    { key: "invalid-key" },
    ["invalid-key"],
    () => true,
  );
  await expect(
    invoke(rejected, "web_search", { query: "test" }),
  ).rejects.toThrow("认证失败");
  await expect(
    invoke(make({}), "fetch_content", { url: "http://127.0.0.1/private" }),
  ).rejects.toThrow("公开");
});

test("取消和总超时终止实际网络读取，不产生可查阅内容", async () => {
  test.setTimeout(35000);
  const manager = SessionManager.inMemory();
  let aborted = 0;
  let notifyStarted: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const hanging = async (_url: any, init: any): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          aborted++;
          reject(init.signal.reason);
        },
        { once: true },
      );
      notifyStarted();
    });
  const tools = createWebTools(manager, hanging, {}, [], () => true);
  const controller = new AbortController();
  const canceled = invoke(
    tools,
    "web_search",
    { query: "cancel" },
    controller.signal,
  );
  await started;
  controller.abort();
  await expect(canceled).rejects.toThrow("已停止");
  expect(aborted).toBeGreaterThan(0);
  await expect(
    invoke(tools, "web_search", { query: "timeout" }),
  ).rejects.toThrow("超时");
  expect(manager.getBranch()).toEqual([]);
});
