// 来源候选冲突宿主（SPEC-reader §9，paper-30min-qa3.4）：候选与 current 明确区分；
// 冲突按原文阅读顺序逐项呈现 base/current/candidate，显式选择保留哪一方；
// 未解决计数始终可见，全部解决后才可发布；发布前主进程复核 baseRevision。
// 解决状态经 coreCandidateResolve 落盘；发布成功后 reader 按新 changeset 恢复。
import { useMemo, useState } from "react";
import type { DocumentMergeResult, MergeConflict } from "../../shared/document/merge";
import type { DocumentTree } from "../../shared/document/tree";
import type { ArxivUpdatePublishCommandResult } from "../../shared/contracts";
import { Button } from "../ui/Button";
import { EmptyState, InlineMessage } from "../ui/Feedback";

const desktop = window.desktop;

type CandidateSummary = DocumentMergeResult & { root: string; sourceSnapshotId: string };

const conflictTypeLabels: Record<MergeConflict["type"], string> = {
  content: "内容冲突",
  deletion: "删除冲突",
  order: "顺序冲突",
  structure: "结构冲突",
  asset: "资产冲突",
};

/** 阅读块坐标：每个 unit/block 映射到其所在阅读块下标（同一坐标系）。
 * 一次预计算，全部冲突共用；缺失锚点排到末尾而不是跳到最前。 */
function readingPositions(tree: DocumentTree): Map<string, number> {
  const positions = new Map<string, number>();
  tree.blocks.forEach((block, index) => {
    positions.set(`block:${block.id}`, index);
    const units =
      block.kind === "unit"
        ? [block.unitId]
        : block.kind === "figure"
          ? block.captionUnitId
            ? [block.captionUnitId]
            : []
          : block.kind === "table"
            ? [...(block.captionUnitId ? [block.captionUnitId] : []), ...block.rows.flat().map((cell) => cell.unitId)]
            : [];
    for (const unitId of units) if (!positions.has(`unit:${unitId}`)) positions.set(`unit:${unitId}`, index);
  });
  return positions;
}

function conflictOrder(positions: Map<string, number>, tree: DocumentTree, conflict: MergeConflict): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const anchor of conflict.anchors) {
    if (anchor.kind === "unit") best = Math.min(best, positions.get(`unit:${anchor.unitId}`) ?? best);
    if (anchor.kind === "block") best = Math.min(best, positions.get(`block:${anchor.blockId}`) ?? best);
    if (anchor.kind === "section") {
      const section = tree.sections[anchor.sectionId];
      if (section) for (const unitId of section.unitIds) best = Math.min(best, positions.get(`unit:${unitId}`) ?? best);
    }
  }
  return best;
}

/** 单元快照的可读文本：句子按阅读顺序拼接，atom 用显示文本。 */
function snapshotText(value: unknown, tree: DocumentTree | null): string {
  if (value === null || value === undefined) return "（该方不存在此内容）";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => snapshotText(entry, tree)).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // unit 快照：sentences 数组含 content。
    if (Array.isArray(record.sentences)) {
      return (record.sentences as Array<Record<string, unknown>>)
        .map((sentence) => {
          const content = sentence.content;
          if (!Array.isArray(content)) return "";
          return (content as Array<Record<string, unknown>>)
            .map((part) =>
              part.kind === "text"
                ? String(part.text ?? "")
                : part.kind === "atom" && part.content && typeof part.content === "object"
                  ? String((part.content as Record<string, unknown>).text ?? "")
                  : "",
            )
            .join("");
        })
        .join(" ");
    }
    // 块快照：figure 资产或 unit 引用。
    if (record.kind === "figure") {
      const asset = record.asset as Record<string, unknown> | null;
      return asset ? `图片资产 ${String(asset.path)}（${String(asset.mime)}）` : "（无资产）";
    }
    if (record.kind === "unit" && typeof record.unitId === "string" && tree) {
      const unit = tree.units[record.unitId];
      if (unit)
        return unit.sentenceIds
          .map((sentenceId) => {
            const sentence = tree.sentences[sentenceId];
            return sentence.content
              .map((part) => (part.kind === "text" ? part.text : tree.atoms[part.atomId].text))
              .join("");
          })
          .join(" ");
    }
    if (typeof record.title === "string") return `章节「${record.title}」`;
    if (typeof record.text === "string") return record.text;
    if (typeof record.path === "string") return String(record.path);
    return JSON.stringify(value, null, 1).slice(0, 600);
  }
  return String(value);
}

