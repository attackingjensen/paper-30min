# 贡献指南

本文件约定向 Paper30Min 提交改动的分支策略与合并规则。产品定位与边界见 [README.md](README.md) 与 [docs/adr/](docs/adr/)；工程契约见 [docs/project-format.md](docs/project-format.md)。

> 仓库默认分支是 `main`，作为持续集成主干，不要求等于最新正式发布版本。日常改动通过面向 `main` 的短分支和小 PR 合入。

## 分支策略

- `main`：保持可构建、经过审查的集成状态；正式稳定版由 Release/tag 及对应验收证据界定。
- 短分支：从最新 `main` 创建，按阶段或任务命名，建议使用 `feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`refactor/<主题>`。
- PR：base 选择 `main`，范围保持聚焦，能够独立审查、验证和回退；不再把多个阶段累积到长期版本分支。
- 日常改动不要直接 push 到 `main`。发布后的最终发布文档收尾按 [版本交付约定](docs/release-workflow.md) 处理。

### 有写权限时

```bash
git fetch origin
git switch -c feat/my-change origin/main
# ... 修改并本地验证 ...
git push -u origin feat/my-change
```

然后在 GitHub 上创建 PR：base = `main`，compare = `feat/my-change`。

### 没有写权限时（fork 流程）

先 fork 仓库，再基于上游的 `main` 开发：

```bash
git remote add upstream https://github.com/attackingjensen/paper-30min.git
git fetch upstream
git switch -c feat/my-change upstream/main
git push -u origin feat/my-change   # origin 指向自己的 fork
```

创建跨 fork PR 时，base 选择上游仓库的 `main`。这条路径不需要仓库写权限。

## 代码与文档约定

- 新版在 `app/` 开发；旧 v1 Tauri 客户端源码已删除，历史实现经 git 历史与 Release/tag 追溯。
- 本地开放式工程：正文文件、相对路径清单与 Pi 会话为权威，不引入 SQLite。
- 文档默认中文；代码标识符与技能 frontmatter 保持自身格式。
- 当前任务与进度由 beads 承接，配置见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)；Linear 仅作历史参考，GitHub Issues 只承担外部问题记录。
- 不在仓库新增进度或审查流水账文档；审查结论、验证结果与未解决项写入对应 PR / beads。
- 提交信息使用 `feat` / `fix` / `docs` / `test` / `ci` / `refactor` 前缀加中文简述，一个提交只做一件事。
- 不提交密钥、token、个人绝对路径或真实论文数据；`.local/`、`tmp/`、`test-results/` 等为本地目录，不进版本库。

## 评审与合并

- PR 需通过 Electron CI：Linux quality 跑静态门禁、构建与并行非 Electron 测试；Windows electron 跑构建与隐藏窗口串行 Electron 全套回归。
- 至少一次人工 review；有争议的取舍在 PR 中说明理由。新增依赖需说明用途与替代方案。
- 保持 PR 范围聚焦，不夹带无关改动；已推送的分支不要 force push。
- 合并前处理审查阻断项并记录实际验证结果；未运行的测试或安装走查不得记为通过。
- 合入 `main` 不等于正式发布；安装包、签名、升级与发布验收另按 [版本交付约定](docs/release-workflow.md) 执行。

## 对 AI 协作者的要求

- 遵循 [AGENTS.md](AGENTS.md) 与当前已安装技能；技能或命令不可用时如实说明，不谎称已调用。
- 汇报时给出实际执行的命令与结果；无法确认的结论不要写成已验证。
