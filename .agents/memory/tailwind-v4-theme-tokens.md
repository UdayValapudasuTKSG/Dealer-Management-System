---
name: Tailwind v4 theme tokens
description: Why bg-sidebar / custom-namespace utilities silently render transparent in Tailwind v4, and how to fix.
---

In Tailwind v4, a utility like `bg-sidebar`, `text-sidebar-foreground`, or `border-sidebar-border` only resolves if a matching `--color-<name>` custom token is declared in the `@theme inline { … }` block of the CSS entry. Defining the underlying `--sidebar` / `--sidebar-foreground` HSL vars in `:root` is NOT enough — without the `--color-*` mapping the utility is a no-op and the element renders with no background/border (effectively transparent).

**Symptom that hides the bug:** a transparent element can still look correct if whatever is behind it happens to match the intended color. AURA's sidebar used `bg-sidebar` with no registered `--color-sidebar`, so it was transparent the whole time — it only looked right in DARK mode because the dark page body showed through. In LIGHT mode the near-white body showed through and the sidebar "disappeared" / blended in. The bug was invisible until light mode exposed it.

**Fix:** register every custom color namespace in `@theme inline`, e.g.
`--color-sidebar: hsl(var(--sidebar));` plus `-foreground`, `-border`, `-primary`, `-accent`, `-ring`, etc.

**Why:** `@theme inline` is what generates the utility classes; `:root` vars alone just hold values nothing references.

**How to apply:** whenever you add a new color namespace (sidebar, chart, brand, etc.) and its `bg-/text-/border-` utilities seem to do nothing, check it's declared in `@theme inline` before debugging anything else. Prefer theme-adaptive overlays (`bg-foreground/[0.05]`) over `bg-white/[…]` so hover/surface states invert automatically instead of needing per-mode override hacks.
