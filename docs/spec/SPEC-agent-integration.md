# Spec: agent-integration

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[document-core](SPEC-document-core.md)、[pdf-import](SPEC-pdf-import.md)、[annotations-results](SPEC-annotations-results.md)（均已批准）  
> 协同：[reader](SPEC-reader.md)、[translation](SPEC-translation.md)、[workspace](SPEC-workspace.md)（均已批准）  
> 下游：`pdf-comparison`、`legacy-projects`

## Objective

保留 Paper30Min 的 Pi 原生持续会话、右侧 Agent、模型配置、普通文件工具和网络调研能力，并把它们接入新的 current 文档树、双语言选区、工作区窗格、Markdown 成果和实际来源证据。人与 Agent 读取同一 current 投影，不再维护另一份 Agent 专用解析稿。

普通解释、总结和讨论不需要 PDF 已核验，也没有完整 LLM 审阅门禁。只有逐字引用、公式／数字精确核对、声称已对照来源、显式原文修正和核验记录等任务需要更严格的来源与授权证据。无法补查时，Agent 必须说明限制，不能编造来源或核验状态。

本模块成功时，应满足：

- 选区“解释／提问”进入右侧持续对话，默认携带选区与结构上下文，Agent 可按需读取 current 其他范围，不生成独立问答卡。
- 只有用户明确要求保存时，Agent 才生成普通 Markdown 笔记、精解、记忆卡片或原生批注；没有地图发布流程。
- Agent 可以形成结构化原文修正候选，但只有用户预览确认后才能推进 current。
- 精确任务具有实际来源读取记录；Agent 核验只能覆盖证据支持的范围，普通回答不附带笼统警告。
- 云端解析、重解析、全文翻译／重译和来源下载仍由专门界面启动，Agent 不能在对话中自行产生这些费用。

## Scope

### In scope

- Pi JSONL 会话、右侧持续对话、停止、分支、压缩、重开和模型配置。
- 当前窗格、当前正文、选区、译文摘录和显式附件上下文。
- current outline／unit／range 读取和来源快照读取的工具边界。
- 普通讨论、精确任务、来源补查和无法补查时的行为。
- 结构化原文修正候选、changeset 预览、用户确认发布和基线冲突。
- 显式 Markdown 成果与原生批注创建、锚点链接生成和校验。
- Agent 核验任务的主进程来源证据、实际覆盖范围和 recordVerification 调用。
- 普通文件 read／write／edit、受限 PowerShell、web_search／fetch 的既有安全边界。
- 会话中的 revision、来源、任务授权和工具回执记录。

### Out of scope

- 文档树、翻译生成、卡片扫描、双窗格布局和 PDF 同步的内部实现。
- arXiv／PDF 导入、云端解析、全文翻译和来源下载任务的拥有权与费用界面。
- 正文渲染和修正候选视觉预览，属于 `reader`。
- 完整 LLM 逐页审阅、阅读地图、自动论证关系和独立问答卡。
- 旧 `resolve_reference`、PDF 原生批注、正式 PDF 引用字典和材料登记。
- 通用自主后台 Agent、无人值守任务和跨工程写入。
- 旧会话与引用迁移，属于 `legacy-projects`。

## Tech Stack

- 沿用 `@earendil-works/pi-coding-agent`、Pi 原生 JSONL 会话、TypeScript、Node.js utility process 和 React 右侧 Agent。
- 沿用现有模型服务、thinking／vision 配置、`userData` 凭据保护与 `safeStorage`。
- document-core 的 Reader／Agent 文本投影、稳定 ID 和结构化修正命令。
- pdf-import 的 PDF 原页读取与 SourceReadReceipt；arxiv-import 的不可变 HTML 快照与资产。
- annotations-results 的锚点 URL、原生批注命令和 Markdown AST 校验。
- 现有普通文件 read／write／edit、Windows PowerShell job 和 Web 工具；不恢复旧引用服务，不引入第二套 Agent 框架。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron、受控模型和工具回归：

```powershell
npx playwright test -g 'agent-integration'
```

默认使用脚本化模型响应、受控工具、临时工程和本地来源 fixtures，不调用真实模型、arXiv、百度或搜索服务。真实模型验收单独记录模型、任务、工具轨迹和未解决限制，不能把脚本化工具调用当作模型质量或所有自然语言场景已验证。

