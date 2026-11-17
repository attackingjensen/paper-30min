import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { fetch, type Dispatcher } from "undici";
import { readDiagnosticArray, type ImportDiagnostic } from "../../shared/arxiv.js";
import type {
  ManagedFileContent,
  PdfParseSourceSnapshotRecord,
} from "../../shared/contracts.js";
import type {
  PdfParseAssetFact,
  PdfParseBlockFact,
  PdfParseFactsFile,
  PdfParsePageFact,
  PdfParseTaskRecord,
} from "../../shared/parsing.js";
import {
  publishSourceSnapshot,
  readSourceSnapshot,
  type ProjectCommitHooks,
} from "../project-core.js";
import { findBatchParseSnapshot, resultResource, saveTask } from "./baidu-task.js";

const ASSET_BUDGET = 32 * 1024 * 1024;
const SNAPSHOT_ASSET_BUDGET = 256 * 1024 * 1024;
const PNG_PIXEL_BUDGET = 16_000_000;
const PAGE_BLOCK_BUDGET = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BASE64_ASSET_CHARS = Math.ceil(ASSET_BUDGET / 3) * 4;

/** 无法取得或无法证明安全的资源占位；转换器据此给出缺失诊断，不渲染远端内容。 */
export const MISSING_ASSET_PLACEHOLDER = "missing-asset";

const BOOLEAN_SETTINGS = new Set([
  "use_doc_preprocessor",
  "use_layout_detection",
  "use_chart_recognition",
  "use_seal_recognition",
  "use_ocr_for_image_block",
  "format_block_content",
  "merge_layout_blocks",
  "return_layout_polygon_points",
]);
const ARRAY_SETTINGS = new Set(["markdown_ignore_labels"]);

const MESSAGE_KEYS: Record<string, string> = {
  "parse-response-invalid": "parse.response.invalid",
  "parse-response-digest-mismatch": "parse.response.digestMismatch",
  "parse-page-count-mismatch": "parse.pageCount.mismatch",
  "parse-page-duplicate": "parse.page.duplicate",
  "parse-block-invalid": "parse.block.invalid",
  "parse-block-budget-exceeded": "parse.block.budgetExceeded",
  "parse-resource-url-rejected": "parse.resource.urlRejected",
  "parse-resource-redirect-rejected": "parse.resource.redirectRejected",
  "parse-asset-budget-exceeded": "parse.asset.budgetExceeded",
  "parse-asset-missing": "parse.asset.missing",
  "parse-page-empty": "parse.page.empty",
  "parse-response-fields-dropped": "parse.response.fieldsDropped",
  "parse-stopped": "parse.stopped",
};

interface PublishParseSnapshotInput {
  root: string;
  /** 已完成下载的任务记录；phase 为 downloaded 且已持久化 responseSha256。 */
  task: PdfParseTaskRecord;
  /** 仅存在于主进程内存的原始响应；含密字节绝不写入工程。 */
  response: { bytes: Uint8Array; sha256: string };
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
  hooks?: ProjectCommitHooks;
}

type ParseSnapshotResult =
  | {
      ok: true;
      snapshot: PdfParseSourceSnapshotRecord;
      task: PdfParseTaskRecord;
      diagnostics: ImportDiagnostic[];
    }
  | { ok: false; diagnostic: ImportDiagnostic; task: PdfParseTaskRecord };

class ParseFatalError extends Error {
  constructor(
    readonly code: string,
    readonly stage: ImportDiagnostic["stage"],
  ) {
    super(code);
    this.name = "ParseFatalError";
  }
}

function fatal(code: string, stage: ImportDiagnostic["stage"] = "validate"): never {
  throw new ParseFatalError(code, stage);
}

function diagnostic(
  code: string,
  severity: ImportDiagnostic["severity"],
  stage: ImportDiagnostic["stage"],
  sourceAlias?: string,
): ImportDiagnostic {
  return {
    code,
    severity,
    stage,
    messageKey: MESSAGE_KEYS[code] ?? code,
    ...(sourceAlias === undefined ? {} : { sourceAlias }),
  };
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fatal("parse-response-invalid");
  return value as Record<string, unknown>;
}

function positiveDimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    fatal("parse-response-invalid");
  return value;
}

function unknownKeyCount(record: Record<string, unknown>, allowed: string[]) {
  return Object.keys(record).filter((key) => !allowed.includes(key)).length;
}

function safeVendorPath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\\]/.test(value) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !value.includes("://")
  );
}

