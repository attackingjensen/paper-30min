// 单元/全文强制重译（SPEC-translation §8.4–8.6，paper-30min-crd.8）：
// coreTranslationRetranslate 显式区分 unit/full；逐单元原子替换（含 ready/stale），
// 失败单元保留旧译文不制造新 gap；generator 是句级事实，未触碰单元保留旧模型。
import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { commitRevision, createProject, publishSourceSnapshot } from "../src/main/project-core";
import { dispatchCoreCommand } from "../src/main/core-commands";
import { runProjectTranslation, stopTranslationTasks, translationSourceUnits } from "../src/main/translation/run";
import {
  commitTranslationMeta,
  commitTranslationUnit,
  readPaperTitle,
  readTranslationProjection,
  translationMetaSources,
  readTranslationTaskRecord,
  translationSentenceDigests,
} from "../src/main/translation/store";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import { appendRemovedTombstones, createDocumentChangeset } from "../src/shared/document/changeset";
import { defaultAgentSettings } from "../src/shared/contracts";
import type { ModelConfig } from "../src/main/agent-settings";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-retranslate-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** 英文工程：unitA 三句（s1 含公式 atom），unitB 单句，section 带标题与 raw block。 */
function retranslateTree(paperId: string) {
  const ids = {
    section: randomUUID(),
    unitA: randomUUID(),
    s1: randomUUID(),
    s2: randomUUID(),
    s3: randomUUID(),
    unitB: randomUUID(),
    sB: randomUUID(),
    atom: randomUUID(),
    rawBlock: randomUUID(),
  };
  const tree: DocumentTree = {
    documentFormatVersion: 1,
    paperId,
    sections: {
      [ids.section]: {
        id: ids.section,
        parentSectionId: null,
        title: "1 Introduction",
        childSectionIds: [],
        unitIds: [ids.unitA, ids.unitB],
      },
    },
    units: {
      [ids.unitA]: { id: ids.unitA, sectionId: ids.section, kind: "paragraph", sentenceIds: [ids.s1, ids.s2, ids.s3] },
      [ids.unitB]: { id: ids.unitB, sectionId: ids.section, kind: "paragraph", sentenceIds: [ids.sB] },
    },
    sentences: {
      [ids.s1]: {
        id: ids.s1,
        unitId: ids.unitA,
        content: [
          { kind: "text", text: "Energy stays " },
          { kind: "atom", atomId: ids.atom },
          { kind: "text", text: " in this study." },
        ],
      },
      [ids.s2]: { id: ids.s2, unitId: ids.unitA, content: [{ kind: "text", text: "Results improve steadily." }] },
      [ids.s3]: { id: ids.s3, unitId: ids.unitA, content: [{ kind: "text", text: "The conclusion follows here." }] },
      [ids.sB]: { id: ids.sB, unitId: ids.unitB, content: [{ kind: "text", text: "A second paragraph closes." }] },
    },
    atoms: {
      [ids.atom]: {
        id: ids.atom,
        unitId: ids.unitA,
        kind: "math",
        text: "$E=mc^2$",
        source: { format: "latex", value: "E=mc^2" },
      },
    },
    blocks: [
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.unitA },
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.unitB },
      {
        id: ids.rawBlock,
        sectionId: ids.section,
        kind: "raw",
        html: "<blockquote><p>Quoted <strong>source</strong> line.</p></blockquote>",
        text: "Quoted source line.",
        limitations: ["复杂排版按白名单投影，交互结构未保留。"],
      },
    ],
  };
  return { tree: parseDocumentTree(tree, paperId), ids };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

async function projectWithTree(name: string, tree: DocumentTree) {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
    metadata: { kind: "arxiv", canonicalId: "2401.00005v1", title: "Retranslation Study" },
  });
  const committedTree = parseDocumentTree({ ...tree, paperId: created.manifest.paper.id }, created.manifest.paper.id);
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
  return { created, revision, source, tree: committedTree };
}

