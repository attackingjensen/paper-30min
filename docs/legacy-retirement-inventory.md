# 旧核退役分类清单

> 日期：2026-11-15
> Beads：`paper-30min-amw.1`
> 分支：`feat/phase0-legacy-retirement`
> 代码基线：`f3164fe`（盘点期间源码与测试未变）
> 性质：只读盘点产物，供审阅；未删除或修改任何源码、测试与 fixtures。本清单本身不是删除授权。

## 0. 只读范围与规格状态

### 0.1 本次盘点范围

- 必选范围：`app/src/` 下全部实际源码（TypeScript、TSX、CTS、`.d.ts`、CSS）与 `app/tests/` 下全部测试、fixture 与测试辅助文件。
- 扩展范围：`app/` 内会被构建或测试使用的脚本、配置、入口与产品提示词（`app/scripts/`、`app/playwright.config.ts`、`app/vite.config.ts`、`app/tsconfig*.json`、`app/index.html`、`app/skills/`）。
- 不纳入：`legacy/v1/app/`（按任务要求只读范围外）、`app/node_modules/`、`app/dist/`、`app/test-results/`、`app/playwright-report/`、`app/tmp/`、根目录构建/测试日志、`app/package-lock.json`。
- `app/package.json` 不作为逐文件分类对象：它是依赖与脚本清单，不承载旧核职责；若后续增删依赖，应在对应模块 PR 的依赖审查中单独记录。

### 0.2 规格状态与效力边界

- 已批准规格：`docs/spec/capability-map.md`、`SPEC-project-core.md`、`SPEC-document-core.md`、`SPEC-arxiv-import.md`、`SPEC-pdf-import.md`、`SPEC-reader.md`、`SPEC-translation.md`、`SPEC-annotations-results.md`、`SPEC-workspace.md`、`SPEC-agent-integration.md`、`SPEC-pdf-comparison.md`。
- **`docs/spec/SPEC-legacy-projects.md` 页头仍为“状态：待批准”**（`SPEC-legacy-projects.md:3`）。
- 本清单把 `SPEC-legacy-projects.md` **仅作为旧格式边界参考**，不把它当作已批准的实施依据。**本清单不是删除授权**：任何文件是否可删，仍须由对应已批准 module spec、Phase 0 任务票（amw.3/4/5）与 PR 审查共同确认；`SPEC-legacy-projects.md` 批准前，不据此扩大删除范围。
- 仅靠 `SPEC-legacy-projects.md` 支撑、或删除依据存在争议的项目，集中在第 6 节“待审阅/不确定项”单列，不混入确定删除结论。
- 本清单不声称已完成任何实现验证；未运行 `typecheck`、`build`、Electron 回归或真实服务测试，分类结论不构成通过证据。

## 1. 分类口径与统计

### 1.1 每文件唯一主分类

| 分类 | 定义 | 处置边界 |
|---|---|---|
| 复用 | 新核可原样或基本原样沿用；文件本身不含旧核专属职责 | 可保留，后续只在依赖或接口自然变化时调整 |
| 改造 | 文件含需保留的基础能力，同时含旧核专属职责或旧契约；需随对应 module phase 调整 | 保留基线并拆分旧职责；不得因单个旧 export 把整个文件判废弃 |
| 废弃 | 整个文件专属旧引用、旧映射、旧材料/旧导入或旧 PDF 原生批注/审阅门禁；Phase 0 可集中删除 | 删除前必须先移除或改写其引用点；同一 PR 内处理 import、IPC、preload、type、test、build 引用 |

补充规则：

- 混合文件不因一个旧 export 判废弃；例如 `markdown-references.ts` 保留 markdown-it/KaTeX 渲染器，只移除旧引用使用索引。
- 不以“无 import”作为废弃依据；测试文件由 Playwright 自动发现，产品提示词由目录读取，均可能没有静态 import。
- 旧 PDF 原生批注、旧引用字典、旧阅读地图、旧材料登记、旧 v1 书库批量导入属于旧核专属能力；对应文件原则上废弃。
- 旧解析/审阅链是 `pdf-import` 的改造输入，不整体判废弃；只把审阅门禁、`candidate.md` 正文权威、`mapping.json` 引用字典等旧职责剥离。

### 1.2 统计口径与数量

| 范围 | 文件数 | 复用 | 改造 | 废弃 | 说明 |
|---|---:|---:|---:|---:|---|
| `app/src/` | 52 | 12 | 25 | 15 | 含 47 个 TS/TSX/CTS/`.d.ts` 与 5 个 CSS |
| `app/tests/` | 14 | 4 | 5 | 5 | 含 10 个 `*.spec.ts`、1 个测试辅助 `.ts`、`.gitattributes` 与 2 个 PDF fixture |
| 核心小计 | 66 | 16 | 30 | 20 | 任务要求的源文件与测试全集 |
| 构建/测试辅助 | 9 | 7 | 1 | 1 | 2 个脚本、4 个配置、1 个入口 HTML、2 个产品 Skill 提示词 |
| **合计** | **75** | **23** | **31** | **21** | 每文件恰好一个主分类 |

## 2. 完整分类表

### 2.1 `app/src/main/`（19 个）

| 文件 | 分类 | spec / 代码依据 | 接管 / 说明 |
|---|---|---|---|
| `app/src/main/agent-service.ts` | 改造 | `SPEC-agent-integration.md:88`（现有 agent-service 是改造输入；`requireReviewed`、`reviewBatchId`、`complete_review_page`、mapping、旧 `resolve_reference`、PDF 原生批注链退出）；`:139-149`（Pi 会话保留）；`app/src/main/agent-service.ts:485-528`（旧审阅/建图工具链） | agent-integration：保留 Pi 会话、流式、停止/分支/压缩、模型与工具安全；移除审阅门禁、建图、旧引用工具与 PDF 原生批注。Phase 0 先拆旧工具与 mapping 分支（amw.3/amw.4） |
| `app/src/main/agent-settings.ts` | 复用 | `SPEC-agent-integration.md:49-50`（沿用模型服务、thinking/vision、`userData` 与 `safeStorage`）；`:75-135`（任务/证据类型与凭据边界） | 保留模型服务、模型列表、思考等级、视觉标记与加密密钥；文件内旧单模型本机设置迁移不属于工程旧格式，可原样保留 |
| `app/src/main/agent-tools.ts` | 改造 | `SPEC-agent-integration.md:262-268`（普通 read/write/edit/bash 边界保留）；`:227-237`（成果写入需专用命令）；`:88`（旧写作用域需清理） | agent-integration：保留 read/write/edit/PowerShell、基线冲突、去敏与产物回显；移除 `mapping-*`/`text/candidates` 旧写作用域。Phase 0 清理建图/候选权限分支（amw.4） |
| `app/src/main/baidu-candidate.ts` | 改造 | `SPEC-pdf-import.md:91`（现有 baidu-candidate 是改造输入；`reviewedThroughPage` 门禁、`candidate.md` 正文权威、正式 PDF 引用字典和 `materials` 前提不属于新契约）；`:194-238`（去敏、完整性与转换）；`:227-238`（直接生成文档树，不经过可编辑 Markdown 中间权威） | pdf-import：保留 JSONL 页级校验、重复页检查、资源下载/去敏、图片预算与 PDF 页数核对；把候选输出改为 document-core 文档树，移除 `createCitation`、`paper://cite`、`candidate.md` 权威 |
| `app/src/main/chat-materials.ts` | 改造 | `SPEC-agent-integration.md:151-174`（默认上下文、显式附件与 current/source 读取边界）；`SPEC-project-core.md:137-141`（普通参考文件不再登记为 materials） | agent-integration：保留 document/Skill 枚举、附件去重与发送前准备；`:27-29` 的旧 `references.resolve` source 附件分支改为新 current/source 上下文，`:12` 的 paper-map 过滤随建图目录删除。**文件含通用职责，不能按 amw.5 预设整文件删除** |
| `app/src/main/document-references.ts` | 废弃 | `SPEC-project-core.md:209`（新工程不创建出处字典）；`SPEC-annotations-results.md:90`（旧 `paper://cite` 与材料路径不进入新锚点协议）；代码本身只对旧 `paper30min-source:` 链接 fail-closed | Phase 0（旧引用，amw.3）：整个文件是旧出处字典占位；若新锚点保存前校验需要 hook，应由 annotations-results 重新实现，不沿用旧协议 |
| `app/src/main/main.ts` | 改造 | `SPEC-project-core.md:45`（Electron 主进程、utility process、受限 IPC/preload）；`:204-211`（本机偏好与旧功能边界）；`SPEC-workspace.md:15`（窗口尺寸、侧栏与 Agent 宽度留在 `userData`） | project-core/workspace/legacy-projects：保留协议注册、utility process、可信 sender 校验、工程监听、设置存储、外链/外部打开与安全窗口配置；移除旧 `project:command` 全部旧命令、PDF 原生批注 IPC、legacy 选择入口与旧引用字典监听特例 |
| `app/src/main/parsing-service.ts` | 改造 | `SPEC-pdf-import.md:91`（现有 parsing-service 是改造输入；远程恢复与费用保护可保留）；`:181-192`（提交不确定性与恢复）；`:249-257`（重解析/离线重新转换）；`:259-291`（核验记录） | pdf-import：保留百度任务状态机、POST 前持久化、提交不明禁止重传、30 分钟查询、资源预算与恢复；移除审阅门禁、`candidate.md`/`mapping.json` 权威，改为解析快照、页/块事实、文档树候选与 verification sidecar |
| `app/src/main/parsing-settings.ts` | 复用 | `SPEC-pdf-import.md:50-53`（沿用百度 AI Studio、PaddleOCR-VL-1.6、`safeStorage`/`userData`）；`:171-179`（凭据与机器配置边界） | 保留百度 Token 加密、endpoint/model 校验与本机存储；新模块只需复用，不因旧工程契约删除 |
| `app/src/main/pdf-tools.ts` | 改造 | `SPEC-agent-integration.md:88`（pdf-tools 是改造输入；旧 PDF 引用/原生批注链退出）；`:177-187`（`read_source` 的文本/图像/资产模态与 SourceReadReceipt）；`SPEC-pdf-comparison.md:54-56` | agent-integration/pdf-import：保留 PDFium 整页渲染、取消、页码/尺寸/缩放信息；移除“返回可复用引用链接”的旧语义，增加 `pdf-text`/`pdf-image`/`source-asset` 模态与主进程 receipt |
| `app/src/main/preload.cts` | 改造 | `SPEC-project-core.md:45`（受限 IPC/preload）；`SPEC-agent-integration.md:49`（生产 preload 回归）；`SPEC-annotations-results.md:90`（PDF 原生批注 ID 不进入新协议）；`:387`（不恢复 `#annotation=`） | project-core/agent-integration：保留 `contextBridge`、`invoke`、`watchProject`、`watchAgent`、choose/openLink/openFile；移除 `handleAnnotationWrite` 与 `pdf:annotation-*` 通道；按新 Command/AgentCommand 收缩类型 |
| `app/src/main/product-skills.ts` | 复用 | `SPEC-agent-integration.md:229-236`（Markdown 成果与显式保存）；`SPEC-project-core.md:209`（新工程无地图登记） | 服务本身通用，保留读取/保存/版本校验与 bundled 目录；目录内容变化由 `shared/product-skills.ts` 与 Skill 文件承担，`paper-map.md` 删除后此服务无需改结构 |
| `app/src/main/project-service.ts` | 改造 | `SPEC-project-core.md:82`（现有 project-service 是改造输入；PDF 必需、`materials`、`map`、旧导入假设不要求保留）；`:86-106`（新磁盘契约）；`:204-211`（旧功能边界）；`SPEC-document-core.md:78-95`（revision 内容契约） | project-core：保留路径安全、符号链接拒绝、原子 JSON、SHA-256、串行写队列、普通 Markdown 基线/外部冲突、最近工程；重写 `formatVersion: 2` 清单、工程创建/首次导入、source snapshot、revision/current；移除 materials/map/explanations/translations、引用字典、旧 reading、legacy scan/import、PDF 必需创建、PDF 原生批注保存。Phase 0 拆旧材料/旧导入（amw.5）与旧引用/映射（amw.3/amw.4） |
| `app/src/main/reference-context.ts` | 废弃 | `SPEC-agent-integration.md:88`（旧 `resolve_reference` 退出）；`:43`（旧引用工具不在范围）；`SPEC-annotations-results.md:90`（旧 `paper://cite` 不进入新锚点） | Phase 0（旧引用，amw.3）：整文件是旧 citation 块空间匹配与解析稿行号定位；新 document-core 锚点/投影替代，不保留旧块匹配 |
| `app/src/main/reference-service.ts` | 废弃 | `SPEC-agent-integration.md:88`（旧 `resolve_reference` 与 PDF 原生批注链退出）；`:43`（旧引用/PDF 原生批注不在范围）；`SPEC-annotations-results.md:90`（`#annotation=` 与 PDF 原生 ID 不进入新协议） | Phase 0（旧引用，amw.3）：整文件是旧 citation/annotation 解析与 PDF 原生批注创建；新 `read_source` 只读取已存在来源快照，不解析旧链接、不写 PDF 批注 |
| `app/src/main/reference-tools.ts` | 废弃 | `SPEC-agent-integration.md:88`（旧 `resolve_reference` 退出）；`:90-103`（新工具表不含旧引用工具）；`SPEC-pdf-import.md:91`（新核验记录走 sidecar） | Phase 0（旧引用，amw.3）：整文件只注册 `resolve_reference` 与 PDF 原生 `create_annotation`；新工具集由 agent-integration 重新定义 |
| `app/src/main/turndown-plugin-gfm.d.ts` | 复用 | `SPEC-pdf-import.md:194-238`（HTML 表格/块转换仍需可行的类型支持）；文件只是 `turndown-plugin-gfm` 的构建期类型声明 | 原样保留；若 pdf-import 最终不再使用 `turndown-plugin-gfm`，随依赖一起删除，不作为 Phase 0 旧核专属文件 |
| `app/src/main/web-tools.ts` | 复用 | `SPEC-agent-integration.md:34`（保留网络调研工具）；`:260-268`（Web 工具安全边界）；`:188`（外部网页不能替代论文来源） | 保留 Exa 搜索/网页读取、取消、超时、限流、凭据去敏与会话内容复用；无需因旧工程格式改造 |
| `app/src/main/worker.ts` | 改造 | `SPEC-project-core.md:45`（Node utility process）；`SPEC-agent-integration.md:80-81`（主进程/Agent 运行时边界）；`SPEC-pdf-import.md:83-84`（解析与组合入口） | project-core/agent-integration/pdf-import：保留 utility process 消息路由、trash/annotation 取消机制中可复用部分、工程/Agent/解析命令分发；移除 ReferenceService 与旧 annotation 写回，接入新 project/document/pdf/agent services |

