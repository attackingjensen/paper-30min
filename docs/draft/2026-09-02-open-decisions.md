---
status: draft
updated: 2026-09-03
---

# 待决技术与产品事项

本文汇总截至 2026-09-03 已讨论但尚未接受的建议、假设和问题。它是后续讨论入口，不代表项目决定；当前进度以 [`docs/status/current.md`](../status/current.md) 为准，已接受决策以 [`docs/adr/`](../adr/) 为准。

## 技术栈

### 当前事实

- 前端使用原生 HTML、CSS 和 JavaScript，由浏览器直接运行。
- 本地服务器使用 Python 标准库，负责静态资源、arXiv 获取和模型请求转发。
- 项目没有前端构建步骤；主要耗时来自 PDF 解析、网络和模型生成，而非本地服务器计算。

### 已讨论倾向

- 当前需求与 JavaScript + Python 的低门槛运行方式匹配，不宜为了技术统一进行全面重写。
- TypeScript 能帮助约束论文记录、解析结果和异步任务状态，但不能替代正确的 module 设计。
- 可以先通过 JSDoc、`// @ts-check` 和 `checkJs` 获得类型检查，再根据实际收益决定是否迁移 `.ts`。
- Rust 目前不适合重写核心功能；若未来采用 Tauri，它可能只承担 Windows 外壳和桌面生命周期。

### 待拍板

- 是否在 deep module 稳定后引入 `checkJs`。
- 什么规模或维护痛点足以触发正式 TypeScript 迁移。
- 是否长期保留“无需前端构建”的运行约束。

## Windows 应用外壳

### 当前事实

- 当前形态是本地 Web App，通过启动脚本运行，可供电脑和同一局域网内的手机访问。
- 本地优先已经由 [ADR-0001](../adr/0001-local-first-reading.md) 接受，但它没有规定必须永久使用浏览器外壳。

### 决定记录

- 作者 2026-09-03 决定**缓议**：先稳定 deep module 与产品契约，待安装包、开始菜单入口或无终端启动出现真实痛点后，再评估 pywebview 原型。

### 已讨论倾向

- Windows 应用应作为现有 Web App 的桌面 adapter，而非重写阅读界面和核心逻辑。
- `pywebview + PyInstaller` 的原型成本最低，可以优先验证打包、WebView2、数据持久化和局域网访问。
- Tauri 更适合产品成熟后的轻量安装包；Electron 和 WinUI 全面重写目前缺少足够收益。
- 原型应验证 PDF worker、IndexedDB、模型流式输出、手机访问、进程退出和无 Python 环境运行。

### 待拍板（缓议期间冻结）

- 作者是否需要安装包、开始菜单入口和无终端启动。
- Windows 外壳是否必须继续向手机提供局域网访问。
- 桌面数据目录、端口占用、单实例和升级行为应如何定义。
- 是否先建立 pywebview 原型，以及什么结果才足以进入正式实现。

## 文件与 module 结构

### 当前事实

- 顶层结构与当前规模匹配，`public/`、`vendor/`、`skills/`、`tools/` 和 `docs/` 的职责基本清楚。
- [`public/js/app.js`](../../public/js/app.js) 同时承担 DOM、当前论文、生成任务、问答、导入和持久化协调。
- 统一测试入口已落地：`npm test` 串起 `node --test`（自动发现 `tests/*.test.mjs`）与 `tools/check_markdown.mjs`；`tools/check_parser.mjs` 承担人工查看的解析检查，不在门禁内。

### 已讨论倾向

- 不进行纯目录重排，也不引入多层 `src/domain/application` 结构。
- `tests/` 已建立，让 `tools/` 保留生成器、mock 和开发辅助工具。
- 只有在知识归属明确后，才从 `app.js` 提取有真实 depth 的 module；不按页面或函数数量机械拆分。
- `server.py` 当前规模可以保持单文件，待转发策略或桌面生命周期出现独立测试需求后再深化。

