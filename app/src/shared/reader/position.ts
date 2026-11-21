// Full 阅读位置捕获与恢复（SPEC-reader §5，paper-30min-qa3.3）：
// 位置以 revisionId＋稳定锚点＋锚内相对偏移为权威；scrollTop 只作同布局辅助。
// 恢复按 changeset 状态：retained/moved 原锚点；changed 定位原节点并提示；
// removed 保留摘录与 tombstone，父 section 存在时显式回退，否则文首。
// 本模块进程中立：不读 DOM、不发请求；挂载与布局测量由 renderer 承担。
import type { DocumentTree } from "../document/tree.js";
import type { DocumentAnchor } from "../document/anchor.js";
import { deriveAnchorState, type DocumentChangeset, type NodeType, type Tombstone } from "../document/changeset.js";
import type { ReaderProjection } from "./projection.js";

/** 位置锚点：只允许导航级稳定锚点，不携带字符 range（range 属选区语义）。 */
export type ReadingPositionAnchor = Exclude<DocumentAnchor, { kind: "range" }>;

export interface ReadingPosition {
  revisionId: string;
  /** 语言视图；译文 revision 由 translation 契约补充，reader 不换算偏移。 */
  view: "source" | "translation";
  anchor: ReadingPositionAnchor;
  /** 捕获时锚点所属父 section（removed 回退规则的唯一依据）。 */
  parentSectionId: string | null;
  /** 捕获时的可读摘录：removed 后展示，不参与任何相似匹配。 */
  excerpt: string;
  /** 锚点顶部与视口的相对偏移（px）；只在恢复同锚点时使用。 */
  offsetWithinAnchor: number;
  /** 辅助诊断：同 revision 同布局优化，绝不跨 revision/语言复用。 */
  scrollTop: number;
  capturedAt: string;
}

export type ReadingPositionResolution =
  | { status: "restored"; anchor: ReadingPositionAnchor; offsetWithinAnchor: number }
  | { status: "changed"; anchor: ReadingPositionAnchor; offsetWithinAnchor: number; notice: string }
  | {
      status: "removed";
      notice: string;
      excerpt: string;
      tombstone: Tombstone | null;
      /** 父 section 仍存在时回到该 section；否则 null（回到文首）。 */
      fallback: Extract<ReadingPositionAnchor, { kind: "section" }> | null;
    };

export interface PositionRevisionContext {
  tree: DocumentTree;
  projection: ReaderProjection;
  /** 当前 revision 相对其 base 的 changeset；与捕获 revision 不一致时按存在性解析。 */
  changeset: DocumentChangeset;
  tombstones: Tombstone[];
}

/** 锚点主节点（removed 判定与 tombstone 查找的对象）。 */
function primaryNode(anchor: ReadingPositionAnchor): { nodeType: NodeType; nodeId: string } {
  switch (anchor.kind) {
    case "section":
      return { nodeType: "section", nodeId: anchor.sectionId };
    case "unit":
      return { nodeType: "unit", nodeId: anchor.unitId };
    case "sentence":
      return { nodeType: "sentence", nodeId: anchor.sentenceId };
    case "atom":
      return { nodeType: "atom", nodeId: anchor.atomId };
    case "block":
      return { nodeType: "block", nodeId: anchor.blockId };
  }
}

function nodeExists(tree: DocumentTree, nodeType: NodeType, nodeId: string): boolean {
  switch (nodeType) {
    case "section":
      return Boolean(tree.sections[nodeId]);
    case "unit":
      return Boolean(tree.units[nodeId]);
    case "sentence":
      return Boolean(tree.sentences[nodeId]);
    case "atom":
      return Boolean(tree.atoms[nodeId]);
    case "block":
      return tree.blocks.some((block) => block.id === nodeId);
  }
}

/** 解析捕获位置在目标 revision 中的落点。
 * 不做相似文本/最近段落匹配；changeset 覆盖捕获 revision 时按状态分类，
 * 跨多级 revision 链（changeset 不直接覆盖）时退化为存在性＋内容提示判定。 */
export function resolveReadingPosition(
  position: ReadingPosition,
  context: PositionRevisionContext,
): ReadingPositionResolution {
  const { tree, changeset, tombstones } = context;
  const primary = primaryNode(position.anchor);
  const exists = nodeExists(tree, primary.nodeType, primary.nodeId);
  const covered = changeset.baseRevision === position.revisionId;
  const status = covered
    ? changeset.changes.find((entry) => entry.nodeType === primary.nodeType && entry.nodeId === primary.nodeId)?.status
    : undefined;

  if (!exists || status === "removed" || status === "conflicted") {
    const tombstone =
      tombstones.find((entry) => entry.nodeType === primary.nodeType && entry.nodeId === primary.nodeId) ?? null;
    const parentAlive = position.parentSectionId !== null && Boolean(tree.sections[position.parentSectionId]);
    return {
      status: "removed",
      notice: parentAlive
        ? "原阅读位置已失效：目标内容已被删除，已回到所属章节开头。"
        : "原阅读位置已失效：目标内容与所属章节均已删除，已回到文首。",
      excerpt: position.excerpt,
      tombstone,
      fallback:
        parentAlive && position.parentSectionId ? { kind: "section", sectionId: position.parentSectionId } : null,
    };
  }
  if (covered) {
    // 单元/块锚点的依赖（句子、atom）内容变化同样构成 changed：
    // 节点自身指纹排除结构引用，仅看主节点会漏掉句内改写。
    const state = deriveAnchorState(tree, changeset, position.anchor);
    if (state === "stale" || state === "missing" || state === "invalid") {
      return {
        status: "changed",
        anchor: position.anchor,
        offsetWithinAnchor: position.offsetWithinAnchor,
        notice: "该位置内容已变化：已定位到原节点，请留意与摘录的差异。",
      };
    }
  }
  return { status: "restored", anchor: position.anchor, offsetWithinAnchor: position.offsetWithinAnchor };
}
