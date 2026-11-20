// 修正草稿按页签保留（SPEC-reader §8.6）：renderer 内存中按 root＋tab 键控，
// 取消不修改 current；revision 变化时草稿保留并要求重新读取，不静默覆盖。
// 本模块只存草稿状态，不写受管文件；发布经 coreCorrectionPublish 命令。
import type { CorrectionPreview, DocumentCorrection } from "../../shared/document/correction.js";

export interface CorrectionDraft {
  /** 草稿创建时的 current 基线；发布前必须仍等于 current。 */
  baseRevision: string;
  /** 目标单元（修正宿主一次编辑一个单元）。 */
  unitId: string;
  /** 结构化命令序列（预览与发布共用）。 */
  corrections: DocumentCorrection[];
  /** 预览固定的候选身份；发布沿用同一 ID。 */
  previewRevisionId: string | null;
  /** 已成功的预览（含 changeset 与候选身份）：重挂载后仍可核对与发布。 */
  preview: CorrectionPreview | null;
}

const drafts = new Map<string, CorrectionDraft>();

const key = (root: string, tab: string) => `${root}\u0000${tab}`;

export function getCorrectionDraft(root: string, tab: string): CorrectionDraft | null {
  return drafts.get(key(root, tab)) ?? null;
}

export function setCorrectionDraft(root: string, tab: string, draft: CorrectionDraft | null): void {
  if (draft === null) drafts.delete(key(root, tab));
  else drafts.set(key(root, tab), draft);
}
