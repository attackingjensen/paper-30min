# Spec: pdf-comparison

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[arxiv-import](SPEC-arxiv-import.md)、[pdf-import](SPEC-pdf-import.md)、[workspace](SPEC-workspace.md)（均已批准）  
> 协同：[document-core](SPEC-document-core.md)、[reader](SPEC-reader.md)（均已批准）  
> 下游：`legacy-projects`

## Objective

在结构化 reader 与其 PDF 原页并排时，提供可重建的 **unit→页／区域映射**、双向点击定位和正文阅读位置跟随。PDF 始终是可选对照视图：没有 PDF 的 arXiv HTML 工程可以完整阅读，只有用户打开对照时才取得固定版本 PDF 或显式选择本地对照副本。

映射是派生缓存，不是正式引用权威。它优先使用云端解析的页／块事实，其次使用 PDF 文本层与 current 原文的可证明匹配。区域、页级、候选和无法定位必须明确区分；任何相似度、最近段落或三连词投票都不能单独决定唯一目标。

本模块成功时，应满足：

- arXiv 对照 PDF 固定当前 `vN`，本地对照副本标记为“用户提供”，均不自动改变 current、来源身份或触发云端解析。
- 点击正文可以定位 PDF 区域／页，点击 PDF 文字／区域可以定位原文章节／unit；译文沿用原文映射，不推算译文对应的 PDF 字符位置。
- 正文阅读位置变化可以跟随定位 PDF，但用户手动浏览 PDF 时能暂停跟随，避免两侧互相抢滚动。
- 映射按 current revision、PDF 快照和算法版本重建，局部修正只使相关映射失效，旧坐标不冒充新内容。
- PDF 原文和快照不被修改，不出现正式 PDF 引用字典、`paper://cite` 或持久原生批注。

## Scope

### In scope

- arXiv 当前版本 PDF 的按需下载、已有 PDF 复用和显式本地对照副本。
- 对照 PDF 的来源角色、匹配覆盖诊断、快照不可变性和版本更新。
- 云端页／块事实到 current source alias 的直接映射。
- PDF 文本层、规范化、词坐标、可证明唯一匹配和区域构建。
- `source-region`／`text-region`／`page`／`candidates`／`unmapped`／`stale` 映射状态。
- 正文→PDF 与 PDF→正文点击、跟随、暂停／恢复和瞬态高亮。
- 跨页 unit、混合页面尺寸、旋转／裁剪、扫描 PDF 和无文本层降级。
- current 修正、来源更新、算法升级、缓存重建和异步任务隔离。
- workspace 兼容配对、多 reader 实例和独立跟随状态。

### Out of scope

- PDF 云端解析、翻译、Agent 对话和实际核验记录。
- 通用 PDF 阅读器、双窗格布局和页签持久化，属于 `reader`／`workspace`。
- PDF 原生批注、持久引用链接、区域框选引用和旧 citation 工具。
- 用 PDF 图片替换 HTML 图、图表重绘、OCR 和本地 MinerU。
- 连续滚动百分比双向绑定、PDF 与译文的词级对齐和模型辅助映射。
- 旧 PDF 映射与引用迁移，属于 `legacy-projects`。

## Tech Stack

- Node.js utility process 负责 PDF 获取、文本层／词坐标提取、映射和缓存；React／EmbedPDF 负责原页与瞬态交互。
- 沿用现有 `@embedpdf`／PDFium、PDF 快照、source alias 和 reader／workspace 宿主接口。
- document-core 的稳定 unit／block ID、sourceAliases、changeset 与 tombstones。
- 确定性 Unicode／空白／断词规范化、PDF 词坐标和云端 `facts.json`；不调用模型、OCR 或云端重解析。
- JSON／二进制可重建缓存按 revision、PDF SHA-256 与 algorithmVersion 隔离；不引入数据库或正式引用字典。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron、PDF 与同步交互回归：

```powershell
npx playwright test -g 'pdf-comparison'
```

