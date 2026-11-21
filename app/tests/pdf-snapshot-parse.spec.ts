import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { createProject, listSourceSnapshots } from "../src/main/project-core";
import { snapshotLocalPdf } from "../src/main/pdf/snapshot";
import {
  listBaiduPdfParseTasks,
  resumeBaiduPdfParse,
  startBaiduPdfParse,
  type BaiduPdfParseConfig,
} from "../src/main/parsing/baidu-task";
import { MISSING_ASSET_PLACEHOLDER, publishParseSnapshot } from "../src/main/parsing/parse-snapshot";
import type { PdfParseSourceSnapshotRecord } from "../src/shared/contracts";
import type { PdfParseFactsFile, PdfParseTaskRecord } from "../src/shared/parsing";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const TOKEN = "test-baidu-token-never-persist";
const SIGNED_URL_MARKER = "signature-never-persist";
const MODEL = "PaddleOCR-VL-1.6" as const;
const ASSET_LIMIT = 32 * 1024 * 1024;

type AssetHandler = (request: IncomingMessage, response: ServerResponse, endpoint: string) => void | Promise<void>;

let sandbox: string;
let root: string;
let sourceSnapshotId: string;
let servers: Server[];

async function drain(request: IncomingMessage) {
  for await (const _chunk of request) {
    // Consume controlled multipart fixtures before sending the receipt.
  }
}

async function controlledServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
    for (const secret of secrets) expect(bytes.includes(secret), `${path.basename(file)} leaked a secret`).toBe(false);
  }
}

function pngBytes(width = 2, height = 2): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image);
}

