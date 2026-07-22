import { and, asc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import {
  db,
  dealersTable,
  divisionsTable,
  stageChecklistsTable,
  agentsTable,
  leadSourcesTable,
  dealerTaxesTable,
  emailLogsTable,
  dealerInvitesTable,
  dealerUsersTable,
  provisioningStepsTable,
  PROVISIONING_STEP_KEYS,
  EXTERNAL_PROVISIONING_STEPS,
  ENTITLEMENT_KEYS,
  CHECKLIST_STAGES,
  DEFAULT_STAGE_CHECKLISTS,
  type Dealer,
  type ProvisioningStep,
  type ProvisioningStepKey,
  type DealerEntitlements,
} from "@workspace/db";
import { ensureDefaultRoles, DEFAULT_AGENTS } from "./provisioning";
import { ensureLeadSources } from "./lead-sources";
import { ensureDealerTaxes } from "./taxes";
import { enqueueEmail } from "./email";
import { logger } from "./logger";

/**
 * Dealer onboarding SAGA (P2 NC-11, INV-SAGA-1/2).
 *
 * Durable per-step markers in provisioning_steps; the orchestrator re-drives
 * from the first non-done marker. External steps (GCS / SMTP / LOS) never run
 * inside a held DB transaction — each is bracketed by two short local writes:
 * claim (in_progress) → side-effect outside any txn → record (done|failed).
 * Abort runs per-step compensation in REVERSE order; a dealer is never left
 * partially active (status stays `provisioning` or moves to `closed`).
 */

export type SagaRunResult = {
  ok: boolean;
  failedStep?: ProvisioningStepKey;
  error?: string;
};

/** Dev-only fail injection (never honored in production): forces the named
 * step to fail so compensation can be exercised end-to-end. */
export function devFailStep(header: unknown): ProvisioningStepKey | null {
  if (process.env.NODE_ENV === "production") return null;
  if (typeof header !== "string") return null;
  return (PROVISIONING_STEP_KEYS as readonly string[]).includes(header)
    ? (header as ProvisioningStepKey)
    : null;
}

/** An in_progress claim older than this is considered orphaned (the process
 * died mid-step) and may be taken over by a new run. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/** True if another run currently holds a fresh (non-stale) step claim. */
export async function sagaInFlight(dealerId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: provisioningStepsTable.id })
    .from(provisioningStepsTable)
    .where(
      and(
        eq(provisioningStepsTable.dealerId, dealerId),
        eq(provisioningStepsTable.status, "in_progress"),
        gt(
          provisioningStepsTable.startedAt,
          new Date(Date.now() - STALE_CLAIM_MS),
        ),
      ),
    )
    .limit(1);
  return !!row;
}

/** Create the durable step ledger for a fresh dealer (all pending). */
export async function createSagaLedger(dealerId: number): Promise<void> {
  await db
    .insert(provisioningStepsTable)
    .values(PROVISIONING_STEP_KEYS.map((stepKey) => ({ dealerId, stepKey })))
    .onConflictDoNothing();
}

export async function getSagaSteps(
  dealerId: number,
): Promise<ProvisioningStep[]> {
  const rows = await db
    .select()
    .from(provisioningStepsTable)
    .where(eq(provisioningStepsTable.dealerId, dealerId));
  const order = new Map(PROVISIONING_STEP_KEYS.map((k, i) => [k, i] as const));
  return rows.sort(
    (a, b) =>
      (order.get(a.stepKey as ProvisioningStepKey) ?? 99) -
      (order.get(b.stepKey as ProvisioningStepKey) ?? 99),
  );
}

// ---------------------------------------------------------------------------
// Step implementations. Each is idempotent (safe to re-run on resume).
// ---------------------------------------------------------------------------

type StepCtx = { dealer: Dealer; ownerEmail: string | null; actor: string };

