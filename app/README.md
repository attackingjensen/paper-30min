# Paper30Min v2 桌面客户端

Electron + React / TypeScript 客户端。新版代码在本目录，旧 Tauri 客户端保留在 [legacy/v1/app](../legacy/v1/app/) 供只读参考。

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

`npm test` 先构建，再运行 Playwright 的真实 Electron 高层测试。测试只替代系统文件选择器，使用生产 preload、IPC、Node 工程进程和真实磁盘操作；回收站调用也使用 Electron 系统接口。默认测试使用临时配置与可控模型服务，覆盖流式回复、代理、失败恢复、并发停止和迟到事件。失败保留 trace，布局截图位于 `test-results/`。

桌面回归默认隐藏原生窗口，不显示任务栏按钮，也不抢占桌面焦点；后台仍进行真实渲染和截图，并通过 CDP 保持浏览器输入与剪贴板 API 可用。需要现场视觉检查或验证原生焦点时，只显式显示所选用例：

```powershell
$env:PAPER30MIN_TEST_WINDOW='visible'
npx playwright test -g '需要检查的用例名称'
Remove-Item Env:PAPER30MIN_TEST_WINDOW
```

隐藏测试不代替原生焦点或人工交互验收；涉及复制的用例仍会使用系统剪贴板。普通开发和正式启动默认显示窗口。

可用 `PAPER30MIN_PROFILE` 指定独立本机配置目录，用于隔离试用；普通启动使用 Electron 的 `userData`。启动运行器会移除宿主的 `ELECTRON_RUN_AS_NODE`，防止 Electron 被当成 Node 启动。

## 工程格式

详见 [工程文件契约](../docs/project-format.md)。`src/main/project-service.ts` 是界面及后续 Agent 共享的文件操作入口，由 Node utility process 执行；主进程负责系统选择器、回收站和外部打开，React 通过受限 preload 调用。渲染窗口开启 sandbox 和 context isolation，不直接访问文件系统。

当前支持从 PDF 创建、打开与最近工程、默认位置、材料管理和工作台外壳。PDF 使用 EmbedPDF 完整 Viewer，保留原生缩放、手型拖动、搜索、侧栏和批注等工具，文字选区使用浅紫色。工程 PDF 的阅读位置保存在工程内，Viewer 中临时打开的其他文件不会自动加入工程。Markdown 支持 CodeMirror 编辑、阅读和分屏，提供搜索替换、撤销重做、公式与工程内图片预览；笔记入口可新建文档。保存使用 Ctrl+S 或保存按钮，未保存的编辑在标签和设置往返中保留。外部文件变化自动同步，双方修改时保留内容并提示冲突。其他文本文件可只读查看。解析配置由后续工单交付，正式启动页由 STE-92 承接。

## 导入旧 PDF

先在「设置 → 工程文件夹」选择默认位置，再从启动页或该设置页进入「导入旧 PDF」。选择旧书库根目录（默认 `%APPDATA%/com.paper30min.reader`），确认或修改逐篇工程名后开始。旧版把原始文件统一存为 `attachments/<论文 ID>/pdf`，默认工程名因此取 `pdf-<论文 ID>`；同名目录追加序号，不覆盖已有文件。

每份 PDF 复制进独立工程，其他旧内容全部不导入，不访问旧数据库，不自动解析或调用模型。可停止导入或重试未完成项；重启后再次导入同一来源会核验并跳过成功项。本机 `legacy-imports.json` 用于重试识别，不随工程搬迁。强制中断留下的未完成目录保留，重试使用新目录。源 PDF 及旧书库不移动、不修改、不删除。完整约定见 [工程文件契约](../docs/project-format.md)。

## Agent 对话与模型

设置页可保存 Agent 协议、端点、模型名称和 token 预算，支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 的 Pi 适配器。OpenAI 端点填写 API 基地址（通常以 `/v1` 结尾）；Anthropic 填写服务根地址（例如 `https://api.anthropic.com`），SDK 自行添加 `/v1/messages`。API 密钥由 Electron `safeStorage` 加密，保存在本机 `agent-settings.json`，不返回界面、不写入工程。替换密钥需要重新输入，留空保留已保存密钥；也可明确移除。配置损坏或无法解密时，可在设置页重新填写配置和密钥，或移除旧密钥后保存。

代理可选直连、环境变量或自定义 HTTP/HTTPS 地址。环境变量模式使用启动进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，不读取 Windows 系统代理设置。修改模型或代理在下一次空闲发送时生效，当前回复及其补充消息继续使用原配置。

