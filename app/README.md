# 论文精读 Windows 正式客户端（`app/`）

基于 Tauri 的 Windows 正式客户端。Rust 提供窄接口的本地能力，JavaScript 负责领域流程编排与界面。
当前范围（issue #31）：论文阅读、导入、精读、PDF、翻译、问答和回想卡片流程已接入正式客户端，
并接入 Windows 本地模型调用与统一任务生命周期；完成第一轮渐进式前端重设计（导航、阅读状态、任务反馈）。
不处理云端同步（另票）；任务注册表仍为内存态，重启后任务不恢复。

实现约束见 `docs/specs/client-and-frontend-boundaries.md` 与 `docs/specs/client-local-rust-js-boundary.md`；
领域术语见根目录 `CONTEXT.md`。`prototype/tauri-reader/` 的临时代码不作为本目录来源。

## 桥接形状

- `bridge_invoke(command, input)`：短时、幂等或事务性操作。命令名带版本后缀（`app.info@1`、
  `bridge.echo@1`、`tasks.*@1`、`library.*@1`、`files.*@1`、`migration.*@1`、`settings.*@1`、
  `skills.list@1`、`exports.write@1`、`dialog.*@1`、`app.close-window@1`）。
- `bridge_start(taskKind, input)`：长任务，返回 `{ schemaVersion, taskId }`；
  事件经 `task:{taskId}` 通道推送（`chunk` / `progress` / `status`），终态可用 `tasks.get@1` 查询。
  任务类型：`model.chat@1`（流式模型调用）、`model.test@1`（连接测试）、
  `net.fetch-text@1`（网页文本抓取）、`files.download@1`（整文件下载落附件）、`demo.*@1`（演示）。
  模型与网络失败按统一策略自动重试（retry_waiting → 退避 → 重试，共 3 次）；
  流式 chat 一旦已产出内容块即不再自动重试，避免重复内容。
- 与接口规格措辞的对应：`invoke` → `bridge_invoke`，`start` → `bridge_start`，
  `subscribe(taskId)` → 监听 `task:{taskId}` 事件，`getTask(taskId)` → `tasks.get@1`。
- 每个响应包含 `schemaVersion`；错误统一为 `{ code, message, retryable, details }`。
- 任务状态：`queued`、`running`、`succeeded`、`failed`、`cancel_requested`、`cancelled`、`retry_waiting`；
  取消请求幂等，只在安全检查点停止。
- 窗口关闭时若仍有运行中任务，Rust 阻止关闭并发出 `app:close-requested` 事件；
  前端选择“等待任务完成”（任务全部结束后自动退出）或“停止任务并退出”。

## 运行与验证

```bash
cd app
npm install            # 安装 @tauri-apps/cli

npm run tauri dev      # 开发模式（带控制台）
npm run tauri build    # 安装包：src-tauri/target/release/bundle/nsis/*-setup.exe

npm test               # JavaScript 桥接客户端契约测试（node --test）
npm run test:rust      # Rust 桥接与任务生命周期测试（cargo test）
npm run smoke          # 不开窗口的桥接冒烟检查（debug 构建，退出码 0/1）
```

发布构建不带控制台；`--bridge-smoke` 请用 debug 构建运行。

## 界面结构（`ui/`）

- `ui/index.html` + `ui/style.css` + `ui/js/main.js`：阅读界面（书库 / 阅读 / 任务中心三个视图）。
- `ui/js/` 领域模块：`papers.js`（论文记录生命周期）、`generation.js`（精读生成编排）、
  `skills.js`、`markdown.js`、`parser.js`（PDF/arXiv/文本解析）与浏览器版同源移植；
  `store.js`（`library.*@1`/`files.*@1` 存储适配）、`model.js`（设置缓存与 `model.*@1` 任务封装）为 Tauri 端新增。
- `ui/vendor/`（pdf.js、MathJax）与 `ui/samples/` 从 `public/` 复制；技能文件由 Rust 编译期内嵌
  （`skills.list@1`），`generation.js`/`markdown.js` 与内置技能副本有同步测试防漂移。
- 任务中心从主导航进入，显示全部任务的七态与进度，支持取消与失败重试；
  阅读位置（视图/精读部分/PDF 页码）经 `library.*ReadingPosition@1` 持久化，重开论文时恢复。

## 数据位置

应用数据目录由 Tauri 管理（`app_data_dir`，标识 `com.paper30min.reader`），与原型
（`com.paper30min.prototype`）和浏览器书库相互隔离。首次启动会创建
`database/`、`attachments/`、`operations/`、`exports/`，并在 `database/library.sqlite`
建立版本化书库（v3 起含 settings 表：模型设置与技能覆盖；API Key 只存此处，
不进入论文 DTO、迁移数据与整库导出）。JavaScript 只通过 `library.*@1`、`files.*@1` 与 `migration.*@1` 命令读写领域 DTO，
不依赖表结构，也不接触附件绝对路径。PDF 和其他附件按 `attachments/{paperId}/` 分区保存，
写入使用临时文件后原子改名；`files.readRange@1` 提供按字节范围读取，供在线阅读按页取数。
浏览器书库通过 `migration.inspect@1` 预检整库 JSON（不修改书库），再用 `migration.commit@1`
提交对应预检令牌；按论文 ID 合并记录与附件，不导入 API Key 或应用设置。源文件变化或令牌过期
必须重新预检；提交失败不改写原导出文件。导入文件上限 512 MB。预检由 Rust 读取导出文件，
结果 DTO 不含绝对路径；提交前请自行保留原导出文件。