默认使用本地 HTML／JSON 文档树、PDF 和解析事实 fixtures，不访问真实 arXiv、云端解析或模型服务。真实 arXiv 下载验收单独记录固定版本与日期；原生 PDF 选择、滚动、焦点和视觉定位需要实际窗口证据，不能只凭映射对象断言记为通过。

## Project Structure

### 仓库代码边界

```text
app/src/main/pdf-comparison/  PDF 获取、文本层、映射、缓存和恢复
app/src/shared/pdf-comparison/  映射状态、来源角色和 IPC 类型
app/src/renderer/pdf/        原页配对、点击、跟随和瞬态高亮
app/tests/fixtures/pdf-comparison/  文本层、旋转、跨页、歧义和扫描 fixtures
app/tests/                   映射、故障注入和真实 Electron 回归
```

现有 `pdf-citations.ts` 只作为 EmbedPDF 选择、页面坐标和瞬态高亮参考。其 createCitation、正式引用链接和 PDF 原生批注职责不进入新模块。textfold 的懒下载与双栏交互可以借鉴，但三连词投票不能作为唯一可靠性证明。

### 对照 PDF 与缓存契约

对照使用 pdf-import 已定义的不可变 PDF 快照，并增加用途／角色事实，不复制另一份 PDF：

```text
sources/<pdfSourceSnapshotId>/
  snapshot.json             # kind: "pdf"；purpose、origin、paperId、版本与摘要
  paper.pdf

.paper30min/cache/pdf-comparison/
  <revisionId>-<pdfSha256>-<algorithmVersion>/
    index.json              # 映射状态、覆盖与构建诊断
    entries/                # 可重建 unit→页／区域条目
```

- `purpose` 区分 `primary-source` 与 `comparison-copy`。本地 PDF 导入的主来源可以继续对照，arXiv HTML 懒下载和用户显式副本只用于对照，除非用户另行走主来源导入流程。
- `origin` 区分 `arxiv-download` 与 `user-supplied`。用户提供副本始终显示该事实，不因文本匹配就改标为 arXiv 同源文件。
- 缓存键包含 current revision、PDF SHA-256、解析快照（若有）和算法版本。缓存不是 current、锚点或来源身份。
- 映射条目记录 method、precision、page／boxes、source alias、current content hash、PDF span hash、诊断和构建状态。
- 缓存可以整体删除重建；不得写入正式 citation、修改 PDF、source snapshot、document tree 或 `paper30min.json`。

## Code Style

映射显式区分方法和精度：

```ts
export type ComparisonPrecision =
  | "source-region"
  | "text-region"
  | "page"
  | "candidates"
  | "unmapped"
  | "stale";

export interface ComparisonTarget {
  revisionId: string;
  unitId: string;
  pdfSourceSnapshotId: string;
  method: "parser-facts" | "pdf-text" | "source-alias" | "page-facts";
  precision: ComparisonPrecision;
  contentSha256: string;
  pages: ComparisonPage[];
}

export interface ComparisonPage {
  page: number;
  width: number;
  height: number;
  boxes: ComparisonRect[];
}
```

- `source-region` 来自云端页／块事实，`text-region` 来自 PDF 文本层可证明匹配；两者都不能写成“逐字选区已验证”。
- `page` 只有页级定位，`candidates` 保留多个可能目标，`unmapped` 没有可用目标，`stale` 表示旧内容／坐标已失效。
- boxes 使用实际页面坐标与尺寸，支持每页多个框和跨页多个页面；不可用坐标必须为空，不能伪造。
- `contentSha256` 绑定 current 内容；PDF span 另行核验，避免把 current 已修正文本误认为与 PDF 一致。
- Node ESM 相对导入沿用 `.js` 后缀，共享类型不得导入 Node 或 React 模块。

## Behavior Contract

### 1. 可选 PDF 与来源角色

