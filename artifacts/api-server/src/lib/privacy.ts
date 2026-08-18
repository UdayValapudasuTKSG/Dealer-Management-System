import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  customersTable,
  contactsTable,
  leadsTable,
  dealsTable,
  invoicesTable,
  paymentsTable,
  financeApplicationsTable,
  gatesTable,
  whatsappMessagesTable,
  whatsappConversationsTable,
  callLogsTable,
  emailLogsTable,
  timelineEventsTable,
  reviewsTable,
  customerNotesTable,
  customerPersonasTable,
  customerDocumentsTable,
  testDrivesTable,
  dsarRequestsTable,
  auditLogsTable,
  type DsarRequest,
  type DsarStepMarker,
} from "@workspace/db";
import { storage } from "./storage";
import { logger } from "./logger";
import { queueCustomerSync } from "./erpnext/entities";

// ---------------------------------------------------------------------------
// R10 privacy / DSAR engine.
//
// Export (R10.4): assembles a portable bundle of classes C1–C5 for one
// customer WITHIN the active dealer scope. Async: caller creates a
// dsar_requests row (202) and this module fills the bundle.
//
// Erasure (R10.5): a durable saga (NC-11) with per-step markers:
//   1 freeze/consent-flag   → all marketing consent revoked
//   2 anonymize C1/C2       → customer/contacts/leads identity tokenized
//   3 purge C4/C5           → message bodies, transcripts, notes, payloads
//   4 de-link retain C3     → financial rows keep amounts, identity severed
//   5 delete stored docs    → object storage files removed (outside any txn)
//   6 backup marker         → pendingBackupErasure=true (R10.7 PENDING-INFRA)
//   7 finalize + audit
// Each step is idempotent; a re-run skips completed markers.
// ---------------------------------------------------------------------------

const ERASED_NAME = (token: string) => `Erased Subject ${token}`;

function token(customerId: number): string {
  return `#${customerId}`;
}

async function markStep(
  requestId: number,
  steps: DsarStepMarker[],
  step: string,
  detail?: string,
): Promise<DsarStepMarker[]> {
  const next = [
    ...steps,
    { step, completedAt: new Date().toISOString(), ...(detail ? { detail } : {}) },
  ];
  await db
    .update(dsarRequestsTable)
    .set({ steps: next })
    .where(eq(dsarRequestsTable.id, requestId));
  return next;
}

function hasStep(steps: DsarStepMarker[], step: string): boolean {
  return steps.some((s) => s.step === step);
}

async function writeDsarAudit(opts: {
  dealerId: number;
  actor: string;
  action: "export" | "delete" | "update";
  customerId: number;
  summary: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogsTable).values({
    dealerId: opts.dealerId,
    actorName: opts.actor,
    action: opts.action,
    module: "customers",
    entityType: "customer",
    entityId: String(opts.customerId),
    summary: opts.summary,
    details: opts.details,
  });
}

