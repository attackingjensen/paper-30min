# 项目当前状态

> 更新时间：2026-09-06

## 当前目标

将仓库持有者使用 Codex 制作并接受的需求原型工程化为可实际使用、可验证和可持续维护的项目。仓库持有者是实际使用者与需求确认者；协作方负责工程质量，不在缺少使用反馈时自行扩展产品需求。`steven123397/dev` 是协作开发分支；当前不创建新的合入 `main` 的 PR。

## 当前能力

- 支持从 arXiv HTML、本地 PDF、示例论文和粘贴文本导入内容；PDF 解析覆盖完整论文。
- 按摘要和论文实际一级章节形成精读部分，并使用对应技能生成单节或整篇精读结果。
- 支持论文问答、PDF 对照阅读、独立翻译、论文整理和回想卡片。
- 技能以 `skills/*.md` 为正式来源；加载失败时回退到内容同步的内置副本。
- 本地书库保存论文、PDF、精读结果、论文问答和阅读状态。
- 整库可通过 JSON 信封导出和导入；导出排除 API Key，导入按论文 ID 合并。
- 支持 Markdown、LaTeX 公式、阅读进度、连续阅读统计和单篇笔记导出。
- 模型连接支持 OpenAI 兼容接口及 DashScope 地址改写。
- Windows 正式客户端可将浏览器整库 JSON 预检后迁入本地 SQLite 书库，按论文 ID 合并记录与附件，不导入 API Key。
- Windows 正式客户端已接入完整阅读流程：论文导入（本地 PDF、arXiv、示例论文）、书库、单节/批量精读、PDF 对照阅读、翻译、论文问答和回想卡片；模型调用经 Rust 本地发起（API Key 仅存本机设置表，不进导出与迁移），流式输出经任务事件流推送，支持取消与失败重试（流式产出内容后不再自动重试，避免重复文本）。
- 任务统一呈现等待、进行中、成功、失败、已取消、待重试状态：任务中心从主导航进入，支持取消与失败重试；关闭窗口时可选择等待任务完成或停止任务并退出。
- 第一轮渐进式前端重设计已落地：书库/阅读/任务中心三视图，书库卡片网格，阅读位置（视图/精读部分/PDF 页码）持久化并在重开论文时恢复；业务行为与数据契约与浏览器版保持一致。

## 架构状态

- [ADR-0001](../adr/0001-local-first-reading.md)：采用本地优先的论文阅读方式。
- [ADR-0002](../adr/0002-follow-paper-structure.md)：按论文实际结构组织精读。
- [ADR-0003](../adr/0003-lan-fully-trusted.md)：当前局域网按完全可信环境处理。
- [ADR-0004](../adr/0004-paper-lifecycle-module.md)：`papers.js` 统一拥有论文记录生命周期。
- [ADR-0005](../adr/0005-generation-task-module.md)：`generation.js` 统一拥有精读生成任务及批量编排。
- 运行栈保持原生 JavaScript 与 Python 标准库，无前端构建步骤。Windows 正式客户端在 Tauri 中使用 SQLite 保存书库记录。

## 工程基线

- `npm test` 是统一门禁，当前 117 个测试全部通过。Windows 客户端另有 `cd app && npm test`（node 契约测试 37 项）、`npm run test:rust`（94 项）与 `npm run smoke`（14/14）。
- GitHub Actions CI（`.github/workflows/ci.yml`，Issue #14）在 push 与 PR 时运行：`windows-latest`（产品基准）与 `ubuntu-latest`（路径、文件名大小写等跨平台检查）矩阵，固定 Node 24 与 Python 3.11；门禁为 `npm test`、`server.py`/`tools/mock_llm.py`/`tools/make_sample_pdf.py` 的内存编译检查，以及 `tools/check_syntax.mjs` 对自有 JavaScript 的纯语法检查（覆盖未被测试导入的入口文件，排除 `public/vendor/`）；不生成或提交缓存与解析输出。
- 自动化测试覆盖论文生命周期、书库迁移、技能加载、生成任务、SSE、模型地址与错误处理，以及 Markdown 关键边界。
- 已使用真实 Edge 与慢速 mock 模型走查示例论文导入、PDF 显示、单节与批量生成、中断落库、技能编辑、整库迁移和论文问答；走查期间控制台无异常。
- `tools/check_parser.mjs` 用于人工检查解析结果，不属于自动门禁；运行时仍会出现 PDF.js 标准字体资源警告。