/** 最小结构完整 JPEG：SOI + SOF0 + DHT + SOS + 扫描数据 + EOI。 */
function jpegBytes(width = 8, height = 8, extra?: Buffer): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(11, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 1;
  sof[8] = 1;
  sof[9] = 0x11;
  sof[10] = 0;
  const dht = Buffer.from([
    0x00, 0x1a, 0x00, 0, 1, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
  ]);
  const sos = Buffer.from([0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xc0, sof),
    segment(0xc4, dht),
    segment(0xda, sos),
    extra ?? Buffer.from([0x12, 0x34]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function block(id: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    block_label: "text",
    block_content: content,
    block_bbox: [10 * (id + 1), 20, 100 + 10 * id, 60],
    block_id: id,
    block_order: id,
    group_id: id,
    ...extra,
  };
}

function vendorPage(blocks: ReturnType<typeof block>[], markdown?: Record<string, unknown>) {
  return {
    prunedResult: {
      width: 1191,
      height: 1684,
      model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
      parsing_res_list: blocks,
    },
    ...(markdown === undefined ? {} : { markdown }),
  };
}

function row(pages: ReturnType<typeof vendorPage>[]) {
  return {
    result: {
      dataInfo: {
        type: "pdf",
        numPages: pages.length,
        pages: pages.map((page) => ({
          width: page.prunedResult.width,
          height: page.prunedResult.height,
        })),
      },
      layoutParsingResults: pages,
    },
  };
}

function jsonl(rows: unknown[]): Buffer {
  return Buffer.from(rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

function twoPages(): Buffer {
  return jsonl([
    row([
      vendorPage([block(0, "First page paragraph"), block(1, "Figure 1: caption")]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]);
}

interface DownloadFixture {
  endpoint: string;
  task: PdfParseTaskRecord;
  response: { bytes: Uint8Array; sha256: string };
  counts: { posts: number; queries: number; downloads: number };
}

/** 经受控百度服务走完整提交→查询→下载链路，取得内存中的原始响应。 */
async function downloadResponse(
  buildRaw: (endpoint: string) => Buffer,
  assetHandler?: AssetHandler,
): Promise<DownloadFixture> {
  const counts = { posts: 0, queries: 0, downloads: 0 };
  let endpoint = "";
  endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      counts.posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "job-parse" } }));
      return;
    }
    if (request.url === "/jobs/job-parse") {
      counts.queries += 1;
      response.end(
        JSON.stringify({
          code: 0,
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
        }),
      );
      return;
    }
    if (request.url === "/jobs/result") {
      counts.downloads += 1;
      response.end(buildRaw(endpoint));
      return;
    }
    if (assetHandler) {
      await assetHandler(request, response, endpoint);
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
  expect(started.outcome).toBe("downloaded");
  if (started.outcome !== "downloaded") throw new Error("controlled download did not finish");
  return { endpoint, task: started.task, response: started.response, counts };
}

async function parseSnapshots() {
  return (await listSourceSnapshots(root)).filter(
    (snapshot) => snapshot.kind === "pdf-parse",
  ) as PdfParseSourceSnapshotRecord[];
}

async function readSnapshotFile(snapshot: PdfParseSourceSnapshotRecord, relative: string) {
  return fs.readFile(path.join(root, snapshot.path, relative));
}

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-parse-snapshot-"));
  servers = [];
  const project = await createProject({ parent: sandbox, name: "解析工程" });
  root = project.root;
  const snapshot = await snapshotLocalPdf({ root, source: SAMPLE });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  sourceSnapshotId = snapshot.snapshot.sourceSnapshotId;
});

test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("pdf-import 签名资源与内联图片本地化，含密原始响应不进入工程", async () => {
  const image = pngBytes();
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First page paragraph")], {
            images: { "imgs/fig.png": `${endpoint}/asset?${SIGNED_URL_MARKER}` },
          }),
          vendorPage([block(0, "Second page text")], {
            images: { "imgs/inline.png": image.toString("base64") },
          }),
        ]),
      ]),
    async (request, response) => {
      expect(request.url).toBe(`/jobs/asset?${SIGNED_URL_MARKER}`);
      response.end(image);
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("localization failed");
  const { snapshot } = result;
  expect(snapshot.kind).toBe("pdf-parse");
  expect(snapshot.parentSourceSnapshotId).toBe(sourceSnapshotId);
  expect(snapshot.parseBatchId).toBe(fixture.task.parseBatchId);
  expect(snapshot.jobId).toBe("job-parse");
  expect(snapshot.pageCount).toBe(2);
  expect(snapshot.responseSha256).toBe(fixture.response.sha256);
  expect(snapshot.sanitization).toEqual({ replaced: 2, missing: 0, dropped: 0 });

  const managed = await readSnapshotFile(snapshot, "result.jsonl");
  expect(snapshot.sanitizedSha256).toBe(sha256(managed));
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const expectedRef = `assets/${sha256(image)}.png`;
  expect(rows[0].result.layoutParsingResults[0].markdown.images).toEqual({ "imgs/fig.png": expectedRef });
  expect(rows[0].result.layoutParsingResults[1].markdown.images).toEqual({ "imgs/inline.png": expectedRef });
  expect((await readSnapshotFile(snapshot, expectedRef)).equals(image)).toBe(true);

  const facts = JSON.parse((await readSnapshotFile(snapshot, "facts.json")).toString("utf8")) as PdfParseFactsFile;
  expect(facts.pageCount).toBe(2);
  expect(facts.pages[0].assets).toEqual([
    { vendorPath: "imgs/fig.png", path: expectedRef, sha256: sha256(image), size: image.length, mime: "image/png" },
  ]);
  expect(result.task.parseSourceSnapshotId).toBe(snapshot.sourceSnapshotId);
  expect(result.task.sanitizedSha256).toBe(snapshot.sanitizedSha256);
  expect(result.task.phase).toBe("downloaded");
  const [persisted] = await listBaiduPdfParseTasks(root);
  expect(persisted.parseSourceSnapshotId).toBe(snapshot.sourceSnapshotId);
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import data URI 图片被提取为内容寻址资产", async () => {
  const image = pngBytes(3, 2);
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, "First")], {
          images: { "imgs/fig.png": `data:image/png;base64,${image.toString("base64")}` },
        }),
        vendorPage([block(0, "Second")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("data URI localization failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].markdown.images["imgs/fig.png"]).toBe(`assets/${sha256(image)}.png`);
  expect(result.snapshot.sanitization.replaced).toBe(1);
});

test("pdf-import 去敏不改变正文、页块顺序与几何事实", async () => {
  const raw = jsonl([
    row([
      vendorPage([
        block(0, "Page one text", { block_order: null }),
        block(1, "More text", { block_bbox: [5, 6, 70, 80] }),
      ]),
    ]),
    row([vendorPage([block(0, "Page two text", { group_id: 7 })])]),
  ]);
  const fixture = await downloadResponse(() => raw);
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("preservation publish failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const sanitized = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const original = raw
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(sanitized).toHaveLength(original.length);
  for (const [index, originalRow] of original.entries()) {
    expect(sanitized[index].result.dataInfo).toEqual(originalRow.result.dataInfo);
    const originalPages = originalRow.result.layoutParsingResults;
    const sanitizedPages = sanitized[index].result.layoutParsingResults;
    expect(sanitizedPages).toHaveLength(originalPages.length);
    for (const [pageIndex, originalPage] of originalPages.entries()) {
      expect(sanitizedPages[pageIndex].prunedResult.parsing_res_list).toEqual(
        originalPage.prunedResult.parsing_res_list,
      );
      expect(sanitizedPages[pageIndex].prunedResult.width).toBe(originalPage.prunedResult.width);
      expect(sanitizedPages[pageIndex].prunedResult.height).toBe(originalPage.prunedResult.height);
      expect(sanitizedPages[pageIndex].prunedResult.model_settings).toEqual(originalPage.prunedResult.model_settings);
    }
  }
  const facts = JSON.parse(
    (await readSnapshotFile(result.snapshot, "facts.json")).toString("utf8"),
  ) as PdfParseFactsFile;
  expect(facts.pages.map((page) => page.page)).toEqual([1, 2]);
  expect(facts.pages[0].blocks).toEqual([
    { blockId: 0, label: "text", order: null, groupId: 0, bbox: [10, 20, 100, 60] },
    { blockId: 1, label: "text", order: 1, groupId: 1, bbox: [5, 6, 70, 80] },
  ]);
  expect(facts.pages[1].blocks[0].groupId).toBe(7);
  expect(facts.pages[0].width).toBe(1191);
  expect(facts.pages[0].height).toBe(1684);
});

async function expectResourceRejected(value: unknown, code: string, ...secrets: string[]) {
  let assetHits = 0;
  const fixture = await downloadResponse(
    () =>
      jsonl([
        row([
          vendorPage([block(0, "First page")], { images: { "imgs/fig.png": value } }),
          vendorPage([block(0, "Second page")]),
        ]),
      ]),
    async (_request, response) => {
      assetHits += 1;
      response.end(pngBytes());
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("dangerous resource was accepted");
  expect(result.diagnostic.code).toBe(code);
  expect(assetHits).toBe(0);
  expect(await parseSnapshots()).toEqual([]);
  const [persisted] = await listBaiduPdfParseTasks(root);
  expect(persisted.phase).toBe("downloaded");
  expect(persisted.diagnostic?.code).toBe(code);
  expect(persisted.parseSourceSnapshotId).toBeUndefined();
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER, ...secrets);
}

test("pdf-import 非允许 host 的资源地址被拒绝且不发起访问", async () => {
  await expectResourceRejected(
    `https://evil.example/img.png?${SIGNED_URL_MARKER}`,
    "parse-resource-url-rejected",
    "evil.example",
  );
});

test("pdf-import 含凭据或 fragment 的资源地址被拒绝", async () => {
  await expectResourceRejected(
    "https://user:pass@paddleocr.aistudio-app.com/img.png",
    "parse-resource-url-rejected",
    "user:pass",
  );
});

test("pdf-import fragment 资源地址被拒绝", async () => {
  await expectResourceRejected("https://paddleocr.aistudio-app.com/img.png#fragment", "parse-resource-url-rejected");
});

test("pdf-import 危险 scheme 的 javascript 与 data 文本资源被拒绝", async () => {
  await expectResourceRejected("javascript:alert(1)", "parse-resource-url-rejected");
});

test("pdf-import data 文本内联资源被拒绝", async () => {
  await expectResourceRejected(
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "parse-resource-url-rejected",
  );
});

test("pdf-import 资源重定向被拒绝且不跟随", async () => {
  let assetHits = 0;
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First")], { images: { "imgs/fig.png": `${endpoint}/redirect` } }),
          vendorPage([block(0, "Second")]),
        ]),
      ]),
    async (_request, response, endpoint) => {
      assetHits += 1;
      response.writeHead(302, { location: `${endpoint}/elsewhere` });
      response.end();
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("redirect was accepted");
  expect(result.diagnostic.code).toBe("parse-resource-redirect-rejected");
  expect(assetHits).toBe(1);
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 无法取得的资源写成去敏占位与 warning", async () => {
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First")], { images: { "imgs/fig.png": `${endpoint}/missing` } }),
          vendorPage([block(0, "Second")]),
        ]),
      ]),
    async (_request, response) => {
      response.writeHead(500).end();
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("missing asset blocked publication");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].markdown.images["imgs/fig.png"]).toBe(MISSING_ASSET_PLACEHOLDER);
  expect(result.snapshot.sanitization).toEqual({ replaced: 0, missing: 1, dropped: 0 });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "parse-asset-missing",
      severity: "warning",
      sourceAlias: "page-1/imgs/fig.png",
    }),
  ]);
  expect(result.snapshot.diagnostics).toEqual(result.diagnostics);
  await expectProjectDoesNotContain(SIGNED_URL_MARKER);
});

