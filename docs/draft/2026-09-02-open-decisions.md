---
status: draft
updated: 2026-09-04
---

# 待决技术与产品事项

本文汇总截至 2026-09-04 已讨论但尚未接受的建议、假设和触发条件。它是后续讨论入口，不代表项目决定；当前进度以 [`docs/status/current.md`](../status/current.md) 为准，已接受决策以 [`docs/adr/`](../adr/) 为准。

## 已确定的近期顺序

以下事项已进入 GitHub Issues，由作者分别安排新对话执行：

1. [Issue #13](https://github.com/attackingjensen/paper-30min/issues/13)：完成现有功能的浏览器与真实模型验证。
2. [Issue #14](https://github.com/attackingjensen/paper-30min/issues/14)：建立 Windows 主导的最小 CI。
3. [Issue #15](https://github.com/attackingjensen/paper-30min/issues/15)：在 `papers.js` 与 `generation.js` 试点 `checkJs`，以前一项完成并稳定运行为前置条件。

这三项只巩固已实现能力与工程基线，不增加产品功能。发现的新缺陷应另建 Issue，不在验证或工程化任务中顺手扩展范围。

## 技术栈

### 当前事实

- 前端使用浏览器直接运行的原生 HTML、CSS 和 JavaScript，本地服务器使用 Python 标准库。
- 主要耗时来自 PDF 解析、网络和模型生成，而非本地服务器计算。
- `papers.js` 与 `generation.js` 已分别统一论文记录生命周期和阅读生成任务，见 ADR-0004、ADR-0005。
- 当前没有前端构建步骤。

### 已安排的试点

- Issue #15 仅使用 JSDoc、TypeScript `checkJs` 与 `noEmit` 检查两个已稳定的 deep module。
- 试点不迁移 `.ts`，不增加浏览器运行时构建步骤，也不自动导向全面 TypeScript 迁移。
- 是否扩大范围由真实问题数量、注解成本和遗留盲区决定。

### 仍待拍板

- 什么规模、维护痛点或试点结果足以触发正式 TypeScript 迁移。
- 是否长期保留“无需前端构建”的运行约束。
- Rust 仍无核心重写理由；只有未来选择 Tauri 时，才重新讨论其桌面生命周期职责。

## CI 与测试边界

### 当前事实

- `npm test` 是统一门禁，当前 79 个测试全部通过。
- 自动化测试已覆盖论文生命周期、书库迁移、技能加载、阅读生成任务、SSE、模型地址与错误处理，以及 Markdown 关键边界。
- `tools/check_parser.mjs` 没有断言，用于人工检查解析结果，不属于自动门禁。
- Python 服务器及上游转发路径尚无系统性自动化测试；浏览器验证缺口由 Issue #13 跟踪。

### 已安排的范围

- Issue #14 在 `windows-latest` 与 `ubuntu-latest` 执行 `npm test`、Python 编译检查和仓库自有 JavaScript 语法检查。
- CI 暂不设置覆盖率阈值，不引入浏览器端到端框架，不调用真实模型，也不运行人工解析检查。

### 仍待拍板

- 何时引入真实浏览器自动化，以及 IndexedDB 与 DOM 交互应通过真实浏览器还是小型 adapter 验证。
- 服务器行为测试采用进程级 HTTP 测试，还是先提取可注入的传输边界。
- 是否需要覆盖率度量；在现有行为边界尚未稳定前，不设置数字阈值。

## 上游转发 module

### 当前事实

- `server.py` 约 220 行，`Handler` 同时包含输入校验、curl/urllib 传输选择、上游错误处理和响应写入。
- 当前只有浏览器前端这一主要调用场景。
- 局域网完全可信已由 ADR-0003 接受，不需要借模块深化重新讨论鉴权需求。

### 当前倾向

- 暂不直接提取 forwarding module。单一调用方下，额外接口的收益尚不足以证明拆分成本。
- 优先补充服务器端行为测试，覆盖非法输入、curl/urllib 两条路径、上游 HTTP 错误、流式响应尾段、超时及客户端断开。
- 若测试显示传输策略难以隔离，可先建立最小可注入边界，而非按函数数量拆文件。

### 重新评估条件

- curl 与 urllib 的请求或响应策略继续分化，重复规则明显增加。
- 出现第二种调用场景。
- Windows 外壳引入进程生命周期、端口或关闭协议等新职责。
- 服务器测试无法通过现有 `Handler` 公共行为稳定表达。

## Windows 应用外壳

### 当前事实

- 当前形态是本地 Web App，通过启动脚本运行，并可供同一局域网内的手机访问。
- 本地优先已由 ADR-0001 接受，但没有规定必须永久使用浏览器外壳。

### 决定记录

- 作者于 2026-09-03 决定缓议：先稳定 deep module 与产品契约，待安装包、开始菜单入口或无终端启动出现真实痛点后，再评估 pywebview 原型。

### 已讨论倾向

- Windows 应用应作为现有 Web App 的桌面 adapter，而非重写阅读界面和核心逻辑。
- `pywebview + PyInstaller` 的原型成本最低，可以优先验证打包、WebView2、数据持久化和局域网访问。
- Tauri 更适合产品成熟后的轻量安装包；Electron 和 WinUI 全面重写目前缺少足够收益。

### 重新评估条件

- 作者明确需要安装包、开始菜单入口或无终端启动。
- 需要定义桌面数据目录、端口占用、单实例和升级行为。
- 能够明确外壳是否必须继续向手机提供局域网访问。

## 已完成并移出待决范围

- `papers.js` 统一论文记录生命周期，见 ADR-0004 与 Issue #9。
- `generation.js` 统一阅读生成任务及批量编排，见 ADR-0005 与 Issue #12。
- `skills/*.md` 已成为技能正式来源，内置定义保留为同步兜底，见 Issue #5。
- 整库导出与导入已实现，见 Issue #4。
- PDF 全文解析、DashScope 地址适配、GBK 启动、SSE 尾段及 Markdown 表头等缺陷已经修复。
