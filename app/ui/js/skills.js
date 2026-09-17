// 技能库（#64 / 规格 #55 决策 23–25）：技能库 = 四段协议提示词（map-l2 / map-l1 / deep-dive /
// synthesize，各内嵌工具指导段与出处纪律段）+ 章节关注点数据（按章节类型叠加：协议提示词打底 +
// 该节类型关注点追加）。旧五技能（每类章节一个提示词）的内容迁为对应类型的关注点覆盖项，
// 原文件留档于 skills/legacy/，仍驱动旧精读生成路径（直至该路径随 #55 决策 26 退役）。
// 运行时以 skills.list@1 提供的文件为正式来源，BUILTIN_* 仅作来源失败时的降级兜底，
// 两者内容由 tests/skills-sync.test.mjs 强制同步。
// 覆盖对象 v2（settings `skills.overrides` 缝沿用）：
//   {version: 2, prompts: {stage: 提示词文本}, focus: {类型: [关注点]}, legacy: {旧技能id: 原文}}
// v1 平铺 {章节id: 提示词} 在 initSkills 时迁移并写回：已知类型 → focus 覆盖项 + legacy 只读留档，
// 未知键仅 legacy 留档；legacy 同时供旧精读路径沿用（用户调教在旧路径退役前不失效）。
// 移植自 public/js/skills.js：fetch('/api/skills') 与 localStorage 覆盖层
// 改为经 initSkills 注入的异步缝（main.js 启动时接 skills.list@1 / settings 命令）。

// ---------- 受控词表与占位符契约 ----------
// SECTION_TYPES 即建图调用①章节类型打标的受控词表（#55 决策 12），与 section-focus.json 的键一致。
export const PROTOCOL_STAGES = ['map-l2', 'map-l1', 'deep-dive', 'synthesize'];
// 覆盖对象版本：v2 = {version, prompts, focus, legacy}（v1 平铺 {章节id: 提示词} 迁移而来）。
const OVERRIDES_VERSION = 2;
export const SECTION_TYPES = ['abstract', 'introduction', 'method', 'experiments', 'part'];

// 各段协议提示词的必备占位符（结构断言与 #65 上下文装配共用此契约）。
export const PROTOCOL_PLACEHOLDERS = {
  'map-l2': ['title', 'paperText', 'sectionTypes', 'sectionFocus'],
  'map-l1': ['title', 'abstract', 'l2Summaries', 'figureList', 'tableList'],
  'deep-dive': ['title', 'map', 'l2Summaries', 'sectionId', 'sectionTitle', 'sectionType', 'sectionText', 'sectionPages', 'attachedAssets', 'sectionFocus'],
  'synthesize': ['title', 'map', 'l2Summaries', 'digResults'],
};

// 四段协议提示词的必备段落（结构断言用；工具指导段与出处纪律段为规格要求的内嵌段）。
export const PROTOCOL_REQUIRED_SECTIONS = ['## 任务', '## 工具', '## 出处纪律', '## 输出格式'];

