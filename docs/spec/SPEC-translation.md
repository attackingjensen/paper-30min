# Spec: translation

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[document-core](SPEC-document-core.md)、[reader](SPEC-reader.md)（均已批准）  
> 下游：`annotations-results`、`workspace`、`agent-integration`

## Objective

为 Paper30Min 提供与 current 文档树共享结构和锚点的 **中英全文翻译**。原文结构化完成后立即可读；用户选择目标语言后才按需生成，已完成单元无需等待整篇任务结束即可阅读。翻译不依赖 PDF、五级字段、阅读地图或另一份 Agent 专用正文。

翻译采用原子保留：新结果通过句子 ID、数量、atom 和 schema 校验后才替换对应旧译文；失败、停止或局部漏段不破坏已经完成的内容。正文更新后，按实际 changeset 保留、补齐或标记局部 stale，不因 revisionId 改变就让全篇译文作废。

本模块成功时，应满足：

- 创建工程时选择目标语言，或之后首次切换到该语言，才启动翻译；未选择的语言不生成。
- 翻译按阅读顺序渐进显示，单段失败不阻塞其他单元，已有译文在离线重开后仍可阅读。
- 原文与译文句子一一对应，公式、引用和交叉引用复用同一 atom，不能因模型漏句而截断或合并对齐。
- 原句修改后保留旧译文并显著标为“已过期”，新增句显示原文；自动补试不覆盖仍有效的译文。
- reader 获得支持当前语言精确选区、原句软映射和局部重译后 quote 校验的完整投影。

## Scope

### In scope

- 英文→中文与中文→英文的全文翻译，目标语言按需选择和任务启动。
- 标题、章节、unit、sentence、表格单元、图注、脚注和参考文献的翻译投影。
- 基于原句 ID 与 atom 占位的模型输入、结构化输出、校验和确定性组装。
- 按单元原子发布、渐进可读、停止、恢复、缺口记录和自动／手动补译。
- 每单元／句子的模型、prompt、schema、内容与状态事实。
- 正文 revision 更新后的 retained／moved／changed／removed／added 处理。
- 旧译文保留、局部 stale、显式更新、单元／全文重译和模型变更边界。
- 翻译缓存、并发、任务去重、超时、预算和凭据边界。
- 支持 reader 双语言精确选区、quote 校验和 translation revision 重基的投影。

### Out of scope

- 原文渲染、选区 DOM 映射和侧栏视觉布局，属于 `reader`。
- 高亮／批注持久化及成果回链，属于 `annotations-results`。
- 页签语言偏好和布局恢复，属于 `workspace`。
- Agent 对话中的临时翻译、网页翻译和通用多语言翻译。
- 原文修正、来源更新、PDF 解析和 current 原子提交。
- 五级摘要、takeaway／reason／topic、自动论证关系和阅读地图。
- 中英以外的目标语言、自动多语言产品体系和翻译质量评分。

## Tech Stack

- Node.js utility process 负责翻译任务、校验、缓存和原子持久化；React 只消费只读翻译投影。
- 沿用现有模型服务配置、Pi／模型调用基础设施、`userData` 与凭据保护；每个任务固定开始时的 provider／model 配置。
- JSON UTF-8 保存派生译文与任务状态；SHA-256 用于原句、译文和缓存输入核验。
- 模型只返回受控 JSON 文本与 atom 占位，不返回可执行 HTML、工具调用或原文修正。
- 本地确定性组装、规范化和完整性校验；模型输出不直接写 current、来源快照或普通 Markdown。
- 不引入 textfold 的五级 ladder、摘要 prompt 或 Python 服务，不默认新增模型依赖。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron、受控模型服务与文件系统回归：

```powershell
npx playwright test -g 'translation'
```

默认回归使用本地文档树和受控模型响应，不访问真实模型服务。真实模型验收须由用户明确授权并记录 provider、model、样本 revision、实际完成／缺口和费用相关信息，不能由缓存或历史运行冒充；Linux 构建不能替代 Windows 桌面行为验收。

