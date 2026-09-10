# 第三方组件与模型权重声明（Docling 侧车）

本侧车随安装包再分发以下第三方组件与模型权重。许可证核实记录见
`docs/background/2026-09-10-docling-sidecar/model-license-review.md`（Issue #57 验收项）。

## 代码组件（pip 钉版依赖，见 requirements-sidecar.txt）

- Docling 2.126.0（docling / docling-core / docling-ibm-models / docling-parse / docling-slim）— **MIT License**，© Docling 项目贡献者（IBM）。https://github.com/docling-project/docling
- PyTorch 2.14.0 — BSD-3-Clause，© Meta Platforms。
- Transformers 5.16.1 — Apache-2.0，© Hugging Face。
- RapidOCR 3.9.2 — Apache-2.0，© RapidAI。https://github.com/RapidAI/RapidOCR
- 其余传递依赖许可证见各自 `Lib/site-packages/<pkg>.dist-info/` 元数据（均为 OSI 批准的宽松许可证）。

## 模型权重

- **docling-layout-heron**（布局分析模型，`models/docling-project--docling-layout-heron/`）
  — **Apache License 2.0**，© docling-project（IBM Research）。
  https://huggingface.co/docling-project/docling-layout-heron
- **TableFormer accurate/fast**（表格结构模型，`models/docling-project--docling-models/`）
  — **CDLA-Permissive-2.0**，© docling-project（IBM Research）。
  https://huggingface.co/docling-project/docling-models
- **PP-OCRv6 det/rec + PP-OCRv4 cls**（扫描页 OCR，`models/RapidOcr/`）
  — **Apache License 2.0**，模型源自百度 PaddleOCR 项目，经 RapidAI 转换分发。
  https://github.com/PaddlePaddle/PaddleOCR · https://www.modelscope.cn/models/RapidAI/RapidOCR

上述许可证均允许随产品再分发；按 Apache-2.0 第 4 条与 CDLA-Permissive-2.0 第 3 条，
本声明即归属与许可文本指引。许可证全文：
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- CDLA-Permissive-2.0: https://cdla.dev/permissive-2-0/
- MIT: https://opensource.org/license/mit

## 公式模型（可选，不随默认包）

`docling-project/CodeFormulaV2`（Apache-2.0）仅在用户开启公式 enrichment 时按需下载。
