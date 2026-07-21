<!--
  MERGE NOTE: If your Repl already has a replit.md (Replit usually generates one),
  APPEND the section below to it instead of overwriting. Replit Agent auto-loads
  replit.md every session, so these rules always stay in context.
-->

## Project: Dealer Management System (DMS) — CAM Motors & GT Automotive (Guyana)

**Full functional spec:** `docs/DMS_Master_Spec_v3.md` — this is the source of truth. When any
instruction references a section (e.g., §7, §17.3), open that file and read that section.
**Build script:** `docs/REPLIT_PROMPTS.md` — build phases in order (Prompt 1 → 16). One phase at a time.

### Non-negotiable global rules (apply to everything)
1. **Multi-tenant** — every record carries `dealerId` (+ `divisionId`: CAM/GT). Two portals: Super-Admin
   Platform Console (governs dealers) and Dealer Workspace (daily ops). We build the Dealer Workspace.
2. **RBAC everywhere** — enforce role scope on every API endpoint AND UI element (deny by default).
   Navigation visibility per spec §3.
3. **Single source of truth, in-app** — calendar, notifications, call logs, documents, and customer
   comms live inside the app. Email/WhatsApp are outbound reinforcement only. (Hard client mandate.)
4. **Review-first** — the system/agents pre-fill; humans review → approve/correct → advance. Every
   pipeline stage has a Guidance-for-Success checklist with an AI hard-stop blocking advancement.
5. **Reviews are INLINE** — shown on the lead record at whatever stage it is in (highlighted in context),
   NEVER a separate workflow. The "Reviews" sidebar item is only a filtered shortcut that deep-links
   into the lead at its current stage.
6. **Agents draft, humans approve** — any customer-facing send or state change needs one-click human
   approval. Agents never message a customer autonomously.
7. **Deterministic core** — pricing, taxes, VIN validation (17 chars), registration pattern
   (`^[A-Z]{3}[0-9]{1,4}$`), and round-robin are plain code, never LLM. LLMs only for
   language/extraction/summarization, with the AI-governance guardrails in §17.3.
8. **Everyone lands on their Daily Briefing** (not a list). Advisor / Manager / Leadership dashboards
   are genuinely distinct.
9. **Daily Briefing is LEAN** — only (a) triage/action items, (b) today's scheduling, (c) overall call
   sentiment. ALL charts, KPIs, funnels, and analytics go to **Reports**, never the Daily Briefing.
10. **WhatsApp-first** for customer messages (email fallback), by customer preference.
11. **Never lose history** — interested models, dropped deals, cancellations are retained, never hard-deleted.
12. **Localization** — currency GYD + USD (with exchange rate); timezone Guyana (GMT-4).
13. **Audit everything** — every user and agent action → immutable Audit Log (who/what/when/before→after).
14. **Infra items marked 🔴 in §17 (DR/backup, managed DB/encryption-at-rest, uptime SLA, managed
    tracing, message broker): do NOT build.** Scaffold the seam, add a `PENDING-INFRA` TODO, and wait —
    the client will provision infrastructure.