## Project Structure

### 仓库代码边界

```text
app/src/main/translation/    任务、prompt、校验、缓存、迁移和原子发布
app/src/shared/translation/  翻译状态、投影、诊断和 IPC 类型
app/src/renderer/            语言选择、进度、缺口和 stale 展示
app/tests/fixtures/translation/  句子、atom、漏段、错误响应和更新 fixtures
app/tests/                   转换、恢复、stale 和真实 Electron 回归
```

翻译任务与持续 Agent 会话分离，不创建 Pi 对话或独立问答卡。模型配置可以复用，但任务进度、并发和结果持久化由本模块拥有。

### 派生译文磁盘契约

译文属于原 revision 的受管派生侧车，不写入已发布的 `paper/revisions/<revisionId>/`，也不登记进工程清单：

```text
.paper30min/revisions/<revisionId>/translations/<language>/
  index.json                # baseRevision、当前 translationRevision、条目索引与状态
  units/<unitId>.json       # 已提交单元及逐句译文
  sections/<sectionId>.json # 已提交章节标题等元数据
```

- `index.json` 是此语言当前投影的唯一指针，记录 `baseRevision`、`language`、当前 `translationRevision`、条目文件、逐句内容摘要和状态。
- 单元／章节文件先完整写入并验证，再以同目录临时文件＋替换原子推进 `index.json`。未引用文件不是当前译文，启动时不得按时间或文件名猜测发布。
- 一个提交可以只新增或替换一个 unit／section；无需重写整篇译文。`translationRevision` 随成功 index 提交改变。
- 初次生成时 `ready` 表示与当前原句一致，`gap` 表示尚无可用译文，`stale` 表示保留的是旧原句译文。运行中的 pending／failed 属于任务记录，不能冒充 ready。
- 已提交译文中保留实际 generator、prompt／schema 版本、原句摘要和译文摘要；模型 API key、代理和机器配置不得写入。
- 旧原 revision 清理前，先把可继承译文迁移到新 current 的侧车。不承诺完整翻译历史，但 stale 展示所需的旧译文与 quote 必须保留。
- `.paper30min/cache/` 中可重建的模型响应缓存不是当前译文权威，不能与已提交 index 混用。

## Code Style

共享类型明确区分原文 revision、翻译 revision 和逐句状态：

```ts
export type TranslationSentenceStatus = "ready" | "gap" | "stale";

export interface TranslationSentence {
  sentenceId: string;
  sourceSha256: string;
  translationSha256: string | null;
  status: TranslationSentenceStatus;
  content: InlinePart[] | null;
  staleReason?: "source-changed";
}

export interface TranslationIndex {
  formatVersion: 1;
  baseRevision: string;
  language: "zh" | "en";
  translationRevision: string;
}
```

- `content` 复用原文 atom ID；`null` 只用于 gap。stale 内容必须连同旧 `sourceSha256` 保留，不能标成当前原句的 ready。
- `translationRevision` 标识一次已提交 index 状态，不是原文 revision，也不要求下游因它单独变化就丢弃全部精确选区。
- 下游可以在所有相关 sentence ID、range 与 quote 仍匹配时，把旧 translationRevision 重基到当前值；任何相关文本变化只影响对应选区。
- generator 事实至少包含 provider、model、promptVersion 和 schemaVersion；同篇不同单元可以因显式配置变化而有不同模型事实。
- Node ESM 相对导入沿用 `.js` 后缀，共享类型不得导入 Node 或 React 模块。

## Behavior Contract

### 1. 按需启动与语言边界

1. 原文 current 发布后即可阅读，不自动开始任何未选择的语言翻译，也不要求配置模型。
2. 以下两种用户动作算一次明确的按需生成请求：
   - 创建工程时选择与原文不同的目标语言，在首个 current 可读后开始。
   - 阅读时首次切换到尚无译文的语言，立即开始该语言任务。
