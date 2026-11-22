// 译文精确选区（SPEC-translation §5.4/§10，paper-30min-crd.4）：
// 语言视图选区只覆盖 ready/stale 译文片段（译文逻辑偏移，atom 占一位）；
// gap 句保留在读取顺序中但不进入可选句子集——原文锚点不冒充译文 range，
// 跨 gap 的选区不产出伪连续 ranges。quote 口径与原文 createRangeAnchor 一致
// （UTF-16 逻辑位、atom 展开权威文本、32 位前后文），供重基校验复用。
import type { ReaderProjection } from "./projection.js";
import type { SelectionIndex, SentenceInfo } from "./selection.js";
import type { TranslationSentenceView, TranslationUnitView } from "./translation-view.js";
import type { TranslationProjection } from "../translation/contracts.js";

interface TranslationSentenceInfo extends SentenceInfo {
  status: "ready" | "stale";
  sentence: TranslationSentenceView;
  /** 提交时原句内容摘要（stale 为旧原句摘要）；用于区分源变化与译文重译。 */
  sourceSha256?: string;
}

/** 结构上兼容 SelectionIndex：mapDomSelection 直接复用同一映射规则。 */
export interface TranslationSelectionIndex {
  sentences: Map<string, TranslationSentenceInfo>;
  blocks: SelectionIndex["blocks"];
  order: Map<string, number>;
  /** 构建时投影的原 revision；跨 revision 比较时源摘要变化即 stale。 */
  baseRevision?: string;
}

type SelectionRange = { unitId: string; sentenceId: string; start: number; end: number };

const quoteContextLength = 32;

/** 按语言视图构建译文选区索引。projection 提供块结构（公式/图片等无 unit
 * 块的降级判定与原文一致）；省略时只做句内与同视图跨句映射。
 * translation 提供逐句源摘要与 baseRevision，供跨 revision 的 stale 判定。 */
export function buildTranslationSelectionIndex(
  views: readonly TranslationUnitView[],
  projection?: ReaderProjection,
  translation?: TranslationProjection,
): TranslationSelectionIndex {
  const digests = new Map(
    (translation?.units ?? []).flatMap((unit) =>
      unit.sentences.flatMap((sentence) =>
        sentence.sourceSha256 !== null ? [[sentence.sentenceId, sentence.sourceSha256] as const] : [],
      ),
    ),
  );
  const index: TranslationSelectionIndex = {
    sentences: new Map(),
    blocks: new Map(),
    order: new Map(),
    ...(translation ? { baseRevision: translation.baseRevision } : {}),
  };
  for (const view of views) {
    for (const sentence of view.sentences) {
      index.order.set(sentence.sentenceId, index.order.size);
      if (sentence.status === "gap") continue;
      let length = 0;
      const textParts: Array<{ start: number; end: number }> = [];
      for (const part of sentence.parts) {
        if (part.kind === "text") textParts.push({ start: part.start, end: part.end });
        length = part.end;
      }
      index.sentences.set(sentence.sentenceId, {
        unitId: view.unitId,
        length,
        textParts,
        status: sentence.status,
        sentence,
        ...(digests.has(sentence.sentenceId) ? { sourceSha256: digests.get(sentence.sentenceId) } : {}),
      });
    }
  }
  if (projection) {
    for (const item of projection.items) {
      const sentenceIds: string[] = [];
      const collect = (unit: { sentences: Array<{ sentenceId: string }> } | null) => {
        if (unit) sentenceIds.push(...unit.sentences.map((sentence) => sentence.sentenceId));
      };
      if (item.kind === "unit") collect(item);
      else if (item.kind === "figure") collect(item.caption);
      else if (item.kind === "table") {
        collect(item.caption);
        for (const row of item.rows) for (const cell of row) collect(item.cells[cell.unitId]);
      }
      index.blocks.set(item.blockId, { blockId: item.blockId, sentenceIds });
    }
  }
  return index;
}

function logicalSlice(sentence: TranslationSentenceView, start: number, end: number): string {
  let text = "";
  for (const part of sentence.parts) {
    if (part.start >= end) break;
    if (part.kind === "text") {
      if (start < part.end && end > part.start)
        text += part.text.slice(Math.max(0, start - part.start), Math.min(part.text.length, end - part.start));
    } else if (start <= part.start && part.start < end) {
      text += part.atom.text;
    }
  }
  return text;
}

function invalid(message: string): never {
  throw new Error(`译文选区无效：${message}`);
}

/** 译文 quote 快照：校验父子关系与逻辑边界后截取文本与前后文。
 * 越界/空 range/不在可选集显式拒绝，不静默截断或近似。 */
