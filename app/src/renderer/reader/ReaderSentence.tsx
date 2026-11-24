// 句级正文渲染（SPEC-reader §2 / SPEC-translation §5）：原文、译文 ready/gap/stale
// 与 atom 的展示组件。纯展示：投影与选区权威在 FullReader／shared 投影层。
import { createContext, useContext, useState } from "react";
import katex from "katex";
import type { ReaderAtom, ReaderInlinePart, ReaderSentence, ReaderUnitContent } from "../../shared/reader/projection";
import type { TranslationSentenceView, TranslationUnitView } from "../../shared/reader/translation-view";

const desktop = window.desktop;

/** stale 对照区展开态：按 sentenceId 存续于 FullReader 的 ref，跨阅读器重挂载保留。
 * 未提供（独立渲染）时退化为句内本地状态。 */
export interface StaleExpansionStore {
  has: (sentenceId: string) => boolean;
  toggle: (sentenceId: string) => void;
}

const StaleExpansionContext = createContext<StaleExpansionStore | null>(null);

/** 单元正文：句子携带稳定 ID；文本片段按逻辑顺序渲染，atom 独立锚定。
 * 语言视图按句替换为译文片段；gap 句保留原文锚点，stale 句显著标识。 */
export function UnitBody({
  unit,
  onNavigate,
  translation,
}: {
  unit: ReaderUnitContent;
  onNavigate: (unitId: string) => void;
  translation?: TranslationUnitView;
}) {
  const translated = new Map(translation?.sentences.map((sentence) => [sentence.sentenceId, sentence]) ?? []);
  return (
    <>
      {unit.sentences.map((sentence) => (
        <SentenceBody
          key={sentence.sentenceId}
          sentence={sentence}
          onNavigate={onNavigate}
          translation={translated.get(sentence.sentenceId)}
        />
      ))}
    </>
  );
}

export const StaleExpansionProvider = StaleExpansionContext.Provider;

function SentenceBody({
  sentence,
  onNavigate,
  translation,
}: {
  sentence: ReaderSentence;
  onNavigate: (unitId: string) => void;
  translation?: TranslationSentenceView;
}) {
  const status = translation?.status ?? "ready";
  const parts = translation && translation.status !== "gap" ? translation.parts : sentence.parts;
  // stale 对照：旧译文显著标识，最新原文可展开查看（原文锚点，不冒充译文）。
  // 展开态优先走 FullReader 提供的持久 store：project:changed 引发的全量重挂载
  // 不得静默收起用户展开的对照区（paper-30min-70v）。
  const expansion = useContext(StaleExpansionContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  const showSource = expansion ? expansion.has(sentence.sentenceId) : localExpanded;
  const renderParts = (value: ReaderInlinePart[]) =>
    value.map((part, index) =>
      part.kind === "text" ? (
        <span key={index} data-start={part.start} data-end={part.end}>
          {part.text}
        </span>
      ) : (
        <AtomView key={part.atom.id} atom={part.atom} start={part.start} end={part.end} onNavigate={onNavigate} />
      ),
    );
  return (
    <span
      data-sentence-id={sentence.sentenceId}
      data-translation-status={translation ? status : undefined}
      className={status === "stale" ? "reader-sentence-stale" : undefined}
    >
      {renderParts(parts)}
      {translation?.status === "gap" && (
        <span className="reader-translation-note" role="note">
          未翻译
        </span>
      )}
      {translation?.status === "stale" && (
        <>
          <span
            className="reader-translation-note stale"
            role="note"
            title="原句已修改，显示的是旧译文；可查看最新原文。"
          >
            已过期
          </span>
          {translation.sourceParts && (
            <button
              type="button"
              className="reader-stale-source-toggle"
              aria-expanded={showSource}
              onClick={() => (expansion ? expansion.toggle(sentence.sentenceId) : setLocalExpanded((value) => !value))}
            >
              {showSource ? "收起原文" : "查看最新原文"}
            </button>
          )}
          {showSource && translation.sourceParts && (
            <span className="reader-stale-source" data-stale-source={sentence.sentenceId}>
              {renderParts(translation.sourceParts)}
            </span>
          )}
        </>
      )}
    </span>
  );
}

function AtomView({
  atom,
  start,
  end,
  onNavigate,
}: {
  atom: ReaderAtom;
  start: number;
  end: number;
  onNavigate: (unitId: string) => void;
}) {
  const jump = (targetUnitId: string) => {
    if (!document.querySelector(`[data-unit-id="${targetUnitId}"]`)) return;
    onNavigate(targetUnitId);
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
            <span className="reader-warning" role="note">
              公式渲染失败，保留来源。
            </span>
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
    return (
      <span className="reader-atom" data-atom-id={atom.id} data-start={start} data-end={end}>
        {atom.text}
      </span>
    );
  }
  if (atom.kind === "link") {
    if (atom.href === null) {
      return (
        <span className="reader-atom reader-link-disabled" data-atom-id={atom.id} data-start={start} data-end={end}>
          {atom.text}
          <span className="reader-warning" role="note">
            {atom.warning}
          </span>
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
      <span className="reader-warning" role="note">
        {atom.warning}
      </span>
    </span>
  );
}
