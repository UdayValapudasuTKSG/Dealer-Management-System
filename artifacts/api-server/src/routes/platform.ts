import { Router, type IRouter, type Response } from "express";
import { asc, desc, eq, sql, and, isNull } from "drizzle-orm";
import {
  db,
  dealersTable,
  dealerUsersTable,
  usersTable,
  rolesTable,
  agentsTable,
  agentRunsTable,
  agentPoliciesTable,
  AGENT_POLICY_MASTER_KEY,
  auditLogsTable,
  impersonationGrantsTable,
  DEALER_STATUS_TRANSITIONS,
  type DealerStatus,
  type AuditAction,
} from "@workspace/db";
import {
  ListDealersResponse,
  CreateDealerBody,
  CreateDealerResponse,
  UpdateDealerParams,
  UpdateDealerBody,
  UpdateDealerResponse,
  ListDealerMembersParams,
  ListDealerMembersResponse,
  AddDealerMemberParams,
  AddDealerMemberBody,
  AddDealerMemberResponse,
  UpdateDealerMemberParams,
  UpdateDealerMemberBody,
  UpdateDealerMemberResponse,
  RemoveDealerMemberParams,
  ListPlatformUsersResponse,
  ListDealerAgentsParams,
  ListDealerAgentsResponse,
  GetDealerAgentsOverviewParams,
  GetDealerAgentsOverviewResponse,
  ListDealerAgentRunsParams,
  ListDealerAgentRunsResponse,
  UpdateDealerAgentParams,
  UpdateDealerAgentBody,
  UpdateDealerAgentResponse,
  ListPlatformAuditQueryParams,
  ListPlatformAuditResponse,
  StartImpersonationBody,
  StartImpersonationResponse,
  SuspendDealerParams,
  RetryOffboardingParams,
  RetryOffboardingResponse,
  SuspendDealerBody,
  SuspendDealerResponse,
  ResumeDealerParams,
  ResumeDealerResponse,
  OffboardDealerParams,
  OffboardDealerBody,
  OffboardDealerResponse,
  CloseDealerParams,
  CloseDealerResponse,
  ListAgentPoliciesResponse,
  UpdateAgentPolicyBody,
  UpdateAgentPolicyResponse,
} from "@workspace/api-zod";
import {
  suspendBlockers,
  runOffboardingSaga,
  closeUnmet,
} from "../lib/dealer-lifecycle";
import { DEFAULT_AGENTS } from "../lib/provisioning";
import { ensureDefaultRoles, pauseDealerAgents } from "../lib/provisioning";
import {
  createSagaLedger,
  getSagaSteps,
  runProvisioningSaga,
  sagaInFlight,
  abortProvisioningSaga,
  goLiveUnmet,
  devFailStep,
} from "../lib/provisioning-saga";
import {
  dealerInvitesTable,
  provisioningStepsTable,
  EXTERNAL_PROVISIONING_STEPS,
  type ProvisioningStepKey,
} from "@workspace/db";
import {
  GetDealerProvisioningParams,
  RetryDealerProvisioningParams,
  AbortDealerProvisioningParams,
  AbortDealerProvisioningBody,
  ActivateDealerParams,
} from "@workspace/api-zod";
import { invalidateGrantCache } from "../middlewares/rbac";
import { logger } from "../lib/logger";

// All /platform routes are gated to the super admin in middlewares/rbac.ts
// (authorize short-circuits the "platform" segment on user.isSuperAdmin).
const router: IRouter = Router();

/** How long a super-admin impersonation grant stays valid. */
// NC-10: impersonation windows are capped at 60 minutes.
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

/** Platform-level audit rows carry dealerId = null so they never leak into a
 * dealer's own audit trail; the subject dealer goes in details. */
async function platformAudit(
  res: Response,
  entry: {
    action: AuditAction;
    entityType: string;
    entityId: string | number | null;
    summary: string;
    details?: Record<string, unknown>;
  },
) {
  const user = res.locals.user;
  try {
    await db.insert(auditLogsTable).values({
      dealerId: null,
      actorUserId: user?.id ?? null,
      actorClerkId: user?.clerkId ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      action: entry.action,
      module: "platform",
      entityType: entry.entityType,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      summary: entry.summary,
      details: entry.details ?? null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write platform audit row");
  }
}

async function dealerWithCount(id: number) {
  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, id));
  if (!dealer) return null;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dealerUsersTable)
    .where(eq(dealerUsersTable.dealerId, id));
  return { ...dealer, userCount: count };
}

