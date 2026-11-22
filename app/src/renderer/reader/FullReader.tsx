// Full 全文阅读器（SPEC-reader §1–2，paper-30min-qa3.1）。
// 只消费 project-core current revision 的文档树投影；不读取 source-base、
// 原始 HTML 或云端 Markdown 作为另一份正文。渲染层不发隐式远端请求：
// 图片经 paper30min 受管协议，外链经主进程受控打开入口。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ProjectCoreSnapshot, ProjectRevisionContext } from "../../shared/contracts";
import { readDiagnosticArray, type ImportDiagnostic } from "../../shared/arxiv";
import "./reader.css";
import type { DocumentTree } from "../../shared/document/tree";
import { createRangeAnchor } from "../../shared/document/anchor";
import { buildReaderProjection, type ReaderItem, type ReaderProjection } from "../../shared/reader/projection";
import { buildSelectionIndex, mapDomSelection, type SelectionIndex } from "../../shared/reader/selection";
import {
  buildTranslationSelectionIndex,
  translationQuote,
  type TranslationSelectionIndex,
} from "../../shared/reader/translation-selection";
import { resolveReadingPosition, type ReadingPosition, type ReadingPositionAnchor } from "../../shared/reader/position";
import { collectReaderDiagnostics, type ReaderDiagnostic } from "../../shared/reader/diagnostics";
import { summarizeVerification, type VerificationRecord } from "../../shared/verification";
import { SourcePanel, sourcePanelFacts } from "./SourcePanel";
import { CorrectionHost } from "./CorrectionHost";
import { ConflictHost } from "./ConflictHost";
import { TranslationControls } from "./TranslationControls";
import { UnitBody } from "./ReaderSentence";
import { Button } from "../ui/Button";
import { EmptyState, InlineMessage } from "../ui/Feedback";
import type { ArxivUpdateCandidateCommandResult, ArxivUpdateCheckCommandResult } from "../../shared/contracts";
import type { DocumentMergeResult } from "../../shared/document/merge";
import {
  detectSourceLanguage,
  type TranslationLanguage,
  type TranslationProjection,
  type TranslationRawProjection,
} from "../../shared/translation/contracts";
import {
  buildTranslationUnitViews,
  readerProjectionUnits,
  type TranslationUnitView,
} from "../../shared/reader/translation-view";
import type { TranslationReadCommandResult, TranslationStartCommandResult } from "../../shared/contracts";

const desktop = window.desktop;
/** raw block 白名单（与 document-core rawHtmlTags 一致）：渲染层独立消毒，
 * 不信任磁盘字节一定经过提交校验；只保留无属性结构标签，
 * 脚本、事件处理器、远端资源与样式一律不进入 DOM。 */
const rawAllowedTags = new Set([
  "blockquote",
  "br",
  "code",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function sanitizeRawHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const walk = (parent: Element | DocumentFragment) => {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      if (!rawAllowedTags.has(tag)) {
        child.remove();
        continue;
      }
      for (const attribute of Array.from(child.attributes)) child.removeAttribute(attribute.name);
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
  context: ProjectRevisionContext;
  /** 来源诊断面板输入（SPEC-reader §7）：事实、警告与核验记录。 */
  snapshot: Record<string, unknown>;
  snapshotWarnings: ImportDiagnostic[];
  verification: VerificationRecord[];
  /** 核验侧车读取失败（损坏/预算/IO）：与真实无记录区分，正文仍可读。 */
  verificationError: string | null;
}

/** 位置通知：changed/removed 的显式提示与 removed 摘录（不参与相似匹配）。 */
interface PositionNotice {
  text: string;
  excerpt: string | null;
}

const positionAnchorSelector = (anchor: ReadingPositionAnchor): string => {
  switch (anchor.kind) {
    case "section":
      return `[data-section-id="${anchor.sectionId}"]`;
    case "unit":
      return `[data-unit-id="${anchor.unitId}"]`;
    case "sentence":
      return `[data-sentence-id="${anchor.sentenceId}"]`;
    case "atom":
      return `[data-atom-id="${anchor.atomId}"]`;
    case "block":
      return `[data-block-id="${anchor.blockId}"]`;
  }
};

/** 捕获时锚点所属父 section：removed 回退规则的唯一依据。 */
function parentSectionOf(tree: DocumentTree, anchor: ReadingPositionAnchor): string | null {
  switch (anchor.kind) {
    case "section":
      return tree.sections[anchor.sectionId]?.parentSectionId ?? null;
    case "unit":
      return tree.units[anchor.unitId]?.sectionId ?? null;
    case "sentence":
      return tree.units[tree.sentences[anchor.sentenceId]?.unitId ?? ""]?.sectionId ?? null;
    case "atom":
      return tree.units[tree.atoms[anchor.atomId]?.unitId ?? ""]?.sectionId ?? null;
    case "block":
      return tree.blocks.find((block) => block.id === anchor.blockId)?.sectionId ?? null;
  }
}

function sourceFacts(snapshot: Record<string, unknown>): ReaderSourceFacts {
  return {
    title: typeof snapshot.title === "string" && snapshot.title ? snapshot.title : null,
    authors: Array.isArray(snapshot.authors) ? snapshot.authors.filter((a): a is string => typeof a === "string") : [],
    canonicalId: typeof snapshot.canonicalId === "string" ? snapshot.canonicalId : null,
  };
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
        <p className="reader-warning" role="note">
          公式渲染失败，保留来源表示与诊断。
        </p>
      )}
      {item.text && <p className="reader-formula-text">{item.text}</p>}
    </div>
  );
}

