---
name: Field-permission redaction testing
description: How to test role_field_permissions grants and avoid money leaks in aggregate payloads
---
- The active role for field permissions comes from the user's **dealer membership** (`dealer_users.role_id`), not from matching `roles.name` — testing a grant against the wrong role silently does nothing.
- Field-permission grants are cached ~30s server-side; after inserting/updating a grant, wait out the TTL (or restart api-server) before curling.
- **Why:** a "hidden deal_financials" test looked like a redaction bug when the grant was on the wrong role id and the cache was warm.
- **How to apply:** when redacting money from report/aggregate payloads, strip ALL series that can carry money — KPIs, table cells, primary chart values on currency charts, AND secondary chart series (weighted values) plus their labels. Apply the redaction before both `res.json` and export rendering so hidden data never leaves the server.
