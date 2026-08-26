---
name: Meta leadgen webhook delivery gaps + polling fallback
description: Why real-customer leadgen webhooks silently stop and how the poll fallback covers it.
---

- Meta can silently withhold leadgen webhooks even when everything checks out (app subscription active with correct callback_url, page subscribed_apps includes leadgen, endpoint reachable): most commonly the app is in **Development Mode** (real customers' leads never fire webhooks — only app admins/testers), or Lead Access Manager restrictions, or delivery disabled after repeated callback failures.
- Diagnosis path: (1) prod logs — zero POST /webhooks/meta while leads accumulate in Ads Manager; (2) `/{form_id}/leads?filtering=[time_created>...]` shows the missing leads; (3) `/{app_id}/subscriptions` with app token (`appid|appsecret`) confirms callback config; (4) `/{page_id}/subscribed_apps` confirms page link.
- Fallback: `meta-lead-poll` sweep (10-min interval, 48h lookback) polls each dealer's mapped page's ACTIVE forms and funnels ids through `processLeadgenEvent`.
- **Why safe**: `processLeadgenEvent` now atomically CLAIMS the (channel, external_id) ledger row via insert-on-conflict-do-nothing BEFORE any side effect, and releases the claim on every failure path. Never revert to check-then-insert-at-the-end — webhook + poll racing would double-create leads and double-send customer emails.
- **How to apply**: any new inbound-lead delivery path must go through processLeadgenEvent (or replicate the claim pattern), never call createInboundLead directly for Meta leads.
