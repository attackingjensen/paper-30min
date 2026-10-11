# 三层阅读协议与工具化取证

旧协议「每类章节一个提示词、单次注入章节原文」的产物无地图、无分层、无出处，长论文上下文成本高且不可核验。项目决定把阅读协议改为三阶段，迭代而非推翻 ADR-0002：**建图**由用户显式触发，两调用自底向上，先全部节薄摘要、再合成阅读地图；**深挖**按需发起，配方打底后模型用只读工具 `read_section` / `search_paper` / `get_figure` / `get_page_image` 越节取证，Rust 驱动循环、无工具调用即完成、步数有上限；**综合**手动触发复述稿，未深挖节明确标注。产物纪律为 EXTRACTED：每条论断带出处指针，无出处不写。技能库随之改为协议各阶段提示词加按章节类型叠加的关注点数据。

工具调用的传输形态采用文本协议：模型输出约定格式的调用块，Rust 解析执行并把结果续入上下文，不依赖模型底座的原生 function-calling——文本协议零能力假设，解析失败可喂回模型自我纠正。两条取舍被明确否决：地图不提供「建议深挖节」判断，深挖选择是用户的；不设阶段条或向导式流程 UI，阅读方法由信息架构本身承载。

代价是接受多次模型调用的编排复杂度与提示词工程成本，换来 token 预算可控（跨节上下文来自地图与薄摘要）与产物可核验。

来源：[#35](https://github.com/attackingjensen/paper-30min/issues/35)、[#41](https://github.com/attackingjensen/paper-30min/issues/41)、[#46](https://github.com/attackingjensen/paper-30min/issues/46)、[#48](https://github.com/attackingjensen/paper-30min/issues/48)、[#55](https://github.com/attackingjensen/paper-30min/issues/55)；转写自 Git 历史 35324e7 的 ADR-0006，编号重排为 0003。
