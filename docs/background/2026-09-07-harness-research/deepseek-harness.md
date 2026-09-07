# 调研：DeepSeek harness 的文本抓取工具与上下文组装

来源票据：[#36](https://github.com/attackingjensen/paper-30min/issues/36)（父地图：[#35](https://github.com/attackingjensen/paper-30min/issues/35)）。
一手资料：本机 `D:\codex_project\deepseek-harness` 源码（`@deepseek-ai/dsh-root` 0.1.1-rc.2，pnpm monorepo）。文中所有"路径:行号"均相对该仓库根。

## 结论摘要

dsh 让模型"抓取而非整读"的核心不是某一个工具，而是一组互相咬合的契约：

1. **窗口化读取**：`read` 从不整文件直送。每次调用返回一个带行号的有界窗口（默认/上限 2000 行、单行 2000 字符、整窗 50KB），尾部固定输出"当前进度 + 如何续读"的页脚，把翻页动作显式交还给模型。
2. **定位先行**：`glob`/`grep` 只返回指针（路径、行号、匹配行），默认封顶（100 路径 / 250 匹配）；超帽时内联只留样本，完整结果落"溢出文件"（spill），回复里给定位符和"用 read/grep 读它"的提示——大结果从不进入上下文，但永远可追回。
3. **行为约束写在系统提示里**：每个工具注册时自带一条 100–199 号段的提示（"用 read 而不是 cat""用 grep 而不是 shell grep，需要上下文时对命中文件用 read"），工具描述里也内嵌截断语义与下一步建议；文件编辑另有 read-before-edit 观察门禁。
4. **上下文永远有界**：超帽工具结果先被工具自身截断，再被通用 spill 策略替换为"头/尾预览 + 存储定位符"；历史层再有 token 压力压缩（摘要替换旧区间）与免模型的 tool-result 修剪（保留头 4096/尾 1024 码点）。任何一层都不允许无界文本进入请求。
5. **循环终止靠"无工具调用即完成"**：助手消息不含工具调用则本步完成；每步重新组装系统提示并重发派生历史；`max-tokens` 粘滞、取消合成 `ABORTED_BEFORE_DISPATCH` 结果，保证会话日志可确定性重放。

对 L3 深挖工具集的直接启示：**把论文的"地址"（节 id、页码、行号）做成工具契约的一等公民，让模型先拿指针、再按需取窗口，截断永远伴随可追回的恢复路径**。

## 工具与契约事实清单

### 工具全景（模型可见）

与代码库阅读直接相关的模型可见工具（完整生成目录见 `docs/tool-catalog.md:1-60` 的包映射表）：

| 工具 | 包 | 职责 |
| --- | --- | --- |
| `read` / `write` / `edit` / `read_image` | `packages/fs/tool-fs` | UTF-8 文件读写；`read` 是窗口化文本抓取工具 |
| `glob` / `grep` | `packages/fs/tool-fs-search` | 路径发现与内容搜索；进程内打包 ripgrep（`@vscode/ripgrep`），无 shell 层 |
| `str_replace_editor` | `packages/fs/tool-str-replace-editor` | view/create/替换/插入的独立编辑工具 |
| `bash` 等 | `packages/shell/*` | 通用 shell（系统提示明确劝退用于读文件） |
| `run_code` | `packages/core/tools`（Code Mode） | 保留传输工具；`mode: code` 下唯一可直接调用的工具 |

### `read`：窗口化读取

- **参数**（`packages/fs/tool-fs/src/read.ts:76-83`）：`file_path`（必填）、`offset`（1 起始行，默认 1）、`limit`（默认即上限 2000，`READ_LIMIT` 见 `read.ts:16`）。`limit > readLimit` 报错（`read.ts:60`）。
- **规范输出值**（`read.ts:84-105`）：`{ path, offset, lines: [{number, text}], totalLines }`——结构化行数组是规范值（canonical value），模型看到的文本只是它的渲染。
- **模型可见渲染**（`packages/fs/tool-fs/src/read-render.ts:152-170`）：固定信封
  ```
  <path>…</path>
  <type>file</type>
  <content>
  123: 行文本…

  (Showing lines 1-2000 of 5300. Use offset=2001 to continue.)
  </content>
  ```
  页脚三态：字节截断（`Output capped … Use offset=N to continue`）、普通续读（`Showing lines X-Y of Z`）、读完（`End of file - total Z lines`）。
- **截断策略**（`read-render.ts:69-89`）：单行超 2000 字符截断并加后缀 `... (line truncated to 2000 chars)`（`read-render.ts:11,69-71`）；窗口字节累计超 50KB（`READ_MAX_BYTES`，`read-render.ts:14`）停止收集并置 `truncatedByBytes`；流式扫描时行缓冲只保留 2001 字符，单行再长也不撑爆内存（`read-render.ts:117-125`）；`offset` 越过 EOF 抛 `FS_NOT_FOUND`（`read-render.ts:96-99`）。
- **大文件路由**：≥10MB 或大小未知走流式读取（`read.ts:22,144-146`）。
- **系统提示**（`read.ts:69-74`）：`tool:read`（order 100）——"Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files."
- **观察副作用**：每次成功读取发出 `fs/observed` 记录版本（`read.ts:162`），供 read-before-edit 门禁使用（见下文）。

### `grep`：内容搜索

- **参数**（`packages/fs/tool-fs-search/src/grep.ts:282-291`）：`pattern`（必填，ripgrep 正则）、`path`（默认会话工作区）、`include`（单个正向 glob；显式拒绝 `!` 否定与逗号列表，`grep.ts:68-79`）。
- **执行**：固定 argv `rg --json --regexp=… [--glob=…] [-- path]`，模型输入全部作为独立 argv 元素、目标置于 `--` 之后，无 shell 引号问题（`grep.ts:112-117`）；NDJSON 流式解析，非 UTF-8 匹配行降级为占位符而非整体失败（`grep.ts:135-161`）。
- **输出契约**：规范值 `{ matches: [{path, lineNumber, line}] }`（`grep.ts:293-312`）；渲染为"按文件分组 + `Line N: text`"（`grep.ts:192-204`），头部 `Found K of M matches`（截断时）或 `Found N matches`（`grep.ts:216-226`）。路径一律转工作区相对（`grep.ts:328`）。
- **截断与恢复**：内联最多 250 条匹配（`GREP_MAX_MATCHES`，`grep.ts:30`，注释明示对齐 Claude Code 的 `head_limit`）；单行预览 2000 字节、按 UTF-8 边界截断（`grep.ts:36`；`search-core.ts:317`）。超帽时 `tools/post-execute` 监听器把**完整**格式化结果写入 spill 文件，页脚改为 `Full grep result stored at: <locator>. <retrievalHint>`；存不了则建议"narrow pattern, path, or include"（`grep.ts:341-364`）。
- **进程护栏**：原始 stdout 上限 20MB（`search-core.ts:36`）、超时 30s（`search-core.ts:43`）、stderr 尾巴 64KB（`search-core.ts:50`）、终止宽限 3s（`search-core.ts:53`）。
- **系统提示**（`grep.ts:276-280`）：`tool:grep`（order 104）——"Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context."

### `glob`：路径发现

- **参数**（`packages/fs/tool-fs-search/src/glob.ts:311-325`）：`pattern`（必填；描述里内嵌关键语义"无 `/` 的模式匹配任意深度 basename，`*` 搜全树"）、`path`（默认工作区）。
- **执行**：`rg --files --glob=… --sort=modified --no-ignore --hidden`，并双重否定 glob 排除 `.git/.svn/.hg/.bzr/.jj/.sl`（`glob.ts:38,90-108`）。结果只含文件、按修改时间排序、含隐藏与 ignored 文件。
- **输出契约**：规范值 `{ root, paths: string[] }`（`glob.ts:327-335`）；100 条内全量返回（`GLOB_MAX_RESULTS`，`glob.ts:26`）。
- **超帽采样**：配置 `sampleOverCapGlobResults: true` 时，不是截头，而是**按顶层目录轮转采样**（`sampleAcrossTopLevel`，`glob.ts:171-203`），让内联页横跨整棵树而非单一子树；页脚明说"sampled across X of the Y top-level entries … Narrow path to inspect a specific subtree"（`glob.ts:214-229`）。完整列表同样落 spill（`glob.ts:361-373`）。
- **系统提示**（`glob.ts:301-306`）：`tool:glob`（order 103）——"Use the glob tool — not shell find — to discover files by path pattern. …"，并随配置陈述排序/采样语义。

### 工具流水线与呈现（所有工具共享）

- **统一管线**（`packages/core/tools/README.md`）：`tools/pre-execute`（allow/deny/ask 门禁）→ 单调 guard → `tools/execute`（超时/重试/指标环绕）→ `tools/post-execute`（可替换内容/值、附加上下文）→ 定义自带的 `finalizeContent` → 只读 `tools/result`。grep/glob 的 spill 就是挂在 `post-execute` 的监听器。
- **定义即契约**：`ToolDefinition` = schema + **强制 output 声明**（`output { schema, render, presentationMeta? }`）+ `execute`。`render` 把规范值渲染成模型可见文本；`presentationMeta` 投影成可持久化、可重放的 UI 卡片数据（`read.ts:123-132`）。模型可见文本不是规范值本身——管线先校验冻结规范值，再渲染。
- **呈现模式**：`mode: native | code | both`。`code` 模式下模型只看到 `run_code`（保留名，不可注册/遮蔽，`packages/core/tools/src/code-mode.ts:20`）加一段生成的 SDK 声明（`tools:sdk` 段，order 150，`code-mode.ts:24`），直接调用其他工具会被解析为 `UNKNOWN_TOOL`；每个 agent 可用 `presentAs` 自选呈现（`packages/core/agent-tool-presentation/README.md`）。SDK 文案要求模型"curate"输出——只有 print/return 的才进入上下文（`code-mode.ts:45-52`）。

## 上下文组装机制

### 系统提示：分区段、有顺序、可插值

- **组装登记处**（`packages/core/system-prompt/README.md`）：插件贡献 `{ name, order, text }` 区段，升序拼接；顺序带约定——`-100` harness 身份（固定一句 `You are an AI agent powered by DeepSeek Harness.`）、`0` 部署 persona、`100–199` 工具指导。工具 schema 由工具注册处自动喂入组装（`ctx.systemPrompt.tools()`），与区段分离；`toolOrder` 配置可显式定序，未列出工具按字典序落在 `<unlisted-tools>` 槽位。
- **变量插值**：`{{model}}`/`{{cwd}}` 等注册变量严格插值，未知引用直接抛错（fail loud）。
- **每步重组装**：agent loop 每个 step 都调用 `systemPrompt.assemble()`（`packages/core/agent-loop/src/agent.ts:230`），所以工具可见性、动态指导的变化按步生效；每步请求都重付系统提示与 schema 的 token，靠前缀稳定保 KV cache。

### 结构信息如何进入上下文

1. **工作区指令链**（`packages/context/agent-instructions/README.md`）：首个 `agent/pre-step` 读取 `$DSH_HOME/AGENTS.md` 及从项目根到 cwd 的每级 `AGENTS.md`/`CLAUDE.md`（去重、有 `maxBytes` 渲染预算，保最具体、砍宽泛），包装成一条 durable user 消息，用 `<system-reminder>` 框架注入，并声明"不覆盖系统/用户指令"。之后监听成功的 `read/write/edit` 结果做嵌套发现与变更通知（新增/替换/移除各一条 system-reminder）；`</system-reminder>` 字面量在内容中被转义，防仓库文本越狱。超帽发可见的 `Workspace instruction budget ...` 诊断。
2. **动态运行时上下文**：`ctx.systemPrompt.context()` 贡献的动态上下文经 `RuntimeContextProjection.project()` 去重后作为 sourced user 消息注入（`packages/core/agent-loop/src/runtime-context.ts:64`）；清空时写入固定墓碑文案 `Current runtime context: none. Earlier runtime-context snapshots no longer apply.`（`runtime-context.ts:14`）。
3. **@文件引用**（`packages/context/file-reference/README.md`）：`@path` 只注入路径文本与"该 agent 可调用 read"的固定指导，**不附文件内容**——内容可见性永远由显式工具调用产生。

### 历史裁剪与"防整库直送"的四道闸

1. **工具内截断**（产生时）：read 窗口、grep/glob 条数帽、单行预览帽——第一道且最语义化。
2. **通用 spill 策略**（`packages/spill/spill-policy/README.md`）：`tools/post-execute` 上，最终纯文本结果超 `maxInlineBytes` 即整体存 `ctx.spillStore`，替换为"头/尾预览 + `(Omitted N bytes. Full formatted result stored at: … Use read with offset/limit, or grep this path to search within it.)`"；`read` 结果被豁免以避免 read→spill→read 循环；spill 失败保留原结果（best-effort）。spill 文件按 session 分组、0600 私有权（`packages/spill/spill-local/README.md`）。
3. **免模型修剪**（`packages/compaction/compaction-tool-result-pruner/README.md`）：压缩触发时先把超 8192 码点的 tool result 重写为"头 4096 + `[... tool result middle pruned ...]` + 尾 1024"，原文留在只增日志；修剪后压力解除则跳过摘要。
4. **摘要压缩**（`packages/compaction/compaction-basic/README.md`）：`thresholdRatio 0.8 × 路由上下文窗口`触发（`agent/pre-step` 压力检查 + `agent/request-error` 溢出恢复两路），把最旧的完整 surface 单元摘要成一条 `<compacted-summary>` user 消息（`surfaceOp: replace`），保留最近 `retainRatio 0.16` 的原文尾巴；切割边用 tool-pairing 平衡保证不切断未应答的工具调用对；摘要调用复用会话自身系统提示与工具做前缀以命中 KV cache。原文不删，重放确定性。

### 多轮工具调用循环与终止

- **双层循环**（`packages/core/agent-loop/src/agent.ts:246-330`）：turn 内含若干 step；step 内是"请求模型 → 收 assistant 消息 → 有工具调用则执行 → 再请求"的 `while (true)`（`agent.ts:339-419`）。
- **终止条件**（`agent.ts:410-418`）：assistant 消息无工具调用 → `completed`；`finish.kind === 'max-tokens'` → `max-tokens`（粘滞，不被后续正常步降级）；工具结果带 `concludesTurn` → `completed`；pre-step 拒绝 → `blocked`；取消 → `aborted`；异常 → `error`。turn 在"有终止因 且 next-step 收件箱为空"时闭合（`agent.ts:295-299`）。
- **并发调度**（`packages/core/agent-loop/src/tool-calls.ts:59-101`）：`isConcurrencySafe` 为 true 的调用成组进入有界滚动池（`maxParallelToolCalls` 默认 10，`packages/core/agent-loop/README.md`），独占调用构成屏障；策略、结果落库与上下文按模型顺序提交，只有 dispatch/body 重叠。
- **取消卫生**：未派发的调用补写合成 `tool/call` + `ABORTED_BEFORE_DISPATCH` 结果对（`tool-calls.ts:249-259`），日志永远成对可重放；被中断的流若已有可见文本则追加 `interrupted: true` 的 assistant 锚点，下一请求包含"用户已看到的前缀"。
- **行为约束门禁**（`packages/fs/fs-observation-policy/README.md`）：`edit` 前必须先读过该文件，否则 `FS_NOT_OBSERVED: edit requires reading "<path>" first — read the file, then retry`；版本过期 `FS_STALE_VERSION — re-read the file, then retry`。错误文案自带恢复指令，把"约束"写成可执行的下一步。

## 可借鉴机制（供 L3 深挖工具集设计）

按对"论文作为代码库"的适配价值排序：

1. **指针优先的工具分层**：`glob/grep` 只回指针、`read` 才回内容、描述互相指引（grep 提示说"需要上下文时对命中文件用 read"）。L3 可对应为：`search_paper`（回 节id+页+行 指针）、`read_section`（回该节有界窗口）。论文地图（L1）相当于常驻的"目录索引"，grep 退居次要。
2. **窗口契约三件套**：`offset/limit + totalLines + 续读页脚`。页脚把"已看 X–Y / 共 Z、用 offset=N 继续"写成机器可遵循的文本，模型的翻页行为零猜测。论文场景可用"页窗口"（`page_offset/page_limit`）或"段落窗口"，页脚同样报进度。
3. **截断永远伴随恢复路径**：超帽结果落 spill 文件并回定位符 + 取回提示；存不了就建议收窄查询。回复从不因截断"丢信息"，只"移信息"。L3 的大表格/长推导可整体溢出，回"完整内容在 X，用 read 工具取"。
4. **约束写进系统提示的工具指导段**：每个工具注册时自带 order 100–199 的提示段，既劝退绕过（"不要用 cat"），也指引串联（"命中后用 read"）。论文协议可把"L1→L2→L3 的调用顺序、不许整篇直送"写成同位工具指导段，而非塞在一次性说明里。
5. **错误即指令**：`FS_NOT_OBSERVED — read the file, then retry`。门禁拒绝时给出确切下一步，模型自我纠错无需人工。L3 可设"深挖前须已建图"类门禁（契约：错误文案直接教恢复动作）。
6. **超帽采样而非截头**（glob 的顶层轮转采样）：当结果集有天然分组（论文=节），跨组采样让一页结果覆盖全貌，并明说"sampled across X of Y groups；收窄 path 看子树"。论文检索超帽时可按节轮转采样。
7. **每步重组装 + 动态上下文去重投影**：系统提示按步组装、动态上下文变化才注入新快照（不变零成本）。深挖进行中可把"当前深挖位置/已取证清单"作为动态上下文段，只增不改，保前缀缓存。
8. **四道防直送闸门的分工**：产生时截断（工具语义）→ 结果溢出（通用字节策略）→ 免模型修剪（历史中的旧结果）→ 摘要压缩（token 压力）。L3 设计可照搬分层：工具内窗口 → 单结果 spill → 旧深挖结果修剪 → 会话压缩；每层独立可配，且都不丢可追回性。
9. **结构化规范值 + 渲染分离**：工具输出先有 JSON 规范值（管线校验冻结），`render` 才产生模型文本，`presentationMeta` 供 UI 重放。论文工具的"窗口"也可保留结构化值（节 id、行区间），UI 卡片与模型文本各取所需。
10. **信封格式轻量稳定**：`<path>/<type>/<content>` 三元素信封 + 行号前缀，模型易解析、UI 可正则还原（`read.ts:180`）。论文读取输出可用 `<section>/<pages>/<content>` 同类信封。

## 源码出处索引

| 主题 | 位置 |
| --- | --- |
| `read` 工具（schema/窗口/执行/提示段） | `packages/fs/tool-fs/src/read.ts:16,56-83,84-105,136-164,69-74` |
| 窗口构建/截断/信封渲染 | `packages/fs/tool-fs/src/read-render.ts:11,14,69-89,96-99,152-170` |
| `grep` 工具（schema/argv/分组渲染/spill） | `packages/fs/tool-fs-search/src/grep.ts:30,68-117,192-226,276-291,341-364` |
| `glob` 工具（schema/VCS 排除/采样/spill） | `packages/fs/tool-fs-search/src/glob.ts:26,38,90-108,171-203,214-229,301-325,361-373` |
| ripgrep 进程护栏常量 | `packages/fs/tool-fs-search/src/search-core.ts:36,43,50,53` |
| 工具注册处/管线/模式 | `packages/core/tools/README.md`；`packages/core/tools/src/code-mode.ts:20,24,45-52` |
| 系统提示组装（区段/order 带/变量/toolOrder） | `packages/core/system-prompt/README.md` |
| 循环与终止（step/turn/并发/取消合成结果） | `packages/core/agent-loop/src/agent.ts:246-330,332-420`；`packages/core/agent-loop/src/tool-calls.ts:59-101,249-259`；`packages/core/agent-loop/README.md` |
| 动态上下文投影 | `packages/core/agent-loop/src/runtime-context.ts:14,64` |
| AGENTS.md 指令链注入 | `packages/context/agent-instructions/README.md` |
| @文件引用（只给路径不给内容） | `packages/context/file-reference/README.md` |
| read-before-edit 观察门禁 | `packages/fs/fs-observation-policy/README.md`；触发点 `packages/fs/tool-fs/src/read.ts:162` |
| 通用结果 spill 策略 | `packages/spill/spill-policy/README.md`；本地存储 `packages/spill/spill-local/README.md` |
| 保留库（ItemRetainer/TextRetainer 分工） | `packages/util/output-retention/README.md` |
| 压缩（触发/保留/切割/摘要） | `packages/compaction/compaction/README.md`；`packages/compaction/compaction-basic/README.md`；修剪 `packages/compaction/compaction-tool-result-pruner/README.md` |
| 生成版工具目录（模型可见 schema 原文） | `docs/tool-catalog.md`（read 667 行起、glob 749 行起、grep 774 行起） |
