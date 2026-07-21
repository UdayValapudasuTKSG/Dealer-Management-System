import type { RequestHandler, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, idempotencyKeysTable } from "@workspace/db";
import { activeDealerId } from "./rbac";
import { logger } from "../lib/logger";
import { incrementMetric } from "../lib/metrics";

// ---------------------------------------------------------------------------
// Idempotency-key support for money-moving / stock-moving mutations
// (payments, invoices, vehicle allocation). A client sends
// `X-Idempotency-Key: <uuid>`; the first execution stores its JSON response,
// and any retry with the same key replays the stored response instead of
// executing the mutation twice. Keys are scoped per dealer + endpoint.
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_HEADER = "x-idempotency-key";

export function idempotent(endpoint: string): RequestHandler {
  return async (req, res, next) => {
    const key = req.header(IDEMPOTENCY_HEADER)?.trim();
    if (!key || key.length > 200) return next();

    const dealerId = activeDealerId(res);
    const [existing] = await db
      .select()
      .from(idempotencyKeysTable)
      .where(
        and(
          eq(idempotencyKeysTable.dealerId, dealerId),
          eq(idempotencyKeysTable.key, key),
          eq(idempotencyKeysTable.endpoint, endpoint),
        ),
      );
    if (existing) {
      incrementMetric("idempotent_replays_total", { endpoint });
      res.setHeader("Idempotent-Replay", "true");
      res.status(existing.statusCode).json(existing.responseBody);
      return;
    }

    // Capture the outgoing JSON body so a retry can replay it exactly.
    const originalJson = res.json.bind(res) as Response["json"];
    res.json = ((body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        db.insert(idempotencyKeysTable)
          .values({
            dealerId,
            key,
            endpoint,
            statusCode: res.statusCode,
            responseBody: body,
          })
          .onConflictDoNothing()
          .catch((err) =>
            logger.error({ err, endpoint }, "Failed to store idempotency key"),
          );
      }
      return originalJson(body);
    }) as Response["json"];
    next();
  };
}
