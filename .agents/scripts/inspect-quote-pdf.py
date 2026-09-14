import sys
from pathlib import Path
import fitz

source = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
doc = fitz.open(source)
print(f"{source.name}: {len(doc)} pages")
for index, page in enumerate(doc):
    page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(out / f"page-{index+1}.png")
    (out / f"page-{index+1}.txt").write_text(page.get_text())