# Paper30Min v2 桌面客户端

Electron + React / TypeScript 客户端。旧 v1 Tauri 客户端源码已删除，历史实现经 git 历史与 Release/tag 追溯。

本文只写开发入口、验证方式与各模块的实现位置；行为契约的权威在 [docs/spec/](../docs/spec/) 与 [工程文件契约](../docs/project-format.md)，预算与质量线在 [CONSTRAINTS.md](../CONSTRAINTS.md)，检查点验证证据在对应 PR 与 beads，不在此复述。

## 开发与验证

在 Windows 上使用 Node.js 24 和 npm，依赖版本由 `package-lock.json` 锁定。

```powershell
cd app
npm ci
npm run dev
```

`dev` 编译 Node 入口、启动 Vite 和真实 Electron 窗口。React 修改即时更新；修改 `src/main/` 或共享契约后重新启动命令。Vite 地址默认是 `http://127.0.0.1:5173`，需通过 Electron 使用本机工程能力。`npm run build` 生成运行目录，`npm start` 打开该构建；这里的构建不是 Windows 安装包。

```powershell
npm run typecheck
npm run build
npm test
```

`npm test` 先构建，再依次运行 4 workers 的非 Electron 测试与 `workers: 1` 的真实 Electron 高层测试，覆盖完整清单。`npm run test:fast` 只运行非 Electron 层；`npm run test:desktop` 构建后只运行 Electron 层；已构建时可用 `npm run test:electron` 直接运行后者。直接执行 `npx playwright test` 仍保留单 workers 的完整默认配置，便于按既有方式筛选用例。

真实 Electron 测试只替代系统文件选择器，使用生产 preload、IPC、Node 工程进程和真实磁盘操作。默认测试使用临时配置与可控模型服务，覆盖流式回复、代理、失败恢复、并发停止和迟到事件。失败保留 trace，布局截图位于 `test-results/`。两层分别在 `test-results/timing/non-electron.json` 与 `test-results/timing/electron.json` 写入 JSON 时序报告。

GitHub 的 `Electron CI` 使用 Node.js 24，在 PR 与 `main` push 上启动两条并行路径，不再对同一 PR 同时触发 push matrix。Linux `quality` 安装一次依赖，运行 `check:fast`、`check:architecture`、`check:lint:type-aware`、`check:dependencies`、构建和并行非 Electron 测试；Windows `electron` 安装一次依赖，构建后先补跑两条 `win32` junction 非 Electron 回归，再以隐藏窗口运行完整串行 Electron 套件。Windows 使用受控服务，不配置真实模型或百度服务凭据；HTML 报告、JSON 时序、失败 trace 和布局截图作为 `electron-test-evidence-windows-latest` 附件保留 14 天，非 Electron 报告单独上传。可从 Actions 页面手动运行工作流。Linux 构建与非 Electron 通过不代表 Electron 桌面行为已验证；CI 不生成安装包。

## 质量约束

[根目录 CONSTRAINTS.md](../CONSTRAINTS.md) 是质量规则的权威来源。本机运行 secrets 门禁前，需要 PATH 中可用 gitleaks 8.30.1；CI 通过 Go 安装相同版本，dependency-cruiser、SWC、Oxlint 与 tsrs 则由 `npm ci` 安装。依赖漏洞检查使用 Node.js 24 自带的 npm，不再需要 OSV Scanner。

```powershell
npm run check:fast    # 类型、knip、原生 Oxlint、gitleaks、diff floor guard；编辑循环
npm run check:task    # fast + 架构边界 + type-aware Oxlint + 分层导入/工程契约 Playwright 套件；任务交还前
npm run check:full    # fast + 架构边界 + type-aware Oxlint + npm audit + 构建 + 完整分层回归；完整本地验证
```

