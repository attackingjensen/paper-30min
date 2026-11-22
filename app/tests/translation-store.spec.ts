// 翻译原子发布与渐进投影（SPEC-translation §4–5，paper-30min-crd.2）：
// unit 文件先完整写入并核验，再以临时文件＋替换原子推进 index；
// 故障注入覆盖 unit 写入后、index 推进前后的崩溃现场；
// 离线重开只认已提交 index，未引用 staging 不被猜测发布。
import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { commitRevision, createProject, openProject, publishSourceSnapshot } from "../src/main/project-core";
import { buildReaderProjection, type ReaderUnitContent } from "../src/shared/reader/projection";
import type { TranslationGenerator } from "../src/shared/translation/contracts";
import {
  commitTranslationUnit,
  readTranslationProjection,
  translationSentenceDigests,
} from "../src/main/translation/store";
import { testDocumentIds, testDocumentTree, testRevisionFiles } from "./fixtures/document-tree";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256hex = /^[a-f0-9]{64}$/;
const generator: TranslationGenerator = {
  provider: "controlled",
  model: "controlled-translate",
  promptVersion: 1,
  schemaVersion: 1,
};

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-store-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function committedProject(name = "译文工程") {
  const created = await createProject({ parent: sandbox, name });
  const source = await publishSourceSnapshot({
    root: created.root,
    files: { "document.html": Buffer.from("<html>paper</html>") },
    metadata: { kind: "arxiv", canonicalId: "2401.00001v1" },
  });
  const revision = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: source.sourceSnapshotId,
    files: testRevisionFiles(created.manifest.paper.id, "第一版"),
    metadata: { normalizationVersion: 1 },
  });
  const tree = testDocumentTree(created.manifest.paper.id, "第一版");
  const projection = buildReaderProjection(tree);
  const item = projection.items.find((candidate) => candidate.kind === "unit");
  if (!item || item.kind !== "unit") throw new Error("测试投影缺少单元。");
  return { created, revision, tree, unit: item as ReaderUnitContent };
}

/** 合法译文内容：与原句 atom 一一对应（存储层不重做模型校验，只核验摘要）。 */
function translatedContent(unit: ReaderUnitContent, text: string) {
  return unit.sentences.map((sentence) => ({
    sentenceId: sentence.sentenceId,
    content: [
      { kind: "text" as const, text },
      ...sentence.parts.flatMap((part) =>
        part.kind === "atom" ? [{ kind: "atom" as const, atomId: part.atom.id }] : [],
      ),
    ],
  }));
}

const sidecar = (root: string, revisionId: string, language: string) =>
  path.join(root, ".paper30min", "revisions", revisionId, "translations", language);