router.get("/platform/dealers", async (_req, res): Promise<void> => {
  const dealers = await db
    .select()
    .from(dealersTable)
    .orderBy(asc(dealersTable.id));
  const counts = await db
    .select({
      dealerId: dealerUsersTable.dealerId,
      count: sql<number>`count(*)::int`,
    })
    .from(dealerUsersTable)
    .groupBy(dealerUsersTable.dealerId);
  const countMap = new Map(counts.map((c) => [c.dealerId, c.count]));
  res.json(
    ListDealersResponse.parse(
      dealers.map((d) => ({ ...d, userCount: countMap.get(d.id) ?? 0 })),
    ),
  );
});

router.post("/platform/dealers", async (req, res): Promise<void> => {
  const body = CreateDealerBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  const [existing] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .where(sql`lower(${dealersTable.name}) = ${name.toLowerCase()}`);
  if (existing) {
    res.status(409).json({ error: "A dealer with this name already exists" });
    return;
  }
  // NC-3: create ALWAYS returns status=provisioning — the shell row is
  // written first, then the durable SAGA seeds defaults step by step.
  const [created] = await db
    .insert(dealersTable)
    .values({
      name,
      city: body.data.city ?? null,
      country: body.data.country ?? null,
      status: "provisioning",
      ...(body.data.usdExchangeRate !== undefined
        ? { usdExchangeRate: body.data.usdExchangeRate }
        : {}),
      ...(body.data.entitlements !== undefined
        ? { entitlements: body.data.entitlements }
        : {}),
      createdBy: res.locals.user?.clerkId ?? null,
    })
    .returning();
  const dealerId = created!.id;
  await createSagaLedger(dealerId);
  if (body.data.ownerEmail) {
    // Recorded up-front so the invite step (and Clerk JIT binding) can see it.
    await db
      .insert(dealerInvitesTable)
      .values({
        dealerId,
        email: body.data.ownerEmail.toLowerCase(),
        invitedBy: res.locals.user?.email ?? "platform",
      })
      .onConflictDoNothing();
  }
  const failStep = devFailStep(req.header("x-provisioning-fail-step"));
  const run = await runProvisioningSaga(dealerId, {
    actor: res.locals.user?.email ?? "platform",
    failStep,
  });
  await platformAudit(res, {
    action: "provision",
    entityType: "dealer",
    entityId: dealerId,
    summary: `${res.locals.user?.name ?? "Super admin"} created dealership shell "${created!.name}" (provisioning saga ${run.ok ? "completed all steps" : `halted at ${run.failedStep}`})`,
    details: { dealerId, sagaOk: run.ok, failedStep: run.failedStep ?? null },
  });
  res.status(201).json(
    CreateDealerResponse.parse({
      dealer: { ...created!, userCount: 0 },
      saga: await provisioningStatus(dealerId),
    }),
  );
});

/** Assemble the ProvisioningStatus payload (markers + go-live unmet list). */
async function provisioningStatus(dealerId: number) {
  const [dealer] = await db
    .select({ status: dealersTable.status })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const steps = await getSagaSteps(dealerId);
  const firstNonDone = steps.find((s) => s.status !== "done");
  return {
    dealerId,
    status: dealer?.status ?? "provisioning",
    steps: steps.map((s) => ({
      stepKey: s.stepKey,
      status: s.status,
      attempts: s.attempts,
      startedAt: s.startedAt,
      doneAt: s.doneAt,
      lastError: s.lastError,
      compensationRunAt: s.compensationRunAt,
      external: EXTERNAL_PROVISIONING_STEPS.includes(
        s.stepKey as ProvisioningStepKey,
      ),
    })),
    resumableFrom: firstNonDone?.stepKey ?? null,
    unmet: await goLiveUnmet(dealerId),
  };
}

router.get(
  "/platform/dealers/:id/provisioning",
  async (req, res): Promise<void> => {
    const params = GetDealerProvisioningParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [dealer] = await db
      .select({ id: dealersTable.id })
      .from(dealersTable)
      .where(eq(dealersTable.id, params.data.id));
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    res.json(await provisioningStatus(params.data.id));
  },
);

