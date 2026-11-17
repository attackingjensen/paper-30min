import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ProxyAgent } from "undici";
import { createProject } from "../src/main/project-core";
import { snapshotLocalPdf } from "../src/main/pdf/snapshot";
import {
  listBaiduPdfParseTasks,
  resumeBaiduPdfParse,
  startBaiduPdfParse,
  stopBaiduPdfParse,
  type BaiduPdfParseConfig,
} from "../src/main/parsing/baidu-task";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const TOKEN = "test-baidu-token-never-persist";
const SIGNED_URL_MARKER = "signature-never-persist";
const MODEL = "PaddleOCR-VL-1.6" as const;

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

let sandbox: string;
let root: string;
let sourceSnapshotId: string;
let pdfSha256: string;
let servers: Server[];

async function drain(request: IncomingMessage) {
  for await (const _chunk of request) {
    // Consume controlled multipart fixtures before sending the receipt.
  }
}

async function controlledServer(handler: Handler) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/jobs`;
}

function config(endpoint: string): BaiduPdfParseConfig {
  return { endpoint, model: MODEL, apiKey: TOKEN };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(target)));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

async function expectProjectDoesNotContain(...secrets: string[]) {
  for (const file of await filesUnder(root)) {
    const bytes = await fs.readFile(file);
    for (const secret of secrets)
      expect(bytes.includes(secret), `${path.basename(file)} leaked a secret`).toBe(false);
  }
}

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-pdf-task-"));
  servers = [];
  const project = await createProject({ parent: sandbox, name: "PDF 工程" });
  root = project.root;
  const snapshot = await snapshotLocalPdf({ root, source: SAMPLE });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  sourceSnapshotId = snapshot.snapshot.sourceSnapshotId;
  pdfSha256 = snapshot.snapshot.sha256;
});

test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("pdf-import 新任务确认前无 POST，取消确认不写任务记录", async () => {
  let confirmations = 0;
  const result = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config("http://127.0.0.1:1/jobs"),
    confirmUpload: async (request) => {
      confirmations += 1;
      expect(request).toEqual({
        sourceSnapshotId,
        originalName: "sample_paper.pdf",
        pdfSha256,
        pageCount: 2,
        provider: "baidu-aistudio",
        model: MODEL,
        endpoint: "http://127.0.0.1:1/jobs",
        options: {
          useDocOrientationClassify: false,
          useDocUnwarping: false,
          useChartRecognition: false,
        },
      });
      return false;
    },
  });
  expect(result).toEqual({ outcome: "cancelled" });
  expect(confirmations).toBe(1);
  expect(await listBaiduPdfParseTasks(root)).toEqual([]);
});

test("pdf-import 提交查询下载复用任务号，Token 与签名 URL 不进入工程", async () => {
  let posts = 0;
  let queries = 0;
  let downloads = 0;
  const raw = Buffer.from(`{"resource":"https://cdn.example/image?${SIGNED_URL_MARKER}"}\n`);
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "job-original" } }));
      return;
    }
    if (request.url === "/jobs/job-original") {
      queries += 1;
      response.end(JSON.stringify({
        code: 0,
        data: {
          state: "done",
          resultUrl: { jsonUrl: `${endpoint}/result?${SIGNED_URL_MARKER}` },
        },
      }));
      return;
    }
    if (request.url === `/jobs/result?${SIGNED_URL_MARKER}`) {
      downloads += 1;
      response.end(raw);
      return;
    }
    response.writeHead(404).end();
  });
  const result = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(result.outcome).toBe("downloaded");
  if (result.outcome !== "downloaded") throw new Error("controlled download did not finish");
  expect(Buffer.from(result.response.bytes).equals(raw)).toBe(true);
  expect(result.response.sha256).toBe(sha256(raw));
  expect(result.task).toMatchObject({
    parentSourceSnapshotId: sourceSnapshotId,
    pdfSha256,
    provider: "baidu-aistudio",
    model: MODEL,
    phase: "downloaded",
    jobId: "job-original",
    responseSha256: sha256(raw),
  });
  expect(posts).toBe(1);
  expect(queries).toBe(1);
  expect(downloads).toBe(1);
  expect(result.task).not.toHaveProperty("apiKey");
  expect(result.task).not.toHaveProperty("resultUrl");
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);

  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: result.task.parseBatchId,
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("downloaded");
  expect(posts).toBe(1);
  expect(queries).toBe(2);
  expect(downloads).toBe(2);
});

test("pdf-import 无效提交回执进入不确定，人工关联恢复且绝不重传", async () => {
  let posts = 0;
  const raw = Buffer.from("controlled-jsonl\n");
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "invalid job id" } }));
      return;
    }
    if (request.url === "/jobs/manual-job") {
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      response.end(raw);
      return;
    }
    response.writeHead(404).end();
  });
  const started = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(started.outcome).toBe("incomplete");
  if (started.outcome !== "incomplete") throw new Error("invalid receipt unexpectedly succeeded");
  expect(started.task.phase).toBe("unknown");
  expect(started.task.jobId).toBeUndefined();
  expect(started.task.diagnostic?.code).toBe("baidu-submit-receipt-invalid");

  let extraConfirmations = 0;
  await expect(startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => {
      extraConfirmations += 1;
      return true;
    },
  })).rejects.toThrow("先恢复原任务");
  expect(extraConfirmations).toBe(0);
  await expect(resumeBaiduPdfParse({
    root,
    parseBatchId: started.task.parseBatchId,
    config: config(endpoint),
  })).rejects.toThrow("任务号");
  expect(posts).toBe(1);

  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: started.task.parseBatchId,
    jobId: "manual-job",
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("downloaded");
  expect(posts).toBe(1);
  const [persisted] = await listBaiduPdfParseTasks(root);
  expect(persisted.jobId).toBe("manual-job");
  expect(persisted.phase).toBe("downloaded");
});

test("pdf-import 首次 POST 前崩溃留下不确定记录，重开不自动上传", async () => {
  let posts = 0;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "unexpected" } }));
      return;
    }
    if (request.url === "/jobs/manual-after-crash") {
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      response.end("recovered\n");
      return;
    }
    response.writeHead(404).end();
  });
  await expect(startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
    hooks: {
      onPoint: (point) => {
        if (point === "submitting-persisted") throw new Error("injected crash before POST");
      },
    },
  })).rejects.toThrow("injected crash before POST");
  expect(posts).toBe(0);
  const [task] = await listBaiduPdfParseTasks(root);
  expect(task.phase).toBe("unknown");
  await expect(startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  })).rejects.toThrow("先恢复原任务");

  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: task.parseBatchId,
    jobId: "manual-after-crash",
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("downloaded");
  expect(posts).toBe(0);
});

test("pdf-import 合法任务号先持久化再查询，崩溃恢复不重传", async () => {
  let posts = 0;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "persisted-job" } }));
      return;
    }
    if (request.url === "/jobs/persisted-job") {
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      response.end("persisted-result\n");
      return;
    }
    response.writeHead(404).end();
  });
  await expect(startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
    hooks: {
      onPoint: (point) => {
        if (point === "job-persisted") throw new Error("injected crash before query");
      },
    },
  })).rejects.toThrow("injected crash before query");
  expect(posts).toBe(1);
  const [task] = await listBaiduPdfParseTasks(root);
  expect(task).toMatchObject({ phase: "querying", jobId: "persisted-job" });

  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: task.parseBatchId,
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("downloaded");
  expect(posts).toBe(1);
});

test("pdf-import 只有明确拒绝可结束提交，5xx 保持不确定并阻止新费用", async () => {
  let posts = 0;
  let confirmations = 0;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    posts += 1;
    await drain(request);
    response.writeHead(posts === 1 ? 422 : 500);
    response.end(`provider-sensitive-${SIGNED_URL_MARKER}`);
  });
  const rejected = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => {
      confirmations += 1;
      return true;
    },
  });
  expect(rejected.outcome).toBe("incomplete");
  if (rejected.outcome !== "incomplete") throw new Error("rejection unexpectedly succeeded");
  expect(rejected.task.phase).toBe("failed");
  expect(rejected.task.jobId).toBeUndefined();
  expect(rejected.task.diagnostic?.code).toBe("baidu-submit-rejected");

  const uncertain = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => {
      confirmations += 1;
      return true;
    },
  });
  expect(uncertain.outcome).toBe("incomplete");
  if (uncertain.outcome !== "incomplete") throw new Error("5xx unexpectedly succeeded");
  expect(uncertain.task.phase).toBe("unknown");
  expect(uncertain.task.diagnostic?.code).toBe("baidu-submit-unknown");
  expect(confirmations).toBe(2);
  expect(posts).toBe(2);
  await expect(startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  })).rejects.toThrow("先恢复原任务");
  expect(posts).toBe(2);
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import 单轮查询超时保留原任务，恢复不新建云端任务", async () => {
  let posts = 0;
  let remoteDone = false;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "slow-job" } }));
      return;
    }
    if (request.url === "/jobs/slow-job") {
      response.end(JSON.stringify({
        code: 0,
        data: remoteDone
          ? { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } }
          : { state: "running" },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      response.end("slow-result\n");
      return;
    }
    response.writeHead(404).end();
  });
  let now = 0;
  const timing = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
    queryWaitMs: 1_000,
    pollIntervalMs: 600,
  };
  const waiting = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
    timing,
  });
  expect(waiting.outcome).toBe("incomplete");
  if (waiting.outcome !== "incomplete") throw new Error("query wait unexpectedly succeeded");
  expect(waiting.task).toMatchObject({ phase: "querying", jobId: "slow-job" });
  expect(waiting.task.diagnostic?.code).toBe("baidu-query-wait-exceeded");
  expect(now).toBeGreaterThanOrEqual(1_000);
  expect(posts).toBe(1);

  remoteDone = true;
  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: waiting.task.parseBatchId,
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("downloaded");
  expect(posts).toBe(1);
});

test("pdf-import 停止只停止本机等待，恢复继续原任务", async () => {
  let posts = 0;
  let remoteDone = false;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "stop-job" } }));
      return;
    }
    if (request.url === "/jobs/stop-job") {
      if (!remoteDone) {
        const [task] = await listBaiduPdfParseTasks(root);
        expect(stopBaiduPdfParse(root, task.parseBatchId)).toBe(true);
      }
      response.end(JSON.stringify({
        code: 0,
        data: remoteDone
          ? { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } }
          : { state: "running" },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      response.end("stopped-result\n");
      return;
    }
    response.writeHead(404).end();
  });
  const stopped = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(stopped.outcome).toBe("incomplete");
  if (stopped.outcome !== "incomplete") throw new Error("stop unexpectedly succeeded");
  expect(stopped.task).toMatchObject({ phase: "stopped", jobId: "stop-job" });
  expect(stopped.task.diagnostic?.code).toBe("baidu-task-stopped");
  expect(posts).toBe(1);

  remoteDone = true;
  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: stopped.task.parseBatchId,
    config: config(endpoint),
  });
  expect(resumed.outcome).toBe("downloaded");
  expect(posts).toBe(1);
});

test("pdf-import 重下结果摘要不符时保留现场，不采用另一份响应", async () => {
  let posts = 0;
  let raw = Buffer.from("first-result\n");
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "digest-job" } }));
      return;
    }
    if (request.url === "/jobs/digest-job") {
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      response.end(raw);
      return;
    }
    response.writeHead(404).end();
  });
  const first = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(first.outcome).toBe("downloaded");
  if (first.outcome !== "downloaded") throw new Error("first download failed");
  raw = Buffer.from("different-result\n");
  const changed = await resumeBaiduPdfParse({
    root,
    parseBatchId: first.task.parseBatchId,
    config: config(endpoint),
  });
  expect(changed.outcome).toBe("incomplete");
  if (changed.outcome !== "incomplete") throw new Error("changed digest was accepted");
  expect(changed.task.phase).toBe("downloading");
  expect(changed.task.diagnostic?.code).toBe("baidu-result-digest-mismatch");
  expect(changed.task.responseSha256).toBe(first.task.responseSha256);
  expect(posts).toBe(1);
  await expectProjectDoesNotContain("different-result");
});

test("pdf-import 代理凭据与网络错误不进入工程或任务诊断", async () => {
  const proxySecret = "proxy-credential-never-persist";
  const proxy = new ProxyAgent(`http://${proxySecret}@127.0.0.1:1`);
  let posts = 0;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") posts += 1;
    response.writeHead(500).end();
  });
  try {
    const result = await startBaiduPdfParse({
      root,
      sourceSnapshotId,
      config: { ...config(endpoint), dispatcher: proxy },
      confirmUpload: async () => true,
    });
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") throw new Error("unreachable proxy unexpectedly succeeded");
    expect(result.task.phase).toBe("unknown");
    expect(result.task.diagnostic?.code).toBe("baidu-submit-unknown");
    expect(JSON.stringify(result.task)).not.toContain(proxySecret);
    expect(posts).toBe(0);
    await expectProjectDoesNotContain(TOKEN, proxySecret);
  } finally {
    await proxy.close();
  }
});

