import { useEffect, useMemo, useRef, useState } from "react";
import { invertedEffects } from "@codemirror/commands";
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { markdownRenderer as renderer } from "../shared/markdown-references";
import "katex/dist/katex.min.css";
import { isDirty, type MarkdownDraft } from "./useMarkdownDocuments";
import "./markdown.css";

const normalize = (text: string) => text.replace(/\r\n?|\n/g, "\n");
// Keep original line endings in CM state, including the native undo/redo history.
const restoreEndings = StateEffect.define<readonly string[]>();
const lineEndings = StateField.define<readonly string[]>({
  create: () => [],
  update(value, transaction) {
    const restored = transaction.effects
      .filter((effect) => effect.is(restoreEndings))
      .at(-1);
    if (restored) return restored.value;
    if (!transaction.docChanged) return value;
    let next: string[] = [];
    let end = 0;
    transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
      const startLine = transaction.startState.doc.lineAt(from).number - 1;
      next = next.concat(
        value.slice(end, startLine),
        Array<string>(inserted.lines - 1).fill(value[0] ?? "\n"),
      );
      end = transaction.startState.doc.lineAt(to).number - 1;
    });
    return next.concat(value.slice(end));
  },
});
function localPath(documentPath: string, href: string): string | null {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.includes("\\")
  )
    return null;
  const base = new URL(
    "https://project/" +
      documentPath.split("/").map(encodeURIComponent).join("/"),
  );
  const resolved = new URL(href, base);
  if (resolved.origin !== base.origin) return null;
  return decodeURIComponent(resolved.pathname.slice(1));
}

