# Spec: reader

> 状态：已批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[document-core](SPEC-document-core.md)（已批准）  
> 来源协同：[arxiv-import](SPEC-arxiv-import.md)、[pdf-import](SPEC-pdf-import.md)（均已批准）  
> 下游：`translation`、`annotations-results`、`workspace`、`agent-integration`、`pdf-comparison`

## Objective

为 Paper30Min 提供以 current JSON 文档树为唯一输入的 **Full 全文阅读器**。它渲染完整章节、段落、公式、表格、图片、脚注、参考文献和必要的 raw block，提供稳定锚点导航、精确选区、阅读位置恢复和诊断展示；不实现五级折叠、阅读地图、自动论证关系或独立选区问答卡。

阅读器同时是多个下游能力的宿主：语言切换复用同一原文锚点；笔记、精解和记忆卡片在正文旁形成可回跳的侧栏；原文修正与来源候选都通过结构化命令和不可变 revision 完成。右侧持续 Agent 对话独立于阅读器，选区提问不会自动生成成果卡片。

本模块成功时，应满足：

- 原文结构化完成后立即可读，不等待翻译、PDF、完整核验或模型任务。
- 原文和译文都能精确标记当前语言选区；跨语言只按原句软映射，不换算中英文字符偏移。
- 每个阅读窗格有独立语言、阅读位置和选区状态，重开、缩放和 revision 变化后按锚点恢复。
- 宽屏时成果卡片锚定对应正文单元的单侧边栏，窄屏或双栏时回到该单元下方，不形成独立全局信息流。
- 用户修正、候选冲突和异步加载都不会静默覆盖 current、草稿或旧阅读现场。

## Scope

### In scope

- current 文档树的 Full 阅读投影、标题／来源信息和所有阅读块渲染。
- 公式、表格、图片、SVG、交叉引用、脚注、参考文献、代码和受控 raw block。
- 原文精确选区、译文精确选区、跨语言整句软映射及选区操作宿主。
- 基于稳定锚点的阅读位置捕获、恢复、语言切换和 revision 变化处理。
- 单侧锚定成果边栏、窄屏内联、卡片与正文互相定位、失效锚点展示。
- 来源事实、机器诊断、占位和 PDF 核验状态的非评分化展示。
- 显式单元／atom 修正、结构化命令预览、草稿与基线冲突保护。
- 来源候选的单元级三方冲突查看、逐项解决和发布宿主。
- 可选 PDF 原页阅读组件及其独立位置状态；不包含语义同步。
- 长文档增量渲染、异步结果隔离、键盘与窄窗格可访问性。

### Out of scope

- 翻译生成、译文持久化、缺口补译和 stale 计算，属于 `translation`。
- 高亮／批注持久化、Markdown 锚点链接扫描和成果卡片数据生产，属于 `annotations-results`。
- 双窗格、页签拖拽、布局恢复和成果打开偏好，属于 `workspace`。
- Agent 对话、工具、提示词和精确任务来源补查，属于 `agent-integration`。
- PDF unit→页／区域映射、双向同步和 PDF 文字选区对齐，属于 `pdf-comparison`。
- 来源获取、云端解析、文档树合并算法和 current 原子提交的内部实现。
- 完整 WYSIWYG 结构编辑、自由多栏、五级折叠、阅读地图、自动语义边和独立问答卡。
- 旧 PDF 引用字典、PDF 原生批注权威和旧工程兼容。

## Tech Stack

- React 19、TypeScript、Electron 受限 IPC／preload；renderer 只消费只读投影和结构化命令结果。
- 沿用现有 KaTeX 与本地字体／样式资源；MathML、SVG 和 raw HTML 只渲染经 document-core 消毒的内容。
- 沿用 `@embedpdf`／PDFium 作为可选原页组件，不要求用 PDF 渲染来显示结构化正文。
- DOM 渲染保留稳定 ID 与逻辑偏移映射；token、搜索和定位索引可由 document-core cache 重建，但不成为正文权威。
- `ResizeObserver` 按实际正文容器宽度切换边栏／内联布局，不以整个窗口宽度代替窗格宽度。
- 长文档可使用分块挂载或虚拟化，但必须保持锚点导航、选区语义、可访问性和恢复行为。
- 不默认新增编辑器、数学或 PDF 依赖；新增依赖在实现计划中单独确认。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron 与渲染回归：