`check:task` 的过滤器为 `project-core|document-core|arxiv-import|pdf-import|pdf-reparse|pdf-snapshot|pdf-verification`，不替代其他功能的定向测试；其他改动仍用 `npx playwright test -g '相关用例'` 补充。`npm run check:lint` 可单独运行原生 correctness 与 React Hooks；`npm run check:lint:type-aware` 再加入 floating Promise。根目录 `.oxlintrc.json` 是唯一 lint 配置，依据官方[配置与规则](https://oxc.rs/docs/guide/usage/linter/config)及 [type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware)。架构边界由 `npm run check:architecture`（dependency-cruiser + SWC，按解析路径判定 11 条规则）单独承担，与 lint 职责零重叠；等价迁移尝试未通过独立审查，退路依据见 CONSTRAINTS。`npm run check:dependencies` 执行 `npm audit --audit-level=high --json`，校验非空依赖树、报告完整性和严重度，high / critical 阻断，registry 或解析错误非零退出；Dependabot 仅作后台监控，不冒充合并门禁。gitleaks 始终使用 `--redact`，扫描排除 `.local/` 本机私有配置、`.upstream/` 只读副本、依赖和生成物，不排除产品源码中的 finding。floor guard 默认与 `origin/main` 的 merge base 比较，可用 `node scripts/floor-guard.mjs --base <ref>` 指定基线。

repository-level Secret Scanning / Push Protection 状态本次未获 admin 证据；用户于 2026-11-21 确认保留 gitleaks、setup-go 与现有仓库设置，不声称已由 GitHub 推送保护接管。

CI 在 Linux quality 执行 fast（含原生 lint）、架构边界、type-aware lint、npm audit、构建和并行非 Electron，Windows electron 继续运行定向 junction 与完整串行 Electron 回归。安全工具或解析器不可用、扫描报告不完整、架构扫描为 0 modules、lint 扫描为 0 files 都按检查失败处理，不能当作通过。

## 死代码检测

[knip](https://knip.dev/overview/getting-started) 是仅用于开发和 CI 的静态检测工具，不进入生产运行代码或安装包。它检查未使用文件、导出、导出类型和依赖，并同时报告未声明依赖；配置位于 `knip.jsonc`，业务源码不需要检测标记。

```powershell
npm run test:dead-code
```

命令有问题时退出码为 1，配置或内部错误为 2；Electron CI 在 Linux quality 把它作为阻断门禁。`src/main/main.ts`、`worker.ts`、`preload.cts` 和 `src/renderer/main.tsx` 显式登记为入口，因为 Electron 的进程启动/预加载路径不都经过静态 import；`includeEntryExports` 同时检查入口文件的导出。当前无 `ignoreFiles`、无 `ignoreIssues` 豁免；历史豁免的清理过程见 git 历史与对应 PR。配置依据见官方 [entry/project 与 ignoreIssues](https://knip.dev/reference/configuration)、[issue types](https://knip.dev/reference/issue-types) 和 [CLI 退出码](https://knip.dev/reference/cli)。

knip 能证明静态引用和依赖层面的死代码情况，不能单独证明旧引用、旧映射、旧材料或旧导入的语义残留为零；退役类任务还需对照退役清单做定向协议、通道和入口检查。

## 测试窗口与配置隔离

桌面回归默认隐藏原生窗口，不显示任务栏按钮，也不抢占桌面焦点；每次启动将原生窗口内容区设为 1440 × 960，避免 runner 的小屏幕改变桌面测试布局，用例内仍可调整为窄窗口。后台仍进行真实渲染和截图，并通过 CDP 保持浏览器输入与剪贴板 API 可用。需要现场视觉检查或验证原生焦点时，只显式显示所选用例：

```powershell
$env:PAPER30MIN_TEST_WINDOW='visible'
npx playwright test -g '需要检查的用例名称'
Remove-Item Env:PAPER30MIN_TEST_WINDOW
```

隐藏测试不代替原生焦点或人工交互验收；涉及复制的用例仍会使用系统剪贴板。普通开发和正式启动默认显示窗口。

可用 `PAPER30MIN_PROFILE` 指定独立本机配置目录，用于隔离试用；普通启动使用 Electron 的 `userData`。启动运行器会移除宿主的 `ELECTRON_RUN_AS_NODE`，防止 Electron 被当成 Node 启动。

## 实现地图

| 领域 | 位置 | 权威规格 | 定向回归 |
|---|---|---|---|
| 工程容器与文档树（formatVersion 2） | `src/main/project-core.ts`、`src/shared/document/`、`src/main/document/merge.ts` | [SPEC-project-core](../docs/spec/SPEC-project-core.md)、[SPEC-document-core](../docs/spec/SPEC-document-core.md) | `-g 'project-core\|document-core'` |
| 命令面与 IPC | `src/main/core-commands.ts`（`core*` 命令族）、`src/main/preload.cts`、`src/main/worker.ts` | [工程文件契约](../docs/project-format.md) | `pdf-core-commands`、真实 Electron 套件 |
| arXiv 导入与更新编排 | `src/main/arxiv/`（reference／version／transport／snapshot／convert／import／lineage／update） | [SPEC-arxiv-import](../docs/spec/SPEC-arxiv-import.md) | `-g 'arxiv-import'` |
| PDF 云端解析 | `src/main/parsing/`（baidu-task／parse-snapshot／parse-convert／pdf-import）、`src/main/pdf/`（snapshot／verification／page-crop／fallback-import） | [SPEC-pdf-import](../docs/spec/SPEC-pdf-import.md) | `-g 'pdf-import'` |
| 界面工程服务（formatVersion 1 过渡形态） | `src/main/project-service.ts` | [工程文件契约](../docs/project-format.md) | `desktop.spec.ts` |
| Full 阅读器（current 投影、复杂内容渲染、原文选区与阅读位置） | `src/shared/reader/projection.ts`、`src/shared/reader/selection.ts`、`src/shared/reader/position.ts`、`src/renderer/reader/FullReader.tsx` | [SPEC-reader](../docs/spec/SPEC-reader.md) | `-g 'reader'` |
| Agent 与模型 | `src/main/agent-service.ts`、`agent-tools.ts`、`pdf-tools.ts`、`web-tools.ts` | [SPEC-agent-integration](../docs/spec/SPEC-agent-integration.md) | `agent-files`、`web-tools` 等 |

要点（细节以规格与契约为准）：

- 新核经 `core*` 命令与旧命令共用同一受限 preload 和 `project:command` 通道，在 Node utility process 执行。渲染窗口开启 sandbox 和 context isolation，不直接访问文件系统；主进程负责系统选择器和外部打开。
- 界面创建链路仍是 `project-service.ts` 的 `formatVersion: 1` 过渡形态（PDF 复制入工程、EmbedPDF 只读 Viewer、Markdown CodeMirror 编辑与自动保存、外部变化冲突提示）。打开 `formatVersion: 2` 工程时论文 tab 为 Full 阅读入口：正文只从 current revision 的 `document.json` 投影渲染（章节、公式、表格、图片、脚注、参考文献与受控 raw block），资产经 `paper30min://project` 协议按受管登记读取；current 为空或损坏显示导入／恢复状态，不渲染伪正文。原文精确选区经 `shared/reader/selection.ts` 映射为 UTF-16 逻辑 range（atom 占一位，KaTeX/MathML 辅助节点不计偏移，跨句/跨单元完整展开，不可映射内容显式降级）；选区工具条的解释/提问把 quote 与上下文送入右侧持续 Agent 对话草稿，不生成问答卡、不自动发送。阅读位置按 `revisionId＋稳定锚点＋锚内相对偏移` 捕获（scrollTop 仅辅助），经 `saveReaderPosition` 按 tab 持久化；重开/resize/revision 变化按锚点恢复：retained/moved 原锚点，changed 定位原节点并提示，removed 保留摘录与 tombstone、父 section 存在时显式回退否则回文首，不按相似文本重挂；恢复窗口禁用浏览器滚动锚定并做布局兜底核对，用户滚动即失效。侧栏宿主由后续切片承接。
- arXiv／PDF 导入命令面已可用：受控 transport 的 `baseUrl` 注入点仅测试门控生效，生产拒绝回环/私网；PDF 云端命令的凭据由主进程注入，上传确认经 `pdf:uploadConfirm` 由 renderer 显式应答；提交结果不明必须人工关联任务号，不自动重传。
- arXiv 更新编排（SPEC §8）命令面已可用：`coreArxivCheckUpdate` 只读 abs 报告版本状态；`coreArxivUpdateCandidate`（要求严格更高版本）／`coreArxivRefetch`／`coreArxivReconvert` 形成三方合并候选（离线重转换无网络参数）；候选身份含转换器版本，构建时整体落盘，`coreArxivPublishCandidate` 按用户确认的候选 revisionId 重载同一存储字节、复核 baseRevision 与来源身份并应用显式冲突选择后发布。PDF 回退后的工程按 pdf-parse→pdf→arXiv 谱系回溯参与检查与更新；候选确认前 current 不变，不做后台自动更新。
- 通用文档合并不依赖来源模块；核验继承等来源侧车逻辑由 PDF 侧调用方经 commit 钩子注入（见工程契约）。
- 无云端资产的视觉块可引用原页裁剪图（PDFium 内容寻址 PNG，随候选 revision 发布，不回写快照）；公式块裁剪是可选区域证据，LaTeX／文本仍是权威。
- 契约测试使用受控 fixtures／受控百度服务，不访问真实云端；真实 Electron 回归经生产 preload、IPC、Node 工程进程与真实 undici 传输。真实 arXiv／百度／模型验收须用户明确授权并单独记录（见下文与 CONSTRAINTS W2）。

## PDF 阅读与旧引用退役

当前版本已移除 PDF 原生批注写回、旧引用字典、`paper://cite/` 与 `#annotation=` 链接，以及按解析块展开引用的 Agent 工具。阅读器保留 PDF 渲染、缩放、滚动与阅读位置恢复；工程 PDF 只读，不提供批注创建入口。

旧解析批次路径（`parsing-service`／`baidu-candidate`／「论文解析」面板、`text/<batchId>/paper.md` 可编辑 Markdown 权威与 `mapping.json` 块映射）已随 Phase 3 检查点退役：PDF 解析统一走 `corePdf*` 命令链，解析结果直接进入规范文档树。旧工程中的历史批次文件保留原位，不再提供读取、恢复或删除入口；旧格式工程按 legacy-projects 规格明确拒绝。上传确认对话框保留，供 PDF 云端命令显式确认使用。

旧逐页审阅、`complete_review_page` 工具与日常 Agent 的审阅门禁已于 v2.0.0 Phase 0 退役：不再提供「开始审阅」「继续审阅」入口，普通会话直接发送即可，Agent 读取正文并按需用 `read_pdf` 对照原页。历史审阅会话作为普通会话记录保留。

## 百度解析配置

在「解析模型」设置中保存百度任务地址、`PaddleOCR-VL-1.6` 与 Token。Token 独立加密保存在本机 `parsing-settings.json`，代理复用 Agent 的代理设置；凭据只从主进程注入 PDF 云端命令，renderer 命令不携带 Token。

接口沿用 [百度官方异步任务服务](https://ai.baidu.com/ai-doc/AISTUDIO/Mml7n69e7)：向 `/api/v2/ocr/jobs` 提交 multipart PDF，收到 `data.jobId` 后查询 `data.state`，完成后下载 `data.resultUrl.jsonUrl`。上传/响应/资产预算见 CONSTRAINTS B7–B10；任务状态机、去敏与恢复契约见 [SPEC-pdf-import](../docs/spec/SPEC-pdf-import.md) 与工程契约。配额及服务端实际模型版本由百度账户和服务决定，请求模型名不等于服务端版本证据。OCR 位置是块区域信息；页面旋转、裁切、预处理或区域无效时明确降为页级，同尺寸页面的语义换位无法自动检出，公式和表格质量仍需对照原页核对。

真实百度验收须由用户明确授权、使用其凭据并单独记录实际任务号、模型、PDF 摘要与费用相关界面；默认回归使用受控百度服务与本地 fixtures，不访问真实云端。

## Agent 对话与模型

设置页可保存 Agent 协议、端点、模型名称和 token 预算，支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 的 Pi 适配器。OpenAI 端点填写 API 基地址（通常以 `/v1` 结尾）；Anthropic 填写服务根地址（例如 `https://api.anthropic.com`），SDK 自行添加 `/v1/messages`。API 密钥由 Electron `safeStorage` 加密，保存在本机 `agent-settings.json`，不返回界面、不写入工程。替换密钥需要重新输入，留空保留已保存密钥；也可明确移除。配置损坏或无法解密时，可在设置页重新填写配置和密钥，或移除旧密钥后保存。

代理可选直连、环境变量或自定义 HTTP/HTTPS 地址。环境变量模式使用启动进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，不读取 Windows 系统代理设置。修改模型或代理在下一次空闲发送时生效，当前回复及其补充消息继续使用原配置。

右侧 Agent 可发送消息、查看流式回复、补充下一条消息、停止和从已保存消息创建分支。会话自动保存为工程内 `.pi/sessions/*.jsonl`，重开或整体搬迁后可继续；设置往返保留当前会话和输入草稿。停止清空尚未执行的补充消息，保留已收到的内容及已完成文件修改。各会话可独立运行和停止。可通过 `@` 选择工程文档和产品 Skill；标签提供实际来源，Agent 按需读取，不自动加载当前文档，也不加载本机全局 Pi 扩展或技能。

普通对话即可根据用户请求读取、编辑成果、运行脚本与搜索网页，无需切换模式。思考过程和工具调用使用统一的可展开卡片；网络搜索密钥在「Agent 网络搜索」设置页独立配置。Pi 原生 read、write、edit、bash 已接入，工具卡片显示参数、过程、输出、失败、实际改动及新文件入口，历史重开仍保留工具调用与结果。read 当前支持 2 MiB 内 UTF-8 工程文本。

`read_pdf` 将工程内 PDF 的指定整页渲染为实际 PNG，不接受区域坐标或预期哈希参数，每次读取当前文件，无需打开 PDF 标签或等待解析，也不改变阅读位置。除图像外只返回路径、文档身份、文件版本、页码、总页数、尺寸（PDF 点单位）、实际缩放和来源信息；不提取文本层、不执行 OCR。正文阅读使用工程解析稿；模型指出原文位置时使用真实文件路径与页码，不猜链接或坐标。「支持视觉输入」须与服务实际能力一致；未启用时明确报错，不提供文本降级。每次调用独立释放 PDFium 与图像，不保留跨调用图像缓存。

在讨论中用 `@记忆卡片` 指定值得保留的原文或讨论，Agent 将其整理为 `memories/` 下的普通 Markdown，保留必要解释、适用条件、疑问与真实来源。卡片使用现有编辑和文件能力，不自动生成或安排复习。新版提示词位于 `app/skills/`，可在「设置 → 产品 Skill」修改，覆盖保存在本机配置目录；调用时会话记录实际提示词和版本。旧根目录 `skills/` 仅供旧版使用。

Windows 的 bash 工具实际执行 PowerShell。使用本机可用的 PowerShell，默认超时 120 秒，工具参数可指定其他期限。输出截断与非零退出码沿用 Pi；子进程置于 Windows Job Object 中，Shell 退出或被取消时清理整棵进程树。只传递运行所需的系统环境变量，不继承模型密钥、代理凭据或 Orca/Codex 会话变量；已知模型密钥在输出、工具结果和持久会话前脱敏。

Shell 是用户授权的受信任主机执行，**没有文件权限沙箱**。工程服务的只读保护强制应用于 write/edit 和界面保存；Shell 规则通过任务授权及模型指令约束，不能保证恶意脚本无法按绝对路径越界或覆盖保护文件，也不能保证拦截脚本自行上传内容。模型正常读取与发送工程上下文属于配置模型的授权；工程外访问、系统修改、上传和发布须符合用户明确任务。该取舍已在 STE-81 实施中经用户确认，Windows Job Object 仅解决进程生命周期。

Viewer 的 WASM 使用本地资源，界面字体使用系统字体，不加载默认远端字体。

## 真实模型验证

真实模型测试须单独启用、使用本机凭据并确认允许该服务及其费用；关闭 trace，凭据不写入测试产物，临时工程与隔离配置由测试清理：

```powershell
$env:PAPER30MIN_REAL_MODEL='1'
npx playwright test -g '用本机旧配置运行真实 Pi'
Remove-Item Env:PAPER30MIN_REAL_MODEL
```

- `PAPER30MIN_REAL_PROFILE`：指定包含 Electron 加密配置 `agent-settings.json` 及配套 `Local State` 的本机目录，复制到隔离测试目录后使用，不修改原配置。记忆卡片验证用 `-g 'STE-99 真实模型' --trace=off`。
- `PAPER30MIN_REAL_CONFIG`：指定本机 JSON 文件（`baseUrl`、`model`、`apiKey`），与 PROFILE 同时指定时优先。明文凭据文件应放在仓库外，完成后删除。
- `PAPER30MIN_REAL_SCAN` + `-g 'read_pdf 真实视觉模型'`：真实视觉验证，使用 high 思考强度与视觉输入。
- `PAPER30MIN_REAL_SAVE_PROFILE`：显式指定时才把加密配置复制到该目录。

真实模型验证仅覆盖实际使用的供应商、模型与场景，不代表所有协议或图文、工具能力都已验证；公式文字仍需对照原页核验。当前检查不覆盖安装包、v1 升级或持续内存表现；触控板的实际手感需在设备上体验。旧客户端测试不构成新版验证证据，远端验证以对应提交的 `Electron CI` 实际结果为准。