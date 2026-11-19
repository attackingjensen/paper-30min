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
import { PNG } from "pngjs";
import {
  commitRevision,
  createProject,
  listSourceSnapshots,
  openProject,
  readRevision,
  readRevisionAsset,
  readRevisionDocument,
  readRevisionTombstones,
} from "../src/main/project-core";
import { snapshotLocalPdf } from "../src/main/pdf/snapshot";
import {
  listBaiduPdfParseTasks,
  startBaiduPdfParse,
  type BaiduPdfParseConfig,
} from "../src/main/parsing/baidu-task";
import { publishParseSnapshot } from "../src/main/parsing/parse-snapshot";
import {
  PDF_CONVERTER_VERSION,
  convertParseResult,
  publishParseDocument,
} from "../src/main/parsing/parse-convert";
import {
  importPdfToCurrent,
  reconvertParseCandidate,
  resumePdfImport,
} from "../src/main/parsing/pdf-import";
import { publishDocumentMergeCandidate } from "../src/main/document/merge";
import { projectSentenceText } from "../src/shared/document/anchor";
import type { DocumentTree } from "../src/shared/document/tree";
import type {
  PdfParseSourceSnapshotRecord,
  ProjectRevisionRecord,
} from "../src/shared/contracts";
import type { PdfParseFactsFile, PdfParseTaskRecord } from "../src/shared/parsing";
import type { ImportDiagnostic } from "../src/shared/arxiv";

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const TOKEN = "test-baidu-token-never-persist";
const SIGNED_URL_MARKER = "signature-never-persist";
const MODEL = "PaddleOCR-VL-1.6" as const;

type AssetHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: string,
) => void | Promise<void>;

let sandbox: string;
let root: string;
let sourceSnapshotId: string;
let servers: Server[];

async function drain(request: IncomingMessage) {
  for await (const _chunk of request) {
    // Consume controlled multipart fixtures before sending the receipt.
  }
}

async function controlledServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
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
    for (const secret of secrets)
      expect(bytes.includes(secret), `${path.basename(file)} leaked a secret`).toBe(false);
  }
}

function pngBytes(width = 2, height = 2): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image);
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
      response.end(JSON.stringify({ code: 0, data: { jobId: "job-convert" } }));
      return;
    }
    if (request.url === "/jobs/job-convert") {
      counts.queries += 1;
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
      }));
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

interface SanitizedFixture extends DownloadFixture {
  snapshot: PdfParseSourceSnapshotRecord;
}

/** 下载 + 去敏发布解析快照，得到可转换的受管来源。 */
async function sanitizedFixture(
  buildRaw: (endpoint: string) => Buffer,
  assetHandler?: AssetHandler,
): Promise<SanitizedFixture> {
  const fixture = await downloadResponse(buildRaw, assetHandler);
  const published = await publishParseSnapshot({
    root,
    task: fixture.task,
    response: fixture.response,
  });
  expect(published.ok).toBe(true);
  if (!published.ok) throw new Error("controlled sanitize did not finish");
  return { ...fixture, task: published.task, snapshot: published.snapshot };
}

interface ImportFixture {
  endpoint: string;
  result: Awaited<ReturnType<typeof importPdfToCurrent>>;
  counts: { posts: number; queries: number; downloads: number };
}

/** 端到端：受控云服务 + 上传确认 + 去敏 + 转换 + 首次发布。 */
async function importFixture(
  buildRaw: (endpoint: string) => Buffer,
  extras: {
    assetHandler?: AssetHandler;
    signal?: AbortSignal;
    convertHooks?: Parameters<typeof importPdfToCurrent>[0]["convertHooks"];
  } = {},
): Promise<ImportFixture> {
  const counts = { posts: 0, queries: 0, downloads: 0 };
  let endpoint = "";
  endpoint = await controlledServer(async (request, response) => {
    if (request.method === "POST") {
      counts.posts += 1;
      await drain(request);
      response.end(JSON.stringify({ code: 0, data: { jobId: "job-convert" } }));
      return;
    }
    if (request.url === "/jobs/job-convert") {
      counts.queries += 1;
      response.end(JSON.stringify({
        code: 0,
        data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
      }));
      return;
    }
    if (request.url === "/jobs/result") {
      counts.downloads += 1;
      response.end(buildRaw(endpoint));
      return;
    }
    if (extras.assetHandler) {
      await extras.assetHandler(request, response, endpoint);
      return;
    }
    response.writeHead(404).end();
  });
  const result = await importPdfToCurrent({
    root,
    sourceSnapshotId,
    config: config(endpoint),
    confirmUpload: async () => true,
    ...(extras.signal === undefined ? {} : { signal: extras.signal }),
    ...(extras.convertHooks === undefined ? {} : { convertHooks: extras.convertHooks }),
  });
  return { endpoint, result, counts };
}

async function readSnapshotFile(snapshot: PdfParseSourceSnapshotRecord, relative: string) {
  return fs.readFile(path.join(root, snapshot.path, relative));
}

async function parseSnapshots() {
  return (await listSourceSnapshots(root)).filter(
    (snapshot) => snapshot.kind === "pdf-parse",
  ) as PdfParseSourceSnapshotRecord[];
}

function taskPath(parseBatchId: string) {
  return path.join(root, ".paper30min", "parsing", parseBatchId, "task.json");
}

async function readTaskRecord(parseBatchId: string): Promise<PdfParseTaskRecord> {
  return JSON.parse(await fs.readFile(taskPath(parseBatchId), "utf8")) as PdfParseTaskRecord;
}

async function writeTaskRecord(record: PdfParseTaskRecord) {
  await fs.writeFile(taskPath(record.parseBatchId), JSON.stringify(record, null, 2) + "\n");
}

function unitText(tree: DocumentTree, unitId: string): string {
  return tree.units[unitId].sentenceIds
    .map((sentenceId) => projectSentenceText(tree, sentenceId))
    .join(" ");
}

