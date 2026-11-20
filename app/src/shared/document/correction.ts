// document-core 结构化修正命令契约（SPEC-document-core §6，SPEC-reader §8，
// paper-30min-qa3.4）。修正请求携带 baseRevision、目标锚点、预期原内容与替换操作；
// 预览与发布共用同一命令序列，发布前主进程按真实 current 重放并复核基线。
// 纯类型＋运行时校验，进程中立；不读磁盘、不渲染。
import type { DocumentTree } from "./tree.js";
import type { DocumentChangeset, Tombstone } from "./changeset.js";

type AtomNode = DocumentTree["atoms"][string];
type InlinePart = DocumentTree["sentences"][string]["content"][number];

/** 单元文字修正：atom 以受保护占位表达，只改文本；句子按确定性分段重切。 */
interface UnitTextEdit {
  type: "unit-text";
  unitId: string;
  /** 预期原逻辑内容（文本＋atom.text，按句子拼接）；不符即拒绝，不静默覆盖。 */
  expected: string;
  /** 替换后的完整单元文本；不得包含任何 atom 显示文本（占位受保护）。 */
  text: string;
}

/** 同类型 atom 内容修正：保留 ID 与顺序，只替换该类型的内容字段。 */
export type AtomEdit = {
  type: "atom";
  atomId: string;
  expected: AtomNode;
} & (
  | { kind: "math" | "inline-object"; text: string; source: { format: "latex" | "mathml" | "text"; value: string } }
  | { kind: "citation" | "cross-reference"; text: string; targetUnitId: string | null; sourceTarget?: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "footnote-reference"; text: string; targetUnitId: string }
);

/** 拆分单元：旧 unit/sentence ID 退役（split），新结构分配新 ID。 */
interface UnitSplitEdit {
  type: "unit-split";
  unitId: string;
  expected: string;
  /** 按顺序的新单元文本；每段独立成单元，atom 不得跨段。 */
  parts: string[];
}

/** 合并相邻单元：旧 ID 退役（merged），新单元承载拼接文本。 */
interface UnitMergeEdit {
  type: "unit-merge";
  unitIds: string[];
  expected: string[];
}

interface UnitDeleteEdit {
  type: "unit-delete";
  unitId: string;
  expected: string;
}

/** 移动单元到目标单元之前／之后（可跨章节）；内容不变保留 ID。 */
interface UnitMoveEdit {
  type: "unit-move";
  unitId: string;
  beforeUnitId?: string;
  afterUnitId?: string;
}

/** 图块资产替换：新资产内容寻址落盘，caption 与块 ID 不变。 */
interface FigureAssetEdit {
  type: "figure-asset";
  blockId: string;
  /** 新资产字节经 IPC 传入；路径与摘要由主进程按内容派生。 */
  bytes: Uint8Array;
  mime: string;
}

/** raw block 受控文本投影修正：不提供任意 HTML 源码编辑。 */
interface RawTextEdit {
  type: "raw-text";
  blockId: string;
  expected: string;
  text: string;
}

export type DocumentCorrection =
  | UnitTextEdit
  | AtomEdit
  | UnitSplitEdit
  | UnitMergeEdit
  | UnitDeleteEdit
  | UnitMoveEdit
  | FigureAssetEdit
  | RawTextEdit;

export function unitLogicalText(tree: DocumentTree, unitId: string): string {
  const unit = tree.units[unitId];
  if (!unit) throw new Error(`修正目标单元不存在：${unitId}。`);
  return unit.sentenceIds.map((sentenceId) => {
    const sentence = tree.sentences[sentenceId];
    return sentence.content.map((part: InlinePart) =>
      part.kind === "text" ? part.text : tree.atoms[part.atomId].text).join("");
  }).join(" ");
}

/** atom 占位令牌：携带稳定 atom ID，普通文本无法伪造或歧义匹配。
 * 修正文本必须按原顺序保留每个令牌恰好一次；缺失、重复或乱序都拒绝。 */
export function atomPlaceholderToken(atomId: string): string {
  return `⟦atom:${atomId}⟧`;
}

/** 单元的可编辑文本投影：atom 以占位令牌表达，普通文字原样保留。
 * 修正宿主与引擎共用同一投影，expected 校验也按此口径。 */
export function unitEditText(tree: DocumentTree, unitId: string): string {
  const unit = tree.units[unitId];
  if (!unit) throw new Error(`修正目标单元不存在：${unitId}。`);
  return unit.sentenceIds.map((sentenceId) =>
    tree.sentences[sentenceId].content.map((part: InlinePart) =>
      part.kind === "text" ? part.text : atomPlaceholderToken(part.atomId)).join(""),
  ).join(" ");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(message: string): never {
  throw new Error(`修正命令无效：${message}`);
}

function requireId(value: unknown, description: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`${description} 必须是稳定节点 ID。`);
  return value;
}

