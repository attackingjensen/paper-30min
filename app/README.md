# 论文精读 Windows 正式客户端（`app/`）

基于 Tauri 的 Windows 正式客户端。Rust 提供窄接口的本地能力，JavaScript 负责领域流程编排与界面。
当前范围（issue #28）：在 #27 桥接之上建立应用数据根目录、版本化 SQLite 与书库基础记录。
覆盖论文、原文章节、精读部分、精读结果、翻译、回想卡片、论文问答和阅读位置；不处理附件文件和浏览器迁移。

实现约束见 `docs/specs/client-and-frontend-boundaries.md` 与 `docs/specs/client-local-rust-js-boundary.md`；
领域术语见根目录 `CONTEXT.md`。`prototype/tauri-reader/` 的临时代码不作为本目录来源。

## 桥接形状

- `bridge_invoke(command, input)`：短时、幂等或事务性操作。命令名带版本后缀（`app.info@1`、
  `bridge.echo@1`、`tasks.*@1`、`library.*@1`、`app.close-window@1`）。
- `bridge_start(taskKind, input)`：长任务，返回 `{ schemaVersion, taskId }`；
  事件经 `task:{taskId}` 通道推送（`chunk` / `progress` / `status`），终态可用 `tasks.get@1` 查询。
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

## 数据位置

应用数据目录由 Tauri 管理（`app_data_dir`，标识 `com.paper30min.reader`），与原型
（`com.paper30min.prototype`）和浏览器书库相互隔离。首次启动会创建
`database/`、`attachments/`、`operations/`、`exports/`，并在 `database/library.sqlite`
建立版本化书库。JavaScript 只通过 `library.*@1` 命令读写领域 DTO，不依赖表结构。