## 当前协作状态

- PR #3 已合入 `main`。
- GitHub Issue #1 至 #13 均已关闭。
- Issue #14 的最小 CI 已在 `steven123397/dev` 实现并推送（0b17761），本地三步门禁（npm test、Python 编译检查、JS 语法检查）均验证通过；首次 Actions 运行（run 33889794169）因账号账单锁定未能启动作业，待作者解锁后重跑验证再关闭。Issue #15 在 CI 稳定后试点 `checkJs`。
- Issue #16 跟踪重切分作废/保留提示在正常 UI 流程不可达的产品决策；Issue #17 的两个重切分小缺陷（粘贴区跨论文残留、标题计数口径）已修复（03f21cf）并经浏览器走查验证（含反向残留场景与 toast 文案实测），已关闭。
- PR #3 之后的功能、修复与 deep module 工作保留在 `steven123397/dev`，暂不创建新的 PR。

## 剩余验证缺口

- Issue #13 的四项验证已于 2026-09-04 全部完成：重切分作废规则与提示、翻译与回想卡片的生成/持久化/恢复、真实模型（阿里云百炼 OpenAI 兼容端点）导入/单节精读/问答全流程、重复生成互斥 toast，均通过；发现记入 Issue #16 与 #17。
- Python 服务器及上游转发路径尚无系统性自动化测试。

## 后续讨论