test("pdf-import 网络中断的资源写成占位 warning 而非致命失败", async () => {
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First")], { images: { "imgs/fig.png": `${endpoint}/broken` } }),
          vendorPage([block(0, "Second")]),
        ]),
      ]),
    async (_request, response) => {
      response.destroy();
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("network failure blocked publication");
  expect(result.snapshot.sanitization.missing).toBe(1);
  expect(result.diagnostics[0].code).toBe("parse-asset-missing");
});

test("pdf-import 损坏或不受支持的图片字节降级为占位 warning", async () => {
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First")], { images: { "imgs/fig.png": `${endpoint}/garbage` } }),
          vendorPage([block(0, "Second")]),
        ]),
      ]),
    async (_request, response) => {
      response.end(Buffer.from("this is not an image"));
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("corrupt image blocked publication");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].markdown.images["imgs/fig.png"]).toBe(MISSING_ASSET_PLACEHOLDER);
  expect(result.diagnostics[0].code).toBe("parse-asset-missing");
});

test("pdf-import 无法证明安全的非字符串资源值不原样持久化", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([
      row([vendorPage([block(0, "First")], { images: { "imgs/fig.png": 42 } }), vendorPage([block(0, "Second")])]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unprovable value blocked publication");
  expect(result.snapshot.sanitization.missing).toBe(1);
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  expect(managed.toString("utf8")).not.toContain("42");
});

test("pdf-import 单资产声明大小超预算拒绝", async () => {
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First")], { images: { "imgs/big.png": `${endpoint}/big` } }),
          vendorPage([block(0, "Second")]),
        ]),
      ]),
    async (_request, response) => {
      response.writeHead(200, { "content-length": String(ASSET_LIMIT + 1) });
      response.end();
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized declared asset was accepted");
  expect(result.diagnostic.code).toBe("parse-asset-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 单资产实际字节超预算拒绝", async () => {
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, "First")], { images: { "imgs/big.png": `${endpoint}/big` } }),
          vendorPage([block(0, "Second")]),
        ]),
      ]),
    async (_request, response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.end(Buffer.alloc(ASSET_LIMIT + 1, 0x61));
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized streamed asset was accepted");
  expect(result.diagnostic.code).toBe("parse-asset-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 快照资产合计超预算拒绝", async () => {
  // 结构完整的大 JPEG：SOF 声明 8x8 像素，SOS 之前插入多个受控 APP1 段填充。
  const jpegHead = jpegBytes();
  const sosIndex = jpegHead.length - 14;
  const head = jpegHead.subarray(0, sosIndex);
  const tail = jpegHead.subarray(sosIndex);
  const fillers: Buffer[] = [];
  let remaining = ASSET_LIMIT - 65_536 - jpegHead.length;
  while (remaining > 0) {
    const segmentBytes = Math.min(remaining, 65_530);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(segmentBytes, 0);
    fillers.push(Buffer.from([0xff, 0xe1]), length, Buffer.alloc(segmentBytes - 2, 0x61));
    remaining -= segmentBytes;
  }
  let served = 0;
  const fixture = await downloadResponse(
    (endpoint) => {
      const images: Record<string, string> = {};
      for (let index = 0; index < 9; index += 1) images[`imgs/a${index}.jpg`] = `${endpoint}/a${index}`;
      return jsonl([row([vendorPage([block(0, "First")], { images }), vendorPage([block(0, "Second")])])]);
    },
    async (_request, response) => {
      tail[tail.length - 4] = served;
      served += 1;
      const body = Buffer.concat([head, ...fillers, tail]);
      response.writeHead(200, { "transfer-encoding": "chunked" });
      for (let offset = 0; offset < body.length; offset += 16_384) {
        const piece = body.subarray(offset, offset + 16_384);
        if (!response.write(piece)) {
          const { promise, resolve } = Promise.withResolvers<void>();
          response.once("drain", resolve);
          await promise;
        }
      }
      response.end();
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized asset total was accepted");
  expect(result.diagnostic.code).toBe("parse-asset-budget-exceeded");
  expect(served).toBe(9);
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 超像素 PNG 在解码前拒绝", async () => {
  const fake = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fake, 0);
  fake.writeUInt32BE(13, 8);
  fake.write("IHDR", 12, "ascii");
  fake.writeUInt32BE(5000, 16);
  fake.writeUInt32BE(4000, 20);
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, "First")], { images: { "imgs/huge.png": fake.toString("base64") } }),
        vendorPage([block(0, "Second")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized pixel PNG was accepted");
  expect(result.diagnostic.code).toBe("parse-asset-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 单页超块预算拒绝", async () => {
  const blocks = Array.from({ length: 10_001 }, (_, index) => block(index, `b${index}`));
  const fixture = await downloadResponse(() => jsonl([row([vendorPage(blocks), vendorPage([block(0, "Second")])])]));
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized block list was accepted");
  expect(result.diagnostic.code).toBe("parse-block-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 页数与 PDF 快照不符拒绝", async () => {
  const fixture = await downloadResponse(() => jsonl([row([vendorPage([block(0, "Only page")])])]));
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("page count mismatch was accepted");
  expect(result.diagnostic.code).toBe("parse-page-count-mismatch");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 重复非空页拒绝", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([row([vendorPage([block(0, "Same content")]), vendorPage([block(0, "Same content")])])]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("duplicate page was accepted");
  expect(result.diagnostic.code).toBe("parse-page-duplicate");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 非法块阅读顺序拒绝", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([row([vendorPage([block(0, "A"), block(1, "B", { block_order: 0 })]), vendorPage([block(0, "Second")])])]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("invalid block order was accepted");
  expect(result.diagnostic.code).toBe("parse-block-invalid");
});

test("pdf-import 重复块身份拒绝", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([row([vendorPage([block(0, "A"), block(0, "B", { block_order: 1 })]), vendorPage([block(0, "Second")])])]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("duplicate block id was accepted");
  expect(result.diagnostic.code).toBe("parse-block-invalid");
});

test("pdf-import 无效 JSONL 与错误码响应拒绝", async () => {
  const fixture = await downloadResponse(() => Buffer.from("this is not jsonl\n"));
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("invalid JSONL was accepted");
  expect(result.diagnostic.code).toBe("parse-response-invalid");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import 非零错误码批次拒绝", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([{ errorCode: 500, ...row([vendorPage([block(0, "A")]), vendorPage([block(0, "B")])]) }]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("error-coded batch was accepted");
  expect(result.diagnostic.code).toBe("parse-response-invalid");
});

test("pdf-import 响应摘要不符保留现场不发布", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const result = await publishParseSnapshot({
    root,
    task: fixture.task,
    response: { bytes: fixture.response.bytes, sha256: "0".repeat(64) },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("digest mismatch was accepted");
  expect(result.diagnostic.code).toBe("parse-response-digest-mismatch");
  expect(await parseSnapshots()).toEqual([]);
  const [persisted] = await listBaiduPdfParseTasks(root);
  expect(persisted.responseSha256).toBe(fixture.response.sha256);
});

test("pdf-import 未知字段与 markdown.text 不持久化并记录去敏原因", async () => {
  const fixture = await downloadResponse((endpoint) => {
    const first = vendorPage([block(0, "First", { secretExtra: `https://cdn.example/x?${SIGNED_URL_MARKER}` })], {
      text: `![img](${endpoint}/asset?${SIGNED_URL_MARKER})`,
      images: { "imgs/fig.png": pngBytes().toString("base64") },
    });
    return jsonl([{ extraTop: SIGNED_URL_MARKER, ...row([first, vendorPage([block(0, "Second")])]) }]);
  });
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("dropped-field publish failed");
  expect(result.snapshot.sanitization.dropped).toBeGreaterThanOrEqual(3);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "parse-response-fields-dropped", severity: "warning" })]),
  );
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].markdown).toEqual({
    images: { "imgs/fig.png": `assets/${sha256(pngBytes())}.png` },
  });
  expect(rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list[0]).not.toHaveProperty("secretExtra");
  expect(rows[0]).not.toHaveProperty("extraTop");
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import 空页保留页级 warning 不阻断发布", async () => {
  const fixture = await downloadResponse(() => jsonl([row([vendorPage([block(0, "First")]), vendorPage([])])]));
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("empty page blocked publication");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "parse-page-empty", severity: "warning", sourceAlias: "page-2" }),
    ]),
  );
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[1].prunedResult.parsing_res_list).toEqual([]);
});

