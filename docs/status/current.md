# 项目当前状态

> 更新时间：2026-09-04

## 当前目标

在作者已拍板的方向上先修缺陷、再做模块设计，不主动扩展作者需求。`steven123397/dev` 是协作开发分支；`main` 由项目作者主导维护，协作方拥有同等推送权限。

## 已实现能力

- 从 arXiv HTML、本地 PDF 和粘贴文本获取论文内容。
- 识别摘要与实际一级章节，并按原始顺序形成精读部分。
- 按章节类型选择技能，生成单节或整篇精读结果。运行时技能以 `skills/*.md` 为正式来源：`server.py` 的 `/api/skills` 提供文件清单，前端启动时拉取解析（`parseSkillFile`，id 取 frontmatter 的 section）；接口失败时回退 `skills.js` 内置副本并提示，测试强制兜底副本与文件逐字一致；补齐了 `part` 通用章节技能文件；`parseSkillFile` 现将 CRLF 归一化为 LF（连带修复「导入 .md」混入 `\r` 的问题）。
- 基于论文内容进行连续问答。
- 在本地书库中保存论文、精读结果、论文问答和阅读进度。
- 支持 Markdown、LaTeX 公式、连续阅读统计和单篇笔记导出。
- 整库导出/导入：单个 JSON 信封文件（`paper-30min-library` v1，papers.js 拥有格式），含全部论文与 PDF、自定义技能、设置；按 id 合并不覆盖已有记录；导出时清空 apiKey、导入时不用空值覆盖本地密钥。
- PDF 对照阅读、按章节或全文的独立翻译、论文整理与回想卡片。
- 阿里云百炼（DashScope）地址自动改写为 `/compatible-mode/v1`，支持裸域名与 `dashscope-intl`、`dashscope-vpc`、`dashscope-cn-beijing` 等多段区域域名。
- PDF 解析覆盖完整论文（2026-09-03 取消前 30 页限制），与界面“全文”表述一致。
- 提供示例论文、mock 模型（`--unterminated-tail` 可复现末尾无换行的 SSE 场景，`--port 0` 由系统分配端口）和解析器检查脚本。

## 工程基线

