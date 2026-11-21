// arxiv-import 共享契约（SPEC-arxiv-import.md Code Style）。
// 纯类型，不得导入 Node 或 React 模块。

export interface ArxivReference {
  baseId: string;
  version: number | null;
  canonicalId: string;
}

/** 回退交接只携带身份事实（baseId/version/baseRevision）；下载 URL 由主进程
 * 按固定版本与受控 baseUrl 重建，renderer 传来的任何 URL 都不被信任。 */
export interface PdfFallbackRequest {
  kind: "arxiv-pdf";
  baseId: string;
  version: number;
  reasonCode: string;
  baseRevision: string | null;
}

export interface ImportDiagnostic {
  code: string;
  severity: "warning" | "fatal";
  stage: "resolve" | "fetch" | "snapshot" | "convert" | "validate" | "publish";
  messageKey: string;
  sourceAlias?: string;
  sourceUrl?: string;
  /** 底层失败原文（截断去敏后），供诊断定位；稳定 code/messageKey 仍是分类权威。 */
  errorDetail?: string;
}

const DIAGNOSTIC_STAGES = ["resolve", "fetch", "snapshot", "convert", "validate", "publish"] as const;

/** 受管记录中诊断的完整运行时校验（唯一权威规则，主进程与共享层共用）。 */
export function parseImportDiagnostic(value: unknown): ImportDiagnostic {
  if (value === null || typeof value !== "object") throw new Error("诊断记录无效。");
  const record: Record<string, unknown> = { ...value };
  if (
    typeof record.code !== "string" ||
    typeof record.messageKey !== "string" ||
    (record.severity !== "warning" && record.severity !== "fatal") ||
    !DIAGNOSTIC_STAGES.includes(record.stage as (typeof DIAGNOSTIC_STAGES)[number])
  ) {
    throw new Error("诊断记录无效。");
  }
  return {
    code: record.code,
    severity: record.severity,
    stage: record.stage as ImportDiagnostic["stage"],
    messageKey: record.messageKey,
    ...(typeof record.sourceAlias === "string" ? { sourceAlias: record.sourceAlias } : {}),
    ...(typeof record.sourceUrl === "string" ? { sourceUrl: record.sourceUrl } : {}),
    ...(typeof record.errorDetail === "string" ? { errorDetail: record.errorDetail } : {}),
  };
}

/** 读取受管记录中的诊断数组：字段缺失按空处理；字段存在但损坏必须抛错，
 * 不得静默清空警告完成恢复（SPEC 错误恢复契约）。 */
export function readDiagnosticArray(value: unknown): ImportDiagnostic[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("受管记录中的诊断数组损坏。");
  return value.map(parseImportDiagnostic);
}