interface SanitizeContext {
  dropped: number;
  warnings: ImportDiagnostic[];
}

interface ValidatedBlock {
  label: string;
  content: string;
  bbox: [number, number, number, number] | null;
  id: number;
  order: number | null;
  groupId: number | null;
}

interface ValidatedPage {
  pageNumber: number;
  width: number;
  height: number;
  settings: Record<string, boolean | string[]>;
  blocks: ValidatedBlock[];
  images: Record<string, unknown> | null;
}

interface ValidatedRow {
  pages: ValidatedPage[];
}

function whitelistSettings(value: unknown, context: SanitizeContext) {
  if (value === undefined) return {};
  const record = objectValue(value);
  const settings: Record<string, boolean | string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (BOOLEAN_SETTINGS.has(key) && typeof entry === "boolean") settings[key] = entry;
    else if (
      ARRAY_SETTINGS.has(key) &&
      Array.isArray(entry) &&
      entry.every((item) => typeof item === "string")
    )
      settings[key] = [...(entry as string[])];
    else context.dropped += 1;
  }
  return settings;
}

/** 第一遍：页级结构、块身份／顺序与几何验证；不发起任何网络访问。 */
function validateRows(
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
  context: SanitizeContext,
): ValidatedRow[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fatal("parse-response-invalid");
  }
  const rows: ValidatedRow[] = [];
  const seen = new Set<string>();
  let pageCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    signal?.throwIfAborted();
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fatal("parse-response-invalid");
    }
    const rowRecord = objectValue(value);
    if (rowRecord.errorCode !== undefined && rowRecord.errorCode !== 0)
      fatal("parse-response-invalid");
    const result = objectValue(rowRecord.result);
    const info = objectValue(result.dataInfo);
    const list = result.layoutParsingResults;
    const infoPages = info.pages;
    if (
      info.type !== "pdf" ||
      !Array.isArray(list) ||
      !Array.isArray(infoPages) ||
      info.numPages !== list.length ||
      infoPages.length !== list.length
    )
      fatal("parse-response-invalid");
    context.dropped +=
      unknownKeyCount(rowRecord, ["result", "errorCode"]) +
      unknownKeyCount(result, ["dataInfo", "layoutParsingResults"]) +
      unknownKeyCount(info, ["type", "numPages", "pages"]);
    const pages: ValidatedPage[] = [];
    for (const [index, entry] of list.entries()) {
      signal?.throwIfAborted();
      const pageRecord = objectValue(entry);
      const data = objectValue(pageRecord.prunedResult);
      const width = positiveDimension(data.width);
      const height = positiveDimension(data.height);
      const infoPage = objectValue(infoPages[index]);
      if (infoPage.width !== width || infoPage.height !== height)
        fatal("parse-response-invalid");
      context.dropped +=
        unknownKeyCount(infoPage, ["width", "height"]) +
        unknownKeyCount(pageRecord, ["prunedResult", "markdown"]);
      const settings = whitelistSettings(data.model_settings, context);
      const rawBlocks = data.parsing_res_list;
      if (!Array.isArray(rawBlocks)) fatal("parse-response-invalid");
      if (rawBlocks.length > PAGE_BLOCK_BUDGET) fatal("parse-block-budget-exceeded");
      const blocks: ValidatedBlock[] = [];
      const ids = new Set<number>();
      let previousOrder = -1;
      for (const item of rawBlocks) {
        const record = objectValue(item);
        const id = record.block_id;
        const label = record.block_label;
        const content = record.block_content;
        if (
          typeof id !== "number" ||
          !Number.isSafeInteger(id) ||
          id < 0 ||
          ids.has(id) ||
          typeof label !== "string" ||
          typeof content !== "string"
        )
          fatal("parse-block-invalid");
        ids.add(id);
        let order: number | null = null;
        if (record.block_order !== undefined && record.block_order !== null) {
          const candidate = record.block_order;
          if (
            typeof candidate !== "number" ||
            !Number.isSafeInteger(candidate) ||
            candidate <= previousOrder
          )
            fatal("parse-block-invalid");
          previousOrder = candidate;
          order = candidate;
        }
        let groupId: number | null = null;
        if (record.group_id !== undefined && record.group_id !== null) {
          if (
            typeof record.group_id === "number" &&
            Number.isSafeInteger(record.group_id) &&
            record.group_id >= 0
          )
            groupId = record.group_id;
          else context.dropped += 1;
        }
        let bbox: [number, number, number, number] | null = null;
        if (record.block_bbox !== undefined && record.block_bbox !== null) {
          const box = record.block_bbox;
          if (
            Array.isArray(box) &&
            box.length === 4 &&
            box.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
          )
            bbox = box as [number, number, number, number];
          else context.dropped += 1;
        }
        context.dropped += unknownKeyCount(record, [
          "block_label",
          "block_content",
          "block_bbox",
          "block_id",
          "block_order",
          "group_id",
        ]);
        blocks.push({ label, content, bbox, id, order, groupId });
      }
      let images: Record<string, unknown> | null = null;
      if (pageRecord.markdown !== undefined) {
        const markdown = objectValue(pageRecord.markdown);
        context.dropped += unknownKeyCount(markdown, ["images"]);
        if (markdown.images !== undefined) {
          const manifest = objectValue(markdown.images);
          images = {};
          for (const [vendorPath, rawValue] of Object.entries(manifest)) {
            if (!safeVendorPath(vendorPath)) fatal("parse-response-invalid");
            images[vendorPath] = rawValue;
          }
        }
      }
      pageCount += 1;
      const page: ValidatedPage = {
        pageNumber: pageCount,
        width,
        height,
        settings,
        blocks,
        images,
      };
      const canonical = hash(Buffer.from(JSON.stringify({
        width: page.width,
        height: page.height,
        settings: page.settings,
        blocks: page.blocks,
      })));
      if (seen.has(canonical) && blocks.some((block) => block.content.trim()))
        fatal("parse-page-duplicate");
      seen.add(canonical);
      if (blocks.length === 0)
        context.warnings.push(diagnostic("parse-page-empty", "warning", "validate", `page-${page.pageNumber}`));
      pages.push(page);
    }
    rows.push({ pages });
  }
  return rows;
}