function normalized(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function paragraphTexts(tree: DocumentTree): string[] {
  return Object.values(tree.units)
    .filter((unit) => unit.kind === "paragraph")
    .map((unit) => normalized(unitText(tree, unit.id)));
}

function warningCodes(warnings: ImportDiagnostic[]): string[] {
  return warnings.map((warning) => warning.code);
}

async function currentRevisionId(): Promise<string | null> {
  return (await openProject(root)).manifest.paper.currentRevision;
}

async function publishedTree(revision: ProjectRevisionRecord) {
  return readRevisionDocument(root, revision.revisionId, "document");
}

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-parse-convert-"));
  servers = [];
  const project = await createProject({ parent: sandbox, name: "转换工程" });
  root = project.root;
  const snapshot = await snapshotLocalPdf({ root, source: SAMPLE });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  sourceSnapshotId = snapshot.snapshot.sourceSnapshotId;
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

test("pdf-import 端到端：全部页面转换后才推进 current，正文逐字进入规范树", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([
        block(0, "A Study of Testing", { block_label: "doc_title" }),
        block(1, "Introduction", { block_label: "paragraph_title" }),
        block(2, "First paragraph. Second sentence."),
        block(3, "More text here."),
      ]),
      vendorPage([
        block(0, "Method", { block_label: "paragraph_title" }),
        block(1, "We did things."),
      ]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision, task, warnings } = fixture.result;

  expect(await currentRevisionId()).toBe(revision.revisionId);
  expect(revision.baseRevision).toBeNull();
  const snapshots = await parseSnapshots();
  expect(snapshots).toHaveLength(1);
  expect(revision.sourceSnapshotId).toBe(snapshots[0].sourceSnapshotId);

  const tree = await publishedTree(revision);
  expect(tree.documentFormatVersion).toBe(1);
  expect(tree.paperId).toBe(task.paperId);
  const rootSection = Object.values(tree.sections).find((section) => section.parentSectionId === null)!;
  expect(rootSection.title).toBe("A Study of Testing");
  const childSections = rootSection.childSectionIds.map((id) => tree.sections[id]);
  expect(childSections.map((section) => section.title)).toEqual(["Introduction", "Method"]);
  // 平铺确定结构：vendor 不提供层级，全部章节直属根章节。
  expect(childSections.every((section) => section.parentSectionId === rootSection.id)).toBe(true);
  expect(paragraphTexts(tree)).toEqual([
    "First paragraph. Second sentence.",
    "More text here.",
    "We did things.",
  ]);
  const firstParagraph = Object.values(tree.units).find(
    (unit) => unit.kind === "paragraph" && unitText(tree, unit.id).startsWith("First paragraph"),
  )!;
  expect(firstParagraph.sourceAliases).toEqual(["page-1/b2"]);

  const sourceBase = await readRevisionDocument(root, revision.revisionId, "source-base");
  expect(sourceBase).toEqual(tree);
  expect(await readRevisionTombstones(root, revision.revisionId)).toEqual([]);
  const changeset = JSON.parse(await fs.readFile(
    path.join(root, revision.path, "changeset.json"),
    "utf8",
  )) as { changes: Array<{ status: string }> };
  expect(changeset.changes.length).toBeGreaterThan(0);
  expect(changeset.changes.every((change) => change.status === "added")).toBe(true);

  const persisted = await readTaskRecord(task.parseBatchId);
  expect(persisted.phase).toBe("candidate-complete");
  expect(persisted.candidateRevisionId).toBe(revision.revisionId);
  expect(persisted.diagnostic).toBeUndefined();
  expect(revision.pdfParse).toMatchObject({ converterVersion: PDF_CONVERTER_VERSION });
  expect(warningCodes(warnings)).toContain("pdf-convert-hierarchy-flattened");
  expect(fixture.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 发布后正文与资产离线可读，不需要网络或 LLM 审阅", async () => {
  const image = pngBytes();
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([
        block(0, "Before ![Figure A](imgs/fig.png) after."),
      ], { images: { "imgs/fig.png": image.toString("base64") } }),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision } = fixture.result;

  // 关闭全部受控服务后读取：current 阅读不依赖任何网络入口。
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const tree = await publishedTree(revision);
  expect(paragraphTexts(tree)).toContain("Second page text");
  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  expect(figure.kind === "figure" && figure.asset).toBeTruthy();
  if (figure.kind !== "figure" || !figure.asset) throw new Error("figure asset missing");
  const asset = await readRevisionAsset(root, revision.revisionId, figure.asset.path);
  expect(Buffer.from(asset.bytes).equals(image)).toBe(true);
  expect(fixture.counts.downloads).toBe(1);
});

test("pdf-import vendor 标签映射到规范结构：章节、图注、公式、参考文献与视觉块", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([
        block(0, "Deep Learning Review", { block_label: "doc_title" }),
        block(1, "Introduction", { block_label: "paragraph_title" }),
        block(2, "We study things."),
        block(3, "<table><tr><td>1</td></tr></table>", { block_label: "table" }),
        block(4, "Table 1: Numbers.", { block_label: "figure_title" }),
        block(5, " $$ E=mc^2 $$ ", { block_label: "display_formula" }),
        block(6, "", { block_label: "image" }),
        block(7, "", { block_label: "chart" }),
      ]),
      vendorPage([
        block(0, "[1] First ref. [2] Second ref.", { block_label: "reference_content" }),
        block(1, "A footnote.", { block_label: "footnote" }),
        block(2, "Page header", { block_label: "header" }),
        block(3, "Unknown content.", { block_label: "weird_label" }),
      ]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const warnings = fixture.result.warnings;

  const table = tree.blocks.find((entry) => entry.kind === "table")!;
  expect(table.kind === "table" && table.captionUnitId).toBeTruthy();
  if (table.kind !== "table" || !table.captionUnitId) throw new Error("table caption missing");
  expect(tree.units[table.captionUnitId].kind).toBe("caption");
  expect(normalized(unitText(tree, table.captionUnitId))).toBe("Table 1: Numbers.");
  expect(table.rows).toHaveLength(1);
  expect(normalized(unitText(tree, table.rows[0][0].unitId))).toBe("1");

  const formula = tree.blocks.find((entry) => entry.kind === "formula")!;
  expect(formula.kind === "formula").toBe(true);
  if (formula.kind !== "formula") throw new Error("formula missing");
  expect(formula.source).toEqual({ format: "latex", value: "E=mc^2" });
  expect(formula.text).toBe("$$ E=mc^2 $$");

  const figures = tree.blocks.filter((entry) => entry.kind === "figure");
  expect(figures).toHaveLength(2);
  for (const figure of figures) {
    if (figure.kind !== "figure") continue;
    expect(figure.asset).toBeNull();
    expect(figure.warning).toBeTruthy();
  }
  expect(warningCodes(warnings)).toContain("pdf-convert-figure-missing");

  const references = Object.values(tree.units).filter((unit) => unit.kind === "reference");
  expect(references).toHaveLength(2);
  expect(references.map((unit) => normalized(unitText(tree, unit.id))))
    .toEqual(["[1] First ref.", "[2] Second ref."]);
  const footnotes = Object.values(tree.units).filter((unit) => unit.kind === "footnote");
  expect(footnotes).toHaveLength(1);
  expect(normalized(unitText(tree, footnotes[0].id))).toBe("A footnote.");
  expect(paragraphTexts(tree)).toContain("Page header");
  expect(paragraphTexts(tree)).toContain("Unknown content.");
  expect(warningCodes(warnings)).toContain("pdf-convert-furniture");
  expect(warningCodes(warnings)).toContain("pdf-convert-label-downgraded");
});

