// 来源诊断收集（SPEC-reader §7，paper-30min-qa3.4）：从 Full 投影收集可行动诊断，
// 每条锚定受影响 block/unit/atom；进程中立，不读 DOM、不发请求。
// 诊断只陈述事实与限制，不产生质量分数或“已验证”结论。
import type { ReaderProjection } from "./projection.js";

export interface ReaderDiagnostic {
  /** 稳定代码：同类诊断可筛选汇总。 */
  code:
    | "figure-missing"
    | "figure-warning"
    | "formula-render-failed"
    | "reference-unresolved"
    | "link-disabled"
    | "raw-limited";
  message: string;
  /** 受影响节点锚点（block 或 unit）；汇总入口据此定位。 */
  blockId: string;
  unitId?: string;
}

/** 收集投影内全部结构化诊断；KaTeX 渲染失败由渲染层另行补充（同一代码）。 */
export function collectReaderDiagnostics(projection: ReaderProjection): ReaderDiagnostic[] {
  const diagnostics: ReaderDiagnostic[] = [];
  for (const item of projection.items) {
    if (item.kind === "figure") {
      if (!item.asset)
        diagnostics.push({
          code: "figure-missing",
          message: item.warning ?? "图片资产缺失，保留占位与来源说明。",
          blockId: item.blockId,
        });
      else if (item.warning)
        diagnostics.push({ code: "figure-warning", message: item.warning, blockId: item.blockId });
    }
    if (item.kind === "raw")
      diagnostics.push({
        code: "raw-limited",
        message: `raw block 按白名单投影：${item.limitations.join("；")}`,
        blockId: item.blockId,
      });
    const units = item.kind === "unit" ? [item]
      : item.kind === "table" ? [...(item.caption ? [item.caption] : []), ...Object.values(item.cells)]
      : item.kind === "figure" && item.caption ? [item.caption]
      : [];
    for (const unit of units)
      for (const sentence of unit.sentences)
        for (const part of sentence.parts) {
          if (part.kind !== "atom" || !part.atom.warning) continue;
          diagnostics.push({
            code: part.atom.kind === "link" ? "link-disabled" : "reference-unresolved",
            message: part.atom.warning,
            blockId: item.blockId,
            unitId: unit.unitId,
          });
        }
  }
  return diagnostics;
}