```powershell
npx playwright test -g 'reader'
```

默认使用本地文档树、译文投影、成果卡片和 PDF fixtures，不访问真实 arXiv、百度或模型服务。隐藏窗口回归仍须验证真实 DOM、截图、选区、滚动和交互；只有原生焦点、IME、系统菜单或人工视觉验收需要 `PAPER30MIN_TEST_WINDOW=visible` 的聚焦用例，不能以模拟 DOM 断言冒充这些证据。

## Project Structure

### 仓库代码边界

```text
app/src/renderer/reader/     Full 投影、选区、位置、侧栏和修正／冲突宿主
app/src/renderer/pdf/        可选原页组件与独立阅读位置
app/src/shared/reader/       阅读位置、选区和侧栏宿主的共享类型
app/src/main/document/       结构化修正、候选合并与 revision 命令
app/tests/fixtures/reader/   复杂文档、译文、卡片、长文和恶意内容 fixtures
app/tests/                   投影契约、真实 Electron、截图与交互回归
```

现有 `MarkdownDocument.tsx` 只用于普通 Markdown 成果，不得改造成主论文正文权威。现有 `PdfReader.tsx` 的原页渲染和位置恢复可以复用，但旧引用、PDF 原生批注和材料身份假设不属于新 reader。

### 宿主边界

reader 不生产以下数据，只定义消费接口：

- `translation` 提供带原句映射、译文 revision 和精确译文偏移的只读投影。
- `annotations-results` 提供已解析的高亮、批注和成果侧栏项，包括未保存 Markdown 草稿中的项目。
- `workspace` 持久化每个页签的阅读位置、语言和草稿，并决定成果在当前窗格还是侧边打开。
- `agent-integration` 接收选区上下文和显式修正任务，不直接操作 DOM 或受管 JSON。
- `pdf-comparison` 在原文＋PDF 组合上增加同步，不反向改变通用 reader。

## Code Style

选区同时保留原文锚点与创建时的语言视图，不把两种偏移混为一个 range：

```ts
export interface ReaderSelection {
  baseRevision: string;
  originalAnchors: DocumentAnchor[];
  view:
    | { kind: "source" }
    | {
        kind: "translation";
        language: "zh" | "en";
        translationRevision: string;
        ranges: TranslatedSelectionRange[];
        quote: QuoteSnapshot;
      };
}

export interface TranslatedSelectionRange {
  sentenceId: string;
  start: number;
  end: number;
}
```

- 原文视图中的 `originalAnchors` 可以包含 document-core 的精确 `range`；译文视图只能保留对应原句／unit／atom／block，不得伪造原文字符 range。
- 译文 range 使用译文自己的逻辑内容序列和半开区间，具体持久化与 stale 规则由 translation 定义；reader 不把译文偏移换算成原文偏移。
- `translationRevision` 是派生内容版本，不等于原文 `baseRevision`。译文精确高亮必须同时校验二者及 quote。
- 阅读位置使用 `revisionId`、原文锚点、语言视图和少量视口相对信息；全局 scrollTop 只能作为辅助，不能成为跨语言／跨 revision 权威。
- 侧栏项必须携带明确 primary anchor、全部相关锚点和稳定排序信息，reader 不根据相似文本猜放置位置。

## Behavior Contract

### 1. current 投影与 Full 完整性