test("pdf-import HTML 表格保留行列跨度与单元格文本", async () => {
  const html = '<table><tr><td rowspan="2">A</td><td colspan="2">B</td></tr>' +
    "<tr><td>C</td><td>D</td></tr></table>";
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, html, { block_label: "table" })]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const table = tree.blocks.find((entry) => entry.kind === "table")!;
  if (table.kind !== "table") throw new Error("table missing");
  expect(table.rows).toHaveLength(2);
  expect(table.rows[0]).toHaveLength(2);
  expect(table.rows[0][0]).toMatchObject({ rowSpan: 2, columnSpan: 1 });
  expect(table.rows[0][1]).toMatchObject({ rowSpan: 1, columnSpan: 2 });
  expect(table.rows[1]).toHaveLength(2);
  const texts = table.rows.flat().map((cell) => normalized(unitText(tree, cell.unitId)));
  expect(texts).toEqual(["A", "B", "C", "D"]);
  for (const cell of table.rows.flat())
    expect(tree.units[cell.unitId].kind).toBe("table-cell");
});

test("pdf-import 恶意 HTML 表格被消毒，危险内容不进入规范树", async () => {
  const html = '<table><tr><td onclick="alert(1)">safe</td>' +
    '<td><script>alert(2)</script><a href="javascript:alert(3)">link</a></td></tr>' +
    '<tr><td><img src="https://evil.example/x.png" onerror="alert(4)"></td>' +
    "<td><!-- comment -->ok</td></tr></table>";
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, html, { block_label: "table" })]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision } = fixture.result;
  const documentBytes = await fs.readFile(path.join(root, revision.path, "document.json"));
  for (const dangerous of ["onclick", "javascript:", "<script", "evil.example", "alert", "onerror"])
    expect(documentBytes.includes(dangerous), `document.json contains ${dangerous}`).toBe(false);
  const tree = await publishedTree(revision);
  const table = tree.blocks.find((entry) => entry.kind === "table")!;
  if (table.kind !== "table") throw new Error("table missing");
  const texts = table.rows.flat().map((cell) => normalized(unitText(tree, cell.unitId)));
  expect(texts).toContain("safe");
  expect(texts).toContain("link");
  expect(texts).toContain("ok");
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-html-sanitized");
});

test("pdf-import 嵌套表格与不可信跨度降级为 raw block 并保留文本投影", async () => {
  const nested = "<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>";
  // 超过列预算的数字跨度由转换器整体降级 raw；非数字跨度在去敏阶段即被移除。
  const badSpan = '<table><tr><td colspan="999">wide</td></tr></table>';
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([
        block(0, nested, { block_label: "table" }),
        block(1, badSpan, { block_label: "table" }),
        block(2, "Table 1: Nested.", { block_label: "figure_title" }),
      ]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const raws = tree.blocks.filter((entry) => entry.kind === "raw");
  expect(raws).toHaveLength(2);
  for (const raw of raws) {
    if (raw.kind !== "raw") continue;
    expect(raw.limitations.length).toBeGreaterThan(0);
    expect(raw.text.trim().length).toBeGreaterThan(0);
  }
  expect(raws.some((raw) => raw.kind === "raw" && raw.text.includes("inner"))).toBe(true);
  expect(raws.some((raw) => raw.kind === "raw" && raw.text.includes("wide"))).toBe(true);
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-table-lossy");
  // 配对图注随 raw 降级为普通段落，文本不丢失。
  expect(paragraphTexts(tree)).toContain("Table 1: Nested.");
});

test("pdf-import 表格内图片给出可读占位与 warning，资产保留在解析快照", async () => {
  const image = pngBytes();
  const html = '<table><tr><td><img src="imgs/table.png" alt="表格图"></td></tr></table>';
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, html, { block_label: "table" })], {
        images: { "imgs/table.png": image.toString("base64") },
      }),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const table = tree.blocks.find((entry) => entry.kind === "table")!;
  if (table.kind !== "table") throw new Error("table missing");
  const cellText = normalized(unitText(tree, table.rows[0][0].unitId));
  expect(cellText.length).toBeGreaterThan(0);
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-table-image");
  const snapshots = await parseSnapshots();
  const assetFact = snapshots[0].files.find((file) => file.path.startsWith("assets/"));
  expect(assetFact).toBeTruthy();
});

test("pdf-import 行内公式成为 math atom 并保留文本投影", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "Energy $E=mc^2$ is famous.")]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const atoms = Object.values(tree.atoms);
  expect(atoms).toHaveLength(1);
  expect(atoms[0]).toMatchObject({
    kind: "math",
    text: "$E=mc^2$",
    source: { format: "latex", value: "E=mc^2" },
  });
  expect(paragraphTexts(tree)).toContain("Energy $E=mc^2$ is famous.");
});

test("pdf-import 正文图片引用本地化为 revision 资产，缺失资源成为占位", async () => {
  const image = pngBytes();
  const localized = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "Before ![Figure A](imgs/fig.png) after.")], {
        images: { "imgs/fig.png": image.toString("base64") },
      }),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(localized.result.outcome).toBe("published");
  if (localized.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(localized.result.revision);
  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  if (figure.kind !== "figure" || !figure.asset) throw new Error("figure asset missing");
  expect(figure.asset.sha256).toBe(sha256(image));
  expect(figure.asset.mime).toBe("image/png");
  expect(figure.asset.path).toBe(`assets/${sha256(image)}.png`);
  expect(figure.captionUnitId).toBeTruthy();
  if (figure.captionUnitId)
    expect(normalized(unitText(tree, figure.captionUnitId))).toBe("Figure A");
  expect(paragraphTexts(tree)).toContain("Before");
  expect(paragraphTexts(tree)).toContain("after.");
  const revisionFile = localized.result.revision.files.find(
    (file) => file.path === figure.asset!.path,
  );
  expect(revisionFile?.sha256).toBe(sha256(image));
});

