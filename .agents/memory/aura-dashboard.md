---
name: AURA dashboard conventions
description: Non-obvious KPI semantics and operational rules for the AURA dealership OS dashboard.
---

# AURA dashboard conventions

- `conversionRate` (dashboard summary) and agent `successRate` are stored/returned as whole-number percentages (e.g. 14.3, 98.2). Render directly with `.toFixed(1)`.
- **Why:** A prior bug displayed `1430.0%` / `9820.0%` because the frontend multiplied an already-percent value by 100.
- **How to apply:** Never `* 100` these fields in the UI.

- `monthlyRevenue` = sum of `otdPrice` for delivered deals created in the **current calendar month**, not all-time.
- **Why:** The field name implies month-bounded semantics; summing all delivered deals overstates the KPI as data grows.

- Newly added/changed API routes 404 until the `artifacts/api-server` workflow is restarted.
- **How to apply:** Restart the workflow after editing route files, then curl `localhost:80/api/...` to verify.