### 2.2 `app/src/shared/`（10 个）

| 文件 | 分类 | spec / 代码依据 | 接管 / 说明 |
|---|---|---|---|
| `app/src/shared/annotation-links.ts` | 废弃 | `SPEC-annotations-results.md:90`（现有 annotation-links 只作路径安全、AST 重写和交互参考；`#annotation=`、PDF 原生 ID、`paper://cite` 和材料路径不进入新文本锚点协议）；`:141-168`（新 `paper://anchor/v1`）；`SPEC-agent-integration.md:334`（不恢复 `#annotation=`） | Phase 0（旧引用，amw.3）：整文件专属旧 PDF 批注相对链接与 `#annotation=` 编解码；新 codec 必须在 annotations-results 重新实现，不能沿用相对路径 rebase 语义 |
| `app/src/shared/chat-input.ts` | 改造 | `SPEC-agent-integration.md:151-163`（选区/附件上下文）；`:228-237`（成果/锚点保存）；`SPEC-annotations-results.md:141-168`（新锚点 URL） | agent-integration/annotations-results：保留 Markdown AST 提取、来源注入展示与附件去重；把 `paper://cite`/`#annotation=`/`sourceSnapshotLabel` 替换为新 current 投影附件与 `paper://anchor`；移除 PDF 原生批注材料语义 |
| `app/src/shared/citations.ts` | 废弃 | `SPEC-pdf-import.md:118`（旧 `mapping.json`/`candidate.md` 不是权威；PDF 页/框事实不构成正式引用字典）；`:236`（不创建 `.paper30min-citations.json`/`paper://cite`）；`SPEC-pdf-comparison.md:85`（`createCitation`、正式引用链接不进入新模块） | Phase 0（旧引用，amw.3）：整文件是旧 citation 字典、`paper://cite` codec 与 PDF 区域校验；新 pdf-comparison 使用可重建映射缓存，不保留正式引用字典 |
| `app/src/shared/contracts.ts` | 改造 | `SPEC-project-core.md:74-82`（共享 IPC/工程类型）；`:110-129`（`ProjectManifest` v2）；`SPEC-agent-integration.md:105-135`（任务/SourceReadReceipt）；`SPEC-workspace.md:110-142`（PageDescriptor/TabInstance/WorkspaceLayout） | 全模块共享契约：保留 `Desktop` IPC 骨架、Preferences、Markdown 文件/保存、Agent 设置与 Chat 基础类型；移除 v1 `Manifest`、`DocumentRecord`/`annotationSha256`、`materials`/`map`/`explanations`/`translations`、Legacy 类型、旧 `Command`/`AgentCommand`、Citation/Reference/AnnotationWrite 依赖；新增 project/document/agent/workspace 类型。Phase 0 先清旧字段（amw.3/4/5） |
| `app/src/shared/mapping.ts` | 废弃 | `SPEC-pdf-import.md:118`（旧 mapping 不再权威）；`SPEC-pdf-comparison.md:85`（不恢复正式映射/引用字典）；`SPEC-reader.md:11`（无阅读地图）；`SPEC-agent-integration.md:88`（mapping 发布退出） | Phase 0（旧映射，amw.4）：整文件只描述旧建图计划与状态；新 pdf-comparison 的派生缓存契约在对应 module spec 中定义，不复用此类型 |
| `app/src/shared/markdown-references.ts` | 改造 | `SPEC-annotations-results.md:51-54`（沿用 markdown-it + `mdast-util-from-markdown` 与 AST 位置）；`:90`（旧 citation/annotation 使用索引不进入新协议）；`SPEC-reader.md:52`（KaTeX 渲染保留） | annotations-results/reader：保留 `markdownRenderer`（markdown-it + KaTeX）作为普通 Markdown 成果渲染；移除/替换 `markCitationUses` 旧引用与 `#annotation=` 使用索引；不得把旧引用扫描当成新锚点扫描 |
| `app/src/shared/parsing.ts` | 改造 | `SPEC-pdf-import.md:91`（旧解析契约是改造输入）；`:128-142`（新的来源事实/核验类型）；`:181-192`（任务阶段与恢复） | pdf-import：保留 `ParsingPhase`、任务/命令状态与恢复语义；重写 `ParsingRun`/`ParsingMapping`/`ParsedBlock` 为 PDF snapshot、parse snapshot、facts、diagnostic、verification 类型；移除 `Citation` 依赖与 `reviewedThroughPage` 门禁字段 |
| `app/src/shared/pdf-versions.ts` | 废弃 | `SPEC-pdf-import.md:151-152`（任务/PDF/解析快照/revision 使用不同 ID；PDF SHA-256 不替代身份）；`:160-166`（同字节复用快照，不同字节新快照）；`SPEC-project-core.md:136-141`（来源快照/revision 身份） | Phase 0（旧材料身份/批注谱系，amw.5）：整文件是旧 PDF 原生批注 lineage、material relink 与旧库幂等判断；先由 amw.3 清掉 reference-service/pdf-annotations 消费方，再由 amw.5 清 project-service/parsing-service 剩余引用并删除本文件 |
| `app/src/shared/product-skills.ts` | 改造 | `SPEC-agent-integration.md:229-236`（只保留显式 Markdown 成果）；`SPEC-project-core.md:209`（无地图登记）；`SPEC-reader.md:11`（无阅读地图） | agent-integration：保留 `ProductSkill` 接口与 `memory-card.md` 条目；移除 `paper-map.md` 条目及其地图/精解描述；Skill 目录随 catalog 收缩 |
| `app/src/shared/references.ts` | 废弃 | `SPEC-agent-integration.md:43`（旧 `resolve_reference` 不在范围）；`:88`（旧引用/PDF 原生批注链退出）；`SPEC-annotations-results.md:90`（PDF 原生 ID 不进入新协议）；`SPEC-legacy-projects.md:143`（旧 citation/块 ID 不导入） | Phase 0（旧引用，amw.3）：整文件是旧 ResolvedReference/AnnotationWrite/AnnotationWriter 契约；新来源读取与核验由 agent-integration/pdf-import 新类型承接 |

### 2.3 `app/src/renderer/`（23 个）