async function runStep(key: ProvisioningStepKey, ctx: StepCtx): Promise<void> {
  const { dealer } = ctx;
  const dealerId = dealer.id;
  switch (key) {
    case "seed_roles":
      // Canonical role/permission templates are global and shared; ensure
      // they exist (idempotent). Never compensated (other tenants use them).
      await ensureDefaultRoles();
      return;
    case "seed_divisions": {
      await db
        .insert(divisionsTable)
        .values([
          { dealerId, name: "CAM Motors", code: "CAM" },
          { dealerId, name: "GT Automotive", code: "GT" },
        ])
        .onConflictDoNothing();
      return;
    }
    case "seed_taxes":
      await ensureDealerTaxes(dealerId);
      return;
    case "seed_entitlements": {
      // Materialize an explicit entitlement matrix (missing keys previously
      // meant "enabled"; a provisioned dealer gets a full explicit snapshot).
      const explicit: DealerEntitlements = {};
      for (const k of ENTITLEMENT_KEYS) {
        explicit[k] = dealer.entitlements?.[k] ?? true;
      }
      await db
        .update(dealersTable)
        .set({ entitlements: explicit })
        .where(eq(dealersTable.id, dealerId));
      return;
    }
    case "provision_storage":
      // EXTERNAL (PENDING-INFRA seam): per-dealer GCS prefix is create-if-
      // absent by convention (`dealers/<id>/`) — object storage paths are
      // derived, so there is nothing durable to create yet. Logged so the
      // step is auditable and stays resumable when real bucket setup lands.
      logger.info(
        { dealerId, prefix: `dealers/${dealerId}/` },
        "provision_storage: GCS prefix reserved (create-if-absent seam)",
      );
      return;
    case "seed_lead_sources":
      await ensureLeadSources(dealerId);
      return;
    case "seed_checklists":
      await db
        .insert(stageChecklistsTable)
        .values(
          CHECKLIST_STAGES.map((stage) => ({
            dealerId,
            stage,
            version: 1,
            items: DEFAULT_STAGE_CHECKLISTS[stage],
            createdBy: "provisioning",
          })),
        )
        .onConflictDoNothing();
      return;
    case "seed_agents": {
      const existing = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.dealerId, dealerId))
        .limit(1);
      if (existing.length === 0) {
        await db
          .insert(agentsTable)
          .values(DEFAULT_AGENTS.map((a) => ({ dealerId, ...a })));
      }
      return;
    }
    case "invite_owner_admin": {
      if (!ctx.ownerEmail) return; // optional — no owner supplied
      const email = ctx.ownerEmail.toLowerCase();
      await db
        .insert(dealerInvitesTable)
        .values({ dealerId, email, invitedBy: ctx.actor })
        .onConflictDoNothing();
      // EXTERNAL: SMTP goes through the durable email outbox (email_logs);
      // dedupeKey makes re-runs no-ops. Never inside a DB transaction.
      await enqueueEmail({
        template: "owner_invite",
        to: email,
        dealerId,
        data: { dealerName: dealer.name },
        dedupeKey: `owner-invite-${dealerId}-${email}`,
      });
      return;
    }
    case "register_los":
      // EXTERNAL (PENDING-INFRA seam): LOS Demerara sandbox handshake.
      // Idempotent by dealerId; logged until the real enrolment API exists.
      logger.info(
        { dealerId },
        "register_los: LOS Demerara sandbox enrolment (seam, no-op)",
      );
      return;
  }
}

/** Reverse compensation per step (P2 edge table). Global roles are shared
 * across tenants and are never removed. */
