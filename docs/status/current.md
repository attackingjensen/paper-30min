# 项目当前状态

> 更新时间：2026-09-15（#77 真实窗口走查通过并关闭）

## 当前阶段

项目定性为"论文精读"专精 agent harness（帮助用户高效阅读一篇完整论文）。Windows 端首轮工程化闭环已完成；Wayfinder 地图 [#35](https://github.com/attackingjensen/paper-30min/issues/35) 收敛后的实施链（#57–#72）已全部完成关闭：定稿规格群 [#48](https://github.com/attackingjensen/paper-30min/issues/48)（PDF 块模型生产管线）/ [#51](https://github.com/attackingjensen/paper-30min/issues/51)（进度与已读完数据模型）/ [#52](https://github.com/attackingjensen/paper-30min/issues/52)（提问双形态契约）/ [#55](https://github.com/attackingjensen/paper-30min/issues/55)（建图协议与 L1/L2/L3 产物契约）/ [#56](https://github.com/attackingjensen/paper-30min/issues/56)（应用组织与导航结构）均已落地并经真实窗口全量走查。各票的实现细节、验收证据与走查留档以对应 GitHub Issue 的完成说明为准。#72 走查暴露的「导入 → 解析 → 预渲染」UI 承接缺口已由 [#73](https://github.com/attackingjensen/paper-30min/issues/73) 补齐：导入 PDF（本地/arXiv）后自动排队解析与预渲染，「开始建图」带前置兜底，建图 preflight 在界面上可达。

打磨批整改草稿 [2026-09-07 打磨批整改草稿](../draft/2026-09-07-polish-batch-draft.md) 的先行项已落地：soft-ui 皮肤（浅底、靛蓝主色、大圆角、彩色柔影与上浮/聚焦反馈）进入正式 UI 并通过真实窗口视觉走查（[2026-09-13 soft-ui 走查](../draft/2026-09-13-softui-walkthrough.md)）；产品改名 **Paper30Min** 与新图标「30 分钟进度环」已全量替换（窗口/任务栏/安装包图标全套、favicon、顶栏品牌、动态窗口标题「论文标题 · Paper30Min」、文档层产品称谓；bundle identifier 保持 com.paper30min.reader 不动以保既有数据根）。草稿其余项经 2026-09-13 重估因大规模重构失效，作者决定放弃，草稿留档退役。

发布线动向（2026-09-13）：Windows 第一版已发布。steven123397/dev 已合入 main（不用 PR，两分支同源），版本号 1.0.0 落位；`Paper30Min_1.0.0_x64-setup.exe`（约 700MB，侧车与模型随包）已通过 [GitHub Release v1.0.0](https://github.com/attackingjensen/paper-30min/releases/tag/v1.0.0) 正式发布，作者在三台 Windows 机器上安装使用验收通过。首次启动空书库自动播种一份内置「使用说明」论文（纯文本、可删除不复活、不计打卡）。Linux 暂不支持：卡在 Docling 侧车仅 Windows 构建，适配另立项。遗留验收项：覆盖升级与卸载未专项验收（三台新装均通过）。发布后已修待出补丁的问题：侧车子进程在 Windows 下弹控制台黑窗（已修 `CREATE_NO_WINDOW`，随下一补丁版发布）。

v1.0 发布后的首要反馈是「太慢」（解析/预渲染、建图、深挖三处等待都过长）。源码分析结论：预渲染挡在建图前、建图调用①是一次巨型输出、深挖每轮全量重发且批量串行，再叠加侧车每次冷启与 Docling 默认 4 线程/ACCURATE 表模式。已立性能规格 [#74](https://github.com/attackingjensen/paper-30min/issues/74)（对 #48/#55 的性能修订，不改产物契约）及实施链 #75–#85。[#75](https://github.com/attackingjensen/paper-30min/issues/75) 已关闭（契约测试 + 真实窗口点验解析计时与建图轮次行）。[#76](https://github.com/attackingjensen/paper-30min/issues/76) 已关闭：解析完成后即可建图，预渲染与建图并行，深挖等页图齐备。[#77](https://github.com/attackingjensen/paper-30min/issues/77) 已关闭：导入后页图预渲染与解析并行，解析完成后补渲染图表裁切图（真实窗口点验任务中心双任务与图表补渲染；页图预渲染明显快于解析）。#75 遥测随即揭示建图一轮「首字 164 s / 总 211 s」的真因：`qwen3.8-flash` 在 DashScope 默认开启思考且强度最高，推理 token 走 `reasoning_content`、应用侧不识别而静默；据此修订 #74 §E3（[修订评论](https://github.com/attackingjensen/paper-30min/issues/74#issuecomment-5665232412)）：协议四阶段默认 `enable_thinking: false`、问答默认开思考并显示「思考中」（[#82](https://github.com/attackingjensen/paper-30min/issues/82) 重写），新增 [#86](https://github.com/attackingjensen/paper-30min/issues/86)（可空 temperature、400 自动卸参数）。当前下一步：#82 是最直接的体感修复，优先；其后按 #78 / #79 推进。

当前不扩展产品范围，不因零散感受新建打磨类 Issue，也不创建合入 `main` 的 PR。`steven123397/dev` 是当前协作分支。

## 已具备能力

### 浏览器阅读器

- 支持从 arXiv HTML、本地 PDF、示例论文和粘贴文本导入论文。
- 按论文实际一级章节组织精读部分，支持单节和批量精读。
- 支持 PDF 对照阅读、翻译、论文问答、论文整理和回想卡片。
- 支持 Markdown、LaTeX 公式、阅读进度、连续阅读统计和单篇笔记导出。
- 支持整库 JSON 导入/导出；导入按论文 ID 合并，API Key 不进入导出文件。

### Windows 正式客户端

- 采用 Tauri + Rust + 原生 JavaScript，SQLite 保存本地书库。
- 支持本地 PDF、arXiv 和示例论文导入，浏览器整库可预检后迁移。
- 支持论文、精读、PDF、翻译、问答和回想卡片的完整阅读流程。提问支持 @节 chip、原文选中片段引用块与建图门禁。阅读视图为四 tab（地图 / 原文 / 提问 / 回想卡片）与地图页 ⇄ 节页两层导航；翻译是原文 tab 的节级对照。地图页呈现 L1 五区块与复述稿（手动触发、重跑确认）；节页聚合 L2 薄摘要、三态深挖、图表区与已读完标记；出处指针按文本块 / 图表 / 页三分定位。节树与 PDF 对照栏可拖拽调宽、可收起为视口边缘浮钮；PDF 对照随节页定位该节起始页。任务运行期间书库 / 任务中心 / 阅读页往返不取消任务。导入 PDF 后页图预渲染与解析并行，解析完成后补渲染图表裁切图；解析完成即可建图。节页「开始深挖」在页图与裁切图齐备前禁用并提示「页图预渲染中」。
- 书库卡片直接呈现建图状态（未建图 / 建图中带实时阶段 / 已建图带标记进度 n/N）；任务中心对协议任务呈现类型徽章、建图阶段流、深挖取证轨迹步骤流（工具步与模型轮按 details 原序穿插：首字时延、总时长、输入/输出 token、缓存命中；reasoning token 非零时高亮）与批量逐节子进度；解析任务详情展示启动 / 模型加载 / 版面 / 表格 / OCR / 其他 / 总计的计时拆分（消费任务快照的 details 有界日志，容量 500，JS 订阅前的事件不丢）。`pdfassets.prerender` 按 scope 显示「预渲染页图 / 预渲染图表 / 预渲染」。模型调用跨轮复用进程级 HTTP 客户端。
- 导出笔记内容源为协议产物（L1/L2/深挖/复述稿，笔记格式 v2），旧精读结果保留为文末只读附录。
- 模型调用由 Rust 发起，API Key 只保存在本机设置表；流式输出通过任务事件传给界面。
- 任务中心支持排队、进行中、成功、失败、已取消、待重试等状态，以及取消、重试和关闭窗口时的等待/停止选择。
- 论文成果、附件、设置和阅读位置在关闭并重新打开后可恢复。
- 已完成第一轮渐进式前端重设计：书库、阅读和任务中心三视图，阅读位置可恢复，业务行为和数据契约与浏览器版保持一致。
- 视觉系统为 soft-ui 皮肤：浅底 `#f8fafc`、靛蓝主色 `#6366f1`、18px 大圆角、彩色柔影，卡片/按钮/输入框/浮钮/弹窗带 hover 上浮、聚焦光圈与按压缩放反馈，全局选区淡靛蓝、细圆角滚动条；纯 CSS 落地于 `app/ui/style.css`，无逻辑改动。

## 工程验证

- 根目录 `npm test`：244 项通过（递归含 `app/tests/`）。
- `cd app && node --test`：161 项通过。
- `cd app/src-tauri && cargo test`：239 项通过（`pdfparse_regression` 默认跑清单良构，全链 assert 模式本机实测 13/13 全绿）。
- `cd app && npm run smoke`：14/14 通过。
- 真实 Tauri 窗口走查：#31 清单 12 项曾通过（见 draft）；#35 实施链的全量窗口点验（视图骨架 / 双侧栏 / 地图页与节页 / 书库与任务中心呈现 / 导出切换 / 阅读位置与重启恢复 / #33 移交用例）见 [Issue #72 全量走查](../draft/2026-09-12-issue72-walkthrough.md)；soft-ui 皮肤的真实窗口视觉走查（18 项清单，1 项 tab hover 缺陷即修即验）见 [2026-09-13 soft-ui 走查](../draft/2026-09-13-softui-walkthrough.md)；#75 任务中心点验解析成功后的计时拆分与建图进行中的模型轮行（首字/总时长/token，reasoning 高亮）；#76 点验解析结束即可建图、任务中心同时可见预渲染、深挖按钮在预渲染完成前禁用并有提示；#77 点验导入后「解析 PDF」与「预渲染页图」并行、解析完成后出现「预渲染图表」、三者完成后深挖可用。
- 详细走查记录见 [Issue #31 真实窗口走查清单](../draft/2026-09-06-issue31-walkthrough.md)；各票新增测试的分布见对应 Issue 的完成说明。

## 实施状态

Windows 正式客户端规格 [Issue #24](https://github.com/attackingjensen/paper-30min/issues/24) 已随项目定性转变关闭（实施链主体已完成），实施链如下：

| Issue | 内容 | 状态 |
| --- | --- | --- |
| [#27](https://github.com/attackingjensen/paper-30min/issues/27) | Tauri 外壳与 Rust/JavaScript 桥接 | 已完成 |
| [#28](https://github.com/attackingjensen/paper-30min/issues/28) | 本地数据目录与 SQLite 书库 | 已完成 |
| [#29](https://github.com/attackingjensen/paper-30min/issues/29) | 附件与 PDF 文件能力 | 已完成 |
| [#30](https://github.com/attackingjensen/paper-30min/issues/30) | 浏览器书库迁移 | 已完成 |
| [#31](https://github.com/attackingjensen/paper-30min/issues/31) | 论文阅读、模型调用与任务生命周期 | 已完成 |
| [#32](https://github.com/attackingjensen/paper-30min/issues/32) | 安装、升级与正式本地验收 | 已关闭（未启动，随定性转变废止） |

#35 地图的实施链（#57–#72，均以子 issue 挂到所属规格）：

| Issue | 内容 | 状态 |
| --- | --- | --- |
| [#57](https://github.com/attackingjensen/paper-30min/issues/57) | Docling 侧车打包与进程契约 | 已完成 |
| [#58](https://github.com/attackingjensen/paper-30min/issues/58) | DoclingDocument → 块模型映射层 | 已完成 |
| [#59](https://github.com/attackingjensen/paper-30min/issues/59) | 页图与图表裁切预渲染 | 已完成 |
| [#60](https://github.com/attackingjensen/paper-30min/issues/60) | 踩坑论文集回归夹具与性能门禁 | 已完成 |
| [#61](https://github.com/attackingjensen/paper-30min/issues/61) | read_marks 与 activity_days：建表、schema v4 迁移与整记录写入缝 | 已完成 |
| [#62](https://github.com/attackingjensen/paper-30min/issues/62) | 进度派生改标记源与打卡写入缝（JS） | 已完成 |
| [#63](https://github.com/attackingjensen/paper-30min/issues/63) | protocol_products 产物表与 DTO 写入缝 | 已完成 |
| [#64](https://github.com/attackingjensen/paper-30min/issues/64) | 技能库改造：四段协议提示词与章节关注点 | 已完成 |
| [#65](https://github.com/attackingjensen/paper-30min/issues/65) | 领域任务种类与文本协议工具循环 | 已完成 |
| [#66](https://github.com/attackingjensen/paper-30min/issues/66) | chat_messages 绑定列与迁移 | 已完成 |
| [#67](https://github.com/attackingjensen/paper-30min/issues/67) | 三形态上下文组装纯函数 | 已完成 |
| [#68](https://github.com/attackingjensen/paper-30min/issues/68) | 提问 UI 行为契约 | 已完成 |
| [#69](https://github.com/attackingjensen/paper-30min/issues/69) | 视图状态机模块与四 tab 骨架 | 已完成 |
| [#70](https://github.com/attackingjensen/paper-30min/issues/70) | 双侧栏交互与 PDF 对照接入 | 已完成 |
| [#71](https://github.com/attackingjensen/paper-30min/issues/71) | 地图页与节页内容区 | 已完成 |
| [#72](https://github.com/attackingjensen/paper-30min/issues/72) | 书库与任务中心呈现、导出切换与走查 | 已完成 |

性能规格 [#74](https://github.com/attackingjensen/paper-30min/issues/74) 的实施链（#75–#85，均以子 issue 挂到 #74，阻塞关系用 GitHub 依赖表达）：

| Issue | 内容 | 状态 |
| --- | --- | --- |
| [#75](https://github.com/attackingjensen/paper-30min/issues/75) | 模型轮遥测、解析计时探针与共享 HTTP 客户端 | 已完成 |
| [#76](https://github.com/attackingjensen/paper-30min/issues/76) | 建图只等块模型：convert 落块模型、preflight 迁移到深挖 | 已完成 |
| [#77](https://github.com/attackingjensen/paper-30min/issues/77) | 页图与解析并行：prerender scope 与前端双排队 | 已完成 |
| [#78](https://github.com/attackingjensen/paper-30min/issues/78) | Docling 线程数按物理核、TableFormer FAST 与基线重建 | 待开始（依赖 #75） |
| [#79](https://github.com/attackingjensen/paper-30min/issues/79) | 节薄摘要默认按节分片并有界并发 | 待开始（依赖 #75） |
| [#80](https://github.com/attackingjensen/paper-30min/issues/80) | 深挖轮次进度与最终稿预览 | 待开始（依赖 #75） |
| [#81](https://github.com/attackingjensen/paper-30min/issues/81) | 深挖减轮：预附本节图表与一轮多工具 | 待开始（依赖 #75） |
| [#82](https://github.com/attackingjensen/paper-30min/issues/82) | 分阶段模型、请求体附加参数与思考模式默认策略（协议关、问答开） | 待开始（依赖 #75，优先） |
| [#83](https://github.com/attackingjensen/paper-30min/issues/83) | 批量深挖有界并发 | 待开始（依赖 #79、#80） |
| [#84](https://github.com/attackingjensen/paper-30min/issues/84) | 常驻侧车：serve 模式、预热、空闲释放与回退 | 待开始（依赖 #75、#77） |
| [#86](https://github.com/attackingjensen/paper-30min/issues/86) | 请求参数兼容性：可空 temperature 与 400 自动卸参数 | 待开始（依赖 #75） |
| [#85](https://github.com/attackingjensen/paper-30min/issues/85) | 性能对照走查与状态同步 | 待开始（依赖全部） |

云端同步服务和 Android 阅读伴侣目前只有正式规格，分别见 [Issue #25](https://github.com/attackingjensen/paper-30min/issues/25) 和 [Issue #26](https://github.com/attackingjensen/paper-30min/issues/26)，暂不进入实现。

## 已知未收口项

这些事项是当前事实或技术限制，不自动转化为新的需求：

- 任务注册表仍为内存态，应用重启后不恢复历史任务。
- 阅读位置尚未携带 `contentVersion`，也未接入云端同步。
- 本机 PDF 打开时暂时一次性读取文件，尚未实现按页懒加载传输。
- 移除回想卡片图片后，附件文件暂时没有清理命令。
- 安装包、覆盖升级、干净账户安装和卸载验收尚未完成，属于 #32 范围。
- 批量「全部深挖」重跑已有结果的节无覆盖确认（单节「重新深挖」有），#72 走查记录在案。
- #33（任务中心导航误取消任务）与 #34（公式密集论文 PDF 保真）已随 #35 地图收敛移交关闭：#33 语义经 #56 规格修订评论落 #69/#72 验收（#72 全量走查已覆盖往返不取消与关窗等待/停止）；#34 由 #48 管线的公式占位+裁切图策略覆盖，公式密集回归样例移交 #60，「编辑原文」入口暂不携带、实际使用仍痛再立票。

## 相关决策与维护规则

- 三端路线和客户端边界见 [正式客户端与前端边界规格](../background/client-and-frontend-boundaries.md)（已移入 background，作现状参考）。
- Rust/JavaScript 接口边界见 [本地能力接口规格](../background/client-local-rust-js-boundary.md)（同上）。
- 项目术语和领域约束见 [CONTEXT.md](../../CONTEXT.md)；当前架构的权威决策见 ADR [0006](../adr/0006-three-layer-reading-protocol.md)（三层阅读协议）与 [0007](../adr/0007-progress-and-products-data-model.md)（进度与产物数据模型）。
- 具体需求、决策和验收以 GitHub Issue、规格文件和走查记录为准；本文件只记录当前快照。
- 完成一项工作后，只在该工作改变当前目标、能力、风险、未完成事项或下一步时更新本文件；不要把提交记录、命令输出和过程日志复制到这里。