| 文件 | 分类 | spec / 代码依据 | 接管 / 说明 |
|---|---|---|---|
| `app/src/renderer/AgentMessage.tsx` | 改造 | `SPEC-agent-integration.md:53`（消息/来源展示）；`:228-237`（成果与锚点）；`SPEC-annotations-results.md:166-170`（新 `paper://anchor` 应用内导航） | agent-integration/annotations-results：保留 Markdown/KaTeX 渲染、图片不发起远端请求、外链受控打开；把 `isSourceLink` 从旧 `paper://cite`/`#annotation=` 切换到新锚点与显式附件 |
| `app/src/renderer/AgentPanel.tsx` | 改造 | `SPEC-agent-integration.md:88`（AgentPanel 是改造输入；`requireReviewed`、`reviewBatchId`、`complete_review_page`、mapping、旧 `resolve_reference`、PDF 原生批注链退出）；`:139-149`（持续会话 UI）；`:151-163`（上下文/附件） | agent-integration：保留会话列表、流式消息、停止/分支/压缩、模型选择、附件与工具轨迹；移除 readiness 门禁、审阅会话、建图按钮、旧来源预览与 PDF 原生批注剪贴板逻辑。Phase 0 拆旧能力入口（amw.3/4/5） |
| `app/src/renderer/AgentSettingsForm.tsx` | 复用 | `SPEC-agent-integration.md:49-50`（沿用模型服务、thinking/vision、本机凭据）；`:75-135`（凭据不进入工程） | 保留多服务/多模型编辑、代理、Exa 密钥、vision 开关与保存冲突处理；新模块无旧工程字段依赖 |
| `app/src/renderer/App.tsx` | 改造 | `SPEC-workspace.md:90`（现有 App.tsx 单页签组是改造输入；旧 `saveWorkspace` 单 `active` 与按路径过滤恢复可删除）；`SPEC-project-core.md:82`（创建/恢复入口改造输入）；`SPEC-legacy-projects.md:74`（使用现有错误提示展示旧格式原因） | workspace/project-core/legacy-projects：保留应用壳、左右栏、页签、文件树、设置路由、对话框、错误提示、Markdown/Agent/PDF 宿主；移除 map/explanations/translations/materials 阅读导航、LegacyImport、PDF-only 新建、citation/annotation 导航、旧 reading/PDF position 持久化。Phase 0 拆旧入口（amw.3/4/5） |
| `app/src/renderer/LegacyImport.tsx` | 废弃 | `SPEC-project-core.md:19`（旧 v1 书库批量导出入口不再存在）；`:210`（不提供旧书库扫描/批量导入）；`SPEC-legacy-projects.md:38`（旧 v1 SQLite/批量导入/`legacy-imports.json` 退出）；`:126`（不创建 `legacy-imports.json`） | Phase 0（旧材料/旧导入，amw.5）：整文件专属旧 v1 书库选择、批量导入与重试 UI；新核只保留普通 PDF 导入与显式拒绝旧布局 |
| `app/src/renderer/MappingPanel.tsx` | 废弃 | `SPEC-reader.md:11`（不实现阅读地图）；`SPEC-project-core.md:209`（新工程不创建 map）；`SPEC-agent-integration.md:88`（mapping 发布退出）；`capability-map.md:13`（阅读地图不在当前范围） | Phase 0（旧映射，amw.4）：整文件专属阅读地图生成与发布 UI；普通论文精解仍由 annotations-results/agent-integration 的 Markdown 成果承接，不随本文件取消 |
| `app/src/renderer/MarkdownDocument.tsx` | 改造 | `SPEC-reader.md:91`（现有 MarkdownDocument 只用于普通 Markdown 成果，不得改造成主论文正文权威）；`SPEC-annotations-results.md:90`（旧引用/批注链接不进入新协议）；`:214-236`（普通 Markdown AST 扫描）；`SPEC-workspace.md:90`（多视图草稿改造输入） | workspace/annotations-results/reader：保留 CodeMirror 编辑、read/edit/split、草稿、外部冲突、图片本地解析、KaTeX；移除旧 `paper://cite` 使用高亮、`#annotation=` 粘贴/rebase 与 PDF 引用定位；新增新锚点链接识别/回跳，保持“普通成果编辑器”定位 |
| `app/src/renderer/ParsingPanel.tsx` | 改造 | `SPEC-pdf-import.md:91`（现有 ParsingPanel 是改造输入；`reviewedThroughPage` 门禁等不属于新契约）；`:171-179`（上传/费用确认）；`:181-192`（提交不明/恢复）；`:240-247`（首次发布与可读门槛） | pdf-import：保留解析记录、任务号关联、停止/恢复、上传确认、删除与进度；移除逐页审阅/继续审阅、`candidate.md` 正文入口与旧引用字典语义；增加解析快照、机器诊断、候选/发布状态与核验范围展示 |
| `app/src/renderer/PdfReader.tsx` | 改造 | `SPEC-reader.md:91`（原页渲染和位置恢复可复用；旧引用、PDF 原生批注和材料身份假设不属于新 reader）；`:254-260`（可选 PDF 原页与独立位置）；`SPEC-pdf-comparison.md:85`（pdf-citations 仅作 EmbedPDF 选择/坐标/瞬态高亮参考） | reader/pdf-comparison/workspace：保留 EmbedPDF 渲染、缩放/滚动/旋转/spread、页级位置捕获、原页只读视图；移除 citation/annotation 面板、PDF 原生批注保存、旧 hash lineage 与全局 reading 文件；位置状态改由 workspace 按页签持久化 |
| `app/src/renderer/ProductSkillsForm.tsx` | 复用 | `SPEC-agent-integration.md:229-236`（显式 Markdown 成果/Skill 编辑）；`SPEC-project-core.md:209`（无地图登记） | 保留通用 Skill 选择、编辑、版本冲突与重载；catalog 收缩后自动只显示保留项，无需改组件 |
| `app/src/renderer/agent.css` | 复用 | `SPEC-agent-integration.md:139-149`（右侧 Agent 与持续会话 UI 保留）；文件内无旧引用/映射/材料专属选择器 | 保留 Agent 面板、消息、模型选择、工具轨迹、设置与 Skill 表单样式；旧能力入口移除时可留下少量未用类，后续按模块清理 |
| `app/src/renderer/annotation-clipboard.ts` | 废弃 | `SPEC-annotations-results.md:90`（旧 `#annotation=` 与 PDF 原生 ID 不进入新协议）；`:166`（新锚点自包含、无需相对路径 rebase）；`:387`（不恢复 `#annotation=`） | Phase 0（旧引用，amw.3）：整文件专属旧批注链接剪贴板元数据与跨文档 rebase；新 `paper://anchor` 复制/粘贴由 annotations-results 新命令实现 |
| `app/src/renderer/global.d.ts` | 复用 | `SPEC-project-core.md:45`（受限 preload 类型入口）；`SPEC-agent-integration.md:49`（生产 preload） | 只声明 `Window.desktop: Desktop`；契约内容变化由 `contracts.ts` 承担，本文件无需修改 |
| `app/src/renderer/main.tsx` | 复用 | `SPEC-project-core.md:74-80`（React 入口，不拥有持久化权威） | 保留 React 19 根挂载与全局样式导入；不承载旧核职责 |
| `app/src/renderer/markdown.css` | 复用 | `SPEC-reader.md:91`（普通 Markdown 成果渲染保留）；`SPEC-annotations-results.md:51-54`（Markdown/KaTeX） | 保留 Markdown 预览、表格、代码、图片、KaTeX 与链接样式；不含旧引用/批注专属选择器 |
| `app/src/renderer/parsing.css` | 改造 | `SPEC-pdf-import.md:91`（ParsingPanel 改造输入）；`:240-247`（发布/诊断状态） | pdf-import：保留解析面板基础布局与状态样式；移除审阅门禁/旧候选入口样式，新增快照、诊断、候选与核验状态样式 |
| `app/src/renderer/pdf-annotation-commit.ts` | 废弃 | `SPEC-agent-integration.md:43`（PDF 原生批注退出）；`:88`（PDF 原生批注链退出）；`SPEC-annotations-results.md:43`（PDF 原生批注不在范围）；`:90`（PDF 原生 ID 不进入新协议） | Phase 0（旧引用，amw.3）：整文件是 EmbedPDF 原生批注并发提交兼容层；新核不写 PDF 原生批注，无需保留 |
| `app/src/renderer/pdf-annotations.ts` | 废弃 | `SPEC-agent-integration.md:43`（PDF 原生批注退出）；`:88`（PDF 原生批注链退出）；`SPEC-annotations-results.md:43`（PDF 原生批注不在范围）；`:400`（不出现 PDF 原生批注权威） | Phase 0（旧引用，amw.3）：整文件专属 PDF 原生批注加载、保存、复制链接与 Agent 写回；新 annotations-results 使用文本锚点 sidecar，不写 PDF |
| `app/src/renderer/pdf-citations.ts` | 废弃 | `SPEC-pdf-comparison.md:85`（现有 pdf-citations 仅作 EmbedPDF 选择/坐标/瞬态高亮参考；`createCitation`、正式引用链接和 PDF 原生批注职责不进入新模块）；`SPEC-agent-integration.md:43`（旧引用工具退出）；`SPEC-annotations-results.md:90`（旧 `paper://cite` 不进入新协议） | Phase 0（旧引用，amw.3）：整文件是旧 citation 框选/复制/定位与工具栏；pdf-comparison 可参考其 EmbedPDF 选择/坐标 API，但需在新模块重写为映射缓存与瞬态高亮 |
| `app/src/renderer/select.css` | 复用 | `SPEC-agent-integration.md:139-149`（设置/会话选择器保留）；文件只定义 Chromium `select` 外观 | 原样保留；不承载旧核职责 |
| `app/src/renderer/style.css` | 改造 | `SPEC-workspace.md:90`（App/布局改造）；`SPEC-reader.md:91`（Markdown/PDF 宿主保留）；`SPEC-project-core.md:209`（无 map/materials） | workspace/reader/project-core：保留应用壳、侧栏、页签、工具栏、设置与通用布局；移除 legacy-import、citation-uses/citation-use-target、mapping-panel、material-row 等旧选择器；Phase 0 随旧组件删除（amw.3/4/5） |
| `app/src/renderer/useMarkdownDocuments.ts` | 改造 | `SPEC-workspace.md:90`（现有草稿能力是改造输入；旧单页签/按路径过滤恢复不满足双窗格）；`:203-218`（草稿与关闭保护）；`SPEC-project-core.md:186-190`（普通 Markdown 基线/原子保存/外部冲突） | workspace/project-core：保留草稿缓存、自动保存、基线冲突、外部变化、关闭前 flush 与重试；扩展为同路径多视图共享文本、独立光标/滚动/模式，恢复草稿按 tabInstanceId 管理；移除旧 tab 单实例假设 |
| `app/src/renderer/usePanelLayout.ts` | 改造 | `SPEC-workspace.md:90`（宽度交互是改造输入）；`:15`（窗口尺寸/侧栏/Agent 宽度留在 userData）；`:19-23`（双窗格独立状态）；`:229`（比例持久化） | workspace：保留 pointer 拖拽、键盘调整、最小/最大宽度与 overlay 行为；扩展为左右中栏分栏比例与双窗格，Agent 宽度/展开状态仍在本机偏好；不得把窗格布局写入工程清单 |