## Project Structure

### 仓库代码边界

```text
app/src/main/agent/          Pi 会话、任务上下文、授权和运行时编排
app/src/main/agent/tools/    current、来源、修正、成果和核验工具
app/src/shared/agent/        任务、附件、证据和 IPC 类型
app/src/renderer/            右侧对话、附件、候选确认和来源状态
app/tests/fixtures/agent/    脚本化模型、工具调用和会话 fixtures
app/tests/                   授权、工具、恢复和真实 Electron 回归
```

现有 `agent-service.ts`、`agent-tools.ts`、`pdf-tools.ts` 和 `AgentPanel.tsx` 是改造输入。`requireReviewed`、`reviewBatchId`、`complete_review_page`、mapping 发布、旧 `resolve_reference` 和 PDF 原生批注链路退出新核；普通会话、停止／分支／压缩和工具安全机制可以保留。

### 工具边界

| 工具                          | 责任                                              | 不写／不能替代                                   |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `get_document_context`        | 当前 revision、元数据、章节路径、选区和相邻上下文 | 不默认附全文，不读 source-base                   |
| `read_current`                | 按 anchor／range 读取 current 文本、atom 和结构   | 不等于已读来源快照                               |
| `read_source`                 | 读取指定 HTML／PDF 来源并生成 SourceReadReceipt   | 不读取普通参考文件冒充主来源，不自动下载／重解析 |
| `create_anchor_link`          | 从已验证 ReaderSelection 生成规范 URL             | 不让模型手编 base64／ID                          |
| `create_correction_candidate` | 生成结构化修正候选与 changeset                    | 不推进 current                                   |
| `save_result`                 | 显式保存普通 Markdown 成果并校验锚点              | 不写受管正文，不创建地图                         |
| `create_annotation`           | 显式创建原生高亮／批注                            | 不写 PDF 原生批注                                |
| `record_verification`         | 按实际来源证据记录覆盖范围                        | 不接受 Agent 自述代替证据                        |

既有 `read`、`write`、`edit`、`bash`、`web_search`、`fetch_content` 保持普通文件与网络用途，不成为绕过上述专用命令的通道。`publishCorrectionCandidate` 是用户界面命令，不注册给 Agent。

## Code Style

任务和来源证据使用主进程生成的可验证记录：

```ts
export interface AgentTaskContext {
  taskId: string;
  sessionId: string;
  baseRevision: string;
  action: "chat" | "correct" | "save-result" | "annotate" | "verify";
  selection?: ReaderSelection;
}

export interface SourceReadReceipt {
  id: string;
  taskId: string;
  sessionId: string;
  sourceSnapshotId: string;
  baseRevision: string;
  modality: "source-text" | "pdf-text" | "pdf-image" | "source-asset";
  pages?: number[];
  sourceAliases?: string[];
  contentSha256: string;
}
```

- `action` 由实际用户任务和命令入口决定，模型不能仅通过自述提升权限。
- receipt 绑定实际提供给模型的内容、来源快照、任务、session 和模态；普通 `read_current` 不生成 SourceReadReceipt。
- `baseRevision` 表示任务开始时的 current；来源快照自己的 ID 与 revision 不可互换。
- 会话可以保存 receipt 引用和安全元数据，不保存 Authorization、签名 URL、代理或 API key。
- Node ESM 相对导入沿用 `.js` 后缀，共享类型不得导入 Node 或 React 模块。

## Behavior Contract

### 1. 持续会话与右侧交互

1. Pi 原生会话继续保存在工程 `.pi/sessions/`，支持创建、列表、重开、停止、排队、压缩和普通分支；不引入旧审阅／建图会话类型。
2. 右侧 Agent 独立于中栏双窗格，展开／收起、切换页签或打开成果不会清空当前输入、附件或会话。
3. 普通会话不再在每次发送前调用 `requireReviewed`。未核验 PDF 解析稿、arXiv HTML 和本地修正都可以直接讨论。
4. 会话消息与工具记录不可变追加。每条新任务记录当时的 baseRevision、当前页签和显式附件，旧任务不会被改写成新 revision 的内容。
5. current 更新后，新消息使用新 current；历史选区和 quote 按 changeset 显示变化，不用旧 revision 静默覆盖新正文。
6. 普通分支继承对话历史，不继承旧任务的写入授权或自动回滚 current。新分支中的修正、保存和核验仍需当前用户任务授权。
7. 压缩和重开保留可恢复的任务／receipt 引用；模型不得把摘要中的“已读取”当作新任务的实际来源证据。
8. 停止会中止可取消工具与模型流，已产生的模型费用不能撤回；迟到的工具结果不能写入新任务或 current。
9. 未配置模型时只禁用 Agent 请求，正文、成果和其他工作区功能继续可用。

