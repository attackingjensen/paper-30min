# 文档

开发直接使用已安装的 Compound Engineering（CE）技能。需求探索、计划、实施、审查和经验沉淀的步骤与产物格式由技能管理，仓库不维护第二套流程。

- `plans/`：技能按需生成统一计划，探索与实施设计在同一产物中推进。
- `solutions/`：ce-compound 按条件沉淀经验证的项目经验。
- `reviews/`：代码审查与发布前风险记录；当前重点见 [v1.2.0 发布前审查](reviews/2026-09-24-v1.2-pre-release.md)。
- `releases/`：预发布说明与安装版验收范围；当前见 [v1.2.0-beta.2](releases/v1.2.0-beta.2.md)，解析组件说明见 [v1.2.0-beta.1](releases/v1.2.0-beta.1.md)。
- 其他产物目录由相应技能按需创建；不预建完整目录树或空白模板。

项目介绍见 [README](../README.md)，当前进度见 [current.md](current.md)，产品定位与方向见 [STRATEGY.md](../STRATEGY.md)，业务概念与既有取舍见 [CONCEPTS.md](../CONCEPTS.md)，运行和测试见 [客户端 README](../app/README.md)。工作上下文来自当前任务、相关计划、代码、测试和必要的 Issue；`current.md` 只保留简短的项目进度，提交前按实际变化更新。

2026-09-23 从旧文档体系迁移至 CE。迁移前的 ADR、背景调研、验证记录、状态与草稿不再保留于工作区，可从 [Git 历史 35324e7](https://github.com/attackingjensen/paper-30min/tree/35324e785c16059e6d4932ab5b483024733c1f01/docs) 或原始 Issue 查阅；仍适用的进度和领域语义分别见 [current.md](current.md) 与 [CONCEPTS.md](../CONCEPTS.md)。

## 历史资料索引

以下链接固定到迁移前的 Git 提交，用于追溯当时的决定和验证，不代表现行实现；行为变更仍以当前代码、测试和相关 Issue 为准。

- 阅读协议与进度取舍：[三层阅读协议](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/adr/0006-three-layer-reading-protocol.md)、[进度与产物数据模型](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/adr/0007-progress-and-products-data-model.md)。
- 客户端与未来移动阅读边界：[客户端与前端边界](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/client-and-frontend-boundaries.md)、[Rust/JavaScript 接口边界](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/client-local-rust-js-boundary.md)。
- 侧车发版与升级核对：[模型权重再分发许可核实](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/2026-09-10-docling-sidecar/model-license-review.md)、[打包体积与速度复核](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/background/2026-09-10-docling-sidecar/packaging-measurements.md)。
- 性能对照：[v1.0.0 与 #74 优化后的 #85 走查](https://github.com/attackingjensen/paper-30min/blob/35324e785c16059e6d4932ab5b483024733c1f01/docs/draft/2026-09-19-issue85-walkthrough.md)。

CE 配置使用默认值，产物根目录默认是 `docs/`。可选设置见 `.compound-engineering/config.example.yaml`。已启用的自动经验沉淀和汇报写作约定保留在 [AGENTS.md](../AGENTS.md)。
