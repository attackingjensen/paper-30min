import { ProjectService } from "./project-service.js";
import { AgentService } from "./agent-service.js";
import type { ModelConfig } from "./agent-settings.js";
import type { AgentCommand, Command } from "../shared/contracts.js";
import type { ParsingCommand } from "../shared/parsing.js";
import type { ParsingConfig } from "./parsing-settings.js";
import { ParsingService } from "./parsing-service.js";
import { ReferenceService } from "./reference-service.js";
import type { AnnotationWrite } from "../shared/references.js";

const port = process.parentPort!;
let nextId = 0;
const trashRequests = new Map<
  number,
  { resolve: () => void; reject: (error: Error) => void }
>();
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
const annotationRequests = new Map<number, { resolve: (value: { sha256: string } | null) => void; reject: (error: Error) => void }>();
const references = new ReferenceService(service, (request: AnnotationWrite, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const id = ++nextId;
  const abort = () => port.postMessage({ annotationCancel: id });
  signal?.addEventListener("abort", abort, { once: true });
  const cleanup = () => signal?.removeEventListener("abort", abort);
  annotationRequests.set(id, {
    resolve: (value) => { cleanup(); resolve(value); },
    reject: (error) => { cleanup(); reject(error); },
  });
  port.postMessage({ annotationWrite: { id, request } });
}));
const agent = new AgentService(
  (state) => port.postMessage({ agentState: state }),
  service,
  parsing,
  references,
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
        | { type: "parsing"; command: ParsingCommand; config: ParsingConfig };
      shutdown?: boolean;
      trashResult?: boolean;
      error?: string;
      annotationResult?: boolean;
      value?: { sha256: string } | null;
    };
  }) => {
    if (data.annotationResult) {
      const request = annotationRequests.get(data.id);
      annotationRequests.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve(data.value ?? null);
      return;
    }
    if (data.trashResult !== undefined) {
      const request = trashRequests.get(data.id);
      trashRequests.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve();
      return;
    }
    try {
      const command = data.command;
      let value: unknown;
      if (data.shutdown) {
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
          command.command.type === "stop"
            ? { root: command.command.root }
            : ((await service.dispatch({
                type: "refresh",
                root: command.command.root,
              })) as { root: string });
        value = await agent.dispatch(
          { ...command.command, root: project.root },
          command.config,
        );
      } else if (command?.type === "resolveReference") {
        value = await references.resolve(command.root, command);
      } else if (command?.type === "move") {
        value = await agent.withFileMove(command.root, () => service.dispatch(command));
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