### 2. 默认上下文与显式附件

1. 选区“解释／提问”创建或聚焦持续会话，默认提供：
   - 当前 baseRevision、paperId、当前页签与语言视图。
   - ReaderSelection、所在完整 unit、章节路径和必要的相邻单元。
   - 文档标题与结构 outline，便于 Agent 按需扩展。
2. 不默认附整篇论文。`read_current` 用于读取指定 section／unit／sentence／atom／block 或明确的更大范围，并受模型上下文预算约束。
3. 原文选区提供原文 range 与 quote；译文选区同时提供译文摘录、translationRevision 和对应原句／单元，不把译文偏移当原文偏移。
4. 普通对话提供当前页签与结构上下文；没有选区时不伪造选区。用户可以显式附加其他普通文档、成果或来源。
5. workspace 焦点变化只影响下一次显式操作的默认上下文，不替换已发送附件。用户发送前可以查看、移除或追加附件。
6. 附件在消息界面显示来源标签和预览，不把大段来源快照伪装成用户手写消息；模型输入仍保留完整已验证内容。
7. 附件包含稳定 ID、revision 和内容摘要，异步准备完成后再次校验；current 已变化时提示重取，不静默附加到新 revision。
8. `tmp` 候选和普通成果可以由用户显式附加，但 Agent 不得因读到其内容就将其登记为正式成果或正文。

### 3. current 读取与 Agent 文本投影

1. `get_document_context` 与 `read_current` 均来自 current Reader／Agent 投影，包含稳定节点 ID、公式、表格、图注和 unresolved 诊断。
2. Agent 不直接读取 `document.json` 或 `source-base.json` 作为普通文本文件，也不读取旧 candidate.md 作为另一份正文。
3. 读取范围按 anchor 和 document-core 逻辑偏移解析；越界、removed 或 quote 不符时返回明确状态，不模糊寻找相似段落。
4. `read_current` 只证明 Agent 读取了当前阅读权威，不证明它对对照始 HTML／PDF，不生成 SourceReadReceipt。
5. Agent 可以使用确定性的全文搜索或 outline 定位，再把准确 anchor 交给 read_current；搜索结果本身不是正文证据。
6. 普通解释、总结和讨论可以直接使用 current，包括尚未核验的 PDF 解析树。无需在每条回答附加“尚未完整审阅”等笼统警告。
7. 如果任务涉及本地修正，current 投影与来源快照的差异必须可区分，不能把 source-base 或上游原文当作用户修正后的 current。

### 4. 来源读取与证据

1. `read_source` 只接受当前论文来源谱系中的 sourceSnapshotId 和明确范围，不接受任意普通 PDF 或文件路径冒充主来源。
2. 对 arXiv HTML，主进程返回对应原始 HTML 片段、source alias、LaTeX／MathML 和必要的本地原始资产；不执行 HTML，也不以 current 转换树代替来源。
3. 对 PDF，主进程可以返回：
   - 实际 PDF 文本层及页码／几何信息（`pdf-text`，若存在）。
   - PDFium 实际渲染的完整页或经校准区域图像（`pdf-image`）。
   - 需要对照的原始嵌入资产（`source-asset`）。
4. 扫描 PDF 没有可用文本层时，不得用 OCR 或解析树冒充原 PDF 文本层。视觉模型不可用时，需要图像核验的任务必须报告无法完成，不能谎称看过原页。
5. 每次读取生成 SourceReadReceipt，记录 taskId、sessionId、sourceSnapshotId、baseRevision、模态、页／alias 范围和实际内容摘要。
6. receipt 由主进程生成并关联实际工具结果，模型不能手写 ID。停止、工程切换或来源摘要变化后，旧 receipt 不得用于新任务。
7. 来源读取可以分批，实际覆盖范围是各 receipt 的并集；未读取的页、单元格、公式或段落不得被说成已覆盖。
8. `read_source` 不自动下载缺失 PDF、重解析、翻译或调用其他付费服务。来源不可用时返回可行动限制。
9. Web 搜索与外部网页可以提供外部事实，但不能替代本论文对应来源的补查，也不能生成论文核验 receipt。

