from pathlib import Path
import fitz

source = "attached_assets/Purchase_Order_Template_1790307325865.pdf"
output = Path(".agents/outputs/po-template")
output.mkdir(parents=True, exist_ok=True)
doc = fitz.open(source)
print("Pages:", len(doc))
for i, page in enumerate(doc):
    page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(output / f"page-{i+1}.png")
    print(f"PAGE {i+1} {page.rect}\n{page.get_text()}")