test("pdf-import 缺失图片资源成为可读占位，警告不阻塞发布", async () => {
  const missing = await importFixture(
    (endpoint) => jsonl([
      row([
        vendorPage([block(0, "Before ![Figure B](imgs/lost.png) after.")], {
          images: { "imgs/lost.png": `${endpoint}/lost` },
        }),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
    {
      assetHandler: (request, response) => {
        if (request.url === "/jobs/lost") {
          response.writeHead(500).end();
          return;
        }
        response.writeHead(404).end();
      },
    },
  );
  expect(missing.result.outcome).toBe("published");
  if (missing.result.outcome !== "published") throw new Error("missing-asset import did not publish");
  const missingTree = await publishedTree(missing.result.revision);
  const missingFigure = missingTree.blocks.find((entry) => entry.kind === "figure")!;
  if (missingFigure.kind !== "figure") throw new Error("figure missing");
  expect(missingFigure.asset).toBeNull();
  expect(missingFigure.warning).toBeTruthy();
  expect(warningCodes(missing.result.warnings)).toContain("pdf-convert-figure-missing");
});

test("pdf-import 页块顺序与 source alias 连接 facts.json，解析快照不可变", async () => {
  const fixture = await sanitizedFixture(() => jsonl([
    row([
      vendorPage([
        block(0, "Part one.", { group_id: 5 }),
        block(1, "Part two.", { group_id: 5 }),
        block(2, "Later."),
      ]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  const factsBefore = await readSnapshotFile(fixture.snapshot, "facts.json");
  const resultBefore = await readSnapshotFile(fixture.snapshot, "result.jsonl");
  const snapshotBefore = await readSnapshotFile(fixture.snapshot, "snapshot.json");

  const published = await publishParseDocument({
    root,
    task: fixture.task,
    snapshot: fixture.snapshot,
  });
  expect(published.ok).toBe(true);
  if (!published.ok) throw new Error("publish did not succeed");
  const tree = await publishedTree(published.revision);
  const paragraphs = Object.values(tree.units).filter((unit) => unit.kind === "paragraph");
  expect(normalized(unitText(tree, paragraphs[0].id))).toBe("Part one. Part two.");
  expect(paragraphs[0].sourceAliases).toEqual(["page-1/b0", "page-1/b1"]);
  expect(normalized(unitText(tree, paragraphs[1].id))).toBe("Later.");
  expect(paragraphs[1].sourceAliases).toEqual(["page-1/b2"]);

  const facts = JSON.parse(factsBefore.toString("utf8")) as PdfParseFactsFile;
  expect(facts.pages[0].blocks.map((entry) => entry.blockId)).toEqual([0, 1, 2]);
  expect(facts.pages[0].blocks[0].bbox).toEqual([10, 20, 100, 60]);
  // 转换与发布不回写不可变解析快照。
  expect((await readSnapshotFile(fixture.snapshot, "facts.json")).equals(factsBefore)).toBe(true);
  expect((await readSnapshotFile(fixture.snapshot, "result.jsonl")).equals(resultBefore)).toBe(true);
  expect((await readSnapshotFile(fixture.snapshot, "snapshot.json")).equals(snapshotBefore)).toBe(true);
});

test("pdf-import 缺失 block_order 按响应数组顺序降级并记录 warning", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([
        block(0, "First.", { block_order: null }),
        block(1, "Second.", { block_order: null }),
      ]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  expect(paragraphTexts(tree).slice(0, 2)).toEqual(["First.", "Second."]);
  const degraded = fixture.result.warnings.filter(
    (warning) => warning.code === "pdf-convert-order-degraded",
  );
  expect(degraded.length).toBeGreaterThan(0);
  expect(degraded[0].sourceAlias).toBe("page-1");
});

test("pdf-import 同组混用标签被拒绝，不发布部分 current", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "Good page text")]),
      vendorPage([
        block(0, "A", { group_id: 9 }),
        block(1, "B", { group_id: 9, block_label: "table" }),
      ]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("incomplete");
  if (fixture.result.outcome !== "incomplete") throw new Error("expected rejection");
  expect(fixture.result.diagnostic.code).toBe("pdf-convert-group-invalid");
  expect(await currentRevisionId()).toBeNull();
  const persisted = await readTaskRecord(fixture.result.task.parseBatchId);
  expect(persisted.phase).toBe("converting");
  expect(persisted.diagnostic?.code).toBe("pdf-convert-group-invalid");
  // 解析快照完整保留，可修复后离线重新转换。
  expect(await parseSnapshots()).toHaveLength(1);
  expect(await fs.readdir(path.join(root, "paper", "revisions")).catch(() => [])).toEqual([]);
});

test("pdf-import 全部页面无可读正文时拒绝发布", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "", { block_label: "image" })]),
      vendorPage([block(0, "", { block_label: "chart" })]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("incomplete");
  if (fixture.result.outcome !== "incomplete") throw new Error("expected rejection");
  expect(fixture.result.diagnostic.code).toBe("pdf-convert-body-empty");
  expect(await currentRevisionId()).toBeNull();
});

test("pdf-import 个别空白页保留 warning，其余页面正常发布", async () => {
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "Readable text.")]),
      vendorPage([]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-page-empty");
  const tree = await publishedTree(fixture.result.revision);
  expect(paragraphTexts(tree)).toContain("Readable text.");
});

test("pdf-import current 已存在时拒绝直写覆盖，旧正文保持不变", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("first import did not publish");
  const originalCurrent = await currentRevisionId();

  const second = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "Different first page")]),
      vendorPage([block(0, "Different second page")]),
    ]),
  ]));
  expect(second.result.outcome).toBe("incomplete");
  if (second.result.outcome !== "incomplete") throw new Error("expected rejection");
  expect(second.result.diagnostic.code).toBe("pdf-convert-current-exists");
  expect(await currentRevisionId()).toBe(originalCurrent);
  const tree = await publishedTree(first.result.revision);
  expect(paragraphTexts(tree)).toContain("First page paragraph");
});

