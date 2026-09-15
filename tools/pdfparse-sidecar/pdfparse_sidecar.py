# -*- coding: utf-8 -*-
"""Docling 侧车程序（Issue #57，规格 #48 §实施决策 1–4）。

由 Rust 以子进程方式调用，输入 PDF 路径 + 选项，输出 DoclingDocument 无损 JSON
与结构化结果。进程协议：

- 所有子命令把最终结果写入 `<out-dir>/result.json`（bootstrap 写到 --manifest-dir），
  并在 stdout 打印一行 `PDFPARSE_RESULT {json}`。结果 JSON 形态：
    成功: {"ok": true, ...}
    失败: {"ok": false, "error": {"code": ..., "message": ..., "retryable": bool}}
- 长任务在 stdout 打印 `PDFPARSE_PROGRESS {"stage": ..., "done": n, "total": m}` 单行进度。
- 退出码：0 = 结果已按协议产出（含 ok:false 的可归类失败）；2 = 侧车自身崩溃，
  此时 result.json 可能缺失，由 Rust 侧映射为 sidecar_crashed 并附 stderr 尾部。

结构化错误码（与 Rust pdfparse.rs 对齐）：
    pdf_not_found / pdf_open_failed / conversion_failed / deps_missing /
    model_missing / model_download_failed / bootstrap_failed

离线语义：convert 始终在 HF_HUB_OFFLINE=1 下运行，模型只从 artifacts 目录取；
公式 enrichment 开启而模型缺失时，才按 HF_ENDPOINT（默认官方源，内置 hf-mirror
备选）尝试一次下载，失败报 model_download_failed（retryable）。
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

DOCLING_VERSION = "2.126.0"

# artifacts 目录下的固定布局（docling download_models 的 local_dir 约定）：
#   <models>/docling-project--docling-layout-heron/      布局模型（Apache-2.0）
#   <models>/docling-project--docling-models/model_artifacts/tableformer/{accurate,fast}/
#   <models>/RapidOcr/                                   OCR 模型（PP-OCRv6/v4，Apache-2.0）
#   <models>/docling-project--CodeFormulaV2/             公式模型（可选，enrichment 用）
LAYOUT_FOLDER = "docling-project--docling-layout-heron"
TABLEFORMER_FOLDER = "docling-project--docling-models"
RAPIDOCR_FOLDER = "RapidOcr"
FORMULA_FOLDER = "docling-project--CodeFormulaV2"

HF_OFFICIAL = "https://huggingface.co"
HF_MIRROR = "https://hf-mirror.com"

THREAD_MIN = 2
THREAD_MAX = 8


def _explicit_thread_env():
    """环境已显式给出合法线程数时返回该整数，否则 None。"""
    for key in ("DOCLING_NUM_THREADS", "OMP_NUM_THREADS"):
        raw = os.environ.get(key)
        if raw is None or not str(raw).strip():
            continue
        try:
            return int(str(raw).strip())
        except ValueError:
            continue
    return None


def resolve_num_threads(physical_cores=None):
    """解析 Docling 线程数：显式环境变量优先；否则物理核钳制到 [2, 8]。"""
    explicit = _explicit_thread_env()
    if explicit is not None:
        return explicit
    cores = physical_cores
    if cores is None:
        import psutil

        cores = psutil.cpu_count(logical=False)
    try:
        cores = int(cores)
    except (TypeError, ValueError):
        cores = THREAD_MIN
    return max(THREAD_MIN, min(THREAD_MAX, cores))


def apply_thread_env():
    """未设线程环境变量时按物理核写入 DOCLING_NUM_THREADS。须在 import docling 之前调用。"""
    n = resolve_num_threads()
    if _explicit_thread_env() is None:
        os.environ["DOCLING_NUM_THREADS"] = str(n)
    return n

# 布局模型固定到验证当天的快照（#46 回归所用版本）；TableFormer 由 docling 2.126
# 自身钉在 docling-models v2.3.0。
LAYOUT_REPO = "docling-project/docling-layout-heron"
LAYOUT_REVISION = "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"
TABLEFORMER_REPO = "docling-project/docling-models"
TABLEFORMER_REVISION = "v2.3.0"
FORMULA_REPO = "docling-project/CodeFormulaV2"

REQUIRED_MODEL_FILES = [
    f"{LAYOUT_FOLDER}/model.safetensors",
    f"{LAYOUT_FOLDER}/config.json",
    f"{LAYOUT_FOLDER}/preprocessor_config.json",
    f"{TABLEFORMER_FOLDER}/model_artifacts/tableformer/accurate/tm_config.json",
    f"{TABLEFORMER_FOLDER}/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
    f"{TABLEFORMER_FOLDER}/model_artifacts/tableformer/fast/tm_config.json",
    f"{TABLEFORMER_FOLDER}/model_artifacts/tableformer/fast/tableformer_fast.safetensors",
    # RapidOCR torch 后端：PP-OCRv6 det/rec small + PP-OCRv4 cls mobile（见
    # docling.models.stages.ocr.rapid_ocr_model 的 _RAPIDOCR_MODEL_TYPE 常量）。
    f"{RAPIDOCR_FOLDER}/PP-OCRv6_det_small.pth",
    f"{RAPIDOCR_FOLDER}/PP-OCRv6_rec_small.pth",
    f"{RAPIDOCR_FOLDER}/ppocrv6_dict.txt",
    f"{RAPIDOCR_FOLDER}/ch_ptocr_mobile_v2.0_cls_mobile.pth",
]

FORMULA_MODEL_FILES = [
    f"{FORMULA_FOLDER}/config.json",
]


def emit_progress(stage, done=0, total=0):
    line = json.dumps({"stage": stage, "done": done, "total": total}, ensure_ascii=False)
    print(f"PDFPARSE_PROGRESS {line}", flush=True)


def _timing_seconds(item):
    if item is None:
        return 0.0
    total = getattr(item, "total", None)
    if callable(total):
        try:
            return float(total())
        except Exception:  # noqa: BLE001
            return 0.0
    if isinstance(item, dict):
        times = item.get("times") or []
        try:
            return float(sum(times))
        except TypeError:
            return 0.0
    times = getattr(item, "times", None)
    if times:
        try:
            return float(sum(times))
        except TypeError:
            return 0.0
    return 0.0


def summarize_pipeline_timings(timings):
    """把 Docling conversion.timings 收成 {stage: seconds}，至少含 layout/table。"""
    buckets = {
        "layout": 0.0,
        "table": 0.0,
        "ocr": 0.0,
        "page": 0.0,
        "assemble": 0.0,
        "readingOrder": 0.0,
        "other": 0.0,
    }
    if not timings:
        return buckets
    items = timings.items() if hasattr(timings, "items") else []
    known = (
        ("table", ("table", "tableformer")),
        ("ocr", ("ocr", "rapidocr")),
        ("layout", ("layout",)),
        ("readingOrder", ("reading_order", "reading-order", "readingorder")),
        ("assemble", ("assemble",)),
        ("page", ("page", "pdf", "backend", "parse")),
    )
    skip = {"pipeline_total", "pipeline", "total"}
    for key, item in items:
        key_l = str(key).lower()
        if key_l in skip:
            continue
        seconds = _timing_seconds(item)
        matched = None
        for bucket, needles in known:
            if any(needle in key_l for needle in needles):
                matched = bucket
                break
        buckets[matched or "other"] += seconds
    return {key: round(value, 3) for key, value in buckets.items()}


def write_result(out_dir, payload):
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    target = out_path / "result.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PDFPARSE_RESULT {json.dumps(payload, ensure_ascii=False)}", flush=True)


def error_payload(code, message, retryable, **extra):
    payload = {
        "ok": False,
        "error": {"code": code, "message": message, "retryable": retryable},
    }
    payload.update(extra)
    return payload


def missing_models(models_dir, required):
    return [rel for rel in required if not (Path(models_dir) / rel).is_file()]


def hf_download(repo_id, revision, local_dir, endpoint=None, allow_patterns=None):
    """snapshot_download 包装：先按配置端点（默认官方源），网络失败回退 hf-mirror。

    端点显式传给 snapshot_download（huggingface_hub 在 import 时读取 HF_ENDPOINT
    常量，事后改环境变量不生效）；HF_HUB_DISABLE_XET=1 强制走普通 HTTP 路径，
    避免 xet 直传域名在国内网络不可达。仓库/版本不存在（404 类）不是网络问题，
    不做镜像重试，直接抛出。
    """
    from huggingface_hub import snapshot_download

    os.environ["HF_HUB_DISABLE_XET"] = "1"
    endpoints = []
    for candidate in (endpoint or os.environ.get("HF_ENDPOINT") or HF_OFFICIAL, HF_MIRROR):
        if candidate and candidate not in endpoints:
            endpoints.append(candidate)
    last_error = None
    for url in endpoints:
        try:
            return snapshot_download(
                repo_id=repo_id,
                revision=revision,
                local_dir=str(local_dir),
                endpoint=url,
                allow_patterns=allow_patterns,
            )
        except Exception as err:  # noqa: BLE001 - 端点间回退，最后抛结构化错误
            error_kind = type(err).__name__
            if "RevisionNotFound" in error_kind or "RepositoryNotFound" in error_kind:
                raise
            last_error = err
    raise RuntimeError(f"模型下载失败（官方源与镜像均不可达）: {last_error}")


def download_base_models(models_dir, endpoint=None, progress_stage="models"):
    """下载布局 + 表格 + OCR 模型（不依赖 docling 的 CLI，只用其下载器约定）。"""
    models_dir = Path(models_dir)
    steps = [
        (
            "layout",
            lambda: hf_download(
                LAYOUT_REPO,
                LAYOUT_REVISION,
                models_dir / LAYOUT_FOLDER,
                endpoint=endpoint,
            ),
        ),
        (
            "tableformer",
            lambda: hf_download(
                TABLEFORMER_REPO,
                TABLEFORMER_REVISION,
                models_dir / TABLEFORMER_FOLDER,
                endpoint=endpoint,
                allow_patterns=["model_artifacts/**", "README.md", "config.json"],
            ),
        ),
        ("rapidocr", lambda: download_rapidocr_models(models_dir / RAPIDOCR_FOLDER)),
    ]
    total = len(steps)
    for index, (name, action) in enumerate(steps):
        emit_progress(progress_stage, index, total)
        action()
    emit_progress(progress_stage, total, total)


def download_rapidocr_models(local_dir):
    """走 docling 自带的 RapidOCR 下载器（modelscope 源，国内可达）。"""
    from docling.models.stages.ocr.rapid_ocr_model import RapidOcrModel

    RapidOcrModel.download_models(backend="torch", local_dir=Path(local_dir))


def download_formula_model(models_dir, endpoint=None):
    return hf_download(
        FORMULA_REPO,
        "main",
        Path(models_dir) / FORMULA_FOLDER,
        endpoint=endpoint,
    )


def scan_textless_pages(pdf_path):
    """用 pypdfium2 预扫文本层：无文本页将走 OCR，需在结果中标记降级。

    返回 (页码列表, 总页数)；打开失败抛异常（调用方归类为 pdf_open_failed）。
    """
    import pypdfium2 as pdfium

    textless = []
    with pdfium.PdfDocument(str(pdf_path)) as doc:
        total = len(doc)
        for index in range(total):
            page = doc[index]
            try:
                textpage = page.get_textpage()
                try:
                    if textpage.count_chars() == 0:
                        textless.append(index + 1)
                finally:
                    textpage.close()
            finally:
                page.close()
    return textless, total


def cmd_convert(args):
    started = time.perf_counter()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = Path(args.pdf)
    if not pdf_path.is_file():
        write_result(
            out_dir,
            error_payload("pdf_not_found", f"PDF 文件不存在: {pdf_path}", False),
        )
        return 0

    models_dir = Path(args.models_dir)
    required = list(REQUIRED_MODEL_FILES)
    if args.formula_enrichment:
        required += FORMULA_MODEL_FILES
    missing = missing_models(models_dir, required)
    if missing and args.formula_enrichment and missing == FORMULA_MODEL_FILES:
        # 唯一允许在线补模型的路径：用户显式开启了公式 enrichment。
        try:
            download_formula_model(models_dir, endpoint=args.endpoint)
        except Exception as err:  # noqa: BLE001
            write_result(
                out_dir,
                error_payload(
                    "model_download_failed",
                    f"公式模型下载失败: {err}",
                    True,
                ),
            )
            return 0
        missing = missing_models(models_dir, required)
    if missing:
        write_result(
            out_dir,
            error_payload(
                "model_missing",
                "模型工件缺失: " + ", ".join(missing),
                False,
                missing=missing,
            ),
        )
        return 0

    try:
        ocr_pages, page_count = scan_textless_pages(pdf_path)
    except Exception as err:  # noqa: BLE001 - 打开失败（含加密/损坏）
        write_result(
            out_dir,
            error_payload("pdf_open_failed", f"PDF 打开失败: {err}", False),
        )
        return 0

    num_threads = apply_thread_env()
    table_mode = args.table_mode

    # 离线运行：模型全部来自 artifacts 目录，禁止任何 HF 网络访问。
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    emit_progress("startup")
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            AcceleratorOptions,
            PdfPipelineOptions,
            RapidOcrOptions,
            TableFormerMode,
        )
        from docling.datamodel.settings import settings
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except ImportError as err:
        write_result(
            out_dir,
            error_payload("deps_missing", f"侧车依赖不完整: {err}", False),
        )
        return 0

    settings.debug.profile_pipeline_timings = True

    pipeline_options = PdfPipelineOptions(
        artifacts_path=models_dir,
        do_formula_enrichment=args.formula_enrichment,
        # 规格 #48 决策 1：OCR 仅对无文本层页触发。全部页面有文本层时整个 OCR
        # 阶段关闭（默认的 pdf-aware 模式会对插图位图区域做 OCR，CPU 上每页数十秒，
        # 而产物用不上）；存在无文本层页才启用（RapidOCR torch 后端与布局模型共用
        # 同一套 torch 依赖；onnxruntime 不随包）。
        do_ocr=bool(ocr_pages),
        ocr_options=RapidOcrOptions(backend="torch"),
        accelerator_options=AcceleratorOptions(num_threads=num_threads),
    )
    pipeline_options.table_structure_options.mode = TableFormerMode(table_mode)
    try:
        converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
        )
    except Exception as err:  # noqa: BLE001
        write_result(
            out_dir,
            error_payload("conversion_failed", f"管线初始化失败: {err}", True),
        )
        return 0
    emit_progress("models_loaded")

    try:
        conversion = converter.convert(str(pdf_path))
        docling_json = out_dir / "docling.json"
        conversion.document.save_as_json(str(docling_json))
        timings = summarize_pipeline_timings(getattr(conversion, "timings", None))
    except Exception as err:  # noqa: BLE001
        detail = traceback.format_exc()[-1500:]
        write_result(
            out_dir,
            error_payload("conversion_failed", f"PDF 转换失败: {err}", True, detail=detail),
        )
        return 0

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    warnings = []
    if ocr_pages:
        warnings.append("scanned_pages_ocr")
    payload = {
        "ok": True,
        "doclingJsonPath": str(docling_json),
        "pages": page_count,
        "elapsedMs": elapsed_ms,
        "doclingVersion": DOCLING_VERSION,
        "ocrPages": ocr_pages,
        "warnings": warnings,
        "timings": timings,
        "tableMode": table_mode,
        "numThreads": num_threads,
    }
    write_result(out_dir, payload)
    return 0


def cmd_render(args):
    """页图与图表裁切预渲染（Issue #59，规格 #48 §双通道资产）。

    job JSON（--job）：{"scale": 2, "quality": 86, "pages": [1, 2, ...],
    "crops": [{"id": "fig_3", "page": 7, "bbox": [x, y, w, h]}]}；
    bbox 为 pdf.js 视口坐标（左上原点，scale=2），与 pypdfium2 同 scale
    渲染位图的像素坐标系一致，直接作裁切框。裁切框钳制到页边界；
    完全落在页外（钳制后 < 2px）记 skippedCrops，不编造产物（#48 §诚实档 15）。

    产物：<out-dir>/pages/page-{n}.webp、<out-dir>/crops/{id}.webp。
    渲染只用 pypdfium2 + Pillow，不需要布局/OCR 模型；逐页渲染，
    crops 按页分组与页图共享同一次渲染（内存峰值 = 一页位图）。
    """
    started = time.perf_counter()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = Path(args.pdf)
    if not pdf_path.is_file():
        write_result(
            out_dir,
            error_payload("pdf_not_found", f"PDF 文件不存在: {pdf_path}", False),
        )
        return 0

    try:
        job = json.loads(Path(args.job).read_text(encoding="utf-8"))
        scale = float(job.get("scale", 2.0))
        quality = int(job.get("quality", 86))
        if "pages" not in job or job["pages"] is None:
            pages_listed = None
        else:
            pages_listed = sorted({int(p) for p in job["pages"]})
        crops = [
            {
                "id": str(crop["id"]),
                "page": int(crop["page"]),
                "bbox": [float(v) for v in crop["bbox"]],
            }
            for crop in job.get("crops", [])
        ]
        if not (0 < scale <= 8) or not (1 <= quality <= 100):
            raise ValueError("scale/quality 超界")
        for crop in crops:
            if len(crop["bbox"]) != 4 or any(
                not math.isfinite(v) or v < 0 for v in crop["bbox"]
            ):
                raise ValueError(f"裁切 bbox 非法: {crop['id']}")
            if not re.fullmatch(r"[A-Za-z0-9._-]+", crop["id"]) or ".." in crop["id"]:
                raise ValueError(f"裁切 id 不是合法标识: {crop['id']}")
    except (OSError, ValueError, KeyError, TypeError) as err:
        write_result(out_dir, error_payload("job_invalid", f"渲染作业无效: {err}", False))
        return 0

    try:
        import pypdfium2 as pdfium
    except ImportError as err:
        write_result(
            out_dir,
            error_payload("deps_missing", f"侧车依赖不完整: {err}", False),
        )
        return 0

    crops_by_page = {}
    for crop in crops:
        crops_by_page.setdefault(crop["page"], []).append(crop)

    pages_dir = out_dir / "pages"
    crops_dir = out_dir / "crops"
    pages_dir.mkdir(parents=True, exist_ok=True)
    if crops:
        crops_dir.mkdir(parents=True, exist_ok=True)
    result_pages = []
    result_crops = []
    skipped = []
    warnings = []
    render_ms = 0
    encode_ms = 0
    try:
        with pdfium.PdfDocument(str(pdf_path)) as doc:
            page_count = len(doc)
            # pages=null：按 PDF 实际页数渲染全部页图（scope=pages）。
            # 空数组：不输出页图（scope=crops，render_pages 仍含裁切所在页）。
            if pages_listed is None:
                pages = list(range(1, page_count + 1))
            else:
                pages = pages_listed
            render_pages = sorted(set(pages) | set(crops_by_page))
            pages_wanted = set(pages)
            missing = [p for p in render_pages if p < 1 or p > page_count]
            if missing:
                write_result(
                    out_dir,
                    error_payload(
                        "job_invalid",
                        f"渲染页码越界（PDF 共 {page_count} 页）: {missing}",
                        False,
                    ),
                )
                return 0
            planned = len(pages_wanted) + len(crops)
            done = 0
            for page_no in render_pages:
                page = doc[page_no - 1]
                try:
                    render_started = time.perf_counter()
                    bitmap = page.render(scale=scale)
                    img = bitmap.to_pil().convert("RGB")
                    render_ms += int((time.perf_counter() - render_started) * 1000)
                    width, height = img.size
                    if page_no in pages_wanted:
                        target = pages_dir / f"page-{page_no}.webp"
                        encode_started = time.perf_counter()
                        img.save(str(target), "WEBP", quality=quality)
                        encode_ms += int((time.perf_counter() - encode_started) * 1000)
                        result_pages.append(
                            {
                                "page": page_no,
                                "path": str(target),
                                "width": width,
                                "height": height,
                                "bytes": target.stat().st_size,
                            }
                        )
                        done += 1
                        if planned:
                            emit_progress("render", done, planned)
                    for crop in crops_by_page.get(page_no, []):
                        x, y, crop_w, crop_h = crop["bbox"]
                        left = max(0, min(width, round(x)))
                        top = max(0, min(height, round(y)))
                        right = max(0, min(width, round(x + crop_w)))
                        bottom = max(0, min(height, round(y + crop_h)))
                        if right - left < 2 or bottom - top < 2:
                            skipped.append({"id": crop["id"], "reason": "bbox_outside_page"})
                            warnings.append(f"crop_skipped:{crop['id']}")
                            done += 1
                            if planned:
                                emit_progress("render", done, planned)
                            continue
                        cropped = img.crop((left, top, right, bottom))
                        target = crops_dir / f"{crop['id']}.webp"
                        encode_started = time.perf_counter()
                        cropped.save(str(target), "WEBP", quality=quality)
                        encode_ms += int((time.perf_counter() - encode_started) * 1000)
                        result_crops.append(
                            {
                                "id": crop["id"],
                                "page": page_no,
                                "path": str(target),
                                "width": right - left,
                                "height": bottom - top,
                                "bytes": target.stat().st_size,
                            }
                        )
                        done += 1
                        if planned:
                            emit_progress("render", done, planned)
                finally:
                    page.close()
    except Exception as err:  # noqa: BLE001 - pypdfium2 打开/渲染失败统一归类
        detail = traceback.format_exc()[-1500:]
        write_result(
            out_dir,
            error_payload("render_failed", f"页图渲染失败: {err}", True, detail=detail),
        )
        return 0

    write_result(
        out_dir,
        {
            "ok": True,
            "scale": scale,
            "quality": quality,
            "pages": result_pages,
            "crops": result_crops,
            "skippedCrops": skipped,
            "warnings": warnings,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "renderMs": render_ms,
            "encodeMs": encode_ms,
        },
    )
    return 0


def cmd_selfcheck(args):
    """自检：报告 python/docling 版本与各模型工件在位情况。"""
    models_dir = Path(args.models_dir) if args.models_dir else None
    missing = missing_models(models_dir, REQUIRED_MODEL_FILES) if models_dir else list(REQUIRED_MODEL_FILES)
    formula_missing = (
        missing_models(models_dir, FORMULA_MODEL_FILES) if models_dir else list(FORMULA_MODEL_FILES)
    )
    try:
        import docling  # noqa: F401
        import torch  # noqa: F401
        import rapidocr  # noqa: F401

        deps_ok = True
        deps_error = None
    except ImportError as err:
        deps_ok = False
        deps_error = str(err)
    payload = {
        "ok": True,
        "python": sys.version.split()[0],
        "depsOk": deps_ok,
        "depsError": deps_error,
        "doclingVersion": DOCLING_VERSION,
        "modelsDir": str(models_dir) if models_dir else None,
        "missingModels": missing,
        "missingFormulaModel": formula_missing,
        "ready": deps_ok and not missing,
    }
    print(f"PDFPARSE_RESULT {json.dumps(payload, ensure_ascii=False)}", flush=True)
    return 0


def cmd_prefetch_models(args):
    """下载基础模型集（布局/表格/OCR）。假定依赖已安装。"""
    try:
        download_base_models(args.models_dir, endpoint=args.endpoint)
    except Exception as err:  # noqa: BLE001
        write_result(
            args.out_dir,
            error_payload("model_download_failed", f"模型下载失败: {err}", True),
        )
        return 0
    missing = missing_models(args.models_dir, REQUIRED_MODEL_FILES)
    if missing:
        write_result(
            args.out_dir,
            error_payload("model_missing", "模型下载后仍缺失: " + ", ".join(missing), True),
        )
        return 0
    write_result(args.out_dir, {"ok": True, "modelsDir": str(args.models_dir)})
    return 0


def cmd_bootstrap(args):
    """首启下载案：安装 pip 依赖 + 下载模型。只依赖 stdlib（deps 可能尚未安装）。"""
    sidecar_root = Path(args.sidecar_root)
    python_exe = sys.executable
    requirements = sidecar_root / "app" / "requirements-sidecar.txt"
    manifest_dir = Path(args.manifest_dir)
    endpoint = args.endpoint

    def fail(code, message, retryable):
        write_result(manifest_dir, error_payload(code, message, retryable))
        return 0

    # 1) 确保 pip 可用（嵌入版 Python 不带 pip，get-pip.py 随包）。
    # get-pip 按自身设计访问 PyPI（或内嵌 wheel），绝不能继承调用方为依赖安装
    # 准备的离线 PIP_* 环境（实测 PIP_NO_INDEX=1 会让 get-pip 报 "from versions: none"）。
    emit_progress("deps", 0, 3)
    pip_env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PIP_")}
    probe = subprocess.run(
        [python_exe, "-m", "pip", "--version"],
        capture_output=True,
        text=True,
        env=pip_env,
    )
    if probe.returncode != 0:
        get_pip = sidecar_root / "app" / "get-pip.py"
        install = subprocess.run(
            [python_exe, str(get_pip), "--no-warn-script-location"],
            capture_output=True,
            text=True,
            env=pip_env,
        )
        if install.returncode != 0:
            return fail("bootstrap_failed", f"pip 引导失败: {install.stderr[-800:]}", True)

    # 2) 安装钉版依赖（可用 PIP_INDEX_URL 覆盖源）。
    emit_progress("deps", 1, 3)
    env = dict(os.environ)
    if args.pip_index_url:
        env["PIP_INDEX_URL"] = args.pip_index_url
    install = subprocess.run(
        [
            python_exe,
            "-m",
            "pip",
            "install",
            "--no-warn-script-location",
            "--no-cache-dir",
            "-r",
            str(requirements),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    if install.returncode != 0:
        return fail("bootstrap_failed", f"依赖安装失败: {install.stderr[-1500:]}", True)
    # 依赖完整性标记：取消/崩溃留下的残缺 site-packages 不带标记，
    # Rust 门禁（deps_ready）凭它区分"装好了"与"装了一半"。
    (sidecar_root / "deps.ok").write_text(
        f"installed {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n", encoding="utf-8"
    )

    # 3) 依赖就位后，用子进程跑模型下载（当前进程 import 不到新装的包）。
    emit_progress("models", 2, 3)
    models_dir = Path(args.models_dir)
    # --models-dir/--endpoint 是全局参数，必须位于子命令之前。
    models_cmd = [
        python_exe,
        str(Path(__file__).resolve()),
        "--models-dir",
        str(models_dir),
    ]
    if endpoint:
        models_cmd += ["--endpoint", endpoint]
    models_cmd += ["prefetch-models", "--out-dir", str(manifest_dir)]
    prefetch = subprocess.run(models_cmd, capture_output=True, text=True)
    for line in prefetch.stdout.splitlines():
        if line.startswith("PDFPARSE_PROGRESS"):
            print(line, flush=True)
    result_line = next(
        (line for line in prefetch.stdout.splitlines() if line.startswith("PDFPARSE_RESULT ")),
        None,
    )
    if result_line is None:
        return fail(
            "bootstrap_failed",
            f"模型下载子进程异常退出（exit={prefetch.returncode}）: {prefetch.stderr[-800:]}",
            True,
        )
    payload = json.loads(result_line[len("PDFPARSE_RESULT "):])
    if not payload.get("ok"):
        write_result(manifest_dir, payload)
        return 0

    emit_progress("models", 3, 3)
    write_result(manifest_dir, {"ok": True, "modelsDir": str(models_dir)})
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pdfparse_sidecar")
    parser.add_argument(
        "--models-dir",
        default=os.environ.get("PDFPARSE_MODELS_DIR", ""),
        help="模型 artifacts 目录（也可用 PDFPARSE_MODELS_DIR 环境变量）",
    )
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("HF_ENDPOINT") or None,
        help="HF 下载端点（默认官方源，失败自动回退 hf-mirror）",
    )
    parser.add_argument(
        "--table-mode",
        choices=["fast", "accurate"],
        default="fast",
        help="表格结构识别模式（默认 fast）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_convert = sub.add_parser("convert", help="PDF → DoclingDocument JSON")
    p_convert.add_argument("--pdf", required=True)
    p_convert.add_argument("--out-dir", required=True)
    p_convert.add_argument("--formula-enrichment", action="store_true")

    p_render = sub.add_parser("render", help="页图与图表裁切预渲染（scale=2 webp）")
    p_render.add_argument("--pdf", required=True)
    p_render.add_argument("--out-dir", required=True)
    p_render.add_argument("--job", required=True, help="渲染作业 JSON 路径")

    sub.add_parser("selfcheck", help="自检侧车与模型在位情况")

    p_prefetch = sub.add_parser("prefetch-models", help="下载基础模型集")
    p_prefetch.add_argument("--out-dir", required=True)

    p_boot = sub.add_parser("bootstrap", help="首启下载案：装依赖 + 下模型")
    p_boot.add_argument(
        "--sidecar-root",
        default=str(Path(__file__).resolve().parent.parent),
        help="侧车根目录（默认取脚本所在 app/ 的上一级）",
    )
    p_boot.add_argument("--manifest-dir", required=True, help="result.json 写入目录")
    p_boot.add_argument("--pip-index-url", default=os.environ.get("PIP_INDEX_URL") or None)

    args = parser.parse_args(argv)
    # render/selfcheck 不触碰模型：render 只用 pypdfium2 + Pillow。
    if not args.models_dir and args.command not in ("render", "selfcheck"):
        out_dir = getattr(args, "out_dir", None) or getattr(args, "manifest_dir", None) or "."
        write_result(out_dir, error_payload("model_missing", "未指定模型目录", False))
        return 0
    if args.command == "convert":
        return cmd_convert(args)
    if args.command == "render":
        return cmd_render(args)
    if args.command == "selfcheck":
        return cmd_selfcheck(args)
    if args.command == "prefetch-models":
        return cmd_prefetch_models(args)
    if args.command == "bootstrap":
        return cmd_bootstrap(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