右侧 Agent 可发送纯文本消息、查看流式回复、补充下一条消息、停止和从已保存消息创建分支。会话自动保存为工程内 `.pi/sessions/*.jsonl`，重开或整体搬迁后可继续；设置往返保留当前会话和输入草稿。停止清空尚未执行的补充消息，保留已收到的内容及已完成文件修改。各会话可独立运行和停止。当前没有文件、图片或 PDF 附件入口，不自动读取当前文档，也不加载本机全局 Pi 扩展或技能。

普通对话即可根据用户请求读取、编辑成果、运行脚本与搜索网页，无需切换模式。思考过程和工具调用使用统一的可展开卡片；网络搜索密钥在「Agent 网络搜索」设置页独立配置。Pi 原生 read、write、edit、bash 已接入，工具卡片显示参数、过程、输出、失败、实际改动及新文件入口，历史重开仍保留工具调用与结果。read 当前支持 2 MiB 内 UTF-8 工程文本。

`read_pdf` 将已登记 PDF 的指定页面或区域渲染为实际 PNG，无需打开 PDF 标签或等待解析，也不改变阅读位置。除图像外，只返回文件版本、页码、尺寸、区域、缩放和应用登记的可回查引用；不提取文本层、不执行 OCR，也不负责块内短句定位。正文阅读使用工程已有解析稿。模型设置中的「支持视觉输入」须与服务实际能力一致；未启用时明确报错，不提供文本降级。每次调用独立释放 PDFium 与图像，不保留跨调用图像缓存；引用 JSON 只保存定位记录，图像保留在 Pi 工具结果中。附件与研究 Skill 由后续工单接入。

Windows 的 bash 工具实际执行 PowerShell。使用本机可用的 PowerShell，默认超时 120 秒，工具参数可指定其他期限。输出截断与非零退出码沿用 Pi；子进程置于 Windows Job Object 中，Shell 退出或被取消时清理整棵进程树。只传递运行所需的系统环境变量，不继承模型密钥、代理凭据或 Orca/Codex 会话变量；已知模型密钥在输出、工具结果和持久会话前脱敏。

Shell 是用户授权的受信任主机执行，**没有文件权限沙箱**。工程服务的只读保护强制应用于 write/edit 和界面保存；Shell 规则通过任务授权及模型指令约束，不能保证恶意脚本无法按绝对路径越界或覆盖保护文件，也不能保证拦截脚本自行上传内容。模型正常读取与发送工程上下文属于配置模型的授权；工程外访问、系统修改、上传和发布须符合用户明确任务。该取舍已在 STE-81 实施中经用户确认，Windows Job Object 仅解决进程生命周期。

真实模型测试须单独启用，当前测试会只读旧 Windows Paper30Min 保存的模型配置，并使用临时工程和隔离配置目录；运行前确认允许使用该服务及其费用。此模式关闭 trace，凭据不写入测试产物：

```powershell
$env:PAPER30MIN_REAL_MODEL='1'
npx playwright test -g '用本机旧配置运行真实 Pi'
Remove-Item Env:PAPER30MIN_REAL_MODEL
```

`read_pdf` 的真实视觉测试支持通过 `PAPER30MIN_REAL_PROFILE` 指定包含 Electron 加密配置 `agent-settings.json` 及其配套 `Local State` 的本机目录，复制到隔离测试目录并重新启动后使用，不修改原配置。也可通过 `PAPER30MIN_REAL_CONFIG` 指定本机 JSON 文件（字段为 `baseUrl`、`model`、`apiKey`），同时指定时优先使用 JSON。用 `PAPER30MIN_REAL_SCAN` 指定扫描 PDF，并设置 `PAPER30MIN_REAL_MODEL=1` 后运行 `npx playwright test -g 'read_pdf 真实视觉模型'`。该测试使用 high 思考强度与视觉输入，产物不包含密钥。明文凭据文件应放在仓库外，完成后删除；临时工程与隔离配置仍由测试清理。只有显式指定 `PAPER30MIN_REAL_SAVE_PROFILE` 时才把 Electron 加密后的配置及配套 `Local State` 复制到该目录。

Viewer 的 WASM 和中文预置印章使用本地资源，界面字体使用系统字体，不加载默认远端字体。批注编辑与导出使用 Viewer 原生行为，尚未接入工程内的自动保存或 Agent 取证流程。

真实模型验证仅覆盖实际使用的供应商、模型与场景，不代表所有协议或图文、工具能力都已验证；公式文字仍需对照原页核验。当前检查不覆盖安装包、v1 升级或持续内存表现；触控板的实际手感需在设备上体验。旧客户端测试和当前不可用的 GitHub CI 不构成新版验证证据。
