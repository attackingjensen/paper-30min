import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  Plus,
  Settings2,
  Sparkles,
  Square,
} from "lucide-react";
import { AgentMessage } from "./AgentMessage";
import "./agent.css";
import type {
  AgentCommand,
  AgentSettings,
  ChatSession,
  ThinkingLevel,
} from "../shared/contracts";

export function AgentPanel({
  root,
  onSettings,
  initialView,
  onViewChange,
}: {
  root: string;
  onSettings: () => void;
  initialView?: { active: string; text: string };
  onViewChange: (view: { active: string; text: string }) => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState(initialView?.active ?? "");
  const [text, setText] = useState(initialView?.text ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [catalog, setCatalog] = useState<AgentSettings>();
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  useEffect(() => {
    onViewChange({ active, text });
  }, [active, text, onViewChange]);
  const update = useCallback(
    (state: ChatSession) => {
      if (state.root !== root) return;
      setSessions((old) => {
        const previous = old.find((s) => s.id === state.id);
        if (previous && previous.revision > state.revision) return old;
        return previous
          ? old.map((s) => (s.id === state.id ? state : s))
          : [...old, state];
      });
    },
    [root],
  );
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.desktop.watchAgent((state) => {
      if (!disposed) update(state);
    });
    void window.desktop
      .agent<ChatSession[]>({ type: "list", root })
      .then((items) => {
        if (disposed) return;
        for (const item of items) update(item);
        setActive((id) => id || items[0]?.id || "");
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [root, update]);
  useEffect(() => {
    let disposed = false;
    void window.desktop
      .agent<AgentSettings>({ type: "settings" })
      .then((value) => {
        if (!disposed) setCatalog(value);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const current = sessions.find((s) => s.id === active);
  const selectedModel = catalog?.models.find(
    (model) => model.id === catalog.selectedModelId,
  );
  async function selectModel(modelId: string, thinking?: ThinkingLevel) {
    try {
      setCatalog(
        await window.desktop.agent<AgentSettings>({
          type: "selectModel",
          modelId,
          thinking,
        }),
      );
      setModelOpen(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    const el = scroll.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [active, current?.revision]);
  async function command(command: AgentCommand, select = false) {
    setPending(true);
    setError("");
    try {
      const state = await window.desktop.agent<ChatSession>(command);
      update(state);
      if (select) {
        follow.current = true;
        setAwayFromBottom(false);
        setActive(state.id);
      }
      return state;
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setPending(false);
    }
  }
  async function send() {
    if (!text.trim() || pending) return;
    follow.current = true;
    setAwayFromBottom(false);
    const conversation =
      current ?? (await command({ type: "create", root }, true));
    if (!conversation) return;
    if (await command({ type: "send", root, id: conversation.id, text }))
      setText("");
  }
  return (
    <aside className="right">
      <div className="agent-head">
        <Sparkles />
        <span>Agent</span>
        <div className="session-switch">
          {sessions.length > 0 && (
            <>
              <select
                aria-label="会话"
                value={active}
                onChange={(e) => {
                  follow.current = true;
                  setAwayFromBottom(false);
                  setActive(e.target.value);
                  setText("");
                  setError("");
                }}
              >
                {!active && <option value="">选择会话</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                    {s.busy ? " · 运行中" : ""}
                  </option>
                ))}
              </select>
              <ChevronDown />
            </>
          )}
        </div>
        <button
          className="icon"
          title="新会话"
          aria-label="新会话"
          disabled={pending}
          onClick={() => {
            setText("");
            void command({ type: "create", root }, true);
          }}
        >
          <Plus />
        </button>
      </div>
      <div
        className="chat"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (!el) return;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          setAwayFromBottom(!follow.current);
        }}
      >
        {!current?.messages.length && (
          <div className="agent-welcome">
            <div className="agent-welcome-mark">
              <Sparkles />
            </div>
            <h3>从一个问题开始</h3>
            <p>聊聊你的想法，或继续探索阅读中遇到的问题。</p>
          </div>
        )}
        {current?.messages.map((m) => (
          <div className={`chat-message ${m.role}`} key={m.id}>
            <div className="message-head">
              <span>
                {m.role === "user" ? (
                  "你"
                ) : (
                  <>
                    <Sparkles /> Agent
                  </>
                )}
              </span>
              {m.id !== "streaming" &&
                m.id !== "pending-user" &&
                !current.busy && (
                  <button
                    className="icon"
                    title="从此消息分支"
                    aria-label="从此消息分支"
                    disabled={pending}
                    onClick={() =>
                      void command(
                        {
                          type: "branch",
                          root,
                          id: current.id,
                          messageId: m.id,
                        },
                        true,
                      )
                    }
                  >
                    <GitBranch />
                  </button>
                )}
            </div>
            {m.role === "assistant" && m.thinking && (
              <details className="thinking-card">
                <summary>
                  Thinking <ChevronDown />
                </summary>
                <div className="thinking-content">{m.thinking}</div>
              </details>
            )}
            <AgentMessage text={m.text} role={m.role} onError={setError} />
            {m.status && (
              <small>{m.status === "aborted" ? "已停止" : "请求失败"}</small>
            )}
          </div>
        ))}
        {current?.queued.map((message, i) => (
          <div className="queued-message" key={i}>
            待补充：{message}
          </div>
        ))}
        {(error || current?.error) && (
          <p className="agent-error" role="alert">
            {error || current?.error}
          </p>
        )}
      </div>
      <div className="composer-wrap">
        {awayFromBottom && (
          <button
            className="latest-message"
            onClick={() => {
              follow.current = true;
              setAwayFromBottom(false);
              if (scroll.current)
                scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            <ArrowDown /> 回到最新消息
          </button>
        )}
        {current?.busy && (
          <div className="agent-activity" role="status">
            <span />
            {current.stopping ? "正在停止…" : "正在回复…"}
          </div>
        )}
        <div className="composer">
          <textarea
            aria-label="Agent 消息"
            placeholder="有什么想聊的？"
            title="Enter 发送，Ctrl+Enter 换行"
            value={text}
            maxLength={100000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              event.preventDefault();
              if (event.ctrlKey) {
                const input = event.currentTarget;
                input.setRangeText(
                  "\n",
                  input.selectionStart,
                  input.selectionEnd,
                  "end",
                );
                setText(input.value);
              } else if (!event.repeat) {
                void send();
              }
            }}
            disabled={current?.stopping}
          />
          <div className="composer-foot">
            <div className="composer-config">
              <div
                className="model-picker"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setModelOpen(false);
                }}
              >
                <button
                  className="model-picker-trigger"
                  type="button"
                  title="选择模型"
                  aria-label="选择模型"
                  aria-expanded={modelOpen}
                  onClick={() => {
                    setModelOpen(!modelOpen);
                    setModelQuery("");
                  }}
                >
                  <span>
                    {selectedModel?.name || selectedModel?.model || "选择模型"}
                  </span>
                  <ChevronDown />
                </button>
                {modelOpen && (
                  <div className="model-picker-menu">
                    <input
                      autoFocus
                      aria-label="搜索模型"
                      placeholder="搜索模型或服务"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setModelOpen(false);
                      }}
                    />
                    <div className="model-picker-options">
                      {catalog?.models
                        .filter((model) => {
                          const service = catalog.services.find(
                            (item) => item.id === model.serviceId,
                          );
                          return `${model.name} ${model.model} ${service?.name}`
                            .toLowerCase()
                            .includes(modelQuery.toLowerCase());
                        })
                        .map((model) => {
                          const service = catalog.services.find(
                            (item) => item.id === model.serviceId,
                          );
                          return (
                            <button
                              type="button"
                              key={model.id}
                              className={
                                model.id === catalog.selectedModelId
                                  ? "active"
                                  : ""
                              }
                              onClick={() => void selectModel(model.id)}
                            >
                              <span>
                                {model.name || model.model || "未命名模型"}
                              </span>
                              <small>{service?.name}</small>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
              {selectedModel && selectedModel.availableThinking.length > 1 && (
                <select
                  aria-label="思考等级"
                  value={selectedModel.thinking}
                  onChange={(e) =>
                    void selectModel(
                      selectedModel.id,
                      e.target.value as ThinkingLevel,
                    )
                  }
                >
                  {selectedModel.availableThinking.map((level) => (
                    <option key={level} value={level}>
                      {level === "off" ? "无思考" : level}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="model-settings-link"
                onClick={onSettings}
                title="Agent 模型设置"
                aria-label="模型设置"
              >
                <Settings2 />
              </button>
            </div>
            <div className="row">
              {current?.busy && (
                <button
                  className="icon stop-response"
                  title="停止回复"
                  aria-label="停止回复"
                  disabled={current.stopping}
                  onClick={() =>
                    void command({ type: "stop", root, id: current.id })
                  }
                >
                  <Square />
                </button>
              )}
              <button
                className="icon"
                title={current?.busy ? "补充消息" : "发送消息"}
                aria-label={current?.busy ? "补充消息" : "发送消息"}
                disabled={pending || !text.trim() || current?.stopping}
                onClick={() => void send()}
              >
                <ArrowUp />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
