# Paper30Min

论文精读应用：Windows Tauri 客户端。开发使用已安装的 NexusKit 技能；项目特有的版本与发布边界见下文，不另建竞争的阶段或审批链。

## 项目事实

- Windows 本地书库是论文内容权威来源；Rust 负责存储、文件、网络、模型和阅读协议运行，JavaScript 负责界面与前端状态。
- `app/` 是 Windows 客户端，`skills/` 是产品阅读提示词，不能与 NexusKit 开发技能混用。
- 下一版本起，从 `main` 创建版本分支；同一分支可由多个对话串行实施多份 plan，最终集中在一个面向 `main` 的版本 PR。v1.2.0 的 `steven123397/dev` 属于历史开发分支，不再作为长期开发入口。
- `steven123397` 独立承担全部开发和维护；仓库持有者 [attackingjensen](https://github.com/attackingjensen) 仅作为产品体验者，不参与开发或 PR。

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
- 每次提交前核对 [docs/current.md](docs/current.md)，按实际进度更新；不记流水账，也不记录 PR 操作状态。
- 版本开发、审查、合并、发布和状态交接的顺序见 [版本交付约定](docs/release-workflow.md)。

## 项目知识

`STRATEGY.md` 承接已确认的产品定位、用户、边界和方向，供探索与规划使用。[CONCEPTS.md](CONCEPTS.md) 提供阅读模型、关键术语与既有取舍。接手前先读 [docs/current.md](docs/current.md)，历史资料索引见 [docs/README.md](docs/README.md)。

`docs/solutions/` 是长期经验库。涉及设计取舍、非琐碎实现或排障时，按主题、模块或症状定向检索标题、`module`、`tags`、`problem_type` 等元数据，精读并复用匹配条目；无匹配时照常推进。

经验沉淀按 `nk-compound` 的准入与授权边界执行，不因完成普通任务自动建档。所有本地提交通过 `nk-commit`，按实际变化维护 `docs/current.md`；`nk-handoff` 仅在明确要求时调用。