/* __BUILTIN_PROTOCOL_PROMPTS_BEGIN__ */
export const BUILTIN_PROTOCOL_PROMPTS = [
  {
    id: 'map-l2',
    name: "建图 · 节薄摘要（L2）",
    stage: 'map-l2',
    description: "建图调用①：对本片原文章节生成薄摘要并打章节类型标",
    prompt: `<!-- Token 预算（#79）：输入 ≈ 本片原文章节文本层 + 关注点全表数百 token；输出 ≈ 单节 1500 字量级。调用方按节分片并发；任一调用装配后超 983,616 输入 token 由调用方报错拒绝，不截断。 -->

你是一位严谨的论文精读助手，正在为论文《{title}》执行建图第①步：通读本片块模型文本，为输入中出现的原文章节生成薄摘要（L2），并给出章节类型打标。

## 任务

对输入中出现的**每一个原文章节**（References / Acknowledgments 除外，遇到时跳过、不产出），生成一条薄摘要：

- \`gist\`：本节主旨，不超过 2 句；
- \`points\`：3–6 条要点，每条一句话并带出处指针；
- \`keyAssets\`：本节关键图 / 表的 id 清单（只取自正文中实际出现的 \`[图 fig_n]\` 占位与表编号，没有则为空数组）；
- \`pages\`：本节在原文中的起止页码；
- \`type\`：章节类型打标，取值只能是受控词表 {sectionTypes} 之一；按内容语义判断，词表匹配不上时回退为 \`part\`。

薄摘要的覆盖必须完整无缺口：不遗漏任何一节，也不把多节合并为一条。

## 章节关注点

下方按章节类型给出关注点清单。生成某节的薄摘要时，优先覆盖该节类型对应的关注点：

{sectionFocus}

## 工具

本阶段不调用任何工具：全文文本层已在下方完整给出。不要输出工具调用块（\` \`\`\`tool \` 围栏），直接产出结果。

## 出处纪律

EXTRACTED 纪律：每条要点必须携带出处指针，没有出处的论断不要写。出处指针统一语法：

- \`(p5)\`：第 5 页；
- \`(fig_3)\` / \`(tbl_2)\`：图 / 表清单条目；
- \`(L12-18)\`：本节第 12–18 块；
- \`(sec_2:L30-34)\`：跨节引用第 2 节第 30–34 块。

图表 id 只能取自正文中实际出现的编号，不得臆造清单外的图、表、节或块号。

## 输出格式

只输出一个 JSON 对象（不要输出其他任何文字，不要用代码围栏包裹）：

{"sections": [{"secId": "节 id", "title": "节标题", "type": "类型", "gist": "…", "points": [{"text": "…", "refs": ["(p5)"]}], "keyAssets": ["fig_3"], "pages": {"start": 3, "end": 5}}]}

论文全文块模型文本层：
"""
{paperText}
"""`,
  },
  {
    id: 'map-l1',
    name: "建图 · 阅读地图（L1）",
    stage: 'map-l1',
    description: "建图调用②：由全部节薄摘要、图表清单与摘要合成一屏阅读地图",
    prompt: `<!-- Token 预算：输入 ≈ 全部 L2（每节 1500 字量级）+ 图表清单 + Abstract，典型 1–3 万 token；输出为一屏地图（数百 token）。 -->

你是一位严谨的论文精读助手，正在为论文《{title}》执行建图第②步：基于摘要、全部节薄摘要（L2）与图表清单，合成一份一屏为限的阅读地图（L1）。不要回读原文——地图自底向上由给定材料合成。

## 任务

生成阅读地图，字段：

- \`problem\`：本文要解决的问题（1–2 句，带出处）；
- \`method\`：方法概述（2–4 句，带出处）；
- \`contributions\`：贡献声明清单（每条一句，带出处）；
- \`keyEvidence\`：关键证据清单——引用处最密集、结论性最强的图表，每条含 \`assetId\`（填图 / 表 id，如 "fig_3" / "tbl_2"，只能取自下方图表清单）、\`note\`（一句说明）与 \`refs\`；
- \`glossary\`：术语表，每条含 \`term\` 与 \`defRef\`（定义出处）；
- \`structure\`：节树——按薄摘要给出的顺序组织，含各节编号、标题与起止页；小节条目照录薄摘要中给出的索引信息（提示性元数据，保持原样，不要改写编号与标题）。

一屏为限，宁精勿滥：contributions 与 keyEvidence 各不超过 5 条，glossary 不超过 10 条。

## 工具

本阶段不调用任何工具：所需材料已全部给出。不要输出工具调用块（\` \`\`\`tool \` 围栏），直接产出结果。

## 出处纪律

EXTRACTED 纪律：problem / method / contributions / glossary 中每条论断必须携带出处指针，没有出处的论断不要写。出处指针统一语法：\`(p5)\` 页、\`(fig_3)\` / \`(tbl_2)\` 图表、\`(L12-18)\` 本节块、\`(sec_2:L30-34)\` 跨节块。structure 与 keyEvidence 的实体（节、图、表）只能取自输入材料中出现的编号——模型只写论断与说明，不得臆造清单外的实体。

## 输出格式

只输出一个 JSON 对象（不要输出其他任何文字，不要用代码围栏包裹）：

{"problem": {"text": "…", "refs": ["(p1)"]}, "method": {"text": "…", "refs": []}, "contributions": [{"text": "…", "refs": []}], "keyEvidence": [{"assetId": "fig_3", "note": "…", "refs": []}], "glossary": [{"term": "…", "defRef": "(sec_1:L12-14)"}], "structure": [{"secId": "…", "title": "…", "type": "…", "pages": {"start": 1, "end": 2}, "subsections": [{"number": "2.1", "title": "…"}]}]}

## 输入材料

论文摘要（Abstract）：
"""
{abstract}
"""

全部节薄摘要（L2）：
"""
{l2Summaries}
"""

图清单：
"""
{figureList}
"""

表清单：
"""
{tableList}
"""`,
  },
  {
    id: 'deep-dive',
    name: "深挖 · 四段式（L3）",
    stage: 'deep-dive',
    description: "单节深挖：核心论点 / 关键细节 / 与全局的关系 / 边界与存疑；可越界取证",
    prompt: `<!-- Token 预算：常驻 = L1 地图 + 全部 L2（每节 1500 字量级）+ 当前节原文全送；当前节页图 ±1 页与本节关键图表裁切图（至多 4 张）由调用方随消息附图（页图约 1902 token/页、裁切图约 1024 token/张）。工具循环最多 12 步、一轮至多 3 个工具调用块，工具结果只回窗口或指针。 -->

你是一位资深研究员，正在深挖论文《{title}》的「{sectionTitle}」（节 id：{sectionId}，章节类型：{sectionType}）。

## 任务

吃透这一节：读透下方已给出的当前节原文，必要时用工具越界取证（读别节的块、搜全文、看图表、看页图），然后输出四段式深挖结果。当前节原文已完整给出，是忠实性的构造保证——关于本节的事实以原文为准；其他节的信息只能来自 L1/L2 摘要或工具实际取回的内容，不得凭印象编造。

{sectionFocus}

## 上下文

阅读地图（L1，常驻）：
"""
{map}
"""

全部节薄摘要（L2）：
"""
{l2Summaries}
"""

当前节原文（块模型，完整，块号以 L 标注）：
"""
{sectionText}
"""

当前节页图：{sectionPages}（已随消息附图；邻页可用 get_page_image 调取）。
已附本节图表：{attachedAssets}

## 工具

需要越出当前节取证时，在输出中写工具调用块（\`\`\`tool 围栏，内容为一个 JSON 对象；一轮可写多个、按需一次发齐，至多 3 个）：

\`\`\`tool
{"name": "read_section", "args": {"sec_id": "节 id", "offset": 1, "limit": 40}}
\`\`\`

四件只读工具：

- \`read_section(sec_id, offset, limit)\`：按块窗口读取指定节原文（单窗约 8KB 字符），返回块文本与出处；截断时页脚会指出完整内容在第几页页图。
- \`search_paper(pattern)\`：全文检索，只返回 节+块+页 指针（可能标注所属小节），不返回原文；结果过多时会截断并标注。
- \`get_figure(fig_id)\`：取图 / 表的裁切图、图注与正文引用处；id 取自 L1/L2 或正文中出现的编号。
- \`get_page_image(page)\`：取指定页的页图。

纪律：一轮最多发三个工具调用块，按需要一次发齐，发出后停止输出、等待工具结果作为新上下文续上；地址（节 id、图表 id、页码）必须取自输入材料或先前工具结果，不得猜测；当前节不要再调 read_section；已附图表无需再调 get_figure。取证充分后，直接输出深挖结果正文——输出中不含工具调用块即视为完成。

## 出处纪律

EXTRACTED 纪律：结果中每条论断必须携带出处指针，没有出处的论断不要写。出处指针统一语法：\`(p5)\` 页、\`(fig_3)\` / \`(tbl_2)\` 图表、\`(L12-18)\` 本节块、\`(sec_2:L30-34)\` 跨节块。跨节论断的出处必须来自工具实际取回的内容。

## 输出格式

最终输出为 Markdown，四段标题固定：

## 核心论点
## 关键细节
## 与全局的关系
## 边界与存疑

「与全局的关系」结合 L1 地图与其他节的薄摘要，说明本节在整篇中的位置与作用；「边界与存疑」列出原文的前提、限制与未回答问题（含你从证据中读出的疑点），确实没有则明确写"无"。`,
  },
  {
    id: 'synthesize',
    name: "综合 · 复述稿",
    stage: 'synthesize',
    description: "由阅读地图、全部节薄摘要与已有深挖结果复述全篇：问题 → 方法 → 证据 → 边界",
    prompt: `<!-- Token 预算：输入 = L1 地图 + 全部 L2 + 已有深挖结果，典型 1–4 万 token；输出为一篇复述稿。 -->

你是一位严谨的论文精读助手，正在为论文《{title}》撰写复述稿：把全篇按「问题 → 方法 → 证据 → 边界」重新讲述一遍，使读者不读原文也能把握论文的问题、方法、关键证据与适用边界。

## 任务

只依据下方给出的材料（阅读地图 L1、全部节薄摘要 L2、已有深挖结果）写作，不回读原文。凡来自尚未深挖之节的内容，在该论断的出处指针后标注"（未经深挖核验）"。

## 工具

本阶段不调用任何工具：所需材料已全部给出。不要输出工具调用块（\` \`\`\`tool \` 围栏），直接产出复述稿。

## 出处纪律

EXTRACTED 纪律：每条论断必须携带出处指针，没有出处的论断不要写。出处指针统一语法：\`(p5)\` 页、\`(fig_3)\` / \`(tbl_2)\` 图表、\`(L12-18)\` 本节块、\`(sec_2:L30-34)\` 跨节块。图表引用只取自材料中出现的编号。

## 输出格式

Markdown，四段标题固定：

## 问题
## 方法
## 证据
## 边界

「问题」写清论文要解决什么、为什么重要；「方法」讲清怎么做、关键设计是什么；「证据」给出支撑结论的关键实验 / 论证与数字；「边界」写明前提、限制与未回答问题。

## 输入材料

阅读地图（L1）：
"""
{map}
"""

全部节薄摘要（L2）：
"""
{l2Summaries}
"""

已有深挖结果（未列出的节即未深挖）：
"""
{digResults}
"""`,
  },
];
/* __BUILTIN_PROTOCOL_PROMPTS_END__ */

