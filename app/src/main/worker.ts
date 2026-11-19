import { ProjectService } from "./project-service.js";
import { dispatchCoreCommand, isCoreCommand } from "./core-commands.js";
import { AgentService } from "./agent-service.js";
import type { ModelConfig } from "./agent-settings.js";
import type {
  AgentCommand,
  Command,
  CoreCommand,
  PdfImportMachineConfig,
  PdfImportWorkerCommand,
  PdfUploadConfirmationReply,
} from "../shared/contracts.js";
import type { BaiduUploadConfirmationRequest } from "../shared/parsing.js";
import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ProductSkills } from "./product-skills.js";
import { reconvertParseCandidate, publishParseCandidate } from "./parsing/pdf-import.js";
import { listBaiduPdfParseTasks } from "./parsing/baidu-task.js";
import type { PdfReparseCommandResult } from "../shared/contracts.js";

const port = process.parentPort!;
/** 进行中的 PDF 操作：operationId → 取消控制器与完成信号（worker 进程内权威）。
 * shutdown 必须先 abort 再等待 done 全部落定，才能关闭工程服务。 */
const pdfOperations = new Map<string, { controller: AbortController; done: Promise<void> }>();
/** 上传确认往返：confirmationId → resolver；应答须同时匹配 operationId 与 confirmationId，
 * 只有 confirmed === true 才发起上传；未应答前不发起 POST。 */
const pdfConfirmations = new Map<
  string,
  { operationId: string; resolve: (confirmed: boolean) => void }
>();

function requestUploadConfirmation(
  operationId: string,
  request: BaiduUploadConfirmationRequest,
  signal: AbortSignal,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  // 等待确认期间取消／退出立即按拒绝落定，不让操作永久挂起。
  if (signal.aborted) {
    resolve(false);
    return promise;
  }
  const confirmationId = randomUUID();
  const settle = (confirmed: boolean) => {
    signal.removeEventListener("abort", abort);
    pdfConfirmations.delete(confirmationId);
    resolve(confirmed);
  };
  const abort = () => settle(false);
  signal.addEventListener("abort", abort, { once: true });
  pdfConfirmations.set(confirmationId, { operationId, resolve: settle });
  port.postMessage({ pdfUploadConfirm: { operationId, confirmationId, request } });
  return promise;
}

function pdfDispatcher(config: PdfImportMachineConfig): Dispatcher {
  if (config.proxy === "custom") return new ProxyAgent(config.proxyUrl);
  if (config.proxy === "environment") return new EnvHttpProxyAgent();
  return new Agent();
}

/** 离线重转换／候选发布的取消包装：core-commands 的无配置路径不携带信号，
 * worker 侧注入取消并注册完成信号供 shutdown 等待；中止时不推进 current。 */
async function dispatchPdfOffline(
  command: Extract<CoreCommand, { type: "corePdfReconvert" | "corePdfPublishCandidate" }>,
): Promise<unknown> {
  const controller = new AbortController();
  let done: Promise<void>;
  const run = (async () => {
    if (command.type === "corePdfPublishCandidate") {
      controller.signal.throwIfAborted();
      return publishParseCandidate({
        root: command.root,
        parseBatchId: command.parseBatchId,
        baseRevision: command.baseRevision,
        ...(command.resolutions === undefined ? {} : { resolutions: command.resolutions }),
        signal: controller.signal,
      });
    }
    const candidate = await reconvertParseCandidate({
      root: command.root,
      parseBatchId: command.parseBatchId,
      baseRevision: command.baseRevision,
      signal: controller.signal,
    });
    const tasks = await listBaiduPdfParseTasks(command.root);
    const task = tasks.find((entry) => entry.parseBatchId === command.parseBatchId);
    if (!task) throw new Error("PDF 云端任务不存在。");
    controller.signal.throwIfAborted();
    const metadata = candidate.metadata?.pdfParse;
    const warnings =
      metadata !== null && typeof metadata === "object" && "warnings" in metadata
        ? metadata.warnings
        : undefined;
    const { assets: _assets, metadata: _metadata, ...summary } = candidate;
    return {
      outcome: "candidate",
      task,
      candidate: summary,
      warnings: Array.isArray(warnings) ? warnings : [],
    } satisfies PdfReparseCommandResult;
  })();
  done = run.then(
    () => undefined,
    () => undefined,
  );
  const key = randomUUID();
  pdfOperations.set(key, { controller, done });
  try {
    return await run;
  } finally {
    pdfOperations.delete(key);
  }
}

