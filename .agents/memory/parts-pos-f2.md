---
name: Parts counter F2 accounting
description: Approved shift-close treatment and isolated parts testing boundaries.
---
The user approved separate cash-transfer and actual over/short postings for F2 parts-counter shift closing.

**Why:** The supplied F2 diagram mixes a till transfer with an unresolved cash-over/short annotation; these are distinct accounting events.

**How to apply:** A bank/float transfer does not create an expense. Only counted cash minus expected cash creates an over/short entry. Reconciliation itself creates no GL.

The user requested clearly identified dummy parts for CAM Motors Dummy. Artificial stock and prices belong only to that dealer, never real GT/CAM inventory.

**Why:** The connected ERP company was previously confirmed test-only, but vehicle VAT approval does not independently authorize the new parts tax configuration.

**How to apply:** Require Finance approval of parts VAT and validated brand/item/warehouse mappings before posting. Do not invent HSN codes to bypass ERP compliance. ERP stock-updating Sales Invoices must not also enqueue a Stock Entry for the same sale.

The user authorized defining fictional products for the five dummy parts when asked for descriptions and HSN classifications.

**Why:** Generic brand-only sample names could not establish a classification, and ERPNext requires HSN on item creation.

**How to apply:** Use specific fictional product descriptions with matching entries verified against the ERP HSN catalogue. Treat brands as test accounting buckets, not verified fitment. This authorization does not approve real-stock classifications, tax rules, opening balances or accounting postings.
