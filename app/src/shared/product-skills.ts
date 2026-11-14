export const productSkillCatalog = [
  { id: "paper-map.md", name: "建图", description: "生成阅读地图与逐节论文精解" },
  { id: "memory-card.md", name: "记忆卡片", description: "整理指定讨论或原文中值得留下的内容" },
] as const;

export interface ProductSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  version: string;
}