router.post(
  "/platform/dealers/:id/provisioning/retry",
  async (req, res): Promise<void> => {
    const params = RetryDealerProvisioningParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [dealer] = await db
      .select({ status: dealersTable.status, name: dealersTable.name })
      .from(dealersTable)
      .where(eq(dealersTable.id, params.data.id));
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    if (dealer.status !== "provisioning") {
      res
        .status(422)
        .json({ error: `Dealer is ${dealer.status}, not provisioning` });
      return;
    }
    if (await sagaInFlight(params.data.id)) {
      res.status(409).json({ error: "Saga already in flight" });
      return;
    }
    const failStep = devFailStep(req.header("x-provisioning-fail-step"));
    const run = await runProvisioningSaga(params.data.id, {
      actor: res.locals.user?.email ?? "platform",
      failStep,
    });
    await platformAudit(res, {
      action: "provision",
      entityType: "dealer",
      entityId: params.data.id,
      summary: `${res.locals.user?.name ?? "Super admin"} re-drove provisioning for "${dealer.name}" (${run.ok ? "all steps done" : `halted at ${run.failedStep}`})`,
      details: { dealerId: params.data.id, sagaOk: run.ok },
    });
    res.status(202).json(await provisioningStatus(params.data.id));
  },
);

router.post(
  "/platform/dealers/:id/provisioning/abort",
  async (req, res): Promise<void> => {
    const params = AbortDealerProvisioningParams.safeParse(req.params);
    const body = AbortDealerProvisioningBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [dealer] = await db
      .select({ status: dealersTable.status, name: dealersTable.name })
      .from(dealersTable)
      .where(eq(dealersTable.id, params.data.id));
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    if (dealer.status !== "provisioning") {
      res
        .status(422)
        .json({ error: `Dealer is ${dealer.status}, not provisioning` });
      return;
    }
    await abortProvisioningSaga(params.data.id, body.data.reason);
    await platformAudit(res, {
      action: "provision",
      entityType: "dealer",
      entityId: params.data.id,
      summary: `${res.locals.user?.name ?? "Super admin"} aborted provisioning for "${dealer.name}" — reverse compensation run, dealer closed`,
      details: { dealerId: params.data.id, reason: body.data.reason },
    });
    res.status(202).json(await provisioningStatus(params.data.id));
  },
);

router.post(
  "/platform/dealers/:id/activate",
  async (req, res): Promise<void> => {
    const params = ActivateDealerParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [dealer] = await db
      .select()
      .from(dealersTable)
      .where(eq(dealersTable.id, params.data.id));
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    if (dealer.status !== "provisioning") {
      res
        .status(422)
        .json({ unmet: [`status:${dealer.status}`] });
      return;
    }
    // INV-SAGA-2: never active unless every marker is done AND the go-live
    // checklist passes. Deterministic evaluator; 422 {unmet:[]} otherwise.
    const unmet = await goLiveUnmet(params.data.id);
    if (unmet.length > 0) {
      res.status(422).json({ unmet });
      return;
    }
    const [updated] = await db
      .update(dealersTable)
      .set({ status: "active" })
      .where(
        and(
          eq(dealersTable.id, params.data.id),
          eq(dealersTable.status, "provisioning"),
        ),
      )
      .returning();
    if (!updated) {
      res.status(422).json({ unmet: ["status:changed_concurrently"] });
      return;
    }
    await platformAudit(res, {
      action: "activate",
      entityType: "dealer",
      entityId: updated.id,
      summary: `${res.locals.user?.name ?? "Super admin"} activated dealership "${updated.name}" — go-live checklist passed`,
      details: { dealerId: updated.id },
    });
    const full = await dealerWithCount(updated.id);
    res.json(UpdateDealerResponse.parse(full));
  },
);

router.patch("/platform/dealers/:id", async (req, res): Promise<void> => {
  const params = UpdateDealerParams.safeParse(req.params);
  const body = UpdateDealerBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  // Status is NOT patchable here — lifecycle moves go through the dedicated
  // suspend/resume/offboard/close endpoints with their own gates.
  const [updated] = await db
    .update(dealersTable)
    .set({
      name: body.data.name.trim(),
      ...(body.data.city !== undefined ? { city: body.data.city } : {}),
      ...(body.data.country !== undefined
        ? { country: body.data.country }
        : {}),
      ...(body.data.usdExchangeRate !== undefined
        ? { usdExchangeRate: body.data.usdExchangeRate }
        : {}),
      ...(body.data.entitlements !== undefined
        ? { entitlements: body.data.entitlements }
        : {}),
      ...(body.data.legalHold !== undefined
        ? { legalHold: body.data.legalHold }
        : {}),
    })
    .where(eq(dealersTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Dealer not found" });
    return;
  }
  const full = await dealerWithCount(updated.id);
  res.json(UpdateDealerResponse.parse(full));
});

// ---------------------------------------------------------------------------
// P3 dealer lifecycle endpoints. Every move is validated against the
// DEALER_STATUS_TRANSITIONS table (illegal jump → 409 invalid_transition).
// ---------------------------------------------------------------------------

async function loadDealerOr404(res: Response, id: number) {
  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, id));
  if (!dealer) {
    res.status(404).json({ error: "Dealer not found" });
    return null;
  }
  return dealer;
}

