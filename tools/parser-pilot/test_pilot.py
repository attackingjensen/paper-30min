import importlib.util
from pathlib import Path
import unittest
import subprocess
import tempfile
from unittest.mock import patch

try:
    import pypdfium2 as pdfium
except ImportError:
    pdfium = None

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class GeometryTests(unittest.TestCase):
    def test_baidu_zero_based_page_and_scaled_box(self):
        raw = {"pages": [{"page_num": 0, "page_angle": 0,
            "meta": {"page_width": 1200, "page_height": 1600},
            "layouts": [{"layout_id": "x", "type": "table",
                         "position": [100, 200, 300, 400]}],
            "tables": [{"layout_id": "x", "markdown": "| 12.5 |"}]}]}
        records = pilot.baidu_records(raw, [(600, 800)])
        self.assertEqual(records[0]["page"], 1)
        self.assertEqual(records[0]["bboxPoints"], [50, 100, 150, 200])
        self.assertEqual(records[0]["text"], "| 12.5 |")
        self.assertEqual(records[0]["geometryStatus"], "candidate")

    def test_rotated_missing_angle_and_wrong_aspect_are_not_precise(self):
        for angle, width in [(90, 600), (None, 600), (0, 800)]:
            raw = {"pages": [{"page_num": 0, "page_angle": angle,
                "meta": {"page_width": width, "page_height": 800},
                "layouts": [{"position": [10, 20, 30, 40], "type": "text"}]}]}
            self.assertIsNone(pilot.baidu_records(raw, [(600, 800)])[0]["bboxPoints"])

    def test_docling_bottom_left(self):
        raw = {"texts": [{"self_ref": "#/texts/0", "label": "text", "text": "abc",
            "prov": [{"page_no": 1, "bbox": {"l": 10, "b": 100, "r": 50,
                "t": 130, "coord_origin": "BOTTOMLEFT"}}]}],
            "pages": {"1": {"size": {"width": 600, "height": 800}}}}
        record = pilot.docling_records(raw, [(600, 800)])[0]
        self.assertEqual(record["bboxPoints"], [10, 670, 40, 30])

    def test_invalid_boxes_and_nonfinite_values(self):
        for box in [[-1, 2, 3, 4], [1, 2, 0, 4], [599, 2, 3, 4],
                    [float("nan"), 2, 3, 4]]:
            self.assertFalse(pilot.valid_box(box, (600, 800)))

    def test_missing_and_duplicate_pages_are_rejected(self):
        with self.assertRaises(ValueError):
            pilot.baidu_records({"pages": []}, [(600, 800)])
        page = {"page_num": 0, "layouts": []}
        with self.assertRaises(ValueError):
            pilot.baidu_records({"pages": [page, page]}, [(600, 800)])

    def test_docling_unknown_origin_is_unverified(self):
        raw = {"texts": [{"prov": [{"page_no": 1, "bbox": {"coord_origin": "unknown"}}]}],
            "pages": {"1": {"size": {"width": 600, "height": 800}}}}
        self.assertIsNone(pilot.docling_records(raw, [(600, 800)])[0]["bboxPoints"])

    def test_docling_top_left_and_dimension_mismatch(self):
        raw = {"texts": [{"prov": [{"page_no": 1, "bbox": {"l": 10, "t": 20,
            "r": 40, "b": 60, "coord_origin": "TOPLEFT"}}]}],
            "pages": {"1": {"size": {"width": 600, "height": 800}}}}
        self.assertEqual(pilot.docling_records(raw, [(600, 800)])[0]["bboxPoints"], [10, 20, 30, 40])
        self.assertIsNone(pilot.docling_records(raw, [(601, 800)])[0]["bboxPoints"])


@unittest.skipUnless(pdfium is not None, "Run with installed sidecar Python for PDF integration")
class PdfIntegrationTests(unittest.TestCase):
    def test_rotation_inspection_and_output_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            pdf = base / "rotated.pdf"
            with pdfium.PdfDocument.new() as document:
                page = document.new_page(600, 800)
                page.set_rotation(90)
                page.close()
                document.save(str(pdf))
            with pdfium.PdfDocument(str(pdf)) as document:
                width, height = document[0].get_size()
            raw = base / "raw.json"
            pilot.save(raw, {"pages": [{"page_num": 0, "page_angle": 0,
                "meta": {"page_width": width, "page_height": height},
                "layouts": [{"type": "text", "position": [10, 20, 30, 40]}]}]})
            out = base / "inspection"
            pilot.inspect(pdf, raw, "baidu", out)
            record = pilot.read(out / "records.json")[0]
            self.assertIsNone(record["bboxPoints"])
            self.assertEqual(record["geometryStatus"], "unverified-pdf-rotation")
            self.assertTrue((out / "page-1.png").is_file())
            with self.assertRaises(FileExistsError):
                pilot.inspect(pdf, raw, "baidu", out)

    @unittest.skipUnless((pilot.SIDECAR / "sidecar-manifest.json").is_file(), "Installed sidecar needed")
    def test_failed_baseline_never_persists_success(self):
        for failure in ("business", "missing-json", "invalid-json", "timeout"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                out = Path(directory) / "baseline"

                def failed_process(command, **kwargs):
                    target = Path(command[command.index("--out-dir") + 1])
                    if failure == "timeout":
                        raise subprocess.TimeoutExpired(command, 600)
                    pilot.save(target / "result.json", {"ok": failure != "business"})
                    if failure == "business":
                        pilot.save(target / "docling.json", {"texts": [], "tables": [], "pictures": []})
                    if failure == "invalid-json":
                        (target / "docling.json").write_text("{", encoding="utf-8")
                    return subprocess.CompletedProcess(command, 0)

                with patch.object(pilot, "PAPERS", ("1412.6980",)), patch.object(
                        pilot.subprocess, "run", side_effect=failed_process):
                    expected = (subprocess.TimeoutExpired if failure == "timeout"
                                else ValueError if failure == "invalid-json" else RuntimeError)
                    with self.assertRaises(expected):
                        pilot.baseline(out)
                record = pilot.read(out / "1412.6980/run.json")
                self.assertEqual(record["status"], "failed")
                self.assertEqual(record["failurePhase"], "inspection" if failure == "invalid-json" else "convert")


if __name__ == "__main__":
    unittest.main()
