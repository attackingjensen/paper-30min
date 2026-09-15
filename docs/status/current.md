# 项目当前状态

> 更新时间：2026-09-15

## 当前阶段

Paper30Min 是「论文精读」专精 agent harness：帮助用户高效读完一篇完整论文。Windows 正式客户端 **1.0.0** 已发布（[GitHub Release](https://github.com/attackingjensen/paper-30min/releases/tag/v1.0.0)）；`steven123397/dev` 与 `main` 同源，当前协作走 `dev`，不创建合入 `main` 的 PR，也不因零散感受新建打磨类 Issue。

Wayfinder 地图 [#35](https://github.com/attackingjensen/paper-30min/issues/35) 的实施链已完成。当前工作是性能规格 [#74](https://github.com/attackingjensen/paper-30min/issues/74)（修订 #48 / #55 的耗时，不改产物契约）：v1.0 反馈解析、建图、深挖都太慢。已完成 #75–#78、#82；[#79](https://github.com/attackingjensen/paper-30min/issues/79) 契约与实现已落地，10 节真实窗口对照待作者点验（走查归 [#85](https://github.com/attackingjensen/paper-30min/issues/85)）。**下一步是 [#80](https://github.com/attackingjensen/paper-30min/issues/80)**（深挖轮次进度与最终稿预览）。云端同步 [#25](https://github.com/attackingjensen/paper-30min/issues/25) 与 Android 阅读伴侣 [#26](https://github.com/attackingjensen/paper-30min/issues/26) 暂不实现。

## 已具备能力

### 浏览器阅读器

仍保留于 `public/`，供体验与旧书库迁移：arXiv HTML / 本地 PDF / 示例 / 粘贴文本导入；按实际一级章节精读；PDF 对照、翻译、问答、整理、回想卡片；Markdown 与公式；进度与打卡；整库 JSON 导入导出（API Key 不进导出文件）。

### Windows 正式客户端

Tauri + Rust + 原生 JavaScript，SQLite 本地书库。支持本地 PDF、arXiv、示例导入，以及浏览器整库预检后迁移。首次空书库播种一份可删除的「使用说明」（不计打卡）。

阅读是四 tab（地图 / 原文 / 提问 / 回想卡片）与地图页 ⇄ 节页两层导航。建图生成阅读地图与全部节薄摘要；深挖按节取证；复述稿手动触发。提问支持 @节、原文选中片段与建图门禁。出处按文本块 / 图表 / 页三分定位。节树与 PDF 对照可调宽、可收起。任务往返书库 / 任务中心 / 阅读页不取消。

导入后页图预渲染与解析并行，解析完成后补渲染图表裁切图；解析完成即可建图。解析默认 TableFormer FAST、线程按物理核钳制到 2–8，设置可切回 ACCURATE。深挖在页图与裁切图齐备前禁用。

协议四阶段默认关闭思考，问答默认开启并显示思考心跳；可按阶段指定模型名与请求体附加参数。模型由 Rust 调用，API Key 只留本机。任务中心覆盖排队到重试，关窗可等待或停止。笔记导出以协议产物为正源。视觉为 soft-ui 皮肤。

Linux 暂不支持（Docling 侧车仅 Windows）。覆盖升级与卸载未专项验收。侧车子进程 Windows 控制台黑窗已修（`CREATE_NO_WINDOW`），随下一补丁发布。

## 性能实施链（#74）

子票挂在 #74，阻塞关系以 GitHub 依赖为准。细节与走查证据以各 Issue 完成说明为准。

| Issue | 内容 | 状态 |
| --- | --- | --- |
| [#75](https://github.com/attackingjensen/paper-30min/issues/75) | 模型轮遥测、解析计时探针与共享 HTTP 客户端 | 已完成 |
| [#76](https://github.com/attackingjensen/paper-30min/issues/76) | 建图只等块模型 | 已完成 |
| [#77](https://github.com/attackingjensen/paper-30min/issues/77) | 页图与解析并行 | 已完成 |
| [#78](https://github.com/attackingjensen/paper-30min/issues/78) | 物理核线程、TableFormer FAST、回归基线 | 已完成 |
| [#79](https://github.com/attackingjensen/paper-30min/issues/79) | 节薄摘要按节分片并有界并发 | 实现已落地，待真实窗口 |
| [#80](https://github.com/attackingjensen/paper-30min/issues/80) | 深挖轮次进度与最终稿预览 | 待开始 |
| [#81](https://github.com/attackingjensen/paper-30min/issues/81) | 深挖减轮：预附图表与一轮多工具 | 待开始 |
| [#82](https://github.com/attackingjensen/paper-30min/issues/82) | 分阶段模型与思考默认（协议关、问答开） | 已完成 |
| [#83](https://github.com/attackingjensen/paper-30min/issues/83) | 批量深挖有界并发 | 待开始（依赖 #79、#80） |
| [#84](https://github.com/attackingjensen/paper-30min/issues/84) | 常驻侧车 | 待开始 |
| [#86](https://github.com/attackingjensen/paper-30min/issues/86) | 可空 temperature 与 400 自动卸参数 | 待开始 |
| [#85](https://github.com/attackingjensen/paper-30min/issues/85) | 性能对照走查与状态同步 | 待开始（依赖全部） |

## 工程验证

门禁：根目录 `npm test`、`cd app && node --test`、`cd app/src-tauri && cargo test`、`cd app && npm run smoke`。走查与回归基线以对应 Issue 完成说明和 `docs/draft/` 中的走查记录为准，不在本文件追加清单。

## 已知未收口项

这些是当前事实或技术限制，不自动转化为新需求：

- 任务注册表是内存态，重启后不恢复历史任务。
- 阅读位置尚未携带 `contentVersion`，也未接入云端同步。
- 本机 PDF 打开时一次性读取文件，尚未按页懒加载。
- 移除回想卡片图片后，附件文件没有清理命令。
- 安装包覆盖升级、干净账户安装和卸载验收未做（原 #32 范围，规格已随定性转变关闭）。
- 批量「全部深挖」重跑已有结果的节没有覆盖确认（单节「重新深挖」有）。
- 「编辑原文」入口暂不提供；公式密集样例由 #60 回归覆盖。

## 权威来源

- 术语：[CONTEXT.md](../../CONTEXT.md)
- 现行客户端边界：[正式客户端与前端边界](../background/client-and-frontend-boundaries.md)、[本地 Rust/JS 接口](../background/client-local-rust-js-boundary.md)
- 架构决策：ADR [0006](../adr/0006-three-layer-reading-protocol.md)、[0007](../adr/0007-progress-and-products-data-model.md)
- 需求、决策、验收以 GitHub Issue 为准；本文件只覆盖当前快照，不追加流水账。状态改动随那次工作同一次提交，见 `AGENTS.md`「项目文档」。
