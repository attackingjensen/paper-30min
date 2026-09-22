# 项目当前状态

> 更新时间：2026-09-22

## 当前阶段

Paper30Min 是「论文精读」专精 agent harness：帮助用户高效读完一篇完整论文。Windows 正式客户端 **1.0.0** 已发布（[GitHub Release](https://github.com/attackingjensen/paper-30min/releases/tag/v1.0.0)）；`steven123397/dev` 与 `main` 同源，当前协作走 `dev`，不创建合入 `main` 的 PR，也不因零散感受新建打磨类 Issue。

Wayfinder 地图 [#35](https://github.com/attackingjensen/paper-30min/issues/35) 的实施链已完成。性能规格 [#74](https://github.com/attackingjensen/paper-30min/issues/74)（修订 #48 / #55 的耗时，不改产物契约）实施链 **#75–#84、#86 全部完成**，对照走查 [#85](https://github.com/attackingjensen/paper-30min/issues/85) 已完成并关闭（[走查记录](../draft/2026-09-19-issue85-walkthrough.md)：同机 v1.0.0 基线 vs 优化后，3 篇夹具全链 8.0–8.4×；真实窗口 9 项点验 8 过 1 项被缺陷阻断）。走查发现的阻断缺陷 [#87](https://github.com/attackingjensen/paper-30min/issues/87) 已修复并关闭（A+B：深挖校验域改块模型内容节映射域 + 建图后按块模型回写记录 parts；[走查记录](../draft/2026-09-22-issue87-walkthrough.md)：XGBoost / NAF 两篇导入→建图→全部深挖 3/3 过，含取消保留与单节重挖）。当前无进行中工作；开口为走查已知项 [#88](https://github.com/attackingjensen/paper-30min/issues/88) / [#89](https://github.com/attackingjensen/paper-30min/issues/89) 与未来线 [#25](https://github.com/attackingjensen/paper-30min/issues/25) / [#26](https://github.com/attackingjensen/paper-30min/issues/26)。

## 已具备能力

### 浏览器阅读器

仍保留于 `public/`，供体验与旧书库迁移：arXiv HTML / 本地 PDF / 示例 / 粘贴文本导入；按实际一级章节精读；PDF 对照、翻译、问答、整理、回想卡片；Markdown 与公式；进度与打卡；整库 JSON 导入导出（API Key 不进导出文件）。

### Windows 正式客户端

Tauri + Rust + 原生 JavaScript，SQLite 本地书库。支持本地 PDF、arXiv、示例导入，以及浏览器整库预检后迁移。首次空书库播种一份可删除的「使用说明」（不计打卡）。

阅读是四 tab（地图 / 原文 / 提问 / 回想卡片）与地图页 ⇄ 节页两层导航。建图生成阅读地图与全部节薄摘要；深挖按节取证，配方预附本节关键图表裁切图、一轮可发至多三个工具调用；复述稿手动触发。批量深挖多节有界并发推进（上限同建图的协议并发设置），开工即列出全部目标，任务中心按节显示排队 / 轮次 / 完成 / 失败并分栏轨迹，节页各自显示本节运行态；单节失败不停机、收尾汇总失败节，取消后在飞节轮边界收尾、未开始节不再启动。深挖进行中节页实时显示「第 n 轮 · 正在调用工具 · 已收到 x 字」，最终四段式结果与复述稿在生成中流式预览（标「生成中」），任务成功后由落库产物替换；建图 JSON 阶段发接收进度心跳。提问支持 @节、原文选中片段与建图门禁。出处按文本块 / 图表 / 页三分定位。节树与 PDF 对照可调宽、可收起。任务往返书库 / 任务中心 / 阅读页不取消。

导入后页图预渲染与解析并行，解析完成后补渲染图表裁切图；解析完成即可建图。解析默认 TableFormer FAST、线程按物理核钳制到 2–8，设置可切回 ACCURATE。解析侧车常驻：应用启动时预热模型（默认开，可关），第二篇及以后论文解析免去启动等待；页图渲染复用同一进程并与解析并行；空闲超时（默认 10 分钟，可配 1–240）自动释放，常驻不可用自动回退一次一进程。深挖在页图与裁切图齐备前禁用。

协议四阶段默认关闭思考，问答默认开启并显示思考心跳；可按阶段指定模型名与请求体附加参数。温度设置可留空表示不发送；端点拒收 temperature/max_tokens 等参数时自动卸参数重发一次并按端点记住，任务中心可见提示。模型由 Rust 调用，API Key 只留本机。任务中心覆盖排队到重试，关窗可等待或停止。笔记导出以协议产物为正源。视觉为 soft-ui 皮肤。

Linux 暂不支持（Docling 侧车仅 Windows）。覆盖升级与卸载未专项验收。侧车子进程 Windows 控制台黑窗已修（`CREATE_NO_WINDOW`），随下一补丁发布。

## 性能实施链（#74）

子票挂在 #74，阻塞关系以 GitHub 依赖为准。细节与走查证据以各 Issue 完成说明为准。

| Issue | 内容 | 状态 |
| --- | --- | --- |
| [#75](https://github.com/attackingjensen/paper-30min/issues/75) | 模型轮遥测、解析计时探针与共享 HTTP 客户端 | 已完成 |
| [#76](https://github.com/attackingjensen/paper-30min/issues/76) | 建图只等块模型 | 已完成 |
| [#77](https://github.com/attackingjensen/paper-30min/issues/77) | 页图与解析并行 | 已完成 |
| [#78](https://github.com/attackingjensen/paper-30min/issues/78) | 物理核线程、TableFormer FAST、回归基线 | 已完成 |
| [#79](https://github.com/attackingjensen/paper-30min/issues/79) | 节薄摘要按节分片并有界并发 | 已完成 |
| [#80](https://github.com/attackingjensen/paper-30min/issues/80) | 深挖轮次进度与最终稿预览 | 已完成 |
| [#81](https://github.com/attackingjensen/paper-30min/issues/81) | 深挖减轮：预附图表与一轮多工具 | 已完成 |
| [#82](https://github.com/attackingjensen/paper-30min/issues/82) | 分阶段模型与思考默认（协议关、问答开） | 已完成 |
| [#83](https://github.com/attackingjensen/paper-30min/issues/83) | 批量深挖有界并发 | 已完成（窗口点验由 #87 走查补齐） |
| [#84](https://github.com/attackingjensen/paper-30min/issues/84) | 常驻侧车 | 已完成 |
| [#86](https://github.com/attackingjensen/paper-30min/issues/86) | 可空 temperature 与 400 自动卸参数 | 已完成 |
| [#85](https://github.com/attackingjensen/paper-30min/issues/85) | 性能对照走查与状态同步 | 已完成（窗口点验 8/9 过，1 项被 #87 阻断） |

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
- [#87](https://github.com/attackingjensen/paper-30min/issues/87) 已修复关闭（[走查记录](../draft/2026-09-22-issue87-walkthrough.md)）：遗留——建图对齐 parts 不迁移 readMarks，导入→解析窗口内按 pdf.js 序号记的已读完标记在对齐后改指块模型同序号节或成孤儿（不计数、不显示，历史保留）；走查新发现——块模型无 abstract 节的论文（如 NAF）进度 chip 比节树多 1（前端进度域固定补 abstract 占位，该类论文到不了「已读完」），待立后续票。
- 瞬时失败的协议任务会让节页「进行中」与「全部深挖」禁用状态滞留至下次重渲染（#85 走查缺陷 B，低）。
- 常驻侧车池未跨任务保温：每篇解析重付 ~5 s 模型加载，且出现过一次会话级回退停用（#85 走查发现 1/2，侧车隔离实验证明保温能力正常，疑点在池层）——[#88](https://github.com/attackingjensen/paper-30min/issues/88) 跟踪。
- A1 解析计时探针在表密集论文上开销显著（2106 对照：开 102 s / 关 66 s），叠加连跑热节流可击穿 #78 性能门禁；#85 走查按机制以 `PAPER30MIN_PDFPARSE_PERF_FACTOR=2.0` 放宽通过，探针按需化与回归锁容毒同票——[#89](https://github.com/attackingjensen/paper-30min/issues/89) 跟踪。

## 权威来源

- 术语：[CONTEXT.md](../../CONTEXT.md)
- 现行客户端边界：[正式客户端与前端边界](../background/client-and-frontend-boundaries.md)、[本地 Rust/JS 接口](../background/client-local-rust-js-boundary.md)
- 架构决策：ADR [0006](../adr/0006-three-layer-reading-protocol.md)、[0007](../adr/0007-progress-and-products-data-model.md)
- 需求、决策、验收以 GitHub Issue 为准；本文件只覆盖当前快照，不追加流水账。状态改动随那次工作同一次提交，见 `AGENTS.md`「项目文档」。