// Atomic compare-and-set on dealer status: the UPDATE only lands when the
// row is STILL in the expected `from` status, so two concurrent admin calls
// can never both commit (the loser gets null → 409 stale transition).
async function casDealerStatus(
  id: number,
  from: string,
  set: Partial<typeof dealersTable.$inferInsert> & { status: DealerStatus },
) {
  const [updated] = await db
    .update(dealersTable)
    .set(set)
    .where(
      and(
        eq(dealersTable.id, id),
        eq(dealersTable.status, from as DealerStatus),
      ),
    )
    .returning();
  return updated ?? null;
}

function staleTransition(res: Response, to: DealerStatus) {
  res.status(409).json({
    error: "invalid_transition",
    detail: `dealer status changed concurrently; ${to} not applied`,
    to,
  });
}

function assertTransition(
  res: Response,
  from: string,
  to: DealerStatus,
): boolean {
  const allowed =
    DEALER_STATUS_TRANSITIONS[from as DealerStatus] ?? [];
  if (!allowed.includes(to)) {
    res.status(409).json({
      error: "invalid_transition",
      from,
      to,
    });
    return false;
  }
  return true;
}

router.post(
  "/platform/dealers/:id/suspend",
  async (req, res): Promise<void> => {
    const params = SuspendDealerParams.safeParse(req.params);
    const body = SuspendDealerBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await loadDealerOr404(res, params.data.id);
    if (!dealer) return;
    if (!assertTransition(res, dealer.status, "suspended")) return;
    // Advisory pre-check: open money exposure blocks unless force=true.
    const blockers = await suspendBlockers(dealer.id);
    if (blockers.length > 0 && !body.data.force) {
      res.status(409).json({ error: "suspend_blocked", blockers });
      return;
    }
    const updated = await casDealerStatus(dealer.id, dealer.status, {
      status: "suspended",
    });
    if (!updated) {
      staleTransition(res, "suspended");
      return;
    }
    const paused = await pauseDealerAgents(dealer.id);
    await platformAudit(res, {
      action: "suspend",
      entityType: "dealer",
      entityId: dealer.id,
      summary: `${res.locals.user?.name ?? "Super admin"} suspended dealership "${dealer.name}"${body.data.force ? " (forced past blockers)" : ""} — writes frozen, ${paused} agents paused`,
      details: {
        dealerId: dealer.id,
        reason: body.data.reason,
        force: body.data.force ?? false,
        blockers,
        agentsPaused: paused,
      },
    });
    const full = await dealerWithCount(updated.id);
    res.json(SuspendDealerResponse.parse(full));
  },
);

router.post(
  "/platform/dealers/:id/resume",
  async (req, res): Promise<void> => {
    const params = ResumeDealerParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await loadDealerOr404(res, params.data.id);
    if (!dealer) return;
    if (!assertTransition(res, dealer.status, "active")) return;
    const updated = await casDealerStatus(dealer.id, dealer.status, {
      status: "active",
    });
    if (!updated) {
      staleTransition(res, "active");
      return;
    }
    await platformAudit(res, {
      action: "activate",
      entityType: "dealer",
      entityId: dealer.id,
      summary: `${res.locals.user?.name ?? "Super admin"} resumed dealership "${dealer.name}" (agents stay paused until re-enabled)`,
      details: { dealerId: dealer.id },
    });
    const full = await dealerWithCount(updated.id);
    res.json(ResumeDealerResponse.parse(full));
  },
);

router.post(
  "/platform/dealers/:id/offboard",
  async (req, res): Promise<void> => {
    const params = OffboardDealerParams.safeParse(req.params);
    const body = OffboardDealerBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await loadDealerOr404(res, params.data.id);
    if (!dealer) return;
    if (!assertTransition(res, dealer.status, "offboarding")) return;
    const offboardedAt = new Date();
    const updated = await casDealerStatus(dealer.id, dealer.status, {
      status: "offboarding",
      offboardedAt,
    });
    if (!updated) {
      staleTransition(res, "offboarding");
      return;
    }
    const paused = await pauseDealerAgents(dealer.id);
    await platformAudit(res, {
      action: "suspend",
      entityType: "dealer",
      entityId: dealer.id,
      summary: `${res.locals.user?.name ?? "Super admin"} started offboarding dealership "${dealer.name}" — export + retention clock running, ${paused} agents paused`,
      details: { dealerId: dealer.id, reason: body.data.reason },
    });
    // 202: the export saga runs asynchronously after the response.
    const full = await dealerWithCount(updated.id);
    res.status(202).json(OffboardDealerResponse.parse(full));
    void runOffboardingSaga(updated).catch((err) =>
      req.log.error({ err, dealerId: dealer.id }, "offboarding saga error"),
    );
  },
);

