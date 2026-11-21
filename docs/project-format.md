# 本地工程文件契约

本文是工程磁盘格式与读写行为的契约摘要：文件组织、身份与路径规则、提交/恢复语义、本机配置边界。行为规格的权威在 [docs/spec/](spec/)（project-core、document-core、arxiv-import、pdf-import、agent-integration 等），数值预算的权威在 [CONSTRAINTS.md](../CONSTRAINTS.md)（B1–B10）；本文不重复规格全文，冲突时以规格与实现为准。

## 文件组织

两种格式并存：新核遇到 `formatVersion: 1` 明确拒绝并提示旧格式处理流程；界面服务对 `formatVersion: 2` 清单经 `coreOpen` 投影为工作台视图（Full 阅读器入口），正文权威仍是 project-core 的 current revision，不提供自动迁移或双写。

### formatVersion 2（新核容器，导入命令链使用）

```text
工程文件夹/
  paper30min.json               # 工程身份、名称、主论文身份与 current 指针
  paper/revisions/<revisionId>/ # 已发布受管正文：document.json、source-base.json、tombstones.json、changeset.json、assets/
  sources/<sourceSnapshotId>/   # 不可变来源快照与 snapshot.json（逐文件 SHA-256／大小／可选 MIME）
  .paper30min/revisions/        # revision 元数据与核验侧车 verification.json
  .paper30min/imports/          # 首次导入恢复记录
  .paper30min/staging/          # 尚未发布的受管候选
  .paper30min/update-candidates/<revisionId>/ # arXiv 更新候选：candidate.json、五棵树与 changeset/tombstones、assets/（发布重载同一字节）
  .paper30min/pdf-evidence/     # 主进程 PDF 来源读取证据（一次性消费）
  .paper30min/parsing/<parseBatchId>/ # PDF 云端任务 task.json
  notes/ memories/ tmp/         # 用户文档、记忆卡片、临时产物
  .pi/sessions/                 # Pi 原生 JSONL 会话
```

### formatVersion 1（界面过渡形态）

```text
工程文件夹/
  paper30min.json       # 轻量清单：id、name、paper{id,path,sha256}
  text/paper.pdf        # 创建时复制的工程论文
  notes/ memories/ tmp/ .pi/sessions/
```

界面创建链路仍产出此格式；打开 v2 工程时论文 tab 为虚拟 Full 阅读入口（无文件路径），正文只从 current revision 的 `document.json` 投影渲染，资产经 `paper30min://project` 协议按受管登记读取。旧 `materials`、`map`、`explanations`、`translations` 字段读取时忽略、不再写入，既有清单按原样保留。旧解析批次产物（`text/<batchId>/paper.md`、`.paper30min/parsing/<batchId>/run.json`／`mapping.json`、`text/candidates/`）已随旧解析路径退役：文件保留原位，不再提供读取、恢复或删除入口。

允许增加普通文件和目录，文件树直接从磁盘读取，不要求逐个登记。内部隐藏目录、隐藏临时文件与 `node_modules` 不展示。应用持续监听当前工程，文件树自动更新；也可手动刷新，窗口重新获得焦点时刷新。

## 身份、路径与提交语义

- 相对路径使用 `/`，不允许父级穿越、绝对路径、Windows 保留名称或指向工程外的符号链接。工程与主论文身份是持久化 UUID，不随路径变化；整体搬迁后按相对路径继续工作，机器配置不随工程搬迁。
- 工程论文身份固定，不能被替换；改名／移动只操作文件，清单 `paper.path` 随路径更新，目标不能覆盖，清单保存失败时尝试回到原路径。外部改名／移动后缺失文件显示「找不到文件」。
- 清单只保存身份与指针：`paper.currentRevision` 是 revision ID 或 `null`；`null` 仅在存在有效首次导入记录时合法。
- 来源快照与已发布 revision 不可变。提交先完整落盘正文内容与 revision 元数据，再原子替换 current 指针；替换前复核清单字节、基线、旧／新 revision 与来源摘要。失败保留现场，旧 current 仍可读。受管写入按工程根在进程内串行；文件系统不提供面向任意外部写入的原子 compare-and-swap，不承诺任意跨进程竞态或断电场景的完整事务。
- 快照复用要求字节与来源谱系均一致（PDF：SHA-256＋本地／arXiv base ID 与固定版本；arXiv：abs/HTML 与全部已接受资产的完整摘要集合），否则新建 UUID 快照。SHA-256 不承担工程或 `paper.id` 身份。本地外部绝对路径不进入工程。
- project-core 不按字段名猜测或清洗凭据；来源模块必须在调用发布 API 前完成 Authorization、Cookie、签名 URL 等来源秘密的语义脱敏。

