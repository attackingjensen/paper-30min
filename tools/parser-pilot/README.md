# 百度解析试点：离线准备工具

本工具不访问网络，不读取凭据，不上传论文。它运行现行 Docling 基线，或检查已下载的百度 PaddleOCR-VL 原始 JSON。真实服务提交、持久化任务 ID、查询恢复与资源下载在取得账号及预算后另行接入；此工具不是客户端的云端功能。

## 运行

复用已安装侧车的 Python、pypdfium2 和 Pillow，不新增依赖。在仓库根目录执行：

```powershell
app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/pilot.py baseline --out tmp/parser-pilot-20261006
app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/test_pilot.py

# 取得真实百度结果后，用相同原始 PDF 检查；输出目录必须不存在。
app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/pilot.py inspect --provider baidu --pdf app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf --raw tmp/baidu-resnet.json --out tmp/baidu-resnet-inspection
```

基线固定为 Adam（15 页）、知识蒸馏（9 页）、ResNet（12 页）、XGBoost（13 页），共 49 页。每篇独立进程，FAST 表格模式，关闭公式增强，包含进程及模型加载时间；没有把历史 manifest 耗时当作新实测。输出目录防覆盖，失败留存日志和状态；进程异常终止留下的 `running` 不代表成功。

每篇保存 PDF SHA-256、侧车清单与脚本 SHA-256、实际页数、选项、耗时、原始 `docling.json`、侧车 `result.json` 和日志。检查输出保存原始 JSON SHA-256、页尺寸、逐块记录、分类计数和全部页的 PNG 叠加图。输出留在被 Git 忽略的 `tmp/`，不要提交含论文或服务临时链接的原始产物。

## 坐标检查边界

百度使用原始结果的 `pages[].page_num`（官方示例从 0 开始）、`meta.page_width/page_height`、`position=[x,y,w,h]`。按尺寸比例映射到 PDF 点坐标；缺页、重复页或非法页号拒绝检查。非零或缺失 `page_angle`、页宽高比例不符、越界、缺失或非有限坐标不给叠加框。原始 PDF 自身非零旋转也保守降级。表格文本通过 `layout_id` 关联 `tables[].markdown`。原始输出仍是完整内容权威，本工具不删改其中的单元格、行框和图片字段。

Docling 根据明确的坐标原点转换；文本、表格与图片集合顺序不等于阅读顺序，必须从原始 `body` 树核对。表格内容应查看原始 `data.table_cells`，不能把记录中的空 `text` 计作识别失败。

所有框仅标记 `candidate`，不是已验证的产品级 `SourceRegion`。比例正确不能证明 CropBox 偏移、图像预处理或文本与区域关系正确；须在**原始 PDF** 上人工检查。返回的 processed PDF 不能替代该检查。`qualityVerdict` 和 `coordinateVerdict` 始终为待审，不会凭统计自动判通过。

## 真实调用准备

选择 [PaddleOCR-VL 接口](https://cloud.baidu.com/doc/OCR/s/3mi73at9o)，不是旧文档解析接口。首轮拟使用 `return_span_boxes=true`、`relevel_titles=true`、`merge_tables=true`，关闭 `angle_adjust`、水印擦除和扭曲矫正，避免初测引入几何变换。供应商模型标识与参数随请求留存，无法取得服务端实际版本时明确记为未知。调用前需确认这些公开论文可以上传、累计页数预算及本机凭据位置。

第一轮 49 页只覆盖文本层论文。后续需扫描页、旋转/CropBox 和跨页表格专项样本，新增提交或重测均计入确认后的累计预算。API 提交不得自动重试；必须在轮询前落盘 `task_id`，提交断线但可能已受理时记为状态不明，由人工核对。查询恢复不等于重新上传。

人工质量表至少逐篇记录：全部页完整性、双栏顺序、标题/附录、关键公式及编号、表格数字和合并单元格、图表与标题归属、原 PDF 上的段落/公式/表格/图形定位。任何缺页、关键数字错误、系统性错序或错位均阻止进入完整功能开发；局部降级须列出例子与影响，经评估后决定，不把单一评分作为验收。