function requireText(value: unknown, description: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    invalid(`${description} 必须是非空文本。`);
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("命令必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

/** IPC 边界校验：renderer 输入不可信；类型收窄后再进入修正引擎。 */
export function parseDocumentCorrection(value: unknown): DocumentCorrection {
  const record = objectValue(value);
  switch (record.type) {
    case "unit-text":
      return {
        type: "unit-text",
        unitId: requireId(record.unitId, "unitId"),
        expected: requireText(record.expected, "expected", true),
        text: requireText(record.text, "text"),
      };
    case "unit-split": {
      if (!Array.isArray(record.parts) || record.parts.length < 2)
        invalid("拆分必须提供至少两个新单元文本。");
      return {
        type: "unit-split",
        unitId: requireId(record.unitId, "unitId"),
        expected: requireText(record.expected, "expected", true),
        parts: record.parts.map((part) => requireText(part, "parts")),
      };
    }
    case "unit-merge": {
      if (!Array.isArray(record.unitIds) || record.unitIds.length < 2)
        invalid("合并必须提供至少两个单元。");
      if (!Array.isArray(record.expected) || record.expected.length !== record.unitIds.length)
        invalid("合并的预期原内容必须与单元一一对应。");
      return {
        type: "unit-merge",
        unitIds: record.unitIds.map((id) => requireId(id, "unitIds")),
        expected: record.expected.map((text) => requireText(text, "expected", true)),
      };
    }
    case "unit-delete":
      return {
        type: "unit-delete",
        unitId: requireId(record.unitId, "unitId"),
        expected: requireText(record.expected, "expected", true),
      };
    case "unit-move": {
      const before = record.beforeUnitId === undefined ? undefined : requireId(record.beforeUnitId, "beforeUnitId");
      const after = record.afterUnitId === undefined ? undefined : requireId(record.afterUnitId, "afterUnitId");
      if ((before === undefined) === (after === undefined))
        invalid("移动必须且只能指定 beforeUnitId 或 afterUnitId 之一。");
      return {
        type: "unit-move",
        unitId: requireId(record.unitId, "unitId"),
        ...(before === undefined ? {} : { beforeUnitId: before }),
        ...(after === undefined ? {} : { afterUnitId: after }),
      };
    }
    case "figure-asset": {
      if (!(record.bytes instanceof Uint8Array) || record.bytes.byteLength === 0)
        invalid("资产替换必须携带非空字节。");
      // 硬预算在边界即拒绝：预览不得认证一条发布必然失败的命令（B3）。
      if (record.bytes.byteLength > 32 * 1024 * 1024)
        invalid("资产替换超过 32 MiB 预算。");
      return {
        type: "figure-asset",
        blockId: requireId(record.blockId, "blockId"),
        bytes: record.bytes,
        mime: requireText(record.mime, "mime"),
      };
    }
    case "raw-text":
      return {
        type: "raw-text",
        blockId: requireId(record.blockId, "blockId"),
        expected: requireText(record.expected, "expected", true),
        text: requireText(record.text, "text"),
      };
    case "atom": {
      const atomId = requireId(record.atomId, "atomId");
      const expected = objectValue(record.expected);
      const kind = record.kind;
      const text = requireText(record.text, "text", true);
      if (kind === "math" || kind === "inline-object") {
        const source = objectValue(record.source);
        if (source.format !== "latex" && source.format !== "mathml" && source.format !== "text")
          invalid("atom source.format 必须是 latex、mathml 或 text。");
        return {
          type: "atom", atomId, expected: expected as unknown as AtomNode, kind,
          text, source: { format: source.format, value: requireText(source.value, "source.value") },
        };
      }
      if (kind === "citation" || kind === "cross-reference") {
        const target = record.targetUnitId === null ? null : requireId(record.targetUnitId, "targetUnitId");
        const sourceTarget = record.sourceTarget === undefined
          ? undefined : requireText(record.sourceTarget, "sourceTarget");
        return {
          type: "atom", atomId, expected: expected as unknown as AtomNode, kind, text,
          targetUnitId: target,
          ...(sourceTarget === undefined ? {} : { sourceTarget }),
        };
      }
      if (kind === "link")
        return { type: "atom", atomId, expected: expected as unknown as AtomNode, kind, text, href: requireText(record.href, "href") };
      if (kind === "footnote-reference")
        return {
          type: "atom", atomId, expected: expected as unknown as AtomNode, kind, text,
          targetUnitId: requireId(record.targetUnitId, "targetUnitId"),
        };
      return invalid("atom 修正类型不受支持。");
    }
    default:
      return invalid("修正命令类型不受支持。");
  }
}

/** 经 IPC 的修正预览：staging 树与 changeset 可序列化，资产字节留在工程进程。 */
export interface CorrectionPreview {
  baseRevision: string;
  revisionId: string;
  document: DocumentTree;
  changeset: DocumentChangeset;
  tombstones: Tombstone[];
  /** 预览涉及的资产（新增替换）：摘要与 MIME，供界面展示，不含字节。 */
  assets: Array<{ path: string; sha256: string; mime: string; size: number }>;
}

/** 预览树相对基线的变化统计：发布确认界面按真实 changeset 呈现，不猜测影响。 */
export function summarizeCorrectionChangeset(changeset: DocumentChangeset) {
  const counts: Record<DocumentChangeset["changes"][number]["status"], number> = {
    retained: 0, moved: 0, changed: 0, removed: 0, added: 0, conflicted: 0,
  };
  for (const entry of changeset.changes) counts[entry.status] += 1;
  return counts;
}
