# Paper30Min

论文精读应用：v2.0.0 使用 Electron + React/TypeScript + Node + Pi SDK；旧 Windows Tauri 客户端已归档。开发使用已安装的 NexusKit 技能；项目特有的版本与发布边界见下文，不另建竞争的阶段或审批链。

## 项目事实

- v2 使用本地开放工程：正文文件、相对路径清单与 Pi 会话为权威，无 SQLite；Node 负责工程与 Agent 运行，React 负责界面。旧版 Rust/SQLite 书库仅供迁移与行为参考。
- 根目录 `app/` 是新版 Electron 客户端；`legacy/v1/app/` 是旧客户端，只读参考，不在其中开发新版。`app/skills/` 是新版产品阅读提示词，根目录 `skills/` 保留旧版协议，均不能与 NexusKit 开发技能混用。
- 下一版本起，从 `main` 创建版本分支；同一分支可由多个对话串行实施多份 plan，最终集中在一个面向 `main` 的版本 PR。v1.2.0 的 `steven123397/dev` 属于历史开发分支，不再作为长期开发入口。
- `steven123397` 独立承担全部开发和维护；仓库持有者 [attackingjensen](https://github.com/attackingjensen) 仅作为产品体验者，不参与开发或 PR。

## 快速导航

- 术语表：[CONCEPTS.md](CONCEPTS.md)
- 关键决策：[docs/adr/](docs/adr/)
- Issue 跟踪配置（Linear / GitHub）：[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)
- 版本交付约定：[docs/release-workflow.md](docs/release-workflow.md)

## 验证入口

新版在 `app/` 中运行：

- 类型检查：`npm run typecheck`。
- 生产运行目录构建：`npm run build`，不等同于安装包。
- 真实 Electron 高层集成：`npm test`（或 `npm run test:desktop`），覆盖窗口操作、工程文件结果与重开。
- 开发窗口：`npm run dev`；详细入口见 [app/README.md](app/README.md)，工程契约见 [docs/project-format.md](docs/project-format.md)。

Electron 自动化回归默认隐藏窗口，不在用户桌面弹窗或抢占焦点，避免干扰用户同时操作电脑。只有明确需要现场前端视觉检查、原生焦点或人工交互验收时，才设置 `PAPER30MIN_TEST_WINDOW=visible` 并通过 Playwright `-g` 筛选相关用例；完成后清除该环境变量，不以可见模式运行整套回归。隐藏模式仍须验证实际渲染、截图和交互，但不能替代原生焦点或人工交互验收；剪贴板用例仍可能使用系统剪贴板。

以下为归档旧客户端的检查，不代表新版 Electron 已通过验证：

- Windows JavaScript：`cd legacy/v1/app` 后 `node --test`。
- Rust：`cd legacy/v1/app/src-tauri` 后 `cargo test`。
- 桌面集成：`cd legacy/v1/app` 后 `npm run smoke`；JavaScript 单测不能替代 Tauri 原生桥和窗口验证。
- JavaScript 语法：仓库根目录 `node tools/check_syntax.mjs`。

按改动范围选择检查；构建与运行细节见 `legacy/v1/app/README.md`。

GitHub 的 `Electron CI` 在 Windows 上运行新版类型检查、构建和隐藏窗口 Electron 全套回归，Linux 仅做类型检查和构建。`Legacy v1 CI` 独立保留旧客户端检查，按旧代码、工具或自身工作流的变更触发，也可手动运行。两者不能互相替代；只有对应提交实际完成的 CI 才记为通过。本机仍按改动范围记录检查。

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
