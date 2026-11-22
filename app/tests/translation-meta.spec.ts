// 标题与 raw block 翻译投影（SPEC-translation §2.2/§3.4/§3.7/§7，paper-30min-crd.6）：
// 论文标题是元数据（不制造新 unit）；section 标题保留 ID，无标题 section 不得命名；
// raw 只生成安全文本投影，不返回 HTML；标题 changed 仅标题 stale，正文句不受影响。
import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { commitRevision, createProject, publishSourceSnapshot } from "../src/main/project-core";
import { dispatchCoreCommand } from "../src/main/core-commands";
import { createDocumentChangeset } from "../src/shared/document/changeset";
import {
  createTranslationMetaInput,
  parseTranslationMetaOutput,
  translationProtocolVersions,
} from "../src/main/translation/model-io";
import {
  commitTranslationMeta,
  readTranslationProjection,
  translationMetaSources,
} from "../src/main/translation/store";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import type { TranslationGenerator } from "../src/shared/translation/contracts";

const testModelBudget = { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 };
const generator: TranslationGenerator = {
  provider: "controlled",
  model: "controlled-translate",
  promptVersion: translationProtocolVersions.promptVersion,
  schemaVersion: translationProtocolVersions.schemaVersion,
};

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-meta-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** 带标题 section、无标题 section 与 raw block 的英文树。 */
function metaTree(paperId: string) {
  const ids = {
    intro: randomUUID(),
    empty: randomUUID(),
    unit: randomUUID(),
    sentence: randomUUID(),
    emptyUnit: randomUUID(),
    emptySentence: randomUUID(),
    rawBlock: randomUUID(),
  };
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [ids.intro]: {
        id: ids.intro,
        parentSectionId: null,
        title: "1 Introduction",
        childSectionIds: [ids.empty],
        unitIds: [ids.unit],
      },
      [ids.empty]: {
        id: ids.empty,
        parentSectionId: ids.intro,
        title: "",
        childSectionIds: [],
        unitIds: [ids.emptyUnit],
      },
    },
    units: {
      [ids.unit]: { id: ids.unit, sectionId: ids.intro, kind: "paragraph", sentenceIds: [ids.sentence] },
      [ids.emptyUnit]: {
        id: ids.emptyUnit,
        sectionId: ids.empty,
        kind: "paragraph",
        sentenceIds: [ids.emptySentence],
      },
    },
    sentences: {
      [ids.sentence]: {
        id: ids.sentence,
        unitId: ids.unit,
        content: [{ kind: "text", text: "We study progressive reading." }],
      },
      [ids.emptySentence]: {
        id: ids.emptySentence,
        unitId: ids.emptyUnit,
        content: [{ kind: "text", text: "Untitled section body." }],
      },
    },
    atoms: {},
    blocks: [
      { id: randomUUID(), sectionId: ids.intro, kind: "unit", unitId: ids.unit },
      {
        id: ids.rawBlock,
        sectionId: ids.intro,
        kind: "raw",
        html: "<blockquote><p>Quoted <strong>source</strong> line.</p></blockquote>",
        text: "Quoted source line.",
        limitations: ["复杂排版按白名单投影，交互结构未保留。"],
      },
      { id: randomUUID(), sectionId: ids.empty, kind: "unit", unitId: ids.emptyUnit },
    ],
  };
  return { tree: parseDocumentTree(tree, paperId), ids };
}

async function metaProject(name: string, tree: DocumentTree, title: string | null) {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
    metadata: {
      kind: "arxiv",
      canonicalId: "2401.00001v1",
      ...(title === null ? {} : { title }),
    },
  });
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  // 树身份必须与工程主论文一致：fixture 的占位 paperId 在此重基。
  const committedTree = { ...tree, paperId: created.manifest.paper.id };
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: {
      "document.json": json(committedTree),
      "source-base.json": json(committedTree),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: null }),
    },
    metadata: { normalizationVersion: 1 },
  });
  return { created, revision };
}

const sidecar = (root: string, revisionId: string, language: string) =>
  path.join(root, ".paper30min", "revisions", revisionId, "translations", language);

