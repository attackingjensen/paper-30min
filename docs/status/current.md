# 项目当前状态

> 更新时间：2026-09-03

## 当前目标

在作者已拍板的方向上先修缺陷、再做模块设计，不主动扩展作者需求。`steven123397/dev` 是协作开发分支；`main` 由项目作者主导维护，协作方拥有同等推送权限。

## 已实现能力

- 从 arXiv HTML、本地 PDF 和粘贴文本获取论文内容。
- 识别摘要与实际一级章节，并按原始顺序形成精读部分。
- 按章节类型选择技能，生成单节或整篇精读结果。
- 基于论文内容进行连续问答。
- 在本地书库中保存论文、精读结果、论文问答和阅读进度。
- 支持 Markdown、LaTeX 公式、连续阅读统计和单篇笔记导出。
- PDF 对照阅读、按章节或全文的独立翻译、论文整理与回想卡片。
- 阿里云百炼（DashScope）地址自动改写为 `/compatible-mode/v1`，支持裸域名与 `dashscope-intl`、`dashscope-vpc`、`dashscope-cn-beijing` 等多段区域域名。
- PDF 解析覆盖完整论文（2026-09-03 取消前 30 页限制），与界面“全文”表述一致。
- 提供示例论文、mock 模型和解析器检查脚本。

## 工程基线

- 运行栈为原生 JavaScript 前端与 Python 标准库本地服务器，无前端构建步骤。
- `npm test` 是统一测试入口，串起 `node --test`（自动发现 `tests/*.test.mjs`，当前 45 个测试）与 `tools/check_markdown.mjs`。`tools/check_parser.mjs` 没有断言、只输出 JSON 供人工查看，因此不在门禁内。
- 示例 PDF 解析检查和 Python 语法编译检查通过；PDF.js 会报告标准字体资源警告。`check_parser.mjs` 曾因 `package.json` 的 `type: module` 使 `require()` 返回空模块命名空间而无法加载 UMD，2026-09-03 修复：改为依赖 UMD 自行注册 `globalThis.pdfjsLib` / `globalThis.pdfjsWorker`（Node 下 fake worker 依赖后者）。
- 自动化验证覆盖解析器、SSE 流式传输、Markdown 表格渲染与公式边界、DashScope 地址改写（含多段区域域名与伪装域名负例）和 API 错误分支的关键边界；阅读任务、持久化、模型传输的其余行为和 Markdown 渲染仍缺少系统性回归测试。
- 已配合 `tools/mock_llm.py` 在浏览器中做过一次端到端验证：页面加载零控制台错误，示例论文解析出 6 个章节，PDF 取回 200；直接调用 `chat()` 得到 15 次增量 `onDelta`、长度按 18 字符单调累积、253 字符全文结尾与 mock 源码逐字一致；UI 精读流程落库 392 字符摘要，结尾同样逐字一致。合并双方的改动（表格 `<thead>` 与 `isLikelyMath`）在浏览器中确认互不干扰。
- 该次验证的边界需明确记录：交互由 `element.click()` 派发而非真实指针事件（内置浏览器视口处于 hidden），focus、hover 与键盘路径未覆盖；未做任何视觉确认，MathJax 实际排版、PDF 页面绘制与 CSS 布局均未验证；回忆卡与翻译两个标签页仅确认存在、未实际操作。
- 已建立 GitHub Issues、triage 标签、领域词汇表与 ADR 结构；局域网信任假设由 ADR-0003 接受。

## 进行中事项

- 2026-09-03 与作者集中拍板：方向为先修缺陷、再做模块设计；PDF 解析取消页数限制；DashScope 正则放宽支持多段区域域名；局域网视为完全可信；Windows 外壳缓议；整库迁移与技能来源等转入 Issue。
- 同日与作者完成「论文记录生命周期」grilling 设计并全部拍板：`papers.js` deep module 统一拥有记录生命周期，设计由 [ADR-0004](../adr/0004-paper-lifecycle-module.md) 接受。Issue #9 四步已全部完成并关闭：骨架与创建点切换、全部写入点迁移为带规则函数、重切分作废孤儿结果（唯一行为变更）、打卡派生收编；`db.js` 已吸收删除，43 个测试全绿；尚未做浏览器端交互验证。
- PR #3 已以 merge commit（`107d1b2`）合入 `main`，未采用 squash 或 rebase；`npm test` 全绿（17 个测试与 Markdown 检查全部通过）。
- 新增 Issue #4（整库导出/导入，暂缓）、#5（`skills/*.md` 为运行时技能正式来源）、#6（GBK 控制台崩溃）、#7（mock 末尾未终止 SSE）、#8（书库视图渲染异常待复现），均带 `ready-for-agent` 标签。
- Issues #10、#11 已修复：中断保存的部分精读结果改用原始流式 Markdown 落库（不再取渲染后的 `textContent`，避免格式永久丢失）；`buildPrompt` 与 `buildChatContext` 改为函数形式替换，论文标题与原文按字面注入提示词，不受 `$&`、`$'` 等替换模式腐蚀。`tests/skills.test.mjs` 覆盖字面注入；中断保存路径在 `app.js` 内、暂无 Node 侧回归，两处修复均待浏览器端验证。
- “论文记录生命周期”设计已接受（ADR-0004），是当前首选实施项；[待决技术与产品事项](../draft/2026-09-02-open-decisions.md) 汇总剩余未拍板内容。

## 待确认问题

- 无。原待作者确认的问题已于 2026-09-03 全部拍板：可执行工作进入 GitHub Issue（#4–#8），长期决定进入 ADR-0003，其余决定见待决事项草稿的“已移出”一节。

## 下一步

1. 浏览器端走查 `papers.js` 迁移与 Issue #10 修复：示例论文导入、精读生成（含中断后部分结果的 Markdown 保留）、重切分作废提示与打卡显示。
2. 设计「阅读生成任务」module（下一个 Strong 候选，经 `saveAnalysis` 缝与 `papers.js` 衔接）。
3. 安排 Issue #4–#8 的处理时机；其中 #5 涉及服务端技能加载入口与 `skills.js` 内置定义去留，需要先讨论设计再实现。