1. arXiv HTML 工程不打开对照时不请求 PDF。用户点击“PDF 对照”后，才下载当前 revision 对应 arXiv base ID 的固定 `vN` PDF。
2. 下载遵守 arxiv-import 的 host、HTTPS、重定向、取消、重试和格式校验规则；只接受实际 PDF，不以 HTML 错误页冒充。
3. 对照 PDF 单文件最大 100 MiB、最多 1000 页。之后若用户另行请求云端解析，pdf-import 的 50 MiB 上传上限仍独立适用。
4. 已有相同 SHA-256 的已验证 PDF 快照可以复用，不重复下载；不同版本或字节必须形成新快照，不原地覆盖。
5. 当前 arXiv revision 更新到新 `vN` 后，旧 PDF 不自动作为当前对照。用户可显式查看历史 PDF 并看到版本标识，或取得新固定版本。
6. PDF 主来源导入的工程直接复用其父 PDF 快照；对照不额外复制文件，也不重新上传云端。
7. 用户可以显式选择本地 PDF 作为 comparison-copy：
   - 只读复制并记录 `origin: user-supplied`、paperId、文件名、摘要和选择时间。
   - 不替换主论文、current 或主来源，不自动成为后续云端解析／上游核验的同源证明。
   - 后续用于来源读取时必须显示“用户提供对照副本”，不能声称它是 arXiv 原始下载。
8. 加密、损坏、超限或无法读取的 PDF 被拒绝并给出具体错误；current 结构化正文继续可读。
9. 对照副本的获取和配对不是普通文件树“打开 PDF”动作；只有这条显式命令才建立受管对照快照和论文关联。

### 2. 用户副本匹配诊断

1. 对用户副本和懒下载 PDF 构建映射后，展示实际可定位 unit 数、source-region／text-region／page 覆盖和无法映射原因；不把覆盖率称为解析正确率。
2. 对 `user-supplied` 副本，如果可证明 text-region 的正文 unit 比例低于 30%，显示“可能是不同论文／版本”的强警告，并要求用户再次确认后才能启用跟随。
3. 30% 只是交互警告阈值，不是同源证明、内容正确率或自动接受标准；高于阈值仍始终保留 user-supplied 标识。
4. 如果完全没有可证明文本匹配，默认只允许手动页浏览，不启用自动跟随；用户仍可明确选择人工对照。
5. primary-source PDF 不按该阈值阻止对照，因为其解析树本来就可能与 PDF 有识别差异；只展示真实映射覆盖和限制。
6. 不匹配警告不会删除副本或 current。用户可以选择另一副本、继续仅页浏览或关闭配对。
7. 匹配诊断不采用 textfold 的三连词票数作为同源结论，只接受本规格的 source-region／text-region 证据。

### 3. 映射输入与规范化

1. 映射使用 current Reader 投影、PDF 快照、可用的解析 `facts.json` 和 PDF 文本层，不使用 source-base 代替 current，也不使用旧 candidate.md。
2. PDF 文本层提取保留每个词的页码、实际坐标、顺序和页面尺寸。没有文本层时不执行 OCR；只有云端事实／页级证据可用。
3. Unicode、空白、软连字符、换行断词、连字和 PDF 分片词的规范化必须确定且带 algorithmVersion；不得按显示语言随意改写原句。
4. 公式和 atom 可以有独立边界。PDF 公式字符与 LaTeX 不同的时候，不能把普通文本相似度当作公式已一致，也不能因此静默丢弃整个 unit 的边界信息。
5. 多栏、跨页和混合尺寸页面使用实际 PDF 顺序和可验证结构；无法证明阅读顺序时降级，不按 x／y 坐标猜全文顺序。
6. 旋转、crop／media box、预处理缩放和坐标原点必须统一校验；不可靠几何只保留页级事实。
7. 映射任务可以按页增量完成并显示真实进度；正文与 PDF 页浏览不等待全篇映射完成。

### 4. 映射证据等级

按以下优先级生成目标，低等级证据不能覆盖已经可靠的高等级目标：

