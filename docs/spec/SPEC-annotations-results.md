# Spec: annotations-results

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[document-core](SPEC-document-core.md)、[reader](SPEC-reader.md)、[translation](SPEC-translation.md)（均已批准）  
> 下游：`workspace`、`agent-integration`、`pdf-comparison`、`legacy-projects`

## Objective

为 Paper30Min 提供两类彼此独立但共享文本锚点的阅读积累：

1. **原生高亮与批注**：保存在 revision 关联的受管 JSON sidecar 中，支持创建、编辑、删除、跨语言显示和按 changeset 迁移。
2. **普通 Markdown 成果**：扫描 notes、explanations、memories 及用户自建位置中的真实锚点链接，在对应正文旁生成跳转卡片，包括打开中的未保存草稿；不建立成果关系数据库。

Markdown 链接必须自包含、可验证、可搬迁。它们指向 `paper.id` 与 document-core 的稳定节点，而不是 PDF 路径、原生 PDF 批注 ID、当前数组位置或 revision 文件路径。正文变化后，quote 只用于校验与失效诊断，不用于模糊搜索和静默重挂。

本模块成功时，应满足：

- 高亮与批注不需要创建 Markdown；明确保存的笔记、精解和记忆卡片则保持普通文件与外部冲突保护。
- 原文和译文精确选区都可保存，跨语言只按原句软映射，translation revision 变化按实际 quote 局部重基。
- 普通 `.md`／`.markdown` 中的有效链接直接形成卡片；`tmp` 候选、受管区、代码和符号链接不参与卡片生产。
- 同一文件对同一规范化锚点与语言视图的重复链接合并为一张卡，保留全部出现位置与次数。
- 文件移动、未保存编辑、链接删除、正文更新和翻译重基都不会制造错挂、重复或静默丢失。

## Scope

### In scope

- 原生高亮／批注的记录、校验、编辑、删除、原子写入和 revision 迁移。
- 版本化文本锚点 URL 的编码、解码、规范化、校验和跨工程分流。
- 原文 range、section／unit／sentence／atom／block 锚点及译文附加选区。
- 普通 Markdown 文件与打开草稿的增量扫描、链接 AST 位置和卡片生成。
- 重复链接合并、文件移动／改名、外部修改、未保存状态和链接删除。
- 卡片标题、类型、摘录、出现次数、状态与双向导航所需的数据。
- changed／removed／invalid／wrong-paper 链接和原生记录的失效呈现。
- 扫描预算、缓存、路径安全、恶意 payload 与异步更新隔离。

### Out of scope

- 正文渲染、侧栏视觉布局、双窗格和成果打开偏好，属于 `reader`／`workspace`。
- 译文生成、翻译 revision 提交和 stale 计算，属于 `translation`。
- Agent 如何生成笔记、精解或记忆卡片，属于 `agent-integration`。
- PDF 原生批注、PDF 坐标字典、PDF 选区和双向同步，属于 `pdf-comparison` 或明确退出。
- 独立问答卡、自动论证关系、阅读地图和模型摘要。
- 普通 Markdown 的编辑器、保存算法和一般相对链接重写，沿用 project-core／现有文件能力。
- 旧批注与引用迁移，属于 `legacy-projects`。

## Tech Stack

- TypeScript、React、Node.js utility process 和受限 IPC／preload。
- JSON UTF-8 保存原生批注；普通 Markdown 与打开中的草稿是成果卡片的唯一内容来源。
- 沿用 `mdast-util-from-markdown` 的 AST 与位置信息，区分真实链接、引用式链接、代码和图片。
- document-core 的稳定 ID、DocumentAnchor、QuoteSnapshot、changeset 与 tombstones。
- translation 的 sentence ID、translationRevision、译文 range 和 quote 校验。
- SHA-256 用于内容与缓存核验；不引入 SQLite、ORM、成果关系数据库或模型重锚服务。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron、Markdown 与文件系统回归：

```powershell
npx playwright test -g 'annotations-results'
```

