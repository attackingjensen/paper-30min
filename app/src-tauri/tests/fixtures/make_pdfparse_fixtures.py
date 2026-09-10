# -*- coding: utf-8 -*-
"""生成 pdfparse 契约测试的 PDF 夹具（纯 stdlib，输出已提交，无需重跑）。

- pdfparse_scanned_blank.pdf：单页、无文本层、只有一个填充矩形，
  用于触发 Docling 的 OCR 降级路径（OCR 模型加载 + 扫描页标记）。
重跑：python app/src-tauri/tests/fixtures/make_pdfparse_fixtures.py
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def make_scanned_blank_pdf() -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    ]
    stream = b"0.5 0.5 0.5 rg\n72 600 200 100 re f\n"
    objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (index, body)
    xref = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


if __name__ == "__main__":
    target = HERE / "pdfparse_scanned_blank.pdf"
    target.write_bytes(make_scanned_blank_pdf())
    print(f"written {target} ({target.stat().st_size} bytes)")
