// 原文修正宿主（SPEC-reader §8，paper-30min-qa3.4）：默认只读，显式进入单元修正；
// atom 以受保护占位表达，单独入口编辑；结构操作经结构化命令与 changeset 预览；
// 草稿按页签保留，基线变化拒绝发布并要求重新读取，不静默覆盖 current。
import { useMemo, useState } from "react";
import type { DocumentTree } from "../../shared/document/tree";
import {
  atomPlaceholderToken,
  unitEditText,
  type AtomEdit,
  type DocumentCorrection,
} from "../../shared/document/correction";
import type { CorrectionPreview } from "../../shared/document/correction";
import { summarizeCorrectionChangeset } from "../../shared/document/correction";
import { getCorrectionDraft, setCorrectionDraft, type CorrectionAtomEditorDraft } from "./correction-draft";
import { Button } from "../ui/Button";
import { InlineMessage } from "../ui/Feedback";

const desktop = window.desktop;

type AtomNode = DocumentTree["atoms"][string];

const changeLabels: Record<string, string> = {
  retained: "保留",
  moved: "移动",
  changed: "内容变化",
  removed: "删除",
  added: "新增",
  conflicted: "冲突",
};

/** atom 受保护占位：携带 ID 的令牌，编辑文本必须按原顺序保留。 */
function atomPlaceholder(atom: AtomNode): string {
  return atomPlaceholderToken(atom.id);
}

function createAtomEditorDraft(atom: AtomNode): CorrectionAtomEditorDraft {
  return {
    atomId: atom.id,
    text: atom.text,
    value:
      atom.kind === "math" || atom.kind === "inline-object" ? atom.source.value : atom.kind === "link" ? atom.href : "",
    format: atom.kind === "math" || atom.kind === "inline-object" ? atom.source.format : "text",
  };
}