/** Gather all lead ids + phones/emails linked to the subject in-dealer. */
async function subjectGraph(dealerId: number, customerId: number) {
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    );
  if (!customer) return null;
  const leads = await db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.dealerId, dealerId), eq(leadsTable.customerId, customerId)),
    );
  const phones = [
    customer.phone,
    customer.whatsapp,
    ...leads.map((l) => l.phone),
  ].filter((p): p is string => !!p);
  return { customer, leads, leadIds: leads.map((l) => l.id), phones };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function buildExportBundle(
  dealerId: number,
  customerId: number,
): Promise<Record<string, unknown> | null> {
  const graph = await subjectGraph(dealerId, customerId);
  if (!graph) return null;
  const { customer, leads, leadIds, phones } = graph;

  const dealerScoped = <T extends { dealerId: number | null }>(rows: T[]) =>
    rows.filter((r) => r.dealerId === dealerId);

  const [contacts, notes, personas, docs, deals, finApps, invoices, testDrives, reviews] =
    await Promise.all([
      db
        .select()
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.dealerId, dealerId),
            eq(contactsTable.accountId, customerId),
          ),
        ),
      db
        .select()
        .from(customerNotesTable)
        .where(
          and(
            eq(customerNotesTable.dealerId, dealerId),
            eq(customerNotesTable.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(customerPersonasTable)
        .where(
          and(
            eq(customerPersonasTable.dealerId, dealerId),
            eq(customerPersonasTable.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(customerDocumentsTable)
        .where(
          and(
            eq(customerDocumentsTable.dealerId, dealerId),
            eq(customerDocumentsTable.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(dealsTable)
        .where(
          and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.customerId, customerId)),
        ),
      db
        .select()
        .from(financeApplicationsTable)
        .where(
          and(
            eq(financeApplicationsTable.dealerId, dealerId),
            eq(financeApplicationsTable.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.dealerId, dealerId),
            eq(invoicesTable.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(testDrivesTable)
        .where(
          and(
            eq(testDrivesTable.dealerId, dealerId),
            eq(testDrivesTable.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(reviewsTable)
        .where(
          and(
            eq(reviewsTable.dealerId, dealerId),
            eq(reviewsTable.customerId, customerId),
          ),
        ),
    ]);

  const payments =
    invoices.length > 0
      ? await db
          .select()
          .from(paymentsTable)
          .where(
            and(
              eq(paymentsTable.dealerId, dealerId),
              inArray(
                paymentsTable.invoiceId,
                invoices.map((i) => i.id),
              ),
            ),
          )
      : [];

  const timeline = await db
    .select()
    .from(timelineEventsTable)
    .where(
      and(
        eq(timelineEventsTable.dealerId, dealerId),
        eq(timelineEventsTable.customerId, customerId),
      ),
    );
  const emails = await db
    .select()
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.dealerId, dealerId),
        eq(emailLogsTable.customerId, customerId),
      ),
    );
  const calls =
    leadIds.length > 0
      ? dealerScoped(
          await db
            .select()
            .from(callLogsTable)
            .where(inArray(callLogsTable.leadId, leadIds)),
        )
      : [];
  const whatsapp =
    phones.length > 0
      ? dealerScoped(
          await db
            .select()
            .from(whatsappMessagesTable)
            .where(inArray(whatsappMessagesTable.phone, phones)),
        )
      : [];

  return {
    generatedAt: new Date().toISOString(),
    scope: "single-dealer (active tenant)",
    classes: {
      "C1_C2_identity": { customer, contacts, leads },
      C3_financial: {
        note: "Financial ledger retained for statutory audit; exported for portability.",
        deals,
        invoices,
        payments,
        financeApplications: finApps,
      },
      C4_communications: {
        whatsappMessages: whatsapp,
        callLogs: calls,
        emailLogs: emails,
        timelineEvents: timeline,
      },
      C5_derived: {
        personas,
        notes,
        reviews,
        testDrives,
      },
      documents: docs.map((d) => ({
        id: d.id,
        type: d.type,
        fileName: d.fileName,
        mimeType: d.mimeType,
        uploadedBy: d.uploadedBy,
      })),
    },
  };
}

export async function processExport(request: DsarRequest, actor: string): Promise<void> {
  try {
    const bundle = await buildExportBundle(request.dealerId, request.customerId);
    await db
      .update(dsarRequestsTable)
      .set({
        bundle: bundle ?? { error: "customer not found" },
        status: bundle ? "completed" : "failed",
        completedAt: new Date(),
      })
      .where(eq(dsarRequestsTable.id, request.id));
    await writeDsarAudit({
      dealerId: request.dealerId,
      actor,
      action: "export",
      customerId: request.customerId,
      summary: `DSAR export bundle assembled for customer #${request.customerId}`,
      details: { dsarRequestId: request.id, classes: ["C1", "C2", "C3", "C4", "C5"] },
    });
  } catch (err) {
    logger.error({ err, dsarId: request.id }, "DSAR export failed");
    await db
      .update(dsarRequestsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(dsarRequestsTable.id, request.id));
  }
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/** R10.5 legal holds: open deals / active finance apps / open gates defer erasure. */
export async function erasureHolds(
  dealerId: number,
  customerId: number,
): Promise<string[]> {
  const unmet: string[] = [];
  const openDeals = await db
    .select({ id: dealsTable.id, stage: dealsTable.stage })
    .from(dealsTable)
    .where(
      and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.customerId, customerId)),
    );
  for (const d of openDeals) {
    if (d.stage === "desking" || d.stage === "committed") {
      unmet.push(`open_deal:${d.id} (${d.stage})`);
    }
  }
  const finApps = await db
    .select({ id: financeApplicationsTable.id, status: financeApplicationsTable.status })
    .from(financeApplicationsTable)
    .where(
      and(
        eq(financeApplicationsTable.dealerId, dealerId),
        eq(financeApplicationsTable.customerId, customerId),
      ),
    );
  for (const f of finApps) {
    if (["pending", "submitted", "under_review", "approved"].includes(f.status)) {
      unmet.push(`active_finance_application:${f.id} (${f.status})`);
    }
  }
  const gates = await db
    .select({ id: gatesTable.id, status: gatesTable.status })
    .from(gatesTable)
    .where(
      and(eq(gatesTable.dealerId, dealerId), eq(gatesTable.customerId, customerId)),
    );
  for (const g of gates) {
    if (g.status === "pending") unmet.push(`open_gate:${g.id}`);
  }
  return unmet;
}

export async function runErasureSaga(
  request: DsarRequest,
  actor: string,
): Promise<void> {
  const { dealerId, customerId } = request;
  let steps = request.steps ?? [];
  try {
    const graph = await subjectGraph(dealerId, customerId);
    if (!graph) {
      await db
        .update(dsarRequestsTable)
        .set({ status: "failed", error: "customer not found" })
        .where(eq(dsarRequestsTable.id, request.id));
      return;
    }
    const { customer, leadIds, phones } = graph;
    const tok = token(customerId);

    // 1 — freeze: revoke all marketing consent so no outreach proposes sends.
    if (!hasStep(steps, "freeze_consent")) {
      const revoked = Object.fromEntries(
        Object.entries(customer.marketingConsent ?? {}).map(([ch, e]) => [
          ch,
          { ...e, granted: false, basis: "erasure_freeze", capturedAt: new Date().toISOString() },
        ]),
      );
      await db
        .update(customersTable)
        .set({ marketingConsent: revoked })
        .where(eq(customersTable.id, customer.id));
      steps = await markStep(request.id, steps, "freeze_consent");
    }

    // 2 — anonymize C1/C2 (customer shell survives for C3 referential integrity).
    if (!hasStep(steps, "anonymize_identity")) {
      await db
        .update(customersTable)
        .set({
          name: ERASED_NAME(tok),
          email: null,
          phone: null,
          whatsapp: null,
          dateOfBirth: null,
          occupation: null,
          company: null,
          address: null,
          city: null,
          country: null,
          location: null,
          taxNumber: null,
          avatarUrl: null,
          tags: [],
          erasedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(customersTable.id, customer.id));
      // ERPNext sync: disable the mapped ERPNext Customer for erased records.
      queueCustomerSync(dealerId, customer.id);
      await db
        .update(contactsTable)
        .set({ name: ERASED_NAME(tok), email: null, phone: null, title: null })
        .where(
          and(
            eq(contactsTable.dealerId, dealerId),
            eq(contactsTable.accountId, customer.id),
          ),
        );
      if (leadIds.length > 0) {
        await db
          .update(leadsTable)
          .set({
            name: ERASED_NAME(tok),
            email: null,
            phone: null,
            company: null,
            notes: null,
            testDriveLicence: null,
          })
          .where(inArray(leadsTable.id, leadIds));
      }
      steps = await markStep(request.id, steps, "anonymize_identity");
    }

    // 3 — purge C4/C5 payloads; keep metadata/aggregates.
    if (!hasStep(steps, "purge_communications")) {
      if (phones.length > 0) {
        // Tenant-scoped: only this dealer's rows — a phone number can exist
        // under multiple dealers and erasure must never cross tenants.
        await db
          .update(whatsappMessagesTable)
          .set({ body: "[erased]" })
          .where(
            and(
              eq(whatsappMessagesTable.dealerId, dealerId),
              inArray(whatsappMessagesTable.phone, phones),
            ),
          );
      }
      if (leadIds.length > 0) {
        await db
          .update(callLogsTable)
          .set({ transcript: null, notes: null, recordingUrl: null })
          .where(inArray(callLogsTable.leadId, leadIds));
      }
      await db
        .update(emailLogsTable)
        .set({ payload: {} })
        .where(
          and(
            eq(emailLogsTable.dealerId, dealerId),
            eq(emailLogsTable.customerId, customerId),
          ),
        );
      await db
        .update(timelineEventsTable)
        .set({ detail: null })
        .where(
          and(
            eq(timelineEventsTable.dealerId, dealerId),
            eq(timelineEventsTable.customerId, customerId),
          ),
        );
      await db
        .update(reviewsTable)
        .set({ comment: null, customerName: ERASED_NAME(tok) })
        .where(
          and(
            eq(reviewsTable.dealerId, dealerId),
            eq(reviewsTable.customerId, customerId),
          ),
        );
      await db
        .delete(customerNotesTable)
        .where(
          and(
            eq(customerNotesTable.dealerId, dealerId),
            eq(customerNotesTable.customerId, customerId),
          ),
        );
      await db
        .delete(customerPersonasTable)
        .where(
          and(
            eq(customerPersonasTable.dealerId, dealerId),
            eq(customerPersonasTable.customerId, customerId),
          ),
        );
      steps = await markStep(request.id, steps, "purge_communications");
    }

    // 4 — C3 financial rows are RETAINED; identity is already de-linked to the
    // anonymized shell (customer name tokenized). Ledger is never rewritten.
    if (!hasStep(steps, "retain_financial_delinked")) {
      steps = await markStep(
        request.id,
        steps,
        "retain_financial_delinked",
        "invoices/payments/finance apps kept for statutory audit, linked to anonymized shell",
      );
    }

    // 5 — delete stored document objects (NEVER inside a DB transaction).
    if (!hasStep(steps, "delete_documents")) {
      const docs = await db
        .select()
        .from(customerDocumentsTable)
        .where(
          and(
            eq(customerDocumentsTable.dealerId, dealerId),
            eq(customerDocumentsTable.customerId, customerId),
          ),
        );
      for (const d of docs) {
        try {
          await storage.delete(d.storageKey);
        } catch (err) {
          logger.warn({ err, key: d.storageKey }, "DSAR doc object delete failed (continuing)");
        }
      }
      if (docs.length > 0) {
        await db
          .delete(customerDocumentsTable)
          .where(inArray(customerDocumentsTable.id, docs.map((d) => d.id)));
      }
      steps = await markStep(request.id, steps, "delete_documents", `${docs.length} object(s)`);
    }

    // 6 — R10.7 PENDING-INFRA durable backup-propagation marker.
    if (!hasStep(steps, "backup_marker")) {
      await db
        .update(dsarRequestsTable)
        .set({ pendingBackupErasure: true })
        .where(eq(dsarRequestsTable.id, request.id));
      steps = await markStep(
        request.id,
        steps,
        "backup_marker",
        "backup/DR propagation pending infra (crypto-shred) — not claimed live",
      );
    }

    // 7 — finalize + audit (audit row SURVIVES the erasure it describes).
    await db
      .update(dsarRequestsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(dsarRequestsTable.id, request.id));
    await markStep(request.id, steps, "finalize");
    await writeDsarAudit({
      dealerId,
      actor,
      action: "delete",
      customerId,
      summary: `DSAR erasure completed for customer #${customerId}: C1/C2 anonymized, C4/C5 purged, C3 retained de-linked`,
      details: { dsarRequestId: request.id, pendingBackupErasure: true },
    });
    // Opt-out state persists on whatsapp_conversations by design (R10.6).
  } catch (err) {
    logger.error({ err, dsarId: request.id }, "DSAR erasure saga failed");
    await db
      .update(dsarRequestsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(dsarRequestsTable.id, request.id));
  }
}
