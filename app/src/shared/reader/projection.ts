// Full 阅读投影（SPEC-reader §1–2，paper-30min-qa3.1）：
// current 文档树是唯一输入；按 blocks 真实顺序输出全部可读内容，
// 每个片段携带稳定 ID 与 UTF-16 逻辑偏移（atom 占一个逻辑位置）。
// 本模块进程中立：不渲染 DOM、不发请求；KaTeX/DOM 由 renderer 承担。
import type { DocumentTree } from "../document/tree.js";

type Atom = DocumentTree["atoms"][string];
type AssetReference = Extract<DocumentTree["blocks"][number], { kind: "figure" }>["asset"];

/** 投影后的 atom：在树原子之上补充可点击性与降级警告。
 * link 的 href 经协议校验：危险协议为 null（渲染为纯文本）。 */
export type ReaderAtom =
  | (Omit<Extract<Atom, { kind: "link" }>, "href"> & { href: string | null; warning?: string })
  | (Exclude<Atom, { kind: "link" }> & { warning?: string });

export type ReaderInlinePart =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "atom"; atom: ReaderAtom; start: number; end: number };

export interface ReaderSentence {
  sentenceId: string;
  unitId: string;
  parts: ReaderInlinePart[];
}

export interface ReaderUnitContent {
  unitId: string;
  unitKind: DocumentTree["units"][string]["kind"];
  sentences: ReaderSentence[];
}

interface ReaderItemBase {
  blockId: string;
  sectionId: string;
}

export type ReaderItem =
  | (ReaderItemBase & { kind: "section"; sectionId: string; title: string; depth: number })
  | (ReaderItemBase & ReaderUnitContent & { kind: "unit" })
  | (ReaderItemBase & {
      kind: "formula";
      source: { format: "latex" | "mathml" | "text"; value: string };
      text: string;
      asset?: AssetReference;
    })
  | (ReaderItemBase & {
      kind: "figure";
      asset: AssetReference;
      captionUnitId: string | null;
      caption: ReaderUnitContent | null;
      warning?: string;
    })
  | (ReaderItemBase & {
      kind: "table";
      captionUnitId: string | null;
      caption: ReaderUnitContent | null;
      rows: Array<Array<{ unitId: string; rowSpan: number; columnSpan: number }>>;
      cells: Record<string, ReaderUnitContent>;
    })
  | (ReaderItemBase & {
      kind: "raw";
      html: string;
      text: string;
      limitations: string[];
    });

export interface ReaderProjection {
  paperId: string;
  items: ReaderItem[];
}

const safeLinkProtocols: Record<string, true> = { "https:": true, "http:": true, "mailto:": true };

export function projectAtom(atom: Atom): ReaderAtom {
  if (atom.kind === "link") {
    let protocol: string | null = null;
    try {
      protocol = new URL(atom.href).protocol;
    } catch {
      protocol = null;
    }
    if (protocol !== null && safeLinkProtocols[protocol]) return { ...atom, href: atom.href };
    return { ...atom, href: null, warning: "链接协议不受支持，已按纯文本显示。" };
  }
  if ((atom.kind === "cross-reference" || atom.kind === "citation") && atom.targetUnitId === null) {
    const source = atom.kind === "cross-reference" ? atom.sourceTarget : undefined;
    return {
      ...atom,
      warning: `来源目标未解析${source ? `：${source}` : ""}，保留显示文本。`,
    };
  }
  return atom;
}

function projectUnit(tree: DocumentTree, unitId: string): ReaderUnitContent {
  const unit = tree.units[unitId];
  if (!unit) throw new Error(`阅读投影单元不存在：${unitId}。`);
  return {
    unitId,
    unitKind: unit.kind,
    sentences: unit.sentenceIds.map((sentenceId) => {
      const sentence = tree.sentences[sentenceId];
      if (!sentence) throw new Error(`阅读投影句子不存在：${sentenceId}。`);
      let cursor = 0;
      const parts: ReaderInlinePart[] = sentence.content.map((part) => {
        if (part.kind === "text") {
          const start = cursor;
          cursor += part.text.length;
          return { kind: "text", text: part.text, start, end: cursor };
        }
        const atom = tree.atoms[part.atomId];
        if (!atom) throw new Error(`阅读投影原子不存在：${part.atomId}。`);
        const start = cursor;
        cursor += 1;
        return { kind: "atom", atom: projectAtom(atom), start, end: cursor };
      });
      return { sentenceId, unitId, parts };
    }),
  };
}

/** 按 blocks 真实顺序构建 Full 投影；章节标题在其首个内容块前输出一次。
 * 不按模型层级或论证角色隐藏任何块；异步/渲染层不得以下标代替这些 ID。 */
export function buildReaderProjection(tree: DocumentTree): ReaderProjection {
  const items: ReaderItem[] = [];
  const emittedSections = new Set<string>();
  const sectionChain = (sectionId: string): string[] => {
    const chain: string[] = [];
    let cursor: string | undefined = sectionId;
    while (cursor) {
      chain.unshift(cursor);
      cursor = tree.sections[cursor]?.parentSectionId ?? undefined;
    }
    return chain;
  };
  for (const block of tree.blocks) {
    for (const [index, sectionId] of sectionChain(block.sectionId).entries()) {
      if (emittedSections.has(sectionId)) continue;
      emittedSections.add(sectionId);
      const section = tree.sections[sectionId];
      items.push({
        kind: "section",
        blockId: block.id,
        sectionId,
        title: section.title,
        depth: index + 1,
      });
    }
    const base = { blockId: block.id, sectionId: block.sectionId };
    switch (block.kind) {
      case "unit":
        items.push({ ...base, ...projectUnit(tree, block.unitId), kind: "unit" });
        break;
      case "formula":
        items.push({
          ...base,
          kind: "formula",
          source: block.source,
          text: block.text,
          ...(block.asset ? { asset: block.asset } : {}),
        });
        break;
      case "figure":
        items.push({
          ...base,
          kind: "figure",
          asset: block.asset,
          captionUnitId: block.captionUnitId,
          caption: block.captionUnitId ? projectUnit(tree, block.captionUnitId) : null,
          ...(block.warning ? { warning: block.warning } : {}),
        });
        break;
      case "table": {
        const cells: Record<string, ReaderUnitContent> = {};
        for (const cell of block.rows.flat()) cells[cell.unitId] = projectUnit(tree, cell.unitId);
        items.push({
          ...base,
          kind: "table",
          captionUnitId: block.captionUnitId,
          caption: block.captionUnitId ? projectUnit(tree, block.captionUnitId) : null,
          rows: block.rows,
          cells,
        });
        break;
      }
      case "raw":
        items.push({
          ...base,
          kind: "raw",
          html: block.html,
          text: block.text,
          limitations: block.limitations,
        });
        break;
    }
  }
  return { paperId: tree.paperId, items };
}