test("pdf-import 恢复复用已去敏快照，不重复查询或下载", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const published = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(published.ok).toBe(true);
  if (!published.ok) throw new Error("publish failed");
  const before = { ...fixture.counts };
  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: fixture.task.parseBatchId,
    config: config(fixture.endpoint),
  });
  expect(resumed.outcome).toBe("sanitized");
  if (resumed.outcome !== "sanitized") throw new Error("resume did not reuse snapshot");
  expect(resumed.snapshot.sourceSnapshotId).toBe(published.snapshot.sourceSnapshotId);
  expect(resumed.task.parseSourceSnapshotId).toBe(published.snapshot.sourceSnapshotId);
  expect(fixture.counts).toEqual(before);
});

test("pdf-import 发布后崩溃丢失任务关联，恢复按批次找回快照", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const published = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(published.ok).toBe(true);
  if (!published.ok) throw new Error("publish failed");
  const [persisted] = await listBaiduPdfParseTasks(root);
  const { parseSourceSnapshotId: _id, sanitizedSha256: _digest, ...crashed } = persisted;
  const taskFile = path.join(root, ".paper30min", "parsing", fixture.task.parseBatchId, "task.json");
  await fs.writeFile(taskFile, JSON.stringify(crashed, null, 2) + "\n");
  const before = { ...fixture.counts };
  const resumed = await resumeBaiduPdfParse({
    root,
    parseBatchId: fixture.task.parseBatchId,
    config: config(fixture.endpoint),
  });
  expect(resumed.outcome).toBe("sanitized");
  if (resumed.outcome !== "sanitized") throw new Error("crash recovery did not find snapshot");
  expect(resumed.snapshot.sourceSnapshotId).toBe(published.snapshot.sourceSnapshotId);
  expect(fixture.counts).toEqual(before);
  const [relinked] = await listBaiduPdfParseTasks(root);
  expect(relinked.parseSourceSnapshotId).toBe(published.snapshot.sourceSnapshotId);
});