1. **parser-facts／source-alias**：云端解析页／块事实与 current source alias 对齐，且页码、几何和校准通过时生成 source-region；几何不可靠时只生成 page。
2. **pdf-text 可证明匹配**：规范化的完整 unit／sentence 或连续片段在 PDF 词序列中有唯一、顺序一致且边界明确的结果，生成 text-region。
3. **page-facts**：只能确认来源页或唯一页面文本证据时生成 page，不生成虚假区域。
4. **candidates**：多个满足基本条件的页／区域／unit，保留全部候选和证据，不自动选唯一目标。
5. **unmapped**：没有可证明目标，明确不可定位。

可证明文本匹配必须满足：

- n-gram 只可用于寻找候选，最终必须由完整连续序列、唯一性和顺序关系验证；不能仅凭票数或相似度接受。
- 重复段落、公式、短标题和常见短语需要足够结构上下文；不能仅凭单一 quote 或相同哈希决定身份。
- 区域来自实际 PDF 词框或可校准块框，支持跨行／跨页；不得用最近文字框、最近段落或整块页面冒充精确区域。
- 无法比较的 atom 内容必须记录为限制，不能宣称整个 unit 已逐字一致。
- 任何自动阈值都只是构建诊断，不能把模糊候选提升为可靠区域。

### 5. current 修正与缓存重建

1. retained／moved 的 unit 保留映射，更新阅读顺序但不重新计算坐标。
2. current changed 时：
   - parser-facts／source-alias 可以保留为“来源区域”，但必须标记 current 与来源内容不同，不能用于证明一致。
   - pdf-text 条目仅在当前文本与 PDF span 仍完全匹配时保留，否则标 stale 并尝试重新构建。
3. removed／拆分／合并的条目进入 stale／tombstone 诊断，不把旧区域挂到新 unit。
4. added 单元没有旧映射，必须重新证明；不得因它与旧文本相似就继承坐标。
5. 新 PDF SHA-256、不同 parse snapshot 或 algorithmVersion 改变时，旧缓存整体只作历史诊断，必须重建，不能复用旧坐标。
6. 同一 PDF 重解析产生新 source alias／facts 时，按 document-core 对齐结果延续可用映射，不因批次号单独让全部映射失效。
7. 缓存先完整写入 staging 并验证，再原子替换当前缓存 index；崩溃留下的部分缓存不被当作完整映射。
8. current、PDF、解析快照或算法在构建中变化时，旧任务只保留原 key 的部分结果，不写入新 key，也不阻塞新任务。

### 6. 正文→PDF 点击与跟随

1. 在兼容配对中，点击正文 unit／block 会定位其 PDF 目标：
   - source-region／text-region 滚动到首个区域并显示全部相关瞬态框。
   - page 只滚动到页面并明确显示“仅页级定位”。
   - candidates 展示候选，不自动选择唯一目标；unmapped／stale 显示原因。
2. 点击是显式导航，允许用户关闭点击同步或跟随；普通文本选择和拖动不自动触发跳转。
3. 译文视图沿用同一原文 unit 映射，定位的是原文 PDF 区域，不尝试把译文 range 换算成 PDF 坐标。
4. **阅读位置跟随**开启时，reader 当前阅读锚点变化后经过短防抖再定位 PDF；不逐滚动帧同步，也不按两侧滚动百分比绑定。
5. 跟随只在目标可靠为 region／page 时自动滚动；candidates、unmapped、stale 或 user-supplied 强警告未确认时，仅更新状态，不抢滚动。
6. 如果目标区域已经完整可见，跟随只更新高亮，不重复滚动；连续小范围阅读保持原 PDF 位置。
7. 用户手动滚动 PDF 后暂停自动跟随并显示“继续跟随”。手动 PDF 浏览不会被下一次正文滚动立即抢回；点击正文或显式“继续跟随”可以恢复。
8. PDF→正文点击后设置新的同步 epoch，等待正文布局稳定，避免刚完成的反向导航立即触发旧 reader-follow 抢回。
9. 跟随只从 reader→PDF，不因 PDF 滚动百分比反向滚动正文；PDF→正文只由明确点击／命令触发。
10. 跟随和点击不切换活动页签、不改变当前窗格或替换 Agent 附件；键盘焦点政策与导航命令一致，不能无提示跳动。