function AtomEditor({
  atom,
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  atom: AtomNode;
  draft: CorrectionAtomEditorDraft;
  onChange: (next: CorrectionAtomEditorDraft) => void;
  onSave: (edit: AtomEdit) => void;
  onCancel: () => void;
}) {
  const { text, value, format } = draft;
  const [error, setError] = useState("");
  function submit() {
    try {
      let edit: AtomEdit;
      if (atom.kind === "math" || atom.kind === "inline-object") {
        edit = { type: "atom", atomId: atom.id, expected: atom, kind: atom.kind, text, source: { format, value } };
      } else if (atom.kind === "link") {
        edit = { type: "atom", atomId: atom.id, expected: atom, kind: "link", text, href: value };
      } else if (atom.kind === "citation" || atom.kind === "cross-reference") {
        edit = {
          type: "atom",
          atomId: atom.id,
          expected: atom,
          kind: atom.kind,
          text,
          targetUnitId: atom.targetUnitId,
          ...(atom.kind === "cross-reference" && atom.sourceTarget ? { sourceTarget: atom.sourceTarget } : {}),
        };
      } else {
        edit = {
          type: "atom",
          atomId: atom.id,
          expected: atom,
          kind: "footnote-reference",
          text,
          targetUnitId: atom.targetUnitId,
        };
      }
      onSave(edit);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="correction-atom-editor" role="group" aria-label={`修正原子 ${atom.kind}`}>
      <p className="correction-atom-kind">原子类型：{atom.kind}（类型不可在此改变）</p>
      <label>
        显示文本（占位）
        <input className="ui-input" value={text} onChange={(e) => onChange({ ...draft, text: e.target.value })} />
      </label>
      {(atom.kind === "math" || atom.kind === "inline-object") && (
        <>
          <label>
            来源表示
            <textarea
              className="ui-input"
              value={value}
              onChange={(e) => onChange({ ...draft, value: e.target.value })}
              rows={3}
            />
          </label>
          <label>
            格式
            <select
              className="ui-input"
              value={format}
              onChange={(e) => onChange({ ...draft, format: e.target.value as typeof format })}
            >
              <option value="latex">latex</option>
              <option value="mathml">mathml</option>
              <option value="text">text</option>
            </select>
          </label>
        </>
      )}
      {atom.kind === "link" && (
        <label>
          链接地址（https/http/mailto）
          <input className="ui-input" value={value} onChange={(e) => onChange({ ...draft, value: e.target.value })} />
        </label>
      )}
      {(atom.kind === "citation" || atom.kind === "cross-reference" || atom.kind === "footnote-reference") && (
        <p className="correction-atom-target">
          目标：{atom.targetUnitId ? <code>{atom.targetUnitId.slice(0, 8)}</code> : "未解析（保留来源文本）"}
        </p>
      )}
      {error && (
        <InlineMessage variant="error" className="correction-error">
          {error}
        </InlineMessage>
      )}
      <div className="correction-actions">
        <Button type="button" variant="primary" onClick={submit}>
          保存原子修正
        </Button>
        <Button type="button" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

export function CorrectionHost({
  root,
  tab,
  tree,
  baseRevision,
  unitId,
  onClose,
  onPublished,
}: {
  root: string;
  tab: string;
  tree: DocumentTree;
  baseRevision: string;
  unitId: string;
  onClose: () => void;
  onPublished: (revisionId: string) => void;
}) {
  const unit = tree.units[unitId];
  const existing = getCorrectionDraft(root, tab);
  const usableDraft = existing !== null && existing.unitId === unitId ? existing : null;
  const staleDraft = usableDraft !== null && usableDraft.baseRevision !== baseRevision;
  // 目标可能已被删除：先按存在性兜底，恢复 UI 在 guard 分支呈现，不在初始化抛错。
  const original = unit ? unitEditText(tree, unitId) : "";
  // 基线变化时草稿文本与结构操作仍保留展示（SPEC §8.6）：用户重新读取后
  // 自行决定是否重新应用；只有预览/发布被禁止，不静默清空编辑。
  const [text, setText] = useState(() =>
    usableDraft
      ? ((usableDraft.corrections.find((edit) => edit.type === "unit-text") as { text: string } | undefined)?.text ??
        original)
      : original,
  );
  const [extraEdits, setExtraEdits] = useState<DocumentCorrection[]>(() =>
    usableDraft ? usableDraft.corrections.filter((edit) => edit.type !== "unit-text") : [],
  );
  const [atomEditor, setAtomEditor] = useState<CorrectionAtomEditorDraft | null>(usableDraft?.atomEditor ?? null);
  const atomEditing = atomEditor?.atomId ?? null;
  // 预览与固定命令随草稿恢复：reader 重挂载不丢失已预览的发布现场。
  const [previewState, setPreviewState] = useState<CorrectionPreview | null>(
    usableDraft && !staleDraft ? usableDraft.preview : null,
  );
  const preview = previewState;
  const [previewedEdits, setPreviewedEdits] = useState<DocumentCorrection[] | null>(
    usableDraft && !staleDraft && usableDraft.preview ? usableDraft.corrections : null,
  );
  // 任何编辑都使预览失效：发布只能基于最新命令重新预览。
  const setPreview = (value: CorrectionPreview | null) => {
    setPreviewState(value);
    if (value === null) setPreviewedEdits(null);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [baselineBroken, setBaselineBroken] = useState(staleDraft);

  const atoms = useMemo(() => {
    if (!unit) return [];
    return unit.sentenceIds.flatMap((sentenceId) =>
      tree.sentences[sentenceId].content.flatMap((part) => (part.kind === "atom" ? [tree.atoms[part.atomId]] : [])),
    );
  }, [tree, unit]);

  if (!unit) {
    return (
      <section className="correction-host" role="alert">
        <p>修正目标单元已不存在（可能已被删除）。请关闭修正模式重新选择。</p>
        <Button type="button" onClick={onClose}>
          关闭
        </Button>
      </section>
    );
  }

  function corrections(operations = extraEdits): DocumentCorrection[] {
    const edits: DocumentCorrection[] = [];
    // 先改字再拆分/删除是合法工作流：文字修正先行，结构命令的预期原内容
    // 取文字修正后的中间文本。拆分按空行切段时 trim 会去掉首尾空白，
    // 中间以各段拼接（单空格连接）为准。
    const split = operations.find((edit) => edit.type === "unit-split");
    const intermediate = split && split.type === "unit-split" ? split.parts.join(" ") : text;
    if (intermediate !== original) edits.push({ type: "unit-text", unitId, expected: original, text: intermediate });
    for (const edit of operations) {
      if (edit.type === "unit-split" || edit.type === "unit-delete") edits.push({ ...edit, expected: intermediate });
      else edits.push(edit);
    }
    return edits;
  }

  function persistDraft(
    next: DocumentCorrection[],
    previewValue: CorrectionPreview | null,
    editor: CorrectionAtomEditorDraft | null = atomEditor,
  ) {
    setCorrectionDraft(root, tab, {
      baseRevision: staleDraft && usableDraft ? usableDraft.baseRevision : baseRevision,
      unitId,
      corrections: next,
      previewRevisionId: previewValue?.revisionId ?? null,
      preview: previewValue,
      atomEditor: editor,
    });
  }

  function updateAtomEditor(next: CorrectionAtomEditorDraft | null) {
    setAtomEditor(next);
    persistDraft(corrections(), preview, next);
  }

  async function runPreview() {
    const edits = corrections();
    if (!edits.length) {
      setError("没有需要发布的修正：内容与原文一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await desktop.invoke<CorrectionPreview>({
        type: "coreCorrectionPreview",
        root,
        baseRevision,
        corrections: edits,
      });
      setPreview(result);
      setPreviewedEdits(edits);
      persistDraft(edits, result);
    } catch (e) {
      const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
      setError(message);
      if (/baseRevision/.test(message)) setBaselineBroken(true);
      // 草稿保留：预览失败不清空用户编辑。
      persistDraft(edits, preview);
    } finally {
      setBusy(false);
    }
  }

  async function runPublish() {
    if (atomEditor) {
      setError("请先保存或取消当前原子修正，再发布。");
      return;
    }
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const revision = await desktop.invoke<{ revisionId: string }>({
        type: "coreCorrectionPublish",
        root,
        baseRevision,
        revisionId: preview.revisionId,
        corrections: previewedEdits ?? corrections(),
      });
      setCorrectionDraft(root, tab, null);
      setPreview(null);
      onPublished(revision.revisionId);
    } catch (e) {
      const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
      setError(message);
      if (/baseRevision/.test(message)) setBaselineBroken(true);
      // 发布失败保留草稿与预览，要求重新读取或合并。
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setCorrectionDraft(root, tab, null);
    setPreview(null);
    onClose();
  }

  const counts = preview ? summarizeCorrectionChangeset(preview.changeset) : null;

  return (
    <section className="correction-host" aria-label="原文修正">
      <header className="correction-header">
        <h2>
          修正单元 <code>{unitId.slice(0, 8)}</code>
        </h2>
        <Button type="button" onClick={cancel}>
          取消修正
        </Button>
      </header>
      {baselineBroken && (
        <InlineMessage variant="error" className="correction-error">
          current 基线已变化：草稿已保留，但不能发布。请关闭后重新读取正文，再决定是否重新应用修正。
        </InlineMessage>
      )}
      <label className="correction-text-label">
        单元文本（atom 占位必须按原顺序保留）
        <textarea
          className="ui-input correction-text"
          value={text}
          rows={5}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            setPreview(null);
            // 每次编辑即落草稿：外部 revision 变化前未预览的编辑也不丢失。
            const edits: DocumentCorrection[] =
              next !== original
                ? [{ type: "unit-text", unitId, expected: original, text: next }, ...extraEdits]
                : [...extraEdits];
            persistDraft(edits, null);
          }}
        />
      </label>
      <div className="correction-atoms" role="group" aria-label="原子修正入口">
        {atoms.map((atom) => (
          <div key={atom.id} className="correction-atom-row">
            <span className="correction-atom-placeholder" data-atom-id={atom.id}>
              {atom.kind}：{atomPlaceholder(atom)}
            </span>
            <Button
              type="button"
              onClick={() => updateAtomEditor(atom.id === atomEditing ? null : createAtomEditorDraft(atom))}
            >
              {atom.id === atomEditing ? "收起" : "修正原子"}
            </Button>
            {atom.id === atomEditing && atomEditor && (
              <AtomEditor
                atom={atom}
                draft={atomEditor}
                onChange={updateAtomEditor}
                onCancel={() => updateAtomEditor(null)}
                onSave={(edit) => {
                  const next = [
                    ...extraEdits.filter((entry) => !(entry.type === "atom" && entry.atomId === edit.atomId)),
                    edit,
                  ];
                  setExtraEdits(next);
                  setAtomEditor(null);
                  setPreview(null);
                  persistDraft(corrections(next), null, null);
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="correction-structure" role="group" aria-label="结构操作">
        <Button
          type="button"
          disabled={atoms.length > 0}
          title={atoms.length > 0 ? "含原子的单元暂不支持拆分" : undefined}
          onClick={() => {
            const parts = text
              .split(/\n{2,}/)
              .map((part) => part.trim())
              .filter(Boolean);
            if (parts.length < 2) {
              setError("拆分需要至少两段：请用空行分隔单元文本。");
              return;
            }
            const next: DocumentCorrection[] = [
              ...extraEdits,
              { type: "unit-split", unitId, expected: original, parts },
            ];
            setExtraEdits(next);
            setPreview(null);
            persistDraft(corrections(next), null);
            setError("");
          }}
        >
          按空行拆分为多单元
        </Button>
        <Button
          type="button"
          onClick={() => {
            const next: DocumentCorrection[] = [...extraEdits, { type: "unit-delete", unitId, expected: original }];
            setExtraEdits(next);
            setPreview(null);
            persistDraft(corrections(next), null);
          }}
        >
          删除该单元
        </Button>
        {extraEdits.length > 0 && (
          <Button
            type="button"
            onClick={() => {
              setExtraEdits([]);
              setPreview(null);
              persistDraft(corrections([]), null);
            }}
          >
            清除结构操作
          </Button>
        )}
      </div>
      {extraEdits.length > 0 && (
        <ul className="correction-pending">
          {extraEdits.map((edit, index) => (
            <li key={index}>
              待发布结构操作：<code>{edit.type}</code>
              {edit.type === "unit-split" && `（${edit.parts.length} 段）`}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <InlineMessage variant="error" className="correction-error">
          {error}
        </InlineMessage>
      )}
      <div className="correction-actions">
        <Button type="button" variant="primary" disabled={busy || baselineBroken} onClick={() => void runPreview()}>
          预览 changeset
        </Button>
        <Button
          type="button"
          disabled={busy || !preview || baselineBroken || atomEditor !== null}
          onClick={() => void runPublish()}
        >
          确认发布新 revision
        </Button>
      </div>
      {preview && counts && (
        <div className="correction-preview" aria-label="修正预览">
          <h3>
            预览：{preview.revisionId.slice(0, 8)}（基线 {preview.baseRevision.slice(0, 8)}）
          </h3>
          <ul className="correction-counts">
            {Object.entries(counts)
              .filter(([, count]) => count > 0)
              .map(([status, count]) => (
                <li key={status}>
                  <span className={`correction-status correction-status-${status}`}>
                    {changeLabels[status] ?? status}
                  </span>
                  {count} 个节点
                </li>
              ))}
          </ul>
          {preview.changeset.changes.filter((entry) => entry.status === "removed").length > 0 && (
            <p className="correction-removed-note">
              删除/拆分/合并的旧锚点将退役（tombstone {preview.tombstones.length} 条）；旧精确选区不自动调整偏移。
            </p>
          )}
          {preview.assets.length > 0 && (
            <ul className="correction-assets">
              {preview.assets.map((asset) => (
                <li key={asset.path}>
                  <code>{asset.path}</code>（{asset.mime}，{asset.size} 字节）
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