1. reader 只读取 project-core 的 current revision 和 document-core 的 Reader 投影，不读取 `source-base.json`、原始 HTML 或云端 Markdown 作为另一份正文。
2. current 为空或 revision 不完整时显示工程创建／导入恢复状态，不渲染空白论文、摘要页或旧 staging 冒充正文。
3. Full 按 `blocks` 的真实顺序显示全部可读内容，包括摘要、章节、附录、脚注和参考文献。不得按模型层级、论证角色或 takeaway 隐藏段落。
4. 标题、作者和来源信息来自已验证元数据；正文标题重复展示不得制造新的文本 unit 或锚点。
5. section 层级只影响语义与排版，不提供五级内容折叠。普通导航、字号或宽度设置不得改变正文内容和节点身份。
6. Reader 投影中的每个文本片段、atom、block 都能追溯到稳定 ID；异步渲染不得用数组下标代替持久锚点。
7. current 切换时以 revision 为边界替换投影，并按 changeset 恢复位置与侧栏；不得把两个 revision 的 DOM 或异步结果拼接使用。

### 2. 复杂内容渲染

1. **行内公式**作为 atom 渲染，保留稳定 atom ID 和来源 LaTeX／MathML。KaTeX／MathML 的隐藏 annotation、辅助文本和复制层不得被重复计入选区偏移。
2. **独立公式**保留编号、交叉引用和横向溢出容器；无法渲染时显示来源表示与诊断，不留空白。
3. **图片与 SVG**使用 revision 内本地资产，响应式缩放且保持宽高比；caption、缺失占位和来源 warning 与图片关联。可提供键盘可关闭的原图放大视图，不隐式访问远端。
4. **表格**按行、列、跨度和表头渲染，宽表在自身容器内横向滚动，不撑破正文窗格。单元格文字仍可选择并映射到对应 unit。
5. **raw block**只在来源允许的限制内渲染消毒 HTML 和可读文本投影，并明确其结构限制；不得执行脚本、事件处理器、iframe、表单提交或远端 CSS／字体。
6. **代码、算法与预格式化文本**保留空白、顺序和横向滚动，不因排版而换行改写权威文本。
7. **内部交叉引用与脚注**点击后定位目标 section／unit／atom／block，并提供可辨识焦点；无法解析的来源目标保留显示文本与 warning，不猜测目标。
8. **外部链接**通过受控系统打开入口处理，不在正文内嵌网页。危险 URL 不渲染为可点击链接。
9. 图片、公式和表格的懒加载不得改变文档逻辑顺序；加载前后的布局变化必须被位置恢复与侧栏布局处理。

### 3. 原文选区与操作条

1. 原文选区以 document-core 的逻辑内容为准：普通文本按 UTF-16 code unit，内联 atom 占一个逻辑位置，range 为半开区间。
2. DOM 只承担交互，选区通过显式文本投影映射回 `unitId`、`sentenceId`、`start`、`end` 和 QuoteSnapshot；不得直接以 `textContent`、屏幕像素或 KaTeX 辅助节点计算权威偏移。
3. 跨句／跨单元选择按原文顺序保存多个 range，不以首尾两点猜中间内容。跨图、表或 raw block 时，能确定的文本与 block 分别表达；无法精确映射的部分明确降级，不静默近似。
4. 点击 atom 可选择整个 atom；公式复制和来源表示不参与额外偏移。表格与列表选择同样遵守其 unit 结构。
5. 鼠标和键盘都能完成选择及后续操作。选区工具条提供解释／提问、高亮和批注入口，保持在可视区域内，并在选区折叠、滚动失效、revision 切换或窗格失活时安全关闭。
6. “解释／提问”把当前选区、原文上下文和语言视图发送到右侧持续 Agent 对话，不创建独立问答卡。高亮与批注通过 annotations-results 的命令保存，不由 reader 直接写文件。
7. 工具条、卡片和高亮装饰不得破坏原生选择、剪贴板、IME、焦点或文本偏移。

### 4. 双语言视图与选区

