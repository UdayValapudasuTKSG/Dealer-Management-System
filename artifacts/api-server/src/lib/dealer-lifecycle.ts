import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  dealersTable,
  invoicesTable,
  financeApplicationsTable,
  gatesTable,
  provisioningStepsTable,
  customersTable,
  leadsTable,
  dealsTable,
  vehiclesTable,
  quotesTable,
  paymentsTable,
  serviceOrdersTable,
  auditLogsTable,
  OFFBOARDING_STEP_KEYS,
  type OffboardingStepKey,
  type Dealer,
} from "@workspace/db";
import { objectStorageClient } from "./objectStorage";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// P3 dealer lifecycle: suspend advisory pre-check, offboarding export/retention
// SAGA (durable step markers in provisioning_steps — keys disjoint from
// provisioning), and the close gate. No DB transaction spans the GCS upload.
// ---------------------------------------------------------------------------

/** Retention window started at offboard; close is blocked until it lapses. */
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);

export type SuspendBlocker =
  | "open_invoices"
  | "undisbursed_finance"
  | "open_gates";

/**
 * Advisory pre-check for money-affecting lifecycle moves (suspend/offboard):
 * open money exposure returns blockers the caller must force past.
 */
export async function suspendBlockers(
  dealerId: number,
): Promise<SuspendBlocker[]> {
  const blockers: SuspendBlocker[] = [];
  const [openInvoices] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.dealerId, dealerId),
        inArray(invoicesTable.status, ["issued", "partially_paid"]),
      ),
    );
  if ((openInvoices?.count ?? 0) > 0) blockers.push("open_invoices");
  const [undisbursed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(financeApplicationsTable)
    .where(
      and(
        eq(financeApplicationsTable.dealerId, dealerId),
        eq(financeApplicationsTable.status, "approved"),
      ),
    );
  if ((undisbursed?.count ?? 0) > 0) blockers.push("undisbursed_finance");
  if (await hasOpenGates(dealerId)) blockers.push("open_gates");
  return blockers;
}

export async function hasOpenGates(dealerId: number): Promise<boolean> {
  const [open] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gatesTable)
    .where(
      and(eq(gatesTable.dealerId, dealerId), eq(gatesTable.status, "pending")),
    );
  return (open?.count ?? 0) > 0;
}

// --- Offboarding SAGA -------------------------------------------------------

async function markStep(
  dealerId: number,
  stepKey: OffboardingStepKey,
  patch: Partial<{
    status: "pending" | "in_progress" | "done" | "failed";
    lastError: string | null;
  }>,
) {
  await db
    .insert(provisioningStepsTable)
    .values({
      dealerId,
      stepKey,
      status: patch.status ?? "pending",
      attempts: 1,
      startedAt: new Date(),
      doneAt: patch.status === "done" ? new Date() : null,
      lastError: patch.lastError ?? null,
    })
    .onConflictDoUpdate({
      target: [provisioningStepsTable.dealerId, provisioningStepsTable.stepKey],
      set: {
        status: patch.status ?? "pending",
        attempts: sql`${provisioningStepsTable.attempts} + 1`,
        doneAt: patch.status === "done" ? new Date() : null,
        lastError: patch.lastError ?? null,
      },
    });
}

export async function offboardingStepStates(dealerId: number) {
  const rows = await db
    .select({
      stepKey: provisioningStepsTable.stepKey,
      status: provisioningStepsTable.status,
    })
    .from(provisioningStepsTable)
    .where(eq(provisioningStepsTable.dealerId, dealerId));
  const map = new Map(rows.map((r) => [r.stepKey, r.status]));
  return OFFBOARDING_STEP_KEYS.map((k) => ({
    stepKey: k,
    status: map.get(k) ?? "pending",
  }));
}

/** Tenant tables included in the whole-tenant offboarding export bundle. */
const EXPORT_TABLES = [
  ["customers", customersTable],
  ["leads", leadsTable],
  ["deals", dealsTable],
  ["vehicles", vehiclesTable],
  ["quotes", quotesTable],
  ["invoices", invoicesTable],
  ["payments", paymentsTable],
  ["finance_applications", financeApplicationsTable],
  ["service_orders", serviceOrdersTable],
  ["gates", gatesTable],
  ["audit_logs", auditLogsTable],
] as const;

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  const bucketName = parts[1] ?? "";
  const objectName = parts.slice(2).join("/");
  return { bucketName, objectName };
}

