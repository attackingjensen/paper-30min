# 贡献指南

本文件约定向 Paper30Min 提交改动的分支策略与合并规则。产品定位与边界见 [README.md](README.md) 与 [docs/adr/](docs/adr/)；工程契约见 [docs/project-format.md](docs/project-format.md)。

> 仓库默认分支是 `main`（稳定线）。v2.0.0 的开发在版本分支 `codex/v2.0.0` 上进行，提交 PR 时请手动把 base 切换为版本分支，而不是默认的 `main`。

## 分支策略

- `main`：稳定发布线，只接受版本 PR，不要直接提交。
- 版本分支：从最新 `main` 创建，形如 `codex/v2.0.0`。同一版本可以分多份 plan、由多个对话串行实施，最终集中成一个面向 `main` 的版本 PR。
- 功能分支：从当前版本分支创建，建议命名 `feat/<主题>`、`fix/<主题>`、`docs/<主题>`。
- **不要直接向版本分支 push**。所有改动通过 PR 提交，base 选择版本分支（例如 `codex/v2.0.0`）。

### 有写权限时

```bash
git fetch origin
git switch -c feat/my-change origin/codex/v2.0.0
# ... 修改并本地验证 ...
git push -u origin feat/my-change
```

然后在 GitHub 上创建 PR：base = `codex/v2.0.0`，compare = `feat/my-change`。

### 没有写权限时（fork 流程）

先 fork 仓库，再基于上游的版本分支开发：

```bash
git remote add upstream https://github.com/attackingjensen/paper-30min.git
git fetch upstream
git switch -c feat/my-change upstream/codex/v2.0.0
git push -u origin feat/my-change   # origin 指向自己的 fork
```

创建跨 fork PR 时，base 选择上游仓库的 `codex/v2.0.0`。这条路径不需要仓库写权限。

## 代码与文档约定

- 新版在 `app/` 开发；`legacy/v1/app/` 是已归档的旧客户端，只读参考，不在其中开发。
- 本地开放式工程：正文文件、相对路径清单与 Pi 会话为权威，不引入 SQLite。
- 文档默认中文；代码标识符与技能 frontmatter 保持各自格式。
- 不在仓库新增进度或审查流水账文档：任务与进度记录到 issue tracker（配置见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)），审查结论与验证证据写入对应 PR。
- 提交信息使用 `feat` / `fix` / `docs` / `test` / `ci` / `refactor` 前缀加中文简述，一个提交只做一件事。
- 不提交密钥、token、个人绝对路径或真实论文数据；`.local/`、`tmp/`、`test-results/` 等为本地目录，不进版本库。

## 评审与合并

- PR 需通过 Electron CI：Windows 跑类型检查、构建与隐藏窗口 Electron 全套回归，Linux 只做类型检查与构建。
- 至少一次人工 review；有争议的取舍在 PR 中说明理由。新增依赖需说明用途与替代方案。
- 保持 PR 范围聚焦，不夹带无关改动；已推送的分支不要 force push。
- 合并由版本分支维护者执行；面向 `main` 的合并只通过版本 PR 完成。

## 对 AI 协作者的要求

- 遵循 [AGENTS.md](AGENTS.md) 与当前已安装技能；技能不可用时如实说明，不谎称已调用。
- 汇报时给出实际执行的命令与结果；无法确认的结论不要写成已验证。