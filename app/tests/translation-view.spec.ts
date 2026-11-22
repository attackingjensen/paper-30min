// 翻译语言视图投影回归（SPEC-translation §5，paper-30min-crd.2）：
// ready 译文携带译文逻辑偏移与原文 atom；gap 回退原文锚点；stale 保留旧译文。
// stale 的 atom 只从提交时旧快照重建：当前树 atom 已改/已删不影响旧译文展示与 quote。
import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import { buildTranslationUnitViews } from "../src/shared/reader/translation-view";
import type { TranslationProjection } from "../src/shared/translation/contracts";
import { complexReaderTree } from "./fixtures/reader/complex-document";

function fixture() {
  const paperId = randomUUID();
  const { tree, ids } = complexReaderTree(paperId);
  const parsed = parseDocumentTree(tree, paperId);
  const projection = buildReaderProjection(parsed);
  const unit = (unitId: string): ReaderUnitContent => {
    const item = projection.items.find((candidate) => candidate.kind === "unit" && candidate.unitId === unitId);
    if (!item || item.kind !== "unit") throw new Error("测试单元不存在。");
    return item;
  };
  return { ids, tree: parsed, abstract: unit(ids.abstract), intro: unit(ids.intro), target: unit(ids.target) };
}

const generator = { provider: "controlled", model: "m", promptVersion: 1, schemaVersion: 1 };

function projection(units: TranslationProjection["units"]): TranslationProjection {
  return {
    baseRevision: "revision-current",
    language: "zh",
    translationRevision: randomUUID(),
    sourceLanguage: "en",
    units,
    task: null,
  };
}

/** 句级事实占位：视图测试不校验摘要语义，只需 DTO 完整（64 位 hex）。 */
const factSha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
function sentenceFacts(label: string) {
  return { sourceSha256: factSha(`${label}:source`), translationSha256: factSha(`${label}:translation`), generator };
}

/** 同一棵树上模拟 atom 修正/删除后的当前投影（ID 稳定，旧快照与当前树可对照）。 */
function currentAbstract(tree: DocumentTree, abstractUnitId: string): ReaderUnitContent {
  const item = buildReaderProjection(tree).items.find(
    (candidate) => candidate.kind === "unit" && candidate.unitId === abstractUnitId,
  );
  if (!item || item.kind !== "unit") throw new Error("测试单元不存在。");
  return item;
}