interface StoredAsset {
  path: string;
  bytes: Buffer;
  mime: string;
  size: number;
}

interface AssetStore {
  files: Map<string, StoredAsset>;
  total: number;
  replaced: number;
  missing: number;
}

interface LocalizedResource {
  reference: string;
  fact: PdfParseAssetFact | null;
}

function missingResource(
  store: AssetStore,
  context: SanitizeContext,
  vendorPath: string,
  pageNumber: number,
): LocalizedResource {
  store.missing += 1;
  context.warnings.push(
    diagnostic("parse-asset-missing", "warning", "fetch", `page-${pageNumber}/${vendorPath}`),
  );
  return { reference: MISSING_ASSET_PLACEHOLDER, fact: null };
}

/** 校验实际字节：PNG 先查像素预算再完整解码；JPEG 查完整首尾标记。 */
function imageKind(bytes: Buffer): { ext: string; mime: string } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > PNG_PIXEL_BUDGET)
      fatal("parse-asset-budget-exceeded", "fetch");
    try {
      PNG.sync.read(bytes);
    } catch {
      return null;
    }
    return { ext: "png", mime: "image/png" };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  )
    return { ext: "jpg", mime: "image/jpeg" };
  return null;
}

function storeAsset(
  bytes: Buffer,
  store: AssetStore,
  context: SanitizeContext,
  vendorPath: string,
  pageNumber: number,
): LocalizedResource {
  if (bytes.length > ASSET_BUDGET) fatal("parse-asset-budget-exceeded", "fetch");
  const kind = imageKind(bytes);
  if (!kind) return missingResource(store, context, vendorPath, pageNumber);
  const sha256 = hash(bytes);
  const existing = store.files.get(sha256);
  if (existing) {
    store.replaced += 1;
    return {
      reference: existing.path,
      fact: {
        vendorPath,
        path: existing.path,
        sha256,
        size: existing.size,
        mime: existing.mime,
      },
    };
  }
  if (store.total + bytes.length > SNAPSHOT_ASSET_BUDGET)
    fatal("parse-asset-budget-exceeded", "fetch");
  store.total += bytes.length;
  const stored: StoredAsset = {
    path: `assets/${sha256}.${kind.ext}`,
    bytes,
    mime: kind.mime,
    size: bytes.length,
  };
  store.files.set(sha256, stored);
  store.replaced += 1;
  return {
    reference: stored.path,
    fact: { vendorPath, path: stored.path, sha256, size: stored.size, mime: stored.mime },
  };
}

