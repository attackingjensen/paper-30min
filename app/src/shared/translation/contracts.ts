import type { DocumentTree } from "../document/tree.js";

export type TranslationLanguage = "en" | "zh";

type InlinePart = DocumentTree["sentences"][string]["content"][number];

interface TranslationSentenceContent {
  sentenceId: string;
  content: InlinePart[];
}

export interface TranslationUnitContent {
  unitId: string;
  sentences: TranslationSentenceContent[];
}

/** 译文行内片段：atom 只引用原 ID，内部结构由原文树权威提供。 */
export type TranslationInlinePart = TranslationUnitContent["sentences"][number]["content"][number];

export type TranslationSentenceStatus = "ready" | "gap" | "stale";

/** 已提交译文的 generator 事实；不含 API key、代理或机器配置。 */
export interface TranslationGenerator {
  provider: string;
  model: string;
  promptVersion: number;
  schemaVersion: number;
}

/** 提交时原句引用的 atom 完整快照：stale 展示与 quote 只从此重建，
 * 不再依赖当前树仍存在同 ID atom。缺省（旧格式）回退当前树 atom，仅适用于未变 atom。 */
export type TranslationAtomSnapshot = DocumentTree["atoms"][string];

/** 磁盘单元文件（units/<unitId>.<generation>.json）：只保存完整通过校验的 ready 句。
 * stale/gap 是读取时对照当前原文推导的投影状态，不回写单元文件。
 * generator 与 atom 快照是句级事实：merge 只替换目标句，kept 句保留原事实。 */
export interface TranslationUnitFile {
  formatVersion: 1;
  unitId: string;
  sentences: Array<{
    sentenceId: string;
    sourceSha256: string;
    translationSha256: string;
    content: TranslationInlinePart[];
    generator: TranslationGenerator;
    /** 译文引用的 atom 完整快照（提交时原树事实）；旧格式缺省。 */
    atoms?: TranslationAtomSnapshot[];
  }>;
}

export interface TranslationUnitIndexEntry {
  unitId: string;
  file: string;
  logicalBytes: number;
  sentences: Array<{
    sentenceId: string;
    sourceSha256: string;
    translationSha256: string;
    generator: TranslationGenerator;
  }>;
}

/** index.json：此语言当前投影的唯一指针；未引用文件不是当前译文。 */
export interface TranslationIndex {
  formatVersion: 1;
  baseRevision: string;
  language: TranslationLanguage;
  translationRevision: string;
  logicalContentBytes: number;
  units: TranslationUnitIndexEntry[];
  /** 迁移保留的失效诊断（removed/split/merge 旧译文）；可选，缺省为空。 */
  retired?: TranslationRetiredEntry[];
}

/** 失效诊断条目（SPEC-translation §7）：removed/split/merge 的旧译文只保留于此，
 * 不挂到相似或相邻新句；随迁移 index 持久化，离线重开一致。 */
export interface TranslationRetiredEntry {
  sentenceId: string;
  unitId: string;
  reason: "removed" | "split" | "merged";
  /** 旧原句可读摘录（document-core 同一口径，上限 500 码点）。 */
  excerpt: string;
  content: TranslationInlinePart[];
  generator: TranslationGenerator;
}

/** 主进程读取路径输出的只读投影：状态已对照当前原文树推导。 */
interface TranslationSentenceProjection {
  sentenceId: string;
  status: TranslationSentenceStatus;
  /** null 只用于 gap；stale 保留旧译文内容。 */
  content: TranslationInlinePart[] | null;
  /** 提交时原句内容摘要（含引用 atom 内容）；stale 仍是旧原句摘要；gap 为 null。 */
  sourceSha256: string | null;
  /** 提交时译文逻辑内容摘要；gap 为 null。 */
  translationSha256: string | null;
  /** 提交该句的 generator 事实；gap 为 null。 */
  generator: TranslationGenerator | null;
  /** stale 句译文引用的旧 atom 快照；缺省（旧格式）回退当前树 atom。 */
  atoms?: TranslationAtomSnapshot[];
  staleReason?: "source-changed";
}

export interface TranslationUnitProjection {
  unitId: string;
  sentences: TranslationSentenceProjection[];
}

export interface TranslationProjection {
  baseRevision: string;
  language: TranslationLanguage;
  /** null 表示尚无已提交 index；gap 不触发阻塞阅读的恢复。 */
  translationRevision: string | null;
  /** 确定性源语言判断；无法确定时为 null，不创建翻译任务。 */
  sourceLanguage: TranslationLanguage | null;
  units: TranslationUnitProjection[];
  /** 任务记录事实（task.json）：pending/failed 不冒充 ready；无记录为 null。 */
  task: { status: "running" | "finished"; gaps: Array<{ unitId: string; diagnostic: string }> } | null;
  /** 迁移保留的失效诊断；无已提交 index 或无退役句时省略。 */
  retired?: TranslationRetiredEntry[];
}

/** 确定性源语言判断：按正文逻辑文本的 CJK 与 ASCII 字母占比。
 * 混合语言论文仍归入占比更高的一侧；无法确定时返回 null，不创建任务。
 * 进程中立：主进程任务启动与 renderer 语言入口共用同一口径。 */
export function detectSourceLanguage(tree: DocumentTree): TranslationLanguage | null {
  let cjk = 0;
  let latin = 0;
  for (const sentence of Object.values(tree.sentences)) {
    for (const part of sentence.content) {
      if (part.kind !== "text") continue;
      for (const character of part.text) {
        const code = character.codePointAt(0)!;
        if (code >= 0x4e00 && code <= 0x9fff) cjk++;
        else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin++;
      }
    }
  }
  const total = cjk + latin;
  if (total < 20) return null;
  if (cjk / total >= 0.3) return "zh";
  if (latin / total >= 0.7) return "en";
  return null;
}
