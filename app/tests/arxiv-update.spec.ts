// SPEC-arxiv-import §8 契约回归（arxiv-import 更新编排）：新版本检查只读 abs；
// 更新候选、同版重取与离线重新转换形成三方合并候选；确认发布前 current 不变，
// stale base 拒绝。受控 transport + 真实临时工程；离线动作以无 transport 签名与必失败探针证明不触网。
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  commitRevision,
  listSourceSnapshots,
  openProject,
  readRevision,
  readRevisionDocument,
} from "../src/main/project-core";
import { importArxivPaper } from "../src/main/arxiv/import";
import {
  checkArxivUpdate,
  fetchArxivUpdateCandidate,
  refetchArxivSnapshot,
  reconvertArxivCandidate,
  publishArxivUpdateCandidate,
} from "../src/main/arxiv/update";
import type { ArxivFetchResponse, ArxivTransport } from "../src/main/arxiv/fetch";
import { ArxivFetchError } from "../src/main/arxiv/fetch";
import { absHtml } from "./fixtures/arxiv-abs";
import { latexmlDocument, FIG1_SRC, FIG2_SRC } from "./fixtures/arxiv-latexml";

const BASE = "http://127.0.0.1:9999";
const ID = "2401.01234";
const absUrl = (version: number | null) => `${BASE}/abs/${version === null ? ID : `${ID}v${version}`}`;
const htmlUrl = (version: number) => `${BASE}/html/${ID}v${version}`;
const FIG1_URL = `${BASE}/html/extracted/6543210/figures/overview.png`;
const FIG2_URL = `${BASE}/html/x2.png`;
const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);

let sandbox: string;
test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-arxiv-update-"));
});
test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

function fullRoutes(): Record<string, { bytes: Uint8Array; mime: string }> {
  return {
    [absUrl(null)]: { bytes: Buffer.from(absHtml({ id: ID, versions: [1] })), mime: "text/html" },
    [absUrl(1)]: { bytes: Buffer.from(absHtml({ id: ID, versions: [1] })), mime: "text/html" },
    [htmlUrl(1)]: { bytes: Buffer.from(latexmlDocument()), mime: "text/html" },
    [FIG1_URL]: { bytes: PNG1, mime: "image/png" },
    [FIG2_URL]: { bytes: PNG2, mime: "image/png" },
  };
}

function controlledTransport(routes: Record<string, { bytes: Uint8Array; mime: string }>) {
  const calls: string[] = [];
  const transport: ArxivTransport = async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new ArxivFetchError("arxiv-fetch-status", url, 404);
    const response: ArxivFetchResponse = {
      status: 200,
      url,
      redirectChain: [url],
      headers: { "content-type": route.mime },
      bytes: route.bytes,
    };
    return response;
  };
  return { calls, transport };
}

/** 必定失败的 transport 探针：任何调用都记录并抛错，证明离线路径未触网。 */
function forbiddenTransport() {
  const calls: string[] = [];
  const transport: ArxivTransport = async (url: string) => {
    calls.push(url);
    throw new Error(`离线动作不得访问网络：${url}`);
  };
  return { calls, transport };
}

/** v2 LaTeX 文档：同一 base ID，citation 元数据固定 v2，结论句有真实内容变化。 */
function latexmlV2(): string {
  return latexmlDocument()
    .replace('content="2401.01234v1"', 'content="2401.01234v2"')
    .replace("We conclude with", "We now conclude with");
}

async function importedProject(name: string) {
  const { transport } = controlledTransport(fullRoutes());
  const imported = await importArxivPaper({ parent: sandbox, name, input: ID, transport, baseUrl: BASE });
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(imported.diagnostic.messageKey);
  return imported;
}

/** 编辑提交必须携带基线 revision 的全部受管资产（真实编辑器路径同样如此）。 */
async function revisionAssets(root: string, revisionId: string) {
  const revision = await readRevision(root, revisionId);
  const files: Record<string, { bytes: Uint8Array; mime?: string }> = {};
  for (const file of revision.files) {
    if (!file.path.startsWith("assets/")) continue;
    const bytes = await fs.readFile(path.join(root, revision.path, file.path));
    files[file.path] = { bytes, ...(file.mime === undefined ? {} : { mime: file.mime }) };
  }
  return files;
}