1. 每个 reader 实例独立保存 `source` 或可用译文视图。首次原文导入默认显示 source，不等待译文；语言切换不创建新的论文或 revision 身份。
2. translation 投影必须保留原句 ID、atom ID、原文 revision、译文 revision 和译文逻辑偏移映射。缺少这些映射时，reader 只能提供句／单元级上下文，不能制造精确译文 range。
3. **在原文创建的精确选区**：
   - 原文视图中按原 range 精确显示。
   - 译文视图中按对应原句显示整句软高亮；不尝试挑选译文中的等价单词。
4. **在译文创建的精确选区**：
   - 保存原句／unit 锚点、译文 revision、译文 ranges 和译文 quote。
   - 同一译文 revision 且 quote 校验通过时，在译文视图中精确显示。
   - 原文视图中只按对应原句软高亮，不把译文 start／end 用于原文。
5. 译文 stale、局部重译或原文 changed 后，旧译文精确 range 保留摘录并按 translation／document changeset 失效；原句仍有效时可以显示句级关联，但不冒充原精确选区。
6. 译文选区提问同时携带当前译文摘录和对应原文句／单元上下文。成果回链始终以原文锚点为主，译文精确选区只是附加视图证据。
7. 切换语言时保持当前逻辑阅读位置、侧栏关联和选区上下文，不复用旧语言的全局 scrollTop 或像素偏移。
8. 软高亮必须在视觉和可访问文本上区别于当前语言精确高亮，避免让用户误以为已完成词级对齐。

### 5. 阅读位置捕获与恢复

1. 每个页签／窗格独立捕获：
   - `revisionId` 和当前最上方可见的 section／unit／block 锚点。
   - 锚点内的可选句子或块位置、锚点顶部与视口的相对偏移。
   - 当前语言视图及可用的 translation revision。
   - 辅助 scrollTop、容器尺寸和捕获时间，仅用于诊断与同布局优化。
2. 恢复时先按锚点挂载目标，再等待必要的字体、公式、图片尺寸和布局测量，最后恢复相对位置；不能在目标尚未渲染时只写旧 scrollTop。
3. 语言切换、窗格 resize、双栏切换和侧栏布局变化后，以原锚点为中心重新定位，不追求不同内容高度下的相同绝对像素。
4. retained／moved 节点在新 revision 中继续恢复原锚点；changed 但 ID 仍存在的节点可定位到该节点并明确提示内容已变化。
5. 目标 removed 时保留原位置摘录和 tombstone 信息。若捕获时的父 section 仍存在，可以在明确提示“原阅读位置已失效”后回到该 section；否则回到文首并提示。不得按相似文本或最近段落静默重挂。
6. 候选、后台索引、图片加载或旧 revision 的异步结果不得覆盖用户已经移动到的新位置；所有恢复操作使用 revision／view／epoch 校验。
7. reader 向外提供位置捕获与恢复接口，workspace 决定持久化时机和布局恢复。一个论文的全局单一滚动位置不能满足双窗格。

### 6. 成果侧栏与窄屏内联

1. reader 按 primary anchor 将笔记、精解、记忆卡片和其他文本锚定成果放到对应 section／unit／block 旁；不扫描 Markdown、不建立成果关系数据库。
2. 宽屏采用**单侧锚定边栏**：
   - 卡片位于正文一侧，与对应锚点的阅读顺序一致，随正文滚动。
   - 同一锚点的多张卡片按宿主提供的稳定顺序堆叠，不互相覆盖。
   - 卡片较高时，后续卡片在边栏内顺序下移并保持关联提示，不覆盖下一正文单元或其卡片。
