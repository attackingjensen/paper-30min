import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { PNG } from "pngjs";
import { ProjectService } from "../src/main/project-service";
import { ParsingService } from "../src/main/parsing-service";
import {
  defaultParsingSettings,
  type ParsingRun,
  type ParsingMapping,
} from "../src/shared/parsing";
import type { Project } from "../src/shared/contracts";
import { markdownRenderer } from "../src/shared/markdown-references";

test("真实百度片段生成独立批次、多区域引用和离线候选；失败恢复不重复提交", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-parsing-"),
  );
  const projects = new ProjectService(
    path.join(directory, "preferences.json"),
    async () => {},
  );
  let submits = 0;
  let downloads = 0;
  const rows = (
    await fs.readFile(
      "../legacy/v1/app/src-tauri/tests/fixtures/aistudio/1512.03385.jsonl",
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  const firstPage = rows[0].result.layoutParsingResults[0];
  firstPage.markdown = {
    images: { "imgs/table.png": PNG.sync.write(image).toString("base64") },
  };
  firstPage.prunedResult.parsing_res_list[0].block_label = "table";
  firstPage.prunedResult.parsing_res_list[0].block_content =
    '<table><tr><th>Image</th></tr><tr><td><img src="imgs/table.png" /></td></tr></table>';
  const paragraph = firstPage.prunedResult.parsing_res_list.find((block: any) => block.block_label === "figure_title");
  paragraph.block_content = "First paragraph.\n\nSecond paragraph.\n\n```text\ncode example\n```\n\nSection title\n===\n\n| A | B |\n| --- | --- |\n| x | y |\n\n1. First item\n\n   ```text\n   nested code\n   ```\n\n2. Second item\n\n> | A | B |\n> | --- | --- |\n> | x | y |\n>\n> After table.";
  firstPage.prunedResult.parsing_res_list.push({
    block_id: 10000,
    block_label: "text",
    block_content: "    indented code\n    second line",
    block_bbox: [10, 10, 100, 50],
  });
  let raw = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n"));
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      submits++;
      for await (const _chunk of request) {
        /* Consume the actual multipart upload. */
      }
      if (submits === 1) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { jobId: "job-1" } }));
    } else if (request.url === "/jobs/job-1") {
      response.end(
        JSON.stringify({
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
        }),
      );
    } else {
      downloads++;
      if (downloads === 1) {
        response.writeHead(503);
        response.end();
      } else response.end(raw);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/jobs`;
  const config = { ...defaultParsingSettings, endpoint, apiKey: "test-secret" };
  const parsing = new ParsingService(projects);
  try {
    const project = (await projects.dispatch({
      type: "create",
      input: {
        source: path.resolve(
          "../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf",
        ),
        parent: directory,
        name: "paper",
        makeDefault: false,
        operationId: "create",
      },
    })) as Project;
    const { root } = project;
    const rejected = (await parsing.dispatch(
      { type: "start", root, documentId: project.manifest.paper.id },
      config,
    )) as ParsingRun;
    const status = async () =>
      (
        (await parsing.dispatch(
          { type: "status", root },
          config,
        )) as ParsingRun[]
      )[0];
    await expect.poll(async () => (await status()).phase).toBe("failed");
    expect((await status()).batchId).toBe(rejected.batchId);
    expect((await status()).jobId).toBeUndefined();
    const run = (await parsing.dispatch(
      { type: "start", root, documentId: project.manifest.paper.id },
      config,
    )) as ParsingRun;
    await expect.poll(async () => (await status()).phase).toBe("failed");
    expect((await status()).jobId).toBe("job-1");
    await parsing.dispatch(
      { type: "resume", root, batchId: run.batchId },
      config,
    );
    await expect
      .poll(async () => (await status()).phase, { timeout: 60_000 })
      .toBe("candidate");
    expect(submits).toBe(2);
    const final = await status();
    expect(final.pageCount).toBe(12);
    const mapping: ParsingMapping = JSON.parse(
      await fs.readFile(
        path.join(root, ".paper30min/parsing", run.batchId, "mapping.json"),
        "utf8",
      ),
    );
    const grouped = mapping.blocks.find(
      (block) => block.vendorIds.includes(7) && block.vendorIds.includes(8),
    );
    expect(grouped?.citation.pages[0].rects).toHaveLength(2);
    expect(grouped?.citation.pages[0].rects[0].origin.x).toBeCloseTo(47);
    expect(
      mapping.blocks.some(
        (block) =>
          block.label === "display_formula" && block.citation.kind === "region",
      ),
    ).toBe(true);
    expect(mapping.images.length).toBeGreaterThan(0);
    const markdown = await fs.readFile(
      path.join(root, final.candidate!),
      "utf8",
    );
    expect(markdown).not.toContain("块 ID：");
    expect(markdown).not.toContain("图片来源：");
    expect(markdown).toContain(`[原文](paper://cite/${grouped!.citation.id})`);
    expect(final.candidate).toBe(`text/${run.batchId}/paper.md`);
    expect(await fs.readdir(path.join(root, "text", run.batchId))).toEqual(["images", "paper.md"]);
    const snapshot = await projects.dispatch({ type: "refresh", root }) as Project;
    expect(snapshot.files.some((file) => file.path.startsWith(".paper30min/"))).toBe(false);
    expect(snapshot.files.filter((file) => file.path.startsWith(`text/${run.batchId}/`) && file.path.endsWith(".md"))).toHaveLength(1);
    expect(markdown).not.toContain("test-secret");
    expect(markdown).not.toContain("http:");
    expect(mapping.blocks[0].images.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("](imgs/table.png)");
    const tableImage = mapping.blocks[0].images[0];
    expect(markdown.split(`](${tableImage})`)).toHaveLength(2);
    for (const crop of mapping.blocks[0].images.slice(1))
      expect(markdown).not.toContain(`](${crop})`);
    const paragraphBlock = mapping.blocks.find((block) => block.vendorIds.includes(paragraph.block_id))!;
    expect(paragraphBlock.text).toContain("Second paragraph.");
    expect(markdown).toContain(`First paragraph. [原文](paper://cite/${paragraphBlock.citation.id})\n\nSecond paragraph. [原文](paper://cite/${paragraphBlock.citation.id})`);
    expect(markdown).toContain("```text\ncode example\n```");
    const rendered = markdownRenderer.render(markdown);
    expect(rendered).toContain(`<h1>Section title <a href="paper://cite/${paragraphBlock.citation.id}">原文</a></h1>`);
    expect(rendered).toContain(`</table>\n<p><a href="paper://cite/${paragraphBlock.citation.id}">原文</a></p>`);
    expect(rendered.match(/<ol>/g)).toHaveLength(1);
    expect(rendered).toContain(`<li>\n<p>Second item <a href="paper://cite/${paragraphBlock.citation.id}">原文</a></p>`);
    expect(rendered.match(/<blockquote>/g)).toHaveLength(1);
    const codeBlock = mapping.blocks.find((block) => block.vendorIds.includes(10000))!;
    expect(rendered).toContain(`<pre><code>indented code\nsecond line\n</code></pre>\n<p><a href="paper://cite/${codeBlock.citation.id}">原文</a></p>`);
    for (const block of mapping.blocks) {
      const resolved: any = await projects.dispatch({
        type: "resolveCitation",
        root,
        link: `paper://cite/${block.citation.id}`,
      });
      expect(resolved.citation).toEqual(block.citation);
    }
    const validRaw = raw;
    raw = Buffer.from("");
    await parsing.dispatch(
      { type: "start", root, documentId: project.manifest.paper.id },
      config,
    );
    await expect.poll(async () => (await status()).phase).toBe("failed");
    expect((await status()).rawSha256).toBeTruthy();
    raw = validRaw;
    const newRun = (await parsing.dispatch(
      { type: "start", root, documentId: project.manifest.paper.id },
      config,
    )) as ParsingRun;
    await expect
      .poll(async () => (await status()).phase, { timeout: 60_000 })
      .toBe("candidate");
    const newMapping: ParsingMapping = JSON.parse(
      (
        await projects.readParsingFile(root, newRun.batchId, "mapping.json")
      ).toString(),
    );
    expect(
      newMapping.blocks.some((block) =>
        mapping.blocks.some((old) => old.id === block.id),
      ),
    ).toBe(false);
    expect(
      (
        await projects.readParsingFile(root, run.batchId, "candidate.md")
      ).toString(),
    ).toBe(markdown);
    // Recreate a pre-change completed batch to exercise its existing on-disk contract.
    const legacy = path.join(root, "text/candidates", run.batchId);
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.rename(path.join(root, ".paper30min/parsing", run.batchId), legacy);
    await fs.rename(path.join(root, "text", run.batchId, "paper.md"), path.join(legacy, "candidate.md"));
    await fs.rename(path.join(root, "text", run.batchId, "images"), path.join(legacy, "images"));
    const legacyRun = JSON.parse(await fs.readFile(path.join(legacy, "run.json"), "utf8"));
    legacyRun.candidate = `text/candidates/${run.batchId}/candidate.md`;
    await fs.writeFile(path.join(legacy, "run.json"), JSON.stringify(legacyRun));
    await fs.writeFile(path.join(legacy, "page-1.md"), "existing page output");
    const reopened = new ParsingService(projects);
    expect(
      (
        (await reopened.dispatch(
          { type: "status", root },
          config,
        )) as ParsingRun[]
      )[0].phase,
    ).toBe("candidate");
    await reopened.dispatch(
      { type: "verify", root, batchId: run.batchId },
      { ...config, apiKey: "" },
    );
    const imagePath = mapping.images[0].path;
    await fs.writeFile(
      path.join(legacy, imagePath),
      "damaged",
    );
    await expect(
      reopened.dispatch({ type: "verify", root, batchId: run.batchId }, config),
    ).rejects.toThrow("候选图片缺失或已变化");
    await expect(
      projects.writeParsingFile(
        root,
        run.batchId,
        imagePath,
        Buffer.from("replacement"),
      ),
    ).rejects.toThrow("不能覆盖");
    expect(
      (await projects.readParsingFile(root, run.batchId, imagePath)).toString(),
    ).toBe("damaged");
    expect(await fs.readFile(path.join(legacy, "page-1.md"), "utf8")).toBe("existing page output");
    await reopened.close();
  } finally {
    await parsing.close();
    await projects.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("停止提交时仍保存迟到的任务回执，重开复用任务号", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-receipt-"),
  );
  const projects = new ProjectService(
    path.join(directory, "preferences.json"),
    async () => {},
  );
  const parsing = new ParsingService(projects);
  let submits = 0;
  let accepted!: () => void;
  let receipt!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    receipt = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      submits++;
      for await (const _chunk of request) {
        /* The receipt arrives after cancellation. */
      }
      accepted();
      await held;
      response.end(JSON.stringify({ data: { jobId: "late-job" } }));
    } else response.end(JSON.stringify({ data: { state: "failed" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    ...defaultParsingSettings,
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/jobs`,
    apiKey: "fixture",
  };
  try {
    const project = (await projects.dispatch({
      type: "create",
      input: {
        source: path.resolve(
          "../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf",
        ),
        parent: directory,
        name: "paper",
        makeDefault: false,
        operationId: "receipt",
      },
    })) as Project;
    const root = project.root;
    const run = (await parsing.dispatch(
      { type: "start", root, documentId: project.manifest.paper.id },
      config,
    )) as ParsingRun;
    await uploaded;
    await parsing.dispatch(
      { type: "stop", root, batchId: run.batchId },
      config,
    );
    receipt();
    await expect
      .poll(
        async () =>
          (
            (await parsing.dispatch(
              { type: "status", root },
              config,
            )) as ParsingRun[]
          )[0].phase,
      )
      .toBe("stopped");
    const legacy = path.join(root, "text/candidates", run.batchId);
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.rename(path.join(root, ".paper30min/parsing", run.batchId), legacy);
    const reopened = new ParsingService(projects);
    try {
      await reopened.dispatch(
        { type: "resume", root, batchId: run.batchId },
        config,
      );
      await expect
        .poll(
          async () =>
            (
              (await reopened.dispatch(
                { type: "status", root },
                config,
              )) as ParsingRun[]
            )[0].phase,
        )
        .toBe("remote-failed");
      expect(submits).toBe(1);
      expect(
        (
          (await reopened.dispatch(
            { type: "status", root },
            config,
          )) as ParsingRun[]
        )[0].jobId,
      ).toBe("late-job");
      expect(JSON.parse(await fs.readFile(path.join(legacy, "run.json"), "utf8")).phase).toBe("remote-failed");
    } finally {
      await reopened.close();
    }
  } finally {
    receipt();
    await parsing.close();
    await projects.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("未知提交禁止重付费；关联任务号后可恢复，任一分组坐标不可信则整块降为页级", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-unknown-"),
  );
  const projects = new ProjectService(
    path.join(directory, "preferences.json"),
    async () => {},
  );
  const parsing = new ParsingService(projects);
  let submits = 0;
  const rows = (
    await fs.readFile(
      "../legacy/v1/app/src-tauri/tests/fixtures/aistudio/1512.03385.jsonl",
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pages = rows.flatMap((row) => row.result.layoutParsingResults);
  pages[0].prunedResult.model_settings.use_doc_preprocessor = true;
  pages[1].prunedResult.parsing_res_list.find(
    (block: any) => block.block_id === 8,
  ).block_bbox = [-1, 0, 10, 10];
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      submits++;
      for await (const _chunk of request) {
        /* Service accepted the bytes but lost the receipt. */
      }
      request.socket.destroy();
    } else if (request.url === "/jobs/known-job")
      response.end(
        JSON.stringify({
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
        }),
      );
    else response.end(rows.map((row) => JSON.stringify(row)).join("\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/jobs`;
  const config = { ...defaultParsingSettings, endpoint, apiKey: "test-secret" };
  try {
    const project = (await projects.dispatch({
      type: "create",
      input: {
        source: path.resolve(
          "../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf",
        ),
        parent: directory,
        name: "paper",
        makeDefault: false,
        operationId: "unknown",
      },
    })) as Project;
    const root = project.root;
    const start = {
      type: "start" as const,
      root,
      documentId: project.manifest.paper.id,
    };
    const run = (await parsing.dispatch(start, config)) as ParsingRun;
    const status = async () =>
      (
        (await parsing.dispatch(
          { type: "status", root },
          config,
        )) as ParsingRun[]
      )[0];
    await expect.poll(async () => (await status()).phase).toBe("unknown");
    await expect(parsing.dispatch(start, config)).rejects.toThrow(
      "避免重复付费",
    );
    await expect(
      parsing.dispatch({ type: "resume", root, batchId: run.batchId }, config),
    ).rejects.toThrow("不能自动重传");
    const reopened = new ParsingService(projects);
    await reopened.dispatch(
      { type: "resume", root, batchId: run.batchId, jobId: "known-job" },
      config,
    );
    await expect
      .poll(
        async () =>
          (
            (await reopened.dispatch(
              { type: "status", root },
              config,
            )) as ParsingRun[]
          )[0].phase,
        { timeout: 60_000 },
      )
      .toBe("candidate");
    expect(submits).toBe(1);
    const mapping: ParsingMapping = JSON.parse(
      (
        await projects.readParsingFile(root, run.batchId, "mapping.json")
      ).toString(),
    );
    expect(
      mapping.blocks
        .filter((block) => block.citation.pages[0].page === 1)
        .every((block) => block.citation.kind === "page"),
    ).toBe(true);
    expect(
      mapping.blocks.find(
        (block) => block.vendorIds.includes(7) && block.vendorIds.includes(8),
      )?.citation.kind,
    ).toBe("page");
    const md = (
      await projects.readParsingFile(root, run.batchId, "candidate.md")
    ).toString();
    expect(md).not.toContain("未生成推测区域");
    expect(md).toContain("[原文](paper://cite/");
    expect(mapping.blocks[0].limitation).toContain("仅页级定位");
    await reopened.close();
  } finally {
    await parsing.close();
    await projects.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("旧版其余三份真实 JSONL 与对应 PDF 可生成完整候选，跨批次块 ID 独立", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-corpus-"),
  );
  const projects = new ProjectService(
    path.join(directory, "preferences.json"),
    async () => {},
  );
  const parsing = new ParsingService(projects);
  let current = Buffer.alloc(0);
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      for await (const _chunk of request) {
        /* Actual multipart upload. */
      }
      response.end(JSON.stringify({ data: { jobId: "fixture-job" } }));
    } else if (request.url === "/jobs/fixture-job")
      response.end(
        JSON.stringify({
          data: { state: "done", resultUrl: { jsonUrl: `${endpoint}/result` } },
        }),
      );
    else response.end(current);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/jobs`;
  const config = { ...defaultParsingSettings, endpoint, apiKey: "fixture" };
  const ids = new Set<string>();
  try {
    for (const [arxiv, count] of [
      ["1412.6980", 15],
      ["1503.02531", 9],
      ["1603.02754", 13],
    ] as const) {
      current = await fs.readFile(
        `../legacy/v1/app/src-tauri/tests/fixtures/aistudio/${arxiv}.jsonl`,
      );
      const project = (await projects.dispatch({
        type: "create",
        input: {
          source: path.resolve(
            `../legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/${arxiv}.pdf`,
          ),
          parent: directory,
          name: arxiv,
          makeDefault: false,
          operationId: arxiv,
        },
      })) as Project;
      const run = (await parsing.dispatch(
        {
          type: "start",
          root: project.root,
          documentId: project.manifest.paper.id,
        },
        config,
      )) as ParsingRun;
      await expect
        .poll(
          async () =>
            (
              (await parsing.dispatch(
                { type: "status", root: project.root },
                config,
              )) as ParsingRun[]
            )[0].phase,
          { timeout: 60_000 },
        )
        .toBe("candidate");
      const mapping: ParsingMapping = JSON.parse(
        (
          await projects.readParsingFile(
            project.root,
            run.batchId,
            "mapping.json",
          )
        ).toString(),
      );
      expect(
        new Set(
          mapping.blocks.flatMap((block) =>
            block.citation.pages.map((page) => page.page),
          ),
        ).size,
      ).toBe(count);
      expect(
        mapping.blocks.some((block) => block.citation.kind === "region"),
      ).toBe(true);
      for (const block of mapping.blocks) {
        expect(ids.has(block.id)).toBe(false);
        ids.add(block.id);
      }
    }
  } finally {
    await parsing.close();
    await projects.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
