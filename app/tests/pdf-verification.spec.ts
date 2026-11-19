import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import {
  documentAnchorDependencies,
  createRangeAnchor,
  type DocumentAnchor,
} from "../src/shared/document/anchor";
import { createDocumentChangeset } from "../src/shared/document/changeset";
import type { DocumentTree } from "../src/shared/document/tree";
import {
  inheritVerificationRecords,
  parsePdfSourceEvidence,
  parseVerificationSidecar,
  summarizeVerification,
  type VerificationCoverageEntry,
  type VerificationRecord,
} from "../src/shared/verification";
import {
  commitRevision,
  createProject,
  publishSourceSnapshot,
  readRevision,
  readRevisionDocument,
  readRevisionTombstones,
} from "../src/main/project-core";
import { dispatchCoreCommand } from "../src/main/core-commands";
import { snapshotLocalPdf } from "../src/main/pdf/snapshot";
import {
  createVerification,
  readVerificationRecords,
  recordReadPdfEvidence,
  resolveVerificationCoverage,
} from "../src/main/pdf/verification";
import { createPdfTools } from "../src/main/pdf-tools";
import { ProjectService } from "../src/main/project-service";
import {
  createDocumentMergeCandidate,
  publishDocumentMergeCandidate,
} from "../src/main/document/merge";
import type { ProjectRevisionRecord } from "../src/shared/contracts";
import { selectionIds, testSelectionTree } from "./fixtures/document-selection";

const PDF_A = "11111111-1111-4111-8111-111111111111";
const PDF_B = "22222222-2222-4222-8222-222222222222";
const PARSE_A = "33333333-3333-4333-8333-333333333333";
const REV_A = "44444444-4444-4444-8444-444444444444";
const DIGEST = "a".repeat(64);

function coverageOf(
  tree: DocumentTree,
  anchor: DocumentAnchor,
  validity: VerificationCoverageEntry["validity"] = "verified",
): VerificationCoverageEntry[] {
  return documentAnchorDependencies(tree, anchor).map((dependency) => ({
    nodeType: dependency.nodeType,
    nodeId: dependency.nodeId,
    contentSha256: DIGEST,
    quote: "fixture quote",
    validity,
  }));
}

function makeRecord(
  tree: DocumentTree,
  anchor: DocumentAnchor,
  overrides: Partial<VerificationRecord> & { validity?: VerificationCoverageEntry["validity"] } = {},
): VerificationRecord {
  const { validity, ...rest } = overrides;
  return {
    verificationId: randomUUID(),
    verifiedRevisionId: REV_A,
    anchor,
    coverage: coverageOf(tree, anchor, validity),
    pdfSnapshotId: PDF_A,
    parseSnapshotId: PARSE_A,
    actor: { kind: "user", confirmed: true },
    createdAt: "2026-11-17T00:00:00.000Z",
    ...rest,
  };
}

function entryOf(record: VerificationRecord, nodeId: string): VerificationCoverageEntry {
  const entry = record.coverage.find((candidate) => candidate.nodeId === nodeId);
  if (!entry) throw new Error(`coverage 缺少节点 ${nodeId}`);
  return entry;
}

function unitAnchor(): DocumentAnchor {
  return { kind: "unit", unitId: selectionIds.unit };
}

function changesetFrom(base: DocumentTree, current: DocumentTree) {
  return createDocumentChangeset({
    base,
    current,
    baseRevision: REV_A,
    revisionId: randomUUID(),
  });
}

function movedTree(base: DocumentTree): DocumentTree {
  const current = structuredClone(base);
  current.sections[selectionIds.section].unitIds.reverse();
  current.blocks.reverse();
  return current;
}

function changedTree(base: DocumentTree): DocumentTree {
  const current = structuredClone(base);
  const content = current.sentences[selectionIds.sentence].content;
  const last = content.at(-1);
  if (last?.kind !== "text") throw new Error("fixture 末尾不是文本");
  last.text = " in the revised paper remains one sentence.";
  return current;
}

function treeWithoutSecondUnit(base: DocumentTree): DocumentTree {
  const current = structuredClone(base);
  current.sections[selectionIds.section].unitIds = [selectionIds.unit];
  current.blocks = current.blocks.filter((block) => block.id !== selectionIds.secondBlock);
  delete current.units[selectionIds.secondUnit];
  delete current.sentences[selectionIds.thirdSentence];
  return current;
}

test("pdf-verification 继承：同一 PDF 内容不变的 retained/moved 保持 verified 并保留 provenance", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, unitAnchor());
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, movedTree(base)),
    currentPdfSnapshotId: PDF_A,
  });
  expect(inherited).toHaveLength(1);
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("verified");
  expect(inherited[0].verifiedRevisionId).toBe(REV_A);
  expect(inherited[0].pdfSnapshotId).toBe(PDF_A);
  expect(inherited[0].parseSnapshotId).toBe(PARSE_A);
  expect(inherited[0].coverage).toEqual(record.coverage);
  expect(inherited[0].pdfSourceChanged).toBeUndefined();
});

test("pdf-verification 继承：同一 PDF 内容改变成为 modified-unreviewed，保留原摘要与 quote", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, unitAnchor());
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, changedTree(base)),
    currentPdfSnapshotId: PDF_A,
  });
  expect(entryOf(inherited[0], selectionIds.sentence).validity).toBe("modified-unreviewed");
  expect(entryOf(inherited[0], selectionIds.sentence).contentSha256)
    .toBe(entryOf(record, selectionIds.sentence).contentSha256);
  expect(entryOf(inherited[0], selectionIds.sentence).quote)
    .toBe(entryOf(record, selectionIds.sentence).quote);
  expect(inherited[0].verifiedRevisionId).toBe(REV_A);
  expect(inherited[0].pdfSourceChanged).toBeUndefined();
});

