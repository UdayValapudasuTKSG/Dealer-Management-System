import fitz
from glob import glob

filenames = sorted(glob("artifacts/api-server/outputs/demo-test-*.pdf"))
assert len(filenames) == 13, filenames
filenames += ["artifacts/api-server/outputs/demo-report-sales-pipeline.pdf",
              "artifacts/api-server/outputs/demo-report-large.pdf"]
for filename in filenames:
    pdf = fitz.open(filename)
    assert 0 < len(pdf) < 100, (filename, len(pdf))
    full = "\n".join(page.get_text() for page in pdf)
    assert "DEMO · Harbour Motors" in full
    assert "GYD 42,500" in full
    if "large" in filename:
        assert "DEMO-500" in full
    else:
        assert "DEMO-5" in full
    for number, page in enumerate(pdf):
        assert len(page.get_text().strip()) > 40, (filename, number)
        assert f"{number + 1} / {len(pdf)}" in page.get_text()
        for block in page.get_text("blocks"):
            if block[6] == 0:
                assert block[0] >= -0.5 and block[2] <= page.rect.width + 0.5, (filename, number, block)
                assert block[1] >= -0.5 and block[3] <= page.rect.height + 0.5, (filename, number, block)
    if "demo-report-" in filename:
        pdf[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(
            filename.replace(".pdf", "-page1.png")
        )
    print(filename, len(pdf), "pages: text, footer, bounds OK")