import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  db,
  emailLogsTable,
  serviceEstimateDecisionsTable,
} from "@workspace/db";

type EstimateInvalidationTx = Pick<typeof db, "update">;

/**
 * Invalidate every current decision for a card and stop delivery attempts for
 * those now-stale decision links. Call this while the owning job-card row is
 * locked, in the same transaction as the price/version mutation.
 *
 * The quote worker holds the same job-card lock from its final decision check
 * through SMTP hand-off, so cancelling a claimed `sending` row here is safe:
 * either this transaction wins before hand-off or the worker completes first.
 * Every dispatchable state is cancelled synchronously.
 */
export async function invalidateServiceEstimate(
  tx: EstimateInvalidationTx,
  dealerId: number,
  jobCardId: number,
): Promise<void> {
  const invalidated = await tx
    .update(serviceEstimateDecisionsTable)
    .set({ invalidatedAt: new Date() })
    .where(and(
      eq(serviceEstimateDecisionsTable.dealerId, dealerId),
      eq(serviceEstimateDecisionsTable.jobCardId, jobCardId),
      isNull(serviceEstimateDecisionsTable.invalidatedAt),
    ))
    .returning({ id: serviceEstimateDecisionsTable.id });
  if (invalidated.length === 0) return;

  await tx
    .update(emailLogsTable)
    .set({
      status: "cancelled",
      deliveryStatus: "cancelled",
      nextAttemptAt: null,
      lastError: "cancelled: the linked service estimate was superseded",
    })
    .where(and(
      eq(emailLogsTable.dealerId, dealerId),
      eq(emailLogsTable.channel, "email"),
      eq(emailLogsTable.template, "service.estimate.ready"),
      inArray(emailLogsTable.serviceEstimateDecisionId, invalidated.map((row) => row.id)),
      or(
        eq(emailLogsTable.status, "queued"),
        eq(emailLogsTable.status, "sending"),
        and(
          eq(emailLogsTable.status, "failed"),
          lt(emailLogsTable.attempts, 3),
        ),
      ),
    ));
}