/** 受控资产下载：拒绝重定向；声明与实际字节都必须有界；网络失败交由占位 warning。 */
async function fetchAsset(
  url: string,
  signal: AbortSignal | undefined,
  dispatcher: Dispatcher | undefined,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      redirect: "manual",
      signal: requestSignal,
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("parse-asset-fetch-failed");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    fatal("parse-resource-redirect-rejected", "fetch");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("parse-asset-fetch-failed");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > ASSET_BUDGET)) {
    await response.body?.cancel().catch(() => undefined);
    fatal("parse-asset-budget-exceeded", "fetch");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > ASSET_BUDGET) {
        exceeded = true;
        break;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ParseFatalError) throw error;
    if (signal?.aborted) throw error;
    throw new Error("parse-asset-fetch-failed");
  }
  if (exceeded) {
    // break 已释放迭代器锁；cancel 尽力中止传输，其失败不掩盖预算拒绝。
    await response.body?.cancel().catch(() => undefined);
    fatal("parse-asset-budget-exceeded", "fetch");
  }
  return Buffer.concat(chunks);
}

async function localizeValue(
  input: PublishParseSnapshotInput,
  value: unknown,
  store: AssetStore,
  context: SanitizeContext,
  vendorPath: string,
  pageNumber: number,
): Promise<LocalizedResource> {
  if (typeof value !== "string" || !value)
    return missingResource(store, context, vendorPath, pageNumber);
  if (/^https?:\/\//i.test(value)) {
    let url: string;
    try {
      url = resultResource(value, input.task.endpoint);
    } catch {
      fatal("parse-resource-url-rejected", "fetch");
    }
    let bytes: Buffer;
    try {
      bytes = await fetchAsset(url, input.signal, input.dispatcher);
    } catch (error) {
      if (error instanceof ParseFatalError) throw error;
      if (input.signal?.aborted) throw error;
      return missingResource(store, context, vendorPath, pageNumber);
    }
    return storeAsset(bytes, store, context, vendorPath, pageNumber);
  }
  const dataUri = /^data:image\/(?:png|jpeg|jpg);base64,/i.exec(value);
  if (dataUri) {
    const base64 = value.slice(dataUri[0].length);
    if (base64.length > BASE64_ASSET_CHARS) fatal("parse-asset-budget-exceeded", "fetch");
    return storeAsset(Buffer.from(base64, "base64"), store, context, vendorPath, pageNumber);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) fatal("parse-resource-url-rejected", "fetch");
  if (value.length > BASE64_ASSET_CHARS) fatal("parse-asset-budget-exceeded", "fetch");
  return storeAsset(Buffer.from(value, "base64"), store, context, vendorPath, pageNumber);
}

/** 第二遍：资源本地化与受管响应重建；正文、页／块顺序与几何事实逐字保留。 */
async function localizeRows(
  input: PublishParseSnapshotInput,
  rows: ValidatedRow[],
  context: SanitizeContext,
) {
  const store: AssetStore = { files: new Map(), total: 0, replaced: 0, missing: 0 };
  const sanitizedRows: unknown[] = [];
  const factsPages: PdfParsePageFact[] = [];
  for (const row of rows) {
    const sanitizedPages: unknown[] = [];
    for (const page of row.pages) {
      input.signal?.throwIfAborted();
      const assetFacts: PdfParseAssetFact[] = [];
      let localizedImages: Record<string, string> | null = null;
      if (page.images !== null) {
        localizedImages = {};
        for (const [vendorPath, value] of Object.entries(page.images)) {
          const localized = await localizeValue(
            input,
            value,
            store,
            context,
            vendorPath,
            page.pageNumber,
          );
          localizedImages[vendorPath] = localized.reference;
          if (localized.fact) assetFacts.push(localized.fact);
        }
      }
      sanitizedPages.push({
        prunedResult: {
          width: page.width,
          height: page.height,
          model_settings: page.settings,
          parsing_res_list: page.blocks.map((block) => ({
            block_label: block.label,
            block_content: block.content,
            block_bbox: block.bbox,
            block_id: block.id,
            block_order: block.order,
            group_id: block.groupId,
          })),
        },
        ...(localizedImages === null ? {} : { markdown: { images: localizedImages } }),
      });
      const blockFacts: PdfParseBlockFact[] = page.blocks.map((block) => ({
        blockId: block.id,
        label: block.label,
        order: block.order,
        groupId: block.groupId,
        bbox: block.bbox,
      }));
      factsPages.push({
        page: page.pageNumber,
        width: page.width,
        height: page.height,
        modelSettings: page.settings,
        blocks: blockFacts,
        assets: assetFacts,
      });
    }
    sanitizedRows.push({
      result: {
        dataInfo: {
          type: "pdf",
          numPages: row.pages.length,
          pages: row.pages.map((page) => ({ width: page.width, height: page.height })),
        },
        layoutParsingResults: sanitizedPages,
      },
    });
  }
  return { sanitizedRows, factsPages, store };
}

