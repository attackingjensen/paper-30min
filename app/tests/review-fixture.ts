import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Manifest } from "../src/shared/contracts";
import type { ParsingRun } from "../src/shared/parsing";
import { checkParsingPdf } from "../src/main/baidu-candidate";

// Historical Agent tests start after parsing. Seed that precondition as ordinary
// project files; the production readiness check still runs through IPC.
export async function seedParsing(root: string, reviewed = true, batchId = "c".repeat(32)) {
  const manifest: Manifest = JSON.parse(await fs.readFile(path.join(root, "paper30min.json"), "utf8"));
  const bytes = await fs.readFile(path.join(root, manifest.paper.path));
  const pageCount = await checkParsingPdf({ bytes: new Uint8Array(bytes), sha256: manifest.paper.sha256 });
  const body = Buffer.from("Original paragraph.\n");
  const mapping = Buffer.from(JSON.stringify({ formatVersion: 1, projectId: manifest.id,
    batchId, document: manifest.paper, rawSha256: "b".repeat(64), blocks: [], images: [] }));
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const run: ParsingRun = { formatVersion: 1, projectId: manifest.id, batchId, document: manifest.paper,
    endpoint: "https://example.com", model: "fixture", phase: "candidate", candidate: `text/${batchId}/paper.md`,
    rawSha256: "b".repeat(64), mappingSha256: hash(mapping), markdownSha256: hash(body),
    completedPages: pageCount, pageCount, reviewedThroughPage: reviewed ? pageCount : 0,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), elapsedMs: 0 };
  await fs.mkdir(path.join(root, "text", batchId), { recursive: true });
  await fs.mkdir(path.join(root, ".paper30min/parsing", batchId), { recursive: true });
  await fs.writeFile(path.join(root, run.candidate!), body);
  await fs.writeFile(path.join(root, ".paper30min/parsing", batchId, "mapping.json"), mapping);
  await fs.writeFile(path.join(root, ".paper30min/parsing", batchId, "run.json"), JSON.stringify(run));
  return run;
}
