// 正文更新后的译文迁移（SPEC-translation §7，paper-30min-crd.3）：
// 新 current 发布前按 document-core changeset 迁移已提交译文：
// retained/moved 保持 ready，changed 保留旧译文由读取推导 stale，added 为 gap，
// removed/split/merge 只进失效诊断，不自动重挂；无差别清空被禁止。
import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { commitRevision, createProject, openProject, publishSourceSnapshot } from "../src/main/project-core";
import { dispatchCoreCommand } from "../src/main/core-commands";
import {
  commitTranslationUnit,
  readTranslationProjection,
  translationSentenceDigests,
} from "../src/main/translation/store";
import { translationSourceUnits } from "../src/main/translation/run";
import { parseDocumentTree, type DocumentTree } from "../src/shared/document/tree";
import { appendRemovedTombstones, createDocumentChangeset, type Tombstone } from "../src/shared/document/changeset";
import type { TranslationGenerator } from "../src/shared/translation/contracts";

const generator: TranslationGenerator = {
  provider: "controlled",
  model: "controlled-translate",
  promptVersion: 1,
  schemaVersion: 1,
};

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-translation-migrate-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** 英文工程：一个三句单元（s1 含公式 atom、s2/s3 纯文本）＋一个单句单元。 */
function migrationTree(paperId: string) {
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
    metadata: { kind: "arxiv", canonicalId: "2401.00003v1" },
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

/** 直接经存储提交整单元译文（模拟既往任务成果）。 */
async function translateUnit(root: string, baseRevision: string, tree: DocumentTree, unitId: string) {
  const unit = translationSourceUnits(tree).find((candidate) => candidate.unitId === unitId);
  if (!unit) throw new Error("测试单元不存在。");
  const sentences = unit.sentences.map((sentence) => ({
    sentenceId: sentence.sentenceId,
    content: [
      { kind: "text" as const, text: `译文：${sentence.sentenceId.slice(0, 8)}` },
      ...sentence.parts.flatMap((part) =>
        part.kind === "atom" ? [{ kind: "atom" as const, atomId: part.atom.id }] : [],
      ),
    ],
  }));
  const committed = await commitTranslationUnit({
    root,
    baseRevision,
    language: "zh",
    generator,
    unit: { unitId, sentences },
    digests: translationSentenceDigests(tree, unit, sentences),
  });
  return { sentences, committed };
}

/** 发布新 current：changeset 与 tombstones 按 document-core 同一口径生成；
 * 显式结构退役（split/merged）由调用方提供，优先于笼统 removed。 */
async function publishNext(
  root: string,
  baseRevision: string,
  sourceSnapshotId: string,
  base: DocumentTree,
  next: DocumentTree,
  explicit: Tombstone[] = [],
) {
  const revisionId = randomUUID();
  // 克隆树携带占位 paperId：发布前重基到工程主论文身份。
  const paperId = (await openProject(root)).manifest.paper.id;
  const rebasedBase = { ...base, paperId };
  const rebased = { ...next, paperId };
  const changeset = createDocumentChangeset({ base: rebasedBase, current: rebased, baseRevision, revisionId });
  const explicitIds = new Set(explicit.map((entry) => entry.nodeId));
  const tombstones = [
    ...explicit,
    ...appendRemovedTombstones(rebasedBase, changeset, []).filter((entry) => !explicitIds.has(entry.nodeId)),
  ];
  // 经生产命令面发布：译文迁移钩子与核验继承同一提交点执行。
  return (await dispatchCoreCommand({
    type: "coreCommit",
    root,
    baseRevision,
    sourceSnapshotId,
    revisionId,
    files: {
      "document.json": json(rebased),
      "source-base.json": json(rebased),
      "tombstones.json": json(tombstones),
      "changeset.json": json(changeset),
    },
    metadata: { normalizationVersion: 1 },
  })) as Awaited<ReturnType<typeof commitRevision>>;
}

const sidecar = (root: string, revisionId: string, language: string) =>
  path.join(root, ".paper30min", "revisions", revisionId, "translations", language);

test.describe("translation 正文更新后的局部 stale 迁移", () => {
  test("retained/moved 保持 ready，changed 仅该句 stale，added 为 gap", async () => {
    const paperId = randomUUID();
    const { tree, ids } = migrationTree(paperId);
    const { created, revision, source } = await projectWithTree("局部迁移", tree);
    const a = await translateUnit(created.root, revision.revisionId, tree, ids.unitA);
    const b = await translateUnit(created.root, revision.revisionId, tree, ids.unitB);

    // s2 内容改变；s3 删除；unitA 追加新句；unitB 整体移到 unitA 之前（moved）。
    const next = structuredClone(tree);
    next.sentences[ids.s2].content = [{ kind: "text", text: "Results improve rapidly now." }];
    const added = randomUUID();
    next.sentences[added] = {
      id: added,
      unitId: ids.unitA,
      content: [{ kind: "text", text: "A brand new sentence." }],
    };
    next.units[ids.unitA].sentenceIds = [ids.s1, ids.s2, added];
    delete next.sentences[ids.s3];
    next.sections[ids.section].unitIds = [ids.unitB, ids.unitA];
    next.blocks = [next.blocks[1], next.blocks[0]];

    const second = await publishNext(created.root, revision.revisionId, source.sourceSnapshotId, tree, next);

    const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
    expect(projection.baseRevision).toBe(second.revisionId);
    expect(projection.translationRevision).toMatch(/^[0-9a-f-]{36}$/);
    expect(projection.translationRevision).not.toBe(a.committed.translationRevision);
    const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
    const byId = new Map(unitA.sentences.map((sentence) => [sentence.sentenceId, sentence]));
    // retained：s1 译文、atom 与 generator 事实原样保留。
    expect(byId.get(ids.s1)).toEqual({ sentenceId: ids.s1, status: "ready", content: a.sentences[0].content });
    expect(unitA.generator).toEqual(generator);
    // changed：仅 s2 stale，旧译文保留，不冒充最新。
    expect(byId.get(ids.s2)).toEqual({
      sentenceId: ids.s2,
      status: "stale",
      staleReason: "source-changed",
      content: a.sentences[1].content,
    });
    // added：新句为 gap，由消费方按最新原文显示。
    expect(byId.get(added)).toEqual({ sentenceId: added, status: "gap", content: null });
    // moved：unitB 不 stale，阅读位置以新树为准。
    const unitB = projection.units.find((unit) => unit.unitId === ids.unitB)!;
    expect(unitB.sentences).toEqual([{ sentenceId: ids.sB, status: "ready", content: b.sentences[0].content }]);

    // 旧侧车不被修改：失效诊断只属于新 revision。
    const oldIndex = JSON.parse(
      await fs.readFile(path.join(sidecar(created.root, revision.revisionId, "zh"), "index.json"), "utf8"),
    );
    expect(oldIndex.translationRevision).toBe(b.committed.translationRevision);
    expect(oldIndex.units.find((entry: { unitId: string }) => entry.unitId === ids.unitA).sentences).toHaveLength(3);
  });

  test("removed 旧译文只进失效诊断，不挂到相似新句", async () => {
    const paperId = randomUUID();
    const { tree, ids } = migrationTree(paperId);
    const { created, revision, source } = await projectWithTree("删除诊断", tree);
    const a = await translateUnit(created.root, revision.revisionId, tree, ids.unitA);

    const next = structuredClone(tree);
    next.units[ids.unitA].sentenceIds = [ids.s1, ids.s2];
    delete next.sentences[ids.s3];
    const second = await publishNext(created.root, revision.revisionId, source.sourceSnapshotId, tree, next);

    const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
    const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
    expect(unitA.sentences.map((sentence) => sentence.sentenceId)).toEqual([ids.s1, ids.s2]);
    expect(projection.retired).toEqual([
      {
        sentenceId: ids.s3,
        unitId: ids.unitA,
        reason: "removed",
        excerpt: "The conclusion follows here.",
        content: a.sentences[2].content,
        generator,
      },
    ]);
    // 诊断随迁移 index 持久化：离线重开一致，旧侧车保持原样。
    const reopened = await readTranslationProjection(created.root, second.revisionId, "zh");
    expect(reopened.retired).toEqual(projection.retired);
  });

  test("拆分／合并／删除单元：旧译文进诊断，新句为 gap，不自动重挂", async () => {
    const paperId = randomUUID();
    const { tree, ids } = migrationTree(paperId);
    const { created, revision, source } = await projectWithTree("结构退役", tree);
    await translateUnit(created.root, revision.revisionId, tree, ids.unitA);
    await translateUnit(created.root, revision.revisionId, tree, ids.unitB);

    // unitA 拆成两个新单元（split），unitB 删除（removed）：旧 ID 全部退役。
    const next = structuredClone(tree);
    const partOne = randomUUID();
    const partTwo = randomUUID();
    const oneSentence = randomUUID();
    const twoSentence = randomUUID();
    delete next.units[ids.unitA];
    delete next.sentences[ids.s1];
    delete next.sentences[ids.s2];
    delete next.sentences[ids.s3];
    delete next.atoms[ids.atom];
    delete next.units[ids.unitB];
    delete next.sentences[ids.sB];
    next.units[partOne] = { id: partOne, sectionId: ids.section, kind: "paragraph", sentenceIds: [oneSentence] };
    next.units[partTwo] = { id: partTwo, sectionId: ids.section, kind: "paragraph", sentenceIds: [twoSentence] };
    next.sentences[oneSentence] = {
      id: oneSentence,
      unitId: partOne,
      content: [{ kind: "text", text: "Energy stays constant in this study." }],
    };
    next.sentences[twoSentence] = {
      id: twoSentence,
      unitId: partTwo,
      content: [{ kind: "text", text: "Results improve steadily and the conclusion follows." }],
    };
    next.sections[ids.section].unitIds = [partOne, partTwo];
    next.blocks = [
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: partOne },
      { id: randomUUID(), sectionId: ids.section, kind: "unit", unitId: partTwo },
    ];
    // 拆分是显式结构操作：旧句以 split 原因退役（与修正引擎同一口径）。
    const explicit: Tombstone[] = [ids.s1, ids.s2, ids.s3].map((sentenceId) => ({
      nodeType: "sentence",
      nodeId: sentenceId,
      lastRevision: revision.revisionId,
      excerpt: tree.sentences[sentenceId].content.map((part) => (part.kind === "text" ? part.text : "")).join(""),
      reason: "split",
    }));
    const second = await publishNext(created.root, revision.revisionId, source.sourceSnapshotId, tree, next, explicit);

    const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
    // 新单元没有任何已提交译文：全部 gap，不重挂旧译文。
    expect(projection.units).toEqual([]);
    expect((projection.retired ?? []).map((entry) => [entry.sentenceId, entry.reason]).sort()).toEqual(
      [
        [ids.s1, "split"],
        [ids.s2, "split"],
        [ids.s3, "split"],
        [ids.sB, "removed"],
      ].sort(),
    );
    expect((projection.retired ?? []).every((entry) => entry.content.length > 0)).toBe(true);
  });

  test("正文完全未变时迁移保持全部 ready，不清空译文", async () => {
    const paperId = randomUUID();
    const { tree, ids } = migrationTree(paperId);
    const { created, revision, source } = await projectWithTree("全保留", tree);
    const a = await translateUnit(created.root, revision.revisionId, tree, ids.unitA);
    const second = await publishNext(
      created.root,
      revision.revisionId,
      source.sourceSnapshotId,
      tree,
      structuredClone(tree),
    );
    const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
    const unitA = projection.units.find((unit) => unit.unitId === ids.unitA)!;
    expect(unitA.sentences.every((sentence) => sentence.status === "ready")).toBe(true);
    expect(unitA.sentences.map((sentence) => sentence.content)).toEqual(
      a.sentences.map((sentence) => sentence.content),
    );
    expect(projection.retired).toEqual([]);
  });

  test("无已提交译文时不写迁移侧车；迁移失败不阻断 current 发布", async () => {
    const paperId = randomUUID();
    const { tree, ids } = migrationTree(paperId);
    const { created, revision, source } = await projectWithTree("无译文迁移", tree);
    const next = structuredClone(tree);
    next.sentences[ids.s2].content = [{ kind: "text", text: "Changed without translation." }];
    const second = await publishNext(created.root, revision.revisionId, source.sourceSnapshotId, tree, next);
    expect((await openProject(created.root)).currentRevision?.revisionId).toBe(second.revisionId);
    await expect(fs.stat(sidecar(created.root, second.revisionId, "zh"))).rejects.toMatchObject({ code: "ENOENT" });
    const projection = await readTranslationProjection(created.root, second.revisionId, "zh");
    expect(projection.translationRevision).toBeNull();
    expect(projection.units).toEqual([]);
  });
});
