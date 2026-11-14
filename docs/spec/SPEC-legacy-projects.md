# Spec: legacy-projects

> 状态：待批准  
> 所属能力地图：[文本中心阅读核](capability-map.md)  
> 依赖：[project-core](SPEC-project-core.md)、[document-core](SPEC-document-core.md)、[annotations-results](SPEC-annotations-results.md)、[agent-integration](SPEC-agent-integration.md)（均已批准）  
> 协同：[pdf-import](SPEC-pdf-import.md)、[workspace](SPEC-workspace.md)、[pdf-comparison](SPEC-pdf-comparison.md)（均已批准）

## Objective

明确关闭旧格式兼容范围，而不是为未发布的开发格式建立长期迁移层。旧 v2 Electron 工程使用 `paper30min.json` 的 `formatVersion: 1`，但 v2 从未公开上线；这些开发期目录不获得自动迁移、只读兼容或会话续跑承诺。旧 v1 SQLite 书库也不恢复已经取消的批量导入能力。

本模块成功时，应满足：

- 新核能识别旧 v2 `formatVersion: 1` 清单和已知旧 v1 书库布局，给出明确、可操作的说明，绝不按 `formatVersion: 2` 猜测读取。
- 拒绝打开时不修改旧目录、不创建新工程、不启动解析／翻译／模型任务，也不把失败路径登记为成功打开的新核工程。
- 用户仍可通过普通新工程流程手动抢救单个 PDF、Markdown 和图片；这只是重新使用普通文件，不是旧格式迁移。
- 旧正文、成果、引用、批注、Pi 会话和阅读位置均不自动转换、重挂或恢复；不引入旧格式服务、SQLite 读取器或兼容运行时。

## Scope

### In scope

- 在现有工程打开入口识别旧 v2 `formatVersion: 1`，并明确拒绝。
- 在用户显式选择目录时识别已知旧 v1 书库布局，说明不支持直接打开或批量导入。
- 损坏、未知版本、不安全路径与无权限读取的分流，避免把普通错误误报为已识别旧格式。
- 拒绝操作的非破坏性和无网络／无模型副作用。
- 手动抢救普通 PDF、Markdown 和图片时的权威边界与用户说明。
- 旧格式识别和拒绝行为的最小回归 fixtures。

### Out of scope

- 旧 v2 全量迁移、有限导入、只读查看器、原地升级和新旧格式双写。
- 选择旧解析批次、把 `paper.md`／`candidate.md` 离线转换为 document tree，或自动选择最新批次。
- 旧 `materials`、`map`、`explanations`、`translations` 指针恢复。
- `paper://cite`、`#annotation=`、`.paper30min-citations.json`、PDF 坐标和原生批注的解析、只读跳转或锚点转换。
- 旧 Pi 会话归档界面、只读消息查看、历史分支或原样续跑。
- `.paper30min-reading.json` 的标签、PDF 页码、滚动、缩放或 Markdown 光标恢复。
- 旧 v1 SQLite 读取、WAL 处理、附件扫描、PDF 批量导入和 `legacy-imports.json`。
- 删除旧工程、旧书库或旧源码；旧 v1 源码删除是全部规格批准后的独立交付操作。

## Tech Stack

- 沿用 Electron、React／TypeScript 和现有 Node 工程打开入口。
- 复用 project-core 的路径安全、清单读取预算、JSON 解析和错误传递；不新增数据库或格式转换器。
- 旧 v1 只检查已知目录布局，不加载 SQLite 驱动、不打开数据库、不枚举附件。
- 使用现有应用提示／错误界面展示原因和手动处理方式；不引入 legacy 专用工作台。

## Commands

在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

针对本模块的真实 Electron 回归：

```powershell
npx playwright test -g 'legacy-projects'
```

默认只使用本地临时目录和最小旧格式 fixtures，不访问真实 arXiv、百度、模型、搜索服务或用户真实旧书库。测试不得通过创建迁移输出、调用模拟模型或扫描 fixtures 中的 PDF 来冒充兼容能力。

## Project Structure

### 仓库代码边界

```text
app/src/main/project-service.ts   在现有打开入口完成旧格式识别与拒绝分流
app/src/shared/contracts.ts       仅在现有通用错误无法表达时补充最小诊断 code
app/src/renderer/App.tsx          使用现有错误提示展示原因与手动处理建议
app/tests/                      旧格式、安全性、非破坏性和无任务副作用回归
docs/spec/                      本模块与已批准的新核规格
```