async function translateUnit(root: string, baseRevision: string, tree: DocumentTree, unitId: string) {
  const unit = translationSourceUnits(tree).find((candidate) => candidate.unitId === unitId);
  if (!unit) throw new Error("测试单元不存在。");
  const sentences = unit.sentences.map((sentence) => ({
    sentenceId: sentence.sentenceId,
    content: [
      { kind: "text" as const, text: `旧译：${sentence.sentenceId.slice(0, 8)}` },
      ...sentence.parts.flatMap((part) =>
        part.kind === "atom" ? [{ kind: "atom" as const, atomId: part.atom.id }] : [],
      ),
    ],
  }));
  const committed = await commitTranslationUnit({
    root,
    baseRevision,
    language: "zh",
    generator: { provider: "controlled", model: "controlled-translate", promptVersion: 1, schemaVersion: 1 },
    unit: { unitId, sentences },
    digests: translationSentenceDigests(tree, unit, sentences),
  });
  return { sentences, committed };
}

/** 提交论文标题、section 标题与 raw block 的旧译文（句级 generator 事实为旧模型）。 */
async function translateMeta(root: string, baseRevision: string, tree: DocumentTree) {
  const sources = translationMetaSources(tree, await readPaperTitle(root, baseRevision));
  const translated = {
    paperTitle: sources.paperTitle === null ? null : `旧译：${sources.paperTitle}`,
    sections: sources.sections.map((section) => ({ sectionId: section.sectionId, title: `旧译：${section.title}` })),
    rawBlocks: sources.rawBlocks.map((raw) => ({ blockId: raw.blockId, text: `旧译：${raw.text}` })),
  };
  await commitTranslationMeta({
    root,
    baseRevision,
    language: "zh",
    generator: { provider: "controlled", model: "controlled-translate", promptVersion: 1, schemaVersion: 1 },
    sources,
    translated,
  });
  return { sources, translated };
}

/** 修改 s2 内容并发布新 current（经生产命令面，触发迁移）。 */
async function changeS2(root: string, baseRevision: string, sourceSnapshotId: string, tree: DocumentTree, s2: string) {
  const next = structuredClone(tree);
  next.sentences[s2].content = [{ kind: "text", text: "Results improve rapidly now." }];
  const paperId = tree.paperId;
  const revisionId = randomUUID();
  const changeset = createDocumentChangeset({ base: tree, current: next, baseRevision, revisionId });
  const tombstones = appendRemovedTombstones(tree, changeset, []);
  const revision = (await dispatchCoreCommand({
    type: "coreCommit",
    root,
    baseRevision,
    sourceSnapshotId,
    revisionId,
    files: {
      "document.json": json({ ...next, paperId }),
      "source-base.json": json({ ...next, paperId }),
      "tombstones.json": json(tombstones),
      "changeset.json": json(changeset),
    },
    metadata: { normalizationVersion: 1 },
  })) as { revisionId: string };
  return { revision, next: { ...next, paperId } };
}

function modelConfig(baseUrl: string, model = "controlled-translate"): ModelConfig {
  return {
    ...defaultAgentSettings,
    services: [{ id: "default", name: "受控", api: "openai-completions", baseUrl, hasKey: true }],
    models: [
      {
        id: "default",
        serviceId: "default",
        name: "受控翻译",
        model,
        contextWindow: 128_000,
        maxTokens: 4096,
        availableThinking: ["off"],
        thinking: "off",
      },
    ],
    keys: { default: "controlled-key" },
    unreadableKeys: [],
  };
}

