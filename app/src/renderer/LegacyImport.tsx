import { useRef, useState } from "react";
import { FolderOpen, Import, RotateCcw, Square, X } from "lucide-react";
import type { LegacyImportResult, LegacyLibrary, LegacyPdf } from "../shared/contracts";

type Item = LegacyPdf & {
  status: "pending" | "running" | "failed" | "created" | "existing";
  projectRoot?: string;
};
const statusNames = {
  pending: "待导入", running: "导入中", failed: "失败", created: "已创建", existing: "已存在",
};
const errorText = (error: unknown) => (error as Error).message.replace(
  /^Error invoking remote method '[^']+': Error: /, "",
);

export function LegacyImport({ folder, onClose, onOpen, onUpdated }: {
  folder: string | null;
  onClose: () => void;
  onOpen: (root: string) => void;
  onUpdated: () => Promise<unknown>;
}) {
  const [library, setLibrary] = useState<LegacyLibrary | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const stopped = useRef(false);
  const operation = useRef<string | null>(null);

  async function choose() {
    setBusy(true);
    setError("");
    try {
      const root = await window.desktop.choose("legacy");
      if (!root) return;
      const result = await window.desktop.invoke<LegacyLibrary>({ type: "scanLegacy", root });
      setLibrary(result);
      setItems(result.papers.map((paper) => ({ ...paper, status: paper.error ? "failed" : "pending" })));
      setAttempted(false);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function start() {
    if (!library || !folder) return;
    setBusy(true);
    setRunning(true);
    setAttempted(true);
    setError("");
    stopped.current = false;
    try {
      for (const item of items) {
        if (stopped.current) break;
        if (item.status === "created" || item.status === "existing") continue;
        const operationId = crypto.randomUUID();
        operation.current = operationId;
        const update = (patch: Partial<Item>) => setItems((old) =>
          old.map((value) => value.path === item.path ? { ...value, ...patch } : value),
        );
        update({ status: "running", error: undefined });
        try {
          const result = await window.desktop.invoke<LegacyImportResult>({
            type: "importLegacy", root: library.root, path: item.path, name: item.name, operationId,
          });
          update({ status: result.existing ? "existing" : "created", name: result.name, projectRoot: result.root });
        } catch (e) {
          update(stopped.current ? { status: "pending" } : { status: "failed", error: errorText(e) });
        } finally { operation.current = null; }
      }
      await onUpdated();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setRunning(false); }
  }

  async function stop() {
    stopped.current = true;
    if (operation.current) {
      try { await window.desktop.invoke({ type: "cancelCreate", operationId: operation.current }); }
      catch (e) { setError(errorText(e)); }
    }
  }

  const completed = items.filter((item) => item.status === "created" || item.status === "existing").length;
  return (
    <div className="modal-backdrop">
      <section className="modal legacy-import" role="dialog" aria-modal="true" aria-label="导入旧 PDF">
        <div className="between">
          <h2>导入旧 PDF</h2>
          <button className="icon" aria-label="关闭导入" title="关闭导入" disabled={busy} onClick={onClose}><X /></button>
        </div>
        <label>默认工程文件夹</label>
        <div className="path source-path">{folder ?? "请先设置默认工程文件夹"}</div>
        <label>旧书库文件夹</label>
        <div className="location">
          <span className="path">{library?.root ?? "尚未选择"}</span>
          <button className="borderbtn" disabled={busy || !folder} onClick={() => void choose()}><FolderOpen /> 选择旧书库</button>
        </div>
        {!!items.length && <>
          <div className="legacy-progress" role="status">{completed} / {items.length}</div>
          <progress value={completed} max={items.length} aria-label="导入进度" />
          <div className="legacy-items">
            {items.map((item, index) => (
              <div className="legacy-item" key={item.path}>
                <label htmlFor={`legacy-name-${index}`}>工程名称 {index + 1}</label>
                <input id={`legacy-name-${index}`} value={item.name} disabled={busy || !!item.projectRoot}
                  onChange={(e) => setItems((old) => old.map((value) => value.path === item.path ? { ...value, name: e.target.value } : value))} />
                <div className="between">
                  <span className="path muted">{item.path}</span>
                  <span className={`legacy-status ${item.status}`}>{statusNames[item.status]}</span>
                </div>
                {item.error && <p className="form-error">{item.error}</p>}
                {item.projectRoot && <button className="legacy-open" disabled={busy}
                  aria-label={`打开 ${item.name}`} onClick={() => onOpen(item.projectRoot!)}>
                  <FolderOpen /> <span className="path">{item.projectRoot}</span>
                </button>}
              </div>
            ))}
          </div>
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-footer">
          {running ? <button className="borderbtn" onClick={() => void stop()}><Square /> 停止导入</button> :
            <button className="primary" disabled={busy || !folder || !items.length || completed === items.length}
              onClick={() => void start()}>{attempted ? <RotateCcw /> : <Import />}{attempted ? "重试未完成项" : "开始导入"}</button>}
        </div>
      </section>
    </div>
  );
}
