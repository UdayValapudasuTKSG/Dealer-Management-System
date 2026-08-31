/**
 * Collision insurance claims (Task 279).
 *
 * A claim rides on top of a normal repair order: the workshop keeps its
 * existing job-card / parts / invoice lifecycle, while the claim tracks the
 * insurer workflow (intake → … → closed, with denied / total-loss exits),
 * damage evidence, supplements, backorder cycle-time pauses and the split
 * insurer / customer-deductible receivable.
 *
 * Guard rails:
 * - Every read/write is dealer-scoped; cross-dealer rows are 404s.
 * - Transitions are adjacent-only; decision targets (approved, denied,
 *   total_loss, insurer_signoff) need a Service Manager / Management user.
 * - Supplements carry their own pending/approved/denied lifecycle and never
 *   move the parent claim.
 * - Settlements are capped per payer against the invoiced split inside a
 *   FOR UPDATE transaction so concurrent posts cannot overshoot.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import {
  db,
  collisionClaimsTable,
  collisionSupplementsTable,
  collisionSettlementsTable,
  serviceOrdersTable,
  serviceInvoicesTable,
  COLLISION_ADVANCE_MAP,
  COLLISION_APPROVER_TARGETS,
  type CollisionClaim,
  type CollisionClaimEvent,
} from "@workspace/db";
import {
  ListCollisionClaimsQueryParams,
  ListCollisionClaimsResponse,
  CreateCollisionClaimBody,
  CreateCollisionClaimResponse,
  GetCollisionClaimParams,
  GetCollisionClaimResponse,
  UpdateCollisionClaimParams,
  UpdateCollisionClaimBody,
  UpdateCollisionClaimResponse,
  AdvanceCollisionClaimParams,
  AdvanceCollisionClaimBody,
  AdvanceCollisionClaimResponse,
  ResumeCollisionClaimParams,
  ResumeCollisionClaimResponse,
  CreateCollisionSupplementParams,
  CreateCollisionSupplementBody,
  CreateCollisionSupplementResponse,
  DecideCollisionSupplementParams,
  DecideCollisionSupplementBody,
  DecideCollisionSupplementResponse,
  CreateCollisionSettlementParams,
  CreateCollisionSettlementBody,
  CreateCollisionSettlementResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import { isTechnicianRole } from "./service";
import { coordinateCollisionClaim } from "../lib/collision-coordinator";

const router: IRouter = Router();

const TERMINAL = new Set(["closed", "denied", "total_loss"]);

/**
 * Generated Zod coerces `format: date` fields to Date objects, but the
 * loss_date column is a date-STRING (`date({ mode: "string" })`). Convert at
 * the boundary — inserting a Date shifts a day in UTC-4 and fails typecheck.
 */
function toDateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function isServiceApprover(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
    user.roleName ?? "",
  );
}

function actor(res: { locals: { user?: { id?: number; name?: string | null; email?: string | null } | null } }): {
  byUserId: number | null;
  byName: string;
} {
  const u = res.locals.user;
  return {
    byUserId: u?.id ?? null,
    byName: u?.name ?? u?.email ?? "Unknown",
  };
}

function event(
  res: Parameters<typeof actor>[0],
  kind: CollisionClaimEvent["kind"],
  extra: Partial<CollisionClaimEvent> = {},
): CollisionClaimEvent {
  return {
    kind,
    at: new Date().toISOString(),
    ...actor(res),
    ...extra,
  };
}

/** Dealer-scoped claim fetch; technicians only reach claims on their orders. */
async function findClaim(
  res: { locals: Record<string, unknown> },
  id: number,
): Promise<CollisionClaim | null> {
  const dealerId = activeDealerId(res as never);
  const [claim] = await db
    .select()
    .from(collisionClaimsTable)
    .where(
      and(
        eq(collisionClaimsTable.id, id),
        eq(collisionClaimsTable.dealerId, dealerId),
      ),
    );
  if (!claim) return null;
  const viewer = (res.locals as { user?: { id: number; roleName?: string | null; isSuperAdmin?: boolean } }).user;
  if (isTechnicianRole(viewer)) {
    const [order] = await db
      .select({ technicianUserId: serviceOrdersTable.technicianUserId })
      .from(serviceOrdersTable)
      .where(
        and(
          eq(serviceOrdersTable.id, claim.serviceOrderId),
          eq(serviceOrdersTable.dealerId, dealerId),
        ),
      );
    if (!order || order.technicianUserId !== viewer!.id) return null;
  }
  return claim;
}