3. 已有译文只切换视图，不因打开工程、切换页签或点击语言而重新生成。强制重译与 stale 更新按独立动作处理。
4. 启动和进行中的界面持续显示目标语言、provider／model、任务状态和可能产生费用的提示；不另用不明显的后台任务隐藏这些请求。
5. 未配置可用模型时保留原文和语言入口，提供设置与重试动作，不阻塞正文、PDF 对照或 Agent。
6. 仅支持英文→中文与中文→英文。源语言与目标相同则不创建翻译任务；无法确定或语言不支持时明确报告，不自动扩展为多语言产品。
7. 源语言判断使用来源元数据和确定性检查，用户可以纠正明显误判。混合语言论文仍选择一个目标语言，专有名词、引用标识和 atom 按规则保留。
8. 不翻译用户未选择的其他语言，不在导入后自动排队“所有可用语言”。

### 2. 模型输入与上下文

1. 模型输入来自 current Reader／Agent 投影的原句、标题和 atom，不读取另一份 Markdown 或 Agent 专用解析稿。
2. 每个请求只要求翻译指定 unit／sentence，以及必要的章节标题或论文标题；输出不得包含 takeaway、reason、topic、map、论证角色或原文修正。
3. 可以提供论文标题、章节路径和相邻单元作为上下文，但上下文只用于术语与衔接，不能要求模型输出额外摘要或改写未指定内容。
4. 分批按 unit 与 sentence 边界确定，遵守所选模型的 contextWindow／maxTokens 和安全余量。长 unit 可按句拆分请求，全部片段通过后才组装；单句无法放入预算时记为 gap，不影响其他 unit。
5. 默认并发最多 4 个模型请求，同一原文 revision＋目标语言只运行一个翻译任务。并发完成顺序不改变正文阅读顺序或 atom 身份。
6. 不使用网络搜索、网页工具、PDF OCR、Agent 工具或模型自生事实来补充论文内容。
7. prompt、schema、atom 标记和规范化均有版本；缓存与恢复必须识别这些版本，不能把不同协议的输出直接拼接。

### 3. 句子与 atom 对齐契约

1. 每个原句有且只有一个目标句，复用原 sentence ID 和顺序。句子片段可以仍是片段，但模型不得自行合并、拆分、遗漏或新增句子。
2. 公式、引用、交叉引用、链接和其他 atom 以带 ID 的占位输入。目标句中的每个原 atom 必须出现且仅出现一次，并留在对应原句内。
3. atom 的 LaTeX、目标、书目键和内部结构不由模型改写；模型只翻译其周围普通文本。不得把公式转成普通字符后重新猜测。
4. 标题保留对应 section ID；无标题 section 不得由模型擅自命名。论文标题翻译是元数据，不制造新正文 unit。
5. 表格逐单元格翻译并保持行、列、跨度；图注、脚注与参考文献中的普通文字可以翻译，作者名、DOI、标识符和 atom 保持不变。
6. 图片、SVG、公式和资产引用沿用原 ID 与本地资源，不生成替代图片或远端资源。
7. raw block 不允许模型返回 HTML。只能生成安全的译文文本投影，与原 sanitized raw block 并列并标明结构限制。
8. 目标语言的空白和 Unicode 规范化必须确定且可测试，不能因显示语言改变原句 ID、atom 或选区逻辑位置的含义。

### 4. 输出校验与原子保留

每个 unit／section 在提交前验证：

- 只包含请求的 ID，句子数量、ID 与顺序完全匹配，没有未知或重复条目。
- 每个原子句都有目标文本，原句为空等特殊情况有明确处理；模型漏句不能通过截断数组或合并尾句来“修复”。
- atom 占位完整、唯一且位于原句，未引入未知 atom、危险 HTML、脚本或额外结构。
- schema、Unicode、路径、内容大小和 projection 均可验证，标题没有凭空新增。

提交规则：