async function compensateStep(
  key: ProvisioningStepKey,
  dealerId: number,
): Promise<void> {
  switch (key) {
    case "register_los":
      logger.info({ dealerId }, "compensate register_los: enrolment revoked (seam)");
      return;
    case "invite_owner_admin":
      await db
        .update(dealerInvitesTable)
        .set({ status: "revoked" })
        .where(
          and(
            eq(dealerInvitesTable.dealerId, dealerId),
            eq(dealerInvitesTable.status, "pending"),
          ),
        );
      await db
        .update(emailLogsTable)
        .set({ status: "failed", lastError: "provisioning aborted" })
        .where(
          and(
            eq(emailLogsTable.dealerId, dealerId),
            eq(emailLogsTable.template, "owner_invite"),
            eq(emailLogsTable.status, "queued"),
          ),
        );
      return;
    case "seed_checklists":
      await db
        .delete(stageChecklistsTable)
        .where(eq(stageChecklistsTable.dealerId, dealerId));
      return;
    case "seed_agents":
      await db.delete(agentsTable).where(eq(agentsTable.dealerId, dealerId));
      return;
    case "seed_lead_sources":
      await db
        .delete(leadSourcesTable)
        .where(eq(leadSourcesTable.dealerId, dealerId));
      return;
    case "provision_storage":
      logger.info(
        { dealerId },
        "compensate provision_storage: prefix tombstoned (seam)",
      );
      return;
    case "seed_entitlements":
      await db
        .update(dealersTable)
        .set({ entitlements: {} })
        .where(eq(dealersTable.id, dealerId));
      return;
    case "seed_taxes":
      await db
        .delete(dealerTaxesTable)
        .where(eq(dealerTaxesTable.dealerId, dealerId));
      return;
    case "seed_divisions":
      await db
        .delete(divisionsTable)
        .where(eq(divisionsTable.dealerId, dealerId));
      return;
    case "seed_roles":
      return; // global templates, shared — never compensated
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Re-drive the saga from the first non-done step. Claims each step with a
 * short local write, runs the side-effect OUTSIDE any transaction, then
 * records the result with a second short write. Stops on first failure.
 */
export async function runProvisioningSaga(
  dealerId: number,
  opts: { actor?: string; failStep?: ProvisioningStepKey | null } = {},
): Promise<SagaRunResult> {
  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  if (!dealer) return { ok: false, error: "dealer not found" };
  if (dealer.status !== "provisioning") {
    return { ok: false, error: `dealer status is ${dealer.status}` };
  }
  const [invite] = await db
    .select({ email: dealerInvitesTable.email })
    .from(dealerInvitesTable)
    .where(eq(dealerInvitesTable.dealerId, dealerId))
    .orderBy(asc(dealerInvitesTable.id))
    .limit(1);
  const ctx: StepCtx = {
    dealer,
    ownerEmail: invite?.email ?? null,
    actor: opts.actor ?? "platform",
  };

  const steps = await getSagaSteps(dealerId);
  for (const step of steps) {
    if (step.status === "done") continue;
    const key = step.stepKey as ProvisioningStepKey;
    // Claim: short local write (never wraps the side-effect). Single-run
    // semantics: a fresh in_progress row belongs to another run and is NOT
    // claimable — only orphaned claims (older than STALE_CLAIM_MS) may be
    // taken over. The attempt counter increments atomically at the DB level.
    const claimed = await db
      .update(provisioningStepsTable)
      .set({
        status: "in_progress",
        attempts: sql`${provisioningStepsTable.attempts} + 1`,
        startedAt: new Date(),
        lastError: null,
      })
      .where(
        and(
          eq(provisioningStepsTable.id, step.id),
          or(
            inArray(provisioningStepsTable.status, [
              "pending",
              "failed",
              "compensated",
            ]),
            and(
              eq(provisioningStepsTable.status, "in_progress"),
              lt(
                provisioningStepsTable.startedAt,
                new Date(Date.now() - STALE_CLAIM_MS),
              ),
            ),
          ),
        ),
      )
      .returning({ id: provisioningStepsTable.id });
    if (claimed.length === 0) {
      // Another run holds this step: stop here rather than skipping ahead
      // (later steps depend on earlier ones having completed).
      return {
        ok: false,
        failedStep: key,
        error: "saga already in flight (step claimed by another run)",
      };
    }
    try {
      if (opts.failStep === key) {
        throw new Error(`injected failure at ${key} (dev fail injection)`);
      }
      await runStep(key, ctx); // side-effect OUTSIDE any txn
      await db
        .update(provisioningStepsTable)
        .set({ status: "done", doneAt: new Date() })
        .where(eq(provisioningStepsTable.id, step.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(provisioningStepsTable)
        .set({ status: "failed", lastError: message })
        .where(eq(provisioningStepsTable.id, step.id));
      logger.error({ err, dealerId, step: key }, "Provisioning step failed");
      return { ok: false, failedStep: key, error: message };
    }
  }
  return { ok: true };
}

/**
 * Abort: run per-step compensation in REVERSE over every step that made
 * progress, mark them compensated, and close the dealer shell. The dealer is
 * never left partially active (INV-SAGA-2).
 */
export async function abortProvisioningSaga(
  dealerId: number,
  reason: string,
): Promise<void> {
  const steps = await getSagaSteps(dealerId);
  const progressed = steps.filter((s) =>
    ["done", "failed", "in_progress"].includes(s.status),
  );
  for (const step of [...progressed].reverse()) {
    const key = step.stepKey as ProvisioningStepKey;
    try {
      await compensateStep(key, dealerId);
      await db
        .update(provisioningStepsTable)
        .set({ status: "compensated", compensationRunAt: new Date() })
        .where(eq(provisioningStepsTable.id, step.id));
    } catch (err) {
      logger.error(
        { err, dealerId, step: key },
        "Compensation failed (continuing reverse pass)",
      );
    }
  }
  await db
    .update(dealersTable)
    .set({ status: "closed" })
    .where(
      and(eq(dealersTable.id, dealerId), eq(dealersTable.status, "provisioning")),
    );
  logger.info({ dealerId, reason }, "Provisioning saga aborted and compensated");
}

// ---------------------------------------------------------------------------
// Go-live checklist (deterministic evaluator → {unmet:[]})
// ---------------------------------------------------------------------------

export async function goLiveUnmet(dealerId: number): Promise<string[]> {
  const unmet: string[] = [];
  const steps = await getSagaSteps(dealerId);
  if (steps.length === 0) unmet.push("saga_not_started");
  for (const s of steps) {
    if (s.status !== "done") unmet.push(`step:${s.stepKey}`);
  }
  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  if (!dealer) return ["dealer_not_found"];
  if (!(dealer.usdExchangeRate > 0)) unmet.push("usd_exchange_rate");
  const [division] = await db
    .select({ id: divisionsTable.id })
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, dealerId))
    .limit(1);
  if (!division) unmet.push("division_active");
  // Owner invite (if one was issued) must be accepted OR a GM membership
  // must already exist — the founding operator has to be able to sign in.
  const invites = await db
    .select()
    .from(dealerInvitesTable)
    .where(eq(dealerInvitesTable.dealerId, dealerId));
  const pendingInvite = invites.some((i) => i.status === "pending");
  if (pendingInvite) {
    const [gm] = await db
      .select({ id: dealerUsersTable.id })
      .from(dealerUsersTable)
      .where(
        and(
          eq(dealerUsersTable.dealerId, dealerId),
          eq(dealerUsersTable.isGeneralManager, true),
        ),
      )
      .limit(1);
    if (!gm) unmet.push("owner_invite_accepted");
  }
  return unmet;
}