默认使用本地文档树、译文、Markdown 和文件系统 fixtures，不访问真实模型、arXiv 或云服务。隐藏窗口回归仍须验证真实卡片、链接、编辑器位置、截图和交互；不能以内存索引断言代替磁盘与渲染结果。

## Project Structure

### 仓库代码边界

```text
app/src/shared/annotations/  锚点 payload、原生记录和卡片共享类型
app/src/main/annotations/    sidecar、链接解析、校验和 revision 迁移
app/src/main/results/        普通 Markdown 扫描、去重、失效诊断和缓存
app/src/renderer/            高亮／批注命令、卡片和 Markdown 回跳入口
app/tests/fixtures/annotations/  锚点、译文、重复链接和异常 payload fixtures
app/tests/fixtures/results/      普通 Markdown、草稿、移动与外部修改 fixtures
app/tests/                   契约、故障注入和真实 Electron 回归
```

现有 `annotation-links.ts`、`annotation-clipboard.ts` 和 PDF 原生批注实现只作为路径安全、AST 重写和交互参考。`#annotation=`、PDF 原生 ID、`paper://cite` 和材料路径不进入新文本锚点协议。

### 存储边界

```text
.paper30min/revisions/<revisionId>/
  annotations.json          # 原生高亮／批注及其当前状态

.paper30min/cache/results/
  ...                       # 可重建的 Markdown 扫描索引，不是成果权威
```

- `annotations.json` 是原生高亮／批注的权威，但不登记 Markdown 成果，也不保存卡片关系。
- 普通 Markdown 文件和其 AST 中的锚点链接是成果卡片权威；缓存删除后必须能从磁盘与打开草稿重建相同卡片。
- `paper/`、`sources/`、`.paper30min/`、`.pi/` 是受管区，根目录 `tmp/` 是候选区，均不参与成果卡片生产。
- 新 sidecar 与缓存按需创建，不在新工程预建空文件。清单不登记 annotations、explanations、translations 或成果文件。

## Code Style

原生记录与链接共享选区语义，但不互相依赖存在：

```ts
export interface TextAnnotation {
  id: string;
  kind: "highlight" | "note";
  selection: ReaderSelection;
  comment: string;
  createdRevision: string;
  createdAt: string;
  updatedAt: string;
  staleReason?: "source-changed" | "translation-changed" | "removed";
}

export interface ResultOccurrence {
  path: string;
  offset: number;
  line: number;
  column: number;
  ordinal: number;
  unsaved: boolean;
}
```

- 原生 `id` 用于编辑／删除该记录，不写入 Markdown 锚点 URL。删除原生记录不会使包含同锚点的 Markdown 链接失效。
- highlight 的 comment 可以为空；note 必须有非空纯文本批注，不包含 Agent thread、问答或模型摘要。
- `createdRevision` 保留创建事实；ReaderSelection 的 baseRevision 可在 quote 完全不变时重基，stale 时保持原值。
- `ResultOccurrence` 的位置来自当前磁盘或草稿 AST，不是永久身份。文件＋规范化锚点＋语言视图才是卡片分组键。
- Node ESM 相对导入沿用 `.js` 后缀，共享类型不得导入 Node 或 React 模块。

## Behavior Contract

### 1. 文本锚点 URL

使用版本化、自包含的自定义链接：

```text
paper://anchor/v1/<base64url-canonical-json>
```

payload 至少包含：

```ts
export interface AnchorPayload {
  v: 1;
  paper: string;                 // 当前主论文 paper.id
  base: string;                  // 创建时的原文 revision，仅作 provenance
  anchor: DocumentAnchor;
  snapshot?: AnchorSnapshot;     // 校验摘要与失效展示摘录
  view?: TranslatedAnchorView;   // 译文精确 range、revision 与 quote
}
```