### 7. PDF→正文点击与选区

1. 点击 PDF 文本时，通过实际词／块坐标查找包含它的 current 映射：
   - 唯一 unit 时定位该 unit／block 并显示对应高亮。
   - 多个重叠 unit 时展示候选，不按“最近段落”或最小面积强行选择。
   - 没有目标时只保留 PDF 位置并提示。
2. 对 parser-facts 区域点击，source-alias 可以定位 current 中经过可靠对齐的节点；current 已修正时显示“来源区域与 current 不同”。
3. PDF 页空白处只有在存在唯一可靠块区域时才允许反向定位；否则不做最近段落猜测。
4. PDF 文本选区完成后提供“在正文中查找”动作：使用完整规范化选区与 PDF 词序列验证唯一 current 目标；选区本身不自动跳转或清除。
5. 跨页选区按页保存片段，只有所有必要片段与同一 current 范围可证明对应时才精确反向定位，否则显示候选／限制。
6. PDF 文字与原文不一致时，可以复制真实 PDF 摘录交给 Agent，但不得把它包装成 current 的 DocumentAnchor。
7. 反向定位只改变对应 reader 实例的阅读位置，不修改 current、PDF、批注或成果链接。

### 8. 瞬态高亮与原页状态

1. PDF 区域高亮是当前配对／导航的瞬态覆盖层，不写入 PDF、不保存为原生批注、不生成正式引用链接。
2. 新导航替换旧高亮；切换 revision、PDF、页签、配对或来源时清除旧高亮，迟到绘制不得恢复。
3. source-region、text-region、page-only、current-differs 和 candidates 在视觉及可访问文本上可区分，不能只靠颜色。
4. 高亮坐标来自公共 PDF 页面／viewport API，随缩放、旋转、滚动和布局更新；不能用 DOM 文本框近似代替 PDF 坐标。
5. 跨页区域可以分别在对应页面绘制，但导航首先定位首个区域；其余区域不阻塞页面渲染。
6. PDF 页面继续按可见邻域有界渲染，映射文本索引与位图缓存分离。长 PDF 不因建立文本映射就一次性栅格化所有页面。
7. 原页的缩放、旋转、spread 和手动阅读位置由 workspace 独立保存；自动跟随不把这些视图偏好变成全局设置。

### 9. workspace 配对与异步隔离

1. 只有主论文 reader 与相关 PDF 快照可以建立语义配对；普通 Markdown｜PDF、笔记｜笔记等只并排，不建立映射。
2. 同 pageKey 的多个 reader 实例可与同一 PDF 配对，共享只读缓存，但各自拥有点击、跟随、暂停、当前目标和 epoch。
3. 原文｜译文视图切换只改变显示语言，不复制 PDF 快照或改变映射权威；各实例可以独立暂停跟随。
4. 页签移动、分栏、关闭、工程切换、current 更新或 PDF 改变都会使旧配对任务失效；迟到结果不能滚动新页面。
5. 配对建立和映射构建不阻塞中栏其他页面；失败时保留 reader 与 PDF 独立阅读和手动页导航。
6. pdf-import 的 SourceReadReceipt 与核验记录不由普通映射自动产生。只有 agent-integration 的显式来源读取和核验命令才能创建它们。
7. user-supplied comparison-copy 被用于 Agent 来源读取时，receipt 必须保留其 origin，不能冒充 arxiv-download 或 primary-source。

### 10. 预算与资源边界

首版限制：