/** Elapsed cycle time excluding backorder pauses (open segment included). */
export function claimCycleSeconds(claim: {
  createdAt: Date;
  closedAt: Date | null;
  pausedSeconds: number;
  pausedAt: Date | null;
}): number {
  const end = claim.closedAt ?? new Date();
  let paused = claim.pausedSeconds;
  if (claim.pausedAt) {
    paused += Math.max(
      0,
      Math.floor((end.getTime() - claim.pausedAt.getTime()) / 1000),
    );
  }
  return Math.max(
    0,
    Math.floor((end.getTime() - claim.createdAt.getTime()) / 1000) - paused,
  );
}

function isUniqueViolation(err: unknown, index: string): boolean {
  // Drizzle wraps the pg error in DrizzleQueryError — check `cause` too.
  const raw = err as
    | { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }
    | null;
  const e = raw?.code ? raw : raw?.cause;
  return e?.code === "23505" && e?.constraint === index;
}

// ---------------------------------------------------------------------------
// List + create
// ---------------------------------------------------------------------------

router.get("/collision-claims", async (req, res): Promise<void> => {
  const query = ListCollisionClaimsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const viewer = res.locals.user;
  const q = query.data;
  const rows = await db
    .select({ claim: collisionClaimsTable })
    .from(collisionClaimsTable)
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(serviceOrdersTable.id, collisionClaimsTable.serviceOrderId),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    )
    .where(
      and(
        eq(collisionClaimsTable.dealerId, dealerId),
        q.status ? eq(collisionClaimsTable.status, q.status) : undefined,
        q.insurer
          ? ilike(collisionClaimsTable.insurerName, `%${q.insurer}%`)
          : undefined,
        q.lossFrom
          ? gte(collisionClaimsTable.lossDate, toDateOnly(q.lossFrom))
          : undefined,
        q.lossTo
          ? lte(collisionClaimsTable.lossDate, toDateOnly(q.lossTo))
          : undefined,
        q.serviceOrderId
          ? eq(collisionClaimsTable.serviceOrderId, q.serviceOrderId)
          : undefined,
        isTechnicianRole(viewer)
          ? eq(serviceOrdersTable.technicianUserId, viewer!.id)
          : undefined,
      ),
    )
    .orderBy(desc(collisionClaimsTable.createdAt));
  res.json(ListCollisionClaimsResponse.parse(rows.map((r) => r.claim)));
});