1. `paper` 必须是应用生成的 `paper.id`，不是 arXiv ID、工程名、PDF 哈希或 source alias。
2. `base` 用于创建诊断，不要求 current 等于它才能解析；稳定节点可以跨 revision 延续。
3. range 必须包含完整 QuoteSnapshot。其他锚点必须带有足以校验当前内容和展示失效摘录的 snapshot；应用生成链接时始终填写。
4. 译文 `view` 保存 language、translationRevision、译文 ranges 与 quote；原文锚点仍是卡片主位置，译文偏移不能写入原 anchor。
5. JSON 使用 UTF-8、规范字段顺序和无空白编码，base64url 不含 padding。解析后重新规范化用于去重，不能以原始字符串不同制造重复卡。
6. payload schema、ID、父子关系、range 顺序、UTF-16 偏移、atom 位置和 quote 必须校验；未知版本或非法字段明确失败。
7. 单链接 UTF-8 最大 64 KiB、最多 256 个 ranges。完整 quote 超限时拒绝创建并建议改用句／单元链接，不截断 quote 冒充精确选区。
8. 链接不引用原生批注 ID，不要求对应 sidecar 记录存在，也不包含模型密钥、远端资产或机器路径。
9. 点击链接只能调用应用内导航命令，不得交给操作系统执行未知 scheme，不得把 payload 中的文本渲染为 HTML。

### 2. 锚点解析与失效状态

解析结果至少区分：`active`、`source-changed`、`translation-changed`、`removed`、`invalid`、`wrong-paper`。

1. `paper` 与当前主论文不符时为 wrong-paper。不得按标题、arXiv ID、文件名或相似内容自动重绑定到当前论文。
2. 节点存在且 ID、父子关系、range 和 quote 均匹配时为 active；内容不变的 retained／moved 不改变有效性。
3. 原句或 atom 已变化时，精确 range 不自动调整偏移，返回 source-changed 并保留原 quote。unit／section 链接可继续定位到存在的节点，但显示内容已变化。
4. 译文 revision 改变时，逐句校验 view ranges 与 quote：完全匹配可重基并保持 active；相关文本改变只使相交视图失效为 translation-changed。
5. 节点删除、拆分、合并或无法可靠延续时为 removed，使用 tombstone 和原摘录诊断，不在全文中搜索相似句重挂。
6. payload 非法、quote 不完整、范围越界或引用关系不一致时为 invalid；不能生成看似有效的正文卡片。
7. 同组不同 occurrence 可以因创建时的 snapshot 不同而有不同状态。卡片只要还有一个有效 occurrence 就保留有效导航，同时展示其他 occurrence 的失效信息；不得让旧 occurrence 把新有效链接整体拖成 removed。
8. quote 与 snapshot 只用于创建校验、当前匹配和失效诊断，不独立授权自动重锚。

### 3. 原生高亮与批注

1. 创建命令接收 ReaderSelection，由主进程重新校验 baseRevision、原文锚点、译文 revision、range 与 quote；renderer 不能只传文字和数组下标。
2. highlight 可以没有批注，note 的批注为 1–100,000 个字符的纯文本。不包含独立问答 thread、模型 citation 或 PDF 坐标。
3. 每条记录有稳定 UUID、kind、selection、comment、创建／更新时间与 createdRevision；Actor 可记录 user 或带 session ID 的 agent，但不影响锚点解析。
4. 编辑批注使用记录 ID 和预期 `updatedAt`／内容基线，原子更新 sidecar。编辑 comment 不会把 source-changed 或 translation-changed 记录重新标为 active。
5. 删除需要显式动作，只删除对应原生记录。它不删除 Markdown 文件中的同锚点链接，也不影响其他成果卡片。
6. 外部字节变化、记录 ID 重复、基线冲突或写入失败时保留用户输入与旧 sidecar，不静默覆盖。
7. 同一工程的原生写入串行执行；Agent 只能通过明确任务调用相同命令，不直接写 `annotations.json`。
8. 提供“复制文本锚点链接”命令生成标准 payload。复制到 Markdown 后产生的是独立成果链接，不是对原生记录的弱引用。

### 4. 原生记录的 revision 与翻译迁移

新 current 发布时，先迁移原生记录，再允许旧 revision 清理：