/* __BUILTIN_SECTION_FOCUS_BEGIN__ */
export const BUILTIN_SECTION_FOCUS = {
    "abstract": {
      "label": "摘要",
      "focus": [
        "忠实对应原文，不增删信息",
        "专业术语采用「中文译名（English Term）」格式，首次出现时标注英文",
        "一句话概括这篇论文做了什么、达到了什么"
      ]
    },
    "introduction": {
      "label": "引言",
      "focus": [
        "领域背景与宏观脉络，理解本文所需的必要概念",
        "相关工作的主要思路、分类与各自局限",
        "本文具体要解决什么问题，已有方法为何解决不好",
        "逐条贡献声明，并点评是否实质、含金量如何"
      ]
    },
    "method": {
      "label": "方法",
      "focus": [
        "核心创新点是什么，与已有方法的关键区别在哪里",
        "分步骤 / 分模块拆解：输入是什么、经过哪些处理、输出是什么",
        "关键公式的含义与作用，说明符号含义",
        "作者给出的有效性论证、直觉或分析；作者未解释时明确指出，并将合理推测与作者陈述区分开",
        "易忽略但重要的设计细节：超参选择、初始化、训练技巧、工程取舍"
      ]
    },
    "experiments": {
      "label": "实验",
      "focus": [
        "评测设置：在哪些 benchmark / 数据集 / 任务上评测，对比了哪些基线",
        "主要结果的关键数字与结论：相对基线提升多少，是否 SOTA",
        "可复现性细节：模型规模、数据、优化器、学习率、算力开销、推理方式",
        "消融实验：消融了哪些组件、各自贡献多少、哪个最关键；缺少消融须明确指出",
        "结果洞察：作者对结果的分析，以及数字背后作者没有明说的信息"
      ]
    },
    "part": {
      "label": "通用正文",
      "focus": [
        "本节在整篇论文中的定位：承接了什么、推进了什么",
        "本节提出的关键概念、假设、问题、论证或设计，保持原文逻辑顺序",
        "重要公式、模块、算法步骤或理论结论的解释",
        "这些内容为什么重要、依赖哪些前提，以及原文呈现的限制或未回答问题",
        "区分作者明确陈述与读者自己的解释；不因位于正文中间就默认它是方法章节"
      ]
    }
  };
