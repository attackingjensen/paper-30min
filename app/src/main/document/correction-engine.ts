// document-core 结构化修正引擎（SPEC-document-core §6，SPEC-reader §8，
// paper-30min-qa3.4）。修正在 staging 副本上应用：已发布树永不原地修改；
// 普通文字修正保留节点 ID，拆分/合并/删除按保守规则退役旧 ID 并建立 tombstone。
// 预览与发布共用同一引擎，发布前按真实 current 重放并复核 baseRevision。
// 本模块只在工程进程运行：不读磁盘、不发请求；资产字节由调用方提供。
import { createHash } from "node:crypto";
import {
  appendRemovedTombstones,
  createDocumentChangeset,
  parseDocumentTombstones,
  type Tombstone,
} from "../../shared/document/changeset.js";
import {
  atomPlaceholderToken,
  parseDocumentCorrection,
  unitEditText,
  unitLogicalText,
  type DocumentCorrection,
} from "../../shared/document/correction.js";
import { parseDocumentTree, type DocumentTree } from "../../shared/document/tree.js";

type InlinePart = DocumentTree["sentences"][string]["content"][number];
type Block = DocumentTree["blocks"][number];

export interface CorrectionResult {
  document: DocumentTree;
  changeset: ReturnType<typeof createDocumentChangeset>;
  tombstones: Tombstone[];
  /** 本次修正新增的资产（内容寻址）；既有引用资产由发布路径按登记读取。 */
  assets: Record<string, { bytes: Uint8Array; mime: string }>;
}

function invalid(message: string): never {
  throw new Error(`修正无效：${message}`);
}

/** 新节点身份按修正会话（revisionId）＋目标＋序号确定性派生：
 * 同一 revisionId 重放同一命令序列产生逐字节一致的树（预览即发布内容）。
 * 派生 ID 只属于本次修正会话，不复用任何退役 ID。 */
function correctionIdentity(seed: string): string {
  const identity = createHash("sha256").update(seed).digest("hex");
  return `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(12, 15)}-8${identity.slice(15, 18)}-${identity.slice(18, 30)}`;
}

/** 确定句切分（与导入分段同一规则形状）：英文终止符后随空白或结尾，
 * 中文终止符直接断句；atom 受保护不参与断句。修正时计算并持久化，重开不重跑。 */
function splitSentences(parts: InlinePart[]): InlinePart[][] {
  const sentences: InlinePart[][] = [];
  let current: InlinePart[] = [];
  const flush = () => {
    const merged: InlinePart[] = [];
    for (const part of current) {
      const last = merged.at(-1);
      if (part.kind === "text" && last?.kind === "text") last.text += part.text;
      else merged.push(part.kind === "text" ? { ...part } : part);
    }
    if (merged.some((part) => part.kind === "atom" || part.text.trim())) sentences.push(merged);
    current = [];
  };
  for (const part of parts) {
    if (part.kind === "atom") {
      current.push(part);
      continue;
    }
    let rest = part.text;
    for (;;) {
      const match = /[.!?](?=\s|$)|[。！？]/.exec(rest);
      if (!match) {
        if (rest) current.push({ kind: "text", text: rest });
        break;
      }
      const end = match.index + match[0].length;
      current.push({ kind: "text", text: rest.slice(0, end) });
      flush();
      rest = rest.slice(end).replace(/^\s+/, "");
    }
  }
  flush();
  return sentences;
}

/** 单元内 atom 按阅读顺序展开；文字修正必须原样保留全部 atom 及顺序。 */
function unitAtoms(tree: DocumentTree, unitId: string): string[] {
  const unit = tree.units[unitId];
  return unit.sentenceIds.flatMap((sentenceId) =>
    tree.sentences[sentenceId].content.flatMap((part) =>
      part.kind === "atom" ? [part.atomId] : []));
}

/** 单元可编辑投影与占位令牌由共享契约提供（unitEditText/atomPlaceholderToken）。 */

/** 把新文本与受保护 atom 序列重建为句子内容：按占位令牌定位 atom，
 * 令牌之间的文字原样保留；不猜测插入位置，不接受裸显示文本冒充占位。 */