test("pdf-verification 继承：不同 PDF 内容未变成为 historical-source 并附来源变化事实", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, unitAnchor());
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, movedTree(base)),
    currentPdfSnapshotId: PDF_B,
  });
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("historical-source");
  expect(inherited[0].pdfSourceChanged).toBe(true);
  expect(inherited[0].verifiedRevisionId).toBe(REV_A);
  expect(inherited[0].pdfSnapshotId).toBe(PDF_A);
});

test("pdf-verification 继承：不同 PDF 且内容改变同时表达修改与来源变化", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, unitAnchor());
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, changedTree(base)),
    currentPdfSnapshotId: PDF_B,
  });
  expect(entryOf(inherited[0], selectionIds.sentence).validity).toBe("modified-unreviewed");
  expect(inherited[0].pdfSourceChanged).toBe(true);
});

test("pdf-verification 继承：删除节点使对应 coverage removed，新增节点没有旧核验", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, { kind: "unit", unitId: selectionIds.secondUnit });
  const current = treeWithoutSecondUnit(base);
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, current),
    currentPdfSnapshotId: PDF_A,
  });
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("removed");
  const summary = summarizeVerification(current, inherited);
  expect(summary.counts.unrecorded).toBe(
    Object.keys(current.sections).length + Object.keys(current.units).length +
    Object.keys(current.sentences).length + Object.keys(current.atoms).length +
    current.blocks.length,
  );
});

test("pdf-verification 继承：section 内一兄弟句子改变另一不变，逐节点分别降级", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, { kind: "section", sectionId: selectionIds.section });
  const current = changedTree(base);
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, current),
    currentPdfSnapshotId: PDF_A,
  });
  expect(entryOf(inherited[0], selectionIds.sentence).validity).toBe("modified-unreviewed");
  expect(entryOf(inherited[0], selectionIds.secondSentence).validity).toBe("verified");
  expect(entryOf(inherited[0], selectionIds.thirdSentence).validity).toBe("verified");
  expect(entryOf(inherited[0], selectionIds.secondUnit).validity).toBe("verified");
  const summary = summarizeVerification(current, inherited);
  const statusOf = (nodeId: string) =>
    summary.nodes.find((node) => node.nodeId === nodeId)?.status;
  expect(statusOf(selectionIds.sentence)).toBe("modified-unreviewed");
  expect(statusOf(selectionIds.secondSentence)).toBe("verified");
  expect(statusOf(selectionIds.thirdSentence)).toBe("verified");
});

test("pdf-verification 继承：section 部分删除只 tombstone 被删节点，存活节点保留核验", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, { kind: "section", sectionId: selectionIds.section });
  const current = treeWithoutSecondUnit(base);
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, current),
    currentPdfSnapshotId: PDF_A,
  });
  for (const nodeId of [selectionIds.secondUnit, selectionIds.thirdSentence, selectionIds.secondBlock])
    expect(entryOf(inherited[0], nodeId).validity).toBe("removed");
  for (const nodeId of [selectionIds.unit, selectionIds.sentence, selectionIds.secondSentence, selectionIds.atom])
    expect(entryOf(inherited[0], nodeId).validity).toBe("verified");
  const summary = summarizeVerification(current, inherited);
  const statusOf = (nodeId: string) =>
    summary.nodes.find((node) => node.nodeId === nodeId)?.status;
  expect(statusOf(selectionIds.unit)).toBe("verified");
  expect(statusOf(selectionIds.sentence)).toBe("verified");
  expect(statusOf(selectionIds.secondSentence)).toBe("verified");
});

test("pdf-verification 继承：modified-unreviewed 与 historical-source 不因内容不变自动恢复", () => {
  const base = testSelectionTree(randomUUID());
  const modified = makeRecord(base, unitAnchor(), { validity: "modified-unreviewed" });
  const historical = makeRecord(base, unitAnchor(), {
    validity: "historical-source",
    pdfSourceChanged: true,
  });
  const inherited = inheritVerificationRecords({
    records: [modified, historical],
    changeset: changesetFrom(base, movedTree(base)),
    currentPdfSnapshotId: PDF_B,
  });
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("modified-unreviewed");
  for (const entry of inherited[1].coverage) expect(entry.validity).toBe("historical-source");
});

test("pdf-verification 继承：removed 记录保持 removed，不重新挂回留存节点", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, unitAnchor(), { validity: "removed" });
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(base, movedTree(base)),
    currentPdfSnapshotId: PDF_A,
  });
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("removed");
});

test("pdf-verification 继承：coverage 节点不在 changeset 中时保守判为 removed", () => {
  const base = testSelectionTree(randomUUID());
  const record = makeRecord(base, unitAnchor());
  const stranger = testSelectionTree(randomUUID());
  const remapped = new Map<string, string>();
  const foreign = JSON.parse(JSON.stringify(stranger).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (id: string) => {
      if (!remapped.has(id)) remapped.set(id, randomUUID());
      return remapped.get(id)!;
    },
  )) as DocumentTree;
  const foreignMoved = structuredClone(foreign);
  Object.values(foreignMoved.sections)[0].unitIds.reverse();
  foreignMoved.blocks.reverse();
  const inherited = inheritVerificationRecords({
    records: [record],
    changeset: changesetFrom(foreign, foreignMoved),
    currentPdfSnapshotId: PDF_A,
  });
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("removed");
});