test("pdf-import before-publish 中断：恢复沿用同一 revisionId，不重复下载", async () => {
  const fixture = await importFixture(() => twoPages(), {
    convertHooks: {
      onConvertPoint: (point) => {
        if (point === "before-publish") throw new Error("crash before publish");
      },
    },
  });
  expect(fixture.result.outcome).toBe("incomplete");
  if (fixture.result.outcome !== "incomplete") throw new Error("expected interruption");
  expect(fixture.result.diagnostic.code).toBe("pdf-convert-interrupted");
  const interrupted = await readTaskRecord(fixture.result.task.parseBatchId);
  expect(interrupted.phase).toBe("converting");
  expect(interrupted.candidateRevisionId).toBeTruthy();
  expect(await currentRevisionId()).toBeNull();

  const resumed = await resumePdfImport({
    root,
    parseBatchId: interrupted.parseBatchId,
  });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not publish");
  expect(resumed.revision.revisionId).toBe(interrupted.candidateRevisionId);
  expect(await currentRevisionId()).toBe(interrupted.candidateRevisionId);
  expect(fixture.counts.downloads).toBe(1);
  expect(fixture.counts.posts).toBe(1);
});

test("pdf-import revision-content 中断留下残留，恢复清理后按同一身份重发布", async () => {
  const fixture = await importFixture(() => twoPages(), {
    convertHooks: {
      commitHooks: {
        onCommitPoint: (point) => {
          if (point === "revision-content") throw new Error("crash at revision content");
        },
      },
    },
  });
  expect(fixture.result.outcome).toBe("incomplete");
  if (fixture.result.outcome !== "incomplete") throw new Error("expected interruption");
  const interrupted = await readTaskRecord(fixture.result.task.parseBatchId);
  const revisionId = interrupted.candidateRevisionId!;
  expect(revisionId).toBeTruthy();
  // 内容目录已落盘但元数据缺失：受管残留候选。
  await fs.access(path.join(root, "paper", "revisions", revisionId));
  await expect(
    fs.access(path.join(root, ".paper30min", "revisions", revisionId, "revision.json")),
  ).rejects.toThrow();
  expect(await currentRevisionId()).toBeNull();

  const resumed = await resumePdfImport({ root, parseBatchId: interrupted.parseBatchId });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not publish");
  expect(resumed.revision.revisionId).toBe(revisionId);
  expect(await currentRevisionId()).toBe(revisionId);
  expect(fixture.counts.downloads).toBe(1);
});

test("pdf-import before-current-replace 中断：候选已完整发布，恢复只推进指针", async () => {
  const convertPoints: string[] = [];
  const fixture = await importFixture(() => twoPages(), {
    convertHooks: {
      onConvertPoint: (point) => {
        convertPoints.push(point);
      },
      commitHooks: {
        onCommitPoint: (point) => {
          if (point === "before-current-replace") throw new Error("crash before current replace");
        },
      },
    },
  });
  expect(fixture.result.outcome).toBe("incomplete");
  if (fixture.result.outcome !== "incomplete") throw new Error("expected interruption");
  const interrupted = await readTaskRecord(fixture.result.task.parseBatchId);
  const revisionId = interrupted.candidateRevisionId!;
  const revision = await readRevision(root, revisionId);
  expect(revision.revisionId).toBe(revisionId);
  expect(await currentRevisionId()).toBeNull();
  const pointsBeforeResume = convertPoints.length;

  const resumed = await resumePdfImport({ root, parseBatchId: interrupted.parseBatchId });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not publish");
  expect(resumed.revision.revisionId).toBe(revisionId);
  expect(resumed.revision.committedAt).toBe(revision.committedAt);
  expect(await currentRevisionId()).toBe(revisionId);
  // 恢复只核验并推进指针，不重新转换。
  expect(convertPoints.length).toBe(pointsBeforeResume);
  expect(fixture.counts.downloads).toBe(1);
});

test("pdf-import current 推进后任务记录丢失：恢复幂等补齐，不重转换", async () => {
  const fixture = await importFixture(() => twoPages());
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision, task } = fixture.result;
  const before = await readTaskRecord(task.parseBatchId);
  // 模拟 current 已推进但 candidate-complete 未落盘的崩溃窗口。
  await writeTaskRecord({ ...before, phase: "converting" });
  expect(await currentRevisionId()).toBe(revision.revisionId);

  const resumed = await resumePdfImport({ root, parseBatchId: task.parseBatchId });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not complete");
  expect(resumed.revision.revisionId).toBe(revision.revisionId);
  expect(await currentRevisionId()).toBe(revision.revisionId);
  const after = await readTaskRecord(task.parseBatchId);
  expect(after.phase).toBe("candidate-complete");
  expect(fixture.counts.downloads).toBe(1);
});

test("pdf-import 重开已完成任务不重转换、不重复下载", async () => {
  const fixture = await importFixture(() => twoPages());
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision, task } = fixture.result;
  const documentBefore = await fs.readFile(path.join(root, revision.path, "document.json"));

  const resumed = await resumePdfImport({ root, parseBatchId: task.parseBatchId });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not complete");
  expect(resumed.revision.revisionId).toBe(revision.revisionId);
  expect((await fs.readFile(path.join(root, revision.path, "document.json"))).equals(documentBefore))
    .toBe(true);
  expect(fixture.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 转换中本机停止中止处理，恢复从快照继续", async () => {
  const controller = new AbortController();
  const fixture = await importFixture(() => twoPages(), {
    signal: controller.signal,
    convertHooks: {
      onConvertPoint: (point) => {
        if (point === "candidate-built") controller.abort();
      },
    },
  });
  expect(fixture.result.outcome).toBe("stopped");
  if (fixture.result.outcome !== "stopped") throw new Error("expected stop");
  const stopped = await readTaskRecord(fixture.result.task.parseBatchId);
  expect(stopped.phase).toBe("stopped");
  expect(await currentRevisionId()).toBeNull();

  const resumed = await resumePdfImport({ root, parseBatchId: stopped.parseBatchId });
  expect(resumed.outcome).toBe("published");
  if (resumed.outcome !== "published") throw new Error("resume did not publish");
  expect(await currentRevisionId()).toBe(resumed.revision.revisionId);
  expect(fixture.counts.downloads).toBe(1);
});

test("pdf-import 转换预算超限拒绝发布，不截断正文", async () => {
  const huge = "x".repeat(2 * 1024 * 1024 + 1);
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, huge, { block_label: "table" })]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("incomplete");
  if (fixture.result.outcome !== "incomplete") throw new Error("expected rejection");
  expect(fixture.result.diagnostic.code).toBe("pdf-convert-tree-invalid");
  expect(await currentRevisionId()).toBeNull();
  // 原始正文完整保留在解析快照中，没有被截断。
  const snapshots = await parseSnapshots();
  const resultBytes = await readSnapshotFile(snapshots[0], "result.jsonl");
  expect(resultBytes.includes(huge)).toBe(true);
});