3. 空间不足时，以实际正文容器宽度为准切换为**锚点后内联**：卡片紧随对应单元之后、下一单元之前，正文与卡片均不横向压缩或溢出。双栏中的每个窗格独立判断。
4. 点击卡片定位并高亮对应原文范围；当前为译文时使用对应原句的软高亮。点击正文标记时，若有多个相交成果，展示全部相交项，不按“最新一张”静默吞掉其他成果。
5. 卡片打开成果文件、在当前窗格还是侧边打开，以及“默认侧边打开”偏好由 workspace 决定；reader 只发出打开请求并保留当前阅读位置。
6. 未保存 Markdown 草稿中的侧栏更新不得迫使正文重排回顶部或丢失当前选区；更新只影响相关锚点的卡片与布局。
7. changed range 可以在仍存在的单元旁显示“内容已变化”状态；removed 或无法确认的锚点放入明确的失效成果区域，保留 quote／tombstone，不挂到相邻段落。
8. 侧栏只呈现用户高亮、批注和明确保存的成果，不显示 textfold 式自动论证边、模型 takeaway 或独立问答卡。
9. 布局动画尊重 `prefers-reduced-motion`，卡片类型和失效状态不能只靠颜色表达。

### 7. 来源诊断与核验展示

1. 来源面板展示可行动事实：arXiv 固定版本、HTML 快照，或 PDF 快照、provider、model、parse batch、转换器版本和实际 warning。
2. 缺图、raw block、未解析交叉引用、页级定位限制等诊断尽量锚定受影响 block；同时提供可筛选的汇总入口，不在每个段落堆叠笼统警告。
3. 诊断使用具体代码与说明，不显示“正确率”“质量优秀”或“全文已验证”等未经证明的结论。
4. PDF 核验状态区分：
   - 同一 PDF 且内容未变的 `verified`。
   - 旧 PDF 的 `historical-source`。
   - 内容变化后的 `modified-unreviewed`。
   - 无核验记录或已删除范围。
5. 用户／Agent、实际核验范围和来源可在详情中查看；reader 不把核验覆盖度转换成质量分数。
6. 核验状态不会阻止阅读、选区、翻译、成果或 Agent 入口，也不要求每条 Agent 回复附带笼统警告。
7. 来源快照缺失不影响 current 阅读；涉及原页、重新处理或新增核验时，在对应入口明确报告限制。

### 8. 用户原文修正

1. Full 阅读默认只读。用户必须对具体 unit／atom 显式进入修正模式，不能把整个正文变成自由 `contentEditable`。
2. 单元修正使用结构化编辑器：
   - 普通文字可以修改，atom 以受保护占位表示并保留 ID 与顺序。
   - atom 内容通过单独修正入口编辑；删除、替换或改变 atom 类型必须是明确操作。
   - raw HTML 不提供任意源码自由编辑，使用受控文本投影或专门结构命令。
3. 拆分、合并、删除、移动、资产替换和顺序调整只通过 document-core 的结构化命令与预览完成。首版不承诺全文拖拽、表格自由编辑或 Word 式 WYSIWYG。
4. 修正请求携带 `baseRevision`、目标锚点、预期原内容和替换操作；reader 不得直接覆盖 JSON、source-base 或来源快照。
5. 发布前预览实际 changeset，包括 retained／moved／changed／removed、锚点失效和派生内容影响。用户确认后才以新 revision 发布。
6. 修正草稿按页签保留，取消不修改 current。基线变化、外部 current 更新或验证失败时保留草稿，要求重新读取或合并，不静默覆盖。
7. 原文修正后按实际变化更新侧栏、译文与核验状态；不得全篇无差别作废，也不得让旧精确 range 自动调整偏移。
8. Agent 修正使用同一结构化命令与验证边界，普通渲染、复制、导出和选区提问不能隐式修改原文。

### 9. 来源候选与冲突交互

