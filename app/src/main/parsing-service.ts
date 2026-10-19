import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  fetch,
  FormData,
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  type Dispatcher,
} from "undici";
import type { DocumentRecord, PdfSource, Project } from "../shared/contracts.js";
import type {
  ParsingCommand,
  ParsingRun,
  ParsingMapping,
} from "../shared/parsing.js";
import type { ParsingConfig } from "./parsing-settings.js";
import { ProjectService } from "./project-service.js";
import { buildCandidate, checkParsingPdf } from "./baidu-candidate.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
const validJob = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
type Config = ParsingConfig & { proxy?: string; proxyUrl?: string };
class SubmissionRejectedError extends Error {}

export class ParsingService {
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<void>; run: ParsingRun }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private reviews = new Map<string, string>();
  constructor(private projects: ProjectService) {}

  private reviewKey(root: string, batchId: string) {
    return path.resolve(root).toLowerCase() + "\0" + batchId;
  }

  isReviewActive(root: string, batchId: string, sessionId: string) {
    return this.reviews.get(this.reviewKey(root, batchId)) === sessionId;
  }

  reviewStatus(root: string, batchId: string) {
    return this.serialize(() => this.reviewRun(root, batchId));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async readSource(root: string, expected: DocumentRecord) {
    const source = await this.projects.dispatch({ type: "readPdf", root, path: expected.path }) as PdfSource;
    const document = source.document;
    if (!document || document.id !== expected.id || document.sha256 !== expected.sha256 ||
        source.sha256 !== (document.annotationSha256 ?? document.sha256))
      throw new Error("PDF 已被替换或版本无法确认，解析及审阅已失效。");
    return source;
  }

  private async reviewRun(root: string, batchId: string) {
    const project = await this.projects.dispatch({ type: "refresh", root }) as Project;
    const run = (await this.runs(project)).find((item) => item.batchId === batchId);
    if (!run || run.phase !== "candidate") throw new Error("此批次尚无完整解析正文。");
    const document = [project.manifest.paper, ...project.manifest.materials].find((item) => item.id === run.document.id);
    if (!document || document.sha256 !== run.document.sha256) throw new Error("PDF 身份或版本已变化，不能继续审阅。");
    const source = await this.readSource(root, document);
    run.document = source.document!;
    await this.verifyCandidate(root, run);
    return run;
  }

  startReview(root: string, batchId: string, sessionId: string): Promise<ParsingRun> {
    return this.serialize(async () => {
      const key = this.reviewKey(root, batchId);
      if (this.reviews.has(key)) throw new Error("此批次正在审阅，请先停止当前会话。");
      const run = await this.reviewRun(root, batchId);
      if ((run.reviewedThroughPage ?? 0) === run.pageCount) throw new Error("此批次已完成审阅，可继续阅读或纠错。");
      run.reviewSessionId = sessionId;
      delete run.reviewError;
      await this.save(root, run);
      this.reviews.set(key, sessionId);
      return run;
    });
  }

  completeReviewPage(root: string, batchId: string, sessionId: string, page: number, signal: AbortSignal) {
    return this.serialize(async () => {
      signal.throwIfAborted();
      if (this.reviews.get(this.reviewKey(root, batchId)) !== sessionId) throw new Error("审阅会话已停止或被替换。");
      const run = await this.reviewRun(root, batchId);
      const next = (run.reviewedThroughPage ?? 0) + 1;
      if (!Number.isSafeInteger(page) || page !== next || page > run.pageCount) throw new Error(`请先完成第 ${next} 页审阅。`);
      signal.throwIfAborted();
      run.reviewedThroughPage = page;
      await this.save(root, run, signal);
      return { reviewedThroughPage: page, pageCount: run.pageCount, complete: page === run.pageCount };
    });
  }

  finishReview(root: string, batchId: string, sessionId: string, error?: string) {
    return this.serialize(async () => {
      const key = this.reviewKey(root, batchId);
      if (this.reviews.get(key) !== sessionId) return;
      try {
        const project = await this.projects.dispatch({ type: "refresh", root }) as Project;
        const run = (await this.runs(project)).find((item) => item.batchId === batchId);
        if (!run) throw new Error("解析批次已不存在。");
        run.reviewError = error ?? ((run.reviewedThroughPage ?? 0) < run.pageCount ? "审阅尚未完成，可从下一页继续。" : undefined);
        await this.save(root, run);
      } finally {
        this.reviews.delete(key);
      }
    });
  }

  async requireReviewed(root: string): Promise<ParsingRun> {
    const project = await this.projects.dispatch({ type: "refresh", root }) as Project;
    const runs = (await this.runs(project)).filter((run) => run.document.id === project.manifest.paper.id && run.phase === "candidate" && run.pageCount > 0 && run.reviewedThroughPage === run.pageCount);
    let reason = "请先在论文解析中完成工程论文的逐页审阅。";
    for (const run of runs) {
      try { return await this.reviewRun(root, run.batchId); }
      catch (error) { reason = (error as Error).message; }
    }
    throw new Error(reason);
  }

  async close() {
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((task) => task.done),
    );
  }

  dispatch(
    command: Exclude<ParsingCommand, { type: "settings" | "saveSettings" }>,
    config: Config,
  ): Promise<unknown> {
    // Stop bypasses startup/disk work. Network and mapping never hold this queue.
    if (command.type === "stop") {
      const task = this.active.get(path.resolve(command.root).toLowerCase());
      if (task?.run.batchId === command.batchId) task.controller.abort();
      return Promise.resolve();
    }
    return this.serialize(() => this.execute(command, config));
  }

  private async runs(project: Project): Promise<ParsingRun[]> {
    const result: ParsingRun[] = [];
    for (const batchId of await this.projects.parsingBatches(project.root)) {
      let run: ParsingRun;
      try {
        run = JSON.parse(
          (
            await this.projects.readParsingFile(
              project.root,
              batchId,
              "run.json",
            )
          ).toString("utf8"),
        );
      } catch {
        throw new Error("解析任务记录无法读取或已损坏。");
      }
      if (
        run.formatVersion !== 1 ||
        run.batchId !== batchId ||
        run.projectId !== project.manifest.id ||
        !run.document?.id ||
        !/^[a-f0-9]{64}$/.test(run.document.sha256) ||
        ![
          "preparing",
          "submitting",
          "unknown",
          "querying",
          "downloading",
          "mapping",
          "stopped",
          "failed",
          "remote-failed",
          "candidate",
        ].includes(run.phase) ||
        (run.jobId !== undefined && !validJob(run.jobId)) ||
        !Number.isSafeInteger(run.pageCount) || run.pageCount < 0 ||
        (run.reviewedThroughPage !== undefined && (!Number.isSafeInteger(run.reviewedThroughPage) || run.reviewedThroughPage < 0 || run.reviewedThroughPage > run.pageCount))
      )
        throw new Error("解析任务记录损坏或工程身份不匹配。");
      const active = this.active.get(project.root.toLowerCase());
      run.busy = active?.run.batchId === run.batchId;
      run.stopping = run.busy && active?.controller.signal.aborted;
      run.reviewBusy = this.reviews.has(this.reviewKey(project.root, batchId));
      if (!run.busy && run.phase === "submitting") run.phase = "unknown";
      else if (
        !run.busy &&
        ["preparing", "querying", "downloading", "mapping"].includes(run.phase)
      )
        run.phase = "stopped";
      result.push(run);
    }
    return result.sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    );
  }

  private async execute(
    command: Exclude<
      ParsingCommand,
      { type: "settings" | "saveSettings" | "stop" }
    >,
    config: Config,
  ) {
    const project = (await this.projects.dispatch({
      type: "refresh",
      root: command.root,
    })) as Project;
    const { root } = project;
    const runs = await this.runs(project);
    if (command.type === "status") return runs;
    if (command.type === "readiness") {
      try { await this.requireReviewed(root); return { ready: true }; }
      catch (error) { return { ready: false, reason: (error as Error).message }; }
    }
    if (command.type === "delete") {
      const run = runs.find((item) => item.batchId === command.batchId);
      if (!run) throw new Error("解析批次不存在。");
      if (run.busy || run.reviewBusy) throw new Error("请先停止此批次，等待任务停止后再删除。");
      await this.projects.deleteParsingBatch(root, run.batchId);
      return;
    }
    if (command.type === "verify") {
      const run = runs.find((item) => item.batchId === command.batchId);
      if (!run || run.phase !== "candidate")
        throw new Error("此批次尚无完整解析候选。");
      return this.reviewRun(root, run.batchId);
    }
    const key = root.toLowerCase();
    if (this.active.has(key)) throw new Error("工程已有解析任务正在运行。");
    let run: ParsingRun;
    if (command.type === "start") {
      if (
        runs.some(
          (item) =>
            item.phase === "unknown" ||
            (!["candidate", "remote-failed"].includes(item.phase) &&
              item.jobId &&
              !item.rawSha256),
        )
      )
        throw new Error("尚有未结束的云端任务，请先恢复原任务，避免重复付费。");
      const document = [
        project.manifest.paper,
        ...project.manifest.materials,
      ].find((item) => item.id === command.documentId);
      if (!document) throw new Error("PDF 尚未登记为工程材料。");
      run = {
        formatVersion: 1,
        projectId: project.manifest.id,
        batchId: randomUUID().replaceAll("-", ""),
        document,
        endpoint: config.endpoint,
        model: config.model,
        phase: "preparing",
        completedPages: 0,
        pageCount: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMs: 0,
      };
    } else {
      const existing = runs.find((item) => item.batchId === command.batchId);
      if (!existing) throw new Error("解析批次不存在。");
      run = existing;
      if (run.phase === "remote-failed")
        throw new Error("此云端任务已失败，请检查服务后主动发起新解析。");
      if (run.phase === "candidate") {
        await this.verifyCandidate(root, run);
        return run;
      }
      if (run.endpoint !== config.endpoint || run.model !== config.model)
        throw new Error("恢复需要原解析服务与模型配置。");
      if (run.phase === "unknown") {
        if (!validJob(command.jobId))
          throw new Error(
            "提交是否受理未知，请从百度控制台取得任务号后关联，不能自动重传。",
          );
        run.jobId = command.jobId;
        run.phase = "querying";
      } else if (command.jobId) throw new Error("只有未知提交可关联任务号。");
    }
    if (!config.apiKey || config.keyError)
      throw new Error("请先在解析模型设置中保存可用的百度 Token。");
    const currentDocument = [
      project.manifest.paper,
      ...project.manifest.materials,
    ].find(
      (doc) => doc.id === run.document.id && doc.sha256 === run.document.sha256,
    );
    if (!currentDocument)
      throw new Error("PDF 身份或版本已变化，不能继续此解析批次。");
    run.document = currentDocument;
    const source = await this.readSource(root, run.document);
    run.document = source.document!;
    if (source.bytes.byteLength > 50 * 1024 * 1024)
      throw new Error("本地上传 PDF 上限为 50 MiB。");
    run.pageCount = await checkParsingPdf(source);
    delete run.busy;
    delete run.stopping;
    await this.save(root, run);
    const controller = new AbortController();
    const task = { controller, done: Promise.resolve(), run };
    this.active.set(key, task);
    task.done = this.perform(
      root,
      run,
      source,
      config,
      controller.signal,
    ).finally(() => this.active.delete(key));
    void task.done.catch(() => undefined); // A failed final disk write leaves the last recoverable on-disk phase.
    return { ...run, busy: true };
  }

  private async save(root: string, run: ParsingRun, signal?: AbortSignal) {
    run.updatedAt = new Date().toISOString();
    await this.projects.writeParsingFile(
      root,
      run.batchId,
      "run.json",
      json(run),
      signal,
    );
  }

  private async verifyCandidate(root: string, run: ParsingRun) {
    const mappingBytes = await this.projects.readParsingFile(
      root,
      run.batchId,
      "mapping.json",
    );
    const body = await this.projects.readParsingFile(
      root,
      run.batchId,
      "candidate.md",
    );
    if (
      hash(mappingBytes) !== run.mappingSha256
    )
      throw new Error("解析映射已变化，不能当作完整解析结果。");
    if (!body.length || body.length > 2 * 1024 * 1024) throw new Error("解析正文为空或超过编辑预算。");
    const mapping = JSON.parse(mappingBytes.toString("utf8")) as ParsingMapping;
    for (const image of mapping.images)
      if (
        hash(
          await this.projects.readParsingFile(root, run.batchId, image.path),
        ) !== image.sha256
      )
        throw new Error("候选图片缺失或已变化。");
  }

  private async perform(
    root: string,
    run: ParsingRun,
    source: PdfSource,
    config: Config,
    signal: AbortSignal,
  ) {
    const started = Date.now();
    const network: Dispatcher =
      config.proxy === "custom"
        ? new ProxyAgent(config.proxyUrl!)
        : config.proxy === "environment"
          ? new EnvHttpProxyAgent()
          : new Agent();
    const resourceUrl = (value: string) => {
      const url = new URL(value);
      const endpoint = new URL(run.endpoint);
      if (
        url.username ||
        url.password ||
        url.hash ||
        !(
          url.origin === endpoint.origin ||
          (url.protocol === "https:" &&
            (!url.port || url.port === "443") &&
            (url.hostname === "paddleocr.aistudio-app.com" ||
              url.hostname.endsWith(".bcebos.com")))
        )
      )
        throw new Error("解析资源地址不在服务或百度 HTTPS 资源域名内。");
      return url.href;
    };
    const request = async (
      url: string,
      limit: number,
      init: Parameters<typeof fetch>[1] = {},
      submission = false,
    ) => {
      const requestSignal = submission
        ? AbortSignal.timeout(120_000)
        : AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      try {
        const response = await fetch(url, {
          ...init,
          redirect: "error",
          dispatcher: network,
          signal: requestSignal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          const message = `解析服务 HTTP ${response.status}，请检查凭据、额度或服务状态。`;
          if (
            submission &&
            [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(
              response.status,
            )
          )
            throw new SubmissionRejectedError(message);
          throw new Error(message);
        }
        if (Number(response.headers.get("content-length")) > limit) {
          await response.body?.cancel();
          throw new Error("解析响应超过本机大小上限。");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body!) {
          size += chunk.length;
          if (size > limit) {
            await response.body?.cancel().catch(() => {});
            throw new Error("解析响应超过本机大小上限。");
          }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } catch (error) {
        if (signal.aborted && !submission) throw error;
        // Never expose signed resource URLs, tokens or the provider's response text.
        if ((error as Error).message.startsWith("解析")) throw error;
        throw new Error("解析网络中断或超时，请恢复原任务查询；未自动重传。");
      }
    };
    const api = async (
      url: string,
      init?: Parameters<typeof fetch>[1],
      submission = false,
    ) => {
      const bytes = await request(
        url,
        1024 * 1024,
        { ...init, headers: { Authorization: `Bearer ${config.apiKey}` } },
        submission,
      );
      let value: any;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("解析状态响应不是有效 JSON。");
      }
      if ((value.code !== undefined && value.code !== 0) || !value.data)
        throw new Error("解析状态响应失败，请到服务控制台检查任务。");
      return value.data;
    };
    try {
      signal.throwIfAborted();
      if (!run.jobId && !run.rawSha256) {
        // Persist uncertainty BEFORE the POST. Cancellation still consumes and saves
        // the receipt, so an accepted job can be resumed without another charge.
        run.phase = "submitting";
        await this.save(root, run);
        signal.throwIfAborted();
        const form = new FormData();
        form.set("model", run.model);
        form.set(
          "optionalPayload",
          JSON.stringify({
            useDocOrientationClassify: false,
            useDocUnwarping: false,
            useChartRecognition: false,
          }),
        );
        form.set(
          "file",
          new Blob([new Uint8Array(source.bytes)], { type: "application/pdf" }),
          "paper.pdf",
        );
        try {
          const result = await api(
            run.endpoint,
            { method: "POST", body: form },
            true,
          );
          if (!validJob(result.jobId))
            throw new Error("解析提交响应缺少有效任务号。");
          run.jobId = result.jobId;
          run.phase = "querying";
          await this.save(root, run);
        } catch (error) {
          run.phase =
            error instanceof SubmissionRejectedError ? "failed" : "unknown";
          throw error;
        }
      }
      signal.throwIfAborted();
      let raw: Buffer;
      if (run.rawSha256) {
        raw = await this.projects.readParsingFile(
          root,
          run.batchId,
          "result.jsonl",
        );
        if (hash(raw) !== run.rawSha256)
          throw new Error("已保存原始解析结果摘要不符，请保留现场检查。");
      } else {
        const deadline = Date.now() + 30 * 60_000;
        for (;;) {
          signal.throwIfAborted();
          run.phase = "querying";
          await this.save(root, run);
          const result = await api(`${run.endpoint}/${run.jobId}`);
          if (result.state === "failed") {
            run.phase = "remote-failed";
            throw new Error("百度远端解析失败，请在服务控制台检查原任务。");
          }
          if (result.state === "done") {
            if (typeof result.resultUrl?.jsonUrl !== "string")
              throw new Error("解析完成响应缺少 JSONL 下载地址。");
            run.phase = "downloading";
            await this.save(root, run);
            raw = await request(
              resourceUrl(result.resultUrl.jsonUrl),
              256 * 1024 * 1024,
            );
            await this.projects.writeParsingFile(
              root,
              run.batchId,
              "result.jsonl",
              raw,
              signal,
            );
            run.rawSha256 = hash(raw);
            await this.save(root, run);
            break;
          }
          if (!["pending", "running"].includes(result.state))
            throw new Error("解析服务返回未知任务状态。");
          if (Date.now() > deadline)
            throw new Error("本轮查询已等待 30 分钟，可恢复原任务继续查询。");
          await delay(1500, undefined, { signal });
        }
      }
      signal.throwIfAborted();
      run.phase = "mapping";
      await this.save(root, run);
      const result = await buildCandidate({
        root,
        run,
        source,
        raw: raw!,
        projects: this.projects,
        signal,
        download: (url) => request(resourceUrl(url), 32 * 1024 * 1024),
        progress: async (completed, count) => {
          run.completedPages = completed;
          run.pageCount = count;
          await this.save(root, run);
        },
      });
      signal.throwIfAborted();
      await this.readSource(root, run.document);
      await this.projects.writeParsingFile(
        root,
        run.batchId,
        "mapping.json",
        json(result.mapping),
        signal,
      );
      run.candidate = await this.projects.writeParsingFile(
        root,
        run.batchId,
        "candidate.md",
        Buffer.from(result.markdown),
        signal,
      );
      run.mappingSha256 = hash(json(result.mapping));
      run.markdownSha256 = hash(Buffer.from(result.markdown));
      run.phase = "candidate";
      delete run.error;
    } catch (error) {
      if (run.phase !== "unknown" && run.phase !== "remote-failed")
        run.phase = signal.aborted ? "stopped" : "failed";
      run.error = signal.aborted
        ? "已停止本机处理；已受理的云端任务可能继续计费，恢复将复用任务号。"
        : (error as Error).message;
    } finally {
      run.elapsedMs += Date.now() - started;
      try {
        await this.save(root, run);
      } finally {
        await network.destroy();
      }
    }
  }
}