### 2.4 `app/tests/`（14 个）

| 文件 | 分类 | spec / 代码依据 | 接管 / 说明 |
|---|---|---|---|
| `app/tests/agent-files.spec.ts` | 改造 | `SPEC-agent-integration.md:262-268`（普通文件 read/write/edit/bash 保留）；`SPEC-project-core.md:184-193`（普通文件树/外部冲突）；`SPEC-project-core.md:242-254`（真实 Electron/文件系统回归） | project-core/agent-integration：保留基线冲突、取消、所有权与路径保护用例；改用 v2 工程创建、普通文件树与新锚点校验；移除 `paper30min-source:` 转换与 materials 前提 |
| `app/tests/desktop.spec.ts` | 改造 | `SPEC-project-core.md:82`（desktop.spec 明确是改造输入）；各 module Testing Strategy；`SPEC-reader.md:338-349`、`SPEC-agent-integration.md:327-339`、`SPEC-workspace.md:312-323` | 全模块真实 Electron 回归：保留 Electron 启动、窗口隐藏/截图、模型配置、Pi 会话、普通文件与工具安全、Markdown/PDF 阅读等可用基线；重写 PDF-only 新建、审阅门禁、citation/annotation、mapping、legacy 导入与旧 reading 用例。Phase 0 先删除旧能力用例（amw.3/4/5），不要把旧通过记录当新证据 |
| `app/tests/fixtures/.gitattributes` | 复用 | `SPEC-pdf-import.md:350-360`（PDF fixtures）；`SPEC-pdf-comparison.md:294-344`（PDF/HTML fixtures） | 保留 `*.pdf binary`，避免 PDF fixture 被文本换行处理 |
| `app/tests/fixtures/encrypted.pdf` | 复用 | `SPEC-pdf-import.md:162`（加密/损坏 PDF 明确错误）；`:354`（加密 PDF fixtures） | 保留为 pdf-import 加密 PDF 负面 fixture；新测试可继续使用 |
| `app/tests/fixtures/long-150.pdf` | 复用 | `SPEC-pdf-import.md:354`（长 PDF fixtures）；`SPEC-pdf-comparison.md:306`、`:339`（长 PDF/有界渲染） | 保留为长文档、页数与有界渲染 fixture；新模块应复用而非另造同义文件 |
| `app/tests/mapping.spec.ts` | 改造 | `SPEC-project-core.md:209`（新工程不创建 map）；`SPEC-agent-integration.md:88`（mapping 发布退出、Product Skill 基座保留）；`capability-map.md:13`（阅读地图不在范围内） | Phase 0（amw.4）删除 `:11-57` 建图发布测例；保留 `:59-73` Product Skills 版本基线测例，把 catalog 断言从“建图、记忆卡片”改为“记忆卡片”，不能整文件删除 |
| `app/tests/parsing.spec.ts` | 改造 | `SPEC-pdf-import.md:91`（旧解析是改造输入）；`:293-348`（受控百度、提交不确定、恢复、去敏、转换测试）；`:350-421`（首次发布/重解析故障注入） | pdf-import：保留 POST 不确定、任务号关联、停止/恢复、JSONL 页级校验、图片预算、删除批次等用例；把 `candidate.md`/`mapping.json`/citation 断言改为解析快照、facts、文档树与诊断 |
| `app/tests/pdf-save.spec.ts` | 废弃 | `SPEC-pdf-import.md:109`（PDF 快照只读、不可变）；`:164`（只读复制原 PDF）；`SPEC-agent-integration.md:364`（Agent 不直接覆盖 PDF）；`SPEC-pdf-comparison.md:85`（不恢复 PDF 原生批注） | Phase 0（旧引用，amw.3）：整文件验证旧 `savePdf` 原生批注写回/文件占用重试；新核对 PDF 不可变与快照复制。若需保留文件锁/原子替换测试，应在新 pdf snapshot 测试中重写，不保留旧 savePdf 语义 |
| `app/tests/pdf-tools.spec.ts` | 改造 | `SPEC-agent-integration.md:88`（pdf-tools 是改造输入；旧引用返回退出）；`:177-187`（`read_source` 模态与 receipt）；`SPEC-pdf-import.md:54`（PDFium 页面渲染） | agent-integration/pdf-import：保留旋转页、完整页图、取消不返回迟到图像等渲染用例；增加 `pdf-text`/`pdf-image`/`source-asset`、SourceReadReceipt、来源快照与任务/session 绑定断言；移除“不登记引用”围绕旧 citation 的断言 |
| `app/tests/pdf-versions.spec.ts` | 废弃 | `SPEC-pdf-import.md:151-152`（PDF/解析/revision ID 分离；PDF SHA 不替代身份）；`:160-166`（同字节复用/不同字节新快照）；`:236`（不创建正式引用字典） | Phase 0（amw.5，先清 amw.3 引用链）：整文件围绕旧 `annotationSha256` lineage、`createCitation` 与 legacy 导入/relink 幂等；新 pdf-import 用快照/revision 重写，不沿用该版本模型 |
| `app/tests/reference-tools.spec.ts` | 废弃 | `SPEC-agent-integration.md:43`（旧 `resolve_reference` 不在范围）；`:88`（旧引用/PDF 原生批注链退出）；`SPEC-annotations-results.md:90`（旧引用协议退出） | Phase 0（旧引用，amw.3）：整文件只测 `resolve_reference`、PDF 原生批注创建与旧 citation 行号定位；新 `read_source`/`record_verification` 测试在 agent-integration/pdf-import 新写 |
| `app/tests/review-fixture.ts` | 废弃 | `SPEC-pdf-import.md:91`（`reviewedThroughPage` 门禁、candidate 正文权威与旧解析前提退出）；`SPEC-agent-integration.md:143`（普通会话不再调用 `requireReviewed`）；`app/tests/review-fixture.ts:38-56`（只生成旧 formatVersion 1 run/mapping/candidate） | Phase 0（amw.5）：`seedParsing` 与 `seedBlockParsing` 均只构造旧解析批次/引用数据，整文件无新核契约可保留；仍引用它的 desktop 保留测例须同批改用新 fixtures，不能因现有 import 而误判为混合文件 |
| `app/tests/review.spec.ts` | 废弃 | `SPEC-agent-integration.md:143`（不再有完整审阅门禁）；`SPEC-pdf-import.md:91`（逐页审阅门禁不属于新契约）；`:450`（不以完整 LLM 审阅作为阅读条件） | Phase 0（旧材料/旧导入解析链，amw.5）：整文件验证连续页审阅持久化/续审；新核以机器完整性 + 核验范围 sidecar 取代，不保留页面审阅门禁 |
| `app/tests/web-tools.spec.ts` | 复用 | `SPEC-agent-integration.md:34`（保留网络调研）；`:260-268`（Web 工具安全/去敏/取消）；`:188`（外部网页不替代论文来源） | 保留 Exa 搜索、正文分段、会话重开隔离、密钥仅请求头、限流/认证/取消用例；如新模块增加 receipt 负例，可在同文件扩展 |

### 2.5 构建/测试辅助文件（9 个）

| 文件 | 分类 | spec / 代码依据 | 接管 / 说明 |
|---|---|---|---|
| `app/scripts/dev.mjs` | 复用 | `app/README.md` 开发入口；`SPEC-project-core.md:51-60`（`npm run dev` 工程命令） | 保留 Vite dev server + Electron 启动；不承载旧核职责 |
| `app/scripts/start.mjs` | 复用 | `app/package.json` `start` 脚本；`SPEC-project-core.md:53-60` | 保留生产 Electron 启动包装；不承载旧核职责 |
| `app/playwright.config.ts` | 复用 | `SPEC-project-core.md:62-68`（真实 Electron 回归入口）；各 module Commands | 保留 testDir、单 worker、超时、trace 与真实服务环境变量；新测试通过用例标题/文件组织接入，不要求改本配置 |
| `app/vite.config.ts` | 复用 | `SPEC-project-core.md:51-60`（前端构建）；`SPEC-document-core.md:47-54`（React/TS 构建） | 保留 `base`、renderer outDir 与 dev server；不承载旧核职责 |
| `app/tsconfig.json` | 复用 | `SPEC-project-core.md:53-60`（`npm run typecheck`）；`SPEC-document-core.md:47-54`（TS 配置） | 保留 strict、Bundler、JSX 与 include；新目录在 `app/src`/`app/tests` 下自动纳入 |
| `app/tsconfig.node.json` | 复用 | `SPEC-project-core.md:45-49`（Node utility process/ESM）；`:53-60`（Node 构建） | 保留 main/shared 的 Node 构建输出；新 main 模块目录自动纳入 |
| `app/index.html` | 复用 | `SPEC-project-core.md:45`（Electron renderer 入口）；`SPEC-annotations-results.md:264-267`（本地图片资产协议） | 保留根节点、CSP 与模块入口；如新增资产协议/远端限制，在对应 module PR 调整 CSP |
| `app/skills/memory-card.md` | 改造 | `SPEC-agent-integration.md:229-236`（记忆卡片作为显式 Markdown 成果）；`SPEC-annotations-results.md:15-23`（普通 Markdown 锚点卡片）；`:141-168`（新锚点） | agent-integration/annotations-results：保留“仅整理用户关注范围、区分论文事实/讨论理解/推测、默认存 `memories/`”的意图；把 `resolve_reference`、`read_pdf`、`paper://cite/...`、“已审阅解析稿”改为 current 投影、`read_source`、`paper://anchor` 与新核验状态 |
| `app/skills/paper-map.md` | 废弃 | `SPEC-reader.md:11`（无阅读地图）；`SPEC-project-core.md:209`（新工程无 map）；`SPEC-agent-integration.md:88`（mapping 发布退出）；`capability-map.md:13` | Phase 0（旧映射，amw.4）：整文件专属旧建图/精解流程；随 `MappingPanel`、`mapping.ts`、catalog `paper-map.md` 条目一并删除 |

## 3. 废弃文件引用点（专项交叉核对）

> 以下基于当前代码基线，由文件名/导出符号静态检索、CodeGraph 调用闭包、IPC/协议字符串检索交叉得到；覆盖 import、类型、值调用、IPC/preload、renderer、测试与已知运行时/构建入口。实施删除票时若基线已变化，必须重新核对，不能把后续新增调用视为本清单遗漏。