实现应优先复用现有工程打开和错误展示路径，不创建 `legacy-migration/`、旧引用服务、SQLite 读取器、会话适配器或一套平行工程命令。只有确有测试需要的 fixtures 才加入仓库，不收录真实用户工程、凭据、签名 URL 或会话内容。

### 旧格式仅作识别输入

旧 v2 的下列文件只用于说明拒绝范围，不是新核运行输入：

```text
旧 v2 开发工程/
  paper30min.json                 # formatVersion = 1；只读取版本以分流
  text/                           # 不选择批次、不转换正文
  .paper30min-citations.json      # 不解析、不恢复
  .paper30min-reading.json        # 不读取、不恢复
  .paper30min/parsing/            # 不恢复任务、不读取旧来源事实
  .pi/sessions/                   # 不加载、不归入新会话
```

旧 v1 仅在显式选择的目录同时具有 `database/library.sqlite` 普通文件和 `attachments/` 普通目录时，报告为“已知旧 v1 书库布局”。这不证明数据库完整或属于某个具体版本，也不授权读取 SQLite、WAL 或附件内容。

## Code Style

- 旧格式处理是打开流程中的窄分流，不为一次性拒绝逻辑设计通用迁移框架。
- 诊断使用稳定 code：旧 v2 为 `legacy-v2-development-project`，旧 v1 布局为 `legacy-v1-library-unsupported`；未知或损坏格式继续使用 project-core 的通用错误。
- 用户文案说明“这是未发布的旧开发工程格式，当前版本不支持打开或迁移”，并给出手动复制普通文件／重新导入 PDF 的选项；不得提示“正在迁移”或“可继续恢复”。
- 旧 v1 文案使用“识别到旧 v1 书库布局”，不得在未检查数据库的情况下声称已验证书库完整性。
- 不记录旧工程正文、会话、Token、签名 URL 或绝对路径到日志；诊断只需要格式类别和稳定 code。

## Behavior Contract

### 1. 旧 v2：识别并明确拒绝

1. 用户显式打开一个工程目录时，先执行 project-core 的路径与符号链接安全检查，再按现有清单读取预算读取 `paper30min.json`。
2. 清单是合法 JSON 对象且数值字段 `formatVersion` 严格等于 `1` 时，即可分类为旧 v2 开发工程并拒绝；不需要也不允许继续信任或解析其 `paper`、`materials`、`map`、`explanations`、`translations` 路径。
3. 字符串 `"1"` 不做数值强制转换；缺失版本、损坏 JSON、未知版本和其他 schema 问题按 project-core 通用错误处理，不凭 `text/`、`paper.pdf` 或目录名猜测旧工程。
4. 即使旧清单其余字段损坏、文件缺失或批次不完整，也只显示不支持旧格式，不提供修复、重关联、批次选择或只读进入。
5. 拒绝后不得：
   - 写入 `formatVersion: 2`、创建 revision／source snapshot 或改动旧清单。
   - 创建、删除、移动或重命名旧目录中的任何文件。
   - 登记为成功打开的新核工程，或生成 `.paper30min/workspace/`。
   - 启动 PDF 下载／上传、云端解析、翻译、Agent、Pi 会话恢复或来源更新。

### 2. 旧 v1：只识别已知布局

1. 只有用户显式选择目录时才检查旧 v1 布局；应用不得后台扫描本机磁盘或默认书库目录。
2. 同时存在安全的 `database/library.sqlite` 普通文件和 `attachments/` 普通目录时，明确报告不支持直接打开或批量导入，并保持目录不变。
3. 不打开 SQLite，不读取 schema／user_version／WAL，不枚举 `attachments/<paperId>/pdf`，不恢复旧标题、笔记、回忆卡、成果、会话或阅读状态。
4. 只有附件目录、只有 WAL／SHM、数据库缺失或路径包含符号链接时，不得断言识别到完整旧书库；分别按普通不支持目录或安全错误处理。
5. 不创建 `legacy-imports.json`，不恢复“导入旧 PDF”入口，不执行跨路径去重或批量创建工程。

### 3. 手动抢救不等于迁移

用户可以在拒绝提示后自行处理普通文件，但应用不提供 legacy 专用转换：