function AssetPreview({
  root,
  candidateRevisionId,
  value,
  label,
}: {
  root: string;
  candidateRevisionId: string;
  value: unknown;
  label: string;
}) {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const asset =
    record?.kind === "figure"
      ? (record.asset as Record<string, unknown> | null)
      : record && typeof record.path === "string"
        ? record
        : null;
  if (!asset || typeof asset.path !== "string") {
    return (
      <EmptyState className="conflict-side-empty">
        {label}：{snapshotText(value, null)}
      </EmptyState>
    );
  }
  const src =
    "paper30min://project/image?" +
    new URLSearchParams({
      root,
      path: `update-candidates/${candidateRevisionId}/${asset.path}`,
    });
  return (
    <figure className="conflict-asset">
      <figcaption>
        {label}：<code>{asset.path}</code>
      </figcaption>
      <img src={src} alt={`${label} 资产预览`} loading="lazy" />
    </figure>
  );
}

function ConflictSide({
  label,
  value,
  tree,
  root,
  candidateRevisionId,
  isAsset,
}: {
  label: string;
  value: unknown;
  tree: DocumentTree | null;
  root: string;
  candidateRevisionId: string;
  isAsset: boolean;
}) {
  return (
    <div className="conflict-side">
      <h4>{label}</h4>
      {isAsset ? (
        <AssetPreview root={root} candidateRevisionId={candidateRevisionId} value={value} label={label} />
      ) : (
        <pre className="conflict-text">{snapshotText(value, tree)}</pre>
      )}
    </div>
  );
}

