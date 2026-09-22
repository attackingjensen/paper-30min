# Issue #90 / #91 走查：进度域与任务收尾（2026-09-22）

两票的验证面不同：**#90 走真实窗口**（纯读数，零数据写入）；**#91 走确定性单元用例**——它的竞态窗口只有毫秒级，真实窗口既难复现也难否定（理由见下）。

## #90：无 abstract 论文的进度域与节树同域

环境：`npm run tauri dev`（debug，前端加载的就是工作区文件），真实数据根 `%APPDATA%/com.paper30min.reader`，全程只读（未打任何「已读完」标记）。

样本 = 1610.00633（书库卡片题名 Deep Reinforcement Learning for Robotic Manipulation with Asynchronous Off-Policy Updates），已在 #87 走查中重建过地图：对齐后 parts = part-1..8，块模型无 abstract 节。

| 读数 | 值 | 位置 |
| --- | --- | --- |
| 书库卡片 chip | 已建图 · 已读完 0/8 | 书库视图 |
| 阅读页进度 chip | 0/8 已读完 | `#map-progress-chip` |
| 节树可标记节点 | 8（I / II / III / IV / Algorithm 1 / V / VI / VII） | 左侧节树 |
| 节树灰项 | 2（REFERENCES / ACKNOWLEDGEMENTS，按设计不参与进度） | 同上 |

分母 8 = 节树可标记节点数 8 ✅。修复前该读数是 0/9（`readingParts` 恒补 abstract 占位）。

**常规论文不回归**（同库同次读数）：XGBoost 已对齐且有 abstract 节，仍为 0/12（占位照旧计入）；浏览器迁移的纯文本论文仍显示「未建图」，无表外读数。

**未做**：「全部标记 → 达到已读完」这一段只由单元测试锚定（`isPaperRead`），没有在真实书库打标记——#51 的打卡口径是「撤销不回收」，为验收在作者真实库留下永久活动日不划算。

## #91：瞬时失败后的任务收尾

- 楔子定位在 `trackTask` 的收尾时序：任务在订阅建立前即终态（Tauri 事件不重放）**且** `tasks.get@1` 快照恰在终态写入之前取到 → 两次都落空，任务永不收尾；`sessionTasks` 条目停在「无终态」，`hasOpenProtocolTask` 因此恒判为开放 → 节页「深挖进行中」与「全部深挖」按钮永久禁用（导航重渲染也无效，因为它读的就是这个判定）。
- 因此证据取确定性用例而不是窗口实拍：`app/tests/bridge.test.mjs` 用可控 gate 复现同一时序（订阅建立晚于终态写入、事件丢失），旧实现在 200 ms 内不收尾即判失败。窗口里这个竞态窗口是毫秒级，实拍既不能稳定复现也不能证明其消失。
- 同一次收尾的另一条路径也一并钉住：`onEvent` / `onStatus` 抛错不再阻断 settle（渲染回调炸了不能让任务登记永远停在「开放」）。

## 记录

- 现场清理：应用与侧车进程全部退出（`paper30min.exe` 0 个、sidecar python 0 个）；书库搜索已清空，6 篇论文与筛选默认值复位；本次走查无标记、无打卡写入。
- 未修范围（另行跟踪）：[#92](https://github.com/attackingjensen/paper-30min/issues/92) 存量未对齐 parts 的进度分母与节树不一致（该形态下 chip 读数 0/7、0/8 等仍可能不等于节树可标记节点数）。