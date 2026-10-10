---
name: WhatsApp quote documents
description: Safety and delivery rules for sending customer quote PDFs through Meta WhatsApp.
---

Generate quote PDFs from the complete render payload persisted in the outbox, upload the bytes directly to Meta's media endpoint, and send the document by media ID. Never expose a private quote through a public or long-lived signed URL.

**Why:** Meta needs retrievable media, but quote documents contain customer and pricing data. Persisting the render payload makes retries deterministic without weakening storage access controls.

**How to apply:** Free-form documents may only be sent while the customer's 24-hour service window is open; an ordinary text service template does not authorize a PDF outside that window. The user confirmed GT's `vehicle_estimate_document` approved with a Document header, English (US), and the guided customer-name/estimate-reference body parameters. That confirmation does not cover CAM. Outside the window, GT may use this document template with private Meta media; other dealers must have their own approved configuration. Recheck the window after PDF preparation. Preserve STOP checks at enqueue and worker time. For dedupe hits, active/retryable rows are queued, sent rows are already sent, and terminal/cancelled rows are blocked—never label every existing row as newly queued.