router.post("/collision-claims", async (req, res): Promise<void> => {
  const parsed = CreateCollisionClaimBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const input = parsed.data;

  // The claim must attach to a valid SAME-DEALER repair order; cross-dealer
  // order ids look identical to missing ones (404, no existence leak).
  const [order] = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.id, input.serviceOrderId),
        eq(serviceOrdersTable.dealerId, dealerId),
      ),
    );
  if (!order) {
    res.status(404).json({ error: "Repair order not found" });
    return;
  }
  try {
    const outcome = await db.transaction(async (tx) => {
      // Claim intake and invoice issuance serialize on the stable repair-order
      // row. Neither path can observe "no opposing record" and then both
      // commit independently.
      const [lockedOrder] = await tx
        .select()
        .from(serviceOrdersTable)
        .where(
          and(
            eq(serviceOrdersTable.id, order.id),
            eq(serviceOrdersTable.dealerId, dealerId),
          ),
        )
        .for("update");
      if (!lockedOrder) return { kind: "missing" as const };
      if (["closed", "cancelled"].includes(lockedOrder.status)) {
        return { kind: "closed" as const };
      }
      const [existingLiveInvoice] = await tx
        .select({ id: serviceInvoicesTable.id })
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.serviceOrderId, lockedOrder.id),
            eq(serviceInvoicesTable.dealerId, dealerId),
            sql`${serviceInvoicesTable.status} <> 'void'`,
          ),
        )
        .limit(1);
      if (existingLiveInvoice) return { kind: "invoiced" as const };
      const [claim] = await tx
        .insert(collisionClaimsTable)
        .values({
        dealerId,
        serviceOrderId: lockedOrder.id,
        customerId: lockedOrder.customerId ?? null,
        customerName: lockedOrder.customerName ?? null,
        vehicleInfo: lockedOrder.vehicleInfo,
        vehicleId: lockedOrder.vehicleId ?? null,
        lossDate: toDateOnly(input.lossDate),
        insurerName: input.insurerName.trim(),
        policyNumber: input.policyNumber ?? null,
        claimNumber: input.claimNumber?.trim() || null,
        adjusterName: input.adjusterName ?? null,
        adjusterContact: input.adjusterContact ?? null,
        severity: input.severity ?? "moderate",
        damageNotes: input.damageNotes ?? null,
        damagePoints: input.damagePoints ?? [],
        initialEstimate: input.initialEstimate ?? 0,
        deductible: input.deductible ?? 0,
        createdBy: actor(res).byName,
        history: [event(res, "created", { to: "intake" })],
        })
        .returning();
      return { kind: "ok" as const, claim };
    });
    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Repair order not found" });
      return;
    }
    if (outcome.kind === "closed") {
      res.status(422).json({
        error: "Cannot attach a claim to a closed or cancelled repair order",
      });
      return;
    }
    if (outcome.kind === "invoiced") {
      res.status(422).json({
        error:
          "Cannot attach a collision claim after invoicing; create the claim before insurer sign-off and invoice issuance",
      });
      return;
    }
    const claim = outcome.claim;
    coordinateCollisionClaim({
      id: claim.id,
      dealerId: claim.dealerId,
      vehicleInfo: claim.vehicleInfo,
      status: claim.status,
      event: "created",
      eventKey: "created",
    });
    res.status(201).json(CreateCollisionClaimResponse.parse(claim));
  } catch (err) {
    if (isUniqueViolation(err, "collision_claims_service_order_unique")) {
      res
        .status(409)
        .json({ error: "This repair order already has a collision claim" });
      return;
    }
    if (
      isUniqueViolation(err, "collision_claims_insurer_claim_number_unique")
    ) {
      res.status(409).json({
        error: "A claim with this insurer claim number already exists",
      });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Detail + update
// ---------------------------------------------------------------------------

router.get("/collision-claims/:id", async (req, res): Promise<void> => {
  const params = GetCollisionClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const claim = await findClaim(res, params.data.id);
  if (!claim) {
    res.status(404).json({ error: "Claim not found" });
    return;
  }
  const dealerId = activeDealerId(res);
  const supplements = await db
    .select()
    .from(collisionSupplementsTable)
    .where(
      and(
        eq(collisionSupplementsTable.claimId, claim.id),
        eq(collisionSupplementsTable.dealerId, dealerId),
      ),
    )
    .orderBy(desc(collisionSupplementsTable.createdAt));
  const settlements = await db
    .select()
    .from(collisionSettlementsTable)
    .where(
      and(
        eq(collisionSettlementsTable.claimId, claim.id),
        eq(collisionSettlementsTable.dealerId, dealerId),
      ),
    )
    .orderBy(desc(collisionSettlementsTable.createdAt));

  const approvedSupplements = supplements
    .filter((s) => s.status === "approved")
    .reduce((sum, s) => sum + s.amount, 0);
  res.json(
    GetCollisionClaimResponse.parse({
      claim,
      supplements,
      settlements,
      approvedTotal:
        claim.approvedEstimate == null
          ? null
          : claim.approvedEstimate + approvedSupplements,
      insurerPaid: settlements
        .filter((s) => s.payer === "insurer")
        .reduce((sum, s) => sum + s.amount, 0),
      deductiblePaid: settlements
        .filter((s) => s.payer === "customer")
        .reduce((sum, s) => sum + s.amount, 0),
      cycleSeconds: claimCycleSeconds(claim),
    }),
  );
});

router.patch("/collision-claims/:id", async (req, res): Promise<void> => {
  const params = UpdateCollisionClaimParams.safeParse(req.params);
  const parsed = UpdateCollisionClaimBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const claim = await findClaim(res, params.data.id);
  if (!claim) {
    res.status(404).json({ error: "Claim not found" });
    return;
  }
  const input = parsed.data;
  try {
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.id, claim.id),
            eq(collisionClaimsTable.dealerId, claim.dealerId),
          ),
        )
        .for("update");
      if (!locked) return { kind: "missing" as const };
      if (TERMINAL.has(locked.status)) {
        return { kind: "terminal" as const, status: locked.status };
      }
      const financialKeys = [
        "initialEstimate",
        "contestedEstimate",
        "approvedEstimate",
        "deductible",
      ] as const;
      if (
        locked.serviceInvoiceId != null &&
        financialKeys.some((key) => input[key] !== undefined)
      ) {
        return { kind: "financial_locked" as const };
      }
      const events: CollisionClaimEvent[] = [];
      for (const key of financialKeys) {
        if (input[key] !== undefined && input[key] !== locked[key]) {
          events.push(
            event(res, "estimate", {
              note: key.replace(/([A-Z])/g, " $1").toLowerCase(),
              amount: input[key] ?? null,
            }),
          );
        }
      }
      const [updated] = await tx
        .update(collisionClaimsTable)
        .set({
        ...(input.lossDate !== undefined && {
          lossDate: toDateOnly(input.lossDate),
        }),
        ...(input.insurerName !== undefined && {
          insurerName: input.insurerName.trim(),
        }),
        ...(input.policyNumber !== undefined && {
          policyNumber: input.policyNumber,
        }),
        ...(input.claimNumber !== undefined && {
          claimNumber: input.claimNumber?.trim() || null,
        }),
        ...(input.adjusterName !== undefined && {
          adjusterName: input.adjusterName,
        }),
        ...(input.adjusterContact !== undefined && {
          adjusterContact: input.adjusterContact,
        }),
        ...(input.severity !== undefined && { severity: input.severity }),
        ...(input.damageNotes !== undefined && {
          damageNotes: input.damageNotes,
        }),
        ...(input.damagePoints !== undefined && {
          damagePoints: input.damagePoints,
        }),
        ...(input.initialEstimate !== undefined && {
          initialEstimate: input.initialEstimate,
        }),
        ...(input.contestedEstimate !== undefined && {
          contestedEstimate: input.contestedEstimate,
        }),
        ...(input.approvedEstimate !== undefined && {
          approvedEstimate: input.approvedEstimate,
        }),
        ...(input.deductible !== undefined && { deductible: input.deductible }),
        ...(input.totalLossValue !== undefined && {
          totalLossValue: input.totalLossValue,
        }),
        ...(events.length > 0 && {
          history: [...locked.history, ...events],
        }),
        })
        .where(
          and(
            eq(collisionClaimsTable.id, locked.id),
            eq(collisionClaimsTable.dealerId, locked.dealerId),
          ),
        )
        .returning();
      return { kind: "ok" as const, updated };
    });
    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    if (outcome.kind === "terminal") {
      res.status(422).json({
        error: `Cannot edit a ${outcome.status.replace("_", " ")} claim`,
      });
      return;
    }
    if (outcome.kind === "financial_locked") {
      res.status(422).json({
        error:
          "Claim financials are locked after invoicing so the insurer/deductible split cannot diverge",
      });
      return;
    }
    res.json(UpdateCollisionClaimResponse.parse(outcome.updated));
  } catch (err) {
    if (
      isUniqueViolation(err, "collision_claims_insurer_claim_number_unique")
    ) {
      res.status(409).json({
        error: "A claim with this insurer claim number already exists",
      });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

router.post("/collision-claims/:id/advance", async (req, res): Promise<void> => {
  const params = AdvanceCollisionClaimParams.safeParse(req.params);
  const parsed = AdvanceCollisionClaimBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: (params.success ? parsed : params).error?.message ?? "Invalid",
    });
    return;
  }
  const claim = await findClaim(res, params.data.id);
  if (!claim) {
    res.status(404).json({ error: "Claim not found" });
    return;
  }
  const target = parsed.data.targetStatus;
  if (
    COLLISION_APPROVER_TARGETS.has(target) &&
    !isServiceApprover(res.locals.user)
  ) {
    res.status(403).json({
      error:
        "Only a Service Manager / Management user can record this decision",
    });
    return;
  }
  if (target === "invoiced") {
    res.status(422).json({
      error:
        "Generate the collision invoice from the completed job card after insurer sign-off; invoice issuance performs the atomic transition",
    });
    return;
  }

  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.id, claim.id),
          eq(collisionClaimsTable.dealerId, claim.dealerId),
        ),
      )
      .for("update");
    if (!locked) return { kind: "conflict" as const };
    if (!(COLLISION_ADVANCE_MAP[locked.status] ?? []).includes(target)) {
      return {
        kind: "unmet" as const,
        unmet: [
          `Cannot move a ${locked.status.replace(/_/g, " ")} claim to ${target.replace(/_/g, " ")} — transitions are one step at a time`,
        ],
      };
    }
    const unmet: string[] = [];
    const totalLossValue =
      parsed.data.totalLossValue ?? locked.totalLossValue ?? null;
    if (target === "approved" && locked.approvedEstimate == null) {
      unmet.push("Record the insurer-approved estimate value first");
    }
    if (target === "total_loss" && totalLossValue == null) {
      unmet.push("Record the vehicle value evidence (total-loss value) first");
    }
    if (target === "closed") {
      if (locked.serviceInvoiceId == null) {
        unmet.push("Claim has not been invoiced yet");
      } else {
        const [sums] = await tx
          .select({
            insurerPaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'insurer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
            deductiblePaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'customer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
          })
          .from(collisionSettlementsTable)
          .where(
            and(
              eq(collisionSettlementsTable.claimId, locked.id),
              eq(collisionSettlementsTable.dealerId, locked.dealerId),
            ),
          );
        const insurerOpen = (locked.insurerDue ?? 0) - (sums?.insurerPaid ?? 0);
        const deductibleOpen =
          (locked.deductibleDue ?? 0) - (sums?.deductiblePaid ?? 0);
        if (insurerOpen > 0.005)
          unmet.push(`Insurer balance of ${insurerOpen.toFixed(2)} still open`);
        if (deductibleOpen > 0.005)
          unmet.push(
            `Customer deductible of ${deductibleOpen.toFixed(2)} still outstanding`,
          );
      }
      const pendingSupplements = await tx
        .select({ id: collisionSupplementsTable.id })
        .from(collisionSupplementsTable)
        .where(
          and(
            eq(collisionSupplementsTable.claimId, locked.id),
            eq(collisionSupplementsTable.dealerId, locked.dealerId),
            eq(collisionSupplementsTable.status, "pending"),
          ),
        );
      if (pendingSupplements.length > 0)
        unmet.push(`${pendingSupplements.length} supplement(s) still pending a decision`);
    }
    if (unmet.length > 0) return { kind: "unmet" as const, unmet };
    const terminal = TERMINAL.has(target);
    const events: CollisionClaimEvent[] = [
      event(res, "status", {
        from: locked.status,
        to: target,
        note: parsed.data.note ?? null,
      }),
    ];
    let pausedSeconds = locked.pausedSeconds;
    let pausedAt = locked.pausedAt;
    if (terminal && pausedAt) {
      pausedSeconds += Math.max(
        0,
        Math.floor((now.getTime() - pausedAt.getTime()) / 1000),
      );
      pausedAt = null;
      events.push(event(res, "resume", { note: "Auto-resumed at close" }));
    }
    const [updated] = await tx
      .update(collisionClaimsTable)
      .set({
        status: target,
        pausedSeconds,
        pausedAt,
        ...(target === "total_loss" && { totalLossValue }),
        ...(terminal && {
          closedAt: now,
          outcomeReason: parsed.data.note ?? locked.outcomeReason ?? null,
        }),
        history: [...locked.history, ...events],
      })
      .where(
        and(
          eq(collisionClaimsTable.id, locked.id),
          eq(collisionClaimsTable.dealerId, locked.dealerId),
        ),
      )
      .returning();
    if (!updated) return { kind: "conflict" as const };
    return { kind: "ok" as const, updated };
  });
  if (outcome.kind === "unmet") {
    res.status(422).json({ unmet: outcome.unmet });
    return;
  }
  if (outcome.kind === "conflict") {
    res
      .status(409)
      .json({ error: "Claim changed concurrently — reload and retry" });
    return;
  }
  coordinateCollisionClaim({
    id: outcome.updated.id,
    dealerId: outcome.updated.dealerId,
    vehicleInfo: outcome.updated.vehicleInfo,
    status: outcome.updated.status,
    event: "status",
    eventKey: `status:${outcome.updated.history.at(-1)?.from ?? claim.status}:${target}`,
    detail: parsed.data.note,
  });
  res.json(AdvanceCollisionClaimResponse.parse(outcome.updated));
});

