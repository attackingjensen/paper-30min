import { CommandsPlugin, UIPlugin, SelectionPlugin, InteractionManagerPlugin, DocumentManagerPlugin,
  ScrollPlugin, ViewportPlugin, type PluginRegistry, type EmbedPdfContainer, type SelectionMenuItem } from "@embedpdf/react-pdf-viewer";
import { citationMarkdown, type Citation, type CitationInput, type CitationPage, type CitationRect } from "../shared/citations";

/** All evidence coordinates come from plugin capabilities, never DOM text/selection geometry. */
export function connectPdfCitations(registry: PluginRegistry, viewer: EmbedPdfContainer, options: {
  root: string; path: string; sha256: string; target?: Citation;
  onStatus: (message: string) => void;
}) {
  const documentId = "reading";
  const selection = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)!.provides();
  const manager = registry.getPlugin<DocumentManagerPlugin>(DocumentManagerPlugin.id)!.provides();
  const interaction = registry.getPlugin<InteractionManagerPlugin>(InteractionManagerPlugin.id)!.provides();
  const scroll = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)!.provides();
  const viewport = registry.getPlugin<ViewportPlugin>(ViewportPlugin.id)!.provides();
  const commands = registry.getPlugin<CommandsPlugin>(CommandsPlugin.id)!.provides();
  const ui = registry.getPlugin<UIPlugin>(UIPlugin.id)!.provides();
  let region: { pageIndex: number; rect: CitationRect } | undefined;
  let disposed = false;
  let copying = false;
  const page = (index: number, rects: CitationRect[]): CitationPage => {
    const p = manager.getDocument(documentId)?.pages[index];
    if (!p) throw new Error("PDF 页面尚未就绪。");
    return { page: index + 1, width: p.size.width, height: p.size.height, rects };
  };
  async function copy(wholePage = false) {
    if (copying) return;
    copying = true;
    try {
      const selected = selection.forDocument(documentId).getFormattedSelection();
      let input: CitationInput;
      if (!wholePage && region) {
        input = { sha256: options.sha256, kind: "region", pages: [page(region.pageIndex, [region.rect])], text: "" };
      } else if (!wholePage && selected.length) {
        const pages = selected.map((p) => page(p.pageIndex, p.segmentRects)).sort((a, b) => a.page - b.page);
        const text = (await selection.forDocument(documentId).getSelectedText().toPromise()).join("\n");
        input = { sha256: options.sha256, kind: "text", pages, text };
      } else {
        if (!wholePage) throw new Error("请先选中文字或框选区域；整页引用请使用「复制整页出处」。");
        input = { sha256: options.sha256, kind: "page", pages: [page(scroll.forDocument(documentId).getCurrentPage() - 1, [])], text: "" };
      }
      const citation = await window.desktop.invoke<Citation>({ type: "createCitation", root: options.root, path: options.path, input });
      if (disposed) return;
      await navigator.clipboard.writeText(citationMarkdown(citation));
      options.onStatus("已复制出处，可粘贴到 Markdown 文档。");
    } catch (error) { if (!disposed) options.onStatus(`复制出处失败：${(error as Error).message}`); }
    finally { copying = false; }
  }
  interaction.registerMode({ id: "paper-citation-region", scope: "page", exclusive: true, cursor: "crosshair" });
  const offRegion = selection.onMarqueeEnd((event) => {
    if (event.documentId !== documentId || event.modeId !== "paper-citation-region") return;
    region = { pageIndex: event.pageIndex, rect: event.rect };
    interaction.forDocument(documentId).activateDefaultMode();
    options.onStatus("区域已选中，点击「复制出处」或右键复制。");
    draw();
  });
  const offSelection = selection.onBeginSelection(() => { region = undefined; draw(); });
  commands.registerCommand({ id: "paper:copy-citation", label: "复制出处", icon: "copy", action: () => void copy() });
  const schema = ui.getSchema();
  const menu = schema.selectionMenus.selection;
  if (menu) {
    const removeLink = (items: SelectionMenuItem[]): SelectionMenuItem[] => items
      .filter((item) => item.type !== "command-button" || item.commandId !== "annotation:add-link")
      .map((item) => item.type === "group" ? { ...item, items: removeLink(item.items) } : item);
    ui.mergeSchema({ selectionMenus: { ...schema.selectionMenus, selection: { ...menu, items: [
      { type: "command-button", id: "paper-copy-citation", commandId: "paper:copy-citation", variant: "icon-text" },
      ...removeLink(menu.items),
    ] } } });
  }

  // The bundled 2.15.1 viewer has no custom page-layer slot. Only the presentation
  // host is located in its shadow root; page transforms remain the public Scroll API's job.
  const overlay = document.createElement("div");
  overlay.setAttribute("aria-label", "出处高亮");
  Object.assign(overlay.style, { position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", zIndex: "5" });
  let targetShown = false;
  let targetValid = false;
  let frame = 0;
  function draw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (disposed || !manager.isDocumentOpen(documentId)) return;
      const host = viewer.shadowRoot?.querySelector<HTMLElement>('#document-content .bg-bg-app[style*="overflow: auto"]');
      if (!host) return;
      if (overlay.parentElement !== host.parentElement) host.parentElement!.appendChild(overlay);
      const metrics = viewport.forDocument(documentId).getMetrics();
      const layout = scroll.forDocument(documentId).getLayout();
      const zoom = registry.getStore().getState().core.documents[documentId]?.scale ?? 1;
      const gap = viewport.getViewportGap();
      // The scroller centers content when narrower than the viewport.
      const left = Math.max(0, (metrics.clientWidth - layout.totalContentSize.width * zoom - gap * 2) / 2) + gap;
      overlay.style.width = `${metrics.clientWidth}px`;
      overlay.style.height = `${metrics.clientHeight}px`;
      overlay.replaceChildren();
      const pages = region ? [page(region.pageIndex, [region.rect])] : targetValid ? options.target!.pages : [];
      for (const p of pages) for (const rect of p.rects) {
        const mapped = scroll.forDocument(documentId).getRectPositionForPage(p.page - 1, rect);
        if (!mapped) continue;
        const mark = document.createElement("div");
        mark.dataset.citationPage = String(p.page);
        Object.assign(mark.style, {
          position: "absolute", left: `${left + mapped.origin.x - metrics.scrollLeft}px`,
          top: `${gap + mapped.origin.y - metrics.scrollTop}px`, width: `${mapped.size.width}px`, height: `${mapped.size.height}px`,
          background: "rgba(244, 191, 60, 0.3)", outline: "1px solid rgba(178, 119, 0, 0.7)",
        });
        overlay.appendChild(mark);
      }
    });
  }
  const offReady = scroll.onLayoutReady((event) => {
    if (event.documentId !== documentId) return;
    if (!targetShown && options.target) {
      targetShown = true;
      const target = options.target;
      const doc = manager.getDocument(documentId)!;
      if (target.sha256 !== options.sha256 || target.pages.some((p) => !doc.pages[p.page - 1] ||
          Math.abs(doc.pages[p.page - 1].size.width - p.width) > 0.01 || Math.abs(doc.pages[p.page - 1].size.height - p.height) > 0.01)) {
        options.onStatus("出处页码、尺寸或 PDF 版本不一致，无法定位。");
        return;
      }
      const first = target.pages[0];
      targetValid = true;
      scroll.forDocument(documentId).scrollToPage({ pageNumber: first.page, pageCoordinates: first.rects[0]?.origin, behavior: "instant", alignY: 25 });
      options.onStatus(target.kind === "page" ? "已定位到出处页面（页级出处）。" : "已定位并高亮出处。");
    }
    draw();
  });
  const offLayout = scroll.onLayoutChange(draw);
  const offViewport = viewport.onViewportChange(draw);
  const offScroll = viewport.onScrollChange(draw);
  return {
    copy,
    selectRegion: () => {
      if (!manager.getDocument(documentId)) { options.onStatus("PDF 页面尚未就绪。"); return; }
      region = undefined;
      selection.enableForMode("paper-citation-region", { enableSelection: false, enableMarquee: true, showMarqueeRects: true }, documentId);
      selection.forDocument(documentId).clear();
      interaction.forDocument(documentId).activate("paper-citation-region");
      options.onStatus("在 PDF 页面上拖动框选区域。");
      draw();
    },
    dispose: () => {
      disposed = true; cancelAnimationFrame(frame); overlay.remove();
      offRegion(); offSelection(); offReady(); offLayout(); offViewport(); offScroll();
    },
  };
}
