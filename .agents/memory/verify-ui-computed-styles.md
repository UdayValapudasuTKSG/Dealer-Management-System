---
name: Verify UI via computed styles, not screenshots
description: In this workspace the screenshot tool's persistent browser can serve a stale image even when the live DOM is correct; use getComputedStyle to confirm.
---

The `screenshot` app_preview tool drives a persistent browser session that HMR-patches
CSS and components but does not always fully reload. It can return a **stale image**
that does not reflect the true live render — e.g. a theme toggle that is actually
applied still shows the old theme in the screenshot.

**Rule:** When a visual change "isn't showing" in a screenshot but the served
HTML/CSS (via `curl`) and code look correct, do NOT trust the screenshot. Add a
one-off `console.log` reading `getComputedStyle(document.documentElement)` /
`document.body` (and `document.documentElement.className`) in `main.tsx`, restart,
then read the value from the browser console via `refresh_all_logs`. The computed
style is ground truth.

**Why:** A light/dark theme toggle was correctly implemented (class on `<html>`,
`:root.light` token overrides in CSS all confirmed present via curl) yet every
screenshot rendered dark. `getComputedStyle` proved the live DOM was fully light
(`--foreground: 0 0% 9%`, `bodyBg: rgb(247,247,247)`). Hours were lost chasing a
non-existent CSS cascade bug because the screenshot was stale.

**How to apply:** Reach for the computed-style probe early when a
supposedly-applied visual change won't appear in a screenshot. Remove the probe
before finishing.
