# 项目当前状态

> 更新时间：2026-09-12（#69 视图状态机与四 tab 骨架完成）

## 当前阶段

项目定性为"论文精读"专精 agent harness（帮助用户高效阅读一篇完整论文）。Windows 端首轮工程化闭环已完成；当前处于 Wayfinder 地图 [#35](https://github.com/attackingjensen/paper-30min/issues/35) 收敛后的实施链推进期：定稿规格群 [#48](https://github.com/attackingjensen/paper-30min/issues/48)（PDF 块模型生产管线）/ [#51](https://github.com/attackingjensen/paper-30min/issues/51)（进度与已读完数据模型）/ [#52](https://github.com/attackingjensen/paper-30min/issues/52)（提问双形态契约）/ [#55](https://github.com/attackingjensen/paper-30min/issues/55)（建图协议与 L1/L2/L3 产物契约）/ [#56](https://github.com/attackingjensen/paper-30min/issues/56)（应用组织与导航结构）均 ready-for-agent，实施票 #57–#72 已拆出并接好 blocked-by 依赖；#57–#69 已完成关闭，实施前沿为 [#70](https://github.com/attackingjensen/paper-30min/issues/70)（双侧栏交互与 PDF 对照接入）。各票的实现细节、验收证据与走查留档以对应 GitHub Issue 的完成说明为准。

打磨批整改草稿已形成：[2026-09-07 打磨批整改草稿](../draft/2026-09-07-polish-batch-draft.md)，覆盖 UI 层静默行为、阅读流、任务中心与导航、Paper30Min 改名与新图标（已选定 B「30 分钟进度环」）、视觉系统重整；因分析架构调整暂缓转正式规格与票据，重估随地图收敛解禁，时点另定。

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
- 支持论文、精读、PDF、翻译、问答和回想卡片的完整阅读流程。提问支持 @节 chip、原文选中片段引用块与建图门禁。阅读视图为四 tab（地图 / 原文 / 提问 / 回想卡片）与地图页 ⇄ 节页两层导航；翻译是原文 tab 的节级对照。任务运行期间书库 / 任务中心 / 阅读页往返不取消任务。
- 模型调用由 Rust 发起，API Key 只保存在本机设置表；流式输出通过任务事件传给界面。
- 任务中心支持排队、进行中、成功、失败、已取消、待重试等状态，以及取消、重试和关闭窗口时的等待/停止选择。
- 论文成果、附件、设置和阅读位置在关闭并重新打开后可恢复。
- 已完成第一轮渐进式前端重设计：书库、阅读和任务中心三视图，阅读位置可恢复，业务行为和数据契约与浏览器版保持一致。

## 工程验证

- 根目录 `npm test`：209 项通过（递归含 `app/tests/`）。
- `cd app && node --test`：126 项通过。
- `cd app/src-tauri && cargo test`：218 项通过（`pdfparse_regression` 默认跑清单良构，全链 assert 模式本机实测 13/13 全绿）。
- `cd app && npm run smoke`：14/14 通过。
- 真实 Tauri 窗口走查：#31 清单 12 项曾通过（见 draft）；#69 四 tab / 落地分流 / #33 导航走查清单见 [Issue #69 走查](../draft/2026-09-12-issue69-walkthrough.md)，窗口点验待做。
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
| [#70](https://github.com/attackingjensen/paper-30min/issues/70) | 双侧栏交互与 PDF 对照接入 | 未开始 |
| [#71](https://github.com/attackingjensen/paper-30min/issues/71) | 地图页与节页内容区 | 未开始 |
| [#72](https://github.com/attackingjensen/paper-30min/issues/72) | 书库与任务中心呈现、导出切换与走查 | 未开始 |

云端同步服务和 Android 阅读伴侣目前只有正式规格，分别见 [Issue #25](https://github.com/attackingjensen/paper-30min/issues/25) 和 [Issue #26](https://github.com/attackingjensen/paper-30min/issues/26)，暂不进入实现。

## 已知未收口项

这些事项是当前事实或技术限制，不自动转化为新的需求：

- 任务注册表仍为内存态，应用重启后不恢复历史任务。
- 阅读位置尚未携带 `contentVersion`，也未接入云端同步。
- 本机 PDF 打开时暂时一次性读取文件，尚未实现按页懒加载传输。
- 移除回想卡片图片后，附件文件暂时没有清理命令。
- PDF 对照随节页定位该节起始页留给 [#70](https://github.com/attackingjensen/paper-30min/issues/70)，尚未接线。
- 安装包、覆盖升级、干净账户安装和卸载验收尚未完成，属于 #32 范围。
- #33（任务中心导航误取消任务）与 #34（公式密集论文 PDF 保真）已随 #35 地图收敛移交关闭：#33 语义经 #56 规格修订评论落 #69/#72 验收；#34 由 #48 管线的公式占位+裁切图策略覆盖，公式密集回归样例移交 #60，「编辑原文」入口暂不携带、实际使用仍痛再立票。

## 相关决策与维护规则

- 三端路线和客户端边界见 [正式客户端与前端边界规格](../background/client-and-frontend-boundaries.md)（已移入 background，作现状参考）。
- Rust/JavaScript 接口边界见 [本地能力接口规格](../background/client-local-rust-js-boundary.md)（同上）。
- 项目术语和领域约束见 [CONTEXT.md](../../CONTEXT.md)；当前架构的权威决策见 ADR [0006](../adr/0006-three-layer-reading-protocol.md)（三层阅读协议）与 [0007](../adr/0007-progress-and-products-data-model.md)（进度与产物数据模型）。
- 具体需求、决策和验收以 GitHub Issue、规格文件和走查记录为准；本文件只记录当前快照。
- 完成一项工作后，只在该工作改变当前目标、能力、风险、未完成事项或下一步时更新本文件；不要把提交记录、命令输出和过程日志复制到这里。