1. 同一响应中不同 unit 可以独立验收，合法 unit 先提交，失败 unit 留为 gap，不因一批中一项失败丢弃其他合法结果。
2. 新 unit 只有在完整通过后才写入并推进 index；pending 或半个 unit 不对 reader 可见。
3. 替换已有 unit／sentence 时，新结果完整提交前旧译文仍可读取。失败、停止或崩溃不先删除旧译文。
4. 初次全文生成以 unit 为最小可见提交；局部 stale 更新以 sentence 为最小提交，避免重译同 unit 中仍有效的句子。
5. index 推进后产生新的 translationRevision 和实际变化事实；崩溃留下的未引用 unit 不作为 current projection。
6. 模型输出的“看起来合理”不能替代这些机器校验，校验通过也不宣称翻译语义完全正确。

### 5. 渐进阅读与投影

1. 用户开始翻译后可以立即进入目标语言视图，不必等整个任务结束：
   - ready 句显示当前译文。
   - gap 句显示当前原文，并标明未翻译／处理中／失败状态。
   - stale 句显示旧译文并显著标为“已过期”，同时可查看对应最新原文。
2. 已完成内容按原文 blocks 顺序渐进出现，不重排当前阅读位置，不在整篇完成后强制 reload 才能看到结果。
3. 语言视图提供当前 translationRevision、baseRevision、逐句内容摘要、状态和 generator 事实，供 reader 与侧栏校验。
4. ready 译文投影提供译文逻辑文本、atom 位置、sentence ID 和精确 range 映射，支持 reader 的译文选区。
5. stale 投影仍可用于阅读与选区，但必须携带 stale 状态和旧 revision／quote，不能冒充当前原句翻译。
6. gap 中显示的原文使用原文锚点，不能包装成“译文 range”。
7. 新 unit 提交、语言切换或原文 revision 迁移都使用 epoch／revision 校验，迟到的旧任务结果不得覆盖新视图。
8. 离线重开直接读取已提交 index 和 unit 文件；ready 与 stale 都可显示，gap 不触发阻塞阅读的恢复过程。

### 6. 失败、停止与恢复

1. 首轮各单元处理完毕后，对失败或模型漏出的单元自动补试一次；已保存 unit 不重发。补试仍失败的保留 gap 和诊断。
2. 打开已有缺口译文时，可以自动补译一次，但必须同时满足：
   - 用户打开该语言且已有可用模型配置。
   - 仅处理 gap，不处理 stale 或 ready。
   - 同一应用会话中，相同 baseRevision、language、model 和 gap 内容指纹最多自动补试一次。
3. 自动补试界面显示模型、缺口与费用提示；用户停止后不再自动启动同一指纹。手动“补译缺口”可以再次显式发起。
4. 网络失败、限流、无效 JSON、句子／atom 校验失败和单句超预算分别记录，不用无限重试掩盖系统问题。
5. 用户停止时取消未发送批次；已在进行的请求可能已产生费用，完成且合法的结果可以保存。不得谎称停止能撤回模型费用。
6. 重开应用后读取任务记录和 index，只恢复未完成的 gap；不得把 pending 当成 ready，也不得重复提交已保存 unit。
7. 原文 current 变化时，旧 baseRevision 任务停止调度新批次。已完成结果只写旧 revision 侧车，再按迁移规则继承，不能直接写入新 current 的翻译。
8. 任务、unit 和 index 写入失败时保留旧 index 与已提交内容，给出可行动错误，不清空整篇重来。

### 7. 正文更新后的局部 stale

新 current 发布后，先根据 document-core changeset 迁移译文，再允许后续补译：

| 原文变化 | 译文处理 |
|---|---|
| retained，句子 ID 与内容不变 | 保持 ready，保留译文、atom 与 generator 事实 |
| moved，身份与内容不变 | 保持 ready，更新阅读位置，不标 stale |
| changed，原句或 atom 内容改变 | 仅该句标为 stale，保留旧译文和旧 sourceSha256 |
| section 标题改变，正文句未变 | 仅标题 stale，正文译文不受影响 |
| added 新句／unit | 标为 gap，显示最新原文 |
| 拆分、合并、删除或无法可靠延续 | 旧句进入 tombstone 诊断，新句为 gap，不自动重挂旧译文 |

