---
name: Clerk proxy development boundary
description: Prevent development Clerk assets from falling through the protected API router when production proxy variables are visible.
---

Frontend builds must pass Clerk's `proxyUrl` only when `import.meta.env.PROD` is true. In development, Clerk should connect directly to its development Frontend API even if `VITE_CLERK_PROXY_URL` is present in the shared environment.

**Why:** Shared Replit environment variables can expose the production proxy URL to Vite development workflows. Sending Clerk's JavaScript loader to `/api/__clerk` while the API proxy is intentionally production-only makes it fall through to protected `/api` middleware and return 401.

**How to apply:** Keep the API proxy production-only and mounted before auth middleware. Gate `proxyUrl` in every Clerk frontend provider with `import.meta.env.PROD`; never solve this by exempting `/api/__clerk` from authentication or enabling the secret-bearing proxy in development.