### 5. 精确任务与无法补查

1. 以下任务需要 read_source 的实际证据：
   - 逐字引用、声称逐字／逐项核对、公式或数字的精确比较。
   - 声称“已对照原文／原页／来源”、建立 Agent 核验记录。
   - 需要判断来源图像、表格单元、符号或排版是否与 current 一致的任务。
2. 用户以“核验”“逐字引用”“对照原页”等明确动作发起时，宿主将任务标为 source-required；Agent 也必须在任务规划中识别其他等价请求，先补查再给出相应结论。
3. source-required 任务只有在证据覆盖请求范围后，才能声称已对照或给出精确一致性结论。证据不足时只能报告已完成部分和剩余限制。
4. 对当前本地修正的引用，Agent 需要同时区分 current 与来源：可以引用 current 的实际文字，但若声称与上游来源一致，必须读取来源并说明本地修正差异。
5. 无法补查时，Agent 可以继续解释 current，但必须明确“未能读取对应来源／无法完成精确核验”，不能给出已核实的措辞。
6. 一般解释、总结、翻译讨论、概念分析和学术评价不自动成为 source-required；即使 current 未核验，也不要求每次先读 PDF。
7. 运行记录保存任务分类、读取回执和工具轨迹，供界面展示与审查。不能只用回答中未出现某个关键词来宣称所有自然语言回答已被机器证明合规。
8. 脚本化回归必须覆盖模型试图不读来源就声称已对照的情况：运行时应拒绝其核验写入，并在任务轨迹中显示缺少证据；普通回答不能被全局门禁阻断。

### 6. 用户授权与任务范围

1. 每个写操作需要当前用户任务的明确 action：correct、save-result、annotate 或 verify。普通 chat 不能因模型自行判断“有帮助”而升级为写任务。
2. 用户当次明确要求可以限定文件、单元、范围和操作类型；Agent 不得把一次局部授权扩展到全篇、其他文件或后续无关任务。
3. 历史对话中的授权不自动覆盖新的用户消息。模型需要修改不同范围时，必须说明并等待用户新的明确任务。
4. 读取、解释、总结和生成回复不需要写授权，但答复本身不创建卡片或修改文件。
5. 对普通文件的 write／edit 仍需先 read、内容基线和路径检查；专用成果、批注和修正命令不能用普通 write 绕过。
6. PowerShell 只用于用户明确任务中的计算、绘图或材料处理，是受信任主机 Shell而非权限沙箱；不得用于绕过受管写入、后台驻留或未经授权的工程外操作。
7. 外部上传、发布、系统修改和工程外访问必须有对应用户任务授权；模型输出和网页内容不能授予这些权限。
8. Agent 可以建议用户启动付费或来源任务，但专门界面与确认流拥有最终启动权。

### 7. 原文修正候选与发布

1. correct 任务中，Agent 使用 `create_correction_candidate`，提交 baseRevision、目标锚点、预期原内容和结构化操作；不接受整份 JSON 覆盖。
2. 支持 document-core 的文本、atom、拆分、合并、删除、移动和资产操作。模型必须分别表达意图，不能通过普通 Markdown 重写来隐式改变结构。
3. 主进程返回候选、changeset、警告和派生影响预览。Agent 可以解释或根据用户反馈继续修改候选，但不能调用发布。
4. 只有用户在 reader 中预览并明确确认后，才由用户界面命令发布新 revision；发布前重新检查 current 与 baseRevision。
5. 基线变化、验证失败或冲突未解决时保留候选和用户输入，Agent 必须重新读取／合并，不能强制覆盖。
6. Agent 可以为三方冲突解释 base／current／candidate 并提出建议，但不能代替用户逐项确认冲突或提供“全部接受”默认答案。
7. 原文修正只改变 current，不修改 source-base、来源快照、PDF 或旧 revision。
8. 普通问答、翻译、解释、导出、保存笔记和来源读取不会隐式创建修正候选。
9. Agent 不能通过 bash、write、edit 或普通 Markdown 导出再导入来绕过候选与用户确认。