test("pdf-import 快照字节被篡改时拒绝转换并保留现场", async () => {
  const fixture = await sanitizedFixture(() => twoPages());
  const resultPath = path.join(root, fixture.snapshot.path, "result.jsonl");
  await fs.writeFile(resultPath, Buffer.concat([await fs.readFile(resultPath), Buffer.from(" ")]));
  const published = await publishParseDocument({
    root,
    task: fixture.task,
    snapshot: fixture.snapshot,
  });
  expect(published.ok).toBe(false);
  if (published.ok) throw new Error("expected rejection");
  expect(published.diagnostic.code).toBe("pdf-convert-snapshot-digest");
  expect(await currentRevisionId()).toBeNull();
});

test("pdf-import 全链路秘密不进入工程任何文件", async () => {
  const image = pngBytes();
  const fixture = await importFixture(
    (endpoint) => jsonl([
      row([
        vendorPage([block(0, "First page paragraph")], {
          images: { "imgs/fig.png": `${endpoint}/asset?${SIGNED_URL_MARKER}` },
        }),
        vendorPage([block(0, "Second page text")]),
      ]),
    ]),
    {
      assetHandler: (request, response) => {
        if (request.url === `/jobs/asset?${SIGNED_URL_MARKER}`) {
          response.end(image);
          return;
        }
        response.writeHead(404).end();
      },
    },
  );
  expect(fixture.result.outcome).toBe("published");
  await expectProjectDoesNotContain(TOKEN, SIGNED_URL_MARKER);
});

test("pdf-import 转换进行中拒绝新的云端任务", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = importFixture(() => twoPages(), {
    convertHooks: {
      onConvertPoint: async (point) => {
        if (point === "before-publish") await gate;
      },
    },
  });
  await expect.poll(async () => {
    const tasks = await listBaiduPdfParseTasks(root);
    return tasks.find((task) => task.phase === "converting")?.parseBatchId ?? "";
  }).not.toBe("");
  await expect(
    startBaiduPdfParse({
      root,
      sourceSnapshotId,
      config: config("http://127.0.0.1:1/jobs"),
      confirmUpload: async () => true,
    }),
  ).rejects.toThrow();
  release();
  const fixture = await running;
  expect(fixture.result.outcome).toBe("published");
});

test("pdf-import 相同快照离线重新转换内容结构确定，无网络无模型", async () => {
  const fixture = await sanitizedFixture(() => jsonl([
    row([
      vendorPage([
        block(0, "Title", { block_label: "paragraph_title" }),
        block(1, "Deterministic text. $x^2$"),
      ]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  const resultBytes = await readSnapshotFile(fixture.snapshot, "result.jsonl");
  const facts = JSON.parse(
    (await readSnapshotFile(fixture.snapshot, "facts.json")).toString("utf8"),
  ) as PdfParseFactsFile;
  const paperId = fixture.task.paperId;
  const first = convertParseResult({ paperId, resultBytes, facts });
  const second = convertParseResult({ paperId, resultBytes, facts });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error("conversion failed");
  const fingerprint = (tree: DocumentTree) => tree.blocks.map((entry) => {
    const units = entry.kind === "unit" ? [entry.unitId]
      : entry.kind === "figure" ? (entry.captionUnitId ? [entry.captionUnitId] : [])
      : entry.kind === "table" ? entry.rows.flat().map((cell) => cell.unitId)
      : [];
    return {
      kind: entry.kind,
      aliases: entry.sourceAliases ?? [],
      texts: units.map((unitId) => normalized(unitText(tree, unitId))),
    };
  });
  expect(fingerprint(second.tree)).toEqual(fingerprint(first.tree));
  expect(second.warnings).toEqual(first.warnings);
  expect(fixture.counts.downloads).toBe(1);
});

test("pdf-import 离线重新转换：current 已存在时形成无内容变化候选，发布不重排节点", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const snapshots = await parseSnapshots();
  expect(snapshots).toHaveLength(1);

  const candidate = await reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  });
  expect(candidate.conflicts).toHaveLength(0);
  expect(candidate.changeset.changes.every((entry) => entry.status === "retained")).toBe(true);

  const published = await publishDocumentMergeCandidate(candidate);
  expect(await currentRevisionId()).toBe(published.revisionId);
  const publishedDoc = await publishedTree(published);
  expect(publishedDoc).toEqual(await publishedTree(first.result.revision));
  const metadata = (await readRevision(root, published.revisionId)).pdfParse as Record<string, unknown>;
  expect(metadata.converterVersion).toBe(PDF_CONVERTER_VERSION);
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 离线重新转换：内容不变时保留本地修正，source-base 不被本地修正污染", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(first.result.revision);
  const paragraph = Object.values(tree.units).find((unit) =>
    unit.kind === "paragraph" && normalized(unitText(tree, unit.id)) === "Second page text");
  if (!paragraph) throw new Error("fixture paragraph not found");
  const sentenceId = paragraph.sentenceIds[0];

  const local = structuredClone(tree);
  local.sentences[sentenceId].content = [{ kind: "text", text: "Second page text local fix" }];
  const localRevision = await commitRevision({
    root,
    baseRevision: first.result.revision.revisionId,
    sourceSnapshotId: first.result.revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(local)),
      "source-base.json": Buffer.from(JSON.stringify(tree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: first.result.revision.revisionId })),
    },
  });

  const candidate = await reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: localRevision.revisionId,
  });
  expect(candidate.conflicts).toHaveLength(0);
  const published = await publishDocumentMergeCandidate(candidate);
  const publishedDoc = await publishedTree(published);
  expect(projectSentenceText(publishedDoc, sentenceId)).toBe("Second page text local fix");
  const sourceBase = await readRevisionDocument(root, published.revisionId, "source-base");
  expect(projectSentenceText(sourceBase, sentenceId)).toBe("Second page text");
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 离线重新转换：baseRevision 已变化时拒绝形成候选，current 不受影响", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(first.result.revision);
  const localRevision = await commitRevision({
    root,
    baseRevision: first.result.revision.revisionId,
    sourceSnapshotId: first.result.revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(tree)),
      "source-base.json": Buffer.from(JSON.stringify(tree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: first.result.revision.revisionId })),
    },
  });
  await expect(reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  })).rejects.toThrow(/baseRevision/);
  expect(await currentRevisionId()).toBe(localRevision.revisionId);
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 离线重新转换：解析快照缺失时明确拒绝，不访问云端", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const snapshots = await parseSnapshots();
  await fs.rm(path.join(root, snapshots[0].path), { recursive: true, force: true });
  await expect(reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  })).rejects.toThrow();
  expect(await currentRevisionId()).toBe(first.result.revision.revisionId);
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 离线重新转换：候选保留 revision 资产，发布后离线可读", async () => {
  const image = pngBytes();
  const first = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, "Before ![Figure A](imgs/fig.png) after.")], {
        images: { "imgs/fig.png": image.toString("base64") },
      }),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");

  const candidate = await reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  });
  const published = await publishDocumentMergeCandidate(candidate);
  const asset = await readRevisionAsset(root, published.revisionId, `assets/${sha256(image)}.png`);
  expect(Buffer.from(asset.bytes).equals(image)).toBe(true);
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