| 变化 | 原生记录处理 |
|---|---|
| retained／moved，quote 仍匹配 | 保持 active，可重基 baseRevision，保留原 createdRevision |
| 原文 changed | 标 source-changed，保留原 range、quote 和 comment |
| 原文 removed／拆分／合并 | 标 removed，关联 tombstone，不自动转移到新节点 |
| 无关 translationRevision 改变 | 不制造失效 |
| 相关译文 range 与 quote 仍匹配 | 重基 translationRevision，保持 active |
| 相关译文改变或原句已 stale | 标 translation-changed，保留旧译文 quote |

- comment 编辑、卡片读取和缓存重建不能清除 staleReason。
- 新增原文节点没有旧原生记录；相同文本复制到新节点不会自动继承旧批注。
- 迁移和 sidecar 原子提交失败时保留旧记录并警告，不回滚新 current，也不把旧记录直接挂到新节点。
- 不承诺完整批注编辑历史，但当前 stale 记录及其原摘录必须保留。

### 5. 普通 Markdown 扫描范围

1. 扫描工程内普通 `.md` 与 `.markdown` 文件，包括：
   - `notes/`、`explanations/`、`memories/`。
   - 根目录和用户自建普通目录中的 Markdown。
   - 已分配给这些普通路径、尚未保存到磁盘的打开草稿。
2. 明确排除：
   - `paper/`、`sources/`、`.paper30min/`、`.pi/`、隐藏内部目录和 `node_modules`。
   - 根目录 `tmp/` 中的用户候选成果。
   - 符号链接、目录联接、工程外路径和受管 staging／cache。
3. `tmp` 中链接可以在用户打开候选并点击时做导航校验，但不生成正文成果卡片；只有用户明确保存到普通位置才成为成果。
4. 普通文件树与扫描使用相同路径边界，不因扩展名或文件内容把 PDF、图片或其他文件提升为成果。
5. 不需要模型，也不读取 Agent 会话来推断成果关系；只有真实 Markdown AST 链接参与。

### 6. AST 链接提取

1. 支持 Markdown inline link 与 reference-style link／definition；definition 只有被实际引用时才产生 occurrence。
2. 排除 code block、inline code、图片目标、原始 HTML、纯文本中的 scheme 字符串和未使用的 definition。它们不会被误当成成果链接。
3. 每个 occurrence 保存当前路径、规范 payload、AST offset／line／column，以及同组在文件中的 ordinal。
4. 链接 label 可以是任意普通文字，不能代替 payload 中的 QuoteSnapshot，也不能作为自动重锚依据。
5. 卡片标题取文件首个非空 H1，缺失时取文件名。卡片类型按根目录映射为笔记／精解／记忆卡片，其他位置显示通用 Markdown 类型。
6. 卡片摘录来自首个有效 occurrence 所在块的真实纯文本投影，不调用模型生成摘要；危险 HTML 不进入卡片。
7. 无效 payload 不中断整文件或其他文件扫描，记录路径、位置和机器可读原因，供失效区域与源文档诊断使用。

### 7. 未保存草稿与外部修改

1. 打开草稿路径符合普通扫描范围时，草稿内容优先于磁盘用于实时卡片生产，并标记 `unsaved`。
2. 未保存新增、编辑或删除链接必须增量更新卡片，不要求先自动保存；不能为了扫描而覆盖用户草稿。
3. 外部磁盘与草稿同时变化时，实时视图使用草稿并显示冲突状态，不把磁盘与草稿各生成一套重复卡片。磁盘版本仍保留供冲突解决与重开。
4. 草稿保存成功后改用新磁盘基线；丢弃草稿或关闭未保存标签后回退到磁盘卡片。删除／移动文件时保留当前草稿的失效提示。
5. 草稿路径改变时按新路径重新判断资格和分组；从普通位置移到 `tmp` 会撤下成果卡片，移回普通位置可重新生成。
6. 每次输入只重扫受影响草稿，不全项目重扫。异步结果必须校验 path、内容 hash、revision 和当前草稿 epoch，迟到结果不得覆盖新输入。
7. 卡片源位置始终指向产生它的当前草稿或磁盘 AST；打开成果时使用同一版本，避免行号来自另一份内容。

