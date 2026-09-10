# Docling 侧车模型权重再分发许可核实（#57 验收项 1）

- 日期：2026-09-10
- 来源票据：[#57 Docling 侧车打包与进程契约](https://github.com/attackingjensen/paper-30min/issues/57)；
  遗留风险出处：[#48 Spec：PDF 块模型生产管线](https://github.com/attackingjensen/paper-30min/issues/48) §Further Notes
- 核实范围：随安装包再分发的三组模型权重（布局 / 表格 / OCR）；代码包许可见文末附注。

## 结论

**三组模型权重的许可证均允许随安装包再分发（含商用），义务均为保留归属与许可文本。
随包案的许可合规落法：`THIRD_PARTY_NOTICES.md` 随侧车分发（`app/` 内），
安装包内含全部 `*.dist-info` 元数据。** 无阻断项，打包可继续。

## 逐款核实

| 权重 | 仓库 | 许可证 | 再分发义务 | 核实途径 |
| --- | --- | --- | --- | --- |
| docling-layout-heron（布局，164MB） | huggingface.co/docling-project/docling-layout-heron | **Apache-2.0**（模型卡 YAML `license: apache-2.0`） | 附许可文本与归属；修改须声明（§4） | 模型卡现场读取（经 hf-mirror 镜像；本地 HF 缓存快照 8f39ad3 的 README 一致） |
| TableFormer accurate/fast（表格结构，342MB） | huggingface.co/docling-project/docling-models（revision v2.3.0，docling 2.126 自钉） | **CDLA-Permissive-2.0**（模型卡 YAML `license: cdla-permissive-2.0`；页面同时展示 apache-2.0 标签） | CDLA-Permissive-2.0 §3：再分发须附许可文本与归属声明 | 模型卡现场读取 + 本地缓存快照 README |
| PP-OCRv6 det/rec small + PP-OCRv4 cls mobile（OCR，约 60MB） | modelscope.cn/models/RapidAI/RapidOCR（docling 经 `RapidOcrModel.download_models` 拉取）；上游为百度 PaddleOCR | **Apache-2.0**（PaddleOCR 仓库 LICENSE；RapidOCR 包 License-Expression: Apache-2.0；rapidocr wheel 本身随包内置同一组模型再分发） | 同 Apache-2.0 §4 | GitHub API 核实 PaddleOCR 与 RapidAI/RapidOCR 仓库 LICENSE；venv 内 rapidocr-3.9.2 dist-info METADATA |

附注（代码包，非权重）：docling MIT（GitHub API 核实）、PyTorch BSD-3-Clause、
transformers Apache-2.0、其余传递依赖均为 OSI 批准的宽松许可证
（各包 `dist-info` 随侧车落盘，未删减）。

## 留档判断

1. Apache-2.0 与 CDLA-Permissive-2.0 都是宽松许可证，均无 copyleft、无商用限制、
   无"权重不得再分发"条款；与本项目（MIT 代码）兼容。
2. 公式模型 `docling-project/CodeFormulaV2`（Apache-2.0，模型卡）**不随默认包**，
   仅在用户开启公式 enrichment 时按需下载，已列入 THIRD_PARTY_NOTICES.md 备查。
3. 百度系云端 API（PP-StructureV3 / PaddleOCR-VL）为 BYOK 降级预案、不随包分发，
   不在本次核实范围（#46 结论）。
4. 升级 Docling 版本时须复核本表（模型仓库与 revision 可能变化），
   与"版本锁定 + 回归夹具"策略（#48 §Further Notes）一并执行。