/* __BUILTIN_SECTION_FOCUS_END__ */

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

// 浏览器阅读器仍用此模板做截断注入；Tauri 问答已改走 qa.js 三形态装配（#67）。
export const CHAT_SYSTEM_TEMPLATE = `你是「论文精读助手」，正在帮助用户深入理解论文《{title}》。以下是论文的主要内容（可能被截断）：

{content}

请基于论文内容用中文回答用户问题；引用原文时给出英文原句；如果论文中没有相关内容，请如实说明，不要编造。回答使用 Markdown 格式。`;

// ---------- 注入缝 ----------
// listSkillFiles() -> [{file, text}]（接 skills.list@1）；
// loadOverrides() -> 覆盖对象、saveOverrides(obj)（接 settings 命令）。
// 缺省 listSkillFiles 直接抛错，loadSkills 走内置兜底。
let skillSource = {
  listSkillFiles: async () => { throw new Error('技能文件来源尚未注入'); },
  loadOverrides: async () => ({}),
  saveOverrides: async () => {},
};

let overridesCache = emptyOverrides();

/** 启动时注入技能来源并预热覆盖缓存；v1 覆盖在此迁移为 v2 并写回（幂等）。 */
export async function initSkills(impl = {}) {
  skillSource = { ...skillSource, ...impl };
  let stored = {};
  try {
    stored = await skillSource.loadOverrides() || {};
  } catch (err) {
    console.warn('技能覆盖读取失败，视为无覆盖：', err);
    stored = {};
  }
  const migrated = migrateSkillsOverrides(stored);
  overridesCache = migrated;
  if (JSON.stringify(stored) !== JSON.stringify(migrated)) {
    try {
      await skillSource.saveOverrides(migrated);
    } catch (err) {
      console.warn('技能覆盖迁移写回失败：', err);
    }
  }
}

