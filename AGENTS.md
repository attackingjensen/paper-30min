# Paper30Min

论文精读应用：Windows Tauri 客户端。开发使用已安装的 NexusKit 技能；项目特有的版本与发布边界见下文，不另建竞争的阶段或审批链。

## 项目事实

- Windows 本地书库是论文内容权威来源；Rust 负责存储、文件、网络、模型和阅读协议运行，JavaScript 负责界面与前端状态。
- `app/` 是 Windows 客户端，`skills/` 是产品阅读提示词，不能与 NexusKit 开发技能混用。
- 下一版本起，从 `main` 创建版本分支；同一分支可由多个对话串行实施多份 plan，最终集中在一个面向 `main` 的版本 PR。v1.2.0 的 `steven123397/dev` 属于历史开发分支，不再作为长期开发入口。
- `steven123397` 独立承担全部开发和维护；仓库持有者 [attackingjensen](https://github.com/attackingjensen) 仅作为产品体验者，不参与开发或 PR。

## 快速导航

- 术语表：[CONCEPTS.md](CONCEPTS.md)
- 关键决策：[docs/adr/](docs/adr/)
- Issue 跟踪配置（Linear / GitHub）：[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)
- 版本交付约定：[docs/release-workflow.md](docs/release-workflow.md)

## 验证入口

- Windows JavaScript：`cd app` 后 `node --test`。
- Rust：`cd app/src-tauri` 后 `cargo test`。
- 桌面集成：`cd app` 后 `npm run smoke`；JavaScript 单测不能替代 Tauri 原生桥和窗口验证。
- JavaScript 语法：仓库根目录 `node tools/check_syntax.mjs`。

按改动范围选择检查；构建与运行细节见 `app/README.md`。

GitHub CI 因账户问题暂不可用。恢复前以本机检查记录验证结果，不把未运行的 CI 标为通过；恢复后再核对工作流实际结果。

## 工作约定

- 文档默认中文；标识符与技能 frontmatter 保留技能自身格式。
- 技能不可用时说明情况，不谎称已调用。
- 无法运行的检查说明原因，不标为通过。
- 小型明确修复不为凑流程创建计划或额外产物。
- 开发通过 Orca 托管对话与工作树进行，用法见 `nk-orca-guide`；`/.orca/` 已列入 `.gitignore`。
- 任务与进度由 Linear 承接（配置见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)），仓库不维护进度状态文档。
- OpenViking 接收完整会话并整理过程记录，仓库不另建逐轮审查流水账；审查结论、验证结果与未解决项写入对应 PR / Linear，最终发布证据与限制写入发布说明。
- 版本开发、审查、合并和发布的顺序见 [版本交付约定](docs/release-workflow.md)。

## 项目知识

产品定位、边界与关键决策见 [docs/adr/](docs/adr/)；[CONCEPTS.md](CONCEPTS.md) 提供阅读模型与领域术语。历史资料索引见 [docs/README.md](docs/README.md)。

经验与排障沉淀存放于 OpenViking（含原 `docs/solutions/` 迁入的条目）。涉及设计取舍、非琐碎实现或排障时，先语义检索复用既有结论，无匹配时照常推进；日常蒸馏自动进行，复盘与记忆修订按 `nk-retro` 由用户触发，不因完成普通任务自动建档。所有本地提交通过 `nk-commit`。