| 废弃文件 | 引用点（`path:line`，类别） | 说明 |
|---|---|---|
| `app/src/main/document-references.ts` | `app/src/main/project-service.ts:13-16`（import）、`:236`（构造默认值）、`:980`（Markdown 保存前调用）；`app/tests/agent-files.spec.ts:12`（构造第 3 参）、`:17-19`（自定义 processor） | 导出 `prepareDocumentReferences`/`DocumentReferenceProcessor`。构造签名还波及 worker、agent-service 与 mapping/parsing/pdf-* /reference-tools 等测试中的 ProjectService 构造点；amw.3 与 project-core 契约调整需协调 |
| `app/src/main/reference-context.ts` | `app/src/main/reference-service.ts:11`（import）、`:137`（matchBlocks 调用）、`:145`（manuscriptLocations 调用） | 导出 `matchBlocks`/`manuscriptLocations`；CodeGraph 与静态检索均无其他调用者、无直接测试，随 ReferenceService 同批删除 |
| `app/src/main/reference-service.ts` | `app/src/main/worker.ts:8`（import）、`:30-41`（构造与 AnnotationWriter 桥）、`:113-114`（resolveReference IPC）；`app/src/main/agent-service.ts:41`（import）、`:204`（默认构造）、`:486`（工具注入）；`app/src/main/chat-materials.ts:5`（type）、`:28`（resolve）；`app/src/main/reference-tools.ts:3`（type）、`:17`、`:27`（resolve/create）；`app/src/renderer/AgentPanel.tsx:427`（resolveReference IPC）；`app/tests/reference-tools.spec.ts:7`、`:26`、`:73`、`:136`、`:145`；`app/tests/pdf-versions.spec.ts:7`、`:39`；`app/tests/desktop.spec.ts:1983`、`:2015`、`:2021`（Agent 工具/IPC） | 无独立 preload 注册；经 worker、Agent 工具和聊天附件三条链路接线。amw.3 同步清理这些调用与 `ResolvedReference` 类型消费 |
| `app/src/main/reference-tools.ts` | `app/src/main/agent-service.ts:42`（import）、`:486-487`（customTools 注册）、`:474`（system prompt）；`app/tests/reference-tools.spec.ts:8`（import）、`:145-146`（工具装配） | 导出 `createReferenceTools`，含 `resolve_reference`/`create_annotation`；无 preload/IPC 直连，仅作为 Pi 工具注入（amw.3） |
| `app/src/shared/annotation-links.ts` | `app/src/main/project-service.ts:12`（import）、`:1057-1062`（移动重写）、`:1070-1100`（Pi 会话重写）、`:1204-1206`（pdfUses）；`app/src/main/reference-service.ts:7`（import）、`:74`、`:217`、`:220`；`app/src/shared/chat-input.ts:2`（import）、`:5`、`:69-71`、`:77-91`；`app/src/shared/markdown-references.ts:4`（import）、`:25-26`；`app/src/renderer/annotation-clipboard.ts:1`；`app/src/renderer/AgentPanel.tsx:26`（import）、`:462`、`:464`；`app/src/renderer/App.tsx:48`（import）、`:282-289`；`app/src/renderer/MarkdownDocument.tsx:10`（import）、`:138-140`、`:182-206`、`:391`；`app/src/renderer/pdf-annotations.ts:3`（import）、`:136`；`app/src/renderer/PdfReader.tsx:20`（import/type）、`:27`、`:139-143`；`app/src/main/reference-tools.ts:7`（参数描述）；`app/tests/reference-tools.spec.ts:11`；`app/tests/desktop.spec.ts:2015`、`:2021`、`:2035`、`:4777-4796`、`:4799-4804`、`:4818-4867`、`:4848-4867`、`:5086-5101` | 旧 `#annotation=` 编解码/重基。amw.3 同步清理 movedLinkEdits、聊天 source 提取、Markdown 粘贴/点击、PDF 批注链接和测试 |
| `app/src/shared/citations.ts` | `app/src/main/project-service.ts:9`（import/type）、`:35`（citationName）、`:396-405`（建图校验）、`:1160-1262`（字典命令）；`app/src/main/baidu-candidate.ts:8`（type）；`app/src/main/reference-context.ts:3-4`；`app/src/main/reference-service.ts:5`（type）；`app/src/renderer/pdf-citations.ts:3`（import/type）、`:49`（createCitation IPC）；`app/src/renderer/PdfReader.tsx:15`（type）；`app/src/renderer/App.tsx:47`（type）、`:293`（resolveCitation IPC）；`app/src/renderer/MarkdownDocument.tsx:9`（type）；`app/src/shared/contracts.ts:1`（type）、`:130-133`（IPC types）；`app/src/shared/references.ts:2`（type）；`app/src/shared/markdown-references.ts:3`（type）；`app/src/shared/parsing.ts:1`、`:57`（ParsedBlock.citation）；`app/src/main/main.ts:229`（字典 watcher 排除）；`app/tests/reference-tools.spec.ts:12`、`:126`、`:167`；`app/tests/review-fixture.ts:8`（type）、`:17`（createCitation）；`app/tests/desktop.spec.ts:419`、`:432`、`:2381`、`:4564`、`:4598`、`:4611`、`:4744`、`:4779`、`:5140`、`:5173`、`:5196`、`:5220`、`:5246-5248`、`:5311`、`:5324`、`:5352`；`app/tests/parsing.spec.ts:179-209`、`:521`、`:671`；`app/tests/pdf-tools.spec.ts:116`、`:259`、`:270` | 旧 citation 字典、codec、区域校验及 PDF uses。无独立 fixture 文件，测试均在临时目录内联构造；amw.3 同步清理 baidu-candidate 的 createCitation/cite 注入 |
| `app/src/shared/mapping.ts` | `app/src/main/agent-service.ts:49`（import）、`:61`（Conversation.mappingPlan type）、`:199`（mappingPlans Map type）、`:242`（sync cast）、`:639`（dispatch return type）；`app/src/main/project-service.ts:8`（import）、`:357`、`:362`、`:375`（create/publish 签名与内部类型）；`app/src/shared/contracts.ts:5`（import）、`:250`（ChatSession.mapping IPC type）；`app/src/renderer/MappingPanel.tsx:4`（import）、`:13`（state type）；`app/tests/mapping.spec.ts:8`（test type） | 无专属 IPC/preload/build 通道；经 `app/src/main/preload.cts:32-39` 泛型 `agent:command`/`agent:changed` 传输。amw.4 同步删除这些类型与引用 |
| `app/src/shared/pdf-versions.ts` | `app/src/main/project-service.ts:11`（import）、`:790-791`（importLegacy 幂等）、`:1154`（annotationSha256）、`:1424`（material relink）；`app/src/main/parsing-service.ts:21`（import）、`:63`（readSource 版本复核）；`app/src/main/reference-service.ts:10`（import）、`:208`（旧引用消费）；`app/src/renderer/pdf-annotations.ts:10`（import）、`:178`（批注版本校验）；`app/tests/pdf-versions.spec.ts`（整文件测试） | 导出 `isKnownPdfVersion`/`canReusePdfEvidence` 均只服务旧材料身份与批注 lineage。需与 amw.3 的旧引用/批注消费方协调删除，再由 amw.5 清剩余材料/导入引用 |
| `app/src/shared/references.ts` | `app/src/main/reference-service.ts:8`（import）；`app/src/main/reference-context.ts:6`（type）；`app/src/main/preload.cts:9`（type）、`:14-23`（pdf:annotation-write listener）、`:26-29`（renderer API）；`app/src/main/main.ts:109`、`:133-148`、`:179-180`、`:206-211`（批注 IPC 转发/超时/回收）；`app/src/main/worker.ts:9`（type）、`:29-41`（writer 桥与注入）、`:68-74`（annotationResult）；`app/src/shared/contracts.ts:2`（type）、`:132`（resolveReference）、`:144`（handleAnnotationWrite）；`app/src/renderer/pdf-annotations.ts:171-184`（写入消费）；`app/src/renderer/AgentPanel.tsx:28`（type）、`:427-435`（预览）；`app/tests/desktop.spec.ts:2015-2035`、`:4882-4925`；`app/tests/pdf-versions.spec.ts:39`（writer 注入） | 旧 ResolvedReference/AnnotationWrite/AnnotationWriter 契约；amw.3 与 ReferenceService、preload/main/worker 批注桥同批删除 |
| `app/src/renderer/LegacyImport.tsx` | `app/src/renderer/App.tsx:45`（import）、`:124`（state）、`:787-788`（设置页入口）、`:828-830`（起始页入口）、`:1094-1096`（JSX）；`app/src/renderer/LegacyImport.tsx:35`（choose("legacy") IPC）、`:37`（scanLegacy IPC）、`:63-65`（importLegacy IPC）、`:79`（cancelCreate 消费）；`app/src/main/main.ts:334-343`（legacy choose handler/type/defaultPath）；`app/src/shared/contracts.ts:149`（choose "legacy" type）；`app/tests/desktop.spec.ts:4031-4178`（3 个 UI 测例）；`app/src/renderer/style.css:778-792`（legacy CSS）；`app/README.md:83`（doc） | `cancelCreate` 本身保留给新工程创建。连带删除 `legacy-imports.json` 读写、Legacy 类型和 scan/import 命令；截图产物不进版本库（amw.5） |
| `app/src/renderer/MappingPanel.tsx` | `app/src/renderer/App.tsx:44`（import）、`:642-646`（JSX 与 4 个回调）；`app/src/renderer/style.css:940-943`（CSS）；`app/tests/desktop.spec.ts:2573`、`:2600`、`:2613`、`:2615`、`:2620`、`:2622`、`:2735-2756`（UI selectors/actions） | 无专属 IPC/preload 通道；组件经泛型 `agent:command`/`agent:changed` 与 parsing 通道调用。amw.4 同步移除 App 挂载、样式和测例 |
| `app/src/renderer/annotation-clipboard.ts` | `app/src/renderer/pdf-annotations.ts:4`（import）、`:139`（复制）；`app/src/renderer/AgentPanel.tsx:25`（import）、`:452`、`:464`（粘贴/复制）；`app/src/renderer/MarkdownDocument.tsx:11`（import）、`:129`、`:140`（粘贴/复制）；`app/tests/desktop.spec.ts:2981-2988`、`:4794-4804`、`:4848-4867` | 导出 copy/copied/setAnnotationClipboard 均服务旧批注链接；新 paper://anchor 不复用相对路径 rebase（amw.3） |
| `app/src/renderer/pdf-annotation-commit.ts` | `app/src/renderer/pdf-annotations.ts:7`（import）、`:28`（调用）、`:201`（并发批注合并路径） | 导出 `preserveConcurrentAnnotationEdits`；grep 与 CodeGraph 均确认唯一消费者为 pdf-annotations，无其他入口（amw.3） |
| `app/src/renderer/pdf-annotations.ts` | `app/src/renderer/PdfReader.tsx:19`（import/type）、`:103-107`（navigate）、`:108`、`:111`、`:139-146`（view/uses）、`:237-242`（构造与保存钩）；`app/src/renderer/pdf-annotations.ts:114-115`（savePdf IPC）、`:171`（handleAnnotationWrite）；`app/src/main/preload.cts:11-29`（preload 批注桥）；`app/src/main/main.ts:109`、`:133-148`、`:179-180`、`:206-211`（IPC）；`app/src/main/worker.ts:29-41`、`:68-74`（writer 桥）；`app/src/shared/contracts.ts:129`、`:144`（IPC/Desktop type）；`app/src/main/project-service.ts:1120-1158`（savePdf）；`app/tests/desktop.spec.ts:4762-5105`（批注/并发/外部冲突/超时） | 导出 connectPdfAnnotations/AnnotationView；amw.3 同批拆除 PdfReader 连接、preload/main/worker 通道与 savePdf |
| `app/src/renderer/pdf-citations.ts` | `app/src/renderer/PdfReader.tsx:16`（import）、`:96`（type）、`:104`（cancel/clearTarget）、`:133`（navigate）、`:243-244`（构造）、`:272`、`:275-276`（取消/右键复制）；`app/src/renderer/pdf-citations.ts:49`（createCitation IPC）、`:52`、`:76`（paper30min-chat-source CustomEvent）；`app/tests/desktop.spec.ts:4548-4708`、`:5107-5366` | 导出 `connectPdfCitations`，唯一生产消费者为 PdfReader；pdf-comparison 仅参考其 EmbedPDF API 用法，代码整文件退役（amw.3） |
| `app/tests/pdf-save.spec.ts` | 无入边 import；`app/playwright.config.ts:5`（testDir 自动发现）；被测对象 `app/src/main/project-service.ts:1120-1158`（savePdf、EPERM 重试 `:1141-1149`）；IPC 类型 `app/src/shared/contracts.ts:129`；fixture 为 legacy/v1 `sample_paper.pdf` | 整文件只测旧 PDF 原生批注保存；原子替换/文件锁测试意图由 project-core 新原子写回归重写，不保留 savePdf 语义（amw.3） |
| `app/tests/pdf-versions.spec.ts` | 无入边 import；`app/playwright.config.ts:5`（testDir）；自身 `app/tests/pdf-versions.spec.ts:6-9` 导入 pdf-tools、ReferenceService、contracts、review-fixture；覆盖 `reference-service.ts:208`、`pdf-annotations.ts:178`、`project-service.ts:790`、`:1154`、`:1424`、`parsing-service.ts:63`；`:51-77` 为旧库导入/relink 幂等测例 | 两个测例均为批注 lineage/引用信任或旧材料导入，全部退役；amw.3 与 amw.5 协调删除，不拆留旧库测例 |
| `app/tests/reference-tools.spec.ts` | 无入边 import；`app/playwright.config.ts:5`（testDir）；自身 `:7-14` 导入 ReferenceService、reference-tools、pdf-tools、annotation-links、citations、review-fixture；`:17`、`:134`、`:200` 三个测例均只测旧 resolve_reference/create_annotation | 整文件废弃，无可保留测例；新 read_source/create_anchor_link/原生文本批注测试由 agent-integration/annotations-results 新写（amw.3） |
| `app/tests/review-fixture.ts` | `app/tests/desktop.spec.ts:16`（import seedParsing/seedBlockParsing）、`:154-161`（reviewed create helper 消费）；`app/tests/mapping.spec.ts:6`（import）；`app/tests/pdf-versions.spec.ts:9`（import）；`app/tests/reference-tools.spec.ts:14`（import）；`app/playwright.config.ts:5` 间接经上述 specs | 两个导出均只生成旧解析/引用数据。amw.5 删除时同步处理 desktop 保留测例的 seed 前置；mapping/pdf-versions/reference-tools 中相应旧测例随各自票据清理 |
| `app/tests/review.spec.ts` | `app/playwright.config.ts:5`（testDir 自动发现，无其他 import）；`app/src/main/parsing-service.ts:80-133`（startReview/completeReviewPage/finishReview/requireReviewed 被测入口）；`app/tests/review.spec.ts:26-33`（内联 mapping/run/candidate fixtures）；`app/tests/review.spec.ts:17`（legacy v1 sample PDF fixture） | 整文件只验证旧逐页审阅与门禁，无保留测例；删除即从测试集合消失（amw.5） |
| `app/skills/paper-map.md` | `app/src/shared/product-skills.ts:2`（catalog）；`app/src/main/product-skills.ts:7`（bundled 目录运行时解析）、`:14-25`（按 catalog 读取）；`app/src/main/agent-service.ts:697`（skill attachment）；`app/src/renderer/MappingPanel.tsx:53`（继续建图 attachment）；`app/src/main/chat-materials.ts:12`（过滤）；`app/tests/mapping.spec.ts:63`（catalog 断言）；`app/tests/desktop.spec.ts:2519`、`:2675`（建图测例） | 无构建拷贝步骤；必须与 catalog 条目同批删除，否则 ProductSkills 读取缺失文件并影响记忆卡片（amw.4） |

