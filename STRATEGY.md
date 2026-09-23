---
name: Paper30Min
last_updated: 2026-09-23
---

# Paper30Min Strategy

本文承接已有构想和已确认的产品决策，不重新立项或新增路线承诺。业务术语和实现取舍见 [CONCEPTS.md](CONCEPTS.md)；未有定论的指标与优先级明确保留为空缺。历史材料（构想、背景、ADR、验证记录）见 Git 历史 35324e7。

## Purpose

使用者希望养成每天阅读论文的习惯，并真正理解一篇论文的问题、方法创新、为什么有效，以及实验和消融支持了什么结论。困难在于不同章节需要不同的阅读关注点，完整理解还要把方法解释与实验依据联系起来，不能只停留在摘要或零散问答。

来源：原始构想（Git 历史 35324e7）、[复述级阅读定位 #35](https://github.com/attackingjensen/paper-30min/issues/35)。

## Positioning

Paper30Min 定位为专属论文精读 agent harness：以论文实际结构、分层阅读产物和可回查的原文证据组织阅读，让用户达到能讲清“问题 → 方法 → 证据 → 边界”的复述级理解。阅读地图提供参照，用户选择深挖方向；以信息架构承载阅读方法，控制上下文与 token 成本，不靠阶段向导要求用户照步骤操作。

来源：[#35 的已确认定位](https://github.com/attackingjensen/paper-30min/issues/35)与阅读协议决策（ADR 0006，Git 历史 35324e7）。

## Users

**Primary:** 以仓库持有者为代表、需要持续精读论文的个人使用者——借助产品理解感兴趣论文的方法创新、作用机制和实验依据，积累自己的阅读成果，并在需要时跨设备接续阅读。

项目源于实际自用需求；现有材料没有要求发展为面向公众的多用户平台。`steven123397` 独立承担全部开发和维护工作；仓库持有者 [attackingjensen](https://github.com/attackingjensen) 仅作为产品体验者，不参与开发或 PR。新增能力应依据实际使用反馈和已确认需求，不凭空创造产品需求。局域网访问是无云服务器时的替代实现，不是必须长期保留的产品能力。来源：当前分工约定、协作背景（Git 历史 35324e7）、[移动服务范围 #25](https://github.com/attackingjensen/paper-30min/issues/25)。

## Boundaries

- 围绕单篇论文精读展开；新增能力应服务于读懂论文，保持功能不冗杂，不泛化为通用 agent 工作台。依据：[#35](https://github.com/attackingjensen/paper-30min/issues/35)。
- Windows 本地书库是论文内容权威来源，核心阅读不以托管账户或云同步为前提；模型请求发送到用户配置的端点。依据：本地优先决策（ADR 0001，Git 历史 35324e7）。
- 用户手动决定已读完，不由生成结果推断；阅读进度、阅读位置和活动历史分别表达不同事实。依据：数据模型决策（ADR 0007，Git 历史 35324e7）。
- Android 首版是阅读伴侣，不复制 Windows 的导入、生成和完整书库管理；移动服务不接收模型 API Key、不提供模型代理或公开注册。该方向尚未实现。依据：[#25](https://github.com/attackingjensen/paper-30min/issues/25)、[#26](https://github.com/attackingjensen/paper-30min/issues/26)。

## Key metrics

历史材料未形成完整的产品指标体系。以下只承接已有目标、验收要求和可用证据，不新增数值门槛或宣称已有自动采集。

- **复述级理解**：目标是使用者能讲清论文的问题、方法、证据与边界；目前没有统一评分方法或采集机制。“30 分钟”是产品定位，不能当成已验证的完成时限。来源：[#35](https://github.com/attackingjensen/paper-30min/issues/35)。
- **阅读链路等待时间**：解析、建图、单节/批量深挖及综合的耗时；现有阶段遥测、同机夹具对照和验证报告提供证据。来源：[#74](https://github.com/attackingjensen/paper-30min/issues/74) 与对照记录（Git 历史 35324e7 的 `docs/draft/2026-09-19-issue85-walkthrough.md`）。
- **产物可核验性**：论断须带可回查出处，未经核验部分须明确标注；现有协议约束与契约测试提供检查依据，但尚无统一的准确率或覆盖率指标。来源：阅读协议决策（ADR 0006，Git 历史 35324e7）。
- **持续阅读**：原始目标是养成日常阅读习惯，活动日数据已提供阅读活动记录；未定义产品层面的目标频率或成功阈值。来源：原始构想与活动日决策（Git 历史 35324e7，构想 / ADR 0007）。

## Tracks

以下归纳已有产品方向，不表示新增任务、启动移动端或决定下一轮资源分配；当前材料没有给出新的优先级排序。

### 复述级精读与证据质量

让论文的结构、图表和原文证据能支撑分层理解、定向深挖及全文复述。

_Why it serves the approach:_ 直接服务“理解方法为何有效、实验说明了什么”，让产物可核验；方向依据 [#35](https://github.com/attackingjensen/paper-30min/issues/35)。

### 个人阅读的可用性与连续性

让本地阅读、产物积累和任务反馈可用，控制解析与生成等待，保持进度和阅读状态可信。

_Why it serves the approach:_ 降低持续读论文时的使用负担，支撑日常阅读习惯；依据原始构想（Git 历史 35324e7）、[#74](https://github.com/attackingjensen/paper-30min/issues/74) 与进度决策（ADR 0007，Git 历史 35324e7）。

### 跨设备接续阅读（已定方向，尚未启动）

让用户在电脑导入和整理论文后，在手机继续阅读主动选择的内容。

_Why it serves the approach:_ 延续同一篇论文的阅读，而非建设第二个完整生成客户端；依据协作背景（Git 历史 35324e7）、[#25](https://github.com/attackingjensen/paper-30min/issues/25)、[#26](https://github.com/attackingjensen/paper-30min/issues/26)。
