import { useEffect, useState } from "react";
import {
  FileSearch,
  Play,
  RefreshCw,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import {
  defaultParsingSettings,
  type ParsingSettings,
  type ParsingRun,
  type ParsingCommand,
} from "../shared/parsing";
import type { Project } from "../shared/contracts";
import "./parsing.css";

export function ParsingSettingsForm() {
  const [settings, setSettings] = useState<ParsingSettings>(
    defaultParsingSettings,
  );
  const [token, setToken] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    void window.desktop
      .parsing<ParsingSettings>({ type: "settings" })
      .then((value) => {
        if (!disposed) setSettings(value);
      })
      .catch((error) => {
        if (!disposed) setMessage(error.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <form
      className="parsing-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setMessage("");
        void window.desktop
          .parsing<ParsingSettings>({
            type: "saveSettings",
            settings,
            apiKey: token,
            clearKey,
          })
          .then((value) => {
            setSettings(value);
            setToken("");
            setClearKey(false);
            setMessage("解析配置已保存。");
          })
          .catch((error) => setMessage(error.message))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor="parsing-endpoint">百度任务地址</label>
      <input
        id="parsing-endpoint"
        value={settings.endpoint}
        onChange={(event) =>
          setSettings({ ...settings, endpoint: event.target.value })
        }
        required
      />
      <label htmlFor="parsing-model">解析模型</label>
      <select
        id="parsing-model"
        value={settings.model}
        onChange={(event) =>
          setSettings({ ...settings, model: event.target.value })
        }
      >
        <option>PaddleOCR-VL-1.6</option>
      </select>
      <label htmlFor="parsing-token">百度 Token</label>
      <div className="row">
        <input
          id="parsing-token"
          type="password"
          autoComplete="off"
          value={token}
          placeholder={
            clearKey
              ? "保存后清除"
              : settings.keyError
                ? "凭据无法解密，请重新填写"
                : settings.hasKey
                  ? "已保存，留空保留"
                  : "尚未配置"
          }
          onChange={(event) => {
            setToken(event.target.value);
            setClearKey(false);
          }}
        />
        <button
          type="button"
          className="icon"
          title="清除百度 Token"
          aria-label="清除百度 Token"
          onClick={() => {
            setToken("");
            setClearKey(true);
          }}
        >
          <Trash2 />
        </button>
      </div>
      <button className="primary" disabled={busy}>
        <Save /> 保存解析配置
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

const phaseNames: Record<ParsingRun["phase"], string> = {
  preparing: "准备解析",
  submitting: "正在提交",
  unknown: "提交结果不明",
  querying: "云端处理中",
  downloading: "正在下载",
  mapping: "正在保存候选",
  stopped: "已停止",
  failed: "处理失败",
  "remote-failed": "云端任务失败",
  candidate: "待 Agent 审阅",
};

export function ParsingPanel({
  project,
  onOpen,
  onSettings,
}: {
  project: Project;
  onOpen: (path: string) => void;
  onSettings: () => void;
}) {
  const [runs, setRuns] = useState<ParsingRun[]>([]);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobIds, setJobIds] = useState<Record<string, string>>({});
  const [documentId, setDocumentId] = useState(project.manifest.paper.id);
  const [confirming, setConfirming] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await window.desktop.parsing<ParsingRun[]>({
          type: "status",
          root: project.root,
        });
        if (!disposed) {
          setRuns(result);
          setStatusError("");
        }
      } catch (error) {
        if (!disposed) setStatusError((error as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 1500);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project.root, revision]);
  const command = async (value: ParsingCommand) => {
    setBusy(true);
    setError("");
    try {
      await window.desktop.parsing(value);
      setRevision((value) => value + 1);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="article parsing-panel">
      <div className="between row">
        <h1>论文解析</h1>
        <button className="borderbtn" onClick={onSettings}>
          解析设置
        </button>
      </div>
      <div className="row parsing-start">
        <select
          aria-label="待解析 PDF"
          value={documentId}
          onChange={(event) => setDocumentId(event.target.value)}
        >
          {[project.manifest.paper, ...project.manifest.materials]
            .filter((record) => /\.pdf$/i.test(record.path))
            .map((record) => (
              <option key={record.id} value={record.id}>
                {record.path}
              </option>
            ))}
        </select>
        <button
          className="primary"
          disabled={busy || runs.some((run) => run.busy)}
          onClick={() => setConfirming(true)}
        >
          <FileSearch /> 解析 PDF
        </button>
      </div>
      {confirming && (
        <div
          className="parsing-confirm"
          role="dialog"
          aria-label="确认云端解析"
        >
          <p>将工程内此 PDF 上传到已配置的百度解析服务，可能产生费用。</p>
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void command({ type: "start", root: project.root, documentId });
              }}
            >
              <Play /> 上传并解析
            </button>
            <button onClick={() => setConfirming(false)}>取消</button>
          </div>
        </div>
      )}
      {(error || statusError) && (
        <div className="notice error" role="alert">
          {error || statusError}
        </div>
      )}
      <div className="parsing-runs">
        {!runs.length && <p className="muted">尚无解析候选</p>}
        {runs.map((run) => (
          <section
            className="parsing-run"
            key={run.batchId}
            aria-label={`解析批次 ${run.batchId}`}
          >
            <div className="between row">
              <strong>{run.document.path.split("/").at(-1)}</strong>
              <span className={`parsing-phase ${run.phase}`} role="status">
                {run.stopping
                  ? "正在停止，等待提交回执"
                  : phaseNames[run.phase]}
              </span>
            </div>
            <p className="muted path">{run.batchId}</p>
            <div className="row muted tiny">
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span>
                {run.completedPages} / {run.pageCount || "?"} 页
              </span>
              <span>{Math.round(run.elapsedMs / 1000)} 秒</span>
            </div>
            {run.busy && (
              <progress
                aria-label="解析进度"
                max={run.pageCount || 1}
                value={run.phase === "mapping" ? run.completedPages : undefined}
              />
            )}
            {run.jobId && <p className="tiny path">任务号：{run.jobId}</p>}
            {run.error && <p className="parsing-error">{run.error}</p>}
            {run.phase === "unknown" && !run.busy && (
              <label className="parsing-job">
                关联百度任务号
                <input
                  aria-label={`百度任务号 ${run.batchId}`}
                  value={jobIds[run.batchId] ?? ""}
                  onChange={(event) =>
                    setJobIds({ ...jobIds, [run.batchId]: event.target.value })
                  }
                />
              </label>
            )}
            <div className="row">
              {run.busy ? (
                <button
                  className="borderbtn"
                  disabled={busy || run.stopping}
                  onClick={() =>
                    void command({
                      type: "stop",
                      root: project.root,
                      batchId: run.batchId,
                    })
                  }
                >
                  <Square /> 停止解析
                </button>
              ) : run.phase === "remote-failed" ? null : run.phase !==
                "candidate" ? (
                <button
                  className="borderbtn"
                  disabled={
                    busy || (run.phase === "unknown" && !jobIds[run.batchId])
                  }
                  onClick={() =>
                    void command({
                      type: "resume",
                      root: project.root,
                      batchId: run.batchId,
                      jobId:
                        run.phase === "unknown"
                          ? jobIds[run.batchId]
                          : undefined,
                    })
                  }
                >
                  <RefreshCw />{" "}
                  {run.phase === "unknown" ? "关联并恢复查询" : "恢复解析"}
                </button>
              ) : (
                <button
                  className="borderbtn"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void window.desktop
                      .parsing({
                        type: "verify",
                        root: project.root,
                        batchId: run.batchId,
                      })
                      .then(() => onOpen(run.candidate!))
                      .catch((error) => setError(error.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  <FileSearch /> 查看候选
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
