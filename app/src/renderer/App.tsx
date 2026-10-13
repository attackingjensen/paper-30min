import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronDown,
  File,
  FileText,
  Folder,
  FolderOpen,
  Home,
  Map,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  Command,
  CreateInput,
  Preferences,
  Project,
} from "../shared/contracts";

const desktop = window.desktop;
type Tab = { key: string; title: string; path?: string };
type Dialog =
  | {
      type: "create";
      source: string;
      parent: string;
      name: string;
      makeDefault: boolean;
    }
  | { type: "move"; path: string; destination: string }
  | { type: "trash"; id: string; name: string };

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function App() {
  const [preferences, setPreferences] = useState<Preferences>({
    defaultFolder: null,
    recent: [],
  });
  const [project, setProject] = useState<Project | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("");
  const [navigation, setNavigation] = useState<"reading" | "files">("reading");
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(window.innerWidth >= 900);
  const [settings, setSettings] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const current = tabs.find((t) => t.key === active);
  const root = project?.root;

  const run = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
      setError("");
      setBusy(true);
      try {
        return await operation();
      } catch (e) {
        setError(
          (e as Error).message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  const reloadPreferences = () =>
    desktop.invoke<Preferences>({ type: "preferences" }).then(setPreferences);
  useEffect(() => {
    void run(reloadPreferences);
  }, [run]);
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 900) setRight(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let disposed = false;
    setContent(null);
    if (root && current?.path) {
      desktop
        .invoke<string | null>({ type: "read", root, path: current.path })
        .then((value) => {
          if (!disposed) setContent(value);
        })
        .catch((e) => {
          if (!disposed) setError((e as Error).message);
        });
    }
    return () => {
      disposed = true;
    };
  }, [root, current?.path, project]);

  const refresh = useCallback(() => {
    if (root)
      void run(async () =>
        setProject(await desktop.invoke<Project>({ type: "refresh", root })),
      );
  }, [root, run]);
  useEffect(() => {
    const onFocus = () => {
      if (!busy && !creating) refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, busy, creating]);

  function openTab(tab: Tab) {
    setTabs((old) =>
      old.some((t) => t.key === tab.key) ? old : [...old, tab],
    );
    setActive(tab.key);
  }
  function openPath(filePath: string) {
    openTab({
      key: filePath,
      path: filePath,
      title: filePath.split("/").at(-1)!,
    });
  }
  function enter(p: Project) {
    setProject(p);
    const tab = {
      key: p.manifest.paper.path,
      path: p.manifest.paper.path,
      title: p.manifest.paper.path.split("/").at(-1)!,
    };
    setTabs([tab]);
    setActive(tab.key);
    setSettings(null);
  }
  function closeTab(key: string) {
    const remaining = tabs.filter((t) => t.key !== key);
    setTabs(remaining);
    if (active === key) setActive(remaining.at(-1)?.key ?? "");
  }
  async function openProject(folder?: string) {
    await run(async () => {
      const selected = folder ?? (await desktop.choose("folder"));
      if (!selected) return;
      const p = await desktop.invoke<Project>({ type: "open", root: selected });
      enter(p);
      await reloadPreferences();
    });
  }
  async function newProject() {
    await run(async () => {
      const source = await desktop.choose("pdf");
      if (!source) return;
      const name = source
        .split(/[\\/]/)
        .at(-1)!
        .replace(/\.pdf$/i, "");
      setDialog({
        type: "create",
        source,
        name,
        parent: preferences.defaultFolder ?? "",
        makeDefault: !preferences.defaultFolder,
      });
    });
  }
  async function createProject(d: Extract<Dialog, { type: "create" }>) {
    const operationId = crypto.randomUUID();
    setCreating(operationId);
    await run(async () => {
      const input: CreateInput = { ...d, operationId };
      const p = await desktop.invoke<Project>({ type: "create", input });
      enter(p);
      setDialog(null);
      await reloadPreferences();
    });
    setCreating(null);
  }
  async function update(command: Command) {
    return run(async () => {
      const p = await desktop.invoke<Project>(command);
      setProject(p);
      return p;
    });
  }
  async function addMaterial() {
    await run(async () => {
      const source = await desktop.choose("material");
      if (source && root)
        setProject(
          await desktop.invoke<Project>({ type: "addMaterial", root, source }),
        );
    });
  }
  async function relink(id: string) {
    await run(async () => {
      const source = await desktop.choose(
        id === project?.manifest.paper.id ? "pdf" : "material",
      );
      if (!source || !root || !project) return;
      const oldPath = [
        project.manifest.paper,
        ...project.manifest.materials,
      ].find((r) => r.id === id)!.path;
      const p = await desktop.invoke<Project>({
        type: "relink",
        root,
        id,
        source,
      });
      const newPath = [p.manifest.paper, ...p.manifest.materials].find(
        (r) => r.id === id,
      )!.path;
      retargetTabs(oldPath, newPath);
      setProject(p);
    });
  }
  function retargetTabs(from: string, to: string) {
    setTabs((old) =>
      old.map((t) =>
        t.path === from
          ? { key: to, path: to, title: to.split("/").at(-1)! }
          : t,
      ),
    );
    setActive((old) => (old === from ? to : old));
  }
  const missingCurrent =
    current?.path &&
    project &&
    !project.files.some((f) => f.path === current.path && !f.directory);
  const record =
    project &&
    [project.manifest.paper, ...project.manifest.materials].find(
      (r) => r.path === current?.path,
    );
  const separator =
    preferences.defaultFolder?.includes("\\") ||
    (dialog?.type === "create" && dialog.parent.includes("\\"))
      ? "\\"
      : "/";

  function nav(label: string, icon: ReactNode, tab: Tab) {
    return (
      <button
        className={`nav ${active === tab.key ? "selected" : ""}`}
        onClick={() => openTab(tab)}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }
  function materialList() {
    if (!project) return null;
    return [project.manifest.paper, ...project.manifest.materials].map((r) => (
      <div className="material-row" key={r.id}>
        <FileText />
        <button
          className="material-name"
          onClick={() => openPath(r.path)}
          title={r.path}
        >
          {r.path.split("/").at(-1)}
          <small>{r.path}</small>
        </button>
        {r.id === project.manifest.paper.id && (
          <span className="pill">工程论文</span>
        )}
        {project.missing.includes(r.id) ? (
          <button onClick={() => void relink(r.id)} disabled={busy}>
            重新关联
          </button>
        ) : (
          <IconButton
            label={`改名或移动 ${r.path}`}
            onClick={() =>
              setDialog({ type: "move", path: r.path, destination: r.path })
            }
          >
            <MoreHorizontal />
          </IconButton>
        )}
        {r.id !== project.manifest.paper.id &&
          !project.missing.includes(r.id) && (
            <IconButton
              label={`移出 ${r.path}`}
              onClick={() =>
                setDialog({ type: "trash", id: r.id, name: r.path })
              }
            >
              <Trash2 />
            </IconButton>
          )}
      </div>
    ));
  }
  function contentView() {
    if (!current) return <div className="empty">尚未打开文档</div>;
    if (current.key === "materials")
      return (
        <article className="article">
          <h1>相关材料</h1>
          {materialList()}
        </article>
      );
    if (missingCurrent)
      return (
        <article className="article">
          <FileText className="document-symbol" />
          <h1>找不到文件</h1>
          <p className="muted path">{current.path}</p>
          {record && (
            <button
              className="borderbtn"
              onClick={() => void relink(record.id)}
              disabled={busy}
            >
              重新关联
            </button>
          )}
        </article>
      );
    if (current.path)
      return (
        <article className="article">
          <FileText className="document-symbol" />
          <h1>{current.title}</h1>
          <p className="muted path">{current.path}</p>
          {content !== null ? (
            <pre className="file-content">{content}</pre>
          ) : (
            <button
              className="borderbtn"
              disabled={busy}
              onClick={() =>
                void run(() => desktop.openFile(root!, current.path!))
              }
            >
              <FolderOpen /> 在外部应用中打开
            </button>
          )}
        </article>
      );
    const paths =
      current.key === "map"
        ? project?.manifest.map
          ? [project.manifest.map]
          : []
        : current.key === "explanations"
          ? (project?.manifest.explanations ?? [])
          : current.key === "translations"
            ? Object.values(project?.manifest.translations ?? {})
            : (project?.files
                .filter((f) => !f.directory && f.path.startsWith("notes/"))
                .map((f) => f.path) ?? []);
    return (
      <article className="article">
        <h1>{current.title}</h1>
        {paths.length ? (
          paths.map((p) => (
            <button
              className="document-row"
              key={p}
              onClick={() => openPath(p)}
            >
              <FileText />
              {p.split("/").at(-1)}
            </button>
          ))
        ) : (
          <div className="empty">尚无{current.title}</div>
        )}
      </article>
    );
  }

  return (
    <>
      <header className="top">
        <IconButton
          label={left ? "收起左侧栏" : "展开左侧栏"}
          onClick={() => setLeft(!left)}
        >
          <PanelLeft />
        </IconButton>
        <BookOpen className="brand-mark" />
        <span className="brand">Paper30Min</span>
        <span className="slash">/</span>
        <span>{settings ? "设置" : project ? "工作台" : "本地工程"}</span>
        <span className="spacer" />
        <span className="tiny muted">本地工程</span>
        <IconButton
          label={right ? "收起 Agent" : "展开 Agent"}
          onClick={() => setRight(!right)}
        >
          <PanelRight />
        </IconButton>
      </header>
      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <IconButton label="关闭错误提示" onClick={() => setError("")}>
            <X />
          </IconButton>
        </div>
      )}
      {settings ? (
        <section className="settings-workspace">
          <aside className="settings-nav">
            <button
              className="nav settings-back"
              onClick={() => setSettings(null)}
            >
              <ArrowLeft /> 返回{project ? "工作台" : "工程"}
            </button>
            <div className="section-label">设置</div>
            {[
              ["projects", "工程文件夹"],
              ["agent", "Agent 模型"],
              ["parsing", "解析模型"],
              ["proxy", "代理配置"],
            ].map(([id, name]) => (
              <button
                key={id}
                className={`nav ${settings === id ? "selected" : ""}`}
                onClick={() => setSettings(id)}
              >
                {id === "projects" ? (
                  <Folder />
                ) : id === "agent" ? (
                  <Sparkles />
                ) : (
                  <Settings />
                )}
                <span>{name}</span>
              </button>
            ))}
          </aside>
          <main className="settings-canvas">
            <article className="settings-content">
              <h1>
                {settings === "projects"
                  ? "工程文件夹"
                  : settings === "agent"
                    ? "Agent 模型"
                    : settings === "parsing"
                      ? "解析模型"
                      : "代理配置"}
              </h1>
              {settings === "projects" ? (
                <>
                  <label>默认工程文件夹</label>
                  <div className="setting-value path">
                    {preferences.defaultFolder ?? "尚未设置"}
                  </div>
                  <div className="row">
                    <button
                      className="borderbtn"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const folder = await desktop.choose("folder");
                          if (folder)
                            setPreferences(
                              await desktop.invoke<Preferences>({
                                type: "setDefault",
                                folder,
                              }),
                            );
                        })
                      }
                    >
                      <FolderOpen /> 选择文件夹
                    </button>
                    {preferences.defaultFolder && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            setPreferences(
                              await desktop.invoke<Preferences>({
                                type: "setDefault",
                                folder: null,
                              }),
                            ),
                          )
                        }
                      >
                        清除默认位置
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="empty">尚未接入</p>
              )}
            </article>
          </main>
        </section>
      ) : !project ? (
        <main className="start">
          <div className="start-heading">
            <BookOpen />
            <h1>Paper30Min</h1>
            <IconButton label="设置" onClick={() => setSettings("projects")}>
              <Settings />
            </IconButton>
          </div>
          <div className="row start-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void newProject()}
            >
              <Plus /> 从 PDF 新建工程
            </button>
            <button
              className="borderbtn"
              disabled={busy}
              onClick={() => void openProject()}
            >
              <FolderOpen /> 打开工程文件夹
            </button>
          </div>
          <h2>最近工程</h2>
          {preferences.recent.length ? (
            preferences.recent.map((r) => (
              <button
                className="recent"
                key={r.root}
                onClick={() => void openProject(r.root)}
                disabled={busy}
              >
                <Folder />
                <span>
                  {r.name}
                  <small>{r.root}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="muted">尚无最近工程</p>
          )}
        </main>
      ) : (
        <div
          className={`shell ${!left ? "left-collapsed" : ""} ${!right ? "right-collapsed" : ""}`}
        >
          <div className="sidebar-slot" inert={!left} aria-hidden={!left}>
            <aside className="sidebar">
              <div className="workspace">
                <span className="avatar">
                  <BookOpen />
                </span>
                本地工作空间
                <ChevronDown />
              </div>
              <button
                className="nav"
                disabled={busy}
                onClick={() => {
                  setProject(null);
                  setTabs([]);
                  setActive("");
                }}
              >
                <Home />
                <span>所有工程</span>
              </button>
              <button
                className="nav"
                disabled={busy}
                onClick={() => void newProject()}
              >
                <Plus />
                <span>从 PDF 新建工程</span>
              </button>
              <div className="section-label between">
                当前工程
                <IconButton
                  label="管理材料"
                  onClick={() =>
                    openTab({ key: "materials", title: "相关材料" })
                  }
                >
                  <MoreHorizontal />
                </IconButton>
              </div>
              <div className="project-name" title={project.manifest.name}>
                <span className="project-dot" />
                {project.manifest.name}
              </div>
              <div className="switch" role="group" aria-label="导航模式">
                <button
                  className={navigation === "reading" ? "active" : ""}
                  onClick={() => setNavigation("reading")}
                >
                  阅读导航
                </button>
                <button
                  className={navigation === "files" ? "active" : ""}
                  onClick={() => setNavigation("files")}
                >
                  工程文件
                </button>
              </div>
              <nav
                className="left-nav"
                aria-label={navigation === "reading" ? "阅读导航" : "工程文件"}
              >
                {navigation === "reading" ? (
                  <>
                    {nav("原始论文", <FileText />, {
                      key: project.manifest.paper.path,
                      path: project.manifest.paper.path,
                      title: project.manifest.paper.path.split("/").at(-1)!,
                    })}
                    {nav("阅读地图", <Map />, {
                      key: "map",
                      title: "阅读地图",
                    })}
                    {nav("论文精解", <BookOpen />, {
                      key: "explanations",
                      title: "论文精解",
                    })}
                    {nav("全文译文", <FileText />, {
                      key: "translations",
                      title: "全文译文",
                    })}
                    {nav("笔记", <FileText />, { key: "notes", title: "笔记" })}
                    {nav("相关材料", <Folder />, {
                      key: "materials",
                      title: "相关材料",
                    })}
                  </>
                ) : (
                  <FileTree files={project.files} onOpen={openPath} />
                )}
              </nav>
              <footer className="sidebar-footer">
                <IconButton
                  label="设置"
                  onClick={() => setSettings("projects")}
                >
                  <Settings />
                </IconButton>
                <span className="spacer" />
                <IconButton label="刷新工程" onClick={refresh} disabled={busy}>
                  <RefreshCw />
                </IconButton>
              </footer>
            </aside>
          </div>
          <div className="frame">
            <nav className="tabs" aria-label="文档标签">
              <div className="file-tabs" role="tablist">
                {tabs.map((t) => (
                  <div
                    className={`file-tab ${active === t.key ? "active" : ""}`}
                    key={t.key}
                  >
                    <button
                      role="tab"
                      aria-selected={active === t.key}
                      title={t.title}
                      onClick={() => setActive(t.key)}
                    >
                      <FileText />
                      <span>{t.title}</span>
                    </button>
                    <IconButton
                      label={`关闭 ${t.title}`}
                      onClick={() => closeTab(t.key)}
                    >
                      <X />
                    </IconButton>
                  </div>
                ))}
              </div>
            </nav>
            <div className="body">
              <main className="main">
                <div className="toolbar" role="toolbar" aria-label="内容操作">
                  <div className="toolbar-title">
                    <FileText />
                    <span>{current?.title ?? "文档"}</span>
                  </div>
                  <div className="toolbar-actions">
                    {current?.key === "materials" ? (
                      <button
                        disabled={busy}
                        onClick={() => void addMaterial()}
                      >
                        <Plus /> 添加材料
                      </button>
                    ) : (
                      current?.path &&
                      !missingCurrent && (
                        <>
                          <IconButton
                            label="改名或移动"
                            disabled={busy}
                            onClick={() =>
                              setDialog({
                                type: "move",
                                path: current.path!,
                                destination: current.path!,
                              })
                            }
                          >
                            <MoreHorizontal />
                          </IconButton>
                          <IconButton
                            label="在外部应用中打开"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                desktop.openFile(root!, current.path!),
                              )
                            }
                          >
                            <FolderOpen />
                          </IconButton>
                        </>
                      )
                    )}
                  </div>
                </div>
                {contentView()}
              </main>
              <div className="right-slot" inert={!right} aria-hidden={!right}>
                <aside className="right">
                  <div className="agent-head">
                    <Sparkles />
                    <span>Agent</span>
                  </div>
                  <div className="chat">
                    <Sparkles className="agent-symbol" />
                    <h3>尚无会话</h3>
                  </div>
                  <div className="composer-wrap">
                    <div className="composer">
                      <textarea
                        disabled
                        aria-label="Agent 消息"
                        placeholder="Agent 尚未接入"
                      />
                      <div className="composer-foot">
                        <span>未连接</span>
                        <IconButton label="发送消息" disabled>
                          <ArrowUp />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog.type === "create"
                ? "新建工程"
                : dialog.type === "move"
                  ? "改名或移动"
                  : "移出工程"
            }
            onSubmit={(event) => {
              event.preventDefault();
              if (dialog.type === "create") void createProject(dialog);
              if (dialog.type === "move" && root)
                void update({
                  type: "move",
                  root,
                  path: dialog.path,
                  destination: dialog.destination,
                }).then((p) => {
                  if (p) {
                    retargetTabs(dialog.path, dialog.destination);
                    setDialog(null);
                  }
                });
              if (dialog.type === "trash" && root)
                void update({ type: "trash", root, id: dialog.id }).then(
                  (p) => {
                    if (p) {
                      closeTab(dialog.name);
                      setDialog(null);
                    }
                  },
                );
            }}
          >
            <h2>
              {dialog.type === "create"
                ? "新建工程"
                : dialog.type === "move"
                  ? "改名或移动"
                  : "移出工程"}
            </h2>
            {dialog.type === "create" ? (
              <>
                <label htmlFor="project-name">工程名称</label>
                <input
                  id="project-name"
                  autoFocus
                  value={dialog.name}
                  disabled={busy}
                  onChange={(e) =>
                    setDialog({ ...dialog, name: e.target.value })
                  }
                  required
                />
                <label>原始 PDF</label>
                <div className="path source-path">{dialog.source}</div>
                <label>保存位置</label>
                <div className="location">
                  <span className="path">
                    {dialog.parent || "请选择工程文件夹"}
                  </span>
                  <button
                    type="button"
                    className="borderbtn"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const folder = await desktop.choose("folder");
                        if (folder) setDialog({ ...dialog, parent: folder });
                      })
                    }
                  >
                    <FolderOpen /> 选择位置
                  </button>
                </div>
                <label>完整工程路径</label>
                <output className="path preview" data-testid="project-preview">
                  {dialog.parent
                    ? dialog.parent.replace(/[\\/]$/, "") +
                      separator +
                      dialog.name
                    : "尚未选择保存位置"}
                </output>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={dialog.makeDefault}
                    disabled={busy}
                    onChange={(e) =>
                      setDialog({ ...dialog, makeDefault: e.target.checked })
                    }
                  />
                  将此位置设为默认工程文件夹
                </label>
              </>
            ) : dialog.type === "move" ? (
              <>
                <label htmlFor="destination">工程内相对路径</label>
                <input
                  id="destination"
                  autoFocus
                  value={dialog.destination}
                  disabled={busy}
                  onChange={(e) =>
                    setDialog({ ...dialog, destination: e.target.value })
                  }
                  required
                />
              </>
            ) : (
              <>
                <p className="path">{dialog.name}</p>
                <p>文件将移入系统回收站，相关引用将失效。研究成果保留。</p>
              </>
            )}
            {error && <p className="form-error">{error}</p>}
            <div className="modal-footer">
              <button
                type="button"
                onClick={() => {
                  if (creating)
                    void desktop
                      .invoke({ type: "cancelCreate", operationId: creating })
                      .catch((e) => setError((e as Error).message));
                  else {
                    setDialog(null);
                    setError("");
                  }
                }}
                disabled={busy && !creating}
              >
                {creating ? "取消创建" : "取消"}
              </button>
              <button
                className="primary"
                type="submit"
                disabled={
                  busy ||
                  (dialog.type === "create" && (!dialog.parent || !dialog.name))
                }
              >
                {busy
                  ? "处理中…"
                  : dialog.type === "create"
                    ? "创建工程"
                    : dialog.type === "move"
                      ? "保存"
                      : "移入回收站"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function FileTree({
  files,
  onOpen,
  prefix = "",
}: {
  files: Project["files"];
  onOpen: (path: string) => void;
  prefix?: string;
}) {
  return (
    <div className="filetree">
      {files
        .filter(
          (f) =>
            f.path.startsWith(prefix) &&
            !f.path.slice(prefix.length).includes("/"),
        )
        .map((f) =>
          f.directory ? (
            <details key={f.path} open>
              <summary>
                <Folder />
                {f.path.slice(prefix.length)}
              </summary>
              <FileTree files={files} onOpen={onOpen} prefix={f.path + "/"} />
            </details>
          ) : (
            <button key={f.path} onClick={() => onOpen(f.path)} title={f.path}>
              <File /> <span>{f.path.slice(prefix.length)}</span>
            </button>
          ),
        )}
    </div>
  );
}