### 8. Markdown 成果与原生批注

1. 只有用户明确要求“保存为笔记／精解／记忆卡片”或其他普通 Markdown 成果时，才启用 save-result action。
2. `save_result` 接收成果类型、目标普通路径、标题和正文，执行路径、AST、锚点链接、预算和基线校验。默认目录为 notes／explanations／memories，用户也可指定其他普通位置。
3. Agent 使用 `create_anchor_link` 从已验证 ReaderSelection 获取链接，再插入 Markdown；不手编 base64、node ID、paperId 或旧 PDF 引用。
4. 覆盖已有成果前必须 read 并使用内容基线；外部冲突保留双方内容，不能覆盖用户草稿。
5. `tmp` 可用于明确候选，但不会自动形成正式成果卡片。只有用户明确保存到普通位置才进入 annotations-results 扫描。
6. 保存成功后返回真实路径与卡片解析结果；失败不得伪报已保存或已发布。没有 map／目录登记和地图发布步骤。
7. 原生高亮／批注只在 annotate action 中通过 annotations-results 命令创建；不得写入 PDF 原生批注或旧 `#annotation=` 链接。
8. 选区提问、Agent 回复和会话历史本身不生成独立问答卡，只有明确保存的 Markdown 或原生批注才成为阅读积累。
9. Agent 生成成果时可以使用 current 与外部资料，但外部链接与论文文本锚点必须区分；不得把网页内容冒充论文原文。

### 9. Agent 核验

1. verify 任务必须具有明确范围、baseRevision 和目标 PDF 快照。Agent 先 read_current 确定 resolved coverage，再 read_source 获取对应来源。
2. `record_verification` 只接受主进程生成且覆盖请求范围的 receipts、ReaderSelection／resolved coverage 和 session／task ID。
3. 主进程校验每个节点的内容摘要、PDF 快照、页／区域、模态和当前 baseRevision；自述、普通 read_current、旧会话摘要或其他 PDF 的 receipt 无效。
4. 对纯文本层可证明的文字任务，pdf-text 可以作为证据；公式、图像、扫描页、表格视觉归属和声称已看原图的任务需要相应 pdf-image／source-asset。
5. 只能记录实际读取并完成的范围。一个 section 只核验了部分 unit 时，不能标记整个 section；新增句和未读句始终不在覆盖内。
6. 核验中途停止或来源不足时，可以保存已完成的精确范围，但必须向用户说明未覆盖部分，不能报告全任务完成。
7. current 已变化时旧 receipt 不再用于新核验；需要按新 baseRevision 重新读取 current 和来源。
8. 核验记录不会解锁普通 Agent 使用，因为普通使用本来就没有门禁；它也不会豁免后续精确任务的当次来源补查。
9. Agent 不能直接编辑 `verification.json`、伪造 receipt 或把用户核验改写成 Agent 核验。

### 10. 付费与来源任务边界

1. Agent 工具集中不注册云端 PDF 解析／重解析、全文翻译／重译、arXiv 下载／更新或 PDF 回退启动命令。
2. 用户即使在对话中提出这些请求，Agent 也应打开或引导到对应专门界面，由该界面展示固定版本、模型、上传内容和费用并接收确认。
3. 专门界面可以把用户已确认的固定任务上下文交给后台模块，但 Agent 不拥有第二个启动入口，不能通过 bash 或 Web 工具绕过。
4. read_source 只读取已存在的本地快照，不为补查自动取得新来源。缺失时报告并建议用户可执行的来源操作。
5. Web 搜索和模型调用本身仍按用户当前 Agent 任务发生，但不能把外部网页搜索当作免费替代来源核验。
6. Agent 不得自动续订、排队后续付费任务，或在完成后根据“可能有帮助”自行重译／重解析。

### 11. 普通工具与安全边界