/** 在 current 上追加本地句子修正（模拟用户编辑），返回新 current。 */
async function localEdit(root: string, baseRevision: string, text: string) {
  const revision = await readRevision(root, baseRevision);
  const tree = await readRevisionDocument(root, baseRevision, "document");
  const unitId = Object.values(tree.units).find((unit) =>
    unit.sentenceIds.some((id) =>
      tree.sentences[id].content.some((part) => part.kind === "text" && part.text.includes("We study energy"))))!
    .id;
  const sentenceId = tree.units[unitId].sentenceIds[0];
  tree.sentences[sentenceId].content.push({ kind: "text", text });
  return commitRevision({
    root,
    baseRevision,
    sourceSnapshotId: revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(tree)),
      "source-base.json": Buffer.from(JSON.stringify(await readRevisionDocument(root, baseRevision, "source-base"))),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision })),
      ...(await revisionAssets(root, baseRevision)),
    },
  });
}

function sentenceTexts(tree: Awaited<ReturnType<typeof readRevisionDocument>>): string[] {
  return Object.values(tree.units).flatMap((unit) =>
    unit.sentenceIds.flatMap((id) =>
      tree.sentences[id].content.map((part) => (part.kind === "text" ? part.text : ""))));
}

test("arxiv-import 更新检查只读 abs：报告新版本，不下载 HTML、不生成候选或推进 current", async () => {
  const imported = await importedProject("检查新版");
  const routes = fullRoutes();
  routes[absUrl(null)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" };
  routes[absUrl(2)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" };
  routes[htmlUrl(2)] = { bytes: Buffer.from(latexmlV2()), mime: "text/html" };
  const { calls, transport } = controlledTransport(routes);

  const checked = await checkArxivUpdate({ root: imported.root, transport, baseUrl: BASE });
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.status).toBe("update-available");
  if (checked.status !== "update-available") return;
  expect(checked.current.version).toBe(1);
  expect(checked.latest).toEqual({ baseId: ID, version: 2, canonicalId: `${ID}v2` });
  // 只读 abs：无 HTML/资产/PDF 请求，无快照、revision 或 current 变化。
  expect(calls.every((url) => url.startsWith(`${BASE}/abs/`))).toBe(true);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(1);
  const opened = await openProject(imported.root);
  expect(opened.manifest.paper.currentRevision).toBe(imported.revision.revisionId);
  expect(await fs.readdir(path.join(imported.root, "paper", "revisions"))).toEqual([imported.revision.revisionId]);
});

test("arxiv-import 更新检查已经最新与无法检查如实区分；同版远端 HTML 变化不冒充新版本", async () => {
  const imported = await importedProject("已经最新");
  const routes = fullRoutes();
  // 同版 HTML 字节已变化：检查更新只报告论文版本状态，不比较 HTML。
  routes[htmlUrl(1)] = { bytes: Buffer.from(latexmlDocument().replace("System overview.", "Changed caption.")), mime: "text/html" };
  const { calls, transport } = controlledTransport(routes);
  const latest = await checkArxivUpdate({ root: imported.root, transport, baseUrl: BASE });
  expect(latest.ok).toBe(true);
  if (latest.ok) expect(latest.status).toBe("up-to-date");
  expect(calls.every((url) => url.startsWith(`${BASE}/abs/`))).toBe(true);

  const broken = controlledTransport({});
  const failed = await checkArxivUpdate({ root: imported.root, transport: broken.transport, baseUrl: BASE });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.diagnostic.stage).toBe("resolve");
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
});

test("arxiv-import 更新检查撤稿新版如实报告 withdrawn，不产生候选或自动采用上一版", async () => {
  const imported = await importedProject("撤稿新版");
  const routes = fullRoutes();
  routes[absUrl(null)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], withdrawn: [2] })), mime: "text/html" };
  const { calls, transport } = controlledTransport(routes);
  const checked = await checkArxivUpdate({ root: imported.root, transport, baseUrl: BASE });
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.status).toBe("withdrawn");
  if (checked.status !== "withdrawn") return;
  expect(checked.latest.version).toBe(2);
  expect(calls.every((url) => url.startsWith(`${BASE}/abs/`))).toBe(true);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(1);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
});