/** 300x200pt 单页 PDF：黑矩形 top-left (20,30)-(100,60)，与 sample 同为无旋转标准页。 */
function inkPdf(pageDict = "/MediaBox [0 0 300 200]"): Buffer {
  const stream = "0 g 20 140 80 30 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R ${pageDict} /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** vendor 页 1200x800 与 300x200pt PDF 同宽高比；bbox 对应黑矩形区域。 */
function cropPage(blocks: ReturnType<typeof block>[]) {
  return {
    prunedResult: {
      width: 1200,
      height: 800,
      model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true },
      parsing_res_list: blocks,
    },
  };
}

function cropRow(pages: ReturnType<typeof cropPage>[]) {
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

async function useInkPdf(pageDict?: string) {
  const file = path.join(sandbox, "ink.pdf");
  await fs.writeFile(file, inkPdf(pageDict));
  const snapshot = await snapshotLocalPdf({ root, source: file });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw new Error("ink PDF snapshot failed");
  sourceSnapshotId = snapshot.snapshot.sourceSnapshotId;
}

function cropVisualResponse(): Buffer {
  return jsonl([cropRow([cropPage([
    block(0, "Intro text.", { block_bbox: [40, 40, 600, 80] }),
    block(1, "", { block_label: "image", block_bbox: [80, 120, 400, 240] }),
    block(2, " $$ E=mc^2 $$ ", { block_label: "display_formula", block_bbox: [80, 300, 400, 360] }),
  ])])]);
}

test("pdf-import 无云端资产视觉块引用原页裁剪图：派生资产进入 revision，快照不回写", async () => {
  await useInkPdf();
  const fixture = await importFixture(() => cropVisualResponse());
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision, warnings } = fixture.result;
  const tree = await publishedTree(revision);

  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  expect(figure.kind).toBe("figure");
  if (figure.kind !== "figure") throw new Error("figure missing");
  expect(figure.asset).not.toBeNull();
  expect(figure.warning).toBeUndefined();
  const cropAsset = await readRevisionAsset(root, revision.revisionId, figure.asset!.path);
  const image = PNG.sync.read(Buffer.from(cropAsset.bytes));
  // bbox (80,120)-(400,240) → 80x30pt × scale 2 = 160x60，全部为黑矩形墨迹。
  expect(image.width).toBe(160);
  expect(image.height).toBe(60);
  let ink = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] < 128) ink++;
  expect(ink).toBe(160 * 60);

  const formula = tree.blocks.find((entry) => entry.kind === "formula")!;
  expect(formula.kind).toBe("formula");
  if (formula.kind !== "formula") throw new Error("formula missing");
  expect(formula.source).toEqual({ format: "latex", value: "E=mc^2" });
  expect(formula.asset).toBeTruthy();
  expect(formula.asset!.path).toMatch(/^assets\/[a-f0-9]{64}\.png$/);

  // 派生资产只进 revision：解析快照与 PDF 快照文件清单不含裁剪图。
  const snapshots = await listSourceSnapshots(root);
  for (const snapshot of snapshots)
    expect(snapshot.files.some((file) => file.path === figure.asset!.path)).toBe(false);
  expect(warningCodes(warnings)).not.toContain("pdf-crop-region-uncalibrated");
  expect(fixture.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 云端资产存在时优先云端字节，不产生原页裁剪", async () => {
  await useInkPdf();
  const image = pngBytes();
  const page = cropPage([
    block(0, "Intro text.", { block_bbox: [40, 40, 600, 80] }),
    block(1, "![Figure A](imgs/fig.png)", { block_label: "image", block_bbox: [80, 120, 400, 240] }),
  ]);
  const withManifest = { ...page, markdown: { images: { "imgs/fig.png": image.toString("base64") } } };
  const fixture = await importFixture(() => jsonl([cropRow([withManifest])]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  if (figure.kind !== "figure" || !figure.asset) throw new Error("figure asset missing");
  expect(figure.asset.path).toBe(`assets/${sha256(image)}.png`);
  const asset = await readRevisionAsset(root, fixture.result.revision.revisionId, figure.asset.path);
  expect(Buffer.from(asset.bytes).equals(image)).toBe(true);
});

test("pdf-import 旋转页视觉块只声明页级来源：warning 保留，正文仍发布", async () => {
  await useInkPdf("/MediaBox [0 0 300 200] /Rotate 90");
  const fixture = await importFixture(() => cropVisualResponse());
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  if (figure.kind !== "figure") throw new Error("figure missing");
  expect(figure.asset).toBeNull();
  expect(figure.warning).toBeTruthy();
  const formula = tree.blocks.find((entry) => entry.kind === "formula")!;
  if (formula.kind !== "formula") throw new Error("formula missing");
  expect(formula.asset).toBeUndefined();
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-crop-region-uncalibrated");
  expect(paragraphTexts(tree)).toContain("Intro text.");
});

test("pdf-import 预处理页面拒绝区域裁剪：只保留页级事实与 warning", async () => {
  await useInkPdf();
  const raw = cropVisualResponse();
  const rows = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  rows[0].result.layoutParsingResults[0].prunedResult.model_settings.use_doc_preprocessor = true;
  const fixture = await importFixture(() => jsonl(rows));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  if (figure.kind !== "figure") throw new Error("figure missing");
  expect(figure.asset).toBeNull();
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-crop-region-uncalibrated");
});

test("pdf-import 跨度范围重叠的表格整体降级 raw，不产生重叠单元", async () => {
  // 真实网格冲突：row0 的 D 以 rowspan=2 占据 (1,2)；row1 的 colspan=3 从空闲列 0
  // 开始，while-skip 不移动起点，但跨度范围内部 (1,2) 已被占用 → 整体降级 raw。
  const overlap = '<table><tr><td rowspan="2">A</td><td>B</td><td rowspan="2">D</td></tr>' +
    '<tr><td colspan="3">C</td></tr></table>';
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, overlap, { block_label: "table" })]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const tree = await publishedTree(fixture.result.revision);
  expect(tree.blocks.some((entry) => entry.kind === "table")).toBe(false);
  const raw = tree.blocks.find((entry) => entry.kind === "raw")!;
  expect(raw.kind).toBe("raw");
  if (raw.kind !== "raw") throw new Error("raw block missing");
  expect(raw.text).toContain("A");
  expect(raw.text).toContain("B");
  expect(raw.text).toContain("C");
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-table-lossy");
});