- 运行栈为原生 JavaScript 前端与 Python 标准库本地服务器，无前端构建步骤。
- `npm test` 是统一测试入口，串起 `node --test`（自动发现 `tests/*.test.mjs`，当前 58 个测试）与 `tools/check_markdown.mjs`。`tools/check_parser.mjs` 没有断言、只输出 JSON 供人工查看，因此不在门禁内。`tests/skills.test.mjs` 含「内置兜底技能与 skills/*.md 逐字一致」的同步守卫——修改技能文件必须同步 `skills.js` 兜底副本，否则门禁失败。`tests/mock_llm.test.mjs` 会真实启动 `tools/mock_llm.py` 验证 SSE 字节流形态，无 python 环境时自动跳过。
- 示例 PDF 解析检查和 Python 语法编译检查通过；PDF.js 会报告标准字体资源警告。`check_parser.mjs` 曾因 `package.json` 的 `type: module` 使 `require()` 返回空模块命名空间而无法加载 UMD，2026-09-03 修复：改为依赖 UMD 自行注册 `globalThis.pdfjsLib` / `globalThis.pdfjsWorker`（Node 下 fake worker 依赖后者）。
- 自动化验证覆盖解析器、SSE 流式传输、Markdown 表格渲染与公式边界、DashScope 地址改写（含多段区域域名与伪装域名负例）和 API 错误分支的关键边界；阅读任务、持久化、模型传输的其余行为和 Markdown 渲染仍缺少系统性回归测试。
- 已配合 `tools/mock_llm.py` 在浏览器中做过一次端到端验证：页面加载零控制台错误，示例论文解析出 6 个章节，PDF 取回 200；直接调用 `chat()` 得到 15 次增量 `onDelta`、长度按 18 字符单调累积、253 字符全文结尾与 mock 源码逐字一致；UI 精读流程落库 392 字符摘要，结尾同样逐字一致。合并双方的改动（表格 `<thead>` 与 `isLikelyMath`）在浏览器中确认互不干扰。
- 该次验证的边界需明确记录：交互由 `element.click()` 派发而非真实指针事件（内置浏览器视口处于 hidden），focus、hover 与键盘路径未覆盖；未做任何视觉确认，MathJax 实际排版、PDF 页面绘制与 CSS 布局均未验证；回忆卡与翻译两个标签页仅确认存在、未实际操作。
- 已建立 GitHub Issues、triage 标签、领域词汇表与 ADR 结构；局域网信任假设由 ADR-0003 接受。

## 进行中事项

- 2026-09-03 与作者集中拍板：方向为先修缺陷、再做模块设计；PDF 解析取消页数限制；DashScope 正则放宽支持多段区域域名；局域网视为完全可信；Windows 外壳缓议；整库迁移与技能来源等转入 Issue。
- 同日与作者完成「论文记录生命周期」grilling 设计并全部拍板：`papers.js` deep module 统一拥有记录生命周期，设计由 [ADR-0004](../adr/0004-paper-lifecycle-module.md) 接受。Issue #9 四步已全部完成并关闭：骨架与创建点切换、全部写入点迁移为带规则函数、重切分作废孤儿结果（唯一行为变更）、打卡派生收编；`db.js` 已吸收删除，43 个测试全绿；尚未做浏览器端交互验证。
- PR #3 已以 merge commit（`107d1b2`）合入 `main`，未采用 squash 或 rebase；`npm test` 全绿（17 个测试与 Markdown 检查全部通过）。
- 新增 Issue #4（整库导出/导入，暂缓）、#6（GBK 控制台崩溃）、#7（mock 末尾未终止 SSE）、#8（书库视图渲染异常待复现），均带 `ready-for-agent` 标签；Issue #5 已于 2026-09-04 完成：设计三要点（内置定义保留作降级兜底、接口返回文件原文清单、id = frontmatter section）与作者确认后实现，`npm test` 50 个测试全绿，服务端冒烟（curl `/api/skills` + Node 模拟前端加载链路）通过，浏览器端交互验证待作者走查。
- Issues #10、#11 已修复：中断保存的部分精读结果改用原始流式 Markdown 落库（不再取渲染后的 `textContent`，避免格式永久丢失）；`buildPrompt` 与 `buildChatContext` 改为函数形式替换，论文标题与原文按字面注入提示词，不受 `$&`、`$'` 等替换模式腐蚀。`tests/skills.test.mjs` 覆盖字面注入；中断保存路径在 `app.js` 内、暂无 Node 侧回归，两处修复均待浏览器端验证。
- Issue #8 已关闭（2026-09-04，commit `18841ba`）：两个原始现象静态+浏览器实测双重确认不可复现、当前代码不可达（现象 1 文案自 9764c6b 才存在于 dev 线，非 main 既有缺陷；原始观测推测为缓存旧 app.js 或误触 `#brand-home`）。实测找到并修复同缝 4 个缺陷：`closePaper` 统一中断精读/问答生成并等收尾后再刷新书库；`generateSection`/`sendChat` 捕获论文引用防 `current` 置 null 崩坏；`generateAll` 守卫 + try/finally 修复按钮永久卡死；问答中断不再落库错误消息。Chrome CDP 复测（单节/批量中断返回、立即重进、完整批量回归）console 零异常，`npm test` 50 个测试全绿。
- Issue #6 已修复并关闭（2026-09-04）：GBK 控制台直接运行 `python server.py` 时横幅 emoji 抛 `UnicodeEncodeError` 致进程退出；修复为 `main()` 启动时对 stdout/stderr 做 `reconfigure(errors='replace')`（保持原编码，emoji 降级为 `?`；带 `hasattr` 守卫覆盖 pythonw 等无流/嵌入式场景）。GBK 模拟（`PYTHONIOENCODING=gbk`）、UTF-8 终端 emoji 原样保留、stdout=None 场景均实测通过，HTTP 服务正常；`npm test` 50 个测试全绿。
- Issue #7 已修复（2026-09-04）：`tools/mock_llm.py` 新增 `--unterminated-tail`——末尾内容事件不带 `\n\n`、不发 `data: [DONE]`，直接关连接，精确复现「最后一个 data 行没有换行符」场景（与 `tests/api.test.mjs` 单测形态一致）；同时新增 `--port`（0 = 系统分配）并给启动横幅加 `flush=True`（修复 stdout 被管道捕获时缓冲不可见，否则自动化测试拿不到端口）。新增 `tests/mock_llm.test.mjs` 真实启动 mock 两条模式：断言原始字节流尾部形态，并用前端 `chat()` 走完残留 buf 收尾解析、确认收全文本；curl 冒烟字节级确认尾部无换行无 `[DONE]`。`npm test` 52 个测试全绿；浏览器端走查待作者。
- Issue #4 已完成（2026-09-04）：整库导出/导入落地。作者拍板五项设计：JSON 信封（格式标识 + 版本号）、导出包含全部 PDF（base64）、设置导出但清空 apiKey、导入按 id 合并（同 id 跳过并报告）、自定义技能同 id 以导入为准。实现：`papers.js` 拥有信封格式与论文序列化（`exportLibrary`/`parseLibraryFile`/`importLibrary`，Blob↔base64 走 arrayBuffer 路径、Node 可测）；`skills.js` 增 `importCustomSkills`；`api.js` 增 `mergeImportedSettings`（空 apiKey 不覆盖本地密钥）；书库工具栏增「导出书库 / 导入书库」。新增 6 个回归测试（导出信封、PDF 往返、id 合并、格式校验、设置合并、技能合并），`npm test` 58 个测试全绿；浏览器端走查待作者。至此 Issue #4–#11 全部关闭。
- “论文记录生命周期”设计已接受（ADR-0004），是当前首选实施项；[待决技术与产品事项](../draft/2026-09-02-open-decisions.md) 汇总剩余未拍板内容。

## 待确认问题

- 无。原待作者确认的问题已于 2026-09-03 全部拍板：可执行工作进入 GitHub Issue（#4–#8），长期决定进入 ADR-0003，其余决定见待决事项草稿的“已移出”一节。

## 下一步

作者安排（2026-09-03）：以下各项由作者逐个开启独立对话推进，会话内不要自行启动下一项；本批改动合入 `main` 的 PR 暂缓。

1. 浏览器端走查 `papers.js` 迁移与 Issue #10 修复：示例论文导入、精读生成（含中断后部分结果的 Markdown 保留）、重切分作废提示与打卡显示；一并走查 Issue #5：技能列表从文件加载、编辑/导入/恢复默认、改 `skills/*.md` 后刷新生效；Issue #8 修复（`18841ba`）已经 Chrome CDP 实测验证，可并入本次走查。
2. 设计「阅读生成任务」module（Issue #12：先 grilling 定设计——任务 identity、状态、取消、增量归属；经 `saveAnalysis` 缝与 `papers.js` 衔接；`app.js` 现有 `current/aborter/inflightStream/generating` 生成态是收编对象）。
3. 浏览器端走查整库导出/导入（可与第 1 项一并进行：导出 → 换浏览器或清除站点数据后导入 → 核对论文、PDF、自定义技能、设置齐备且已有记录不被覆盖；#7 的端到端验证同理：`python tools/mock_llm.py --unterminated-tail` 启动后跑一次精读，确认未终止末尾事件下结果完整落库）。