## 4. 共享/混合文件的旧核职责与保留职责

| 文件 | 旧核专属职责 | 必须保留的职责 | 结论/接管 |
|---|---|---|---|
| `app/src/shared/contracts.ts` | v1 `Manifest`（`formatVersion: 1`、`paper`、`materials`、`map`、`explanations`、`translations`）；`DocumentRecord`/`annotationSha256`；`DocumentTab`/`ReadingState`/`PdfPosition` 旧单页签阅读状态；`LegacyPdf`/`LegacyLibrary`/`LegacyImportResult`；旧 `Command` 中的 materials/map/citation/reference/legacy/reading 命令；`ChatSession.reviewBatchId`/`mapping`；旧 `AgentCommand` 的 materials/mappingPlan/mapping/review；Citation/Reference/AnnotationWrite 依赖 | IPC/Desktop 骨架；`Preferences`；工程/文件树基础类型；`MarkdownFile`/`MarkdownSave`/`ProjectAsset`；Agent 设置、模型、思考等级、Chat 消息/工具/会话基础字段 | 改造。Phase 0 清旧字段/命令（amw.3/4/5）；project-core 定义 v2 `ProjectManifest`，document-core/agent-integration/workspace 各自补充新类型 |
| `app/src/main/main.ts` + `app/src/main/preload.cts` + `app/src/main/worker.ts` | `pdf:annotation-write/result/cancel` 与 `handleAnnotationWrite`；旧 `project:command` 全量命令；`project:watch` 对 `.paper30min-citations.json` 的旧特例；legacy/material choose；旧 parsing/agent settings 分支；ReferenceService/旧 annotation 写回；旧 `resolveReference` 路由 | Electron 启动与安全窗口配置；协议注册；utility process fork/消息/退出清理；可信 sender 校验；`watchProject`/`watchAgent`；设置存储；openLink/openFile；工程/Agent/解析命令骨架；trash 机制 | 改造。Phase 0 移除 PDF 原生批注与旧命令/旧引用路由（amw.3/4/5）；project-core 重写工程 IPC，agent-integration 重写 Agent 工具路由，pdf-import 重写解析路由 |
| `app/src/renderer/App.tsx` | 阅读导航中的“论文解析/阅读地图/论文精解/全文译文/相关材料”；`LegacyImport` 入口；PDF-only 新建流程；`citationVisit`/`annotationVisit`/`usageVisit` 与 `openCitation`；`saveWorkspace`/`savePdfPosition` 旧 reading 持久化；旧 `manifest.paper/materials/map/explanations/translations` 视图；旧 PDF 引用反查开关 | 应用壳与左右栏；页签条与当前文档；文件树；设置路由；新建/打开/笔记/移动/回收站对话框；错误提示；Markdown/Agent/PDF 宿主；响应式布局与键盘/焦点基础 | 改造。workspace 接管双窗格/页签/恢复（`SPEC-workspace.md:90`）；project-core 接管 v2 创建/打开；Phase 0 删除旧导航、LegacyImport、citation/annotation 导航与旧 reading（amw.3/4/5） |
| `app/src/main/project-service.ts` | v1 清单解析；`materials`/`map`/`explanations`/`translations`；`.paper30min-citations.json` 引用字典；`.paper30min-reading.json`；`scanLegacy`/`importLegacy`/`legacy-imports.json`；PDF 必需创建；解析批次目录/`candidate.md`/`mapping.json`；PDF 原生批注保存 `savePdf`；旧 annotation link 重写；旧 material copy/trash/relink | 相对路径与 Windows 保留名校验；符号链接拒绝；原子 JSON/临时文件/sync/rename；SHA-256；串行写队列；普通 Markdown UTF-8/基线/外部冲突/原子保存；普通文件树 snapshot；最近工程/默认目录；创建目录独占所有权与失败清理；安全 `resolve` | 改造。project-core 重写清单/创建/首次导入/revision/current；document-core 提供 revision 内容；Phase 0 拆旧材料/旧导入（amw.5）、旧引用/映射（amw.3/4）；legacy-projects 只负责旧格式识别/拒绝，不接管旧导入能力 |
| `app/src/main/agent-service.ts` + `app/src/main/agent-tools.ts` | `requireReviewed` 门禁；`complete_review_page`；`paper30min-review`/`paper30min-mapping` 自定义会话条目；建图 `mappingPlan`/`mapping` 流；`resolve_reference` 工具；PDF 原生批注写回；`mapping-*`/`text/candidates` 写作用域；旧 `paper://cite`/`#annotation=` 附件注入 | Pi 原生 JSONL 会话；流式/停止/排队/分支/压缩；模型服务/thinking/vision；凭据去敏；read/write/edit/PowerShell 安全；普通文件基线冲突；web_search/fetch_content；会话恢复与工程搬迁 | 改造。agent-integration 保留会话与普通工具，新增 current/source/correction/result/annotation/verification 工具；Phase 0 删除审阅/建图/旧引用工具（amw.3/4/5） |
| `app/src/main/parsing-service.ts` + `app/src/main/baidu-candidate.ts` + `app/src/renderer/ParsingPanel.tsx` + `app/src/shared/parsing.ts` | `reviewedThroughPage` 门禁；`candidate.md` 正文权威；`mapping.json` + `ParsedBlock` citation；旧 `review`/`verify` 语义；旧 materials 文档选择；旧引用字典写入；旧 `paper://cite` 块链接 | 百度任务阶段机；POST 前“提交中”持久化；提交不明禁止重传；任务号关联；30 分钟查询窗口；取消/停止；有界重试；JSONL 页级/重复页/块顺序校验；资源域名/预算/去敏；图片本地化；PDF 页数核对；上传确认与费用提示；批次记录/恢复/删除 | 改造。pdf-import 保留远程任务与费用保护，改为 PDF/parse snapshot、facts、document tree、diagnostic、verification；移除审阅门禁与 Markdown/citation 权威（`SPEC-pdf-import.md:91`、`:227-238`） |
| `app/src/renderer/PdfReader.tsx` | citation 连接/导航/反查；PDF 原生批注连接/保存；`annotationTarget`/`citationNonce`/`showUses`；旧 `PdfSource.document`/`annotationSha256` 材料身份；旧 `.paper30min-reading.json` 页面位置 | EmbedPDF/PDFium 原页渲染；缩放/旋转/spread/页级滚动；位置捕获与恢复；外部修改提示；页面错误/密码/损坏处理；只读原页视图 | 改造。reader 保留可选原页与独立位置（`SPEC-reader.md:254-260`）；pdf-comparison 后续增加映射/双向同步；Phase 0 删除 citation/PDF 原生批注链（amw.3） |
| `app/src/renderer/MarkdownDocument.tsx` | `paper://cite` 使用高亮/反查；`#annotation=` 链接识别、粘贴 rebase、复制元数据；`sources/` 只读出处字典语义；旧 citation 行号跳转 | CodeMirror 编辑器；read/edit/split；草稿/自动保存/冲突双方查看；图片本地路径解析；Markdown-it + KaTeX 预览；外链受控打开；行尾保真；多标签草稿基础 | 改造。保留普通 Markdown 成果编辑器定位（`SPEC-reader.md:91`）；annotations-results 接管新 `paper://anchor` 链接；workspace 接管多视图共享草稿；Phase 0 删旧引用/批注链接逻辑（amw.3） |
| `app/src/renderer/AgentPanel.tsx` + `app/src/shared/chat-input.ts` + `app/src/shared/markdown-references.ts` | readiness/审阅/建图入口；旧 `resolve_reference` 预览；`paper://cite`/`#annotation=` 来源提取；`sourceSnapshotLabel`；`markCitationUses` 旧使用索引；PDF 原生批注剪贴板 | 持续会话 UI；流式消息/工具轨迹；附件去重/预览/移除；模型选择；Markdown AST 提取；Markdown-it + KaTeX 渲染；外链/来源链接应用内导航基础 | 改造。agent-integration 保留会话/附件/渲染；annotations-results 接管新锚点提取与卡片；Phase 0 删旧来源协议与 PDF 批注剪贴板（amw.3/4/5） |
| `app/tests/desktop.spec.ts` | PDF-only 新建；旧材料/legacy 导入；解析审阅；旧 citation/PDF 原生批注；建图/精解；旧 reading/PDF position；旧 `resolve_reference` | Electron 启动/隐藏窗口/截图；真实窗口与文件系统；模型设置/会话/流式；普通文件与 Shell；Markdown/PDF 阅读基础；工程搬迁/重开；工具安全 | 改造。按 module Testing Strategy 重写为 project/document/arxiv/pdf/reader/annotations/workspace/agent/comparison 套件；Phase 0 先删旧能力用例（amw.3/4/5），旧通过记录不得当新证据 |
| `app/tests/mapping.spec.ts` | `:11-57` 建图发布测例及 `seedBlockParsing` 引用种子 | `:59-73` Product Skills 版本基线、冲突与重开持久化测例 | 改造。amw.4 删除建图测例并把 catalog 断言改为仅“记忆卡片”；文件继续保留 |
| `app/src/renderer/style.css` | `.legacy-*`、`.citation-uses`、`.citation-use-target`、`.mapping-panel`、`.material-row` 等旧选择器 | 应用壳、侧栏、页签、工具栏、设置、通用表单/按钮/模态、布局与响应式基础 | 改造。Phase 0 随旧组件删除旧选择器（amw.3/4/5）；workspace/reader 新增布局样式 |
| `app/src/main/product-skills.ts` + `app/src/shared/product-skills.ts` + `app/skills/memory-card.md` | `paper-map.md` 建图/精解 Skill 与地图描述；memory-card 中对 `resolve_reference`/`read_pdf`/`paper://cite`/“已审阅解析稿”的旧依赖 | Skill 读取/保存/版本校验；`ProductSkill` 接口；memory-card 的“仅整理关注范围、区分事实/理解/推测、默认 `memories/`”意图；`memory-card.md` 保留为显式成果 | 改造/部分废弃。`shared/product-skills.ts` 与 `memory-card.md` 改造；`paper-map.md` 废弃（amw.4）；`main/product-skills.ts` 服务复用 |
| `app/src/shared/parsing.ts` | `ParsingRun.reviewedThroughPage`/`reviewSessionId`；`ParsingMapping`/`ParsedBlock`/`Citation`；旧 `verify` | `ParsingPhase` 任务阶段；`ParsingCommand` 的状态/启动/恢复/停止骨架；预算/诊断语义 | 改造。pdf-import 重写类型，保留阶段/恢复语义 |
| `app/src/shared/markdown-references.ts` | `markCitationUses` 的 `paper://cite` 与 `#annotation=` 使用位置/行号 | `markdownRenderer`（markdown-it + KaTeX）；AST token 渲染基础 | 改造。保留 renderer，删除/替换旧 usage 索引 |

