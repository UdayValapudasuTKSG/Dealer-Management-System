---
name: Gmail IMAP intake testing
description: How to test inbound-email agents against a real Gmail inbox without an external sender
---
- Gmail SMTP rewrites the From header of `user+alias@gmail.com` back to the canonical account address, so sending "from an alias" to yourself still looks self-sent — a self-sent skip guard will (correctly) swallow the test.
- **How to apply:** to exercise the external-sender path, use IMAP `APPEND` to place a crafted RFC822 message (arbitrary From, fresh Message-ID, current Date) directly into INBOX; the poller treats it like real inbound mail.
- IMAP `SEARCH SINCE` is day-granular — pair it with a persisted Message-ID ledger and an enable-time watermark for exact no-backfill/idempotency semantics.
