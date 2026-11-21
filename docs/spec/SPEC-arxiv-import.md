# Spec: arxiv-import

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[project-core](SPEC-project-core.md)、[document-core](SPEC-document-core.md)（均已批准）  
> 协同：`pdf-import` 仅接收显式回退请求，不构成本模块的实现依赖  
> 下游：`pdf-comparison`

## Objective

为 Paper30Min 提供以 **arXiv 官方 LaTeXML HTML** 为首选来源的导入能力。用户输入 arXiv URL 或 ID 后，系统固定实际版本，保存不可变的原始 HTML、元数据和图片快照，并转换为 `document-core` 的类型化文档树；正常阅读和离线重开不需要 PDF、OCR 或模型服务。

HTML 只是来源，不是第二份当前正文。只有转换后的 current revision 是界面与 Agent 的阅读权威。HTML 不存在、无法取得或核心结构不可读时，系统保留可恢复现场并说明原因，只有用户显式确认后才把固定版本交接给 `pdf-import`，不得自动下载 PDF 或产生云端解析费用。

本模块成功时，应满足：

- 无版本输入在导入开始时解析为确定的 `vN`，有版本输入绝不静默改用其他版本。
- 原始来源与本地资产可追溯、可重新处理，current 的推进仍遵守基线与候选提交协议。
- 主体文字、章节和阅读顺序完整可验证；局部图片或引用问题以明确警告降级，不冒充零问题。
- 新版本检查、同版 HTML 重取和既有快照重新转换是三个不同动作，都不会自动覆盖 current。

## Scope

### In scope

- 新旧式 arXiv ID、`arXiv:` 前缀及 abs／html／pdf URL 的解析与规范化。
- 无版本引用的实际版本固定、显式版本校验、撤稿版本识别和来源身份关联。
- arXiv abs 元数据、LaTeXML HTML 与引用资产的受控获取、重试、取消、预算和诊断。
- 不可变来源快照、原始字节、资产映射、来源事实与获取警告。
- LaTeXML HTML 到规范文档树的确定性转换、来源别名、内容覆盖与安全消毒。
- 首次导入的可读门槛、恢复阶段、离线重开和离线重新转换。
- 用户主动的新版本检查、新来源候选、同版 HTML 重取和既有快照重新转换。
- 显式 PDF 回退请求的固定版本、原因和 `baseRevision` 交接。

### Out of scope

- PDF 下载、云端解析、解析提供商和费用控制的具体实现，属于 `pdf-import`。
- PDF 原页显示、unit→页／区域映射和双向同步，属于 `pdf-comparison`。
- 文档树 schema、稳定 ID 生命周期、三方合并与 changeset 的内部实现，属于 `document-core`。
- 阅读器布局、翻译、批注、成果卡片、Agent 工具和工作区。
- 本地 TeX 编译、本地 LaTeXML／MinerU、arXiv source tarball 导入和 ar5iv 来源。
- 通用网页抓取、DOI 解析、参考文献外部补全和 arXiv 以外的 HTML 来源。
- 后台自动更新、自动 PDF 回退和模型化的来源质量评分。

## Tech Stack

- Electron 主进程与 Node.js utility process；TypeScript、Node.js 24 和受限 IPC／preload。
- 沿用 `app/` 现有网络与依赖锁定方式；网络实现可使用现有 `undici`，不通过 renderer 直接跨域抓取。
- HTML 解析与白名单消毒必须支持 LaTeXML、MathML、SVG、表格和来源别名；不得用 Chromium 加载并执行来源页面代替解析。
- JSON UTF-8 保存元数据与诊断，原始 HTML 和资产保存原始字节；SHA-256 用于完整性。
- 转换、规范化和句子分段均为确定性本地过程，不调用模型。重开和重新转换不得重新分配已发布 revision 的 ID。
- HTML 解析／消毒若需新增依赖，在实现计划中单独确认，不默认引入 headless browser 或 Python 服务。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron 与受控来源回归：

```powershell
npx playwright test -g 'arxiv-import'
```

默认回归使用本地 fixtures、受控 transport 和临时工程，不访问真实 arXiv、PDF 云服务或模型服务。真实 arXiv 验收单独执行并记录日期、论文 ID、固定版本和结果，不作为每次 CI 的网络依赖；Linux 构建不能替代 Windows 桌面行为验收。

## Project Structure

### 仓库代码边界