## 5. 不属于 Phase 0 的后续改造

以下 31 个“改造”文件不应在 Phase 0 整文件删除。Phase 0 只按 amw.3/4/5 拆除旧核专属职责并保留可复用基座，不提前实现新核；新清单、文档树、双窗格、来源证据等职责由后续对应 module phase 接管。

### 5.1 project-core

- `app/src/main/project-service.ts`：v2 清单、工程创建/首次导入、source snapshot、revision/current、普通文件树；旧 materials/map/citation/reading/legacy 分支由 Phase 0 删除，但文件主体继续。
- `app/src/shared/contracts.ts`：新 `ProjectManifest`、source/revision、IPC 契约。
- `app/src/main/main.ts`、`app/src/main/preload.cts`、`app/src/main/worker.ts`：新工程命令与 IPC 路由。
- `app/src/renderer/App.tsx`：创建/打开/恢复入口与错误分流。
- `app/src/renderer/style.css`、`app/tests/agent-files.spec.ts`、`app/tests/desktop.spec.ts`：工程回归与样式。

### 5.2 document-core / arxiv-import

- 当前 `app/src` 没有独立的 document-core 或 arxiv-import 实现目录；这两个模块将在后续 phase 新增 `app/src/shared/document/`、`app/src/main/document/`、`app/src/main/arxiv/` 等文件，不在本清单 75 个文件内。
- `contracts.ts`、`project-service.ts`、`worker.ts`、`desktop.spec.ts` 需为新文档树/来源快照/转换器接入预留类型与命令；不得把现有 Markdown/citation 结构机械搬入 document-core。

### 5.3 pdf-import

- `app/src/main/parsing-service.ts`、`app/src/main/baidu-candidate.ts`、`app/src/main/parsing-settings.ts`、`app/src/shared/parsing.ts`、`app/src/renderer/ParsingPanel.tsx`、`app/src/renderer/parsing.css`。
- `app/src/main/pdf-tools.ts` 的 PDF 渲染部分与 `app/src/main/worker.ts` 的解析路由。
- `app/tests/parsing.spec.ts`、`app/tests/pdf-tools.spec.ts`、`app/tests/fixtures/encrypted.pdf`、`app/tests/fixtures/long-150.pdf`。
- 不得恢复 `candidate.md` 正文权威、`reviewedThroughPage` 门禁或正式 PDF 引用字典（`SPEC-pdf-import.md:91`、`:118`、`:450`）。

### 5.4 reader / translation / annotations-results

- `app/src/renderer/PdfReader.tsx`：可选原页、独立位置、后续 pdf-comparison 宿主；不得恢复旧 citation/PDF 原生批注。
- `app/src/renderer/MarkdownDocument.tsx`、`app/src/shared/markdown-references.ts`、`app/src/renderer/AgentMessage.tsx`、`app/src/shared/chat-input.ts`：普通 Markdown 成果与新锚点/卡片；不得改造成主论文正文权威。
- `app/src/renderer/style.css`、`app/src/renderer/markdown.css`（复用但随 reader/results 调整组合）。
- `app/src/` 当前没有 translation 实现；后续新增翻译任务/投影/侧车文件，不在本清单内。不得从旧 candidate/解析稿生成译文权威。

### 5.5 workspace

- `app/src/renderer/App.tsx`：双窗格/页签组/当前窗格/侧边打开/显式副本；删除旧单页签 `saveWorkspace` 与按路径过滤恢复（`SPEC-workspace.md:90`）。
- `app/src/renderer/usePanelLayout.ts`：中栏分栏比例、双窗格独立状态、Agent 宽度本机偏好。
- `app/src/renderer/useMarkdownDocuments.ts`：同路径多视图共享文本、独立光标/滚动/模式、tabInstanceId 草稿。
- `app/src/shared/contracts.ts`：`PageDescriptor`/`TabInstance`/`WorkspaceLayout`。
- `app/src/renderer/style.css`：双窗格布局；旧 `.paper30min-reading.json` 相关样式/入口删除。

### 5.6 agent-integration

- `app/src/main/agent-service.ts`、`app/src/main/agent-tools.ts`、`app/src/main/pdf-tools.ts`、`app/src/main/worker.ts`、`app/src/main/chat-materials.ts`、`app/src/main/preload.cts`、`app/src/shared/contracts.ts`、`app/src/shared/chat-input.ts`。
- `app/src/renderer/AgentPanel.tsx`、`app/src/renderer/AgentMessage.tsx`、`app/src/renderer/AgentSettingsForm.tsx`（复用）。
- `app/src/main/product-skills.ts`、`app/src/shared/product-skills.ts`、`app/skills/memory-card.md`。
- 新工具边界必须按 `SPEC-agent-integration.md:90-103`：`get_document_context`、`read_current`、`read_source`、`create_anchor_link`、`create_correction_candidate`、`save_result`、`create_annotation`、`record_verification`；普通 chat 无写权限，旧 `resolve_reference`/PDF 原生批注不恢复。

### 5.7 pdf-comparison

- `app/src/renderer/PdfReader.tsx` 与后续新增 `app/src/main/pdf-comparison/`、`app/src/shared/pdf-comparison/`、`app/src/renderer/pdf/`。
- 现有 `app/src/renderer/pdf-citations.ts` 仅可参考 EmbedPDF 选择/坐标/瞬态高亮 API，整文件仍废弃（`SPEC-pdf-comparison.md:85`）；不得恢复 `createCitation`、正式引用链接或 PDF 原生批注。
- 映射缓存、`source-region`/`text-region`/`page`/`candidates`/`unmapped`/`stale` 状态在新 module phase 实现。

### 5.8 legacy-projects（待批准）