test("pdf-import 重复发布同批次复用同一快照", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const first = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("first publish failed");
  const second = await publishParseSnapshot({ root, task: first.task, response: fixture.response });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("second publish failed");
  expect(second.snapshot.sourceSnapshotId).toBe(first.snapshot.sourceSnapshotId);
  expect(await parseSnapshots()).toHaveLength(1);
});

test("pdf-import 停止信号中断去敏，不发布快照也不记失败诊断", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const controller = new AbortController();
  controller.abort();
  const result = await publishParseSnapshot({
    root,
    task: fixture.task,
    response: fixture.response,
    signal: controller.signal,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("aborted publish succeeded");
  expect(result.diagnostic.code).toBe("parse-stopped");
  expect(await parseSnapshots()).toEqual([]);
  const [persisted] = await listBaiduPdfParseTasks(root);
  expect(persisted.phase).toBe("downloaded");
  expect(persisted.diagnostic).toBeUndefined();
});

test("pdf-import 表格 HTML 内签名 URL 被本地化，签名不进入工程", async () => {
  const image = pngBytes();
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([
            block(0, `<table><tr><td><img src="${endpoint}/asset?${SIGNED_URL_MARKER}" alt="图"></td></tr></table>`, {
              block_label: "table",
            }),
          ]),
          vendorPage([block(0, "Second page text")]),
        ]),
      ]),
    async (request, response) => {
      expect(request.url).toBe(`/jobs/asset?${SIGNED_URL_MARKER}`);
      response.end(image);
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("table HTML localization failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const content = rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list[0].block_content as string;
  expect(content).toContain(`src="assets/${sha256(image)}.png"`);
  expect(content).not.toContain(SIGNED_URL_MARKER);
  expect(result.snapshot.sanitization.replaced).toBe(1);
  const facts = JSON.parse(
    (await readSnapshotFile(result.snapshot, "facts.json")).toString("utf8"),
  ) as PdfParseFactsFile;
  expect(facts.pages[0].assets).toEqual([
    expect.objectContaining({ path: `assets/${sha256(image)}.png`, sha256: sha256(image) }),
  ]);
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import 正文 HTML 内 data URI 提取为资产，原始 base64 不落盘", async () => {
  const image = pngBytes(3, 3);
  const base64 = image.toString("base64");
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, `<p>前文<img src="data:image/png;base64,${base64}">后文</p>`)]),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("inline HTML localization failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const content = rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list[0].block_content as string;
  expect(content).toContain(`src="assets/${sha256(image)}.png"`);
  expect(managed.includes(base64)).toBe(false);
  expect((await readSnapshotFile(result.snapshot, `assets/${sha256(image)}.png`)).equals(image)).toBe(true);
  await expectProjectDoesNotContain(TOKEN);
});