async function attachSnapshot(
  input: PublishParseSnapshotInput,
  snapshot: PdfParseSourceSnapshotRecord,
  diagnostics: ImportDiagnostic[],
): Promise<ParseSnapshotResult> {
  input.task.parseSourceSnapshotId = snapshot.sourceSnapshotId;
  input.task.sanitizedSha256 = snapshot.sanitizedSha256;
  delete input.task.diagnostic;
  await saveTask(input.root, input.task);
  return { ok: true, snapshot, task: input.task, diagnostics };
}

/** 去敏并本地化云端解析响应，发布不可变解析快照（SPEC-pdf-import §4）。
 * 含密原始响应只存在于内存；致命失败保留任务现场，不发布快照。 */
export async function publishParseSnapshot(
  input: PublishParseSnapshotInput,
): Promise<ParseSnapshotResult> {
  const { task } = input;
  if (task.phase !== "downloaded" || task.jobId === undefined || task.responseSha256 === undefined)
    throw new Error("只有已下载且记录摘要的 PDF 解析任务可以发布解析快照。");
  try {
    if (
      hash(input.response.bytes) !== input.response.sha256 ||
      input.response.sha256 !== task.responseSha256
    )
      fatal("parse-response-digest-mismatch");
    const existing = await findBatchParseSnapshot(input.root, task);
    if (existing)
      return attachSnapshot(input, existing, readDiagnosticArray(existing.diagnostics));
    const parent = await readSourceSnapshot(input.root, task.parentSourceSnapshotId);
    if (
      parent.kind !== "pdf" ||
      parent.sha256 !== task.pdfSha256 ||
      typeof parent.pageCount !== "number" ||
      !Number.isSafeInteger(parent.pageCount) ||
      parent.pageCount < 1 ||
      parent.pageCount > 1000
    )
      throw new Error("父 PDF 来源快照无效，不能发布解析快照。");
    input.signal?.throwIfAborted();
    const context: SanitizeContext = { dropped: 0, warnings: [] };
    const rows = validateRows(input.response.bytes, input.signal, context);
    const pageCount = rows.reduce((total, row) => total + row.pages.length, 0);
    if (pageCount !== parent.pageCount) fatal("parse-page-count-mismatch");
    const { sanitizedRows, factsPages, store } = await localizeRows(input, rows, context);
    const resultBytes = Buffer.from(
      sanitizedRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const facts: PdfParseFactsFile = { formatVersion: 1, pageCount, pages: factsPages };
    const factsBytes = Buffer.from(JSON.stringify(facts, null, 2) + "\n");
    const sanitizedSha256 = hash(resultBytes);
    const files: Record<string, ManagedFileContent> = {
      "result.jsonl": { bytes: resultBytes, mime: "application/x-ndjson" },
      "facts.json": { bytes: factsBytes, mime: "application/json" },
    };
    for (const asset of store.files.values())
      files[asset.path] = { bytes: asset.bytes, mime: asset.mime };
    const diagnostics =
      context.dropped > 0
        ? [...context.warnings, diagnostic("parse-response-fields-dropped", "warning", "snapshot")]
        : context.warnings;
    const published = await publishSourceSnapshot(
      {
        root: input.root,
        files,
        metadata: {
          kind: "pdf-parse",
          parentSourceSnapshotId: task.parentSourceSnapshotId,
          parseBatchId: task.parseBatchId,
          provider: task.provider,
          model: task.model,
          jobId: task.jobId,
          options: { ...task.options },
          pageCount,
          responseSha256: input.response.sha256,
          sanitizedSha256,
          sanitization: {
            replaced: store.replaced,
            missing: store.missing,
            dropped: context.dropped,
          },
          diagnostics,
        },
      },
      input.hooks ?? {},
    );
    return attachSnapshot(
      input,
      published as PdfParseSourceSnapshotRecord,
      diagnostics,
    );
  } catch (error) {
    if (input.signal?.aborted)
      return { ok: false, diagnostic: diagnostic("parse-stopped", "fatal", "snapshot"), task };
    if (error instanceof ParseFatalError) {
      const failure = diagnostic(error.code, "fatal", error.stage);
      task.diagnostic = failure;
      await saveTask(input.root, task);
      return { ok: false, diagnostic: failure, task };
    }
    throw error;
  }
}