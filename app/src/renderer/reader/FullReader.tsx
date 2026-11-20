// Full 全文阅读器（SPEC-reader §1–2，paper-30min-qa3.1）。
// 只消费 project-core current revision 的文档树投影；不读取 source-base、
// 原始 HTML 或云端 Markdown 作为另一份正文。渲染层不发隐式远端请求：
// 图片经 paper30min 受管协议，外链经主进程受控打开入口。
import { useCallback, useEffect, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ProjectCoreSnapshot } from "../../shared/contracts";
import "./reader.css";
import type { DocumentTree } from "../../shared/document/tree";
import { createRangeAnchor } from "../../shared/document/anchor";
import {
  buildReaderProjection,
  type ReaderAtom,
  type ReaderItem,
  type ReaderProjection,
  type ReaderSentence,
  type ReaderUnitContent,
} from "../../shared/reader/projection";
import { buildSelectionIndex, mapDomSelection, type SelectionIndex } from "../../shared/reader/selection";

const desktop = window.desktop;
/** raw block 白名单（与 document-core rawHtmlTags 一致）：渲染层独立消毒，
 * 不信任磁盘字节一定经过提交校验；只保留无属性结构标签，
 * 脚本、事件处理器、远端资源与样式一律不进入 DOM。 */
const rawAllowedTags = new Set([
  "blockquote", "br", "code", "em", "li", "ol", "p", "pre", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

function sanitizeRawHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walk = (parent: Element | DocumentFragment) => {
    for (const child of [...parent.children]) {
      const tag = child.tagName.toLowerCase();
      if (!rawAllowedTags.has(tag)) {
        child.remove();
        continue;
      }
      for (const attribute of [...child.attributes])
        child.removeAttribute(attribute.name);
      walk(child);
    }
  };
  walk(template.content);
  return template.innerHTML;
}

interface ReaderSourceFacts {
  title: string | null;
  authors: string[];
  canonicalId: string | null;
}

interface ReaderState {
  revisionId: string;
  tree: DocumentTree;
  projection: ReaderProjection;
  index: SelectionIndex;
  facts: ReaderSourceFacts;
}

function sourceFacts(snapshot: Record<string, unknown>): ReaderSourceFacts {
  return {
    title: typeof snapshot.title === "string" && snapshot.title ? snapshot.title : null,
    authors: Array.isArray(snapshot.authors)
      ? snapshot.authors.filter((a): a is string => typeof a === "string")
      : [],
    canonicalId: typeof snapshot.canonicalId === "string" ? snapshot.canonicalId : null,
  };
}

/** 单元正文：句子携带稳定 ID；文本片段按逻辑顺序渲染，atom 独立锚定。 */
function UnitBody({ unit }: { unit: ReaderUnitContent }) {
  return (
    <>
      {unit.sentences.map((sentence) => (
        <SentenceBody key={sentence.sentenceId} sentence={sentence} />
      ))}
    </>
  );
}

function SentenceBody({ sentence }: { sentence: ReaderSentence }) {
  return (
    <span data-sentence-id={sentence.sentenceId}>
      {sentence.parts.map((part, index) =>
        part.kind === "text" ? (
          <span key={index} data-start={part.start} data-end={part.end}>{part.text}</span>
        ) : (
          <AtomView key={part.atom.id} atom={part.atom} start={part.start} end={part.end} />
        ),
      )}
    </span>
  );
}

function AtomView({ atom, start, end }: { atom: ReaderAtom; start: number; end: number }) {
  const jump = (targetUnitId: string) => {
    const target = document.querySelector(`[data-unit-id="${targetUnitId}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("reader-jump-target");
    if (target instanceof HTMLElement) {
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
    window.setTimeout(() => target.classList.remove("reader-jump-target"), 2000);
  };
  if (atom.kind === "math" || atom.kind === "inline-object") {
    if (atom.source.format === "latex") {
      try {
        const html = katex.renderToString(atom.source.value, {
          throwOnError: true,
          trust: false,
          strict: "ignore",
        });
        return (
          <span
            className="reader-atom reader-math"
            data-atom-id={atom.id}
            data-start={start}
            data-end={end}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } catch {
        return (
          <span className="reader-atom reader-math-failed" data-atom-id={atom.id} data-start={start} data-end={end}>
            <code>{atom.source.value}</code>
            <span className="reader-warning" role="note">公式渲染失败，保留来源。</span>
          </span>
        );
      }
    }
    if (atom.source.format === "mathml") {
      // 树校验已按 MathML 白名单消毒；这里不再执行任何脚本或加载远端资源。
      return (
        <span
          className="reader-atom reader-math"
          data-atom-id={atom.id}
          data-start={start}
          data-end={end}
          dangerouslySetInnerHTML={{ __html: atom.source.value }}
        />
      );
    }
    return <span className="reader-atom" data-atom-id={atom.id} data-start={start} data-end={end}>{atom.text}</span>;
  }
  if (atom.kind === "link") {
    if (atom.href === null) {
      return (
        <span className="reader-atom reader-link-disabled" data-atom-id={atom.id} data-start={start} data-end={end}>
          {atom.text}
          <span className="reader-warning" role="note">{atom.warning}</span>
        </span>
      );
    }
    return (
      <a
        className="reader-atom reader-link"
        data-atom-id={atom.id}
        data-start={start}
        data-end={end}
        href={atom.href}
        onClick={(event) => {
          event.preventDefault();
          void desktop.openLink(atom.href!).catch(() => undefined);
        }}
      >
        {atom.text}
      </a>
    );
  }
  if (atom.kind === "footnote-reference") {
    return (
      <button
        type="button"
        className="reader-atom reader-ref"
        data-atom-id={atom.id}
        data-start={start}
        data-end={end}
        aria-label={`脚注 ${atom.text}`}
        onClick={() => jump(atom.targetUnitId)}
      >
        <sup>{atom.text}</sup>
      </button>
    );
  }
  // citation 与 cross-reference：已解析可跳转；未解析保留文本＋警告。
  if (atom.targetUnitId !== null) {
    return (
      <button
        type="button"
        className="reader-atom reader-ref"
        data-atom-id={atom.id}
        data-start={start}
        data-end={end}
        onClick={() => jump(atom.targetUnitId!)}
      >
        {atom.text}
      </button>
    );
  }
  return (
    <span className="reader-atom reader-ref-unresolved" data-atom-id={atom.id} data-start={start} data-end={end}>
      {atom.text}
      <span className="reader-warning" role="note">{atom.warning}</span>
    </span>
  );
}

function FormulaView({ item }: { item: Extract<ReaderItem, { kind: "formula" }> }) {
  let rendered: string | null = null;
  if (item.source.format === "latex") {
    try {
      rendered = katex.renderToString(item.source.value, {
        throwOnError: true,
        trust: false,
        strict: "ignore",
        displayMode: true,
      });
    } catch {
      rendered = null;
    }
  }
  return (
    <div className="reader-formula" data-block-id={item.blockId}>
      <div className="reader-formula-scroll">
        {rendered !== null ? (
          <div dangerouslySetInnerHTML={{ __html: rendered }} />
        ) : item.source.format === "mathml" ? (
          <div dangerouslySetInnerHTML={{ __html: item.source.value }} />
        ) : (
          <pre className="reader-formula-source">{item.source.value}</pre>
        )}
      </div>
      {rendered === null && item.source.format === "latex" && (
        <p className="reader-warning" role="note">公式渲染失败，保留来源表示与诊断。</p>
      )}
      {item.text && <p className="reader-formula-text">{item.text}</p>}
    </div>
  );
}

function FigureView({
  item,
  root,
  revisionPath,
}: {
  item: Extract<ReaderItem, { kind: "figure" }>;
  root: string;
  revisionPath: string;
}) {
  const [failed, setFailed] = useState(false);
  const captionText = item.caption?.sentences
    .flatMap((s) => s.parts.map((p) => (p.kind === "text" ? p.text : p.atom.text)))
    .join("") ?? "图片";
  const src = item.asset
    ? "paper30min://project/image?" +
      new URLSearchParams({ root, path: `${revisionPath}/${item.asset.path}` })
    : "";
  return (
    <figure className="reader-figure" data-block-id={item.blockId}>
      {item.asset && !failed ? (
        <img
          src={src}
          alt={captionText}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="reader-figure-missing" role="img" aria-label={captionText}>
          图片不可用
        </div>
      )}
      {(item.warning || failed) && (
        <p className="reader-warning" role="note">
          {item.warning ?? "图片加载失败；正文其余内容不受影响。"}
        </p>
      )}
      {item.caption && (
        <figcaption data-unit-id={item.caption.unitId}>
          <UnitBody unit={item.caption} />
        </figcaption>
      )}
    </figure>
  );
}

function TableView({ item }: { item: Extract<ReaderItem, { kind: "table" }> }) {
  return (
    <div className="reader-table-scroll" data-block-id={item.blockId}>
      <table className="reader-table">
        {item.caption && (
          <caption data-unit-id={item.caption.unitId}>
            <UnitBody unit={item.caption} />
          </caption>
        )}
        <tbody>
          {item.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell) => (
                <td
                  key={cell.unitId}
                  data-unit-id={cell.unitId}
                  rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                  colSpan={cell.columnSpan > 1 ? cell.columnSpan : undefined}
                >
                  <UnitBody unit={item.cells[cell.unitId]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawView({ item }: { item: Extract<ReaderItem, { kind: "raw" }> }) {
  // 渲染层按白名单独立消毒；结构限制必须可见，文本投影保证辅助技术可读。
  const html = sanitizeRawHtml(item.html);
  return (
    <div className="reader-raw" data-block-id={item.blockId}>
      <div className="reader-raw-html" dangerouslySetInnerHTML={{ __html: html }} />
      <ul className="reader-raw-limitations">
        {item.limitations.map((limitation, index) => (
          <li key={index} className="reader-raw-limit">{limitation}</li>
        ))}
      </ul>
    </div>
  );
}

function UnitView({ item }: { item: Extract<ReaderItem, { kind: "unit" }> }) {
  const Tag = item.unitKind === "reference" || item.unitKind === "footnote" ? "div" : "p";
  return (
    <Tag
      className={`reader-unit reader-unit-${item.unitKind}`}
      data-unit-id={item.unitId}
      data-block-id={item.blockId}
    >
      <UnitBody unit={item} />
    </Tag>
  );
}

/** 选区工具条状态：逻辑映射结果＋视口坐标；revision/代际切换即失效。 */
interface SelectionToolbarState {
  x: number;
  y: number;
  quote: string;
  context: string;
  degraded: boolean;
}

export function FullReader({
  root,
  epoch = 0,
  onAsk,
}: {
  root: string;
  epoch?: number;
  /** 解释/提问进入右侧持续对话；reader 不创建问答卡、不直接发送模型请求。 */
  onAsk?: (draft: string) => void;
}) {
  const [state, setState] = useState<ReaderState | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [toolbar, setToolbar] = useState<SelectionToolbarState | null>(null);
  const requestRef = useRef(0);
  const articleRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const request = ++requestRef.current;
    let disposed = false;
    setState(null);
    setStatus("loading");
    (async () => {
      let core: ProjectCoreSnapshot;
      try {
        core = await desktop.invoke<ProjectCoreSnapshot>({ type: "coreOpen", root });
      } catch (error) {
        // current 损坏／引用不完整：阅读器自身呈现恢复状态，
        // 不让打开链路整体失败退回启动页。
        if (disposed || request !== requestRef.current) return;
        setMessage((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
        setStatus("error");
        return;
      }
      if (disposed || request !== requestRef.current) return;
      if (!core.currentRevision) {
        setStatus("empty");
        return;
      }
      const revision = core.currentRevision;
      const [treeValue, snapshot] = await Promise.all([
        desktop.invoke<unknown>({
          type: "coreReadDocument",
          root,
          revisionId: revision.revisionId,
          tree: "document",
        }),
        desktop.invoke<Record<string, unknown>>({
          type: "coreReadSource",
          root,
          sourceSnapshotId: revision.sourceSnapshotId,
        }),
      ]);
      if (disposed || request !== requestRef.current) return;
      // 结构校验由主进程读取路径承担；渲染层对受损 current 仍按投影防御
      // （危险链接降级、raw 白名单消毒），不以拒绝渲染代替安全降级。
      const tree = treeValue as DocumentTree;
      const projection = buildReaderProjection(tree);
      setState({
        revisionId: revision.revisionId,
        tree,
        projection,
        index: buildSelectionIndex(projection),
        facts: sourceFacts(snapshot),
      });
      setToolbar(null);
      setStatus("ready");
    })().catch((error: Error) => {
      if (disposed || request !== requestRef.current) return;
      setMessage(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
      setStatus("error");
    });
    return () => {
      disposed = true;
    };
  }, [root, epoch]);

  // 选区交互：DOM 只承担交互，权威偏移经投影索引映射；工具条不破坏原生选择。
  const refreshSelection = useCallback(() => {
    const article = articleRef.current;
    const current = state;
    if (!article || !current) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setToolbar(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) {
      setToolbar(null);
      return;
    }
    const mapping = mapDomSelection(range, current.index);
    if (mapping.ranges.length === 0 && mapping.degraded.length === 0) {
      setToolbar(null);
      return;
    }
    let quote = "";
    let context = "";
    let degraded = mapping.degraded.length > 0;
    if (mapping.ranges.length > 0) {
      try {
        const anchor = createRangeAnchor(current.tree, mapping.ranges);
        quote = anchor.quote.text;
        context = [anchor.quote.before, anchor.quote.text, anchor.quote.after].filter(Boolean).join("");
      } catch {
        // 映射与树不一致（受损字节）：不伪造 quote，按降级处理。
        degraded = true;
      }
    }
    const rect = range.getBoundingClientRect();
    const width = 220;
    const x = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const y = rect.bottom + 8 + 40 > window.innerHeight ? Math.max(8, rect.top - 48) : rect.bottom + 8;
    setToolbar({ x, y, quote, context, degraded: degraded || quote === "" });
  }, [state]);

  useEffect(() => {
    if (status !== "ready") return;
    document.addEventListener("selectionchange", refreshSelection);
    window.addEventListener("resize", refreshSelection);
    return () => {
      document.removeEventListener("selectionchange", refreshSelection);
      window.removeEventListener("resize", refreshSelection);
    };
  }, [status, refreshSelection]);

  function ask(mode: "解释" | "提问") {
    if (!toolbar || !onAsk) return;
    const header = mode === "解释" ? "请解释以下原文选区：" : "关于以下原文选区，我想提问：";
    const body = toolbar.quote
      ? `> ${toolbar.quote.split("\n").join("\n> ")}\n\n（上下文：${toolbar.context}）`
      : "（该选区包含无法精确映射的内容，已按块级锚点降级。）";
    onAsk(`${header}\n${body}\n\n`);
    setToolbar(null);
  }

  if (status === "loading") return <div className="empty">正在读取正文…</div>;
  if (status === "empty")
    return (
      <div className="full-reader-empty empty" role="status">
        尚未发布正文：工程已创建，但 current 为空。完成导入后这里会显示全文。
      </div>
    );
  if (status === "error" || !state)
    return (
      <div className="full-reader-empty empty" role="alert">
        正文不可读：{message || "revision 损坏或引用不完整。"}请重新导入或恢复工程，不会以旧内容冒充正文。
      </div>
    );

  const { projection, facts } = state;
  const revisionPath = `paper/revisions/${state.revisionId}`;
  return (
    <article
      className="full-reader"
      data-revision-id={state.revisionId}
      ref={articleRef}
      onMouseUp={refreshSelection}
      onKeyUp={refreshSelection}
    >
      <header className="reader-header">
        <h1>{facts.title ?? "未命名论文"}</h1>
        {facts.authors.length > 0 && (
          <p className="reader-authors">{facts.authors.join("、")}</p>
        )}
        {facts.canonicalId && <p className="reader-source muted">arXiv {facts.canonicalId}</p>}
      </header>
      {projection.items.map((item, index) => {
        switch (item.kind) {
          case "section": {
            if (!item.title) return null;
            const Level = (item.depth <= 5 ? `h${item.depth + 1}` : "h6") as
              "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Level key={`section-${item.sectionId}`} data-section-id={item.sectionId}>
                {item.title}
              </Level>
            );
          }
          case "unit":
            return <UnitView key={item.blockId} item={item} />;
          case "formula":
            return <FormulaView key={item.blockId} item={item} />;
          case "figure":
            return (
              <FigureView
                key={`${state.revisionId}-${item.blockId}-${index}`}
                item={item}
                root={root}
                revisionPath={revisionPath}
              />
            );
          case "table":
            return <TableView key={item.blockId} item={item} />;
          case "raw":
            return <RawView key={item.blockId} item={item} />;
        }
      })}
      {toolbar && (
        <div
          className="reader-selection-toolbar"
          role="toolbar"
          aria-label="选区操作"
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {toolbar.degraded && <span className="reader-selection-degraded" role="note">含不可精确映射内容</span>}
          <button type="button" onClick={() => ask("解释")}>解释</button>
          <button type="button" onClick={() => ask("提问")}>提问</button>
        </div>
      )}
    </article>
  );
}