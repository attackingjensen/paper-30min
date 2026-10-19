import { AnnotationPlugin, ExportPlugin, ScrollPlugin, CommandsPlugin, UIPlugin,
  type PluginRegistry, type TrackedAnnotation } from "@embedpdf/react-pdf-viewer";
import { annotationHref, type AnnotationTarget } from "../shared/annotation-links";
import { copyAnnotationMarkdown } from "./annotation-clipboard";
import { SelectionPlugin } from "@embedpdf/plugin-selection";
import { InteractionManagerPlugin } from "@embedpdf/plugin-interaction-manager";
import { preserveConcurrentAnnotationEdits } from "./pdf-annotation-commit";
import { HistoryPlugin } from "@embedpdf/plugin-history";
import type { DocumentRecord, PdfSource } from "../shared/contracts";
import { canReusePdfEvidence } from "../shared/pdf-versions";

export interface AnnotationView {
  items: { id: string; page: number; comment: string }[];
  selected: { id: string; page: number }[];
  dirty: boolean;
  saving: boolean;
  loaded: boolean;
  error: string;
}

export function connectPdfAnnotations(registry: PluginRegistry, options: {
  root: string; path: string; sha256: string; document?: DocumentRecord;
  onChange: (view: AnnotationView) => void;
  onSaved: (source: PdfSource) => void;
  onStatus: (message: string) => void;
}) {
  const documentId = "reading";
  const restoreCommitReducer = preserveConcurrentAnnotationEdits(registry, documentId);
  const annotations = registry.getPlugin<AnnotationPlugin>(AnnotationPlugin.id)!.provides().forDocument(documentId);
  const exporter = registry.getPlugin<ExportPlugin>(ExportPlugin.id)!.provides().forDocument(documentId);
  const scroll = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)!.provides();
  const selection = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)!.provides().forDocument(documentId);
  const interaction = registry.getPlugin<InteractionManagerPlugin>(InteractionManagerPlugin.id)!.provides().forDocument(documentId);
  let anchorPage = 0;
  const offBegin = selection.onBeginSelection(({ page }) => { anchorPage = page; });
  // In 2.15.1 a cross-page release reaches only the destination page's handler.
  // Finish the original handler through the public interaction API so native tools create the annotations.
  const finishCrossPage = (event: PointerEvent) => {
    const state = selection.getState();
    if (!annotations.getActiveTool()?.interaction.textSelection || !state.selecting ||
        !state.selection || state.selection.start.page === state.selection.end.page) return;
    interaction.getHandlersForScope({ type: "page", documentId, pageIndex: anchorPage })?.onPointerUp?.(
      { x: 0, y: 0 }, { clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, target: event.target,
        currentTarget: event.currentTarget, stopImmediatePropagation() {}, isImmediatePropagationStopped: () => false },
      interaction.getActiveMode());
  };
  window.addEventListener("pointerup", finishCrossPage);
  let version = options.sha256;
  let sourceDocument = options.document;
  let generation = 0;
  let savedGeneration = 0;
  let loaded = false;
  let layoutReady = false;
  let disposed = false;
  let error = "";
  let saving: Promise<void> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (!disposed && !error) saveTimer = setTimeout(() => void flush().catch(() => {}), 600);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (!loaded && generation === savedGeneration) return;
    do { await save(); } while (generation !== savedGeneration);
  }
  let target: { value: AnnotationTarget; nonce: string } | undefined;
  let shown = "";
  function selected() { return loaded ? annotations.getSelectedAnnotations().filter((a) => a.commitState !== "deleted") : []; }
  function notify() {
    if (!disposed) options.onChange({ selected: selected().map(({ object }) => ({ id: object.id, page: object.pageIndex + 1 })),
      items: loaded ? annotations.getAnnotations().filter((a) => a.commitState !== "deleted").map(({ object }) => ({ id: object.id, page: object.pageIndex + 1, comment: object.contents ?? "" })) : [],
      dirty: generation !== savedGeneration, saving: !!saving, loaded, error });
  }
  function locate() {
    if (!target || !loaded || !layoutReady || shown === target.nonce) return;
    shown = target.nonce;
    const annotation = annotations.getAnnotationById(target.value.id);
    if (!annotation || annotation.commitState === "deleted") {
      options.onStatus("找不到目标批注，可能已删除或 PDF 已被外部替换。");
      return;
    }
    annotations.setActiveTool(null);
    const { object } = annotation;
    scroll.forDocument(documentId).scrollToPage({ pageNumber: object.pageIndex + 1,
      pageCoordinates: object.rect.origin, behavior: "instant", alignY: 30 });
    annotations.selectAnnotation(object.pageIndex, object.id);
    options.onStatus("");

  }
  const offEvent = annotations.onAnnotationEvent((event) => {
    if (event.type === "loaded") { loaded = true; notify(); locate(); }
    else if (!event.committed) { generation++; error = ""; notify(); scheduleSave(); }
  });
  const offState = annotations.onStateChange(() => notify());
  const offHistory = registry.getPlugin<HistoryPlugin>(HistoryPlugin.id)!.provides().forDocument(documentId).onHistoryChange((topic) => {
    if (loaded && (topic === "annotations" || topic === undefined)) { generation++; error = ""; notify(); scheduleSave(); }
  });
  const offLayout = scroll.onLayoutReady((event) => {
    if (event.documentId === documentId) { layoutReady = true; locate(); }
  });

  async function save(): Promise<void> {
    if (saving) return saving;
    if (!loaded) throw new Error("批注尚未加载完成。");
    if (generation === savedGeneration) return;
    const snapshot = generation;
    error = "";
    saving = (async () => {
      try {
        await annotations.commit().toPromise();
        const buffer = await exporter.saveAsCopy().toPromise();
        const result = await window.desktop.invoke<{ sha256: string; document: DocumentRecord }>({ type: "savePdf", root: options.root,
          path: options.path, bytes: new Uint8Array(buffer), version });
        version = result.sha256;
        sourceDocument = result.document;
        savedGeneration = snapshot;
        options.onSaved({ sha256: version, document: sourceDocument, bytes: new Uint8Array(buffer) });
      } catch (reason) {
        error = `批注保存失败：${reason instanceof Error ? reason.message : String((reason as { message?: string }).message ?? reason)}`;
        throw new Error(error);
      } finally { saving = undefined; notify(); }
    })();
    notify();
    return saving;
  }
  async function copy() {
    try {
      const items: TrackedAnnotation[] = selected();
      if (!items.length) throw new Error("请先选中一个或多个批注。");
      await flush();
      const markdown = items.map(({ object }) => {
        if (!annotations.getAnnotationById(object.id) || annotations.getAnnotationById(object.id)?.commitState === "deleted")
          throw new Error("选中的批注已删除，请重新选择。");
        return `[PDF 第 ${object.pageIndex + 1} 页批注](${annotationHref({ path: options.path, id: object.id })})`;
      }).join("\n");
      await copyAnnotationMarkdown(markdown, options.root);
      options.onStatus(`已复制 ${items.length} 个批注链接`);
    } catch (reason) { options.onStatus((reason as Error).message); }
  }
  async function exportCopy(): Promise<void> {
    if (saving) { await saving.catch(() => {}); return exportCopy(); }
    saving = (async () => {
      try {
        await annotations.commit().toPromise();
        const buffer = await exporter.saveAsCopy().toPromise();
        const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = options.path.split("/").at(-1)!.replace(/\.pdf$/i, "-批注副本.pdf");
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        options.onStatus("已生成批注副本并交给系统下载；请确认下载结果。工程 PDF 仍需保存。");
      } catch (reason) { options.onStatus(`批注副本导出失败：${String((reason as { message?: string }).message ?? reason)}`); }
      finally { saving = undefined; notify(); }
    })();
    notify();
    return saving;
  }
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (generation !== savedGeneration || saving) { event.preventDefault(); event.returnValue = ""; }
  };
  window.addEventListener("beforeunload", beforeUnload);
  const commands = registry.getPlugin<CommandsPlugin>(CommandsPlugin.id)!.provides();
  commands.registerCommand({ id: "document:export", label: "导出 PDF 副本", icon: "download", categories: ["document", "document-export"],
    action: () => void exportCopy() });
  commands.registerCommand({ id: "paper:copy-annotation", label: "复制批注链接", icon: "link", action: () => void copy() });
  const offAgentWrite = window.desktop.handleAnnotationWrite(async (request, checkActive) => {
    if (request.root !== options.root || request.path !== options.path) return null;
    if (!loaded || disposed) throw new Error("阅读器批注尚未加载完成，请稍后重试。");
    checkActive();
    await flush();
    checkActive();
    if (disposed) throw new Error("阅读器已关闭，请重试。");
    if (!canReusePdfEvidence(request, { sha256: version, document: sourceDocument }))
      throw new Error("阅读器 PDF 版本与磁盘不一致，请重新载入后重试。");
    annotations.createAnnotation(request.annotation.pageIndex, request.annotation);
    await flush();
    if (!annotations.getAnnotationById(request.annotation.id)) throw new Error("批注创建失败。");
    return { sha256: version };
  });
  const ui = registry.getPlugin<UIPlugin>(UIPlugin.id)!.provides();
  const schema = ui.getSchema();
  const toolbar = schema.toolbars["annotation-toolbar"];
  if (toolbar) ui.mergeSchema({ toolbars: { "annotation-toolbar": { ...toolbar, items: [
    { type: "command-button", id: "paper-copy-annotation-toolbar", commandId: "paper:copy-annotation", variant: "icon" }, ...toolbar.items,
  ] } } });
  const menus = ui.getSchema().selectionMenus;
  ui.mergeSchema({ selectionMenus: Object.fromEntries(Object.entries(menus).map(([id, menu]) => [id,
    id === "selection" ? menu : { ...menu, items: [
      { type: "command-button", id: `paper-copy-annotation-${id}`, commandId: "paper:copy-annotation", variant: "icon" }, ...menu.items,
    ] },
  ])) });
  return { save: flush, copy,
    navigate(value: AnnotationTarget, nonce: string) { target = { value, nonce }; locate(); },
    dispose() { offAgentWrite(); restoreCommitReducer(); clearTimeout(saveTimer); disposed = true; offEvent(); offState(); offHistory(); offLayout(); offBegin();
      window.removeEventListener("pointerup", finishCrossPage); window.removeEventListener("beforeunload", beforeUnload); },
  };
}
