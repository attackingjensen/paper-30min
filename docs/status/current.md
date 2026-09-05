# 项目当前状态

> 更新时间：2026-09-05

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

## 架构状态

- [ADR-0001](../adr/0001-local-first-reading.md)：采用本地优先的论文阅读方式。
- [ADR-0002](../adr/0002-follow-paper-structure.md)：按论文实际结构组织精读。
- [ADR-0003](../adr/0003-lan-fully-trusted.md)：当前局域网按完全可信环境处理。
- [ADR-0004](../adr/0004-paper-lifecycle-module.md)：`papers.js` 统一拥有论文记录生命周期。
- [ADR-0005](../adr/0005-generation-task-module.md)：`generation.js` 统一拥有精读生成任务及批量编排。
- 运行栈保持原生 JavaScript 与 Python 标准库，无前端构建步骤。

## 工程基线

- `npm test` 是统一门禁，当前 80 个测试全部通过。
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
- Issue #27（Windows Tauri 外壳与 Rust/JavaScript 桥接）已在 `app/` 实现：应用标识 `com.paper30min.reader`，版本化命令 `invoke(command, input)`、`start/subscribe/getTask` 任务事件流、统一错误结构 `{code, message, retryable, details}`、取消幂等且只在安全检查点停止、关闭前运行中任务查询与“等待完成/停止任务”关闭选择；验证入口为 `cargo test`、`node --test` 契约测试和 `--bridge-smoke` 冒烟命令，debug 与 release 构建均经真实窗口走查（启动、事件流、三条关闭路径、退出不留进程）。SQLite 书库（#28）、附件/PDF（#29）、浏览器迁移（#30）、论文与任务接入（#31）按阻塞关系随后推进。
