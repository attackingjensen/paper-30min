import Type from "typebox";
import Schema from "typebox/schema";
import { DocumentAnchorSchema, type DocumentAnchor } from "./document/anchor.js";
import { parseDocumentChangeset, type DocumentChangeset } from "./document/changeset.js";
import type { DocumentTree } from "./document/tree.js";

const IdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const SessionFieldSchema = Type.String({ minLength: 1, maxLength: 200 });
const NodeTypeSchema = Type.Union([
  Type.Literal("section"),
  Type.Literal("unit"),
  Type.Literal("sentence"),
  Type.Literal("atom"),
  Type.Literal("block"),
]);
const ValiditySchema = Type.Union([
  Type.Literal("verified"),
  Type.Literal("modified-unreviewed"),
  Type.Literal("historical-source"),
  Type.Literal("removed"),
]);
const CoverageEntrySchema = Type.Object({
  nodeType: NodeTypeSchema,
  nodeId: IdSchema,
  contentSha256: Sha256Schema,
  quote: Type.String({ maxLength: 2000 }),
  range: Type.Optional(Type.Object({
    sentenceId: IdSchema,
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
const ActorSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("user"),
    confirmed: Type.Literal(true),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("agent"),
    sessionId: SessionFieldSchema,
    taskId: SessionFieldSchema,
    evidenceIds: Type.Array(IdSchema, { minItems: 1, maxItems: 1000, uniqueItems: true }),
  }, { additionalProperties: false }),
]);
const VerificationRecordSchema = Type.Object({
  verificationId: IdSchema,
  verifiedRevisionId: IdSchema,
  anchor: DocumentAnchorSchema,
  coverage: Type.Array(CoverageEntrySchema, { minItems: 1, maxItems: 200_000 }),
  pdfSnapshotId: IdSchema,
  parseSnapshotId: Type.Union([IdSchema, Type.Null()]),
  actor: ActorSchema,
  createdAt: Type.String({ minLength: 1, maxLength: 40 }),
  validity: ValiditySchema,
  pdfSourceChanged: Type.Optional(Type.Literal(true)),
}, { additionalProperties: false });
const VerificationSidecarSchema = Type.Object({
  formatVersion: Type.Literal(1),
  revisionId: IdSchema,
  records: Type.Array(VerificationRecordSchema),
}, { additionalProperties: false });
const PdfSourceEvidenceSchema = Type.Object({
  formatVersion: Type.Literal(1),
  evidenceId: IdSchema,
  projectId: IdSchema,
  paperId: IdSchema,
  pdfSnapshotId: IdSchema,
  pages: Type.Array(Type.Integer({ minimum: 1, maximum: 1000 }), {
    minItems: 1,
    maxItems: 1000,
    uniqueItems: true,
  }),
  sessionId: SessionFieldSchema,
  taskId: SessionFieldSchema,
  contentSha256: Sha256Schema,
  createdAt: Type.String({ minLength: 1, maxLength: 40 }),
}, { additionalProperties: false });

export type VerificationNodeType = Type.Static<typeof NodeTypeSchema>;
type VerificationValidity = Type.Static<typeof ValiditySchema>;
export type VerificationCoverageEntry = Type.Static<typeof CoverageEntrySchema>;
export type VerificationActor = Type.Static<typeof ActorSchema>;
export type VerificationRecord = Type.Static<typeof VerificationRecordSchema>;
type VerificationSidecar = Type.Static<typeof VerificationSidecarSchema>;
export type PdfSourceEvidenceRecord = Type.Static<typeof PdfSourceEvidenceSchema>;

/** 核验命令输入（SPEC-pdf-import §9）：user 必须显式 confirmed，agent 必须携带来源证据。 */
export type VerificationActorInput =
  | { kind: "user"; confirmed: boolean }
  | { kind: "agent"; sessionId: string; taskId: string; evidenceIds: string[] };

const sidecarSchema = Schema.Compile(VerificationSidecarSchema);
const evidenceSchema = Schema.Compile(PdfSourceEvidenceSchema);

function invalid(message: string): never {
  throw new Error(`核验记录无效：${message}`);
}

export function parseVerificationSidecar(
  value: unknown,
  expectedRevisionId?: string,
): VerificationSidecar {
  if (!sidecarSchema.Check(value)) invalid("不符合 verification formatVersion: 1 schema。");
  if (expectedRevisionId !== undefined && value.revisionId !== expectedRevisionId)
    invalid("侧车 revisionId 与所属 revision 不一致。");
  const ids = new Set<string>();
  for (const record of value.records) {
    if (ids.has(record.verificationId)) invalid(`核验 ID 重复：${record.verificationId}。`);
    ids.add(record.verificationId);
  }
  return value;
}

export function parsePdfSourceEvidence(
  value: unknown,
  identity?: { projectId: string; paperId: string },
): PdfSourceEvidenceRecord {
  if (!evidenceSchema.Check(value)) invalid("来源读取证据不符合 formatVersion: 1 schema。");
  if (identity && (value.projectId !== identity.projectId || value.paperId !== identity.paperId))
    invalid("来源读取证据不属于当前工程主论文。");
  return value;
}

/** 发布新 current 时的核验继承（SPEC-pdf-import §11）：保留原 verifiedRevisionId、来源与证据，
 * 只按实际 changeset 与 PDF 谱系另存当前 validity；不改写历史，不自动重挂新增节点。 */
export function inheritVerificationRecords(input: {
  records: VerificationRecord[];
  changeset: DocumentChangeset;
  currentPdfSnapshotId: string | null;
}): VerificationRecord[] {
  const changeset = parseDocumentChangeset(input.changeset);
  const statuses = new Map(changeset.changes.map((entry) => [entry.nodeId, entry.status]));
  return input.records.map((record) => {
    if (record.validity === "removed") return structuredClone(record);
    let changed = false;
    let gone = false;
    for (const entry of record.coverage) {
      const status = statuses.get(entry.nodeId);
      if (status === undefined || status === "removed" || status === "conflicted" || status === "added") {
        gone = true;
        break;
      }
      if (status === "changed") changed = true;
    }
    const samePdf = input.currentPdfSnapshotId !== null &&
      record.pdfSnapshotId === input.currentPdfSnapshotId;
    const validity: VerificationValidity = gone
      ? "removed"
      : changed
        ? "modified-unreviewed"
        : record.validity === "verified" && !samePdf
          ? "historical-source"
          : record.validity;
    return {
      ...structuredClone(record),
      validity,
      ...(samePdf ? {} : { pdfSourceChanged: true as const }),
    };
  });
}

type VerificationNodeStatus =
  | "verified"
  | "historical-source"
  | "modified-unreviewed"
  | "unrecorded";

interface VerificationSummary {
  counts: Record<VerificationNodeStatus, number>;
  nodes: Array<{
    nodeType: VerificationNodeType;
    nodeId: string;
    status: VerificationNodeStatus;
    verificationId: string | null;
  }>;
}

/** 文档级摘要（SPEC-pdf-import §9.5、§11）：按当前有效记录逐节点聚合四态，
 * 不合并为“全篇已审阅”，不产生任何主观质量分数。 */
export function summarizeVerification(
  tree: DocumentTree,
  records: VerificationRecord[],
): VerificationSummary {
  const effective = new Map<string, VerificationRecord>();
  const ordered = records
    .filter((record) => record.validity !== "removed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of ordered)
    for (const entry of record.coverage) effective.set(entry.nodeId, record);
  const counts: Record<VerificationNodeStatus, number> = {
    verified: 0,
    "historical-source": 0,
    "modified-unreviewed": 0,
    unrecorded: 0,
  };
  const nodes: VerificationSummary["nodes"] = [];
  const add = (nodeType: VerificationNodeType, nodeId: string) => {
    const record = effective.get(nodeId);
    const status: VerificationNodeStatus = record
      ? (record.validity as VerificationNodeStatus)
      : "unrecorded";
    counts[status] += 1;
    nodes.push({ nodeType, nodeId, status, verificationId: record?.verificationId ?? null });
  };
  for (const section of Object.values(tree.sections)) add("section", section.id);
  for (const unit of Object.values(tree.units)) add("unit", unit.id);
  for (const sentence of Object.values(tree.sentences)) add("sentence", sentence.id);
  for (const atom of Object.values(tree.atoms)) add("atom", atom.id);
  for (const block of tree.blocks) add("block", block.id);
  return { counts, nodes };
}