import { ProjectService } from "./project-service.js";
import { dispatchCoreCommand, isCoreCommand } from "./core-commands.js";
import { AgentService } from "./agent-service.js";
import type { ModelConfig } from "./agent-settings.js";
import type {
  AgentCommand,
  Command,
  PdfImportMachineConfig,
  PdfImportWorkerCommand,
  PdfUploadConfirmationReply,
} from "../shared/contracts.js";
import type { BaiduUploadConfirmationRequest, ParsingCommand } from "../shared/parsing.js";
import type { ParsingConfig } from "./parsing-settings.js";
import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import { ParsingService } from "./parsing-service.js";
import path from "node:path";
import { ProductSkills } from "./product-skills.js";

const port = process.parentPort!;
let nextId = 0;
const trashRequests = new Map<
  number,
  { resolve: () => void; reject: (error: Error) => void }
>();
/** 进行中的 PDF 云端操作：operationId → 取消控制器（worker 进程内权威）。 */
const pdfOperations = new Map<string, AbortController>();
/** 上传确认往返：operationId → renderer 应答；未应答前不发起 POST。 */
const pdfConfirmations = new Map<string, (confirmed: boolean) => void>();

function requestUploadConfirmation(
  operationId: string,
  request: BaiduUploadConfirmationRequest,
): Promise<boolean> {
  return new Promise((resolve) => {
    pdfConfirmations.set(operationId, resolve);
    port.postMessage({ pdfUploadConfirm: { operationId, request } });
  });
}

function pdfDispatcher(config: PdfImportMachineConfig): Dispatcher {
  return config.proxy === "custom"
    ? new ProxyAgent(config.proxyUrl!)
    : config.proxy === "environment"
      ? new EnvHttpProxyAgent()
      : new Agent();
}

async function dispatchPdfCloud(command: PdfImportWorkerCommand): Promise<unknown> {
  const inner = command.command;
  if (pdfOperations.has(inner.operationId))
    throw new Error(`PDF 操作已在进行中：${inner.operationId}`);
  const controller = new AbortController();
  pdfOperations.set(inner.operationId, controller);
  const network = pdfDispatcher(command.config);
  try {
    return await dispatchCoreCommand(inner, {
      config: {
        endpoint: command.config.endpoint,
        model: command.config.model,
        apiKey: command.config.apiKey,
        dispatcher: network,
      },
      confirmUpload: (request) => requestUploadConfirmation(inner.operationId, request),
      signal: controller.signal,
    });
  } finally {
    pdfConfirmations.delete(inner.operationId);
    if (pdfOperations.get(inner.operationId) === controller)
      pdfOperations.delete(inner.operationId);
    await network.destroy();
  }
}
const service = new ProjectService(
  process.argv[2],
  (file) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      trashRequests.set(id, { resolve, reject });
      port.postMessage({ trash: { id, file } });
    }),
);
const parsing = new ParsingService(service);
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
        | { type: "parsing"; command: ParsingCommand; config: ParsingConfig }
        | PdfImportWorkerCommand;
      shutdown?: boolean;
      trashResult?: boolean;
      pdfUploadConfirmReply?: PdfUploadConfirmationReply;
      error?: string;
    };
  }) => {
    if (data.trashResult !== undefined) {
      const request = trashRequests.get(data.id);
      trashRequests.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve();
      return;
    }
    if (data.pdfUploadConfirmReply !== undefined) {
      const reply = data.pdfUploadConfirmReply;
      const resolve = pdfConfirmations.get(reply.operationId);
      pdfConfirmations.delete(reply.operationId);
      resolve?.(reply.confirmed);
      return;
    }
    try {
      const command = data.command;
      let value: unknown;
      if (data.shutdown) {
        for (const controller of pdfOperations.values()) controller.abort();
        await Promise.all([agent.close(), parsing.close()]);
        await service.close();
      } else if (command?.type === "parsing") {
        if (
          command.command.type === "settings" ||
          command.command.type === "saveSettings"
        )
          throw new Error("无效解析命令。");
        value = await parsing.dispatch(command.command, command.config);
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
