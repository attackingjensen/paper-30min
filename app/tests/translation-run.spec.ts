// 翻译任务编排回归（SPEC-translation §1/§4/§6，paper-30min-crd.2/crd.5）：
// 受控模型响应驱动真实工程：按需启动、逐单元原子发布、首轮补试一次、
// 恢复不重复请求、同 revision＋language 单任务、离线重开读取已提交内容。
// crd.5：current 推进停止旧任务、用户停止零新增请求、全失败同会话限次。
import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { commitRevision, createProject, publishSourceSnapshot } from "../src/main/project-core";
import { dispatchCoreCommand } from "../src/main/core-commands";
import { runProjectTranslation, stopTranslationTasks, translationSourceUnits } from "../src/main/translation/run";
import { detectSourceLanguage } from "../src/shared/translation/contracts";
import {
  commitTranslationUnit,
  readTranslationProjection,
  translationSentenceDigests,
} from "../src/main/translation/store";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import { createDocumentChangeset } from "../src/shared/document/changeset";
import { buildReaderProjection } from "../src/shared/reader/projection";
import { defaultAgentSettings } from "../src/shared/contracts";
import type { ModelConfig } from "../src/main/agent-settings";

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-run-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** 两个英文单元的真实树：摘要＋正文段落，各一句。 */
function englishTree(paperId: string) {
  const ids = {
    section: randomUUID(),
    abstract: randomUUID(),
    abstractSentence: randomUUID(),
    body: randomUUID(),
    bodySentence: randomUUID(),
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
        unitIds: [ids.abstract, ids.body],
      },
    },
    units: {
      [ids.abstract]: {
        id: ids.abstract,
        sectionId: ids.section,
        kind: "abstract",
        sentenceIds: [ids.abstractSentence],
      },
      [ids.body]: { id: ids.body, sectionId: ids.section, kind: "paragraph", sentenceIds: [ids.bodySentence] },
    },
    sentences: {
      [ids.abstractSentence]: {
        id: ids.abstractSentence,
        unitId: ids.abstract,
        content: [{ kind: "text", text: "We study progressive reading of scientific papers." }],
      },
      [ids.bodySentence]: {
        id: ids.bodySentence,
        unitId: ids.body,
        content: [{ kind: "text", text: "Translations appear unit by unit while the task runs." }],
      },
    },
    atoms: {},
    blocks: [
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.abstract },
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: ids.body },
    ],
  };
  return { tree: parseDocumentTree(tree, paperId), ids };
}

async function projectWithTree(name: string, tree: DocumentTree) {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
    metadata: { kind: "arxiv", canonicalId: "2401.00001v1" },
  });
  // 树身份必须与工程主论文一致：fixture 的占位 paperId 在此重基。
  const committedTree = parseDocumentTree({ ...tree, paperId: created.manifest.paper.id }, created.manifest.paper.id);
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
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

function modelConfig(baseUrl = "https://example.invalid/v1"): ModelConfig {
  return {
    ...defaultAgentSettings,
    services: [{ id: "default", name: "受控", api: "openai-completions", baseUrl, hasKey: true }],
    models: [
      {
        id: "default",
        serviceId: "default",
        name: "受控翻译",
        model: "controlled-translate",
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

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** 受控模型端点：记录逐单元请求；可挂起指定单元、按单元注入 HTTP 失败。 */
function controlledModelServer(options: { holdUnits?: Map<string, Promise<void>>; failUnits?: Set<string> } = {}) {
  const calls: Array<{ unitId: string; sentenceIds: string[] }> = [];
  const server: Server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    const prompt = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as {
      unit: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
    };
    calls.push({ unitId: prompt.unit.unitId, sentenceIds: prompt.unit.sentences.map((s) => s.sentenceId) });
    const hold = options.holdUnits?.get(prompt.unit.unitId);
    if (hold) await hold;
    if (options.failUnits?.has(prompt.unit.unitId)) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "受控失败" } }));
      return;
    }
    const content = JSON.stringify({
      unitId: prompt.unit.unitId,
      sentences: prompt.unit.sentences.map((sentence) => ({
        sentenceId: sentence.sentenceId,
        content: `译文：${sentence.content}`,
      })),
    });
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

