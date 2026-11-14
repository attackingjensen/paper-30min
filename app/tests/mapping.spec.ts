import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectService } from "../src/main/project-service";
import { seedBlockParsing } from "./review-fixture";
import type { Project } from "../src/shared/contracts";
import type { MappingPlan } from "../src/shared/mapping";
import { ProductSkills } from "../src/main/product-skills";

test("建图完整发布按清单顺序登记十三节与附录，失败停止和期间编辑保留旧成果", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-mapping-"));
  const projects = new ProjectService(path.join(directory, "preferences.json"), file => fs.rm(file));
  try {
    const project = await projects.dispatch({ type: "create", input: {
      source: path.resolve("../legacy/v1/app/ui/samples/sample_paper.pdf"), parent: directory,
      name: "mapping", makeDefault: false, operationId: "mapping",
    } }) as Project;
    const { root } = project;
    const { run, link } = await seedBlockParsing(root);
    const plan = await projects.createMappingPlan(root, run.candidate!);
    const files = [...Array.from({ length: 12 }, (_, index) => `explanations/${index + 1}.md`), "explanations/附录.md"];
    const signal = new AbortController().signal;
    async function stage(plan: MappingPlan, explanations = files) {
      for (const [index, file] of ["map.md", ...explanations].entries())
        await projects.writeAgentFile(root, path.join(root, plan.directory, file), `# ${index ? `第${index}节` : "地图"}\n\n讲解与[原文](${link})。\n`, null, signal, { outputDirectory: plan.directory });
      await projects.writeAgentFile(root, path.join(root, plan.directory, "result.json"), JSON.stringify({ map: "map.md", explanations }), null, signal, { outputDirectory: plan.directory });
    }
    await expect(projects.writeAgentFile(root, path.join(root, "notes/wrong.md"), "wrong", null, signal, { outputDirectory: plan.directory })).rejects.toThrow("建图只能");
    await stage(plan);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(projects.publishMapping(root, plan, cancelled.signal)).rejects.toThrow();
    expect((await projects.dispatch({ type: "refresh", root }) as Project).manifest.map).toBeNull();
    const published = await projects.publishMapping(root, plan, signal);
    const first = await projects.dispatch({ type: "refresh", root }) as Project;
    expect(first.manifest.explanations.map(file => path.posix.basename(file))).toEqual(["1.md", "2.md", "3.md", "4.md", "5.md", "6.md", "7.md", "8.md", "9.md", "10.md", "11.md", "12.md", "附录.md"]);
    expect(published.files).toEqual([first.manifest.map, ...first.manifest.explanations]);
    expect((await projects.dispatch({ type: "readMarkdown", root, path: first.manifest.explanations[9] }) as { text: string }).text).toContain("第10节");
    const next = await projects.createMappingPlan(root, run.candidate!);
    await stage(next, ["explanations/引言.md"]);
    await fs.writeFile(path.join(root, first.manifest.explanations[0]), "用户新内容");
    await expect(projects.publishMapping(root, next, signal)).rejects.toThrow("已变化");
    expect((await projects.dispatch({ type: "refresh", root }) as Project).manifest).toEqual(first.manifest);
    expect(await fs.readFile(path.join(root, first.manifest.explanations[0]), "utf8")).toBe("用户新内容");
    expect(await fs.readFile(path.join(root, next.directory, "map.md"), "utf8")).toContain(link);
    const incomplete = await projects.createMappingPlan(root, run.candidate!);
    await projects.writeAgentFile(root, path.join(root, incomplete.directory, "result.json"), JSON.stringify({ map: "map.md", explanations: [] }), null, signal, { outputDirectory: incomplete.directory });
    await expect(projects.publishMapping(root, incomplete, signal)).rejects.toThrow("结果清单无效");
    const replacement = await projects.createMappingPlan(root, run.candidate!);
    await stage(replacement, ["explanations/新版.md"]);
    await projects.publishMapping(root, replacement, signal);
    const current = await projects.dispatch({ type: "open", root }) as Project;
    expect(current.manifest.explanations).toEqual([`explanations/${replacement.id}/新版.md`]);
    expect(await fs.stat(path.join(root, first.manifest.map!)).catch(() => null)).toBeNull();
    expect((await projects.dispatch({ type: "pdfUses", root, path: project.manifest.paper.path }) as { citations: { uses: unknown[] }[] }).citations[0].uses.length).toBeGreaterThan(0);
  } finally { await projects.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("产品 Skill 编辑保留明确版本，过期或无效保存不覆盖已保存提示词", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-skills-"));
  try {
    const store = new ProductSkills(directory);
    expect((await store.list()).map(skill => skill.name)).toEqual(["建图", "记忆卡片"]);
    const original = await store.read("memory-card.md");
    const edited = await store.save(original.id, original.content + "\n保留用户关注的条件。", original.version);
    expect(edited.version).not.toBe(original.version);
    await expect(store.save(original.id, "过期输入", original.version)).rejects.toThrow("Skill 已变化");
    await expect(store.save(original.id, "", edited.version)).rejects.toThrow("不能为空");
    await expect(store.read("../other.md")).rejects.toThrow("未知");
    expect(await new ProductSkills(directory).read(original.id)).toEqual(edited);
    expect(await fs.readdir(directory)).toEqual(["memory-card.md"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
