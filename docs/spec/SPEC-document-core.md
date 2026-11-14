# Spec: document-core

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[project-core](SPEC-project-core.md)（已批准）  
> 下游：`arxiv-import`、`pdf-import`、`reader`

## Objective

为 Paper30Min 定义唯一的当前正文模型：**类型化、不可变、带稳定文本锚点的 JSON 文档树**。它同时服务全文阅读、翻译、批注、Markdown 成果回链、Agent 读取和可选 PDF 对照，不再从 Markdown 或 PDF 坐标反推正文结构。

本模块还要让本地修正与来源更新可以安全共存：通过 `source-base`、当前树和候选树执行单元级三方合并；能可靠延续的 ID 与锚点才延续，其余明确冲突或失效，不以相似文本猜测目标。

## Scope

### In scope

- 文档树、阅读块、内联原子、资产引用和来源别名。
- 章节、单元、句子、原子与阅读块的稳定 ID 及生命周期。
- 精确选区、文本摘录和锚点解析所需的结构化表达。
- `source-base`、current 树、不可变 revision 和结构化修正命令。
- 新来源候选的对齐、单元级三方合并、冲突记录与解决。
- 锚点变化集、墓碑和派生内容失效所需的事实。
- 文档验证、消毒、确定性分段和受管资源完整性。
- Full 文本、Agent 文本和 Markdown／HTML 投影的边界。

### Out of scope

- arXiv HTML 获取与转换、PDF 云端解析和来源特有警告。
- 翻译生成与译文存储、批注和成果卡片的持久化。
- 阅读器视觉布局、冲突界面的具体样式和双栏 PDF 坐标映射。
- Agent 如何发起修正，以及 Markdown 文本锚点 URL 的最终编码。
- 五级折叠、语义摘要、自动论证关系和词级缩放动画。
- 旧 v2 文档迁移，属于 `legacy-projects`。

## Tech Stack

- TypeScript 类型与运行时 schema 验证；JSON UTF-8 为受管正文持久化格式。
- Node.js utility process 负责修正、对齐、合并、验证和 revision 发布。
- React 只消费只读文档投影，不在渲染进程直接修改 JSON。
- SHA-256 用于内容与资产完整性；应用生成 UUID 用于节点身份。
- 确定性、带版本的规范化与句子分段；重开不重跑分段器。
- 可使用项目已有 TypeBox 等依赖实现运行时校验，不引入数据库或 ORM。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron 与文件系统回归：

```powershell
npx playwright test -g 'document-core'
```

默认测试使用本地结构化 fixtures 和受控来源，不访问真实 arXiv、百度或模型服务。CI 证据以对应提交的 `Electron CI` 实际结果为准。

## Project Structure

### 仓库代码边界

```text
app/src/shared/document/     文档类型、锚点类型、运行时 schema 与只读投影
app/src/main/document/       规范化、修正、对齐、合并和 revision 命令
app/src/renderer/            只读文档与冲突数据展示，不拥有正文权威
app/tests/                   document-core 契约、合并和 Electron 回归
app/tests/fixtures/          公式、表格、图片、重复文本与多语言 fixtures
```

上述目录是目标模块边界，不要求把现有实现机械搬入同名文件。共享类型不得导入 Node 或 React 模块。

### revision 内容契约

每个 `paper/revisions/<revisionId>/` 至少包含：

```text
document.json               # 当前阅读树，界面与 Agent 的唯一正文权威
source-base.json            # 不含本地修正的规范来源树，仅用于差异与合并
assets/<sha256>.<ext>        # 两棵树共同引用的内容寻址资产
tombstones.json             # 累积的退役 ID、摘录与失效原因
changeset.json              # 从 baseRevision 到本 revision 的结构与锚点变化
```

- `source-base.json` 不是第二份阅读正文，也不向普通文件树或 Agent 默认阅读入口暴露。
- `document.json` 与 `source-base.json` 使用同一树 schema；revision ID、来源快照 ID、规范化版本和提交信息由 project-core 的 revision 元数据关联。
- `assets/` 保存两棵树引用资产的并集。当前树和来源基线可以指向不同哈希，以支持来源更新与本地替换的三方对比。
- 已发布目录不可原地修改；修正和合并始终在 staging 中生成完整新 revision。
- 旧本地 revision 可按 project-core 清理，但 tombstones 必须随新 current 累积保留，防止旧 ID 被重新使用。

## Code Style

节点表使用 ID 为键，阅读顺序使用显式数组；ID 不编码位置、标题或内容哈希。共享类型保持两空格缩进和可辨识的判别联合：