```text
app/src/main/arxiv/          引用解析、版本解析、获取、快照和 LaTeXML 转换
app/src/main/project/        首次导入、候选与 current 提交的组合入口
app/src/shared/contracts.ts  来源元数据、诊断和 PDF 回退交接的共享类型
app/src/renderer/            导入进度、警告、恢复和显式操作入口
app/tests/fixtures/arxiv/    版本、公式、表格、图片、附录与恶意 HTML fixtures
app/tests/                   转换契约、故障注入和真实 Electron 回归
```

上述目录是目标模块边界，不要求机械新增同名文件。`arxiv-import` 可以调用 `document-core` 的候选命令，但不能自行合并文档、改写 current 或导入 `pdf-import` 的内部实现。

### arXiv 来源快照契约

每个被接受的 arXiv HTML 快照位于：

```text
sources/<sourceSnapshotId>/
  snapshot.json             # 固定版本、来源元数据、文件摘要和资产 URL 映射
  abs.html                  # 实际读取的 abs 页面原始字节
  document.html             # 实际读取的 LaTeXML HTML 原始字节
  assets/<sha256>.<ext>      # 已接受原始资产，不按文件名覆盖
```

- `snapshot.json` 至少记录 base ID、固定版本、规范化 ID、最终 abs／html URL、标题、作者、版本日期、许可信息、获取时间、各文件 SHA-256／MIME／大小和资产原始 URL 映射。
- 可记录公开响应的 `ETag`、`Last-Modified`、Content-Type 和重定向链；不得保存 Cookie、Authorization、代理凭据或其他请求密钥。
- `abs.html` 用于追溯版本与元数据，`document.html` 用于离线重新转换。两者都不作为 renderer 的活动页面打开。
- 快照中的资产保持原始字节，不做压缩、改名覆盖或有损转码。revision 内经过消毒或转换的资产由 `document-core` 另行内容寻址。
- 快照一经发布不可变。补取资产、重取 HTML 或修正元数据必须形成新快照，不能原地补齐旧快照。
- 转换器版本、转换警告和覆盖报告属于 revision／导入记录，不回写已发布来源快照。

## Code Style

共享契约使用可辨识联合、机器可读诊断和明确的可空状态：

```ts
export interface ArxivReference {
  baseId: string;
  version: number | null;
  canonicalId: string;
}

export interface PdfFallbackRequest {
  kind: "arxiv-pdf";
  baseId: string;
  version: number;
  reasonCode: string;
  baseRevision: string | null;
}

export interface ImportDiagnostic {
  code: string;
  severity: "warning" | "fatal";
  stage: "resolve" | "fetch" | "snapshot" | "convert" | "validate" | "publish";
  messageKey: string;
  sourceAlias?: string;
  sourceUrl?: string;
}
```

- `version: null` 只允许存在于尚未解析的用户输入；已接受快照和 PDF 回退请求必须是确定的正整数版本。
- `canonicalId` 是 `baseId + vN` 的来源标识，不替代工程 UUID、`paper.id`、source snapshot ID 或 revision ID。
- 诊断使用稳定 `code` 与 `messageKey`，界面负责中文呈现；不得把未消毒 HTML 当作错误消息直接渲染。
- 来源元数据不保存主观质量分数、模型评价或“已完整核验”结论。
- Node ESM 相对导入沿用 `.js` 后缀，共享类型不得导入 Node 或 React 模块。

## Behavior Contract

### 1. 引用解析与固定版本

1. 支持官方新旧式标识符：
   - 新式：`YYMM.NNNN` 或 `YYMM.NNNNN`，可带 `vN`。
   - 旧式：`archive/YYMMNNN`，可带 `vN`，例如 `hep-th/9901001v3`。
   - 接受对应裸 ID、`arXiv:` 前缀及官方 abs／html／pdf URL；pdf URL 仍优先尝试同一固定版本的 HTML，不直接触发 PDF 解析。