router.post("/collision-claims/:id/resume", async (req, res): Promise<void> => {
  const params = ResumeCollisionClaimParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const claim = await findClaim(res, params.data.id);
  if (!claim) {
    res.status(404).json({ error: "Claim not found" });
    return;
  }
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(collisionClaimsTable)
      .where(
        and(
          eq(collisionClaimsTable.id, claim.id),
          eq(collisionClaimsTable.dealerId, claim.dealerId),
        ),
      )
      .for("update");
    if (!locked) return { kind: "conflict" as const };
    if (!locked.pausedAt) return { kind: "not_paused" as const };
    const [updated] = await tx
      .update(collisionClaimsTable)
      .set({
      pausedSeconds:
        locked.pausedSeconds +
        Math.max(0, Math.floor((now.getTime() - locked.pausedAt.getTime()) / 1000)),
      pausedAt: null,
      history: [
        ...locked.history,
        event(res, "resume", { note: "Backordered parts received — work resumed" }),
      ],
      })
      .where(eq(collisionClaimsTable.id, locked.id))
      .returning();
    return updated
      ? { kind: "ok" as const, updated }
      : { kind: "conflict" as const };
  });
  if (outcome.kind === "not_paused") {
    res.status(422).json({ error: "Claim is not paused" });
    return;
  }
  if (outcome.kind === "conflict") {
    res
      .status(409)
      .json({ error: "Claim changed concurrently — reload and retry" });
    return;
  }
  const updated = outcome.updated;
  coordinateCollisionClaim({
    id: updated.id,
    dealerId: updated.dealerId,
    vehicleInfo: updated.vehicleInfo,
    status: updated.status,
    event: "resumed",
    eventKey: `resume:${updated.pausedSeconds}`,
  });
  res.json(ResumeCollisionClaimResponse.parse(updated));
});

