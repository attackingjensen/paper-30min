---
status: accepted
---

# 阅读生成任务由 generation.js 统一拥有

精读生成的任务身份此前是隐式的：由「共享 `aborter` 当前指向 + `inflightStream` promise + 闭包捕获的论文引用 + sectionId 参数」拼成；精读与问答共用一个 `aborter`，并发触发时后启动者覆盖先启动者的控制器，先启动的任务成为仍在运行、仍会落库、但停止按钮够不着的孤儿（Issue #8 的「捕获论文引用」只是防御性补丁，不构成所有权）；流式增量经闭包直接写入 DOM 节点，生成逻辑与渲染纠缠，Node 侧无法回归（Issue #10、#11 的中断保存路径即因此无测试覆盖）。项目决定建立 `public/js/generation.js` deep module，统一拥有阅读生成任务的生命周期；第一批只收编精读生成（单节与批量），问答改用独立 `aborter` 消除共享缺陷，翻译与回忆卡保持现状，抽象按通用设计（任务 = 种类 + 归属键 + 提交回调），日后收编其余生成时不必返工。

任务拥有显式身份：唯一 id 加结构化归属键（种类 + 论文 + 精读部分），registry 为模块内部 Map，对外只暴露语义化操作——`startSection(paper, sectionId, sinks)`、`startBatch(paper, hooks)`、`cancelForPaper(paper)`。任务对象创建时持有论文引用，完成与中断落库一律经任务自己的引用提交，永不读全局 `current`。任务状态机为 `running → completed | failed | cancelling → cancelled`；任务的 `done` promise 只 resolve 不 reject，完成、失败与取消都是正常业务终态，以结果对象 `{ status, text?, saved? }` 区分；取消幂等。同一论文同时至多一个精读任务（含批量进行中的当前节），重复启动被拒绝并由界面提示；模块不限死跨论文互斥，当前界面下跨论文并发本就不可达（离开即中断）。批量生成是模块拥有的编排：串行顺序、单节失败续跑、无原文节跳过、取消后不再推进，界面推进（切换当前精读部分卡片）经注入的 `onSectionStart` / `onSectionSettled` 钩子完成。

原始增量流归任务所有：`api.chat` 的累积全文先进任务自有缓冲，再转发给调用方创建任务时注入的单个渲染 sink（`onUpdate(fullText)`，界面仍 `renderMarkdownInto`）；中断后部分结果从任务缓冲截取，调用方不再另备 `streamed` 副本。中断部分结果规则由模块拥有：缓冲 trim 后超过 60 字符时拼警示标记「⚠️ 生成被中断，内容为部分结果。」经 `papers.saveAnalysis` 提交（ADR-0004 的缝），否则丢弃；阈值与标记逐字保持现状。组提示词组装（技能选择、`buildPrompt`、`maxChars` 截断）与无原文前置校验一并收编；模型调用与设置读取经 `generation.init({ chat, loadSettings })` 注入，Node 测试以可控假实现驱动，界面只保留 DOM 渲染与事件。

两条真实备选被否决：批量循环留在 `app.js` 逐节调模块（界面推进更直接，但串行、守卫、失败续跑与停止语义仍不可 Node 回归，恰是验收要求的重心）；中断部分结果的阈值与标记作为任务配置由调用方注入（更灵活，但这条产品行为将继续游离在模块与回归测试之外）。问答与翻译、回忆卡本次不纳入：它们的中断语义与精读不一致（不落库部分结果），统一三态是独立产品决定，不应被模块重构裹挟。