export function MarkdownDocument({
  root,
  draft,
  onChange,
  onSave,
  onOpen,
  onPosition,
}: {
  root: string;
  draft: MarkdownDraft;
  onChange: () => void;
  onSave: () => void;
  onOpen: (path: string) => void;
  onPosition: (position: {
    mode: MarkdownDraft["mode"];
    scroll: number;
    readScroll: number;
    cursor: number;
  }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);
  const [showConflict, setShowConflict] = useState(false);
  const [linkError, setLinkError] = useState("");
  const callbacks = useRef({ onChange, onSave, onPosition });
  callbacks.current = { onChange, onSave, onPosition };
  const positionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  function recordPosition() {
    clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(
      () =>
        callbacks.current.onPosition({
          mode: draft.mode,
          scroll: draft.scroll,
          readScroll: draft.readScroll,
          cursor: draft.cursor,
        }),
      180,
    );
  }
  const readOnly = /^sources\//i.test(draft.path);
  const editing = !readOnly && draft.mode !== "read";
  useEffect(() => {
    if (!host.current || !editing || !draft.file) return;
    const state =
      draft.editor ??
      EditorState.create({
        doc: normalize(draft.text),
        selection: {
          anchor: Math.min(draft.cursor, normalize(draft.text).length),
        },
        extensions: [
          basicSetup,
          lineEndings.init(() => draft.text.match(/\r\n|\r|\n/g) ?? []),
          invertedEffects.of((transaction) =>
            transaction.docChanged
              ? [restoreEndings.of(transaction.startState.field(lineEndings))]
              : [],
          ),
          markdown(),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            compositionstart() { draft.composing = true; callbacks.current.onChange(); },
            compositionend() { draft.composing = false; callbacks.current.onChange(); },
          }),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown 源码",
            spellcheck: "false",
          }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
          ]),
          EditorView.theme({
            "&": { height: "100%", fontSize: "14px" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "Consolas, 'Microsoft YaHei', monospace",
            },
            ".cm-content": { padding: "18px 0" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
              { backgroundColor: "#dcd8ef !important" },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const endings = update.state.field(lineEndings);
              let index = 0;
              draft.text = update.state.doc
                .toString()
                .replace(/\n/g, () => endings[index++]);
              callbacks.current.onChange();
            }
            draft.editor = update.state;
            draft.cursor = update.state.selection.main.head;
          }),
        ],
      });
    const view = new EditorView({ state, parent: host.current });
    view.scrollDOM.scrollTop = draft.scroll;
    const scrolled = () => {
      draft.scroll = view.scrollDOM.scrollTop;
      recordPosition();
    };
    view.scrollDOM.addEventListener("scroll", scrolled);
    return () => {
      draft.scroll = view.scrollDOM.scrollTop;
      callbacks.current.onPosition({
        mode: draft.mode,
        scroll: draft.scroll,
        readScroll: draft.readScroll,
        cursor: draft.cursor,
      });
      view.scrollDOM.removeEventListener("scroll", scrolled);
      view.destroy();
      if (draft.composing) { draft.composing = false; callbacks.current.onChange(); }
    };
  }, [draft, editing, draft.loading, draft.revision]);
  useEffect(() => {
    if (preview.current) preview.current.scrollTop = draft.readScroll;
  }, [draft, draft.mode, draft.loading]);
  useEffect(() => {
    const flush = () => {
      clearTimeout(positionTimer.current);
      callbacks.current.onPosition({
        mode: draft.mode,
        scroll: draft.scroll,
        readScroll: draft.readScroll,
        cursor: draft.cursor,
      });
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [draft]);

  const html = useMemo(() => {
    const tokens = renderer.parse(draft.text.replace(/^\uFEFF/, ""), {});
    const visit = (list: typeof tokens) => {
      for (const token of list) {
        if (token.type === "image") {
          const source = String(token.attrGet("src") ?? "");
          try {
            const relative = localPath(draft.path, source);
            token.attrSet(
              "src",
              relative
                ? "paper30min://project/image?" +
                    new URLSearchParams({ root, path: relative })
                : "",
            );
            if (!relative)
              token.attrSet(
                "alt",
                (token.content || "图片") + "（请使用工程内图片）",
              );
          } catch {
            token.attrSet("src", "");
          }
        }
        if (token.children) visit(token.children);
      }
    };
    visit(tokens);
    return renderer.renderer.render(tokens, renderer.options, {});
  }, [draft.text, draft.path, root]);

  // Drafts are mutable: location checks must use the snapshot that produced the preview.
  function mode(value: MarkdownDraft["mode"]) {
    draft.mode = value;
    onChange();
    onPosition({
      mode: value,
      scroll: draft.scroll,
      readScroll: draft.readScroll,
      cursor: draft.cursor,
    });
  }
  if (draft.loading) return <div className="empty">正在读取文档…</div>;
  return (
    <section className="markdown-document">
      <div className="markdown-actions">
        {readOnly ? (
          <span className="muted">只读出处字典</span>
        ) : (
          <div className="switch" role="group" aria-label="Markdown 视图">
            {(
              [
                ["read", "阅读"],
                ["edit", "编辑"],
                ["split", "分屏"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                aria-pressed={draft.mode === id}
                className={draft.mode === id ? "active" : ""}
                onClick={() => mode(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {(draft.error || linkError) && (
        <div className="notice error" role="alert">
          {draft.error || linkError}
          {draft.error && draft.external === undefined && isDirty(draft) && <button onClick={onSave} disabled={draft.saving}>重试自动保存</button>}
        </div>
      )}
      {draft.external !== undefined && (
        <div className="markdown-conflict" role="alert">
          <span>文档已在外部修改。你的编辑已保留，尚未覆盖磁盘文件。</span>
          <button
            className="borderbtn"
            onClick={() => setShowConflict(!showConflict)}
          >
            查看双方内容
          </button>
          <small>Agent 整合将在后续接入。</small>
        </div>
      )}
      {showConflict && draft.external !== undefined && (
        <div className="markdown-conflict-inputs">
          <label>
            我的未保存内容
            <textarea aria-label="我的未保存内容" readOnly value={draft.text} />
          </label>
          <label>
            当前磁盘内容
            <textarea
              aria-label="当前磁盘内容"
              readOnly
              value={draft.external?.text ?? "文件已不存在"}
            />
          </label>
        </div>
      )}
      <div className={"markdown-panes " + (readOnly ? "read" : draft.mode)}>
        {editing && <div ref={host} className="markdown-editor" />}
        {(readOnly || draft.mode !== "edit") && (
          <article
            ref={preview}
            className="markdown-preview"
            aria-label="Markdown 阅读"
            onScroll={(event) => {
              draft.readScroll = event.currentTarget.scrollTop;
              recordPosition();
            }}
            onClick={(event) => {
              const anchor = (event.target as HTMLElement).closest("a");
              if (!anchor) return;
              event.preventDefault();
              setLinkError("");
              const href = anchor.getAttribute("href") ?? "";
              if (/^https?:\/\//i.test(href)) {
                void window.desktop
                  .openLink(href)
                  .catch((error) => setLinkError(error.message));
                return;
              }
              if (href.startsWith("#")) return;
              try {
                const relative = localPath(draft.path, href);
                if (relative) onOpen(relative);
                else setLinkError("此链接类型尚未接入。");
              } catch {
                setLinkError("链接路径无效。");
              }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </section>
  );
}