router.post(
  "/platform/dealers/:id/offboarding/retry",
  async (req, res): Promise<void> => {
    const params = RetryOffboardingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await loadDealerOr404(res, params.data.id);
    if (!dealer) return;
    if (dealer.status !== "offboarding") {
      res.status(409).json({
        error: "not_offboarding",
        detail: "Export saga can only be re-driven while status=offboarding",
        status: dealer.status,
      });
      return;
    }
    await platformAudit(res, {
      action: "suspend",
      entityType: "dealer",
      entityId: dealer.id,
      summary: `${res.locals.user?.name ?? "Super admin"} re-drove the offboarding export saga for dealership "${dealer.name}"`,
      details: { dealerId: dealer.id },
    });
    const full = await dealerWithCount(dealer.id);
    res.status(202).json(RetryOffboardingResponse.parse(full));
    // Resumes from the first non-done step in the provisioning_steps ledger.
    void runOffboardingSaga(dealer).catch((err) =>
      req.log.error({ err, dealerId: dealer.id }, "offboarding saga retry error"),
    );
  },
);

router.post(
  "/platform/dealers/:id/close",
  async (req, res): Promise<void> => {
    const params = CloseDealerParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await loadDealerOr404(res, params.data.id);
    if (!dealer) return;
    if (!assertTransition(res, dealer.status, "closed")) return;
    // Close is a hard gate: NO force. All conditions must be met.
    const unmet = await closeUnmet(dealer);
    if (unmet.length > 0) {
      res.status(422).json({ error: "close_blocked", unmet });
      return;
    }
    const updated = await casDealerStatus(dealer.id, dealer.status, {
      status: "closed",
    });
    if (!updated) {
      staleTransition(res, "closed");
      return;
    }
    await platformAudit(res, {
      action: "suspend",
      entityType: "dealer",
      entityId: dealer.id,
      summary: `${res.locals.user?.name ?? "Super admin"} closed dealership "${dealer.name}" — tenant is now fully dark (423 on all requests)`,
      details: { dealerId: dealer.id },
    });
    const full = await dealerWithCount(updated.id);
    res.json(CloseDealerResponse.parse(full));
  },
);

// ---------------------------------------------------------------------------
// P4 agent policy library + global kill switch (__all__ master key).
// Missing rows fail OPEN; a disabled row wins over everything.
// ---------------------------------------------------------------------------

const VALID_POLICY_KEYS = new Set<string>([
  AGENT_POLICY_MASTER_KEY,
  ...DEFAULT_AGENTS.map((a) => a.key),
]);

router.get("/platform/agent-policies", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(agentPoliciesTable)
    .orderBy(asc(agentPoliciesTable.agentKey));
  res.json(ListAgentPoliciesResponse.parse(rows));
});