test.describe("translation 语言视图投影", () => {
  test("ready 句显示译文并携带译文逻辑偏移，atom 复用原文结构", () => {
    const { ids, abstract } = fixture();
    const sentenceId = ids.inlineMathSentence;
    const views = buildTranslationUnitViews(
      [abstract],
      projection([
        {
          unitId: abstract.unitId,
          sentences: [
            {
              ...sentenceFacts("ready-inline-math"),
              sentenceId,
              status: "ready",
              content: [
                { kind: "text", text: "能量保持 " },
                { kind: "atom", atomId: ids.inlineMath },
                { kind: "text", text: " 不变。" },
              ],
            },
          ],
        },
      ]),
    );

    const sourceAtom = abstract.sentences[0].parts.find((part) => part.kind === "atom");
    expect(views[0].sentences[0]).toMatchObject({ sentenceId, unitId: abstract.unitId, status: "ready" });
    expect(views[0].sentences[0].parts).toEqual([
      { kind: "text", text: "能量保持 ", start: 0, end: 5 },
      { kind: "atom", atom: sourceAtom?.kind === "atom" ? sourceAtom.atom : undefined, start: 5, end: 6 },
      { kind: "text", text: " 不变。", start: 6, end: 10 },
    ]);
  });

  test("gap 句回退当前原文片段与原文锚点，不包装成译文 range", () => {
    const { abstract, target } = fixture();
    const views = buildTranslationUnitViews([abstract, target], projection([]));

    expect(views[0].sentences[0]).toEqual({
      sentenceId: abstract.sentences[0].sentenceId,
      unitId: abstract.unitId,
      status: "gap",
      parts: abstract.sentences[0].parts,
    });
    expect(views[1].sentences[0].status).toBe("gap");
    expect(views[1].sentences[0].parts).toEqual(target.sentences[0].parts);
  });

  test("stale 句保留旧译文并携带过期标识，同单元其他 ready 句不受影响", () => {
    const { ids, intro } = fixture();
    const [first, second] = intro.sentences;
    const views = buildTranslationUnitViews(
      [intro],
      projection([
        {
          unitId: intro.unitId,
          sentences: [
            {
              ...sentenceFacts("stale-first"),
              sentenceId: first.sentenceId,
              status: "stale",
              staleReason: "source-changed",
              content: [
                { kind: "text", text: "旧译文 " },
                { kind: "atom", atomId: ids.citation },
                { kind: "atom", atomId: ids.footnoteRef },
              ],
            },
            {
              ...sentenceFacts("ready-second"),
              sentenceId: second.sentenceId,
              status: "ready",
              content: [
                { kind: "text", text: "参见 " },
                { kind: "atom", atomId: ids.resolvedRef },
                { kind: "text", text: "。" },
              ],
            },
          ],
        },
      ]),
    );

    expect(views[0].sentences[0]).toMatchObject({
      sentenceId: first.sentenceId,
      status: "stale",
      staleReason: "source-changed",
    });
    expect(views[0].sentences[0].parts[0]).toEqual({ kind: "text", text: "旧译文 ", start: 0, end: 4 });
    expect(views[0].sentences[1]).toMatchObject({ sentenceId: second.sentenceId, status: "ready" });
  });

  test("stale 句携带最新原文片段供对照，ready/gap 不携带", () => {
    const { ids, intro } = fixture();
    const [first, second] = intro.sentences;
    const views = buildTranslationUnitViews(
      [intro],
      projection([
        {
          unitId: intro.unitId,
          sentences: [
            {
              ...sentenceFacts("stale-text-only"),
              sentenceId: first.sentenceId,
              status: "stale",
              staleReason: "source-changed",
              content: [{ kind: "text", text: "旧译文" }],
            },
            {
              ...sentenceFacts("ready-second"),
              sentenceId: second.sentenceId,
              status: "ready",
              content: [
                { kind: "text", text: "参见 " },
                { kind: "atom", atomId: ids.resolvedRef },
                { kind: "text", text: "。" },
              ],
            },
          ],
        },
      ]),
    );

    // stale：旧译文显示之外，可对照最新原文（原文锚点片段）。
    expect(views[0].sentences[0].sourceParts).toEqual(first.parts);
    // ready 与 gap 不携带对照原文。
    expect(views[0].sentences[1].sourceParts).toBeUndefined();
  });

  test("已提交单元中的新增句为 gap，显示最新原文", () => {
    const { ids, intro } = fixture();
    const views = buildTranslationUnitViews(
      [intro],
      projection([
        {
          unitId: intro.unitId,
          sentences: [
            {
              ...sentenceFacts("ready-first"),
              sentenceId: intro.sentences[0].sentenceId,
              status: "ready",
              content: [
                { kind: "text", text: "先前工作 " },
                { kind: "atom", atomId: ids.citation },
                { kind: "atom", atomId: ids.footnoteRef },
              ],
            },
          ],
        },
      ]),
    );

    expect(views[0].sentences[0].status).toBe("ready");
    expect(views[0].sentences[1]).toEqual({
      sentenceId: intro.sentences[1].sentenceId,
      unitId: intro.unitId,
      status: "gap",
      parts: intro.sentences[1].parts,
    });
  });

  test("atom 内容改变后 stale 旧译文只展开旧快照 atom 文本，quote 不用新 atom", () => {
    const paperId = randomUUID();
    const { tree: oldTree, ids } = complexReaderTree(paperId);
    parseDocumentTree(oldTree, paperId);
    const oldAtom = oldTree.atoms[ids.inlineMath];
    const sentenceId = oldTree.units[ids.abstract].sentenceIds[0];
    const storedSentence = {
      ...sentenceFacts("stale-atom-changed"),
      sentenceId,
      status: "stale" as const,
      staleReason: "source-changed" as const,
      content: [
        { kind: "text" as const, text: "能量保持 " },
        { kind: "atom" as const, atomId: ids.inlineMath },
        { kind: "text" as const, text: " 不变。" },
      ],
      atoms: [oldAtom],
    };

    // 当前树：同 ID atom 内容改变（atom-only 修正），重新校验并投影。
    const currentTree = structuredClone(oldTree);
    currentTree.atoms[ids.inlineMath] = {
      ...currentTree.atoms[ids.inlineMath],
      kind: "math",
      text: "$E=mc^3$",
      source: { format: "latex", value: "E=mc^3" },
    };
    const current = currentAbstract(parseDocumentTree(currentTree, paperId), ids.abstract);
    const views = buildTranslationUnitViews(
      [current],
      projection([{ unitId: current.unitId, sentences: [storedSentence] }]),
    );

    const sentence = views[0].sentences[0];
    expect(sentence.status).toBe("stale");
    // 旧译文 atom 展开旧快照文本，不是当前树的新文本。
    expect(sentence.parts[1]).toEqual({ kind: "atom", atom: oldAtom, start: 5, end: 6 });
    expect(sentence.parts[1].kind === "atom" ? sentence.parts[1].atom.text : "").toBe("$E=mc^2$");
    // 对照原文来自当前树（新 atom 文本）。
    const sourceAtomPart = sentence.sourceParts?.find((part) => part.kind === "atom");
    expect(sourceAtomPart?.kind === "atom" ? sourceAtomPart.atom.text : "").toBe("$E=mc^3$");
  });

  test("atom 被移除后 stale 仍可渲染不抛错，sourceParts 独立展示最新原文", () => {
    const paperId = randomUUID();
    const { tree: oldTree, ids } = complexReaderTree(paperId);
    parseDocumentTree(oldTree, paperId);
    const oldAtom = oldTree.atoms[ids.inlineMath];
    const sentenceId = oldTree.units[ids.abstract].sentenceIds[0];
    const storedSentence = {
      ...sentenceFacts("stale-atom-removed"),
      sentenceId,
      status: "stale" as const,
      staleReason: "source-changed" as const,
      content: [
        { kind: "text" as const, text: "能量保持 " },
        { kind: "atom" as const, atomId: ids.inlineMath },
        { kind: "text" as const, text: " 不变。" },
      ],
      atoms: [oldAtom],
    };

    // 当前树：原句改写为纯文本，atom 整体删除（树校验要求无悬空引用）。
    const currentTree = structuredClone(oldTree);
    currentTree.sentences[sentenceId].content = [{ kind: "text", text: "Energy is conserved throughout." }];
    delete currentTree.atoms[ids.inlineMath];
    const current = currentAbstract(parseDocumentTree(currentTree, paperId), ids.abstract);
    const views = buildTranslationUnitViews(
      [current],
      projection([{ unitId: current.unitId, sentences: [storedSentence] }]),
    );

    const sentence = views[0].sentences[0];
    expect(sentence.status).toBe("stale");
    expect(sentence.parts).toEqual([
      { kind: "text", text: "能量保持 ", start: 0, end: 5 },
      { kind: "atom", atom: oldAtom, start: 5, end: 6 },
      { kind: "text", text: " 不变。", start: 6, end: 10 },
    ]);
    expect(sentence.sourceParts).toEqual(current.sentences[0].parts);
  });
});
