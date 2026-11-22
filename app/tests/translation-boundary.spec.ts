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
import { createTranslationModelSession } from "../src/main/translation/model-request";
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
      unit: { unitId: string; sentences: Array<{ sentenceId: string; content: string }> };
    };
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
    expect(stored.generator.model).toBe("old-model");
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
      promptVersion: 1,
      schemaVersion: 1,
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
});
