# -*- coding: utf-8 -*-
"""生成 pdfparse 契约测试的 PDF 夹具（纯 stdlib，输出已提交，无需重跑）。

- pdfparse_scanned_blank.pdf：单页、无文本层、只有一个填充矩形，
  用于触发 Docling 的 OCR 降级路径（OCR 模型加载 + 扫描页标记）。
- pdfparse_formula_graphics.pdf（Issue #60）：单页、有文本层，
  文本之间夹一个纯路径算子绘制的矢量公式与一个 FlateDecode 位图公式，
  用于回归「矢量与图片公式」类样例：图形内容不得静默产出失真文本，
  被布局模型检出的区域必须是占位块 + 可裁切 bbox。
重跑：python app/src-tauri/tests/fixtures/make_pdfparse_fixtures.py
"""
import math
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent


def assemble_pdf(objects):
    """objects: bytes 列表（1 号对象在前）；返回完整 PDF 字节。"""
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


def make_scanned_blank_pdf() -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    ]
    stream = b"0.5 0.5 0.5 rg\n72 600 200 100 re f\n"
    objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
    return assemble_pdf(objects)


def formula_bitmap(width=240, height=48) -> bytes:
    """确定性生成一张"显示公式"形态的位图（白底黑纹：积分号、等号、分式）。"""
    px = bytearray(b"\xff" * width * height * 3)

    def dot(x, y, size=1):
        for dy in range(size):
            for dx in range(size):
                xx, yy = x + dx, y + dy
                if 0 <= xx < width and 0 <= yy < height:
                    i = (yy * width + xx) * 3
                    px[i : i + 3] = b"\x00\x00\x00"

    for y in range(6, 42):  # 左侧积分号模样：竖长 S 曲线
        dot(30 + int(6 * math.sin(y / 6.0)), y, 3)
    for x in range(55, 70):  # 等号
        dot(x, 28, 2)
        dot(x, 20, 2)
    for x in range(40 + 60, 200):  # 分式横线
        dot(x, 24, 2)
    for x in range(95, 130, 6):  # 分子符号团
        dot(x + 20, 34, 3)
        dot(x + 22, 40, 2)
    for x in range(95, 130, 6):  # 分母符号团
        dot(x + 20, 10, 3)
    return bytes(px)


def make_formula_graphics_pdf() -> bytes:
    """一页夹具：真实文本层 + 矢量公式（纯路径，无文本算子）+ 位图公式。"""
    bitmap = formula_bitmap()
    compressed = zlib.compress(bitmap)

    text_ops = []
    for font, font_size, x, y, content in [
        ("F2", 20, 72, 730, "Formula Graphics Fixture"),
        ("F2", 14, 72, 695, "1. Introduction"),
        ("F1", 10, 72, 665, "This page mixes real text with a vector-drawn formula and an image formula."),
        ("F1", 10, 72, 420, "The vector formula above is drawn with path operators only."),
        ("F1", 10, 72, 270, "The image formula above is a raster bitmap."),
        ("F2", 14, 72, 200, "2. Conclusion"),
        ("F1", 10, 72, 175, "Section boundaries must survive graphics regions."),
    ]:
        text_ops.append("BT /%s %d Tf %d %d Td (%s) Tj ET" % (font, font_size, x, y, content))

    # 矢量公式区（y 450–530，x 150–310）：积分号 S 形描边 + 分式横线 + 符号块，纯路径。
    vector_ops = [
        "2 w 0 0 0 RG",
        "168 455 m 196 462 196 484 196 496 c 196 512 182 524 168 524 c S",
        "150 490 m 310 490 l S",
        "226 498 14 9 re f",
        "252 498 10 14 re f",
        "226 464 14 9 re f",
        "252 460 10 12 re f",
    ]
    # 位图公式区：240×48 置于 (186, 310)。
    image_ops = ["q", "240 0 0 48 186 310 cm", "/Im1 Do", "Q"]

    stream = "\n".join(text_ops + vector_ops + image_ops).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R /F2 7 0 R >> /XObject << /Im1 6 0 R >> >> "
        b"/Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /XObject /Subtype /Image /Width 240 /Height 48 "
        b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
        b"/Length %d >>\nstream\n" % len(compressed)
        + compressed
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ]
    return assemble_pdf(objects)


if __name__ == "__main__":
    scanned = HERE / "pdfparse_scanned_blank.pdf"
    scanned.write_bytes(make_scanned_blank_pdf())
    print(f"written {scanned} ({scanned.stat().st_size} bytes)")
    graphics = HERE / "pdfparse_formula_graphics.pdf"
    graphics.write_bytes(make_formula_graphics_pdf())
    print(f"written {graphics} ({graphics.stat().st_size} bytes)")
