---
name: Storage ACL fail-closed matching
description: Rules for object-storage access checks — never LIKE-match user-supplied keys.
---

Rule: when checking whether a user-supplied storage key is "referenced" by a tenant's records, use exact equality or jsonb `@>` containment — never `LIKE '%key%'`.

**Why:** unescaped `%`/`_` in a user-controlled key turns a LIKE reference-check into a broad match, letting an attacker mark arbitrary legacy keys as referenced and bypass the fail-closed ACL (found in architect review of the P0 security pass, 2026-07).

**How to apply:** any route serving objects by key (storage routes, download endpoints) — reference checks against jsonb arrays use `col @> '["key"]'::jsonb`; scalar columns use `eq`.
