# Paper30Min

论文精读应用。当前版本使用 Electron + React/TypeScript + Node + Pi SDK；旧 Windows Tauri 客户端已归档。开发使用当前安装的 NexusKit 技能，项目只保留下述特有约定，不另建竞争的开发或审批流程。

## 当前实现

- 根目录 `app/` 是新版 Electron 客户端；`legacy/v1/app/` 是旧客户端，只读参考，不在其中开发新版。
- v2 使用本地开放工程：正文文件、相对路径清单与 Pi 会话为权威，无 SQLite；Node 负责工程与 Agent 运行，React 负责界面。旧版 Rust/SQLite 书库仅供迁移与行为参考。
- `app/skills/` 是产品阅读提示词，根目录 `skills/` 保留旧版协议，均不能与 NexusKit 开发技能混用。

## 分支与交付

- `main` 是持续集成主干，不要求等于最新正式发布版本；正式稳定版由 Release/tag 及对应验收证据界定。
- 日常开发从最新 `main` 创建短分支，按阶段或任务提交面向 `main` 的小 PR，不再维护承载整个版本的长期分支。
- 每个 PR 在合并前完成适用审查和检查，处理阻断项并记录验证结果；未运行的检查不得记为通过。
- 当前任务与进度由 beads 承接；Linear 仅作历史参考，GitHub Issues 只承担外部问题记录。配置见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。
- 贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，发布边界见 [docs/release-workflow.md](docs/release-workflow.md)。

## 验证入口

新版在 `app/` 中运行：

- 类型检查：`npm run typecheck`。
- 生产运行目录构建：`npm run build`，不等同于安装包。
- 真实 Electron 高层集成：`npm test`（或 `npm run test:desktop`），覆盖窗口操作、工程文件结果与重开。
- 开发窗口：`npm run dev`；详见 [app/README.md](app/README.md)，工程契约见 [docs/project-format.md](docs/project-format.md)。

Electron 自动化回归默认隐藏窗口，不弹窗或抢占焦点。只有明确需要现场视觉检查、原生焦点或人工交互验收时，才设置 `PAPER30MIN_TEST_WINDOW=visible` 并通过 Playwright `-g` 筛选相关用例；完成后清除该环境变量，不以可见模式运行整套回归。隐藏模式仍须验证实际渲染、截图和交互，但不能替代原生焦点或人工交互验收；剪贴板用例仍可能使用系统剪贴板。

GitHub 的 `Electron CI` 在 Windows 上运行类型检查、构建和隐藏窗口 Electron 全套回归，Linux 仅做类型检查和构建。`Legacy v1 CI` 独立保留旧客户端检查，两者不能互相替代；只有对应提交实际完成的 CI 才记为通过。归档客户端的检查入口见 `legacy/v1/app/README.md`，不构成新版验证证据。

## 工作约定

- 文档默认中文；标识符与技能 frontmatter 保留技能自身格式。
- 技能或命令不可用时说明情况，不谎称已调用；按改动范围选择检查，无法运行时如实记录。
- 小型明确修复不为凑流程创建计划或额外产物；较大工作按 NexusKit 技能拆分并进入 beads。
- OpenViking 接收完整会话并整理过程记录，仓库不另建逐轮审查流水账。审查结论、验证结果与未解决项写入对应 PR / beads，最终发布证据与限制写入发布说明。
- 涉及设计取舍、非琐碎实现或排障时，先语义检索 OpenViking 既有结论；

## Beads 任务跟踪

- 运行 `bd prime` 获取完整工作流上下文；项目自定义模板见 `.beads/PRIME.md`。
- **禁用 `bd remember` / `bd memories`**：持久知识由 OpenViking 管理，不写入 beads 记忆。
- 常用命令：`bd ready`、`bd show <id>`、`bd update <id> --claim`、`bd close <id>`。
- 图规则：只允许一层 parent-child；checkpoint 只有入边；不建 root epic。详见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

## 快速导航

- 术语表：[CONCEPTS.md](CONCEPTS.md)
- 关键决策：[docs/adr/](docs/adr/)
- 历史资料索引：[docs/README.md](docs/README.md)
- Issue 图与建票规则：[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)

## 项目约定

- idea：`docs/ideation/`，一个想法一个文件
- 决策记录：`docs/adr/`，编号递增，不删旧
- 规格：`docs/spec/`，一份 spec 一个文件；外部工具：无
- task：beads（当前仓库 `attackingjensen/paper-30min`），格式遵循 planning-and-task-breakdown；Linear 仅作历史参考
- issue 图：`docs/agents/issue-tracker.md`
- 子智能体模型：沿用用户级默认配置，不创建项目级或用户级 agent 覆盖文件
- 以上文件在第一次真正产出时创建，不预建空目录
