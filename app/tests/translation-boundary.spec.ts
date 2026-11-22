// 翻译缓存、凭据与机器配置边界（SPEC-translation §9，paper-30min-crd.4）：
// 已提交 index/unit 是当前译文权威；凭据只存在于进程内存与请求 Authorization，
// 不写入侧车、任务记录或模型输入；凭据变更不影响既有译文可读；
// 未实现的模型响应缓存目录损坏/缺失不阻塞读取，也不被猜测发布。
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
import { createTranslationModelSession, TranslationModelRequestError } from "../src/main/translation/model-request";
import { createTranslationModelInput } from "../src/main/translation/model-io";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import { createDocumentChangeset } from "../src/shared/document/changeset";
import { defaultAgentSettings } from "../src/shared/contracts";
import type { ModelConfig } from "../src/main/agent-settings";
import { testDocumentTree, testRevisionFiles } from "./fixtures/document-tree";

const secret = "sk-translation-boundary-secret";
let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-boundary-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

async function committedProject(name: string) {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
    metadata: { kind: "arxiv", canonicalId: "2401.00009v1" },
  });
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "First version"),
    metadata: { normalizationVersion: 1 },
  });
  const tree = testDocumentTree(created.manifest.paper.id, "First version");
  const projection = buildReaderProjection(tree);
  const item = projection.items.find((candidate) => candidate.kind === "unit");
  if (!item || item.kind !== "unit") throw new Error("测试单元不存在。");
  return { created, revision, tree, unit: item as ReaderUnitContent };
}

function modelConfig(baseUrl: string, key = secret): ModelConfig {
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
    keys: { default: key },
    unreadableKeys: [],
    proxy: "direct",
    proxyUrl: "",
  };
}