```ts
export interface DocumentTree {
  documentFormatVersion: 1;
  paperId: string;
  sections: Record<string, SectionNode>;
  units: Record<string, UnitNode>;
  sentences: Record<string, SentenceNode>;
  atoms: Record<string, AtomNode>;
  blocks: BlockNode[];
}

export type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "atom"; atomId: string };

export interface SentenceNode {
  id: string;
  unitId: string;
  content: InlinePart[];
}
```

- `SectionNode` 保存父章节、标题、子章节与直属单元的顺序。
- `UnitNode` 保存所属章节、结构类型和有序 sentence ID。
- `BlockNode` 定义真实阅读流，引用文本单元或图、表、独立公式与受控 raw block。
- 所有 ID 在同一论文内唯一，不能因移动、改名或内容修正而复用为另一逻辑节点。
- 运行时验证与 TypeScript 类型必须同步修改，不能只靠类型断言相信磁盘 JSON。

## Behavior Contract

### 1. 文档模型与唯一权威

1. 文档只描述来源结构，不包含模型摘要或论证角色：
   - **Section**：章节层级、标题和直属内容顺序。
   - **Unit**：段落、列表项、图注、摘要、脚注、参考文献条目等可寻址文本单元。
   - **Sentence**：单元内有序句子，包含文本与内联原子。
   - **Atom**：行内公式、引用、交叉引用、链接、脚注引用或不可拆内联对象。
   - **Block**：实际阅读流中的文本、图、表、独立公式和受控 raw block。
2. `document.json` 是 current 阅读树；`source-base.json` 只回答“未包含本地修正的来源树是什么”。
3. 翻译、批注、精解、记忆卡片、自动论证关系和阅读地图不属于文档树。
4. 初次导入时 current 树与 source-base 内容一致。本地修正只改变 current；来源更新同时建立新的 source-base 和合并后的 current。
5. Full 投影必须包含当前树的全部可读内容，不按模型层级隐藏段落。

### 2. 结构与资产表达

1. 行内公式保存来源 LaTeX／MathML 等可用表示及稳定 atom ID；翻译和文本投影必须复用同一 atom，不得把公式拆成普通字符重新猜测。
2. 图、表和独立公式是稳定 block：
   - 图保存本地资产引用和 caption 单元。
   - 表尽可能保存行、列、跨度和单元格内容；不能只保留一张截图冒充可翻译文本。
   - 独立公式保存显示数学所需结构与来源表示。
3. 只有在类型化表达会造成明显内容损失时才允许 raw block。raw block 必须具有稳定 ID、消毒后的 HTML、可读文本投影和明确限制，不得成为绕过规范化的通用入口。
4. 图片和其他二进制资产以内容哈希命名并保存在当前 revision 内；运行时不依赖原始远端 URL。
5. 缺失资产可以产生带警告的占位节点并保留来源信息，但不得静默省略。核心文字结构损坏不能靠占位节点提交为可读正文。
6. 来源 HTML ID、标签和书目键可以保存为 `sourceAliases`。别名用于对齐与交叉引用，不是 Paper30Min 的稳定身份。

### 3. 稳定 ID 生命周期

1. 初次导入时为 section、unit、sentence、atom 和 block 分配持久 ID；上游 ID 只保存为 alias。
2. 以下操作保留原 ID：
   - 同一节点内的普通文字修正，且逻辑节点未拆分或合并。
   - 内容不变的可靠移动、章节归属变化和阅读顺序变化。
   - 同类型原子的内容修正；其派生内容按 changed 处理。
3. 以下操作采用保守身份规则：
   - 拆分或合并 unit／sentence 时，退役受影响的旧结构 ID并为新结构分配新 ID。
   - section 拆分或合并时同样处理；不能默认让第一段或主段继承全部旧身份。
   - 改变节点的结构类型，或无法确认新旧节点是同一逻辑内容时，退役旧 ID并建立新 ID。
4. 单元内重新分段只影响发生边界变化的句子；未受影响且内容不变的句子保留 ID。
5. 退役 ID 写入 tombstones，记录节点类型、最后出现 revision、原摘录、原因和可选的人工参考候选。候选不是自动重定向。
6. 任何 ID 不得因内容哈希相同、位置相同或后续重新导入而再次分配给不同逻辑内容。

### 4. 句子与文本规范化