test("pdf-import 正文 HTML 引用已知 manifest 资源时精确替换，不重复下载", async () => {
  const image = pngBytes();
  let assetHits = 0;
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage(
            [
              block(0, `<table><tr><td><img src="${endpoint}/asset?${SIGNED_URL_MARKER}"></td></tr></table>`, {
                block_label: "table",
              }),
            ],
            {
              images: { "imgs/fig.png": `${endpoint}/asset?${SIGNED_URL_MARKER}` },
            },
          ),
          vendorPage([block(0, "Second page text")]),
        ]),
      ]),
    async (_request, response) => {
      assetHits += 1;
      response.end(image);
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("manifest reuse failed");
  expect(assetHits).toBe(1);
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const page = rows[0].result.layoutParsingResults[0];
  expect(page.prunedResult.parsing_res_list[0].block_content).toContain(`src="assets/${sha256(image)}.png"`);
  expect(page.markdown.images["imgs/fig.png"]).toBe(`assets/${sha256(image)}.png`);
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import 正文 HTML 无法取得的资源写占位 warning，签名不落盘", async () => {
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, `<p><img src="${endpoint}/gone?${SIGNED_URL_MARKER}"></p>`)]),
          vendorPage([block(0, "Second page text")]),
        ]),
      ]),
    async (_request, response) => {
      response.writeHead(500).end();
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("missing HTML resource blocked publication");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list[0].block_content).toContain(
    `src="${MISSING_ASSET_PLACEHOLDER}"`,
  );
  expect(result.snapshot.sanitization.missing).toBe(1);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "parse-asset-missing", severity: "warning" })]),
  );
  await expectProjectDoesNotContain(SIGNED_URL_MARKER);
});

test("pdf-import 正文 HTML 危险 scheme 资源拒绝发布，不原样落盘", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, '<p><img src="javascript:alert(1)"></p>')]),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("dangerous HTML resource was accepted");
  expect(result.diagnostic.code).toBe("parse-resource-url-rejected");
  expect(await parseSnapshots()).toEqual([]);
  await expectProjectDoesNotContain("javascript:alert");
});