| 项目                |                       上限 |
| ------------------- | -------------------------: |
| 对照 PDF            |                    100 MiB |
| PDF 页数            |                  1–1000 页 |
| 单页文本词项        |                     50,000 |
| 单 PDF 文本词项合计 |                  5,000,000 |
| 单缓存 key 数据     |                    256 MiB |
| 页面位图            | 可见邻域有界，不全页预渲染 |

超预算时保留已验证页级／局部事实并报告具体项目，不截断后宣称完整映射。云端解析预算、document-core 节点预算和 workspace 恢复预算继续独立适用。

## Error and Recovery Requirements

| 情况                                     | 必须行为                                           |
| ---------------------------------------- | -------------------------------------------------- |
| arXiv PDF 下载失败、版本混杂或响应非 PDF | current 继续可读，允许重试或显式本地副本，不改版本 |
| 用户副本匹配很低或完全不同               | 强警告并禁用默认跟随，不冒充同源或删除文件         |
| 无文本层、扫描 PDF 或几何不可校准        | 使用可用云端事实／页级定位，不执行 OCR 或伪造区域  |
| 重复文本、歧义匹配或阅读顺序不明         | 展示候选／unmapped，不选择唯一目标                 |
| current 局部修正                         | 来源区域标注差异，文本匹配仅相关条目 stale／重建   |
| PDF／解析快照／算法改变                  | 旧缓存不应用，按新 key 重建                        |
| 缓存写入中断或损坏                       | 从 current 与 PDF 重建，不影响正文或原页           |
| 用户手动浏览 PDF                         | 暂停跟随并显示恢复入口，不抢滚动                   |
| 配对／revision／页签切换                 | 清除旧高亮和任务，不应用迟到定位                   |
| 超预算                                   | 明确降级，不截断后宣称完整映射                     |

错误恢复不得通过相似度猜测、自动云端重解析、覆盖 current／PDF、强制跟随或恢复正式引用字典来完成。

## Testing Strategy

### PDF 获取与用户副本

- 未打开对照时无 PDF 请求；打开后只下载当前 vN，失败可重试且 current 可用。
- 相同字节复用、不同字节新快照、版本更新后旧 PDF 不冒充当前。
- user-supplied 只读复制、origin 与 paperId 正确，不能自动成为主来源或同源证明。
- 低于阈值、零匹配和部分匹配的警告、手动页浏览和跟随启用规则。
- 加密、损坏、超限和非 PDF 响应。

### 映射算法

使用唯一／重复段落、连字、断词、公式、多栏、跨页、混合尺寸、旋转、裁剪和扫描 fixtures：

- parser-facts 与 source alias 对齐，校准失败只保留 page。
- 完整连续文本唯一匹配生成 text-region，重复／歧义生成 candidates 或 unmapped。
- n-gram 投票本身不能接受目标，最近段落和单一 quote 不能决定映射。
- 跨行／跨页 boxes 来自真实词框，区域不伪造，atom 限制明确。
- 无文本层不执行 OCR，超预算明确降级。
- 缓存键、原子提交和损坏重建正确。

### current 更新与缓存迁移

- retained／moved 保留，changed 区分来源区域与文本一致性，added 重新证明，removed／split／merge 不继承。
- 同 PDF 重解析按 alias 延续，新 PDF／算法版本不混用旧坐标。
- 局部修正只重建相关条目，不全篇无差别失效。
- 构建中 revision／PDF／算法变化时旧任务不写新 key。

### 点击、跟随与反向定位

- region／page／candidates／unmapped 的正文→PDF 行为与提示。
- 阅读位置跟随防抖、已可见不重复滚动、手动 PDF 暂停和显式恢复。
- PDF→正文设置同步 epoch，不与旧 reader-follow 互相抢滚动。
- 译文沿用原文 unit，不换算译文 range；普通选择不自动跳转。
- PDF 文字／区域点击唯一、重叠、空白和 current-differs 分支。
- PDF 选区唯一、跨页、歧义和失败时保留选择，不自动清除或伪造 anchor。
- 瞬态高亮随缩放／旋转／布局更新，旧 epoch 不恢复。