test("pdf-import 远端明确失败保留诊断，只有用户再次确认才能发起新任务", async () => {
  let posts = 0;
  let confirmations = 0;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      if (posts === 1) {
        response.end(JSON.stringify({ code: 0, data: { jobId: "remote-failed-job" } }));
      } else {
        response.writeHead(422).end();
      }
      return;
    }
    if (request.url === "/jobs/remote-failed-job") {
      response.end(JSON.stringify({ code: 0, data: { state: "failed" } }));
      return;
    }
    response.writeHead(404).end();
  });
  const failed = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(failed.outcome).toBe("incomplete");
  if (failed.outcome !== "incomplete") throw new Error("remote failure unexpectedly succeeded");
  expect(failed.task).toMatchObject({ phase: "remote-failed", jobId: "remote-failed-job" });
  expect(failed.task.diagnostic?.code).toBe("baidu-remote-failed");
  expect(posts).toBe(1);
  await expect(resumeBaiduPdfParse({
    root,
    parseBatchId: failed.task.parseBatchId,
    config: config(endpoint),
  })).rejects.toThrow("已结束");
  expect(posts).toBe(1);

  const rejected = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => {
      confirmations += 1;
      return true;
    },
  });
  expect(rejected.outcome).toBe("incomplete");
  expect(confirmations).toBe(1);
  expect(posts).toBe(2);
});

