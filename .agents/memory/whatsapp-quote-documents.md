---
name: WhatsApp quote documents
description: Safety and delivery rules for sending customer quote PDFs through Meta WhatsApp.
---

Generate quote PDFs from the complete render payload persisted in the outbox, upload the bytes directly to Meta's media endpoint, and send the document by media ID. Never expose a private quote through a public or long-lived signed URL.

**Why:** Meta needs retrievable media, but quote documents contain customer and pricing data. Persisting the render payload makes retries deterministic without weakening storage access controls.

**How to apply:** Free-form documents require an open 24-hour window. Outside it, only an approved document-header template for that sending account may carry the uploaded media ID; ordinary text templates never authorize a PDF. The user supplied an Active English (US) Utility approval screenshot for GT's vehicle_estimate_document after receiving the two-variable (customer name, estimate reference) submission instructions. Do not assume that approval covers CAM. Preserve STOP checks at enqueue and worker time. For dedupe hits, active/retryable rows are queued, sent rows are already sent, and terminal/cancelled rows are blocked—never label every existing row as newly queued.