import { eq } from "drizzle-orm";
import { db, amberConnectionsTable } from "@workspace/db";
import { amberEntitled } from "./connection";
import { decryptAmberSecret } from "./crypto";
import { resolveAmberProvider } from "./provider";
import { processAmberEvent, trimAmberEvents } from "./ingest";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Scheduled Amber sync seam. Runs periodically; per tick it re-checks the
// dealer's ENTITLEMENT and enabled switch so disabling either stops work
// immediately. While the provider contract is pending (no adapter
// registered), connections are parked with lastSyncStatus=pending_contract —
// no fabricated outbound call, no retry burn.
// ---------------------------------------------------------------------------

const SYNC_INTERVAL_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;

export function startAmberSyncWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runAmberSyncTick(), SYNC_INTERVAL_MS);
  logger.info("Amber sync worker started");
}

export function stopAmberSyncWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runAmberSyncTick(): Promise<void> {
  const conns = await db
    .select()
    .from(amberConnectionsTable)
    .where(eq(amberConnectionsTable.enabled, true));
  for (const conn of conns) {
    try {
      // Entitlement gate per tick: a disabled module does zero work.
      if (!(await amberEntitled(conn.dealerId))) continue;

      const provider = resolveAmberProvider(conn);
      if (!provider) {
        await db
          .update(amberConnectionsTable)
          .set({ lastSyncStatus: "pending_contract", lastSyncAt: new Date() })
          .where(eq(amberConnectionsTable.id, conn.id));
        continue;
      }

      const apiKey = decryptAmberSecret(conn.apiKeyCiphertext!, conn.dealerId);
      const events = await provider.pullEvents(conn, apiKey, conn.lastSyncAt);
      for (const event of events) {
        await processAmberEvent(conn.dealerId, event);
      }
      await trimAmberEvents(conn.dealerId);
      await db
        .update(amberConnectionsTable)
        .set({ lastSyncStatus: "ok", lastSyncAt: new Date() })
        .where(eq(amberConnectionsTable.id, conn.id));
    } catch (err) {
      logger.error({ err, dealerId: conn.dealerId }, "Amber sync tick failed");
      await db
        .update(amberConnectionsTable)
        .set({ lastSyncStatus: "error", lastSyncAt: new Date() })
        .where(eq(amberConnectionsTable.id, conn.id))
        .catch(() => undefined);
    }
  }
}