test("pdf-verification 摘要：按当前有效记录聚合四态，不产生质量分数", () => {
  const tree = testSelectionTree(randomUUID());
  const older = makeRecord(tree, unitAnchor(), {
    createdAt: "2026-11-17T00:00:00.000Z",
    validity: "verified",
  });
  const newer = makeRecord(tree, unitAnchor(), {
    createdAt: "2026-11-18T00:00:00.000Z",
    validity: "modified-unreviewed",
  });
  const historical = makeRecord(tree, { kind: "unit", unitId: selectionIds.secondUnit }, {
    validity: "historical-source",
    pdfSourceChanged: true,
  });
  const summary = summarizeVerification(tree, [older, newer, historical]);
  expect(Object.keys(summary).sort()).toEqual(["counts", "nodes"]);
  expect(Object.keys(summary.counts).sort()).toEqual([
    "historical-source", "modified-unreviewed", "unrecorded", "verified",
  ]);
  const statusOf = (nodeId: string) =>
    summary.nodes.find((node) => node.nodeId === nodeId)?.status;
  expect(statusOf(selectionIds.unit)).toBe("modified-unreviewed");
  expect(statusOf(selectionIds.sentence)).toBe("modified-unreviewed");
  expect(statusOf(selectionIds.secondUnit)).toBe("historical-source");
  expect(statusOf(selectionIds.section)).toBe("unrecorded");
  expect(summary.nodes.find((node) => node.nodeId === selectionIds.unit)?.verificationId)
    .toBe(newer.verificationId);
  const total = Object.values(summary.counts).reduce((sum, value) => sum + value, 0);
  expect(total).toBe(summary.nodes.length);
});

test("pdf-verification 摘要：重新核验后最新记录生效，历史标记不永久累加", () => {
  const tree = testSelectionTree(randomUUID());
  const stale = makeRecord(tree, unitAnchor(), {
    createdAt: "2026-11-17T00:00:00.000Z",
    validity: "modified-unreviewed",
  });
  const reverified = makeRecord(tree, unitAnchor(), {
    createdAt: "2026-11-18T00:00:00.000Z",
    validity: "verified",
  });
  const summary = summarizeVerification(tree, [stale, reverified]);
  const unit = summary.nodes.find((node) => node.nodeId === selectionIds.unit)!;
  expect(unit.status).toBe("verified");
  expect(unit.verificationId).toBe(reverified.verificationId);
  expect(summary.counts.verified).toBeGreaterThan(0);
});

test("pdf-verification 侧车 schema：拒绝坏格式、revisionId 不符与重复核验 ID", () => {
  const tree = testSelectionTree(randomUUID());
  const revisionId = randomUUID();
  const record = makeRecord(tree, unitAnchor());
  const sidecar = { formatVersion: 1, revisionId, records: [record] };
  expect(parseVerificationSidecar(sidecar, revisionId).records).toEqual([record]);
  expect(() => parseVerificationSidecar({ ...sidecar, formatVersion: 2 }, revisionId)).toThrow();
  expect(() => parseVerificationSidecar(sidecar, randomUUID())).toThrow();
  expect(() => parseVerificationSidecar(
    { ...sidecar, records: [record, record] },
    revisionId,
  )).toThrow();
  expect(() => parseVerificationSidecar(
    {
      ...sidecar,
      records: [{
        ...record,
        coverage: record.coverage.map((entry) => ({ ...entry, validity: "excellent" })),
      }],
    },
    revisionId,
  )).toThrow();
});

const SAMPLE = path.resolve("tests/fixtures/sample_paper.pdf");
const OTHER_PDF = path.resolve("tests/fixtures/pdfparse_formula_graphics.pdf");

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-verification-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function json(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function commitTree(
  root: string,
  baseRevision: string | null,
  sourceSnapshotId: string,
  document: DocumentTree,
  sourceBase: DocumentTree,
) {
  return commitRevision({
    root,
    baseRevision,
    sourceSnapshotId,
    files: {
      "document.json": json(document),
      "source-base.json": json(sourceBase),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision }),
    },
  });
}

async function pdfProject(name: string, tree: DocumentTree, pdf = SAMPLE) {
  const created = await createProject({ parent: sandbox, name });
  tree.paperId = created.manifest.paper.id;
  const snapshot = await snapshotLocalPdf({ root: created.root, source: pdf });
  if (!snapshot.ok) throw new Error("fixture PDF snapshot failed");
  const revision = await commitTree(
    created.root,
    null,
    snapshot.snapshot.sourceSnapshotId,
    tree,
    tree,
  );
  return { root: created.root, pdf: snapshot.snapshot, revision };
}

async function commitViaCore(
  root: string,
  baseRevision: string,
  sourceSnapshotId: string,
  document: DocumentTree,
  sourceBase: DocumentTree,
): Promise<ProjectRevisionRecord> {
  return dispatchCoreCommand({
    type: "coreCommit",
    root,
    baseRevision,
    sourceSnapshotId,
    files: {
      "document.json": json(document),
      "source-base.json": json(sourceBase),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision }),
    },
  }) as Promise<ProjectRevisionRecord>;
}