test("pdf-import 同文字不同图片的页面可发布", async () => {
  const first = pngBytes(2, 2);
  const second = pngBytes(3, 3);
  const distinct = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, "Same caption")], { images: { "imgs/a.png": first.toString("base64") } }),
        vendorPage([block(0, "Same caption")], { images: { "imgs/a.png": second.toString("base64") } }),
      ]),
    ]),
  );
  const published = await publishParseSnapshot({ root, task: distinct.task, response: distinct.response });
  expect(published.ok).toBe(true);
});

test("pdf-import 同几何同块身份但文字不同的两页可发布", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([row([vendorPage([block(0, "First distinct text")]), vendorPage([block(0, "Second distinct text")])])]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("distinct text pages were rejected");
  expect(result.snapshot.pageCount).toBe(2);
});

test("pdf-import 重复纯视觉页拒绝", async () => {
  const visualFixture = await downloadResponse(() =>
    jsonl([
      row([vendorPage([block(0, "", { block_label: "image" })]), vendorPage([block(0, "", { block_label: "image" })])]),
    ]),
  );
  const rejected = await publishParseSnapshot({
    root,
    task: visualFixture.task,
    response: visualFixture.response,
  });
  expect(rejected.ok).toBe(false);
  if (rejected.ok) throw new Error("duplicate visual page was accepted");
  expect(rejected.diagnostic.code).toBe("parse-page-duplicate");
});

test("pdf-import 受管 result.jsonl 超注入预算时拒绝，不发布部分快照", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const result = await publishParseSnapshot({
    root,
    task: fixture.task,
    response: fixture.response,
    budgets: { managedResultBytes: 64 },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized managed result was accepted");
  expect(result.diagnostic.code).toBe("parse-response-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import facts.json 超注入预算时拒绝发布", async () => {
  const fixture = await downloadResponse(() => twoPages());
  const result = await publishParseSnapshot({
    root,
    task: fixture.task,
    response: fixture.response,
    budgets: { factsBytes: 16 },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized facts was accepted");
  expect(result.diagnostic.code).toBe("parse-response-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import JPEG 首尾标记合法但中间损坏时降级为占位 warning", async () => {
  const broken = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04]),
    Buffer.alloc(32, 0x61),
    Buffer.from([0xff, 0xd9]),
  ]);
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, "First")], { images: { "imgs/broken.jpg": broken.toString("base64") } }),
        vendorPage([block(0, "Second")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("corrupt JPEG blocked publication");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].markdown.images["imgs/broken.jpg"]).toBe(MISSING_ASSET_PLACEHOLDER);
  expect(result.diagnostics[0].code).toBe("parse-asset-missing");
});

test("pdf-import 结构完整 JPEG 被接受为内容寻址资产", async () => {
  const jpeg = jpegBytes();
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, "First")], { images: { "imgs/photo.jpg": jpeg.toString("base64") } }),
        vendorPage([block(0, "Second")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("valid JPEG was rejected");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[0].result.layoutParsingResults[0].markdown.images["imgs/photo.jpg"]).toBe(`assets/${sha256(jpeg)}.jpg`);
  expect((await readSnapshotFile(result.snapshot, `assets/${sha256(jpeg)}.jpg`)).equals(jpeg)).toBe(true);
});

test("pdf-import JPEG 超大声明尺寸在解码前拒绝", async () => {
  const huge = jpegBytes(8000, 4000);
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, "First")], { images: { "imgs/huge.jpg": huge.toString("base64") } }),
        vendorPage([block(0, "Second")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("oversized JPEG was accepted");
  expect(result.diagnostic.code).toBe("parse-asset-budget-exceeded");
  expect(await parseSnapshots()).toEqual([]);
});

test("pdf-import prunedResult 未知字段计入 dropped 并不持久化", async () => {
  const fixture = await downloadResponse((endpoint) => {
    const page = vendorPage([block(0, "First")]);
    (page.prunedResult as Record<string, unknown>).layout_extra = `${endpoint}/x?${SIGNED_URL_MARKER}`;
    return jsonl([row([page, vendorPage([block(0, "Second")])])]);
  });
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("dropped pruned field publish failed");
  expect(result.snapshot.sanitization.dropped).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "parse-response-fields-dropped", severity: "warning" })]),
  );
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  expect(managed.includes("layout_extra")).toBe(false);
  await expectProjectDoesNotContain(SIGNED_URL_MARKER);
});

