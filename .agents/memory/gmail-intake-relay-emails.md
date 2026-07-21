---
name: Gmail intake relay emails
description: Website-form notification emails must classify as enquiries; reprocessing skipped mail requires clearing both the DB ledger and IMAP \Seen state.
---

- Website-form "Quote request" notification emails relay a customer's enquiry; the classifier must treat them as enquiries and extract the CUSTOMER's email/name/phone from the body, not the SMTP sender (the relay). Dedupe and lead email use the extracted address.
- **Why:** a strict "automated notifications are not enquiries" prompt rule silently dropped real form leads.
- **How to apply (reprocessing a skipped email):** non-enquiry outcomes are permanently recorded in the `webhook_events` ledger by Message-ID and the mail is marked \Seen + labeled AURA/Processed. To retry: delete the ledger row AND remove \Seen in INBOX. Gmail label moves can silently re-apply \Seen — verify flags right before the next poll and re-unset if needed. IMAP fetches with `source:` set \Seen; use peek-safe fetches (envelope/flags) when only inspecting.
