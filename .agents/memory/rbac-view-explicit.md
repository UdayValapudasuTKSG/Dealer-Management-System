---
name: RBAC view is explicit
description: The "view" permission category is a master visibility switch not implied by "admin"
---

**Rule:** `view` on a module must be granted explicitly; `admin` implies every other category (create/edit/delete/approve/…) but NOT `view`. Enforced in the server `hasPermission`, the web `can()`, GET→view route mapping, and notification recipient queries (which select `category = 'view'` only, never `['view','admin']`).

**Why:** Dealers untick "view" on the Roles & Permissions matrix to hide a module (e.g. Service/Parts) from a role that still holds admin; admin-implies-view leaked pages and notification data to them.

**How to apply:** Any new recipient-resolution query or permission check that gates *seeing* module data must test explicit `view`. Roles configured admin-only (no view) are intentionally blocked from GETs and pages — don't "fix" that by re-adding the admin fallback.
