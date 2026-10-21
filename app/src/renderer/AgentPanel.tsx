import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  Plus,
  Settings2,
  Sparkles,
  Square,
  FileCode,
  Terminal,
  FileOutput,
  Globe,
  Brain,
  Play,
} from "lucide-react";
import { AgentMessage } from "./AgentMessage";
import { copiedAnnotationText, setAnnotationClipboard } from "./annotation-clipboard";
import { isAnnotationLink } from "../shared/annotation-links";
import { extractChatSources, type ChatAttachment } from "../shared/chat-input";
import type { ResolvedReference } from "../shared/references";
import "./agent.css";
import type {
  AgentCommand,
  AgentSettings,
  ChatSession,
  ThinkingLevel,
  ChatTool,
} from "../shared/contracts";

export function AgentPanel({
  root,
  onSettings,
  initialView,
  onViewChange,
  onOpenFile,
  onCitation,
  selectedSession,
  onParsing,
}: {
  root: string;
  onSettings: () => void;
  initialView?: { active: string; text: string; attachments?: ChatAttachment[] };
  onViewChange: (view: { active: string; text: string; attachments?: ChatAttachment[] }) => void;
  onOpenFile: (path: string) => void;
  onCitation: (link: string) => void;
  selectedSession?: string;
  onParsing: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState(initialView?.active ?? "");
  const [text, setText] = useState(initialView?.text ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>(initialView?.attachments ?? []);
  const [materials, setMaterials] = useState<ChatAttachment[]>([]);
  const [mention, setMention] = useState<{ from: number; to: number; query: string }>();
  const [choice, setChoice] = useState(0);
  const [preview, setPreview] = useState<{ title: string; text: string }>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const choices = materials.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(mention?.query.toLowerCase() ?? ""));
  function addAttachments(items: ChatAttachment[]) {
    setAttachments(old => [...old, ...items.filter(item => !old.some(value => value.kind === item.kind && value.value === item.value))]);
  }
  function ingest(value: string) {
    const parsed = extractChatSources(value);
    setText(parsed.text);
    addAttachments(parsed.attachments);
  }
  function choose(item: ChatAttachment) {
    if (!mention) return;
    setText(text.slice(0, mention.from) + text.slice(mention.to));
    addAttachments([item]); setMention(undefined); inputRef.current?.focus();
  }
  function updateMention(input: HTMLTextAreaElement) {
    const end = input.selectionStart;
    const match = /(?:^|\s)@([^\s@]*)$/.exec(input.value.slice(0, end));
    setMention(match ? { from: end - match[1].length - 1, to: end, query: match[1] } : undefined);
    setChoice(0);
  }
  const mentionOpen = !!mention;
  useEffect(() => {
    if (!mentionOpen) return;
    let disposed = false;
    void window.desktop.agent<ChatAttachment[]>({ type: "materials", root }).then(items => { if (!disposed) setMaterials(items); }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; };
  }, [root, mentionOpen]);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ root: string; markdown: string }>).detail;
      if (detail.root !== root) return;
      const parsed = extractChatSources(detail.markdown);
      addAttachments(parsed.attachments); requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("paper30min-chat-source", receive);
    return () => window.removeEventListener("paper30min-chat-source", receive);
  }, [root]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [catalog, setCatalog] = useState<AgentSettings>();
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [readiness, setReadiness] = useState<{ ready: boolean; reason?: string }>();
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  useEffect(() => {
    if (!selectedSession) return;
    setActive(selectedSession);
    void window.desktop.agent<ChatSession>({ type: "open", root, id: selectedSession }).then(update).catch((error) => setError(error.message));
  }, [root, selectedSession]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await window.desktop.parsing<{ ready: boolean; reason?: string }>({ type: "readiness", root });
        if (!disposed) setReadiness(value);
      } catch (error) {
        if (!disposed) setReadiness({ ready: false, reason: (error as Error).message });
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [root]);
  useEffect(() => {
    onViewChange({ active, text, attachments });
  }, [active, text, attachments, onViewChange]);
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
  useLayoutEffect(() => {
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
    if ((!text.trim() && !attachments.length) || pending) return;
    follow.current = true;
    setAwayFromBottom(false);
    const conversation =
      current ?? (await command({ type: "create", root }, true));
    if (!conversation) return;
    if (
      await command({
        type: "send",
        root,
        id: conversation.id,
        text,
        attachments,
      })
    )
      { setText(""); setAttachments([]); setPreview(undefined); }
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
                  setAttachments([]); setPreview(undefined); setMention(undefined);
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
            setAttachments([]); setPreview(undefined); setMention(undefined);
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
        {/* A conversation is append-only. Keep each row mounted when its provisional
            message ID is replaced by Pi's persisted ID (including open details). */}
        {current?.messages.map((m, index) => (
          <div
            className={`chat-message ${m.role}`}
            key={`${current.id}:${index}`}
          >
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
                !current.busy && !current.reviewBatchId && (
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
              <details className="process-card thinking-card">
                <summary>
                  <Brain />
                  <span className="process-title">思考过程</span>
                  <ChevronDown className="process-chevron" />
                </summary>
                <div className="thinking-content">{m.thinking}</div>
              </details>
            )}
            <AgentMessage text={m.text} role={m.role} onError={setError} onCitation={onCitation} />
            {m.tools?.map((tool) => (
              <ToolProcess key={tool.id} tool={tool} onOpenFile={onOpenFile} />
            ))}
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
        {readiness && !readiness.ready && !current?.busy && (
          <div className="notice agent-readiness">
            <p>{readiness.reason}</p>
            <button className="borderbtn" onClick={onParsing}>论文解析</button>
          </div>
        )}
        {current?.reviewBatchId && !current.busy && !readiness?.ready && (
          <button className="borderbtn" disabled={pending}
            onClick={() => void command({ type: "review", root, batchId: current.reviewBatchId! }, true)}><Play /> 继续审阅</button>
        )}
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
        <div
          className={`agent-activity ${current?.busy ? "active" : ""}`}
          role={current?.busy ? "status" : undefined}
        >
          {current?.busy ? (
            <>
              <span />
              {current.stopping ? "正在停止…" : current.compacting ? "正在压缩上下文…" : "正在处理…"}
            </>
          ) : (
            "Enter 发送 · Ctrl+Enter 换行"
          )}
        </div>
        <div className="composer">
          <div className="chat-attachments">
            {attachments.map((item) => <span key={`${item.kind}:${item.value}`}>
              <button title={item.value} onClick={async () => {
                try {
                  if (item.kind !== "source") { setPreview({ title: item.label, text: item.value }); return; }
                  const result = await window.desktop.invoke<ResolvedReference>({ type: "resolveReference", root, link: item.value });
                  setPreview({ title: item.label, text: [
                    `${result.path} · 第 ${result.pages.map(page => page.page).join("、")} 页`,
                    result.excerpt ? `关注文字：${result.excerpt}` : "",
                    ...result.manuscript.locations.map(location => `解析稿：${location.path}，第 ${location.startLine}–${location.endLine} 行（链接第 ${location.linkLine} 行）`),
                    result.manuscript.reason ?? "",
                    ...result.discussions.map((discussion, index) => `讨论 ${index + 1}（${discussion.status}）：\n` + discussion.entries.map(entry => `${entry.parentId ? "回复 " + entry.parentId : "根批注"} [${entry.id}]：${entry.comment ?? "（无文字）"}`).join("\n")),
                    ...result.warnings,
                  ].filter(Boolean).join("\n\n") });
                } catch (error) { setError((error as Error).message); }
              }}>{item.kind === "source" ? "来源" : item.kind === "skill" ? "Skill" : "文档"} · {item.label}</button>
              <button aria-label={`移除 ${item.label}`} onClick={() => { setAttachments(old => old.filter(value => value !== item)); setPreview(undefined); }}>×</button>
            </span>)}
          </div>
          {preview && <section className="chat-source-preview" aria-label="附件预览"><button onClick={() => setPreview(undefined)}>关闭预览</button><pre>{preview.text}</pre></section>}
          {mention && <div className="mention-menu" role="listbox" aria-label="选择文档或 Skill">
            {(["document", "skill"] as const).map(kind => <section key={kind}><strong>{kind === "document" ? "工程文档" : "产品 Skills"}</strong>
              {choices.filter(item => item.kind === kind).map(item => <button role="option" aria-selected={choices.indexOf(item) === choice} key={item.value} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>{item.label}<small>{item.value}</small></button>)}
            </section>)}
            {!choices.length && <p>没有匹配材料</p>}
          </div>}
          <textarea
            ref={inputRef}
            onPaste={(event) => {
              try {
                const pasted = copiedAnnotationText(event.clipboardData, root, "");
                event.preventDefault();
                const input = event.currentTarget;
                const start = input.selectionStart;
                ingest(input.value.slice(0, start) + (pasted ?? event.clipboardData.getData("text/plain")) + input.value.slice(input.selectionEnd));
              } catch (error) { event.preventDefault(); setError((error as Error).message); }
            }}
            onCopy={(event) => {
              const input = event.currentTarget;
              const selected = input.value.slice(input.selectionStart, input.selectionEnd);
              if (!isAnnotationLink(selected)) return;
              event.preventDefault();
              setAnnotationClipboard(event.clipboardData, selected, root, "");
            }}
            aria-label="Agent 消息"
            placeholder="有什么想聊的？"
            title="Enter 发送，Ctrl+Enter 换行"
            value={text}
            maxLength={100000}
            onChange={(e) => {
              setText(e.target.value);
              updateMention(e.target);
            }}
            onSelect={event => updateMention(event.currentTarget)}
            onKeyDown={(event) => {
              if (mention && !event.nativeEvent.isComposing) {
                if (event.key === "Escape") { event.preventDefault(); setMention(undefined); return; }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setChoice(value => (value + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % Math.max(1, choices.length)); return; }
                if ((event.key === "Enter" || event.key === "Tab") && choices[choice]) { event.preventDefault(); choose(choices[choice]); return; }
              }
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
            disabled={pending || current?.stopping}
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
              {selectedModel && (
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
                      {level === "off" ? "不思考" : level}
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
                disabled={pending || (!text.trim() && !attachments.length) || current?.stopping}
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

function ToolProcess({
  tool,
  onOpenFile,
}: {
  tool: ChatTool;
  onOpenFile: (path: string) => void;
}) {
  const details = tool.details as
    | {
        artifacts?: string[];
        change?: { path: string; patch: string };
        conflict?: {
          base: string | null;
          current: string | null;
          proposed: string;
        };
      }
    | undefined;
  const args = tool.arguments as
    | {
        path?: string;
        command?: string;
        query?: string;
        url?: string;
        responseId?: string;
      }
    | undefined;
  return (
    <details
      className="process-card tool-process"
      data-tool={tool.name}
      data-status={tool.status}
    >
      <summary>
        {["web_search", "fetch_content", "get_search_content"].includes(
          tool.name,
        ) ? (
          <Globe />
        ) : tool.name === "bash" ? (
          <Terminal />
        ) : (
          <FileCode />
        )}
        <span className="process-title">
          <span className="process-name">
            {{
              read: "读取文件",
              read_pdf: "读取 PDF 原文",
              complete_review_page: "保存审阅进度",
              write: "写入文件",
              edit: "编辑文件",
              bash: "运行命令",
              web_search: "搜索网页",
              fetch_content: "读取网页",
              get_search_content: "继续查阅",
            }[tool.name] ?? tool.name}
          </span>
          <span
            className="process-subject"
            title={args?.path ?? args?.query ?? args?.url ?? args?.responseId}
          >
            {args?.query ??
              args?.url ??
              args?.path?.replace(/\\/g, "/").split("/").at(-1) ??
              (tool.name === "bash" ? "PowerShell" : args?.responseId)}
          </span>
        </span>
        <small className="process-status">
          {
            {
              running: "运行中",
              done: "完成",
              error: "失败",
              aborted: "已停止",
            }[tool.status]
          }
        </small>
        <ChevronDown className="process-chevron" />
      </summary>
      <div className="process-body">
        <div className="process-label">参数 · {tool.name}</div>
        <pre className="tool-arguments">
          {args?.command ?? JSON.stringify(tool.arguments, null, 2)}
        </pre>
        {tool.output && (
          <>
            <div className="process-label">结果</div>
            <pre className="tool-output">{tool.output}</pre>
          </>
        )}
        {details?.change && (
          <>
            <button
              className="tool-file"
              onClick={() => onOpenFile(details.change!.path)}
            >
              <FileOutput />
              {details.change.path}
            </button>
            <pre className="tool-diff">
              {details.change.patch || "内容未改变"}
            </pre>
          </>
        )}
        {details?.artifacts?.map((file) => (
          <button
            key={file}
            className="tool-file"
            onClick={() => onOpenFile(file)}
          >
            <FileOutput />
            {file}
          </button>
        ))}
        {details?.conflict && (
          <div className="tool-conflict">
            <strong>写入冲突</strong>
            <label>读取基线</label>
            <pre>{details.conflict.base ?? "新文件"}</pre>
            <label>磁盘内容</label>
            <pre>{details.conflict.current ?? "文件已删除"}</pre>
            <label>本次内容</label>
            <pre>{details.conflict.proposed}</pre>
          </div>
        )}
      </div>
    </details>
  );
}
