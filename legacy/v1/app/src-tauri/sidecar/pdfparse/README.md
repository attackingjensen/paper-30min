# sidecar/pdfparse — Docling 侧车构建产物目录

此目录存放 `tools/pdfparse-sidecar/build_sidecar.py` 的构建产物（约 1.5GB），
除本 README 外全部 git 忽略。干净克隆请先构建：

```powershell
# 随包案（默认）：嵌入式 Python + 钉版依赖 + 布局/表格/OCR 模型
python tools/pdfparse-sidecar/build_sidecar.py

# 首启下载案（可选）：只含 Python + 下载器（约 50MB），依赖与模型首启在线拉取
python tools/pdfparse-sidecar/build_sidecar.py --variant download
```

产物布局：`python/`（嵌入式 3.11.9）、`app/`（侧车程序与许可声明）、
`models/`（bundled 案的模型工件）、`sidecar-manifest.json`。

打包时经 `tauri.conf.json` 的 `bundle.resources` 随安装包分发；运行时解析顺序见
`src/pdfparse.rs`（环境变量 `PAPER30MIN_PDFPARSE_HOME` → 可执行文件旁 → 本目录）。

详细说明见 `tools/pdfparse-sidecar/README.md`。
