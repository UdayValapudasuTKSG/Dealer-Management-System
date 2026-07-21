---
name: No-dealer request gating
description: Client must not fire dealer-scoped queries when no dealership is bound (super admin console / dealer picker states)
---

Rule: when a session has no bound dealership (super admin in the Platform Console, or a multi-membership user on the dealer picker), the API only allows the `auth` and `platform` segments (plus a GET /admin/roles exception for super admins, since roles are global reference data). Every dealer-scoped client query or provider mounted unconditionally in the shell (notifications, global search, CopilotKit runtime) will 403-loop.

**Why:** React Query retries turn each blocked widget into a stream of 403s and visible error toasts; CopilotKit surfaces a runtime-error overlay. Also, components using CopilotKit hooks (useCopilotReadable etc.) crash outright if the provider is skipped — gate both provider AND consumers together.

**How to apply:** any always-mounted shell widget or provider that hits dealer-scoped endpoints must check `activeDealer` from `useAuthz()` before rendering/querying. If the console needs new global reference data, add an explicit super-admin GET exception in the rbac no-dealer gate rather than binding a dealer.