2. 解析必须匹配完整输入或受支持 URL 路径，不能像 textfold 一样从任意字符串中正则搜出一个数字 ID。拒绝凭据、非允许 host、路径穿越、伪造后缀和不支持的端点。
3. host 采用显式 arXiv 允许清单；HTTP 输入只能规范化为 HTTPS，不能放宽证书校验。不支持的 query／fragment 不得静默改变来源含义。
4. 无版本输入通过 abs 页面解析一次最新版本，之后本次导入的 HTML、资产和可能的 PDF 回退全部使用该 `vN`。导入中途出现更新版本不改变本次目标。
5. 显式 `vN` 必须获取该版本。旧版 HTML 不存在时不得退回最新版；无版本 HTML 的最终 URL或元数据与已解析版本不一致时，停止并报告版本混杂，不能拼接不同版本的正文和资产。
6. 版本号按整数比较，`v10` 高于 `v2`。工程更新时 base ID 必须一致；不同 base ID 是另一来源，不能冒充同论文更新。
7. 撤稿版本没有正文下载时，明确报告该版本已撤稿，不自动生成空正文、回退到上一版或把旧版冒充最新版。用户可显式选择仍可用的历史版本。
8. `paper.id` 在首次导入、HTML 重取、重新转换、新版本和 PDF 回退中保持不变；arXiv base ID 只是来源谱系，不是工程身份。

### 2. 网络获取与安全边界

1. 先读取 abs 以固定版本和取得来源元数据，再读取对应版本 HTML；资产 URL 相对实际固定版本 HTML URL 解析。
2. 只执行必要的幂等 GET，不携带 arXiv 账号凭据。TLS 证书错误、非允许 host 重定向和到本地／私网地址的重定向必须拒绝。
3. 正文与快照资产只从明确的 arXiv host 允许清单获取。外部普通超链接可以保留供用户点击，但外部图片、脚本、样式、字体和 iframe 不在导入时抓取，也不成为运行时依赖。
4. 生产 transport 必须先验证规范化 URL 和重定向，再访问网络。测试可用受控 transport 映射到本地 fixtures，但不得通过关闭生产 TLS、host 或重定向检查来制造通过。
5. 自动重试只发生在同一次用户动作内，且仅限网络中断、无字节进度超时、429 和可重试 5xx；尊重有界的 `Retry-After`。404、403、证书错误、解析失败和磁盘错误不盲目重试。
6. 每次显式获取动作默认最多两次额外重试；连接或持续无字节进度 30 秒判定停滞，活动下载不使用短总时限。用户可随时取消，不做无限后台重试。
7. 重定向最多 5 次，资产并发默认 4。响应声明大小和实际字节均受预算约束，超限即中止，不截断后报成功。

首版获取预算：

| 项目               |    上限 |
| ------------------ | ------: |
| `abs.html`         |   8 MiB |
| `document.html`    | 128 MiB |
| 单个原始资产       |  32 MiB |
| 单快照原始资产合计 | 512 MiB |
| 自动额外重试       |    2 次 |
| 重定向             |    5 次 |

`document-core` 对文档树、raw block 和 revision 资产的更严格预算仍然适用。

### 3. 快照接受与不可变恢复

1. 原始 abs／HTML 字节、最终 URL、版本和文件摘要先写入受管 staging；只有身份、版本、响应类型、基本 LaTeXML 容器和资产清单可验证，才发布来源快照。
2. 单个非核心资产获取失败可以随快照记录 warning；但 HTML 缺字节、摘要不符、版本混杂或把 abs 页面当成 full-text HTML 不得发布为有效快照。
3. 快照发布与正文可读是不同阶段。有效 HTML 快照可以在转换失败时保留，用于诊断和未来的离线重新转换；它不代表 current 已可读。
4. 相同已验证内容可以复用快照或资产，但不得因为 URL、文件名或修改时间相同就跳过摘要核验。
5. 部分下载、未接受响应和失败转换保留在导入记录／staging 中，按 project-core 的归属规则恢复或清理；不能根据文件名或时间猜测发布。
6. 原始快照始终不可变。重新转换只读取它并生成新候选；同版重取若取得不同字节，必须建立新快照。

### 4. LaTeXML 转换与内容覆盖