function rebuildParts(
  tree: DocumentTree,
  atomIds: string[],
  text: string,
): InlinePart[] {
  const parts: InlinePart[] = [];
  let cursor = 0;
  for (const atomId of atomIds) {
    const token = atomPlaceholderToken(atomId);
    const index = text.indexOf(token, cursor);
    if (index < 0) invalid(`修正文本必须按原顺序保留原子占位 ${token}。`);
    if (text.indexOf(token, index + token.length) >= 0)
      invalid(`原子占位 ${token} 重复出现，无法确定唯一位置。`);
    if (index > cursor) parts.push({ kind: "text", text: text.slice(cursor, index) });
    parts.push({ kind: "atom", atomId });
    cursor = index + token.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  if (!parts.length) invalid("修正后的单元不能为空。");
  return parts;
}

/** 普通文字修正的保边界路径：按原句边界把新文本切回各句，逐句重建内容。
 * 句数与每句 atom 分布不变时保留全部句子 ID（内容变化记 changed）；
 * 用户真实增删句子终止符或移动 atom 时返回 false，交由重切分保守处理。 */
function trySentencePreservingEdit(
  tree: DocumentTree,
  unitId: string,
  text: string,
): boolean {
  const unit = tree.units[unitId];
  const atomIds = unitAtoms(tree, unitId);
  // 校验全部 atom 令牌按原顺序恰好出现一次。
  let cursor = 0;
  for (const atomId of atomIds) {
    const token = atomPlaceholderToken(atomId);
    const at = text.indexOf(token, cursor);
    if (at < 0) return false;
    if (text.indexOf(token, at + token.length) >= 0) return false;
    cursor = at + token.length;
  }
  // 按原句投影定位每句在新文本中的范围：句间以单个空格连接（投影口径）。
  // 每句的 atom 令牌序列是锚；句文本＝首 atom 前文字＋atom 间文字＋末 atom 后文字。
  const ranges: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  for (const [index, sentenceId] of unit.sentenceIds.entries()) {
    const sentence = tree.sentences[sentenceId];
    const sentenceAtoms = sentence.content.flatMap((part) => part.kind === "atom" ? [part.atomId] : []);
    const start = searchFrom;
    let end = text.length;
    if (index < unit.sentenceIds.length - 1) {
      // 下一句的首个 atom 令牌（或本句末终止符）界定本句结尾；end 不含连接空格。
      const nextSentence = tree.sentences[unit.sentenceIds[index + 1]];
      const nextFirstAtom = nextSentence.content.find((part) => part.kind === "atom");
      if (nextFirstAtom && nextFirstAtom.kind === "atom") {
        const nextTokenAt = text.indexOf(atomPlaceholderToken(nextFirstAtom.atomId), searchFrom);
        if (nextTokenAt < 0 || text[nextTokenAt - 1] !== " ") return false;
        end = nextTokenAt - 1;
      } else {
        const tail = text.slice(searchFrom);
        // 本句末终止符＝下一句首文字之前的最后一个「终止符＋空白」。
        // 下一句无 atom 时以其原投影首段定位边界，避免吞掉下一句的终止符。
        const nextProjection = nextSentence.content.map((part) =>
          part.kind === "text" ? part.text : atomPlaceholderToken(part.atomId)).join("");
        const nextStart = tail.indexOf(nextProjection.slice(0, Math.min(12, nextProjection.length)));
        const scope = nextStart >= 0 ? tail.slice(0, nextStart) : tail;
        const matches = [...scope.matchAll(/[.!?](?=\s)|[。！？](?=\s|$)/g)];
        const last = matches.at(-1);
        if (!last || last.index === undefined) return false;
        end = searchFrom + last.index + last[0].length;
      }
      if (text[end] !== " ") return false;
    }
    // 校验本句范围内 atom 令牌序列与原句一致（end 含句间连接空格）。
    const slice = text.slice(start, end);
    let localCursor = 0;
    for (const atomId of sentenceAtoms) {
      const token = atomPlaceholderToken(atomId);
      const at = slice.indexOf(token, localCursor);
      if (at < 0) return false;
      localCursor = at + token.length;
    }
    ranges.push({ start, end });
    // 下一句从连接空格之后开始；末句 end 即文本末尾。
    searchFrom = index < unit.sentenceIds.length - 1 ? end + 1 : end;
  }
  if (searchFrom > text.length) return false;
  // 逐句重建内容并校验终止符数量不变。
  const terminatorCount = (value: string) =>
    (value.match(/[.!?](?=\s|$)|[。！？]/g) ?? []).length;
  for (const [index, sentenceId] of unit.sentenceIds.entries()) {
    const sentence = tree.sentences[sentenceId];
    const { start, end } = ranges[index];
    const slice = text.slice(start, end);
    const parts = rebuildParts(tree, sentence.content.flatMap((part) => part.kind === "atom" ? [part.atomId] : []), slice);
    const newText = parts.map((part) => part.kind === "text" ? part.text : "").join("");
    const oldText = sentence.content.map((part) => part.kind === "text" ? part.text : "").join("");
    const normalizedNew = index < unit.sentenceIds.length - 1 ? `${newText} ` : newText;
    if (terminatorCount(normalizedNew) !== terminatorCount(oldText)) return false;
    tree.sentences[sentenceId] = { ...sentence, content: parts };
  }
  return true;
}

function replaceUnitSentences(
  tree: DocumentTree,
  unitId: string,
  parts: InlinePart[],
  retired: Array<{ nodeType: "unit" | "sentence" | "atom" | "block" | "section"; nodeId: string; reason: Tombstone["reason"] }>,
  nextId: (label: string) => string,
) {
  const unit = tree.units[unitId];
  const sentences = splitSentences(parts);
  if (!sentences.length) invalid("修正后的单元没有可读内容。");
  const oldIds = unit.sentenceIds;
  const atomSentence = (content: InlinePart[]) =>
    content.find((part) => part.kind === "atom")?.atomId ?? null;
  // 含 atom 的句子以 atom 为锚延续原 ID：atom 受保护且顺序不变，普通文字
  // 修正不改变句子边界，内容变化由 changeset 记为 changed，不退役句子锚点。
  const oldByAtom = new Map<string, string>();
  for (const oldId of oldIds) {
    const anchor = atomSentence(tree.sentences[oldId].content);
    if (anchor) oldByAtom.set(anchor, oldId);
  }
  // 第一遍：atom 锚定匹配（与位置无关），先占住对应旧句 ID。
  const assigned = new Map<number, string>();
  const kept = new Set<string>();
  for (const [index, content] of sentences.entries()) {
    const anchor = atomSentence(content);
    const anchored = anchor ? oldByAtom.get(anchor) : undefined;
    if (anchored && !kept.has(anchored)) {
      assigned.set(index, anchored);
      kept.add(anchored);
    }
  }
  // 第二遍：无 atom 的新句按阅读顺序延续剩余无 atom 旧句；句数不变时全部保留。
  const plainOld = oldIds.filter((oldId) => !atomSentence(tree.sentences[oldId].content) && !kept.has(oldId));
  let plainCursor = 0;
  for (const [index, content] of sentences.entries()) {
    if (assigned.has(index) || atomSentence(content)) continue;
    if (plainCursor < plainOld.length) {
      assigned.set(index, plainOld[plainCursor]);
      kept.add(plainOld[plainCursor]);
      plainCursor++;
    }
  }
  const newIds: string[] = [];
  for (const [index, content] of sentences.entries()) {
    const existing = assigned.get(index);
    if (existing) {
      tree.sentences[existing] = { ...tree.sentences[existing], content };
      newIds.push(existing);
      continue;
    }
    const sentenceId = nextId(`sentence:${index}`);
    tree.sentences[sentenceId] = { id: sentenceId, unitId, content };
    newIds.push(sentenceId);
  }
  for (const oldId of oldIds) {
    if (kept.has(oldId)) continue;
    retired.push({ nodeType: "sentence", nodeId: oldId, reason: "split" });
    delete tree.sentences[oldId];
  }
  unit.sentenceIds = newIds;
}

function blockOfUnit(tree: DocumentTree, unitId: string): Block {
  const block = tree.blocks.find((entry) => entry.kind === "unit" && entry.unitId === unitId);
  if (!block) invalid(`单元 ${unitId} 没有独立阅读块，不能执行该结构操作。`);
  return block;
}

function unitBlockIds(tree: DocumentTree, unitId: string): string[] {
  return tree.blocks.filter((block) =>
    block.kind === "unit" ? block.unitId === unitId
      : block.kind === "figure" || block.kind === "table"
        ? (block.captionUnitId === unitId ||
          (block.kind === "table" && block.rows.some((row) => row.some((cell) => cell.unitId === unitId))))
        : false).map((block) => block.id);
}

function removeUnit(tree: DocumentTree, unitId: string, retired: Array<{ nodeType: "unit" | "sentence" | "atom" | "block" | "section"; nodeId: string; reason: Tombstone["reason"] }>) {
  const unit = tree.units[unitId];
  if (!unit) invalid(`修正目标单元不存在：${unitId}。`);
  for (const blockId of unitBlockIds(tree, unitId)) {
    const block = tree.blocks.find((entry) => entry.id === blockId)!;
    if (block.kind === "unit") {
      tree.blocks = tree.blocks.filter((entry) => entry.id !== blockId);
      retired.push({ nodeType: "block", nodeId: blockId, reason: "removed" });
    } else if (block.kind === "figure") {
      block.captionUnitId = null;
    } else if (block.kind === "table") {
      if (block.captionUnitId === unitId) block.captionUnitId = null;
      block.rows = block.rows.map((row) => row.filter((cell) => cell.unitId !== unitId))
        .filter((row) => row.length > 0);
      if (!block.rows.length) {
        tree.blocks = tree.blocks.filter((entry) => entry.id !== blockId);
        retired.push({ nodeType: "block", nodeId: blockId, reason: "removed" });
      }
    }
  }
  for (const sentenceId of unit.sentenceIds) {
    const sentence = tree.sentences[sentenceId];
    for (const part of sentence.content)
      if (part.kind === "atom") {
        retired.push({ nodeType: "atom", nodeId: part.atomId, reason: "removed" });
        delete tree.atoms[part.atomId];
      }
    retired.push({ nodeType: "sentence", nodeId: sentenceId, reason: "removed" });
    delete tree.sentences[sentenceId];
  }
  // 引用该单元的 atom 解除解析目标，保留来源文本（不猜测新目标）。
  for (const atom of Object.values(tree.atoms)) {
    if ((atom.kind === "citation" || atom.kind === "cross-reference") && atom.targetUnitId === unitId) {
      atom.targetUnitId = null;
      if (atom.kind === "cross-reference" && !atom.sourceTarget) atom.sourceTarget = atom.text;
    }
    if (atom.kind === "footnote-reference" && atom.targetUnitId === unitId)
      invalid(`脚注引用 ${atom.id} 指向被删除单元；请先处理引用。`);
  }
  tree.sections[unit.sectionId].unitIds = tree.sections[unit.sectionId].unitIds.filter((id) => id !== unitId);
  retired.push({ nodeType: "unit", nodeId: unitId, reason: "removed" });
  delete tree.units[unitId];
}

/** 删除单元后清理空章节：没有任何阅读块的章节不能保留（树校验要求可读内容）。 */
function pruneEmptySections(tree: DocumentTree, retired: Array<{ nodeType: "unit" | "sentence" | "atom" | "block" | "section"; nodeId: string; reason: Tombstone["reason"] }>) {
  for (;;) {
    const empty = Object.values(tree.sections).filter((section) =>
      !tree.blocks.some((block) => block.sectionId === section.id) &&
      section.childSectionIds.every((childId) => !tree.sections[childId]));
    if (!empty.length) return;
    for (const section of empty) {
      if (section.parentSectionId === null && Object.keys(tree.sections).length === 1)
        invalid("修正不能删除论文的全部可读内容。");
      const parent = section.parentSectionId ? tree.sections[section.parentSectionId] : null;
      if (parent) parent.childSectionIds = parent.childSectionIds.filter((id) => id !== section.id);
      retired.push({ nodeType: "section", nodeId: section.id, reason: "removed" });
      delete tree.sections[section.id];
    }
  }
}

function applyOne(
  tree: DocumentTree,
  edit: DocumentCorrection,
  retired: Array<{ nodeType: "unit" | "sentence" | "atom" | "block" | "section"; nodeId: string; reason: Tombstone["reason"] }>,
  assets: Record<string, { bytes: Uint8Array; mime: string }>,
  sha256: (bytes: Uint8Array) => string,
  nextId: (label: string) => string,
) {
  switch (edit.type) {
    case "unit-text": {
      const unit = tree.units[edit.unitId];
      if (!unit) invalid(`修正目标单元不存在：${edit.unitId}。`);
      if (unitEditText(tree, edit.unitId) !== edit.expected)
        invalid("单元原内容与预期不符：基线可能已变化，请重新读取后再修正。");
      // 优先保边界路径：句内文字修正保留全部句子 ID；真实边界变化才重切分。
      if (!trySentencePreservingEdit(tree, edit.unitId, edit.text))
        replaceUnitSentences(tree, edit.unitId, rebuildParts(tree, unitAtoms(tree, edit.unitId), edit.text), retired, nextId);
      return;
    }
    case "atom": {
      const atom = tree.atoms[edit.atomId];
      if (!atom) invalid(`修正目标原子不存在：${edit.atomId}。`);
      if (JSON.stringify(atom) !== JSON.stringify(edit.expected))
        invalid("原子原内容与预期不符：基线可能已变化，请重新读取后再修正。");
      if (atom.kind !== edit.kind) invalid("改变原子类型必须是显式结构操作，当前不支持。");
      const { type: _type, atomId: _atomId, expected: _expected, ...content } = edit;
      tree.atoms[edit.atomId] = { ...atom, ...content } as typeof atom;
      return;
    }
    case "unit-split": {
      const unit = tree.units[edit.unitId];
      if (!unit) invalid(`修正目标单元不存在：${edit.unitId}。`);
      if (unitEditText(tree, edit.unitId) !== edit.expected)
        invalid("单元原内容与预期不符：基线可能已变化，请重新读取后再修正。");
      const atomIds = unitAtoms(tree, edit.unitId);
      if (atomIds.length > 0) invalid("含原子的单元暂不支持拆分；请先单独修正原子。");
      const block = blockOfUnit(tree, edit.unitId);
      const section = tree.sections[unit.sectionId];
      const position = section.unitIds.indexOf(edit.unitId);
      const blockPosition = tree.blocks.indexOf(block);
      const newUnitIds: string[] = [];
      const newBlocks: Block[] = [];
      for (const [partIndex, part] of edit.parts.entries()) {
        const unitId = nextId(`unit:${partIndex}`);
        const sentenceId = nextId(`sentence:${partIndex}:0`);
        const sentences = splitSentences([{ kind: "text", text: part }]);
        if (!sentences.length) invalid("拆分后的单元没有可读内容。");
        const sentenceIds: string[] = [];
        for (const content of sentences) {
          const id = sentenceIds.length === 0 ? sentenceId : nextId(`sentence:${partIndex}:${sentenceIds.length}`);
          tree.sentences[id] = { id, unitId, content };
          sentenceIds.push(id);
        }
        tree.units[unitId] = { id: unitId, sectionId: unit.sectionId, kind: unit.kind, sentenceIds };
        newUnitIds.push(unitId);
        const blockId = nextId(`block:${partIndex}`);
        newBlocks.push({ id: blockId, sectionId: unit.sectionId, kind: "unit", unitId });
      }
      // 旧结构整体退役（split）：新单元不继承旧身份。
      for (const sentenceId of unit.sentenceIds) {
        retired.push({ nodeType: "sentence", nodeId: sentenceId, reason: "split" });
        delete tree.sentences[sentenceId];
      }
      retired.push({ nodeType: "unit", nodeId: edit.unitId, reason: "split" });
      retired.push({ nodeType: "block", nodeId: block.id, reason: "split" });
      delete tree.units[edit.unitId];
      section.unitIds.splice(position, 1, ...newUnitIds);
      tree.blocks.splice(blockPosition, 1, ...newBlocks);
      return;
    }
    case "unit-merge": {
      const units = edit.unitIds.map((unitId) => {
        const unit = tree.units[unitId];
        if (!unit) invalid(`修正目标单元不存在：${unitId}。`);
        return unit;
      });
      const sectionId = units[0].sectionId;
      if (units.some((unit) => unit.sectionId !== sectionId))
        invalid("只能合并同一章节内的单元。");
      if (units.some((unit) => unitAtoms(tree, unit.id).length > 0))
        invalid("含原子的单元暂不支持合并；请先单独修正原子。");
      const positions = units.map((unit) => tree.sections[sectionId].unitIds.indexOf(unit.id));
      if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1))
        invalid("只能合并阅读顺序相邻的单元。");
      edit.unitIds.forEach((unitId, index) => {
        if (unitEditText(tree, unitId) !== edit.expected[index])
          invalid("单元原内容与预期不符：基线可能已变化，请重新读取后再修正。");
      });
      const kind = units[0].kind;
      if (units.some((unit) => unit.kind !== kind)) invalid("只能合并相同结构类型的单元。");
      const blocks = units.map((unit) => blockOfUnit(tree, unit.id));
      const unitId = nextId("unit:0");
      const text = edit.unitIds.map((id) => unitLogicalText(tree, id)).join(" ");
      const sentences = splitSentences([{ kind: "text", text }]);
      const sentenceIds: string[] = [];
      for (const content of sentences) {
        const id = nextId(`sentence:${sentenceIds.length}`);
        tree.sentences[id] = { id, unitId, content };
        sentenceIds.push(id);
      }
      tree.units[unitId] = { id: unitId, sectionId, kind, sentenceIds };
      const mergedBlockId = nextId("block:0");
      const firstBlockPosition = tree.blocks.indexOf(blocks[0]);
      for (const [index, unit] of units.entries()) {
        for (const sentenceId of unit.sentenceIds) {
          retired.push({ nodeType: "sentence", nodeId: sentenceId, reason: "merged" });
          delete tree.sentences[sentenceId];
        }
        retired.push({ nodeType: "unit", nodeId: unit.id, reason: "merged" });
        retired.push({ nodeType: "block", nodeId: blocks[index].id, reason: "merged" });
        delete tree.units[unit.id];
      }
      tree.sections[sectionId].unitIds.splice(positions[0], units.length, unitId);
      tree.blocks = tree.blocks.filter((block) => !blocks.some((entry) => entry.id === block.id));
      tree.blocks.splice(firstBlockPosition, 0, { id: mergedBlockId, sectionId, kind: "unit", unitId });
      return;
    }
    case "unit-delete": {
      if (unitEditText(tree, edit.unitId) !== edit.expected)
        invalid("单元原内容与预期不符：基线可能已变化，请重新读取后再修正。");
      removeUnit(tree, edit.unitId, retired);
      pruneEmptySections(tree, retired);
      return;
    }
    case "unit-move": {
      const unit = tree.units[edit.unitId];
      if (!unit) invalid(`修正目标单元不存在：${edit.unitId}。`);
      const anchorId = edit.beforeUnitId ?? edit.afterUnitId!;
      const anchor = tree.units[anchorId];
      if (!anchor) invalid(`移动参照单元不存在：${anchorId}。`);
      if (anchorId === edit.unitId) invalid("不能把单元移动到自身位置。");
      const block = blockOfUnit(tree, edit.unitId);
      const anchorBlock = blockOfUnit(tree, anchorId);
      const from = tree.sections[unit.sectionId];
      const to = tree.sections[anchor.sectionId];
      from.unitIds = from.unitIds.filter((id) => id !== edit.unitId);
      const anchorPosition = to.unitIds.indexOf(anchorId);
      to.unitIds.splice(edit.beforeUnitId ? anchorPosition : anchorPosition + 1, 0, edit.unitId);
      unit.sectionId = to.id;
      block.sectionId = to.id;
      tree.blocks = tree.blocks.filter((entry) => entry.id !== block.id);
      const anchorIndex = tree.blocks.indexOf(anchorBlock);
      tree.blocks.splice(edit.beforeUnitId ? anchorIndex : anchorIndex + 1, 0, block);
      pruneEmptySections(tree, retired);
      return;
    }
    case "figure-asset": {
      const block = tree.blocks.find((entry) => entry.id === edit.blockId);
      if (!block || block.kind !== "figure") invalid(`资产替换目标不是图片块：${edit.blockId}。`);
      const hash = sha256(edit.bytes);
      const extension = edit.mime === "image/png" ? "png"
        : edit.mime === "image/jpeg" ? "jpg"
        : edit.mime === "image/svg+xml" ? "svg"
        : edit.mime === "image/webp" ? "webp"
        : edit.mime === "image/gif" ? "gif"
        : edit.mime === "image/avif" ? "avif"
        : invalid(`不支持的资产 MIME：${edit.mime}。`);
      const path = `assets/${hash}.${extension}`;
      assets[path] = { bytes: edit.bytes, mime: edit.mime };
      block.asset = { path, sha256: hash, mime: edit.mime };
      delete block.warning;
      return;
    }
    case "raw-text": {
      const block = tree.blocks.find((entry) => entry.id === edit.blockId);
      if (!block || block.kind !== "raw") invalid(`文本修正目标不是 raw block：${edit.blockId}。`);
      if (block.text !== edit.expected)
        invalid("raw block 原内容与预期不符：基线可能已变化，请重新读取后再修正。");
      // 受控文本投影：只允许替换可读文本，HTML 结构按纯文本段落重建，不接受任意源码。
      block.text = edit.text;
      block.html = `<p>${edit.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
      return;
    }
  }
}

/** 应用结构化修正序列，返回 staging 树、changeset 与 tombstones。
 * 输入树不被修改；任何一步失败整体拒绝，不产生半修正状态。 */
export function applyDocumentCorrections(input: {
  base: DocumentTree;
  baseRevision: string;
  revisionId: string;
  previousTombstones?: Tombstone[];
  corrections: unknown[];
}): CorrectionResult {
  const tree = parseDocumentTree(structuredClone(input.base));
  const edits = input.corrections.map(parseDocumentCorrection);
  if (!edits.length) invalid("修正请求不能为空。");
  const retired: Array<{ nodeType: "unit" | "sentence" | "atom" | "block" | "section"; nodeId: string; reason: Tombstone["reason"] }> = [];
  const assets: Record<string, { bytes: Uint8Array; mime: string }> = {};
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  for (const [index, edit] of edits.entries()) {
    const nextId = (label: string) => correctionIdentity(`correction:${input.revisionId}:${index}:${label}`);
    applyOne(tree, edit, retired, assets, sha256, nextId);
  }
  const document = parseDocumentTree(tree);
  const changeset = createDocumentChangeset({
    base: input.base,
    current: document,
    baseRevision: input.baseRevision,
    revisionId: input.revisionId,
  });
  // 保守退役：split/merged 由操作显式登记；removed 由 changeset 推导。
  // 同一节点只保留一条 tombstone，显式结构原因优先于笼统 removed。
  const explicit: Tombstone[] = retired
    .filter((entry) => entry.reason !== "removed")
    .filter((entry, index, all) => all.findIndex((other) => other.nodeId === entry.nodeId) === index)
    .map((entry) => ({
      nodeType: entry.nodeType,
      nodeId: entry.nodeId,
      lastRevision: input.baseRevision,
      excerpt: excerptOf(input.base, entry.nodeType, entry.nodeId),
      reason: entry.reason,
    }));
  const explicitIds = new Set(explicit.map((entry) => entry.nodeId));
  const tombstones = parseDocumentTombstones(
    [
      ...(input.previousTombstones ?? []),
      ...explicit,
      ...appendRemovedTombstones(input.base, changeset).filter((entry) => !explicitIds.has(entry.nodeId)),
    ],
    document,
  );
  return { document, changeset, tombstones, assets };
}

function excerptOf(tree: DocumentTree, nodeType: string, nodeId: string): string {
  const text = nodeType === "unit" ? unitLogicalText(tree, nodeId)
    : nodeType === "sentence" ? tree.sentences[nodeId]?.content.map((part) =>
      part.kind === "text" ? part.text : tree.atoms[part.atomId].text).join("") ?? ""
    : nodeType === "atom" ? tree.atoms[nodeId]?.text ?? ""
    : nodeType === "section" ? tree.sections[nodeId]?.title ?? ""
    : "";
  return Array.from(text).slice(0, 500).join("");
}
