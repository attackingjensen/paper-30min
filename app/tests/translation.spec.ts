import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { parseDocumentTree } from "../src/shared/document/tree";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import { createTranslationModelInput, parseTranslationModelOutput } from "../src/main/translation/model-io";
import { runTranslationTask } from "../src/main/translation/task";
import { complexReaderTree } from "./fixtures/reader/complex-document";

const testModelBudget = {
  contextWindow: 128_000,
  maxTokens: 4096,
  safetyMarginTokens: 1024,
};

function translationFixture() {
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

function atomToken(atomId: string) {
  return `⟦atom:${atomId}⟧`;
}

function validContents(fixture: ReturnType<typeof translationFixture>) {
  return {
    abstract: `我们研究阅读。能量保持 ${atomToken(fixture.ids.inlineMath)} 不变。`,
    intro: [
      `先前工作 ${atomToken(fixture.ids.citation)} 启发了这一研究${atomToken(fixture.ids.footnoteRef)}。`,
      `参见 ${atomToken(fixture.ids.resolvedRef)} 和 ${atomToken(fixture.ids.unresolvedRef)}，或访问 ${atomToken(fixture.ids.safeLink)}。`,
    ],
  };
}

function response(unitId: string, sentenceIds: readonly string[], contents: readonly string[]) {
  return JSON.stringify({
    unitId,
    sentences: sentenceIds.map((sentenceId, index) => ({ sentenceId, content: contents[index] })),
  });
}

test.describe("translation 按需任务与模型 I/O", () => {
  test("模型输入只包含指定原句，并以带 ID 占位符隐藏 atom 内部结构", () => {
    const fixture = translationFixture();
    const input = createTranslationModelInput({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      targetLanguage: "zh",
      unit: fixture.abstract,
      context: { paperTitle: "Reading paper", sectionPath: ["Abstract"] },
    });

    expect(input.unit).toEqual({
      unitId: fixture.abstract.unitId,
      sentences: [
        {
          sentenceId: fixture.ids.inlineMathSentence,
          content: `We study reading. Energy stays ${atomToken(fixture.ids.inlineMath)} throughout.`,
        },
      ],
    });
    expect(JSON.stringify(input.unit)).not.toContain("E=mc^2");
  });

  test("合法响应确定性组装译文，并复用原句 ID 与 atom ID", () => {
    const fixture = translationFixture();
    const translated = parseTranslationModelOutput(
      fixture.abstract,
      response(
        fixture.abstract.unitId,
        [fixture.ids.inlineMathSentence],
        [`  我们研究阅读。\n能量保持   ${atomToken(fixture.ids.inlineMath)} 不变。  `],
      ),
    );

    expect(translated).toEqual({
      unitId: fixture.abstract.unitId,
      sentences: [
        {
          sentenceId: fixture.ids.inlineMathSentence,
          content: [
            { kind: "text", text: "我们研究阅读。 能量保持 " },
            { kind: "atom", atomId: fixture.ids.inlineMath },
            { kind: "text", text: " 不变。" },
          ],
        },
      ],
    });
  });

  test("文本采用 NFC 并折叠空白，atom 两侧不制造或丢失逻辑内容", () => {
    const fixture = translationFixture();
    const translated = parseTranslationModelOutput(
      fixture.abstract,
      response(
        fixture.abstract.unitId,
        [fixture.ids.inlineMathSentence],
        [`Cafe\u0301 ${atomToken(fixture.ids.inlineMath)}`],
      ),
    );

    expect(translated.sentences[0].content).toEqual([
      { kind: "text", text: "Café " },
      { kind: "atom", atomId: fixture.ids.inlineMath },
    ]);
  });

  test("合法多句响应保持句序和每句全部 atom", () => {
    const fixture = translationFixture();
    const contents = validContents(fixture);
    const translated = parseTranslationModelOutput(
      fixture.intro,
      response(
        fixture.intro.unitId,
        fixture.intro.sentences.map((sentence) => sentence.sentenceId),
        contents.intro,
      ),
    );

    expect(translated.sentences.map((sentence) => sentence.sentenceId)).toEqual(
      fixture.intro.sentences.map((sentence) => sentence.sentenceId),
    );
    expect(
      translated.sentences.map((sentence) =>
        sentence.content.flatMap((part) => (part.kind === "atom" ? [part.atomId] : [])),
      ),
    ).toEqual([
      [fixture.ids.citation, fixture.ids.footnoteRef],
      [fixture.ids.resolvedRef, fixture.ids.unresolvedRef, fixture.ids.safeLink],
    ]);
  });

  test("合法纯文本句不需要 atom 占位", () => {
    const fixture = translationFixture();
    const sentenceId = fixture.target.sentences[0].sentenceId;
    const translated = parseTranslationModelOutput(
      fixture.target,
      response(fixture.target.unitId, [sentenceId], ["这是跳转目标段落。"]),
    );

    expect(translated).toEqual({
      unitId: fixture.target.unitId,
      sentences: [{ sentenceId, content: [{ kind: "text", text: "这是跳转目标段落。" }] }],
    });
  });

  const invalidCases: Array<{
    name: string;
    raw: (fixture: ReturnType<typeof translationFixture>, contents: ReturnType<typeof validContents>) => string;
  }> = [
    {
      name: "漏句不能通过截断数组被接受",
      raw: (fixture, contents) =>
        response(fixture.intro.unitId, [fixture.intro.sentences[0].sentenceId], [contents.intro[0]]),
    },
    {
      name: "多句和未知 ID 被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          [...fixture.intro.sentences.map((sentence) => sentence.sentenceId), randomUUID()],
          [...contents.intro, "额外句子。"],
        ),
    },
    {
      name: "句子顺序变化被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId).reverse(),
          [...contents.intro].reverse(),
        ),
    },
    {
      name: "重复句子 ID 被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          [fixture.intro.sentences[0].sentenceId, fixture.intro.sentences[0].sentenceId],
          contents.intro,
        ),
    },
    {
      name: "缺失 atom 被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          ["先前工作启发了这一研究。", contents.intro[1]],
        ),
    },
    {
      name: "重复 atom 被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          [`${contents.intro[0]}${atomToken(fixture.ids.citation)}`, contents.intro[1]],
        ),
    },
    {
      name: "atom 移到另一句被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          [
            `先前工作 ${atomToken(fixture.ids.citation)} 启发了这一研究。`,
            `${atomToken(fixture.ids.footnoteRef)}${contents.intro[1]}`,
          ],
        ),
    },
    {
      name: "未知 atom 被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          [`${contents.intro[0]}${atomToken(randomUUID())}`, contents.intro[1]],
        ),
    },
    {
      name: "危险 HTML 被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          [`${contents.intro[0]}<script>alert(1)</script>`, contents.intro[1]],
        ),
    },
    {
      name: "额外摘要字段被拒绝",
      raw: (fixture, contents) => {
        const value = JSON.parse(
          response(
            fixture.intro.unitId,
            fixture.intro.sentences.map((sentence) => sentence.sentenceId),
            contents.intro,
          ),
        );
        return JSON.stringify({ ...value, takeaway: "模型自行添加的摘要" });
      },
    },
    {
      name: "非 JSON 响应被拒绝",
      raw: () => "```json\n{}\n```",
    },
    {
      name: "超过单元译文 2 MiB 预算被拒绝",
      raw: (fixture, contents) =>
        response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          [`${contents.intro[0]}${"长".repeat(2 * 1024 * 1024)}`, contents.intro[1]],
        ),
    },
  ];

  for (const invalidCase of invalidCases) {
    test(invalidCase.name, () => {
      const fixture = translationFixture();
      const contents = validContents(fixture);
      expect(() => parseTranslationModelOutput(fixture.intro, invalidCase.raw(fixture, contents))).toThrow(
        /翻译模型输出无效/,
      );
    });
  }

  test("未选择目标语言时不调用模型", async () => {
    const fixture = translationFixture();
    let calls = 0;
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      units: [fixture.abstract],
      generate: async () => {
        calls++;
        return "{}";
      },
    });

    expect(result).toEqual({ status: "skipped", reason: "not-selected", units: [] });
    expect(calls).toBe(0);
  });

  test("已有译文或源目标同语言时只切换，不重复调用模型", async () => {
    const fixture = translationFixture();
    let calls = 0;
    const generate = async () => {
      calls++;
      return "{}";
    };
    const existing = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      selectedLanguage: "zh",
      generatedLanguages: ["zh"],
      units: [fixture.abstract],
      generate,
    });
    const sameLanguage = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      selectedLanguage: "en",
      units: [fixture.abstract],
      generate,
    });

    expect(existing).toEqual({ status: "skipped", reason: "already-generated", units: [] });
    expect(sameLanguage).toEqual({ status: "skipped", reason: "same-language", units: [] });
    expect(calls).toBe(0);
  });

  test("同一任务中合法单元独立完成，错误单元保留 gap 而不合并对齐", async () => {
    const fixture = translationFixture();
    const contents = validContents(fixture);
    const calls: string[] = [];
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      selectedLanguage: "zh",
      units: [fixture.abstract, fixture.intro],
      generate: async (input) => {
        calls.push(input.unit.unitId);
        if (input.unit.unitId === fixture.abstract.unitId) {
          return response(fixture.abstract.unitId, [fixture.ids.inlineMathSentence], [contents.abstract]);
        }
        return response(fixture.intro.unitId, [fixture.intro.sentences[0].sentenceId], [contents.intro[0]]);
      },
    });

    expect(calls).toEqual([fixture.abstract.unitId, fixture.intro.unitId]);
    expect(result.status).toBe("finished");
    expect(result.units.map((unit) => unit.status)).toEqual(["ready", "gap"]);
    expect(result.units[0]).toMatchObject({
      status: "ready",
      unit: {
        unitId: fixture.abstract.unitId,
        sentences: [{ sentenceId: fixture.ids.inlineMathSentence }],
      },
    });
    expect(result.units[1]).toMatchObject({ status: "gap", unitId: fixture.intro.unitId });
  });

  test("长 unit 只在句子边界拆分，片段响应按原顺序完整重组", async () => {
    const fixture = translationFixture();
    const contents = validContents(fixture);
    const probes = fixture.intro.sentences.map((sentence) =>
      createTranslationModelInput({
        baseRevision: "revision-current",
        modelBudget: testModelBudget,
        sourceLanguage: "en",
        targetLanguage: "zh",
        unit: { ...fixture.intro, sentences: [sentence] },
      }),
    );
    const modelBudget = {
      ...testModelBudget,
      contextWindow:
        Math.max(...probes.map((input) => input.estimatedInputTokens)) +
        testModelBudget.maxTokens +
        testModelBudget.safetyMarginTokens,
    };
    const contentById = new Map([
      [fixture.intro.sentences[0].sentenceId, contents.intro[0]],
      [fixture.intro.sentences[1].sentenceId, contents.intro[1]],
    ]);
    const calls: string[][] = [];
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget,
      sourceLanguage: "en",
      selectedLanguage: "zh",
      units: [fixture.intro],
      generate: async (input) => {
        const sentenceIds = input.unit.sentences.map((sentence) => sentence.sentenceId);
        calls.push(sentenceIds);
        expect(input.estimatedInputTokens).toBeLessThanOrEqual(
          modelBudget.contextWindow - modelBudget.maxTokens - modelBudget.safetyMarginTokens,
        );
        return response(
          input.unit.unitId,
          sentenceIds,
          sentenceIds.map((sentenceId) => contentById.get(sentenceId) ?? ""),
        );
      },
    });

    expect(calls).toEqual([[fixture.intro.sentences[0].sentenceId], [fixture.intro.sentences[1].sentenceId]]);
    const translated = result.units[0];
    expect(translated.status).toBe("ready");
    if (translated.status === "ready") {
      expect(translated.unit.sentences.map((sentence) => sentence.sentenceId)).toEqual(
        fixture.intro.sentences.map((sentence) => sentence.sentenceId),
      );
    }
  });

  test("合法片段重组后超过 2 MiB 的 unit 仍为 gap", async () => {
    const content = "x".repeat(1024 * 1024);
    const unitId = randomUUID();
    const unit: ReaderUnitContent = {
      unitId,
      unitKind: "paragraph",
      sentences: [randomUUID(), randomUUID()].map((sentenceId) => ({
        sentenceId,
        unitId,
        parts: [{ kind: "text", text: content, start: 0, end: content.length }],
      })),
    };
    const largeModelBudget = {
      contextWindow: 8 * 1024 * 1024,
      maxTokens: 4 * 1024 * 1024,
      safetyMarginTokens: 1024,
    };
    const probes = unit.sentences.map((sentence) =>
      createTranslationModelInput({
        baseRevision: "revision-current",
        modelBudget: largeModelBudget,
        sourceLanguage: "en",
        targetLanguage: "zh",
        unit: { ...unit, sentences: [sentence] },
      }),
    );
    const modelBudget = {
      ...largeModelBudget,
      contextWindow: Math.max(...probes.map((input) => input.estimatedInputTokens)) + largeModelBudget.maxTokens + 1024,
    };
    const calls: string[][] = [];
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget,
      sourceLanguage: "en",
      selectedLanguage: "zh",
      units: [unit],
      generate: async (input) => {
        const sentenceIds = input.unit.sentences.map((sentence) => sentence.sentenceId);
        calls.push(sentenceIds);
        return response(
          input.unit.unitId,
          sentenceIds,
          sentenceIds.map(() => content),
        );
      },
    });

    expect(calls).toHaveLength(2);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({ status: "gap", diagnostic: expect.stringMatching(/2 MiB/) });
  });

  test("单句超出输入预算时不截断也不发送，其他单元继续", async () => {
    const fixture = translationFixture();
    const targetProbe = createTranslationModelInput({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      targetLanguage: "zh",
      unit: fixture.target,
    });
    const modelBudget = {
      ...testModelBudget,
      contextWindow: targetProbe.estimatedInputTokens + testModelBudget.maxTokens + testModelBudget.safetyMarginTokens,
    };
    const longUnit: ReaderUnitContent = {
      ...fixture.intro,
      sentences: [
        {
          ...fixture.intro.sentences[0],
          parts: [{ kind: "text", text: "x".repeat(5000), start: 0, end: 5000 }],
        },
      ],
    };
    const calls: string[] = [];
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget,
      sourceLanguage: "en",
      selectedLanguage: "zh",
      units: [longUnit, fixture.target],
      generate: async (input) => {
        calls.push(input.unit.unitId);
        return response(fixture.target.unitId, [fixture.target.sentences[0].sentenceId], ["这是跳转目标段落。"]);
      },
    });

    expect(calls).toEqual([fixture.target.unitId]);
    expect(result.units.map((unit) => unit.status)).toEqual(["gap", "ready"]);
    expect(result.units[0]).toMatchObject({ diagnostic: expect.stringMatching(/模型输入预算/) });
  });

  test("单语言逻辑内容达到 64 MiB 后，越界单元不能成为 ready", async () => {
    const content = "x".repeat(2 * 1024 * 1024 - 1024);
    const units: ReaderUnitContent[] = Array.from({ length: 33 }, () => {
      const unitId = randomUUID();
      const sentenceId = randomUUID();
      return {
        unitId,
        unitKind: "paragraph",
        sentences: [
          {
            sentenceId,
            unitId,
            parts: [{ kind: "text", text: content, start: 0, end: content.length }],
          },
        ],
      };
    });
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget: {
        contextWindow: 8 * 1024 * 1024,
        maxTokens: 4 * 1024 * 1024,
        safetyMarginTokens: 0,
      },
      sourceLanguage: "en",
      selectedLanguage: "zh",
      units,
      generate: async (input) => response(input.unit.unitId, [input.unit.sentences[0].sentenceId], [content]),
    });

    expect(result.units.map((unit) => unit.status)).toEqual([...Array(32).fill("ready"), "gap"]);
    expect(result.units[32]).toMatchObject({ diagnostic: expect.stringMatching(/64 MiB/) });
  });

  test("模型请求拒绝只使对应单元成为 gap", async () => {
    const fixture = translationFixture();
    const contents = validContents(fixture);
    const calls: string[] = [];
    const result = await runTranslationTask({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      selectedLanguage: "zh",
      units: [fixture.abstract, fixture.intro],
      generate: async (input) => {
        calls.push(input.unit.unitId);
        if (input.unit.unitId === fixture.abstract.unitId) throw new Error("受控请求失败");
        return response(
          fixture.intro.unitId,
          fixture.intro.sentences.map((sentence) => sentence.sentenceId),
          contents.intro,
        );
      },
    });

    expect(calls).toEqual([fixture.abstract.unitId, fixture.intro.unitId]);
    expect(result.units.map((unit) => unit.status)).toEqual(["gap", "ready"]);
    expect(result.units[0]).toMatchObject({ diagnostic: "翻译模型请求失败，请检查模型配置后重试。" });
  });
});
