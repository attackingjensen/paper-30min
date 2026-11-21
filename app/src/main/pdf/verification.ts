import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { renameManaged } from "../managed-rename.js";
import {
  listSourceSnapshots,
  openProject,
  readRevision,
  readRevisionDocument,
  readSourceSnapshot,
  withProjectWriteLock,
  type ProjectCommitHooks,
} from "../project-core.js";
import {
  createRangeAnchor,
  documentAnchorDependencies,
  parseDocumentAnchor,
  type DocumentAnchor,
} from "../../shared/document/anchor.js";
import {
  createDocumentChangeset,
  documentNodeContentFingerprint,
  documentNodeExcerpt,
} from "../../shared/document/changeset.js";
import type { DocumentTree } from "../../shared/document/tree.js";
import {
  inheritVerificationRecords,
  parsePdfSourceEvidence,
  parseVerificationSidecar,
  type PdfSourceEvidenceRecord,
  type VerificationActor,
  type VerificationActorInput,
  type VerificationCoverageEntry,
  type VerificationNodeType,
  type VerificationRecord,
} from "../../shared/verification.js";

const SIDECAR_BUDGET = 64 * 1024 * 1024;
const EVIDENCE_BUDGET = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function excerpt(text: string): string {
  return Array.from(text).slice(0, 500).join("");
}

async function managedDirectory(root: string, relative: string, create: boolean) {
  let target = root;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    let entry;
    try {
      entry = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
      await fs.mkdir(target);
      entry = await fs.lstat(target);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("核验受管目录不能通过链接或普通文件访问。");
  }
  return target;
}