## 创建、失败与搬迁（界面链路）

创建前展示名称和完整工程路径，用户可修改。保存位置必须已存在且可写，同名子目录不覆盖；新目录独占创建，PDF 复制到 `text/paper.pdf` 后计算 SHA-256 并写清单。复制、初始化与最近工程登记均成功才返回成功；登记是提交点，迟到的取消不撤回已提交工程。失败或取消清理本次拥有的目录；强制杀进程或断电不保证清理，未登记目录需用户检查，不自动删除。

PDF 阅读位置及 Markdown 视图、位置保存在工程内 `.paper30min-reading.json`，按工程内路径恢复，不比较 PDF 哈希。文件移动依赖本地文件系统硬链接提供不覆盖保证，跨卷挂载点不支持。

## PDF 云端任务与解析快照

- `task.json` 保存 UUID 批次、父 PDF 快照、PDF 摘要、provider、固定模型与 endpoint、解析选项、`jobId`、阶段、响应摘要与候选 revision 身份；不保存 Token、代理、签名 URL 或原始错误正文（`errorDetail` 为去敏截断后的定位原文）。每个新任务先经调用方显式确认，首次 POST 前原子写入「提交中」；重开把未完成的准备／提交记录视为「提交结果不明」，必须人工关联任务号，不得自动重传。
- 原始 JSONL 只存在于主进程内存，经去敏与资源本地化后发布为解析快照（`kind: "pdf-parse"`：`snapshot.json`、`result.jsonl`、`facts.json`、`assets/`）；含密原始字节不写入工程。资源下载只允许当前 endpoint origin 与百度 HTTPS 资源域名，拒绝凭据、fragment、危险 scheme 与重定向；无法取得或无法证明安全的资源写成占位与 warning，未知字段不持久化，超预算拒绝且不发布快照。快照发布后不可变，转换与验证诊断不回写。
- 恢复直接复用已发布快照，不重复下载；发布后崩溃丢失关联时按批次找回快照并核对谱系与摘要。快照未发布时可从原 `jobId` 重下并核对摘要，不符即保留现场。查询超时和本机停止不冒充远端失败，恢复沿用原 endpoint、模型、解析选项与 PDF 摘要。
- 转换以 `result.jsonl` 与 `facts.json` 为输入，全部页面转换并通过 document-core 全量验证后才生成规范树；初次导入 `document.json` 与 `source-base.json` 一致。不经过可编辑 Markdown 中间权威、不逐页渐进 current、不要求全文 LLM 审阅。vendor 页／块 ID 保存为 `sourceAliases`（`page-N/bM`），不替代稳定节点 ID；章节层级缺失采用平铺结构＋warning，`block_order` 缺失按响应顺序降级＋warning。表格消毒后转换，嵌套或不可信跨度降级 raw block；公式保留 LaTeX 与文本投影；缺失图片成为占位＋warning。
- 任务阶段由 `downloaded` 经 `converting` 到 `candidate-complete`；候选身份提交前持久化，崩溃恢复复用已发布候选只推进指针，残留清理后按同一身份重新转换。相同快照离线重新转换内容结构确定；warning 与转换器版本存于 revision 元数据 `pdfParse`。current 已存在时拒绝直写覆盖，更新必须走 document-core 合并路径。
- 无云端资产的视觉块可引用原页裁剪图：仅无旋转、CropBox 与 MediaBox 重合、未预处理且宽高比校验通过的页面产出区域裁剪，否则降为页级＋warning。裁剪图为内容寻址 PNG，随候选 revision 发布，不回写原始 PDF 或解析快照；云端资产存在时优先云端字节。公式块裁剪是可选区域证据，LaTeX／文本仍是权威。