其他规则：

1. unit 内只有部分句子 changed 时，其他 ready 句继续显示，不全 unit 作废。
2. stale 句默认显示旧译文＋“已过期”，可以查看最新原文；不得显示成最新译文，也不得自动重译覆盖。
3. 对 removed／split／merge 的旧译文只保留在失效诊断中，不挂到相似或相邻新句。
4. 迁移形成新的 baseRevision 与 translationRevision；所有下游通过实际句 ID、range 和 quote 重基，不能只凭版本号全篇失效。
5. 原文修正、来源更新、模型改变或翻译器升级本身都不是全篇重译理由。

### 8. 补译、stale 更新与强制重译

1. **补译缺口**只处理 gap，包括新增句和既往失败句，不自动处理 stale 或 ready。
2. **更新过期译文**是显式动作，只处理 stale。请求可以携带同 unit 的上下文，但只替换目标 stale 句，其他 ready 句保持不变。
3. stale 更新失败时旧译文继续以 stale 显示，不能先清空后留下无内容。
4. **重译单元／全文**用于用户主动改变风格、模型或重新生成 ready 内容；全文重译覆盖大量已有结果并可能产生较高费用，必须单独确认。
5. 强制重译同样逐单元原子替换，失败单元保留旧 ready 结果，不制造新 gap。
6. 更改默认模型只影响之后发起的请求。既有译文保留原 generator 事实，不自动换模型重跑；同篇混合模型必须可追溯。
7. 翻译器／prompt 升级只影响新请求和显式重译，不能仅因应用升级就把既有译文全部标 stale。
8. 所有任务都固定目标 baseRevision；原文变化后按旧任务停止与迁移规则处理，不把旧结果冒充新原文翻译。

### 9. 缓存与复用

1. 已提交 index 和 unit 文件是当前译文权威；模型缓存只是可重建优化，不能绕过句子、atom、quote 和 revision 校验。
2. 缓存键至少包含原句／unit 内容、atom ID 与内容、目标语言、provider／model、prompt／schema／规范化版本，以及实际影响输出的上下文和术语设置。
3. retained／moved 内容直接继承已提交译文，优先于再次查询模型或缓存。
4. 不因表面文本相同就跨不同 atom、上下文或模型配置复用结果；重复段落必须结合结构与输入键判断。
5. 无效响应、校验失败结果和部分 unit 不作为已提交缓存命中；错误诊断可按任务需要保留，但不能阻止后续显式重试。
6. 缓存不包含 API key、请求 Authorization、代理凭据或不必要的原始服务响应。凭据变更不影响既有译文可读。
7. 缓存清理不影响已提交译文；译文侧车迁移和清理遵守 current revision 的提交顺序。

### 10. 翻译 revision 与精确选区支持

1. 每次 index 原子推进产生新的 translationRevision，但下游是否保留精确选区取决于实际句子、range 和 quote，而非只比较版本字符串。
2. annotations-results 可以在所有相关 sentence ID、range 和 quote 仍匹配时，将选区的 translationRevision 重基到当前值；原创建 revision 可继续作为 provenance。
3. 如果只有无关 unit 新增或改变，既有选区保持精确有效，不全篇软化为句级高亮。
4. 如果相关译文文本改变，只有相交 range 失效并保留 quote；未相交 range 继续有效。
5. 原句 changed 导致 stale 时，译文精确选区按 stale 处理；原文侧只保留对应原句软映射，不自动计算新的词级对应。
6. 模型重译得到完全相同文本时，quote 校验通过的选区可以重基，不制造无意义失效。
7. reader 不需要理解模型缓存或任务细节，只消费本模块验证后的当前投影。

### 11. 预算与资源边界

首版资源限制：

