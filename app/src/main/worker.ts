import { ProjectService } from "./project-service.js";
import type { Command } from "../shared/contracts.js";

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

port.on(
  "message",
  async ({
    data,
  }: {
    data: {
      id: number;
      command?: Command;
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
      port.postMessage({
        id: data.id,
        value: data.shutdown
          ? await service.close()
          : await service.dispatch(data.command!),
      });
    } catch (error) {
      port.postMessage({ id: data.id, error: (error as Error).message });
    }
  },
);
