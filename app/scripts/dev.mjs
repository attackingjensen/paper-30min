import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";

const compiler = spawn(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.node.json"],
  { stdio: "inherit" },
);
await new Promise((resolve, reject) =>
  compiler.on("exit", (code) =>
    code ? reject(new Error("Node build failed")) : resolve(),
  ),
);
const server = await createServer({
  server: { port: Number(process.env.PAPER30MIN_DEV_PORT ?? 5173) },
});
await server.listen();
server.printUrls();
const env = {
  ...process.env,
  PAPER30MIN_DEV_URL: server.resolvedUrls.local[0],
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", async () => {
  await server.close();
  process.exit();
});
process.on("SIGINT", () => child.kill());
