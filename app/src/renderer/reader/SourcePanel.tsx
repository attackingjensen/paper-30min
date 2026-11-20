// 来源诊断面板（SPEC-reader §7，paper-30min-qa3.4）：可行动事实、锚定诊断与
// PDF 核验四态的非评分化展示。诊断不阻塞阅读；核验覆盖度不转换为质量分数。
import { useMemo, useState } from "react";
import type { ImportDiagnostic } from "../../shared/arxiv";
import type { ReaderDiagnostic } from "../../shared/reader/diagnostics";
import type { VerificationRecord } from "../../shared/verification";

export interface SourcePanelFacts {
  kind: string | null;
  canonicalId: string | null;
  baseId: string | null;
  version: number | null;
  fetchedAt: string | null;
  /** PDF 快照事实（本地 PDF 来源）。 */
  pdfSha256: string | null;
  pdfFileName: string | null;
  /** 解析事实（pdf-parse 来源）。 */
  provider: string | null;
  model: string | null;
  parseBatchId: string | null;
  converterVersion: string | number | null;
}

const verificationLabels: Record<string, string> = {
  verified: "已核验（同一 PDF 且内容未变）",
  "historical-source": "历史来源（旧 PDF）",
  "modified-unreviewed": "内容已变化，未重新核验",
  unrecorded: "无核验记录",
};

function factString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 从来源快照与 revision 元数据提取可行动事实；缺失字段如实显示为未知。 */
export function sourcePanelFacts(
  snapshot: Record<string, unknown>,
  revision: Record<string, unknown>,
): SourcePanelFacts {
  const pdfParse = revision.pdfParse;
  const parseMeta = pdfParse !== null && typeof pdfParse === "object"
    ? pdfParse as Record<string, unknown>
    : null;
  const arxiv = revision.arxiv;
  const arxivMeta = arxiv !== null && typeof arxiv === "object"
    ? arxiv as Record<string, unknown>
    : null;
  return {
    kind: factString(snapshot.kind),
    canonicalId: factString(snapshot.canonicalId),
    baseId: factString(snapshot.baseId),
    version: typeof snapshot.version === "number" ? snapshot.version : null,
    fetchedAt: factString(snapshot.fetchedAt),
    pdfSha256: factString(snapshot.sha256),
    pdfFileName: factString(snapshot.fileName),
    provider: factString(snapshot.provider) ?? factString(parseMeta?.provider),
    model: factString(snapshot.model) ?? factString(parseMeta?.model),
    parseBatchId: factString(snapshot.parseBatchId) ?? factString(parseMeta?.parseBatchId),
    converterVersion: parseMeta?.converterVersion !== undefined &&
      (typeof parseMeta.converterVersion === "string" || typeof parseMeta.converterVersion === "number")
      ? parseMeta.converterVersion
      : arxivMeta?.converterVersion !== undefined &&
        (typeof arxivMeta.converterVersion === "string" || typeof arxivMeta.converterVersion === "number")
      ? arxivMeta.converterVersion
      : null,
  };
}

function Fact({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="source-fact">
      <dt>{label}</dt>
      <dd>{value === null || value === "" ? "未记录" : String(value)}</dd>
    </div>
  );
}

