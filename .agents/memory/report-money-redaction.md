---
name: Mixed-source report financial redaction
description: Financial report exports can expose vehicle prices through derived pipeline metrics.
---

When a report's money values derive from both vehicle pricing and deal financials, hiding either contributing permission group must suppress the derived currency values in JSON, PDF tables, KPIs and charts.

**Why:** A vehicle-price-restricted role could still infer those prices from pipeline totals when the report checked only deal-financial visibility.

**How to apply:** Test each contributing field restriction independently, with a full-access positive control. Reuse authorized report payloads for PDF exports rather than re-querying unrestricted data.