// 译文精确选区与重基（SPEC-translation §10，paper-30min-crd.4）：
// 语言视图选区只覆盖 ready/stale 译文片段；gap 回退原文锚点不冒充译文 range；
// translationRevision 变化按实际 sentenceId/range/quote 局部重基，不全篇失效。
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { parseDocumentTree } from "../src/shared/document/tree";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import {
  buildTranslationSelectionIndex,
  classifyTranslationSelection,
  translationQuote,
} from "../src/shared/reader/translation-selection";
import { buildTranslationUnitViews } from "../src/shared/reader/translation-view";
import type { TranslationProjection } from "../src/shared/translation/contracts";
import { complexReaderTree } from "./fixtures/reader/complex-document";

const generator = { provider: "controlled", model: "m", promptVersion: 1, schemaVersion: 1 };

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
  return { tree: parsed, ids, projection, abstract: unit(ids.abstract) };
}

function translatedProjection(
  units: TranslationProjection["units"],
  translationRevision: string | null = randomUUID(),
): TranslationProjection {
  return {
    baseRevision: "revision-current",
    language: "zh",
    translationRevision,
    sourceLanguage: "en",
    units,
    task: null,
  };
}

/** 摘要句译文：text "能量保持 "(0..5) + atom(5..6) + text " 不变。"(6..10)。 */
function readyUnit(abstract: ReaderUnitContent, sentenceId: string, atomId: string) {
  return {
    unitId: abstract.unitId,
    sentences: [
      {
        sentenceId,
        status: "ready" as const,
        sourceSha256: "a".repeat(64),
        translationSha256: "c".repeat(64),
        generator,
        content: [
          { kind: "text" as const, text: "能量保持 " },
          { kind: "atom" as const, atomId },
          { kind: "text" as const, text: " 不变。" },
        ],
      },
    ],
  };
}

test.describe("translation 译文精确选区", () => {
  test("ready 句译文 quote 按逻辑偏移截取，atom 展开权威文本", () => {
    const { ids, abstract } = fixture();
    const views = buildTranslationUnitViews(
      [abstract],
      translatedProjection([readyUnit(abstract, ids.inlineMathSentence, ids.inlineMath)]),
    );
    const index = buildTranslationSelectionIndex(views);
    expect(
      translationQuote(index, [{ unitId: abstract.unitId, sentenceId: ids.inlineMathSentence, start: 0, end: 10 }]),
    ).toEqual({
      text: "能量保持 $E=mc^2$ 不变。",
      before: "",
      after: "",
    });
    // 部分截取与前后文（32 逻辑位上下文，句内）。
    expect(
      translationQuote(index, [{ unitId: abstract.unitId, sentenceId: ids.inlineMathSentence, start: 5, end: 6 }]),
    ).toEqual({
      text: "$E=mc^2$",
      before: "能量保持 ",
      after: " 不变。",
    });
  });

  test("gap 句不进入译文选区索引：原文锚点不冒充译文 range", () => {
    const { ids, abstract } = fixture();
    const views = buildTranslationUnitViews([abstract], translatedProjection([]));
    const index = buildTranslationSelectionIndex(views);
    expect(index.sentences.has(ids.inlineMathSentence)).toBe(false);
    expect(() =>
      translationQuote(index, [{ unitId: abstract.unitId, sentenceId: ids.inlineMathSentence, start: 0, end: 3 }]),
    ).toThrow(/不在译文选区/);
  });

  test("stale 句仍可精确选区，索引携带 stale 状态", () => {
    const { ids, abstract } = fixture();
    const unit = readyUnit(abstract, ids.inlineMathSentence, ids.inlineMath);
    unit.sentences[0].status = "stale" as never;
    const views = buildTranslationUnitViews([abstract], translatedProjection([unit]));
    const index = buildTranslationSelectionIndex(views);
    expect(index.sentences.get(ids.inlineMathSentence)?.status).toBe("stale");
    expect(
      translationQuote(index, [{ unitId: abstract.unitId, sentenceId: ids.inlineMathSentence, start: 0, end: 5 }]).text,
    ).toBe("能量保持 ");
  });

  test("偏移越界、空 range 与父子关系不一致显式拒绝，不静默截断", () => {
    const { ids, abstract } = fixture();
    const views = buildTranslationUnitViews(
      [abstract],
      translatedProjection([readyUnit(abstract, ids.inlineMathSentence, ids.inlineMath)]),
    );
    const index = buildTranslationSelectionIndex(views);
    const range = { unitId: abstract.unitId, sentenceId: ids.inlineMathSentence, start: 0, end: 11 };
    expect(() => translationQuote(index, [range])).toThrow(/逻辑边界/);
    expect(() => translationQuote(index, [{ ...range, end: 0 }])).toThrow(/逻辑边界/);
    expect(() => translationQuote(index, [{ ...range, end: 5, unitId: randomUUID() }])).toThrow(/父子关系/);
  });
});

