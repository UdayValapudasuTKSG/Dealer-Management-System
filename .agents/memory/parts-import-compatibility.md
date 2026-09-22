---
name: Parts import compatibility
description: How user-supplied pricing layouts relate to the broader parts catalog.
---

Treat a supplied pricing workbook as an additional supported layout, not an exhaustive replacement for the parts catalog template.

**Why:** The user clarified that Make, Barcode, Costing Method, Supplier, and other catalog fields must remain available even though their example pricing sheet contains only pricing columns.

**How to apply:** Extend templates and mappings without dropping existing catalog fields. Preserve support for the original shorter workbook. Keep descriptive vehicle make separate from category; accepting a make does not establish model-level fitment compatibility. Missing import columns must not erase existing catalog metadata.