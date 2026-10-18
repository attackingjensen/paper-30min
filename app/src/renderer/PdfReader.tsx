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
import { Save, Link, Search, X, RefreshCw } from "lucide-react";
import { connectPdfAnnotations, type AnnotationView } from "./pdf-annotations";
import type { AnnotationTarget } from "../shared/annotation-links";

export function PdfReader({ root, path, position, onPosition, citation, revision, onUse, mode, onMode, annotationTarget, onPending }: {
  root: string; path: string; position?: PdfPosition;
  citation?: Citation; revision: unknown; onUse: (use: CitationUse) => void;
  onPosition: (position: PdfPosition) => void;
  mode: "legacy" | "annotation"; onMode: (mode: "legacy" | "annotation") => void;
  annotationTarget?: { target: AnnotationTarget; nonce: string; selectOnly?: boolean };
  onPending: (pending: boolean) => void;
}) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [error, setError] = useState("");
  const [external, setExternal] = useState("");
  const [epoch, setEpoch] = useState(0);
  const pending = useRef({ dirty: false, saving: false });
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const initialPosition = useRef(position);
  useEffect(() => {
    let disposed = false;
    const baseline = sourceRef.current?.sha256;
    void window.desktop.invoke<PdfSource>({ type: "readPdf", root, path }).then((value) => {
      if (disposed) return;
      const previous = sourceRef.current;
      if (previous?.sha256 !== baseline) return;
      if (previous && previous.sha256 !== value.sha256) {
        if (pending.current.dirty) {
          setExternal("PDF 已在外部修改，内存批注已保留；请导出副本后重新载入核对，不能覆盖外部文件。");
          return;
        }
        setExternal("PDF 已在外部修改，已重新载入。请重新核对批注链接。");
        setEpoch((n) => n + 1);
      }
      setSource(value);
    }).catch((e: Error) => {
      if (disposed) return;
      if (sourceRef.current) setExternal(`无法读取磁盘 PDF，当前阅读与批注已保留：${e.message}`);
      else setError(e.message);
    });
    return () => { disposed = true; };
  }, [root, path, revision]);
  const saved = source?.sha256 === initialPosition.current?.sha256 ? initialPosition.current : undefined;
  if (error) return <div className="pdf-error" role="alert">PDF 打开失败：{error}</div>;
  if (!source) return <div className="empty">正在打开 PDF…</div>;
  return <section className="pdf-workspace">
    <div className="pdf-mode switch" role="group" aria-label="PDF 引用模式">
      <button aria-pressed={mode === "annotation"} className={mode === "annotation" ? "active" : ""} onClick={() => onMode("annotation")}>原生批注</button>
      <button aria-pressed={mode === "legacy"} className={mode === "legacy" ? "active" : ""} onClick={() => onMode("legacy")}>旧引用</button>
      {mode === "annotation" && <button className="icon" aria-label="重新载入 PDF" title="重新载入 PDF" onClick={async () => {
        if (pending.current.saving) return;
        if (pending.current.dirty && !window.confirm("有未保存的批注。确定放弃内存批注并重新载入磁盘 PDF 吗？")) return;
        try {
          const value = await window.desktop.invoke<PdfSource>({ type: "readPdf", root, path });
          pending.current = { dirty: false, saving: false }; onPending(false);
          setSource(value); setEpoch((n) => n + 1); setExternal("");
        } catch (error) { setExternal(`重新载入失败：${(error as Error).message}`); }
      }}><RefreshCw /></button>}
    </div>
    {mode === "annotation" && external && <div className="notice error" role="alert">{external}</div>}
    {mode === "legacy" && citation && citation.sha256 !== source.sha256
      ? <div role="alert">PDF 已被替换，引用已失效。</div>
      : <PdfDocument key={`${mode}:${epoch}`} root={root} source={source} path={path} saved={saved} onPosition={onPosition}
        citation={citation} revision={revision} onUse={onUse} mode={mode} annotationTarget={annotationTarget}
        onSaved={(sha256, bytes) => { const value = { sha256, bytes }; sourceRef.current = value; setSource(value); }}
        onPending={(dirty, saving = false) => { pending.current = { dirty, saving }; onPending(dirty); }} />}
  </section>;
}