1. 转换以 `article.ltx_document` 等明确 full-text 结构为入口，跳过标题／作者等已保存为元数据的重复展示，但不得把摘要页、错误页或登录／验证码页面转换成正文。
2. 标题、作者、摘要、章节、附录、定理／证明、段落、列表、公式、图注、表格、脚注和参考文献均须进入元数据或文档树，不能因暂时不支持渲染而静默省略。
3. LaTeXML 的元素 ID、章节 ID、书目键和目标 ID 保存为 `sourceAliases`；Paper30Min 的 section／unit／sentence／atom／block ID 由 document-core 分配，不能直接把上游 ID 当作稳定身份。
4. 行内与独立公式优先保留 LaTeX `alttext`／TeX annotation 及可用 MathML。只有 MathML 时仍须产生可读文本投影，不能让 Agent 读到空白或重复 annotation。
5. 图片保存本地资产引用、caption、来源别名和可读占位。原始 SVG 可以保留在快照，进入 revision 或 renderer 前必须消毒；不能安全处理的格式明确降级，不执行其中内容。
6. 表格尽可能转换为带行、列、跨度和单元格内容的结构。确实无法无损表达时可用带文本投影的 raw block 和 warning，不得只留表格截图冒充可翻译文本。
7. 内部引用、公式编号、图表引用、脚注和参考文献链接解析到规范节点；目标不存在时保留显示文本与来源目标并产生 warning，不根据相似标题猜测链接。
8. 如果来源中目标节点存在却在转换时被遗漏，这是内容覆盖错误，不能降级成普通 unresolved warning。
9. 代码、算法和复杂排版至少保留有序可读文本；raw HTML 仅在类型化表达明显损失内容时使用，并遵守 document-core 的大小和白名单限制。
10. 忽略 script、style、meta 等非正文元素必须有明确分类；其他可见来源内容必须被转换、结构化降级或记为 fatal coverage 错误，不能静默跳过。
11. 转换器与规范化／分段器均有持久版本。相同快照和相同算法版本必须产生相同规范内容；重新转换已发布 revision 不得原地改变其字节或 ID。

### 5. “正文可读”门槛与警告

发布首个 current 或来源候选前必须同时满足：

- 目标 base ID 和固定版本明确，快照完整且通过摘要检查。
- 主体全文容器可信，存在标题／摘要以外的实际正文内容；不能只导入摘要和参考文献就宣称全文可读。
- 章节、附录、unit、阅读块和资产引用通过 document-core 全量验证，来源可见内容均有转换或明确失败记录。
- 阅读顺序完整，没有缺失章节、重复占用节点、规范树内部引用悬空或无法解释的核心结构缺口。
- 文档与资产均在预算内，危险 HTML／SVG／URL 已移除或使候选失败。

允许带 warning 发布的局部问题：

- 单张或少量非系统性图片缺失、格式不支持或外部资产未抓取，已保留 caption、来源信息和占位。
- 来源本身缺少交叉引用目标，或少量非核心元数据无法解析。
- 个别复杂表格／排版使用有文本投影的 raw block。
- 不改变主体文字与阅读顺序完整性的其他明确降级。

如果同类失败覆盖全部图片、全部公式或某一整类正文，表明基址解析或转换存在系统性问题，不得拆成大量局部 warning 后发布。警告不代表已经通过人工或模型核验，也不自动触发 PDF 回退。

### 6. 首次导入与恢复阶段

首次导入按以下顺序组合 project-core 与 document-core：

1. 本地校验引用、工程名称和父目录，创建工程与可恢复导入记录。
2. 读取 abs，固定实际版本并记录目标；版本无法确定时不得进入正文可读状态。
3. 获取对应 HTML 和资产，核验后发布不可变来源快照。
4. 从快照生成候选树，初次导入时 `document` 与 `source-base` 内容一致。
5. 完成内容覆盖、schema、安全、完整性和可读门槛检查。
6. 先完整发布 revision 与元数据，最后由 project-core 原子推进 `currentRevision`。

恢复要求：

- 每个阶段记录目标版本、已完成快照／候选 ID、machine-readable 诊断和下一可行动作，不记录凭据。
- 重试只补做未完成阶段；已验证快照和资产按摘要复用，不重复产生同内容身份。
- 停止、取消、崩溃或应用退出不删除工程，不把快照存在显示为正文可读。
- HTML 转换失败后可用同一转换器重试，或在未来转换器升级后离线重新转换；二者都不能改变既有快照。
- current 仍为空时允许显式 PDF 回退；current 已存在时，任何失败都保持旧 current 可读。

### 7. 显式 PDF 回退交接

