## Agent skills

### 问题跟踪

问题与规格说明统一记录在 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### 分类标签

使用五个默认分类标签。详见 `docs/agents/triage-labels.md`。

### 领域文档

本仓库采用单上下文文档结构。详见 `docs/agents/domain.md`。

### 项目文档

开始项目分析、规划或实现前，先读取 `docs/status/current.md`、`CONTEXT.md` 和相关 GitHub Wayfinder 地图/票据。完成会实质改变目标、能力、风险、进行中事项或下一步的工作后，同步覆盖更新 `docs/status/current.md`。文档分层及背景、草稿和原型的读取规则见 `docs/README.md`。

### Wayfinder 与规格

- 规划工作通过 GitHub Issues 推进；决策票的讨论和 resolution comment 是权威来源。操作规则见 `docs/agents/issue-tracker.md`。
- 已定稿、供实施会话读取的规格放在 `docs/specs/`，并回链来源 Issue；规格不脱离 Issue 形成独立需求版本。
- 涉及 Tauri、本地书库、Android 阅读伴侣、Rust/JavaScript 接口或前端重设计时，先读取 `docs/specs/client-and-frontend-boundaries.md`。

### 当前路线

- Windows 正式客户端采用 Tauri，保留浏览器阅读器；Android 首版是移动阅读伴侣。
- Windows 本地书库是论文内容权威来源；前端重设计可以改变布局和视觉表现，但保持业务行为与数据契约一致。
- 当前 Wayfinder 前沿为 Issue #23；客户端实现、云端服务和部署工作须在相应规格与票据明确后进行。