function withAliases(tree: DocumentTree): DocumentTree {
  tree.sections[selectionIds.section].sourceAliases = ["page-1"];
  tree.units[selectionIds.unit].sourceAliases = ["page-1/b0"];
  tree.sentences[selectionIds.sentence].sourceAliases = ["page-1/b0"];
  tree.atoms[selectionIds.atom].sourceAliases = ["page-1/b0"];
  tree.blocks[0].sourceAliases = ["page-1/b0"];
  tree.units[selectionIds.secondUnit].sourceAliases = ["page-2/b0"];
  tree.sentences[selectionIds.thirdSentence].sourceAliases = ["page-2/b0"];
  tree.blocks[1].sourceAliases = ["page-2/b0"];
  return tree;
}

function addUnit(tree: DocumentTree) {
  const unitId = randomUUID();
  const sentenceId = randomUUID();
  const blockId = randomUUID();
  tree.units[unitId] = {
    id: unitId,
    sectionId: selectionIds.section,
    kind: "paragraph",
    sentenceIds: [sentenceId],
  };
  tree.sentences[sentenceId] = {
    id: sentenceId,
    unitId,
    content: [{ kind: "text", text: "Fresh unit." }],
  };
  tree.sections[selectionIds.section].unitIds.push(unitId);
  tree.blocks.push({ id: blockId, sectionId: selectionIds.section, kind: "unit", unitId });
  return { unitId, sentenceId, blockId };
}

const USER = { kind: "user", confirmed: true } as const;

test("pdf-verification 用户核验：section 展开固定当时节点，侧车不改动不可变正文", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision } = await pdfProject("固定覆盖", base);
  const documentPath = path.join(root, revision.path, "document.json");
  const sourceBasePath = path.join(root, revision.path, "source-base.json");
  const documentBefore = await fs.readFile(documentPath);
  const sourceBaseBefore = await fs.readFile(sourceBasePath);

  const record = await createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: { kind: "section", sectionId: selectionIds.section },
    actor: USER,
  });
  for (const entry of record.coverage) expect(entry.validity).toBe("verified");
  expect(record.verifiedRevisionId).toBe(revision.revisionId);
  expect(record.actor).toEqual({ kind: "user", confirmed: true });
  const covered = new Set(record.coverage.map((entry) => entry.nodeId));
  for (const nodeId of [
    selectionIds.section, selectionIds.unit, selectionIds.sentence,
    selectionIds.atom, selectionIds.block, selectionIds.secondUnit,
    selectionIds.thirdSentence, selectionIds.secondBlock,
  ])
    expect(covered.has(nodeId), `coverage 缺少 ${nodeId}`).toBe(true);
  for (const entry of record.coverage) {
    expect(entry.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.quote.length).toBeGreaterThan(0);
  }
  expect(resolveVerificationCoverage(base, record.anchor)).toEqual(record.coverage);

  const records = await readVerificationRecords(root, revision.revisionId);
  expect(records).toEqual([record]);
  expect((await fs.readFile(documentPath)).equals(documentBefore)).toBe(true);
  expect((await fs.readFile(sourceBasePath)).equals(sourceBaseBefore)).toBe(true);
  expect((await readRevision(root, revision.revisionId)).files).toEqual(revision.files);
  const summary = summarizeVerification(base, records);
  expect(summary.counts.verified).toBe(summary.nodes.length);
});

test("pdf-verification 用户核验：未显式确认被拒绝，正文仍可读且不写侧车", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision } = await pdfProject("显式确认", base);
  await expect(createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: unitAnchor(),
    actor: { kind: "user", confirmed: false },
  })).rejects.toThrow(/确认/);
  expect(await readVerificationRecords(root, revision.revisionId)).toEqual([]);
  expect(await readRevisionDocument(root, revision.revisionId, "document")).toEqual(base);
});

test("pdf-verification 用户核验：current 已变化、锚点不存在或 quote 不符均拒绝", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision } = await pdfProject("拒绝现场", base);
  await expect(createVerification({
    root,
    expectedRevisionId: randomUUID(),
    anchor: unitAnchor(),
    actor: USER,
  })).rejects.toThrow(/current/);
  await expect(createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: { kind: "unit", unitId: randomUUID() },
    actor: USER,
  })).rejects.toThrow(/锚点/);
  const range = createRangeAnchor(base, [{
    unitId: selectionIds.unit,
    sentenceId: selectionIds.sentence,
    start: 0,
    end: 4,
  }]);
  await expect(createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: { ...range, quote: { ...range.quote, text: "Wrong quote" } },
    actor: USER,
  })).rejects.toThrow(/锚点/);
  expect(await readVerificationRecords(root, revision.revisionId)).toEqual([]);
});

test("pdf-verification 用户核验：range 锚点固定 sentence range 与精确 quote", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision } = await pdfProject("range 覆盖", base);
  const anchor = createRangeAnchor(base, [{
    unitId: selectionIds.unit,
    sentenceId: selectionIds.sentence,
    start: 0,
    end: 4,
  }]);
  const record = await createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor,
    actor: USER,
  });
  const sentenceEntry = record.coverage.find((entry) => entry.nodeType === "sentence")!;
  expect(sentenceEntry.range).toEqual({
    sentenceId: selectionIds.sentence,
    start: 0,
    end: 4,
  });
  expect(sentenceEntry.quote).toBe("Dr. ");
});