1. HTML 确定不存在、最终获取失败或核心结构不可读时，界面可以显示“改用此版本 PDF 解析”动作，同时展示真实原因；403、429 或网络失败不得被描述成“论文没有 HTML”。
2. 在用户点击并确认前，不请求 PDF URL、不调用云端解析、不创建 PDF 费用，也不把回退当作自动重试的一部分。
3. 确认后仅生成 `PdfFallbackRequest`，携带固定 base ID、`vN`、原因和 `baseRevision`；不携带 URL，下载目标由主进程按固定版本与受控基址重建。实际 PDF 获取、快照和云解析由 pdf-import 定义。
4. 回退继续同一工程与 `paper.id`：首次导入时 `baseRevision` 为空，更新时必须是用户当前读取的 revision。
5. PDF 解析完成后仍须通过 document-core 候选／合并与 project-core 发布协议；原 HTML 快照和失败诊断保留，旧 current 不因开始回退而改变。
6. HTML 仅有局部 warning 且达到可读门槛时，正常发布 HTML。用户仍可另行发起 PDF 候选，但系统不得因 warning 自动替换来源。
7. 本模块只定义交接数据，不反向依赖 pdf-import 实现；组合入口可以在两个模块都可用后连接命令。

### 8. 新版本检查与同版刷新

1. **检查新版本**是用户主动动作，只获取 abs 元数据并比较固定版本，不自动下载 HTML／PDF、生成候选或推进 current。结果区分已有新版、已经最新、目标撤稿和无法检查。
2. 发现新版后，用户再显式选择“获取候选”。目标版本必须严格高于当前固定版本（同版刷新走重取，历史版本不借更新降级）；系统取得新版快照并转换，交由 document-core 与旧 `source-base`、current 执行三方合并；确认和冲突解决后才发布。
3. 检查更新时，即使同一版本的远端 HTML 字节已经变化，也只报告论文版本状态，不把同版 HTML 变化冒充新论文版本。
4. **同版 HTML 重取**是独立显式动作，固定当前 `vN` 重新获取 HTML 和资产：
   - 字节与已验证快照相同则复用，不制造重复快照或 revision。
   - 字节不同则建立新快照和候选，记录获取差异；不得原地替换旧快照。
5. **重新转换既有快照**不访问网络，使用选定快照与当前转换器生成候选。转换器升级不是 arXiv 新版本，也不能伪造旧 `source-base`。
6. 同版重取或重新转换即使只改变来源字节／元数据而规范正文相同，也只能形成无正文内容变化的候选；changeset 不得把全部派生内容标为 stale。
7. 所有候选发布都携带 `baseRevision` 并重新核对 current。候选身份按快照、基线与转换器版本确定性派生；候选在构建时整体落盘（树、冲突、解决状态与资产），发布按用户确认的候选身份重载同一份存储字节，不重新转换——发布内容必须与用户确认的预览一致，提交中断后按同一候选身份恢复。转换器升级后重转换形成新候选，不静默复用旧版本存储。冲突时保留候选，旧 current 不被覆盖。
8. 不做启动时检查、定时后台更新、自动追最新版或自动采用候选。
9. current 来源为 PDF 回退产物（pdf-parse 快照）时，检查与更新沿 `parentSourceSnapshotId` 回溯 pdf 快照携带的 arXiv 事实（baseId／固定版本）；回退工程因此仍可参与新版本检查与更新候选。本地 PDF 无 arXiv 谱系时如实拒绝，不猜测身份。

### 9. 离线重开与重新处理

1. 正常重开只读取 current revision 及其本地资产，不请求 abs、HTML、图片 CDN、PDF 或模型服务。
2. 来源快照用于追溯和离线重新转换，不是运行时必须加载的第二份正文；current 可读不因断网而降级。
3. 离线重新转换使用快照中的原始 HTML、abs 元数据、资产和 URL 映射，不重新访问远端。既有缺失资产继续显示原 warning，不能假装已补齐。
4. renderer 不直接渲染原始 `document.html`；所有 HTML／SVG／MathML 投影均来自经过验证和消毒的 current revision。
5. 普通外部超链接可以在用户主动点击时打开，但离线正文不得隐式发起这些请求。

## Error and Recovery Requirements

