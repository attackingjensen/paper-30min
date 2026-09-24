# 论文精读 Windows 正式客户端（`app/`）

基于 Tauri 的 Windows 正式客户端。Rust 承担本地能力、模型请求与阅读协议运行，JavaScript 承担界面与前端状态。支持导入、建图、深挖、复述稿和论文问答。云端同步尚未实现，任务注册表为内存态。

## 代码入口

- [bridge.rs](src-tauri/src/bridge.rs)：版本化命令与任务入口。
- [library.rs](src-tauri/src/library.rs)：本地书库与持久化。
- [protocol.rs](src-tauri/src/protocol.rs)、[model.rs](src-tauri/src/model.rs)：阅读协议运行与模型请求。
- [tasks.rs](src-tauri/src/tasks.rs)：任务生命周期。
- [pdfparse.rs](src-tauri/src/pdfparse.rs)、[pdfpool.rs](src-tauri/src/pdfpool.rs)、[pdfassets.rs](src-tauri/src/pdfassets.rs)：解析侧车、常驻池与页图/裁切图。

以下桥接说明用于入门，命令与任务类型以代码和契约测试为准。

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

## Windows 更新与发版核对

v1.2.0-beta.2 是仅更新主程序的预发布版本；解析组件继续使用 v1.2.0-beta.1 的 ZIP、内置哈希及下载地址，不重新打包。v1.1.0 和 Beta.1 用户都需手动安装 Beta.2：预发布不进入稳定版更新端点。更新沿用 `com.paper30min.reader` 的 currentUser NSIS 安装身份，书库仍位于 Tauri 应用数据目录。主程序安装包不含 Docling：新安装用户可在设置的「服务」页按需下载或选择本地 ZIP 安装解析组件。未安装组件时仍可查看 PDF 与已有阅读内容，新 PDF 的结构化解析和页图生成不可用。v1.1.0 原地升级时安装器锁定旧安装目录并保留旧侧车，首次启动复制到用户本地组件目录；迁移失败可在设置中重试。安装前应备份现有书库，并等待生成任务完成或确认取消。

1. 将 Tauri updater 私钥及密码保存在仓库外并独立备份；公钥在 `src-tauri/tauri.conf.json`。私钥丢失后，已安装版本将无法验证后续更新。Windows 代码签名与 updater 的 `.sig` 是不同事项，应分别核对。不要把私钥、密码或组件包提交到仓库。
2. 核对 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 都是同一版本。使用 `TAURI_SIGNING_PRIVATE_KEY`（私钥路径或内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量运行 `npm run tauri build`，不要把凭据写进 `.env`、命令日志或仓库。
3. 核对已发布的 Beta.1 组件 ZIP 和清单与 `src-tauri/component-release.json` 一致；Beta.2 不重新生成或上传组件包。后者的 SHA-256 编入主程序，用于下载安装和本地 ZIP 安装校验。
4. 核对 `src-tauri/target/release/bundle/nsis/Paper30Min_<version>_x64-setup.exe` 与相邻 `.sig`。在仓库根目录运行以下检查；`verify` 会用更新器公钥核对安装包字节、签名注释中的文件名及清单一致性：

   ```powershell
   node tools/release_manifest.mjs create --installer app/src-tauri/target/release/bundle/nsis/Paper30Min_1.2.0-beta.2_x64-setup.exe --component app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.zip --component-manifest app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.manifest.json --tag v1.2.0-beta.2 --manifest app/src-tauri/target/release/latest-beta.json
   node tools/release_manifest.mjs verify --installer app/src-tauri/target/release/bundle/nsis/Paper30Min_1.2.0-beta.2_x64-setup.exe --component app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.zip --component-manifest app/src-tauri/target/release/component/Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.manifest.json --tag v1.2.0-beta.2 --manifest app/src-tauri/target/release/latest-beta.json
   ```

5. 用 `src-tauri/tauri.test-updater.conf.json` 构建隔离安装身份，并由本机测试端点 `127.0.0.1:18437` 提供较新版本的签名清单和安装包，实际走查下载、签名拒绝、安装及书库保留。正式构建不使用该测试配置。
6. 完成代码审查后构建 Beta.2 主程序并签名。Beta.2 Release 标为 GitHub 预发布，仅附上主程序安装包、`.sig` 和独立的 `latest-beta.json`；解析组件继续从 Beta.1 Release 下载。不要上传 `latest.json`，稳定版端点保持指向正式版。云主机完成安装版走查后再决定是否发布 v1.2.0 正式版；正式版须重新构建、签名和复核。本机与 GitHub CI 的实际检查状态分别记录，CI 因账户问题不可用时不记为通过。

## 界面结构（`ui/`）

- `ui/index.html` + `ui/style.css` + `ui/js/main.js`：阅读界面（书库 / 阅读 / 任务中心三个视图）。
- `ui/js/` 领域模块：`papers.js`（论文记录生命周期）、`generation.js`（精读生成编排）、
  `skills.js`、`markdown.js`、`parser.js`（PDF/arXiv/文本解析）在客户端内维护；
  `store.js` 负责 `library.*@1`/`files.*@1` 存储适配，`model.js` 负责设置缓存与 `model.*@1` 任务封装。
- `ui/vendor/` 内置 pdf.js、MathJax，`ui/samples/` 内置示例论文；技能文件由 Rust 编译期内嵌
  （`skills.list@1`），内置技能副本有同步测试防漂移。
- 任务中心从主导航进入，显示全部任务的七态与进度，支持取消与失败重试；
  阅读位置（视图/精读部分/PDF 页码）经 `library.*ReadingPosition@1` 持久化，重开论文时恢复。

## 数据位置

应用数据目录由 Tauri 管理（`app_data_dir`，标识 `com.paper30min.reader`）。首次启动会创建
`database/`、`attachments/`、`operations/`、`exports/`，并在 `database/library.sqlite`
建立版本化书库（v3 起含 settings 表：模型设置与技能覆盖；API Key 只存此处，
不进入论文 DTO、迁移数据与整库导出）。JavaScript 只通过 `library.*@1`、`files.*@1` 与 `migration.*@1` 命令读写领域 DTO，
不依赖表结构，也不接触附件绝对路径。PDF 和其他附件按 `attachments/{paperId}/` 分区保存，
写入使用临时文件后原子改名；`files.readRange@1` 提供按字节范围读取，供在线阅读按页取数。
浏览器书库通过 `migration.inspect@1` 预检整库 JSON（不修改书库），再用 `migration.commit@1`
提交对应预检令牌；按论文 ID 合并记录与附件，不导入 API Key 或应用设置。源文件变化或令牌过期
必须重新预检；提交失败不改写原导出文件。导入文件上限 512 MB。预检由 Rust 读取导出文件，
结果 DTO 不含绝对路径；提交前请自行保留原导出文件。