1. **单个 PDF：** 用户可通过正常新建／PDF 导入入口选择旧工程或旧书库中的实际 PDF。新核按 pdf-import 创建新的不可变来源快照；云端上传和解析仍需独立确认。旧 PDF 原文件不修改。
2. **Markdown 与图片：** 用户可通过系统文件管理器把需要的普通文件复制到新工程的非受管目录，并自行维持相对图片链接。新核只把它们当作普通用户文件，不登记旧 `map`／`explanations`／`translations` 身份。
3. **旧链接：** 手工复制的 `paper://cite` 不解析、不跳转、不产生成果卡片；`#annotation=` 不调用旧批注定位，至多按普通 Markdown 文件链接处理。不得改写为 `paper://anchor`、根据 quote／坐标猜锚点或生成引用附录。
4. **PDF 内原生批注：** 若普通 PDF 导入的字节内已有批注，它们只作为原 PDF 内容随快照保留；不提取为新原生批注、不作为文本锚点、核验记录或 Agent 证据，也不提供旧批注编辑与回复恢复。
5. **Pi 会话与阅读位置：** 用户可在应用外自行保留或查看旧文件；新核不导入、不展示为可续跑会话、不恢复标签和阅读偏移。
6. 手动复制或重新导入后生成的新 ID、revision、会话和工作区状态都属于新工程，不与旧 ID 建立隐式兼容关系。

### 4. 不保留旧运行能力

1. 旧 `run.json`、`result.jsonl`、`mapping.json` 不用于恢复云端任务、离线重新转换或 PDF 对照映射；如需解析，按新来源任务重新开始。
2. 旧 `reviewedThroughPage`、审阅／建图会话和模型回复不构成新核核验记录或 SourceReadReceipt。
3. 旧 `.paper30min-citations.json`、块 ID、材料 ID 和 PDF 坐标不进入 pdf-comparison 缓存。
4. 旧 `.paper30min-reading.json` 不进入 workspace session，也不因路径相同恢复标签。
5. 旧 Pi 工具调用、附件和授权不注入新会话；新对话从新的任务上下文和授权开始。

### 5. 安全与副作用边界

1. 识别旧格式只需最小元数据读取，不得跟随旧清单中的相对路径、符号链接或外部绝对路径。
2. 读取失败、权限拒绝和不安全路径必须如实报告，不能为了完成识别而提升权限、修复文件或改用其他路径。
3. 拒绝流程不得访问网络、读取模型／解析凭据或创建后台任务；测试需以任务桩证明没有这些调用。
4. 旧目录可能存在唯一用户数据；不得把“未发布格式”解释为可以删除、清空或覆盖开发目录。
5. 用户手动选择 PDF 或复制普通文件是新的显式操作，不由拒绝提示自动触发。

## Error and Recovery Requirements

| 场景 | 必须行为 |
| --- | --- |
| 旧 v2 `formatVersion: 1` | 显示旧开发格式不支持；目录保持不变，无工程／网络／模型副作用 |
| 旧清单其余字段损坏或缺失 | 仍按版本明确拒绝，不尝试修复或读取其指向文件 |
| 清单损坏、版本缺失或类型错误 | 使用通用无效清单错误，不猜测 legacy 类别 |
| 更高或未知 `formatVersion` | 使用通用不支持版本错误，不按旧 v2 或新 v2 读取 |
| 旧路径存在符号链接、父级穿越或越界 | 在安全检查处拒绝，不跟随路径或读取目标内容 |
| 旧 v1 已知布局 | 显示不支持直接打开／批量导入；不读 SQLite、WAL 或附件 |
| 读取权限不足或磁盘错误 | 报告实际读取失败，不误报格式已识别，不自动重试为其他格式 |
| 用户从拒绝提示手动导入 PDF | 进入普通 pdf-import 流程，重新校验格式并确认云端任务 |
| 用户手工复制带旧链接的 Markdown | 保留正文，旧链接不形成引用／批注能力，不自动重写或重挂 |
| 拒绝后再次打开 | 结果保持确定且幂等，不累积恢复文件、任务或重复工程记录 |

## Testing Strategy

### 格式与安全 fixtures

1. 最小旧 v2 清单，以及含旧 `materials`、地图、译文、批次和恶意相对路径的清单，均只识别版本并拒绝，不跟随路径。
2. 损坏 JSON、缺失版本、字符串版本、未知未来版本和普通 v2 清单分别进入正确分支。
3. 旧 v1 已知布局、只有附件、只有 WAL／SHM、数据库缺失及符号链接布局分别验证识别与拒绝边界。
4. 构造不可读／错误注入，验证真实错误不会被改写成旧格式结论。