- `app/src/main/project-service.ts` 的打开/清单读取入口与 `app/src/renderer/App.tsx` 的错误展示：只增加旧 `formatVersion: 1` 识别与拒绝分流（`SPEC-legacy-projects.md:110-118`），不迁移、不转换、不恢复旧能力。
- `app/src/shared/contracts.ts`：仅在现有错误无法表达时补充最小诊断 code（`SPEC-legacy-projects.md:74`）。
- `app/tests/desktop.spec.ts`：新增旧 v2/v1 识别、非破坏性、零任务副作用回归；旧 capability 用例删除，不把“旧文件仍存在”单独当只读证据。
- 因该规格尚未批准，相关工作不得在 Phase 0 以本清单为依据提前实施。

## 6. 待审阅 / 不确定项

1. **`SPEC-legacy-projects.md` 未批准**：旧 `.paper30min-reading.json` 的读取/保存移除（`app/src/main/project-service.ts:34`、`:593-606`、`:1263-1277`；`app/src/renderer/App.tsx:152-171`）在 `SPEC-workspace.md:230` 被明确转交 legacy-projects。该项目前只有“待批准规格 + workspace 转交”支撑，列入待确认；主代理应在 legacy-projects 获批后再确认删除，不得把本清单当授权。
2. **旧 Pi 会话自定义条目**：`paper30min-review`、`paper30min-mapping`、`paper30min-mapping-published` 的清理同时依赖 agent-integration（移除审阅/建图）与 legacy-projects（旧会话不续跑，`SPEC-legacy-projects.md:145`）；需专项报告核对是否还有新核要保留的会话兼容行为。
3. **`app/src/main/turndown-plugin-gfm.d.ts` 与 `turndown`/`turndown-plugin-gfm` 依赖**：pdf-import 若直接把 HTML 表格转换为类型化表格/raw block，可能不再需要 Markdown 表格转换；当前判“复用”是保守结论，待 pdf-import 实现计划确认。若删除依赖，此 `.d.ts` 应同 PR 删除。
4. **`app/src/main/pdf-tools.ts` 的复用边界**：新 `read_source` 需要 `pdf-text`/`pdf-image`/`source-asset` 与 SourceReadReceipt，现有 `read_pdf` 只返回整页 PNG 和定位信息。需确认是“改造”还是“新文件替换 + 旧文件废弃”；当前按 `SPEC-agent-integration.md:88` 判改造。
5. **`app/src/main/reference-service.ts` 中 PDFium 调用的边界**：旧引用专项确认整文件只服务旧 citation/annotation 解析与 PDF 批注写回，判“废弃”。新 `read_source` 的 `pdf-text`/`pdf-image` 由 agent-integration/pdf-import 在 `pdf-tools.ts` 等改造输入上实现；可借鉴底层调用，但不为此保留旧 ReferenceService。
6. **`app/tests/pdf-save.spec.ts` 的文件锁/原子替换用例**：整文件废弃，因为它只验证旧 `savePdf` 原生批注写回。Windows 文件短暂占用、EPERM 有界重试和外部修改不覆盖的测试意图应在 project-core 的清单/普通文件原子写回归中重新覆盖，不保留旧 PDF 写入口。
7. **`app/tests/review-fixture.ts` 的删除闭包**：两路专项对“改造/废弃”意见不同，主对话用 CodeGraph 核对后确认两个导出都只生成旧 `formatVersion: 1` 的 run/mapping/candidate，故判“废弃”。`desktop.spec.ts` 仍经 `create(..., reviewed = true)` 使用 `seedParsing`；amw.5 必须同批删除旧审阅测例或把确需保留的测例迁移到新 snapshot/facts/document tree fixtures，不能留下断 import，也不能为省事恢复旧 helper。
8. **`app/src/main/document-references.ts`**：当前判废弃，但 `ProjectService` 的 `DocumentReferenceProcessor` hook 可能适合承接新 `paper://anchor` 保存前校验。若保留 hook，应重写实现并改名，不沿用旧 `paper30min-source:` 协议。
9. **`app/src/renderer/AgentMessage.tsx` + `app/src/shared/chat-input.ts` 的链接协议**：两者保留通用渲染/AST 能力，但旧 `isSourceLink`、`sourceSnapshotLabel`、`paper://cite`/`#annotation=` 全部需要替换。需 annotations-results 专项确认新 `paper://anchor` 在聊天/成果中的展示与点击边界。
10. **`app/skills/memory-card.md`**：判改造而非复用，因为正文仍要求 `resolve_reference`、`read_pdf`、`paper://cite/...` 和“已审阅解析稿”。需 agent-integration/annotations-results 专项给出新版提示词，不得只改 Skill 名称而保留旧工具链。
11. **`app/src/renderer/style.css` 的旧选择器删除时机**：文件混合通用布局与旧 `.legacy-*`/`.citation-*`/`.mapping-*`/`.material-*`。需与 App/MappingPanel/LegacyImport/PdfReader 删除同 PR，避免遗留死样式或误删通用样式。
12. **`app/tests/` 对 `legacy/v1/app/src-tauri/tests/fixtures/` 的依赖**：`desktop.spec.ts:227`、`:288`、`:489`、`:1954`、`:2044`、`:2098`、`:2146`、`:2378`、`:2695`、`:2705`、`:2781`、`:3938`、`:4979`；`parsing.spec.ts:30`、`:93`、`:336`、`:420`、`:455`、`:567`、`:573`；`pdf-tools.spec.ts:92`、`:220`、`:250`；`pdf-versions.spec.ts:23`；`reference-tools.spec.ts:22`、`:139`。这些 fixture 位于 `legacy/v1/app/`，不在本次盘点范围，但被新版测试直接读取；Phase 10 删除旧客户端前必须把所需样本迁入 `app/tests/fixtures/` 或改为新受控 fixtures，否则会造成测试失效。此项是覆盖风险，不是本清单遗漏。
13. **`app/src/main/agent-settings.ts`、`parsing-settings.ts` 的本机配置迁移**：两者含旧单模型/旧格式本机配置兼容分支（`agent-settings.ts:55-94`、`parsing-settings.ts` 的 formatVersion 1）。它们不属于工程旧格式，当前判复用；若后续统一设置 schema，应单独评审，不纳入旧核退役。
14. **`app/src/shared/pdf-versions.ts` 的字节相等判断**：专项确认两个导出均只服务旧材料 relink、旧库幂等和批注 lineage，整文件废弃。新 pdf-import 的“相同字节复用快照”应在新 source snapshot 契约中直接按 SHA-256 实现，不抽取这套带旧批注信任语义的 helper。
15. **`app/src/shared/product-skills.ts` catalog 收缩时机**：`paper-map.md` 条目删除会同步影响 `ProductSkills.list()`、`chat-materials.ts:12` 过滤和测试；需与 MappingPanel/agent-service 建图分支同一变更，避免运行期读取已删除 Skill。
16. **统计口径排除项**：`app/package.json`、`package-lock.json`、`dist/`、`test-results/`、`playwright-report/`、`tmp/`、日志文件未逐文件分类；若后续要求“所有可构建输入”包含依赖清单，应另表补充，不能从本表推断已覆盖。
17. **amw.5 预设与代码证据冲突**：删除票文字点名整删 `chat-materials.ts`，但该文件包含新 agent-integration 仍需的 document/Skill 枚举和通用附件准备，专项与全量普查均判“改造”。执行 amw.5 前应以本清单修正删除范围，只剥离旧 source/material 分支，不得为满足预设文案破坏通用能力。
18. **旧导入文档入口**：`app/README.md:83` 仍描述旧导入；它不属于本次源文件/测试分类全集，但 amw.5 实施时应同步修订，避免代码删除后文档继续承诺旧能力。

## 7. 覆盖核对方法

### 7.1 实际使用的全集获取命令

在仓库根目录执行：

```bash
find app/src -type f | sort
find app/tests -type f | sort
find app/scripts app/skills -type f | sort
```

并显式核对 `app/playwright.config.ts`、`app/vite.config.ts`、`app/tsconfig.json`、`app/tsconfig.node.json`、`app/index.html`。

### 7.2 实际数量

- `app/src`：52 个文件（`main` 19、`shared` 10、`renderer` 23；其中 CSS 5 个）。
- `app/tests`：14 个文件（10 个 `*.spec.ts`、1 个 `review-fixture.ts`、1 个 `.gitattributes`、2 个 PDF）。
- 构建/测试辅助：9 个文件（2 个脚本、4 个配置、1 个 HTML 入口、2 个 Skill 提示词）。
- 合计 75 个文件；分类计数见 1.2。

### 7.3 交叉核对（本次实际执行）

- 以 `find` 得到的三组路径为基准，逐项检查本文件第 2 节表格中是否存在且仅存在一条对应行；同时反向检查第 2 节是否出现 `find` 之外的路径。
- **实际结果：** 范围全集 75 个文件；第 2 节表格 75 行；缺失 0；范围外路径 0；重复路径 0。专项对账后，第 2 节分类计数为复用 23、改造 31、废弃 21，与 1.2 统计表一致。
- 对 21 个废弃文件执行静态检索与 CodeGraph 调用闭包交叉核对：检索 `from "…<module>"`、`import type`、`require`、导出符号、IPC 命令 `type: "<name>"`、preload 通道名、测试 import 与 Playwright `testDir` 自动发现；结果写入第 3 节。构建范围统一由 `app/tsconfig.json` 的 `include`（`src`、`tests`、`playwright.config.ts`、`vite.config.ts`）与 `app/tsconfig.node.json` 的 `include`（`src/main`、`src/shared`）覆盖；`app/index.html` 是 renderer 构建入口。
- 对共享/混合文件逐个人工阅读旧职责与保留职责，记录在第 4 节；没有用“无 import”或“单个旧 export”直接判废弃。
- **主对话最终复核：** Node 脚本确认范围全集 75 个文件、第 2 节 75 行，分类为复用 23／改造 31／废弃 21，缺失、范围外、重复均为 0，且 21 个废弃文件在第 3 节均有引用点条目；另校验 117 个带 `app/` 路径的代码行号引用及全部 `SPEC-*` 行号引用，文件均存在且行号未越界。`git diff --check` 与针对新文档的 `git diff --no-index --check` 无空白错误，仅有 LF→CRLF 转换提示。
- 未运行 `npm run typecheck`、`npm run build`、`npm test` 或 Electron 回归：本任务只产出分类清单，未修改代码；这些检查不能记为本清单已通过，需由后续实现 PR 执行并记录。
- 未穷举用户历史数据中的任意动态路径或 `legacy/v1/app` 内部实现；代码内已知运行时拼接、协议字符串和目录读取入口已纳入第 3 节。`legacy/v1/app` 内部不属于本次盘点范围。第 6 节第 12 项已记录 `app/tests` 对旧客户端 fixtures 的实际依赖，属于后续迁移风险而非本次遗漏。