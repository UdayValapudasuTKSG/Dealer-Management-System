---
name: Meta WhatsApp webhook delivery needs WABA-level subscribed_apps
description: Why a correctly configured Meta webhook (URL, verify token, messages field) still receives nothing
---
Rule: Meta webhook wiring has TWO layers — app-level subscription (callback URL + fields, dashboard "Verify and save") AND a WABA-level link created via `POST /<WABA_ID>/subscribed_apps` with the WhatsApp access token. If the second is missing, verification succeeds and messages show two ticks, but zero POSTs ever arrive. A WABA ID is not a Phone Number ID; enumerate `/<WABA_ID>/phone_numbers` and bind outbound sends to the matching phone-number object.

**Why:** Hit during the Twilio→Meta cutover: everything looked configured, GET challenge passed, but inbound was silent until `subscribed_apps` was posted; delivery started immediately after.

**How to apply:** When a Meta WhatsApp webhook receives nothing despite a green dashboard config, check `GET /<WABA_ID>/subscribed_apps` — the app must be listed. WABA ID is on WhatsApp → API Setup ("Try it out"); the token's user id / app id can't enumerate WABAs without business_management scope, so ask the user for it. Diagnose app-level state with `GET /<APP_ID>/subscriptions?access_token=<APP_ID>|<APP_SECRET>`. For a single global business channel, bind it explicitly to one dealer and reject webhook events whose `metadata.phone_number_id` differs from the configured sender; never infer tenant identity from the customer phone number.
