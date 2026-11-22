// 翻译语言视图投影回归（SPEC-translation §5，paper-30min-crd.2）：
// ready 译文携带译文逻辑偏移与原文 atom；gap 回退原文锚点；stale 保留旧译文。
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { parseDocumentTree } from "../src/shared/document/tree";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import { buildTranslationUnitViews } from "../src/shared/reader/translation-view";
import type { TranslationProjection } from "../src/shared/translation/contracts";
import { complexReaderTree } from "./fixtures/reader/complex-document";

function fixture() {
  const paperId = randomUUID();
  const { tree, ids } = complexReaderTree(paperId);
  const projection = buildReaderProjection(parseDocumentTree(tree, paperId));
  const unit = (unitId: string): ReaderUnitContent => {
    const item = projection.items.find((candidate) => candidate.kind === "unit" && candidate.unitId === unitId);
    if (!item || item.kind !== "unit") throw new Error("测试单元不存在。");
    return item;
  };
  return { ids, abstract: unit(ids.abstract), intro: unit(ids.intro), target: unit(ids.target) };
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

test.describe("translation 语言视图投影", () => {
  test("ready 句显示译文并携带译文逻辑偏移，atom 复用原文结构", () => {
    const { ids, abstract } = fixture();
    const sentenceId = ids.inlineMathSentence;
    const views = buildTranslationUnitViews(
      [abstract],
      projection([
        {
          unitId: abstract.unitId,
          generator,
          sentences: [
            {
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
          generator,
          sentences: [
            {
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

  test("已提交单元中的新增句为 gap，显示最新原文", () => {
    const { ids, intro } = fixture();
    const views = buildTranslationUnitViews(
      [intro],
      projection([
        {
          unitId: intro.unitId,
          generator,
          sentences: [
            {
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
});