test("arxiv-import 更新候选：三方合并保留本地修正，确认发布前 current 不变，stale base 拒绝", async () => {
  const imported = await importedProject("新版候选");
  const edited = await localEdit(imported.root, imported.revision.revisionId, " local note");
  const routes = fullRoutes();
  routes[htmlUrl(2)] = { bytes: Buffer.from(latexmlV2()), mime: "text/html" };
  routes[absUrl(2)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" };
  const { calls, transport } = controlledTransport(routes);

  const candidate = await fetchArxivUpdateCandidate({
    root: imported.root,
    baseRevision: edited.revisionId,
    reference: { baseId: ID, version: 2, canonicalId: `${ID}v2` },
    transport,
    baseUrl: BASE,
  });
  expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
  if (!candidate.ok) return;
  expect(candidate.candidate.baseRevision).toBe(edited.revisionId);
  expect(candidate.candidate.conflicts).toEqual([]);
  expect(candidate.candidate.sourceSnapshotId).not.toBe(imported.revision.sourceSnapshotId);
  // 候选未发布：current 仍是本地修正版，新版快照已不可变落盘。
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(edited.revisionId);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(2);
  expect(calls.some((url) => url === htmlUrl(2))).toBe(true);
  expect(calls.some((url) => url.includes("/pdf/"))).toBe(false);
  // 合并文档同时保留本地修正与来源 v2 修正；source-base 只含来源内容。
  const mergedTexts = sentenceTexts(candidate.candidate.document).join(" ");
  expect(mergedTexts).toContain("local note");
  expect(mergedTexts).toContain("We now conclude with");
  expect(sentenceTexts(candidate.candidate.sourceBase).join(" ")).not.toContain("local note");

  // stale base：候选基于 edited，若 current 又前进则发布拒绝，候选保留。
  const ahead = await localEdit(imported.root, edited.revisionId, " second note");
  const stale = await publishArxivUpdateCandidate({
    root: imported.root,
    sourceSnapshotId: candidate.candidate.sourceSnapshotId,
    baseRevision: edited.revisionId,
  });
  expect(stale.ok).toBe(false);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(ahead.revisionId);

  // 以最新 current 重建候选并确认发布：本地修正不丢失。
  const fresh = await fetchArxivUpdateCandidate({
    root: imported.root,
    baseRevision: ahead.revisionId,
    reference: { baseId: ID, version: 2, canonicalId: `${ID}v2` },
    transport,
    baseUrl: BASE,
  });
  expect(fresh.ok).toBe(true);
  if (!fresh.ok) return;
  const published = await publishArxivUpdateCandidate({
    root: imported.root,
    sourceSnapshotId: fresh.candidate.sourceSnapshotId,
    baseRevision: ahead.revisionId,
  });
  expect(published.ok, JSON.stringify(published)).toBe(true);
  if (!published.ok) return;
  expect(published.revision.baseRevision).toBe(ahead.revisionId);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(published.revision.revisionId);
  const finalTexts = sentenceTexts(await readRevisionDocument(imported.root, published.revision.revisionId, "document")).join(" ");
  expect(finalTexts).toContain("local note");
  expect(finalTexts).toContain("second note");
  expect(finalTexts).toContain("We now conclude with");
});

test("arxiv-import 更新候选拒绝其他 base ID 与撤稿版本，不静默换来源", async () => {
  const imported = await importedProject("边界拒绝");
  const routes = fullRoutes();
  routes[absUrl(2)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2], withdrawn: [2] })), mime: "text/html" };
  routes[htmlUrl(2)] = { bytes: Buffer.from(latexmlV2()), mime: "text/html" };
  const { calls, transport } = controlledTransport(routes);

  const other = await fetchArxivUpdateCandidate({
    root: imported.root,
    baseRevision: imported.revision.revisionId,
    reference: { baseId: "2401.99999", version: 1, canonicalId: "2401.99999v1" },
    transport,
    baseUrl: BASE,
  });
  expect(other.ok).toBe(false);
  if (!other.ok) expect(other.diagnostic.code).toBe("arxiv-update-identity-mismatch");
  expect(calls).toHaveLength(0);

  const withdrawn = await fetchArxivUpdateCandidate({
    root: imported.root,
    baseRevision: imported.revision.revisionId,
    reference: { baseId: ID, version: 2, canonicalId: `${ID}v2` },
    transport,
    baseUrl: BASE,
  });
  expect(withdrawn.ok).toBe(false);
  if (!withdrawn.ok) expect(withdrawn.diagnostic.code).toBe("arxiv-version-withdrawn");
  expect(calls.some((url) => url.startsWith(`${BASE}/html/`))).toBe(false);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(1);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
});

