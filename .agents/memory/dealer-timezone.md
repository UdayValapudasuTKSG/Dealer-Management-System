---
name: Dealership timezone conventions
description: How dates/times must be rendered and day boundaries computed per dealership.
---

Every dealership has a validated IANA timezone setting (default `America/Guyana`). Storage stays UTC; ONLY presentation/derivation is zoned.

**Rules:**
- Server: never hardcode a Guyana offset (`-04:00`), a fixed zone name, or use timezone-less `toLocale*` / host-local or UTC `get*` calls for "today", day keys, slot grids, reference-number years, or labels. Resolve the dealer's timezone (cached lookup with invalidation after settings writes) and go through the shared server timezone helper module for wall-clock↔UTC conversion, day keys, day boundaries, and formatting. Wall-clock→UTC is DST-safe: spring-forward gap times resolve to the post-transition instant.
- Client (AURA): the legacy-named Guyana formatters already render in the ACTIVE dealer timezone (set from the session on dealer switch). For "today"/day-key math use the dealer day-key helpers in the client format lib — never browser-local getters, and never `toLocale*` without an explicit dealer timeZone for instants.
- Date-only `YYYY-MM-DD` values are calendar dates: format timezone-agnostically (UTC pin server-side, local calendar construction client-side) so they never shift a day in negative-offset zones.
- The timezone is GM-editable in dealership Settings (invalid identifiers rejected) and super-admin editable via the platform dealer update (explicitly audited). A boundary test suite covers DST gaps/overlaps and midnight transitions — keep it green when touching the helpers.

**Why:** mixed hardcoded-Guyana and host-local formatting made dates wrong the moment a dealership operated in another zone; DST zones need offset re-probing, not fixed GMT-4 arithmetic.

**How to apply:** any new feature that formats a timestamp, groups by day, filters by a local calendar day, or schedules wall-clock events must take the dealer timezone through these helpers.
