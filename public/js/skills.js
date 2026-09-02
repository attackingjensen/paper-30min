// 技能库：每个章节对应一个精读提示词模板（可编辑、可导入 .md 覆盖）
// 占位符：{title} = 论文标题，{content} = 该章节原文
const SKILLS_KEY = 'pr.skills.v1';

export const BUILTIN_SKILLS = [
  {
    id: 'abstract',
    name: '摘要精读 · 翻译',
    section: 'abstract',
    description: '英文原文 + 规范中文翻译 + 一句话总结',
    prompt: `你是一位严谨的 AI 论文精读助手。下面是论文《{title}》的 Abstract 原文。

请完成：
1. 【规范中文翻译】：忠实、准确、流畅地翻译全文，不增删信息；专业术语采用「中文译名（English Term）」格式，首次出现时标注英文。
2. 【一句话总结】：用不超过 60 个字概括这篇论文做了什么、达到了什么。

输出使用 Markdown 格式。

Abstract 原文：
"""
{content}
"""`,
  },
  {
    id: 'introduction',
    name: '引言精读 · 背景与贡献',
    section: 'introduction',
    description: '领域背景 / 相关工作 / 要解决的问题 / 本文贡献',
    prompt: `你是一位资深 AI 研究员，正在精读论文《{title}》的 Introduction（含相关工作）部分。请用中文按以下四个板块输出（使用 Markdown 二级标题）：

## 领域背景
这篇论文所处的研究领域与宏观背景，理解它所需的必要概念。

## 相关工作与现状
已有工作的主要思路脉络与分类，以及它们各自的局限。

## 要解决的问题
本文具体要解决什么问题？为什么已有方法解决不好？痛点是什么？

## 本文贡献
逐条列出论文声明的贡献，每条后面附一句你的点评（是否实质、含金量如何）。

要求：忠实于原文、具体不空泛；引用论文关键表述时附上简短英文原句。

Introduction 原文：
"""
{content}
"""`,
  },
  {
    id: 'part',
    name: '通用章节精读 · 自适应',
    section: 'part',
    description: '适用于理论、问题定义、系统设计等任意正文部分',
    prompt: `你是一位资深 AI 研究员，正在精读论文《{title}》的「{section}」。论文没有必要使用固定的 Method 结构，请严格根据本章节实际内容组织分析。

请用中文输出以下板块（没有对应内容的板块可以省略，不要臆造）：

## 本节定位
说明这一部分在整篇论文中的作用，以及它承接和推进了什么。

## 核心内容
提炼本节提出的关键概念、假设、问题、论证或设计，保持原文逻辑顺序。

## 关键细节
解释重要公式、模块、算法步骤或理论结论；公式沿用 LaTeX，并说明符号含义。

## 作用与局限
分析这些内容为什么重要、依赖哪些前提，以及原文呈现出的限制或未回答问题。

要求：忠实于原文；区分作者明确陈述与自己的解释；不要因为它位于正文中间就默认它是“方法章节”。

通用章节原文：
"""
{content}
"""`,
  },
  {
    id: 'method',
    name: '方法精读 · 创新点深挖',
    section: 'method',
    description: '核心创新点 / 方法详解 / 为什么有效 / 设计细节',
    prompt: `你是一位资深 AI 研究员，正在精读论文《{title}》的 Method 部分——这是读者最关心的部分。请用中文按以下板块输出（使用 Markdown 二级标题）：

## 核心创新点
用 3~5 句话讲清楚方法最核心的创新是什么，与已有方法的关键区别在哪里。

## 方法详解
分步骤 / 分模块拆解方法：输入是什么、经过哪些处理、输出是什么；涉及的关键公式请用文字解释其含义与作用。

## 为什么有效
作者给出了哪些论证、直觉或分析来解释该方法为什么 work？请完整提炼；如果作者没有给出解释，请明确指出，并基于方法设计给出你的合理推测。

## 值得注意的设计细节
实现中容易被忽略但重要的细节（超参选择、初始化、训练技巧、工程取舍等）。

要求：深入但不堆砌术语；讲清「为什么」，而不只是「是什么」。

Method 原文：
"""
{content}
"""`,
  },
  {
    id: 'experiments',
    name: '实验精读 · 结果与消融',
    section: 'experiments',
    description: '评测设置 / 主要结果 / 训练推理细节 / 消融实验 / 洞察',
    prompt: `你是一位资深 AI 研究员，正在精读论文《{title}》的 Experiment 部分。请用中文按以下板块输出（使用 Markdown 二级标题）：

## 评测设置
在哪些 benchmark / 数据集、哪些任务上评测；对比了哪些基线方法。

## 主要结果
关键数字与结论：在哪些任务上达到什么效果，相对基线提升多少，是否 SOTA。适合时用表格呈现。

## 训练与推理细节
模型规模、数据、优化器、学习率、算力开销、推理方式等可复现性细节。

## 消融实验
消融了哪些组件、各自贡献多少、哪个组件最关键；若论文缺少消融请明确指出。

## 结果洞察
作者对实验结果的分析与 insight；以及你从这些数字中读出的、作者没有明说的信息。

Experiment 原文：
"""
{content}
"""`,
  },
];

export const CHAT_SYSTEM_TEMPLATE = `你是「论文精读助手」，正在帮助用户深入理解论文《{title}》。以下是论文的主要内容（可能被截断）：

{content}

请基于论文内容用中文回答用户问题；引用原文时给出英文原句；如果论文中没有相关内容，请如实说明，不要编造。回答使用 Markdown 格式。`;

// ---------- 自定义覆盖的读写 ----------
export function loadCustomSkills() {
  try { return JSON.parse(localStorage.getItem(SKILLS_KEY)) || {}; } catch { return {}; }
}

export function saveCustomSkill(id, prompt) {
  const all = loadCustomSkills();
  all[id] = prompt;
  localStorage.setItem(SKILLS_KEY, JSON.stringify(all));
}

export function resetSkill(id) {
  const all = loadCustomSkills();
  delete all[id];
  localStorage.setItem(SKILLS_KEY, JSON.stringify(all));
}

/** 获取当前生效的技能列表（含是否已自定义标记） */
export function effectiveSkills() {
  const custom = loadCustomSkills();
  return BUILTIN_SKILLS.map(s => ({
    ...s,
    prompt: custom[s.id] ?? s.prompt,
    customized: s.id in custom,
  }));
}

export function getSkill(id) {
  return effectiveSkills().find(s => s.id === id);
}

export function buildPrompt(skill, title, content, section = '') {
  return skill.prompt
    .replaceAll('{title}', title)
    .replaceAll('{section}', section)
    .replaceAll('{content}', content);
}

/** 解析 .md 技能文件：支持 YAML frontmatter（name/description/section），正文为提示词 */
export function parseSkillFile(filename, text) {
  let name = filename.replace(/\.(md|txt)$/i, '');
  let description = '';
  let section = '';
  let body = text;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(name|description|section)\s*:\s*(.+)$/i);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1].toLowerCase() === 'name') name = v;
      if (m[1].toLowerCase() === 'description') description = v;
      if (m[1].toLowerCase() === 'section') section = v.toLowerCase();
    }
    body = fm[2].trim();
  }
  return { name, description, section, prompt: body };
}