// ---------- skills/*.md 与关注点数据加载 ----------
// 文件路由：legacy/ 前缀的 .md → 旧五技能；section-focus.json → 章节关注点数据；其余 .md → 协议提示词。
// 旧技能展示顺序：核心章节在前，新增 section 按字典序排在后面。
const SECTION_ORDER = ['abstract', 'introduction', 'part', 'method', 'experiments'];

let fileProtocolPrompts = null; // null 表示尚未加载或加载失败，此时使用内置兜底。
let fileSectionFocus = null;
let fileLegacySkills = null;

/** 从单个协议提示词 .md 文件构造对象；id 取 frontmatter 的 stage（覆盖键）。 */
export function protocolPromptFromFile(filename, text) {
  const parsed = parseSkillFile(filename, text);
  return { id: parsed.stage, ...parsed };
}

/** 把文件清单转换成协议提示词列表：跳过缺 stage 的文件、同 stage 去重（先到先得）、按固定顺序。 */
export function protocolPromptsFrom(files) {
  const byId = new Map();
  for (const { file, text } of files) {
    const prompt = protocolPromptFromFile(file, text);
    if (!prompt.id) {
      console.warn(`协议提示词文件 ${file} 缺少 frontmatter stage，已忽略`);
      continue;
    }
    if (byId.has(prompt.id)) {
      console.warn(`协议提示词文件 ${file} 的 stage「${prompt.id}」与已加载提示词重复，已忽略`);
      continue;
    }
    byId.set(prompt.id, prompt);
  }
  return [...byId.values()].sort((a, b) => {
    const ia = PROTOCOL_STAGES.indexOf(a.id);
    const ib = PROTOCOL_STAGES.indexOf(b.id);
    return (ia === -1 ? PROTOCOL_STAGES.length : ia) - (ib === -1 ? PROTOCOL_STAGES.length : ib)
      || a.id.localeCompare(b.id);
  });
}

/** 解析章节关注点数据文件（section-focus.json）：畸形条目剔除，整体不可解析返回 null。 */
export function parseSectionFocusText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const types = parsed?.types;
  if (!types || typeof types !== 'object' || Array.isArray(types)) return null;
  const out = {};
  for (const [key, value] of Object.entries(types)) {
    const focus = Array.isArray(value?.focus)
      ? value.focus.filter(item => typeof item === 'string' && item.trim())
      : [];
    if (!focus.length) continue;
    const label = typeof value?.label === 'string' && value.label.trim() ? value.label : key;
    out[key] = { label, focus };
  }
  return Object.keys(out).length ? out : null;
}

/** 从单个旧技能 .md 文件构造技能对象；id 取 frontmatter 的 section（覆盖键）。 */
export function skillFromFile(filename, text) {
  const parsed = parseSkillFile(filename, text);
  return { id: parsed.section, ...parsed };
}

