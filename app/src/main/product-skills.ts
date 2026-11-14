import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { productSkillCatalog, type ProductSkill } from "../shared/product-skills.js";

const bundled = fileURLToPath(new URL("../../skills/", import.meta.url));
const versionOf = (content: string) => createHash("sha256").update(content).digest("hex");

export class ProductSkills {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory?: string) {}

  async read(id: string): Promise<ProductSkill> {
    const info = productSkillCatalog.find(skill => skill.id === id);
    if (!info) throw new Error("未知的产品 Skill。");
    let content: string;
    try {
      if (!this.directory) throw Object.assign(new Error(), { code: "ENOENT" });
      content = await fs.readFile(path.join(this.directory, id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      content = await fs.readFile(path.join(bundled, id), "utf8");
    }
    return { ...info, content, version: versionOf(content) };
  }

  async list() {
    return Promise.all(productSkillCatalog.map(skill => this.read(skill.id)));
  }

  save(id: string, content: string, version: string): Promise<ProductSkill> {
    const operation = this.queue.then(async () => {
      if (!this.directory) throw new Error("产品 Skill 保存位置未配置。");
      if (!content.trim() || Buffer.byteLength(content) > 100_000)
        throw new Error("Skill 提示词不能为空或超过 100,000 字节。");
      if ((await this.read(id)).version !== version)
        throw new Error("Skill 已变化，请保留编辑内容并重新载入后整合。");
      await fs.mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, id);
      const temporary = path.join(this.directory, `.skill-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx");
        try { await handle.writeFile(content, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        if ((await this.read(id)).version !== version)
          throw new Error("Skill 已变化，本次未覆盖原内容。");
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return this.read(id);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