router.patch(
  "/platform/agent-policies",
  async (req, res): Promise<void> => {
    const body = UpdateAgentPolicyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const agentKey = body.data.agentKey;
    if (!VALID_POLICY_KEYS.has(agentKey)) {
      res.status(422).json({ error: "unknown_agent_key", agentKey });
      return;
    }
    const [row] = await db
      .insert(agentPoliciesTable)
      .values({
        agentKey,
        enabled: body.data.enabled,
        note: body.data.note ?? null,
        updatedBy: res.locals.user?.email ?? null,
      })
      .onConflictDoUpdate({
        target: agentPoliciesTable.agentKey,
        set: {
          enabled: body.data.enabled,
          note: body.data.note ?? null,
          updatedBy: res.locals.user?.email ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    await platformAudit(res, {
      action: "update",
      entityType: "agent",
      entityId: null,
      summary: `${res.locals.user?.name ?? "Super admin"} ${body.data.enabled ? "enabled" : "DISABLED"} agent policy "${agentKey}"${agentKey === AGENT_POLICY_MASTER_KEY ? " (GLOBAL kill switch)" : ""}`,
      details: { agentKey, enabled: body.data.enabled, note: body.data.note },
    });
    res.json(UpdateAgentPolicyResponse.parse(row));
  },
);

router.get(
  "/platform/dealers/:id/agents",
  async (req, res): Promise<void> => {
    const params = ListDealerAgentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealer = await dealerWithCount(params.data.id);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    const rows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.dealerId, params.data.id))
      .orderBy(asc(agentsTable.id));
    res.json(ListDealerAgentsResponse.parse(rows));
  },
);

// ---------------------------------------------------------------------------
// Per-dealer agent oversight: roster + governance metrics + success criteria.
// Criteria are evaluated server-side so realm and any future consumer agree
// on what "healthy" means for each agent.
// ---------------------------------------------------------------------------

/** Agents that write records directly (no human in the loop). */
const AUTONOMOUS_AGENT_KEYS = new Set([
  "intake_dedup",
  "call_sentiment",
  "case_classifier",
]);

type AgentMetricRow = {
  agentKey: string;
  runs: number;
  accepted: number;
  overridden: number;
  errors: number;
  blocked: number;
  acceptanceRate: number;
  avgConfidence: number | null;
  avgLatencyMs: number | null;
  lastRunAt: string | null;
};

async function dealerAgentMetrics(dealerId: number): Promise<Map<string, AgentMetricRow>> {
  const rows = await db
    .select({
      agentKey: agentRunsTable.agentKey,
      runs: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'accepted')::int`,
      overridden: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'overridden')::int`,
      errors: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'error')::int`,
      blocked: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'blocked')::int`,
      avgConfidence: sql<number | null>`avg(${agentRunsTable.confidence})`,
      avgLatencyMs: sql<number | null>`avg(${agentRunsTable.latencyMs})::int`,
      lastRunAt: sql<string | null>`max(${agentRunsTable.createdAt})`,
    })
    .from(agentRunsTable)
    .where(eq(agentRunsTable.dealerId, dealerId))
    .groupBy(agentRunsTable.agentKey);
  return new Map(
    rows.map((r) => {
      const reviewed = r.accepted + r.overridden;
      return [
        r.agentKey,
        {
          ...r,
          acceptanceRate: reviewed > 0 ? (r.accepted / reviewed) * 100 : 0,
          avgConfidence: r.avgConfidence == null ? null : Number(r.avgConfidence),
          lastRunAt: r.lastRunAt == null ? null : new Date(r.lastRunAt).toISOString(),
        },
      ];
    }),
  );
}

const pct = (n: number) => `${n.toFixed(1)}%`;

/** Evaluate the success criteria for one agent from its aggregate metrics. */
function evaluateAgentCriteria(agentKey: string, m: AgentMetricRow | null) {
  const criteria: {
    key: string;
    label: string;
    target: string;
    actual: string | null;
    met: boolean | null;
  }[] = [];
  const runs = m?.runs ?? 0;
  const hasData = runs > 0;

  criteria.push({
    key: "activity",
    label: "Handling work (has recorded runs)",
    target: "≥ 1 run",
    actual: hasData ? `${runs} runs` : null,
    met: hasData ? true : null,
  });

  const errorRate = hasData ? (m!.errors / runs) * 100 : null;
  criteria.push({
    key: "error_rate",
    label: "Error rate stays low",
    target: "≤ 5%",
    actual: errorRate == null ? null : pct(errorRate),
    met: errorRate == null ? null : errorRate <= 5,
  });

  const blockedRate = hasData ? (m!.blocked / runs) * 100 : null;
  criteria.push({
    key: "blocked_rate",
    label: "Rarely blocked by governance guardrails",
    target: "≤ 10%",
    actual: blockedRate == null ? null : pct(blockedRate),
    met: blockedRate == null ? null : blockedRate <= 10,
  });

  if (AUTONOMOUS_AGENT_KEYS.has(agentKey)) {
    // Autonomous writers: overrides mean humans had to undo its work.
    const overrideRate = hasData ? (m!.overridden / runs) * 100 : null;
    criteria.push({
      key: "override_rate",
      label: "Autonomous writes rarely overridden",
      target: "≤ 10%",
      actual: overrideRate == null ? null : pct(overrideRate),
      met: overrideRate == null ? null : overrideRate <= 10,
    });
  } else {
    // HITL/advisory agents: judged on human acceptance of their drafts.
    const reviewed = (m?.accepted ?? 0) + (m?.overridden ?? 0);
    criteria.push({
      key: "acceptance_rate",
      label: "Suggestions accepted by staff",
      target: "≥ 70%",
      actual: reviewed > 0 ? pct(m!.acceptanceRate) : null,
      met: reviewed > 0 ? m!.acceptanceRate >= 70 : null,
    });
  }

  criteria.push({
    key: "confidence",
    label: "Average model confidence",
    target: "≥ 0.6",
    actual: m?.avgConfidence == null ? null : m.avgConfidence.toFixed(2),
    met: m?.avgConfidence == null ? null : m.avgConfidence >= 0.6,
  });

  criteria.push({
    key: "latency",
    label: "Responds fast enough",
    target: "≤ 8s avg",
    actual: m?.avgLatencyMs == null ? null : `${(m.avgLatencyMs / 1000).toFixed(1)}s`,
    met: m?.avgLatencyMs == null ? null : m.avgLatencyMs <= 8000,
  });

  const health = !hasData
    ? ("no_data" as const)
    : criteria.some((c) => c.met === false)
      ? ("at_risk" as const)
      : ("meeting" as const);
  return { criteria, health };
}

