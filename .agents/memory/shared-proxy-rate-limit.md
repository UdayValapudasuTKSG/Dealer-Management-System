---
name: Shared-proxy IP rate limiting
description: Why per-IP rate limits must never be mounted globally in this app, and how startup auth races surface as "not found" pages.
---

**Rule:** Never mount a per-IP rate limiter with a bare `router.use()` — behind the Replit shared reverse proxy ALL browser traffic presents the same IP, so a per-IP bucket becomes one global bucket and normal browsing 429s. Scope tight per-IP limits to the public prefixes only (`/enquiries`, `/webhooks`, `/test-drive`); authed traffic is limited per-user after auth.

**Why:** A 60/min per-IP `publicRateLimit` mounted before auth caused app-wide 429 storms; the lead page rendered "Lead not found" for a rate-limited request.

**Related:** On app boot, dealer-scoped queries can fire before `/auth/me` resolves the active dealer and fail with `dealer_selection_required`, then stay stuck in error. The AuthProvider self-heals by refetching errored queries once the active dealer lands; page error states should only claim "not found" on a true 404 (offer Retry otherwise).