### 8. 重复链接与卡片分组

1. 分组键为：**规范化普通路径＋规范化原 anchor＋规范化语言视图**。原生 annotation ID、baseRevision、translationRevision 和链接 label 不直接制造新组。
2. 同一文件对同一 anchor＋view 的多次链接合并为一张卡，显示出现次数并保留全部 occurrence。
3. 不同精确原文 range 是不同卡片；同一原句但不同译文 range 也是不同卡片。只有句／单元级软映射相同不能继续合并精确 range。
4. base／translation revision 不同但 anchor、range 与 view 语义相同的链接可以同组；各 occurrence 独立做 quote 校验和状态迁移。
5. 同一文件的不同 anchor 分别生成卡片。跨文件的同 anchor 链接保持不同成果卡片，不做全局关系归并。
6. 文件复制会产生不同路径的独立卡片；文件移动／改名只更新分组路径和 occurrence，不改变原 anchor 或卡片状态。
7. 删除最后一个有效 occurrence 时移除对应卡片；失效 occurrence 可以按诊断策略保留，但不能假装仍有效。
8. 原生记录与 Markdown 卡片不归并。用户复制原生锚点链接到笔记后，可以合理看到原生批注和笔记成果两种条目。

### 9. 卡片与双向导航

1. 卡片至少包含来源路径、标题、类型、真实摘录、primary anchor、全部相关锚点、出现次数、occurrence 列表和状态。
2. 卡片主体定位原文：active 使用精确范围，译文只按契约软映射；source-changed／translation-changed 显示相应状态，removed 进入失效成果区域。
3. “打开成果”动作按 occurrence 打开来源 Markdown 的精确 AST 位置；workspace 决定当前窗格或侧边打开，reader 保留阅读位置。
4. 打开 occurrence 前重新核对当前路径和内容版本。内容已变化时先重扫并按同组 ordinal 解析；找不到该 occurrence 就明确报错，不跳到相邻行或相似文本。
5. 在 Markdown 中点击 anchor link 时，先重新解析 payload 与 current，再定位原文；不调用 PDF、旧 citation 或系统外部协议。
6. changed 链接不得显示伪精确高亮：原文节点仍在时可以显示单元级变化提示，removed 只展示原摘录与 tombstone。
7. wrong-paper、invalid 和无有效锚点的条目不能挂到当前正文旁，集中在失效诊断中提供来源位置与原因。
8. 卡片数据更新不得改变 current、原生 sidecar 或 Markdown 内容；只有明确的编辑／删除命令才能写数据。

### 10. 缓存、预算与异步一致性

1. 磁盘文件按路径＋内容 hash／元信息做增量扫描，打开草稿按 path＋epoch＋内容 hash 做索引；缓存只保存可重建结果。
2. 文件移动先更新路径映射，内容未变无需重扫；重开时以真实磁盘和当前草稿重建，不信任过期缓存。
3. 扫描、解析、迁移和卡片更新使用可取消任务或 epoch。工程、current、翻译 revision、路径或草稿变化后，旧结果不得覆盖新状态。
4. 首版预算：

| 项目 | 上限 |
|---|---:|
| 单个 Markdown 文件扫描 | 8 MiB |
| 单次全量扫描普通 Markdown 合计 | 128 MiB |
| 单个锚点链接 UTF-8 | 64 KiB |
| 单链接 ranges | 256 |
| 单文件有效链接 occurrence | 2,000 |
| 单文件扫描耗时任务 | 可取消，不阻塞其他文件 |

5. 超预算文件或链接产生明确诊断并跳过，其他文件继续；不得截断 quote、链接或 AST 后生成看似有效卡片。
6. 缓存损坏只触发重建，不删除 Markdown 或原生记录；缓存和 sidecar 的故障必须区分。

## Error and Recovery Requirements

