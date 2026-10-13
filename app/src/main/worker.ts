import { ProjectService } from "./project-service.js";
import { AgentService } from "./agent-service.js";
import type { ModelConfig } from "./agent-settings.js";
import type { AgentCommand, Command } from "../shared/contracts.js";

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
const agent = new AgentService((state) =>
  port.postMessage({ agentState: state }),
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
        | { type: "agent"; command: AgentCommand; config: ModelConfig };
      shutdown?: boolean;
      trashResult?: boolean;
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
    try {
      const command = data.command;
      let value: unknown;
      if (data.shutdown) {
        await Promise.all([agent.close(), service.close()]);
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
