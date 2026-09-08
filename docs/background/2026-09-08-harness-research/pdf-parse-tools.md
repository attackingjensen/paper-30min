# 调研：学术 PDF 开源解析工具盘点与适配评估

- 来源票据：[#41 论文作为代码库：工具化阅读协议与 L1/L2/L3 产物设计](https://github.com/attackingjensen/paper-30min/issues/41)（Wayfinder 父图：[#35](https://github.com/attackingjensen/paper-30min/issues/35)）
- 日期：2026-09-08（所有外部来源均查询于当日；star/最近推送时间经 GitHub API 当日核实）
- 分支：`research/pdf-parse-tools`
- 方法：文档级调研，未安装运行任何工具；所有事实均引一手来源（官方仓库、官方文档、论文摘要页）

## 结论摘要

**主推荐：Docling 作为 Windows 侧车转换器**——MIT 许可、官方支持 Windows、每个输出块自带 `prov`（页码+bbox，源码确认）、30 种块标签与我们的块模型几乎一一对应、正文文本来自 PDF 文本层（不生成、不幻觉），公式 LaTeX 是默认关闭的可选 enrichment。**备选/对照：MinerU pipeline 后端**——公开基准保真度最高、`content_list.json` 每块带 `page_idx`+`bbox`、官方明言纯 CPU 可跑且全离线，但许可证是自定义条款、部署更重。**中间路线成立但有限**：保留 pdf.js 自研文本层 + 仅引 pdffigures2 解决图表清单（JVM 侧车、2024-03 停更），公式继续占位；长期不如直接换 Docling。Nougat（无 bbox、权重 CC-BY-NC、停更）与 olmOCR（7B VLM、需 ≥12GB GPU、无块级 bbox）被硬需求直接淘汰；GROBID 因官方"Windows support is not ensured"不适合嵌入客户端；Marker 模型权重许可受限；PyMuPDF4LLM 与 PP-StructureV3 可作特定场景备选（前者 AGPL、零幻觉、最轻；后者模块全但 Paddle 栈重）。

---

## 一、目标数据组织（适配基准）

对照 Issue #41 背景中定义的三份产物：

- **(a) 块级 Markdown 文本层**：块 = 自然段 / 小节标题 / 图占位 / 表 / 公式 / 脚注，每块带 `kind`、`page`、`bbox` 出处；页眉页脚（furniture）剔除但可追回；双栏阅读顺序正确；无编号章节、附录不丢失。
- **(b) 图表清单**：`fig_{n}/tbl_{n}`：caption、page、bbox、归属节、裁切图。
- **(c) 参考文献清单**：`ref_{n}`：原文文本、被引用处。

硬需求：**每个输出块必须带页码与 bbox**（模型工具按地址抓取的根基）；哲学约束：**宁可占位不可编造**（ML 生成内容必须有裁切图/原文兜底，或降级为占位）。

## 二、逐工具事实

### 1. GROBID（kermitt2/grobid → 现 grobidOrg/grobid）

来源：https://github.com/grobidOrg/grobid （查询 2026-09-08）

- **输出结构**：TEI XML。题录元数据（标题、摘要、作者、机构、关键词）+ 全文（段落、节标题、参考文献与脚注引用点、图、表）+ **结构化参考文献列表**（68 个最终标签；参考文献解析与 CrossRef 对齐是其招牌能力）。坐标：提供"PDF coordinates for extracted information"，可基于"bounding boxes of the identified structures"生成交互式 PDF（经 pdfalto 的 Layout Tokens）。文本来自 PDF 文本层，非生成式。
- **双栏/公式**：官方页未单列双栏处理说明（布局 token 机制隐含处理）；**无公式→LaTeX 能力**（页面未提，已知短板）。
- **运行形态**：Java 库 + Web 服务 + Docker。构建需 OpenJDK 21；官方原文："Linux (64 bits) or macOS (Intel and ARM). Windows support is not ensured."。可选深度学习模型需 Python 3.10-3.11 + JEP + 可选 CUDA。默认 CRF 模型，纯 CPU。
- **许可证/活跃度**：Apache-2.0；5,119 star，4,177 commits，最近推送 2026-09-03，活跃。
- **适配判断**：参考文献清单 (c) 的业界标杆，但"Windows 支持不被保证"直接排除嵌入 Tauri 客户端的可能；部署 Java 服务做唯一一件事（参考文献）也过重。**淘汰（仅其参考文献思路可借鉴）。**

### 2. Docling（IBM，docling-project/docling）

来源：https://github.com/docling-project/docling ；标签枚举 https://github.com/docling-project/docling-core/blob/main/docling_core/types/doc/labels.py ；provenance 源码 https://github.com/docling-project/docling-core/blob/main/docling_core/types/doc/document.py ；enrichment 文档 https://docling-project.github.io/docling/usage/enrichments/ （均查询 2026-09-08）

- **输出结构**：Markdown / HTML / WebVTT / DocTags / 无损 JSON，统一 `DoclingDocument` 表示。官方宣称 PDF 结构理解覆盖"page layout, reading order, table structure, code, formulas, image classification"。`DocItemLabel` 枚举共 30 个值，含：`SECTION_HEADER`、`TEXT`、`PARAGRAPH`、`TITLE`、`LIST_ITEM`、`TABLE`、`PICTURE`、`CAPTION`、`FORMULA`、`FOOTNOTE`、`PAGE_HEADER`、`PAGE_FOOTER`、`REFERENCE`、`DOCUMENT_INDEX`、`CODE` 等——与目标块模型几乎一一对应；furniture（页眉页脚）作为独立标签存在，可剔除可追回。
- **页码+bbox（硬需求）**：✅ 源码确认。每个 `DocItem` 有 `prov: list[ProvenanceItem]`；`_serialize_prov` 逐字段输出 `prov.page_no, prov.bbox.l, prov.bbox.t, prov.bbox.r, prov.bbox.b, prov.bbox.coord_origin.value`；另有 `charspan` 字段（字符区间）。文档概念页确认"Layout information (i.e. bounding boxes) for all items, if available"与"Provenance information"。
- **公式**：可选 enrichment（`do_formula_enrichment=True` / `--enrich-formula`），用 CodeFormula 模型（HF: ds4sd/CodeFormula）"extract their LaTeX representation"，HTML 导出渲染为 MathML；**官方明言多数 enrichment 默认关闭**（省处理时间）。即：公式 LaTeX 是 ML 生成，默认不生成——与"宁可占位"哲学兼容（可开，但须配裁切图）。
- **运行形态**：Python 库（`pip install docling`，2.70.0 起需 Python 3.10+）；官方原文"Works on macOS, Linux and Windows environments for both x86_64 and arm64 architectures"、"Local execution capabilities for sensitive data and air-gapped environments"。形态：CLI、库、docling-serve API 服务、MCP server。模型：布局检测（docling-layout 系列）+ 可选 OCR + 可选 GraniteDocling-258M VLM；官方页未列 GPU 要求（CPU 可跑为其设计定位，但本次未抓到官方性能数字，速度需实测）。正文文本经 docling-parse 从 PDF 文本层提取，非生成式。
- **许可证/活跃度**：代码 MIT；66,132 star，最近推送 2026-09-07，非常活跃。
- **双栏保真度口碑**：OmniDocBench 端到端排行榜（见 §四）未含 Docling，公开端到端基准缺失；其布局模型在 DocLayNet（含双栏学术页）上训练。**风险点：arXiv 双栏实测需自行做样例验证。**
- **适配判断**：(a) 直接满足（标签映射 + prov）；(b) PICTURE/TABLE + 邻近 CAPTION 可组图清单，裁切图按 bbox 走 pdf.js；(c) 有 `REFERENCE` 标签但不做条目级结构化，需改造层按条目切分。**综合最优，主推荐。**

### 3. MinerU（OpenDataLab）

来源：https://github.com/opendatalab/MinerU ；输出文件文档 https://opendatalab.github.io/MinerU/reference/output_files/ ；论文摘要 https://arxiv.org/abs/2409.18839 （均查询 2026-09-08）

- **输出结构**：Markdown + 按阅读顺序排序的 JSON + 富中间格式。官方宣称：单栏/多栏/复杂布局阅读顺序；公式"Automatically recognize and convert formulas in the document to LaTeX format"；表格转 HTML；"Remove headers, footers, footnotes, page numbers, etc., to ensure semantic coherence"；提取图片、图注、表标题、脚注。
- **页码+bbox（硬需求）**：✅ 文档确认。`content_list.json`："All content blocks include a `page_idx` field indicating the page number (starting from 0)"和"a `bbox` field representing the bounding box coordinates of the content block [x0, y0, x1, y1], mapped to a range of 0-1000"（归一化坐标，需按页尺寸换算）。块类型：`text`（`text_level`=1/2 标记一二级标题）、`image`（`img_path`、`image_caption`、`image_footnote`）、`table`（`img_path`、`table_caption`、`table_footnote`、`table_body` 为 HTML 字符串）、`equation`（`img_path`、`text`、`text_format: "latex"`）、`code`、`list`；**家具类进 `discarded` 块**：`header`、`footer`、`page_number`、`aside_text`、`page_footnote`（剔除但可追回）。`middle.json` 提供页→块→行→span 四级像素级 bbox 层级。
- **运行形态**：Python 3.10-3.13（Windows 限 3.10-3.12，因依赖 ray）。官方原文："Supports running in a pure CPU environment, and also supports GPU/MPS acceleration"、"Compatible with Windows, Linux, and Mac platforms"、支持"Private · Fully Offline"部署。VRAM 下限：pipeline 4GB / vlm、hybrid 8GB（GPU 为 Volta+ 或 Apple Silicon）。当前模型：OCR 升至 PP-OCRv6，VLM 为 MinerU2.5-Pro-2605-1.2B；pipeline 后端为布局检测+公式识别+OCR 组合（检测/识别式，正文不生成；公式 LaTeX 仍属识别模型输出，有误差风险，配 `img_path` 裁切图兜底）。论文摘要自述"leverages the sophisticated PDF-Extract-Kit models"+"finely-tuned preprocessing and postprocessing rules"。
- **许可证/活跃度**：已从 AGPLv3 迁到"MinerU Open Source License"（"based on Apache 2.0 with additional conditions"），GitHub API 显示 NOASSERTION（自定义许可，**条款需逐条读**）；79,423 star，最近推送 2026-09-07，v3.4（2026-06-18）。
- **保真度口碑**：OmniDocBench（见 §四）端到端：MinerU2.5-Pro 总榜第 2（95.75），MinerU-Pipeline 86.47（第 25）。
- **适配判断**：(a)(b) 直接满足且块类型映射最省事；(c) 无参考文献条目结构化。**强备选；许可证与部署重量是主要减分项。**

### 4. Marker（datalab-to/marker）

来源：https://github.com/datalab-to/marker （查询 2026-09-08）

- **输出结构**：Markdown / JSON / chunks / HTML。处理"tables, forms, equations, inline math, links, references, and code blocks"；"Extracts and saves images"；"Removes headers/footers/other artifacts"。内联数学自动转 LaTeX（balanced 模式），行间公式以 `$$` 围栏进 Markdown。块有类型（SectionHeader、Table、Figure、Equation、ListItem）与节层级（1=h1、2=h2……）。
- **页码+bbox**：✅ JSON 为按页数组（每页含块列表）；块有 `id`、`block_type`、`html`、`children`、`polygon`（页内四角坐标）；`table_of_contents` 每条带 `page_id`+`polygon`；`--paginate_output` 可在 Markdown 中插页码。
- **双栏口碑**：官方自测"Multi column"档 balanced 模式 76.6 分；OmniDocBench 端到端榜 Marker 78.44，在 32 个参评模型中垫底（§四）。
- **运行形态**：Python 3.10+ / PyTorch；GPU、CPU、MPS 均可，全本地。布局/OCR/表格识别统一走单个 surya VLM（NVIDIA 走 vLLM，CPU/Apple Silicon 走 llama.cpp）；fast 模式用 20M rf-detr 布局模型；`--disable_ocr` 可纯文本层提取（不经 VLM）。模型权重需下载，离线可跑。
- **许可证/活跃度**：代码 Apache-2.0；**模型权重为修改版 AI Pubs Open Rail-M——仅研究/个人/融资或营收 <$5M 的初创免费，更大商用需付费**。39,581 star，最近推送 2026-08-31。
- **适配判断**：功能覆盖好，但权重许可对"随客户端分发"构成实质障碍；OmniDocBench 垫底且 VLM 路径为生成式（幻觉风险，`--disable_ocr` 可规避但退化为纯文本层）。**不推荐。**

### 5. PyMuPDF4LLM（pymupdf/PyMuPDF4LLM）

来源：https://github.com/pymupdf/PyMuPDF4LLM （查询 2026-09-08）

- **输出结构**：结构化 Markdown / JSON / 纯文本，面向 LLM/RAG。"Reconstructs natural reading order across single and multi-column pages"；表格转 GitHub 兼容 Markdown（可选 `table_output="html"`）；图片提取并内联引用，检测矢量图；标题按字号映射 `#` 级；"Configurable exclusion of repetitive page headers and footers"。**无公式→LaTeX**（官方页未提该能力）。
- **页码+bbox**：✅ `page_chunks=True` 返回按页 dict（metadata 含页码、总页数、toc_items、page_boxes）；JSON 输出"Returns bounding box info, layout data, and text per element"。
- **运行形态**：纯 Python，构建于 MuPDF C 引擎；"No GPU, no Cloud, no Tokens required"，全离线。无生成式模型——文本全部来自 PDF 文本层，**零幻觉**（布局模式有一个分组置信度阈值参数，OCR 走 Tesseract/rapidocr，可选）。
- **许可证/活跃度**：**AGPL-3.0**（Artifex 另有商业许可）；2,161 star，最近推送 2026-09-07。
- **适配判断**：技术上是最接近"自研启发式的工业化版本"的工具（确定性、带 bbox、处理双栏与 furniture），且部署最轻；但无公式/无表格结构之外的语义标签（无 footnote 类型、无图表 caption 归属），且 AGPL 对分发不友好（需法务评估或购买商业许可）。**特定场景备选；许可证决定可行性。**

### 6. Nougat（Meta，facebookresearch/nougat）

来源：https://github.com/facebookresearch/nougat （查询 2026-09-08）

- **输出结构**：每篇 PDF 输出一个 `.mmd`（Mathpix Markdown 兼容），LaTeX 数学与表格；训练于 arXiv+PMC。**无页码、无 bbox——整文档连续标记流，硬需求直接不满足。**
- **幻觉风险**：生成式视觉模型；官方页记录 `[MISSING_PAGE]` 失败检测（说明存在需检测的生成失败模式），建议 `--no-skipping` 兜底。英文最佳，中日俄不支持。
- **运行形态**：Python/PyTorch；模型 0.1.0-small（默认）/0.1.0-base，首次运行自动下载；CPU 可跑（慢）。
- **许可证/活跃度**：代码 MIT，**权重 CC-BY-NC（非商用）**；10,071 star，最近推送 **2025-02-21，基本停更**。
- **适配判断**：无 bbox + 非商用权重 + 停更 + 生成式幻觉，四重淘汰。

### 7. PaddleOCR / PP-StructureV3（PaddlePaddle）

来源：https://github.com/PaddlePaddle/PaddleOCR ；PP-StructureV3 文档 https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html （均查询 2026-09-08）

- **输出结构**：七个模块的管线（布局检测、通用 OCR、文档预处理、表格识别、印章识别、**公式识别**、图表解析），Markdown/JSON 输出。公式识别可选 PP-FormulaNet-S（默认建议，224MB）/ UniMERNet（1.5GB）/ LaTeX_OCR；表格识别 SLANeXt_wired/wireless（351MB）+ 单元格检测；图表解析 PP-Chart2Table（0.58B）。官方称比 PaddleOCR-VL 提供"more fine-grained coordinate information, including table cell coordinates, text coordinates"。
- **页码+bbox**：✅ JSON 顶层有 `page_index`；每布局块带 `label`、`score`、`coordinate: [x0,y0,x1,y1]`（文档示例值）；OCR 结果另有 `dt_polys`、`rec_boxes`。
- **运行形态**：Python + PaddlePaddle（Python 3.8-3.12，Linux/Windows/macOS；CPU/GPU/XPU/NPU……）；模型总下载量为 GB 级（官方警告默认模型大、"inference speed may be slow"，建议换轻量模型）；有服务化部署方案。
- **许可证/活跃度**：Apache-2.0；89,064 star，最近推送 2026-07-22。
- **适配判断**：模块覆盖最全（公式识别模型选择多、表格结构强、坐标细到单元格），但 Paddle 栈在 Tauri 侧车语境下最重，文档以中文 RAG 场景为主，学术论文端到端口碑弱于 MinerU/Docling。**备选池保留，不推荐首选。**

### 8. Unstructured（Unstructured-IO/unstructured）

来源：https://github.com/Unstructured-IO/unstructured ；元素类型/元数据文档 https://docs.unstructured.io/ui/document-elements （均查询 2026-09-08）

- **输出结构**：`partition_pdf` 分区。元素类型含 `Title`、`NarrativeText`、`ListItem`、`Table`、`Image`、`Header`、`Footer`、`Formula`、`PageBreak`、`UncategorizedText` 等；**文档元素类型表中无 `Footnote` 类型**（脚注无独立类型）。
- **页码+bbox**：✅ 元数据含 `page_number`（限 PDF/DOCX/PPT/XLSX 等）；`coordinates`（`points` 自左上角逆时针四角 + 坐标系 layout width/height）——"Some file types support location data"，按策略有条件出现（hi_res 有，fast 策略不一定）。
- **运行形态**：Python；系统依赖重：libmagic、poppler-utils、tesseract-ocr、libreoffice（MS Office）；Docker 多平台。hi_res 策略需布局检测模型（本次未抓到官方页确认具体模型与 GPU 要求，存疑待查）。
- **许可证/活跃度**：Apache-2.0；15,404 star，最近推送 2026-09-05。
- **适配判断**：元素类型偏通用文档（无脚注类型、公式仅识别为元素不转 LaTeX），学术双栏精度口碑不突出，系统依赖链长。**不推荐。**

### 9. 补充：olmOCR（Allen AI）——淘汰

来源：https://raw.githubusercontent.com/allenai/olmocr/main/README.md （查询 2026-09-08）

7B 参数 VLM（当前 `allenai/olmOCR-2-7B-1025-FP8`），"requires a GPU"、"at least 12 GB of GPU RAM"+30GB 磁盘，vLLM 推理。输出 Markdown（公式/表格/多栏阅读顺序、自动去页眉页脚），**未提供块级 bbox**。olmOCR-Bench 82.4±1.1（自称近榜首），Apache-2.0，19,445 star，最近推送 2026-03-25。GPU 硬要求 + 无块级 bbox + 生成式幻觉风险：**淘汰**。

### 10. 补充：pdffigures2（Allen AI）——图表清单单点工具

来源：https://raw.githubusercontent.com/allenai/pdffigures2/master/README.md ；GitHub API（查询 2026-09-08）

- Scala/JVM 工具，从学术 PDF"extract figures, captions, tables and section titles"；不经 OCR（PDFBox 文本抽取，确定性）。每个图形对象输出：页码（0 起）、图形 bbox（左上角原点、72dpi 像素）、图内文本、**caption 文本与 caption bbox**、编号名、Table/Figure 分类标签；可输出光栅裁切图（pdftocairo 可出矢量）。
- 已知失败模式：旋转文本、L 形图、caption 与图同行；自称在计算机科学论文上测试，领域外未充分测试。
- Apache-2.0；757 star，**最近推送 2024-03-10（停更但功能稳定）**。
- **适配判断**：恰好只做 (b) 图表清单，且确定性、带 bbox+caption——是"中间路线"的最小增量部件；代价是引入 JVM 侧车。

## 三、能力对照表

| 工具 | 块级 page+bbox | 节/段结构 | 双栏阅读顺序 | furniture 剔除 | 脚注 | 公式→LaTeX | 表格结构化 | 图(bbox+caption) | 参考文献清单 | 正文幻觉风险 | Windows 离线嵌入 | 许可证 | 活跃度 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GROBID | ✅ TEI coords | ✅ | 隐含(布局token) | ✅ | ✅ | ❌ | 部分 | 部分(caption) | ✅✅ 招牌 | 无(非生成) | ❌ 官方不保证 Windows | Apache-2.0 | 活跃(2026-09) |
| **Docling** | ✅ prov(page_no+bbox+charspan) | ✅ 30 标签 | ✅ | ✅ PAGE_HEADER/FOOTER 标签 | ✅ FOOTNOTE 标签 | 可选 enrichment(默认关) | ✅ table structure | ✅ PICTURE+CAPTION | 仅 REFERENCE 标签,需切分 | 正文无;公式LaTeX为ML(可关) | ✅ 官方支持 | MIT | 很活跃(2026-09-07) |
| **MinerU** | ✅ page_idx+bbox(0-1000); middle.json 像素级 | ✅ text_level | ✅ | ✅ discarded 块可追回 | ✅ page_footnote | ✅(识别模型,配裁切图) | ✅ HTML | ✅ image+image_caption | ❌ 需规则 | pipeline 低;VLM 后端生成式 | ✅ 官方支持,纯CPU可跑 | 自定义(Apache 2.0+附加条件) | 很活跃(v3.4, 2026-06) |
| Marker | ✅ 按页 JSON+polygon | ✅ 节层级 | 自测多栏 76.6;OmniDocBench 垫底 | ✅ | 未单列 | ✅(VLM 生成) | ✅ | ✅ | ❌ | VLM 路径生成式;--disable_ocr 规避 | ⚠️ 权重许可限制分发 | 代码 Apache-2.0/权重受限 | 活跃(2026-08) |
| PyMuPDF4LLM | ✅ page_chunks+JSON bbox | 标题按字号 | ✅ | ✅ 可配置 | 无独立类型 | ❌ | ✅ MD/HTML | 提取嵌入图(无 caption 归属) | ❌ | 无(零幻觉) | ✅ 最轻 | **AGPL-3.0** | 活跃(2026-09-07) |
| Nougat | ❌ 无 | 连续流 | 训练内含 | ❌ | ❌ | ✅(生成式) | 生成式 | ❌ | ❌ | **高(生成式)** | 可但慢 | 代码 MIT/权重 **CC-BY-NC** | 停更(2025-02) |
| PP-StructureV3 | ✅ page_index+coordinate | ✅ | ✅ | ✅ | 未单列 | ✅ 多模型可选 | ✅ 到单元格 | ✅ | ❌ | 识别式,低-中 | ⚠️ 栈重(GB 级模型) | Apache-2.0 | 活跃(2026-07) |
| Unstructured | ⚠️ 有条件(hi_res) | 通用文档类型 | 一般 | ✅ Header/Footer | ❌ 无脚注类型 | ❌(仅元素识别) | 有 | 有(无 caption 归属) | ❌ | 低 | ⚠️ 系统依赖链长 | Apache-2.0 | 活跃(2026-09) |
| olmOCR | ❌ 块级无 | 有(生成) | ✅ | ✅ | 未单列 | ✅(生成式) | 生成式 | ❌ | ❌ | **高(7B VLM)** | ❌ 需 ≥12GB GPU | Apache-2.0 | 中等(2026-03) |
| pdffigures2 | ✅ 图/表 page+bbox+caption | 仅节标题 | — | — | — | ❌ | 仅定位+caption | ✅✅ 专项 | ❌ | 无(确定性) | ⚠️ 需 JVM | Apache-2.0 | 停更(2024-03) |

## 四、保真度口碑（双栏学术论文）

唯一抓到的公开端到端基准是 **OmniDocBench**（https://github.com/opendatalab/OmniDocBench ，论文 https://arxiv.org/abs/2412.07626 ，CVPR2025 接收；查询 2026-09-08）。其 v1.6_full 端到端榜（32 个模型，Overall = 文本/阅读顺序/表格/公式综合）：

| 排名 | 模型 | Overall↑ | 文本编辑距离↓ | 阅读顺序编辑距离↓ | 表格 TEDS↑ | 公式 CDM↑ |
|---|---|---|---|---|---|---|
| 2 | MinerU2.5-Pro | 95.75 | 0.036 | 0.120 | 93.42 | 97.45 |
| 12 | MinerU-2.5 | 93.04 | 0.045 | 0.130 | 87.88 | 95.77 |
| 25 | MinerU-Pipeline | 86.47 | 0.055 | 0.153 | 81.88 | 83.07 |
| 32(末) | Marker | 78.44 | 0.157 | 0.243 | 65.77 | 85.24 |

**重要保留**：OmniDocBench 与 MinerU 同属 OpenDataLab，存在利益相关性；Docling、PP-StructureV3、Nougat、GOT-OCR 未出现在端到端榜（仅模型信息或组件级表）。因此该榜只能说明"MinerU 系 > Marker"这一相对关系与 MinerU 的绝对水平，**不能用来证明 Docling 弱**——Docling 缺公开端到端数据，arXiv 双栏实测样例验证是落地前的必要步骤。

关于"幻觉"分层（对照"宁可占位不可编造"）：

- **正文文本**：GROBID、Docling、MinerU pipeline 后端、PyMuPDF4LLM、pdffigures2、Unstructured 均从 PDF 文本层提取或做检测/识别式处理，不会编造正文；风险限于漏字、错序、OCR 误识（扫描件）。
- **公式 LaTeX**：所有工具均为 ML 识别/生成（Docling CodeFormula、MinerU MFR、PP-FormulaNet、Marker/Nougat/olmOCR 生成式），存在符号级错误甚至幻觉。缓解：公式块一律同时保留 `img_path` 裁切图（MinerU/Docling 均支持），消费侧以图为准、LaTeX 为辅；或默认占位（Docling enrichment 默认即关）。
- **整页生成式**（Nougat、olmOCR、MinerU VLM 后端、Marker VLM 路径）：与项目哲学冲突，不作为默认路径。

## 五、适配评估与组合可能性

对照三份产物：

- **(a) 块级 MD + page+bbox**：Docling（prov 完备、标签对应）与 MinerU（content_list/middle.json 双粒度）均可经**纯映射**产出，无需改模型；其余工具缺脚注类型（Unstructured）、缺公式（PyMuPDF4LLM）、缺 bbox（Nougat/olmOCR）或缺 Windows（GROBID）。
- **(b) 图表清单**：MinerU 最现成（image/table 块自带 caption 与裁切图路径）；Docling 需将 PICTURE/TABLE 与邻近 CAPTION 分组（小改造）；pdffigures2 单点最强（caption bbox 直接给、Table/Figure 分类）但只解此一件事。
- **(c) 参考文献清单**：**没有工具在 Windows 离线客户端内现成解决**。GROBID 是唯一条目级标杆但排除；Docling 有 REFERENCE 标签、MinerU 有 list 子类型，均需改造层做"References 节定位 → 条目切分 → 正文引用点正则匹配（[n] / author-year）"。这是任何方案都逃不掉的自研部分（工作量可控，规则化、零幻觉）。
- **组合方案**："文本层用 Docling、图表用 pdffigures2"不划算（Docling 已给图表 bbox+caption，再引 JVM 不值）；"文本用 MinerU、参考文献用 GROBID"受 Windows 限制不可行。**结论：单一主线工具 + 自研参考文献规则层**优于组合。
- **中间路线（保留 pdf.js 自研 + 仅引库解图表/公式）**：成立。最小形态 = 现状自研文本层 + pdffigures2 侧车出图表清单 + 公式继续占位（符合哲学）。它止血最快（不动文本层），但双栏/页眉页脚/无编号节的规则债仍在，且 JVM 侧车部署不轻；一旦后续还要公式 LaTeX，仍需再引 Docling/MinerU 级工具。定位为**过渡方案**，不是终点。

## 六、推荐方案

### 方案 A（主推荐）：Docling 侧车 + 自研参考文献规则层

- **改造层**：
  1. **打包**：Docling 冻结为 Windows 侧车（PyInstaller/uv 嵌入式 Python + 模型随包或首启下载），Rust 侧以子进程 JSON 进出；离线默认（Docling 官方支持 air-gapped）。
  2. **块映射**：`DoclingDocument` JSON → 块模型。`SECTION_HEADER→heading`（层级取 section level）、`TEXT/PARAGRAPH→para`、`FORMULA→formula`、`TABLE→table`（结构转 MD/HTML）、`PICTURE→figure 占位`、`FOOTNOTE→footnote`、`CAPTION` 并入所属 fig/tbl、`PAGE_HEADER/PAGE_FOOTER` 进 furniture 桶（剔除但保留可追回）。
  3. **provenance 换算**：`prov[0].page_no` + `bbox(l,t,r,b,coord_origin)` 统一到与 pdf.js 视口一致的坐标系（需一个样例验证脚本，对照页图像素）。
  4. **图表清单**：按 (kind, 页内 y) 聚类 PICTURE/TABLE 与 CAPTION → `fig_{n}/tbl_{n}`；归属节 = 最近前驱 `SECTION_HEADER`；裁切图由现有 pdf.js 页渲染管线按 bbox 裁（保持与阅读视图同源）。
  5. **参考文献清单**：定位末节 References/参考文献 → 条目切分 → 正文 `[n]`/author-year 引用点扫描（纯规则）。
  6. **公式策略**：默认 enrichment 关闭（占位 + 裁切图）；设置项开启 CodeFormula 时，LaTeX 与裁切图同时存，UI 以图为准。
- **主要风险**：① arXiv 双栏无公开端到端基准，需自测样例集（可用现 parser.js 已踩坑的论文做回归对照）；② Python 侧车使安装包增大（模型量级百 MB 级，官方未给总下载量数字，需实测）；③ CPU 速度未量化，批量导入体验待测；④ 公式 LaTeX 为 ML 输出（有兜底策略）。
- **对自研基线的取舍**：放弃的是"零依赖、完全可控"；换来的是 furniture/双栏/阅读顺序/脚注/表格结构/公式占位这些止血规则**整体退役**，且标签体系官方维护。保留的是参考文献规则层与裁切图管线（pdf.js 页图本就在范围内）。

### 方案 B（备选/对照）：MinerU pipeline 后端侧车

- **改造层**：与方案 A 同构但更薄——`content_list.json` 的块类型（text/text_level、image+image_caption、table+table_caption+table_body、equation+text_format、discarded）几乎就是目标 kind 枚举；bbox 0-1000 归一化需乘页尺寸；参考文献同样需自研规则层。坚持用 pipeline 后端（检测/识别式），不用 VLM 后端以规避生成式幻觉。
- **主要风险**：① 自定义许可证（"based on Apache 2.0 with additional conditions"，GitHub 标 NOASSERTION）须逐条审阅，分发客户端前必须过法务；② 部署最重（torch + 多模型，VRAM 下限 pipeline 4GB/纯 CPU 可跑但慢）；③ 公式 LaTeX 为识别模型输出（有 `img_path` 裁切图兜底）。
- **对自研基线的取舍**：保真度上限最高（OmniDocBench 数据支持），块映射最省；代价是许可不确定性与安装体积。若方案 A 的 arXiv 实测不达标，MinerU 是顺位替换。

### 不作为推荐但记录：中间路线（自研文本层 + pdffigures2）

若近期只想解图表清单而不动文本层：pdffigures2（JAR 侧车）给 `fig_{n}/tbl_{n}` 的 page+bbox+caption+裁切，公式维持占位。止血最快，但规则债保留、JVM 侧车不轻、上游 2024-03 停更；建议仅在方案 A 落地周期不可接受时采用，并预设迁移到 A。

## 七、落地前验证清单（建议）

1. 取 parser.js 历史踩坑论文集（双栏、无编号 Conclusion、附录、脚注密集、公式表格密集各若干），跑 Docling 默认管线，人工核对：阅读顺序、 furniture 剔除、prov 坐标与 pdf.js 页图对齐误差、无编号节是否存活。
2. 实测 CPU 单篇转换耗时与安装包增量（含模型）。
3. 若 Docling 文本层不达标，同一样例集跑 MinerU pipeline 后端对照（同时启动许可证条款审阅）。

---

### 来源清单（均查询于 2026-09-08）

- GROBID：https://github.com/grobidOrg/grobid
- Docling：https://github.com/docling-project/docling ；标签：https://github.com/docling-project/docling-core/blob/main/docling_core/types/doc/labels.py ；provenance：https://github.com/docling-project/docling-core/blob/main/docling_core/types/doc/document.py ；enrichment：https://docling-project.github.io/docling/usage/enrichments/ ；概念：https://docling-project.github.io/docling/concepts/docling_document/
- MinerU：https://github.com/opendatalab/MinerU ；输出文档：https://opendatalab.github.io/MinerU/reference/output_files/ ；论文：https://arxiv.org/abs/2409.18839
- Marker：https://github.com/datalab-to/marker
- PyMuPDF4LLM：https://github.com/pymupdf/PyMuPDF4LLM
- Nougat：https://github.com/facebookresearch/nougat
- PP-StructureV3：https://github.com/PaddlePaddle/PaddleOCR ；https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html
- Unstructured：https://github.com/Unstructured-IO/unstructured ；https://docs.unstructured.io/ui/document-elements
- olmOCR：https://raw.githubusercontent.com/allenai/olmocr/main/README.md
- pdffigures2：https://raw.githubusercontent.com/allenai/pdffigures2/master/README.md （许可证/活跃度经 GitHub API 核实）
- OmniDocBench：https://github.com/opendatalab/OmniDocBench ；https://arxiv.org/abs/2412.07626
- star 数/最近推送/许可证标识：GitHub REST API（`repos/{owner}/{repo}`），2026-09-08 查询

### 本次未能一手确认、标记存疑的点

- Docling 在 arXiv 双栏上的端到端公开基准（缺失，需自测）。
- Docling 模型总下载体积与 CPU 转换速度（官方页未给数字）。
- Unstructured hi_res 策略所用布局检测模型与 GPU 要求（官方文档页本次抓取超时）。
- PP-StructureV3 Markdown 输出中公式是否以 LaTeX、表格是否以 HTML 内联（文档列了 `save_to_markdown()` 与 `format_block_content`，未明示内联格式）。