| 项目 | 上限 |
|---|---:|
| 单语言已提交译文逻辑内容 | 64 MiB |
| 单个 unit 译文文件 | 2 MiB |
| 默认并发模型请求 | 4 |
| 首轮失败后的自动补试 | 1 次 |
| 同会话同指纹打开缺口自动补试 | 1 次 |
| 同一 baseRevision＋language 活动任务 | 1 个 |

模型请求的输入／输出预算由所选模型的 contextWindow、maxTokens 和安全余量共同决定，不能靠截断句子满足。超预算 unit／sentence 留为 gap 并报告，其他内容继续。document-core 的节点与资产预算不变，译文不得新增远端资产或重复复制图片。

## Error and Recovery Requirements

| 情况 | 必须行为 |
|---|---|
| 未配置模型、模型不可用或语言不支持 | 原文继续可读，提供设置／重试，不生成伪译文 |
| 模型漏句、多个 ID、atom 缺失或响应非 JSON | 该 unit 不提交，保留旧译文并记 gap／诊断 |
| 单批中部分 unit 失败 | 合法 unit 先发布，失败项后续补试 |
| 任务停止、应用退出或模型请求超时 | 保存合法完成项，pending 不冒充 ready，可恢复 gap |
| 打开缺口后自动补试失败 | 同会话同指纹不反复自动请求，提供手动补译 |
| 原句修改 | 保留旧译文并标 stale，仅该句失效 |
| 原文 revision 在任务中变化 | 停止旧任务新批次，完成项留在旧侧车并按 changeset 迁移 |
| unit 写入成功、index 推进前崩溃 | 未引用文件不发布，旧 index 继续有效 |
| 强制重译失败 | 旧 ready 保留，不先删除或制造新 gap |
| 译文 quote 与当前 range 不符 | 只使相交精确选区失效，不全局清空高亮 |
| 缓存损坏或凭据变化 | 已提交译文继续可读，缓存可重建，不自动重译全篇 |

错误恢复不得通过截断句子数组、合并多余句子、丢失 atom、默认重译全篇、清空旧译文或反复自动请求来完成。

## Testing Strategy

### 句子、atom 与模型输出

使用英文、中文、公式、引用、表格、图注、脚注、参考文献和 raw block fixtures：

- 每句 ID 与数量一一对应，atom 在原句中恰好一次，标题和结构不变。
- 模型漏句、多句、顺序变化、未知 ID、重复 atom 和危险内容均被拒绝。
- 不采用 textfold 的截断数组、合并尾句或缺失 atom 后仍提交行为。
- 表格单元、atom、专有名词和参考文献标识保持结构，raw block 不生成 HTML。
- 相同输入与规范化版本产生确定投影，无 takeaway／topic／map 字段。

### 原子发布与渐进阅读

- 多 unit 并发完成时，合法 unit 先可见，阅读顺序与位置不跳动。
- unit 写入、index 推进前后崩溃均不会产生半个可见 unit。
- 替换旧 unit 失败时旧译文持续可读；强制重译不会先删除 ready。
- ready／gap／stale 的界面内容、原文回退和过期标识准确。
- 离线重开读取已提交译文，未引用 staging 不被猜测发布。

### 失败、补试与任务恢复

使用受控模型服务覆盖成功、超时、限流、无效 JSON、漏段、停止和重开：

- 首轮结束后只补试一次，已保存 unit 不重复请求。
- 打开缺口按 baseRevision／language／model／指纹每会话最多自动补试一次，stale 不被自动覆盖。
- 停止取消未发送批次，合法在途结果可保存，界面不谎称撤回费用。
- 恢复不重复已提交内容，不混淆不同模型、语言或 baseRevision。
- 单句超预算和部分批次失败不阻塞其他 unit。

### 正文更新与局部 stale

逐项覆盖 retained、moved、changed、added、拆分、合并、删除和标题变化：

