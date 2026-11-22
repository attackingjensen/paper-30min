// 正文更新后的补译与 stale 更新（SPEC-translation §6/§8，paper-30min-crd.3）：
// 任务只处理 gap，不自动覆盖 ready/stale；显式 stale 更新以句为最小提交；
// 打开缺口按 baseRevision＋language＋model＋gap 指纹每会话最多自动补试一次。
import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { commitRevision, createProject, publishSourceSnapshot } from "../src/main/project-core";
import { dispatchCoreCommand } from "../src/main/core-commands";
import { runProjectTranslation, translationSourceUnits } from "../src/main/translation/run";
import {
  commitTranslationUnit,
  readTranslationProjection,
  translationSentenceDigests,
} from "../src/main/translation/store";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import { appendRemovedTombstones, createDocumentChangeset } from "../src/shared/document/changeset";
import { defaultAgentSettings } from "../src/shared/contracts";
import type { ModelConfig } from "../src/main/agent-settings";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-update-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** 英文工程：unitA 三句（s1 含公式 atom），unitB 单句。 */
function updateTree(paperId: string) {
  const ids = {
    section: randomUUID(),
    unitA: randomUUID(),
    s1: randomUUID(),
    s2: randomUUID(),
    s3: randomUUID(),
    unitB: randomUUID(),
    sB: randomUUID(),
    atom: randomUUID(),
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
    metadata: { kind: "arxiv", canonicalId: "2401.00004v1" },
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

/** 受控模型端点：记录每次请求的单元与句子 ID；可按单元或句子注入失败。 */
function controlledServer(options: { failUnits?: Set<string>; failSentences?: Set<string> } = {}) {
  const calls: Array<{ unitId: string; sentenceIds: string[] }> = [];
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
      content = JSON.stringify({
        paperTitle: prompt.paperTitle == null ? null : `新译：${prompt.paperTitle}`,
        sections: (prompt.sections ?? []).map((s) => ({ sectionId: s.sectionId, title: `新译：${s.title}` })),
        rawBlocks: (prompt.rawBlocks ?? []).map((r) => ({ blockId: r.blockId, text: `新译：${r.text}` })),
      });
    } else {
      calls.push({ unitId: prompt.unit.unitId, sentenceIds: prompt.unit.sentences.map((s) => s.sentenceId) });
      const fail =
        options.failUnits?.has(prompt.unit.unitId) ||
        prompt.unit.sentences.some((sentence) => options.failSentences?.has(sentence.sentenceId));
      if (fail) {
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
  return { server, calls };
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

test.describe("translation 补译缺口与显式 stale 更新", () => {
  test("任务只处理 gap：stale 与 ready 不被自动重译", async () => {
    const paperId = randomUUID();
    const { tree, ids } = updateTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("只补gap", tree);
    const a = await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
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
      const result = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      // unitA 无 gap（s2 stale 不自动处理）；unitB 未翻译 → 只请求 unitB。
      expect(result.status).toBe("finished");
      expect(calls).toEqual([{ unitId: ids.unitB, sentenceIds: [ids.sB] }]);
      const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
      const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      const byId = new Map(unitA.sentences.map((sentence) => [sentence.sentenceId, sentence]));
      expect(byId.get(ids.s2)).toMatchObject({ status: "stale", content: a.sentences[1].content });
      expect(byId.get(ids.s1)!.status).toBe("ready");
      expect(byId.get(ids.s3)!.status).toBe("ready");
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("新增句为 gap：任务只请求新增句，同单元 ready 句不重发", async () => {
    const paperId = randomUUID();
    const { tree, ids } = updateTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("新增补译", tree);
    const a = await translateUnit(created.root, revision.revisionId, committed, ids.unitA);

    // unitA 追加新句（added → gap），其余句 retained。
    const next = structuredClone(committed);
    const added = randomUUID();
    next.sentences[added] = {
      id: added,
      unitId: ids.unitA,
      content: [{ kind: "text", text: "A brand new sentence." }],
    };
    next.units[ids.unitA].sentenceIds = [ids.s1, ids.s2, ids.s3, added];
    const revisionId = randomUUID();
    const changeset = createDocumentChangeset({
      base: committed,
      current: next,
      baseRevision: revision.revisionId,
      revisionId,
    });
    const second = (await dispatchCoreCommand({
      type: "coreCommit",
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: source.sourceSnapshotId,
      revisionId,
      files: {
        "document.json": json(next),
        "source-base.json": json(next),
        "tombstones.json": json([]),
        "changeset.json": json(changeset),
      },
      metadata: { normalizationVersion: 1 },
    })) as { revisionId: string };

    const { server, calls } = controlledServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(result.status).toBe("finished");
      // unitA 只请求新增句；unitB 从未翻译，整单元为 gap 一并补译。
      expect(calls).toEqual([
        { unitId: ids.unitA, sentenceIds: [added] },
        { unitId: ids.unitB, sentenceIds: [ids.sB] },
      ]);
      const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
      const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      const byId = new Map(unitA.sentences.map((sentence) => [sentence.sentenceId, sentence]));
      expect(byId.get(added)!.status).toBe("ready");
      // 既有 ready 句内容与 generator 事实不变。
      expect(byId.get(ids.s1)!.content).toEqual(a.sentences[0].content);
      expect(byId.get(ids.s1)!.generator!.model).toBe("controlled-translate");
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("显式 stale 更新只替换目标句；失败保留旧 stale 译文", async () => {
    const paperId = randomUUID();
    const { tree, ids } = updateTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("stale更新", tree);
    const a = await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    const { revision: second } = await changeS2(
      created.root,
      revision.revisionId,
      source.sourceSnapshotId,
      committed,
      ids.s2,
    );

    // 失败路径：s2 请求失败 → 旧译文继续以 stale 显示，不清空。
    const failing = controlledServer({ failSentences: new Set([ids.s2]) });
    const failEndpoint = await startServer(failing.server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const failed = await dispatchCoreCommand(
        { type: "coreTranslationUpdateStale", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(failEndpoint) },
      );
      expect(failed).toMatchObject({ status: "finished" });
      const afterFail = await readTranslationProjection(created.root, second.revisionId, "zh");
      const unitA = afterFail.units.find((unit) => unit.unitId === ids.unitA)!;
      expect(unitA.sentences.find((sentence) => sentence.sentenceId === ids.s2)).toMatchObject({
        status: "stale",
        content: a.sentences[1].content,
      });

      // 成功路径：只替换 s2；s1/s3 内容不变，generator 更新为本次事实。
      const ok = controlledServer();
      const okEndpoint = await startServer(ok.server);
      try {
        const updated = (await dispatchCoreCommand(
          { type: "coreTranslationUpdateStale", root: created.root, language: "zh" },
          undefined,
          { config: modelConfig(okEndpoint, "controlled-translate-v2") },
        )) as { status: string; units: Array<{ unitId: string; status: string }> };
        expect(updated.status).toBe("finished");
        expect(ok.calls).toEqual([{ unitId: ids.unitA, sentenceIds: [ids.s2] }]);
        const afterOk = await readTranslationProjection(created.root, second.revisionId, "zh");
        const updatedA = afterOk.units.find((unit) => unit.unitId === ids.unitA)!;
        const byId = new Map(updatedA.sentences.map((sentence) => [sentence.sentenceId, sentence]));
        expect(byId.get(ids.s2)!.status).toBe("ready");
        expect(byId.get(ids.s2)!.content).toEqual([{ kind: "text", text: "新译：Results improve rapidly now." }]);
        expect(byId.get(ids.s1)!.content).toEqual(a.sentences[0].content);
        expect(byId.get(ids.s3)!.content).toEqual(a.sentences[2].content);
        // generator 是句级事实：只有重译句更新为 v2，未触碰句保留旧模型。
        expect(byId.get(ids.s2)!.generator!.model).toBe("controlled-translate-v2");
        expect(byId.get(ids.s1)!.generator!.model).toBe("controlled-translate");
        expect(byId.get(ids.s3)!.generator!.model).toBe("controlled-translate");
      } finally {
        await stopServer(ok.server);
      }
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(failing.server);
    }
  });

  test("打开缺口自动补试每会话同指纹最多一次；手动补译可再次发起", async () => {
    const paperId = randomUUID();
    const { tree, ids } = updateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("指纹限次", tree);
    // unitB 未翻译 → gap；unitA 已翻译。
    await translateUnit(created.root, revision.revisionId, committed, ids.unitA);

    const { server, calls } = controlledServer({ failUnits: new Set([ids.unitB]) });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      // 首次打开：首轮＋自动补试一次（共 2 次请求），仍失败保留 gap。
      const first = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(first.status).toBe("finished");
      expect(calls.filter((call) => call.unitId === ids.unitB)).toHaveLength(2);

      // 同会话同指纹再次打开：不再自动请求。
      const before = calls.length;
      const again = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(again).toMatchObject({ status: "skipped", reason: "already-generated" });
      expect(calls.length).toBe(before);

      // 手动补译缺口：显式动作可再次发起（此处仍失败，但请求确实发出）。
      const manual = await dispatchCoreCommand(
        { type: "coreTranslationFillGaps", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(manual).toMatchObject({ status: "finished" });
      expect(calls.length).toBe(before + 2);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("fill-gaps 同 unit 两目标句一成一败：合法句独立推进 index，失败句保留 gap 只补试一次", async () => {
    const paperId = randomUUID();
    const { tree, ids } = updateTree(paperId);
    const { created, revision, tree: committed } = await projectWithTree("句级补译", tree);
    // unitA 已有提交（s1/s2/s3 ready），追加两个新句成为同 unit 的两个 gap 目标。
    const a = await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    const next = structuredClone(committed);
    const goodGap = randomUUID();
    const badGap = randomUUID();
    next.sentences[goodGap] = {
      id: goodGap,
      unitId: ids.unitA,
      content: [{ kind: "text", text: "A good new sentence awaits translation." }],
    };
    next.sentences[badGap] = {
      id: badGap,
      unitId: ids.unitA,
      content: [{ kind: "text", text: "A bad new sentence keeps failing." }],
    };
    next.units[ids.unitA].sentenceIds = [ids.s1, ids.s2, ids.s3, goodGap, badGap];
    const revisionId = randomUUID();
    const changeset = createDocumentChangeset({
      base: committed,
      current: next,
      baseRevision: revision.revisionId,
      revisionId,
    });
    const second = (await dispatchCoreCommand({
      type: "coreCommit",
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: (
        await publishSourceSnapshot({
          root: created.root,
          files: { "document.html": Buffer.from("<html>paper2</html>") },
          metadata: { kind: "arxiv", canonicalId: "2401.00004v2" },
        })
      ).sourceSnapshotId,
      revisionId,
      files: {
        "document.json": json(next),
        "source-base.json": json(next),
        "tombstones.json": json([]),
        "changeset.json": json(changeset),
      },
      metadata: { normalizationVersion: 1 },
    })) as { revisionId: string };

    const { server, calls } = controlledServer({ failSentences: new Set([badGap]) });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = (await dispatchCoreCommand(
        { type: "coreTranslationFillGaps", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(endpoint) },
      )) as {
        status: string;
        units: Array<{ unitId: string; status: string; sentences?: Array<{ sentenceId: string; kind: string }> }>;
      };
      expect(result.status).toBe("finished");
      // 每句独立请求：goodGap 首轮成功；badGap 首轮＋补试一次；unitB 整单元 gap 一并补译。
      expect(calls.filter((call) => call.sentenceIds.includes(goodGap))).toHaveLength(1);
      expect(calls.filter((call) => call.sentenceIds.includes(badGap))).toHaveLength(2);
      // 同 unit 部分成功以句级诊断表达。
      const unitA = result.units.find((unit) => unit.unitId === ids.unitA)!;
      expect(unitA.status).toBe("gap");
      expect(unitA.sentences).toEqual([expect.objectContaining({ sentenceId: badGap })]);

      const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
      const stored = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      const byId = new Map(stored.sentences.map((sentence) => [sentence.sentenceId, sentence]));
      // 合法句单独推进 index；失败句保留 gap；未涉及 ready 句内容不变。
      expect(byId.get(goodGap)!.status).toBe("ready");
      expect(byId.get(badGap)!.status).toBe("gap");
      expect(byId.get(ids.s1)!.content).toEqual(a.sentences[0].content);
      expect(byId.get(ids.s2)!.content).toEqual(a.sentences[1].content);
      expect(byId.get(ids.s3)!.content).toEqual(a.sentences[2].content);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("update-stale 同 unit 两 stale 句一成一败：合法句替换，失败句保留旧 stale", async () => {
    const paperId = randomUUID();
    const { tree, ids } = updateTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("句级stale", tree);
    const a = await translateUnit(created.root, revision.revisionId, committed, ids.unitA);
    // s2 与 s3 同时 changed → 同 unit 两个 stale 目标；s1 retained。
    const next = structuredClone(committed);
    next.sentences[ids.s2].content = [{ kind: "text", text: "Results improve rapidly now." }];
    next.sentences[ids.s3].content = [{ kind: "text", text: "The conclusion changes as well." }];
    const revisionId = randomUUID();
    const changeset = createDocumentChangeset({
      base: committed,
      current: next,
      baseRevision: revision.revisionId,
      revisionId,
    });
    const second = (await dispatchCoreCommand({
      type: "coreCommit",
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: source.sourceSnapshotId,
      revisionId,
      files: {
        "document.json": json(next),
        "source-base.json": json(next),
        "tombstones.json": json([]),
        "changeset.json": json(changeset),
      },
      metadata: { normalizationVersion: 1 },
    })) as { revisionId: string };

    const { server, calls } = controlledServer({ failSentences: new Set([ids.s3]) });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = await dispatchCoreCommand(
        { type: "coreTranslationUpdateStale", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(result).toMatchObject({ status: "finished" });
      // 每句独立请求；失败句只补试一次，不拖累合法句。
      expect(calls.filter((call) => call.sentenceIds.includes(ids.s2))).toHaveLength(1);
      expect(calls.filter((call) => call.sentenceIds.includes(ids.s3))).toHaveLength(2);
      const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
      const stored = projection.units.find((unit) => unit.unitId === ids.unitA)!;
      const byId = new Map(stored.sentences.map((sentence) => [sentence.sentenceId, sentence]));
      expect(byId.get(ids.s2)!.status).toBe("ready");
      expect(byId.get(ids.s2)!.content).toEqual([{ kind: "text", text: "新译：Results improve rapidly now." }]);
      expect(byId.get(ids.s3)).toMatchObject({ status: "stale", content: a.sentences[2].content });
      expect(byId.get(ids.s1)!.content).toEqual(a.sentences[0].content);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });
});