router.get(
  "/platform/dealers/:id/agents/overview",
  async (req, res): Promise<void> => {
    const params = GetDealerAgentsOverviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [dealer] = await db
      .select({ id: dealersTable.id })
      .from(dealersTable)
      .where(eq(dealersTable.id, params.data.id));
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    const [agents, metricsByKey] = await Promise.all([
      db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.dealerId, params.data.id))
        .orderBy(asc(agentsTable.id)),
      dealerAgentMetrics(params.data.id),
    ]);
    const overview = agents.map((agent) => {
      const m = metricsByKey.get(agent.key) ?? null;
      const { criteria, health } = evaluateAgentCriteria(agent.key, m);
      return { agent, metrics: m, criteria, health };
    });
    res.json(GetDealerAgentsOverviewResponse.parse(overview));
  },
);

router.get(
  "/platform/dealers/:id/agent-runs",
  async (req, res): Promise<void> => {
    const params = ListDealerAgentRunsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [dealer] = await db
      .select({ id: dealersTable.id })
      .from(dealersTable)
      .where(eq(dealersTable.id, params.data.id));
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    const rows = await db
      .select()
      .from(agentRunsTable)
      .where(eq(agentRunsTable.dealerId, params.data.id))
      .orderBy(desc(agentRunsTable.createdAt))
      .limit(100);
    res.json(ListDealerAgentRunsResponse.parse(rows));
  },
);

router.patch(
  "/platform/dealers/:id/agents/:agentId",
  async (req, res): Promise<void> => {
    const params = UpdateDealerAgentParams.safeParse(req.params);
    const body = UpdateDealerAgentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [agent] = await db
      .update(agentsTable)
      .set(body.data)
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.dealerId, params.data.id),
        ),
      )
      .returning();
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await platformAudit(res, {
      action: "update",
      entityType: "agent",
      entityId: agent.id,
      summary: `${res.locals.user?.name ?? "Super admin"} set agent "${agent.name}" to ${agent.status} for dealer #${params.data.id}`,
      details: { dealerId: params.data.id, agentKey: agent.key, status: agent.status },
    });
    res.json(UpdateDealerAgentResponse.parse(agent));
  },
);

router.get("/platform/audit", async (req, res): Promise<void> => {
  const query = ListPlatformAuditQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = Math.min(Math.max(query.data.limit ?? 100, 1), 500);
  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(
      query.data.dealerId !== undefined
        ? eq(auditLogsTable.dealerId, query.data.dealerId)
        : isNull(auditLogsTable.dealerId),
    )
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);
  res.json(ListPlatformAuditResponse.parse(rows));
});

router.post("/platform/impersonation", async (req, res): Promise<void> => {
  const body = StartImpersonationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const user = res.locals.user!;
  const [dealer] = await db
    .select({ id: dealersTable.id, name: dealersTable.name })
    .from(dealersTable)
    .where(eq(dealersTable.id, body.data.dealerId));
  if (!dealer) {
    res.status(404).json({ error: "Dealer not found" });
    return;
  }
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const [grant] = await db
    .insert(impersonationGrantsTable)
    .values({
      userId: user.id,
      dealerId: dealer.id,
      reason: body.data.reason,
      mode: body.data.mode ?? "read_only",
      expiresAt,
    })
    .returning();
  invalidateGrantCache();
  await platformAudit(res, {
    action: "impersonate",
    entityType: "dealer",
    entityId: dealer.id,
    summary: `${user.name ?? user.email ?? "Super admin"} started a ${grant!.mode === "elevated" ? "write-elevated" : "read-only"} impersonation window for dealership "${dealer.name}" (expires ${expiresAt.toISOString()})`,
    details: {
      dealerId: dealer.id,
      grantId: grant!.id,
      reason: body.data.reason,
      mode: grant!.mode,
      expiresAt: expiresAt.toISOString(),
    },
  });
  res.status(201).json(
    StartImpersonationResponse.parse({
      id: grant!.id,
      dealerId: grant!.dealerId,
      mode: grant!.mode,
      expiresAt: grant!.expiresAt,
    }),
  );
});