test("pdf-import 状态与 JSONL 响应超预算时不读取为成功结果", async () => {
  let posts = 0;
  let oversizedStatus = true;
  let oversizedResult = false;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "budget-job" } }));
      return;
    }
    if (request.url === "/jobs/budget-job") {
      if (oversizedStatus) {
        response.writeHead(200, { "content-length": String(1024 * 1024 + 1) });
        response.end();
      } else {
        response.end(JSON.stringify({
          code: 0,
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
        }));
      }
      return;
    }
    if (request.url === "/jobs/result") {
      if (oversizedResult)
        response.writeHead(200, { "content-length": String(256 * 1024 * 1024 + 1) });
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  const statusLimited = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(statusLimited.outcome).toBe("incomplete");
  if (statusLimited.outcome !== "incomplete") throw new Error("oversized status was accepted");
  expect(statusLimited.task.phase).toBe("querying");
  expect(statusLimited.task.diagnostic?.code).toBe("baidu-query-failed");

  oversizedStatus = false;
  oversizedResult = true;
  const resultLimited = await resumeBaiduPdfParse({
    root,
    parseBatchId: statusLimited.task.parseBatchId,
    config: config(endpoint),
  });
  expect(resultLimited.outcome).toBe("incomplete");
  if (resultLimited.outcome !== "incomplete") throw new Error("oversized JSONL was accepted");
  expect(resultLimited.task.phase).toBe("downloading");
  expect(resultLimited.task.diagnostic?.code).toBe("baidu-download-failed");
  expect(resultLimited.task.responseSha256).toBeUndefined();
  expect(posts).toBe(1);
});

