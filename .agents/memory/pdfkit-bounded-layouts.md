---
name: PDFKit bounded layouts
description: Preventing accidental sparse pages in fixed-coordinate PDFKit documents
---

In fixed-coordinate PDFKit documents, measure variable-width text and budget the entire payload against the printable page height. Commercial snapshot descriptions must wrap completely, not be ellipsized to fit a single page. An explicit `y` beyond the current A4 page can make successive text calls auto-create separate sparse pages.

**Why:** A quotation with many vehicle specifications wrapped inside an unexpectedly narrow description column. Once its running `y` passed the page boundary, totals, approvals, signatures, and disclaimer calls each landed on additional mostly-white pages.

**How to apply:** Check actual column arithmetic, reserve footer/closing-block space before planning rows, move whole rows to continuation pages where possible, and split only oversized rows. Reject impossible page budgets instead of looping. Generate a maximum-item stress PDF and inspect page counts and continuation pages as well as page one.