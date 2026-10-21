import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadSkillsFromDir, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { extractChatSources, type ChatAttachment } from "../shared/chat-input.js";
import type { Project, PdfSource } from "../shared/contracts.js";
import type { ProjectService } from "./project-service.js";
import type { ReferenceService } from "./reference-service.js";

// Only product prompts shipped with the app; never discover user/development skills.
const skillDirectory = fileURLToPath(new URL("../../../skills/", import.meta.url));
function productSkills() {
  return loadSkillsFromDir({ dir: skillDirectory, source: "paper30min" }).skills;
}
export async function chatMaterials(projects: ProjectService, root: string): Promise<ChatAttachment[]> {
  const project = await projects.dispatch({ type: "refresh", root }) as Project;
  return [
    ...project.files.filter(file => !file.directory && /\.(md|txt|pdf)$/i.test(file.path)).map(file => ({ kind: "document" as const, value: file.path, label: file.path })),
    ...productSkills().map(skill => ({ kind: "skill" as const, value: path.relative(skillDirectory, skill.filePath).replaceAll("\\", "/"), label: skill.name })),
  ];
}
export async function prepareChatInput(projects: ProjectService, references: ReferenceService, root: string, text: string, attachments: ChatAttachment[] = []) {
  if (!Array.isArray(attachments) || attachments.length > 50) throw new Error("每条消息最多包含 50 个附件。");
  const extracted = extractChatSources(text);
  attachments = [...attachments, ...extracted.attachments];
  if (attachments.length > 50) throw new Error("每条消息最多包含 50 个附件。");
  const sections = [extracted.text];
  const seen = new Set<string>();
  for (const item of attachments) {
    if (!item || typeof item.value !== "string" || item.value.length > 4096) throw new Error("聊天附件无效。");
    const key = `${item.kind}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.kind === "source") {
      const source = await references.resolve(root, { link: item.value });
      sections.push(`[来源](<${item.value}>)\n\n发送时的来源快照（选区为关注范围；正文请按位置 read，按需 read_pdf）：\n\n\`\`\`json\n${JSON.stringify(source, null, 2)}\n\`\`\``);
    } else if (item.kind === "document") {
      const project = await projects.dispatch({ type: "refresh", root }) as Project;
      if (!project.files.some(file => !file.directory && file.path === item.value)) throw new Error(`指定文档已缺失或移动：${item.value}`);
      const version = /\.pdf$/i.test(item.value)
        ? (await projects.dispatch({ type: "readPdf", root, path: item.value }) as PdfSource).sha256
        : (await projects.readAgentFile(root, path.resolve(root, item.value))).version;
      const identity = [project.manifest.paper, ...project.manifest.materials].find(record => record.path === item.value)?.id;
      sections.push(`指定工程文档：${JSON.stringify(item.value)}${identity ? `（文档 ID：${identity}）` : ""}，发送时 SHA-256 ${version}。按需读取，未附加全文；后续读取若版本变化应说明。`);
    } else if (item.kind === "skill") {
      const skill = productSkills().find(skill => path.relative(skillDirectory, skill.filePath).replaceAll("\\", "/") === item.value);
      if (!skill) throw new Error(`产品 Skill 缺失或加载失败：${item.value}`);
      const content = await fs.readFile(skill.filePath, "utf8");
      const version = createHash("sha256").update(content).digest("hex");
      sections.push(`本轮指定产品 Skill：${skill.name}（${item.value}，SHA-256 ${version}）。以下是本轮指令原文；模板中未提供的材料须按需读取，不得假称已提供。\n\n<skill name=${JSON.stringify(skill.name)}>\n${stripFrontmatter(content).trim()}\n</skill>`);
    } else throw new Error("未知的聊天附件类型。");
  }
  return sections.join("\n\n");
}