async function memberRows(dealerId: number) {
  return db
    .select({
      id: dealerUsersTable.id,
      userId: dealerUsersTable.userId,
      dealerId: dealerUsersTable.dealerId,
      roleId: dealerUsersTable.roleId,
      roleName: rolesTable.name,
      isGeneralManager: dealerUsersTable.isGeneralManager,
      email: usersTable.email,
      name: usersTable.name,
      imageUrl: usersTable.imageUrl,
      userStatus: usersTable.status,
    })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .leftJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(eq(dealerUsersTable.dealerId, dealerId))
    .orderBy(asc(dealerUsersTable.id));
}

router.get(
  "/platform/dealers/:id/members",
  async (req, res): Promise<void> => {
    const params = ListDealerMembersParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealer = await dealerWithCount(params.data.id);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    res.json(ListDealerMembersResponse.parse(await memberRows(params.data.id)));
  },
);

router.post(
  "/platform/dealers/:id/members",
  async (req, res): Promise<void> => {
    const params = AddDealerMemberParams.safeParse(req.params);
    const body = AddDealerMemberBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await dealerWithCount(params.data.id);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    const [role] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(eq(rolesTable.id, body.data.roleId));
    if (!role) {
      res.status(422).json({ error: "Unknown role" });
      return;
    }
    let userId = body.data.userId ?? null;
    if (userId == null && body.data.email) {
      const [byEmail] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          sql`lower(${usersTable.email}) = ${body.data.email.toLowerCase()}`,
        );
      userId = byEmail?.id ?? null;
    }
    if (userId == null) {
      res.status(404).json({
        error:
          "No user found. Ask them to sign up first, then add them by email.",
      });
      return;
    }
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const isGM = body.data.isGeneralManager ?? false;
    if (isGM) {
      await db
        .update(dealerUsersTable)
        .set({ isGeneralManager: false })
        .where(eq(dealerUsersTable.dealerId, params.data.id));
    }
    await db
      .insert(dealerUsersTable)
      .values({
        dealerId: params.data.id,
        userId,
        roleId: body.data.roleId,
        isGeneralManager: isGM,
      })
      .onConflictDoUpdate({
        target: [dealerUsersTable.dealerId, dealerUsersTable.userId],
        set: { roleId: body.data.roleId, isGeneralManager: isGM },
      });
    const rows = await memberRows(params.data.id);
    const member = rows.find((m) => m.userId === userId);
    res.status(201).json(AddDealerMemberResponse.parse(member));
  },
);

router.patch(
  "/platform/dealers/:id/members/:userId",
  async (req, res): Promise<void> => {
    const params = UpdateDealerMemberParams.safeParse(req.params);
    const body = UpdateDealerMemberBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const isGM = body.data.isGeneralManager ?? false;
    if (isGM) {
      await db
        .update(dealerUsersTable)
        .set({ isGeneralManager: false })
        .where(eq(dealerUsersTable.dealerId, params.data.id));
    }
    const [updated] = await db
      .update(dealerUsersTable)
      .set({ roleId: body.data.roleId, isGeneralManager: isGM })
      .where(
        and(
          eq(dealerUsersTable.dealerId, params.data.id),
          eq(dealerUsersTable.userId, params.data.userId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const rows = await memberRows(params.data.id);
    const member = rows.find((m) => m.userId === params.data.userId);
    res.json(UpdateDealerMemberResponse.parse(member));
  },
);

router.delete(
  "/platform/dealers/:id/members/:userId",
  async (req, res): Promise<void> => {
    const params = RemoveDealerMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const deleted = await db
      .delete(dealerUsersTable)
      .where(
        and(
          eq(dealerUsersTable.dealerId, params.data.id),
          eq(dealerUsersTable.userId, params.data.userId),
        ),
      )
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    res.status(204).end();
  },
);

router.get("/platform/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      clerkId: usersTable.clerkId,
      email: usersTable.email,
      name: usersTable.name,
      imageUrl: usersTable.imageUrl,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      dealerCount: sql<number>`(select count(*)::int from ${dealerUsersTable} where ${dealerUsersTable.userId} = ${usersTable.id})`,
    })
    .from(usersTable)
    .orderBy(asc(usersTable.createdAt));
  res.json(ListPlatformUsersResponse.parse(rows));
});

export default router;