function PdfDocument({ root, source, path, saved, onPosition, citation, revision, onUse, mode, annotationTarget, onPending, onSaved }: {
  root: string; citation?: Citation; revision: unknown; onUse: (use: CitationUse) => void;
  source: PdfSource; path: string; saved?: PdfPosition; onPosition: (p: PdfPosition) => void;
  mode: "legacy" | "annotation"; annotationTarget?: { target: AnnotationTarget; nonce: string; selectOnly?: boolean };
  onPending: (pending: boolean, saving?: boolean) => void;
  onSaved: (sha256: string, bytes: Uint8Array) => void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  const viewer = useRef<EmbedPdfContainer | null>(null);
  const citations = useRef<ReturnType<typeof connectPdfCitations> | null>(null);
  const annotations = useRef<ReturnType<typeof connectPdfAnnotations> | null>(null);
  const hash = useRef(source.sha256);
  const latestTarget = useRef(annotationTarget);
  latestTarget.current = annotationTarget;
  useEffect(() => {
    if (annotationTarget) annotations.current?.navigate(annotationTarget.target, annotationTarget.nonce, annotationTarget.selectOnly);
  }, [annotationTarget]);
  const [annotationView, setAnnotationView] = useState<AnnotationView>({ selected: [], dirty: false, saving: false, loaded: false, error: "" });
  const [annotationUses, setAnnotationUses] = useState<CitationUse[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const flushPosition = useRef(() => {});
  const [used, setUsed] = useState<UsedCitation[]>([]);
  const usedRef = useRef(used);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [usageError, setUsageError] = useState("");
  useEffect(() => {
    if (mode !== "legacy") return;
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
  }, [root, path, revision, mode]);
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
    ...(mode === "annotation" && { annotations: { autoCommit: false, selectAfterCreate: true, deactivateToolAfterCreate: true },
      disabledCategories: ["annotation-link", "redaction", "document-open"] }),
    ...(saved && { zoom: { defaultZoomLevel: saved.zoom } }),
    ...(saved?.scrollStrategy && { scroll: { defaultStrategy: saved.scrollStrategy as ScrollStrategy } }),
    ...(saved?.spreadMode && { spread: { defaultSpreadMode: saved.spreadMode as SpreadMode } }),
    ...(saved?.rotation !== undefined && { rotation: { defaultRotation: saved.rotation } }),
  }), [saved, mode]);
  useEffect(() => () => { annotations.current?.dispose(); citations.current?.dispose(); cleanup.current?.(); }, []);

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
        sha256: hash.current, page: metrics.currentPage,
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
    if (mode === "annotation") {
      annotations.current = connectPdfAnnotations(registry, { root, path, sha256: source.sha256, onStatus: setStatus,
        onChange: (view) => { setAnnotationView(view); onPending(view.dirty || view.saving, view.saving); },
        onSaved: (sha256, bytes) => { hash.current = sha256; onSaved(sha256, bytes); flushPosition.current(); },
      });
      if (latestTarget.current) annotations.current.navigate(latestTarget.current.target, latestTarget.current.nonce, latestTarget.current.selectOnly);
    } else {
      citations.current = connectPdfCitations(registry, viewer.current!, { root, path, sha256: source.sha256, target: citation, onStatus: setStatus, onUses: setSelectedIds });
      citations.current.setUses(usedRef.current);
    }
    // Let the native Viewer handle password prompts, malformed files, and retries.
    void manager.openDocumentBuffer({
      buffer: new Uint8Array(source.bytes).buffer, name: path, documentId, scale: saved?.zoom ?? 1,
      rotation: saved?.rotation ?? 0,
    }).toPromise().then(({ task }) => task.toPromise()).catch((e) => console.error("PDF open", e));
  }

  return <div className="pdf-reader" onClick={() => setContextMenu(null)}>
    {mode === "annotation" && <div className="annotation-actions">
      <span aria-label="批注保存状态">{annotationView.saving ? "正在保存批注…" : annotationView.dirty ? "批注未保存" : "批注已保存到 PDF"}</span>
      <button className="icon" title="保存批注到 PDF" aria-label="保存批注到 PDF" disabled={!annotationView.loaded || !annotationView.dirty || annotationView.saving}
        onClick={() => void annotations.current?.save().catch(() => {})}><Save /></button>
      <button className="icon" title="复制批注链接" aria-label="复制批注链接" disabled={!annotationView.selected.length || annotationView.saving}
        onClick={() => void annotations.current?.copy()}><Link /></button>
      <button className="icon" title="查找批注使用位置" aria-label="查找批注使用位置" disabled={!annotationView.selected.length || scanning}
        onClick={async () => {
          setScanning(true);
          try {
            setAnnotationUses(await window.desktop.invoke<CitationUse[]>({ type: "annotationUses", root, path, ids: annotationView.selected.map((a) => a.id) }));
          } catch (error) { setStatus(`批注反查失败：${(error as Error).message}`); }
          finally { setScanning(false); }
        }}><Search /></button>
      {annotationView.selected.length > 0 && <small>已选批注 · 第 {annotationView.selected.map((a) => a.page).join("、")} 页</small>}
    </div>}
    {annotationView.error && <div className="citation-status" role="alert">{annotationView.error}</div>}
    {annotationUses !== null && <aside className="citation-uses" aria-label="批注使用位置">
      <header><strong>引用此批注的文档</strong><button className="icon" title="关闭批注使用位置" aria-label="关闭批注使用位置" onClick={() => setAnnotationUses(null)}><X /></button></header>
      {!annotationUses.length && <p>没有文档使用此批注。</p>}
      {annotationUses.map((use) => <button key={`${use.path}:${use.id}:${use.occurrence}`} onClick={() => { flushPosition.current(); onUse(use); }}>
        <strong>{use.title}</strong><small>{use.path} · 第 {use.line} 行</small><span>{use.context}</span>
      </button>)}
    </aside>}
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
      <button aria-label="取消引用选择" onClick={() => { if (mode === "legacy") citations.current?.cancel(); else setStatus(""); }}>×</button>
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
    if (mode === "legacy") {
      container.addEventListener("pointerdown", preserveSelection, true);
      container.addEventListener("mousedown", preserveSelection, true);
      container.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 90) });
      });
    }
    // Viewer 2.15.1 does not expose SelectionLayer's color through its theme.
    // Target only its isolated text-selection rectangles, not PDF annotations.
    const style = document.createElement("style");
    style.textContent = '[style*="mix-blend-mode: multiply"][style*="isolation: isolate"] > div { background: rgba(104, 101, 216, 0.28) !important; }';
    container.shadowRoot!.appendChild(style);
  }} style={{ width: "100%", height: "100%", minHeight: 0 }} /></div>;
}