1. 候选页面与 current 阅读明确区分；查看、编辑冲突或下载候选不会推进 current。
2. 冲突按原文阅读顺序和类型呈现，至少支持 content、deletion、order／structure 和 asset。每项显示 base、current、candidate 及相关锚点。
3. 内容冲突以整个 unit 为解决粒度，可以提供差异高亮，但不提供词级自动合并或“相似度最佳”默认答案。
4. 解决动作包括保留 current、采用 candidate，或通过结构化修正形成明确手工结果。删除与资产冲突必须显示实际摘录／资产，不只显示 ID。
5. 顺序冲突展示双方顺序和结构上下文，解决后预览新的阅读流；asset 冲突展示可用预览、摘要与来源，不二进制自动合并。
6. 所有冲突必须逐项显式解决，未解决项和计数始终可见；不提供未查看即默认接受的“全部使用候选”。
7. 解决期间原 current 始终可读。发布前重新执行全文档验证与 `baseRevision` 检查，失败时保留所有已选解决结果。
8. current 已被另一操作推进时禁止发布，要求基于新 current 重新合并；不得把旧解决结果静默套到新基线。
9. 发布成功后按新 changeset 恢复阅读位置、侧栏和语言视图；冲突视图中的 `conflicted` 状态不得作为有效派生关系发布。

### 10. 可选 PDF 原页

1. PDF 原页是独立只读视图，可从 PDF 来源快照打开；没有 PDF 的 arXiv HTML 工程不显示“缺少必需文件”的错误。
2. 原页组件可复用现有 EmbedPDF 的页面渲染、缩放、旋转、 spread 与页级位置恢复，但位置按每个页签独立保存。
3. PDF 阅读失败、快照缺失或摘要不符不影响结构化 current；界面保留正文并报告原页不可用。
4. PDF 原生批注、旧引用链接和坐标字典不作为新成果权威。原页读取与核验证据由 pdf-import 控制，双向语义同步由 pdf-comparison 后续增加。
5. PDF 页面渲染和缓存必须有界，不能因打开长 PDF 一次性栅格化全部页面。异步页面结果不得应用到已切换的来源或页签。

### 11. 长文档、异步与可访问性

1. 长文档可以按阅读块增量挂载，图片和 PDF 按可见邻域加载；不得为了“Full”一次性生成超出设备能力的全部高成本位图或 PDF 页面。
2. 虚拟化不得改变阅读顺序、anchor 解析和 quote。跳转、跨单元选择、侧栏定位和恢复必须能先挂载目标，再完成交互。
3. 所有来源读取、译文切换、图片解码、公式渲染和位置恢复使用可取消任务或 epoch；迟到结果不能覆盖新 revision、新语言、新页签或新位置。
4. 正文、表格和公式不得造成整窗格横向溢出；需要横向浏览的内容限制在自身容器。
5. 键盘焦点、标题层级、图片替代文本、表格表头、公式文本投影、卡片状态和错误提示均可被辅助技术理解。
6. 高亮、软高亮、warning、verified 和 stale 不只靠颜色区分；交互目标具有可读名称和焦点状态。
7. reader 不发起隐式远端请求，不执行来源脚本，不把签名 URL、Token 或机器凭据暴露到 DOM、日志或剪贴板。

## Error and Recovery Requirements

| 情况                                    | 必须行为                                          |
| --------------------------------------- | ------------------------------------------------- |
| current 为空、revision 损坏或引用不完整 | 显示恢复／损坏状态，不渲染伪正文                  |
| 图片／公式／表格局部不可用              | 保留可读占位、caption 和诊断，不隐藏整个单元      |
| 选区跨越无法精确映射的复杂内容          | 仅保存可证明范围并说明降级，不猜偏移              |
| 译文缺失、stale 或 quote 不符           | 回退原文／句级上下文，旧译文 range 不冒充精确结果 |
| 阅读位置目标删除或布局尚未稳定          | 保留摘录与提示，按明确父级规则恢复，不静默重挂    |
| 侧栏锚点 changed／removed               | 显示变化或失效区域，不挂到相似／相邻段落          |
| 修正时 current 基线变化                 | 保留草稿和当前可读内容，拒绝覆盖并要求重新处理    |
| 冲突未解决、候选验证失败或基线变化      | 保留解决结果，禁止发布，旧 current 继续可读       |
| PDF 缺失、损坏或异步页面迟到            | 正文继续可用，原页明确失败，旧结果不覆盖新状态    |
| 窗格快速切换语言／revision／页签        | 取消或隔离旧任务，不拼接旧 DOM、图片或位置        |
| 未保存草稿触发侧栏更新                  | 保留阅读位置与选区，只更新相关卡片                |