async function expectUnsafeBlockRejected(tag: string, unsafe: string) {
  const fixture = await downloadResponse(() =>
    jsonl([row([vendorPage([block(0, unsafe)]), vendorPage([block(0, "Second page text")])])]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`${tag} block was accepted`);
  expect(result.diagnostic.code).toBe("parse-resource-url-rejected");
  expect(await parseSnapshots()).toEqual([]);
  await expectProjectDoesNotContain(SIGNED_URL_MARKER);
}

for (const [tag, unsafe] of [
  ["template", `<template><img src="https://evil.example/x.png?${SIGNED_URL_MARKER}"></template>`],
  ["noscript", `<noscript><img src="https://evil.example/x.png?${SIGNED_URL_MARKER}"></noscript>`],
  ["script", `<script>var u="https://evil.example/x.png?${SIGNED_URL_MARKER}"</script>`],
  ["style", `<style>a{background:url(https://evil.example/x.png?${SIGNED_URL_MARKER})}</style>`],
] as const) {
  test(`pdf-import 正文危险标签 ${tag} 独立拒绝发布`, () => expectUnsafeBlockRejected(tag, unsafe));
}

test("pdf-import 表格单元格内 template 资源同样拒绝发布，签名不进入快照", async () => {
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([
          block(
            0,
            `<table><tr><td><template><img src="https://evil.example/x.png?${SIGNED_URL_MARKER}"></template>safe</td></tr></table>`,
            { block_label: "table" },
          ),
        ]),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("table template resource was accepted");
  expect(result.diagnostic.code).toBe("parse-resource-url-rejected");
  expect(await parseSnapshots()).toEqual([]);
  await expectProjectDoesNotContain(SIGNED_URL_MARKER);
});

test("pdf-import markdown 图片引用的签名 URL 被本地化，签名不进入工程", async () => {
  const image = pngBytes();
  const fixture = await downloadResponse(
    (endpoint) =>
      jsonl([
        row([
          vendorPage([block(0, `前文 ![图](${endpoint}/asset?${SIGNED_URL_MARKER}) 后文`)]),
          vendorPage([block(0, "Second page text")]),
        ]),
      ]),
    async (request, response) => {
      expect(request.url).toBe(`/jobs/asset?${SIGNED_URL_MARKER}`);
      response.end(image);
    },
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("markdown image localization failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const content = rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list[0].block_content as string;
  expect(content).toContain(`![图](assets/${sha256(image)}.png)`);
  expect(content).toContain("前文");
  expect(content).toContain("后文");
  expect(content).not.toContain(SIGNED_URL_MARKER);
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import 含 HTML 样字符的普通正文逐字保留，不被重序列化吞字或转义", async () => {
  const tricky = "x<y and z>w";
  const ampersand = 'A & B <span class="x">ok</span>';
  const tagLike = "<script-foo>safe</script-foo> <style-guide>x</style-guide>";
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, tricky), block(1, ampersand), block(2, tagLike)]),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("plain text publish failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const blocks = rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list;
  expect(blocks[0].block_content).toBe(tricky);
  expect(blocks[1].block_content).toBe(ampersand);
  expect(blocks[2].block_content).toBe(tagLike);
});

test("pdf-import 非表格正文内联资源只做定点替换，其余文字逐字保留", async () => {
  const image = pngBytes(3, 3);
  const base64 = image.toString("base64");
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, `x<y and z>w <img src="data:image/png;base64,${base64}"> tail & more`)]),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("inline resource publish failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const content = rows[0].result.layoutParsingResults[0].prunedResult.parsing_res_list[0].block_content as string;
  expect(content).toContain("x<y and z>w");
  expect(content).toContain("tail & more");
  expect(content).toContain(`src="assets/${sha256(image)}.png"`);
  expect(content).not.toContain(base64);
});

test("pdf-import 无 markdown 页的块内联资源持久化 alias，快照可转换", async () => {
  const image = pngBytes(3, 3);
  const base64 = image.toString("base64");
  const fixture = await downloadResponse(() =>
    jsonl([
      row([
        vendorPage([block(0, `<p>内联<img src="data:image/png;base64,${base64}"></p>`)]),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
  );
  const result = await publishParseSnapshot({ root, task: fixture.task, response: fixture.response });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("inline alias publish failed");
  const managed = await readSnapshotFile(result.snapshot, "result.jsonl");
  const rows = managed
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const page = rows[0].result.layoutParsingResults[0];
  // 无原始 markdown 的页也必须落 markdown.images，alias 与 facts 一致。
  expect(page.markdown).toBeTruthy();
  const facts = JSON.parse(
    (await readSnapshotFile(result.snapshot, "facts.json")).toString("utf8"),
  ) as PdfParseFactsFile;
  const expectedPath = `assets/${sha256(image)}.png`;
  expect(facts.pages[0].assets).toHaveLength(1);
  expect(page.markdown.images).toEqual({ "block-0/resource-1": expectedPath });
  for (const asset of facts.pages[0].assets) {
    expect(asset.path).toBe(expectedPath);
    expect(page.markdown.images[asset.vendorPath]).toBe(asset.path);
    expect((await readSnapshotFile(result.snapshot, asset.path)).equals(image)).toBe(true);
  }
});