test.describe("translation 标题与 raw 模型 I/O", () => {
  test("协议版本随标题/raw 扩展递增，generator 与模型输入同源", () => {
    expect(translationProtocolVersions).toEqual({ promptVersion: 3, schemaVersion: 2 });
  });

  test("meta 输入只含论文标题、有标题 section 与 raw 安全文本，无标题 section 不进入请求", () => {
    const { tree } = metaTree(randomUUID());
    const sources = translationMetaSources(tree, "Progressive Reading");
    expect(sources.sections.map((section) => section.title)).toEqual(["1 Introduction"]);
    expect(sources.rawBlocks.map((raw) => raw.text)).toEqual(["Quoted source line."]);
    const input = createTranslationMetaInput({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      targetLanguage: "zh",
      sources,
    });
    const payload = JSON.parse(input.userPrompt) as Record<string, unknown>;
    expect(payload.paperTitle).toBe("Progressive Reading");
    expect(JSON.stringify(payload)).not.toContain("<blockquote>");
    expect(JSON.stringify(payload)).not.toContain("<strong>");
  });

  test("无论文标题时不请求论文标题翻译", () => {
    const { tree } = metaTree(randomUUID());
    const sources = translationMetaSources(tree, null);
    expect(sources.paperTitle).toBeNull();
    const input = createTranslationMetaInput({
      baseRevision: "revision-current",
      modelBudget: testModelBudget,
      sourceLanguage: "en",
      targetLanguage: "zh",
      sources,
    });
    const payload = JSON.parse(input.userPrompt) as Record<string, unknown>;
    expect(payload.paperTitle).toBeNull();
  });

  test("合法 meta 响应按 ID 组装；HTML、未知 ID 与无标题命名被拒绝", () => {
    const { tree, ids } = metaTree(randomUUID());
    const sources = translationMetaSources(tree, "Progressive Reading");
    const valid = {
      paperTitle: "渐进式阅读",
      sections: [{ sectionId: ids.intro, title: "1 引言" }],
      rawBlocks: [{ blockId: ids.rawBlock, text: "引用的来源行。" }],
    };
    const parsed = parseTranslationMetaOutput(sources, JSON.stringify(valid));
    expect(parsed.failures).toEqual([]);
    expect(parsed.content.paperTitle).toBe("渐进式阅读");
    expect(parsed.content.sections).toEqual([{ sectionId: ids.intro, title: "1 引言" }]);
    expect(parsed.content.rawBlocks).toEqual([{ blockId: ids.rawBlock, text: "引用的来源行。" }]);

    // 逐项失败域：标题 HTML 只丢标题，合法 section/raw 仍保留。
    const htmlTitle = parseTranslationMetaOutput(
      sources,
      JSON.stringify({ ...valid, paperTitle: "<b>渐进式阅读</b>" }),
    );
    expect(htmlTitle.content.paperTitle).toBeNull();
    expect(htmlTitle.content.sections).toHaveLength(1);
    expect(htmlTitle.failures.join()).toMatch(/HTML/);
    const htmlRaw = parseTranslationMetaOutput(
      sources,
      JSON.stringify({ ...valid, rawBlocks: [{ blockId: ids.rawBlock, text: "<p>x</p>" }] }),
    );
    expect(htmlRaw.content.rawBlocks).toEqual([]);
    expect(htmlRaw.content.sections).toHaveLength(1);
    expect(htmlRaw.failures.join()).toMatch(/HTML/);
    const named = parseTranslationMetaOutput(
      sources,
      JSON.stringify({ ...valid, sections: [...valid.sections, { sectionId: ids.empty, title: "模型命名" }] }),
    );
    expect(named.content.sections).toEqual([]);
    expect(named.failures.join()).toMatch(/section/);
    const missing = parseTranslationMetaOutput(sources, JSON.stringify({ ...valid, sections: [] }));
    expect(missing.content.sections).toEqual([]);
    expect(missing.failures.join()).toMatch(/section/);
  });
});

