# 验证：Docling 侧车回归实测 + 百度云端 API 对照（#46）

- 来源票据：[#46 验证：Docling 侧车回归实测](https://github.com/attackingjensen/paper-30min/issues/46)（Wayfinder 父图：[#35](https://github.com/attackingjensen/paper-30min/issues/35)）
- 日期：2026-09-09（全部实测于当日完成）
- 方法：实机运行。Docling 2.126.0（pip 安装，默认管线 StandardPdfPipeline：布局模型 docling-layout-heron + TableFormer，公式 enrichment 关闭，OCR 仅对无文本层页触发——本集全部为文本层 PDF，未触发）；百度星河社区官方 API（PP-StructureV3 与 PaddleOCR-VL-1.6 两模型，REST 异步任务，Token 在 `.local/paddleocr.json`）
- 测试机：Windows 11 x64，13th Gen Intel Core i5-13500H，32GB RAM，纯 CPU
- 原始数据与脚本：`.local/wayfinder/issue-46/`（git-excluded；含论文 PDF、全部 JSON 结果、覆盖图、度量脚本与 metrics/*.json）

## 结论摘要

**Docling 侧车通过全部验收项，维持 #41 的主推荐（方案 A）落地。** 四类历史踩坑形态（双栏、无编号/罗马/带句点编号、附录、脚注）全部正确解析；prov 坐标与 pdf.js 页帧经传递验证对齐良好（词覆盖 94–97%，块贴合误差中位 1–3pt）；CPU 速度 3.0–10.1 秒/页可接受；成本为一次性 ~2GB 磁盘（随包）或首启 ~0.9GB 下载。

**云端对照（百度官方 API）结果**：PP-StructureV3 正文 OCR 质量好（正文块字符相似度 0.82，且主要损耗是"行内公式转 LaTeX"这种表征升级而非误识），但**块坐标帧与 PDF 页面真帧存在系统性偏移**（紧框标题块完全错位，随页内位置非线性变化，无文档可依），不能直接用于裁切图/对照定位；PaddleOCR-VL-1.6 正文质量与 PP 相当（0.83），但**整篇提交被静默截断为 1/3 分片（extractedPages 虚报齐全）**，须客户端分段提交绕过，且正文为生成式。按 #46 的翻盘判据（误差不触及公式/表格数字/引用编号才可翻盘），**PaddleOCR-VL 不翻盘**，维持"生成式 VLM 不进地基"决议。**云端 PP-StructureV3 保留为降级预案第二顺位（BYOK、可选加速器），MinerU 本地侧车审阅不启动**（Docling 达标，无需降级）。

## 一、踩坑论文集与 parser.js 基线

10 篇 arXiv CS/AI 论文（155 页），下载于 2026-09-09；每篇先跑现行 parser.js（`tools/check_parser.mjs`）确认踩坑症状：

| arXiv | 论文 | 版式 | 坑位类别 | parser.js 基线症状 |
|---|---|---|---|---|
| 1706.03762 | Attention Is All You Need | NeurIPS 单栏编号 | 公式表格密集（对照基线） | 正常：7 节全检出 |
| 1412.6980 | Adam | ICLR 编号 | 公式密集、附录 | 标题乱码 "A : A M S O"（小型大写） |
| 1503.02531 | Distilling the Knowledge in a NN (Hinton) | NIPS workshop | 无 Conclusion 节 | conclusion=0（本文确无结论节） |
| 1512.03385 | ResNet | CVPR 双栏 | 双栏、脚注密集 | 页脚脚注混入正文流 |
| 1603.02754 | XGBoost | ACM 双栏 | 双栏、附录 | REFERENCES 被当正文 part；附录被吞 |
| 1608.08225 | Why does deep and cheap learning work so well | Phys Rev 罗马双栏 | 脚注密集、罗马编号 | parts=[]：罗马数字标题全灭 |
| 1610.00633 | Deep RL for Robotic Manipulation (NAF) | IEEE 罗马双栏 | 双栏、罗马编号、附录 | parts=[]：全灭 |
| 1712.01815 | AlphaZero（Science 版） | Science 无编号双栏 | 无编号论文 | exit=1：abstract 吞 17K 字符，introduction 未检出 |
| 1810.04805 | BERT | NAACL 双栏 | 双栏、"1." 带句点编号、附录 | parts=[]：带句点编号全灭 |
| 2106.09685 | LoRA | ICLR 编号 | 附录、标题乱码 | 标题乱码 "L RA: L -R A..."；附录节混入正文 parts |

五类坑位覆盖：双栏 ×5（1512/1603/1610/1712/1810）、无编号或编号变体 ×4、附录 ×5（1412/1603/1610/1810/2106）、脚注密集 ×2（1512 实有 6 条、1608 PhysRev 上标引用制）、公式表格密集 ×3（1412/1706/2106）。

## 二、回归实测（Docling 默认管线）

**10/10 全部转换成功，零异常。**

### 2.1 节存活（无编号/罗马/带句点/附录）

parser.js 全灭的四篇，Docling 全部检出为 `section_header`：

- **1712.01815（Science 无编号）**：Abstract、Methods、Anatomy of a Computer Chess Program 等全部 12 个小节检出。
- **1608.08225（Phys Rev 罗马）**：I.–IV. 主节 + A.–H. 小节 + "Appendix A: The polynomial no-flattening theorem" 全部检出。
- **1610.00633（IEEE 罗马）**：I.–VII. + A.–C. 小节 + ACKNOWLEDGEMENTS + REFERENCES 全部检出。
- **1810.04805（BERT，"1." 带句点）**：1–6 节 + 全部小节 + **附录 A–C 全部层级**（A.1–A.5、B.1、C.1–C.2）检出。
- **1603.02754（XGBoost）**：APPENDIX + A. WEIGHTED QUANTILE SKETCH + A.1–A.4 检出（parser.js 曾将其吞入 REFERENCES part）。
- 2106.09685 标题正确还原为 "LORA: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS"（parser.js 乱码修复）。

已知轻微噪声：1706.03762 附录区图题（"Attention Visualizations Input-Input Layer5"）有 3 条被误判为 section_header，需在改造层按位置/字号过滤。

### 2.2 furniture（页眉页脚）剔除

每页页眉/页脚被稳定打上 `page_header`/`page_footer` 标签（如 Adam 15 页 = 15 header + 15 footer），**markdown 导出默认剔除**（实测 "arXiv:1706.03762…" 条纹 0 次进入 md），JSON 中保留可追回。例外：1412.6980 第 1 页的特殊声明行（"Published as a conference paper at ICLR 2017"）被标为 footnote 而非 footer，md 中出现 1 次——属可接受误标（该行人本身就是脚注性质）。

### 2.3 prov 坐标与 pdf.js 页图对齐

方法（传递验证）：

1. **pdf.js ↔ poppler 坐标系一致性抽查**（`check_pdfjs_coords.mjs`，1512.03385 p2、1712.01815 p1）：同名文本项水平起点中位差 = 0（浮点零），竖直方向为系统性 baseline-vs-字框顶差（6.8–8.1pt，≈字号 0.7 倍，符合预期）。即 poppler 文本层词框 ≡ pdf.js 视口坐标。
2. **Docling prov ↔ poppler 词框**（`prov_check.py`，全 10 篇）：正文类块的词覆盖率 **85.9%–97.9%**（中位 95%）；块框贴合度：平均外扩 0.6–2.6pt、内欠 0.3–3.2pt（亚行高）。未覆盖词主要为图内矢量文字（图块单独成块、不参与正文覆盖）。
3. **覆盖图目检**（`overlay.py`，4 篇代表页）：1512.03385 p1 / 1610.00633 p1 / 1712.01815 p1 / 1706.03762 p3 的块框与页图逐块贴合，arXiv 竖排水印条正确归入 furniture。

**结论：prov 可直接驱动按 bbox 裁切页图（pdf.js scale=2 与 144dpi 一致）与对照阅读定位。**

### 2.4 阅读顺序与双栏

- 双栏阅读顺序抽验（1512.03385 p2 全文 dumps + 覆盖图编号）：左栏→右栏→跨栏元素序正确，无栏间串行。
- 控制组文本保真：Docling 块文本与 PDF 文本层空间逐块 diff（`diff_spatial.py`，块 bbox∩词框=区域真值）加权相似度 **0.962**（n=4224 块）；其中正文 0.929、标题 0.996、图表标题 0.997、脚注 0.991（残余差异为段落合并边界与表格单元格展平顺序，非文本错误）。**正文零幻觉确认。**
- 表格 0.639 是"单元格文本展平 vs 文本层流"的度量伪影，不代表表格结构错误（结构由 TableFormer 单独输出）。

### 2.5 已知缺口（改造层须兜）

- **参考文献条目的 [n] 编号被吞**：Docling 把参考文献条目识别为 `list_item` 并丢弃 "[n]" 前缀（1706.03762 实测 37 条只剩作者-标题文本）。条目顺序保留，改造层按序补号即可（#41 的自研参考文献规则层本就要做条目切分）。
- 文内上标引用 `[41]` 等在正文块中**原样保留**（抽验 1512.03385/1706.03762 确认）。
- 表格单元格碎片会以独立小 text 块出现在 texts 流中（如 "plain-18"），映射层应优先消费 tables 集合的结构化输出。

## 三、成本实测

### 3.1 CPU 转换耗时（i5-13500H，默认管线，模型已缓存）

| 论文 | 页数 | 耗时(s) | 秒/页 |
|---|---|---|---|
| 1412.6980 | 15 | 109.4 | 7.3 |
| 1503.02531 | 9 | 51.7 | 5.7 |
| 1512.03385 | 12 | 88.9 | 7.4 |
| 1603.02754 | 13 | 131.8 | 10.1 |
| 1608.08225 | 16 | 80.4 | 5.0 |
| 1610.00633 | 9 | 35.8 | 4.0 |
| 1706.03762 | 15 | 70.4 | 4.7 |
| 1712.01815 | 19 | 57.5 | 3.0 |
| 1810.04805 | 16 | 66.3 | 4.1 |
| 2106.09685 | 26 | 176.3 | 6.8 |

**均值 5.6 s/页，单篇 36–176s（中位 ~75s）**。导入为一次性后台任务，可接受；批量导入需排队展示（任务中心已有能力）。

### 3.2 安装包增量（两案）

实测数字：

- venv 全量安装落盘 **1.5GB**（site-packages：torch 541MB、scipy 118MB、transformers 114MB、cv2 113MB、sympy 79MB、pandas 70MB、rapidocr 63MB、docling-parse 37MB……）。
- HF 模型缓存 **506MB**（docling-layout-heron + tableformer accurate/fast 等）。
- pip 下载侧压缩缓存 **357MB**（wheel 压缩包，有少量未缓存项，为下界）。

两案估算（Windows 安装包增量）：

- **随包方案**：嵌入式 Python（~40MB）+ 精简后 site-packages（去 `__pycache__`/tests/调试符号，估 0.9–1.1GB）+ 模型 506MB；NSIS/7z 压缩后安装包增量约 **+0.8–1.0GB**。离线可用、首启零等待。
- **首启下载方案**：安装包增量仅嵌入式 Python + 下载器（**~50MB**），首次导入时在线拉取 pip 依赖（≥357MB 压缩）+ 模型（506MB）≈ **0.9GB 下载**。**风险：HuggingFace 直连在本测试网络被 DNS 污染阻断，须走 hf-mirror 镜像（已实测可用）或自建分发**；这与"离线即全灭"的产品约束冲突，仅适合作为可选通道。

建议：默认随包（图书馆场景离线优先），首启下载做打包时的可选项。

## 四、三方云端对照（百度星河社区 PaddleOCR 官方 API）

同集合同测：PP-StructureV3（检测/识别式管线）与 PaddleOCR-VL-1.6（0.9B 生成式 VLM）。REST 异步任务：POST `/api/v2/ocr/jobs`（multipart，Bearer）→ 轮询 → `resultUrl.jsonUrl` 下载 JSONL（每页一行，`parsing_res_list` 带 `block_label`/`block_content`/`block_bbox`/`block_order`）。

### 4.1 服务稳定性事实（新发现，影响可行性判断）

- **PaddleOCR-VL 整篇提交静默截断**：10/10 篇结果只返回页码 ≡1 (mod 3) 的分片（如 15 页只回 5 页），而 `extractProgress` 虚报 `extractedPages == totalPages`、`state=done`；其中一篇命中缓存返回 0 秒完成且页集错乱。**绕过：客户端按 ≤6 页分段提交（pageRanges）可拿全量**（本报告 VL 数据即按段重建，26 个分段全部完整返回）。PP-StructureV3 无此问题（10/10 完整）。
- **配额/速率**：本次共 51 个任务（≈310 页次）无触发限流/配额错误；但社区服务免费额度无书面承诺（见 cloud-parse-api 调研），不能依赖。
- **耗时**：PP 整篇 15–97s（9–26 页）；VL 分段 6–200s/段。均为服务端排队+计算，网络上传占比小。

### 4.2 块坐标帧系统性偏移（关键负面发现）

百度返回的 `block_bbox` 与 PDF 页面真帧（poppler/pdf.js 已互证一致）**对不上**：

- 数值：块框按"页像素帧 ÷2"换算后与文本层词框系统性偏移，**页顶部紧框块（标题/节标题）完全错过内容**（如 BERT 标题：真值 y=72–101pt，返回框 y=20–64pt），偏移量随页内位置变化（非恒定平移）；高大的正文块因框体宽容仍罩住正确文字。
- 旁证：服务自回的 `inputImage`（页帧 A，与真帧逐像素一致）与其自绘标注图 `layout_det_res`（页帧 B）内容位置都不一致——即**服务内部存在多个坐标帧且未文档化**，`prunedResult.width/height` 不足以反推变换。
- 后果：百度系输出**不能直接驱动"按 bbox 裁切页图"与对照阅读定位**（产物 (a)(b) 的坐标刚需）；正文文本抽取不受影响。
- 同步影响本文 diff 度量：PP/VL 的标题/公式/表格桶相似度被坐标偏移拉低（下界），正文桶（高块）受影响小。

### 4.3 文本质量（空间逐块 diff，块 bbox∩文本层词框=区域真值；Docling 为控制组）

| 桶 | Docling（控制） | PP-StructureV3 | PaddleOCR-VL-1.6 |
|---|---|---|---|
| 全部块加权 | **0.962** (n=4224) | 0.864 (n=1533) | 0.844 (n=1895) |
| 正文 | 0.929 | 0.823 | 0.825 |
| 标题 | 0.996 | 0.618* | 0.618* |
| 公式 | —（默认关闭） | 0.373*† | 0.387*† |
| 表格 | 0.639*‡ | 0.572*‡ | 0.573*‡ |
| 参考文献 | — | 0.974 | 0.681 |
| 图表标题 | 0.997 | 0.744 | 0.776 |
| 脚注 | 0.991 | 0.696 | 0.522 |

\* 受 §4.2 坐标偏移污染，为下界。† PP/VL 公式输出为 LaTeX，与文本层原始符号流的差异属表征升级（对我们"公式占位+裁切图"策略反而更合用），非纯误识。‡ 表格为 HTML/LaTeX 结构展平 vs 文本流的度量伪影。

典型 OCR 误差形态抽验（PP，正文块）：行内公式转 LaTeX（`$\mathcal{F}(\mathbf{x},\{W_{i}\})$`）为最大"差异"源；真实误识率低，偶见丢空格（"bya"、"Eqn.(1).If"）与字母级误识（"middle"→"midde"）。**VL 正文为生成式转写，存在改写风险（数学记号 LaTeX 化、标点规整化），不满足"宁可占位不可编造"的地基要求。**

### 4.4 引用编号（文档级多重集 diff，剔除参考文献条目行，仅文内引用）

干净样本（1608.08225，PhysRev 上标引用制，无表格方括号干扰）：PP 错误率 **6.9%**、VL **15.5%**、Docling 控制组 24.1%（控制组残余差异来自上标引用的文本层切分方式，非内容错误）。其余论文的数字被表格架构记号（"[3×3, 64]" 类方括号）污染，三方同幅虚高，不作判据。

### 4.5 对照结论

- **PP-StructureV3**：文本质量可用（尤其参考文献 0.974），但坐标帧偏移 + 社区服务配额无承诺 + 隐私出设备，**只能作 BYOK 可选加速器/降级预案，不进默认路径**。
- **PaddleOCR-VL-1.6**：正文质量与 PP 相当但为生成式；整篇截断 bug 须客户端分段绕过；按翻盘判据（误差不触及公式/表格数字/引用编号）——引用编号 15.5% 错误率 + 坐标偏移 + 生成式正文，**不翻盘，维持原决议**。

## 五、最终结论（#46 决议输入）

1. **采用 Docling 侧车**（方案 A）：四类踩坑形态全过、prov 可裁切、CPU 速度可接受、正文零幻觉。
2. 打包策略：**默认随包**（安装包 +0.8–1.0GB），首启下载作可选（须内置镜像端点配置，HF 直连在国内网络不可达）。
3. 降级预案顺位维持：PP-StructureV3 云 API（BYOK）→ MinerU 本地侧车（因 Docling 达标，**本次不启动 MinerU 许可证审阅**）。
4. 改造层待办（交给实施规格）：参考文献条目 [n] 按序补号；tables 集合优先于 texts 碎片；附录区误标 section_header 的过滤；模型下载端点可配置（HF_ENDPOINT）。

## 附：复现入口

- 脚本与原始数据：`.local/wayfinder/issue-46/`（`run_docling.py` / `baidu_api.py` / `vl_rebuild.py` / `prov_check.py` / `diff_spatial.py` / `cite_diff.py` / `overlay.py` / `check_pdfjs_coords.mjs`；度量 JSON 在 `metrics/`；覆盖图在 `overlays/`）
- 论文集清单：`corpus/MANIFEST.md`；parser.js 基线：`parser-baseline/*.json`
