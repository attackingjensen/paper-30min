# 项目当前状态

> 更新时间：2026-09-10

## 当前阶段

项目已完成从浏览器阅读器到 Windows Tauri 客户端的首轮工程化闭环。Windows 端目前达到“能用”，尚未达到“好用”；当前工作重点是实际使用、收集可复现的体验问题，再决定打磨优先级。

打磨批整改草稿已形成：[2026-09-07 打磨批整改草稿](../draft/2026-09-07-polish-batch-draft.md)，覆盖 UI 层静默行为、阅读流、任务中心与导航（含 #33）、Paper30Min 改名与新图标、视觉系统重整；解析器止血、输入保真（#34）与分析架构重组列为方向区。新图标已选定 B「30 分钟进度环」。因分析架构可能带来功能级调整，作者决定暂缓收集多方意见，草稿不转为正式规格与票据；分析架构重新设计已立 Wayfinder 地图：[#35 Paper30Min 精读 harness 重新设计](https://github.com/attackingjensen/paper-30min/issues/35)，项目性质由此从"论文阅读工具"转变为"论文精读"专精 agent harness（帮助用户高效阅读一篇完整论文）。四张调研票（#36–#39）已回；核心设计票 [#41 论文作为代码库](https://github.com/attackingjensen/paper-30min/issues/41) 已定稿关闭：论文表示定为 MD 块模型 + 图表/参考文献清单 + 页图通道（块级出处、统一出处语法），PDF 生产走 Docling 侧车 + 自研参考文献规则层，模型侧四件抓取工具 + L1 常驻地图，深挖为"配方打底 + 工具越界"循环，L1/L2 自底向上生成、产物条条带出处，技能库改为建图/深挖/综合协议提示词 + 章节关注点。Docling 落地验证票 [#46](https://github.com/attackingjensen/paper-30min/issues/46) 已实测关闭（[验证报告](../background/2026-09-09-harness-validation/docling-sidecar-validation.md)）：10 篇踩坑论文集全过（无编号/罗马/双栏/附录全检出、prov 词覆盖 94–97%、CPU 3.0–10.1 s/页、随包增量约 +0.8–1.0GB），百度云端对照中 PP-StructureV3 因坐标帧系统性偏移仅作 BYOK 降级预案、PaddleOCR-VL 因静默截断+生成式不翻盘；规格化票 [#47](https://github.com/attackingjensen/paper-30min/issues/47) 已关闭，定稿规格发布为 [#48 Spec：PDF 块模型生产管线](https://github.com/attackingjensen/paper-30min/issues/48)（ready-for-agent，可拆实施票；遗留风险=Docling 模型权重再分发许可待核实）；进度数据模型票 [#40](https://github.com/attackingjensen/paper-30min/issues/40) 已定稿关闭——已读完=手动标记（可撤销、不以精读结果为前提、论文级派生态），新表 read_marks 随整记录写入缝落库，进度改由标记派生而阅读位置表不动，打卡落库 append-only 活动日表（撤销不回收），schema v4 按快照判据回填且失败拒启动，`CONTEXT.md` 术语已同步；其规格化票 [#49](https://github.com/attackingjensen/paper-30min/issues/49) 已关闭，定稿规格发布为 [#51 Spec：进度与已读完数据模型](https://github.com/attackingjensen/paper-30min/issues/51)（ready-for-agent）；提问契约票 [#42](https://github.com/attackingjensen/paper-30min/issues/42) 已定稿关闭：绑定双形态=@节（@补全 chip+节上入口）与原文选中浮动按钮（PDF 框选不做），单消息单绑定、问答 v1 不挂工具；配方=@节 L1+L2+节原文全送不带页图、片段块并集+覆盖图表自动附裁切图（问答唯一图像通道）、全文=L1+整篇原文；三形态单会话流、12 条历史且绑定注入不重放、统一建图门禁、超输入硬顶报错不截断；chat_messages 增绑定列，气泡 chip/折叠引用块可定位，`CONTEXT.md` 增「绑定提问/全文提问」；其规格化票 [#50](https://github.com/attackingjensen/paper-30min/issues/50) 已关闭，定稿规格发布为 [#52 Spec：提问双形态契约](https://github.com/attackingjensen/paper-30min/issues/52)（ready-for-agent）；规格化过程中发现 #41 模型侧（建图编排、四件抓取工具、L1/L2/L3 产物契约、技能库四段提示词）尚无规格化票，已补立 [#53](https://github.com/attackingjensen/paper-30min/issues/53) 进入前沿；信息架构票 [#43](https://github.com/attackingjensen/paper-30min/issues/43) 已定稿关闭：骨架=地图落地页+节页两层导航（四 tab=地图/原文/提问/回想卡片，PDF 对照侧栏保留，翻译降为原文内节级对照开关），产物居住=L1 地图页、复述稿地图页底部、L2 节页置顶、L3 节页深挖区、原文全局 tab 一处居住（保留跨节片段选择前提）、回想卡片留 tab 且生成源切协议产物，导航即协议=节树状态信号（未深挖/已深挖/已标记）+建图前落地页门禁呈现+出处定位三分（文本块→原文 tab 高亮、图表→节页图区、页→PDF 对照列），书库增建图状态呈现，任务中心单任务粒度+深挖步骤流+批量编排子进度，阅读位置视图值域扩展；UI 原型票 [#44](https://github.com/attackingjensen/paper-30min/issues/44) 已评议通过关闭：三变体可点线框（`prototype/ia-wireframe/`，A 文档式 / B 双栏代码库式 / C 仪表盘式）中选定 **B 双栏代码库式**（节树常驻左栏、状态信号常显）为地图页/节导航结构，并新增 PDF 对照栏左缘拖拽条款（保留 46% 比例宽 + 缩放按钮，拖拽默认约 46%、最小 390px、最宽 75%）；其规格化票 [#54](https://github.com/attackingjensen/paper-30min/issues/54) 随之解除阻塞；规格化票 [#53](https://github.com/attackingjensen/paper-30min/issues/53)、[#54](https://github.com/attackingjensen/paper-30min/issues/54) 均已关闭，定稿规格发布为 [#55 Spec：建图协议与 L1/L2/L3 产物契约](https://github.com/attackingjensen/paper-30min/issues/55)（三个领域任务种类、工具调用走文本协议、产物表 protocol_products、技能库四段提示词+关注点）与 [#56 Spec：应用组织与导航结构](https://github.com/attackingjensen/paper-30min/issues/56)（B 双栏四 tab、节页三态深挖区、侧栏浮钮、出处三分、书库建图状态、旧结果只读折叠区），均 ready-for-agent；汇总票 [#45](https://github.com/attackingjensen/paper-30min/issues/45) 已收官——**#35 地图收敛关闭**：16 张实施票 [#57–#72](https://github.com/attackingjensen/paper-30min/issues) 已拆出，均以子 issue 挂到所属规格并接好原生 blocked-by 依赖；ADR [0006](../adr/0006-three-layer-reading-protocol.md)（三层阅读协议）与 [0007](../adr/0007-progress-and-products-data-model.md)（进度与产物数据模型）已落；CONTEXT.md 复核无缺口。**实施链第一票 [#57](https://github.com/attackingjensen/paper-30min/issues/57) Docling 侧车打包与进程契约已完成**：嵌入式 Python 3.11.9 + 钉版依赖（与 #46 venv 逐版一致）+ 布局/表格/OCR 模型的随包案（落盘 1504MB、NSIS 安装包整体 728MB 实测打包成功，在 #46 估算带内）与首启下载案（36MB + bootstrap 在线补齐，HF_ENDPOINT 可配、hf-mirror 回退实测走通）双双落地；`pdfparse.convert@1`/`pdfparse.bootstrap@1` 任务接入任务中心生命周期（取消=杀子进程），`pdfparse.status@1` 与 `settings.putPdfparse@1`（hfEndpoint）上线；三组模型权重许可逐款核实均可再分发（[核实留档](../background/2026-09-10-docling-sidecar/model-license-review.md)，#48 遗留风险关闭）；OCR 按规格门禁为"仅无文本层页触发"（顺带修掉了 Docling 默认对插图位图逐页 OCR 的数倍减速）；热态实测 2.5–7.8 s/页、全部在 #46 基线 1.5 倍内（[体积与速度复核留档](../background/2026-09-10-docling-sidecar/packaging-measurements.md)）；契约测试 `pdfparse_contract.rs` 8 项全过（夹具 PDF→子进程→结构化输出/错误码/取消）。实施前沿推进为 #58（映射层）、#61、#63、#64、#69。打磨批重估随地图收敛解禁，时点另定。

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
- `cd app/src-tauri && cargo test`：103 项通过（含新增 `pdfparse_contract` 8 项）。
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
