import { AnnotationPlugin, AnnotationPluginPackage, type AnnotationState, type TrackedAnnotation } from "@embedpdf/plugin-annotation";
import type { PluginRegistry } from "@embedpdf/react-pdf-viewer";

/** EmbedPDF 2.15.1 clears pending changes by ID, even if that ID changed during
 * the asynchronous commit. Keep newer objects pending without adding undo entries.
 * Remove this compatibility reducer once the SDK performs snapshot-aware cleanup. */
export function preserveConcurrentAnnotationEdits(registry: PluginRegistry, documentId: string) {
  const reducer = AnnotationPluginPackage.reducer!;
  type AnnotationAction = Parameters<typeof reducer>[1];
  const store = registry.getStore();
  const scoped = store.getPluginStore<AnnotationState, AnnotationAction>(AnnotationPlugin.id);
  const committed = new Map<string, TrackedAnnotation["object"] | null>();
  const off = registry.getPlugin<AnnotationPlugin>(AnnotationPlugin.id)!.provides().forDocument(documentId)
    .onAnnotationEvent((event) => {
      if (event.type !== "loaded" && event.committed)
        committed.set(event.annotation.id, event.type === "delete" ? null : event.annotation);
    });
  store.addPluginReducer<AnnotationState>(AnnotationPlugin.id, (state, rawAction) => {
    const action = rawAction as AnnotationAction;
    const current = state.documents[documentId];
    if (action.type === "ANNOTATION/PURGE_ANNOTATION" && action.payload.documentId === documentId) {
      const restored = current?.byUid[action.payload.uid];
      // Undo can restore an annotation while PDFium is still deleting it.
      if (restored && restored.commitState !== "deleted") return { ...state, documents: {
        ...state.documents, [documentId]: { ...current, hasPendingChanges: true,
          byUid: { ...current.byUid, [action.payload.uid]: { ...restored, commitState: "new" } } },
      } };
    }
    const next = reducer(state, action);
    if (action.type !== "ANNOTATION/COMMIT" || action.payload.documentId !== documentId || !current) return next;
    const document = next.documents[documentId];
    const byUid = { ...document.byUid };
    const unsuccessful = new Set<string>();
    for (const id of action.payload.committedUids) {
      const snapshot = committed.get(id);
      committed.delete(id);
      const latest = current.byUid[id];
      // Do not make the SDK recursively retry a failed engine operation.
      if (snapshot === undefined) { unsuccessful.add(id); continue; }
      if (!latest) continue;
      if (snapshot === null) {
        if (latest.commitState === "deleted") delete byUid[id];
        else byUid[id] = { ...latest, commitState: "new" };
      }
      else if (latest.object !== snapshot || latest.commitState === "deleted")
        byUid[id] = { ...latest, commitState: latest.commitState === "deleted" ? "deleted" : "dirty" };
    }
    const hasPendingChanges = Object.entries(byUid).some(([id, item]) =>
      !unsuccessful.has(id) && ["new", "dirty", "moved", "deleted"].includes(item.commitState));
    return { ...next, documents: { ...next.documents, [documentId]: { ...document, byUid, hasPendingChanges } } };
  }, scoped.getState());
  return () => {
    off();
    store.addPluginReducer(AnnotationPlugin.id, (state, action) => reducer(state, action as AnnotationAction), scoped.getState());
  };
}
