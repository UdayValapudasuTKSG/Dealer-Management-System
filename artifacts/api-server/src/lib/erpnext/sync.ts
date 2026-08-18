import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  erpnextRefsTable,
  erpnextSyncJobsTable,
  type ErpnextSyncJob,
} from "@workspace/db";
import { logger } from "../logger";
import { ErpnextError } from "./client";
import { clientFor, getErpnextConnection } from "./connection";

// ---------------------------------------------------------------------------
// Durable outbound sync queue (outbox/sweep pattern, mirroring the email
// worker): jobs are enqueued with a dedupe key, processed in the background
// with exponential backoff, and dead-lettered after repeated failures.
// When ERPNext is unconfigured/unreachable, jobs simply wait — nothing in
// AURA's request path ever calls ERPNext synchronously.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
/** Backoff minutes by attempt number (1-based). */
const BACKOFF_MINUTES = [1, 2, 5, 15, 60];
/** Re-check interval when the dealer has no (enabled) connection. */
const UNCONFIGURED_RETRY_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const BATCH_SIZE = 10;

export type ErpnextSyncHandler = (
  job: ErpnextSyncJob,
) => Promise<{ docName: string | null }>;

// Per-DocType outbound handlers — the entity-mapping tasks register these.
// Without a handler the generic insert/update push (payload → DocType) runs.
const outboundHandlers = new Map<string, ErpnextSyncHandler>();

export function registerErpnextSyncHandler(
  doctype: string,
  handler: ErpnextSyncHandler,
): void {
  outboundHandlers.set(doctype, handler);
}

