---
name: Headless api-server testing
description: How to spin up an auth-bypassed api-server copy for API tests without killing the real workflow
---

The api-server dev workflow itself runs `node --enable-source-maps ./dist/index.mjs` (it builds then starts dist). A headless test copy (`AUTH_BYPASS=1 PORT=8099 node dist/index.mjs`) therefore has the SAME process signature.

**Why:** `pkill -f "dist/index.mjs"` matched and killed the real workflow server (and the invoking bash, exit 143), causing a mystery FAILED workflow + 502s.

**How to apply:** when cleaning up a headless test server, capture its PID at launch (`node dist/index.mjs & echo $!`) and `kill <pid>` — never pattern-kill on `dist/index.mjs`. Expect to restart the workflow if a pattern kill happened anyway.
