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

可用 `PAPER30MIN_PROFILE` 指定独立本机配置目录，用于隔离试用；普通启动使用 Electron 的 `userData`。启动运行器会移除宿主的 `ELECTRON_RUN_AS_NODE`，防止 Electron 被当成 Node 启动。

## 工程格式

详见 [工程文件契约](../docs/project-format.md)。`src/main/project-service.ts` 是界面及后续 Agent 共享的文件操作入口，由 Node utility process 执行；主进程负责系统选择器、回收站和外部打开，React 通过受限 preload 调用。渲染窗口开启 sandbox 和 context isolation，不直接访问文件系统。

当前支持从 PDF 创建、打开与最近工程、默认位置、材料管理和工作台外壳。PDF 使用 EmbedPDF 完整 Viewer，保留原生缩放、手型拖动、搜索、侧栏和批注等工具，文字选区使用浅紫色。工程 PDF 的阅读位置保存在工程内，Viewer 中临时打开的其他文件不会自动加入工程。Markdown 支持 CodeMirror 编辑、阅读和分屏，提供搜索替换、撤销重做、公式与工程内图片预览；笔记入口可新建文档。保存使用 Ctrl+S 或保存按钮，未保存的编辑在标签和设置往返中保留。外部文件变化自动同步，双方修改时保留内容并提示冲突。其他文本文件可只读查看。解析配置由后续工单交付，正式启动页由 STE-92 承接。

## Agent 对话与模型

设置页可保存 Agent 协议、端点、模型名称和 token 预算，支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 的 Pi 适配器。OpenAI 端点填写 API 基地址（通常以 `/v1` 结尾）；Anthropic 填写服务根地址（例如 `https://api.anthropic.com`），SDK 自行添加 `/v1/messages`。API 密钥由 Electron `safeStorage` 加密，保存在本机 `agent-settings.json`，不返回界面、不写入工程。替换密钥需要重新输入，留空保留已保存密钥；也可明确移除。配置损坏或无法解密时，可在设置页重新填写配置和密钥，或移除旧密钥后保存。

代理可选直连、环境变量或自定义 HTTP/HTTPS 地址。环境变量模式使用启动进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，不读取 Windows 系统代理设置。修改模型或代理在下一次空闲发送时生效，当前回复及其补充消息继续使用原配置。

右侧 Agent 可发送纯文本消息、查看流式回复、补充下一条消息、停止和从已保存消息创建分支。会话自动保存为工程内 `.pi/sessions/*.jsonl`，重开或整体搬迁后可继续；设置往返保留当前会话和输入草稿。停止清空尚未执行的补充消息，保留已收到的内容。各会话可独立运行和停止。当前没有文件、图片或 PDF 附件入口，不自动读取当前文档；取证、写文件、Shell 和研究 Skill 由 STE-81 接入，也不加载本机全局 Pi 扩展或技能。

真实模型测试须单独启用，当前测试会只读旧 Windows Paper30Min 保存的模型配置，并使用临时工程和隔离配置目录；运行前确认允许使用该服务及其费用。此模式关闭 trace，凭据不写入测试产物：

```powershell
$env:PAPER30MIN_REAL_MODEL='1'
npx playwright test -g '用本机旧配置运行真实 Pi'
Remove-Item Env:PAPER30MIN_REAL_MODEL
```

Viewer 的 WASM 和中文预置印章使用本地资源，界面字体使用系统字体，不加载默认远端字体。批注编辑与导出使用 Viewer 原生行为，尚未接入工程内的自动保存或 Agent 取证流程。

真实模型基础文本消息单独验证，不代表所有供应商协议、图文输入或工具调用都已验证。当前检查不覆盖安装包、v1 升级或持续内存表现；触控板的实际手感需在设备上体验。旧客户端测试和当前不可用的 GitHub CI 不构成新版验证证据。