export function ConflictHost({
  root,
  candidate,
  currentTree,
  onCandidateChange,
  onClose,
  onPublished,
}: {
  root: string;
  candidate: CandidateSummary;
  currentTree: DocumentTree;
  /** 解决状态提升到 reader：revision 重读不重置已落盘的解决结果。 */
  onCandidateChange: (next: CandidateSummary) => void;
  onClose: () => void;
  onPublished: (revisionId: string) => void;
}) {
  const state = candidate;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [baselineBroken, setBaselineBroken] = useState(false);
  const [previewOrder, setPreviewOrder] = useState(false);

  const ordered = useMemo(() => {
    const positions = readingPositions(currentTree);
    const list = [...state.conflicts];
    list.sort(
      (a, b) =>
        conflictOrder(positions, currentTree, a) - conflictOrder(positions, currentTree, b) || a.id.localeCompare(b.id),
    );
    return list;
  }, [state.conflicts, currentTree]);
  const unresolved = ordered.filter((conflict) => !state.resolutions[conflict.id]);

  async function resolve(conflictId: string, choice: "current" | "candidate") {
    setBusy(true);
    setError("");
    try {
      const next = await desktop.invoke<CandidateSummary>({
        type: "coreCandidateResolve",
        root,
        revisionId: state.revisionId,
        conflictId,
        choice,
      });
      onCandidateChange(next);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setError("");
    try {
      const result = await desktop.invoke<ArxivUpdatePublishCommandResult>({
        type: "coreArxivPublishCandidate",
        root,
        revisionId: state.revisionId,
        sourceSnapshotId: state.sourceSnapshotId,
        baseRevision: state.baseRevision,
      });
      if (!result.ok) {
        setError(result.diagnostic.messageKey);
        if (/baseMismatch|baseRevision/.test(result.diagnostic.messageKey + result.diagnostic.code))
          setBaselineBroken(true);
        return;
      }
      onPublished(result.revision.revisionId);
    } catch (e) {
      const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
      setError(message);
      if (/baseRevision/.test(message)) setBaselineBroken(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="conflict-host" aria-label="来源候选冲突">
      <header className="conflict-header">
        <h2>
          来源候选 <code>{state.revisionId.slice(0, 8)}</code>
        </h2>
        <p className="conflict-baseline">
          基线 current <code>{state.baseRevision.slice(0, 8)}</code>；查看与解决冲突不会推进 current。
        </p>
        <Button type="button" onClick={onClose}>
          返回阅读
        </Button>
      </header>
      <InlineMessage className="conflict-count">
        冲突 {ordered.length} 项，未解决 <strong>{unresolved.length}</strong> 项。
        {unresolved.length > 0 ? "全部逐项解决后才能发布。" : "全部已解决，可以预览并发布。"}
      </InlineMessage>
      {baselineBroken && (
        <InlineMessage variant="error" className="conflict-error">
          current 已被另一操作推进：已选解决结果保留，但不能套用到新基线。请基于新 current 重新构建候选。
        </InlineMessage>
      )}
      {error && (
        <InlineMessage variant="error" className="conflict-error">
          {error}
        </InlineMessage>
      )}
      <ol className="conflict-list">
        {ordered.map((conflict) => {
          const choice = state.resolutions[conflict.id];
          const isAsset = conflict.type === "asset";
          return (
            <li
              key={conflict.id}
              className={`conflict-item ${choice ? "resolved" : "unresolved"}`}
              data-conflict-id={conflict.id}
            >
              <div className="conflict-item-header">
                <span className={`conflict-type conflict-type-${conflict.type}`}>
                  {conflictTypeLabels[conflict.type]}
                </span>
                <code>{conflict.id}</code>
                <span className="conflict-state">
                  {choice ? `已选择：${choice === "current" ? "保留 current" : "采用 candidate"}` : "未解决"}
                </span>
              </div>
              <div className="conflict-sides">
                <ConflictSide
                  label="base（来源基线）"
                  value={conflict.base}
                  tree={state.base}
                  root={root}
                  candidateRevisionId={state.revisionId}
                  isAsset={isAsset}
                />
                <ConflictSide
                  label="current（含本地修正）"
                  value={conflict.current}
                  tree={state.current}
                  root={root}
                  candidateRevisionId={state.revisionId}
                  isAsset={isAsset}
                />
                <ConflictSide
                  label="candidate（新来源）"
                  value={conflict.candidate}
                  tree={state.sourceBase}
                  root={root}
                  candidateRevisionId={state.revisionId}
                  isAsset={isAsset}
                />
              </div>
              <div className="conflict-actions" role="group" aria-label={`解决冲突 ${conflict.id}`}>
                <Button
                  type="button"
                  disabled={busy || choice === "current"}
                  aria-pressed={choice === "current"}
                  className={choice === "current" ? "selected" : ""}
                  onClick={() => void resolve(conflict.id, "current")}
                >
                  保留 current
                </Button>
                <Button
                  type="button"
                  disabled={busy || choice === "candidate"}
                  aria-pressed={choice === "candidate"}
                  className={choice === "candidate" ? "selected" : ""}
                  onClick={() => void resolve(conflict.id, "candidate")}
                >
                  采用 candidate
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      {ordered.length === 0 && (
        <EmptyState className="conflict-empty">
          候选与 current 无冲突；确认后将按 changeset 发布新 revision。
        </EmptyState>
      )}
      <div className="conflict-publish">
        <Button
          type="button"
          variant="primary"
          disabled={busy || unresolved.length > 0 || baselineBroken}
          onClick={() => void publish()}
        >
          发布候选为新 current
        </Button>
        <Button type="button" disabled={busy || unresolved.length > 0} onClick={() => setPreviewOrder(!previewOrder)}>
          {previewOrder ? "收起阅读流预览" : "预览发布后阅读流"}
        </Button>
      </div>
      {previewOrder && (
        <div className="conflict-order-preview" aria-label="发布后阅读流预览">
          <h3>发布后阅读流（{state.document.blocks.length} 块）</h3>
          <ol>
            {state.document.blocks.map((block) => (
              <li key={block.id}>
                <code>{block.kind}</code>
                <span>{snapshotText(block, state.document).slice(0, 120)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
