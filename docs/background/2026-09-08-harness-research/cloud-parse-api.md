# 调研：云端文档解析 API 盘点与适配评估（替代本地侧车的可能性）

- 来源票据：[#41 论文作为代码库：工具化阅读协议与 L1/L2/L3 产物设计](https://github.com/attackingjensen/paper-30min/issues/41)（Wayfinder 父图：[#35](https://github.com/attackingjensen/paper-30min/issues/35)）
- 日期：2026-09-09（所有外部来源均查询于当日）
- 分支：`research/cloud-parse-api`
- 方法：文档级调研，未实际调用任何 API（未触碰 `.local/` 密钥）；所有事实均引一手来源（官方文档、官方仓库源码）。姊妹篇（本地工具盘点）：[pdf-parse-tools.md](./pdf-parse-tools.md)
- 触发问题：能否用云端 API 做文档解析，免除 Docling/MinerU 侧车的部署重量？用户提到的候选入口是百度飞桨星河社区的 PaddleOCR 服务（`https://aistudio.baidu.com/paddleocr`，页面标题自称"文档解析与智能文字识别 | 支持API调用与MCP服务"）。

## 结论摘要

**百度星河社区的 PaddleOCR 服务是真实存在的官方 API，且管线式与生成式两者皆有**：同一套异步任务 API（`https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`，Bearer Token 鉴权）同时提供 PP-OCRv5/v6、PP-StructureV3（检测识别式管线）和 PaddleOCR-VL/1.5/1.6（0.9B 生成式 VLM 管线）；MCP 服务通过官方 `paddleocr-mcp` 包以 `aistudio` 模式接入。**输出满足硬需求**：块级 `block_bbox`+`block_label`+`block_order`，PDF 输入带页码关联，furniture 标签单列可剔除。**但配额/速率/计费在公开一手页面上查不到数字**（服务页是纯 JS 渲染），社区服务的 SLA 与长期免费性不可依赖；商用路径是百度智能云千帆（API Key 永久有效，按量计费）。**DashScope 系整体不满足硬需求**：qwen3.5-ocr/qwen-vl-ocr 的 `document_parsing` 只输出 LaTeX 文本流（无块级 bbox、无页码），`advanced_recognition` 有行级坐标但无块语义；例外是**阿里云文档智能（Document Mind）的"文档智能解析"API，块级 `pageNum`+四点 `pos` 坐标齐全、类型标签含页眉页脚脚注公式**，但它是独立产品（RPC 签名、RAM 授权、异步轮询），免费额度仅一次性 100 页。用户假设中的"qwen3.8-flash 多模态"不成立——该模型在官方模型列表中属**文本生成**分类，不支持视觉输入；多模态 grounding 由 qwen3-vl-plus/flash 承担，但其文档解析是生成式 QwenVL-HTML/Markdown 流，坐标嵌在标记里且无页码概念。**综合判断：云端 API 中"百度 PP-StructureV3 官方 API"在输出完备性上唯一可直接满足硬需求，可作为 Docling 侧车之外的候选实现路径，但不能免除"隐私出设备 + 离线失效 + 配额不透明"三项结构性代价；建议定位仍为本地侧车为主、云端为可选加速器。**

---

## 一、评估基准（与姊妹篇一致）

对照 Issue #41 的三份产物：(a) 块级 Markdown 文本层（块带 `kind`/`page`/`bbox`）；(b) 图表清单；(c) 参考文献清单。

- **硬需求**：每个输出块必须带页码与 bbox。
- **哲学约束**：宁可占位不可编造（生成式正文不可接受；公式 LaTeX 可为 ML 输出但需裁切图兜底或默认占位）。
- 本轮新增评估维度（云端特有）：接入成本（鉴权形态、SDK/协议）、密钥管理、隐私（论文全文出设备）、离线失效面、计费与配额透明度。

## 二、百度飞桨星河社区 PaddleOCR 服务（官方 API + MCP）

### 2.1 真实形态：管线式与生成式皆有

服务页 `https://aistudio.baidu.com/paddleocr` 为纯 JS 渲染（curl 仅得标题"PaddleOCR - 文档解析与智能文字识别 | 支持API调用与MCP服务 - 飞桨星河社区"，正文无法静态读取）。其背后的 API 与模型清单以官方仓库源码为准：

- `paddleocr/_api_client/_http.py`：`DEFAULT_BASE_URL = "https://paddleocr.aistudio-app.com"`，`API_PATH = "/api/v2/ocr/jobs"`；鉴权为 `Authorization: Bearer {token}`。
- `paddleocr/_api_client/models.py`：`Model` 枚举 = `PP-OCRv5`、`PP-OCRv5-latin`、`PP-OCRv6`、`PP-StructureV3`、`PaddleOCR-VL`、`PaddleOCR-VL-1.5`、`PaddleOCR-VL-1.6`。
- 即：**PP-StructureV3（检测/识别式管线）与 PaddleOCR-VL 系列（生成式 VLM 管线）都在同一服务后面**，调用方按 `model` 参数选择。

### 2.2 接入形态

- **REST API（异步任务制）**：提交 job（`file_url` 或本地文件上传，源码 `validate_input_source` 确认二者互斥必填其一）→ 轮询状态（`Progress: totalPages/extractedPages`）→ 完成后从 `resultUrl.jsonUrl` 下载结果 JSON。SDK 侧 dataclass：`DocParsingResult{job_id, pages: List[DocParsingPage], data_info}`，每页 `DocParsingPage{markdown_text, markdown_images, output_images, pruned_result, exports, ...}`（图片资源以 URL 返回，需二次下载）。
- **MCP**：官方 `paddleocr-mcp` 包（`pip install paddleocr-mcp`，要求 Python ≥3.10）。四种推理来源：`local`（本地）、`aistudio`（官方 API）、`qianfan`（百度智能云千帆）、`self_hosted`（自建服务）。aistudio 模式只需 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`（在 `https://aistudio.baidu.com/account/accessToken` 获取）；默认请求超时 120s、任务轮询上限 600s。MCP 工具名：`ocr` / `pp_structurev3` / `paddleocr_vl`。注意 MCP 模式把解析结果喂给 LLM 会消耗大量 token（官方"已知局限性"提示图像内容会显著增加 token 用量）——对我们"客户端后台解析"场景，**直接调 REST API 比走 MCP 更合适**，MCP 只适合交互式 agent 场景。
- **千帆路径**（商用）：`PADDLEOCR_MCP_QIANFAN_BASE_URL` 默认 `https://qianfan.baidubce.com/v2/ocr`；千帆平台 OCR 分类下有 `POST PaddleOCR-VL`、`POST PP-StructureV3`、`POST PaddleOCRV6`、`POST DeepSeek-OCR` 等接口；API Key 在百度云 IAM 控制台创建、**永久有效**；计费价格未在抓到的鉴权页给出（各接口有独立文档页，未逐一抓取，标存疑）。

### 2.3 计费、配额、速率限制

**存疑（一手来源未覆盖）**：星河社区服务页为 JS 渲染，公开文档（MCP 文档、管线文档、快速开始）均未给出免费额度、QPS、单价数字。AI Studio 服务历来是社区/体验性质；正式商用应走千帆。**这意味着：若把该服务当生产后端，配额与可持续性没有书面承诺可依。**

### 2.4 输出 schema（与服务同源的管线输出，官方文档逐字段确认）

PP-StructureV3 与 PaddleOCR-VL 的 JSON 结果结构一致（服务化/API 结果即管线 `predict` 结果的 JSON 表示的 `prunedResult` 简化版——按官方服务化文档，简化版去掉了 `input_path` 和 `page_index` 字段，但**页关联由 API 返回的按页数组结构承载**，块级字段保留）：

- 顶层：`page_index`（PDF 页码）、`page_count`、`width/height`、`model_settings`。
- `parsing_res_list`（**列表顺序即阅读顺序**）：每块 `block_bbox`（边界框）、`block_label`（块类型）、`block_content`、`block_id`、`block_order`（阅读顺序号，非排序部分为 None）。
- 布局检测标签（PP-DocLayout 系，官方版面检测模块文档列 23 类）：文档标题、段落标题、文本、页码、摘要、目录、参考文献、脚注、算法、公式、公式编号、图像、图表标题、表格、表格标题、印章、图表、页眉、页脚、页眉图像、页脚图像、侧栏文本（PaddleOCR-VL 的 PP-DocLayoutV2 示例输出另见 `vision_footnote` 标签）。
- **furniture 单列**：`markdown_ignore_labels` 默认 `['number','footnote','header','header_image','footer','footer_image','aside_text']`——页眉页脚脚注默认从 Markdown 剔除但仍在 JSON 块中（可追回），与我们的 furniture 桶语义一致。
- **公式**：PP-StructureV3 走公式识别子管线（PP-FormulaNet-S 等识别式模型，输出 LaTeX）；PaddleOCR-VL 由 VLM 生成 LaTeX；`show_formula_number` 控制是否保留公式编号。
- **表格**：`save_to_html()` 可导出 HTML（另有 xlsx）；`use_wired_table_cells_trans_to_html` 等参数存在。
- PP-StructureV3 官方说明其相对 PaddleOCR-VL 提供"more fine-grained coordinate information, including table cell coordinates, text coordinates"（细到单元格与文本行坐标）。

**小结：百度官方 API 的输出完备性与本地 PP-StructureV3 侧车完全等同（同一份代码栈），满足块级 page+bbox 硬需求；正文为 OCR 识别式（选 PP-StructureV3 时）不幻觉。**

## 三、PaddleOCR-VL 单独评估（生成式路径）

来源：`docs/version3.x/pipeline_usage/PaddleOCR-VL.md`（官方仓库，2026-09-09 查询）

- **架构**：两阶段——版面分析模型 PP-DocLayoutV2（检测，出 bbox 与阅读顺序）裁出元素子图 → 每个子图独立送入 VLM（PaddleOCR-VL-0.9B = NaViT 动态分辨率视觉编码器 + ERNIE-4.5-0.3B 语言模型）**生成**块内容（Markdown）。官方强调必须用完整两阶段流程，不能只用 VLM。
- **生成式程度**：块 bbox 与顺序来自检测器（可靠），但**块内文字由 VLM 生成**——正文转写属生成式，存在幻觉面，与"宁可占位不可编造"哲学冲突；缓解只能靠置信度外手段（官方未提供逐字置信度）。
- **输出**：块级 `block_bbox` + `page_index` 齐全（同 §2.4），公式/表格为 LaTeX/HTML，furniture 默认剔除标签同上。
- **指标（官方自述）**：PaddleOCR-VL-1.5 以 94.5% 刷新 OmniDocBench v1.5；1.6 以 96.3% 刷新 v1.6。注意 OmniDocBench 出自 OpenDataLab（MinerU 同门），此为 PaddleOCR 官方引述，非独立第三方复测。
- **本地部署形态**：Python 3.9–3.13 + PaddlePaddle ≥3.2.1（`pip install "paddleocr[doc-parser]"`），官方 Docker 镜像约 8GB（离线版约 10GB）；GPU 要求 CC ≥7.0/CUDA ≥11.8（vLLM 路径 CC ≥8.0/CUDA ≥12.6）；**CPU 可跑但官方明示"对于 PaddleOCR-VL 系列，不建议使用 CPU 推理"**。与 Docling 侧车对比：更吃 GPU、正文生成式，作为默认路径不合适。
- **云端可用性**：AI Studio 官方 API 与千帆均提供（§二）；另有第三方托管（硅基流动、Novita AI，官方文档提及，未展开核实）。

## 四、DashScope / 阿里云系

### 4.1 千问 OCR（qwen3.5-ocr / qwen-vl-ocr）——块级硬需求不满足

来源：`https://help.aliyun.com/zh/model-studio/qwen-vl-ocr`（2026-09-09 查询）

- **模型**：qwen3.5-ocr（基于 Qwen3.5 架构，官方推荐，支持多轮对话与 PDF 直接解析）；qwen-vl-ocr 系列（基于 Qwen3-VL 架构，稳定版/latest/2025-11-20/2025-08-28）。
- **内置任务与输出**：
  - `document_parsing`（文档解析）："识别标题、摘要、标签等内容，**以 LaTeX 格式返回识别结果**"——输出为整篇 LaTeX 文本流（官方示例为 `\documentclass{article}...` 全文转写），**无块级 bbox、无页码、无块类型结构**。
  - `advanced_recognition`（高精识别/文字定位）：返回**行级**旋转矩形 `rotate_rect:[center_x, center_y, width, height, angle]` + 每行文本（`ocr_result.words_info`）——有坐标但无块语义、无阅读顺序、无页码。
  - `table_parsing` → HTML；`formula_recognition` → LaTeX；`key_information_extraction` → JSON KV。
- **PDF 支持**：仅 Response API（非 Chat Completions）可直接传 PDF；≤100MB；`document_parsing` 任务**最多 50 页**（其他任务 10 页）；PDF 解析输出长度"不受模型最大输出长度限制"。qwen-vl-ocr 系列 `max_tokens` 默认 4096（调到 8192 需联系商务审批）。
- **OpenAI 兼容模式**：可用，但官方明示"高级功能（图像旋转矫正和内置 OCR 任务）不支持直接通过参数调用，需手动构造 Prompt 模拟"——即我们现有的 OpenAI 兼容通道**调不到内置任务**，要么上 DashScope SDK 要么自己拼 prompt。
- **计费**：按 token（图像按 32×32 像素/token 折算）。华北2（北京）：qwen3.5-ocr 输入 0.5 元/百万 token、输出 2 元/百万 token；qwen-vl-ocr 输入 0.3、输出 0.5。**免费额度 100 万 token（开通起 90 天内，仅北京地域）**。
- **判定**：`document_parsing` 无块级 page+bbox，硬需求直接不满足；`advanced_recognition` 有行坐标但需自研"行→块聚类+语义标注+页关联"全套对齐逻辑，且正文仍是生成式。**淘汰（作为解析后端）。**

### 4.2 qwen3-vl-plus / qwen3-vl-flash（通用视觉模型，grounding）——不满足页码需求

来源：`https://help.aliyun.com/zh/model-studio/vision` 与模型计费页（2026-09-09 查询）

- 支持二维定位（JSON 输出 `bbox` 坐标、XML 输出 point）、三维定位（Qwen3-VL 新增）。
- 文档解析：按提示词 `qwenvl html` / `qwenvl markdown` 将文档图像解析为 QwenVL HTML/Markdown，"能获取图像、表格等元素的位置信息"——即**坐标嵌在生成式标记内**（元素级 bbox 有，但整块类型体系、页码概念缺省；输入单位是图像，PDF 需自行逐页渲染后逐页调用再自拼页码）。
- 计费（北京，阶梯）：qwen3-vl-flash ≤32K token 档输入 0.15 元/百万、输出 1.5 元/百万；qwen3-vl-plus 输入 1 元、输出 10 元。
- **判定**：正文整页生成 + 无页码概念 + 坐标格式需自解析，不满足硬需求与哲学约束。**淘汰。**

### 4.3 关于"qwen3.8-flash 多模态 grounding"假设的澄清

官方模型列表页（`https://help.aliyun.com/zh/model-studio/models`）将 **qwen3.8-flash 列在"文本生成"分类**，非多模态；`vision` 文档的混合思考模型清单中，qwen3.8/qwen3.7/qwen3.6/qwen3.5 系列与 qwen3-vl-plus/qwen3-vl-flash 并列，视觉能力属后者。**qwen3.8-flash 本身不支持图像输入与 grounding 输出**（以此纠正提问中的假设）。其价格：输入 0.8 元/百万 token、输出 2.7 元/百万（≤1M 档），100 万 token 免费额度。

### 4.4 阿里云文档智能（Document Mind）——唯一满足块级硬需求的阿里系 API

来源：`https://help.aliyun.com/zh/document-mind/` 及子页（2026-09-09 查询）

- **三个文档解析子产品中只有一个出坐标**（官方能力对比原话）：
  - 文档解析（大模型版）：层级树+版面信息、分块流式输出、Markdown，但**"不输出原图和坐标"**；免费额度每月 3000 页。
  - 电子文档解析：纯电子文档结构化，同样**不输出坐标**。
  - **文档智能解析**："输出包含原图和内容坐标"——✅。
- **文档智能解析 API**：异步制，先 `SubmitDocStructureJob`/`SubmitDocStructureJobAdvance` 提交、再 `GetDocStructureResult` 轮询（官方建议每 10 秒一次、最长 120 分钟）。鉴权为阿里云 AccessKey + RAM（需授 `AliyunDocmindFullAccess`），OpenAPI 为 V2 RPC 签名风格。
- **输出 schema（官方示例值）**：块级字段 `text`、`index`、`uniqueId`、`alignment`、**`pageNum`（数组）**、**`pos`（四点 x/y 多边形）**、`type`、`subType`。类型标签含：title/doc_title、图注（figure_note/pic_caption）、页脚（foot/page_footer）、页眉（head/page_header）、页眉页码/页脚页码、脚注（corner_note/footer_note）、尾注（end_note）、侧栏（side/sidebar）、表名/表注、**公式（formula）**、多栏文字、表格、页眉/页脚图片等。`StructureType` 可选 layout/doctree/default（层级树）；`FormulaEnhancement=true` 时**公式以 LaTeX 输出**（默认关闭，契合"宁可占位"）；`OutputFormat=markdown` 可返回整篇 Markdown；`PageIndex` 支持指定解析页范围（1-n）。
- **计费**：自然月阶梯计费、按页计（图片按张折算）；**文档智能解析免费额度为一次性 100 页**（文档解析大模型版是每月 3000 页，但它不出坐标，不适用）；扣费顺序 免费额度→资源包→按量付费。具体阶梯单价在计费概述页未列数字（在单独"按量付费"页，本次未抓到，标存疑）。
- **判定**：输出完备性满足硬需求（块级 pageNum+pos、furniture/脚注/公式标签齐全、公式 LaTeX 可选默认关），形态与 Docling 的 prov 类似；代价是接入重（RPC 签名/RAM/异步轮询，官方自述自签名"预计需 5 个工作日"，建议用 SDK）、免费额度极小、按页计费、论文全文上传阿里云。**技术上合格，工程与成本上不划算；且 PDF 页数上限、双栏学术论文精度均无公开数据（存疑）。**

## 五、能力对照与评分

基准：块级 MD + 每块 page+bbox（硬需求）、公式/表格保真、正文不幻觉。评分 1–5（5=完全满足）。

| 候选 | 块级 page+bbox | 块类型完备性 | 公式→LaTeX | 表格结构化 | 正文不幻觉 | 硬需求总评 | 计费透明度 | 离线可用 |
|---|---|---|---|---|---|---|---|---|
| 百度官方 API - PP-StructureV3 | 5（block_bbox+按页数组） | 5（23 类含页眉页脚脚注参考文献） | 4（识别式模型） | 5（HTML，细到单元格） | 4（OCR 识别式；扫描件有误识面） | **满足** | 1（社区服务配额未公开；商用走千帆） | 1（纯云端） |
| 百度官方 API - PaddleOCR-VL | 5（block_bbox+page_index） | 5 | 4（VLM 生成） | 4（HTML） | 2（正文由 VLM 逐块生成） | 满足硬需求但违哲学约束 | 1（同上） | 1 |
| PaddleOCR-VL 本地 | 5 | 5 | 4 | 4 | 2 | 满足硬需求但违哲学约束 | —（本地免费） | 4（CPU 官方不建议；吃 GPU） |
| DashScope qwen3.5-ocr/qwen-vl-ocr | 1（document_parsing 无坐标；advanced_recognition 仅行级） | 1（无块类型） | 3（生成式 LaTeX） | 3（HTML 但无坐标） | 2（生成式） | **不满足** | 4（token 单价明确） | 1 |
| DashScope qwen3-vl-flash grounding | 2（标记内嵌元素 bbox，无页码） | 2 | 2 | 3 | 2 | **不满足** | 4 | 1 |
| 阿里云 DocMind 文档智能解析 | 5（pageNum+四点 pos） | 4（标签全，未见独立"摘要/参考文献"类型） | 4（可选增强，默认关） | 4（另有表格智能解析 API） | 3（引擎形态官方未明示，存疑） | **满足** | 3（按页阶梯，单价未抓到） | 1 |
| （对照）Docling 本地侧车（姊妹篇主推荐） | 5（prov=page_no+bbox+charspan） | 5（30 标签） | 3（可选 enrichment 默认关） | 4 | 5（正文取自 PDF 文本层） | **满足** | —（本地免费） | 5 |

## 六、作为"桌面客户端云端解析后端"的接入成本评估

1. **密钥管理**：百度 AI Studio 为单一 AccessToken（Bearer）；千帆为 IAM API Key（永久有效）；DashScope 复用现有 qwen 账号 API Key 即可调千问 OCR/VL（OpenAI 兼容端可调通对话，但内置 OCR 任务需 DashScope SDK 或手搓 prompt）；DocMind 需阿里云 AccessKey+RAM 授权+RPC 签名，最重。客户端分发时密钥不能随包——要么用户自备（BYOK，设置项），要么自建中转代理（引入我们自己的服务端与计费责任）。
2. **隐私**：所有云端方案都意味着**论文全文（PDF 或逐页渲染图）离开设备**上传到百度/阿里云。arXiv 公开论文敏感度低，但用户书库可能含付费墙内或内部稿件；这与 #41 现有"Windows 本地书库是论文内容权威来源"的定位存在张力，产品上需要明示开关与告知。
3. **离线失效面**：云端方案离线即全灭（连首篇导入都无法完成）；本地侧车离线可用是结构性优势。任何云端路径都必须与本地兜底（至少 pdf.js 文本层启发式）共存，不能替代。
4. **配额与可持续性**：百度星河社区服务的免费额度/速率**无公开书面数字**（存疑），把核心导入路径押在社区服务上有供给风险；千帆与阿里云是按量计费的正规商用通道，成本随书库规模线性增长（DocMind 免费仅一次性 100 页）。
5. **工程收益**：云端路径省掉的是 Python 侧车打包（PyInstaller/uv 嵌入式 + 百 MB 级模型随包）与 CPU 速度焦虑；换来的是网络依赖、异步任务编排（两家百度/阿里 DocMind 都是 submit+poll 模式）、密钥与隐私设计、以及计费逻辑。**省的是部署重量，添的是运行时复杂度与产品约束。**

## 七、结论与建议

- **若坚持引入云端解析**：百度官方 API 的 **PP-StructureV3** 是唯一在输出完备性、正文非生成式、接入简单（Bearer Token + REST 异步任务）三方面同时合格、且与现有 PP-StructureV3 调研结论同源的候选；阿里云 DocMind 文档智能解析技术合格但接入最重、免费额度最小；DashScope 千问 OCR/VL 系全部因块级 page+bbox 缺失而出局（含对 qwen3.8-flash 多模态假设的否定）。
- **但它没有改变姊妹篇的主推荐**：Docling 本地侧车在硬需求、哲学约束、离线可用、零边际成本上仍全面占优。云端 API 的合理定位是**可选加速器/降级预案**（如 CPU 过慢时的用户自选云端通道，BYOK），而非替代侧车。是否引入，建议在 #41 下另开决策票讨论（密钥分发模式与隐私告知是产品决策，非纯技术问题）。

---

### 来源清单（均查询于 2026-09-09）

- 星河社区服务页（仅标题可读，JS 渲染）：https://aistudio.baidu.com/paddleocr ；AccessToken 获取页：https://aistudio.baidu.com/account/accessToken
- PaddleOCR 官方仓库（API 客户端源码，一手确认 endpoint/鉴权/模型枚举/结果结构）：
  - https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_api_client/_http.py （`DEFAULT_BASE_URL`、`API_PATH=/api/v2/ocr/jobs`、Bearer 鉴权）
  - https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_api_client/models.py （Model 枚举）
  - https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_api_client/results.py （Job/DocParsingResult/DocParsingPage 结构）
  - https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_api_client/_core.py （file_url/file_path 互斥、resultUrl.jsonUrl）
- MCP 服务器文档（四种推理来源、参数表、千帆 base URL、已知局限性）：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/integrations/mcp_server.md
- PP-StructureV3 管线文档（输出 JSON 字段、markdown_ignore_labels 默认值、prunedResult 说明）：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/pipeline_usage/PP-StructureV3.md
- 版面检测模块文档（23 类标签列表、coordinate 格式）：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/module_usage/layout_detection.md
- PaddleOCR-VL 管线文档（两阶段架构、PP-DocLayoutV2+0.9B VLM、输出字段、部署与 GPU 要求、OmniDocBench 自述）：https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.md ；在线版 https://www.paddleocr.ai/latest/version3.x/pipeline_usage/PaddleOCR-VL.html
- 百度千帆 OCR API 鉴权与接口目录：https://cloud.baidu.com/doc/qianfan-api/s/ym9chdsy5
- 阿里云千问 OCR：https://help.aliyun.com/zh/model-studio/qwen-vl-ocr
- 阿里云视觉理解（grounding、qwenvl html/markdown、模型归属）：https://help.aliyun.com/zh/model-studio/vision
- 阿里云百炼模型列表与计费：https://help.aliyun.com/zh/model-studio/models ；https://help.aliyun.com/zh/model-studio/model-pricing
- 阿里云文档智能 Document Mind：https://help.aliyun.com/zh/document-mind/ ；能力对比 https://help.aliyun.com/zh/document-mind/product-overview/overview-of-document-understanding ；API 总览 https://help.aliyun.com/zh/document-mind/developer-reference/api-overview-1 ；文档智能解析 API https://help.aliyun.com/zh/document-mind/developer-reference/docstructure ；计费 https://help.aliyun.com/zh/document-mind/product-overview/billing-overview

### 本次未能一手确认、标记存疑的点

- 百度星河社区 PaddleOCR 官方 API 的免费额度、速率限制、SLA（服务页 JS 渲染，公开文档无数字）。
- 千帆各 OCR 接口的单价（鉴权页无价格，各接口独立文档页未逐一抓取）。
- 百度官方 API 的 PDF 页数/文件大小上限（客户端源码未见限制常量，服务端限制未知）。
- PaddleOCR-VL 的 OmniDocBench 成绩为官方自述，无第三方复测。
- DocMind 文档智能解析的正文提取引擎是否为生成式（官方未明示）；其按量阶梯单价具体数字；PDF 页数上限。
- DocMind 文档智能解析在 arXiv 双栏学术论文上的阅读顺序与精度口碑（无公开基准）。
