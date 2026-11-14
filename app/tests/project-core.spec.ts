import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProject, openProject } from "../src/main/project-core";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sandbox: string;

test.beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-project-core-"));
});

test.afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

test("project-core 创建无 PDF 工程，只保存主论文身份、空 current 和首次导入记录", async () => {
  const created = await createProject({ parent: sandbox, name: "论文" });
  const root = path.join(sandbox, "论文");
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "paper30min.json"), "utf8"),
  );

  expect(manifest).toEqual({
    formatVersion: 2,
    id: created.manifest.id,
    name: "论文",
    paper: {
      id: created.manifest.paper.id,
      currentRevision: null,
    },
  });
  expect(manifest.id).toMatch(uuid);
  expect(manifest.paper.id).toMatch(uuid);
  expect(manifest.paper.id).not.toBe(manifest.id);
  expect(created.root).toBe(root);
  expect(await fs.readdir(root)).toHaveLength(2);
  await expect(fs.readdir(root)).resolves.toEqual(
    expect.arrayContaining(["paper30min.json", ".paper30min"]),
  );

  const importRecord = JSON.parse(
    await fs.readFile(
      path.join(root, ".paper30min", "imports", "initial.json"),
      "utf8",
    ),
  );
  expect(importRecord).toEqual({
    formatVersion: 1,
    id: expect.stringMatching(uuid),
    projectId: manifest.id,
    paperId: manifest.paper.id,
  });
  expect(created.importRecord).toEqual(importRecord);
});

test("project-core 重开首次导入中断工程时保留身份，并明确正文尚未提交", async () => {
  const created = await createProject({ parent: sandbox, name: "中断恢复" });
  const firstImport = created.importRecord;
  const reopened = await openProject(created.root);

  expect(reopened.manifest).toEqual(created.manifest);
  expect(reopened.manifest.paper.currentRevision).toBeNull();
  expect(reopened.importRecord).toEqual(firstImport);
  await expect(
    fs.stat(path.join(created.root, "paper", "revisions")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("project-core 拒绝覆盖已有目录，也不把空 current 的损坏工程当成可恢复工程", async () => {
  const created = await createProject({ parent: sandbox, name: "保留现场" });
  await fs.rm(path.join(created.root, ".paper30min", "imports", "initial.json"));

  await expect(openProject(created.root)).rejects.toThrow("首次导入记录");
  await expect(
    createProject({ parent: sandbox, name: "保留现场" }),
  ).rejects.toThrow("已存在");
  expect(await fs.readFile(path.join(created.root, "paper30min.json"), "utf8"))
    .toContain('"formatVersion": 2');
});

test("project-core 对 formatVersion: 1 明确分流，不按新清单读取", async () => {
  const root = path.join(sandbox, "旧工程");
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "paper30min.json"),
    JSON.stringify({ formatVersion: 1 }),
  );

  await expect(openProject(root)).rejects.toThrow("旧格式");
});
