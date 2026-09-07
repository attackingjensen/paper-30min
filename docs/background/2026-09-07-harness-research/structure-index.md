# 调研：层级结构索引工具（codegraph / graphify 类）

- 来源 Issue：[#37 调研：codegraph / graphify 类层级结构索引工具](https://github.com/attackingjensen/paper-30min/issues/37)
- 日期：2026-09-07
- 目的：为 L1 阅读地图与 L2 节薄摘要的结构设计提供候选项目对比与可借鉴机制清单（供 t5「论文作为代码库」设计票读取）。

## 结论摘要

1. **线索甄别成立**：在"代码/文本结构索引"语境下，codegraph 指 `colbymchenry/codegraph`（Rust 内核 + tree-sitter 的本地代码知识图谱，以 MCP 服务形态接入 Claude Code / Codex 等编码 agent），graphify 指 `Graphify-Labs/graphify`（`/graphify` 技能：tree-sitter 确定性抽取代码 + LLM 子代理抽取文档/PDF，合成可查询知识图谱）。两者均为"编码 agent 前置索引"形态，与票据描述的"仓库持有者在代码开发中使用过"吻合。同名干扰项的甄别过程见下节。
2. **对论文场景最可直接迁移的三个机制**：
   - **确定性骨架 + LLM 语义的双通道抽取**（graphify 三趟管线 + Docling 文档树）：论文的节/图/表/参考文献条目走确定性解析，概念、贡献、证据链走 LLM 抽取，边上带置信度标签，L1 地图只呈现 EXTRACTED 级事实指针。
   - **预算化的层级摘要树**（RAPTOR + GraphRAG + aider repo map）：L1/L2/L3 对应"根摘要 / 节级摘要 / 原文"，RAPTOR 实测上层摘要节点占检索量 18.5%–57%，验证分层摘要的导航价值；aider 证明"签名级表示 + token 预算裁剪 + 当前上下文加权排序"可在极小预算内支撑导航。
   - **稳定身份 + 出处回链**（graphify 确定性节点 ID、SCIP 符号语法、Docling provenance、GraphRAG TextUnit 出处）：每节/每图/每条引用必须有稳定 ID 与页码/bbox 回链，与 #35 已确认的"每段有身份、双通道可寻址"决策直接咬合。
3. **不适配点**：嵌入聚类造层级（RAPTOR/GraphRAG 的核心）对单篇论文过重——论文自带节层级，应以文档自身结构为主、聚类仅用于跨论文；SCIP 是编译器级代码索引，仅"定义处 vs 使用处"的角色区分可借给术语表设计。

## 同名甄别过程

票据提示 codegraph 与 graphify 可能有同名项目，需以"代码/文本结构索引"语境甄别。用 GitHub 仓库搜索（`in:name`，按 star 排序）逐一核对：

**codegraph 同名项**：

| 仓库 | 是什么 | 判定 |
|---|---|---|
| `colbymchenry/codegraph` | 预索引代码知识图谱，Rust 内核 + tree-sitter，MCP 接入 Claude Code/Codex/Cursor/Gemini 等，69.9k star，MIT | **命中**：代码结构索引，agent 开发工具形态 |
| `CodeGraphContext/CodeGraphContext` | MCP 服务器，把代码索引进图数据库（FalkorDB）供 AI 助手查询，4.2k star | 同类但非线索所指 |
| `Jakedismo/codegraph-rust` | Rust 实现的 code GraphRAG，SurrealDB 后端，875 star | 同类但非线索所指 |
| `xnuinside/codegraph` | Python 静态依赖图 + HTML 可视化，506 star | 同名不同物（无 agent 导航） |
| `TeodorVecerdi/CodeGraph` | 游戏可视化编程工具 | 排除 |

**graphify 同名项**：

| 仓库 | 是什么 | 判定 |
|---|---|---|
| `Graphify-Labs/graphify` | `/graphify` 技能：把代码库连同 docs/SQL/配置/PDF 转成可查询知识图谱，本地确定性 AST 解析、无向量库，115.6k star，Apache-2.0 | **命中**：文本+代码结构索引，技能形态，且显式支持 PDF/论文 |
| `kbastani/graphify` | Neo4j 扩展，用图模式识别做文本分类（2014 年代项目） | 语义相近但非编码工具链、已停更，排除 |
| `raufer/graphify` | 非结构化文本转图的小库 | 排除 |
| `warioddly/graphify` | 基于 ECharts 的图表库 | 同名不同物，排除 |
| `elbruno/graphify-dotnet` | graphify 的 .NET 移植 | 衍生项 |

甄别依据：票据称"仓库持有者在代码开发中使用过"——两个命中项均为 Claude Code / Codex 技能形态，且是当前同名项目中 star 最高、语义最贴合"代码/文本结构索引"的项目；`kbastani/graphify` 虽做文本层级模式识别，但属上一代 Neo4j 插件，形态不符。

## 项目对比表

| 维度 | **CodeGraph**（colbymchenry/codegraph） | **graphify**（Graphify-Labs/graphify） | **aider repo map** | **Microsoft GraphRAG** | **RAPTOR**（论文+官方实现） | **Docling**（IBM） | **SCIP**（Sourcegraph） |
|---|---|---|---|---|---|---|---|
| 输入 | 代码（20+ 语言原生，共 30+） | 代码 + docs/PDF/图片/音视频 | 代码 | 非结构化文本文档集 | 长文本 | PDF/DOCX/PPTX/HTML 等 | 代码（各语言索引器产出） |
| 层级/结构表示 | 符号节点（函数/类/方法）+ 边（calls/imports/extends/implements），存 SQLite + FTS5 | 概念节点 + 关系边 + 超边（≥3 节点成组），NetworkX node-link JSON；Leiden 社区作层级 | 文件节点 + 依赖边的图；输出为"文件→关键符号签名行"列表 | Document→TextUnit→Entity/Relationship→Community（Leiden 层级）→Community Report | 树：叶=100 token 块，上层=LLM 摘要节点，递归至无法再聚类 | DoclingDocument：body/furniture 双树 + groups，JSON 指针连父子，阅读顺序内嵌 | Index→Document→Occurrence/SymbolInformation，符号有全局语法（scheme/package/descriptor） |
| 抽取方式 | tree-sitter 确定性抽取 + 跨文件解析（调用→定义、导入→文件、继承） | 三趟：① tree-sitter 确定性（代码，零 LLM）② whisper 转写（媒体）③ LLM 子代理（docs/PDF/图，输出 JSON 片段再合并） | tree-sitter `tags.scm` 查询抽定义/引用 | LLM 逐 TextUnit 抽实体/关系/claim，同名实体合并、描述再摘要 | SBERT 嵌入 + UMAP + GMM 软聚类（BIC 定簇数），逐簇 LLM 摘要 | PDF 后端（布局/表格模型）+ 统一文档装配；区分正文与页眉页脚（furniture） | 编译器/语言服务器级精确索引（LSIF 后继） |
| 切块与索引 | 以文件/符号为粒度；FTS5 全文索引；文件监听 + 2s 防抖增量同步 | 代码按 AST 符号；文档按批次给子代理；SHA256 内容指纹缓存，增量更新 | 以符号标签为粒度；networkx PageRank 排序，personalization 以"聊天中文件 + 用户提及标识符"为种子；`--map-tokens` 预算裁剪（默认 1k token） | TextUnit 默认 1200 token（可配、可贴边界）；Parquet 表 + 向量库 | 100 token 块、句不断句；摘要父节点均值 131 token、平均 6.7 子节点、压缩率约 72% | 以文档项（段落/标题/表/图）为粒度，自带 bbox 与 provenance | 以符号出现（Occurrence，含 range 与 definition/reference 角色）为粒度 |
| 供模型导航/检索 | 单一 MCP 工具 `codegraph_explore`：一次调用返回逐字源码 + 调用路径 + 爆炸半径；窄工具默认隐藏（实测单强工具更少误选、省上下文） | `query`（问题→子图）/`path`（两点最短路径）/`explain`（单概念）；MCP 服务（query_graph/get_node/get_neighbors/shortest_path）；GRAPH_REPORT.md 给"god 节点+意外连接+建议问题" | repo map 随每次请求注入；模型据此点名要文件，aider 再加入上下文 | Global（社区报告）/Local（实体邻域）/DRIFT 三种查询 | collapsed tree（全层压平相似度检索）优于 tree traversal；非叶节点占检索 18.5%–57% | 本身不供检索，输出供下游分块/RAG | IDE 跳转定义/找引用；被 agent 工具链消费 |
| 置信度/出处 | 逐字源码返回，图边来自解析与解析后解析（resolution） | 每条边标 EXTRACTED/INFERRED/AMBIGUOUS，INFERRED 用离散置信档（0.95/0.85/0.75/0.65/0.55）；节点 ID 确定性（`{路径干}_{实体}`） | 仅收录真实定义行，出处即文件 | 每个知识项回链 TextUnit 出处 | 摘要节点保留子树出处；人工抽查约 4% 轻微幻觉、不向父节点传播 | 每项带页码/bbox provenance | 编译器级精确，range 可定位 |
| 实测要点 | 7 仓库基准：工具调用 −88%、token −62%；但会话残留检索上下文 +80%（精度换吞吐，长会话需预算） | 52 文件混合语料（含 5 篇论文）：每次查询 token −71.5×；LOCOMO recall@10 0.497（对照 mem0 0.048） | 默认 1k token 预算即可支撑多数任务 | 全局问题显著优于朴素 RAG（论文结论） | QuALITY 最佳成绩 +20% 绝对准确率（配 GPT-4） | 文档结构化事实标准之一 | — |
| 许可 | MIT | Apache-2.0 | Apache-2.0 | MIT | MIT（代码）/ arXiv（论文） | MIT | Apache-2.0 |

## 可借鉴机制清单

按对 L1 阅读地图 / L2 节薄摘要的参考价值排序：

1. **双通道抽取与置信度标签（graphify）**：确定性通道（tree-sitter/解析器）抽骨架，LLM 通道抽语义，逐边标 `EXTRACTED/INFERRED/AMBIGUOUS` 且 INFERRED 用离散置信档（不让模型自由给连续分——官方理由是模型在离散 rubric 上表现更好）。L1 地图只呈现 EXTRACTED 级指针，深挖时再允许 INFERRED 参与。
2. **文档原生层级优先于聚类层级（Docling + 对照 RAPTOR/GraphRAG）**：Docling 把文档表示为 body/furniture 双树 + groups，阅读顺序内嵌于树，页眉页脚单列——这正是 #35 已确认"双通道结构化文档"的工业先例。论文自带节层级，无需 RAPTOR 式嵌入聚类重造层级；聚类只留给跨论文/跨主题场景。
3. **层级摘要树的形态参数（RAPTOR）**：父节点=子节点集合的摘要、平均扇出 6.7、摘要压缩率约 72%、collapsed tree 检索优于逐层遍历、上层摘要节点占检索 18.5%–57%。直接校准 L2 节薄摘要的密度预期与"L1+L2 全带、L3 按需"的上下文配方。
4. **自底向上的报告生成顺序（GraphRAG）**：先抽底层事实（实体/关系），再逐层汇总成报告。对应：先抽节级事实（L2），再合成全局地图（L1），而不是先写总述再拆节。
5. **预算化裁剪 + 签名级表示 + 当前上下文加权（aider repo map）**：token 预算内只放"文件路径 + 关键符号签名行"，省略号明示裁剪；PageRank 的 personalization 用"当前聊天文件 + 用户提及标识符"作种子。对应 L1"一屏为限"与"阅读位置/已读标记加权"的排序策略。
6. **单一强导航工具 vs 三件套（codegraph vs graphify）**：codegraph 实测"一个强 explore 工具比一排窄工具更少误选、更省上下文"，把 callers/callees/impact 默认隐藏；graphify 则保留 query/path/explain 三件套。L3 深挖工具面设计需在此两极间取舍——倾向 codegraph 结论，但论文场景"路径查询"（概念在哪定义、被哪些节使用）对应 graphify 的 `path`，值得保留。
7. **确定性节点 ID（graphify / SCIP）**：graphify 要求 ID 从标签确定性派生（`{路径干}_{实体}`，禁加 chunk 序号，防增量重建产生孤儿节点）；SCIP 定义全局符号语法。论文侧的节/图/表/引用条目 ID 应可复算（如 `sec_{编号}_{标题slug}`、`fig_{编号}`），支撑精读产物跨会话稳定引用。
8. **出处回链内建于数据模型（GraphRAG TextUnit / Docling provenance / SCIP Occurrence）**：每个知识项带源文本区间或页码/bbox。L2 摘要每条结论应带页码 + 节 + 可选 bbox，与页图通道对齐。
9. **增量与缓存（graphify SHA256 / codegraph 文件监听）**：按内容指纹跳过未变文件。论文 PDF 不变，收益主要在跨论文语料与反复精读；优先级低。
10. **文件级薄摘要的字段设计（graphify node-summaries RFC）**：bounded 一句（200–300 字符）、`generated_by`（deterministic/LLM）、`summary_version`、由 docstring/导出符号/主导关系/社区标签等现有信号确定性生成——几乎是 L2 节薄摘要的镜像问题，字段设计可直接借用。

## 对学术 PDF 论文场景的可迁移性评估

**整体判断**：这些工具的共识是"预建结构索引 → 模型查索引而非翻原文 → 原文按指针回取"，与 #35 已确认的 L1→L2→L3 协议同构。差异在于论文的结构是**文档层级**而非调用图，且精度要求高于召回（复述级阅读）。

- **graphify 是最贴近的参照系**：它已把 `paper` 作为一等 `file_type` 处理（抽取规范要求对论文抽概念、实体、引用边，并允许"一节论文内形成同一连贯思想的概念组"建超边），且支持 `/graphify add <arxiv URL>`。其三趟管线、置信度标签、确定性 ID、文件级薄摘要 RFC 四项机制可直接搬到论文结构索引。需改造处：它的 LLM 子代理按批次读文件、不保证节边界对齐；论文场景应以节为原子单位抽取，保证 L2 全覆盖。
- **codegraph 的可迁移点在交互形态而非数据模型**：单工具 explore、"逐字源码 + 路径 + 爆炸半径"的一次调用返回结构，可映射为 L3 深挖的"节原文 + 概念使用位置 + 相邻节"返回契约；其"残留上下文 +80%"的诚实基准提醒我们 L3 深挖返回要瘦身。
- **aider repo map 的可迁移点在预算观**：地图不是越全越好，是在预算内按当前上下文加权裁剪；L1 一屏为限 + 阅读位置加权即此思想的产品化。
- **GraphRAG / RAPTOR 的可迁移点在分层摘要的生成与验证方法**：自底向上生成、上层摘要确被检索使用（18.5%–57%）；但两者的层级靠嵌入聚类，单篇论文应用原生节层级替代。若未来做跨论文语料（一个课题多篇论文的地图），两者的社区检测即成为首选机制。
- **Docling 是论文解析层的直接候选**：body/furniture 双树（页眉页脚剔除）、阅读顺序、bbox provenance 正是票据 t5 关注的"解析止血"能力的现成实现，可作为 PDF 可分析形态的解析底座候选（是否采用属 t5 决策范围）。
- **SCIP 仅借概念**：术语的"定义处 vs 引用处"角色区分，可用于 L1 术语表（每个术语指向其定义节）与 L3"该术语还在哪些节出现"。

**风险与注意**：① codegraph/graphify 均为高热度新项目（2026 年创建），API 与产物格式变动快，借鉴机制而非依赖其产物格式；② 两者的基准数字为厂商自测，只取方向性结论；③ RAPTOR 摘要存在约 4% 轻微幻觉（虽不向上传播），L2 全覆盖摘要需配出处回链以便核验。

## 来源链接

**一手资料（官方仓库 / 官方文档 / 论文）**：

- CodeGraph 仓库与 README（含 How It Works、MCP Tools、基准）：https://github.com/colbymchenry/codegraph
- graphify 仓库与 README：https://github.com/Graphify-Labs/graphify
- graphify 管线文档 `docs/how-it-works.md`（三趟、Leiden、置信度、缓存、图格式）：https://github.com/Graphify-Labs/graphify/blob/v8/docs/how-it-works.md
- graphify 抽取子代理提示词 `references/extraction-spec.md`（paper 抽取规则、置信档、ID 规则、超边）：https://github.com/Graphify-Labs/graphify/blob/v8/graphify/skills/claude/references/extraction-spec.md
- graphify 文件级节点摘要 RFC：https://github.com/Graphify-Labs/graphify/blob/v8/docs/node-summaries-rfc.md
- aider repo map 文档：https://aider.chat/docs/repomap.html ；构建细节博客：https://aider.chat/2023/10/22/repomap.html ；PageRank personalization 实现 `aider/repomap.py`：https://github.com/Aider-AI/aider/blob/main/aider/repomap.py
- GraphRAG 索引数据流（TextUnit/抽取/Leiden/社区报告）：https://github.com/microsoft/graphrag/blob/main/docs/index/default_dataflow.md ；索引总览：https://microsoft.github.io/graphrag/index/overview/
- RAPTOR 论文（arXiv:2401.18059，切块/GMM 聚类/递归摘要/两种检索策略）：https://arxiv.org/abs/2401.18059 ；官方实现：https://github.com/parthsarthi03/raptor
- Docling 仓库：https://github.com/docling-project/docling ；DoclingDocument 概念文档：https://github.com/docling-project/docling/blob/main/docs/concepts/docling_document.md
- SCIP 仓库与协议定义 `scip.proto`：https://github.com/sourcegraph/scip

**同名甄别检索**：GitHub 仓库搜索 `codegraph in:name` / `graphify in:name`（按 star 排序，2026-09-07 执行）。
