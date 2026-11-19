import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { ImportDiagnostic, PdfFallbackRequest } from "../../shared/arxiv.js";
import type {
  ManagedFileContent,
  PdfSourceSnapshotRecord,
} from "../../shared/contracts.js";
import {
  listSourceSnapshots,
  publishSourceSnapshot,
  type ProjectCommitHooks,
} from "../project-core.js";
import {
  ArxivFetchError,
  fetchDiagnostic,
  type ArxivTransport,
} from "../arxiv/fetch.js";
import { assertArxivVersionConsistent } from "../arxiv/version.js";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 1000;

type PdfArxivFacts = { baseId: string; version: number; pdfUrl: string };

export interface SnapshotLocalPdfInput {
  root: string;
  /** 用户显式选择的外部 PDF；只读取字节，不持久化其绝对路径。 */
  source: string;
  hooks?: ProjectCommitHooks;
}

export interface SnapshotArxivPdfInput {
  root: string;
  request: PdfFallbackRequest;
  transport: ArxivTransport;
  /** 受控端点基址：仅 fixture 门控开启时生效；生产省略即 https://arxiv.org。 */
  baseUrl?: string;
  signal?: AbortSignal;
  allowFixtureLoopback?: boolean;
  hooks?: ProjectCommitHooks;
}

export type PdfSnapshotResult =
  | {
      ok: true;
      reused: boolean;
      snapshot: PdfSourceSnapshotRecord;
      bodyReadable: false;
    }
  | { ok: false; diagnostic: ImportDiagnostic };

class PdfInspectionError extends Error {
  constructor(readonly code: string, readonly messageKey: string) {
    super(code);
    this.name = "PdfInspectionError";
  }
}

function failure(
  code: string,
  messageKey: string,
  stage: ImportDiagnostic["stage"] = "validate",
  sourceUrl?: string,
): PdfSnapshotResult {
  return {
    ok: false,
    diagnostic: {
      code,
      severity: "fatal",
      stage,
      messageKey,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
    },
  };
}

function inspectionFailure(error: unknown): PdfSnapshotResult {
  if (error instanceof PdfInspectionError)
    return failure(error.code, error.messageKey);
  return failure("pdf-inspection-failed", "pdf.inspection.failed");
}