// ---------------------------------------------------------------------------
// Supplements (independent decision lifecycle)
// ---------------------------------------------------------------------------

router.post(
  "/collision-claims/:id/supplements",
  async (req, res): Promise<void> => {
    const params = CreateCollisionSupplementParams.safeParse(req.params);
    const parsed = CreateCollisionSupplementBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const claim = await findClaim(res, params.data.id);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.id, claim.id),
            eq(collisionClaimsTable.dealerId, claim.dealerId),
          ),
        )
        .for("update");
      if (!locked) return { kind: "missing" as const };
      if (TERMINAL.has(locked.status)) return { kind: "terminal" as const };
      if (locked.serviceInvoiceId != null) {
        return { kind: "financial_locked" as const };
      }
      const [supplement] = await tx
        .insert(collisionSupplementsTable)
        .values({
          dealerId: locked.dealerId,
          claimId: locked.id,
          description: parsed.data.description,
          amount: parsed.data.amount,
          requestedBy: actor(res).byName,
        })
        .returning();
      await tx
        .update(collisionClaimsTable)
        .set({
          history: [
            ...locked.history,
            event(res, "supplement", {
              to: "pending",
              note: parsed.data.description,
              amount: parsed.data.amount,
            }),
          ],
        })
        .where(eq(collisionClaimsTable.id, locked.id));
      return { kind: "ok" as const, supplement };
    });
    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    if (outcome.kind === "terminal") {
      res.status(422).json({
        error: "Cannot add supplements to a closed, denied or total-loss claim",
      });
      return;
    }
    if (outcome.kind === "financial_locked") {
      res.status(422).json({
        error:
          "Cannot add supplements after invoicing; all approved scope must be final before the receivable split is locked",
      });
      return;
    }
    const supplement = outcome.supplement;
    coordinateCollisionClaim({
      id: claim.id,
      dealerId: claim.dealerId,
      vehicleInfo: claim.vehicleInfo,
      status: claim.status,
      event: "supplement_submitted",
      eventKey: `supplement:${supplement.id}:submitted`,
      detail: `${supplement.description} — GYD ${supplement.amount.toLocaleString()}`,
    });
    res.status(201).json(CreateCollisionSupplementResponse.parse(supplement));
  },
);

