---
name: Verification suites 502 on batch restart
description: p0-security / isolation-p5 / provisioning-saga fail with all-502s when workflows restart together
---

The verify suites (p0-security, isolation-p5, provisioning-saga) target `http://localhost:80/api` via the shared proxy. When all workflows restart together (workspace boot, mass restart), the api-server workflow spends ~30–40s rebuilding (`build.mjs` then start), so every suite request gets a proxy 502 and the suite reports dozens of failures.

**Why:** the suites have no wait-for-healthz gate; they race the api-server build.

**How to apply:** an all-502 failure log from these suites after a batch restart is noise, not a regression — restart the suite (one at a time) after `curl localhost:80/api/healthz` returns 200 before investigating. All three were confirmed green when run against a healthy server. Late-run 409s in isolation-p5 (L6b–L9) are cascade effects of earlier 502-failed lifecycle steps, not independent bugs.