export function SourcePanel({
  facts,
  snapshotWarnings,
  revisionWarnings,
  diagnostics,
  verification,
  verificationError = null,
  onLocate,
}: {
  facts: SourcePanelFacts;
  snapshotWarnings: ImportDiagnostic[];
  revisionWarnings: ImportDiagnostic[];
  diagnostics: ReaderDiagnostic[];
  verification: {
    counts: Record<string, number>;
    records: VerificationRecord[];
  } | null;
  /** 核验侧车读取失败信息；null 表示读取成功（可能真实无记录）。 */
  verificationError?: string | null;
  onLocate: (blockId: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [showRecords, setShowRecords] = useState(false);
  const codes = useMemo(
    () => [...new Set(diagnostics.map((entry) => entry.code))],
    [diagnostics],
  );
  const visible = filter === "all" ? diagnostics : diagnostics.filter((entry) => entry.code === filter);
  const warnings = [...snapshotWarnings, ...revisionWarnings];
  return (
    <section className="source-panel" aria-label="来源诊断">
      <h2>来源与诊断</h2>
      <dl className="source-facts">
        <Fact label="来源类型" value={facts.kind} />
        {facts.kind === "arxiv" && (
          <>
            <Fact label="arXiv 固定版本" value={facts.canonicalId ?? (facts.baseId && facts.version !== null ? `${facts.baseId}v${facts.version}` : null)} />
            <Fact label="HTML 快照获取时间" value={facts.fetchedAt} />
          </>
        )}
        {facts.kind === "pdf" && (
          <>
            <Fact label="PDF 文件" value={facts.pdfFileName} />
            <Fact label="PDF SHA-256" value={facts.pdfSha256} />
          </>
        )}
        {facts.kind === "pdf-parse" && (
          <>
            <Fact label="解析服务" value={facts.provider} />
            <Fact label="解析模型" value={facts.model} />
            <Fact label="解析批次" value={facts.parseBatchId} />
          </>
        )}
        <Fact label="转换器版本" value={facts.converterVersion} />
      </dl>
      <h3>来源警告（{warnings.length}）</h3>
      {warnings.length === 0 ? (
        <p className="source-empty">来源快照未记录警告。</p>
      ) : (
        <ul className="source-warnings">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              <code>{warning.code}</code>
              <span>{warning.messageKey}</span>
              {warning.errorDetail && <small>{warning.errorDetail}</small>}
            </li>
          ))}
        </ul>
      )}
      <h3>正文诊断（{diagnostics.length}）</h3>
      <div className="source-filter" role="group" aria-label="诊断筛选">
        <button
          type="button"
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          全部 {diagnostics.length}
        </button>
        {codes.map((code) => (
          <button
            key={code}
            type="button"
            className={filter === code ? "active" : ""}
            onClick={() => setFilter(code)}
          >
            {code} {diagnostics.filter((entry) => entry.code === code).length}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="source-empty">当前筛选下没有诊断。</p>
      ) : (
        <ul className="source-diagnostics">
          {visible.map((entry, index) => (
            <li key={`${entry.code}-${entry.blockId}-${index}`}>
              <button type="button" onClick={() => onLocate(entry.blockId)}>
                <code>{entry.code}</code>
                <span>{entry.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>PDF 核验状态</h3>
      {verificationError !== null ? (
        <p className="source-empty" role="note">
          核验记录读取失败（{verificationError}）：无法确认核验状态，不代表无核验记录；正文阅读不受影响。
        </p>
      ) : verification === null ? (
        <p className="source-empty">无核验记录；核验不影响阅读、选区与 Agent 入口。</p>
      ) : (
        <>
          <ul className="source-verification-counts">
            {Object.entries(verificationLabels).map(([status, label]) => (
              <li key={status}>
                <span className={`source-verification-badge source-verification-${status}`}>{label}</span>
                <span>{verification.counts[status] ?? 0} 个节点</span>
              </li>
            ))}
          </ul>
          <p className="source-verification-note">
            核验状态只描述实际核验范围，不代表全文质量结论。
          </p>
          {verification.records.length > 0 && (
            <>
              <button
                type="button"
                className="source-records-toggle"
                aria-expanded={showRecords}
                onClick={() => setShowRecords(!showRecords)}
              >
                {showRecords ? "收起核验详情" : `查看核验详情（${verification.records.length} 条记录）`}
              </button>
              {showRecords && (
                <ul className="source-verification-records">
                  {verification.records.map((record) => (
                    <li key={record.verificationId}>
                      <p>
                        核验于 revision <code>{record.verifiedRevisionId.slice(0, 8)}</code>，
                        覆盖 {record.coverage.length} 个节点，
                        执行者：{record.actor.kind === "user" ? "用户确认" : `Agent 会话 ${record.actor.sessionId.slice(0, 8)}`}，
                        时间 {record.createdAt}。
                      </p>
                      <ul>
                        {record.coverage.slice(0, 20).map((entry, index) => (
                          <li key={`${entry.nodeId}-${index}`}>
                            {entry.nodeType} <code>{entry.nodeId.slice(0, 8)}</code>：
                            {verificationLabels[entry.validity] ?? entry.validity}
                            {entry.quote && <blockquote>{entry.quote}</blockquote>}
                          </li>
                        ))}
                        {record.coverage.length > 20 && (
                          <li>其余 {record.coverage.length - 20} 个节点略。</li>
                        )}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