test.describe("translation 单元原子发布与离线读取", () => {
  test("单元完整写入后原子推进 index，投影按当前原文推导 ready", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "博士 在第一版中仍是一句话。");
    const digests = translationSentenceDigests(tree, unit, sentences);

    const committed = await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences },
      digests,
    });

    expect(committed.translationRevision).toMatch(uuid);
    expect(committed.logicalContentBytes).toBeGreaterThan(0);
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const index = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
    expect(index).toMatchObject({
      formatVersion: 1,
      baseRevision: revision.revisionId,
      language: "zh",
      translationRevision: committed.translationRevision,
    });
    expect(index.units).toHaveLength(1);
    expect(index.units[0]).toMatchObject({
      unitId: unit.unitId,
      file: `units/${unit.unitId}.json`,
      generator,
    });
    expect(index.units[0].sentences[0].sourceSha256).toMatch(sha256hex);
    expect(index.units[0].sentences[0].translationSha256).toMatch(sha256hex);

    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection).toMatchObject({
      baseRevision: revision.revisionId,
      language: "zh",
      translationRevision: committed.translationRevision,
    });
    expect(projection.units).toHaveLength(1);
    expect(projection.units[0].generator).toEqual(generator);
    expect(projection.units[0].sentences).toEqual([
      {
        sentenceId: unit.sentences[0].sentenceId,
        status: "ready",
        content: sentences[0].content,
      },
    ]);
  });

  test("index 推进前崩溃：未引用单元文件不发布，重开无译文且现场不猜测", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "崩溃前的完整单元。");
    const digests = translationSentenceDigests(tree, unit, sentences);
    await expect(
      commitTranslationUnit({
        root: created.root,
        baseRevision: revision.revisionId,
        language: "zh",
        generator,
        unit: { unitId: unit.unitId, sentences },
        digests,
        hooks: {
          beforeIndexReplace: () => {
            throw new Error("受控崩溃：index 推进前");
          },
        },
      }),
    ).rejects.toThrow("受控崩溃");

    // 单元文件已完整落盘，但没有任何 index 引用它。
    const directory = sidecar(created.root, revision.revisionId, "zh");
    await expect(fs.stat(path.join(directory, "units", `${unit.unitId}.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(directory, "index.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // 重开（新的读取路径）不发布未引用文件；残留临时文件不被当作译文。
    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.translationRevision).toBeNull();
    expect(projection.units).toEqual([]);
    const leftovers = await fs.readdir(directory);
    expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("替换已有单元失败时旧译文持续可读，index 与旧内容不变", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const first = translatedContent(unit, "第一版译文。");
    const committed = await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences: first },
      digests: translationSentenceDigests(tree, unit, first),
    });

    const second = translatedContent(unit, "失败的替换译文。");
    await expect(
      commitTranslationUnit({
        root: created.root,
        baseRevision: revision.revisionId,
        language: "zh",
        generator,
        unit: { unitId: unit.unitId, sentences: second },
        digests: translationSentenceDigests(tree, unit, second),
        hooks: {
          beforeIndexReplace: () => {
            throw new Error("受控崩溃：替换 index 前");
          },
        },
      }),
    ).rejects.toThrow("受控崩溃");

    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.translationRevision).toBe(committed.translationRevision);
    expect(projection.units[0].sentences[0]).toMatchObject({ status: "ready", content: first[0].content });
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const unitFile = JSON.parse(await fs.readFile(path.join(directory, "units", `${unit.unitId}.json`), "utf8"));
    expect(unitFile.sentences[0].content).toEqual(first[0].content);
  });

  test("index 已推进后的崩溃仍产生完整可见提交，重开读取一致", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "提交后崩溃的译文。");
    await expect(
      commitTranslationUnit({
        root: created.root,
        baseRevision: revision.revisionId,
        language: "zh",
        generator,
        unit: { unitId: unit.unitId, sentences },
        digests: translationSentenceDigests(tree, unit, sentences),
        hooks: {
          afterIndexReplace: () => {
            throw new Error("受控崩溃：index 推进后");
          },
        },
      }),
    ).rejects.toThrow("受控崩溃");

    // 提交点已经过：重开必须读到完整单元，而不是半篇或空译文。
    const reopened = await openProject(created.root);
    expect(reopened.currentRevision?.revisionId).toBe(revision.revisionId);
    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.translationRevision).toMatch(uuid);
    expect(projection.units[0].sentences[0]).toMatchObject({ status: "ready", content: sentences[0].content });
  });

  test("无已提交 index 时全部原句为 gap，离线重开不触发恢复", async () => {
    const { created, revision, unit } = await committedProject();
    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.translationRevision).toBeNull();
    expect(projection.units).toEqual([]);
    // gap 由投影消费方按原文补齐；存储读取本身不访问网络、不抛错。
    const again = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(again).toEqual(projection);
    expect(unit.sentences.length).toBeGreaterThan(0);
  });

  test("原句内容变化后仅该句投影为 stale，旧译文与摘要保留", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "旧原句的译文。");
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences },
      digests: translationSentenceDigests(tree, unit, sentences),
    });

    // 模拟正文更新：同 ID 原句内容改变（新 revision 的迁移由 crd.3 承担，
    // 这里直接验证读取路径对照当前树的推导）。
    const changedTree = structuredClone(tree);
    const sentenceId = unit.sentences[0].sentenceId;
    changedTree.sentences[sentenceId].content = [
      { kind: "text", text: "A changed sentence about Dr. " },
      { kind: "atom", atomId: testDocumentIds.atom },
      { kind: "text", text: "." },
    ];
    const changedFiles = {
      "document.json": Buffer.from(JSON.stringify(changedTree)),
      "source-base.json": Buffer.from(JSON.stringify(changedTree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: revision.revisionId })),
    };
    const nextRevision = await commitRevision({
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: revision.sourceSnapshotId,
      files: changedFiles,
      metadata: { normalizationVersion: 1 },
    });
    // 迁移前把已提交侧车复制到新 revision 并重基 index（crd.3 之前的最小手工迁移）。
    const target = sidecar(created.root, nextRevision.revisionId, "zh");
    await fs.cp(sidecar(created.root, revision.revisionId, "zh"), target, { recursive: true });
    const migratedIndex = JSON.parse(await fs.readFile(path.join(target, "index.json"), "utf8"));
    migratedIndex.baseRevision = nextRevision.revisionId;
    migratedIndex.translationRevision = randomUUID();
    await fs.writeFile(path.join(target, "index.json"), JSON.stringify(migratedIndex));

    const projection = await readTranslationProjection(created.root, nextRevision.revisionId, "zh");
    expect(projection.units[0].sentences[0]).toEqual({
      sentenceId,
      status: "stale",
      staleReason: "source-changed",
      content: sentences[0].content,
    });
  });

  test("损坏的单元文件使读取明确失败，不以半篇内容冒充投影", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "将被损坏的译文。");
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences },
      digests: translationSentenceDigests(tree, unit, sentences),
    });
    const file = path.join(sidecar(created.root, revision.revisionId, "zh"), "units", `${unit.unitId}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    stored.sentences[0].translationSha256 = "f".repeat(64);
    await fs.writeFile(file, JSON.stringify(stored));

    await expect(readTranslationProjection(created.root, revision.revisionId, "zh")).rejects.toThrow(/摘要|损坏/);
  });

  test("index 引用缺失单元文件时读取失败，不按文件名猜测发布", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "引用将缺失的译文。");
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences },
      digests: translationSentenceDigests(tree, unit, sentences),
    });
    const directory = sidecar(created.root, revision.revisionId, "zh");
    // 未引用的孤立文件不得被发布；被引用文件缺失必须报错。
    await fs.writeFile(path.join(directory, "units", `${randomUUID()}.json`), "{}");
    await fs.rm(path.join(directory, "units", `${unit.unitId}.json`));
    await expect(readTranslationProjection(created.root, revision.revisionId, "zh")).rejects.toThrow();
  });
});
