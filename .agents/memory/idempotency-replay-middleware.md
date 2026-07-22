---
name: Idempotency replay middleware
description: Correctness rules for the x-idempotency-key replay middleware on the api-server
---
- Claim the key with an atomic INSERT ... ON CONFLICT DO NOTHING; never SELECT-then-INSERT (races produce double execution).
- **Why:** concurrent duplicates must resolve to exactly one execution; the loser reads the winner's row (in-flight → 409, completed → replay, body-hash mismatch → 422).
- Only mark a key `completed` when `res.json` actually ran with a 2xx; a premature client disconnect (`close` before json) must RELEASE the claim, or retries replay a null body forever.
- **How to apply:** any new idempotent route just wraps with `idempotent("<endpoint>")`; keys are scoped dealer+endpoint; header is optional by design.
