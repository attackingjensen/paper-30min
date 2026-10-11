# 文档

开发使用已安装的 NexusKit 技能。需求探索、计划、实施、审查和经验沉淀的步骤与新产物格式由技能管理，仓库不维护第二套流程。已有 CE 产物保留原始格式，使用前核对适用范围与当前代码。

- `adr/`：编号式关键决策记录；新决策接续现有最大编号，历史决策不再复述。
- `releases/`：发布说明与安装版验收范围；当前见 [v1.4.0](releases/v1.4.0.md)，解析组件说明见 [v1.2.0-beta.1](releases/v1.2.0-beta.1.md)。
- 其他产物目录由相应技能按需创建；不预建完整目录树或空白模板。

项目介绍见 [README](../README.md)，关键决策见 [adr/](adr/)，业务概念见 [CONCEPTS.md](../CONCEPTS.md)，运行和测试见 [客户端 README](../app/README.md)，issue 跟踪见 [agents/issue-tracker.md](agents/issue-tracker.md)。工作上下文来自当前任务、相关计划、代码、测试和必要的 Issue；任务与进度由 Linear 承接。

每版一个版本分支和一个代码 PR；合并与正式发布的顺序见[版本交付约定](release-workflow.md)。

OpenViking 接收完整会话并整理过程记录，仓库不再维护逐轮审查流水账。审查结论、验证结果与未解决项写入对应 PR / Linear，最终发布证据与限制保留在 `releases/`；已删除的旧审查记录可从 Git 历史查阅。

2026-09-23 从旧文档体系迁移至 CE；2026-09-29 起开发入口转为 NexusKit，已有 CE 产物不批量改写。首次迁移前的 ADR、背景调研、验证记录、状态与草稿不再保留于工作区，可从 [Git 历史 35324e7](https://github.com/attackingjensen/paper-30min/tree/35324e785c16059e6d4932ab5b483024733c1f01/docs) 或原始 Issue 查阅；仍适用的决策已转写回 [adr/](adr/)，领域语义见 [CONCEPTS.md](../CONCEPTS.md)。

## 历史资料索引

2026-10-09 知识重组：`STRATEGY.md`（末版 366fb74）、`docs/current.md`（末版 49fbec0）与 `docs/solutions/` 已移出工作区，历史文档中指向它们的路径随之失效；仍有效的决策转写为 [adr/](adr/)，两条经验迁入 OpenViking 个人资源（「Windows 签名发布的证据分层」与「PDF 来源定位与实际选区分开建模」）。

当前 v1.4.0 解析试点的质量证据见 [百度 49 页复核](research/2026-10-06-aistudio-full-audit.md) 和 [Docling 49 页对照](research/2026-10-06-docling-full-audit.md)，仅限报告中的配置与样本。

v1.4.0 的实施范围与后续需求计划由 Linear ticket 承载（配置见 [agents/issue-tracker.md](agents/issue-tracker.md)）。

以下链接固定到迁移前的 Git 提交，用于追溯当时的决定和验证，不代表现行实现；行为变更仍以当前代码、测试和相关 Issue 为准。

- 阅读协议与进度取舍：[三层阅读协议](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/adr/0006-three-layer-reading-protocol.md)、[进度与产物数据模型](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/adr/0007-progress-and-products-data-model.md)。
- 客户端与未来移动阅读边界：[客户端与前端边界](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/client-and-frontend-boundaries.md)、[Rust/JavaScript 接口边界](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/client-local-rust-js-boundary.md)。
- 侧车发版与升级核对：[模型权重再分发许可核实](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/2026-09-10-docling-sidecar/model-license-review.md)、[打包体积与速度复核](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/2026-09-10-docling-sidecar/packaging-measurements.md)。
- 性能对照：[v1.0.0 与 #74 优化后的 #85 走查](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/draft/2026-09-19-issue85-walkthrough.md)。

旧 CE 配置及示例已按用户要求删除。现行开发入口和知识检索约定见 [AGENTS.md](../AGENTS.md)。
