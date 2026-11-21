import { useEffect, useMemo, useRef, useState } from "react";
import { PDFViewer, type PDFViewerConfig, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { DocumentManagerPlugin } from "@embedpdf/plugin-document-manager";
import { ScrollPlugin, ScrollStrategy, type ScrollState } from "@embedpdf/plugin-scroll";
import type { Action } from "@embedpdf/core";
import { SpreadPlugin, SpreadMode } from "@embedpdf/plugin-spread";
import { RotatePlugin } from "@embedpdf/plugin-rotate";
import { ViewportPlugin } from "@embedpdf/plugin-viewport";
import { ZoomPlugin } from "@embedpdf/plugin-zoom";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import type { PdfSource, PdfPosition } from "../shared/contracts";

export function PdfReader({
  root,
  path,
  position,
  onPosition,
  revision,
}: {
  root: string;
  path: string;
  position?: PdfPosition;
  revision: unknown;
  onPosition: (position: PdfPosition) => void;
}) {
  const [source, setSource] = useState<PdfSource | null>(null);
  const [error, setError] = useState("");
  const [external, setExternal] = useState("");
  const [epoch, setEpoch] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const initialPosition = useRef(position);
  useEffect(() => {
    let disposed = false;
    const baseline = sourceRef.current?.sha256;
    void window.desktop
      .invoke<PdfSource>({ type: "readPdf", root, path })
      .then((value) => {
        if (disposed) return;
        const previous = sourceRef.current;
        if (previous?.sha256 !== baseline) return;
        if (previous && previous.sha256 !== value.sha256) {
          setExternal("PDF 已在外部修改，已重新载入。");
          setEpoch((n) => n + 1);
        }
        setSource(value);
      })
      .catch((e: Error) => {
        if (disposed) return;
        if (sourceRef.current) setExternal(`无法读取磁盘 PDF，当前内容已保留：${e.message}`);
        else setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [root, path, revision]);
  const saved = initialPosition.current;
  if (error)
    return (
      <div className="pdf-error" role="alert">
        PDF 打开失败：{error}
      </div>
    );
  if (!source) return <div className="empty">正在打开 PDF…</div>;
  return (
    <section className="pdf-workspace">
      {external && (
        <div className="notice error" role="alert">
          {external}
        </div>
      )}
      <PdfDocument key={epoch} source={source} path={path} saved={saved} onPosition={onPosition} />
    </section>
  );
}

function PdfDocument({
  source,
  path,
  saved,
  onPosition,
}: {
  source: PdfSource;
  path: string;
  saved?: PdfPosition;
  onPosition: (p: PdfPosition) => void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const config = useMemo<PDFViewerConfig>(
    () => ({
      wasmUrl: new URL(wasmUrl, location.href).href,
      worker: true,
      fontFallback: null,
      fonts: { ui: null, signature: null },
      i18n: { defaultLocale: "zh-CN" },
      disabledCategories: ["annotation", "redaction", "document-open"],
      ...(saved && { zoom: { defaultZoomLevel: saved.zoom } }),
      ...(saved?.scrollStrategy && { scroll: { defaultStrategy: saved.scrollStrategy as ScrollStrategy } }),
      ...(saved?.spreadMode && { spread: { defaultSpreadMode: saved.spreadMode as SpreadMode } }),
      ...(saved?.rotation !== undefined && { rotation: { defaultRotation: saved.rotation } }),
    }),
    [saved],
  );
  useEffect(
    () => () => {
      cleanup.current?.();
    },
    [],
  );

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
      if (pending) {
        onPositionRef.current(pending);
        pending = undefined;
      }
    };
    const save = () => {
      if (!restored || !manager.isDocumentOpen(documentId)) return;
      const metrics = scroll.forDocument(documentId).getMetrics();
      const view = viewport.forDocument(documentId).getMetrics();
      pending = {
        page: metrics.currentPage,
        x: view.scrollLeft,
        y: view.scrollTop,
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
    const offReady = scroll.onLayoutReady((e) => {
      if (e.documentId !== documentId) return;
      if (restored) {
        save();
        return;
      }
      if (saved) viewport.forDocument(documentId).scrollTo({ x: saved.x, y: saved.y, behavior: "instant" });
      restored = true;
    });
    const offScroll = viewport.onScrollChange((e) => {
      if (e.documentId === documentId) save();
    });
    const offZoom = zoom.onZoomChange((e) => {
      if (e.documentId === documentId) save();
    });
    const offLayout = scroll.onLayoutChange((e) => {
      if (e.documentId !== documentId || !restored) return;
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = undefined;
        save();
      });
    });
    window.addEventListener("beforeunload", flush);
    cleanup.current = () => {
      if (layoutFrame !== undefined) {
        cancelAnimationFrame(layoutFrame);
        save();
      }
      flush();
      offResize();
      offReady();
      offScroll();
      offZoom();
      offLayout();
      window.removeEventListener("beforeunload", flush);
    };
    // Let the native Viewer handle password prompts, malformed files, and retries.
    void manager
      .openDocumentBuffer({
        buffer: new Uint8Array(source.bytes).buffer,
        name: path,
        documentId,
        scale: saved?.zoom ?? 1,
        rotation: saved?.rotation ?? 0,
      })
      .toPromise()
      .then(({ task }) => task.toPromise())
      .catch((e) => console.error("PDF open", e));
  }

  return (
    <div className="pdf-reader">
      <PDFViewer
        config={config}
        onReady={ready}
        onInit={(container) => {
          // Viewer 2.15.1 does not expose SelectionLayer's color through its theme.
          // Target only its isolated text-selection rectangles, not PDF annotations.
          const style = document.createElement("style");
          style.textContent =
            '[style*="mix-blend-mode: multiply"][style*="isolation: isolate"] > div { background: rgba(104, 101, 216, 0.28) !important; }';
          container.shadowRoot!.appendChild(style);
        }}
        style={{ width: "100%", height: "100%", minHeight: 0 }}
      />
    </div>
  );
}