## 文档树、合并与核验

- 文档树为 `documentFormatVersion: 1` 的 Section／Unit／Sentence／Atom／Block，节点论文内唯一 UUID；锚点、changeset、tombstones 与三方合并由 document-core 承担（[SPEC-document-core](spec/SPEC-document-core.md)）。重开只读取并验证已持久化内容，不重新分配 ID、不重新分段、不改写 revision 字节。
- 合并候选发布后 current 是合并树，source-base 只含新来源树，后续轮次仍能识别保留的本地修正。冲突必须逐项显式解决；未解决冲突或 baseRevision 变化拒绝发布。提交失败后只有内容、来源、基线与元数据完全一致的同一候选可按原 revisionId 重试。
- 核验记录是 revision 关联的受管侧车 `verification.json`，不属于文档树或不可变正文。每条记录固定创建时的锚点、覆盖节点、内容摘要、PDF／解析快照、actor 与核验方式；用户记录显式确认，Agent 记录必须引用一次性消费的来源读取证据，不接受自述。发布新 current 前按实际 changeset 与 PDF 谱系继承：同 PDF 内容不变保持 `verified`，内容修正 `modified-unreviewed`，换 PDF 内容未变 `historical-source`，拆分／合并／删除 `removed`，新增节点不继承；继承保留原 `verifiedRevisionId`、来源与证据。继承逻辑属 PDF 来源语义，由 `coreCommit`、来源合并发布与重解析候选发布等 PDF 侧调用方经 commit 钩子注入通用提交路径（`before-current-replace`，串行临界区内执行）；通用文档合并（`document/merge`）不依赖来源模块，arXiv 等无核验记录的来源发布为空操作。文档级摘要聚合已核验／历史来源／修改后未复核／无记录四态，不产生主观质量分数（[SPEC-pdf-import](spec/SPEC-pdf-import.md) §9–§11）。
- 新核经 `core*` 命令接入生产 preload、IPC 与 Node utility process（命令面见 [app/README.md](../app/README.md)）。`coreCommit` 是低层容器协议：tombstones 累积与退役语义由 document-core 合并命令层保证，直接调用方自行维护。
- arXiv 更新编排（[SPEC-arxiv-import](spec/SPEC-arxiv-import.md) §8）：检查新版只读 abs 比较固定版本，不下载正文；更新候选要求严格更高版本，同版重取与离线重新转换都形成 document-core 三方合并候选，确认发布前 current 不变。同版重取字节一致复用快照，不一致新建不可变快照；离线重转换不访问网络、不改写快照。候选身份按快照、基线与转换器版本确定性派生，构建时整体落盘于 `.paper30min/update-candidates/`（树与资产读取执行 64 MiB／32 MiB／512 MiB 硬预算），发布按用户确认的候选身份重载同一份存储字节（不重新转换），复核 baseRevision、来源 base ID 与有效固定版本，冲突逐项显式解决。PDF 回退后的 current（pdf-parse 来源）沿 `parentSourceSnapshotId` 回溯父级 **PDF** 快照的 arXiv 事实（baseId/固定版本）参与检查与更新；父级类型不符、缺失或本地 PDF 无谱系时如实拒绝，不猜测身份。

## PDF 阅读与来源信息

工程 PDF 只读，阅读器不提供原生批注创建、引用框选、引用字典或 `#annotation=` 链接。已有 PDF 字节不因阅读、选区复制、缩放或位置恢复而改变。

`read_pdf` 每次读取当前 PDF 并独立渲染整页 PNG，不接受区域坐标或预期哈希参数。结果包含图像、路径、文档身份、文件版本、页码、总页数、尺寸（PDF 点单位）、实际缩放与来源信息；不提取文本层、不执行 OCR 或短句匹配，也不创建引用或修改 PDF。模型指出原文位置时使用真实文件路径和页码，不猜链接、坐标或引用 ID。历史 Pi 会话中旧版本生成的来源快照仍完整保留在 JSONL 内，界面仅在显示投影中隐藏。