| 情况 | 必须行为 |
|---|---|
| payload 非法、版本未知、quote 缺失或 range 越界 | 标 invalid，提供来源位置，不生成有效卡片 |
| 链接来自另一 paper.id | 标 wrong-paper，不按标题或 arXiv ID 自动重绑定 |
| 原文 changed／removed | 保留摘录与失效状态，不调整 range 或相似重挂 |
| 译文 revision 改变 | quote 匹配才重基，相关变化只影响对应 view |
| 原生记录外部变化或编辑基线冲突 | 保留用户输入与旧 sidecar，不静默覆盖 |
| 原生记录删除后 Markdown 仍有链接 | Markdown 卡片继续独立工作 |
| 文件移动／改名 | 更新路径与 occurrence，不重写原 anchor，不重复建卡 |
| 未保存草稿与磁盘冲突 | 草稿用于实时卡片并标冲突，不双份展示、不覆盖草稿 |
| 链接被编辑或删除 | 增量更新／移除卡片，旧异步结果不得复活它 |
| occurrence 打开时内容已变 | 重扫并校验 ordinal，找不到就报错，不猜相邻位置 |
| 扫描缓存损坏或超预算 | 缓存重建／明确跳过，正文和原文件继续可用 |
| current 迁移 sidecar 失败 | 保留旧记录并警告，新 current 不回滚，记录不错挂 |

错误恢复不得通过模糊 quote 搜索、全文相似度重锚、删除用户文件、覆盖未保存草稿或默认接受错误 payload 来完成。

## Testing Strategy

### 锚点 codec 与解析

覆盖所有 DocumentAnchor 类型、原文／译文 range、UTF-16、atom、跨句／跨单元和大 quote：

- 规范 JSON＋base64url 往返无损，非规范输入解析后按语义去重。
- wrong-paper、非法版本、未知字段、越界、错误父子关系和超预算被拒绝。
- retained／moved 保持 active，changed／removed 按契约失效，quote 不触发模糊重锚。
- 译文 quote 匹配可重基，局部重译只影响相交 range。
- 链接点击只走应用内导航，危险 payload 不执行、不渲染 HTML。

### 原生高亮与批注

- 创建时重新校验 ReaderSelection，highlight／note、长批注、编辑、删除和复制链接行为正确。
- 外部修改、记录 ID 冲突、基线变化和写入失败保留现场。
- 原生删除不删除 Markdown 链接，Markdown 删除不删除原生记录。
- revision 迁移覆盖 retained／moved／changed／removed 和翻译重基，staleReason 不被编辑或缓存重建清除。
- Agent 不能直接写 sidecar，普通阅读与扫描不产生隐式写入。

### Markdown AST 与扫描范围

使用 inline／reference links、未使用 definition、代码、图片、raw HTML、伪 scheme、不同扩展名和嵌套目录 fixtures：

- 只提取真实支持的链接，occurrence 位置与实际 AST 一致。
- notes／explanations／memories、根目录和用户自建目录均可生成卡片。
- paper／sources／内部目录／tmp／符号链接不生成卡片，tmp 内显式点击仍可校验导航。
- 无效链接不阻塞其他文件，错误包含路径和位置。
- 卡片标题、类型、真实摘录和失效诊断正确，不调用模型。

### 重复、移动与草稿

- 同文件同 anchor＋view 合并并保留全部 occurrence；不同 range、不同文件和不同 view 不错误合并。
- base／translation revision 不同可同组，但各 occurrence 独立校验状态。
- 文件移动、复制、删除、链接新增／编辑／删除时卡片正确更新。
- 未保存草稿覆盖实时索引并标 unsaved，冲突时不双份显示，保存／丢弃／改路径后正确回退。
- occurrence 打开使用同版本草稿；内容变化后重扫 ordinal，找不到不错跳。
- 快速输入、移动和切换工程时，迟到扫描结果不会复活旧卡片。

### 真实 Electron 与视觉回归

通过生产 preload、IPC、真实临时工程和编辑器验证：