async function dispatchPdfCloud(command: PdfImportWorkerCommand): Promise<unknown> {
  const inner = command.command;
  if (pdfOperations.has(inner.operationId))
    throw new Error(`PDF 操作已在进行中：${inner.operationId}`);
  const controller = new AbortController();
  let network: Dispatcher;
  let run: Promise<unknown>;
  try {
    // 构造失败不得占用 operationId：network 构造纳入同一清理路径。
    network = pdfDispatcher(command.config);
    run = dispatchCoreCommand(inner, {
      config: {
        endpoint: command.config.endpoint,
        model: command.config.model,
        apiKey: command.config.apiKey,
        dispatcher: network,
      },
      confirmUpload: (request) =>
        requestUploadConfirmation(inner.operationId, request, controller.signal),
      signal: controller.signal,
    });
  } catch (error) {
    controller.abort();
    throw error;
  }
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  pdfOperations.set(inner.operationId, { controller, done });
  try {
    return await run;
  } finally {
    for (const entry of pdfConfirmations.values())
      if (entry.operationId === inner.operationId) entry.resolve(false);
    if (pdfOperations.get(inner.operationId)?.controller === controller)
      pdfOperations.delete(inner.operationId);
    await network.destroy();
  }
}
const service = new ProjectService(process.argv[2]);
const agent = new AgentService(
  (state) => port.postMessage({ agentState: state }),
  service,
  new ProductSkills(path.join(path.dirname(process.argv[2]), "product-skills")),
);

port.on(
  "message",
  async ({
    data,
  }: {
    data: {
      id: number;
      command?:
        | Command
        | { type: "agent"; command: AgentCommand; config: ModelConfig }
        | PdfImportWorkerCommand;
      shutdown?: boolean;
      pdfUploadConfirmReply?: PdfUploadConfirmationReply;
      error?: string;
    };
  }) => {
    if (data.pdfUploadConfirmReply !== undefined) {
      const reply = data.pdfUploadConfirmReply;
      const entry = pdfConfirmations.get(reply.confirmationId);
      // 只有 operationId + confirmationId 双匹配的显式 true 才确认；
      // 其余（truthy 非布尔、错误 id、重复／迟到应答）一律按拒绝或忽略。
      if (entry && entry.operationId === reply.operationId)
        entry.resolve(reply.confirmed === true);
      return;
    }
    try {
      const command = data.command;
      let value: unknown;
      if (data.shutdown) {
        // 先以拒绝解决全部未决确认并中止全部操作，等待落定后再关服务，
        // 保证退出时任务现场完整、无新增 POST。
        for (const entry of [...pdfConfirmations.values()]) entry.resolve(false);
        for (const operation of [...pdfOperations.values()]) operation.controller.abort();
        await Promise.allSettled([...pdfOperations.values()].map((operation) => operation.done));
        await agent.close();
        await service.close();
        // 落定应答发出后主动退出：主进程等 exit 事件再 app.exit，
        // 不再依赖恒等 2s 强杀收尾中的进程。
        port.postMessage({ id: data.id, value: null });
        process.exit(0);
      } else if (command?.type === "agent") {
        if (
          command.command.type === "settings" ||
          command.command.type === "saveSettings" ||
          command.command.type === "selectModel"
        )
          throw new Error("无效的模型命令。");
        const project =
          !("root" in command.command) ? undefined : command.command.type === "stop"
            ? { root: command.command.root }
            : ((await service.dispatch({
                type: "refresh",
                root: command.command.root,
              })) as { root: string });
        value = await agent.dispatch(
          project ? { ...command.command, root: project.root } as typeof command.command : command.command,
          command.config,
        );
      } else if (command?.type === "pdfImport") {
        value = await dispatchPdfCloud(command);
      } else if (command?.type === "move") {
        value = await agent.withFileMove(command.root, () => service.dispatch(command));
      } else if (
        command &&
        (command.type === "corePdfReconvert" || command.type === "corePdfPublishCandidate")
      ) {
        value = await dispatchPdfOffline(command);
      } else if (command && isCoreCommand(command)) {
        value = await dispatchCoreCommand(command);
      } else value = await service.dispatch(command!);
      port.postMessage({
        id: data.id,
        value,
      });
    } catch (error) {
      port.postMessage({ id: data.id, error: (error as Error).message });
    }
  },
);
port.postMessage({ ready: true });