### 真实 Electron 高层回归

通过生产 preload、IPC 和窗口交互验证：

1. 打开旧 v2 后显示稳定 code 与清晰说明，不出现正文、PDF、成果、Agent 或恢复入口。
2. 打开前后递归核对旧目录的文件集合与内容 SHA-256，确认没有新增、删除或改写；不比较可能由正常读取影响的文件系统 atime。
3. 拒绝旧 v2／v1 时没有新工程登记、当前 revision、workspace session、Pi 会话或后台任务。
4. 以 arXiv、解析、翻译、模型和网络任务桩证明拒绝路径零调用。
5. 从提示转而手动选择单个 PDF 时，只进入普通 pdf-import；未确认前无上传，旧 PDF 字节不变。
6. 手工复制含 `paper://cite`／`#annotation=` 的 Markdown 后，普通文本可查看，但不产生锚点卡片、旧 PDF 定位或批注恢复。
7. 重开、重复拒绝和切换有效新工程后，旧诊断不会串入新工程状态。

不得用“旧文件仍存在”单独证明只读安全；必须同时检查没有新增受管文件、后台任务和错误能力入口。

## Boundaries

### Always do

- 明确识别、明确拒绝、保持旧目录不变，并提供普通文件手动处理说明。
- 把旧格式识别限制在最小元数据与已知布局，不建立旧内容权威。
- 让所有新 PDF／Markdown 使用新核正常导入和普通文件契约。
- 用真实 Electron 回归证明无写入、无网络、无模型和无旧会话恢复。

### Ask first

- 未来若确有公开释放的旧格式用户数据，再提出新的迁移需求、兼容期限和验收样本。
- 新增旧格式类型、只读查看器、迁移界面、旧引用解析或会话导入。
- 读取 SQLite、枚举旧书库附件、恢复批量导入或删除任何旧目录。
- 将真实用户旧工程纳入测试 fixtures。

### Never do

- 自动迁移、原地升级、双写、修复或只读打开旧 v2。
- 选择旧批次、转换旧正文、恢复旧地图／译文登记或重挂旧引用。
- 加载旧 Pi 会话、恢复旧阅读位置、沿用旧工具结果或旧审阅状态。
- 恢复旧 v1 SQLite 书库扫描、PDF 批量导入、`legacy-imports.json` 或旧引用服务。
- 根据 quote、相似度、块 ID、材料 ID、PDF 页／框坐标把旧内容映射到新锚点。
- 因格式未发布就删除、覆盖或清空旧目录。
- 在本规格批准后仍暗中保留有限导入代码或兼容运行时。

## Success Criteria

- [ ] 旧 v2 `formatVersion: 1` 被明确识别并拒绝，不会按新清单误读。
- [ ] 已知旧 v1 布局有明确说明，不读取 SQLite、WAL 或批量附件。
- [ ] 拒绝前后旧目录内容不变，不创建工程、revision、workspace、Pi 会话或后台任务。
- [ ] 用户可手动重新导入单个 PDF或复制普通 Markdown／图片，但不获得旧引用、批注、会话和位置兼容。
- [ ] 损坏、未知版本、权限和符号链接场景均正确分流，不猜测、不自动修复。
- [ ] 实现中不存在迁移服务、旧格式查看器、SQLite 读取器、旧引用字典或 `legacy-imports.json`。
- [ ] `npm run typecheck`、`npm run build` 和适用 Windows Electron 回归在实现提交上实际通过。

## Open Questions

本模块没有阻塞批准的产品开放问题。旧 v2 从未公开上线，因此开发期 `formatVersion: 1` 不建立迁移承诺；若未来出现真实发布格式的兼容需求，必须另行立项，不能借本模块隐式恢复旧能力。

## 与其他模块的关系

- `project-core`：提供新清单、安全打开和通用错误；本模块完成其延后的旧格式最终决策。
- `document-core`：只接收新来源产生的文档树，不承担旧 Markdown／块 ID 转换。
- `pdf-import`：用户手动选择旧 PDF 后，完全按新来源快照和付费确认处理。
- `annotations-results`：只识别新 `paper://anchor` 与原生文本批注，不解析旧链接。
- `workspace`：只恢复新 session，不读取 `.paper30min-reading.json`。
- `agent-integration`：只创建新 Pi 会话与新证据，不续跑旧工具轨迹。
- `pdf-comparison`：只使用新来源事实和 current 重建映射，不读取旧 citation／mapping 数据。
