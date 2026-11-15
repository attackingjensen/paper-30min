import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductSkills } from "../src/main/product-skills";

test("产品 Skill 编辑保留明确版本，过期或无效保存不覆盖已保存提示词", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper30min-skills-"));
  try {
    const store = new ProductSkills(directory);
    expect((await store.list()).map(skill => skill.name)).toEqual(["记忆卡片"]);
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