router.post(
  "/collision-claims/:id/supplements/:supplementId/decision",
  async (req, res): Promise<void> => {
    const params = DecideCollisionSupplementParams.safeParse(req.params);
    const parsed = DecideCollisionSupplementBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    if (!isServiceApprover(res.locals.user)) {
      res.status(403).json({
        error:
          "Only a Service Manager / Management user can decide supplements",
      });
      return;
    }
    const claim = await findClaim(res, params.data.id);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const next = parsed.data.action === "approve" ? "approved" : "denied";
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.id, claim.id),
            eq(collisionClaimsTable.dealerId, claim.dealerId),
          ),
        )
        .for("update");
      if (!locked) return { kind: "missing_claim" as const };
      if (locked.serviceInvoiceId != null && next === "approved") {
        return { kind: "financial_locked" as const };
      }
      const [updated] = await tx
        .update(collisionSupplementsTable)
        .set({
          status: next,
          decisionNote: parsed.data.note ?? null,
          decidedBy: actor(res).byName,
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(collisionSupplementsTable.id, params.data.supplementId),
            eq(collisionSupplementsTable.claimId, locked.id),
            eq(collisionSupplementsTable.dealerId, locked.dealerId),
            eq(collisionSupplementsTable.status, "pending"),
          ),
        )
        .returning();
      if (!updated) {
        const [existing] = await tx
          .select({ status: collisionSupplementsTable.status })
          .from(collisionSupplementsTable)
          .where(
            and(
              eq(collisionSupplementsTable.id, params.data.supplementId),
              eq(collisionSupplementsTable.claimId, locked.id),
              eq(collisionSupplementsTable.dealerId, locked.dealerId),
            ),
          );
        return existing
          ? { kind: "already_decided" as const, status: existing.status }
          : { kind: "missing_supplement" as const };
      }
      await tx
        .update(collisionClaimsTable)
        .set({
          history: [
            ...locked.history,
            event(res, "supplement", {
              from: "pending",
              to: next,
              note: updated.description,
              amount: updated.amount,
            }),
          ],
        })
        .where(eq(collisionClaimsTable.id, locked.id));
      return { kind: "ok" as const, updated };
    });
    if (outcome.kind === "missing_claim") {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    if (outcome.kind === "financial_locked") {
      res.status(422).json({
        error:
          "Cannot approve a supplement after invoicing because the receivable split is locked",
      });
      return;
    }
    if (outcome.kind === "missing_supplement") {
      res.status(404).json({ error: "Supplement not found" });
      return;
    }
    if (outcome.kind === "already_decided") {
      res.status(409).json({ error: `Supplement already ${outcome.status}` });
      return;
    }
    const updated = outcome.updated;
    coordinateCollisionClaim({
      id: claim.id,
      dealerId: claim.dealerId,
      vehicleInfo: claim.vehicleInfo,
      status: claim.status,
      event: "supplement_decided",
      eventKey: `supplement:${updated.id}:${next}`,
      detail: next,
    });
    res.json(DecideCollisionSupplementResponse.parse(updated));
  },
);

