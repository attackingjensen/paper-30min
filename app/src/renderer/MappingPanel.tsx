import { useEffect, useState } from "react";
import { Sparkles, Square, MessageSquare, Play, X } from "lucide-react";
import type { ChatSession } from "../shared/contracts";
import type { MappingPlan } from "../shared/mapping";

export function MappingPanel({ root, beforeStart, onParsing, onSession, onPublished }: {
  root: string;
  beforeStart: () => Promise<boolean>;
  onParsing: () => void;
  onSession: (id: string) => void;
  onPublished: () => void;
}) {
  const [plan, setPlan] = useState<MappingPlan>();
  const [session, setSession] = useState<ChatSession>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [needsParsing, setNeedsParsing] = useState(false);
  useEffect(() => {
    let disposed = false;
    const update = (state: ChatSession) => {
      if (disposed || state.root !== root || !state.mapping) return;
      setSession(state);
      if (!state.busy && state.mapping.status === "published") onPublished();
    };
    const unsubscribe = window.desktop.watchAgent(update);
    void window.desktop.agent<ChatSession[]>({ type: "list", root }).then(items => {
      if (!disposed) setSession(items.find(item => item.busy && item.mapping) ?? items.find(item => item.mapping));
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; unsubscribe(); };
  }, [root, onPublished]);
  async function act(operation: () => Promise<void>) {
    setPending(true); setError("");
    try { await operation(); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  const running = session?.busy;
  return <div className="mapping-panel">
    <div className="row">
      <button className="borderbtn" disabled={pending || running} onClick={() => void act(async () => {
        if (!await beforeStart()) throw new Error("请先处理未保存的文档或冲突，再生成建图。");
        const readiness = await window.desktop.parsing<{ ready: boolean; reason?: string }>({ type: "readiness", root });
        setNeedsParsing(!readiness.ready);
        if (!readiness.ready) throw new Error(readiness.reason ?? "请先完成论文解析与审阅。");
        setPlan(await window.desktop.agent<MappingPlan>({ type: "mappingPlan", root }));
      })}><Sparkles /> 生成地图与精解</button>
      {running && <button className="icon" title="停止建图" aria-label="停止建图" disabled={pending || session.stopping}
        onClick={() => void act(async () => { setSession(await window.desktop.agent<ChatSession>({ type: "stop", root, id: session.id })); })}><Square /></button>}
      {session && <button className="icon" title="查看建图会话" aria-label="查看建图会话" onClick={() => onSession(session.id)}><MessageSquare /></button>}
      {session?.mapping?.status === "pending" && !running && <button className="borderbtn" disabled={pending}
        onClick={() => void act(async () => {
          const state = await window.desktop.agent<ChatSession>({ type: "send", root, id: session.id,
            attachments: [{ kind: "skill", value: "paper-map.md", label: "建图" }], text: [
            "继续本次建图，先读取已完成候选和当前原文，补齐缺失内容并核查；完整成功后再写 result.json。保持原先确认的替换基线，不覆盖用户新内容。",
            ...(session.error ? [`上一轮应用报告：${session.error}。请核查并处理其中尚未解决的问题。`] : []),
          ].join("\n") });
          setSession(state); onSession(state.id);
        })}><Play /> 继续建图</button>}
      {running && <span role="status">{session.stopping ? "正在停止" : "建图中"}</span>}
      {session?.mapping?.status === "published" && !running && <span role="status">建图已完成</span>}
    </div>
    {(error || session?.error) && <p role="alert" className="form-error">{error || session?.error}</p>}
    {needsParsing && <button className="borderbtn" onClick={onParsing}>论文解析</button>}
    {session?.mapping?.status === "pending" && !running && <div className="path muted">{session.mapping.directory}</div>}
    {plan && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="生成地图与精解">
      <h2>生成地图与精解</h2>
      <p>{plan.targets.length ? "成功后替换以下成果，旧文件移入回收站：" : "生成一份阅读地图与按原文顺序组织的逐节论文精解。"}</p>
      {plan.targets.length > 0 && <ul className="mapping-targets">{plan.targets.map(file => <li className="path" key={file}>{file}</li>)}</ul>}
      <div className="modal-footer">
        <button className="borderbtn" disabled={pending} onClick={() => setPlan(undefined)}><X /> 取消</button>
        <button className="primary" disabled={pending} onClick={() => void act(async () => {
          if (!await beforeStart()) throw new Error("文档尚未保存或存在冲突。");
          const state = await window.desktop.agent<ChatSession>({ type: "mapping", root, planId: plan.id });
          setPlan(undefined); setSession(state); onSession(state.id);
        })}><Sparkles /> {plan.targets.length ? "确认替换并生成" : "开始建图"}</button>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </section></div>}
  </div>;
}