| 情况                                         | 必须行为                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| 输入非法、host 伪造、版本格式错误            | 在网络与工程写入前拒绝，指出具体输入问题                                |
| abs 不存在、版本无法确定、显式版本不存在     | 保留已有工程／current；不得改用其他版本                                 |
| 目标版本撤稿                                 | 显示撤稿事实，不生成空正文或自动采用上一版                              |
| HTML 404、403、429、网络超时或非预期响应     | 区分不存在、访问受限、限流和网络故障，保留现场，允许重试或显式 PDF 回退 |
| HTML 是 abs／错误页、版本混杂、核心正文缺失  | 不发布可读 revision；保留可诊断材料并提供重试、重取或显式回退           |
| 个别图片失败、外部资产被阻止、少量引用未解析 | 保留占位与 warning；达到核心门槛时可发布                                |
| 全部同类资产失败、可见章节遗漏、阅读顺序破坏 | 按系统性转换失败拒绝发布，不以大量 warning 掩盖                         |
| 快照或 revision 写入中断、摘要不符、磁盘失败 | 不推进 current，保留已完成受管内容和恢复记录                            |
| 候选基线已变化或合并未解决                   | 保留候选并拒绝发布，旧 current 继续可读                                 |
| 同版重取得到不同字节                         | 建立新快照，不覆盖旧快照，不自动采用候选                                |
| 用户选择 PDF 回退后取消或失败                | 保留 HTML 快照、诊断和旧 current，不删除工程                            |

错误恢复不得通过静默换版本、删除失败工程、清空警告、截断正文、自动调用付费云解析或默认采用候选来完成。

## Testing Strategy

### 引用、版本与网络契约

覆盖新旧式 ID、4／5 位序号、`v1`／`v10`、abs／html／pdf URL、大小写 host、HTTP 规范化和撤稿版本：

- 无版本输入只解析一次最新版本，后续全部请求保持该 `vN`。
- 显式旧版不会改取最新版；版本混杂、撤稿和不存在版本被明确处理。
- 任意字符串中的类 ID、伪造 host、凭据、路径穿越、非法重定向和私网目标被拒绝。
- 429／5xx／停滞的有界重试、`Retry-After`、取消、活动下载和超预算响应。
- 所有请求在确认 PDF 回退前都不包含 PDF 或云服务。

### 快照与转换契约

使用公式、表格、SVG／位图、算法、脚注、参考文献、重复段落、深层附录和复杂交叉引用 fixtures：

- 原始 abs／HTML 字节与资产摘要持久化，快照不可变，同内容复用不靠文件名。
- 图片按实际固定版本基址本地化，MIME／摘要被核验；外部资产、危险 URL 和脚本不进入运行时。
- 公式、表格、图注、列表、脚注、参考文献和附录进入规范树，Agent 文本不出现静默空白。
- source alias 与内部链接正确映射；来源自身缺目标可 warning，转换遗漏目标则 fatal。
- MathML／SVG／raw HTML 消毒覆盖事件处理器、iframe、危险 data／javascript URL、CSS 远端加载和主动 SVG 内容。
- 内容覆盖、阅读顺序、raw block 降级、系统性失败和 document-core 预算均有断言。
- 相同快照与算法版本重复转换结果确定，离线重新转换不访问网络。

### 首次导入与故障注入

在真实临时工程上分别中断于：abs 后、HTML 部分下载、部分资产、快照发布前、快照发布后、转换中、revision 发布后和 current 推进前：

- 工程身份、目标版本和恢复记录始终一致，重试不重复已验证内容。
- 快照存在不被误报为正文可读；只有完整 current 可离线阅读。
- 核心结构失败与局部 warning 的发布边界符合契约。
- 危险响应、摘要错误、磁盘失败和预算超限不会留下半发布 current。

### 更新、同版刷新与 PDF 交接

- 检查新版只读 abs，不生成候选；获取候选和确认发布是独立动作。
- 新版候选沿用 base ID 与 `paper.id`，current 未确认前不变，基线变化时拒绝发布。
- 同版检查不比较 HTML；显式重取对相同字节复用、不同字节新建快照。
- 离线重新转换不重跑旧来源来伪造 source-base，规范内容相同不导致全篇 stale。
- 撤稿新版不产生空正文候选，也不自动采用上一版。
- PDF 回退必须显式确认，交接版本、原因和 `baseRevision` 正确；使用 mock handoff 验证，不依赖真实 pdf-import。
- 回退取消／失败保留 HTML 现场和旧 current。

### 真实 Electron 高层回归

通过生产 preload、IPC、Node 工程进程和受控 arXiv transport，至少覆盖：