### 待拍板

- 测试文件命名与覆盖范围的约定。
- “论文记录生命周期”与“阅读生成任务”的最终职责划分。
- 技能文件加载的服务端入口与 `skills.js` 内置定义的去留（技能事实来源已拍板，见 Issue #5）。

## Deepening 候选

| 候选 | 当前建议强度 | 观察到的问题 | 尚未决定的方向 |
| --- | --- | --- | --- |
| 论文记录生命周期 | **设计已接受** | 论文结构、不变量、重切分和写入规则散落在多个调用方 | 无——[ADR-0004](../adr/0004-paper-lifecycle-module.md) 已接受设计，实施经 Issue #9 跟踪 |
| 阅读生成任务 | Strong | `current`、`aborter` 和 `generating` 共享，异步结果缺少稳定任务归属 | 是否让独立 deep module 拥有论文 identity、状态、取消和原始增量 |
| 上游转发 | Worth exploring | curl、urllib、请求策略和响应写入集中在 Handler，局域网信任假设已由 [ADR-0003](../adr/0003-lan-fully-trusted.md) 接受 | 是否深化 forwarding module |

技能目录候选已拍板（`skills/*.md` 为正式来源），转入 Issue #5，不再作为候选。「论文记录生命周期」的设计已于 2026-09-03 经 grilling 全部拍板（ADR-0004）：建立 `papers.js` deep module 统一拥有记录生命周期，阅读生成任务未来经 `saveAnalysis` 缝提交结果。

## 测试与质量基线

### 当前事实

- `npm test` 覆盖 SSE 流式边界、DashScope 地址改写、API 错误分支与 Markdown 渲染；解析行为由示例 PDF 和一个合成章节场景检查。
- `tools/check_parser.mjs` 曾因 `package.json` 的 `type: module` 改变 `require()` 对 UMD 的返回值而无法运行，已于 2026-09-03 修复。
- 阅读任务、IndexedDB、模型传输和服务器端点仍缺少系统性回归测试。

### 已讨论倾向

- 优先使用 Node.js 与 Python 标准库提供的测试能力，避免仅为测试引入大型工具链。
- 测试应通过公开 interface 验证行为，不为测试额外暴露内部实现。

### 待拍板

- 何时增加 CI，以及 CI 应覆盖哪些平台和浏览器行为。
- IndexedDB 与 DOM 交互使用真实浏览器测试，还是先通过小型 adapter 测试。

## 建议讨论顺序

作者 2026-09-03 决定先修缺陷、再做模块设计。据此调整后的顺序（仅建议，尚未成为项目计划）：

1. 缺陷修复优先：PDF 全文解析、DashScope 多段区域域名支持与 `check_parser` 修复已于 2026-09-03 完成；其余缺陷经 Issue #4–#8 跟踪，作者决定暂不修复。
2. 使用 grilling 明确“论文记录生命周期”的职责、不变量和 seam。
3. 安排 Issue #4–#8 的处理时机，其中 #5（技能来源）涉及服务端加载入口的设计。
4. 在 module 稳定后重新评估 TypeScript、测试工具和 CI；Windows 外壳在痛点出现后再议。

## 已移出（2026-09-03 拍板）

- 「论文记录生命周期」module 设计全部拍板：见 [ADR-0004](../adr/0004-paper-lifecycle-module.md)，实施计划经 Issue #9 跟踪；打卡活动语义已写入 `CONTEXT.md`。
- 产品契约歧义四项全部拍板：PDF 取消 30 页限制（已实现）；整库导出/导入记录为 Issue #4；`skills/*.md` 为正式技能来源（Issue #5）；局域网信任见 [ADR-0003](../adr/0003-lan-fully-trusted.md)。
- `package.json` 统一测试命令已落地（`npm test`）。
- DashScope 主机正则已放宽支持多段区域域名（含回归测试）。
