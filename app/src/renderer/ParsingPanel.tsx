import { useEffect, useState } from "react";
import {
  FileSearch,
  FileText,
  KeyRound,
  Settings2,
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
      className="agent-settings parsing-settings"
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
      <p className="settings-intro">将 PDF 转为带原文引用的正文，供后续审阅使用。</p>
      <fieldset className="settings-fields" disabled={busy}>
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2><FileSearch /> 百度文档解析</h2>
            <span>所有工程共用</span>
          </div>
          <label htmlFor="parsing-model">解析模型
            <select id="parsing-model" value={settings.model}
              onChange={(event) => setSettings({ ...settings, model: event.target.value })}>
              <option>PaddleOCR-VL-1.6</option>
            </select>
          </label>
          <label htmlFor="parsing-endpoint">百度任务地址
            <input id="parsing-endpoint" type="url" value={settings.endpoint}
              onChange={(event) => setSettings({ ...settings, endpoint: event.target.value })} required />
          </label>
          <div className="settings-key-heading">
            <span><KeyRound /> 服务凭据</span>
            <span className={`key-state ${settings.hasKey && !clearKey && !settings.keyError ? "configured" : ""}`}>
              {clearKey ? "待清除" : settings.keyError ? "需要更新" : settings.hasKey ? "已配置" : "未配置"}
            </span>
          </div>
          <label htmlFor="parsing-token">百度 Token
            <input id="parsing-token" type="password" autoComplete="off" value={token}
              placeholder={clearKey ? "保存后清除" : settings.keyError ? "凭据无法解密，请重新填写" : settings.hasKey ? "已保存，留空保留" : "填写百度解析服务的 Token"}
              onChange={(event) => { setToken(event.target.value); setClearKey(false); }} />
          </label>
          <div className="key-help">
            <p>凭据加密保存在本机，不随论文工程保存。</p>
            <button type="button" className="remove-key" aria-label="清除百度 Token"
              disabled={clearKey}
              onClick={() => { setToken(""); setClearKey(true); }}>
              <Trash2 /> 清除 Token
            </button>
          </div>
          {settings.keyError && !clearKey && <p className="settings-feedback" role="alert">已保存的凭据无法读取，请重新填写或清除。</p>}
        </section>
      </fieldset>
      <div className="settings-save-row">
        <button className="primary" disabled={busy}><Save /> {busy ? "正在保存…" : "保存解析配置"}</button>
        {message && <p className={`settings-feedback ${message === "解析配置已保存。" ? "success" : ""}`} role="status">{message}</p>}
      </div>
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
      <header className="parsing-heading">
        <div><FileSearch className="document-symbol" /><h1>论文解析</h1>
          <p className="parsing-description">将论文转换为带原文引用的正文，保留图表与公式。</p>
        </div>
        <button className="borderbtn" onClick={onSettings}>
          <Settings2 /> 解析设置
        </button>
      </header>
      <section className="parsing-source" aria-label="开始解析">
        <label htmlFor="parsing-document">选择 PDF</label>
        <div className="row parsing-start">
        <select
          id="parsing-document"
          aria-label="待解析 PDF"
          value={documentId}
          onChange={(event) => setDocumentId(event.target.value)}
        >
          {[project.manifest.paper, ...project.manifest.materials]
            .filter((record) => /\.pdf$/i.test(record.path))
            .map((record) => (
              <option key={record.id} value={record.id}>
                {record.id === project.manifest.paper.id ? `${record.path.split("/").at(-1)} · 工程论文` : record.path}
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
        <p className="parsing-source-help">解析结果保存在工程内，完成后可查看正文；Agent 审阅功能尚未接入。</p>
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
      </section>
      {(error || statusError) && (
        <div className="notice error" role="alert">
          {error || statusError}
        </div>
      )}
      <div className="parsing-history-heading"><h2>解析记录</h2><span>{runs.length} 次</span></div>
      <div className="parsing-runs">
        {!runs.length && <div className="parsing-empty"><FileText /><strong>还没有解析正文</strong><p>选择上方的 PDF 开始解析，完成后从这里打开正文。</p></div>}
        {runs.map((run) => (
          <section
            className="parsing-run"
            key={run.batchId}
            aria-label={`解析批次 ${run.batchId}`}
          >
            <div className="between row">
              <strong className="parsing-document-name"><FileText />{run.document.path.split("/").at(-1)}</strong>
              <span className={`parsing-phase ${run.phase}`} role="status">
                {run.stopping
                  ? "正在停止，等待提交回执"
                  : phaseNames[run.phase]}
              </span>
            </div>
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
            <details className="parsing-details">
              <summary>任务详情</summary>
              <dl><dt>文档</dt><dd>{run.document.path}</dd><dt>批次</dt><dd>{run.batchId}</dd>
                {run.jobId && <><dt>任务号</dt><dd>{run.jobId}</dd></>}
                <dt>解析模型</dt><dd>{run.model}</dd>
              </dl>
            </details>
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
                  <FileText /> 查看正文
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