export function translationQuote(
  index: TranslationSelectionIndex,
  ranges: readonly SelectionRange[],
): { text: string; before: string; after: string } {
  if (ranges.length === 0) invalid("至少需要一个 range。");
  let previousOrder = -1;
  for (const range of ranges) {
    const info = index.sentences.get(range.sentenceId) ?? invalid(`句子不在译文选区集：${range.sentenceId}。`);
    if (info.unitId !== range.unitId) invalid("选区句子的父子关系不一致。");
    if (range.start >= range.end || range.end > info.length) invalid(`选区偏移超出句子逻辑边界：${range.sentenceId}。`);
    const order = index.order.get(range.sentenceId)!;
    if (order <= previousOrder) invalid("多个选区必须按阅读顺序排列，且每句至多一个范围。");
    previousOrder = order;
  }
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const firstInfo = index.sentences.get(first.sentenceId)!;
  const lastInfo = index.sentences.get(last.sentenceId)!;
  return {
    text: ranges
      .map((range) => logicalSlice(index.sentences.get(range.sentenceId)!.sentence, range.start, range.end))
      .join("\n"),
    before: logicalSlice(firstInfo.sentence, Math.max(0, first.start - quoteContextLength), first.start),
    after: logicalSlice(lastInfo.sentence, last.end, Math.min(lastInfo.length, last.end + quoteContextLength)),
  };
}

/** 已保存译文选区（annotations-results 视图锚点的最小输入）。 */
export interface SavedTranslationSelection {
  /** 创建时的 translationRevision：只作 provenance，不参与失效判定。 */
  translationRevision: string | null;
  ranges: readonly SelectionRange[];
  quote: { text: string; before: string; after: string };
  /** 创建时投影身份与逐句源摘要（可选，来自创建时索引）：
   * 跨原文 revision 时源摘要变化即 stale，即使旧译文文本未变。 */
  baseRevision?: string;
  sourceDigests?: Readonly<Record<string, string>>;
}

export type TranslationSelectionState =
  | { status: "active"; translationRevision: string | null; quote: SavedTranslationSelection["quote"] }
  | {
      status: "stale" | "translation-changed" | "removed";
      /** 失效/过期时保留旧 quote，供对照与人工恢复；不静默重挂。 */
      quote: SavedTranslationSelection["quote"];
    };

/** translationRevision 重基（SPEC-translation §10）：只按实际 sentenceId、
 * range 与 quote 判定，不比较版本字符串。有效性以每个保存 range 的实际
 * selected text 为单位：未相交 range 的文本不变即继续精确有效（§10.4），
 * 32 位前后文只是创建时 provenance，不反向扩大失效。全部匹配→重基到
 * 当前值并刷新 quote 上下文；原句 stale→按 stale 处理；句子退出译文投影
 * →removed；任一相交 range 文本失配→translation-changed（整组保留旧
 * quote；range 级部分保留属 annotations-results 持久化契约，Phase 6 承接）。 */
export function classifyTranslationSelection(
  index: TranslationSelectionIndex,
  currentTranslationRevision: string | null,
  saved: SavedTranslationSelection,
): TranslationSelectionState {
  const infos = saved.ranges.map((range) => {
    const info = index.sentences.get(range.sentenceId);
    if (!info || info.unitId !== range.unitId || range.start >= range.end || range.end > info.length) return null;
    return info;
  });
  if (infos.some((info) => info === null)) return { status: "removed", quote: saved.quote };
  if (infos.some((info) => info!.status === "stale")) return { status: "stale", quote: saved.quote };
  // 跨原文 revision：任一相关句的源摘要变化即 stale（§10.5），不依赖译文文本是否变化。
  if (
    saved.baseRevision !== undefined &&
    index.baseRevision !== undefined &&
    saved.baseRevision !== index.baseRevision &&
    saved.sourceDigests &&
    infos.some((info) => {
      const savedDigest = saved.sourceDigests![info!.sentence.sentenceId];
      return savedDigest !== undefined && info!.sourceSha256 !== undefined && savedDigest !== info!.sourceSha256;
    })
  )
    return { status: "stale", quote: saved.quote };
  const savedTexts = saved.quote.text.split("\n");
  if (savedTexts.length !== saved.ranges.length) return { status: "translation-changed", quote: saved.quote };
  const currentTexts = saved.ranges.map((range) =>
    logicalSlice(index.sentences.get(range.sentenceId)!.sentence, range.start, range.end),
  );
  if (currentTexts.some((text, index_) => text !== savedTexts[index_]))
    return { status: "translation-changed", quote: saved.quote };
  let quote: SavedTranslationSelection["quote"];
  try {
    quote = translationQuote(index, saved.ranges);
  } catch {
    return { status: "removed", quote: saved.quote };
  }
  return { status: "active", translationRevision: currentTranslationRevision, quote };
}