1. 规范化和句子分段必须是确定性、带版本的本地算法，不依赖模型即时判断。
2. 句子边界在导入或修正时计算并持久化；重开只读取已存句子，不因 Node／ICU 升级重新分段。
3. 分段器升级只能影响新候选；与既有 revision 合并时按保守 ID 规则处理边界变化。
4. 数学、引用和交叉引用先作为 atom 保护，再执行句子分段，避免公式小数点或引用标点被误当作句号。
5. 规范正文保存的是规范化后的逻辑内容，不承诺与来源 HTML 字节完全一致；原始字节由来源快照保留。
6. 空白、Unicode 和阅读顺序的规范化必须确定且可测试，不得按显示语言随意改写原文措辞。

### 5. 锚点与精确选区

结构化锚点至少支持：

```ts
export type DocumentAnchor =
  | { kind: "section"; sectionId: string }
  | { kind: "unit"; unitId: string }
  | { kind: "sentence"; unitId: string; sentenceId: string }
  | { kind: "atom"; unitId: string; atomId: string }
  | { kind: "block"; blockId: string }
  | { kind: "range"; ranges: SelectionRange[]; quote: QuoteSnapshot };
```

1. `SelectionRange` 由 `unitId`、`sentenceId`、`start`、`end` 组成，使用半开区间 `[start, end)`。
2. 偏移基于句子的逻辑内容序列：普通文本按 UTF-16 code unit 计数，每个内联 atom 占一个逻辑位置。不得按当前屏幕像素、渲染 HTML 节点或译文位置保存原文选区。
3. 跨句或跨单元选区保存按原文顺序排列的多个 range，不允许通过首尾两个点猜测中间内容。
4. `QuoteSnapshot` 保存实际选中文本及必要前后文，用于创建时校验和失效后诊断；它不能独立授权自动重锚。
5. 锚点解析必须校验节点存在、父子关系、范围边界、atom 位置和 quote 与当前内容一致。
6. 文本锚点 URL 的字符串编码由 `annotations-results` 定义，但必须无损映射到本模块的结构化锚点，不能再编码 PDF 页码或坐标。

### 6. 结构化修正与 revision

1. 修正请求至少包含 `baseRevision`、目标锚点、预期原内容和替换操作；不得只提供文件路径后覆盖整个 JSON。
2. 修正支持文本、结构、资产和顺序操作，每种操作都经过同一 schema、引用完整性和安全校验。
3. 修正命令在 staging 中复制必要结构并生成完整新 current；已发布 revision 永不原地编辑。
4. 普通文字修正保留适用节点 ID，但使相应内容在 changeset 中标记为 changed。
5. 结构拆分、合并、删除和类型变化按保守规则生成 tombstones 与新 ID。
6. Agent 只能在用户明确任务中调用这些修正命令；普通对话和文档导出不能隐式修改原文。
7. 发布前必须重新核对 project-core 的 current 与 `baseRevision`，冲突时保留候选并拒绝发布。

### 7. 来源候选对齐

三方合并使用：

- **Base**：当前 revision 的 `source-base.json`。
- **Current**：当前 revision 的 `document.json`，包含本地修正。
- **Candidate**：新来源快照转换出的候选树。

候选对齐按以下可靠程度使用证据：

1. 已存在的稳定 ID，适用于本地修正和同一候选链。
2. 跨来源快照保持一致的 source alias。
3. 唯一规范内容结合父级、前后顺序等结构上下文，适用于可靠移动。
4. 同一父级内可证明未变化的顺序关系。

内容哈希只能作为证据之一，不能在重复段落中单独决定身份。模糊相似度、单一全文 quote 命中和“最近段落”只能形成人工参考候选，不得自动延续锚点。无法可靠对齐时按删除＋新增或冲突处理。

旧 source-base 必须直接读取，不得通过当前版本转换器重跑旧来源来临时重建，以免算法升级伪造三方基线。

### 8. 单元级三方合并

首版不做词级或字符级自动合并。同一单元被双方改成不同内容时，整个单元是一项冲突；章节顺序、阅读块和资产单独核对。

| Base／Current／Candidate 状态 | 合并结果 |
|---|---|
| Current 等于 Base，Candidate 改变 | 采用 Candidate，并映射可靠 ID，标记 changed |
| Candidate 等于 Base，Current 改变 | 保留 Current 的本地修正 |
| Current 与 Candidate 做出相同改变 | 采用相同结果，不重复记冲突 |
| Current 与 Candidate 对同一单元作出不同改变 | 生成 content 冲突 |
| Candidate 删除未本地修改的单元 | 接受删除并建立 tombstone |
| Candidate 删除已本地修改的单元 | 生成 deletion 冲突 |
| Current 本地删除，Candidate 未变 | 保留本地删除 |
| Current 本地删除，Candidate 修改该单元 | 生成 deletion 冲突 |
| 双方以不同方式修改父级或阅读顺序 | 生成 order／structure 冲突 |
| 双方替换为不同资产 | 生成 asset 冲突，不二进制自动合并 |