1. 原文／译文高亮与批注、编辑、删除、复制链接、重开和 revision 迁移。
2. 普通 Markdown 链接生成卡片，正文与成果双向定位，重复链接计数和全部 occurrence 可达。
3. 未保存草稿的卡片出现／更新／消失，外部冲突不双份、不覆盖输入。
4. 文件移动、跨工程复制、wrong-paper、changed／removed／invalid 链接呈现。
5. 宽屏锚定边栏与窄屏内联中的多卡、重叠范围和失效区域截图及交互。
6. 扫描缓存删除后结果一致，工程整体搬迁后链接与卡片继续工作。
7. 不出现 PDF 原生批注依赖、旧 `#annotation=`、`paper://cite` 或成果关系数据库。

## Boundaries

### Always do

- 以稳定 paper／node ID、完整 quote 和语言视图组成自包含锚点链接。
- 将原生高亮／批注与普通 Markdown 成果分开持久化、分开删除。
- 扫描全部普通 Markdown，排除 tmp、受管区、代码和工程外路径。
- 让未保存草稿参与实时卡片，并按文件＋规范化锚点＋view 合并重复链接。
- 用真实 AST 位置、changeset 和 quote 校验导航与失效，不模糊重挂。
- 用真实磁盘、草稿和 Electron 验证移动、冲突、迁移和双向定位。

### Ask first

- 引入成果关系数据库、文件登记、手工重绑定或新的受管成果类型。
- 引入 quote／相似度自动重锚、词级中英对齐或模型卡片摘要。
- 扩大扫描到 tmp、sources、隐藏内部目录、符号链接或工程外文件。
- 修改锚点 URL、分组键、失效状态、预算或草稿优先级。
- 支持 raw HTML 锚点、系统外部 scheme 执行或跨工程自动迁移。

### Never do

- 把 PDF 路径、原生 PDF 批注 ID、数组位置或 revision 路径作为文本锚点。
- 让 Markdown 卡片依赖原生批注记录存在，或建立成果关系数据库。
- 根据 quote、标题、arXiv ID 或相似内容把链接重挂到另一位置／论文。
- 用磁盘扫描覆盖未保存草稿，或为磁盘与草稿生成重复卡片。
- 将 tmp 候选、代码、图片目标或纯文本 scheme 当作已保存成果。
- 因 translationRevision 或 revisionId 改变让全部链接失效。
- 让过期 occurrence 覆盖同组的新有效 occurrence，或让迟到扫描复活已删除链接。
- 恢复 `#annotation=`、`paper://cite`、独立问答卡或自动论证关系。

## Success Criteria

- [ ] 文本锚点 URL 自包含、版本化并绑定 paper.id，原文与译文选区均可无损表达。
- [ ] 原生高亮／批注可创建、编辑、删除和迁移，不与 Markdown 成果相互删除。
- [ ] 普通 Markdown 与用户自建目录可生成卡片，tmp／受管区／代码／符号链接不参与。
- [ ] 未保存草稿实时驱动卡片，外部冲突不双份展示，保存与丢弃后的状态正确。
- [ ] 同文件同锚点＋view 合并并保留全部 occurrence，不同 range 和不同文件不错误归并。
- [ ] 文件移动、改名、复制和工程搬迁不会制造错挂或无谓重复。
- [ ] changed／removed／invalid／wrong-paper 有明确诊断，quote 不触发自动重锚。
- [ ] 卡片与 Markdown 双向定位使用同版本 AST 位置，内容变化后不错跳相邻文本。
- [ ] 缓存删除后可完整重建，异步旧结果不会覆盖新草稿、revision 或工程状态。
- [ ] 不出现 PDF 原生批注权威、旧引用字典、独立问答卡或成果关系数据库。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron 回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。以下事项由对应规格继续定义：

- 成果在当前窗格／侧边打开及布局恢复：`workspace`。
- Agent 生成／编辑 Markdown 成果和原生批注的任务边界：`agent-integration`。
- 结构化正文与 PDF 原页同步：`pdf-comparison`。
- 旧 PDF 批注与引用链接的迁移或拒绝：`legacy-projects`。