test("pdf-verification Agent 核验：主进程来源证据覆盖请求页时建立记录", async () => {
  const base = withAliases(testSelectionTree(randomUUID()));
  const { root, pdf, revision } = await pdfProject("Agent 证据", base);
  const evidence = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 1,
    png: Buffer.from("rendered-page-1"),
    sessionId: "session-1",
    taskId: "task-1",
  });
  if (!evidence) throw new Error("真实读取路径未签发证据");
  const record = await createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: unitAnchor(),
    actor: { kind: "agent", sessionId: "session-1", taskId: "task-1", evidenceIds: [evidence.evidenceId] },
  });
  for (const entry of record.coverage) expect(entry.validity).toBe("verified");
  expect(record.actor).toEqual({
    kind: "agent",
    sessionId: "session-1",
    taskId: "task-1",
    evidenceIds: [evidence.evidenceId],
  });
  expect(record.pdfSnapshotId).toBe(pdf.sourceSnapshotId);
});

test("pdf-verification Agent 核验：无证据、页不足、session/task 不符或证据属于其他 PDF 均拒绝", async () => {
  const base = withAliases(testSelectionTree(randomUUID()));
  const { root, pdf, revision } = await pdfProject("Agent 拒绝", base);
  const agent = {
    sessionId: "session-1",
    taskId: "task-1",
  };
  const attempt = (evidenceIds: string[]) => createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: { kind: "section", sectionId: selectionIds.section },
    actor: { kind: "agent", ...agent, evidenceIds },
  });
  await expect(attempt([])).rejects.toThrow(/证据/);
  await expect(attempt([randomUUID()])).rejects.toThrow(/不存在/);

  const insufficient = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 1,
    png: Buffer.from("page-1"),
    sessionId: "session-1",
    taskId: "task-1",
  });
  if (!insufficient) throw new Error("真实读取路径未签发证据");
  await expect(attempt([insufficient.evidenceId])).rejects.toThrow(/覆盖/);

  const wrongSessionPage1 = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 1,
    png: Buffer.from("pages-1"),
    sessionId: "other-session",
    taskId: "task-1",
  });
  const wrongSessionPage2 = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 2,
    png: Buffer.from("pages-2"),
    sessionId: "other-session",
    taskId: "task-1",
  });
  if (!wrongSessionPage1 || !wrongSessionPage2) throw new Error("真实读取路径未签发证据");
  await expect(attempt([wrongSessionPage1.evidenceId, wrongSessionPage2.evidenceId]))
    .rejects.toThrow(/session|task/);

  const otherPdf = await snapshotLocalPdf({ root, source: OTHER_PDF });
  if (!otherPdf.ok) throw new Error("second PDF snapshot failed");
  const wrongSource = await recordReadPdfEvidence({
    root,
    pdfSha256: otherPdf.snapshot.sha256,
    page: 1,
    png: Buffer.from("other-pdf"),
    sessionId: "session-1",
    taskId: "task-1",
  });
  if (!wrongSource) throw new Error("真实读取路径未签发证据");
  await expect(attempt([wrongSource.evidenceId])).rejects.toThrow(/快照/);
  expect(await readVerificationRecords(root, revision.revisionId)).toEqual([]);
});

test("pdf-verification Agent 核验：范围没有页级来源事实时拒绝，用户核验不受影响", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision } = await pdfProject("无页级来源", base);
  const evidencePage1 = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 1,
    png: Buffer.from("pages-1"),
    sessionId: "session-1",
    taskId: "task-1",
  });
  const evidencePage2 = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 2,
    png: Buffer.from("pages-2"),
    sessionId: "session-1",
    taskId: "task-1",
  });
  if (!evidencePage1 || !evidencePage2) throw new Error("真实读取路径未签发证据");
  await expect(createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: unitAnchor(),
    actor: {
      kind: "agent",
      sessionId: "session-1",
      taskId: "task-1",
      evidenceIds: [evidencePage1.evidenceId, evidencePage2.evidenceId],
    },
  })).rejects.toThrow(/页级/);
  const user = await createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  for (const entry of user.coverage) expect(entry.validity).toBe("verified");
});

test("pdf-verification 证据签发：绑定快照/页/session/task 与实际 PNG 摘要，无快照不签发", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf } = await pdfProject("证据契约", base);
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const evidence = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 2,
    png,
    sessionId: "session-1",
    taskId: "task-1",
  });
  if (!evidence) throw new Error("真实读取路径未签发证据");
  expect(evidence.pages).toEqual([2]);
  expect(evidence.pdfSnapshotId).toBe(pdf.sourceSnapshotId);
  expect(evidence.contentSha256).toBe(sha256(png));
  const file = path.join(root, ".paper30min", "pdf-evidence", `${evidence.evidenceId}.json`);
  const persisted = parsePdfSourceEvidence(JSON.parse(await fs.readFile(file, "utf8")));
  expect(persisted).toEqual(evidence);
  // 文件摘要不对应任何已发布 PDF 快照：不签发证据。
  expect(await recordReadPdfEvidence({
    root,
    pdfSha256: sha256("not-a-snapshot"),
    page: 1,
    png,
    sessionId: "session-1",
    taskId: "task-1",
  })).toBeNull();
  // 页码超出快照页数：拒绝签发。
  await expect(recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: pdf.pageCount + 1,
    png,
    sessionId: "session-1",
    taskId: "task-1",
  })).rejects.toThrow(/页/);
});

