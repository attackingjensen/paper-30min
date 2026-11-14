import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProjectService } from "../src/main/project-service";
import { ParsingService } from "../src/main/parsing-service";
import type { Project } from "../src/shared/contracts";
import type { ParsingRun } from "../src/shared/parsing";

test("审阅按连续页持久化，新会话从未完成页继续，正文可持续纠错且 PDF 替换失效", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-review-"));
  const projects = new ProjectService(path.join(directory, "preferences.json"), async () => {});
  const parsing = new ParsingService(projects);
  try {
    const project = await projects.dispatch({ type: "create", input: {
      source: path.resolve("../legacy/v1/app/ui/samples/sample_paper.pdf"),
      parent: directory, name: "review", makeDefault: false, operationId: "review",
    } }) as Project;
    const { root } = project;
    const batchId = "a".repeat(32);
    const body = Buffer.from("Original paragraph.\n");
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const mapping = Buffer.from(JSON.stringify({ formatVersion: 1, projectId: project.manifest.id,
      batchId, document: project.manifest.paper, rawSha256: "b".repeat(64), blocks: [], images: [] }));
    const candidate = await projects.writeParsingFile(root, batchId, "candidate.md", body);
    await projects.writeParsingFile(root, batchId, "mapping.json", mapping);
    const run: ParsingRun = { formatVersion: 1, projectId: project.manifest.id, batchId,
      document: project.manifest.paper, endpoint: "https://example.com", model: "fixture",
      phase: "candidate", candidate, rawSha256: "b".repeat(64), mappingSha256: hash(mapping),
      markdownSha256: hash(body), completedPages: 2, pageCount: 2,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), elapsedMs: 0 };
    await projects.writeParsingFile(root, batchId, "run.json", Buffer.from(JSON.stringify(run)));
    await expect(parsing.requireReviewed(root)).rejects.toThrow("审阅");
    await parsing.startReview(root, batchId, "first");
    await expect(parsing.startReview(root, batchId, "parallel")).rejects.toThrow("正在审阅");
    await expect(parsing.completeReviewPage(root, batchId, "first", 2, new AbortController().signal)).rejects.toThrow("第 1 页");
    await parsing.completeReviewPage(root, batchId, "first", 1, new AbortController().signal);
    await parsing.finishReview(root, batchId, "first", "已停止");
    const next = new ParsingService(projects);
    expect((await next.startReview(root, batchId, "second")).reviewedThroughPage).toBe(1);
    await expect(parsing.completeReviewPage(root, batchId, "first", 2, new AbortController().signal)).rejects.toThrow();
    const file = await projects.readAgentFile(root, path.join(root, candidate));
    await projects.writeAgentFile(root, path.join(root, candidate), "Corrected paragraph.\n", file.version, new AbortController().signal);
    await next.completeReviewPage(root, batchId, "second", 2, new AbortController().signal);
    await next.finishReview(root, batchId, "second");
    expect((await next.requireReviewed(root)).reviewedThroughPage).toBe(2);
    await fs.writeFile(path.join(root, candidate), "Later correction.\n");
    expect((await next.requireReviewed(root)).reviewedThroughPage).toBe(2);
    await fs.appendFile(path.join(root, project.manifest.paper.path), "\n% replaced\n");
    await expect(next.requireReviewed(root)).rejects.toThrow("PDF");
    await expect(next.startReview(root, batchId, "third")).rejects.toThrow("PDF");
  } finally {
    await parsing.close();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
