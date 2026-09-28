"""Keep the original Illustrator flyer immutable; render an email-sized raster PDF."""
from pathlib import Path
import fitz

source = next(Path("attached_assets").glob("BYD-SEALION_7*1790623801776.pdf"))
output = Path(".agents/outputs/BYD-SEALION-7-email.pdf")
output.parent.mkdir(parents=True, exist_ok=True)

doc = fitz.open(source)
print("Source pages:", doc.page_count)
for i, page in enumerate(doc):
    page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False).save(
        output.parent / f"BYD-SEALION-7-before-{i + 1}.png"
    )
print("Original embedded images:", [(img[0], img[2:4]) for img in doc[0].get_images(full=True)[:8]])
mail = fitz.open()
for page in doc:
    # Illustrator's unusually large vector content cannot be shrunk by image
    # recompression. Render at print-quality 240 DPI, JPEG 90 for readable
    # specification text and accurate prices while retaining the original PDF.
    pixels = page.get_pixmap(matrix=fitz.Matrix(240 / 72, 240 / 72), alpha=False)
    image = pixels.tobytes("jpeg", jpg_quality=90)
    target = mail.new_page(width=page.rect.width, height=page.rect.height)
    target.insert_image(target.rect, stream=image)
mail.set_metadata({
    "title": "BYD Sealion 7 EV flyer — email-optimized copy",
    "subject": "GT Automotive BYD Sealion 7 flyer",
})
mail.save(output, garbage=4, deflate=True)
mail.close()
doc.close()
print("Optimized bytes:", output.stat().st_size)
optimized = fitz.open(output)
assert optimized.page_count == 2
for i, page in enumerate(optimized):
    page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False).save(
        output.parent / f"BYD-SEALION-7-after-{i + 1}.png"
    )
print("Text layer in optimized raster:", [len(page.get_text().strip()) for page in optimized])