其他规则：

1. 冲突至少保存 base、current、candidate、相关锚点和冲突类型。
2. 解决方案可以是保留 current、采用 candidate，或通过结构化修正产生明确手工结果。
3. 所有冲突必须解决或逐项明确选择保留哪一方，才能形成可发布候选；不得按默认优先级静默解决。
4. 合并后 source-base 更新为新来源树，current 更新为合并树，使保留下来的本地修正仍能与新来源区分。
5. 发布前重新执行全文档验证和 current 基线检查；冲突解决期间原 current 始终可读。

### 9. Changeset、tombstones 与派生失效

`changeset.json` 至少记录 `baseRevision`、`revisionId`、结构变化和以下锚点事实：

- `retained`：目标和内容均不变，派生内容可继续沿用。
- `moved`：节点身份与内容不变，但父级或阅读位置改变。
- `changed`：节点身份仍存在，但文本、原子、资产或选区依赖内容已改变。
- `removed`：目标删除、拆分、合并或无法可靠延续，只能通过 tombstone 诊断。
- `added`：新节点，没有旧锚点。
- `conflicted`：合并时尚未确定延续关系，不得向下游发布为有效结果。

具体失效边界：

1. unit／section 链接在节点仍存在时仍可解析，但其关联翻译、精解或核验可按 changed 标记过期。
2. sentence 内容发生任何变化时，其旧精确 range 不自动调整偏移；保留原 quote 并标记 changed 或 removed。
3. 内容不变的移动保留 ID 和文本派生关系；PDF 原页等位置型证据是否过期由对应消费模块判断。
4. 拆分、合并和删除只提供 tombstone 与可选参考候选，不自动把旧批注或成果挂到新节点。
5. 任何更新不得因为 revisionId 改变就把全部翻译、批注和成果一律失效；必须按实际变化集判断。

### 10. 验证、消毒与预算

发布前必须验证：

- schema、文档版本、paperId、ID 唯一性和 tombstone 冲突。
- 章节无环、父子关系唯一、阅读块顺序完整且没有重复占用节点。
- unit、sentence、atom、block、asset 和 source alias 引用的完整性。
- 选区偏移、quote、跨单元顺序和 atom 逻辑位置。
- 资产哈希、MIME、路径和引用；缺失资产必须有显式警告或占位。
- 交叉引用目标存在；无法解析的来源目标保留原始信息并产生警告，不猜测内部目标。
- raw HTML、MathML、SVG 和链接经过白名单消毒，不包含脚本、事件处理器、iframe、危险 URL 或运行时远端依赖。

首版安全预算如下，来源模块可以采用更严格限制：

| 项目 | 上限 |
|---|---:|
| `document.json` 或 `source-base.json` 单文件 | 64 MiB |
| 单棵树节点总数 | 200,000 |
| 章节嵌套深度 | 64 |
| 单个 raw HTML block | 2 MiB |
| 单个资产 | 32 MiB |
| 单 revision 引用资产总量 | 512 MiB |

超预算时保留候选并报告具体项目，不截断正文或资产后报成功。预算调整属于契约变更，必须同步版本、测试和规格。

### 11. 只读投影

1. **Reader 投影**从当前树生成适合 React 的只读结构，保留稳定 ID、阅读块和资产引用。
2. **Agent 文本投影**从同一 current 树生成带节点 ID 的文本，公式、表格、图注和 unresolved 警告不得静默消失。
3. **搜索、token、PDF 对照和渲染索引**可以在 `.paper30min/cache/` 重建，不得回写为正文权威。
4. **Markdown／HTML 导出**是普通派生文件；复杂结构降级必须明确，重新导入导出文件不能自动替代原 current。
5. 重开只重建索引，不重新分段、不重新分配 ID、不调用模型。

## Error and Recovery Requirements

以下情况必须拒绝发布并保留旧 current 与候选现场：

- ID 重复、节点循环、引用悬空、阅读顺序不一致或 tombstone 被重新使用。
- 选区越界、quote 不匹配、atom 顺序不一致或跨单元范围不连续。
- 非消毒 HTML、危险链接、资产摘要不符或无法解释的缺失内容。
- 候选对齐歧义、未解决合并冲突、baseRevision 已变化或 source-base 不一致。
- 文档或资产超过预算，或验证后仍缺少可阅读正文结构。
- 分段器／规范化版本无法识别，或重开时被发现试图重排既有句子。

