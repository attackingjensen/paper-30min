// arXiv 来源谱系回溯（SPEC-arxiv-import §7–8，7uo 移交项 4）。
// 只读 project-core 快照记录；PDF 回退后的 current 来源是 pdf-parse，
// 沿 parentSourceSnapshotId 回溯 pdf 快照携带的 arXiv 事实（baseId/version）。
// 不访问网络，不改写任何快照。
import type { ArxivReference } from "../../shared/arxiv.js";
import type { SourceSnapshotRecord } from "../../shared/contracts.js";
import { readSourceSnapshot } from "../project-core.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function arxivReferenceOf(snapshot: SourceSnapshotRecord): ArxivReference | null {
  if (snapshot.kind === "arxiv") {
    if (typeof snapshot.baseId !== "string" || typeof snapshot.version !== "number") return null;
    return {
      baseId: snapshot.baseId,
      version: snapshot.version,
      canonicalId: typeof snapshot.canonicalId === "string"
        ? snapshot.canonicalId
        : `${snapshot.baseId}v${snapshot.version}`,
    };
  }
  if (snapshot.kind === "pdf") {
    const arxiv = snapshot.arxiv;
    if (
      typeof arxiv !== "object" || arxiv === null ||
      !("baseId" in arxiv) || typeof arxiv.baseId !== "string" ||
      !("version" in arxiv) || typeof arxiv.version !== "number"
    ) return null;
    return {
      baseId: arxiv.baseId,
      version: arxiv.version,
      canonicalId: `${arxiv.baseId}v${arxiv.version}`,
    };
  }
  return null;
}

/** 从来源快照回溯 arXiv 身份：arxiv 快照即自身；pdf 快照读谱系事实；
 * pdf-parse 沿父级回溯一跳；本地 PDF 或无谱系来源返回 null，不猜测身份。 */
export async function arxivLineageReference(
  root: string,
  sourceSnapshotId: string,
): Promise<ArxivReference | null> {
  const snapshot = await readSourceSnapshot(root, sourceSnapshotId);
  if (snapshot.kind === "pdf-parse") {
    const parentId = snapshot.parentSourceSnapshotId;
    if (typeof parentId !== "string" || !UUID.test(parentId)) return null;
    return arxivReferenceOf(await readSourceSnapshot(root, parentId));
  }
  return arxivReferenceOf(snapshot);
}
