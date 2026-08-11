---
name: RBAC method→category mapping vs action routes
description: POST workflow-action endpoints default to module:create; edit-only roles get blanket 403s before the route's own identity check runs.
---

The RBAC layer maps HTTP verbs to permission categories (POST→create, PATCH/PUT→edit, DELETE→delete) per path segment.

**Why:** POST is used for workflow actions (sign-offs, approvals, decisions), not just record creation. Roles designed to *perform* those actions often hold only edit/view, so a POST action endpoint 403s for exactly the role it exists for — before any route-level authorization runs.

**How to apply:** When adding a POST action endpoint meant for a non-create role, override the category for that path in the RBAC path rules and enforce the real authorization (identity/role) inside the route.