test("pdf-verification read_pdf 真实渲染签发证据：摘要等于实际 PNG，未登记快照不签发", async () => {
  const base = withAliases(testSelectionTree(randomUUID()));
  const { root, pdf, revision } = await pdfProject("readpdf 证据", base);
  await fs.mkdir(path.join(root, "text"), { recursive: true });
  await fs.copyFile(SAMPLE, path.join(root, "text", "paper.pdf"));
  const service = new ProjectService(path.join(sandbox, "readpdf-config.json"));
  try {
    const tool = createPdfTools(root, service, true, () => true, { sessionId: "session-live" })[0];
    const result = await tool.execute(
      "call-1",
      { path: "text/paper.pdf", page: 1 },
      undefined,
      undefined,
      {} as never,
    );
    const info = JSON.parse((result.content[0] as { text: string }).text);
    expect(info.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    const png = Buffer.from((result.content[1] as { data: string }).data, "base64");
    const evidenceFile = path.join(root, ".paper30min", "pdf-evidence", `${info.evidenceId}.json`);
    const evidence = parsePdfSourceEvidence(JSON.parse(await fs.readFile(evidenceFile, "utf8")));
    expect(evidence.contentSha256).toBe(sha256(png));
    expect(evidence.pages).toEqual([1]);
    expect(evidence.pdfSnapshotId).toBe(pdf.sourceSnapshotId);
    expect(evidence.sessionId).toBe("session-live");
    expect(evidence.taskId).toBe("call-1");
    const record = await createVerification({
      root,
      expectedRevisionId: revision.revisionId,
      anchor: unitAnchor(),
      actor: {
        kind: "agent",
        sessionId: "session-live",
        taskId: "call-1",
        evidenceIds: [info.evidenceId],
      },
    });
    for (const entry of record.coverage) expect(entry.validity).toBe("verified");

    // 未登记为来源快照的 PDF：读取仍成功，但不签发证据。
    await fs.copyFile(OTHER_PDF, path.join(root, "text", "other.pdf"));
    const other = await tool.execute(
      "call-2",
      { path: "text/other.pdf", page: 1 },
      undefined,
      undefined,
      {} as never,
    );
    const otherInfo = JSON.parse((other.content[0] as { text: string }).text);
    expect(otherInfo.evidenceId).toBeUndefined();
    expect(other.content.some((item) => item.type === "image")).toBe(true);
  } finally {
    await service.close();
  }
});

test("pdf-verification 继承接线：merge 发布修改已核验正文后标为 modified-unreviewed", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("修改继承", base);
  const record = await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const candidate = await createDocumentMergeCandidate({
    root,
    baseRevision: first.revisionId,
    sourceSnapshotId: pdf.sourceSnapshotId,
    candidate: changedTree(base),
  });
  const second = await publishDocumentMergeCandidate(candidate);
  const inherited = await readVerificationRecords(root, second.revisionId);
  expect(inherited).toHaveLength(1);
  expect(entryOf(inherited[0], selectionIds.sentence).validity).toBe("modified-unreviewed");
  expect(inherited[0].verifiedRevisionId).toBe(first.revisionId);
  expect(inherited[0].coverage.map(({ validity: _validity, ...rest }) => rest))
    .toEqual(record.coverage.map(({ validity: _validity, ...rest }) => rest));
  const old = await readVerificationRecords(root, first.revisionId);
  for (const entry of old[0].coverage) expect(entry.validity).toBe("verified");
  const tree = await readRevisionDocument(root, second.revisionId, "document");
  const summary = summarizeVerification(tree, inherited);
  expect(summary.nodes.find((node) => node.nodeId === selectionIds.sentence)?.status)
    .toBe("modified-unreviewed");
});

test("pdf-verification 继承接线：coreCommit 内容不变的移动保留 verified", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("移动继承", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const second = await commitViaCore(
    root,
    first.revisionId,
    pdf.sourceSnapshotId,
    movedTree(base),
    base,
  );
  const inherited = await readVerificationRecords(root, second.revisionId);
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("verified");
  expect(inherited[0].pdfSourceChanged).toBeUndefined();
});

test("pdf-verification 继承接线：拆分删除进入 tombstone 与 removed，新增节点无旧核验", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("拆分继承", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: { kind: "unit", unitId: selectionIds.secondUnit },
    actor: USER,
  });
  const split = treeWithoutSecondUnit(base);
  const added = addUnit(split);
  const candidate = await createDocumentMergeCandidate({
    root,
    baseRevision: first.revisionId,
    sourceSnapshotId: pdf.sourceSnapshotId,
    candidate: split,
  });
  const second = await publishDocumentMergeCandidate(candidate);
  const inherited = await readVerificationRecords(root, second.revisionId);
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("removed");
  const tombstones = await readRevisionTombstones(root, second.revisionId);
  expect(tombstones.some((entry) => entry.nodeId === selectionIds.secondUnit)).toBe(true);
  const tree = await readRevisionDocument(root, second.revisionId, "document");
  const summary = summarizeVerification(tree, inherited);
  for (const nodeId of [added.unitId, added.sentenceId, added.blockId])
    expect(summary.nodes.find((node) => node.nodeId === nodeId)?.status).toBe("unrecorded");
});

test("pdf-verification 继承接线：旧 section 核验不覆盖后加入的节点", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("section 新增", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: { kind: "section", sectionId: selectionIds.section },
    actor: USER,
  });
  const extended = structuredClone(base);
  const added = addUnit(extended);
  const second = await commitViaCore(
    root,
    first.revisionId,
    pdf.sourceSnapshotId,
    extended,
    base,
  );
  const inherited = await readVerificationRecords(root, second.revisionId);
  expect(entryOf(inherited[0], selectionIds.section).validity).toBe("modified-unreviewed");
  const tree = await readRevisionDocument(root, second.revisionId, "document");
  const summary = summarizeVerification(tree, inherited);
  for (const nodeId of [added.unitId, added.sentenceId, added.blockId])
    expect(summary.nodes.find((node) => node.nodeId === nodeId)?.status).toBe("unrecorded");
});

