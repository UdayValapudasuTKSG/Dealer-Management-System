import { and, isNotNull, lt, ne, sql } from "drizzle-orm";
import {
  db,
  callLogsTable,
  agentRunsTable,
  whatsappMessagesTable,
  emailLogsTable,
  notificationsTable,
  auditLogsTable,
} from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// R10.6 data-retention sweeps. Each sweep redacts/deletes ONLY the payload
// class past its window — row metadata (counts, statuses, timestamps) is
// retained for reporting. Every batch that touched rows writes ONE audit row
// per dealer so the disposal itself is provable.
//
// Windows:
//   call transcripts / recordings ... 24 months
//   agent run summaries (C5) ........ 12 months
//   whatsapp message bodies ......... 18 months
//   email payloads .................. 18 months
//   notifications (delete) .......... 12 months
// ---------------------------------------------------------------------------

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function cutoff(months: number): Date {
  return new Date(Date.now() - months * MONTH_MS);
}

async function auditDisposal(
  byDealer: Map<number, number>,
  what: string,
): Promise<void> {
  for (const [dealerId, count] of byDealer) {
    await db.insert(auditLogsTable).values({
      dealerId,
      actorName: "Retention Sweep",
      action: "delete",
      module: "customers",
      entityType: "retention",
      summary: `R10.6 retention sweep: ${what} — ${count} record(s) redacted/removed`,
      details: { what, count },
    });
  }
}

function tally(rows: { dealerId: number | null }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) {
    if (r.dealerId == null) continue;
    m.set(r.dealerId, (m.get(r.dealerId) ?? 0) + 1);
  }
  return m;
}

/** Call transcripts + recording URLs older than 24 months. */
export async function sweepCallTranscripts(): Promise<void> {
  const rows = await db
    .update(callLogsTable)
    .set({ transcript: null, recordingUrl: null, transcriptStatus: "expired" })
    .where(
      and(
        lt(callLogsTable.createdAt, cutoff(24)),
        isNotNull(callLogsTable.transcript),
      ),
    )
    .returning({ dealerId: callLogsTable.dealerId });
  if (rows.length) await auditDisposal(tally(rows), "call transcripts >24mo");
}

/** Agent run input/output summaries older than 12 months (metadata kept). */
export async function sweepAgentRunPayloads(): Promise<void> {
  const rows = await db
    .update(agentRunsTable)
    .set({ inputSummary: null, outputSummary: null })
    .where(
      and(
        lt(agentRunsTable.createdAt, cutoff(12)),
        isNotNull(agentRunsTable.inputSummary),
      ),
    )
    .returning({ dealerId: agentRunsTable.dealerId });
  if (rows.length)
    await auditDisposal(tally(rows), "agent run payload summaries >12mo");
}

/** WhatsApp message bodies older than 18 months (thread metadata kept). */
export async function sweepWhatsappBodies(): Promise<void> {
  const rows = await db
    .update(whatsappMessagesTable)
    .set({ body: "[expired per retention policy]" })
    .where(
      and(
        lt(whatsappMessagesTable.createdAt, cutoff(18)),
        ne(whatsappMessagesTable.body, "[expired per retention policy]"),
        ne(whatsappMessagesTable.body, "[erased]"),
      ),
    )
    .returning({ dealerId: whatsappMessagesTable.dealerId });
  if (rows.length)
    await auditDisposal(tally(rows), "whatsapp message bodies >18mo");
}

/** Email payloads older than 18 months (send ledger metadata kept). */
export async function sweepEmailPayloads(): Promise<void> {
  const rows = await db
    .update(emailLogsTable)
    .set({ payload: {} })
    .where(
      and(
        lt(emailLogsTable.createdAt, cutoff(18)),
        sql`${emailLogsTable.payload} != '{}'::jsonb`,
      ),
    )
    .returning({ dealerId: emailLogsTable.dealerId });
  if (rows.length) await auditDisposal(tally(rows), "email payloads >18mo");
}

/** Notifications older than 12 months are deleted outright. */
export async function sweepNotifications(): Promise<void> {
  const rows = await db
    .delete(notificationsTable)
    .where(lt(notificationsTable.createdAt, cutoff(12)))
    .returning({ dealerId: notificationsTable.dealerId });
  if (rows.length) await auditDisposal(tally(rows), "notifications >12mo");
}

// ---------------------------------------------------------------------------
// Worker — daily cadence (first pass shortly after boot).
// ---------------------------------------------------------------------------
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export async function runRetentionSweeps(): Promise<void> {
  await sweepCallTranscripts();
  await sweepAgentRunPayloads();
  await sweepWhatsappBodies();
  await sweepEmailPayloads();
  await sweepNotifications();
}

export function startRetentionSweeps(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runRetentionSweeps().catch((err) =>
      logger.error({ err }, "retention sweep run failed"),
    );
  }, SWEEP_INTERVAL_MS);
  setTimeout(() => {
    runRetentionSweeps().catch((err) =>
      logger.error({ err }, "retention sweep run failed"),
    );
  }, 15_000);
  logger.info("retention sweep worker started (R10.6)");
}
