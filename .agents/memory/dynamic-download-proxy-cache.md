---
name: Dynamic download proxy caching
description: How to prevent Replit's reverse proxy and browsers from returning bodyless 304 responses for generated exports.
---

Treat generated, authenticated, permission-redacted downloads as non-cacheable on both sides of the request.

**Why:** A live inventory export was returned as `304 Not Modified` through the Replit proxy. A 304 has no response body, so the browser could not save or validate the workbook even though the export endpoint itself was healthy.

**How to apply:** Set private `no-store`/`no-cache` response headers on dynamic export routes. Fetch them with `cache: "no-store"` and a unique query value per click so intermediary caches cannot reuse an earlier conditional response. Add a regression that sends `If-None-Match` and still expects `200` with a non-empty body.