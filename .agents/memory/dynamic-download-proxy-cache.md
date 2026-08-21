---
name: Dynamic download proxy caching
description: How to prevent Replit's reverse proxy and browsers from returning bodyless 304 responses for generated exports.
---

Treat generated, authenticated, permission-redacted downloads as non-cacheable on both sides of the request, and make raw download fetches mirror the shared API client's tenant headers.

**Why:** A live inventory export was first returned as `304 Not Modified` through the Replit proxy. After caching was fixed, a raw browser fetch still omitted the active dealer header, so authorization middleware returned a small `dealer_selection_required` JSON payload with HTTP 200. Both responses reached binary validation without containing a workbook.

**How to apply:** Set private `no-store`/`no-cache` response headers on dynamic export routes. Fetch them with `cache: "no-store"` and a unique query value per click so intermediary caches cannot reuse an earlier conditional response. Raw fetches must send the same active tenant/persona headers as the shared client. If binary validation fails, decode structured JSON before showing a generic file error. Add regressions for both conditional requests and missing tenant context.