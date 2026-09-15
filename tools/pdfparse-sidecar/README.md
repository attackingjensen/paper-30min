# Docling 侧车（pdfparse）

Issue [#57](https://github.com/attackingjensen/paper-30min/issues/57) /
规格 [#48](https://github.com/attackingjensen/paper-30min/issues/48) §实施决策 1–4。

把 PDF 转成 DoclingDocument JSON 的 Windows 侧车：嵌入式 Python 3.11.9 +
钉版依赖（Docling 2.126.0 基线）+ 布局/表格/OCR 模型。Rust 以子进程调用
（`pdfparse.convert@1` / `pdfparse.bootstrap@1` 任务），导入走任务中心生命周期，
取消 = 终止子进程。`render` 子命令（Issue #59）另承担页图与图表裁切预渲染
（scale=2 webp），由 `pdfassets.prerender@1` 任务驱动。

## 文件

- `pdfparse_sidecar.py` — 侧车程序（convert / render / bootstrap / prefetch-models / selfcheck）。
- `requirements-sidecar.txt` — 钉版依赖清单（与 #46 验证 venv 逐版一致；升级 Docling
  须回归夹具全绿，见 #60）。
- `build_sidecar.py` — 构建脚本，产物落 `app/src-tauri/sidecar/pdfparse/`。
- `THIRD_PARTY_NOTICES.md` — 随包分发的归属与许可声明（许可核实见
  `docs/background/2026-09-10-docling-sidecar/model-license-review.md`）。

## 构建

```powershell
# 默认 bundled：Python + 依赖（离线 wheel 缓存可选）+ 模型，约 1.5GB 落盘
python tools/pdfparse-sidecar/build_sidecar.py

# 复现/构建机可用 wheel 缓存离线安装依赖
python tools/pdfparse-sidecar/build_sidecar.py --wheels-dir <pip download 目录>

# download 案：只含 Python + 下载器（约 50MB）
python tools/pdfparse-sidecar/build_sidecar.py --variant download

# 模型下载端点可配（HF_ENDPOINT 语义；默认官方源，失败自动回退 hf-mirror）
python tools/pdfparse-sidecar/build_sidecar.py --hf-endpoint https://hf-mirror.com
```

## 进程契约

输入 = PDF 路径 + 选项（`--formula-enrichment`；全局 `--table-mode fast|accurate`，
默认 `fast`），输出 = `<out-dir>/docling.json`
（DoclingDocument 无损 JSON）+ `<out-dir>/result.json`（结构化结果，含 `tableMode` /
`numThreads`）+ stdout 单行
`PDFPARSE_RESULT` / `PDFPARSE_PROGRESS`。错误码：`pdf_not_found`、
`pdf_open_failed`、`conversion_failed`、`deps_missing`、`model_missing`、
`model_download_failed`、`bootstrap_failed`、`bootstrap_required`（Rust 预检）、
`sidecar_missing`、`sidecar_crashed`（Rust 侧）。

### render 子命令（#59）

输入 = `--pdf` + `--out-dir` + `--job <job.json>`；job 形状
`{"scale": 2, "quality": 86, "pages": [1, ...], "crops": [{"id", "page", "bbox": [x, y, w, h]}]}`
（bbox 为 pdf.js 视口坐标 scale=2 左上原点，与渲染位图像素坐标系一致）。
`pages` 可为 null（按 PDF 实际页数渲染全部页图）或为空数组（不输出页图，仍渲染 crops 所在页）。
进度 `done/total` 按页图与裁切产物件数计。
输出 = `<out-dir>/pages/page-{n}.webp` + `<out-dir>/crops/{id}.webp` +
result.json（逐件 width/height/bytes + `skippedCrops`）。裁切框钳制到页边界，
完全页外记 skippedCrops 不编造（#48 §诚实档）。渲染只用 pypdfium2 + Pillow，
不要求模型权重，也不校验模型目录。错误码同上加 `job_invalid` / `render_failed`。

## 运行期语义

- convert 全程 `HF_HUB_OFFLINE=1`，模型只从 artifacts 目录取；唯一在线例外是
  用户开启公式 enrichment 且 CodeFormulaV2 模型缺失（按 HF_ENDPOINT 下载，
  失败报 `model_download_failed`）。公式模型落入当前生效的模型目录——该目录
  须可写（随包安装为 currentUser 模式，安装目录可写）。
- **HF_ENDPOINT 只管辖 HF 腿**（布局/表格/公式模型）；RapidOCR 模型走 docling
  自带下载器的 ModelScope 源（国内可达，与 HF 端点无关），这是有意为之。
- OCR 仅对无文本层页触发（预扫 `pypdfium2` 文本层，存在无文本层页才启用
  RapidOCR torch 后端；onnxruntime 不随包），触发页在结果 `ocrPages` 标记并附
  `scanned_pages_ocr` 警示。
- convert 启动时若环境未显式设置 `DOCLING_NUM_THREADS` / `OMP_NUM_THREADS`，按物理核
  （`psutil.cpu_count(logical=False)`）钳制到 `[2, 8]` 后写入 `DOCLING_NUM_THREADS`
  （须在 import docling 之前）。表格结构默认 FAST，可由 `--table-mode accurate` 切回。
- download 案首启由 `pdfparse.bootstrap@1` 补齐依赖与模型（pip + snapshot_download
  幂等，可安全重试）；运行时下载的模型落书库 `pdfparse-models/`，不打安装目录。
- 依赖完整性以侧车根目录 `deps.ok` 标记为准（构建/bootstrap 成功才写入）——
  取消残留的半截 site-packages 不会误过 `depsReady` 门禁。

## 契约测试

```
cd app/src-tauri
cargo test --test pdfparse_contract            # 常规（状态/成功/错误/取消，约 1 分钟）
cargo test --test pdfassets_contract           # 页图/裁切预渲染（#59，约 5 秒）
PAPER30MIN_PDFPARSE_SLOW=1 cargo test --test pdfparse_contract   # 含 OCR 慢测试（约 4 分钟）
# 踩坑论文集回归夹具（#60）：版本锁定 + 基线断言 + 性能门禁，约 15–25 分钟
PAPER30MIN_PDFPARSE_FIXTURES=1 cargo test --test pdfparse_regression -- --nocapture
```

干净克隆未构建侧车时测试跳过；打包验证设 `PAPER30MIN_PDFPARSE_REQUIRE=1` 强制在场。

## 升级 Docling（版本锁定与回归门禁，Issue #60）

Docling 版本锁定：侧车钉版 `requirements-sidecar.txt`（`docling==X.Y.Z` 等
逐版钉死）+ 侧车程序 `pdfparse_sidecar.py` 的 `DOCLING_VERSION` + 回归基线
`app/src-tauri/tests/fixtures/regression/manifest.json` 的 `doclingVersion`
三处一致，测试交叉校验（不一致即失败）。升级流程：

1. 改钉：`requirements-sidecar.txt` 目标版本 + `pdfparse_sidecar.py`
   `DOCLING_VERSION`，重新构建侧车（`build_sidecar.py`）。
2. 同机对照（升级前）：在旧版本跑一次 dump，留存 `measuredSeconds`：
   `PAPER30MIN_PDFPARSE_FIXTURES=dump cargo test --test pdfparse_regression`。
3. 升级后 dump：同机对新版本再跑一次 dump。逐篇对比
   `manifest.dump.json` 的 `facts`（节清单、计数、warning）与
   `measuredSeconds`：差异可接受才进入下一步；不可接受即升级失败回退。
4. 重建基线：按新 dump 策展更新 `manifest.json`（含 `doclingVersion` 与
   必要的 `baselineSeconds` 重测值），删除 `manifest.dump.json`。
5. 门禁全绿：
   `PAPER30MIN_PDFPARSE_FIXTURES=1 cargo test --test pdfparse_regression`，
   附升级报告（dump 前后对照、性能比值、断言变化说明）随升级提交。
6. 公式图形合成夹具的固化 fixture 若受影响，重建
   `tests/fixtures/docling/formula_graphics.json.gz`（生成方式见
   `tests/fixtures/regression/README.md`）并核对
   `pdfmap_fixtures.rs` 的公式图形断言。

性能门禁的机器状态容差（`PAPER30MIN_PDFPARSE_PERF_FACTOR`）与断言基线判读，
见 `app/src-tauri/tests/fixtures/regression/README.md`。