- 只有实际 changed 的句子成为 stale，其他句保持 ready。
- moved 不 stale，added 为 gap，removed／split／merge 不自动重挂。
- stale 旧译文与最新原文均可查看，显式更新只替换 stale 句。
- 原文任务中变化时旧结果不写新 current，迁移不清空有效译文。
- 模型与 prompt 变化不导致既有译文无差别失效。

### 选区、缓存与真实 Electron

- 无关 unit 提交后，既有译文精确 range 可通过 quote 重基；相关文本变化只使相交 range 失效。
- 原文与译文之间始终按原句软映射，不发生偏移互换。
- 缓存键覆盖 atom、上下文、模型与协议版本，重复段落和缓存损坏不会错用。
- 通过生产 IPC 与真实临时工程验证按需启动、渐进阅读、停止恢复、局部更新和离线重开。
- 验证语言切换不强制 reload、阅读位置稳定、gap／stale 提示和实际截图。
- 真实模型验收单独记录，默认 CI 不访问真实服务，也不把缓存响应当作在线证据。

## Boundaries

### Always do

- 以 current 原句和 atom 为翻译输入，保持一一句子与结构对应。
- 按需启动，逐单元原子发布，已完成部分立即可读。
- 首轮自动补试一次，后续按指纹限制自动补试并允许手动补译。
- 保留旧译文，按实际原句变化标 stale，显式更新只影响目标范围。
- 以 translationRevision＋句 ID＋range＋quote 支持精确选区局部重基。
- 记录实际 generator 和协议版本，保护凭据并用受控服务验证失败恢复。

### Ask first

- 增加目标语言、自动全语言生成、持续自动重试或导入后无条件翻译。
- 引入五级字段、自动摘要、论证角色、模型原文修正或工具调用。
- 修改句子／atom 对齐、stale 继承、选区重基或译文磁盘协议。
- 改变模型并发、预算、缓存键或自动补试费用政策。
- 删除已提交译文、stale 摘录或无法确认归属的恢复现场。

### Never do

- 在原文尚未可读前等待翻译，或要求原文阅读必须配置模型。
- 通过截断、合并或重排句子来接受模型错误输出。
- 改写公式、引用和交叉引用 atom，或让模型返回可执行 HTML。
- 让单段失败、停止或重译失败删除已完成译文。
- 因 revisionId、模型或应用版本变化就让全篇译文无差别失效。
- 把 stale 旧译文冒充最新，或自动覆盖 ready／stale 内容进行未授权重译。
- 把译文偏移换算成原文偏移，或因 translationRevision 变化使全部选区失效。
- 在工程中写入 API key、代理凭据或机器专用模型配置。

## Success Criteria

- [ ] 未选择的语言不生成；创建时选择或首次切换才启动，已有语言切换不重复请求。
- [ ] 原文无需模型立即可读，译文按 unit 渐进出现，离线重开可读取已完成内容。
- [ ] 句子 ID、数量和 atom 完整对应，错误模型输出不会通过截断或合并被接受。
- [ ] unit／index 原子提交在故障注入下不会出现半篇可见 unit或旧译文被提前删除。
- [ ] 首轮自动补试一次，打开缺口按指纹限次，恢复不重复提交已完成内容。
- [ ] 正文 retained／moved 保留译文，changed 局部 stale，added 为 gap，删除／拆分／合并不自动重挂。
- [ ] stale 旧译文明确标识且可对照最新原文，显式更新只替换目标句。
- [ ] 强制重译和模型变化不会无差别清空既有译文，generator 事实可追溯。
- [ ] 翻译 revision 变化只按实际 quote 影响精确选区，跨语言仍只做句级软映射。
- [ ] 缓存、凭据和机器配置边界明确，默认回归不访问真实模型。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron 回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。以下事项由对应规格继续定义：

- 译文精确高亮与批注的持久化和重基：`annotations-results`。
- 每个页签的语言偏好与布局恢复：`workspace`。
- 选区提问如何使用译文摘录与原句上下文：`agent-integration`。