export async function enqueueErpnextSync(opts: {
  dealerId: number;
  doctype: string;
  entityType: string;
  entityId: number;
  operation?: "insert" | "update";
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<number | null> {
  const [row] = await db
    .insert(erpnextSyncJobsTable)
    .values({
      dealerId: opts.dealerId,
      direction: "outbound",
      doctype: opts.doctype,
      operation: opts.operation ?? "insert",
      entityType: opts.entityType,
      entityId: opts.entityId,
      payload: opts.payload ?? {},
      dedupeKey: opts.dedupeKey ?? null,
      status: "queued",
    })
    .onConflictDoNothing({ target: erpnextSyncJobsTable.dedupeKey })
    .returning({ id: erpnextSyncJobsTable.id });
  return row?.id ?? null;
}

/** Look up the ERPNext doc name previously mapped to an AURA record. */
export async function getErpnextRef(
  dealerId: number,
  entityType: string,
  entityId: number,
  doctype: string,
): Promise<string | null> {
  const [row] = await db
    .select({ docName: erpnextRefsTable.docName })
    .from(erpnextRefsTable)
    .where(
      and(
        eq(erpnextRefsTable.dealerId, dealerId),
        eq(erpnextRefsTable.entityType, entityType),
        eq(erpnextRefsTable.entityId, entityId),
        eq(erpnextRefsTable.doctype, doctype),
      ),
    );
  return row?.docName ?? null;
}

export async function saveErpnextRef(
  dealerId: number,
  entityType: string,
  entityId: number,
  doctype: string,
  docName: string,
): Promise<void> {
  await db
    .insert(erpnextRefsTable)
    .values({ dealerId, entityType, entityId, doctype, docName })
    .onConflictDoUpdate({
      target: [
        erpnextRefsTable.dealerId,
        erpnextRefsTable.entityType,
        erpnextRefsTable.entityId,
        erpnextRefsTable.doctype,
      ],
      set: { docName, updatedAt: new Date() },
    });
}

/** Default push when no per-DocType handler is registered: insert the
 * payload as a new doc, or update the previously mapped doc. */
async function genericPush(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const conn = await getErpnextConnection(job.dealerId);
  if (!conn) throw new ErpnextError("ERPNext is not configured", 0, "network");
  const client = clientFor(conn);
  const existing =
    job.erpnextDocName ??
    (await getErpnextRef(job.dealerId, job.entityType, job.entityId, job.doctype));
  if (job.operation === "update" || existing) {
    if (!existing) {
      // No mapping yet — fall back to insert so the doc exists.
      const created = await client.insertDoc(job.doctype, job.payload);
      return { docName: created.name };
    }
    await client.updateDoc(job.doctype, existing, job.payload);
    return { docName: existing };
  }
  const created = await client.insertDoc(job.doctype, job.payload);
  return { docName: created.name };
}

async function processJob(job: ErpnextSyncJob): Promise<void> {
  const attempts = job.attempts + 1;
  try {
    const handler = outboundHandlers.get(job.doctype) ?? genericPush;
    const { docName } = await handler(job);
    if (docName) {
      await saveErpnextRef(
        job.dealerId,
        job.entityType,
        job.entityId,
        job.doctype,
        docName,
      );
    }
    await db
      .update(erpnextSyncJobsTable)
      .set({
        status: "succeeded",
        attempts,
        lastError: null,
        erpnextDocName: docName ?? job.erpnextDocName,
        completedAt: new Date(),
        nextAttemptAt: null,
        updatedAt: new Date(),
      })
      .where(eq(erpnextSyncJobsTable.id, job.id));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    const retryable = err instanceof ErpnextError ? err.retryable : true;
    const dead = attempts >= MAX_ATTEMPTS || !retryable;
    const backoffMin = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1]!;
    await db
      .update(erpnextSyncJobsTable)
      .set({
        status: dead ? "dead" : "failed",
        attempts,
        lastError: message.slice(0, 500),
        nextAttemptAt: dead ? null : new Date(Date.now() + backoffMin * 60_000),
        updatedAt: new Date(),
      })
      .where(eq(erpnextSyncJobsTable.id, job.id));
    logger.warn(
      { err, jobId: job.id, dealerId: job.dealerId, doctype: job.doctype, attempts, dead },
      "ERPNext sync job attempt failed",
    );
  }
}

/** Requeue a failed/dead job for an immediate retry (manual action). */
export async function retryErpnextSyncJob(
  dealerId: number,
  jobId: number,
): Promise<ErpnextSyncJob | null> {
  const [updated] = await db
    .update(erpnextSyncJobsTable)
    .set({
      status: "queued",
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(erpnextSyncJobsTable.id, jobId),
        eq(erpnextSyncJobsTable.dealerId, dealerId),
        inArray(erpnextSyncJobsTable.status, ["failed", "dead"]),
      ),
    )
    .returning();
  if (updated) setTimeout(() => void processQueue(), 50);
  return updated ?? null;
}

let processing = false;

export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const now = new Date();
    const ready = await db
      .select()
      .from(erpnextSyncJobsTable)
      .where(
        and(
          inArray(erpnextSyncJobsTable.status, ["queued", "failed"]),
          or(
            isNull(erpnextSyncJobsTable.nextAttemptAt),
            lte(erpnextSyncJobsTable.nextAttemptAt, now),
          ),
        ),
      )
      .orderBy(asc(erpnextSyncJobsTable.createdAt))
      .limit(BATCH_SIZE);

    // Per-dealer connection gate, checked once per batch.
    const connectable = new Map<number, boolean>();
    for (const job of ready) {
      let ok = connectable.get(job.dealerId);
      if (ok === undefined) {
        const conn = await getErpnextConnection(job.dealerId);
        ok = !!conn && conn.enabled;
        connectable.set(job.dealerId, ok);
      }
      if (!ok) {
        // Not configured / paused: wait without consuming attempts so a job
        // can never dead-letter just because ERPNext isn't connected yet.
        await db
          .update(erpnextSyncJobsTable)
          .set({
            lastError: "Waiting: ERPNext is not connected for this dealership",
            nextAttemptAt: new Date(Date.now() + UNCONFIGURED_RETRY_MS),
            updatedAt: new Date(),
          })
          .where(eq(erpnextSyncJobsTable.id, job.id));
        continue;
      }
      // Claim: only one worker pass may take the job.
      const [claimed] = await db
        .update(erpnextSyncJobsTable)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(
            eq(erpnextSyncJobsTable.id, job.id),
            inArray(erpnextSyncJobsTable.status, ["queued", "failed"]),
          ),
        )
        .returning();
      if (!claimed) continue;
      await processJob(claimed);
    }
  } catch (err) {
    logger.error({ err }, "ERPNext sync queue pass failed");
  } finally {
    processing = false;
  }
}

let started = false;

/** Recover jobs stuck in "processing" after a crash/restart. */
async function recoverStuckJobs(): Promise<void> {
  await db
    .update(erpnextSyncJobsTable)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(erpnextSyncJobsTable.status, "processing"),
        lte(
          erpnextSyncJobsTable.updatedAt,
          sql`now() - interval '10 minutes'`,
        ),
      ),
    );
}

export function startErpnextSyncWorker(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    void recoverStuckJobs().catch(() => undefined);
    void processQueue();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void processQueue(), 5_000);
  logger.info("ERPNext sync worker started");
}