/** 受控模型端点：记录每次请求的单元与句子 ID；可按单元注入失败。 */
function controlledServer(options: { failUnits?: Set<string>; holdUnit?: Map<string, Promise<void>> } = {}) {
  const calls: Array<{ unitId: string; sentenceIds: string[] }> = [];
  const metaCalls: Array<{ paperTitle: string | null; sectionIds: string[]; rawBlockIds: string[] }> = [];
  const server: Server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const prompt = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as {
      unit?: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
      paperTitle?: string | null;
      sections?: Array<{ sectionId: string; title: string }>;
      rawBlocks?: Array<{ blockId: string; text: string }>;
    };
    let content: string;
    if (!prompt.unit) {
      metaCalls.push({
        paperTitle: prompt.paperTitle ?? null,
        sectionIds: (prompt.sections ?? []).map((section) => section.sectionId),
        rawBlockIds: (prompt.rawBlocks ?? []).map((raw) => raw.blockId),
      });
      content = JSON.stringify({
        paperTitle: prompt.paperTitle == null ? null : `新译：${prompt.paperTitle}`,
        sections: (prompt.sections ?? []).map((section) => ({
          sectionId: section.sectionId,
          title: `新译：${section.title}`,
        })),
        rawBlocks: (prompt.rawBlocks ?? []).map((raw) => ({ blockId: raw.blockId, text: `新译：${raw.text}` })),
      });
    } else {
      calls.push({ unitId: prompt.unit.unitId, sentenceIds: prompt.unit.sentences.map((s) => s.sentenceId) });
      const unitHold = options.holdUnit?.get(prompt.unit.unitId);
      if (unitHold) await unitHold;
      if (options.failUnits?.has(prompt.unit.unitId)) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "受控失败" } }));
        return;
      }
      content = JSON.stringify({
        unitId: prompt.unit.unitId,
        sentences: prompt.unit.sentences.map((sentence) => ({
          sentenceId: sentence.sentenceId,
          content: `新译：${sentence.content}`,
        })),
      });
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  return { server, calls, metaCalls };
}

