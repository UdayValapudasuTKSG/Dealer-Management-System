import fitz
doc = fitz.open("attached_assets/Faraz_Yassin_-_Q1_-_7-7-2026_1785695282919.pdf")
print("pages:", doc.page_count)
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=fitz.Matrix(2,2))
    pix.save(f".agents/outputs/quote_p{i+1}.png")
