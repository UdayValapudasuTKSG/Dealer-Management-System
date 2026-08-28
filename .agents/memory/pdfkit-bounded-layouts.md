---
name: PDFKit bounded layouts
description: Preventing accidental sparse pages in fixed-coordinate PDFKit documents
---

In fixed-coordinate PDFKit documents, keep every variable-width text region bounded to an intentional number of lines and budget the entire maximum payload against the printable page height. An explicit `y` beyond the current A4 page can make successive text calls auto-create separate sparse pages.

**Why:** A quotation with many vehicle specifications wrapped inside an unexpectedly narrow description column. Once its running `y` passed the page boundary, totals, approvals, signatures, and disclaimer calls each landed on additional mostly-white pages.

**How to apply:** Check actual column arithmetic, cap or ellipsize variable text where the document is intentionally single-page, compact optional sections, and generate a maximum-item stress PDF. Verify its page count with `pdfinfo` and render page one for visual overlap checks.