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
import { sentenceSourceDigest } from "../src/main/translation/store";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
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
    expect(index.units[0]).toMatchObject({ unitId: unit.unitId });
    expect(index.units[0].generator).toBeUndefined();
    expect(index.units[0].file).toMatch(
      new RegExp(`^units/${unit.unitId}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`),
    );
    expect(index.units[0].sentences[0].generator).toEqual(generator);
    expect(index.units[0].sentences[0].sourceSha256).toMatch(sha256hex);
    expect(index.units[0].sentences[0].translationSha256).toMatch(sha256hex);

    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection).toMatchObject({
      baseRevision: revision.revisionId,
      language: "zh",
      translationRevision: committed.translationRevision,
    });
    expect(projection.units).toHaveLength(1);
    expect(projection.units[0].sentences).toEqual([
      {
        sentenceId: unit.sentences[0].sentenceId,
        status: "ready",
        content: sentences[0].content,
        sourceSha256: digests[0].sourceSha256,
        translationSha256: digests[0].translationSha256,
        generator,
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

    // 单元文件已完整落盘（版本化文件名），但没有任何 index 引用它。
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const unitNames = await fs.readdir(path.join(directory, "units"));
    expect(unitNames.filter((name) => name.startsWith(`${unit.unitId}.`))).toHaveLength(1);
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
    const oldIndex = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
    const unitFile = JSON.parse(await fs.readFile(path.join(directory, oldIndex.units[0].file), "utf8"));
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
    const digests = translationSentenceDigests(tree, unit, sentences);
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences },
      digests,
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
      sourceSha256: digests[0].sourceSha256,
      translationSha256: digests[0].translationSha256,
      generator,
      atoms: [tree.atoms[testDocumentIds.atom]],
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
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const storedIndex = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
    const file = path.join(directory, storedIndex.units[0].file);
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
    const storedIndex = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
    // 未引用的孤立文件不得被发布；被引用文件缺失必须报错。
    await fs.writeFile(path.join(directory, "units", `${randomUUID()}.json`), "{}");
    await fs.rm(path.join(directory, storedIndex.units[0].file));
    await expect(readTranslationProjection(created.root, revision.revisionId, "zh")).rejects.toThrow();
  });

  test("新 unit 已落盘、index rename 失败：旧 index 与旧 unit 字节持续可读", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const first = translatedContent(unit, "崩溃窗口前的旧译文。");
    const committed = await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences: first },
      digests: translationSentenceDigests(tree, unit, first),
    });
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const oldIndexBytes = await fs.readFile(path.join(directory, "index.json"));
    const oldIndex = JSON.parse(oldIndexBytes.toString("utf8"));
    const oldUnitBytes = await fs.readFile(path.join(directory, oldIndex.units[0].file));

    const second = translatedContent(unit, "崩溃窗口中的新译文。");
    await expect(
      commitTranslationUnit({
        root: created.root,
        baseRevision: revision.revisionId,
        language: "zh",
        generator,
        unit: { unitId: unit.unitId, sentences: second },
        digests: translationSentenceDigests(tree, unit, second),
        hooks: {
          // 新 unit 已完整落盘并核验，index 替换这一步失败／崩溃。
          beforeIndexReplace: () => {
            throw new Error("受控崩溃：新 unit 落盘后 index 替换失败");
          },
        },
      }),
    ).rejects.toThrow("受控崩溃");

    // 旧 index 与旧 unit 文件字节原样保留；新 unit 只是未引用残留。
    expect(await fs.readFile(path.join(directory, "index.json"))).toEqual(oldIndexBytes);
    expect(await fs.readFile(path.join(directory, oldIndex.units[0].file))).toEqual(oldUnitBytes);
    const projection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(projection.translationRevision).toBe(committed.translationRevision);
    expect(projection.units[0].sentences[0]).toMatchObject({ status: "ready", content: first[0].content });
    const unitNames = await fs.readdir(path.join(directory, "units"));
    expect(unitNames.filter((name) => name.startsWith(`${unit.unitId}.`)).length).toBeGreaterThanOrEqual(2);
  });

  test("迟到提交在写锁内复核 current：明确拒绝，不写旧侧车、不报成功", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const first = translatedContent(unit, "锁内复核前的译文。");
    const committed = await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences: first },
      digests: translationSentenceDigests(tree, unit, first),
    });
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const oldIndexBytes = await fs.readFile(path.join(directory, "index.json"));

    // 先排队正文发布（同一 per-root 写锁）：提交调用发起时 current=A，
    // 取得锁时 current 已推进到 B，必须在锁内拒绝。
    const nextTree = structuredClone(tree);
    nextTree.sentences[testDocumentIds.sentence].content = [
      { kind: "text", text: "Dr. " },
      { kind: "atom", atomId: testDocumentIds.atom },
      { kind: "text", text: " in 第二版 remains one sentence." },
    ];
    const publish = commitRevision({
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: revision.sourceSnapshotId,
      files: {
        "document.json": Buffer.from(JSON.stringify(nextTree)),
        "source-base.json": Buffer.from(JSON.stringify(nextTree)),
        "tombstones.json": Buffer.from("[]"),
        "changeset.json": Buffer.from(JSON.stringify({ baseRevision: revision.revisionId })),
      },
      metadata: { normalizationVersion: 1 },
    });
    const late = translatedContent(unit, "迟到提交的新译文。");
    const lateCommit = commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences: late },
      digests: translationSentenceDigests(tree, unit, late),
    });
    await expect(lateCommit).rejects.toThrow(/不是当前 current/);
    const second = await publish;
    expect(second.revisionId).not.toBe(revision.revisionId);
    // 旧侧车未被迟到提交污染：index 字节不变，旧译文仍可读。
    expect(await fs.readFile(path.join(directory, "index.json"))).toEqual(oldIndexBytes);
    const oldProjection = await readTranslationProjection(created.root, revision.revisionId, "zh");
    expect(oldProjection.translationRevision).toBe(committed.translationRevision);
    expect(oldProjection.units[0].sentences[0]).toMatchObject({ status: "ready", content: first[0].content });
  });

  test("atom-only 修正仅引用句 stale，旧 sourceSha 保留；未变句保持 ready", async () => {
    const paperId = randomUUID();
    const sectionId = randomUUID();
    const unitId = randomUUID();
    const s1 = randomUUID();
    const s2 = randomUUID();
    const atomId = randomUUID();
    const base: DocumentTree = {
      documentFormatVersion: 1,
      paperId,
      sections: {
        [sectionId]: { id: sectionId, parentSectionId: null, title: "T", childSectionIds: [], unitIds: [unitId] },
      },
      units: { [unitId]: { id: unitId, sectionId, kind: "paragraph", sentenceIds: [s1, s2] } },
      sentences: {
        [s1]: {
          id: s1,
          unitId,
          content: [
            { kind: "text", text: "Energy stays " },
            { kind: "atom", atomId },
            { kind: "text", text: " here." },
          ],
        },
        [s2]: { id: s2, unitId, content: [{ kind: "text", text: "Results improve steadily." }] },
      },
      atoms: {
        [atomId]: { id: atomId, unitId, kind: "math", text: "$E=mc^2$", source: { format: "latex", value: "E=mc^2" } },
      },
      blocks: [{ id: randomUUID(), sectionId, kind: "unit", unitId }],
    };
    const created = await createProject({ parent: sandbox, name: "atom修正" });
    const source = await publishSourceSnapshot({
      root: created.root,
      files: { "document.html": Buffer.from("<html>paper</html>") },
      metadata: { kind: "arxiv", canonicalId: "2401.00005v1" },
    });
    const tree = parseDocumentTree({ ...base, paperId: created.manifest.paper.id }, created.manifest.paper.id);
    const revision = await commitRevision({
      root: created.root,
      baseRevision: null,
      sourceSnapshotId: source.sourceSnapshotId,
      files: {
        "document.json": Buffer.from(JSON.stringify(tree)),
        "source-base.json": Buffer.from(JSON.stringify(tree)),
        "tombstones.json": Buffer.from("[]"),
        "changeset.json": Buffer.from(JSON.stringify({ baseRevision: null })),
      },
      metadata: { normalizationVersion: 1 },
    });
    const readerUnit = buildReaderProjection(tree).items.find(
      (item) => item.kind === "unit" && item.unitId === unitId,
    ) as ReaderUnitContent;
    const sentences = translatedContent(readerUnit, "旧译文。");
    const digests = translationSentenceDigests(tree, readerUnit, sentences);
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId, sentences },
      digests,
    });

    // atom-only 修正：句子内容不变，仅 atom 的 LaTeX 改变（sentence retained、atom changed）。
    const next = structuredClone(tree);
    next.atoms[atomId] = {
      ...next.atoms[atomId],
      kind: "math",
      text: "$E=mc^3$",
      source: { format: "latex", value: "E=mc^3" },
    };
    const nextRevision = await commitRevision({
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: revision.sourceSnapshotId,
      files: {
        "document.json": Buffer.from(JSON.stringify(next)),
        "source-base.json": Buffer.from(JSON.stringify(next)),
        "tombstones.json": Buffer.from("[]"),
        "changeset.json": Buffer.from(JSON.stringify({ baseRevision: revision.revisionId })),
      },
      metadata: { normalizationVersion: 1 },
    });
    // 最小手工迁移（与既有 stale 用例同口径）：复制侧车并重基 index。
    const target = sidecar(created.root, nextRevision.revisionId, "zh");
    await fs.cp(sidecar(created.root, revision.revisionId, "zh"), target, { recursive: true });
    const migratedIndex = JSON.parse(await fs.readFile(path.join(target, "index.json"), "utf8"));
    migratedIndex.baseRevision = nextRevision.revisionId;
    migratedIndex.translationRevision = randomUUID();
    await fs.writeFile(path.join(target, "index.json"), JSON.stringify(migratedIndex));

    const projection = await readTranslationProjection(created.root, nextRevision.revisionId, "zh");
    const byId = new Map(projection.units[0].sentences.map((sentence) => [sentence.sentenceId, sentence]));
    const stale = byId.get(s1)!;
    expect(stale.status).toBe("stale");
    expect(stale.sourceSha256).toBe(digests[0].sourceSha256);
    expect(stale.sourceSha256).not.toBe(sentenceSourceDigest(next, s1));
    expect(stale.atoms).toEqual([tree.atoms[atomId]]);
    expect(byId.get(s2)).toMatchObject({ status: "ready", sourceSha256: digests[1].sourceSha256 });
  });

  test("引用 atom 已删除的已提交句判 stale，不冒充 ready；缺快照旧格式同样判 stale", async () => {
    const { created, revision, tree, unit } = await committedProject();
    const sentences = translatedContent(unit, "引用将删除 atom 的译文。");
    const digests = translationSentenceDigests(tree, unit, sentences);
    await commitTranslationUnit({
      root: created.root,
      baseRevision: revision.revisionId,
      language: "zh",
      generator,
      unit: { unitId: unit.unitId, sentences },
      digests,
    });
    const directory = sidecar(created.root, revision.revisionId, "zh");
    const index = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
    const file = path.join(directory, index.units[0].file);
    // 模拟旧格式：删除句级 atom 快照，读取回退当前树（仅适用于未变 atom）。
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    delete stored.sentences[0].atoms;
    await fs.writeFile(file, JSON.stringify(stored));

    // 合法发布：原句改写为纯文本，atom 整体删除（树校验不允许悬空引用）。
    const nextTree = structuredClone(tree);
    delete nextTree.atoms[testDocumentIds.atom];
    nextTree.sentences[testDocumentIds.sentence].content = [{ kind: "text", text: "Dr. remains one sentence." }];
    const nextRevision = await commitRevision({
      root: created.root,
      baseRevision: revision.revisionId,
      sourceSnapshotId: revision.sourceSnapshotId,
      files: {
        "document.json": Buffer.from(JSON.stringify(nextTree)),
        "source-base.json": Buffer.from(JSON.stringify(nextTree)),
        "tombstones.json": Buffer.from("[]"),
        "changeset.json": Buffer.from(JSON.stringify({ baseRevision: revision.revisionId })),
      },
      metadata: { normalizationVersion: 1 },
    });
    // 最小手工迁移（与既有 stale 用例同口径）：复制侧车并重基 index。
    const target = sidecar(created.root, nextRevision.revisionId, "zh");
    await fs.cp(sidecar(created.root, revision.revisionId, "zh"), target, { recursive: true });
    const migratedIndex = JSON.parse(await fs.readFile(path.join(target, "index.json"), "utf8"));
    migratedIndex.baseRevision = nextRevision.revisionId;
    migratedIndex.translationRevision = randomUUID();
    await fs.writeFile(path.join(target, "index.json"), JSON.stringify(migratedIndex));

    const projection = await readTranslationProjection(created.root, nextRevision.revisionId, "zh");
    expect(projection.units[0].sentences[0]).toMatchObject({
      status: "stale",
      staleReason: "source-changed",
      sourceSha256: digests[0].sourceSha256,
    });
  });
});