/** 把文件清单转换成旧技能列表：跳过缺 section 的文件、同 section 去重（先到先得）、按固定优先级排序。 */
export function fileSkillsFrom(files) {
  const byId = new Map();
  for (const { file, text } of files) {
    const skill = skillFromFile(file, text);
    if (!skill.id) {
      console.warn(`技能文件 ${file} 缺少 frontmatter section，已忽略`);
      continue;
    }
    if (byId.has(skill.id)) {
      console.warn(`技能文件 ${file} 的 section「${skill.id}」与已加载技能重复，已忽略`);
      continue;
    }
    byId.set(skill.id, skill);
  }
  return [...byId.values()].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a.id);
    const ib = SECTION_ORDER.indexOf(b.id);
    return (ia === -1 ? SECTION_ORDER.length : ia) - (ib === -1 ? SECTION_ORDER.length : ib)
      || a.id.localeCompare(b.id);
  });
}

/**
 * 启动时经注入缝拉取技能文件并按文件名路由到三组来源；任何失败都退回内置定义，不阻塞应用。
 * 返回协议提示词实际生效的来源：'file' | 'builtin'（关注点数据缺失时单独回退内置并告警，不影响提示词来源判定）。
 */
export async function loadSkills() {
  let files;
  try {
    files = await skillSource.listSkillFiles();
  } catch (err) {
    console.warn('技能文件加载失败，使用内置定义兜底：', err);
    fileProtocolPrompts = null;
    fileSectionFocus = null;
    fileLegacySkills = null;
    return 'builtin';
  }
  const protocolFiles = [];
  const legacyFiles = [];
  let focusText = null;
  for (const entry of files) {
    const file = entry?.file ?? '';
    if (file === 'section-focus.json') focusText = entry.text;
    else if (file.startsWith('legacy/')) legacyFiles.push(entry);
    else if (file.toLowerCase().endsWith('.md')) protocolFiles.push(entry);
  }
  const parsedProtocol = protocolPromptsFrom(protocolFiles);
  fileProtocolPrompts = parsedProtocol.length ? parsedProtocol : null;
  fileSectionFocus = focusText != null ? parseSectionFocusText(focusText) : null;
  const parsedLegacy = fileSkillsFrom(legacyFiles);
  fileLegacySkills = parsedLegacy.length ? parsedLegacy : null;
  if (!fileSectionFocus) console.warn('关注点数据加载失败，使用内置兜底：', focusText == null ? '缺文件' : '解析失败');
  return fileProtocolPrompts ? 'file' : 'builtin';
}

// ---------- 覆盖对象 v2 的读写与迁移 ----------
function emptyOverrides() {
  return { version: OVERRIDES_VERSION, prompts: {}, focus: {}, legacy: {} };
}

function cloneOverrides(source) {
  return {
    version: OVERRIDES_VERSION,
    prompts: { ...source.prompts },
    focus: Object.fromEntries(Object.entries(source.focus || {}).map(([k, v]) => [k, [...v]])),
    legacy: { ...source.legacy },
  };
}

function normalizeStringMap(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (typeof key === 'string' && key && typeof value === 'string') out[key] = value;
  }
  return out;
}

function normalizeFocusMap(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (typeof key !== 'string' || !key) continue;
    const list = Array.isArray(value)
      ? value.filter(item => typeof item === 'string' && item.trim())
      : (typeof value === 'string' && value.trim() ? [value] : []);
    if (list.length) out[key] = list;
  }
  return out;
}

/**
 * 覆盖对象迁移（纯函数，#55 决策 24）：
 * - v1 平铺 {章节id: 提示词}：已知章节类型 → focus 覆盖项（原文整段为一个关注点）+ legacy 只读留档；
 *   未知键仅 legacy 留档，不臆造关注点。
 * - v2：规范化通过（prompts/legacy 只留字符串，focus 只留非空字符串数组）。
 * - 其他（null / 数组 / 非对象）：空 v2。
 * 幂等：migrate(migrate(x)) 与 migrate(x) 相等。
 */
export function migrateSkillsOverrides(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return emptyOverrides();
  if (stored.version === OVERRIDES_VERSION) {
    return {
      version: OVERRIDES_VERSION,
      prompts: normalizeStringMap(stored.prompts),
      focus: normalizeFocusMap(stored.focus),
      legacy: normalizeStringMap(stored.legacy),
    };
  }
  const next = emptyOverrides();
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    next.legacy[key] = value;
    if (SECTION_TYPES.includes(key)) next.focus[key] = [value];
  }
  return next;
}

/** 当前生效的覆盖对象（v2）只读快照；整库导出经此携带。 */
export function loadCustomSkills() {
  return cloneOverrides(overridesCache);
}

