import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  File,
  FileText,
  Folder,
  FolderOpen,
  Home,
  Import,
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
  DocumentTab,
  PdfPosition,
} from "../shared/contracts";
import { usePanelLayout } from "./usePanelLayout";
import { PdfReader } from "./PdfReader";
import { MarkdownDocument } from "./MarkdownDocument";
import { AgentPanel } from "./AgentPanel";
import type { ChatAttachment } from "../shared/chat-input";
import { AgentSettingsForm } from "./AgentSettingsForm";
import { ProductSkillsForm } from "./ProductSkillsForm";
import { MappingPanel } from "./MappingPanel";
import { LegacyImport } from "./LegacyImport";
import { ParsingPanel, ParsingSettingsForm } from "./ParsingPanel";
import type { ResolvedCitation, CitationUse } from "../shared/citations";
import { isAnnotationLink, resolveAnnotationLink, type AnnotationTarget } from "../shared/annotation-links";
import {
  useMarkdownDocuments,
  isMarkdown,
  isDirty,
} from "./useMarkdownDocuments";

const desktop = window.desktop;
type Tab = DocumentTab;
type Dialog =
  | {
      type: "create";
      source: string;
      parent: string;
      name: string;
      makeDefault: boolean;
    }
  | { type: "note"; name: string }
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
  const layout = usePanelLayout(left, right);
  const [settings, setSettingsState] = useState<string | null>(null);
  const skillDirty = useRef(false);
  const pdfPending = useRef(false);
  const navigationRequest = useRef(0);
  const flushPdf = useRef<(() => Promise<void>) | null>(null);
  const [showPdfUses, setShowPdfUses] = useState(false);
  async function mayLeavePdf() {
    try { await flushPdf.current?.(); return true; }
    catch (error) { setError(`PDF 自动保存失败，当前批注已保留：${(error as Error).message}`); return false; }
  }
  async function setSettings(value: string | null) {
    if (settings === "skills" && value !== settings && skillDirty.current && !window.confirm("放弃尚未保存的提示词编辑并离开？")) return;
    const request = ++navigationRequest.current;
    if (await mayLeavePdf() && request === navigationRequest.current) setSettingsState(value);
  }
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [legacyImport, setLegacyImport] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [citationVisit, setCitationVisit] = useState<(ResolvedCitation & { nonce: string }) | null>(null);
  const [annotationVisit, setAnnotationVisit] = useState<{ target: AnnotationTarget; nonce: string } | null>(null);
  const [usageVisit, setUsageVisit] = useState<{ use: CitationUse; nonce: string } | null>(null);
  useEffect(() => {
    if (settings || citationVisit?.path !== active) setCitationVisit(null);
    if (settings || annotationVisit?.target.path !== active) setAnnotationVisit(null);
    if (settings || usageVisit?.use.path !== active) setUsageVisit(null);
    setShowPdfUses(false);
  }, [active, settings]);
  const [selectedAgent, setSelectedAgent] = useState<{ root: string; id: string }>();
  const current = tabs.find((t) => t.key === active);
  const root = project?.root;
  useEffect(() => {
    const receive = (event: Event) => {
      if ((event as CustomEvent<{ root: string }>).detail.root === root) setRight(true);
    };
    window.addEventListener("paper30min-chat-source", receive);
    return () => window.removeEventListener("paper30min-chat-source", receive);
  }, [root]);
  const activeRoot = useRef(root);
  activeRoot.current = root;
  const documents = useMarkdownDocuments(root, tabs, project);
  const positions = useRef<Record<string, Record<string, PdfPosition>>>({});
  const agentViews = useRef<Record<string, { active: string; text: string; attachments?: ChatAttachment[] }>>(
    {},
  );
  useEffect(() => {
    if (root)
      void desktop
        .invoke({ type: "saveWorkspace", root, tabs, active })
        .catch((e) => setError((e as Error).message));
  }, [root, tabs, active]);
  function savePosition(
    projectRoot: string,
    file: string,
    position: PdfPosition,
  ) {
    (positions.current[projectRoot] ??= {})[file] = position;
    void desktop
      .invoke({
        type: "savePdfPosition",
        root: projectRoot,
        path: file,
        position,
      })
      .catch((e) => setError((e as Error).message));
  }

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
    if (root && current?.path && !isMarkdown(current.path)) {
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

  useEffect(() => {
    if (!root) return;
    let disposed = false;
    const stop = desktop.watchProject(root, (watchError) => {
      if (watchError) {
        setError(watchError);
        return;
      }
      void desktop
        .invoke<Project>({ type: "refresh", root })
        .then((p) => {
          if (!disposed) setProject((old) => (old?.root === root ? p : old));
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [root]);

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

  async function openTab(tab: Tab, activate?: () => void, request = ++navigationRequest.current) {
    if (tab.key !== active && !(await mayLeavePdf())) return;
    if (request !== navigationRequest.current || activeRoot.current !== root) return;
    activate?.();
    setTabs((old) =>
      old.some((t) => t.key === tab.key) ? old : [...old, tab],
    );
    setActive(tab.key);
  }
  function openPath(filePath: string, activate?: () => void, request?: number) {
    return openTab({
      key: filePath,
      path: filePath,
      title: filePath.split("/").at(-1)!,
    }, activate, request);
  }
  async function openCitation(link: string, base = "") {
    if (!root) return;
    const originRoot = root;
    const request = ++navigationRequest.current;
    await run(async () => {
      if (isAnnotationLink(link)) {
        const target = resolveAnnotationLink(link, base);
        try { await desktop.invoke({ type: "resolveFile", root, path: target.path }); }
        catch { throw new Error(`批注 PDF 已缺失或移动：${target.path}`); }
        if (activeRoot.current !== originRoot) return;
        await openPath(target.path, () => {
          setCitationVisit(null);
          setAnnotationVisit({ target, nonce: crypto.randomUUID() });
        }, request);
        return;
      }
      const resolved = await desktop.invoke<ResolvedCitation>({ type: "resolveCitation", root, link });
      if (activeRoot.current !== originRoot) return;
      await openPath(resolved.path, () => {
        setCitationVisit({ ...resolved, nonce: crypto.randomUUID() });
        setAnnotationVisit(null);
      }, request);
    });
  }
  function enter(p: Project) {
    setAnnotationVisit(null);
    pdfPending.current = false;
    setUsageVisit(null);
    setCitationVisit(null);
    setProject(p);
    const tab = {
      key: p.manifest.paper.path,
      path: p.manifest.paper.path,
      title: p.manifest.paper.path.split("/").at(-1)!,
    };
    positions.current[p.root] = p.reading.pdf;
    const restored = p.reading.tabs.filter(
      (t) => !t.path || p.files.some((f) => f.path === t.path && !f.directory),
    );
    setTabs(restored.length ? restored : [tab]);
    setActive(
      restored.some((t) => t.key === p.reading.active)
        ? p.reading.active
        : (restored[0]?.key ?? tab.key),
    );
    setSettingsState(null);
  }
  async function closeTab(key: string) {
    navigationRequest.current++;
    if (key === active && !(await mayLeavePdf())) return;
    const path = tabs.find((t) => t.key === key)?.path;
    if (path && !(await documents.mayLeave(path))) return;
    if (path) documents.forget(path);
    if (activeRoot.current !== root) return;
    setTabs((currentTabs) => {
      const remaining = currentTabs.filter((t) => t.key !== key);
      setActive((currentActive) => currentActive === key ? (remaining.at(-1)?.key ?? "") : currentActive);
      return remaining;
    });
  }
  async function openProject(folder?: string) {
    if (!(await mayLeavePdf())) return;
    if (!(await documents.mayLeave())) return;
    await run(async () => {
      const selected = folder ?? (await desktop.choose("folder"));
      if (!selected) return;
      const p = await desktop.invoke<Project>({ type: "open", root: selected });
      enter(p);
      await reloadPreferences();
    });
  }
  async function newProject() {
    if (!(await mayLeavePdf())) return;
    if (!(await documents.mayLeave())) return;
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
    if (!(await mayLeavePdf())) return;
    if (command.type === "move" && !(await documents.flush())) {
      setError("Markdown 自动保存尚未完成或存在冲突，暂不能移动文件。");
      return;
    }
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
    documents.retarget(from, to);
    const saved = positions.current[root!];
    if (saved?.[from]) {
      saved[to] = saved[from];
      delete saved[from];
    }
    setTabs((old) =>
      old.map((t) =>
        t.path === from
          ? { ...t, key: to, path: to, title: to.split("/").at(-1)! }
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
    if (current.key === "parsing")
      return (
        <ParsingPanel
          key={root}
          project={project!}
          onOpen={openPath}
          onSettings={() => setSettings("parsing")}
          onSession={(id) => { setRight(true); setSelectedAgent({ root: root!, id }); }}
        />
      );
    if (current.key === "materials")
      return (
        <article className="article">
          <h1>相关材料</h1>
          {materialList()}
        </article>
      );
    if (current.path && isMarkdown(current.path)) {
      const draft = documents.drafts.get(current.path);
      return draft ? (
        <MarkdownDocument
          key={root + "/" + current.path}
          root={root!}
          draft={draft}
          usageTarget={usageVisit?.use.path === current.path ? usageVisit : undefined}
          onChange={() => documents.changed(draft)}
          onSave={() => void documents.save(draft)}
          onOpen={openPath}
          onCitation={(link) => void openCitation(link, current.path)}
          onPosition={(position) => {
            const updatePosition = (items: Tab[]) =>
              items.map((t) =>
                t.path === draft.path &&
                JSON.stringify(t.markdown) !== JSON.stringify(position)
                  ? { ...t, markdown: position }
                  : t,
              );
            if (activeRoot.current !== root) {
              // Unmount flush belongs to the old project, never its successor's tabs.
              void desktop
                .invoke({
                  type: "saveWorkspace",
                  root: root!,
                  tabs: updatePosition(tabs),
                  active,
                })
                .catch((e) => setError(e.message));
              return;
            }
            setTabs(updatePosition);
          }}
        />
      ) : (
        <div className="empty">正在读取文档…</div>
      );
    }
    if (missingCurrent && !pdfPending.current)
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
    if (current.path && /\.pdf$/i.test(current.path))
      return (
        <PdfReader
          key={root + "/" + current.path}
          root={root!}
          path={current.path}
          revision={project}
          annotationTarget={annotationVisit?.target.path === current.path ? annotationVisit : undefined}
          onPending={(pending) => { pdfPending.current = pending; }}
          onBeforeLeave={(save) => { flushPdf.current = save; }}
          showUses={showPdfUses} onCloseUses={() => setShowPdfUses(false)}
          onUse={(use) => void openPath(use.path, () => {
            setCitationVisit(null);
            setAnnotationVisit(null);
            setUsageVisit({ use, nonce: crypto.randomUUID() });
          })}
          citationNonce={citationVisit?.nonce}
          citation={citationVisit?.path === current.path ? citationVisit.citation : undefined}
          position={positions.current[root!]?.[current.path]}
          onPosition={(p) => savePosition(root!, current.path!, p)}
        />
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
        {(current.key === "map" || current.key === "explanations") && root && <MappingPanel key={root} root={root}
          beforeStart={() => documents.flush()}
          onParsing={() => openTab({ key: "parsing", title: "论文解析" })}
          onSession={id => { setSelectedAgent({ root, id }); setRight(true); }}
          onPublished={refresh} />}
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
              ["search", "Agent 网络搜索"],
              ["skills", "产品 Skill"],
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
                    : settings === "search"
                      ? "Agent 网络搜索"
                      : settings === "skills"
                        ? "产品 Skill"
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
                  <button className="borderbtn legacy-entry" disabled={busy}
                    onClick={() => setLegacyImport(true)}><Import /> 导入旧 PDF</button>
                </>
              ) : settings === "agent" ||
                settings === "proxy" ||
                settings === "search" ? (
                <AgentSettingsForm key={settings} section={settings} />
              ) : settings === "skills" ? (
                <ProductSkillsForm onDirty={dirty => { skillDirty.current = dirty; }} />
              ) : settings === "parsing" ? (
                <ParsingSettingsForm />
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
            <button className="borderbtn" disabled={busy} onClick={() => setLegacyImport(true)}>
              <Import /> 导入旧 PDF
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
          className={`shell ${!left ? "left-collapsed" : ""} ${!right ? "right-collapsed" : ""} ${layout.resizing ? "resizing" : ""}`}
          style={layout.style}
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
                onClick={async () => {
                  if (!(await mayLeavePdf())) return;
                  if (!(await documents.mayLeave())) return;
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
                    {nav("论文解析", <FileText />, {
                      key: "parsing",
                      title: "论文解析",
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
          {left && (
            <div
              className="panel-resizer left-resizer"
              {...layout.separator("left")}
            />
          )}
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
                      onClick={() => void openTab(t)}
                    >
                      <FileText />
                      <span>
                        {t.title}
                        {t.path &&
                        documents.drafts.get(t.path) &&
                        isDirty(documents.drafts.get(t.path)!)
                          ? " •"
                          : ""}
                      </span>
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
                    {current?.path && /\.pdf$/i.test(current.path) && <button aria-label="文档引用使用位置" aria-expanded={showPdfUses}
                      onClick={() => setShowPdfUses((value) => !value)}>文档引用</button>}
                    {current?.key === "notes" && (
                      <button
                        onClick={() =>
                          setDialog({ type: "note", name: "新笔记.md" })
                        }
                      >
                        <Plus /> 新建笔记
                      </button>
                    )}
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
              {right && (
                <div
                  className="panel-resizer right-resizer"
                  {...layout.separator("right")}
                />
              )}
              <div className="right-slot" inert={!right} aria-hidden={!right}>
                <AgentPanel
                  onCitation={(link) => void openCitation(link)}
                  onOpenFile={openPath}
                  key={root}
                  root={root!}
                  onSettings={() => setSettings("agent")}
                  initialView={agentViews.current[root!]}
                  selectedSession={selectedAgent && selectedAgent.root === root ? selectedAgent.id : undefined}
                  onParsing={() => openTab({ key: "parsing", title: "论文解析" })}
                  onViewChange={(view) => {
                    agentViews.current[root!] = view;
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {legacyImport && <LegacyImport folder={preferences.defaultFolder}
        onClose={() => setLegacyImport(false)} onUpdated={reloadPreferences}
        onOpen={(folder) => { setLegacyImport(false); void openProject(folder); }} />}
      {dialog && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog.type === "create"
                ? "新建工程"
                : dialog.type === "note"
                  ? "新建笔记"
                  : dialog.type === "move"
                    ? "改名或移动"
                    : "移出工程"
            }
            onSubmit={(event) => {
              event.preventDefault();
              if (dialog.type === "create") void createProject(dialog);
              if (dialog.type === "note" && root)
                void run(async () => {
                  const path = await desktop.invoke<string>({
                    type: "createNote",
                    root,
                    name: dialog.name,
                  });
                  setProject(
                    await desktop.invoke<Project>({ type: "refresh", root }),
                  );
                  openPath(path);
                  setDialog(null);
                });
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
                : dialog.type === "note"
                  ? "新建笔记"
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
            ) : dialog.type === "note" ? (
              <>
                <label htmlFor="note-name">笔记名称</label>
                <input
                  id="note-name"
                  autoFocus
                  value={dialog.name}
                  onChange={(e) =>
                    setDialog({ ...dialog, name: e.target.value })
                  }
                  required
                  disabled={busy}
                />
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
                    : dialog.type === "note"
                      ? "创建笔记"
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