test.describe("translation 标题与 raw 原子发布与投影", () => {
  test("meta 提交写入版本化 section 文件与 index 元数据，投影推导 ready", async () => {
    const placeholder = randomUUID();
    const draft = metaTree(placeholder);
    const { created, revision } = await metaProject("标题工程", draft.tree, "Progressive Reading");
    const tree = { ...draft.tree, paperId: created.manifest.paper.id };
    const ids = draft.ids;
    const sources = translationMetaSources(tree, "Progressive Reading");
    const parsed = parseTranslationMetaOutput(
      sources,
      JSON.stringify({
        paperTitle: "渐进式阅读",
        sections: [{ sectionId: ids.intro, title: "1 引言" }],
        rawBlocks: [{ blockId: ids.rawBlock, text: "引用的来源行。" }],
      }),
    );
    const committed = await commitTranslationMeta({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      sources,
      translated: parsed.content,
    });
    expect(committed.translationRevision).toMatch(/^[0-9a-f-]{36}$/);

    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.paperTitle).toEqual({
      status: "ready",
      source: "Progressive Reading",
      content: "渐进式阅读",
    });
    expect(projection.sections).toEqual([
      { sectionId: ids.intro, status: "ready", source: "1 Introduction", content: "1 引言" },
    ]);
    expect(projection.rawBlocks).toEqual([
      { blockId: ids.rawBlock, status: "ready", source: "Quoted source line.", content: "引用的来源行。" },
    ]);
    // 版本化 section 文件存在且被 index 引用；无标题 section 不落盘。
    const index = JSON.parse(
      await fs.readFile(path.join(sidecar(created.root, revision.revisionId, "zh"), "index.json"), "utf8"),
    ) as {
      sections: Array<{ sectionId: string; file: string }>;
    };
    expect(index.sections).toHaveLength(1);
    expect(index.sections[0].file).toMatch(new RegExp(`^sections/${ids.intro}\\.[0-9a-f-]{36}\\.json$`));
    await fs.access(path.join(sidecar(created.root, revision.revisionId, "zh"), index.sections[0].file));
  });

  test("标题 changed 仅标题 stale，正文句 ready 不受影响；raw 文本变化仅 raw stale", async () => {
    const placeholder = randomUUID();
    const draft = metaTree(placeholder);
    const { created, revision } = await metaProject("标题过期工程", draft.tree, "Progressive Reading");
    const tree = { ...draft.tree, paperId: created.manifest.paper.id };
    const ids = draft.ids;
    const sources = translationMetaSources(tree, "Progressive Reading");
    await commitTranslationMeta({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      sources,
      translated: parseTranslationMetaOutput(
        sources,
        JSON.stringify({
          paperTitle: "渐进式阅读",
          sections: [{ sectionId: ids.intro, title: "1 引言" }],
          rawBlocks: [{ blockId: ids.rawBlock, text: "引用的来源行。" }],
        }),
      ).content,
    });
    // 直接改 current 树标题与 raw 文本（模拟修正发布后的读取推导）。
    const changed: DocumentTree = {
      ...tree,
      sections: {
        ...tree.sections,
        [ids.intro]: { ...tree.sections[ids.intro], title: "1 Introduction and Motivation" },
      },
      blocks: tree.blocks.map((block) =>
        block.kind === "raw" ? { ...block, text: "Quoted source line, revised." } : block,
      ),
    };
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    const revisionId = randomUUID();
    const changeset = createDocumentChangeset({
      base: tree,
      current: changed,
      baseRevision: revision.revisionId,
      revisionId,
    });
    const next = (await dispatchCoreCommand({
      type: "coreCommit",
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: revision.sourceSnapshotId,
      revisionId,
      files: {
        "document.json": json(changed),
        "source-base.json": json(changed),
        "tombstones.json": json([]),
        "changeset.json": json(changeset),
      },
      metadata: { normalizationVersion: 1 },
    })) as { revisionId: string };
    const projection = await readTranslationProjection(created.root, next.revisionId, "zh");
    expect(projection.sections).toEqual([
      {
        sectionId: ids.intro,
        status: "stale",
        staleReason: "source-changed",
        source: "1 Introduction and Motivation",
        content: "1 引言",
      },
    ]);
    expect(projection.rawBlocks?.[0].status).toBe("stale");
    expect(projection.paperTitle?.status).toBe("ready");
  });

  test("无标题 section 不进入目标；未提交时标题/raw 投影为 gap，论文标题省略", async () => {
    const placeholder = randomUUID();
    const draft = metaTree(placeholder);
    const { created, revision } = await metaProject("无元数据工程", draft.tree, null);
    const tree = { ...draft.tree, paperId: created.manifest.paper.id };
    const sources = translationMetaSources(tree, null);
    expect(sources.paperTitle).toBeNull();
    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.paperTitle).toBeUndefined();
    expect(projection.sections).toEqual([
      { sectionId: draft.ids.intro, status: "gap", source: "1 Introduction", content: null },
    ]);
    expect(projection.rawBlocks?.[0].status).toBe("gap");
  });
});