错误恢复不得通过清空用户草稿、模糊查找相似段落、伪造译文对齐、默认采用候选或重载整个工程来完成。

## Testing Strategy

### Full 投影与复杂内容

使用含章节、附录、列表、行内／独立公式、SVG、位图、跨行表格、脚注、参考文献、代码和 raw block 的 fixtures：

- 全部阅读块按顺序出现，没有五级字段、模型摘要或参考文献被隐藏。
- 公式 annotation 不重复进入选区；表格单元、atom、图片 caption 和内部链接锚点正确。
- 缺失图片、公式失败、raw block 和 unresolved 引用具有可读降级。
- 恶意 HTML／SVG／URL、远端资源和脚本不会执行或发起请求。
- 宽表、长公式、长英文、CJK、组合字符和窄窗格不造成整页横向溢出。

### 原文与译文选区

覆盖 UTF-16、代理对、组合字符、atom、跨句、跨单元、表格、公式和 raw block：

- DOM 选择无损映射到原文逻辑 range 与 quote，隐藏渲染节点不影响偏移。
- 原文精确选区在译文显示整句软高亮；译文精确选区在原文也只显示整句软高亮。
- 译文精确 range 校验 translation revision、base revision 和 quote，不做中英偏移互换。
- 局部重译、原文 changed／removed 和 stale 译文不会保留伪精确高亮。
- 鼠标、Shift＋方向键、工具条、复制和右侧 Agent 入口保持选区与焦点，不生成问答卡。

### 阅读位置与异步恢复

- 在字体、图片和公式延迟加载后恢复到正确锚点，而非只恢复旧 scrollTop。
- resize、单双栏变化、侧栏／内联切换和语言切换保持逻辑位置。
- retained／moved／changed／removed 分别按契约恢复，removed 显示明确失效提示。
- 快速切换 revision、语言、工程和页签时，迟到的图片、PDF、渲染与恢复结果被隔离。
- 每个窗格独立保存位置，workspace 可通过宿主接口恢复。

### 侧栏与成果交互

使用同段多卡、跨段范围、超长卡、重叠高亮、失效链接和未保存草稿 fixtures：

- 宽屏卡片不重叠、不覆盖下一段；窄屏与双栏按容器宽度内联。
- 卡片与正文双向定位，多个相交成果全部可到达。
- changed／removed 不错误挂到相邻段落，quote 与 tombstone 可见。
- 草稿更新不跳回顶部、不清空选择，布局变化不制造整页横向滚动。
- 键盘、屏幕阅读文本、减少动画和非颜色状态均可验证。

### 修正与候选冲突

- 单元文字、atom、拆分、合并、删除、移动和资产操作都生成结构化命令与 changeset 预览。
- 默认正文只读，atom 占位不会被普通文字编辑意外破坏，raw HTML 不能自由注入。
- 草稿取消、基线冲突、外部 current 更新和发布失败均保留现场。
- 逐项覆盖 content、deletion、order／structure、asset 冲突；未解决项不能发布。
- 发布期间 current 被推进时解决结果保留但不能套用，成功后按 changeset 恢复阅读状态。

### 真实 Electron 与视觉回归

通过生产 preload、IPC 和真实临时工程验证：

1. arXiv／PDF current 的 Full 阅读、离线重开、语言切换和阅读位置恢复。
2. 原文／译文选区、软高亮、成果卡片、失效链接和右侧 Agent 入口。
3. 宽屏、窄窗格和双窗格容器下的截图、卡片布局、表格／公式溢出与交互。
4. 用户修正、草稿冲突、来源候选逐项解决与发布。
5. 可选 PDF 原页、独立位置、长 PDF 有界渲染和 PDF 失败后的正文可用性。
6. 恶意内容无网络／脚本副作用，旧 revision 异步结果不覆盖新界面。

