---
name: WhatsApp outbound providers
description: Outbound WhatsApp queue provider selection (Meta vs Twilio) and the Twilio from-number gotcha
---

The outbound WhatsApp queue (email_logs channel=whatsapp) has two send paths: Meta Cloud API and the Twilio Messages API. Selection honors `WHATSAPP_PROVIDER` first, else whichever is configured.

**Why:** The queue originally only knew Meta; with `WHATSAPP_PROVIDER=twilio` the inbound bot worked (TwiML replies) but every proactive message (reminders, one-tap sends) failed silently in the queue with "Meta credentials missing".

**How to apply:**
- Twilio WhatsApp needs a WhatsApp-enabled From number: `TWILIO_WHATSAPP_FROM` (sandbox +14155238886, recipients must join the sandbox) — the regular `TWILIO_PHONE_NUMBER` is voice/SMS only and Twilio rejects with "could not find a Channel with the specified From address".
- Failed rows retry with backoff up to MAX_ATTEMPTS; to re-drive after a config fix: `UPDATE email_logs SET status='queued', attempts=0, next_attempt_at=NULL WHERE channel='whatsapp' AND status='failed'`.