async function inspectPdf(bytes: Uint8Array): Promise<number> {
  if (bytes.byteLength > MAX_PDF_BYTES)
    throw new PdfInspectionError("pdf-budget-exceeded", "pdf.budget.exceeded");
  if (bytes.byteLength < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-")
    throw new PdfInspectionError("pdf-invalid", "pdf.invalid");

  const [{ init }, { PdfEngine, PdfiumNative }] = await Promise.all([
    import("@embedpdf/pdfium"),
    import("@embedpdf/engines/pdfium"),
  ]);
  const wasmBinary = await fs.readFile(
    new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
  );
  const engine = new PdfEngine(new PdfiumNative(await init({ wasmBinary })), {
    imageConverter: async (getImage) => {
      const image = getImage();
      const png = new PNG({ width: image.width, height: image.height });
      png.data = Buffer.from(image.data);
      return PNG.sync.write(png);
    },
  });
  try {
    const document = await engine
      .openDocumentBuffer(
        {
          id: randomUUID(),
          content: new Uint8Array(bytes).buffer,
        },
        { normalizeRotation: true },
      )
      .toPromise();
    if (document.pages.length < 1 || document.pages.length > MAX_PDF_PAGES)
      throw new PdfInspectionError("pdf-page-count-invalid", "pdf.pages.invalid");
    return document.pages.length;
  } catch (error) {
    if (error instanceof PdfInspectionError) throw error;
    const reason =
      typeof error === "object" && error !== null && "reason" in error
        ? error.reason
        : undefined;
    const code =
      typeof reason === "object" && reason !== null && "code" in reason
        ? reason.code
        : undefined;
    const reasonMessage =
      typeof reason === "object" && reason !== null && "message" in reason
        ? reason.message
        : undefined;
    const message = `${error instanceof Error ? error.message : String(error)} ${typeof reasonMessage === "string" ? reasonMessage : ""}`;
    if (code === 4 || /password|encrypted/i.test(message))
      throw new PdfInspectionError("pdf-encrypted", "pdf.encrypted");
    throw new PdfInspectionError("pdf-invalid", "pdf.invalid");
  } finally {
    await engine.destroy().toPromise();
  }
}

function sameProvenance(
  existing: Record<string, unknown>,
  arxiv: PdfArxivFacts | undefined,
): boolean {
  const current = existing.arxiv;
  if (arxiv === undefined) return current === undefined;
  if (typeof current !== "object" || current === null) return false;
  return (
    "baseId" in current &&
    current.baseId === arxiv.baseId &&
    "version" in current &&
    current.version === arxiv.version
  );
}

async function publishPdf(input: {
  root: string;
  bytes: Uint8Array;
  originalName: string;
  arxiv?: PdfArxivFacts;
  hooks?: ProjectCommitHooks;
}): Promise<PdfSnapshotResult> {
  let pageCount: number;
  try {
    pageCount = await inspectPdf(input.bytes);
  } catch (error) {
    return inspectionFailure(error);
  }
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const files: Record<string, ManagedFileContent> = {
    "paper.pdf": { bytes: input.bytes, mime: "application/pdf" },
  };
  try {
    for (const existing of await listSourceSnapshots(input.root)) {
      if (
        existing.kind !== "pdf" ||
        existing.sha256 !== sha256 ||
        !sameProvenance(existing, input.arxiv)
      )
        continue;
      const [file, ...rest] = existing.files;
      if (
        rest.length !== 0 ||
        file?.path !== "paper.pdf" ||
        file.sha256 !== sha256 ||
        file.size !== input.bytes.byteLength
      ) {
        throw new Error("既有 PDF 来源快照的文件登记不完整。");
      }
      return {
        ok: true,
        reused: true,
        snapshot: existing as PdfSourceSnapshotRecord,
        bodyReadable: false,
      };
    }
    const snapshot = await publishSourceSnapshot(
      {
        root: input.root,
        files,
        metadata: {
          kind: "pdf",
          sha256,
          pageCount,
          originalName: input.originalName,
          ...(input.arxiv === undefined ? {} : { arxiv: input.arxiv }),
        },
      },
      input.hooks ?? {},
    );
    return {
      ok: true,
      reused: false,
      snapshot: snapshot as PdfSourceSnapshotRecord,
      bodyReadable: false,
    };
  } catch {
    return failure(
      "pdf-snapshot-publish-failed",
      "pdf.snapshot.publishFailed",
      "snapshot",
    );
  }
}

export async function snapshotLocalPdf(
  input: SnapshotLocalPdfInput,
): Promise<PdfSnapshotResult> {
  if (!path.isAbsolute(input.source))
    return failure("pdf-read-failed", "pdf.read.failed", "snapshot");
  let bytes: Buffer;
  try {
    const handle = await fs.open(input.source, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        return failure("pdf-read-failed", "pdf.read.failed", "snapshot");
      if (stat.size > MAX_PDF_BYTES)
        return failure("pdf-budget-exceeded", "pdf.budget.exceeded");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PdfInspectionError) return inspectionFailure(error);
    return failure("pdf-read-failed", "pdf.read.failed", "snapshot");
  }
  return publishPdf({
    root: input.root,
    bytes,
    originalName: path.basename(input.source),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
}

export async function snapshotArxivPdf(
  input: SnapshotArxivPdfInput,
): Promise<PdfSnapshotResult> {
  const { request } = input;
  if (request.kind !== "arxiv-pdf")
    return failure("pdf-fallback-invalid", "pdf.fallback.invalid", "resolve");
  if (!Number.isInteger(request.version) || request.version < 1)
    return failure("arxiv-version-unpinned", "arxiv.version.unpinned", "resolve");
  const pinned = {
    baseId: request.baseId,
    version: request.version,
    canonicalId: `${request.baseId}v${request.version}`,
  };
  // 下载 URL 由主进程按固定版本重建（renderer 不携带 URL）；baseUrl 仅在
  // 受控 fixture 门控开启时生效，生产恒为 https://arxiv.org。
  const pdfUrl = `${(input.baseUrl ?? "https://arxiv.org").replace(/\/+$/, "")}/pdf/${pinned.canonicalId}`;
  const requestGuard = assertArxivVersionConsistent(pinned, pdfUrl);
  if (!requestGuard.ok) return requestGuard;
  if (input.signal?.aborted) {
    return {
      ok: false,
      diagnostic: fetchDiagnostic(
        new ArxivFetchError("arxiv-fetch-cancelled", pdfUrl),
        pdfUrl,
        "pdf",
      ),
    };
  }

  let response;
  try {
    response = await input.transport(pdfUrl, {
      budgetBytes: MAX_PDF_BYTES,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.allowFixtureLoopback ? { allowFixtureLoopback: true } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      diagnostic: fetchDiagnostic(error, pdfUrl, "pdf"),
    };
  }
  const responseGuard = assertArxivVersionConsistent(pinned, response.url);
  if (!responseGuard.ok) return responseGuard;
  return publishPdf({
    root: input.root,
    bytes: response.bytes,
    originalName: `${pinned.canonicalId}.pdf`,
    arxiv: {
      baseId: pinned.baseId,
      version: pinned.version,
      pdfUrl: response.url,
    },
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
}
