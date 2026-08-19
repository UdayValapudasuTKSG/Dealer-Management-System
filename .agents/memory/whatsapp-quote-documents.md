---
name: WhatsApp quote documents
description: Safety and delivery rules for sending customer quote PDFs through Meta WhatsApp.
---

Generate quote PDFs from the complete render payload persisted in the outbox, upload the bytes directly to Meta's media endpoint, and send the document by media ID. Never expose a private quote through a public or long-lived signed URL.

**Why:** Meta needs retrievable media, but quote documents contain customer and pricing data. Persisting the render payload makes retries deterministic without weakening storage access controls.

**How to apply:** Free-form documents may only be queued and sent while the customer's 24-hour service window is open; an ordinary text service template does not authorize a PDF outside that window. Preserve STOP checks at enqueue and worker time. For dedupe hits, active/retryable rows are queued, sent rows are already sent, and terminal/cancelled rows are blocked—never label every existing row as newly queued.