# 踩坑论文集回归夹具（Issue #60，规格 #48 §Testing Decisions）

#46 的 10 篇踩坑论文固化为回归夹具：断言基线 = #48 User Stories 1–8 对应事实
（节结构、附录存活、furniture 剔除、prov 覆盖、参考文献编号）；性能门禁 =
单篇转换不超 #46 实测值 1.5 倍；Docling 版本锁定，升级须夹具全绿。

## 组成

- `corpus/*.pdf` — 10 篇 arXiv CS/AI 论文（155 页，2026-09-09 下载自
  arxiv.org/pdf/<id>，#46 验证用同一批文件原样入库）。五类坑位覆盖：
  双栏 ×5、无编号/编号变体 ×4、附录 ×5、脚注密集 ×2、公式表格密集 ×3
  （逐篇坑位与旧解析器基线症状见 #46 验证报告
  `docs/background/2026-09-09-harness-validation/docling-sidecar-validation.md`）。
- `manifest.json` — 基线清单：Docling 版本钉（与
  `tools/pdfparse-sidecar/requirements-sidecar.txt` 一致）、性能基线
  （#46 实测 convert_seconds，i5-13500H）、每篇策展断言（节标题包含/排除、
  附录节编号集合、各类块计数下限、参考文献条目数与正文引用覆盖）。
- 公式密集样例三类（继承 #34 验收标准，`manifest.formulaSamples` 登记）：
  - 文字公式 = `1412.6980`（Adam，35 个公式块）
  - 双栏布局 = `1603.02754`（XGBoost，ACM 双栏，50 个公式块）
  - 矢量与图片公式 = 合成夹具 `../pdfparse_formula_graphics.pdf`
    （纯路径矢量公式 + 嵌入位图公式，生成器
    `tests/fixtures/make_pdfparse_fixtures.py`；其固化映射 fixture 为
    `tests/fixtures/docling/formula_graphics.json.gz`）
  - 扫描件降级提示由 `pdfparse_contract.rs` 的
    `convert_scanned_blank_page_marks_ocr_degraded`（`PAPER30MIN_PDFPARSE_SLOW=1`）
    承载：无文本层页触发 OCR 且结果带 `scanned_pages_ocr` 警示。

## 运行

```
cd app/src-tauri
# 始终运行：清单良构（版本钉一致、夹具在场），无需侧车
cargo test --test pdfparse_regression

# assert 模式：10 篇全链（PDF → 侧车 → 映射 → 基线断言 + 性能门禁），
# 串行约 15–25 分钟，要求侧车已构建（tools/pdfparse-sidecar/build_sidecar.py）
PAPER30MIN_PDFPARSE_FIXTURES=1 cargo test --test pdfparse_regression -- --nocapture

# dump 模式：全链重跑并写 manifest.dump.json（实测耗时 + 事实，供基线重建/
# 版本升级同机对照）
PAPER30MIN_PDFPARSE_FIXTURES=dump cargo test --test pdfparse_regression -- --nocapture
# 复用既有 docling.json 目录跳过转换（本清单初始基线即由 #46 实测输出重建）
PAPER30MIN_PDFPARSE_FIXTURES=dump PAPER30MIN_PDFPARSE_FIXTURES_DUMP_DIR=<docling.json 目录> \
  cargo test --test pdfparse_regression -- --nocapture
```

`manifest.dump.json` 是临时产物，不入库（已 git-ignore）。

## 性能门禁

门禁 = `elapsedMs ≤ baselineSeconds × 1.5 × PAPER30MIN_PDFPARSE_PERF_FACTOR`
（机器系数默认 1.0）。注意计时口径：侧车 `elapsedMs` 含 Python 启动与模型
加载固定开销（约 15–20s），`baselineSeconds` 是 #46 的纯转换耗时——门禁已
为此留出余量。#57 复核实测同机不同状态波动可达 1.7×（Windows Defender 扫描、
冷缓存等），机器繁忙/偏慢时显式设 `PAPER30MIN_PDFPARSE_PERF_FACTOR`（如 1.5）
并在升级报告中说明；版本升级的性能判定以同机 dump 前后对照为准
（`manifest.dump.json` 的 `measuredSeconds`）。

## 断言基线的判读

- 引擎不变量（每篇必过，无需清单字段）：块级 prov 全覆盖；图/表/公式块必带
  正宽高 bbox（裁切链前提）；公式块一律 `[公式]` 占位且默认无 LaTeX；表块为
  MD 管道表；无空文本块；重复 furniture 条纹不系统性泄漏进节块；参考文献
  补号 `[1]..[n]` 连续。
- 清单策展断言：`title`、`sectionsContain`、`sectionsNotContain`（已知误判
  探针，如 1706 附录图题、BERT "· Batch size"）、`appendixNumbers`
  （`null` = 无编号扉页）、各类块计数下限、`references`（编号制精确条目数 +
  正文引用覆盖；作者-年份制/无文献节降级为空清单 + 对应 warning）。
- 计数下限（`min*`）对检测抖动宽容；条目数与节标题精确。断言失败先查
  是真实回归还是机器/版本抖动——版本升级时按 README 重建基线。

## 已知记录（基线固化时刻的行为，非回归目标）

- 1603.02754（XGBoost）：论文题目不被识别（`title_not_detected` warning），
  题目文本成为正文区一个节（ACM 版式下 Docling 阅读顺序把题目排在
  Abstract/引言之后）。清单不对该篇断言 `title`。
- 1610.00633（NAF）：算法浮动体标题 "Algorithm 1 Asynchronous NAF..." 成为
  一个正文节（Docling section_header 判定保留）。
- 1712.01815（AlphaZero）：Science 版正文引用为上标无括号形态，`[n]` 引用点
  扫描为空（`minCited: 0`），参考文献条目本身完整。

## Docling 版本升级

升级流程（钉版、重建、基线重建、门禁）见
`tools/pdfparse-sidecar/README.md` 的「升级 Docling」一节。