错误恢复不得通过清空 ID、全文模糊重锚、默认采用 candidate、删除本地修正或截断文档来完成。

## Testing Strategy

### Schema 与锚点契约

使用理工科英文、中文、重复段落、复杂公式、表格、图注、脚注和交叉引用 fixtures，验证：

- 完整往返、引用完整性、阅读顺序和 Full 投影。
- 重开不重新分段、不改变 ID、不调用模型。
- UTF-16、代理对、组合字符、atom 占位和跨句／跨单元选区。
- quote 创建校验、重复文本歧义和失效摘录保留。
- 恶意 HTML、MathML、SVG、链接和工程外资产路径被拒绝。

### ID 与 revision

覆盖普通修正、可靠移动、重新分段、拆分、合并、删除和类型变化：

- 普通修正与移动保留适用 ID。
- 拆分／合并不会默认让主段继承旧锚点。
- tombstones 累积且旧 ID 永不复用。
- 已发布 revision 字节不变，修正只产生新候选。

### 三方合并

逐项覆盖行为表中的所有分支，并增加：

- 重复段落、跨节移动、双方重排和资产冲突。
- 无法可靠对齐时不得通过模糊匹配自动挂接。
- 多轮本地修正后，source-base 仍能与 current 区分。
- 多轮来源更新后，保留的本地修正仍可追溯。
- 冲突解决期间 current 被另一操作推进时拒绝发布。
- changed／moved／removed 只影响对应派生范围，不全篇失效。

### 真实 Electron 集成

通过生产 IPC 和真实临时工程验证：导入后修正、创建候选、解决冲突、发布、重开和故障恢复。Agent 不得直接写 `document.json`，界面与 Agent 读取的必须是同一 current revision。

## Boundaries

### Always do

- 以 current JSON 树为唯一阅读权威，保留 source-base 作为合并基线。
- 使用稳定 ID、显式顺序、结构化修正和不可变 revision。
- 对候选执行完整验证、保守对齐、单元级三方合并和基线检查。
- 用 changeset 与 tombstones 表达实际变化，无法确认就冲突或失效。
- 保留公式、表格、图片和交叉引用的可读结构与安全来源信息。

### Ask first

- 修改文档格式、锚点偏移规则、ID 生命周期、合并粒度或安全预算。
- 引入字符级自动合并、模型辅助重锚、自动论证角色或五级字段。
- 删除 source-base、tombstones、来源快照或冲突候选。
- 添加新的 raw HTML 能力、远端运行时资源或外部依赖。

### Never do

- 把 Markdown、token 索引、渲染 HTML 或 PDF 坐标当作正文权威。
- 让 Agent 或界面直接覆盖受管 JSON，或原地修改已发布 revision。
- 根据相似度、位置、单一 quote 或内容哈希静默重挂锚点。
- 默认让拆分后的第一段继承旧 ID，或复用 tombstone ID。
- 在有未解决冲突、基线变化或验证失败时推进 current。
- 因一次来源更新将全部批注、翻译和成果无差别失效。
- 为仅 Full 的阅读引入五级摘要、论证角色或动画专用 token 契约。

## Success Criteria

- [ ] current 与 source-base 使用同一类型化树 schema，但职责和读取入口完全分离。
- [ ] 章节、单元、句子、原子和阅读块具有稳定 ID，重开不重新分配或重新分段。
- [ ] 普通修正与可靠移动保留 ID；拆分、合并、删除和歧义对齐遵守保守 tombstone 规则。
- [ ] 精确选区支持 atom、跨句和跨单元范围，并通过偏移与 quote 校验。
- [ ] 三方合并覆盖全部行为表分支，冲突未解决和基线变化时不能发布。
- [ ] 多轮修正与更新后，本地修改仍能相对新 source-base 被识别。
- [ ] changeset 能精确驱动局部 stale／失效，不依赖全篇版本号一刀切。
- [ ] 公式、表格、图片、交叉引用和 raw block 均有可读、可验证且安全的表达。
- [ ] Reader、Agent 和导出均来自同一 current 树，复杂投影降级不会被隐藏。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron 回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。以下事项由下游规格定义：

- 文本锚点的 URL 编码、批注和成果卡片：`annotations-results`。
- 来源特有转换、警告和候选界面：`arxiv-import`、`pdf-import`。
- 冲突的视觉呈现与阅读交互：`reader` 及对应来源模块。
- 译文如何消费 changed／moved：`translation`。
- PDF 页级位置映射如何消费结构变化：`pdf-comparison`。
