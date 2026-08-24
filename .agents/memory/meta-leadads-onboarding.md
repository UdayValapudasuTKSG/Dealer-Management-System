---
name: Meta Lead Ads live onboarding gotchas
description: Non-obvious Meta Graph/token behaviors hit while wiring a dealer's real campaign leads.
---

- Page grants are **baked into a user token at issuance**: granting page/ad-account access later does nothing to existing tokens. Force re-consent by removing the app under facebook.com/settings?tab=business_tools (Business Integrations, NOT "Apps and Websites"), then regenerate.
- Verify which page campaigns actually publish under (`/act_X/ads?fields=creative{object_story_spec{page_id}}`) — the "obvious" brand page may only hold test leads while real lead forms live on a sibling brand page (dealer 1's live leads are on BYD Auto Guyana, not GT Automotive).
- Test-tool leads created **before** the page subscription are never retro-delivered; delete + recreate the test lead. Also check the Page's Lead Access Manager (⚠️ in diagnostics) — enabled restrictions block CRM delivery entirely.
- Historical campaign leads must be **backfilled via `/form_id/leads`** (webhooks never replay history). Bulk import must bypass full intake (emails/auto-quote/AI orchestration per lead = storm): insert leads unassigned (owner-less leads are exempt from the SLA sweep), dedupe by normalized email/phone (2626 submissions → 691 unique), and write `webhook_events` ledger rows for every leadgen id so future webhook retries dedupe.
- `/me/accounts` can return empty for business task-based page access even when `{page-id}?fields=access_token` succeeds — probe the page directly.