function FigureView({
  item,
  root,
  revisionPath,
  onNavigate,
  translatedUnit,
}: {
  item: Extract<ReaderItem, { kind: "figure" }>;
  root: string;
  revisionPath: string;
  onNavigate: (unitId: string) => void;
  translatedUnit?: (unitId: string) => TranslationUnitView | undefined;
}) {
  const [failed, setFailed] = useState(false);
  const captionText =
    item.caption?.sentences.flatMap((s) => s.parts.map((p) => (p.kind === "text" ? p.text : p.atom.text))).join("") ??
    "图片";
  const src = item.asset
    ? "paper30min://project/image?" + new URLSearchParams({ root, path: `${revisionPath}/${item.asset.path}` })
    : "";
  return (
    <figure className="reader-figure" data-block-id={item.blockId}>
      {item.asset && !failed ? (
        <img src={src} alt={captionText} loading="lazy" onError={() => setFailed(true)} />
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
          <UnitBody unit={item.caption} onNavigate={onNavigate} translation={translatedUnit?.(item.caption.unitId)} />
        </figcaption>
      )}
    </figure>
  );
}

function TableView({
  item,
  onNavigate,
  translatedUnit,
}: {
  item: Extract<ReaderItem, { kind: "table" }>;
  onNavigate: (unitId: string) => void;
  translatedUnit?: (unitId: string) => TranslationUnitView | undefined;
}) {
  return (
    <div className="reader-table-scroll" data-block-id={item.blockId}>
      <table className="reader-table">
        {item.caption && (
          <caption data-unit-id={item.caption.unitId}>
            <UnitBody unit={item.caption} onNavigate={onNavigate} translation={translatedUnit?.(item.caption.unitId)} />
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
                  <UnitBody
                    unit={item.cells[cell.unitId]}
                    onNavigate={onNavigate}
                    translation={translatedUnit?.(cell.unitId)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawView({
  item,
  translation,
}: {
  item: Extract<ReaderItem, { kind: "raw" }>;
  translation?: TranslationRawProjection;
}) {
  // 渲染层按白名单独立消毒；结构限制必须可见，文本投影保证辅助技术可读。
  const html = sanitizeRawHtml(item.html);
  return (
    <div className="reader-raw" data-block-id={item.blockId}>
      <div className="reader-raw-html" dangerouslySetInnerHTML={{ __html: html }} />
      {translation && translation.status !== "gap" && (
        <p className="reader-raw-translation" data-raw-translation-status={translation.status}>
          {translation.content}
          {translation.status === "stale" && <span className="reader-translation-note stale">已过期</span>}
          <span className="reader-translation-note">raw 仅文本投影，结构以原文为准</span>
        </p>
      )}
      <ul className="reader-raw-limitations">
        {item.limitations.map((limitation, index) => (
          <li key={index} className="reader-raw-limit">
            {limitation}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnitView({
  item,
  onCorrect,
  onNavigate,
  translation,
}: {
  item: Extract<ReaderItem, { kind: "unit" }>;
  onCorrect?: (unitId: string) => void;
  onNavigate: (unitId: string) => void;
  translation?: TranslationUnitView;
}) {
  const Tag = item.unitKind === "reference" || item.unitKind === "footnote" ? "div" : "p";
  return (
    <Tag className={`reader-unit reader-unit-${item.unitKind}`} data-unit-id={item.unitId} data-block-id={item.blockId}>
      <UnitBody unit={item} onNavigate={onNavigate} translation={translation} />
      {onCorrect && (
        <Button
          className="reader-correct-entry"
          aria-label={`修正单元 ${item.unitId.slice(0, 8)}`}
          onClick={() => onCorrect(item.unitId)}
        >
          修正
        </Button>
      )}
    </Tag>
  );
}

/** 选区工具条状态：逻辑映射结果＋视口坐标；revision/代际切换即失效。
 * view 区分原文/译文选区：译文 quote 不得冒充原文锚点写入原 anchor。 */
interface SelectionToolbarState {
  x: number;
  y: number;
  quote: string;
  context: string;
  degraded: boolean;
  view: "source" | "translation";
}

export function FullReader({
  root,
  epoch = 0,
  onAsk,
  savedPosition = null,
  onPosition,
}: {
  root: string;
  epoch?: number;
  /** 解释/提问进入右侧持续对话；reader 不创建问答卡、不直接发送模型请求。 */
  onAsk?: (draft: string) => void;
  /** workspace 持久化的本窗格位置（挂载时快照）；恢复以锚点为权威。 */
  savedPosition?: ReadingPosition | null;
  /** 位置捕获回调：workspace 决定持久化时机；reader 不直接写文件。 */
  onPosition?: (position: ReadingPosition) => void;
}) {
  const [state, setState] = useState<ReaderState | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [toolbar, setToolbar] = useState<SelectionToolbarState | null>(null);
  const [notice, setNotice] = useState<PositionNotice | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // 修正宿主（SPEC-reader §8）：显式进入单元修正；发布成功后按新 revision 重读。
  const [correctingUnit, setCorrectingUnit] = useState<string | null>(null);
  // 来源候选冲突宿主（SPEC-reader §9）：候选与 current 明确区分，逐项解决后发布。
  const [candidate, setCandidate] = useState<(DocumentMergeResult & { root: string; sourceSnapshotId: string }) | null>(
    null,
  );
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [localEpoch, setLocalEpoch] = useState(0);
  // 语言视图（SPEC-translation §5）：null 为原文；译文投影由主进程验证后只读消费。
  const [language, setLanguage] = useState<TranslationLanguage | null>(null);
  const [translation, setTranslation] = useState<TranslationProjection | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [translationStatus, setTranslationStatus] = useState("");
  const translationEpoch = useRef(0);
  const translationRootRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const articleRef = useRef<HTMLElement | null>(null);
  // 恢复请求代际：用户滚动即失效，迟到布局结果不得覆盖新位置。
  const restoreEpoch = useRef(0);
  // 用户真实滚动意图（wheel/触摸/键盘）：程序化恢复滚动不算。
  const userScrolled = useRef(false);
  // 程序化滚动归属：记录 scrollTo 之后浏览器实际落点（含钳制），
  // scroll 事件落在该位置即程序化；其余一律用户意图，恢复让位（§5.6）。
  const expectedScrollTop = useRef<number | null>(null);
  const programmaticScrollTo = (container: HTMLElement, top: number) => {
    if (Math.abs(container.scrollTop - top) <= 1) return;
    container.scrollTo({ top, behavior: "instant" });
    // 读回实际落点：末尾锚点会被浏览器钳制，归属必须按钳制后位置比较。
    expectedScrollTop.current = container.scrollTop;
  };
  const cancelRestore = () => {
    userScrolled.current = true;
    restoreEpoch.current++;
    expectedScrollTop.current = null;
  };
  const savedRef = useRef(savedPosition);
  savedRef.current = savedPosition;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const stateRef = useRef<ReaderState | null>(null);
  stateRef.current = state;
  const languageRef = useRef<TranslationLanguage | null>(null);
  languageRef.current = language;

  useEffect(() => {
    const request = ++requestRef.current;
    let disposed = false;
    setState(null);
    setStatus("loading");
    // 工程切换：旧语言投影不得冒充新工程的译文。同工程内的 revision 推进
    // 不在此清空（译文提交本身会触发 project:changed）；由代际与 revision 守卫兜底。
    if (translationRootRef.current !== root) {
      translationRootRef.current = root;
      translationEpoch.current++;
      setTranslation(null);
      setLanguage(null);
      setTranslationStatus("");
    }
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
      const [treeValue, snapshot, context, verification] = await Promise.all([
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
        desktop.invoke<ProjectRevisionContext>({
          type: "coreReadRevisionContext",
          root,
          revisionId: revision.revisionId,
        }),
        // 核验记录缺失不影响阅读；读取失败如实标记，不冒充“无核验记录”。
        desktop
          .invoke<VerificationRecord[]>({
            type: "corePdfReadVerification",
            root,
            revisionId: revision.revisionId,
          })
          .then(
            (records) => ({ records, error: null as string | null }),
            (error: Error) => ({
              records: [] as VerificationRecord[],
              error: error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""),
            }),
          ),
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
        context,
        snapshot,
        snapshotWarnings: readDiagnosticArray(snapshot.warnings),
        verification: verification.records,
        verificationError: verification.error,
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
  }, [root, epoch, localEpoch]);

  // 渐进刷新：译文 index 每次原子推进即重读当前语言投影；
  // 只替换句级内容，不重排阅读位置、不强制 reload。
  useEffect(() => {
    if (status !== "ready" || !state || language === null) return;
    const revisionId = state.revisionId;
    let disposed = false;
    const stop = desktop.watchTranslation(root, (changedLanguage) => {
      if (changedLanguage !== language || disposed) return;
      void desktop
        .invoke<TranslationReadCommandResult>({ type: "coreTranslationRead", root, revisionId, language })
        .then((projection) => {
          if (!disposed && stateRef.current?.revisionId === revisionId && languageRef.current === language) {
            setTranslation(projection);
            setTranslationBusy(projection.running === true);
          }
        })
        .catch((error: Error) => {
          if (!disposed && stateRef.current?.revisionId === revisionId && languageRef.current === language)
            setTranslationStatus(
              `译文刷新失败：${error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")}`,
            );
        });
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [status, state, root, language]);

  // revision 推进（修正／来源更新发布）：语言视图保持，按新 current 重读迁移后的
  // 译文投影；旧 revision 投影不得冒充新原文的译文。不自动发起模型请求。
  useEffect(() => {
    const revisionId = stateRef.current?.revisionId;
    if (status !== "ready" || !revisionId || language === null) return;
    const target = language;
    let disposed = false;
    void desktop
      .invoke<TranslationReadCommandResult>({ type: "coreTranslationRead", root, revisionId, language: target })
      .then((projection) => {
        if (!disposed && stateRef.current?.revisionId === revisionId && languageRef.current === target)
          setTranslation(projection);
      })
      .catch((error: Error) => {
        if (!disposed && stateRef.current?.revisionId === revisionId && languageRef.current === target) {
          // 读取失败不保留旧 revision 的 ready 内容：清除投影并给出可行动错误。
          setTranslation(null);
          setTranslationStatus(
            `译文读取失败：${error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")}请重试语言切换。`,
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [status, state, root, language]);

  // 元数据与正文共用同一身份守卫：revision 推进或语言互切后，旧投影的
  // 标题/raw 不得在新读取完成前按 ready 显示。
  const activeTranslation =
    language !== null &&
    translation &&
    state &&
    translation.language === language &&
    translation.baseRevision === state.revisionId
      ? translation
      : null;

  // 语言视图句级投影：选区索引与渲染共用同一 memo，translation:changed 渐进刷新。
  // 投影身份显式键控 (revisionId, language)：语言互切或 revision 推进后，
  // 旧投影在新读取完成前不得进入渲染（迟到/失败响应不冒充当前视图）。
  const translationViews = useMemo(
    () =>
      language !== null &&
      translation &&
      state &&
      translation.language === language &&
      translation.baseRevision === state.revisionId
        ? buildTranslationUnitViews(readerProjectionUnits(state.projection), translation)
        : null,
    [language, translation, state],
  );
  const translationIndex = useMemo<TranslationSelectionIndex | null>(
    () =>
      translationViews && state && translation
        ? buildTranslationSelectionIndex(translationViews, state.projection, translation)
        : null,
    [translationViews, state, translation],
  );
  const translationIndexRef = useRef<TranslationSelectionIndex | null>(null);
  translationIndexRef.current = translationIndex;

  // 选区交互：DOM 只承担交互，权威偏移经投影索引映射；工具条不破坏原生选择。
  // 语言视图选区只覆盖 ready/stale 译文片段（crd.4）：gap 原文与 stale 对照区
  // 不冒充译文 range；跨语言只按原句软映射，不做偏移互换。
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
    const inTranslation = languageRef.current !== null;
    // stale 对照区展示最新原文（原文锚点）：在语言视图中不参与译文选区。
    // 两端分别检查：跨旧译文与对照区的选区共同祖先在对照区外，仍须拒绝。
    if (inTranslation) {
      const inStaleSource = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement;
        return element?.closest("[data-stale-source]") != null;
      };
      if (inStaleSource(range.startContainer) || inStaleSource(range.endContainer)) {
        setToolbar(null);
        return;
      }
    }
    const index = inTranslation ? translationIndexRef.current : current.index;
    if (!index) {
      setToolbar(null);
      return;
    }
    const mapping = mapDomSelection(range, index);
    if (mapping.ranges.length === 0 && mapping.degraded.length === 0) {
      setToolbar(null);
      return;
    }
    let quote = "";
    let context = "";
    let degraded = mapping.degraded.length > 0;
    if (mapping.ranges.length > 0) {
      try {
        const snapshot = inTranslation
          ? translationQuote(translationIndexRef.current!, mapping.ranges)
          : createRangeAnchor(current.tree, mapping.ranges).quote;
        quote = snapshot.text;
        context = [snapshot.before, snapshot.text, snapshot.after].filter(Boolean).join("");
      } catch {
        // 映射与树/译文投影不一致（受损字节或投影已推进）：不伪造 quote，按降级处理。
        degraded = true;
      }
    }
    const rect = range.getBoundingClientRect();
    const width = 220;
    const x = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const y = rect.bottom + 8 + 40 > window.innerHeight ? Math.max(8, rect.top - 48) : rect.bottom + 8;
    setToolbar({
      x,
      y,
      quote,
      context,
      degraded: degraded || quote === "",
      view: inTranslation ? "translation" : "source",
    });
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

  // 位置捕获（SPEC-reader §5.1）：视口最上方可见锚点＋锚内相对偏移；
  // scrollTop 只作辅助。用户滚动使进行中的恢复失效（§5.6）。
  const capturePosition = useCallback((): ReadingPosition | null => {
    const article = articleRef.current;
    const current = stateRef.current;
    const container = article?.parentElement;
    if (!article || !current || !container) return null;
    const containerTop = container.getBoundingClientRect().top;
    const candidates = article.querySelectorAll<HTMLElement>("[data-block-id], [data-section-id]");
    let chosen: HTMLElement | null = null;
    let anchor: ReadingPositionAnchor | null = null;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= containerTop + 1) continue;
      const unitId = element.getAttribute("data-unit-id");
      const sectionId = element.getAttribute("data-section-id");
      const blockId = element.getAttribute("data-block-id");
      if (unitId && current.tree.units[unitId]) anchor = { kind: "unit", unitId };
      else if (sectionId && current.tree.sections[sectionId]) anchor = { kind: "section", sectionId };
      else if (blockId && current.tree.blocks.some((block) => block.id === blockId))
        anchor = { kind: "block", blockId };
      else continue;
      chosen = element;
      break;
    }
    if (!chosen || !anchor) return null;
    const excerpt = (chosen.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      revisionId: current.revisionId,
      view: languageRef.current === null ? "source" : "translation",
      anchor,
      parentSectionId: parentSectionOf(current.tree, anchor),
      excerpt,
      offsetWithinAnchor: containerTop - chosen.getBoundingClientRect().top,
      scrollTop: container.scrollTop,
      capturedAt: new Date().toISOString(),
    };
  }, []);

  // 语言切换与渐进提交的阅读位置稳定（SPEC-translation §5.2）：译文文本长度
  // 变化会重排上方内容；布局变化前捕获视口锚点，变化后按同一锚点重对齐。
  // 不做持续恢复窗口：用户滚动即让位，后续渐进提交重新捕获当前视口锚点。
  const translationLayoutKey = translationViews
    ? `${language}:${translation?.translationRevision ?? "none"}`
    : `${language}:source-fallback`;
  const translationLayoutRef = useRef<{ key: string; position: ReadingPosition | null } | null>(null);
  // 渲染期（DOM 仍是旧布局）捕获上一布局的视口锚点；effect 在布局提交后对齐。
  if (translationLayoutRef.current?.key !== translationLayoutKey) {
    translationLayoutRef.current = {
      key: translationLayoutKey,
      position: status === "ready" ? capturePosition() : null,
    };
  }
  const pendingTranslationAnchor = translationLayoutRef.current.position;
  useEffect(() => {
    if (status !== "ready" || !state || !pendingTranslationAnchor) return;
    translationLayoutRef.current = { key: translationLayoutKey, position: null };
    const container = articleRef.current?.parentElement;
    const article = articleRef.current;
    if (!container || !article || userScrolled.current) return;
    const element = article.querySelector<HTMLElement>(positionAnchorSelector(pendingTranslationAnchor.anchor));
    if (!element) return;
    const top = Math.max(
      0,
      container.scrollTop +
        element.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        pendingTranslationAnchor.offsetWithinAnchor,
    );
    programmaticScrollTo(container, top);
  }, [status, state, translationLayoutKey, pendingTranslationAnchor, capturePosition]);

  useEffect(() => {
    if (status !== "ready") return;
    const container = articleRef.current?.parentElement;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      const expected = expectedScrollTop.current;
      // 落在程序化实际落点即恢复/resize/定位自身滚动；其余视为用户意图。
      if (expected !== null && Math.abs(container.scrollTop - expected) <= 2) {
        expectedScrollTop.current = null;
      } else {
        cancelRestore();
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const position = capturePosition();
        if (position) onPositionRef.current?.(position);
      }, 200);
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelRestore();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    const onWheel = () => cancelRestore();
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchmove", cancelRestore, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchmove", cancelRestore);
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
      // 仅在仍对应当前 revision 时落盘：revision 切换的清理不得把
      // 旧 DOM 的视口位置写成新 revision 的捕获（卸载/切 tab 仍会捕获）。
      const position = capturePosition();
      if (position && position.revisionId === stateRef.current?.revisionId) onPositionRef.current?.(position);
    };
  }, [status, capturePosition]);

  // 恢复（SPEC-reader §5.2–5.5）：先按锚点定位已挂载目标，等字体/图片/公式
  // 布局稳定后恢复锚内相对偏移；removed 按父 section 显式回退并展示摘录。
  useEffect(() => {
    if (status !== "ready" || !state) return;
    const saved = savedRef.current;
    const container = articleRef.current?.parentElement;
    const article = articleRef.current;
    if (!saved || !container || !article) return;
    const epochAtStart = ++restoreEpoch.current;
    userScrolled.current = false;
    // 恢复窗口内禁用浏览器滚动锚定：KaTeX 字体度量等上方高度漂移
    // 会静默平移 scrollTop 且不触发 scroll 事件，与锚点恢复互相打架。
    const previousOverflowAnchor = container.style.overflowAnchor;
    container.style.overflowAnchor = "none";
    const resolution = resolveReadingPosition(saved, {
      tree: state.tree,
      projection: state.projection,
      changeset: state.context.changeset,
      tombstones: state.context.tombstones,
    });
    const target = resolution.status === "removed" ? resolution.fallback : resolution.anchor;
    setNotice(
      resolution.status === "restored"
        ? null
        : {
            text: resolution.notice,
            excerpt:
              resolution.status === "removed" ? resolution.tombstone?.excerpt || resolution.excerpt || null : null,
          },
    );
    const offset = resolution.status === "removed" ? 0 : resolution.offsetWithinAnchor;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    const timers: number[] = [];
    let interval: number | null = null;
    const align = () => {
      if (disposed || epochAtStart !== restoreEpoch.current || userScrolled.current) return;
      const element = target ? article.querySelector<HTMLElement>(positionAnchorSelector(target)) : null;
      if (target && !element) return;
      const top = Math.max(
        0,
        element
          ? container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - offset
          : 0,
      );
      programmaticScrollTo(container, top);
    };
    // 首帧同步对齐：不等 fonts.ready。离屏/隐藏窗口帧生成可能迟到，
    // 恢复必须先落在当前布局上，字体度量漂移由 observer/兜底核对修正。
    align();
    // 图片/公式懒加载与 KaTeX 字体度量都会改变高度：尺寸与子树变化
    // 都按同一锚点重对齐；用户滚动即整体失效。
    resizeObserver = new ResizeObserver(align);
    resizeObserver.observe(article);
    mutationObserver = new MutationObserver(align);
    mutationObserver.observe(article, { childList: true, subtree: true, characterData: true });
    timers.push(
      window.setTimeout(() => {
        resizeObserver?.disconnect();
        resizeObserver = null;
        mutationObserver?.disconnect();
        mutationObserver = null;
      }, 2000),
    );
    // 兜底核对：字体度量/懒加载可能在 observer 静默期后仍改变上方高度；
    // 周期性按同一锚点核对，仍受代际与用户滚动约束。
    interval = window.setInterval(align, 400);
    timers.push(
      window.setTimeout(() => {
        if (interval !== null) window.clearInterval(interval);
        interval = null;
      }, 8000),
    );
    return () => {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      if (interval !== null) window.clearInterval(interval);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      container.style.overflowAnchor = previousOverflowAnchor;
    };
  }, [status, state]);

  // resize/布局变化：以当前锚点为中心重定位，不追求旧绝对像素（§5.3）。
  useEffect(() => {
    if (status !== "ready") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const position = capturePosition();
        const container = articleRef.current?.parentElement;
        const article = articleRef.current;
        if (!position || !container || !article) return;
        const element = article.querySelector<HTMLElement>(positionAnchorSelector(position.anchor));
        if (!element) return;
        const top = Math.max(
          0,
          container.scrollTop +
            element.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            position.offsetWithinAnchor,
        );
        programmaticScrollTo(container, top);
      }, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timer);
    };
  }, [status, capturePosition]);

  function ask(mode: "解释" | "提问") {
    if (!toolbar || !onAsk) return;
    const target = toolbar.view === "translation" ? "译文" : "原文";
    const header = mode === "解释" ? `请解释以下${target}选区：` : `关于以下${target}选区，我想提问：`;
    const body = toolbar.quote
      ? `> ${toolbar.quote.split("\n").join("\n> ")}\n\n（上下文：${toolbar.context}）`
      : "（该选区包含无法精确映射的内容，已按块级锚点降级。）";
    onAsk(`${header}\n${body}\n\n`);
    setToolbar(null);
  }

  // 来源诊断（SPEC-reader §7）：投影内结构化诊断＋渲染层公式失败诊断；
  // 核验四态按节点聚合，不产生质量分数。公式失败诊断只在面板打开时计算，
  // 避免初始加载对每个独立公式重复一次 KaTeX 渲染。
  const diagnostics = useMemo<ReaderDiagnostic[]>(() => {
    if (!state) return [];
    const collected = collectReaderDiagnostics(state.projection);
    if (panelOpen) {
      for (const item of state.projection.items) {
        if (item.kind !== "formula" || item.source.format !== "latex") continue;
        try {
          katex.renderToString(item.source.value, {
            throwOnError: true,
            trust: false,
            strict: "ignore",
            displayMode: true,
          });
        } catch {
          collected.push({
            code: "formula-render-failed",
            message: "公式渲染失败，保留来源表示与诊断。",
            blockId: item.blockId,
          });
        }
      }
    }
    return collected;
  }, [state, panelOpen]);
  const verificationSummary = useMemo(
    () => (state ? summarizeVerification(state.tree, state.verification) : null),
    [state],
  );
  function locateBlock(blockId: string) {
    const article = articleRef.current;
    const container = article?.parentElement;
    const target = article?.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
    if (!article || !container || !target) return;
    const top = Math.max(
      0,
      container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 24,
    );
    // 显式定位是用户导航意图：取消进行中的恢复，避免兜底核对拉回旧锚点。
    cancelRestore();
    programmaticScrollTo(container, top);
    target.classList.add("reader-jump-target");
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    window.setTimeout(() => target.classList.remove("reader-jump-target"), 2000);
  }

  // atom 交叉引用/脚注跳转：与诊断定位同一导航语义（取消恢复、程序化归属）。
  function navigateUnit(unitId: string) {
    const article = articleRef.current;
    const container = article?.parentElement;
    const target = article?.querySelector<HTMLElement>(`[data-unit-id="${unitId}"]`);
    if (!article || !container || !target) return;
    const top = Math.max(
      0,
      container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 24,
    );
    cancelRestore();
    programmaticScrollTo(container, top);
    target.classList.add("reader-jump-target");
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    window.setTimeout(() => target.classList.remove("reader-jump-target"), 2000);
  }

  // 来源更新入口（SPEC-reader §9.1）：显式检查新版本并构建候选；
  // 候选进入冲突宿主，确认发布前 current 不变。
  async function checkSourceUpdate() {
    if (!state) return;
    setUpdateBusy(true);
    setUpdateStatus("正在检查新版本…");
    const operationId = crypto.randomUUID();
    // 更新检查沿用来源谱系的受控端点：快照记录的 absUrl origin 即获取来源；
    // 生产为 https://arxiv.org，测试回环端点仅在主进程测试门控下生效。
    let baseUrl: string | undefined;
    const absUrl = state.snapshot.absUrl;
    if (typeof absUrl === "string") {
      try {
        baseUrl = new URL(absUrl).origin;
      } catch {
        baseUrl = undefined;
      }
    }
    try {
      const check = await desktop.invoke<ArxivUpdateCheckCommandResult>({
        type: "coreArxivCheckUpdate",
        root,
        operationId,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
      if (!check.ok) {
        setUpdateStatus(`无法检查更新：${check.diagnostic.messageKey}`);
        return;
      }
      if (check.status === "up-to-date") {
        setUpdateStatus("已是最新版本。");
        return;
      }
      if (check.status === "withdrawn") {
        setUpdateStatus("最新版本已撤稿，不自动采用；如需更新请显式选择历史版本。");
        return;
      }
      setUpdateStatus(`发现新版本 ${check.latest.canonicalId}，正在构建候选…`);
      const built = await desktop.invoke<ArxivUpdateCandidateCommandResult>({
        type: "coreArxivUpdateCandidate",
        root,
        reference: check.latest,
        baseRevision: state.revisionId,
        operationId: crypto.randomUUID(),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
      if (!built.ok) {
        setUpdateStatus(`候选构建失败：${built.diagnostic.messageKey}`);
        return;
      }
      if (built.outcome === "reused") {
        setUpdateStatus("同版重取字节一致，未产生新候选。");
        return;
      }
      setUpdateStatus("");
      setCandidate(built.candidate);
    } catch (e) {
      setUpdateStatus((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      setUpdateBusy(false);
    }
  }

  // 语言切换（SPEC-translation §1/§5）：原文即回；首次进入无译文语言才启动任务，
  // 已有译文只切换视图。任务期间渐进刷新投影，不重排阅读位置、不强制 reload。
  async function switchLanguage(target: TranslationLanguage | null) {
    if (!state) return;
    const epochAtStart = ++translationEpoch.current;
    const current = state;
    if (target === null) {
      setLanguage(null);
      setTranslation(null);
      setTranslationStatus("");
      setTranslationBusy(false);
      setToolbar(null);
      return;
    }
    // 语言互切：旧语言投影立即退出渲染（memo 身份键控兜底），读取期间显示原文锚点 gap。
    setTranslation(null);
    setLanguage(target);
    setToolbar(null);
    setTranslationBusy(true);
    setTranslationStatus("正在读取译文…");
    const stale = () => epochAtStart !== translationEpoch.current || stateRef.current !== current;
    try {
      const existing = await desktop.invoke<TranslationReadCommandResult>({
        type: "coreTranslationRead",
        root,
        revisionId: current.revisionId,
        language: target,
      });
      if (stale()) return;
      setTranslation(existing);
      setTranslationBusy(existing.running === true);
      const sourceLanguage = existing.sourceLanguage ?? detectSourceLanguage(current.tree);
      if (sourceLanguage === null) {
        setTranslationStatus("无法确定原文语言，未启动翻译；正文仍以原文显示。");
        return;
      }
      if (sourceLanguage === target) {
        setTranslationStatus("目标语言与原文相同，不创建翻译任务。");
        return;
      }
      // 已有译文只切换视图：全部原文单元的句子都 ready 才算完成；
      // 未提交单元（gap）不在 index 中，不能因“已提交部分全 ready”误判完成。
      const sourceUnits = readerProjectionUnits(current.projection);
      const readyByUnit = new Map(
        existing.units.map((unit) => [
          unit.unitId,
          new Set(
            unit.sentences.filter((sentence) => sentence.status === "ready").map((sentence) => sentence.sentenceId),
          ),
        ]),
      );
      const metaStatuses = [
        ...(existing.paperTitle ? [existing.paperTitle.status] : []),
        ...(existing.sections ?? []).map((section) => section.status),
        ...(existing.rawBlocks ?? []).map((raw) => raw.status),
      ];
      const allReady =
        existing.translationRevision !== null &&
        sourceUnits.length > 0 &&
        metaStatuses.every((status) => status === "ready") &&
        sourceUnits.every((unit) => {
          const ready = readyByUnit.get(unit.unitId);
          return (
            ready !== undefined &&
            unit.sentences.length > 0 &&
            unit.sentences.every((sentence) => ready.has(sentence.sentenceId))
          );
        });
      if (allReady) {
        setTranslationStatus("");
        return;
      }
      setTranslationStatus(`正在生成${target === "zh" ? "中文" : "英文"}译文（可能产生模型费用）…`);
      const started = await desktop.invoke<TranslationStartCommandResult>({
        type: "coreTranslationStart",
        root,
        language: target,
      });
      if (stale()) return;
      if (started.status === "finished") {
        setTranslation(started.projection);
        setTranslationBusy(started.projection.running === true);
        const gaps = started.units.filter((unit) => unit.status === "gap");
        setTranslationStatus(gaps.length > 0 ? `译文已渐进发布；${gaps.length} 个单元暂为缺口，可稍后补译。` : "");
      } else if (started.projection) {
        setTranslation(started.projection);
        setTranslationBusy(started.projection.running === true);
        const gaps = started.projection.task?.gaps ?? [];
        setTranslationStatus(
          started.reason === "busy"
            ? "该语言已有翻译任务在运行，译文将渐进出现。"
            : gaps.length > 0
              ? `译文已渐进发布；${gaps.length} 个单元暂为缺口，可稍后补译。`
              : "",
        );
      } else {
        setTranslationStatus("翻译任务未启动：正文尚未发布或已有同语言任务。");
        if (epochAtStart === translationEpoch.current) setTranslationBusy(false);
      }
    } catch (error) {
      if (stale()) return;
      setTranslationStatus((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      // 代际被后续动作取代时由新动作管理 busy；此处不得把新任务的 busy 清掉。
      if (epochAtStart === translationEpoch.current) setTranslationBusy(false);
    }
  }

  // 显式补译／更新过期译文（SPEC-translation §8）：只处理目标状态，
  // 费用提示与任务状态可见；渐进刷新由 translation:changed 承担。
  async function runTranslationAction(action: "fill-gaps" | "update-stale") {
    if (!state || language === null || translationBusy) return;
    const target = language;
    const epochAtStart = ++translationEpoch.current;
    const current = state;
    const stale = () => epochAtStart !== translationEpoch.current || stateRef.current !== current;
    setTranslationBusy(true);
    setTranslationStatus(
      action === "fill-gaps"
        ? `正在补译${target === "zh" ? "中文" : "英文"}缺口（可能产生模型费用）…`
        : `正在更新过期译文（可能产生模型费用）…`,
    );
    try {
      const result = await desktop.invoke<TranslationStartCommandResult>({
        type: action === "fill-gaps" ? "coreTranslationFillGaps" : "coreTranslationUpdateStale",
        root,
        language: target,
      });
      if (stale()) return;
      if (result.status === "finished") {
        setTranslation(result.projection);
        setTranslationBusy(result.projection.running === true);
        const gaps = result.units.filter((unit) => unit.status === "gap");
        setTranslationStatus(
          gaps.length > 0
            ? action === "fill-gaps"
              ? `补译完成；仍有 ${gaps.length} 个单元缺口，可检查模型后重试。`
              : `过期译文更新完成；${gaps.length} 个单元更新失败，旧译文继续以过期显示。`
            : action === "fill-gaps"
              ? "缺口补译完成。"
              : "过期译文已更新。",
        );
      } else if (result.projection) {
        setTranslation(result.projection);
        setTranslationBusy(result.projection.running === true);
        setTranslationStatus(
          result.reason === "busy"
            ? "该语言已有翻译任务在运行，译文将渐进出现。"
            : action === "fill-gaps"
              ? "没有需要补译的缺口。"
              : "没有需要更新的过期译文。",
        );
      }
    } catch (error) {
      if (stale()) return;
      setTranslationStatus((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      if (epochAtStart === translationEpoch.current) setTranslationBusy(false);
    }
  }

  // 用户停止（SPEC-translation §6.5）：取消未发送批次；已在途请求可能已产生
  // 费用，完成且合法的结果仍会保存。停止后同指纹不再自动补试，手动补译可再发起。
  async function stopTranslation() {
    if (!state || language === null) return;
    const target = language;
    ++translationEpoch.current;
    try {
      await desktop.invoke({ type: "coreTranslationStop", root, language: target });
      if (languageRef.current !== target) return;
      const projection = await desktop.invoke<TranslationReadCommandResult>({
        type: "coreTranslationRead",
        root,
        revisionId: stateRef.current!.revisionId,
        language: target,
      });
      if (languageRef.current === target) {
        setTranslation(projection);
        setTranslationBusy(projection.running === true);
      }
      setTranslationStatus("已停止翻译：未发送批次已取消；已完成的译文保留，在途请求可能已产生费用。");
    } catch (error) {
      setTranslationStatus((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      setTranslationBusy(false);
    }
  }

  if (status === "loading") return <EmptyState>正在读取正文…</EmptyState>;
  if (status === "empty")
    return (
      <EmptyState className="full-reader-empty" role="status">
        尚未发布正文：工程已创建，但 current 为空。完成导入后这里会显示全文。
      </EmptyState>
    );
  if (status === "error" || !state)
    return (
      <InlineMessage variant="error" className="full-reader-empty empty">
        正文不可读：{message || "revision 损坏或引用不完整。"}请重新导入或恢复工程，不会以旧内容冒充正文。
      </InlineMessage>
    );

  const { projection, facts } = state;
  const revisionPath = `paper/revisions/${state.revisionId}`;
  // 语言视图：句级投影 memo 与选区索引共用；未提交单元全部为 gap。
  const translationViewMap = translationViews ? new Map(translationViews.map((view) => [view.unitId, view])) : null;
  const translatedUnit = translationViewMap ? (unitId: string) => translationViewMap.get(unitId) : undefined;
  // 缺口与过期计数（含标题/raw 元数据）：显式动作入口只在存在目标状态时出现。
  const translationCounts = (() => {
    const counts = { gaps: 0, stale: 0 };
    if (translationViewMap)
      for (const view of translationViewMap.values())
        for (const sentence of view.sentences) {
          if (sentence.status === "gap") counts.gaps++;
          else if (sentence.status === "stale") counts.stale++;
        }
    const metaStatuses = [
      ...(activeTranslation?.paperTitle ? [activeTranslation.paperTitle.status] : []),
      ...(activeTranslation?.sections ?? []).map((section) => section.status),
      ...(activeTranslation?.rawBlocks ?? []).map((raw) => raw.status),
    ];
    for (const status of metaStatuses) {
      if (status === "gap") counts.gaps++;
      else if (status === "stale") counts.stale++;
    }
    return counts;
  })();
  return (
    <article
      className="full-reader"
      data-revision-id={state.revisionId}
      data-language-view={language ?? "source"}
      ref={articleRef}
      onMouseUp={refreshSelection}
      onKeyUp={refreshSelection}
    >
      <header className="reader-header">
        <h1 data-paper-title>
          {activeTranslation?.paperTitle && activeTranslation.paperTitle.status !== "gap"
            ? activeTranslation.paperTitle.content
            : (facts.title ?? "未命名论文")}
          {activeTranslation?.paperTitle?.status === "stale" && (
            <span className="reader-translation-note stale">已过期</span>
          )}
        </h1>
        {activeTranslation?.paperTitle?.status === "stale" && (
          <p className="reader-stale-source" data-paper-title-source>
            最新原文：{activeTranslation.paperTitle.source}
          </p>
        )}
        {facts.authors.length > 0 && <p className="reader-authors">{facts.authors.join("、")}</p>}
        {facts.canonicalId && <p className="reader-source muted">arXiv {facts.canonicalId}</p>}
        <Button className="reader-source-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>
          来源与诊断{diagnostics.length > 0 ? `（${diagnostics.length} 条正文诊断）` : ""}
        </Button>
        {facts.canonicalId && (
          <Button className="reader-source-toggle" disabled={updateBusy} onClick={() => void checkSourceUpdate()}>
            检查来源更新
          </Button>
        )}
        {updateStatus && <InlineMessage className="reader-update-status">{updateStatus}</InlineMessage>}
        <TranslationControls
          language={language}
          busy={translationBusy}
          status={translationStatus}
          gaps={translationCounts.gaps}
          stale={translationCounts.stale}
          hasProjection={translation !== null}
          onSwitch={(target) => void switchLanguage(target)}
          onAction={(action) => void runTranslationAction(action)}
          onStop={() => void stopTranslation()}
        />
      </header>
      {panelOpen && (
        <SourcePanel
          facts={sourcePanelFacts(state.snapshot, state.context.revision)}
          snapshotWarnings={state.snapshotWarnings}
          revisionWarnings={(() => {
            const meta = state.context.revision.arxiv ?? state.context.revision.pdfParse;
            return meta !== null && typeof meta === "object"
              ? readDiagnosticArray((meta as Record<string, unknown>).warnings)
              : [];
          })()}
          diagnostics={diagnostics}
          verification={
            verificationSummary && {
              counts: verificationSummary.counts,
              records: state.verification,
            }
          }
          verificationError={state.verificationError}
          onLocate={locateBlock}
        />
      )}
      {candidate && (
        <ConflictHost
          root={root}
          candidate={candidate}
          currentTree={state.tree}
          onCandidateChange={setCandidate}
          onClose={() => setCandidate(null)}
          onPublished={() => {
            setCandidate(null);
            setLocalEpoch((value) => value + 1);
          }}
        />
      )}
      {correctingUnit && (
        <CorrectionHost
          key={`${state.revisionId}:${correctingUnit}`}
          root={root}
          tab="paper"
          tree={state.tree}
          baseRevision={state.revisionId}
          unitId={correctingUnit}
          onClose={() => setCorrectingUnit(null)}
          onPublished={() => {
            setCorrectingUnit(null);
            setLocalEpoch((value) => value + 1);
          }}
        />
      )}
      {notice && (
        <InlineMessage variant="warning" className="reader-position-notice">
          <p>{notice.text}</p>
          {notice.excerpt && <blockquote className="reader-position-excerpt">{notice.excerpt}</blockquote>}
          <Button onClick={() => setNotice(null)}>知道了</Button>
        </InlineMessage>
      )}
      {projection.items.map((item, index) => {
        switch (item.kind) {
          case "section": {
            if (!item.title) return null;
            const Level = (item.depth <= 5 ? `h${item.depth + 1}` : "h6") as "h2" | "h3" | "h4" | "h5" | "h6";
            const sectionTranslation = activeTranslation?.sections?.find((entry) => entry.sectionId === item.sectionId);
            return (
              <Level key={`section-${item.sectionId}`} data-section-id={item.sectionId}>
                {sectionTranslation && sectionTranslation.status !== "gap" ? sectionTranslation.content : item.title}
                {sectionTranslation?.status === "stale" && (
                  <span className="reader-translation-note stale">已过期</span>
                )}
                {sectionTranslation?.status === "stale" && (
                  <span className="reader-stale-source">最新原文：{sectionTranslation.source}</span>
                )}
              </Level>
            );
          }
          case "unit":
            return (
              <UnitView
                key={item.blockId}
                item={item}
                onCorrect={language === null ? (unitId) => setCorrectingUnit(unitId) : undefined}
                onNavigate={navigateUnit}
                translation={translatedUnit?.(item.unitId)}
              />
            );
          case "formula":
            return <FormulaView key={item.blockId} item={item} />;
          case "figure":
            return (
              <FigureView
                key={`${state.revisionId}-${item.blockId}-${index}`}
                item={item}
                root={root}
                revisionPath={revisionPath}
                onNavigate={navigateUnit}
                translatedUnit={translatedUnit}
              />
            );
          case "table":
            return (
              <TableView key={item.blockId} item={item} onNavigate={navigateUnit} translatedUnit={translatedUnit} />
            );
          case "raw":
            return (
              <RawView
                key={item.blockId}
                item={item}
                translation={activeTranslation?.rawBlocks?.find((entry) => entry.blockId === item.blockId)}
              />
            );
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
          {toolbar.degraded && (
            <span className="reader-selection-degraded" role="note">
              含不可精确映射内容
            </span>
          )}
          <Button onClick={() => ask("解释")}>解释</Button>
          <Button onClick={() => ask("提问")}>提问</Button>
        </div>
      )}
    </article>
  );
}
