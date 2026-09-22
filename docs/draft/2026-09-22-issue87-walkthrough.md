# Issue #87 走查：UI 导入论文批量「全部深挖」修复的真实窗口点验（A+B）

> 日期：2026-09-22。执行：代理以 computer-use 驱动真实窗口（作者委托）。
> 环境：`npm run tauri dev`（debug，工作区含 #87 未提交修复），真实数据根
> `%APPDATA%/com.paper30min.reader`，真实 DashScope `qwen3.8-flash`（温度 0.3 /
> maxTokens 4096 / maxChars 20000，库内既有设置，未改动）。夹具为票面指定的两篇：
> 1603.02754（XGBoost，13 页）与 1610.00633（NAF，9 页），经「＋ 导入 PDF」原生
> 对话框从 `app/src-tauri/tests/fixtures/regression/corpus/` 导入（即 UI 真实导入路径）。
> 两篇论文与全部产物保留在书库以便复看（与 #85 走查后清理不同；未改动任何设置）。

## 验收结果：3/3 过

### 1. UI 导入 → 建图 → 「全部深挖」跑通（两篇）

| | XGBoost（13 页） | NAF（9 页） |
| --- | --- | --- |
| 建图前记录 parts（pdf.js 形状） | part-1..7（INTRODUCTION / TREE BOOSTING… / SPLIT FINDING… / SYSTEM DESIGN / RELATED WORKS / CONCLUSION / REFERENCES），**无 abstract** | **空**——pdf.js 编号节一个未识别，正文全并入 introduction（比票面「4 节」更极端） |
| 块模型节集 | 14 节，L2 域 12（abstract + 9 body + 2 appendix） | 10 节，L2 域 8（全 body，**无 abstract 节**） |
| 建图 | 落地页「薄摘要 n/12」递进至 12/12 | 8 节 L2（DB `protocol_products` kind=l2 ×8）+ map ×1 |
| 建图后记录 parts（A 回写） | **abstract + part-1..11**（title 取块模型节题，semanticType 取 L2 type：introduction/method/experiments/part） | **part-1..8**（块模型无 abstract 节故不补，与 L2 域一一对应） |
| 进度 chip ↔ 节树 | 0/12 已读完 ↔ 树 12 项（同域） | 0/9 已读完 ↔ 树 8 项（多 1，见发现 1） |
| 「全部深挖」 | 12/12 落库、树 12 节全橙、无 `invalid_input` | 先 6/8（取消，见验收 2）后补跑 8/8、树 8 节全橙、无 `invalid_input` |

A 侧回写在两侧都经 DB `reading_parts` 前后对照确认（建图前 pdf.js 形状 → 建图后
abstract/part-N 同构形状），且 chip 与节树读数同域——原缺陷「块模型内容节 ⊄ 记录 parts」
的两个实证形态（XGBoost 缺 abstract、NAF 连 part-1 都不在）均消除。

### 2. 多节并发在飞、按节完成、取消后已完成节保留

NAF「全部深挖」（task-000011）在飞实拍（任务中心）：

- **3 节已完成**（I. INTRODUCTION / II. RELATED WORK / III. BACKGROUND，绿）·
  **3 节同时第 1 轮在飞**（IV. … / Algorithm 1 … / V. SIMULATED EXPERIMENTS，并发 = 协议
  设置 3）· **2 节排队**（VI. / VII.，灰）；进度行「第 1 轮开始 · 上下轮 25201 token」。
- 取消后任务「已取消」：DB `dig` 恰为已完成 6 节（part-1..6）；未启动的 2 节标「已取消」且无
  产物；地图页提示随之变为「当前 2/8 节未经深挖核验」。
- 补跑「全部深挖」后 8/8 落库（重跑已有结果节无需覆盖确认，行为与既有说明一致）。

XGBoost 侧同批（task-000005 成功）留下逐节轮次遥测与工具轨迹：各节第 1 轮首字
2.2–5.8 s、单轮总时 15–32 s；部分节带取证步（如 6. END TO END EVALUATIONS：第 1 步
`get_figure(fig_11)` → p9 裁切图，共 2 步）。

### 3. 单节「重新深挖」回归

XGBoost ABSTRACT 节页点「重新深挖」：节页实时「深挖进行中 · 第 1 轮 · 已收到 76 字」+
流式「生成中」预览 → 完成；`dig/abstract` 产物刷新（1926 → 2210 字节，updated_at 更新），
L3 结果区与「取证轨迹 →」入口在位。单节路径未受 A+B 影响。

## 走查新发现

1. **无 abstract 论文的进度域多 1（低，[#90](https://github.com/attackingjensen/paper-30min/issues/90) 已修复关闭）**：块模型无 abstract 节的论文
   （NAF），进度 chip 为 0/9 而节树只有 8 项——前端进度域固定补一个 abstract 占位
   （`papers.js` `readingParts` 恒返回 `[FALLBACK_PARTS[0], ...parts]`），该占位在节树
   没有对应项、也标不上「已读完」，故这类论文永远到不了「已读完」。属既有行为，被 A
   侧对齐后显形；记入 `docs/status/current.md` 已知未收口项。
2. **#83 窗口验收口一并补齐**：有界并发在飞（3/3/2）、逐节完成、取消后已完成节保留
   三项在本走查取得实拍证据（#83 完成说明中「窗口点验待 #87 修复后补」的遗留项）。
3. **readMarks 不随 parts 对齐迁移**（承接实现说明，本次未触发）：本次两篇走查均无
   已读完标记；导入→解析完成窗口内按 pdf.js 序号记的标记在对齐后会改指块模型同序号节
   或成孤儿（不计数、不显示，历史保留）。见 #87 完成评论「遗留」。
4. **工具使用备注（供下次窗口走查）**：原生文件对话框「双击文件行」最可靠（点「打开」
   按钮或对文件名框 setValue 有静默失败）；批量深挖进行中 DOM 持续重渲染、无障碍元素
   索引漂移，页头导航用坐标直点（书库 461,63 / 阅读 493,63 / 任务 583,63 / 地图 250,143），
   页面内元素才用索引。

## 记录

- 证据来源：窗口截图（computer-use 实拍）+ DB 只读查询（`reading_parts` / `protocol_products`
  / `activity_days`）+ 任务中心逐节状态与轮次遥测。任务号见正文。
- 数据落点：两篇论文（`ed558456-…` XGBoost / `1af92ccf-…` NAF）连同 map、l2×20、dig×20
  产物留在正式书库；恢复方式为卡片「删除」。
- dev 应用（`npm run tauri dev`，pid 29004）走查结束时仍在运行，可继续复看。
- 本走查不含代码改动；#87 修复（A+B）与契约测试在工作区待提交，关票随该次提交。