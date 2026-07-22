import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, idempotencyKeysTable } from "@workspace/db";
import { activeDealerId } from "./rbac";
import { logger } from "../lib/logger";
import { incrementMetric } from "../lib/metrics";

// ---------------------------------------------------------------------------
// Idempotency-key support for mutations (NC-7). A client sends
// `X-Idempotency-Key: <uuid>`; semantics per R4.5:
//  - first use: an in-flight row is recorded with the request-body hash,
//    and the JSON response is persisted on completion;
//  - replay of a COMPLETED request (same key, same body) → stored response
//    returned verbatim, no re-execution;
//  - duplicate while the original is still IN FLIGHT → 409;
//  - same key with a DIFFERENT body → 422 `key_reuse_mismatch`.
// Keys are scoped per dealer + endpoint. The header stays OPTIONAL (clients
// that do not send it simply get no replay protection) so existing consumers
// are not broken; domain-level uniqueness provides the second guard.
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_HEADER = "x-idempotency-key";

function hashBody(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

export function idempotent(endpoint: string): RequestHandler {
  return async (req, res, next) => {
    const key = req.header(IDEMPOTENCY_HEADER)?.trim();
    if (!key || key.length > 200) return next();

    const dealerId = activeDealerId(res);
    const bodyHash = hashBody(req.body);
    const scope = and(
      eq(idempotencyKeysTable.dealerId, dealerId),
      eq(idempotencyKeysTable.key, key),
      eq(idempotencyKeysTable.endpoint, endpoint),
    );

    // Atomically claim the key: the first request inserts an in-flight row;
    // concurrent duplicates hit the unique index and read the existing row.
    const [claimed] = await db
      .insert(idempotencyKeysTable)
      .values({ dealerId, key, endpoint, bodyHash, state: "in_flight" })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeysTable.id });

    if (!claimed) {
      const [existing] = await db
        .select()
        .from(idempotencyKeysTable)
        .where(scope);
      if (!existing) {
        // Vanishingly rare race (row deleted between insert and select).
        res.status(409).json({
          error: "idempotency_conflict",
          message: "A request with this Idempotency-Key is already processing",
        });
        return;
      }
      if (existing.bodyHash != null && existing.bodyHash !== bodyHash) {
        res.status(422).json({
          error: "key_reuse_mismatch",
          message:
            "This Idempotency-Key was already used with a different request body",
        });
        return;
      }
      if (existing.state === "in_flight" || existing.statusCode == null) {
        res.status(409).json({
          error: "idempotency_in_flight",
          message: "A request with this Idempotency-Key is already processing",
        });
        return;
      }
      incrementMetric("idempotent_replays_total", { endpoint });
      res.setHeader("Idempotent-Replay", "true");
      res.status(existing.statusCode).json(existing.responseBody);
      return;
    }

    // Persist the outgoing JSON body so a retry replays it exactly; release
    // the in-flight claim on failure so the client can retry.
    let settled = false;
    const complete = (statusCode: number, body: unknown, sawBody: boolean) => {
      if (settled) return;
      settled = true;
      // Only a response that actually produced a JSON body counts as
      // completed; a premature client disconnect must release the claim so
      // the retry re-executes instead of replaying a null body.
      if (sawBody && statusCode >= 200 && statusCode < 300) {
        db.update(idempotencyKeysTable)
          .set({ state: "completed", statusCode, responseBody: body })
          .where(eq(idempotencyKeysTable.id, claimed.id))
          .catch((err) =>
            logger.error({ err, endpoint }, "Failed to store idempotency key"),
          );
      } else {
        db.delete(idempotencyKeysTable)
          .where(eq(idempotencyKeysTable.id, claimed.id))
          .catch((err) =>
            logger.error(
              { err, endpoint },
              "Failed to release idempotency key",
            ),
          );
      }
    };
    const originalJson = res.json.bind(res) as Response["json"];
    res.json = ((body: unknown) => {
      complete(res.statusCode, body, true);
      return originalJson(body);
    }) as Response["json"];
    res.on("close", () => complete(res.statusCode, null, false));
    next();
  };
}