/** 修改一句内容并经生产命令面发布新 current（触发译文迁移）。 */
async function publishChangedSentence(input: {
  root: string;
  baseRevision: string;
  sourceSnapshotId: string;
  tree: DocumentTree;
  sentenceId: string;
}) {
  const next = structuredClone(input.tree);
  next.sentences[input.sentenceId].content = [{ kind: "text", text: "A revised sentence changes the current tree." }];
  const revisionId = randomUUID();
  const changeset = createDocumentChangeset({
    base: input.tree,
    current: next,
    baseRevision: input.baseRevision,
    revisionId,
  });
  const revision = (await dispatchCoreCommand({
    type: "coreCommit",
    root: input.root,
    baseRevision: input.baseRevision,
    sourceSnapshotId: input.sourceSnapshotId,
    revisionId,
    files: {
      "document.json": json(next),
      "source-base.json": json(next),
      "tombstones.json": json([]),
      "changeset.json": json(changeset),
    },
    metadata: { normalizationVersion: 1 },
  })) as { revisionId: string };
  return revision;
}

test.describe("translation 任务编排", () => {
  test("源语言确定性判断：英文正文为 en，中文正文为 zh，无法确定不创建任务", () => {
    const paperId = randomUUID();
    const { tree } = englishTree(paperId);
    expect(detectSourceLanguage(tree)).toBe("en");

    const chinese = structuredClone(tree);
    for (const sentence of Object.values(chinese.sentences))
      sentence.content = [{ kind: "text", text: "我们研究科学论文的渐进阅读，译文按单元逐步出现。" }];
    expect(detectSourceLanguage(chinese)).toBe("zh");

    const tiny = structuredClone(tree);
    for (const sentence of Object.values(tiny.sentences)) sentence.content = [{ kind: "text", text: "Hi." }];
    expect(detectSourceLanguage(tiny)).toBeNull();
  });

  test("翻译源单元覆盖正文、表格单元与图注，按阅读顺序去重", () => {
    const paperId = randomUUID();
    const { tree, ids } = englishTree(paperId);
    const units = translationSourceUnits(tree);
    expect(units.map((unit) => unit.unitId)).toEqual([ids.abstract, ids.body]);
    expect(buildReaderProjection(tree).items.length).toBeGreaterThan(0);
  });

  test("未配置模型时明确报错，不产生部分译文", async () => {
    const paperId = randomUUID();
    const { tree } = englishTree(paperId);
    const { created, revision } = await projectWithTree("无配置", tree);
    await expect(
      runProjectTranslation({
        root: created.root,
        language: "zh",
        config: { ...defaultAgentSettings, keys: {}, unreadableKeys: [] },
      }),
    ).rejects.toThrow(/配置模型/);
    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.translationRevision).toBeNull();
  });

  test("源目标同语言不创建任务；离线重开读取已提交译文", async () => {
    const paperId = randomUUID();
    const { tree, ids } = englishTree(paperId);
    const { created, revision } = await projectWithTree("同语言", tree);
    const same = await runProjectTranslation({ root: created.root, language: "en", config: modelConfig() });
    expect(same).toMatchObject({ status: "skipped", reason: "same-language" });

    // 直接经存储提交一个单元，模拟既往任务成果；重开只读已提交 index。
    const projection = buildReaderProjection(tree);
    const unit = projection.items.find((item) => item.kind === "unit" && item.unitId === ids.abstract);
    if (!unit || unit.kind !== "unit") throw new Error("缺少摘要单元。");
    const sentences = unit.sentences.map((sentence) => ({
      sentenceId: sentence.sentenceId,
      content: [{ kind: "text" as const, text: "我们研究科学论文的渐进阅读。" }],
    }));
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator: { provider: "controlled", model: "m", promptVersion: 1, schemaVersion: 1 },
      unit: { unitId: unit.unitId, sentences },
      digests: translationSentenceDigests(tree, unit, sentences),
    });

    const reopened = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(reopened.units).toHaveLength(1);
    expect(reopened.units[0].sentences[0].status).toBe("ready");
  });

  test("受控模型服务：逐单元渐进发布，首轮失败自动补试一次，恢复不重复请求", async () => {
    const paperId = randomUUID();
    const { tree, ids } = englishTree(paperId);
    const { created, revision } = await projectWithTree("渐进工程", tree);

    const calls: string[] = [];
    const failFirst = new Set<string>([ids.abstract]);
    const indexChecks: number[] = [];
    const sidecarIndex = path.join(
      created.root,
      ".paper30min",
      "revisions",
      revision.revisionId,
      "translations",
      "zh",
      "index.json",
    );
    const server: Server = createServer(async (request, response) => {
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      const userPrompt = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as {
        unit: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
      };
      calls.push(userPrompt.unit.unitId);
      // body 请求到达时，首轮唯一合法单元尚未产生（abstract 首轮失败）；
      // 渐进发布的正向证据由补试请求时的 index 检查承担。
      if (userPrompt.unit.unitId === ids.body) {
        const index = JSON.parse(await fs.readFile(sidecarIndex, "utf8").catch(() => "null"));
        indexChecks.push(index ? index.units.length : 0);
      }
      // 补试请求到达时，body 译文必须已经提交可见。
      if (userPrompt.unit.unitId === ids.abstract && calls.filter((id) => id === ids.abstract).length === 2) {
        const index = JSON.parse(await fs.readFile(sidecarIndex, "utf8"));
        indexChecks.push(index.units.length);
      }
      if (failFirst.has(userPrompt.unit.unitId)) {
        failFirst.delete(userPrompt.unit.unitId);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "受控首轮失败" } }));
        return;
      }
      const content = JSON.stringify({
        unitId: userPrompt.unit.unitId,
        sentences: userPrompt.unit.sentences.map((sentence) => ({
          sentenceId: sentence.sentenceId,
          content: `译文：${sentence.content}`,
        })),
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(result.status).toBe("finished");
      if (result.status !== "finished") throw new Error("任务未完成。");
      expect(result.units.map((unit) => unit.status)).toEqual(["ready", "ready"]);
      // abstract 首轮失败＋补试一次；body 一次成功。补试不重发已保存单元。
      expect(calls).toEqual([ids.abstract, ids.body, ids.abstract]);
      expect(indexChecks).toEqual([0, 1]);
      expect(result.projection.units).toHaveLength(2);
      expect(result.projection.units.every((unit) => unit.sentences.every((s) => s.status === "ready"))).toBe(true);

      // 恢复：全部已提交且摘要一致 → 不再请求模型。
      const before = calls.length;
      const again = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(again).toMatchObject({ status: "skipped", reason: "already-generated" });
      expect(calls.length).toBe(before);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("current 推进停止旧任务：后续单元零请求，补试零请求，已完成结果只经迁移继承", async () => {
    const paperId = randomUUID();
    const { tree, ids } = englishTree(paperId);
    const { created, revision, source, tree: committed } = await projectWithTree("revision推进", tree);
    const bodyHold = Promise.withResolvers<void>();
    const { server, calls } = controlledModelServer({
      holdUnits: new Map([[ids.body, bodyHold.promise]]),
    });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const running = runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      // abstract 合法完成并提交，body 挂起在途。
      await expect
        .poll(async () => {
          const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
          return projection.units.find((unit) => unit.unitId === ids.abstract)?.sentences[0]?.status ?? "gap";
        })
        .toBe("ready");

      // 发布新 current：旧 baseRevision 任务必须停止调度新批次。
      const second = await publishChangedSentence({
        root: created.root,
        baseRevision: revision.revisionId,
        sourceSnapshotId: source.sourceSnapshotId,
        tree: committed,
        sentenceId: ids.bodySentence,
      });
      bodyHold.resolve();
      const result = await running;
      expect(result.status).toBe("finished");
      // 只有挂起前的两个请求；旧任务不重发 body、不补试、不调度新批次。
      expect(calls.map((call) => call.unitId)).toEqual([ids.abstract, ids.body]);

      // 已完成的合法结果留在旧 A 侧车；新 current 只经 changeset 迁移继承。
      const oldSidecar = await readTranslationProjection(created.root, revision.revisionId, "zh");
      expect(oldSidecar.units.find((unit) => unit.unitId === ids.abstract)?.sentences[0].status).toBe("ready");
      const migrated = await readTranslationProjection(created.root, second.revisionId, "zh");
      const byUnit = new Map(migrated.units.map((unit) => [unit.unitId, unit]));
      expect(byUnit.get(ids.abstract)?.sentences[0]).toMatchObject({
        status: "ready",
        content: [{ kind: "text", text: "译文：We study progressive reading of scientific papers." }],
      });
      // 在途被停止的 body 不冒充译文：新 current 下保持 gap，不直写 B。
      expect(byUnit.get(ids.body)?.sentences[0]?.status ?? "gap").toBe("gap");
    } finally {
      bodyHold.resolve();
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("外部 signal 预先 aborted：零请求，不产生译文", async () => {
    const paperId = randomUUID();
    const { tree } = englishTree(paperId);
    const { created, revision } = await projectWithTree("预先取消", tree);
    const { server, calls } = controlledModelServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await runProjectTranslation({
        root: created.root,
        language: "zh",
        config: modelConfig(endpoint),
        signal: controller.signal,
      });
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(0);
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      expect(projection.translationRevision).toBeNull();
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("用户停止：未发送批次零新增请求，合法完成项保留，同指纹不再自动启动，手动补译可发起", async () => {
    const paperId = randomUUID();
    const { tree, ids } = englishTree(paperId);
    const { created, revision } = await projectWithTree("用户停止", tree);
    const bodyHold = Promise.withResolvers<void>();
    const { server, calls } = controlledModelServer({
      holdUnits: new Map([[ids.body, bodyHold.promise]]),
    });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const running = runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      await expect
        .poll(async () => {
          const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
          return projection.units.find((unit) => unit.unitId === ids.abstract)?.sentences[0]?.status ?? "gap";
        })
        .toBe("ready");

      await stopTranslationTasks(created.root, "zh");
      await running;
      const afterStop = calls.length;

      // 停止后再次打开同指纹：不自动启动，零新增请求。
      const reopened = await runProjectTranslation({
        root: created.root,
        language: "zh",
        config: modelConfig(endpoint),
      });
      expect(reopened).toMatchObject({ status: "skipped", reason: "already-generated" });
      expect(calls.length).toBe(afterStop);

      // 合法完成项保留；body 保持 gap。
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      const byUnit = new Map(projection.units.map((unit) => [unit.unitId, unit]));
      expect(byUnit.get(ids.abstract)?.sentences[0].status).toBe("ready");
      expect(byUnit.get(ids.body)?.sentences[0]?.status ?? "gap").toBe("gap");

      // 手动补译缺口不受停止指纹限制。
      bodyHold.resolve();
      const manual = await dispatchCoreCommand(
        { type: "coreTranslationFillGaps", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(manual).toMatchObject({ status: "finished" });
      expect(calls.length).toBeGreaterThan(afterStop);
      const afterManual = await readTranslationProjection(created.root, revision.revisionId, "zh");
      expect(afterManual.units.find((unit) => unit.unitId === ids.body)?.sentences[0].status).toBe("ready");
    } finally {
      bodyHold.resolve();
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("全部单元持续失败：同会话连续两次打开零重复自动请求，手动补译才新增", async () => {
    const paperId = randomUUID();
    const { tree, ids } = englishTree(paperId);
    const { created } = await projectWithTree("全失败限次", tree);
    const { server, calls } = controlledModelServer({ failUnits: new Set([ids.abstract, ids.body]) });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const first = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(first.status).toBe("finished");
      // 每单元首轮一次＋补试一次；没有任何 index 提交。
      expect(calls.filter((call) => call.unitId === ids.abstract)).toHaveLength(2);
      expect(calls.filter((call) => call.unitId === ids.body)).toHaveLength(2);

      const before = calls.length;
      const second = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(second).toMatchObject({ status: "skipped", reason: "already-generated" });
      expect(calls.length).toBe(before);

      const manual = await dispatchCoreCommand(
        { type: "coreTranslationFillGaps", root: created.root, language: "zh" },
        undefined,
        { config: modelConfig(endpoint) },
      );
      expect(manual).toMatchObject({ status: "finished" });
      expect(calls.length).toBe(before + 4);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });
});