## 记忆卡片

「记忆卡片」由用户在对话中按需调用，生成普通 `memories/*.md`，可自由编辑、改名和搬迁，不需清单登记。保留必要解释、推理、条件和待核实问题；来源使用实际读取过的文件路径与页码，不伪造引用。普通聊天不自动生成卡片，不提供复习调度或独立卡片数据库。

## 本机配置

- `userData/preferences.json`：`defaultFolder` 与最多 20 个最近工程。默认目录只影响后续新建；不存在或不可写时要求重新选择。不随工程搬迁。
- `agent-settings.json`：模型与代理配置；API 密钥用 Electron `safeStorage` 加密，不进工程或会话。换机需重新配置。
- `parsing-settings.json`：百度解析配置，Token 同样加密、仅请求时解密；代理复用 Agent 选择。停止和查看任务状态不依赖凭据。
- 产品 Skill：默认提示词在 `app/skills/`，本机覆盖存 `userData/product-skills/`，保存按内容 SHA-256 检查冲突。每次调用把实际提示词与版本写入用户消息，历史重开不受后续修改影响。旧根目录 `skills/` 不在新版加载。

## Pi 会话

普通对话使用 Pi SDK 的 JSONL 持久化与原生自动上下文压缩，不另建聊天数据库。历史 `cwd` 可能保留原绝对路径，重开使用当前工程目录。分支建立新的原生会话文件；空会话在首次消息写入前不保证落盘。

运行、补充消息队列和输入草稿是临时状态。停止清空待执行补充消息，保留已收到回复与已完成文件修改；迟到事件不追加到会话，排队写入在提交前检查取消。退出取消运行，工程进程未及时结束时主进程等待落定后关闭（超时兜底强杀）；强制终止不保证保存未落盘的流式片段。工具调用、结果、改动与冲突数据保存在对应消息中，历史重开按 toolCallId 关联。

## Agent 文件与 Shell

read、write、edit 复用 Pi 原生工具，工程服务提供真实读写。读取限定工程内 UTF-8 文本（预算见 CONSTRAINTS B6），拒绝父目录、内部隐藏文件、符号链接及 PDF。已有文件必须先 read；edit/write 使用已读取基线，冲突返回基线、当前磁盘与拟写入内容，先重读再整合，不覆盖双方输入。新文件独占创建，已有文件走与界面保存相同的暂存、同步和替换流程；最后一次检查与替换之间仍存在文件系统竞态。

`text/`、`notes/` 等普通 Markdown 允许界面及 Agent 修正；`sources/`、`paper/`、任何 PDF、已登记工程论文及内部受管文件保持保护，来源模块经受限入口落地。

bash 在 Windows x64 上执行 PowerShell，默认超时 120 秒。每次 Shell 建立 kill-on-close 的 Windows Job Object，退出/取消时清理进程树。模型密钥不进子进程环境；输出在持久化前脱敏。Shell 按用户确认采用受信任主机执行，没有强制文件沙箱：模型指令禁止借 Shell 修改受保护文件，但恶意脚本仍具当前用户权限；越界、系统修改和上传／发布须有明确任务授权。

## Markdown 编辑与外部协作

UTF-8 Markdown 正文为权威（含 BOM），编辑预算见 B6。打开、阅读和切换视图不写正文。CodeMirror 仅应用用户编辑范围；未修改范围的换行风格、注释、空行和尾随空格保留，新输入换行沿用文档首个换行样式。阅读渲染不反向生成 Markdown，原始 HTML 按文本显示；公式 KaTeX 渲染，图片限工程内相对路径，工程外文件与符号链接图片不加载。

保存为显式操作（Ctrl+S 或停止输入约 600 毫秒自动保存）。各标签独立保留草稿和撤销记录；关闭脏标签、离开工程或退出需确认放弃，草稿不提供崩溃恢复。保存先检查 SHA-256 基线，再同目录暂存、同步、替换，替换前再次核对磁盘内容，失败不截断旧正文。

无本地修改时载入外部更新；双方修改时保留当前草稿并显示磁盘内容，禁止直接覆盖。删除／改名保留已打开标签内的文本并提示。