async function persistOverrides(next) {
  overridesCache = next;
  await skillSource.saveOverrides(overridesCache);
}

/** 旧技能弹窗的保存缝：原文进 legacy 留档（旧精读路径沿用），已知类型同步为关注点覆盖项。 */
export async function saveCustomSkill(id, prompt) {
  const next = cloneOverrides(overridesCache);
  next.legacy[id] = prompt;
  if (SECTION_TYPES.includes(id)) next.focus[id] = [prompt];
  await persistOverrides(next);
}

export async function resetSkill(id) {
  const next = cloneOverrides(overridesCache);
  delete next.legacy[id];
  delete next.focus[id];
  await persistOverrides(next);
}

/** 协议提示词覆盖：stage 须为四段之一，未知 stage 忽略（与 settings 缝的未知字段纪律一致）。 */
export async function savePromptOverride(stage, prompt) {
  if (!PROTOCOL_STAGES.includes(stage)) {
    console.warn(`未知协议阶段「${stage}」，提示词覆盖已忽略`);
    return;
  }
  const next = cloneOverrides(overridesCache);
  next.prompts[stage] = prompt;
  await persistOverrides(next);
}

export async function resetPromptOverride(stage) {
  const next = cloneOverrides(overridesCache);
  delete next.prompts[stage];
  await persistOverrides(next);
}

/** 章节关注点覆盖：整组替换该类型的关注点清单。 */
export async function saveFocusOverride(type, focus) {
  if (!SECTION_TYPES.includes(type)) {
    console.warn(`未知章节类型「${type}」，关注点覆盖已忽略`);
    return;
  }
  const list = Array.isArray(focus) ? focus.filter(item => typeof item === 'string' && item.trim()) : [];
  const next = cloneOverrides(overridesCache);
  if (list.length) next.focus[type] = list;
  else delete next.focus[type];
  await persistOverrides(next);
}

export async function resetFocusOverride(type) {
  const next = cloneOverrides(overridesCache);
  delete next.focus[type];
  await persistOverrides(next);
}

/**
 * 批量导入覆盖（整库导入用）：先按迁移规则把导入值（v1 或 v2）归一为 v2，
 * 再按 prompts / focus / legacy 三个命名空间逐键合并，同键以导入值为准。返回 { added, overwritten }。
 */
export async function importCustomSkills(incoming) {
  const migrated = migrateSkillsOverrides(incoming);
  const current = overridesCache;
  const next = cloneOverrides(current);
  let added = 0;
  let overwritten = 0;
  for (const ns of ['prompts', 'focus', 'legacy']) {
    for (const [key, value] of Object.entries(migrated[ns])) {
      if (key in (current[ns] || {})) overwritten++;
      else added++;
      next[ns][key] = value;
    }
  }
  await persistOverrides(next);
  return { added, overwritten };
}

// ---------- 协议层读取（生效值 = 覆盖 ?? 文件 ?? 内置兜底，逐段/逐类型回退） ----------
function sectionFocusTable() {
  return { ...BUILTIN_SECTION_FOCUS, ...(fileSectionFocus || {}) };
}

/** 指定协议阶段的生效提示词文本；未知 stage 返回空串。 */
export function getProtocolPrompt(stage) {
  const custom = overridesCache.prompts?.[stage];
  if (typeof custom === 'string') return custom;
  return (fileProtocolPrompts ?? []).find(p => p.id === stage)?.prompt
    ?? BUILTIN_PROTOCOL_PROMPTS.find(p => p.id === stage)?.prompt
    ?? '';
}

/** 四段协议提示词的生效列表（固定顺序，含是否已自定义标记）。 */
export function effectiveProtocolPrompts() {
  return PROTOCOL_STAGES.map(stage => {
    const base = (fileProtocolPrompts ?? []).find(p => p.id === stage)
      ?? BUILTIN_PROTOCOL_PROMPTS.find(p => p.id === stage);
    return {
      id: stage,
      stage,
      name: base?.name ?? stage,
      description: base?.description ?? '',
      prompt: getProtocolPrompt(stage),
      customized: stage in (overridesCache.prompts || {}),
    };
  });
}

/** 指定章节类型的生效关注点清单（覆盖整组替换默认）；未知类型回退 part。 */
export function getSectionFocus(type) {
  const key = SECTION_TYPES.includes(type) ? type : 'part';
  const custom = overridesCache.focus?.[key];
  if (Array.isArray(custom) && custom.length) return [...custom];
  return [...(sectionFocusTable()[key]?.focus ?? [])];
}