// ---------------------------------------------------------------------------
// Split settlements (insurer share vs customer deductible)
// ---------------------------------------------------------------------------

router.post(
  "/collision-claims/:id/settlements",
  async (req, res): Promise<void> => {
    const params = CreateCollisionSettlementParams.safeParse(req.params);
    const parsed = CreateCollisionSettlementBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: (params.success ? parsed : params).error?.message ?? "Invalid",
      });
      return;
    }
    const found = await findClaim(res, params.data.id);
    if (!found) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const { payer, amount, method, reference } = parsed.data;

    const outcome = await db.transaction(async (tx) => {
      // Lock the claim row so concurrent settlement posts serialize and the
      // per-payer cap cannot be overshot by a race.
      const [claim] = await tx
        .select()
        .from(collisionClaimsTable)
        .where(
          and(
            eq(collisionClaimsTable.id, found.id),
            eq(collisionClaimsTable.dealerId, found.dealerId),
          ),
        )
        .for("update");
      if (!claim) return { kind: "not_found" as const };
      if (
        claim.serviceInvoiceId == null ||
        claim.insurerDue == null ||
        claim.deductibleDue == null
      ) {
        return {
          kind: "unprocessable" as const,
          error: "Claim has not been invoiced yet — no receivable to settle",
        };
      }
      // Never collect against a void invoice — the receivable died with it.
      const [linkedInvoice] = await tx
        .select({ status: serviceInvoicesTable.status })
        .from(serviceInvoicesTable)
        .where(
          and(
            eq(serviceInvoicesTable.id, claim.serviceInvoiceId),
            eq(serviceInvoicesTable.dealerId, claim.dealerId),
          ),
        );
      if (!linkedInvoice || linkedInvoice.status === "void") {
        return {
          kind: "unprocessable" as const,
          error: "The claim's service invoice is void — nothing to collect",
        };
      }
      if (claim.status === "denied" || claim.status === "total_loss") {
        return {
          kind: "unprocessable" as const,
          error: `Cannot collect on a ${claim.status.replace("_", " ")} claim`,
        };
      }
      // Duplicate-reference guard (idempotent client retries).
      if (reference) {
        const [dupe] = await tx
          .select({ id: collisionSettlementsTable.id })
          .from(collisionSettlementsTable)
          .where(
            and(
              eq(collisionSettlementsTable.claimId, claim.id),
              eq(collisionSettlementsTable.dealerId, claim.dealerId),
              eq(collisionSettlementsTable.payer, payer),
              eq(collisionSettlementsTable.reference, reference),
            ),
          );
        if (dupe) {
          return {
            kind: "unprocessable" as const,
            error: `A ${payer} payment with reference "${reference}" is already recorded`,
          };
        }
      }
      const [sums] = await tx
        .select({
          paid: sql<number>`coalesce(sum(${collisionSettlementsTable.amount}), 0)`,
        })
        .from(collisionSettlementsTable)
        .where(
          and(
            eq(collisionSettlementsTable.claimId, claim.id),
            eq(collisionSettlementsTable.dealerId, claim.dealerId),
            eq(collisionSettlementsTable.payer, payer),
          ),
        );
      const due = payer === "insurer" ? claim.insurerDue : claim.deductibleDue;
      const remaining = due - (sums?.paid ?? 0);
      if (amount > remaining + 0.005) {
        return {
          kind: "unprocessable" as const,
          error: `Amount exceeds the remaining ${payer === "insurer" ? "insurer balance" : "customer deductible"} of ${remaining.toFixed(2)}`,
        };
      }
      const [settlement] = await tx
        .insert(collisionSettlementsTable)
        .values({
          dealerId: claim.dealerId,
          claimId: claim.id,
          payer,
          amount,
          method: method ?? null,
          reference: reference ?? null,
          recordedBy: actor(res).byName,
        })
        .returning();
      await tx
        .update(collisionClaimsTable)
        .set({
          history: [
            ...claim.history,
            event(res, "payment", {
              to: payer,
              note: reference ?? method ?? null,
              amount,
            }),
          ],
        })
        .where(eq(collisionClaimsTable.id, claim.id));

      // When BOTH shares are fully collected, flip the service invoice to
      // paid (issued → paid CAS; a manual flip elsewhere just no-ops here).
      const [all] = await tx
        .select({
          insurerPaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'insurer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
          deductiblePaid: sql<number>`coalesce(sum(case when ${collisionSettlementsTable.payer} = 'customer' then ${collisionSettlementsTable.amount} else 0 end), 0)`,
        })
        .from(collisionSettlementsTable)
        .where(
          and(
            eq(collisionSettlementsTable.claimId, claim.id),
            eq(collisionSettlementsTable.dealerId, claim.dealerId),
          ),
        );
      if (
        (all?.insurerPaid ?? 0) >= claim.insurerDue - 0.005 &&
        (all?.deductiblePaid ?? 0) >= claim.deductibleDue - 0.005
      ) {
        await tx
          .update(serviceInvoicesTable)
          .set({ status: "paid" })
          .where(
            and(
              eq(serviceInvoicesTable.id, claim.serviceInvoiceId),
              eq(serviceInvoicesTable.dealerId, claim.dealerId),
              eq(serviceInvoicesTable.status, "issued"),
            ),
          );
      }
      return { kind: "ok" as const, settlement };
    });

    if (outcome.kind === "not_found") {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    if (outcome.kind === "unprocessable") {
      res.status(422).json({ error: outcome.error });
      return;
    }
    coordinateCollisionClaim({
      id: found.id,
      dealerId: found.dealerId,
      vehicleInfo: found.vehicleInfo,
      status: found.status,
      event: "settlement",
      eventKey: `settlement:${outcome.settlement.id}`,
      detail: `${payer === "insurer" ? "Insurer" : "Customer deductible"} payment of GYD ${amount.toLocaleString()} recorded.`,
    });
    res
      .status(201)
      .json(CreateCollisionSettlementResponse.parse(outcome.settlement));
  },
);

export default router;