test.describe("translation 元数据目标合并、完整性与崩溃窗口", () => {
  const validMeta = (ids: { intro: string; rawBlock: string }) => ({
    paperTitle: "渐进式阅读",
    sections: [{ sectionId: ids.intro, title: "1 引言" }],
    rawBlocks: [{ blockId: ids.rawBlock, text: "引用的来源行。" }],
  });

  test("部分目标提交保留非目标元数据的内容与 generator 事实", async () => {
    const placeholder = randomUUID();
    const draft = metaTree(placeholder);
    const { created, revision } = await metaProject("合并工程", draft.tree, "Progressive Reading");
    const tree = { ...draft.tree, paperId: created.manifest.paper.id };
    const ids = draft.ids;
    const sources = translationMetaSources(tree, "Progressive Reading");
    await commitTranslationMeta({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      sources,
      translated: parseTranslationMetaOutput(sources, JSON.stringify(validMeta(ids))).content,
    });
    // 只提交 raw 目标：标题与论文标题非目标，内容与 generator 必须原样保留。
    const rawOnly = { paperTitle: null, sections: [], rawBlocks: [{ blockId: ids.rawBlock, text: "新译文。" }] };
    const otherGenerator = { ...generator, model: "other-model" };
    await commitTranslationMeta({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator: otherGenerator,
      sources: { paperTitle: null, sections: [], rawBlocks: sources.rawBlocks },
      translated: rawOnly,
    });
    const index = JSON.parse(
      await fs.readFile(path.join(sidecar(created.root, revision.revisionId, "zh"), "index.json"), "utf8"),
    ) as { paperTitle: { content: string; generator: { model: string } }; sections: Array<{ file: string }> };
    expect(index.paperTitle.content).toBe("渐进式阅读");
    expect(index.paperTitle.generator.model).toBe(generator.model);
    const sectionFile = JSON.parse(
      await fs.readFile(path.join(sidecar(created.root, revision.revisionId, "zh"), index.sections[0].file), "utf8"),
    ) as { title: { content: string; generator: { model: string } }; rawBlocks: Array<{ content: string }> };
    expect(sectionFile.title.content).toBe("1 引言");
    expect(sectionFile.title.generator.model).toBe(generator.model);
    expect(sectionFile.rawBlocks[0].content).toBe("新译文。");
  });

  test("schema 合法但译文摘要被篡改：读取明确拒绝，不冒充 ready", async () => {
    const placeholder = randomUUID();
    const draft = metaTree(placeholder);
    const { created, revision } = await metaProject("篡改工程", draft.tree, "Progressive Reading");
    const tree = { ...draft.tree, paperId: created.manifest.paper.id };
    const sources = translationMetaSources(tree, "Progressive Reading");
    await commitTranslationMeta({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      sources,
      translated: parseTranslationMetaOutput(sources, JSON.stringify(validMeta(draft.ids))).content,
    });
    const dir = sidecar(created.root, revision.revisionId, "zh");
    const index = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8")) as {
      sections: Array<{ file: string }>;
    };
    const file = path.join(dir, index.sections[0].file);
    const section = JSON.parse(await fs.readFile(file, "utf8")) as { title: { content: string } };
    section.title.content = "被篡改的标题";
    await fs.writeFile(file, JSON.stringify(section, null, 2) + "\n");
    await expect(readTranslationProjection(created.root, revision.revisionId, "zh")).rejects.toThrow(/摘要不符/);
  });

  test("index 替换前崩溃：旧标题/raw 与旧 index 仍可读，未引用 generation 不发布", async () => {
    const placeholder = randomUUID();
    const draft = metaTree(placeholder);
    const { created, revision } = await metaProject("崩溃工程", draft.tree, "Progressive Reading");
    const tree = { ...draft.tree, paperId: created.manifest.paper.id };
    const sources = translationMetaSources(tree, "Progressive Reading");
    await commitTranslationMeta({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      sources,
      translated: parseTranslationMetaOutput(sources, JSON.stringify(validMeta(draft.ids))).content,
    });
    const before = await readTranslationProjection(created.root, revision.revisionId, "zh");
    await expect(
      commitTranslationMeta({
        root: created.root,
        baseRevision: revision.revisionId,
        language: "zh",
        generator,
        sources,
        translated: { paperTitle: "新标题", sections: [], rawBlocks: [] },
        hooks: {
          beforeIndexReplace: () => {
            throw new Error("受控崩溃：index 替换前");
          },
        },
      }),
    ).rejects.toThrow(/受控崩溃/);
    const after = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(after.translationRevision).toBe(before.translationRevision);
    expect(after.paperTitle?.content).toBe("渐进式阅读");
    expect(after.sections?.[0].content).toBe("1 引言");
  });
});