test.describe("translation translationRevision 按 quote 重基", () => {
  function viewWith(text: string, status: "ready" | "stale" = "ready") {
    const { ids, abstract } = fixture();
    const unit = {
      unitId: abstract.unitId,
      sentences: [
        {
          sentenceId: ids.inlineMathSentence,
          status,
          sourceSha256: "a".repeat(64),
          translationSha256: "c".repeat(64),
          generator,
          content: [{ kind: "text" as const, text }],
        },
      ],
    };
    const revision = randomUUID();
    const projectionValue = translatedProjection([unit], revision);
    const views = buildTranslationUnitViews([abstract], projectionValue);
    const index = buildTranslationSelectionIndex(views);
    const ranges = [
      { unitId: abstract.unitId, sentenceId: ids.inlineMathSentence, start: 0, end: Math.min(5, text.length) },
    ];
    return { ids, abstract, index, ranges, quote: translationQuote(index, ranges), revision, projectionValue, views };
  }

  test("无关 unit 提交推进 translationRevision：quote 仍匹配则重基保持 active", () => {
    const base = viewWith("能量保持守恒。");
    // 同一句内容不变，另一 unit 新增译文 → 新 translationRevision。
    const other = { unitId: randomUUID(), sentences: [] };
    const next = translatedProjection([...base.projectionValue.units, other]);
    const nextIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([base.abstract], next));
    const result = classifyTranslationSelection(nextIndex, next.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    expect(result.status).toBe("active");
    expect(result.status === "active" && result.translationRevision).toBe(next.translationRevision);
  });

  test("同句未相交且不在 quote 上下文的文本改变：选区保持精确有效", () => {
    const long = "能量保持" + "稳".repeat(50) + "。";
    const base = viewWith(long);
    const changed = translatedProjection([
      {
        ...base.projectionValue.units[0],
        sentences: [
          {
            ...base.projectionValue.units[0].sentences[0],
            content: [{ kind: "text", text: long.slice(0, -1) + "！" }],
          },
        ],
      },
    ]);
    const nextIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([base.abstract], changed));
    const result = classifyTranslationSelection(nextIndex, changed.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    // 选区 0..5 与 32 位 after 上下文都不含句尾变化：重基保持 active。
    expect(result.status).toBe("active");
  });

  test("选区外但落入 quote 上下文的文本改变：range 未相交仍精确有效，重基刷新上下文", () => {
    const base = viewWith("能量保持恒久。");
    // 纯译文重译（源未变）：只改 after 上下文内的第 6 字（久→远），选区 0..5 不含该字。
    const changed = translatedProjection([
      {
        ...base.projectionValue.units[0],
        sentences: [
          { ...base.projectionValue.units[0].sentences[0], content: [{ kind: "text", text: "能量保持恒远。" }] },
        ],
      },
    ]);
    const nextIndex = buildTranslationSelectionIndex(
      buildTranslationUnitViews([base.abstract], changed),
      undefined,
      changed,
    );
    const result = classifyTranslationSelection(nextIndex, changed.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    // SPEC §10.4：只有相交 range 失效；0..5 文本未变，上下文变化不扩大失效。
    expect(result.status).toBe("active");
    expect(result.status === "active" && result.translationRevision).toBe(changed.translationRevision);
    // 重基后 quote 上下文刷新为当前文本，selected text 不变。
    expect(result.quote.text).toBe(base.quote.text);
    expect(result.quote.after).toBe("远。");
  });

  test("跨原文 revision 源摘要变化：旧译文文本未变也按 stale 处理", () => {
    const base = viewWith("能量保持守恒。");
    const baseIndex = buildTranslationSelectionIndex(base.views, undefined, base.projectionValue);
    // 新 current：原句已改（源摘要变化），迁移保留的旧译文文本恰好相同。
    const migrated = translatedProjection([
      {
        ...base.projectionValue.units[0],
        sentences: [{ ...base.projectionValue.units[0].sentences[0], sourceSha256: "b".repeat(64) }],
      },
    ]);
    migrated.baseRevision = "revision-next";
    const nextIndex = buildTranslationSelectionIndex(
      buildTranslationUnitViews([base.abstract], migrated),
      undefined,
      migrated,
    );
    const result = classifyTranslationSelection(nextIndex, migrated.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: translationQuote(baseIndex, base.ranges),
      baseRevision: base.projectionValue.baseRevision,
      sourceDigests: Object.fromEntries(
        base.projectionValue.units.flatMap((unit) =>
          unit.sentences.map((sentence) => [sentence.sentenceId, sentence.sourceSha256 ?? "a".repeat(64)] as const),
        ),
      ),
    });
    expect(result).toMatchObject({ status: "stale" });
  });

  test("两 range 仅一个相交变化：整组 translation-changed 保留旧 quote，未相交 range 文本仍可核验", () => {
    const { abstract, intro } = (() => {
      const f = fixture();
      const item = f.projection.items.find(
        (candidate) => candidate.kind === "unit" && candidate.unitId === f.ids.intro,
      );
      if (!item || item.kind !== "unit") throw new Error("测试单元不存在。");
      return { ...f, intro: item };
    })();
    const firstSentence = abstract.sentences[0].sentenceId;
    const secondSentence = intro.sentences[0].sentenceId;
    const units = [
      {
        unitId: abstract.unitId,
        sentences: [
          {
            sentenceId: firstSentence,
            status: "ready" as const,
            sourceSha256: "a".repeat(64),
            translationSha256: "c".repeat(64),
            generator,
            content: [{ kind: "text" as const, text: "能量保持守恒。" }],
          },
        ],
      },
      {
        unitId: intro.unitId,
        sentences: [
          {
            sentenceId: secondSentence,
            status: "ready" as const,
            sourceSha256: "a".repeat(64),
            translationSha256: "c".repeat(64),
            generator,
            content: [{ kind: "text" as const, text: "先前工作启发研究。" }],
          },
        ],
      },
    ];
    const baseProjection = translatedProjection(units);
    const baseIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([abstract, intro], baseProjection));
    const ranges = [
      { unitId: abstract.unitId, sentenceId: firstSentence, start: 0, end: 4 },
      { unitId: intro.unitId, sentenceId: secondSentence, start: 0, end: 4 },
    ];
    const quote = translationQuote(baseIndex, ranges);
    // 只有第二句相交文本改变；第一句 range 文本不变。
    const changed = translatedProjection([
      units[0],
      {
        ...units[1],
        sentences: [{ ...units[1].sentences[0], content: [{ kind: "text" as const, text: "全新译文完全不同。" }] }],
      },
    ]);
    const nextIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([abstract, intro], changed));
    const result = classifyTranslationSelection(nextIndex, changed.translationRevision, {
      translationRevision: baseProjection.translationRevision,
      ranges,
      quote,
    });
    expect(result).toMatchObject({ status: "translation-changed", quote });
    // 未相交 range 的当前文本仍与保存一致：失效只由相交 range 触发。
    expect(translationQuote(nextIndex, [ranges[0]]).text).toBe(quote.text.split("\n")[0]);
  });

  test("相关译文文本改变使相交 range 失效为 translation-changed，quote 保留", () => {
    const base = viewWith("能量保持守恒。");
    const changed = translatedProjection([
      {
        ...base.projectionValue.units[0],
        sentences: [
          { ...base.projectionValue.units[0].sentences[0], content: [{ kind: "text", text: "完全不同译文。" }] },
        ],
      },
    ]);
    const nextIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([base.abstract], changed));
    const result = classifyTranslationSelection(nextIndex, changed.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    expect(result).toMatchObject({ status: "translation-changed", quote: base.quote });
  });

  test("重译得到完全相同文本：quote 匹配即重基，不制造无意义失效", () => {
    const base = viewWith("能量保持守恒。");
    const same = translatedProjection(base.projectionValue.units);
    const nextIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([base.abstract], same));
    const result = classifyTranslationSelection(nextIndex, same.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    expect(result.status).toBe("active");
  });

  test("原句 changed 导致 stale：选区按 stale 处理，保留旧 quote", () => {
    const base = viewWith("能量保持守恒。", "stale");
    const result = classifyTranslationSelection(base.index, base.revision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    expect(result).toMatchObject({ status: "stale", quote: base.quote });
  });

  test("句子已不在译文投影（removed/gap 回退）：选区 removed，不静默重挂", () => {
    const base = viewWith("能量保持守恒。");
    const empty = translatedProjection([]);
    const nextIndex = buildTranslationSelectionIndex(buildTranslationUnitViews([base.abstract], empty));
    const result = classifyTranslationSelection(nextIndex, empty.translationRevision, {
      translationRevision: base.revision,
      ranges: base.ranges,
      quote: base.quote,
    });
    expect(result).toMatchObject({ status: "removed", quote: base.quote });
  });
});