/**
 * Runs the offboarding SAGA for a dealer already flipped to `offboarding`:
 * freeze_writes (marker only — the 423 write block is live via status) →
 * export_bundle (in-memory JSON of every tenant table) → deliver_export
 * (GCS object under the dealer's private prefix; external, no txn held) →
 * retention_clock (retentionUntil = offboardedAt + RETENTION_DAYS).
 * Idempotent: re-run resumes from the first non-done step.
 */
export async function runOffboardingSaga(dealer: Dealer): Promise<void> {
  const dealerId = dealer.id;
  const states = new Map(
    (await offboardingStepStates(dealerId)).map((s) => [s.stepKey, s.status]),
  );
  try {
    if (states.get("freeze_writes") !== "done") {
      await markStep(dealerId, "freeze_writes", { status: "done" });
    }
    let bundle: Record<string, unknown[]> | null = null;
    if (
      states.get("export_bundle") !== "done" ||
      states.get("deliver_export") !== "done"
    ) {
      await markStep(dealerId, "export_bundle", { status: "in_progress" });
      bundle = {};
      for (const [name, table] of EXPORT_TABLES) {
        bundle[name] = await db
          .select()
          .from(table)
          .where(eq(table.dealerId, dealerId));
      }
      await markStep(dealerId, "export_bundle", { status: "done" });
    }
    if (states.get("deliver_export") !== "done") {
      await markStep(dealerId, "deliver_export", { status: "in_progress" });
      // External side effect — GCS write happens OUTSIDE any DB transaction.
      const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
      if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not set");
      const objectPath = `${privateDir}/dealers/dealer-${dealerId}/exports/tenant-export.json`;
      const { bucketName, objectName } = parseObjectPath(objectPath);
      await objectStorageClient
        .bucket(bucketName)
        .file(objectName)
        .save(
          JSON.stringify(
            {
              dealer: { ...dealer, entitlements: undefined },
              exportedAt: new Date().toISOString(),
              tables: bundle,
            },
            null,
            2,
          ),
          { contentType: "application/json" },
        );
      await db
        .update(dealersTable)
        .set({ exportUrl: objectPath })
        .where(eq(dealersTable.id, dealerId));
      await markStep(dealerId, "deliver_export", { status: "done" });
    }
    if (states.get("retention_clock") !== "done") {
      const offboardedAt = dealer.offboardedAt ?? new Date();
      const retentionUntil = new Date(
        offboardedAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      await db
        .update(dealersTable)
        .set({ retentionUntil })
        .where(eq(dealersTable.id, dealerId));
      await markStep(dealerId, "retention_clock", { status: "done" });
    }
    logger.info({ dealerId }, "Offboarding saga complete");
  } catch (err) {
    const failed =
      OFFBOARDING_STEP_KEYS.find(
        (k) =>
          states.get(k) !== "done" &&
          !["freeze_writes"].includes(k),
      ) ?? "export_bundle";
    await markStep(dealerId, failed, {
      status: "failed",
      lastError: err instanceof Error ? err.message : String(err),
    });
    logger.error({ err, dealerId }, "Offboarding saga failed");
  }
}

/**
 * Close gate (P3): unmet reasons that keep an offboarding dealer open —
 * export still pending, retention clock active, a legal hold, or open gates.
 */
export async function closeUnmet(dealer: Dealer): Promise<string[]> {
  const unmet: string[] = [];
  const steps = await offboardingStepStates(dealer.id);
  const exportDone =
    steps.find((s) => s.stepKey === "deliver_export")?.status === "done" &&
    !!dealer.exportUrl;
  if (!exportDone) unmet.push("export_pending");
  if (dealer.retentionUntil && dealer.retentionUntil.getTime() > Date.now())
    unmet.push("retention_active");
  if (!dealer.retentionUntil) unmet.push("retention_active");
  if (dealer.legalHold) unmet.push("legal_hold");
  if (await hasOpenGates(dealer.id)) unmet.push("open_gates");
  return unmet;
}
