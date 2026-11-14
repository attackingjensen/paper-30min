# Capability Map：文本中心阅读核

> 日期：2026-11-14  
> 状态：已批准  
> 产品方向：[文本中心的论文阅读与 Agent 工作台](../ideation/text-centered-reading.md)

## 范围假设

1. 保留当前 Electron/React/TypeScript、普通文件工程和 Pi Agent 基座。
2. 本次覆盖新阅读核、双栏工作区及旧 v2 工程数据处理，不覆盖安装包、更新器、移动端和云同步。
3. 旧 v1 源码删除属于规格完成后的交付操作，不单列能力模块。
4. `legacy-projects` 只保证明确处理旧工程，不预设一定全量迁移；迁移、只读或拒绝打开在对应 spec 中决定。
5. 五级折叠、自动论证关系、阅读地图和独立问答卡均不在当前范围内。
6. 先完成并批准各模块 spec，再进入分支整合与实现，不在每个模块 spec 后立即写代码。

## 模块与依赖

| Module id | Responsibility | Depends on |
|---|---|---|
| `project-core` | 新工程清单与目录契约、论文与文档身份、普通文件树、来源快照和 revision 的持久化；工程不再强制包含 PDF，不再登记阅读地图 | — |
| `document-core` | 规范文档树、章节／段落／句子／公式等结构、稳定文本锚点、当前正文版本、候选更新、三方对比与冲突、锚点延续或失效 | `project-core` |
| `arxiv-import` | arXiv URL／ID 与固定版本导入、LaTeXML HTML 快照、元数据、图片本地化、公式与交叉引用、离线重开、失败诊断及明确 PDF 回退 | `document-core` |
| `pdf-import` | PDF 云端解析到同一文档树、来源与机器诊断、可选原页、候选重解析、用户／Agent 核验范围及修改后未复核状态 | `document-core` |
| `reader` | Full 结构化原文渲染、图片／公式／表格／交叉引用、阅读位置、语言视图与正文侧栏的宿主；不实现五级层级 | `document-core` |
| `translation` | 中英全文翻译、渐进生成、逐段可用、原子保留、缺口补译、缓存、语言切换及正文更新后的 stale 判断 | `document-core`, `reader` |
| `annotations-results` | 文本高亮与批注、文本锚点链接、Markdown 笔记／精解／记忆卡片的正文侧栏跳转卡片；不含独立问答卡和自动论证关系 | `document-core`, `reader` |
| `workspace` | 任意中栏页面两栏、独立页签组、当前窗格、侧边打开、标签拖拽、草稿与布局恢复、成果卡片打开偏好 | `reader`, `annotations-results` |
| `agent-integration` | 保留 Pi 会话与右侧交互，接入当前正文和选区、显式原文修正、Markdown 成果生成、精确任务来源补查；移除完整审阅门禁和旧 PDF 引用工具 | `document-core`, `pdf-import`, `annotations-results` |
| `pdf-comparison` | 可选 PDF 原页、可重建的 unit→页／区域映射、结构化正文与 PDF 双向点击同步；不恢复正式 PDF 引用字典 | `arxiv-import`, `pdf-import`, `workspace` |
| `legacy-projects` | 盘点并确定旧 v2 工程的迁移、只读或明确拒绝策略，处理旧成果、会话和引用，不允许静默误读或错误重挂 | `document-core`, `annotations-results`, `agent-integration` |

## Build order

```text
project-core
  → document-core
  → arxiv-import / pdf-import / reader
  → translation / annotations-results
  → workspace / agent-integration
  → pdf-comparison
  → legacy-projects
```

斜杠表示依赖已满足后可以并行定义，不要求做成同一个 PR。

## 边界说明

- `project-core` 与 `document-core` 分开：前者回答“工程怎样保存和识别内容”，后者回答“结构化原文及其版本、锚点怎样工作”。
- `annotations-results` 与 `agent-integration` 分开：Markdown 锚点链接和侧栏卡片不依赖模型也能测试；Agent 只是这些成果的生产者之一。
- `workspace` 与 `pdf-comparison` 分开：通用双栏不需要 PDF 映射；PDF 同步只是兼容页面组合上的增强。
- `legacy-projects` 放在最后，避免旧格式反向绑架新文档模型，同时不遗漏旧用户数据。

## 交付顺序

能力地图批准后，按依赖顺序逐份编写并确认 `docs/spec/SPEC-<module-id>.md`。全部模块规格完成并批准后，再删除旧 v1 源码、收尾并合并当前 `codex/v2.0.0` 分支，随后从最新 `main` 创建短分支实施。
