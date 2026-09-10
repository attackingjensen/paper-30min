# Docling 侧车（pdfparse）

Issue [#57](https://github.com/attackingjensen/paper-30min/issues/57) /
规格 [#48](https://github.com/attackingjensen/paper-30min/issues/48) §实施决策 1–4。

把 PDF 转成 DoclingDocument JSON 的 Windows 侧车：嵌入式 Python 3.11.9 +
钉版依赖（Docling 2.126.0 基线）+ 布局/表格/OCR 模型。Rust 以子进程调用
（`pdfparse.convert@1` / `pdfparse.bootstrap@1` 任务），导入走任务中心生命周期，
取消 = 终止子进程。

## 文件

- `pdfparse_sidecar.py` — 侧车程序（convert / bootstrap / prefetch-models / selfcheck）。
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

输入 = PDF 路径 + 选项（`--formula-enrichment`），输出 = `<out-dir>/docling.json`
（DoclingDocument 无损 JSON）+ `<out-dir>/result.json`（结构化结果）+ stdout 单行
`PDFPARSE_RESULT` / `PDFPARSE_PROGRESS`。错误码：`pdf_not_found`、
`pdf_open_failed`、`conversion_failed`、`deps_missing`、`model_missing`、
`model_download_failed`、`bootstrap_failed`、`bootstrap_required`（Rust 预检）、
`sidecar_missing`、`sidecar_crashed`（Rust 侧）。

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
- download 案首启由 `pdfparse.bootstrap@1` 补齐依赖与模型（pip + snapshot_download
  幂等，可安全重试）；运行时下载的模型落书库 `pdfparse-models/`，不打安装目录。
- 依赖完整性以侧车根目录 `deps.ok` 标记为准（构建/bootstrap 成功才写入）——
  取消残留的半截 site-packages 不会误过 `depsReady` 门禁。

## 契约测试

```
cd app/src-tauri
cargo test --test pdfparse_contract            # 常规（状态/成功/错误/取消，约 1 分钟）
PAPER30MIN_PDFPARSE_SLOW=1 cargo test --test pdfparse_contract   # 含 OCR 慢测试（约 4 分钟）
```

干净克隆未构建侧车时测试跳过；打包验证设 `PAPER30MIN_PDFPARSE_REQUIRE=1` 强制在场。
