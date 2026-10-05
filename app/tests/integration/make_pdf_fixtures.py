"""Build local WebView fixtures with pypdf/Pillow; never modify corpus PDFs."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter

output = Path(sys.argv[1])
corpus = Path(__file__).resolve().parents[2] / "src-tauri/tests/fixtures/regression/corpus"
writer = PdfWriter()
for source in sorted(corpus.glob("*.pdf")):
    writer.append(PdfReader(source))
writer.write(output / "long.pdf")

writer = PdfWriter()
source = PdfReader(corpus / "1512.03385.pdf")
for index, size in enumerate([(612, 792), (842, 595), (420, 595)]):
    writer.add_page(source.pages[index])
    writer.pages[-1].scale_to(*size)
writer.write(output / "mixed.pdf")

image = Image.new("RGB", (1224, 1584), "white")
draw = ImageDraw.Draw(image)
draw.text((100, 100), "SCANNED PAGE - no PDF text layer", fill="black", font_size=36)
draw.text((100, 220), "Figure 1: Accuracy across training epochs", fill="black", font_size=28)
draw.line([(120, 600), (120, 330), (600, 330)], fill="black", width=4)
draw.line([(120, 580), (220, 520), (320, 470), (420, 430), (580, 380)], fill="green", width=6)
image.save(output / "scan-image.pdf", "PDF", resolution=144)
image.save(output / "scan-fixture.png")
print("Generated long, mixed-size and bitmap scan fixtures")