test("arxiv-import 同版重取：相同字节复用快照，不制造重复快照或候选", async () => {
  const imported = await importedProject("同版复用");
  const { calls, transport } = controlledTransport(fullRoutes());
  const refetched = await refetchArxivSnapshot({
    root: imported.root,
    baseRevision: imported.revision.revisionId,
    transport,
    baseUrl: BASE,
  });
  expect(refetched.ok, JSON.stringify(refetched)).toBe(true);
  if (!refetched.ok) return;
  expect(refetched.outcome).toBe("reused");
  if (refetched.outcome !== "reused") return;
  expect(refetched.sourceSnapshotId).toBe(imported.revision.sourceSnapshotId);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(1);
  expect(await fs.readdir(path.join(imported.root, "paper", "revisions"))).toEqual([imported.revision.revisionId]);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);
  expect(calls.some((url) => url === htmlUrl(1))).toBe(true);
});

test("arxiv-import 同版重取：字节不同新建快照与候选，规范正文相同则 changeset 无内容变化", async () => {
  const imported = await importedProject("同版异字节");
  const routes = fullRoutes();
  // 仅 HTML 注释变化：来源字节不同，规范正文完全相同。
  routes[htmlUrl(1)] = { bytes: Buffer.from(latexmlDocument().replace("<body>", "<body><!-- refreshed -->")), mime: "text/html" };
  const { transport } = controlledTransport(routes);
  const refetched = await refetchArxivSnapshot({
    root: imported.root,
    baseRevision: imported.revision.revisionId,
    transport,
    baseUrl: BASE,
  });
  expect(refetched.ok, JSON.stringify(refetched)).toBe(true);
  if (!refetched.ok) return;
  expect(refetched.outcome).toBe("candidate");
  if (refetched.outcome !== "candidate") return;
  expect(refetched.candidate.sourceSnapshotId).not.toBe(imported.revision.sourceSnapshotId);
  expect(refetched.candidate.baseRevision).toBe(imported.revision.revisionId);
  expect(refetched.candidate.conflicts).toEqual([]);
  // 规范正文相同：changeset 不得把派生内容标为 changed/stale。
  expect(refetched.candidate.changeset.changes.some((entry) =>
    entry.status === "changed" || entry.status === "added" || entry.status === "removed")).toBe(false);
  // 新快照不可变落盘，旧快照保留，current 未被覆盖。
  const snapshots = await listSourceSnapshots(imported.root);
  expect(snapshots).toHaveLength(2);
  expect(snapshots.map((snapshot) => snapshot.sourceSnapshotId)).toContain(imported.revision.sourceSnapshotId);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(imported.revision.revisionId);

  // 确认发布后 current 推进，正文与旧 current 一致。
  const published = await publishArxivUpdateCandidate({
    root: imported.root,
    sourceSnapshotId: refetched.candidate.sourceSnapshotId,
    baseRevision: imported.revision.revisionId,
  });
  expect(published.ok).toBe(true);
  if (!published.ok) return;
  const before = await readRevisionDocument(imported.root, imported.revision.revisionId, "document");
  const after = await readRevisionDocument(imported.root, published.revision.revisionId, "document");
  // 规范正文集合一致（块遍历顺序可因 UUID 排序不同，内容不得变化）。
  expect([...sentenceTexts(after)].sort()).toEqual([...sentenceTexts(before)].sort());
});

