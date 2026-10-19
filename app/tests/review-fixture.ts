import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Manifest } from "../src/shared/contracts";
import type { ParsingRun } from "../src/shared/parsing";
import { checkParsingPdf } from "../src/main/baidu-candidate";
import { ProjectService } from "../src/main/project-service";
import type { Citation } from "../src/shared/citations";

// A short transcribed block from the Attention Is All You Need fixture. Register
// ordinary parser output, then exercise only production tool/desktop entry points.
export async function seedBlockParsing(root: string) {
  const run = await seedParsing(root);
  const projects = new ProjectService(path.join(root, "tmp/test-preferences.json"), async () => {});
  const excerpt = "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.";
  try {
    const citation = await projects.dispatch({ type: "createCitation", root, path: run.document.path,
      input: { sha256: run.document.sha256, kind: "region", text: "", pages: [
        { page: 1, width: 612, height: 792, rects: [{ origin: { x: 144, y: 414 }, size: { width: 325, height: 18 } }] },
      ] } }) as Citation;
    const mapping = Buffer.from(JSON.stringify({ formatVersion: 1, projectId: run.projectId, batchId: run.batchId,
      document: run.document, rawSha256: run.rawSha256, images: [], blocks: [
        { id: `${run.batchId}:p1:b0`, label: "text", text: excerpt, vendorIds: [0], citation, images: [], limitation: "" },
      ] }));
    const link = `paper://cite/${citation.id}`;
    const body = Buffer.from(`# Attention Is All You Need\n\n${excerpt}\n\n[原文](${link})\n`);
    run.mappingSha256 = createHash("sha256").update(mapping).digest("hex");
    run.markdownSha256 = createHash("sha256").update(body).digest("hex");
    await fs.writeFile(path.join(root, ".paper30min/parsing", run.batchId, "mapping.json"), mapping);
    await fs.writeFile(path.join(root, ".paper30min/parsing", run.batchId, "run.json"), JSON.stringify(run));
    await fs.writeFile(path.join(root, run.candidate!), body);
    return { run, link, excerpt };
  } finally { await projects.close(); }
}

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