/** 全部章节类型的生效关注点（固定受控词表顺序，含是否已自定义标记）。 */
export function effectiveSectionFocus() {
  return SECTION_TYPES.map(type => ({
    type,
    label: sectionFocusTable()[type]?.label ?? type,
    focus: getSectionFocus(type),
    customized: type in (overridesCache.focus || {}),
  }));
}

// ---------- 叠加规则与占位符装配 ----------
// 叠加规则（#55 决策 23）：协议提示词打底 + 该节类型关注点追加。map-l2 按节分片，
// 每片仍叠加整表（打标需要）；deep-dive 面向单节，叠加该节类型清单；map-l1 /
// synthesize 是论文级综合，不叠加关注点。
function focusBlockForStage(stage, sectionType) {
  if (stage === 'map-l2') {
    return SECTION_TYPES.map(type => {
      const entry = sectionFocusTable()[type];
      const header = `${type}（${entry?.label ?? type}）：`;
      return [header, ...getSectionFocus(type).map(item => `- ${item}`)].join('\n');
    }).join('\n');
  }
  if (stage === 'deep-dive') {
    const key = SECTION_TYPES.includes(sectionType) ? sectionType : 'part';
    const entry = sectionFocusTable()[key];
    return [
      `本节类型关注点（${entry?.label ?? key}）：`,
      ...getSectionFocus(key).map(item => `- ${item}`),
    ].join('\n');
  }
  return '';
}

function fillPlaceholders(text, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    // 注入值可能含 $&、$' 等替换模式，字符串替换值会解释它们，须用函数按字面注入。
    out = out.replaceAll(`{${key}}`, () => String(value));
  }
  return out;
}

/**
 * 装配协议提示词：打底文本（覆盖 ?? 文件 ?? 内置）+ 占位符注入 + 关注点叠加。
 * {sectionTypes} 由受控词表注入，{sectionFocus} 由叠加规则注入；其余占位符取自 values。
 * 覆盖版提示词若不含 {sectionFocus} 占位符，关注点块追加到末尾（叠加规则不允许被覆盖丢掉）。
 */
export function composePrompt(stage, { values = {}, sectionType = '' } = {}) {
  const base = getProtocolPrompt(stage);
  if (!base) return '';
  const focus = focusBlockForStage(stage, sectionType);
  const merged = {
    sectionTypes: `[${SECTION_TYPES.map(type => `"${type}"`).join(', ')}]`,
    ...values,
    sectionFocus: focus,
  };
  let text = fillPlaceholders(base, merged);
  if (focus && !base.includes('{sectionFocus}')) {
    text = `${text}\n\n## 章节关注点\n\n${focus}\n`;
  }
  return text;
}

// ---------- 旧精读层（保留至旧生成路径随 #55 决策 26 退役） ----------
/** 获取当前生效的旧技能列表（含是否已自定义标记）；覆盖取自 v2 的 legacy 留档。 */
export function effectiveSkills() {
  const legacy = overridesCache.legacy || {};
  return (fileLegacySkills ?? BUILTIN_SKILLS).map(s => ({
    ...s,
    prompt: legacy[s.id] ?? s.prompt,
    customized: s.id in legacy,
  }));
}

export function getSkill(id) {
  return effectiveSkills().find(s => s.id === id);
}

export function buildPrompt(skill, title, content, section = '') {
  return fillPlaceholders(skill.prompt, { title, section, content });
}

/** 解析 .md 技能文件：支持 YAML frontmatter（name/description/section/stage），正文为提示词 */
export function parseSkillFile(filename, text) {
  // Windows 保存的 .md 常为 CRLF 行尾，先归一化为 LF，避免 \r 混入提示词。
  text = text.replace(/\r\n?/g, '\n');
  let name = filename.replace(/\.(md|txt)$/i, '');
  let description = '';
  let section = '';
  let stage = '';
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(name|description|section|stage)\s*:\s*(.+)$/i);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1].toLowerCase() === 'name') name = v;
      if (m[1].toLowerCase() === 'description') description = v;
      if (m[1].toLowerCase() === 'section') section = v.toLowerCase();
      if (m[1].toLowerCase() === 'stage') stage = v.toLowerCase();
    }
    body = fm[2].trim();
  }
  return { name, description, section, stage, prompt: body };
}
