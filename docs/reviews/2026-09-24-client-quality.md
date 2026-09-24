# Windows 客户端代码品质审查记录

对应 [实施计划](../plans/2026-09-24-1011-refactor-client-code-quality-plan.md)。本记录保存改动前基线和审查证据；首轮全量审查、安装版走查与旧书库实测尚未完成，不能据此放行 v2 功能开发。

## 调用边界

`ui/index.html` 与 `ui/style.css` 提供界面，`ui/js/main.js` 持有当前论文、阅读视图和 PDF 查看器状态。`ui/bridge.js` 将命令与任务事件交给 Tauri；Rust `lib.rs` 接入窗口和对话框，`bridge.rs` 分发版本化命令，`tasks.rs` 管理后台任务。`library.rs` 持有 SQLite 书库，`files.rs` 管理附件；`migration.rs` 处理浏览器书库导入，`protocol.rs`、`pdfparse.rs`、`pdfpool.rs` 与 `pdfassets.rs` 处理阅读协议和解析侧车。CI 与构建入口在 `.github/workflows/ci.yml`、`app/package.json` 和 `app/src-tauri/tauri.conf.json`。

## 改动前基线

2026-09-24 在 `steven123397/dev` 运行：

| 检查 | 结果 | 覆盖与限制 |
| --- | --- | --- |
| `app/` 下 `node --test` | 201 项通过 | 导入与书库 DTO、建图/深挖规则、出处、问答、阅读位置等；不运行 WebView2 |
| 根目录 `node tools/check_syntax.mjs` | 120 个文件通过 | 包括未被单测导入的 JS；不检查运行行为 |
| `app/` 下 `npm run smoke` | 14 项通过 | 原生桥、任务取消、设置、文件、迁移与重开恢复；不开窗口 |
| `app/src-tauri/` 下 `cargo test` | 全部通过 | 包括解析侧车、协议、书库与任务契约测试 |

已有 Rust 契约测试覆盖 SQLite v4-v6 迁移、附件重开和完整性、任务取消与重试、解析失败，以及协议产物。它们使用测试夹具，不能证明用户现存书库及附件在安装版中可读。Windows 开发版窗口、WebView2、安装版侧车与旧书库样本均未走查。

## 已确认问题

| 编号 | 证据与受影响路径 | 风险 | 处理与复核 |
| --- | --- | --- | --- |
| Q1 | `main.js` 的 `refreshMapped` 在异步读取后直接写共享 `currentMapped`；`openPaper` 等待位置读取后没有最终论文身份检查 | 快速切论文时，旧论文块模型或位置加载流程进入新论文界面 | 已加最新请求门禁和切换后的身份检查；`reader-resources.test.mjs` 覆盖乱序完成 |
| Q2 | `main.js` 的 PDF 加载在 `getDocument().promise` 完成时直接写共享 `pdfDocument`，旧页的 `getPage` 完成后也会写画布 | 快速切论文或翻页时，旧文档覆盖新查看器，旧文档未释放 | 已加最新请求门禁、过期文档销毁与页渲染版本检查；仍需 WebView2 走查 |
| Q3 | CI 原来只有 `npm test` 和 JS 语法检查，没有 Rust 测试与原生桥 smoke | Rust 或桥接回归可在 CI 中漏检 | 已在 Windows 作业加入 `cargo test` 和 `npm run smoke`；GitHub CI 因账户问题暂不可用，恢复后须验证工作流 |
| Q4 | `ui/bridge.js` 的 `trackTask` 在事件订阅失败时只做两次快照查询；若两次均为运行态，之后没有事件或查询触发收尾 | 任务可以在 Rust 侧结束，但调用方一直等待 | 已补先红后绿的订阅失败测试；失败后轮询快照直到终态（U5） |
| Q5 | `main.js` 的位置防抖写入与离开论文时的立即写入可并发；`library.rs` 的位置更新没有按时间拒绝旧快照 | 较早的位置写入若后完成，可覆盖离开时的最终位置 | 已用先红后绿测试确认写入顺序，并将位置保存串行化（U3/U5） |
| Q6 | `main.js` 的翻译循环在 `await model.chat` 后以共享 `current` 保存译文；关闭或切论文会改变它 | 中断与切换竞态下，译文可能写入错误论文或出现空对象错误 | 已固定发起时论文与中断句柄；切换、取消和成功保存测试通过，仍需窗口走查（U3） |
| Q7 | `library.rs` 的 `delete_paper` 先提交数据库删除，再调用 `remove_paper_files`；文件删除失败会返回错误 | 操作显示失败但记录已消失，附件可能遗留 | 待确定失败恢复和旧数据兼容策略，再补文件错误注入测试（U4） |

Q1-Q6 的代码改动还须通过整套复核；Q7 尚未关闭。此清单不是 U2 的固定首轮清单。继续审查 UI 标记与样式、任务/侧车资源释放、构建打包和异常路径时，新证实的问题按同一证据口径加入。
