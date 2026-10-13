import { useEffect, useReducer, useRef } from "react";
import type { EditorState } from "@codemirror/state";
import type {
  DocumentTab,
  MarkdownFile,
  MarkdownSave,
} from "../shared/contracts";

export interface MarkdownDraft {
  path: string;
  file?: MarkdownFile;
  text: string;
  external?: MarkdownFile | null;
  error: string;
  loading: boolean;
  saving: boolean;
  editor?: EditorState;
  mode: "read" | "edit" | "split";
  scroll: number;
  readScroll: number;
  cursor: number;
}
export const isMarkdown = (path?: string) =>
  !!path && /\.(md|markdown)$/i.test(path);
export const isDirty = (draft: MarkdownDraft) =>
  !!draft.file && draft.text !== draft.file.text;

export function useMarkdownDocuments(
  root: string | undefined,
  tabs: DocumentTab[],
  revision: unknown,
) {
  const [, render] = useReducer((n) => n + 1, 0);
  const store = useRef<{ root?: string; drafts: Map<string, MarkdownDraft> }>({
    drafts: new Map(),
  });
  if (store.current.root !== root) store.current = { root, drafts: new Map() };
  const drafts = store.current.drafts;
  const alive = () => store.current.drafts === drafts;
  const notify = () => {
    if (alive()) render();
  };

  async function sync(draft: MarkdownDraft) {
    const baseline = draft.file;
    try {
      const file = await window.desktop.invoke<MarkdownFile>({
        type: "readMarkdown",
        root: root!,
        path: draft.path,
      });
      if (!alive() || draft.file !== baseline || draft.saving) return;
      draft.error = "";
      if (!draft.file || !isDirty(draft) || draft.text === file.text) {
        if (draft.text !== file.text) {
          draft.text = file.text;
          draft.editor = undefined;
        }
        draft.file = file;
        draft.external = undefined;
      } else
        draft.external = file.version === draft.file.version ? undefined : file;
    } catch (error) {
      if (!alive() || draft.file !== baseline || draft.saving) return;
      draft.error = (error as Error).message;
      if (draft.file && draft.error.includes("ENOENT")) {
        draft.external = null;
        draft.error = "文件已被删除或移动，你的内容仍保留在此标签中。";
      }
      // Keep the last loaded text and user's input even when the path disappeared.
    } finally {
      if (alive()) {
        draft.loading = false;
        notify();
      }
    }
  }
  useEffect(() => {
    if (!root) return;
    for (const tab of tabs) {
      if (!isMarkdown(tab.path)) continue;
      let draft = drafts.get(tab.path!);
      if (!draft) {
        draft = {
          path: tab.path!,
          text: "",
          loading: true,
          saving: false,
          error: "",
          mode: tab.markdown?.mode ?? "read",
          scroll: tab.markdown?.scroll ?? 0,
          readScroll: tab.markdown?.readScroll ?? 0,
          cursor: tab.markdown?.cursor ?? 0,
        };
        drafts.set(tab.path!, draft);
      }
      void sync(draft);
    }
  }, [root, tabs, revision]);

  async function save(draft: MarkdownDraft) {
    if (!draft.file || draft.saving || !isDirty(draft)) return;
    draft.saving = true;
    draft.error = "";
    notify();
    const text = draft.text;
    try {
      const result = await window.desktop.invoke<MarkdownSave>({
        type: "saveMarkdown",
        root: root!,
        path: draft.path,
        text,
        version: draft.file.version,
      });
      if (!alive()) return;
      if (result.saved) {
        draft.file = result.file;
        draft.external = undefined;
      } else {
        draft.external = result.file;
        draft.error = "文件已在外部变化，尚未覆盖。请查看双方内容。";
      }
    } catch (error) {
      if (alive()) draft.error = "保存失败：" + (error as Error).message;
    } finally {
      draft.saving = false;
      notify();
    }
  }
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...drafts.values()].some((d) => isDirty(d) || d.saving)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [drafts]);

  function mayLeave(path?: string) {
    const selected = path
      ? [drafts.get(path)].filter((d): d is MarkdownDraft => !!d)
      : [...drafts.values()];
    if (selected.some((d) => d.saving)) {
      window.alert("文档正在保存，请稍后再关闭。");
      return false;
    }
    return (
      !selected.some(isDirty) ||
      window.confirm("有未保存的编辑。确定放弃这些编辑并离开吗？")
    );
  }
  return {
    drafts,
    notify,
    save,
    mayLeave,
    forget: (path: string) => drafts.delete(path),
    retarget: (from: string, to: string) => {
      const draft = drafts.get(from);
      if (draft) {
        drafts.delete(from);
        draft.path = to;
        drafts.set(to, draft);
      }
    },
  };
}
