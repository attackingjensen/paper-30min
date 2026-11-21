import { test, expect } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { MockAgent } from "undici";
import { arxivFetch, ArxivFetchError } from "../src/main/arxiv/transport";

// 受控本地 HTTP 服务：生产 transport 允许 http→https 规范化，
// 因此本地 fixture 端点走 http://127.0.0.1，不放宽任何生产 TLS/host 检查。
let server: Server;
let baseUrl: string;
type Handler = (
  url: URL,
  respond: (status: number, headers: Record<string, string>, body?: Buffer | string) => void,
  raw: ServerResponse,
) => void;
let handler: Handler;
const hits: string[] = [];

test.beforeEach(async () => {
  hits.length = 0;
  handler = (_url, respond) => respond(200, { "content-type": "text/html" }, "<html>ok</html>");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    hits.push(url.pathname + url.search);
    handler(
      url,
      (status, headers, body) => {
        res.writeHead(status, headers);
        res.end(body);
      },
      res,
    );
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterEach(async () => {
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
});

// 受控本地 fixture 端点：显式开启回环许可（生产默认拒绝，见下方专项用例）。
const budget = { budgetBytes: 1024 * 1024, allowFixtureLoopback: true };

test("arxiv-import transport 幂等 GET 返回原始字节、最终 URL 与公开响应头", async () => {
  handler = (_url, respond) =>
    respond(200, { "content-type": "text/html", etag: '"abc"' }, Buffer.from("<html>论文</html>"));
  const response = await arxivFetch(`${baseUrl}/abs/2401.01234v1`, budget);
  expect(response.status).toBe(200);
  expect(response.url).toBe(`${baseUrl}/abs/2401.01234v1`);
  expect(Buffer.from(response.bytes).toString("utf8")).toBe("<html>论文</html>");
  expect(response.headers.etag).toBe('"abc"');
  expect(hits).toEqual(["/abs/2401.01234v1"]);
});

test("arxiv-import transport 拒绝非法 URL、凭据、协议与非允许 host，且不发起请求", async () => {
  for (const url of ["https://user:pass@arxiv.org/abs/2401.01234", "ftp://arxiv.org/abs/2401.01234", "not a url"]) {
    const error = await arxivFetch(url, budget).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArxivFetchError);
    expect((error as ArxivFetchError).code).toBe("arxiv-fetch-invalid-url");
  }
  const forged = await arxivFetch("https://arxiv.org.evil.com/abs/2401.01234", budget).catch((e: unknown) => e);
  expect((forged as ArxivFetchError).code).toBe("arxiv-fetch-host-rejected");
  expect(hits).toEqual([]);
});

test("arxiv-import transport 拒绝到非允许 host 的重定向", async () => {
  handler = (_url, respond) => respond(302, { location: "https://evil.example/steal" });
  const error = await arxivFetch(`${baseUrl}/abs/2401.01234`, budget).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-redirect-invalid");
  expect(hits).toEqual(["/abs/2401.01234"]);
});

test("arxiv-import transport 拒绝到本地/私网地址的重定向（非回环）", async () => {
  handler = (_url, respond) => respond(302, { location: "http://192.168.1.1/abs/2401.01234" });
  const error = await arxivFetch(`${baseUrl}/abs/2401.01234`, budget).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-redirect-invalid");
});

test("arxiv-import transport 跟随允许清单内的重定向并记录最终 URL", async () => {
  handler = (url, respond) => {
    if (url.pathname === "/abs/2401.01234") respond(302, { location: `${baseUrl}/abs/2401.01234v2` });
    else respond(200, { "content-type": "text/html" }, "<html>v2</html>");
  };
  const response = await arxivFetch(`${baseUrl}/abs/2401.01234`, budget);
  expect(response.url).toBe(`${baseUrl}/abs/2401.01234v2`);
  expect(hits).toEqual(["/abs/2401.01234", "/abs/2401.01234v2"]);
});

test("arxiv-import transport 重定向超过 5 次即拒绝", async () => {
  handler = (url, respond) => respond(302, { location: `${baseUrl}/loop${Number(url.pathname.slice(5) || 0) + 1}` });
  const error = await arxivFetch(`${baseUrl}/loop0`, budget).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-redirect-limit");
  expect(hits.length).toBe(6);
});

test("arxiv-import transport 429/5xx/网络中断在同一次动作内有界重试（默认 2 次额外）", async () => {
  let attempts = 0;
  handler = (_url, respond) => {
    attempts += 1;
    if (attempts <= 2) respond(503, {});
    else respond(200, { "content-type": "text/html" }, "<html>ok</html>");
  };
  const response = await arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
    sleep: async () => {},
  });
  expect(response.status).toBe(200);
  expect(attempts).toBe(3);
});