涉及原生焦点、IME、系统剪贴板或人工视觉判断的用例单独记录实际窗口证据；不能把截图存在或 DOM 断言单独记为全部交互通过。

## Boundaries

### Always do

- 只从 current 文档树渲染 Full 正文，保留全部阅读块和稳定锚点。
- 使用当前语言精确选区与原句索引，跨语言只做明确句级软映射。
- 按实际窗格宽度提供单侧锚定边栏或锚点后内联。
- 以锚点恢复阅读位置，区分 changed、removed 和异步旧结果。
- 通过结构化命令、changeset 预览和基线检查完成修正与候选发布。
- 用真实 Electron、截图和交互验证复杂内容、双语言、卡片和长文档。

### Ask first

- 引入五级折叠、阅读地图、自动语义边、独立问答卡或全文渐进摘要。
- 引入词级中英自动对齐、模型辅助重锚或相似度侧栏挂接。
- 扩展为自由 WYSIWYG、全文拖拽、表格编辑器或 PDF 原生批注权威。
- 改变选区偏移、阅读位置、双语言锚点或冲突解决协议。
- 新增编辑器／渲染依赖、远端运行时资源或隐式网络请求。

### Never do

- 从 Markdown、PDF 坐标、原始 HTML 或 Agent 专用稿生成另一份正文权威。
- 把译文 start／end 直接用于原文，或宣称跨语言软高亮是精确词级对应。
- 以全局 scrollTop、数组下标或相似文本恢复锚点。
- 让卡片覆盖正文、按全局信息流脱离锚点，或把失效卡片挂到相邻段落。
- 让 renderer／Agent 直接覆盖受管 JSON，或原地修改 source-base／来源快照。
- 在冲突未解决、基线变化或验证失败时推进 current。
- 用未保存的旧异步结果覆盖新 revision、新语言或新页签。
- 恢复完整 LLM 审阅门禁、旧 PDF 引用字典或独立选区问答卡。

## Success Criteria

- [ ] Full 正文包含全部章节、公式、表格、图片、脚注和参考文献，无五级或模型层级依赖。
- [ ] 原文与译文选区均遵守当前语言精确锚点；跨语言只显示可辨识的整句软高亮。
- [ ] 选区支持 UTF-16、atom、跨句／跨单元，不被 KaTeX／MathML 辅助节点破坏。
- [ ] 每个窗格能按锚点恢复阅读位置，语言切换、resize 和 revision 变化不使用全局像素猜位置。
- [ ] 宽屏单侧边栏与窄屏内联均无覆盖、无整页横向溢出，卡片与正文可双向定位。
- [ ] changed／removed 的成果与阅读位置具有明确失效呈现，不静默重挂。
- [ ] 用户可显式修正单元／atom 并预览结构命令，草稿和基线冲突不会覆盖 current。
- [ ] 所有候选冲突逐项解决，发布前重新验证并检查 baseRevision。
- [ ] PDF 原页可选且有界，PDF 失败不影响结构化正文，未引入旧引用权威。
- [ ] 来源诊断与核验状态清晰且非评分化，未核验内容不阻塞任何正常阅读入口。
- [ ] 快速切换和懒加载不会把旧异步结果应用到新 revision、语言或窗格。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron／视觉交互回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。以下事项由对应规格继续定义：

- 译文 range 的持久化、局部重译与 stale：`translation`。
- 高亮／批注和 Markdown 成果链接的数据结构、侧栏项生产：`annotations-results`。
- 页签级位置持久化、双窗格和成果打开偏好：`workspace`。
- 选区进入持续对话、显式修正任务与来源补查：`agent-integration`。
- 原文与 PDF 的双向定位：`pdf-comparison`。
