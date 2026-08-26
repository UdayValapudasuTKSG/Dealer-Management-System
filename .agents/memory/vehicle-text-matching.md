---
name: Vehicle free-text matching
description: How lead form answers are matched to inventory; marketing-name drift caveat.
---
Meta lead forms return raw option slugs ("sealion_7", "yuan_plus_-_480_gs"), so inventory matching must compare fully normalized strings (lowercase, strip all non-alphanumerics), with a token-prefix fallback.

**Why:** Marketing names drift from inventory model names — customers know "SEALION 7" but inventory stores "SEALION EV". Plain substring matching (even normalized) misses these; the token-prefix fallback (unique best model by leading tokens, make tokens stripped) closes the gap, with variant tokens picking the unit (e.g. "480_gs" → variant 480KM-GS).

**How to apply:** Any new intake channel matching free text to vehicles should go through matchVehicleByText, never re-implement substring matching. If a new marketing name appears (e.g. BYD M9, Atto 8 seen in forms but not stocked), leads correctly stay as free-text interest until the model is in inventory.
