// 翻译视图投影（SPEC-translation §5，paper-30min-crd.2）：
// ready 句显示译文并携带译文逻辑偏移（atom 占一个逻辑位置）；
// gap 句回退当前原文锚点，不包装成译文 range；stale 句保留旧译文并显著标识。
// 本模块进程中立：输入是原文投影＋主进程验证后的翻译投影，不读磁盘、不发请求。
import {
  projectAtom,
  type ReaderAtom,
  type ReaderInlinePart,
  type ReaderItem,
  type ReaderSentence,
  type ReaderUnitContent,
} from "./projection.js";
import type {
  TranslationAtomSnapshot,
  TranslationProjection,
  TranslationSentenceStatus,
  TranslationUnitProjection,
} from "../translation/contracts.js";

export interface TranslationSentenceView {
  sentenceId: string;
  unitId: string;
  status: TranslationSentenceStatus;
  /** ready/stale 为译文片段（含逻辑偏移）；gap 为当前原文片段（原文锚点）。 */
  parts: ReaderInlinePart[];
  staleReason?: "source-changed";
  /** stale 句的最新原文片段（原文锚点）：旧译文可对照最新原文；ready/gap 不携带。 */
  sourceParts?: ReaderInlinePart[];
}

export interface TranslationUnitView {
  unitId: string;
  unitKind: ReaderUnitContent["unitKind"];
  sentences: TranslationSentenceView[];
}

/** 把译文内容投影为带逻辑偏移的片段：text 计 UTF-16 长度，atom 占一个位置。
 * ready 复用当前原文树 atom（内容指纹一致）；stale 只从提交时旧 atom 快照重建
 * （快照缺省的旧格式回退当前树，仅适用于未变 atom），当前树 atom 已改/已删不影响展示。 */
function translatedParts(
  content: NonNullable<TranslationUnitProjection["sentences"][number]["content"]>,
  source: ReaderSentence,
  snapshots?: readonly TranslationAtomSnapshot[],
): ReaderInlinePart[] {
  const atoms = new Map<string, ReaderAtom>(
    snapshots
      ? snapshots.map((atom) => [atom.id, projectAtom(atom)] as const)
      : source.parts.flatMap((part) => (part.kind === "atom" ? [[part.atom.id, part.atom] as const] : [])),
  );
  let cursor = 0;
  return content.map((part) => {
    if (part.kind === "text") {
      const start = cursor;
      cursor += part.text.length;
      return { kind: "text", text: part.text, start, end: cursor };
    }
    const atom = atoms.get(part.atomId);
    if (!atom) throw new Error(`译文 atom 缺少可用快照或原文结构：${part.atomId}。`);
    const start = cursor;
    cursor += 1;
    return { kind: "atom", atom, start, end: cursor };
  });
}

/** 按原文单元构建语言视图：句子顺序与 ID 始终以原文为权威。
 * 未提交单元的全部句子为 gap；已提交单元中新增句为 gap、内容变化句为 stale。 */
export function buildTranslationUnitViews(
  units: readonly ReaderUnitContent[],
  projection: TranslationProjection,
): TranslationUnitView[] {
  const translated = new Map(projection.units.map((unit) => [unit.unitId, unit]));
  return units.map((unit) => {
    const stored = translated.get(unit.unitId);
    const sentences = new Map(stored?.sentences.map((sentence) => [sentence.sentenceId, sentence]) ?? []);
    return {
      unitId: unit.unitId,
      unitKind: unit.unitKind,
      sentences: unit.sentences.map((source) => {
        const sentence = sentences.get(source.sentenceId);
        if (!sentence || sentence.status === "gap" || sentence.content === null)
          return { sentenceId: source.sentenceId, unitId: unit.unitId, status: "gap" as const, parts: source.parts };
        return {
          sentenceId: source.sentenceId,
          unitId: unit.unitId,
          status: sentence.status,
          parts: translatedParts(sentence.content, source, sentence.status === "stale" ? sentence.atoms : undefined),
          ...(sentence.status === "stale" ? { staleReason: "source-changed" as const, sourceParts: source.parts } : {}),
        };
      }),
    };
  });
}

/** 投影内全部可读单元（正文、图注、表格 caption 与单元），按阅读顺序去重。 */
export function readerProjectionUnits(projection: { items: readonly ReaderItem[] }): ReaderUnitContent[] {
  const units: ReaderUnitContent[] = [];
  const seen = new Set<string>();
  const push = (unit: ReaderUnitContent | null) => {
    if (!unit || seen.has(unit.unitId)) return;
    seen.add(unit.unitId);
    units.push(unit);
  };
  for (const item of projection.items) {
    if (item.kind === "unit") push(item);
    else if (item.kind === "figure") push(item.caption);
    else if (item.kind === "table") {
      push(item.caption);
      for (const row of item.rows) for (const cell of row) push(item.cells[cell.unitId]);
    }
  }
  return units;
}
