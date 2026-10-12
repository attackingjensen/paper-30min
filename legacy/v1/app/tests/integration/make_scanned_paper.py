"""Rasterize the real ResNet paper at 300 DPI for installed-reader load measurements."""
import sys
from pathlib import Path

import pymupdf

source = Path(__file__).resolve().parents[2] / "src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf"
destination = Path(sys.argv[1])
with pymupdf.open(source) as original, pymupdf.open() as scanned:
    page_count = len(original)
    for page in original:
        pixels = page.get_pixmap(dpi=300, alpha=False)
        image = pixels.tobytes("jpeg", jpg_quality=90)
        target = scanned.new_page(width=page.rect.width, height=page.rect.height)
        target.insert_image(target.rect, stream=image)
    scanned.save(destination, deflate=True)
print(f"Generated {page_count} scanned-paper pages at 300 DPI: {destination}")