1. 从 URL／裸 ID 创建无 PDF 工程，固定版本、导入、关闭网络和重开后完整阅读。
2. 首次导入停止、失败、重试、快照后转换失败与离线重新转换。
3. 局部图片 warning 与核心正文缺失的不同界面结果，实际渲染不加载远端资源。
4. 新版本检查、候选、冲突和确认；同版重取与重新转换不会自动覆盖 current。
5. 显式 PDF 回退确认前后的请求和工程状态，确保没有隐式云调用。
6. 工程整体搬迁后来源快照、current 和资产仍按相对路径工作。

另以少量真实 arXiv 代表论文做发布前来源验证，覆盖公式、表格、图片和附录较多的样本，记录固定版本与已知 warning；该证据不得由 fixtures 或历史运行冒充。

## Boundaries

### Always do

- 固定实际 `vN`，保留原始 abs／HTML／资产快照和来源谱系。
- 以规范文档树为唯一正文权威，先验证快照和候选，再提交 revision／current。
- 本地化运行资产，保留公式、表格、图片、附录和交叉引用的可读结构。
- 区分核心结构失败与局部 warning，提供机器可读、可行动的诊断。
- 将新版本检查、同版重取、离线重新转换和 PDF 回退做成显式独立动作。
- 使用受控来源和真实 Electron 验证离线重开、恢复、更新和安全边界。

### Ask first

- 增加 ar5iv、通用网页、source tarball、本地 LaTeXML 或其他来源。
- 引入自动 PDF 回退、后台更新、自动采用候选或新的付费网络调用。
- 放宽 host／重定向／资产限制、执行原始 HTML 或允许运行时远端依赖。
- 修改获取预算、快照布局、版本协议或 PDF 回退交接字段。
- 新增 HTML 解析依赖、Python 服务、模型质量评估或有损资产转换。

### Never do

- 丢弃用户显式 `vN`、始终追最新版，或把不同版本的 HTML 与资产混合。
- 要求 arXiv HTML 导入必须下载 PDF、OCR、配置模型或通过 LLM 审阅。
- 未经显式确认下载回退 PDF 或调用云端解析，不因 warning 自动改用 PDF。
- 把原始 HTML 当 current 直接渲染，或允许脚本、iframe、危险 URL 和远端资产运行。
- 静默省略章节、附录、表格、公式或参考文献，用摘要页冒充全文。
- 原地修改已接受快照，或根据 URL、文件名、时间猜测发布残留内容。
- 自动覆盖 current、自动回退到上一版，或把撤稿版本转换为空正文。
- 在快照、revision 或导入记录中保存账号、Cookie、代理密钥或模型凭据。

## Success Criteria

- [ ] 新旧式 arXiv URL／ID 均能严格解析；无版本引用固定实际版本，显式版本绝不静默改变。
- [ ] 成功导入后没有 PDF 也能离线重开完整正文、公式、表格、图注和本地图片。
- [ ] 原始 abs／HTML 与资产快照不可变、可校验、可离线重新转换，且不作为第二份阅读正文。
- [ ] 核心内容覆盖和阅读顺序通过验证；局部 warning 与系统性失败有清晰、可测试的边界。
- [ ] 首次导入各中断点均可恢复，快照存在不会误报正文可读，工程与 `paper.id` 始终稳定。
- [ ] PDF 回退只有显式确认才发生，交接固定版本和基线，未确认前无 PDF／云请求。
- [ ] 新版本检查、同版重取和重新转换各自独立，所有候选遵守 `baseRevision` 和确认发布协议。
- [ ] 撤稿、404、403、429、网络失败和核心转换失败具有不同诊断，不互相冒充。
- [ ] 外部资产、恶意 HTML／SVG／URL、非法重定向和超预算响应不会被静默接受或执行。
- [ ] 同版或新版来源变化只按实际 changeset 影响派生内容，不造成全篇无差别 stale。
- [ ] 工程搬迁后 current、来源快照和资产引用继续按相对路径工作。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron 回归在实现提交上实际通过；真实 arXiv 证据单独记录。

## Open Questions

本模块没有阻塞批准的产品开放问题。以下事项由对应规格继续定义：

- PDF 获取、云端解析、费用确认和 PDF 来源快照：`pdf-import`。
- 来源 warning、恢复动作和冲突解决的视觉呈现：`reader` 及工作区相关规格。
- 可选 PDF 原页获取和结构化正文同步：`pdf-comparison`。
- 转换器与规范化的具体依赖选型：实现计划按本模块边界确认，不改变已批准行为契约。