- Tauri 原型已于 2026-09-05 验证通过（Issue #20，分支 `prototype/tauri-client`）：Windows 与荣耀真机（BVL-AN16）双端关键场景全过，据实推荐 Tauri 为正式客户端基础，Web 阅读器保留；正式实施输入：Android 状态栏安全区适配、网络层归口 Rust、构建镜像配置。小米手机、较大 PDF、未缓存附件离线状态标未验证。
- [Tauri 双端验证范围与通过标准](../draft/prototypes/2026-09-05-tauri-client-validation.md) 已附验证结论；正式实现另起任务，不继承原型临时代码。
- 真机目标已知为协作开发者的荣耀与仓库持有者的小米，均为各自最新系统；具体机型和基础版本留到验证时记录。下一轮讨论前端改版、Windows 设备与关闭行为、Android 后台和下载策略、离线位置冲突、缓存删除及 PDF 操作范围。
- 已确认渐进式重设计、每账号一台主要 Windows、关闭任务时提示等待或停止、PDF 支持在线按需读取与主动下载、Android 首版 PDF 只做翻页/页码跳转/双指缩放/位置恢复。Android 后台下载不作持续保证，回到前台后继续；过期离线阅读位置不自动覆盖较新位置；移动数据不做额外限制；移出移动书架后联网确认时清理手机缓存。Q34–Q41 的产品行为已闭合。
- Q42–Q47 已确认：移动副本包含精读结果、翻译、回想卡片和论文问答，不含 API Key 或应用设置；账号可登录多台 Android 设备；删除采用可重试队列；内容同步使用开始时版本；管理员重置密码使旧会话失效；前端优先改善导航、阅读状态、同步状态和任务反馈，不扩张功能范围。
- 原型工具链已于 2026-09-05 在 Issue #19 补齐并实测：Rust 1.98.1（含四个 Android target）、Microsoft OpenJDK 17.0.20.1、Android SDK（platform-tools 37.0.1、android-35、build-tools 35.0.0、NDK 29.0.14206865 稳定版）装于 `D:\dev\`，环境变量已持久化；宿主与 `aarch64-linux-android` 冒烟构建均通过。干净 Windows 验证已调整口径：开发机新建干净本地账户覆盖安装与覆盖安装验证，仓库持有者主力机（Win11，预装 WebView2）只做一次真实环境确认，WebView2 缺失补装路径标未验证；荣耀手机（HONOR BVL-AN16，Android 16 / MagicOS 10.0.0.175，WebView 138.0.7204.179）已完成 USB 调试授权并经 adb 验证；小米手机短期不可得，其真机走查推迟到原型验证时补测并在此之前标未验证。Issue #19 已关闭，Tauri 原型构建与走查前提齐备，#20 解除阻塞。
- 现有服务器位于北京，暂无域名。已同意暂缓域名购买、公网入口与备案安排，先完成客户端原型验证；正式部署前确认云厂商接入要求，公网或私有组网方案尚未选择。
- Wayfinder 地图 [论文阅读器三端工程化规格路线](https://github.com/attackingjensen/paper-30min/issues/18) 已关闭：工具链、Tauri 原型、云端同步契约、客户端与前端边界、Rust/JavaScript 接口边界的决策票均已完成，正式规格已形成。后续实施按规格另起任务，地图不再产生决策票。
- Wayfinder 票 [#21 云端同步契约](https://github.com/attackingjensen/paper-30min/issues/21) 已完成决策并关闭：确定账号会话、移动阅读副本、不可变内容版本、分单元增量同步、阅读位置冲突、删除 tombstone、统一错误恢复和 5 GB 全局容量上限；契约不绑定 Tauri、Rust、JavaScript 或 Android 外壳。后续客户端与前端规格票可直接引用该契约。
- Windows、云端与 Android 客户端形态正在进行 `grill-with-docs` 设计，当前讨论记录见 [客户端形态草稿](../draft/2026-09-05-client-platform-design.md)；草稿不代表已接受需求。
- 客户端设计已确认论文内容手动增量同步并原子切换版本，界面统一称“云端同步”；阅读位置自动同步，版本不一致时保留各自位置，新版就绪后尝试对应章节，失败时由用户选择。Android 打开时自动检查内容更新，阅读中收到新版则退出阅读页后切换；移动书架提供内容同步状态及逐篇、批量操作。
- Windows 直接调用模型且 API Key 仅留本地。当前最多 2 人使用，计划由管理员创建 `diaozx` 和 `liangjq` 两个独立账号并手动重置密码；云端共享容量上限初始为 5 GB。现有磁盘和 COS 的分配留到部署时讨论。
- 客户端交付方向已确认：Windows 普通安装包、Android 直接分发签名 APK，两端手动覆盖升级并保留数据；旧浏览器书库通过整库导出文件迁入，API Key 重新配置。下一步讨论客户端与云端技术选型，Windows 代码签名和安装器细节待定。
- 云端已在设计讨论中选定独立 FastAPI + Uvicorn + SQLite 服务及 Docker Compose 部署，尚未实施。Windows 正在比较 pywebview 与 Tauri，Android 正在比较 Capacitor、Tauri 与 Kotlin 原生界面方案，客户端 Rust 使用范围未定。现有服务器为腾讯云轻量应用服务器，协作开发者具备网站部署与 TCR 使用经验；GitHub CI 账号锁定等待仓库持有者处理，设计和本地验证可继续。
- CI 已由 Issue #14 落地（范围见工程基线）；`checkJs` 小范围试点已转入 Issue #15，正式 TypeScript 迁移与前端构建步骤仍未决定。
- forwarding module 暂不实施；应先补服务器端行为测试，待转发策略复杂化、出现第二个调用场景或 Windows 外壳带来新职责后重新评估。
- 其他未定建议统一见 [待决技术与产品事项](../draft/2026-09-02-open-decisions.md)。
- Wayfinder 地图已完成；Issue #14、#15、#16、#17 的独立处理状态按各自票据记录，不属于该地图终点。
- Issue #22 已完成决策并关闭；正式客户端与前端边界规格见 [client-and-frontend-boundaries.md](../specs/client-and-frontend-boundaries.md)。
- Issue #23 已完成决策并关闭；Rust/JavaScript 本地能力接口规格见 [client-local-rust-js-boundary.md](../specs/client-local-rust-js-boundary.md)。客户端正式实施可据此另起任务。
- 三张正式规格 Issue 已发布并统一改为中文：Windows 正式客户端与本地书库（#24）、论文移动阅读云端同步服务（#25）、Android 移动阅读伴侣（#26）。#24 已通过 GitHub 原生 sub-issue 关系挂载 6 张实施票，并设置原生 blocking 依赖：#27 Tauri 桥接、#28 SQLite 书库、#29 附件/PDF、#30 浏览器迁移、#31 论文与任务接入、#32 安装升级验收；后续按阻塞关系推进，云端和 Android 暂不拆票。
- Issue #27（Windows Tauri 外壳与 Rust/JavaScript 桥接）已在 `app/` 实现。Issue #28（本地数据目录与 SQLite 书库基础）已在同一目录接入：首次启动创建 `database/` 等逻辑分区与版本化 `library.sqlite`；论文、原文章节、精读部分、精读结果、翻译、回想卡片、论文问答和阅读位置经 `library.*@1` DTO 命令读写；同论文写入串行化并在事务中提交；关闭重开后记录可恢复。Issue #29（附件与 PDF 文件能力）已关闭：PDF 和其他附件按 `attachments/{paperId}/` 分区保存，JavaScript 经 `files.*@1` 取得元数据与字节范围，不接触绝对路径。Issue #30（浏览器书库迁移）已关闭：`migration.inspect@1` 预检整库 JSON，返回格式版本、论文数量、冲突统计和错误且不修改书库；`migration.commit@1` 只接受未过期且对应源文件的预检令牌，按论文 ID 合并记录与附件；API Key 与应用设置不进入迁移数据；源文件变化或令牌过期必须重新预检；提交失败保持事务一致且不改写原导出文件。验证入口为 `cargo test`、`node --test` 契约测试和 `--bridge-smoke`（含迁移提交）。2026-09-06 已在真实 Tauri 窗口补做 #28/#29/#30 走查：书库信息、写入/读取/阅读位置/列出/删除经预览界面按钮全流程验证；两次关闭重启后论文记录与阅读位置完整恢复（界面读取 + SQLite 只读核对一致）；迁移用真实浏览器导出格式 JSON（含 base64 PDF 附件与 apiKey）走完预检、提交、重复导入（added=0/skipped=2 无重复）、源文件变化报 source_changed、损坏 JSON 与版本 99 负例均按规格报错，重新预检后流程可恢复且不重复写附件；迁移 PDF 按 `attachments/{paperId}/` 落盘、sha256 与源一致、无 `.part`/`.old` 残留，API Key 全数据目录 grep 不存在，原导出文件未被应用改写；`npm test`、`cargo test`（41 项）与 `smoke`（8/8）复跑通过。已知小项：预览界面"提交迁移"在令牌耗尽后报"需要字符串参数 token"，提示对用户不友好，正式阅读界面由 #31 接入时自然消除；`files.*@1` 命令级窗口内无入口，以迁移落盘证据与 files 契约测试（8 项）为准。
- [Issue #31](https://github.com/attackingjensen/paper-30min/issues/31)（论文阅读、模型调用与任务生命周期接入）已在 `app/` 实现：阅读界面替换预览界面（`app/ui/`，书库/阅读/任务中心三视图 + 第一轮渐进式重设计）；领域模块从浏览器版同源移植（`papers/generation/markdown` 逐字节一致并有同步测试，`skills/parser` 改注入缝）；存储经 `store.js` 走 `library.*@1`/`files.*@1`，记录↔DTO 映射与迁移写入形状逐条核对一致，PDF 附件 id 固定 `pdf`。新增 Rust 能力：`settings.*@1`（settings 表，DB v2→v3；API Key 仅存本机、不进导出与迁移）、`skills.list@1`（编译期内嵌仓库 `skills/*.md`）、`exports.write@1`（exports 分区或用户对话框亲选路径）、`dialog.pickFile/saveFile@1`（tauri-plugin-dialog，分发在命令层拦截）；新增任务类型 `model.chat@1`（SSE 流式，端点规范化含 DashScope 改写）、`model.test@1`、`net.fetch-text@1`、`files.download@1`（流式落盘 + sha256 + 元数据事务），统一重试策略（retryable → retry_waiting → 退避 → 共 3 次；流式产出内容块后不再自动重试防重复文本），任务事件/快照新增可选 `result` 载荷。回想卡片图片按 #29 交接改存附件（迁移老数据 dataUrl 仍兼容渲染）；打开 PDF 先 `verifyAttachment` 再渲染；阅读位置经 `library.*ReadingPosition@1` 持久化并恢复。任务中心显示七态、进度、取消与失败重试；关闭窗口等待/停止流程保留。code-review 双轴审查后修复：流式重试重复内容、model 配置 dead_code、导出信封补 settings（apiKey 清空）、trackTask 公共 helper、复制品同步测试、sessionTasks 上限、术语对齐「回想卡片」。验证：`cargo test` 94 项、`node --test` 37 项、根 `npm test` 117 项、`--bridge-smoke` 14/14 全绿。已知偏差与后续：任务注册表仍为内存态（重启不恢复，规格"任务持久化"留待后续票）；阅读位置 contentVersion 与 Rust 侧节流落云端同步阶段（当前 JS 防抖）；本机 PDF 打开经一次 `readRange` 全量读字节（#29 交接的 invoke 契约内；"按页懒加载"传输层留待需要时）；回想卡片移除图片的附件残留无清理命令（留待后续票）。真实窗口走查（mock LLM 全流程）：进行中，结果补记。