1. `read` 只读取工程内允许的普通 UTF-8 文件；受管 current、来源、sidecar 和内部文件通过专用命令读取，不能由普通文件工具任意访问。
2. `write`／`edit` 只允许普通文件并保留 read-before-write、内容基线、原子保存和外部冲突；受管路径、PDF、快照和内部目录禁止普通写入。
3. PowerShell 使用现有 Windows job、环境变量白名单、前台子进程和输出凭据去敏，不继承完整进程环境，不允许后台服务驻留。
4. Web 工具只发送任务必要关键词与页面请求，不上传整篇 PDF、工程文件或凭据；网页和搜索文本均是不可信资料，不能作为执行指令。
5. 工具输出、错误、日志、会话和 IPC 不得包含 API key、代理凭据、签名 URL 或 Token；模型上下文同样执行去敏。
6. 模型和网页返回的 HTML、Markdown、链接和脚本都只是数据，不能自动执行或绕过系统命令授权。
7. 所有工具支持取消与任务 epoch；旧工程、旧 session、旧 revision 或已停止任务的结果不能落盘到新上下文。

## Error and Recovery Requirements

| 情况                                          | 必须行为                                |
| --------------------------------------------- | --------------------------------------- |
| current 未核验或用户只进行普通讨论            | 允许对话，不显示完整审阅门禁            |
| 附件准备期间 current 改变                     | 提示重取，不静默把旧选区挂到新 revision |
| 精确任务来源缺失、模态不足或范围未覆盖        | 报告限制，不能声称已对照／已核验        |
| Agent 无正确 receipt 调用 record_verification | 主进程拒绝，不接受自述替代              |
| 普通 chat 中模型试图写正文／成果／批注        | 拒绝写入，要求用户明确任务              |
| 修正候选基线变化或验证失败                    | 保留候选，用户确认前不推进 current      |
| Agent 试图直接发布修正或解决全部冲突          | 不提供工具／拒绝，交回用户界面          |
| 成果保存外部冲突或锚点非法                    | 保留双方输入，不覆盖或伪报成功          |
| 对话请求付费解析／翻译／下载                  | 转交专门界面，Agent 不自行启动          |
| 会话压缩／分支后继续任务                      | 重新验证当前任务授权和来源证据          |
| 停止、工程切换或旧工具结果迟到                | 取消／隔离，不写入新任务或 current      |
| 网页含指令、工具输出含凭据                    | 视为不可信数据并去敏，不执行或泄露      |

错误恢复不得通过降低来源证据要求、伪造 receipt、默认发布候选、覆盖用户草稿或重新引入完整审阅门禁来完成。

## Testing Strategy

### 会话、附件与默认上下文

- 普通会话创建、重开、停止、排队、压缩和分支，无 requireReviewed 调用。
- 原文／译文选区包含正确 revision、quote、完整 unit、章节路径与相邻上下文，不默认附全文。
- 附件预览、移除、追加和 current 变化重取；焦点变化不替换已发送附件。
- 历史会话与分支不重写 revision，写入授权不被历史摘要继承。
- 未配置模型不影响正文和工作区，停止后的旧结果不落盘。

### current 与来源工具

- read_current 返回同一 current 投影、稳定 ID 与复杂内容，不能读取 source-base／旧 candidate.md。
- arXiv HTML 来源片段、公式、资产和 alias 来自真实快照，不执行 HTML。
- PDF 文本层、整页／区域图像和扫描页无文本层分别处理，模态和 receipt 正确。
- 非视觉模型需要图像时得到明确限制，不以 OCR／解析树冒充原页。
- receipt 绑定任务、session、来源、revision、模态与实际内容，旧 receipt 不可跨任务复用。
- Web 搜索结果不能替代论文来源或生成核验 receipt。

### 精确任务与核验

- 普通解释、总结和讨论无需 read_source，不出现笼统审阅警告。
- source-required 任务先读取来源；范围不足只能报告部分完成，无法补查时说明限制。
- 本地修正同时区分 current 与来源，不把上游旧文当作 current。
- 模型无证据声称已对照时，record_verification 被拒绝且轨迹可见，普通回答不被全局阻断。
- section 部分覆盖、句子新增、模态不足、baseRevision 改变和停止后的记录边界。
- 核验不会解锁任何普通功能，也不豁免后续精确任务补查。

### 授权、修正与成果

- 普通 chat 写操作被拒绝；correct／save-result／annotate／verify 仅在明确任务启用。
- create_correction_candidate 校验锚点与预期内容，Agent 无发布工具，用户确认后才推进 current。
- 基线冲突、验证失败、三方冲突和候选保留。
- 不能通过 write／edit／bash 绕过受管修正与成果命令。
- save_result 只在明确保存时写普通 Markdown，链接由 create_anchor_link 生成，外部冲突保留双方。
- 原生批注不触碰 PDF，tmp 不自动成为成果，地图和独立问答卡不出现。
- 对话请求付费任务只进入专门界面，工具集中没有隐藏启动入口。