test("arxiv-import transport 重试耗尽后报告最终状态，不无限重试", async () => {
  handler = (_url, respond) => respond(429, { "retry-after": "1" });
  const error = await arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
    sleep: async () => {},
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-status");
  expect((error as ArxivFetchError).status).toBe(429);
  expect(hits.length).toBe(3);
});

test("arxiv-import transport 尊重有界 Retry-After，超界等待被截断到上限", async () => {
  const waited: number[] = [];
  let attempts = 0;
  handler = (_url, respond) => {
    attempts += 1;
    if (attempts === 1) respond(429, { "retry-after": "3600" });
    else respond(200, {}, "ok");
  };
  await arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
    retryAfterCapMs: 50,
    sleep: async (ms) => {
      waited.push(ms);
    },
  });
  expect(waited).toEqual([50]);
});

test("arxiv-import transport 404/403 不重试，直接分类报告", async () => {
  for (const status of [404, 403]) {
    hits.length = 0;
    handler = (_url, respond) => respond(status, {});
    const error = await arxivFetch(`${baseUrl}/html/2401.01234v9`, {
      ...budget,
      sleep: async () => {
        throw new Error("不应等待重试");
      },
    }).catch((e: unknown) => e);
    expect((error as ArxivFetchError).code).toBe("arxiv-fetch-status");
    expect((error as ArxivFetchError).status).toBe(status);
    expect(hits.length).toBe(1);
  }
});

test("arxiv-import transport 声明大小超预算时不读取正文即中止", async () => {
  handler = (_url, respond) => respond(200, { "content-length": String(2 * 1024 * 1024) }, Buffer.alloc(16));
  const error = await arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-budget");
});

test("arxiv-import transport 实际字节超预算即中止，不截断后报成功", async () => {
  handler = (_url, _respond, raw) => {
    raw.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 1);
    let sent = 0;
    const timer = setInterval(() => {
      sent += chunk.length;
      if (sent > 4 * 1024 * 1024) {
        clearInterval(timer);
        raw.end();
        return;
      }
      raw.write(chunk);
    }, 1);
    raw.on("close", () => clearInterval(timer));
  };
  const error = await arxivFetch(`${baseUrl}/assets/big.png`, {
    ...budget,
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-budget");
});

test("arxiv-import transport 无字节进度停滞按 stallTimeout 中止并有界重试", async () => {
  handler = (_url, _respond, raw) => {
    raw.writeHead(200, { "content-type": "text/html" });
    // 只发头部，永不发送正文也不结束。
  };
  const error = await arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
    stallTimeoutMs: 150,
    sleep: async () => {},
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-stalled");
  // 停滞属于可重试网络故障：同一次动作内最多两次额外重试。
  expect(hits.length).toBe(3);
});

test("arxiv-import transport 活动下载不受短总时限影响，只要持续有字节进度", async () => {
  handler = (_url, _respond, raw) => {
    raw.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(32 * 1024, 2);
    let sent = 0;
    const timer = setInterval(() => {
      sent += chunk.length;
      if (sent >= 512 * 1024) {
        clearInterval(timer);
        raw.end(chunk);
        return;
      }
      raw.write(chunk);
    }, 40);
    raw.on("close", () => clearInterval(timer));
  };
  const response = await arxivFetch(`${baseUrl}/assets/active.png`, {
    ...budget,
    stallTimeoutMs: 200,
  });
  expect(response.bytes.byteLength).toBeGreaterThanOrEqual(512 * 1024);
});

test("arxiv-import transport 用户取消立即中止并报告 cancelled", async () => {
  handler = (_url, _respond, raw) => {
    raw.writeHead(200, { "content-type": "text/html" });
    raw.write("<html>partial");
    // 挂住不结束，等待取消。
  };
  const controller = new AbortController();
  const pending = arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
    signal: controller.signal,
  });
  await delay(50);
  controller.abort();
  const error = await pending.catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-cancelled");
});

test("arxiv-import transport 重试等待期间取消同样生效", async () => {
  handler = (_url, respond) => respond(503, { "retry-after": "60" });
  const controller = new AbortController();
  const pending = arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    ...budget,
    signal: controller.signal,
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
  });
  await delay(50);
  controller.abort();
  const error = await pending.catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-cancelled");
  expect(hits.length).toBe(1);
});