test("pdf-verification 继承接线：同 PDF 新解析快照内容不变保持 verified 与 provenance", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("重解析继承", base);
  const record = await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const parseSnapshot = await publishSourceSnapshot({
    root,
    files: {
      "result.jsonl": Buffer.from("{}\n"),
      "facts.json": Buffer.from("{}"),
    },
    metadata: {
      kind: "pdf-parse",
      parentSourceSnapshotId: pdf.sourceSnapshotId,
      parseBatchId: randomUUID(),
      provider: "baidu-aistudio",
      model: "PaddleOCR-VL-1.6",
      jobId: "job-verification",
      options: {
        useDocOrientationClassify: false,
        useDocUnwarping: false,
        useChartRecognition: false,
      },
      pageCount: 2,
      responseSha256: "b".repeat(64),
      sanitizedSha256: "c".repeat(64),
      sanitization: { replaced: 0, missing: 0, dropped: 0 },
      diagnostics: [],
    },
  });
  const second = await commitViaCore(
    root,
    first.revisionId,
    parseSnapshot.sourceSnapshotId,
    base,
    base,
  );
  const inherited = await readVerificationRecords(root, second.revisionId);
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("verified");
  expect(inherited[0].verifiedRevisionId).toBe(first.revisionId);
  expect(inherited[0].parseSnapshotId).toBe(record.parseSnapshotId);
  expect(inherited[0].pdfSnapshotId).toBe(pdf.sourceSnapshotId);
});

test("pdf-verification 继承接线：相同 PDF 字节复用不误判为来源变化", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("字节复用", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const reused = await snapshotLocalPdf({ root, source: SAMPLE });
  if (!reused.ok) throw new Error("reuse snapshot failed");
  expect(reused.reused).toBe(true);
  expect(reused.snapshot.sourceSnapshotId).toBe(pdf.sourceSnapshotId);
  const second = await commitViaCore(
    root,
    first.revisionId,
    reused.snapshot.sourceSnapshotId,
    base,
    base,
  );
  const inherited = await readVerificationRecords(root, second.revisionId);
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("verified");
  expect(inherited[0].pdfSourceChanged).toBeUndefined();
});

test("pdf-verification 继承接线：不同 PDF 内容未变成为 historical-source", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision: first } = await pdfProject("换源继承", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const other = await snapshotLocalPdf({ root, source: OTHER_PDF });
  if (!other.ok) throw new Error("other PDF snapshot failed");
  const second = await commitViaCore(
    root,
    first.revisionId,
    other.snapshot.sourceSnapshotId,
    base,
    base,
  );
  const inherited = await readVerificationRecords(root, second.revisionId);
  for (const entry of inherited[0].coverage) expect(entry.validity).toBe("historical-source");
  expect(inherited[0].pdfSourceChanged).toBe(true);
  const tree = await readRevisionDocument(root, second.revisionId, "document");
  const summary = summarizeVerification(tree, inherited);
  expect(summary.counts["historical-source"]).toBeGreaterThan(0);
  expect(summary.counts.verified).toBe(0);
});

test("pdf-verification 继承接线：不同 PDF 且内容改变同时表达两事实", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision: first } = await pdfProject("换源修改", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const other = await snapshotLocalPdf({ root, source: OTHER_PDF });
  if (!other.ok) throw new Error("other PDF snapshot failed");
  const second = await commitViaCore(
    root,
    first.revisionId,
    other.snapshot.sourceSnapshotId,
    changedTree(base),
    base,
  );
  const inherited = await readVerificationRecords(root, second.revisionId);
  expect(entryOf(inherited[0], selectionIds.sentence).validity).toBe("modified-unreviewed");
  expect(inherited[0].pdfSourceChanged).toBe(true);
});

test("pdf-verification 重新核验：修改后对新 current 核验，摘要按最新记录生效", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("重新核验", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const second = await commitViaCore(
    root,
    first.revisionId,
    pdf.sourceSnapshotId,
    changedTree(base),
    base,
  );
  const stale = await readVerificationRecords(root, second.revisionId);
  expect(entryOf(stale[0], selectionIds.sentence).validity).toBe("modified-unreviewed");
  const fresh = await createVerification({
    root,
    expectedRevisionId: second.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  expect(fresh.verifiedRevisionId).toBe(second.revisionId);
  const records = await readVerificationRecords(root, second.revisionId);
  expect(records).toHaveLength(2);
  const tree = await readRevisionDocument(root, second.revisionId, "document");
  const summary = summarizeVerification(tree, records);
  expect(summary.nodes.find((node) => node.nodeId === selectionIds.unit)?.status).toBe("verified");
  expect(summary.nodes.find((node) => node.nodeId === selectionIds.unit)?.verificationId)
    .toBe(fresh.verificationId);
});

test("pdf-verification PDF 快照损坏时拒绝核验并保留现场", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision } = await pdfProject("快照损坏", base);
  const pdfPath = path.join(root, pdf.path, "paper.pdf");
  await fs.writeFile(pdfPath, Buffer.concat([await fs.readFile(pdfPath), Buffer.from(" ")]));
  await expect(createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  })).rejects.toThrow();
  expect(await readVerificationRecords(root, revision.revisionId)).toEqual([]);
});