test("arxiv-import 离线重新转换：不触网、不伪造 source-base，确认前 current 不变", async () => {
  const imported = await importedProject("离线重转换");
  const edited = await localEdit(imported.root, imported.revision.revisionId, " offline keep");
  const reconverted = await reconvertArxivCandidate({
    root: imported.root,
    sourceSnapshotId: imported.revision.sourceSnapshotId,
    baseRevision: edited.revisionId,
  });
  expect(reconverted.ok, JSON.stringify(reconverted)).toBe(true);
  if (!reconverted.ok) return;
  expect(reconverted.candidate.baseRevision).toBe(edited.revisionId);
  expect(reconverted.candidate.conflicts).toEqual([]);
  // 重新转换的 source-base 来自快照原始内容，不得混入本地修正。
  expect(sentenceTexts(reconverted.candidate.sourceBase).join(" ")).not.toContain("offline keep");
  expect(sentenceTexts(reconverted.candidate.document).join(" ")).toContain("offline keep");
  // 同一快照与算法版本：规范内容不变，changeset 无内容变化。
  expect(reconverted.candidate.changeset.changes.some((entry) =>
    entry.status === "changed" || entry.status === "added" || entry.status === "removed")).toBe(false);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(edited.revisionId);
  expect(await listSourceSnapshots(imported.root)).toHaveLength(1);

  // 确定性：同一基线重复重转换沿用同一候选身份。
  const again = await reconvertArxivCandidate({
    root: imported.root,
    sourceSnapshotId: imported.revision.sourceSnapshotId,
    baseRevision: edited.revisionId,
  });
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.candidate.revisionId).toBe(reconverted.candidate.revisionId);

  const published = await publishArxivUpdateCandidate({
    root: imported.root,
    sourceSnapshotId: imported.revision.sourceSnapshotId,
    baseRevision: edited.revisionId,
  });
  expect(published.ok).toBe(true);
  if (!published.ok) return;
  expect(published.revision.revisionId).toBe(reconverted.candidate.revisionId);
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(published.revision.revisionId);
});

test("arxiv-import 更新冲突候选未解决拒绝发布，显式选择后发布，旧 current 全程可读", async () => {
  const imported = await importedProject("冲突候选");
  // 本地与来源改同一句：摘要 unit 双方不同修改 → content 冲突。
  const revision = await readRevision(imported.root, imported.revision.revisionId);
  const tree = await readRevisionDocument(imported.root, imported.revision.revisionId, "document");
  const unit = Object.values(tree.units).find((candidate) =>
    candidate.sentenceIds.some((id) =>
      tree.sentences[id].content.some((part) => part.kind === "text" && part.text.includes("We study energy"))))!;
  const sentenceId = unit.sentenceIds[0];
  tree.sentences[sentenceId].content = [{ kind: "text", text: "We study energy and mass. local rewrite" }];
  const edited = await commitRevision({
    root: imported.root,
    baseRevision: imported.revision.revisionId,
    sourceSnapshotId: revision.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(tree)),
      "source-base.json": Buffer.from(JSON.stringify(await readRevisionDocument(imported.root, imported.revision.revisionId, "source-base"))),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: imported.revision.revisionId })),
      ...(await revisionAssets(imported.root, imported.revision.revisionId)),
    },
  });
  const routes = fullRoutes();
  routes[htmlUrl(1)] = {
    bytes: Buffer.from(latexmlDocument().replace("We study energy and mass.", "We study energy and mass. source rewrite")),
    mime: "text/html",
  };
  const { transport } = controlledTransport(routes);
  const refetched = await refetchArxivSnapshot({
    root: imported.root,
    baseRevision: edited.revisionId,
    transport,
    baseUrl: BASE,
  });
  expect(refetched.ok).toBe(true);
  if (!refetched.ok) return;
  expect(refetched.outcome).toBe("candidate");
  if (refetched.outcome !== "candidate") return;
  expect(refetched.candidate.conflicts.length).toBeGreaterThan(0);
  const conflict = refetched.candidate.conflicts[0];

  const blocked = await publishArxivUpdateCandidate({
    root: imported.root,
    sourceSnapshotId: refetched.candidate.sourceSnapshotId,
    baseRevision: edited.revisionId,
  });
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.diagnostic.messageKey).toContain("未解决");
  expect((await openProject(imported.root)).manifest.paper.currentRevision).toBe(edited.revisionId);

  const resolved = await publishArxivUpdateCandidate({
    root: imported.root,
    sourceSnapshotId: refetched.candidate.sourceSnapshotId,
    baseRevision: edited.revisionId,
    resolutions: [{ conflictId: conflict.id, choice: "candidate" }],
  });
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
  if (!resolved.ok) return;
  const finalTexts = sentenceTexts(await readRevisionDocument(imported.root, resolved.revision.revisionId, "document")).join(" ");
  expect(finalTexts).toContain("source rewrite");
  expect(finalTexts).not.toContain("local rewrite");
});

