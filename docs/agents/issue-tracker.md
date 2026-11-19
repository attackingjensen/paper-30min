# Issue tracker

- 工具：beads
- 位置：当前仓库 `attackingjensen/paper-30min`

建 issue 图的规则。规则与 tracker 无关；beads 命令见文末。

## 形状

```text
v0.1.0 Phase 1 基础设施        ← 工作单元 = 一列
├── task
├── task
└── checkpoint                 ← 最后一张，只有入边
v0.1.0 Phase 2 编辑器
└── ...
v0.1.0 收口 (milestone)        ← 被各 phase 阻塞
```

- 顶层是工作单元，**没有 root epic**；版本身份写在标题前缀 + label。
- **只允许一层 parent-child。**
- 没有 plan 的维护轮次，整轮就是一个工作单元，不建 phase 层。

## 建图顺序

1. 建工作单元：`v0.1.0 Phase 1 <name>`，label `v0.1.0` + `phase1`；子票同样带所属 `phaseN`。
2. 建任务，挂到所属单元下。
3. 只有真实验证动作才建 checkpoint（跑 e2e、量预算、对契约、跑一轮审查）；同单元的任务阻塞它。
4. 有先后才加 `blocks`，且只在同层加。
5. 顺序中发现的新工作先记录，不立即建执行票；确认真要做时再建，并连 provenance。

## 边

| 边 | 表达 | 方向 |
|---|---|---|
| parent-child | 组成 | 子 → 父 |
| blocks | 调度顺序 | 被阻塞者 → 阻塞者 |
| provenance | 来源 | 新票 → 来源票 |

只有 `blocks` 影响 ready。

**允许**：phase → phase；同单元 task → task；同单元 task → checkpoint。

**禁止**：task ↔ phase 跨级；跨单元 task → task（上提成 phase → phase）；checkpoint 出边；`A→B→C` 已存在时再加 `A→C`。

## checkpoint

- 自带一轮 agent 审查（`code-review-and-quality` 技能）；PR 上人工与 bot 的意见算同一轮。
- 只有入边。没有入边它就能被提前关掉，不算结束点。
- 不许出边。它和单元的关系已由 parent-child 表达。
- 不许强制关闭单元，否则顺序保证失效。

## 审查

- 审查可以建票。一个单元做全量审查时，按范围拆成若干 review 票，挂本单元下，与任务同级。
- finding 第一轮落在对话、review 票还是别处，不做规定。
- 修 finding 的执行票不挂父，也不当别的票的子票；只连 provenance，默认连产生它的 checkpoint，或用户指定的票。

## 关闭

- 理由写：改了什么 / 怎么验的 / 证据（命令、输出、commit、测试名）。
- task 关闭 = 验收满足 + 证据；单元关闭 = 子票全关 + findings 都有去向。
- 不删票。纠正用 supersede / reparent。

## 命名

- 单元 `v0.1.0 Phase 1 <name>`，label `v0.1.0` + `phase1`（子票带同一 `phaseN`）
- 维护轮次 `v0.1.2 简化`，label `v0.1.2` + `simplify`
- 收口 `v0.1.2 收口`，type `milestone`
- label 是筛选维度，不承担结构：每张票带所属 `phaseN`（如 `phase2`），便于跨父子层级按 phase 筛选；结构仍由 parent-child 表达。跨 phase 横切杂务（质量基线、依赖处置等）不打 phase 标签

## 换 tracker

| 概念 | beads | Linear | GitHub |
|---|---|---|---|
| 工作单元 | epic | project / parent issue | parent issue |
| 组成 | parent-child | sub-issue | sub-issue |
| 先后 | `blocks` | blocked-by | issue dependency |
| 来源 | `discovered-from` | related + 正文注明 | 正文注明 + `from:x` label |
| 收口 | milestone issue | milestone | milestone |

最少要有：一层嵌套、blocked-by、label、来源可追溯。

## beads 速查

```bash
bd create --title="v0.1.0 Phase 1 基础设施" --type=epic -l v0.1.0,phase1
bd create --title="..." --parent=<unit> --acceptance="..."
bd dep add <被阻塞> <阻塞者>                      # blocks
bd dep add <新票> <来源票> -t discovered-from     # provenance
bd ready · bd dep cycles · bd lint
```

## 项目边界

- beads 是当前任务、执行进度和验收证据的唯一 tracker；新工作不再写入 Linear。
- Linear 工作区 `steven-liang` 的 P-STE-4 及既有票据只作历史参考。未完成的 STE-85、STE-86、STE-89、STE-90、STE-91、STE-93 不自动迁移，也不代表当前已确认的执行顺序；后续按新方向重新判断。
- GitHub Issues 只承担外部问题记录。确认执行后转入 beads 并保留来源链接，执行进度不写入 GitHub Issue。
- 新审查结论与验证结果写入对应 PR / beads；最终发布证据与限制写入发布说明。

## 不要做

- 不要给计划建 root epic。
- 不要把 checkpoint 当父节点（容器），它只有入边。
- 不要给修复执行票挂父，也不要让它当别的票的子票。
- 不要为了让图看起来完整就给每张票都连边。
- 不要为对齐规则重写历史图。
