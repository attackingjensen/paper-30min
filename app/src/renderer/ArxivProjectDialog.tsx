import { useRef, useState, type RefObject } from "react";
import { FolderOpen } from "lucide-react";
import type { ArxivReference, ImportDiagnostic } from "../shared/arxiv";
import type { PdfParseTaskRecord } from "../shared/parsing";
import type {
  ArxivImportCommandResult,
  ArxivPdfFallbackCommandResult,
  ArxivPdfFallbackImportCommandResult,
  PdfImportCommandResult,
  ProjectCoreSnapshot,
} from "../shared/contracts";
import { Button } from "./ui/Button";
import { Dialog as Modal } from "./ui/Dialog";
import { Field } from "./ui/Field";
import { InlineMessage } from "./ui/Feedback";

const desktop = window.desktop;

export interface ArxivRecovery {
  root: string;
  input: string;
  name: string;
  parent: string;
  reference: ArxivReference;
  diagnostic: ImportDiagnostic | null;
  pdfTask: PdfParseTaskRecord | null;
}

interface ArxivProjectDialogProps {
  recovery?: ArxivRecovery;
  initialParent: string;
  initialMakeDefault: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  confirmAction: (request: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  onRecovery: (root: string) => Promise<void>;
  onCreated: (root: string, parent: string, makeDefault: boolean) => Promise<void>;
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function diagnosticMessage(diagnostic: ImportDiagnostic): string {
  const key = diagnostic.messageKey.split(":", 1)[0];
  if (key.startsWith("arxiv.reference."))
    return "arXiv URL 或 ID 无效；请使用裸 ID、arXiv: 前缀或官方 abs/html/pdf URL。";
  if (key.endsWith(".notFound"))
    return key.startsWith("arxiv.html")
      ? "未找到该固定版本的 arXiv HTML（404）。可恢复重试，或显式改用此版本 PDF。"
      : "未找到该 arXiv ID 或指定版本（404）。";
  if (key.endsWith(".forbidden")) return "arXiv 拒绝访问（403）；这不表示论文没有 HTML。";
  if (key.endsWith(".rateLimited")) return "arXiv 请求受到限流（429）；请稍后恢复导入。";
  if (key.endsWith(".stalled")) return "arXiv 下载长时间没有进度；工程与恢复记录已保留。";
  if (key.endsWith(".tls")) return "arXiv 连接的 TLS 证书校验失败，未放宽安全检查。";
  if (key.endsWith(".network")) return "无法连接或读取 arXiv 来源；请检查网络后恢复导入。";
  if (key.endsWith(".http")) return "arXiv 返回了非预期 HTTP 响应；请稍后恢复导入。";
  if (key === "arxiv.fetch.cancelled") return "已取消 arXiv 导入；工程与恢复记录已保留。";
  if (key === "arxiv.fetch.budget") return "arXiv 响应超过安全预算，已中止导入。";
  if (key === "arxiv.version.withdrawn") return "目标 arXiv 版本已撤稿，未自动改用其他版本。";
  if (key === "arxiv.version.missing" || key === "arxiv.version.unresolved")
    return "无法确定目标 arXiv 版本，未改用其他版本。";
  if (key.startsWith("arxiv.convert.")) return "arXiv HTML 核心正文不可读，未发布可读工程。";
  if (key.startsWith("arxiv.import.createFailed")) return "无法创建本地工程，请检查名称和保存位置。";
  return "arXiv 导入未完成。";
}

export function ArxivProjectDialog({
  recovery,
  initialParent,
  initialMakeDefault,
  returnFocus,
  confirmAction,
  onRecovery,
  onCreated,
  onClose,
}: ArxivProjectDialogProps) {
  const dialogInput = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(recovery?.input ?? "");
  const [name, setName] = useState(recovery?.name ?? "");
  const [parent, setParent] = useState(recovery?.parent ?? initialParent);
  const [makeDefault, setMakeDefault] = useState(recovery ? false : initialMakeDefault);
  const [root, setRoot] = useState(recovery?.root ?? "");
  const [reference, setReference] = useState<ArxivReference | null>(recovery?.reference ?? null);
  const [diagnostic, setDiagnostic] = useState<ImportDiagnostic | null>(recovery?.diagnostic ?? null);
  const [pdfTask, setPdfTask] = useState<PdfParseTaskRecord | null>(recovery?.pdfTask ?? null);
  const [published, setPublished] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [fallbackActive, setFallbackActive] = useState(false);
  const separator = parent.includes("\\") ? "\\" : "/";
  const fallbackEligible =
    Boolean(root) &&
    diagnostic !== null &&
    reference?.version != null &&
    (diagnostic.stage !== "resolve" || diagnostic.code === "arxiv-abs-fetch-failed");

  async function chooseParent() {
    setBusy(true);
    setError("");
    try {
      const folder = await desktop.choose("folder");
      if (folder) setParent(folder);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openPublished() {
    if (busy || !published) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await onCreated(root, parent, makeDefault);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importOrResume() {
    if (busy) return;
    const operationId = crypto.randomUUID();
    setCreating(operationId);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = root
        ? await desktop.invoke<ArxivImportCommandResult>({ type: "coreArxivResume", root, operationId })
        : await desktop.invoke<ArxivImportCommandResult>({
            type: "coreArxivImport",
            parent,
            name,
            input,
            operationId,
          });
      setRoot(result.root);
      if (result.ok) {
        setPublished(true);
        await onCreated(result.root, parent, makeDefault);
        return;
      }
      setDiagnostic(result.diagnostic);
      if (result.root) {
        try {
          const core = await desktop.invoke<ProjectCoreSnapshot>({ type: "coreOpen", root: result.root });
          setReference(core.importRecord?.arxiv?.reference ?? null);
          await onRecovery(result.root);
        } catch (cause) {
          setError("工程已保留，但恢复信息读取或最近工程登记失败：" + errorMessage(cause));
        }
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setCreating(null);
    }
  }

  async function handlePdfResult(result: ArxivPdfFallbackImportCommandResult | PdfImportCommandResult) {
    if ("task" in result) setPdfTask(result.task);
    if (result.outcome === "published") {
      setPdfTask(null);
      setPublished(true);
      await onCreated(root, parent, makeDefault);
      return;
    }
    if (result.outcome === "cancelled") {
      setNotice("已取消 PDF 回退；工程、HTML 诊断和已下载快照均保留，可重试或恢复 HTML。");
    } else if (
      result.outcome === "stopped" ||
      (result.outcome === "incomplete" && result.diagnostic.code === "baidu-task-stopped")
    ) {
      setNotice(
        "已停止本机 PDF 回退等待；已受理的远端任务可能继续运行并产生费用。工程与恢复现场保留，current 尚未发布。",
      );
    } else if (result.outcome === "incomplete" || result.outcome === "snapshot-failed") {
      setNotice(`PDF 回退未完成（${result.diagnostic.code}）：${result.diagnostic.messageKey}`);
    } else {
      setPdfTask(null);
      setNotice("PDF 回退已生成候选但尚未发布 current；工程已保留，请打开工程检查候选。");
    }
  }

  async function resumePdfTask() {
    if (!pdfTask || busy) return;
    const operationId = crypto.randomUUID();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const pending = desktop.invoke<PdfImportCommandResult>({
        type: "corePdfResume",
        root,
        parseBatchId: pdfTask.parseBatchId,
        operationId,
        ...(pdfTask.jobId === undefined ? {} : { jobId: pdfTask.jobId }),
      });
      setCreating(operationId);
      setFallbackActive(true);
      const result = await pending;
      await handlePdfResult(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setCreating(null);
      setFallbackActive(false);
    }
  }

  async function fallbackToPdf() {
    if (!root || !diagnostic || busy || !fallbackEligible || reference?.version == null) return;
    const confirmed = await confirmAction({
      title: "确认 arXiv PDF 回退",
      description: `HTML 导入尚未产生可读正文。确认后将下载 ${reference.canonicalId} 的 PDF；云端上传和可能产生的费用仍会再次单独确认。`,
      confirmLabel: "下载 PDF 并继续",
      cancelLabel: "取消",
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const handoff = await desktop.invoke<ArxivPdfFallbackCommandResult>({
        type: "coreArxivPdfFallback",
        root,
        reason: diagnostic,
        baseRevision: null,
      });
      if (!handoff.ok) {
        setNotice(`无法准备 PDF 回退（${handoff.diagnostic.code}）：${handoff.diagnostic.messageKey}`);
        return;
      }
      const operationId = crypto.randomUUID();
      const pending = desktop.invoke<ArxivPdfFallbackImportCommandResult>({
        type: "coreArxivPdfFallbackImport",
        root,
        request: handoff.request,
        operationId,
      });
      setCreating(operationId);
      setFallbackActive(true);
      const result = await pending;
      await handlePdfResult(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setCreating(null);
      setFallbackActive(false);
    }
  }

  async function cancel() {
    if (!creating) {
      onClose();
      return;
    }
    try {
      await desktop.invoke({ type: "coreArxivCancel", operationId: creating });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Modal
      open
      title="从 arXiv 新建工程"
      description="输入 arXiv URL 或 ID，优先导入固定版本 HTML；不会在未经确认时下载 PDF 或调用云端解析。"
      allowDismiss={!busy}
      initialFocus={dialogInput}
      finalFocus={returnFocus}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void (published ? openPublished() : importOrResume());
      }}
      footer={
        <>
          <Button onClick={() => void cancel()} disabled={busy && !creating}>
            {creating ? (fallbackActive ? "停止回退" : "取消创建") : "取消"}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !input.trim() || !name.trim() || !parent}>
            {busy ? "处理中…" : published ? "打开工程" : root ? "恢复导入" : "创建工程"}
          </Button>
        </>
      }
    >
      <Field.Root validationMode="onBlur">
        <Field.Label>arXiv URL 或 ID</Field.Label>
        <Field.Control
          ref={dialogInput}
          value={input}
          disabled={busy || Boolean(root)}
          onChange={(event) => setInput(event.target.value)}
          placeholder="2401.01234v2 或 https://arxiv.org/abs/2401.01234"
          required
        />
        <Field.Description>支持新旧式 ID、arXiv: 前缀和官方 abs/html/pdf URL。</Field.Description>
        <Field.Error match="valueMissing">请输入 arXiv URL 或 ID。</Field.Error>
      </Field.Root>
      <Field.Root validationMode="onBlur">
        <Field.Label>工程名称</Field.Label>
        <Field.Control
          value={name}
          disabled={busy || Boolean(root)}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Field.Error match="valueMissing">请输入工程名称。</Field.Error>
      </Field.Root>
      <label>保存位置</label>
      <div className="location">
        <span className="path">{parent || "请选择工程文件夹"}</span>
        <Button disabled={busy || Boolean(root)} onClick={() => void chooseParent()}>
          <FolderOpen /> 选择位置
        </Button>
      </div>
      <label>完整工程路径</label>
      <output className="path preview" data-testid="arxiv-project-preview">
        {parent ? parent.replace(/[\\/]$/, "") + separator + name : "尚未选择保存位置"}
      </output>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={makeDefault}
          disabled={busy}
          onChange={(event) => setMakeDefault(event.target.checked)}
        />
        将此位置设为默认工程文件夹
      </label>
      {root && (
        <>
          <label>恢复工程</label>
          <div className="path source-path">{root}</div>
        </>
      )}
      {diagnostic && (
        <InlineMessage variant="error" className="form-error arxiv-diagnostic">
          <strong>{diagnosticMessage(diagnostic)}</strong>
          <code>{diagnostic.code}</code>
          <small>{diagnostic.messageKey}</small>
          {diagnostic.errorDetail && <small>{diagnostic.errorDetail}</small>}
        </InlineMessage>
      )}
      {notice && <InlineMessage variant="warning">{notice}</InlineMessage>}
      {error && (
        <InlineMessage variant="error" className="form-error">
          {error}
        </InlineMessage>
      )}
      {!published && pdfTask && (
        <Button className="arxiv-fallback-action" disabled={busy} onClick={() => void resumePdfTask()}>
          恢复 PDF 任务
        </Button>
      )}
      {!published && !pdfTask && fallbackEligible && diagnostic && (
        <Button className="arxiv-fallback-action" disabled={busy} onClick={() => void fallbackToPdf()}>
          改用此版本 PDF 解析
        </Button>
      )}
    </Modal>
  );
}