test("pdf-import 非允许资源地址不访问且不泄露签名 URL", async () => {
  let queries = 0;
  const signedUrl = `https://example.invalid/result?${SIGNED_URL_MARKER}`;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "url-job" } }));
      return;
    }
    if (request.url === "/jobs/url-job") {
      queries += 1;
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: signedUrl } },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const result = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(result.outcome).toBe("incomplete");
  if (result.outcome !== "incomplete") throw new Error("disallowed URL was accepted");
  expect(result.task.phase).toBe("querying");
  expect(result.task.diagnostic?.code).toBe("baidu-result-url-invalid");
  expect(queries).toBe(1);
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER, "example.invalid");
});

test("pdf-import 完成状态的损坏结果信封保持可恢复诊断", async () => {
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "envelope-job" } }));
      return;
    }
    if (request.url === "/jobs/envelope-job") {
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: null },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const result = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
  });
  expect(result.outcome).toBe("incomplete");
  if (result.outcome !== "incomplete") throw new Error("invalid envelope unexpectedly succeeded");
  expect(result.task.phase).toBe("querying");
  expect(result.task.diagnostic?.code).toBe("baidu-query-response-invalid");
});

test("pdf-import 恢复配置或 PDF 摘要变化时拒绝混合任务且不新增 POST", async () => {
  let posts = 0;
  let queries = 0;
  const endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "guard-job" } }));
      return;
    }
    if (request.url === "/jobs/guard-job") {
      queries += 1;
      response.end(JSON.stringify({ code: 0, data: { state: "running" } }));
      return;
    }
    response.writeHead(404).end();
  });
  const waiting = await startBaiduPdfParse({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
    timing: { queryWaitMs: 0 },
  });
  expect(waiting.outcome).toBe("incomplete");
  if (waiting.outcome !== "incomplete") throw new Error("running task unexpectedly succeeded");
  await expect(resumeBaiduPdfParse({
    root,
    parseBatchId: waiting.task.parseBatchId,
    config: config(`${endpoint}-changed`),
  })).rejects.toThrow("原 endpoint");
  expect(posts).toBe(1);
  expect(queries).toBe(1);

  await fs.writeFile(path.join(root, "sources", sourceSnapshotId, "paper.pdf"), "changed");
  await expect(resumeBaiduPdfParse({
    root,
    parseBatchId: waiting.task.parseBatchId,
    config: config(endpoint),
  })).rejects.toThrow(/摘要|完整性/);
  expect(posts).toBe(1);
  expect(queries).toBe(1);
});
