---
title: "PDF 来源定位与实际选区分开建模"
date: 2026-10-05
problem_type: architecture_decision
component: pdf_reader
module: pdfmap
severity: medium
status: accepted
applies_when:
  - "修改 PDF 高亮、选区问答或旧书库来源恢复"
tags:
  - pdf-evidence
  - provenance
  - selection-persistence
---

# PDF 来源定位与实际选区分开建模

## Context & Decision

论文产物的块地址与用户在 PDF 中实际圈定的范围不是同一对象。v1.3.0 采用两条契约：解析来源矩形负责可核验的出处定位，实际文字或截图负责选区翻译与提问。来源不足时退回页级定位；选区无法精确映射块时仍允许提问，但附近块只作上下文。实现见 [来源提取](../../../app/src-tauri/src/pdfmap.rs)（`source_regions`，520 行）、[来源恢复](../../../app/src-tauri/src/pdfmap_evidence.rs)（`get_source_regions`，13 行）与 [选区绑定](../../../app/ui/js/pdf-selection.js)（`selectionBinding`，21 行）。

## Why & Trade-offs

仅靠文字匹配无法稳定处理双栏、跨页、重复文本及扫描页；把页码或附近块当作精确区域会误导读者。来源恢复因此同时核对 PDF 身份与已保存块模型的投影，而不因存在 Docling 缓存就信任它。来源矩形保留多区域，不合并为覆盖无关内容的大框。实际框选截图独立保存为附件，聊天只保存选区与附件引用，接受额外迁移和清理成本，以便重开、追问及书库导出导入都能恢复原问题对象。持久化与迁移契约见 [书库](../../../app/src-tauri/src/library.rs)（`validate_pdf_selection`，1216 行）与 [迁移](../../../app/src-tauri/src/migration.rs)（`convert_selection_attachments`，868 行）。

## Downstream Impact

来源坐标与实际选区必须分开验证：前者验证身份、页尺寸和可信几何，后者验证选中文字或图片是否随请求与历史重放保持一致。旧聊天允许没有选区字段；旧块没有可信来源时不得猜画高亮。扫描页可框选，但图像理解依赖用户选择的模型能力。

本次原生 PDF 验收 16 项及用户鼠标、触控板、真实模型走查支持已交付路径；未证明所有 DPI、论文和模型组合，亦未替代完整安装版矩阵。验收范围见 [v1.3.0 发布说明](../../releases/v1.3.0.md)。