### 真实 Electron 与工具轨迹回归

通过生产 preload、IPC、Pi 会话、脚本化模型和真实临时工程验证：

1. 未核验 PDF 与 arXiv 工程可直接对话、选区提问、读取 current，无审阅门禁。
2. 原文／译文附件、当前窗格变化、右侧 Agent 收起与重开恢复。
3. 精确任务来源读取、无法补查、实际核验范围和非视觉模型限制。
4. Agent 修正候选、用户预览确认、基线冲突与停止恢复。
5. 显式保存笔记／精解／记忆卡片、锚点卡片、外部冲突和原生批注。
6. 对话请求付费任务被引导到专门界面，Agent 无重复费用入口。
7. 会话压缩、分支、工程搬迁和旧任务结果隔离，无凭据进入会话或日志。

真实模型只用于额外行为验收，不能用一次成功对话证明所有精确表达都被可靠识别；未验证的自然语言边界必须记录。

## Boundaries

### Always do

- 保留 Pi 持续会话与右侧交互，以 current 为唯一 Agent 正文权威。
- 默认提供选区＋结构上下文，按需读取更大范围。
- 普通讨论无审阅门禁，精确任务使用真实来源证据并说明限制。
- 将原文修正做成候选，由用户预览确认后发布。
- 只有明确任务才写成果／批注／核验，付费任务只从专门界面启动。
- 记录任务授权、来源回执和实际覆盖范围，保护凭据与用户草稿。

### Ask first

- 允许 Agent 直接发布 current、逐项确认冲突或启动付费解析／翻译／下载。
- 默认每次附全文、引入自主后台任务或跨工程写入。
- 放宽来源证据、视觉模态、工具路径、Shell 或外部上传边界。
- 引入模型辅助重锚、旧 PDF 引用工具、地图发布或独立问答卡。
- 修改会话中的任务授权、receipt 或候选确认协议。

### Never do

- 在每次发送前要求完整 LLM 审阅，或把未核验 current 禁止交给 Agent。
- 把 read_current、Agent 自述、旧会话摘要或网页搜索当作来源核验证据。
- 让 Agent 直接覆盖 document.json、source-base、PDF、sidecar 或普通用户文件。
- 让 Agent 绕过用户预览发布修正，或替用户默认接受冲突。
- 在普通讨论中自动写成果／批注，或让选区提问生成独立问答卡。
- 通过 bash、write、edit、Web 或第二入口启动付费任务、绕过专用命令。
- 声称读取未提供的来源、看过未提供的图像或覆盖未实际核验的范围。
- 将 API key、签名 URL、代理或 Token 写入会话、工具输出、日志或工程配置。

## Success Criteria

- [ ] Pi 会话与右侧 Agent 保留，普通讨论不再调用完整审阅门禁。
- [ ] 选区默认携带原文／译文与结构上下文，Agent 可按需读取同一 current，不默认附全文。
- [ ] read_current 与 read_source 职责和证据严格区分，receipt 绑定真实内容与任务。
- [ ] 精确任务无法补查时明确限制，Agent 核验只覆盖实际证据范围，普通回答无笼统警告。
- [ ] Agent 只能创建修正候选，用户确认后才发布，基线变化与冲突不会覆盖 current。
- [ ] 只有明确保存才生成普通 Markdown／原生批注，锚点有效且无地图发布流程。
- [ ] 付费解析、翻译和来源任务无 Agent 第二启动入口，专门确认流保持有效。
- [ ] 会话压缩、分支、重开和工程搬迁不会继承错误授权、旧 revision 或旧来源证据。
- [ ] 普通工具、Shell、Web 与凭据边界保持，旧工具结果不写入新任务。
- [ ] 不出现旧 PDF 引用工具、PDF 原生批注、独立问答卡或 Agent 专用正文。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron 回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。以下事项由对应规格继续定义：

- 原文与 PDF 的同步定位及兼容工具增强：`pdf-comparison`。
- 旧 Pi 会话、审阅／建图记录与引用工具数据的处理：`legacy-projects`。
