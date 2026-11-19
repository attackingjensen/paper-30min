import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectService } from "../src/main/project-service";
import { createProjectTools } from "../src/main/agent-tools";

test("公共工程写入保护基线、取消与所有权", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paper30min-tool-files-"),
  );
  const service = new ProjectService(path.join(directory, "config.json"));
  try {
    const project = (await service.dispatch({
      type: "create",
      input: {
        source: path.resolve("tests/fixtures/sample_paper.pdf"),
        parent: directory,
        name: "project",
        makeDefault: false,
        operationId: "files",
      },
    })) as { root: string };
    const root = project.root;
    const file = path.join(root, "notes", "note.md");
    await fs.writeFile(file, "Original\r\n");
    const tools = createProjectTools(root, service, () => true, []);
    const run = (
      name: string,
      args: unknown,
      signal = new AbortController().signal,
    ) =>
      tools
        .find((tool) => tool.name === name)!
        .execute("call", args, signal, undefined, undefined as any);
    await run("read", { path: "notes/note.md" });
    await fs.writeFile(file, "External\r\n");
    const conflict = await run("edit", {
      path: "notes/note.md",
      edits: [{ oldText: "Original", newText: "Agent" }],
    });
    expect(conflict.details).toMatchObject({
      failed: true,
      conflict: {
        base: "Original\r\n",
        current: "External\r\n",
        proposed: "Agent\r\n",
      },
    });
    expect(await fs.readFile(file, "utf8")).toBe("External\r\n");
    await run("read", { path: "notes/note.md" });
    await run("edit", {
      path: "notes/note.md",
      edits: [
        { oldText: "External", newText: "Edited" },
      ],
    });
    expect(await fs.readFile(file, "utf8")).toBe("Edited\r\n");
    await run("write", {
      path: "notes/new/note.md",
      content: "New\r\n",
    });
    expect(
      await fs.readFile(path.join(root, "notes/new/note.md"), "utf8"),
    ).toBe("New\r\n");
    const corrected = await run("write", {
      path: "text/parsed.md",
      content: "changed",
    });
    expect(corrected.details).not.toMatchObject({ failed: true });
    const blocked = await run("write", { path: "text/images/original.png", content: "bad" });
    expect(blocked.details).toMatchObject({ failed: true });
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.writeAgentFile(root, file, "late", null, controller.signal),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toContain("Edited");
    await fs.symlink(
      path.join(root, "text"),
      path.join(root, "notes/link"),
      "junction",
    );
    const link = await run("write", {
      path: "notes/link/parsed.md",
      content: "bad",
    });
    expect(link.details).toMatchObject({ failed: true });
    expect(await fs.readFile(path.join(root, "text/parsed.md"), "utf8")).toBe("changed");
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