test("arxiv-import PDF 回退工程按谱系参与更新检查与候选，baseId 与 paper.id 不变", async () => {
  // 构造回退后的谱系现场：pdf（arXiv 事实）→ pdf-parse → current。
  const { publishSourceSnapshot } = await import("../src/main/project-core");
  const { testDocumentTree } = await import("./fixtures/document-tree");
  const created = await (await import("../src/main/project-core")).createProject({ parent: sandbox, name: "回退更新" });
  const pdfSnapshot = await publishSourceSnapshot({
    root: created.root,
    files: { "paper.pdf": Buffer.from("%PDF-1.7 fixture") },
    metadata: {
      kind: "pdf",
      sha256: "0".repeat(64),
      pageCount: 1,
      originalName: `${ID}v1.pdf`,
      arxiv: { baseId: ID, version: 1, pdfUrl: `https://arxiv.org/pdf/${ID}v1` },
    },
  });
  const parseSnapshot = await publishSourceSnapshot({
    root: created.root,
    files: { "result.jsonl": Buffer.from("{}\n") },
    metadata: { kind: "pdf-parse", parentSourceSnapshotId: pdfSnapshot.sourceSnapshotId, parseBatchId: randomUUID() },
  });
  const pdfTree = testDocumentTree(created.manifest.paper.id, "PDF 正文");
  const current = await commitRevision({
    root: created.root,
    baseRevision: null,
    sourceSnapshotId: parseSnapshot.sourceSnapshotId,
    files: {
      "document.json": Buffer.from(JSON.stringify(pdfTree)),
      "source-base.json": Buffer.from(JSON.stringify(pdfTree)),
      "tombstones.json": Buffer.from("[]"),
      "changeset.json": Buffer.from(JSON.stringify({ baseRevision: null })),
    },
  });
  const routes = fullRoutes();
  routes[absUrl(null)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" };
  routes[absUrl(2)] = { bytes: Buffer.from(absHtml({ id: ID, versions: [1, 2] })), mime: "text/html" };
  routes[htmlUrl(2)] = { bytes: Buffer.from(latexmlV2()), mime: "text/html" };
  const { calls, transport } = controlledTransport(routes);

  const checked = await checkArxivUpdate({ root: created.root, transport, baseUrl: BASE });
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.status).toBe("update-available");
  if (checked.status !== "update-available") return;
  expect(checked.current.version).toBe(1);

  const candidate = await fetchArxivUpdateCandidate({
    root: created.root,
    baseRevision: current.revisionId,
    reference: { baseId: ID, version: 2, canonicalId: `${ID}v2` },
    transport,
    baseUrl: BASE,
  });
  expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
  if (!candidate.ok) return;
  expect(candidate.candidate.baseRevision).toBe(current.revisionId);
  // HTML 候选树以同一 paper.id 合并；PDF 正文与 HTML 正文互不相干，冲突显式保留。
  expect(candidate.candidate.document.paperId).toBe(created.manifest.paper.id);
  expect((await openProject(created.root)).manifest.paper.currentRevision).toBe(current.revisionId);
  expect(calls.some((url) => url.includes("/pdf/"))).toBe(false);
});

test("arxiv-import 首次导入未完成时拒绝更新动作，不绕过恢复流程", async () => {
  const { createProject } = await import("../src/main/project-core");
  const created = await createProject({ parent: sandbox, name: "无正文" });
  const probe = forbiddenTransport();
  const checked = await checkArxivUpdate({ root: created.root, transport: probe.transport, baseUrl: BASE });
  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.diagnostic.code).toBe("arxiv-update-current-missing");
  const candidate = await reconvertArxivCandidate({
    root: created.root,
    sourceSnapshotId: randomUUID(),
    baseRevision: randomUUID(),
  });
  expect(candidate.ok).toBe(false);
  expect(probe.calls).toHaveLength(0);
});
