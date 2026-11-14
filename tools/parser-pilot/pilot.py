"""Offline parser comparison preparation; no network requests or credentials."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "legacy/v1/app/src-tauri/sidecar/pdfparse"
CORPUS = ROOT / "legacy/v1/app/src-tauri/tests/fixtures/regression/corpus"
PAPERS = ("1412.6980", "1503.02531", "1512.03385", "1603.02754")


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_box(box, size):
    return (isinstance(box, list) and len(box) == 4
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
            and box[0] >= 0 and box[1] >= 0 and box[2] > 0 and box[3] > 0
            and box[0] + box[2] <= size[0] + 0.01
            and box[1] + box[3] <= size[1] + 0.01)


def baidu_records(raw, sizes):
    records = []
    seen = set()
    for page in raw["pages"]:
        n = page["page_num"]
        if type(n) is not int or n < 0 or n >= len(sizes) or n in seen:
            raise ValueError("Invalid or duplicate Baidu page_num")
        seen.add(n)
        size = sizes[n]
        meta = page.get("meta", {})
        source = (meta.get("page_width", 0), meta.get("page_height", 0))
        dimensions_ok = (all(isinstance(v, (int, float)) and math.isfinite(v)
                             and v > 0 for v in source)
                         and abs(source[0] / source[1] - size[0] / size[1]) < 0.005)
        supplements = {item["layout_id"]: item for key in ("tables", "images")
                       for item in page.get(key, [])}
        for layout in page.get("layouts", []):
            box = layout.get("position")
            projected = None
            if dimensions_ok and page.get("page_angle") == 0 and valid_box(box, source):
                projected = [box[0] * size[0] / source[0], box[1] * size[1] / source[1],
                             box[2] * size[0] / source[0], box[3] * size[1] / source[1]]
            extra = supplements.get(layout.get("layout_id"), {})
            records.append({"page": n + 1, "id": layout.get("layout_id"),
                "type": layout.get("type"), "text": layout.get("text") or extra.get("markdown", ""),
                "bboxPoints": projected,
                "geometryStatus": "candidate" if projected else "unverified",
                "rawPosition": box, "pageAngle": page.get("page_angle")})
    if seen != set(range(len(sizes))):
        raise ValueError("Baidu result is missing pages")
    return records


def docling_records(raw, sizes):
    records = []
    # Keep collection/provenance order; this is not a recovered reading-order model.
    for key in ("texts", "tables", "pictures"):
        for item in raw.get(key, []):
            for prov in item.get("prov", []):
                n = prov["page_no"]
                if type(n) is not int or not 1 <= n <= len(sizes):
                    raise ValueError("Invalid Docling page_no")
                size = sizes[n - 1]
                source = raw.get("pages", {}).get(str(n), {}).get("size", {})
                box = prov.get("bbox", {})
                projected = None
                if all(abs(source.get(k, 0) - v) < 0.01 for k, v in zip(("width", "height"), size)):
                    origin = box.get("coord_origin")
                    if origin in ("BOTTOMLEFT", "TOPLEFT"):
                        y = size[1] - box["t"] if origin == "BOTTOMLEFT" else box["t"]
                        candidate = [box["l"], y, box["r"] - box["l"], abs(box["t"] - box["b"])]
                        if valid_box(candidate, size):
                            projected = candidate
                records.append({"page": n, "id": item.get("self_ref"),
                    "type": item.get("label", key), "text": item.get("text", ""),
                    "bboxPoints": projected,
                    "geometryStatus": "candidate" if projected else "unverified"})
    return records


def aistudio_records(raw, sizes):
    pages = []
    for row in raw:
        if row.get("errorCode") != 0:
            raise ValueError("AI Studio JSONL contains a failed batch")
        pages.extend(row["result"]["layoutParsingResults"])
    if len(pages) != len(sizes):
        raise ValueError("AI Studio JSONL page count differs from original PDF")
    records = []
    for n, page in enumerate(pages):
        pruned = page["prunedResult"]
        source = (pruned["width"], pruned["height"])
        size = sizes[n]
        geometry_ok = (all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in source)
            and abs(source[0] / source[1] - size[0] / size[1]) < 0.005
            and pruned.get("model_settings", {}).get("use_doc_preprocessor") is False)
        for block in pruned["parsing_res_list"]:
            xyxy = block.get("block_bbox")
            projected = None
            if (geometry_ok and isinstance(xyxy, list) and len(xyxy) == 4
                    and all(isinstance(v, (int, float)) and math.isfinite(v) for v in xyxy)):
                box = [xyxy[0], xyxy[1], xyxy[2] - xyxy[0], xyxy[3] - xyxy[1]]
                if valid_box(box, source):
                    projected = [box[0] * size[0] / source[0], box[1] * size[1] / source[1],
                                 box[2] * size[0] / source[0], box[3] * size[1] / source[1]]
            records.append({"page": n + 1, "id": f"{n + 1}:{block.get('block_id')}",
                "type": block.get("block_label"), "text": block.get("block_content", ""),
                "groupId": block.get("group_id"), "order": block.get("block_order"),
                "bboxPoints": projected, "rawPositionXYXY": xyxy, "pageAssignment": "jsonl-order",
                "geometryStatus": "candidate" if projected else "unverified"})
    return records


def inspect(pdf, raw_path, provider, out):
    import pypdfium2 as pdfium
    from PIL import ImageDraw
    out.mkdir(parents=True, exist_ok=False)
    with pdfium.PdfDocument(str(pdf)) as document:
        sizes = [tuple(document[i].get_size()) for i in range(len(document))]
        raw = ([json.loads(line) for line in raw_path.read_text(encoding="utf-8").splitlines()
                if line.strip()] if provider == "aistudio" else read(raw_path))
        mapper = {"baidu": baidu_records, "docling": docling_records, "aistudio": aistudio_records}[provider]
        records = mapper(raw, sizes)
        for record in records:
            page = document[record["page"] - 1]
            if page.get_rotation() != 0:
                record["bboxPoints"] = None
                record["geometryStatus"] = "unverified-pdf-rotation"
            page.close()
        save(out / "records.json", records)
        save(out / "summary.json", {"provider": provider, "pdfSha256": digest(pdf),
            "rawSha256": digest(raw_path), "pageSizesPoints": sizes,
            "types": dict(Counter(r["type"] for r in records)),
            "unverifiedBoxes": sum(r["bboxPoints"] is None for r in records),
            "qualityVerdict": "pending-manual-review", "coordinateVerdict": "pending-overlay-review"})
        for n in range(len(document)):
            page = document[n]
            bitmap = page.render(scale=1.5)
            picture = bitmap.to_pil().copy()
            draw = ImageDraw.Draw(picture)
            for index, record in enumerate(records):
                if record["page"] != n + 1 or record["bboxPoints"] is None:
                    continue
                x, y, w, h = [v * 1.5 for v in record["bboxPoints"]]
                draw.rectangle((x, y, x + w, y + h), outline="red", width=2)
                draw.text((x, y), str(index), fill="red")
            picture.save(out / f"page-{n + 1}.png")
            bitmap.close()
            page.close()


def baseline(out):
    import pypdfium2 as pdfium
    out.mkdir(parents=True, exist_ok=False)
    python = SIDECAR / "python/python.exe"
    manifest = read(SIDECAR / "sidecar-manifest.json")
    for paper in PAPERS:
        pdf = CORPUS / f"{paper}.pdf"
        target = out / paper
        target.mkdir()
        with pdfium.PdfDocument(str(pdf)) as document:
            pages = len(document)
        identity = {"pdf": str(pdf), "pdfSha256": digest(pdf), "pages": pages,
                    "sidecarManifest": manifest, "tableMode": "fast", "formulaEnrichment": False,
                    "sidecarScriptSha256": digest(SIDECAR / "app/pdfparse_sidecar.py")}
        save(target / "run.json", {**identity, "status": "running"})
        start = time.perf_counter()
        phase = "convert"
        exit_code = None
        elapsed = None
        try:
            with (target / "sidecar.log").open("w", encoding="utf-8") as log:
                result = subprocess.run([str(python), str(SIDECAR / "app/pdfparse_sidecar.py"),
                    "--models-dir", str(SIDECAR / "models"), "--table-mode", "fast", "convert",
                    "--pdf", str(pdf), "--out-dir", str(target)], stdout=log, stderr=subprocess.STDOUT,
                    timeout=600)
            exit_code = result.returncode
            elapsed = time.perf_counter() - start
            payload = read(target / "result.json")
            if exit_code != 0 or payload.get("ok") is not True or not (target / "docling.json").is_file():
                raise RuntimeError(f"Local conversion failed: {paper}; inspect result.json and sidecar.log")
            phase = "inspection"
            inspect(pdf, target / "docling.json", "docling", target / "inspection")
        except Exception as error:
            save(target / "run.json", {**identity, "status": "failed", "failurePhase": phase,
                "failureType": type(error).__name__, "exitCode": exit_code,
                "elapsedSeconds": elapsed if elapsed is not None else time.perf_counter() - start})
            raise
        save(target / "run.json", {**identity, "status": "success", "elapsedSeconds": elapsed,
                                   "exitCode": exit_code})
        print(f"{paper}: {pages} pages; local baseline saved", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    local = commands.add_parser("baseline")
    local.add_argument("--out", type=Path, required=True)
    review = commands.add_parser("inspect")
    review.add_argument("--provider", choices=("baidu", "docling", "aistudio"), required=True)
    review.add_argument("--pdf", type=Path, required=True)
    review.add_argument("--raw", type=Path, required=True)
    review.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "baseline":
        baseline(args.out.resolve())
    else:
        inspect(args.pdf.resolve(), args.raw.resolve(), args.provider, args.out.resolve())


if __name__ == "__main__":
    main()
