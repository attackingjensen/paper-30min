import { CommandsPlugin, UIPlugin, SelectionPlugin, InteractionManagerPlugin, DocumentManagerPlugin,
  ScrollPlugin, ViewportPlugin, type PluginRegistry, type EmbedPdfContainer, type ToolbarItem, type SelectionMenuItem } from "@embedpdf/react-pdf-viewer";
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
  let selectedPage: number | undefined;
  let selectingRegion = false;
  const page = (index: number, rects: CitationRect[]): CitationPage => {
    const p = manager.getDocument(documentId)?.pages[index];
    if (!p) throw new Error("PDF 页面尚未就绪。");
    return { page: index + 1, width: p.size.width, height: p.size.height, rects };
  };
  async function copy(wholePage = selectedPage !== undefined) {
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
        if (!wholePage) throw new Error("请先选中文字或框选区域；整页引用请使用「整页引用」。");
        input = { sha256: options.sha256, kind: "page", pages: [page(selectedPage ?? scroll.forDocument(documentId).getCurrentPage() - 1, [])], text: "" };
      }
      const citation = await window.desktop.invoke<Citation>({ type: "createCitation", root: options.root, path: options.path, input });
      if (disposed) return;
      await navigator.clipboard.writeText(citationMarkdown(citation));
      options.onStatus("已复制引用链接，可粘贴到 Markdown 文档。");
    } catch (error) { if (!disposed) options.onStatus(`复制引用链接失败：${(error as Error).message}`); }
    finally { copying = false; }
  }
  interaction.registerMode({ id: "paper-citation-region", scope: "page", exclusive: true, cursor: "crosshair" });
  // Own the transient preview too: EmbedPDF 2.15.1 does not clear its native
  // marquee when Escape changes mode before pointerup.
  const offMarquee = selection.onMarqueeChange((event) => {
    if (event.documentId !== documentId || event.modeId !== "paper-citation-region" || !selectingRegion) return;
    region = event.rect ? { pageIndex: event.pageIndex, rect: event.rect } : undefined;
    draw();
  });
  const offRegion = selection.onMarqueeEnd((event) => {
    if (event.documentId !== documentId || event.modeId !== "paper-citation-region" || !selectingRegion) return;
    region = { pageIndex: event.pageIndex, rect: event.rect };
    selectingRegion = false;
    interaction.forDocument(documentId).activateDefaultMode();
    options.onStatus("区域已选中，点击「复制引用链接」或右键复制。");
    draw();
  });
  const offSelection = selection.onBeginSelection(() => { region = undefined; selectedPage = undefined; targetValid = false; draw(); });
  commands.registerCommand({ id: "paper:copy-citation", label: "复制引用链接", icon: "copy", action: () => void copy() });

  function cancel() {
    region = undefined;
    selectedPage = undefined;
    selectingRegion = false;
    targetValid = false;
    selection.forDocument(documentId).clear();
    interaction.forDocument(documentId).activateDefaultMode();
    options.onStatus("");
    draw();
  }
  function selectRegion() {
    if (!manager.getDocument(documentId)) { options.onStatus("PDF 页面尚未就绪。"); return; }
    cancel();
    selectingRegion = true;
    selection.enableForMode("paper-citation-region", { enableSelection: false, enableMarquee: true, showMarqueeRects: false }, documentId);
    interaction.forDocument(documentId).activate("paper-citation-region");
    options.onStatus("拖动框选引用区域；按 Esc 取消。");
  }
  function selectPage() {
    cancel();
    selectedPage = scroll.forDocument(documentId).getCurrentPage() - 1;
    options.onStatus("已选择当前整页，点击「复制引用链接」；按 Esc 取消。");
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && (region || selectingRegion || selectedPage !== undefined || targetValid || selection.forDocument(documentId).getFormattedSelection().length)) {
      event.preventDefault();
      cancel();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  viewer.registerIcon("paper-region", { path: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5", strokeWidth: 2, strokeLinecap: "round" });
  commands.registerCommand({ id: "paper:region-citation", label: "框选引用", icon: "paper-region", action: selectRegion });
  commands.registerCommand({ id: "paper:page-citation", label: "整页引用", icon: "file", action: selectPage });
  commands.registerCommand({ id: "paper:cancel-citation", label: "取消引用选择", icon: "x", action: cancel });
  commands.registerCommand({
    id: "paper:citation-tab", label: "引用",
    action: () => ui.forDocument(documentId).setActiveToolbar("top", "secondary", "paper-citation-toolbar"),
    active: () => ui.forDocument(documentId).isToolbarOpen("top", "secondary", "paper-citation-toolbar"),
  });
  const schema = ui.getSchema();
  const insertTab = (items: ToolbarItem[]): ToolbarItem[] => items.map((item) => {
    if (item.type === "group") return { ...item, items: insertTab(item.items) };
    if (item.type !== "tab-group" || item.id !== "mode-tabs") return item;
    const tabs = [...item.tabs];
    tabs.splice(1, 0, { id: "paper-citation-tab", commandId: "paper:citation-tab", variant: "text" });
    return { ...item, tabs };
  });
  ui.mergeSchema({ toolbars: {
    ...Object.fromEntries(Object.entries(schema.toolbars).map(([id, toolbar]) => [id, { ...toolbar, items: insertTab(toolbar.items) }])),
    "paper-citation-toolbar": {
      id: "paper-citation-toolbar", position: { placement: "top", slot: "secondary", order: 0 }, permanent: false,
      items: [
        { type: "spacer", id: "citation-start", flex: true },
        ...["region", "page", "copy", "cancel"].map((name): ToolbarItem => ({
          type: "command-button", id: `paper-citation-${name}`, commandId: `paper:${name}-citation`, variant: "icon",
        })),
        { type: "spacer", id: "citation-end", flex: true },
      ],
    },
  } });

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
  overlay.setAttribute("aria-label", "引用高亮");
  Object.assign(overlay.style, { position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", zIndex: "5" });
  let targetShown = false;
  let layoutReady = false;
  let targetValid = false;
  let frame = 0;
  function draw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (disposed || !manager.isDocumentOpen(documentId)) return;
      if (!region && !targetValid) { overlay.replaceChildren(); return; }
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
  function navigate(target: Citation) {
    options.target = target;
    targetShown = false;
    locate();
  }
  function locate() {
    if (targetShown || !options.target || !layoutReady) return;
    targetShown = true;
    region = undefined;
    targetValid = false;
    const target = options.target;
    const doc = manager.getDocument(documentId)!;
    if (target.pages.some((p) => !doc.pages[p.page - 1] ||
        Math.abs(doc.pages[p.page - 1].size.width - p.width) > 0.01 || Math.abs(doc.pages[p.page - 1].size.height - p.height) > 0.01)) {
      options.onStatus("引用页码或尺寸不一致，无法定位。");
      draw();
      return;
    }
    const first = target.pages[0];
    targetValid = true;
    scroll.forDocument(documentId).scrollToPage({ pageNumber: first.page, pageCoordinates: first.rects[0]?.origin, behavior: "instant", alignY: 25 });
    options.onStatus(target.kind === "page" ? "已定位到引用页面（页级引用）。" : "已定位并高亮引用。");
    draw();
  }
  const offReady = scroll.onLayoutReady((event) => {
    if (event.documentId !== documentId) return;
    layoutReady = true;
    locate();
    draw();
  });
  const offLayout = scroll.onLayoutChange(draw);
  const offViewport = viewport.onViewportChange(draw);
  const offScroll = viewport.onScrollChange(draw);
  return {
    navigate,
    setVersion: (sha256: string) => { options.sha256 = sha256; },
    copy,
    selectRegion, cancel,
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      disposed = true; cancelAnimationFrame(frame); overlay.remove();
      offMarquee(); offRegion(); offSelection(); offReady(); offLayout(); offViewport(); offScroll();
    },
  };
}