test("pdf-verification 预算：超 64 MiB 侧车与超 1 MiB 证据拒绝读取", async () => {
  const base = withAliases(testSelectionTree(randomUUID()));
  const { root, pdf, revision } = await pdfProject("预算", base);
  const evidence = await recordReadPdfEvidence({
    root,
    pdfSha256: pdf.sha256,
    page: 1,
    png: Buffer.from("page-1"),
    sessionId: "session-1",
    taskId: "task-1",
  });
  if (!evidence) throw new Error("真实读取路径未签发证据");
  const sidecarPath = path.join(
    root, ".paper30min", "revisions", revision.revisionId, "verification.json",
  );
  await fs.writeFile(sidecarPath, Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
  await expect(readVerificationRecords(root, revision.revisionId)).rejects.toThrow(/预算/);
  const evidencePath = path.join(
    root, ".paper30min", "pdf-evidence", `${evidence.evidenceId}.json`,
  );
  await fs.writeFile(evidencePath, Buffer.alloc(1024 * 1024 + 1, 0x20));
  await expect(createVerification({
    root,
    expectedRevisionId: revision.revisionId,
    anchor: unitAnchor(),
    actor: { kind: "agent", sessionId: "session-1", taskId: "task-1", evidenceIds: [evidence.evidenceId] },
  })).rejects.toThrow(/预算/);
});

test("pdf-verification 并发：两个同时发起的核验都保留，不互相覆盖", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, revision } = await pdfProject("并发核验", base);
  const [first, second] = await Promise.all([
    createVerification({
      root,
      expectedRevisionId: revision.revisionId,
      anchor: unitAnchor(),
      actor: USER,
    }),
    createVerification({
      root,
      expectedRevisionId: revision.revisionId,
      anchor: { kind: "unit", unitId: selectionIds.secondUnit },
      actor: USER,
    }),
  ]);
  const records = await readVerificationRecords(root, revision.revisionId);
  expect(records).toHaveLength(2);
  expect(new Set(records.map((record) => record.verificationId)))
    .toEqual(new Set([first.verificationId, second.verificationId]));
});

test("pdf-verification 并发：核验与 commit 串行互斥，不写旧 revision 也不丢记录", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("核验提交互斥", base);
  const staleAttempt = createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  }).then(
    () => "accepted" as const,
    (error: Error) => error.message,
  );
  const second = await commitViaCore(
    root,
    first.revisionId,
    pdf.sourceSnapshotId,
    changedTree(base),
    base,
  );
  const outcome = await staleAttempt;
  if (outcome === "accepted") {
    // 核验先取得写锁：记录落在旧 current，commit 继承必须带上它。
    const old = await readVerificationRecords(root, first.revisionId);
    expect(old).toHaveLength(1);
    const inherited = await readVerificationRecords(root, second.revisionId);
    expect(inherited).toHaveLength(1);
    expect(inherited[0].verifiedRevisionId).toBe(first.revisionId);
  } else {
    // commit 先推进 current：过期核验被拒绝，旧 revision 不新增侧车。
    expect(outcome).toMatch(/current/);
    expect(await readVerificationRecords(root, first.revisionId)).toEqual([]);
    expect(await readVerificationRecords(root, second.revisionId)).toEqual([]);
  }
});

test("pdf-verification 继承：merge 发布失败不留下孤儿侧车", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("孤儿侧车", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const candidate = await createDocumentMergeCandidate({
    root,
    baseRevision: first.revisionId,
    sourceSnapshotId: pdf.sourceSnapshotId,
    candidate: changedTree(base),
  });
  // 先把 current 推进到别的 revision：候选基线过期，发布必须失败。
  const moved = await commitViaCore(
    root,
    first.revisionId,
    pdf.sourceSnapshotId,
    movedTree(base),
    base,
  );
  await expect(publishDocumentMergeCandidate(candidate)).rejects.toThrow(/baseRevision/);
  expect(await readVerificationRecords(root, candidate.revisionId)).toEqual([]);
  const orphanDir = path.join(root, ".paper30min", "revisions", candidate.revisionId);
  const entries = await fs.readdir(orphanDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  expect(entries).not.toContain("verification.json");
  // 旧 current 的核验记录不受失败发布影响。
  const old = await readVerificationRecords(root, first.revisionId);
  expect(old).toHaveLength(1);
  const inherited = await readVerificationRecords(root, moved.revisionId);
  expect(inherited).toHaveLength(1);
});

test("pdf-verification 继承：coreCommit 失败不留下孤儿侧车", async () => {
  const base = testSelectionTree(randomUUID());
  const { root, pdf, revision: first } = await pdfProject("core 孤儿", base);
  await createVerification({
    root,
    expectedRevisionId: first.revisionId,
    anchor: unitAnchor(),
    actor: USER,
  });
  const revisionId = randomUUID();
  await expect(dispatchCoreCommand({
    type: "coreCommit",
    root,
    baseRevision: randomUUID(),
    sourceSnapshotId: pdf.sourceSnapshotId,
    revisionId,
    files: {
      "document.json": json(changedTree(base)),
      "source-base.json": json(base),
      "tombstones.json": json([]),
      "changeset.json": json({ baseRevision: first.revisionId }),
    },
  })).rejects.toThrow(/baseRevision/);
  expect(await readVerificationRecords(root, revisionId)).toEqual([]);
  const orphanDir = path.join(root, ".paper30min", "revisions", revisionId);
  const entries = await fs.readdir(orphanDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  expect(entries).not.toContain("verification.json");
});