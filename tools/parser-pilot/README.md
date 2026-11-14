# 百度解析试点工具

`pilot.py` 运行本地 Docling 基线和离线坐标检查；`aistudio.py` 调用 AI Studio PaddleOCR-VL-1.6，上传本地 PDF，持久化任务 ID 并取回原始 JSONL。这是独立试验工具，尚未接入客户端。

## 运行

复用已安装侧车的 Python、pypdfium2 和 Pillow，不新增依赖。在仓库根目录执行：

```powershell
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/pilot.py baseline --out tmp/parser-pilot-20261006
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/test_pilot.py
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/test_aistudio.py

# 取得真实百度结果后，用相同原始 PDF 检查；输出目录必须不存在。
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/pilot.py inspect --provider baidu --pdf legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf --raw tmp/baidu-resnet.json --out tmp/baidu-resnet-inspection
```

基线固定为 Adam（15 页）、知识蒸馏（9 页）、ResNet（12 页）、XGBoost（13 页），共 49 页。每篇独立进程，FAST 表格模式，关闭公式增强，包含进程及模型加载时间；没有把历史 manifest 耗时当作新实测。输出目录防覆盖，失败留存日志和状态；进程异常终止留下的 `running` 不代表成功。

每篇保存 PDF SHA-256、侧车清单与脚本 SHA-256、实际页数、选项、耗时、原始 `docling.json`、侧车 `result.json` 和日志。检查输出保存原始 JSON SHA-256、页尺寸、逐块记录、分类计数和全部页的 PNG 叠加图。输出留在被 Git 忽略的 `tmp/`，不要提交含论文或服务临时链接的原始产物。

## 坐标检查边界

百度使用原始结果的 `pages[].page_num`（官方示例从 0 开始）、`meta.page_width/page_height`、`position=[x,y,w,h]`。按尺寸比例映射到 PDF 点坐标；缺页、重复页或非法页号拒绝检查。非零或缺失 `page_angle`、页宽高比例不符、越界、缺失或非有限坐标不给叠加框。原始 PDF 自身非零旋转也保守降级。表格文本通过 `layout_id` 关联 `tables[].markdown`。原始输出仍是完整内容权威，本工具不删改其中的单元格、行框和图片字段。

Docling 根据明确的坐标原点转换；文本、表格与图片集合顺序不等于阅读顺序，必须从原始 `body` 树核对。表格内容应查看原始 `data.table_cells`，不能把记录中的空 `text` 计作识别失败。

所有框仅标记 `candidate`，不是已验证的产品级 `SourceRegion`。比例正确不能证明 CropBox 偏移、图像预处理或文本与区域关系正确；须在**原始 PDF** 上人工检查。返回的 processed PDF 不能替代该检查。`qualityVerdict` 和 `coordinateVerdict` 始终为待审，不会凭统计自动判通过。

## 真实调用准备

2026-10-06 用户提供 [AI Studio](https://aistudio.baidu.com/paddleocr) 异步 API 示例，试点改用该入口，替代原拟定的百度智能云接口。两者的认证与结果结构不同，不复用智能云参数。官方 [配额说明](https://ai.baidu.com/ai-doc/AISTUDIO/Xmjclapam) 当前写明每用户、每模型每天 20,000 页上限，超额返回 429；额度变化以服务实际响应为准。

凭据仅从 `PADDLEOCR_ACCESS_TOKEN` 环境变量读取，不接受命令行 Token、不写入运行记录。设好环境变量后运行：

```powershell
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/aistudio.py submit --pdf legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1503.02531.pdf --out tmp/aistudio-pilot-20261006/1503.02531
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/aistudio.py collect --out tmp/aistudio-pilot-20261006/1503.02531
legacy/v1/app/src-tauri/sidecar/pdfparse/python/python.exe tools/parser-pilot/pilot.py inspect --provider aistudio --pdf legacy/v1/app/src-tauri/tests/fixtures/regression/corpus/1503.02531.pdf --raw tmp/aistudio-pilot-20261006/1503.02531/result.jsonl --out tmp/aistudio-pilot-20261006/1503.02531/inspection
```

固定 `model=PaddleOCR-VL-1.6`，关闭方向分类、扭曲矫正与统计图表内容解析。服务端实际模型版本无法确认，记录为未知；服务器模型设置随原始结果保留。只上传 PDF，每文件限制 49 页、50 MiB；这是单文件工具护栏，**不代表累计上传预算**。操作者另行累计实际提交页数，不能因单文件合规而无限提交。

提交输出目录必须不存在，`submitting` 在请求前落盘，`jobId` 在查询前落盘。提交异常保守记录 `submit-unknown`，包括可能已经受理的断线，不自动重提。`collect` 只查询该任务，断线或 900 秒轮询超时后可以重跑；远端失败不能被当作成功。一次只允许一个 `collect`；进程强制终止留下 `collect.lock` 时，先确认没有活跃进程再手动移除锁，仅恢复查询。

原始 JSONL 最多 256 MiB，先写 `.part`、检查语法，再发布 `result.jsonl` 和 SHA-256；`downloaded` 仅表示完整下载，不表示内容或坐标通过。下载仅访问百度 HTTPS 资源域名，不发送认证头，不跟随重定向。原始 JSONL 含图片临时链接，留在本机忽略目录；尚未下载其全部图片资源，因此本轮不能证明客户端离线视觉链路已完成。requests 使用当前进程的默认网络环境，不代表已经集成 Rust 的自动代理/直连设置。

AI Studio 使用 `prunedResult.width/height` 和 `parsing_res_list[].block_bbox`（**XYXY**，不是智能云的 XYWH），同时保留类型、内容、`block_order` 和 `group_id`。服务将同组内容合并时，其他框可能是空文本；后续来源映射要保留同组多个区域，不能把合并文字只绑定到第一个框。初测真实 JSONL 没有绝对页号，以官方示例的 JSONL / 页数组顺序分配页码，并明确记为 `jsonl-order`；须人工核对页面对应关系，尺寸一致不能证明顺序正确。开启预处理或尺寸比例不符时不生成候选框。

第一轮 49 页只覆盖文本层论文。后续需扫描页、旋转/CropBox 和跨页表格专项样本；新增提交或重测计入累计用量。查询恢复不等于重新上传。实测记录见 [AI Studio 首轮对照](../../docs/research/2026-10-06-aistudio-pilot.md)。

人工质量表至少逐篇记录：全部页完整性、双栏顺序、标题/附录、关键公式及编号、表格数字和合并单元格、图表与标题归属、原 PDF 上的段落/公式/表格/图形定位。任何缺页、关键数字错误、系统性错序或错位均阻止进入完整功能开发；局部降级须列出例子与影响，经评估后决定，不把单一评分作为验收。