test("arxiv-import transport 网络中断重试后仍失败时报告 network 分类", async () => {
  // 指向一个已关闭的端口，产生真实连接拒绝。
  const closed = createServer();
  const listening = Promise.withResolvers<void>();
  closed.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const port = (closed.address() as AddressInfo).port;
  const shutdown = Promise.withResolvers<void>();
  closed.close((error) => (error ? shutdown.reject(error) : shutdown.resolve()));
  await shutdown.promise;
  const error = await arxivFetch(`http://127.0.0.1:${port}/abs/2401.01234`, {
    ...budget,
    sleep: async () => {},
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-network");
  expect(hits.length).toBe(0);
});

test("arxiv-import transport 生产模式拒绝回环起始与回环重定向，本地服务零命中", async () => {
  const prod = { budgetBytes: 1024 * 1024 };
  const start = await arxivFetch(`${baseUrl}/abs/2401.01234`, prod).catch((e: unknown) => e);
  expect((start as ArxivFetchError).code).toBe("arxiv-fetch-invalid-url");
  expect(hits).toEqual([]);

  // 受控 MockAgent 模拟 arxiv.org 响应（不访问真实网络，不放宽任何检查）：
  // 生产模式跟随到回环的重定向必须被拒绝，本地 /steal 零命中。
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock
    .get("https://arxiv.org")
    .intercept({ path: "/abs/2401.01234", method: "GET" })
    .reply(302, "", { headers: { location: `${baseUrl}/steal` } });
  const redirect = await arxivFetch("https://arxiv.org/abs/2401.01234", {
    ...prod,
    dispatcher: mock,
  }).catch((e: unknown) => e);
  expect((redirect as ArxivFetchError).code).toBe("arxiv-fetch-redirect-invalid");
  expect(hits).toEqual([]);
  await mock.close();
});

test("arxiv-import transport 生产模式起始 http://arxiv.org 规范化为 https 再访问", async () => {
  // MockAgent 只登记 https 端点：若起始 http 未被规范化，请求将无法匹配。
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock
    .get("https://arxiv.org")
    .intercept({ path: "/abs/2401.01234", method: "GET" })
    .reply(200, "<html>ok</html>", { headers: { "content-type": "text/html" } });
  const response = await arxivFetch("http://arxiv.org/abs/2401.01234", {
    budgetBytes: 1024 * 1024,
    dispatcher: mock,
  });
  expect(response.url).toBe("https://arxiv.org/abs/2401.01234");
  expect(Buffer.from(response.bytes).toString("utf8")).toBe("<html>ok</html>");
  expect(hits).toEqual([]);
  await mock.close();
});

test("arxiv-import transport 重定向的无界正文被立即断开，不 draining", async () => {
  const closed = Promise.withResolvers<void>();
  let sent = 0;
  handler = (_url, _respond, raw) => {
    raw.writeHead(302, { location: `${baseUrl}/next`, "content-type": "text/plain" });
    const chunk = Buffer.alloc(64 * 1024, 1);
    const timer = setInterval(() => {
      sent += chunk.length;
      if (!raw.write(chunk)) clearInterval(timer);
    }, 1);
    raw.on("close", () => {
      clearInterval(timer);
      closed.resolve();
    });
  };
  const error = await arxivFetch(`${baseUrl}/abs/2401.01234`, {
    ...budget,
    maxRedirects: 0,
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-redirect-limit");
  // 连接被客户端立即断开（而非读完无界正文）：close 事件到达且发送量有界。
  await closed.promise;
  expect(sent).toBeLessThan(8 * 1024 * 1024);
});

test("arxiv-import transport 声明超预算的大正文不读取即中止", async () => {
  let sent = 0;
  handler = (_url, _respond, raw) => {
    raw.writeHead(200, { "content-length": String(64 * 1024 * 1024) });
    const chunk = Buffer.alloc(64 * 1024, 1);
    const timer = setInterval(() => {
      sent += chunk.length;
      raw.write(chunk);
    }, 1);
    raw.on("close", () => clearInterval(timer));
  };
  const error = await arxivFetch(`${baseUrl}/html/2401.01234v1`, {
    budgetBytes: 1024 * 1024,
    allowFixtureLoopback: true,
  }).catch((e: unknown) => e);
  expect((error as ArxivFetchError).code).toBe("arxiv-fetch-budget");
  expect(sent).toBeLessThan(8 * 1024 * 1024);
});