/** 受控端点：记录 Authorization 与完整请求体；返回合法单句译文。 */
function recordingServer() {
  const requests: Array<{ authorization: string | undefined; body: string }> = [];
  const server: Server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    requests.push({ authorization: request.headers.authorization, body: raw });
    const prompt = JSON.parse(JSON.parse(raw).messages.find((m: { role: string }) => m.role === "user").content) as {
      unit?: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
      paperTitle?: string | null;
      sections?: Array<{ sectionId: string; title: string }>;
      rawBlocks?: Array<{ blockId: string; text: string }>;
    };
    const content = prompt.unit
      ? JSON.stringify({
          unitId: prompt.unit.unitId,
          sentences: prompt.unit.sentences.map((sentence) => ({
            sentenceId: sentence.sentenceId,
            content: `译文：${sentence.content}`,
          })),
        })
      : JSON.stringify({
          paperTitle: prompt.paperTitle == null ? null : `译文：${prompt.paperTitle}`,
          sections: (prompt.sections ?? []).map((s) => ({ sectionId: s.sectionId, title: `译文：${s.title}` })),
          rawBlocks: (prompt.rawBlocks ?? []).map((r) => ({ blockId: r.blockId, text: `译文：${r.text}` })),
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
  return { server, requests };
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

/** 递归收集目录下全部文件内容（侧车＋任务记录）。 */
async function allFileContents(directory: string): Promise<string> {
  let combined = "";
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) combined += await allFileContents(full);
    else combined += await fs.readFile(full, "utf8");
  }
  return combined;
}

test.describe("translation 缓存、凭据与机器配置边界", () => {
  test("任务固定开始时的凭据；密钥只进 Authorization，不写入侧车、任务记录或模型输入", async () => {
    const { created, revision, unit } = await committedProject("凭据边界");
    const { server, requests } = recordingServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const config = modelConfig(endpoint);
      const result = await runProjectTranslation({ root: created.root, language: "zh", config });
      expect(result.status).toBe("finished");
      expect(requests.length).toBeGreaterThan(0);
      // 凭据只出现在请求 Authorization；请求体（模型输入）不含密钥与代理凭据。
      for (const request of requests) {
        expect(request.authorization).toBe(`Bearer ${secret}`);
        expect(request.body).not.toContain(secret);
        expect(request.body).not.toContain("proxy-pass");
      }
      // 侧车与任务记录只保存 generator 事实，不含密钥、代理或机器配置。
      const sidecar = await allFileContents(path.join(created.root, ".paper30min", "revisions"));
      expect(sidecar).not.toContain(secret);
      expect(sidecar).not.toContain("proxy-pass");
      expect(sidecar).not.toContain("proxyUrl");
      expect(sidecar).toContain("controlled-translate");
      const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
      expect(projection.units.find((candidate) => candidate.unitId === unit.unitId)?.sentences[0].status).toBe("ready");
      // 模型输入构造同样不携带凭据字段。
      const input = createTranslationModelInput({
        baseRevision: revision.revisionId,
        modelBudget: { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 },
        sourceLanguage: "en",
        targetLanguage: "zh",
        unit,
      });
      expect(JSON.stringify(input)).not.toContain(secret);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("凭据变更不影响既有译文可读；无密钥配置拒绝新任务但不清空已提交内容", async () => {
    const { created, revision, tree, unit } = await committedProject("凭据变更");
    const sourceUnit = translationSourceUnits(tree).find((candidate) => candidate.unitId === unit.unitId)!;
    const sentences = sourceUnit.sentences.map((sentence) => ({
      sentenceId: sentence.sentenceId,
      content: [
        { kind: "text" as const, text: `既有译文：${sentence.sentenceId.slice(0, 8)}` },
        ...sentence.parts.flatMap((part) =>
          part.kind === "atom" ? [{ kind: "atom" as const, atomId: part.atom.id }] : [],
        ),
      ],
    }));
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator: { provider: "controlled", model: "old-model", promptVersion: 1, schemaVersion: 1 },
      unit: { unitId: unit.unitId, sentences },
      digests: translationSentenceDigests(tree, sourceUnit, sentences),
    });

    // 追加新句并发布新 current：新句为 gap，旧句译文按迁移保留。
    const next = structuredClone(tree);
    const addedId = randomUUID();
    next.sentences[addedId] = {
      id: addedId,
      unitId: unit.unitId,
      content: [{ kind: "text", text: "A newly added sentence awaits translation." }],
    };
    next.units[unit.unitId].sentenceIds.push(addedId);
    const revisionId = randomUUID();
    const changeset = createDocumentChangeset({
      base: tree,
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
          metadata: { kind: "arxiv", canonicalId: "2401.00009v2" },
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

    // 密钥被移除：补译新 gap 显式拒绝，不静默清空；已提交译文离线可读且保留原 generator。
    const config = modelConfig("http://127.0.0.1:1/v1", "");
    await expect(
      dispatchCoreCommand({ type: "coreTranslationFillGaps", root: created.root, language: "zh" }, undefined, {
        config,
      }),
    ).rejects.toThrow(/API 密钥/);
    const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
    const stored = projection.units.find((candidate) => candidate.unitId === unit.unitId)!;
    expect(
      stored.sentences.find((sentence) => sentence.sentenceId === sourceUnit.sentences[0].sentenceId)?.status,
    ).toBe("ready");
    expect(stored.sentences.find((sentence) => sentence.sentenceId === addedId)?.status ?? "gap").toBe("gap");
    expect(
      stored.sentences.find((sentence) => sentence.sentenceId === sourceUnit.sentences[0].sentenceId)?.generator?.model,
    ).toBe("old-model");
  });

  test("模型响应缓存目录缺失或损坏不阻塞已提交译文读取，也不被猜测发布", async () => {
    const { created, revision, unit } = await committedProject("缓存边界");
    const { server } = recordingServer();
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = await runProjectTranslation({ root: created.root, language: "zh", config: modelConfig(endpoint) });
      expect(result.status).toBe("finished");
      const before = await readTranslationProjection(created.root, revision.revisionId, "zh");
      // 可重建缓存不是权威：写入损坏内容后读取仍只认已提交 index/unit。
      const cacheDir = path.join(created.root, ".paper30min", "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, "responses.json"), "{broken");
      const after = await readTranslationProjection(created.root, revision.revisionId, "zh");
      expect(after.translationRevision).toBe(before.translationRevision);
      expect(after.units.find((candidate) => candidate.unitId === unit.unitId)?.sentences[0].status).toBe("ready");
      // 缓存清理不影响已提交译文。
      await fs.rm(cacheDir, { recursive: true, force: true });
      const cleaned = await readTranslationProjection(created.root, revision.revisionId, "zh");
      expect(cleaned.translationRevision).toBe(before.translationRevision);
      expect(cleaned.units.find((candidate) => candidate.unitId === unit.unitId)?.sentences[0].content).toEqual(
        before.units.find((candidate) => candidate.unitId === unit.unitId)?.sentences[0].content,
      );
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("会话创建时固定 provider/model；缺少密钥或不可读密钥显式拒绝", () => {
    const config = modelConfig("https://example.invalid/v1");
    const session = createTranslationModelSession(config);
    expect(session.generator).toEqual({
      provider: "openai-completions",
      model: "controlled-translate",
      promptVersion: 3,
      schemaVersion: 2,
    });
    void session.close();
    expect(() => createTranslationModelSession({ ...config, keys: {} })).toThrow(/API 密钥/);
    expect(() => createTranslationModelSession({ ...config, unreadableKeys: ["default"] })).toThrow(/无法读取/);
    expect(() =>
      createTranslationModelSession({
        ...config,
        services: [{ ...config.services[0], baseUrl: "http://example.invalid/v1" }],
      }),
    ).toThrow(/HTTPS/);
  });

  test("请求失败分类：429 限流、断网、鉴权失败分别记录，诊断不含凭据与原始响应正文", async () => {
    const { created, unit } = await committedProject("失败分类");
    const input = createTranslationModelInput({
      baseRevision: randomUUID(),
      modelBudget: { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 },
      sourceLanguage: "en",
      targetLanguage: "zh",
      unit,
    });
    const rawBody = `受控原始错误正文 ${secret}`;
    const cases: Array<{ status: number; kind: string }> = [
      { status: 429, kind: "rate-limit" },
      { status: 401, kind: "auth" },
      { status: 500, kind: "network" },
    ];
    for (const item of cases) {
      const server: Server = createServer((_request, response) => {
        response.writeHead(item.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: rawBody } }));
      });
      const endpoint = await startServer(server);
      process.env.PAPER30MIN_TEST_WINDOW = "hidden";
      try {
        const session = createTranslationModelSession(modelConfig(endpoint));
        try {
          await expect(session.generate(input)).rejects.toMatchObject({ kind: item.kind });
        } finally {
          await session.close();
        }
      } finally {
        delete process.env.PAPER30MIN_TEST_WINDOW;
        await stopServer(server);
      }
    }
    // 断网：连接拒绝归为 network；诊断与错误对象不含密钥或原始响应正文。
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    const offline = createTranslationModelSession(modelConfig("http://127.0.0.1:1/v1"));
    try {
      let caught: unknown;
      try {
        await offline.generate(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TranslationModelRequestError);
      expect(caught).toMatchObject({ kind: "network" });
      expect((caught as Error).message).not.toContain(secret);
      expect((caught as Error).message).not.toContain(rawBody);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await offline.close();
    }
    // 分类诊断经任务持久化到 task.json：无凭据、无原始服务正文。
    const failing: Server = createServer((_request, response) => {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: rawBody } }));
    });
    const failEndpoint = await startServer(failing);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const result = await runProjectTranslation({
        root: created.root,
        language: "zh",
        config: modelConfig(failEndpoint),
      });
      expect(result.status).toBe("finished");
      if (result.status !== "finished") throw new Error("任务未完成。");
      const taskJson = await fs.readFile(
        path.join(
          created.root,
          ".paper30min",
          "revisions",
          result.projection.baseRevision,
          "translations",
          "zh",
          "task.json",
        ),
        "utf8",
      );
      expect(taskJson).toContain("rate-limit");
      expect(taskJson).not.toContain(secret);
      expect(taskJson).not.toContain(rawBody);
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(failing);
    }
  });

  test("请求超时分类为 timeout：挂起服务不无限等待，诊断可恢复", async () => {
    test.setTimeout(180_000);
    const { unit } = await committedProject("超时分类");
    const input = createTranslationModelInput({
      baseRevision: randomUUID(),
      modelBudget: { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 },
      sourceLanguage: "en",
      targetLanguage: "zh",
      unit,
    });
    // 接受连接但永不响应：请求级超时必须触发并分类为 timeout。
    const server: Server = createServer(() => {});
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const session = createTranslationModelSession(modelConfig(endpoint));
      try {
        await expect(session.generate(input)).rejects.toMatchObject({ kind: "timeout" });
      } finally {
        await session.close();
      }
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("用户取消分类为 aborted：在途请求中止，不冒充网络或配置失败", async () => {
    const { unit } = await committedProject("取消分类");
    const input = createTranslationModelInput({
      baseRevision: randomUUID(),
      modelBudget: { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 },
      sourceLanguage: "en",
      targetLanguage: "zh",
      unit,
    });
    const held = Promise.withResolvers<void>();
    const server: Server = createServer(async () => {
      await held.promise;
    });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const session = createTranslationModelSession(modelConfig(endpoint));
      const controller = new AbortController();
      const pending = session.generate(input, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ kind: "aborted" });
      controller.abort();
      await rejected;
      await session.close();
    } finally {
      held.resolve();
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("流式响应超过 2 MiB 立即断开：不等完整缓冲，后续分块不再接收", async () => {
    const { unit } = await committedProject("流式超限");
    const input = createTranslationModelInput({
      baseRevision: randomUUID(),
      modelBudget: { contextWindow: 128_000, maxTokens: 4096, safetyMarginTokens: 1024 },
      sourceLanguage: "en",
      targetLanguage: "zh",
      unit,
    });
    let chunksSent = 0;
    const gone = Promise.withResolvers<void>();
    let clientGone = false;
    const server: Server = createServer(async (request, response) => {
      for await (const part of request) void part;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.on("close", () => {
        clientGone = true;
        gone.resolve();
      });
      // 每块 256 KiB，共 16 块（4 MiB）：超限后客户端必须立即断开。
      const chunk = "x".repeat(256 * 1024);
      for (let index = 0; index < 16 && !clientGone; index++) {
        const payload = JSON.stringify({
          id: "t",
          object: "chat.completion.chunk",
          model: "controlled-translate",
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
        response.write(`data: ${payload}\n\n`);
        chunksSent++;
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 20);
        await pause.promise;
      }
      if (!clientGone) {
        response.write(
          `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "controlled-translate", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      }
    });
    const endpoint = await startServer(server);
    process.env.PAPER30MIN_TEST_WINDOW = "hidden";
    try {
      const session = createTranslationModelSession(modelConfig(endpoint));
      try {
        await expect(session.generate(input)).rejects.toMatchObject({ kind: "output" });
      } finally {
        await session.close();
      }
      // 2 MiB 上限 ≈ 8 块；服务端远未发完 16 块即被断开（连接关闭可观察）。
      expect(chunksSent).toBeLessThan(16);
      const deadline = Promise.withResolvers<never>();
      const timer = setTimeout(() => deadline.reject(new Error("客户端未断开连接")), 5000);
      try {
        await Promise.race([gone.promise, deadline.promise]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      await stopServer(server);
    }
  });

  test("fixture 门控反向负例：无测试变量拒绝回环 HTTP；有变量仍拒绝非回环 HTTP", () => {
    const config = modelConfig("http://127.0.0.1:9/v1");
    const previous = process.env.PAPER30MIN_TEST_WINDOW;
    try {
      delete process.env.PAPER30MIN_TEST_WINDOW;
      expect(() => createTranslationModelSession(config)).toThrow(/HTTPS/);
      process.env.PAPER30MIN_TEST_WINDOW = "hidden";
      expect(() =>
        createTranslationModelSession({
          ...config,
          services: [{ ...config.services[0], baseUrl: "http://example.invalid/v1" }],
        }),
      ).toThrow(/HTTPS/);
      // 生产 HTTPS 的 userinfo/query/hash 拒绝不受门控影响。
      for (const baseUrl of [
        "https://user:pass@example.invalid/v1",
        "https://example.invalid/v1?key=1",
        "https://example.invalid/v1#frag",
      ]) {
        expect(() =>
          createTranslationModelSession({
            ...config,
            services: [{ ...config.services[0], baseUrl }],
          }),
        ).toThrow(/HTTPS/);
      }
    } finally {
      if (previous === undefined) delete process.env.PAPER30MIN_TEST_WINDOW;
      else process.env.PAPER30MIN_TEST_WINDOW = previous;
    }
  });
});