async function readManagedJsonFile(file: string, budget: number, description: string) {
  const entry = await fs.lstat(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > budget)
    throw new Error(`${description}无效或超过读取预算。`);
  const bytes = await fs.readFile(file);
  if (bytes.byteLength > budget) throw new Error(`${description}超过读取预算。`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${description}损坏；请保留现场检查。`);
  }
}

async function atomicWriteJson(destination: string, value: unknown, budget: number, description: string) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (bytes.byteLength > budget) throw new Error(`${description}超过写入预算。`);
  const temporary = path.join(path.dirname(destination), `.paper30min-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameManaged(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function nodeAliases(tree: DocumentTree, nodeType: VerificationNodeType, nodeId: string): string[] | undefined {
  switch (nodeType) {
    case "section":
      return tree.sections[nodeId]?.sourceAliases;
    case "unit":
      return tree.units[nodeId]?.sourceAliases;
    case "sentence":
      return tree.sentences[nodeId]?.sourceAliases;
    case "atom":
      return tree.atoms[nodeId]?.sourceAliases;
    case "block":
      return tree.blocks.find((block) => block.id === nodeId)?.sourceAliases;
  }
}

/** 创建时固定 coverage（SPEC-pdf-import §9）：展开锚点当时实际包含的节点，
 * 记录内容摘要与 quote；section 不覆盖未来新增节点。 */
export function resolveVerificationCoverage(tree: DocumentTree, anchor: DocumentAnchor): VerificationCoverageEntry[] {
  const ranges = anchor.kind === "range" ? anchor.ranges : [];
  const rangeBySentence = new Map(ranges.map((range) => [range.sentenceId, range]));
  return documentAnchorDependencies(tree, anchor).map((dependency) => {
    const entry: VerificationCoverageEntry = {
      nodeType: dependency.nodeType,
      nodeId: dependency.nodeId,
      contentSha256: sha256(documentNodeContentFingerprint(tree, dependency.nodeType, dependency.nodeId)),
      quote: documentNodeExcerpt(tree, dependency.nodeType, dependency.nodeId),
      validity: "verified",
    };
    const range = dependency.nodeType === "sentence" ? rangeBySentence.get(dependency.nodeId) : undefined;
    if (range) {
      entry.range = { sentenceId: range.sentenceId, start: range.start, end: range.end };
      entry.quote = excerpt(createRangeAnchor(tree, [range]).quote.text);
    }
    return entry;
  });
}

function requiredPages(tree: DocumentTree, coverage: VerificationCoverageEntry[]): Set<number> {
  const pages = new Set<number>();
  for (const entry of coverage) {
    for (const alias of nodeAliases(tree, entry.nodeType, entry.nodeId) ?? []) {
      const match = /^page-(\d+)/.exec(alias);
      if (match) pages.add(Number(match[1]));
    }
  }
  return pages;
}

/** PDF 来源谱系：pdf-parse 快照回溯父 PDF；pdf 快照即自身；其他来源无 PDF。 */
async function pdfLineage(root: string, sourceSnapshotId: string) {
  const snapshot = await readSourceSnapshot(root, sourceSnapshotId);
  if (snapshot.kind === "pdf") return { pdfSnapshotId: snapshot.sourceSnapshotId, parseSnapshotId: null };
  if (snapshot.kind === "pdf-parse") {
    const parentId = snapshot.parentSourceSnapshotId;
    if (typeof parentId !== "string" || !UUID.test(parentId)) throw new Error("解析快照缺少有效的父级 PDF 来源快照。");
    const parent = await readSourceSnapshot(root, parentId);
    if (parent.kind !== "pdf") throw new Error("解析快照的父级不是 PDF 来源快照。");
    return { pdfSnapshotId: parent.sourceSnapshotId, parseSnapshotId: snapshot.sourceSnapshotId };
  }
  return { pdfSnapshotId: null, parseSnapshotId: null };
}

export async function readVerificationRecords(root: string, revisionId: string): Promise<VerificationRecord[]> {
  if (!UUID.test(revisionId)) throw new Error("revisionId 无效。");
  const opened = await openProject(root);
  const directory = await managedDirectory(opened.root, `.paper30min/revisions/${revisionId}`, false);
  if (!directory) return [];
  const file = path.join(directory, "verification.json");
  try {
    await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value = await readManagedJsonFile(file, SIDECAR_BUDGET, "核验侧车");
  return parseVerificationSidecar(value, revisionId).records;
}

async function writeVerificationSidecar(root: string, revisionId: string, records: VerificationRecord[]) {
  const directory = await managedDirectory(root, `.paper30min/revisions/${revisionId}`, true);
  if (!directory) throw new Error("核验侧车目录不可用。");
  await atomicWriteJson(
    path.join(directory, "verification.json"),
    { formatVersion: 1, revisionId, records },
    SIDECAR_BUDGET,
    "核验侧车",
  );
}

async function loadEvidence(
  root: string,
  evidenceId: string,
  projectId: string,
  paperId: string,
): Promise<PdfSourceEvidenceRecord> {
  if (!UUID.test(evidenceId)) throw new Error(`来源读取证据不存在：${evidenceId}。`);
  const directory = await managedDirectory(root, ".paper30min/pdf-evidence", false);
  if (!directory) throw new Error(`来源读取证据不存在：${evidenceId}。`);
  let value: unknown;
  try {
    value = await readManagedJsonFile(path.join(directory, `${evidenceId}.json`), EVIDENCE_BUDGET, "来源读取证据");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`来源读取证据不存在：${evidenceId}。`);
    throw error;
  }
  return parsePdfSourceEvidence(value, { projectId, paperId });
}

/** 主进程 PDF 来源读取路径在实际提供页面字节后登记证据（SPEC-pdf-import §10.3）：
 * 绑定 PDF 快照、页、session/task 与实际提供内容的摘要；Agent 自述不能替代。
 * 仅供 read_pdf 真实渲染路径内部调用，不暴露给命令面。 */
async function recordPdfSourceEvidence(input: {
  root: string;
  pdfSnapshotId: string;
  pages: number[];
  sessionId: string;
  taskId: string;
  contentSha256: string;
}): Promise<PdfSourceEvidenceRecord> {
  const opened = await openProject(input.root);
  const root = opened.root;
  const snapshot = await readSourceSnapshot(root, input.pdfSnapshotId);
  if (snapshot.kind !== "pdf") throw new Error("只有 PDF 来源快照可以登记来源读取证据。");
  const pageCount = snapshot.pageCount;
  if (typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) || pageCount < 1)
    throw new Error("PDF 来源快照页数事实无效。");
  if (!Array.isArray(input.pages) || input.pages.length === 0) throw new Error("来源读取证据必须至少包含一页。");
  const pages = [...new Set(input.pages)];
  for (const page of pages)
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount)
      throw new Error(`来源读取证据页码必须在 1 到 ${pageCount} 之间。`);
  pages.sort((a, b) => a - b);
  if (!input.sessionId || !input.taskId || input.sessionId.length > 200 || input.taskId.length > 200)
    throw new Error("来源读取证据必须绑定有效的 session 与 task。");
  if (!SHA256.test(input.contentSha256)) throw new Error("来源读取证据内容摘要无效。");
  const evidence: PdfSourceEvidenceRecord = {
    formatVersion: 1,
    evidenceId: randomUUID(),
    projectId: opened.manifest.id,
    paperId: opened.manifest.paper.id,
    pdfSnapshotId: snapshot.sourceSnapshotId,
    pages,
    sessionId: input.sessionId,
    taskId: input.taskId,
    contentSha256: input.contentSha256,
    consumeNonce: sha256(randomUUID()),
    createdAt: new Date().toISOString(),
  };
  const directory = await managedDirectory(root, ".paper30min/pdf-evidence", true);
  if (!directory) throw new Error("来源读取证据目录不可用。");
  await atomicWriteJson(path.join(directory, `${evidence.evidenceId}.json`), evidence, EVIDENCE_BUDGET, "来源读取证据");
  return evidence;
}

/** read_pdf 真实渲染并提供页面字节后，在同一调用内按实际 PNG 摘要签发来源读取证据：
 * 文件摘要必须对应已发布 PDF 来源快照（谱系 sha256）；找不到快照时不签发，读取仍成功。
 * session 由 Agent 会话权威注入，task 为本次工具调用 id，renderer 与 Agent 均不能伪造。 */
export async function recordReadPdfEvidence(input: {
  root: string;
  pdfSha256: string;
  page: number;
  png: Uint8Array;
  sessionId: string;
  taskId: string;
}): Promise<PdfSourceEvidenceRecord | null> {
  if (!SHA256.test(input.pdfSha256)) return null;
  const opened = await openProject(input.root);
  let snapshotId: string | null = null;
  for (const snapshot of await listSourceSnapshots(opened.root)) {
    if (snapshot.kind !== "pdf" || snapshot.sha256 !== input.pdfSha256) continue;
    // 同一字节可存在多个快照（不同谱系）：取最新发布的快照作为证据绑定。
    if (snapshotId === null) snapshotId = snapshot.sourceSnapshotId;
    else {
      const previous = await readSourceSnapshot(opened.root, snapshotId);
      if (snapshot.createdAt.localeCompare(previous.createdAt) > 0) snapshotId = snapshot.sourceSnapshotId;
    }
  }
  if (snapshotId === null) return null;
  return recordPdfSourceEvidence({
    root: opened.root,
    pdfSnapshotId: snapshotId,
    pages: [input.page],
    sessionId: input.sessionId,
    taskId: input.taskId,
    contentSha256: sha256(input.png),
  });
}

/** 核验命令（SPEC-pdf-import §9–§10）：主进程校验锚点、coverage、来源与证据后原子写入侧车；
 * 不修改 document.json、source-base.json 或来源摘要。拒绝时保留现场，不写任何记录。
 * 复核 current、读侧车、追加与写入整体在工程写锁内，与 commitRevision 串行互斥。 */
export async function createVerification(input: {
  root: string;
  expectedRevisionId: string;
  anchor: unknown;
  actor: VerificationActorInput;
}): Promise<VerificationRecord> {
  const opened = await openProject(input.root);
  return withProjectWriteLock(opened.root, async () => {
    const root = opened.root;
    const latest = await openProject(root);
    const current = latest.manifest.paper.currentRevision;
    if (current === null || current !== input.expectedRevisionId)
      throw new Error(
        `current 已变化：核验请求基于 ${input.expectedRevisionId}，当前为 ${current ?? "无"}；拒绝建立核验记录。`,
      );
    if (input.actor.kind === "user" && input.actor.confirmed !== true)
      throw new Error("用户核验必须显式确认已对照此 PDF 范围。");
    const revision = await readRevision(root, current);
    const tree = await readRevisionDocument(root, current, "document");
    const anchor = parseDocumentAnchor(tree, input.anchor);
    const lineage = await pdfLineage(root, revision.sourceSnapshotId);
    if (lineage.pdfSnapshotId === null) throw new Error("当前 revision 没有 PDF 来源，不能建立 PDF 核验。");
    const coverage = resolveVerificationCoverage(tree, anchor);
    let actor: VerificationActor;
    if (input.actor.kind === "user") {
      actor = { kind: "user", confirmed: true };
    } else {
      const { sessionId, taskId } = input.actor;
      const evidenceIds = [...new Set(input.actor.evidenceIds ?? [])];
      if (!sessionId || !taskId || sessionId.length > 200 || taskId.length > 200)
        throw new Error("Agent 核验必须绑定有效的 session 与 task。");
      if (evidenceIds.length === 0) throw new Error("Agent 核验必须提供主进程来源读取证据。");
      const required = requiredPages(tree, coverage);
      if (required.size === 0) throw new Error("核验范围没有页级来源事实，Agent 不能建立核验。");
      const covered = new Set<number>();
      const loaded: { evidence: PdfSourceEvidenceRecord; file: string }[] = [];
      for (const evidenceId of evidenceIds) {
        const evidence = await loadEvidence(root, evidenceId, latest.manifest.id, latest.manifest.paper.id);
        if (evidence.sessionId !== sessionId || evidence.taskId !== taskId)
          throw new Error("来源读取证据与核验任务的 session/task 不一致。");
        if (evidence.pdfSnapshotId !== lineage.pdfSnapshotId) throw new Error("来源读取证据不属于当前 PDF 快照。");
        // 一次性：已消费的证据不得重放建立新核验（renderer 可读 evidenceId）。
        if (evidence.consumedAt !== undefined) throw new Error(`来源读取证据已消费，不能重复用于核验：${evidenceId}。`);
        for (const page of evidence.pages) covered.add(page);
        loaded.push({
          evidence,
          file: path.join(root, ".paper30min", "pdf-evidence", `${evidenceId}.json`),
        });
      }
      const missing = [...required].filter((page) => !covered.has(page)).sort((a, b) => a - b);
      if (missing.length > 0) throw new Error(`来源读取证据未覆盖请求范围：缺少页 ${missing.join("、")}。`);
      // 校验全部通过后才烧掉 nonce：任何失败都不消费证据，可修正后重试。
      const consumedAt = new Date().toISOString();
      for (const { evidence, file } of loaded)
        await atomicWriteJson(file, { ...evidence, consumedAt }, EVIDENCE_BUDGET, "来源读取证据");
      actor = { kind: "agent", sessionId, taskId, evidenceIds };
    }
    const record: VerificationRecord = {
      verificationId: randomUUID(),
      verifiedRevisionId: current,
      anchor,
      coverage,
      pdfSnapshotId: lineage.pdfSnapshotId,
      parseSnapshotId: lineage.parseSnapshotId,
      actor,
      createdAt: new Date().toISOString(),
    };
    const existing = await readVerificationRecords(root, current);
    await writeVerificationSidecar(root, current, [...existing, record]);
    return record;
  });
}

/** 发布新 current 前生成继承侧车（SPEC-pdf-import §11）：按旧记录、实际 changeset
 * 与 PDF 谱系逐节点另存 validity；无旧记录时不写侧车。仅经 verificationInheritCommitHooks
 * 注入 commitRevision 的 before-current-replace 钩子调用：校验失败不产生孤儿侧车。 */
async function inheritVerificationSidecar(input: {
  root: string;
  baseRevision: string;
  revisionId: string;
  sourceSnapshotId: string;
  document: DocumentTree;
}): Promise<void> {
  const opened = await openProject(input.root);
  const root = opened.root;
  const records = await readVerificationRecords(root, input.baseRevision);
  if (records.length === 0) return;
  const baseDocument = await readRevisionDocument(root, input.baseRevision, "document");
  const changeset = createDocumentChangeset({
    base: baseDocument,
    current: input.document,
    baseRevision: input.baseRevision,
    revisionId: input.revisionId,
  });
  const lineage = await pdfLineage(root, input.sourceSnapshotId);
  const inherited = inheritVerificationRecords({
    records,
    changeset,
    currentPdfSnapshotId: lineage.pdfSnapshotId,
  });
  await writeVerificationSidecar(root, input.revisionId, inherited);
}

/** PDF 侧核验继承的 commit 钩子：由持有 PDF 语义的调用方注入通用提交路径
 * （coreCommit、merge 发布、重解析候选发布）。在 commit 校验通过后、current
 * 替换前的串行临界区内执行：提交失败不产生孤儿侧车；首次发布无旧记录，空操作。 */
export function verificationInheritCommitHooks(input: {
  root: string;
  baseRevision: string | null;
  revisionId: string;
  sourceSnapshotId: string;
  document: DocumentTree;
}): ProjectCommitHooks {
  return {
    onCommitPoint: async (point) => {
      if (point !== "before-current-replace" || input.baseRevision === null) return;
      await inheritVerificationSidecar({
        root: input.root,
        baseRevision: input.baseRevision,
        revisionId: input.revisionId,
        sourceSnapshotId: input.sourceSnapshotId,
        document: input.document,
      });
    },
  };
}
