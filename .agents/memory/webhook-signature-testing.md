---
name: Webhook signature testing
description: How to verify signature-checked public webhooks (Meta/Twilio style) locally in this repo
---

Rule: test signature-verified webhooks by booting a second server instance with dummy secrets inline (`META_APP_SECRET=x ... PORT=5991 node dist/index.mjs`) and computing real HMACs with node crypto in the same bash command.

**Why:** Real secrets can't be read, and dev env vars would collide with user-provided secrets later. Backgrounded processes DO NOT survive between bash tool invocations in this environment (even with setsid/nohup) — the whole start→curl→kill sequence must run in ONE bash command.

**How to apply:** Build with `node ./build.mjs` first (entry is `dist/index.mjs`). Meta: `sha256=` + HMAC-SHA256(app secret, raw body). Twilio: base64 HMAC-SHA1(auth token, url + sorted key+value concat) — the URL must match what the server reconstructs from x-forwarded-proto/host. Clean up created DB rows afterwards.
