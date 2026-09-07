# 项目当前状态

> 更新时间：2026-09-07

## 当前阶段

项目已完成从浏览器阅读器到 Windows Tauri 客户端的首轮工程化闭环。Windows 端目前达到“能用”，尚未达到“好用”；当前工作重点是实际使用、收集可复现的体验问题，再决定打磨优先级。

打磨批整改草稿已形成：[2026-09-07 打磨批整改草稿](../draft/2026-09-07-polish-batch-draft.md)，覆盖 UI 层静默行为、阅读流、任务中心与导航（含 #33）、Paper30Min 改名与新图标、视觉系统重整；解析器止血、输入保真（#34）与分析架构重组列为方向区。新图标已选定 B「30 分钟进度环」。因分析架构可能带来功能级调整，作者决定暂缓收集多方意见，草稿不转为正式规格与票据；分析架构重新设计已立 Wayfinder 地图：[#35 Paper30Min 精读 harness 重新设计](https://github.com/attackingjensen/paper-30min/issues/35)，项目性质由此从"论文阅读工具"转变为"论文精读"专精 agent harness（帮助用户高效阅读一篇完整论文）；四张调研票（#36–#39）并行调研中，打磨批待地图收敛后重估。

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
- 支持论文、精读、PDF、翻译、问答和回想卡片的完整阅读流程。
- 模型调用由 Rust 发起，API Key 只保存在本机设置表；流式输出通过任务事件传给界面。
- 任务中心支持排队、进行中、成功、失败、已取消、待重试等状态，以及取消、重试和关闭窗口时的等待/停止选择。
- 论文成果、附件、设置和阅读位置在关闭并重新打开后可恢复。
- 已完成第一轮渐进式前端重设计：书库、阅读和任务中心三视图，阅读位置可恢复，业务行为和数据契约与浏览器版保持一致。

## 工程验证

- 根目录 `npm test`：117 项通过。
- `cd app && node --test`：37 项通过。
- `cd app/src-tauri && cargo test`：94 项通过。
- `cd app && npm run smoke`：14/14 通过。
- 真实 Tauri 窗口走查：设置、导入、精读、批量取消、翻译、问答、回想卡片、PDF 操作、任务中心、阅读位置恢复、关闭流程和重启恢复共 12 项通过。
- 详细走查记录见 [Issue #31 真实窗口走查清单](../draft/2026-09-06-issue31-walkthrough.md)。

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

云端同步服务和 Android 阅读伴侣目前只有正式规格，分别见 [Issue #25](https://github.com/attackingjensen/paper-30min/issues/25) 和 [Issue #26](https://github.com/attackingjensen/paper-30min/issues/26)，暂不进入实现。

## 已知未收口项

这些事项是当前事实或技术限制，不自动转化为新的需求：

- 任务注册表仍为内存态，应用重启后不恢复历史任务。
- 阅读位置尚未携带 `contentVersion`，也未接入云端同步。
- 本机 PDF 打开时暂时一次性读取文件，尚未实现按页懒加载传输。
- 移除回想卡片图片后，附件文件暂时没有清理命令。
- 精读节卡片联动 PDF 页码的代码已接入，但还缺一次人工点击确认。
- 安装包、覆盖升级、干净账户安装和卸载验收尚未完成，属于 #32 范围。
- 新增待评估问题：[Issue #33](https://github.com/attackingjensen/paper-30min/issues/33)（任务中心导航误取消任务）和 [Issue #34](https://github.com/attackingjensen/paper-30min/issues/34)（公式密集论文的 PDF 原文保真）；两项暂不自动进入实施。

## 相关决策与维护规则

- 三端路线和客户端边界见 [正式客户端与前端边界规格](../background/client-and-frontend-boundaries.md)（已移入 background，作现状参考）。
- Rust/JavaScript 接口边界见 [本地能力接口规格](../background/client-local-rust-js-boundary.md)（同上）。
- 项目术语和领域约束见 [CONTEXT.md](../../CONTEXT.md)。
- 具体需求、决策和验收以 GitHub Issue、规格文件和走查记录为准；本文件只记录当前快照。
- 完成一项工作后，只在该工作改变当前目标、能力、风险、未完成事项或下一步时更新本文件；不要把提交记录、命令输出和过程日志复制到这里。