test("pdf-import 危险内容独占表格时只留占位，清洗前原文不进入 revision", async () => {
  const dangerous = '<table><tr><td><script>var payload = "table-secret-payload";</script></td></tr></table>';
  const fixture = await importFixture(() => jsonl([
    row([
      vendorPage([block(0, dangerous, { block_label: "table" })]),
      vendorPage([block(0, "Second page text")]),
    ]),
  ]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision } = fixture.result;
  for (const file of await filesUnder(path.join(root, revision.path))) {
    const bytes = await fs.readFile(file);
    expect(bytes.includes("table-secret-payload"), `${path.basename(file)} leaked payload`).toBe(false);
    expect(bytes.includes("<script"), `${path.basename(file)} leaked script`).toBe(false);
  }
  const tree = await publishedTree(revision);
  expect(tree.blocks.some((entry) => entry.kind === "table")).toBe(false);
  expect(tree.blocks.some((entry) => entry.kind === "raw")).toBe(false);
  const figure = tree.blocks.find((entry) => entry.kind === "figure")!;
  expect(figure.kind).toBe("figure");
  if (figure.kind !== "figure") throw new Error("placeholder figure missing");
  expect(figure.warning).toBeTruthy();
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-table-lossy");
  expect(warningCodes(fixture.result.warnings)).toContain("pdf-convert-html-sanitized");
});

test("pdf-import 纯文本快照离线重转换：父 PDF 被删除时拒绝", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const pdfSnapshots = (await listSourceSnapshots(root)).filter((entry) => entry.kind === "pdf");
  await fs.rm(path.join(root, pdfSnapshots[0].path, "paper.pdf"));
  await expect(reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  })).rejects.toThrow();
  expect(await currentRevisionId()).toBe(first.result.revision.revisionId);
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});

test("pdf-import 纯文本快照离线重转换：父 PDF 被篡改时拒绝", async () => {
  const first = await importFixture(() => twoPages());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const pdfSnapshots = (await listSourceSnapshots(root)).filter((entry) => entry.kind === "pdf");
  const pdfPath = path.join(root, pdfSnapshots[0].path, "paper.pdf");
  await fs.writeFile(pdfPath, Buffer.concat([await fs.readFile(pdfPath), Buffer.from("%tampered")]));
  await expect(reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  })).rejects.toThrow();
  expect(await currentRevisionId()).toBe(first.result.revision.revisionId);
});

test("pdf-import 同页两视觉块同 bbox：二者引用同一 revision 裁剪资产", async () => {
  await useInkPdf();
  const fixture = await importFixture(() => jsonl([cropRow([cropPage([
    block(0, "Intro text.", { block_bbox: [40, 40, 600, 80] }),
    block(1, "", { block_label: "image", block_bbox: [80, 120, 400, 240] }),
    block(2, "", { block_label: "image", block_bbox: [80, 120, 400, 240] }),
  ])])]));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const { revision } = fixture.result;
  const tree = await publishedTree(revision);
  const figures = tree.blocks.filter((entry) => entry.kind === "figure");
  expect(figures).toHaveLength(2);
  for (const figure of figures) {
    if (figure.kind !== "figure") throw new Error("figure missing");
    expect(figure.asset).not.toBeNull();
    expect(figure.warning).toBeUndefined();
  }
  const [first, second] = figures;
  if (first.kind !== "figure" || second.kind !== "figure") throw new Error("figures missing");
  expect(first.asset!.path).toBe(second.asset!.path);
  const asset = await readRevisionAsset(root, revision.revisionId, first.asset!.path);
  const image = PNG.sync.read(Buffer.from(asset.bytes));
  expect(image.width).toBe(160);
  expect(image.height).toBe(60);
  expect(warningCodes(fixture.result.warnings)).not.toContain("pdf-convert-figure-missing");
});

test("pdf-import 预处理页视觉块只保留一条 warning，不产生无谓裁切", async () => {
  await useInkPdf();
  const raw = cropVisualResponse();
  const rows = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  rows[0].result.layoutParsingResults[0].prunedResult.model_settings.use_doc_preprocessor = true;
  const fixture = await importFixture(() => jsonl(rows));
  expect(fixture.result.outcome).toBe("published");
  if (fixture.result.outcome !== "published") throw new Error("import did not publish");
  const uncalibrated = fixture.result.warnings.filter(
    (entry) => entry.code === "pdf-crop-region-uncalibrated",
  );
  expect(uncalibrated).toHaveLength(2);
  expect(new Set(uncalibrated.map((entry) => entry.sourceAlias)).size).toBe(2);
});

test("pdf-import 离线重转换重建同一裁剪资产：候选发布后离线可读且字节一致", async () => {
  await useInkPdf();
  const first = await importFixture(() => cropVisualResponse());
  expect(first.result.outcome).toBe("published");
  if (first.result.outcome !== "published") throw new Error("import did not publish");
  const firstTree = await publishedTree(first.result.revision);
  const firstFigure = firstTree.blocks.find((entry) => entry.kind === "figure")!;
  if (firstFigure.kind !== "figure" || !firstFigure.asset) throw new Error("figure asset missing");
  const firstBytes = await readRevisionAsset(root, first.result.revision.revisionId, firstFigure.asset.path);

  const candidate = await reconvertParseCandidate({
    root,
    parseBatchId: first.result.task.parseBatchId,
    baseRevision: first.result.revision.revisionId,
  });
  expect(candidate.conflicts).toHaveLength(0);
  expect(candidate.assets[firstFigure.asset.path]).toBeTruthy();
  const published = await publishDocumentMergeCandidate(candidate);
  const asset = await readRevisionAsset(root, published.revisionId, firstFigure.asset.path);
  expect(Buffer.from(asset.bytes).equals(Buffer.from(firstBytes.bytes))).toBe(true);
  expect(first.counts).toEqual({ posts: 1, queries: 1, downloads: 1 });
});