async function startServer(server: Server) {
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function stopServer(server: Server) {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}

test.describe("translation 强制重译 unit/full", () => {
  test("unit 重译整单元原子替换 ready（含 atom）与其 section 元数据，不触碰其他单元", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("unit重译", tree);
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    const b = await translateUnit(created.root, revision.revisionId, committed, ids.unitB);
    await translateMeta(created.root, revision.revisionId, committed);

    const { server, calls, metaCalls } = controlledServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = (await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "unit", unitId: ids.unitA },
          expectedBaseRevision: revision.revisionId,
        },
        undefined,
        { config: modelConfig(endpoint, "controlled-translate-v2") },
      )) as { status: string; units: Array<{ unitId: string; status: string }> };
      expect(result.status).toBe("finished");
      expect(result.units).toEqual([{ status: "ready", unitId: ids.unitA, committed: false }]);
      // ready 不被跳过：整单元三句一次请求（unit 原子）；meta 覆盖论文标题与该 section。
      expect(calls).toEqual([{ unitId: ids.unitA, sentenceIds: [ids.s1, ids.s2, ids.s3] }]);
      expect(metaCalls).toEqual([
        { paperTitle: "Retranslation Study", sectionIds: [ids.section], rawBlockIds: [ids.rawBlock] },
      ]);
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      const byId = new Map(unitA.sentences.map((sentence) => [sentence.sentenceId, sentence]));
      expect(byId.get(ids.s1)!.status).toBe("ready");
      expect(byId.get(ids.s1)!.content).toEqual([
        { kind: "text", text: "新译：Energy stays " },
        { kind: "atom", atomId: ids.atom },
        { kind: "text", text: " in this study." },
      ]);
      // 未触碰单元保留旧内容与旧 generator；本 section 元数据随单元重译更新（句级事实可追溯）。
      const unitB = projection.units.find((unit) => unit.unitId === ids.unitB)!;
      expect(unitB.sentences[0].content).toEqual(b.sentences[0].content);
      expect(unitB.sentences[0].generator!.model).toBe("controlled-translate");
      expect(projection.paperTitle!.content).toBe("新译：Retranslation Study");
      expect(projection.sections![0].content).toBe("新译：1 Introduction");
      expect(projection.rawBlocks![0].content).toBe("新译：Quoted source line.");
      // 元数据 generator 事实存于 index/section 文件：重译目标更新为本次模型。
      const sidecar = path.join(created.root, ".paper30min", "revisions", revision.revisionId, "translations", "zh");
      const index = JSON.parse(await fs.readFile(path.join(sidecar, "index.json"), "utf8")) as {
        paperTitle: { generator: { model: string } };
        sections: Array<{ file: string }>;
      };
      expect(index.paperTitle.generator.model).toBe("controlled-translate-v2");
      const sectionFile = JSON.parse(await fs.readFile(path.join(sidecar, index.sections[0].file), "utf8")) as {
        title: { generator: { model: string } };
        rawBlocks: Array<{ generator: { model: string } }>;
      };
      expect(sectionFile.title.generator.model).toBe("controlled-translate-v2");
      expect(sectionFile.rawBlocks[0].generator.model).toBe("controlled-translate-v2");
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("unit 重译失败保留旧 ready，不制造新 gap，诊断可行动", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("unit重译失败", tree);
    const a = await translateUnit(created.root, revision.revisionId, committed, ids.unitA);

    const { server, calls } = controlledServer({ failUnits: new Set([ids.unitA]) });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = (await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "unit", unitId: ids.unitA },
          expectedBaseRevision: revision.revisionId,
        },
        undefined,
        { config: modelConfig(endpoint) },
      )) as { status: string; units: Array<{ unitId: string; status: string; diagnostic?: string }> };
      expect(result.status).toBe("finished");
      expect(result.units[0]).toMatchObject({ status: "gap", unitId: ids.unitA });
      expect(result.units[0].diagnostic).toBeTruthy();
      // 首轮＋自动补试一次都失败，旧译文不被删除。
      expect(calls).toHaveLength(2);
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      expect(unitA.sentences.map((sentence) => sentence.status)).toEqual(["ready", "ready", "ready"]);
      expect(unitA.sentences.map((sentence) => sentence.content)).toEqual(a.sentences.map((s) => s.content));
      expect(unitA.sentences[0].generator!.model).toBe("controlled-translate");
      expect(projection.task!.gaps.some((gap) => gap.unitId === ids.unitA)).toBe(true);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("unit 重译覆盖同单元 stale 句为当前原文 ready，其他句一并原子替换", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("unit重译stale", tree);
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    const { revision: second } = await changeS2(
      created.root,
      revision.revisionId,
      source.sourceSnapshotId,
      committed,
      ids.s2,
    );

    const { server, calls } = controlledServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "unit", unitId: ids.unitA },
          expectedBaseRevision: second.revisionId,
        },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(result).toMatchObject({ status: "finished" });
      expect(calls).toEqual([{ unitId: ids.unitA, sentenceIds: [ids.s1, ids.s2, ids.s3] }]);
      const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
      const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      const byId = new Map(unitA.sentences.map((sentence) => [sentence.sentenceId, sentence]));
      expect(byId.get(ids.s2)).toMatchObject({
        status: "ready",
        content: [{ kind: "text", text: "新译：Results improve rapidly now." }],
      });
      expect(byId.get(ids.s1)!.status).toBe("ready");
      expect(byId.get(ids.s3)!.status).toBe("ready");
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("full 重译替换全部单元与元数据；部分单元失败保留旧 ready，generator 句级可追溯", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("full重译", tree);
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    const b = await translateUnit(created.root, revision.revisionId, committed, ids.unitB);
    await translateMeta(created.root, revision.revisionId, committed);

    const { server, calls, metaCalls } = controlledServer({ failUnits: new Set([ids.unitB]) });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = (await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "full" },
          expectedBaseRevision: revision.revisionId,
        },
        undefined,
        { config: modelConfig(endpoint, "controlled-translate-v2") },
      )) as { status: string; units: Array<{ unitId: string; status: string }> };
      expect(result.status).toBe("finished");
      expect(result.units).toContainEqual({ status: "ready", unitId: ids.unitA, committed: false });
      expect(result.units.find((unit) => unit.unitId === ids.unitB)).toMatchObject({ status: "gap" });
      // 全部单元整单元请求（unitB 首轮＋自动补试一次），meta 一次覆盖全部目标。
      expect(calls).toEqual([
        { unitId: ids.unitA, sentenceIds: [ids.s1, ids.s2, ids.s3] },
        { unitId: ids.unitB, sentenceIds: [ids.sB] },
        { unitId: ids.unitB, sentenceIds: [ids.sB] },
      ]);
      expect(metaCalls).toEqual([
        {
          paperTitle: "Retranslation Study",
          sectionIds: [ids.section],
          rawBlockIds: [ids.rawBlock],
        },
      ]);
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      expect(unitA.sentences.every((sentence) => sentence.status === "ready")).toBe(true);
      expect(unitA.sentences.every((sentence) => sentence.generator!.model === "controlled-translate-v2")).toBe(true);
      // 失败单元：旧 ready 保留、旧 generator 保留，不制造新 gap。
      const unitB = projection.units.find((unit) => unit.unitId === ids.unitB)!;
      expect(unitB.sentences[0].status).toBe("ready");
      expect(unitB.sentences[0].content).toEqual(b.sentences[0].content);
      expect(unitB.sentences[0].generator!.model).toBe("controlled-translate");
      // meta 成功：内容更新为本次译文（generator 事实存于 index/section 文件）。
      expect(projection.paperTitle!.content).toBe("新译：Retranslation Study");
      expect(projection.sections![0].content).toBe("新译：1 Introduction");
      expect(projection.rawBlocks![0].content).toBe("新译：Quoted source line.");
      const sidecar = path.join(created.root, ".paper30min", "revisions", revision.revisionId, "translations", "zh");
      const index = JSON.parse(await fs.readFile(path.join(sidecar, "index.json"), "utf8")) as {
        paperTitle: { generator: { model: string } };
        sections: Array<{ file: string }>;
      };
      expect(index.paperTitle.generator.model).toBe("controlled-translate-v2");
      const sectionFile = JSON.parse(await fs.readFile(path.join(sidecar, index.sections[0].file), "utf8")) as {
        title: { generator: { model: string } };
        rawBlocks: Array<{ generator: { model: string } }>;
      };
      expect(sectionFile.title.generator.model).toBe("controlled-translate-v2");
      expect(sectionFile.rawBlocks[0].generator.model).toBe("controlled-translate-v2");
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("重译不受自动补试指纹限制，也不擦除既有停止指纹", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("重译指纹", tree);
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    // unitB 从未翻译 → generate 首轮＋补试失败后登记停止指纹。
    const failing = controlledServer({ failUnits: new Set([ids.unitB]) });
    const failEndpoint = await startServer(failing.server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const first = await dispatchCoreCommand(
        { type: "coreTranslationStart", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(failEndpoint) },
      );
      expect(first).toMatchObject({ status: "finished" });
      const before = failing.calls.length;
      const again = await dispatchCoreCommand(
        { type: "coreTranslationStart", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(failEndpoint) },
      );
      expect(again).toMatchObject({ status: "skipped", reason: "already-generated" });
      expect(failing.calls.length).toBe(before);
    } finally {
      await stopServer(failing.server);
    }

    const ok = controlledServer();
    const okEndpoint = await startServer(ok.server);
    try {
      // unit 重译显式发起：即使同指纹 generate 已被限制，重译仍真实请求。
      const unitResult = await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "unit", unitId: ids.unitB },
          expectedBaseRevision: revision.revisionId,
        },
        undefined,
        { config: modelConfig(okEndpoint) },
      );
      expect(unitResult).toMatchObject({ status: "finished" });
      expect(ok.calls).toEqual([{ unitId: ids.unitB, sentenceIds: [ids.sB] }]);
      // full 重译同样不受限：ready 的 unitA 也被重新请求；unitB 同模型同输入命中
      // 可重建响应缓存（SPEC §9），不重复访问模型，但译文仍整单元替换。
      const fullResult = await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "full" },
          expectedBaseRevision: revision.revisionId,
        },
        undefined,
        { config: modelConfig(okEndpoint) },
      );
      expect(fullResult).toMatchObject({ status: "finished" });
      expect(ok.calls.slice(1)).toEqual([{ unitId: ids.unitA, sentenceIds: [ids.s1, ids.s2, ids.s3] }]);
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      const unitB = projection.units.find((unit) => unit.unitId === ids.unitB)!;
      expect(unitB.sentences[0]).toMatchObject({
        status: "ready",
        content: [{ kind: "text", text: "新译：A second paragraph closes." }],
      });
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(ok.server);
    }
  });

  test("retranslate 缺少显式范围时拒绝，不退化为 gap 补译", async () => {
    const paperId = randomUUID();
    const { tree } = retranslateTree(paperId);
    const { created, revision } = await projectWithTree("重译范围守卫", tree);
    await expect(
      runProjectTranslation({
        root: created.root,
        language: "zh",
        config: modelConfig("http://127.0.0.1:9/v1"),
        mode: "retranslate",
        expectedBaseRevision: revision.revisionId,
      }),
    ).rejects.toThrow("强制重译必须指定 unit 或 full 范围。");
  });

  test("expectedBaseRevision 与 current 不符：拒绝重译，零请求", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("重译revision守卫", tree);
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    const { revision: second } = await changeS2(
      created.root,
      revision.revisionId,
      source.sourceSnapshotId,
      committed,
      ids.s2,
    );
    const { server, calls, metaCalls } = controlledServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      // 确认时的旧 revision 已不是 current：拒绝，不产生任何模型请求。
      const stale = await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "full" },
          expectedBaseRevision: revision.revisionId,
        },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(stale).toMatchObject({ status: "skipped", reason: "revision-changed" });
      expect(calls).toEqual([]);
      expect(metaCalls).toEqual([]);
      // 按新 current 重新确认后正常执行。
      const fresh = await dispatchCoreCommand(
        {
          type: "coreTranslationRetranslate",
          root: created.root,
          language: "zh",
          scope: { kind: "unit", unitId: ids.unitA },
          expectedBaseRevision: second.revisionId,
        },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(fresh).toMatchObject({ status: "finished" });
      expect(calls).toHaveLength(1);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("畸形 scope 在命令边界拒绝：零请求，不退化为标题重译", async () => {
    const paperId = randomUUID();
    const { tree } = retranslateTree(paperId);
    const { created, revision } = await projectWithTree("重译畸形scope", tree);
    const { server, calls, metaCalls } = controlledServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      for (const scope of [{ kind: "chapter" }, { kind: "unit" }, { kind: "unit", unitId: "" }, null]) {
        await expect(
          dispatchCoreCommand(
            {
              type: "coreTranslationRetranslate",
              root: created.root,
              language: "zh",
              scope,
              expectedBaseRevision: revision.revisionId,
            } as never,
            undefined,
            { config: modelConfig(endpoint) },
          ),
        ).rejects.toThrow("重译范围无效");
      }
      expect(calls).toEqual([]);
      expect(metaCalls).toEqual([]);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("停止在途重译：不登记新指纹，既有停止指纹与任务记录保留", async () => {
    const paperId = randomUUID();
    const { tree, ids } = retranslateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("重译停止指纹", tree);
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    // unitB 从未翻译：generate 首轮＋补试失败后登记停止指纹。
    const failing = controlledServer({ failUnits: new Set([ids.unitB]) });
    const failEndpoint = await startServer(failing.server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      await dispatchCoreCommand({ type: "coreTranslationStart", root: created.root, language: "zh" }, undefined, {
        config: modelConfig(failEndpoint),
      });
      const recordBefore = await readTranslationTaskRecord(created.root, revision.revisionId, "zh");
      expect(recordBefore?.autoAttemptFingerprint).toBeTruthy();
      await stopServer(failing.server);

      // 在途 full 重译（unitA 门控挂起，unitB 尚未调度）时用户停止：不得覆盖既有指纹。
      const hold = Promise.withResolvers<void>();
      const held = controlledServer({ holdUnit: new Map([[ids.unitA, hold.promise]]) });
      const heldEndpoint = await startServer(held.server);
      try {
        const running = runProjectTranslation({
          root: created.root,
          language: "zh",
          config: modelConfig(heldEndpoint),
          mode: "retranslate",
          scope: { kind: "full" },
          expectedBaseRevision: revision.revisionId,
        });
        await expect.poll(() => held.calls.length, { timeout: 15000 }).toBeGreaterThan(0);
        const stopped = stopTranslationTasks(created.root, "zh");
        hold.resolve();
        await Promise.all([running, stopped]);
        const recordAfter = await readTranslationTaskRecord(created.root, revision.revisionId, "zh");
        expect(recordAfter?.autoAttemptFingerprint).toBe(recordBefore!.autoAttemptFingerprint);
        // 同指纹 generate 仍受原停止指纹限制（未被擦除，也未新增限制）。
        const before = held.calls.length;
        const again = await runProjectTranslation({
          root: created.root,
          language: "zh",
          config: modelConfig(heldEndpoint),
        });
        expect(again).toMatchObject({ status: "skipped", reason: "already-generated" });
        expect(held.calls.length).toBe(before);
      } finally {
        hold.resolve();
        await stopServer(held.server);
      }
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(failing.server).catch(() => undefined);
    }
  });
});
