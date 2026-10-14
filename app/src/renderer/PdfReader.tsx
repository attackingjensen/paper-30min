import { useEffect, useMemo, useRef, useState } from "react";
import { PDFViewer, type PDFViewerConfig, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { DocumentManagerPlugin } from "@embedpdf/plugin-document-manager";
import { ScrollPlugin, ScrollStrategy, type ScrollState } from "@embedpdf/plugin-scroll";
import type { Action } from "@embedpdf/core";
import { SpreadPlugin, SpreadMode } from "@embedpdf/plugin-spread";
import { RotatePlugin } from "@embedpdf/plugin-rotate";
import { ViewportPlugin } from "@embedpdf/plugin-viewport";
import { ZoomPlugin } from "@embedpdf/plugin-zoom";
import type { StampLibraryConfig } from "@embedpdf/plugin-stamp";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import stampManifest from "@embedpdf/default-stamps/zh-CN/manifest.json?raw";
import stampsUrl from "@embedpdf/default-stamps/zh-CN/stamps.pdf?url";
import type { PdfSource, PdfPosition } from "../shared/contracts";
import type { Citation, CitationUse, UsedCitation } from "../shared/citations";
import { connectPdfCitations } from "./pdf-citations";
import type { EmbedPdfContainer } from "@embedpdf/react-pdf-viewer";

export function PdfReader({ root, path, position, onPosition, citation, revision, onUse }: {
  root: string; path: string; position?: PdfPosition;
  citation?: Citation; revision: unknown; onUse: (use: CitationUse) => void;
  onPosition: (position: PdfPosition) => void;
}) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [error, setError] = useState("");
  const initialPosition = useRef(position);
  useEffect(() => {
    let disposed = false;
    void window.desktop.invoke<PdfSource>({ type: "readPdf", root, path }).then((value) => {
      if (!disposed) setSource(value);
    }).catch((e: Error) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [root, path]);
  const saved = source?.sha256 === initialPosition.current?.sha256 ? initialPosition.current : undefined;
  if (error) return <div className="pdf-error" role="alert">PDF 打开失败：{error}</div>;
  if (!source) return <div className="empty">正在打开 PDF…</div>;
  if (citation && citation.sha256 !== source.sha256) return <div role="alert">PDF 已被替换，引用已失效。</div>;
  return <PdfDocument root={root} source={source} path={path} saved={saved} onPosition={onPosition} citation={citation} revision={revision} onUse={onUse} />;
}

function PdfDocument({ root, source, path, saved, onPosition, citation, revision, onUse }: {
  root: string; citation?: Citation; revision: unknown; onUse: (use: CitationUse) => void;
  source: PdfSource; path: string; saved?: PdfPosition; onPosition: (p: PdfPosition) => void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  const viewer = useRef<EmbedPdfContainer | null>(null);
  const citations = useRef<ReturnType<typeof connectPdfCitations> | null>(null);
  const flushPosition = useRef(() => {});
  const [used, setUsed] = useState<UsedCitation[]>([]);
  const usedRef = useRef(used);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [usageError, setUsageError] = useState("");
  useEffect(() => {
    let disposed = false;
    void window.desktop.invoke<UsedCitation[]>({ type: "citationUses", root, path }).then((items) => {
      if (disposed) return;
      usedRef.current = items;
      setUsed(items);
      citations.current?.setUses(items);
      setUsageError("");
    }).catch((error: Error) => {
      if (disposed) return;
      usedRef.current = [];
      setUsed([]);
      citations.current?.setUses([]);
      setUsageError(error.message);
    });
    return () => { disposed = true; };
  }, [root, path, revision]);
  const selected = used.filter((item) => selectedIds.includes(item.citation.id));
  const [status, setStatus] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const config = useMemo<PDFViewerConfig>(() => ({
    wasmUrl: new URL(wasmUrl, location.href).href,
    worker: true,
    fontFallback: null,
    fonts: { ui: null, signature: null },
    stamp: {
      manifests: [],
      libraries: [{ ...JSON.parse(stampManifest), pdf: new URL(stampsUrl, location.href).href } as StampLibraryConfig],
    },
    i18n: { defaultLocale: "zh-CN" },
    disabledCategories: ["annotation-link"],
    ...(saved && { zoom: { defaultZoomLevel: saved.zoom } }),
    ...(saved?.scrollStrategy && { scroll: { defaultStrategy: saved.scrollStrategy as ScrollStrategy } }),
    ...(saved?.spreadMode && { spread: { defaultSpreadMode: saved.spreadMode as SpreadMode } }),
    ...(saved?.rotation !== undefined && { rotation: { defaultRotation: saved.rotation } }),
  }), [saved]);
  useEffect(() => () => { citations.current?.dispose(); cleanup.current?.(); }, []);

  function ready(registry: PluginRegistry) {
    const manager = registry.getPlugin<DocumentManagerPlugin>(DocumentManagerPlugin.id)!.provides();
    const scrollPlugin = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)!;
    const scroll = scrollPlugin.provides();
    const scrollStore = registry.getStore().getPluginStore<ScrollState, Action>(ScrollPlugin.id);
    const spread = registry.getPlugin<SpreadPlugin>(SpreadPlugin.id)!.provides();
    const rotate = registry.getPlugin<RotatePlugin>(RotatePlugin.id)!.provides();
    const viewport = registry.getPlugin<ViewportPlugin>(ViewportPlugin.id)!.provides();
    const zoom = registry.getPlugin<ZoomPlugin>(ZoomPlugin.id)!.provides();
    const documentId = "reading";
    let initialized = !saved;
    let restored = false;
    let pending: PdfPosition | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let layoutFrame: number | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      if (pending) { onPositionRef.current(pending); pending = undefined; }
    };
    const save = () => {
      if (!restored || !manager.isDocumentOpen(documentId)) return;
      const metrics = scroll.forDocument(documentId).getMetrics();
      const view = viewport.forDocument(documentId).getMetrics();
      pending = {
        sha256: source.sha256, page: metrics.currentPage,
        x: view.scrollLeft, y: view.scrollTop,
        zoom: zoom.forDocument(documentId).getState().currentZoomLevel,
        scrollStrategy: scrollStore.getState().documents[documentId].strategy,
        spreadMode: spread.forDocument(documentId).getSpreadMode(),
        rotation: rotate.forDocument(documentId).getRotation(),
      };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
    const offResize = viewport.onViewportResize((e) => {
      // A restored numeric zoom needs a request after measurement to release the layout gate in 2.15.1.
      if (e.documentId === documentId && !initialized && e.metrics.clientWidth > 0 && e.metrics.clientHeight > 0) {
        initialized = true;
        zoom.forDocument(documentId).requestZoom(saved!.zoom);
      }
    });
    flushPosition.current = () => { save(); flush(); };
    const offReady = scroll.onLayoutReady((e) => {
      if (e.documentId !== documentId) return;
      if (restored) { save(); return; }
      if (saved) viewport.forDocument(documentId).scrollTo({ x: saved.x, y: saved.y, behavior: "instant" });
      restored = true;
    });
    const offScroll = viewport.onScrollChange((e) => { if (e.documentId === documentId) save(); });
    const offZoom = zoom.onZoomChange((e) => { if (e.documentId === documentId) save(); });
    const offLayout = scroll.onLayoutChange((e) => {
      if (e.documentId !== documentId || !restored) return;
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(() => { layoutFrame = undefined; save(); });
    });
    window.addEventListener("beforeunload", flush);
    cleanup.current = () => {
      if (layoutFrame !== undefined) { cancelAnimationFrame(layoutFrame); save(); }
      flush(); offResize(); offReady(); offScroll(); offZoom(); offLayout();
      window.removeEventListener("beforeunload", flush);
    };
    citations.current = connectPdfCitations(registry, viewer.current!, { root, path, sha256: source.sha256, target: citation, onStatus: setStatus, onUses: setSelectedIds });
    citations.current.setUses(usedRef.current);
    // Let the native Viewer handle password prompts, malformed files, and retries.
    void manager.openDocumentBuffer({
      buffer: new Uint8Array(source.bytes).buffer, name: path, documentId, scale: saved?.zoom ?? 1,
      rotation: saved?.rotation ?? 0,
    }).toPromise().then(({ task }) => task.toPromise()).catch((e) => console.error("PDF open", e));
  }

  return <div className="pdf-reader" onClick={() => setContextMenu(null)}>
    {usageError && <div className="citation-status" role="alert">文档引用加载失败：{usageError}</div>}
    {selected.length > 0 && <aside className="citation-uses" aria-label="文档引用使用位置">
      <header><strong>引用此处的文档</strong><button aria-label="关闭文档引用列表" onClick={() => setSelectedIds([])}>×</button></header>
      {selected.map((item) => <section key={item.citation.id}>
        <small>{item.citation.kind === "page" ? "整页引用" : item.citation.kind === "region" ? "区域引用" : "文字引用"} · 第 {item.citation.pages.map((p) => p.page).join("、")} 页</small>
        {item.uses.map((use) => <button key={`${use.path}:${use.occurrence}`} onClick={() => { flushPosition.current(); onUse(use); }}>
          <strong>{use.title}</strong><small>{use.path} · 第 {use.line} 行</small><span>{use.context}</span>
        </button>)}
      </section>)}
    </aside>}
    {status && <div className="citation-status" role="status">
      <span>{status}</span>
      <button aria-label="取消引用选择" onClick={() => citations.current?.cancel()}>×</button>
    </div>}
    {contextMenu && <div className="citation-context" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
      <button role="menuitem" onClick={() => void citations.current?.copy()}>复制引用链接</button>
      <button role="menuitem" onClick={() => void citations.current?.copy(true)}>复制整页引用链接</button>
    </div>}
    <PDFViewer config={config} onReady={ready} onInit={(container) => {
    viewer.current = container;
    // EmbedPDF treats secondary-button down as a new text selection. Preserve
    // the evidence until our context menu consumes it; contextmenu alone is too late.
    const preserveSelection = (event: MouseEvent) => {
      if (event.button === 2) { event.preventDefault(); event.stopPropagation(); }
    };
    container.addEventListener("pointerdown", preserveSelection, true);
    container.addEventListener("mousedown", preserveSelection, true);
    container.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 90) });
    });
    // Viewer 2.15.1 does not expose SelectionLayer's color through its theme.
    // Target only its isolated text-selection rectangles, not PDF annotations.
    const style = document.createElement("style");
    style.textContent = '[style*="mix-blend-mode: multiply"][style*="isolation: isolate"] > div { background: rgba(104, 101, 216, 0.28) !important; }';
    container.shadowRoot!.appendChild(style);
  }} style={{ width: "100%", height: "100%", minHeight: 0 }} /></div>;
}
