import { and, eq, sql } from "drizzle-orm";
import { db, invoicesTable, paymentsTable, salesAccountingWorkflowsTable, type ErpnextSyncJob } from "@workspace/db";

export class SalesAccountingHoldError extends Error {
  constructor() { super("Finance workpaper hold: advance-VAT policy awaits approval. No ERPNext posting was attempted."); }
}

/** Serialize enrolment with remote posting, including its create/ref crash window. */
export async function withSalesAccountingHold<T>(job: ErpnextSyncJob, run: () => Promise<T>): Promise<T> {
  if (!["invoice", "payment"].includes(job.entityType)) return run();
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(76042, ${job.dealerId})`);
    let invoiceId = job.entityId;
    if (job.entityType === "payment") {
      const [payment] = await tx.select().from(paymentsTable).where(and(eq(paymentsTable.id, job.entityId), eq(paymentsTable.dealerId, job.dealerId)));
      if (!payment) return run();
      invoiceId = payment.invoiceId;
    }
    const [invoice] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.dealerId, job.dealerId)));
    if (invoice?.dealId) {
      const [enrolled] = await tx.select().from(salesAccountingWorkflowsTable).where(and(
        eq(salesAccountingWorkflowsTable.dealerId, job.dealerId), eq(salesAccountingWorkflowsTable.dealId, invoice.dealId)));
      if (enrolled) throw new SalesAccountingHoldError();
    }
    return run();
  });
}