### 真实 Electron 与视觉交互回归

通过生产 preload、IPC、真实临时工程和复杂 PDF 验证：

1. arXiv HTML 无 PDF 阅读、懒下载固定版本、离线重开对照。
2. 本地主来源 PDF、用户对照副本、匹配警告与不同来源角色。
3. 正文｜PDF 双向点击、跟随／暂停／恢复、译文对照和候选降级。
4. 跨页、旋转、混合尺寸、扫描 PDF、长 PDF 有界渲染与真实截图。
5. current 修正、来源更新、缓存重建和工程搬迁后的配对。
6. 多 reader 实例独立跟随、页签移动／关闭和旧异步结果隔离。
7. 不出现 createCitation、正式引用链接、PDF 原生批注或自动云解析。

原生 PDF 选择、系统焦点、实际滚动和视觉区域验收单独记录，不能只凭映射数据或 DOM 事件记为全部通过。

## Boundaries

### Always do

- 将 PDF 保持为可选只读对照，固定 arXiv 版本并标记用户副本来源。
- 使用可重建缓存和明确的 source-region／text-region／page 精度。
- 只接受可证明映射，歧义保留候选，无法定位就明确说明。
- 支持双向点击、reader→PDF 跟随和手动浏览暂停／恢复。
- 按 current changeset 局部迁移，隔离旧 PDF、旧缓存和旧异步任务。
- 用真实 PDF、Electron、截图和交互验证坐标、跟随及长文档。

### Ask first

- 引入模型／OCR 映射、相似度唯一重挂或词级译文↔PDF 对齐。
- 增加连续滚动百分比双向绑定、持久 PDF 批注或正式引用链接。
- 修改对照快照角色、匹配阈值、缓存键或跟随暂停政策。
- 自动下载新 PDF、云端重解析或把用户副本提升为主来源。
- 修改预算、页面坐标协议或将图片替换为 PDF 裁剪图。

### Never do

- 把 PDF 作为 arXiv HTML 工程的必需文件，或在对照时自动改版本。
- 把用户提供副本标为 arXiv 同源／原始下载，或仅凭覆盖率证明身份。
- 用三连词投票、最近段落、单一 quote 或相似度选择唯一目标。
- 把 OCR 输出当作 PDF 文本层，或伪造不可校准区域。
- 让跟随持续抢回用户手动 PDF 浏览，或双向绑定滚动百分比。
- 将 PDF 坐标缓存当作正文／锚点权威，或跨 revision／PDF 复用旧坐标。
- 创建正式 PDF 引用字典、持久原生批注或自动云解析任务。
- 让旧高亮、旧映射或旧异步结果应用到新配对。

## Success Criteria

- [ ] arXiv HTML 工程无 PDF 时可读，打开对照才取得当前 vN；本地副本来源清晰且不改写主来源。
- [ ] 用户副本匹配警告不会冒充同源证明，低匹配时默认不自动跟随。
- [ ] 映射优先使用解析事实和可证明文本匹配，区域／页级／候选／unmapped 明确。
- [ ] 正文与 PDF 可双向点击，译文复用原文 unit，无词级偏移猜测。
- [ ] reader→PDF 跟随可暂停／恢复，手动 PDF 浏览不被抢回，无滚动百分比绑定。
- [ ] 跨页、旋转、裁剪、扫描和无文本层均按证据降级，不伪造区域。
- [ ] current 局部修正只影响相关映射，新 PDF／算法版本不会复用旧坐标。
- [ ] 缓存可重建、写入原子、损坏可恢复，不形成正式引用权威。
- [ ] 多实例跟随、旧异步结果和瞬态高亮不会串到错误 revision／PDF／页签。
- [ ] 不出现 `paper://cite`、PDF 原生批注、自动 OCR 或云端重解析。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron／视觉交互回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。旧 PDF 映射、原生批注和引用链接如何处理，由 `legacy-projects` 定义。
