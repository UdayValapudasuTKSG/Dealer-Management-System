import { eq } from "drizzle-orm";
import { db, dealersTable, isEntitlementEnabled } from "@workspace/db";
import { generateLowStockOrders, expirePartsHolds, sweepPartsNotifications } from "./parts-operations";
import { logger } from "./logger";

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<void> | undefined;

/** Explicit per-dealer sweep; no fabricated system user and no tenant fallback. */
export async function runPartsOperationsSweep() {
  if (process.env.OUTBOX_WORKER_DISABLED === "1") return;
  if (running) return running;
  running = (async () => {
    const dealers = await db.select().from(dealersTable).where(eq(dealersTable.status, "active"));
    for (const dealer of dealers) {
      if (!isEntitlementEnabled(dealer.entitlements, "parts_module")) continue;
      // Independent phases: a failed procurement phase must not suppress hold
      // expiry or hide queued notification failures.
      for (const phase of ["expiry", "procurement", "notifications"] as const) {
        try {
          if (phase === "expiry") await expirePartsHolds(dealer.id);
          else if (phase === "procurement") await generateLowStockOrders(dealer.id, null);
          else await sweepPartsNotifications(dealer.id);
        } catch (err) {
          logger.error({ err, dealerId: dealer.id, phase }, "Parts operational sweep failed");
        }
      }
    }
  })();
  try { await running; } finally { running = undefined; }
}
export function startPartsOperationsWorker(intervalMs = 60_000) {
  if (timer || process.env.OUTBOX_WORKER_DISABLED === "1") return;
  timer = setInterval(() => { void runPartsOperationsSweep().catch(err => logger.error({ err }, "Parts operational worker failed")); }, Math.max(10_000, intervalMs));
  timer.unref();
}
export async function stopPartsOperationsWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  await running;
}