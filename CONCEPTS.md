# Paper30Min：核心概念

本表只收录当前实现使用的术语，帮助开发者和 agent 对齐语言；行为契约以 [docs/spec/](docs/spec/) 与 [工程文件契约](docs/project-format.md) 为准，关键决策见 [docs/adr/](docs/adr/)。已退役能力（阅读地图、论文精解、节薄摘要、旧引用字典、PDF 原生批注、旧书库导入、逐页审阅门禁等）不在本表维护：退役边界见对应 ADR 与 `docs/spec/SPEC-legacy-projects.md`，历史术语与实现经 git 历史追溯。

## 工程与文档

### 工程与工程论文

可直接编辑和搬迁的本地文件夹，围绕创建时的固定论文组织正文、成果与会话。工程论文身份保持固定，不能被替换；外部原文件不构成运行依赖。

### 工程清单

`paper30min.json`。`formatVersion: 2`（新核）只保存身份与 current 指针；`formatVersion: 1`（界面过渡形态）保存论文身份与相对路径。两种格式互不读取。默认工程文件夹与最近工程是本机偏好，不随工程搬迁。

### 来源快照（source snapshot）

不可变的原始来源字节与逐文件摘要登记（`sources/<sourceSnapshotId>/`）。PDF、arXiv HTML、去敏解析结果各成一类快照；同字节同谱系复用，异字节新建，不原地更新。

### revision 与 current

一次已发布的受管正文（`paper/revisions/<revisionId>/`），含文档树、来源基线、changeset、tombstones 与资产。current 是清单中的唯一阅读权威指针，只能经原子提交推进；失败保留现场，旧 current 仍可读。

### 文档树（documentFormatVersion 1）

Section／Unit／Sentence／Atom／Block 的类型化树，节点使用论文内唯一 UUID。`document.json` 是当前正文，`source-base.json` 是来源基线；重开不重新分配 ID、不重新分段。

### 锚点与选区

指向文档树稳定节点的结构化位置；精确选区按 UTF-16 code unit 保存连续 ranges，内联 atom 占一个逻辑位置。不凭重复 quote 或相似文本自动重锚。

### changeset 与 tombstone

按稳定 ID 记录 retained／moved／changed／removed／added（合并阶段另有 conflicted）；tombstone 累积保存退役节点的最后出现与原因，退役 ID 不得复用。

### 三方合并候选

以旧 source-base、current 与新来源 candidate 做单元级合并的待发布 revision。冲突必须逐项显式选择 current 或 candidate；未解决冲突或基线变化拒绝发布。
_Avoid: 按默认优先级静默覆盖本地修正_

## 导入与核验

### arXiv 固定版本

无版本输入在导入开始时解析为确定的 `vN`，之后全部请求保持该版本；显式版本绝不静默改用其他版本。

### PDF 回退交接

arXiv HTML 不可用时，经用户显式确认把固定版本身份交接给 PDF 导入；交接不携带 URL、不自动下载 PDF、不产生云端费用。

### 云端解析与解析快照

用户主动确认上传后由所配置服务（当前为百度 AI Studio）解析 PDF；原始响应经去敏与资源本地化后发布为不可变解析快照。含密原始字节不写入工程。
_Avoid: 把云端当作正文权威、自动重传提交结果不明的任务_

### 原页裁剪图

无云端资产的视觉块从原 PDF 校准区域渲染的内容寻址 PNG，随候选 revision 发布，不回写快照；公式块的裁剪是可选区域证据，LaTeX／文本仍是权威。

### 核验记录（verification）

revision 关联的受管侧车，记录用户显式确认或 Agent 凭来源读取证据建立的"已对照原文"标记。发布新 current 时按实际 changeset 与 PDF 谱系继承：verified／modified-unreviewed／historical-source／removed。
_Avoid: 把 Agent 自述当核验、把页码当精确引用_

### 来源读取证据

主进程在 `read_pdf` 真实渲染时签发的受管记录，绑定 PDF 快照、页、session／task 与内容摘要，一次性消费；Agent 核验必须引用证据，不接受自述。

## 阅读与积累

### 记忆卡片

用户按需指定值得保留的原文或讨论，经整理得到的可编辑 `memories/*.md`。保留解释、适用条件、疑问与真实来源；不自动生成，不承担复习调度。
_Avoid: 自动记忆服务、强制问答卡_

### 产品 Skill

用户可编辑的阅读任务提示词（`app/skills/`，本机覆盖）。作用于明确发起的任务，与开发所用 NexusKit 技能分属不同用途。

### 阅读位置

从哪个视图、章节或 PDF 页继续阅读；保存在工程内，随搬迁恢复。
_Avoid: 当作读完比例_

## 尚未实现的方向

以下术语表达已确认的方向，不代表当前客户端已实现；启动时须结合现行规格复核。

- **本地基础解析／可选解析能力**：带文本层论文的本地解析，及按需安装的扫描页 OCR、高精表格扩展（[ADR-0001](docs/adr/0001-local-first-reading.md)、[ADR-0006](docs/adr/0006-optional-cloud-parsing.md)）。
- **全文阅读器**：消费规范文档树的 Full 阅读投影与复杂内容渲染（Phase 4，`SPEC-reader`）。
- **云端同步与移动阅读**：跨设备接续阅读是既定方向（见 [ADR-0005](docs/adr/0005-product-positioning-boundaries.md)）；移动书架／阅读副本的历史契约见 [#25](https://github.com/attackingjensen/paper-30min/issues/25)、[#26](https://github.com/attackingjensen/paper-30min/issues/26)。
