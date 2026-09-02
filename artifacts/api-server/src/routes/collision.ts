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
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, ilike, lte, ne, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  collisionClaimsTable,
  collisionSupplementsTable,
  collisionSettlementsTable,
  collisionChecklistItemsTable,
  documentsTable,
  collisionPortalInvitationsTable,
  collisionClaimCommunicationsTable,
  customersTable,
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
import { enqueueEmail } from "../lib/email";
import { isAgentEnabled, recordAgentRun } from "../lib/agent-governance";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

const TERMINAL = new Set(["closed", "denied", "total_loss"]);

const checklistParams = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});
const checklistRequestBody = z.object({ note: z.string().trim().max(500).optional() });
const checklistLinkBody = z.object({ documentId: z.number().int().positive() });
const checklistWaiveBody = z.object({
  reason: z.string().trim().min(3).max(1000),
});
const portalInviteBody = z.object({
  email: z.string().trim().email().max(320),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  idempotencyKey: z.string().trim().min(8).max(200),
  createDraft: z.boolean().optional().default(false),
});
const PURPOSES = ["missing_documents", "claim_received", "estimate_submitted", "approval_received", "repair_started", "delay_update", "ready_for_collection", "payment_request", "custom"] as const;
const draftBody = z.object({ audience: z.enum(["customer", "insurer"]), purpose: z.enum(PURPOSES), instruction: z.string().trim().max(800).optional(), idempotencyKey: z.string().trim().min(8).max(200) });
const editDraftBody = z.object({ recipient: z.string().trim().email().max(320).optional(), subject: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(6000).optional() }).refine(v => v.recipient || v.subject || v.body);

type CollisionDraft = { subject: string; body: string; model: string };
type CollisionDraftGenerator = (context: Record<string, unknown>) => Promise<CollisionDraft>;
let verificationDraftGenerator: CollisionDraftGenerator | null = null;

/** Test-only seam. Production always uses the configured OpenAI client. */
export function setCollisionDraftGeneratorForVerification(
  generator: CollisionDraftGenerator | null,
): void {
  verificationDraftGenerator = generator;
}

// The focused development verifier runs the server with this opt-in flag. It
// deliberately cannot alter a production process, while retaining the same
// injectable function seam for in-process tests.
if (
  process.env.NODE_ENV === "development" &&
  process.env.COLLISION_DRAFT_VERIFIER === "1"
) {
  setCollisionDraftGeneratorForVerification(async () => ({
    subject: "Collision claim update",
    body: "This is a deterministic draft for staff review.",
    model: "deterministic-verifier",
  }));
}

async function generateCollisionDraft(context: Record<string, unknown>): Promise<CollisionDraft> {
  if (verificationDraftGenerator) return verificationDraftGenerator(context);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    max_tokens: 700,
    messages: [{ role: "system", content: "Write a professional plain-language collision-claim email draft. Return JSON with subject and body only. Do not invent dates, promises, coverage decisions, or financial decisions. When requesting documents say they may be uploaded through the secure portal." }, { role: "user", content: JSON.stringify(context) }],
  });
  const parsed = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(6000) }).safeParse(JSON.parse(completion.choices[0]?.message.content ?? "{}"));
  if (!parsed.success) throw new Error("invalid model draft");
  return { ...parsed.data, model: "gpt-4o-mini" };
}

type ChecklistDefault = {
  category: string;
  key: string;
  label: string;
  description: string;
  audience: "customer" | "insurer" | "workshop";
  requiredForStatus: string | null;
  severeOnly?: boolean;
  partsOnly?: boolean;
};

const CHECKLIST_DEFAULTS: ChecklistDefault[] = [
  { category: "identity", key: "customer_id", label: "Customer identification", description: "Government-issued customer identification.", audience: "customer", requiredForStatus: "submitted" },
  { category: "identity", key: "driver_license", label: "Driver licence", description: "Valid licence for the driver at the time of loss.", audience: "customer", requiredForStatus: "submitted" },
  { category: "vehicle", key: "vehicle_registration", label: "Vehicle registration", description: "Current registration for the claimed vehicle.", audience: "customer", requiredForStatus: "submitted" },
  { category: "insurance", key: "insurance_schedule", label: "Insurance certificate or policy schedule", description: "Certificate or schedule identifying the insured vehicle.", audience: "customer", requiredForStatus: "submitted" },
  { category: "loss", key: "accident_statement", label: "Accident statement", description: "Customer statement describing what happened.", audience: "customer", requiredForStatus: "submitted" },
  { category: "loss", key: "police_report", label: "Police report", description: "Police report for a severe collision where applicable.", audience: "customer", requiredForStatus: "submitted", severeOnly: true },
  { category: "evidence", key: "damage_photos", label: "Damage photos", description: "Clear photographs of the damaged areas.", audience: "customer", requiredForStatus: "estimate_drafted" },
  { category: "estimate", key: "repair_estimate", label: "Repair estimate", description: "Workshop estimate submitted for review.", audience: "workshop", requiredForStatus: "submitted" },
  { category: "approval", key: "insurer_approval", label: "Insurer approval", description: "Written insurer approval of repair scope and value.", audience: "insurer", requiredForStatus: "approved" },
  { category: "parts", key: "parts_quotations", label: "Parts quotations", description: "Supplier quotations supporting applicable parts costs.", audience: "workshop", requiredForStatus: "parts_ordered", partsOnly: true },
  { category: "repair", key: "completion_photos", label: "Repair completion photos", description: "Photographs showing completed repairs.", audience: "workshop", requiredForStatus: "quality_check" },
  { category: "repair", key: "quality_inspection", label: "Quality inspection", description: "Completed post-repair quality inspection.", audience: "workshop", requiredForStatus: "insurer_signoff" },
  { category: "billing", key: "final_invoice", label: "Final invoice", description: "Final repair invoice issued by the workshop.", audience: "workshop", requiredForStatus: "closed" },
  { category: "approval", key: "insurer_signoff", label: "Insurer sign-off", description: "Final insurer acceptance or settlement sign-off.", audience: "insurer", requiredForStatus: "invoiced" },
];

async function instantiateChecklist(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  claim: { id: number; dealerId: number; severity: string },
): Promise<void> {
  const rows = CHECKLIST_DEFAULTS.filter(
    (item) =>
      (!item.severeOnly || claim.severity === "severe") &&
      (!item.partsOnly || claim.severity !== "minor"),
  ).map(({ severeOnly: _severe, partsOnly: _parts, ...item }) => ({
    ...item,
    dealerId: claim.dealerId,
    claimId: claim.id,
  }));
  if (rows.length) {
    await tx
      .insert(collisionChecklistItemsTable)
      .values(rows)
      .onConflictDoNothing({
        target: [collisionChecklistItemsTable.claimId, collisionChecklistItemsTable.key],
      });
  }
}

function checklistEvent(
  res: Parameters<typeof actor>[0],
  action: string,
  label: string,
): CollisionClaimEvent {
  return event(res, "checklist", { note: `${action}: ${label}` });
}

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
       await instantiateChecklist(tx, claim);
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
  const checklist = await db
    .select()
    .from(collisionChecklistItemsTable)
    .where(
      and(
        eq(collisionChecklistItemsTable.claimId, claim.id),
        eq(collisionChecklistItemsTable.dealerId, dealerId),
      ),
    )
    .orderBy(collisionChecklistItemsTable.id);

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
      checklist,
      checklistSummary: {
        total: checklist.length,
        missing: checklist.filter((item) => item.status === "missing").length,
        requested: checklist.filter((item) => item.status === "requested").length,
        uploaded: checklist.filter((item) => item.status === "uploaded").length,
        verified: checklist.filter((item) => item.status === "verified").length,
        waived: checklist.filter((item) => item.status === "waived").length,
      },
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
    const blockedChecklist = await tx
      .select({ label: collisionChecklistItemsTable.label })
      .from(collisionChecklistItemsTable)
      .where(
        and(
          eq(collisionChecklistItemsTable.dealerId, locked.dealerId),
          eq(collisionChecklistItemsTable.claimId, locked.id),
          eq(collisionChecklistItemsTable.requiredForStatus, target),
          ne(collisionChecklistItemsTable.status, "verified"),
          ne(collisionChecklistItemsTable.status, "waived"),
        ),
      );
    unmet.push(...blockedChecklist.map((item) => item.label));
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
// Stage-aware evidence checklist
// ---------------------------------------------------------------------------

router.post(
  "/collision-claims/:id/checklist/:itemId/request",
  async (req, res): Promise<void> => {
    const params = checklistParams.safeParse(req.params);
    const body = checklistRequestBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: (params.success ? body : params).error?.message });
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
        .where(and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)))
        .for("update");
      if (!locked) return null;
      const [item] = await tx
        .update(collisionChecklistItemsTable)
        .set({
          status: "requested",
          requestedByUserId: actor(res).byUserId,
          requestedByName: actor(res).byName,
          requestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(collisionChecklistItemsTable.id, params.data.itemId),
            eq(collisionChecklistItemsTable.claimId, locked.id),
            eq(collisionChecklistItemsTable.dealerId, locked.dealerId),
            sql`${collisionChecklistItemsTable.status} in ('missing','requested')`,
          ),
        )
        .returning();
      if (!item) return null;
      await tx
        .update(collisionClaimsTable)
        .set({
          history: [
            ...locked.history,
            checklistEvent(res, "requested", item.label),
          ],
        })
        .where(eq(collisionClaimsTable.id, locked.id));
      return item;
    });
    if (!outcome) {
      res.status(409).json({ error: "Checklist item is unavailable or already completed" });
      return;
    }
    res.json(outcome);
  },
);

router.post(
  "/collision-claims/:id/checklist/:itemId/link",
  async (req, res): Promise<void> => {
    const params = checklistParams.safeParse(req.params);
    const body = checklistLinkBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: (params.success ? body : params).error?.message });
      return;
    }
    const claim = await findClaim(res, params.data.id);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const [document] = await db
      .select({ id: documentsTable.id })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, body.data.documentId),
          eq(documentsTable.dealerId, claim.dealerId),
          eq(documentsTable.entityType, "collision_claim"),
          eq(documentsTable.entityId, claim.id),
        ),
      );
    if (!document) {
      res.status(404).json({ error: "Collision claim document not found" });
      return;
    }
    const [item] = await db
      .update(collisionChecklistItemsTable)
      .set({ documentId: document.id, status: "uploaded", updatedAt: new Date() })
      .where(
        and(
          eq(collisionChecklistItemsTable.id, params.data.itemId),
          eq(collisionChecklistItemsTable.claimId, claim.id),
          eq(collisionChecklistItemsTable.dealerId, claim.dealerId),
          ne(collisionChecklistItemsTable.status, "verified"),
          ne(collisionChecklistItemsTable.status, "waived"),
        ),
      )
      .returning();
    if (!item) {
      res.status(409).json({ error: "Checklist item is unavailable or already completed" });
      return;
    }
    res.json(item);
  },
);

router.post(
  "/collision-claims/:id/checklist/:itemId/verify",
  async (req, res): Promise<void> => {
    const params = checklistParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const claim = await findClaim(res, params.data.id);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(collisionClaimsTable).where(
        and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)),
      ).for("update");
      if (!locked) return null;
      const [item] = await tx
        .update(collisionChecklistItemsTable)
        .set({
          status: "verified",
          verifiedByUserId: actor(res).byUserId,
          verifiedByName: actor(res).byName,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(collisionChecklistItemsTable.id, params.data.itemId),
            eq(collisionChecklistItemsTable.claimId, locked.id),
            eq(collisionChecklistItemsTable.dealerId, locked.dealerId),
            eq(collisionChecklistItemsTable.status, "uploaded"),
            sql`${collisionChecklistItemsTable.documentId} is not null`,
          ),
        )
        .returning();
      if (!item) return null;
      await tx.update(collisionClaimsTable).set({
        history: [...locked.history, checklistEvent(res, "verified", item.label)],
      }).where(eq(collisionClaimsTable.id, locked.id));
      return item;
    });
    if (!outcome) {
      res.status(422).json({ error: "Link an uploaded collision claim document before verification" });
      return;
    }
    res.json(outcome);
  },
);

router.post(
  "/collision-claims/:id/checklist/:itemId/waive",
  async (req, res): Promise<void> => {
    const params = checklistParams.safeParse(req.params);
    const body = checklistWaiveBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: (params.success ? body : params).error?.message });
      return;
    }
    if (!isServiceApprover(res.locals.user)) {
      res.status(403).json({ error: "Only a Service Manager / Management user can waive required evidence" });
      return;
    }
    const claim = await findClaim(res, params.data.id);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(collisionClaimsTable).where(
        and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)),
      ).for("update");
      if (!locked) return null;
      const [item] = await tx.update(collisionChecklistItemsTable).set({
        status: "waived",
        waivedByUserId: actor(res).byUserId,
        waivedByName: actor(res).byName,
        waivedAt: new Date(),
        waiverReason: body.data.reason,
        updatedAt: new Date(),
      }).where(and(
        eq(collisionChecklistItemsTable.id, params.data.itemId),
        eq(collisionChecklistItemsTable.claimId, locked.id),
        eq(collisionChecklistItemsTable.dealerId, locked.dealerId),
        ne(collisionChecklistItemsTable.status, "verified"),
      )).returning();
      if (!item) return null;
      await tx.update(collisionClaimsTable).set({
        history: [...locked.history, checklistEvent(res, "waived", `${item.label} — ${body.data.reason}`)],
      }).where(eq(collisionClaimsTable.id, locked.id));
      return item;
    });
    if (!outcome) {
      res.status(409).json({ error: "Checklist item is unavailable or already verified" });
      return;
    }
    res.json(outcome);
  },
);

router.post(
  "/collision-claims/:id/portal-invitations",
  async (req, res): Promise<void> => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const body = portalInviteBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: (id.success ? body : id).error?.message });
      return;
    }
    if (body.data.createDraft) {
      res.status(422).json({
        error: "Portal invitation email drafts require the configured claim communication agent",
      });
      return;
    }
    const claim = await findClaim(res, id.data);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + body.data.expiresInDays * 86_400_000);
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(collisionClaimsTable).where(
        and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)),
      ).for("update");
      if (!locked) return { kind: "missing" as const };
      const [existing] = await tx.select({ id: collisionPortalInvitationsTable.id })
        .from(collisionPortalInvitationsTable)
        .where(and(
          eq(collisionPortalInvitationsTable.dealerId, locked.dealerId),
          eq(collisionPortalInvitationsTable.claimId, locked.id),
          eq(collisionPortalInvitationsTable.idempotencyKey, body.data.idempotencyKey),
        ));
      if (existing) return { kind: "duplicate" as const };
      const [invitation] = await tx.insert(collisionPortalInvitationsTable).values({
        dealerId: locked.dealerId,
        claimId: locked.id,
        customerId: locked.customerId,
        email: body.data.email,
        tokenHash,
        expiresAt,
        idempotencyKey: body.data.idempotencyKey,
        createdByUserId: actor(res).byUserId,
        createdByName: actor(res).byName,
      }).returning();
      await tx.update(collisionClaimsTable).set({
        history: [...locked.history, event(res, "portal", { note: "Customer portal invitation created" })],
      }).where(eq(collisionClaimsTable.id, locked.id));
      return { kind: "ok" as const, invitation };
    });
    if (outcome.kind === "duplicate") {
      res.status(409).json({ error: "An invitation already exists for this idempotency key" });
      return;
    }
    if (outcome.kind === "missing") {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const { tokenHash: _hash, ...safeInvitation } = outcome.invitation;
    res.status(201).json({ ...safeInvitation, token: rawToken });
  },
);

router.get("/collision-claims/:id/portal-invitations", async (req, res): Promise<void> => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  const claim = id.success ? await findClaim(res, id.data) : null;
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  const invitations = await db.select().from(collisionPortalInvitationsTable).where(and(
    eq(collisionPortalInvitationsTable.claimId, claim.id),
    eq(collisionPortalInvitationsTable.dealerId, claim.dealerId),
  )).orderBy(desc(collisionPortalInvitationsTable.createdAt));
  res.json(invitations.map(({ tokenHash: _tokenHash, ...invitation }) => invitation));
});

router.post(
  "/collision-claims/:id/portal-invitations/:invitationId/revoke",
  async (req, res): Promise<void> => {
    const params = z.object({
      id: z.coerce.number().int().positive(),
      invitationId: z.coerce.number().int().positive(),
    }).safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const claim = await findClaim(res, params.data.id);
    if (!claim) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(collisionClaimsTable).where(
        and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)),
      ).for("update");
      if (!locked) return null;
      const [invitation] = await tx.update(collisionPortalInvitationsTable).set({
        revokedAt: new Date(),
        revokedByUserId: actor(res).byUserId,
        revokedByName: actor(res).byName,
      }).where(and(
        eq(collisionPortalInvitationsTable.id, params.data.invitationId),
        eq(collisionPortalInvitationsTable.claimId, locked.id),
        eq(collisionPortalInvitationsTable.dealerId, locked.dealerId),
        sql`${collisionPortalInvitationsTable.revokedAt} is null`,
      )).returning();
      if (!invitation) return null;
      await tx.update(collisionClaimsTable).set({
        history: [...locked.history, event(res, "portal", { note: "Customer portal invitation revoked" })],
      }).where(eq(collisionClaimsTable.id, locked.id));
      return invitation;
    });
    if (!outcome) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const { tokenHash: _hash, ...safeInvitation } = outcome;
    res.json(safeInvitation);
  },
);

router.get("/collision-claims/:id/communications", async (req, res): Promise<void> => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  const claim = id.success ? await findClaim(res, id.data) : null;
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  const rows = await db.select().from(collisionClaimCommunicationsTable).where(and(
    eq(collisionClaimCommunicationsTable.dealerId, claim.dealerId), eq(collisionClaimCommunicationsTable.claimId, claim.id),
  )).orderBy(desc(collisionClaimCommunicationsTable.createdAt));
  res.json(rows);
});

router.get("/collision-claims/:id/communications/:communicationId", async (req, res): Promise<void> => {
  const params = z.object({ id: z.coerce.number().int().positive(), communicationId: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!params.success) { res.status(404).json({ error: "Claim not found" }); return; }
  const claim = await findClaim(res, params.data.id);
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  const [row] = await db.select().from(collisionClaimCommunicationsTable).where(and(
    eq(collisionClaimCommunicationsTable.id, params.data.communicationId), eq(collisionClaimCommunicationsTable.claimId, claim.id),
    eq(collisionClaimCommunicationsTable.dealerId, claim.dealerId),
  ));
  if (!row) { res.status(404).json({ error: "Communication not found" }); return; }
  res.json(row);
});

router.post("/collision-claims/:id/communications/generate-draft", async (req, res): Promise<void> => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  const body = draftBody.safeParse(req.body);
  const claim = id.success ? await findClaim(res, id.data) : null;
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  if (!body.success) { res.status(422).json({ error: body.error.message }); return; }
  const [existing] = await db.select().from(collisionClaimCommunicationsTable).where(and(
    eq(collisionClaimCommunicationsTable.dealerId, claim.dealerId), eq(collisionClaimCommunicationsTable.claimId, claim.id),
    eq(collisionClaimCommunicationsTable.generationIdempotencyKey, body.data.idempotencyKey),
  ));
  if (existing) { res.json(existing); return; }
  if (!(await isAgentEnabled(claim.dealerId, "collision_coordinator"))) {
    await recordAgentRun({ dealerId: claim.dealerId, agentKey: "collision_coordinator", runType: "email_draft", inputSource: "collision_claim", inputSummary: "draft generation blocked", status: "blocked", refType: "collision_claim", refId: claim.id, autonomy: "advisory" });
    res.status(409).json({ error: "Collision coordinator is disabled for this dealer" }); return;
  }
  const [customer] = claim.customerId == null ? [] : await db.select({ name: customersTable.name, email: customersTable.email }).from(customersTable).where(and(eq(customersTable.id, claim.customerId), eq(customersTable.dealerId, claim.dealerId)));
  const recipient = body.data.audience === "customer" ? customer?.email : claim.adjusterContact;
  if (!recipient || !z.string().email().safeParse(recipient.trim()).success) {
    res.status(422).json({ error: `A valid ${body.data.audience} email recipient is required before generating a draft` }); return;
  }
  const labels = await db.select({ label: collisionChecklistItemsTable.label, status: collisionChecklistItemsTable.status }).from(collisionChecklistItemsTable).where(and(eq(collisionChecklistItemsTable.claimId, claim.id), eq(collisionChecklistItemsTable.dealerId, claim.dealerId)));
  const context = { customerFirstName: customer?.name?.split(/\s+/)[0] ?? null, vehicle: claim.vehicleInfo, status: claim.status, purpose: body.data.purpose, checklist: labels.filter(x => x.status !== "verified" && x.status !== "waived").map(x => x.label), instruction: body.data.instruction ?? null };
  try {
    const generated = await generateCollisionDraft(context);
    const [draft] = await db.insert(collisionClaimCommunicationsTable).values({
      dealerId: claim.dealerId, claimId: claim.id, audience: body.data.audience, kind: body.data.purpose, recipient: recipient.trim(),
      subject: generated.subject, body: generated.body, status: "draft", generatedByAgent: true, model: generated.model, promptVersion: "collision-email-v1",
      createdByUserId: actor(res).byUserId, createdByName: actor(res).byName, generationIdempotencyKey: body.data.idempotencyKey,
    }).returning();
    await recordAgentRun({ dealerId: claim.dealerId, agentKey: "collision_coordinator", runType: "email_draft", inputSource: "collision_claim", inputSummary: "minimized collision email context", outputSummary: "draft saved for staff review", status: "completed", refType: "collision_claim", refId: claim.id, autonomy: "advisory", mutation: true });
    res.status(201).json(draft);
  } catch {
    await recordAgentRun({ dealerId: claim.dealerId, agentKey: "collision_coordinator", runType: "email_draft", inputSource: "collision_claim", inputSummary: "minimized collision email context", status: "error", errorMessage: "Email draft provider failed", refType: "collision_claim", refId: claim.id, autonomy: "advisory" });
    res.status(502).json({ error: "Email draft provider is unavailable; no draft was created" });
  }
});

router.patch("/collision-claims/:id/communications/:communicationId", async (req, res): Promise<void> => {
  const params = z.object({ id: z.coerce.number().int().positive(), communicationId: z.coerce.number().int().positive() }).safeParse(req.params);
  const body = editDraftBody.safeParse(req.body);
  if (!params.success) { res.status(404).json({ error: "Claim not found" }); return; }
  const claim = await findClaim(res, params.data.id);
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  if (!body.success) { res.status(422).json({ error: body.error.message }); return; }
  const [row] = await db.update(collisionClaimCommunicationsTable).set({ ...body.data, editedByUserId: actor(res).byUserId, editedByName: actor(res).byName, editedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(collisionClaimCommunicationsTable.id, params.data.communicationId), eq(collisionClaimCommunicationsTable.claimId, claim.id),
    eq(collisionClaimCommunicationsTable.dealerId, claim.dealerId), eq(collisionClaimCommunicationsTable.status, "draft"),
  )).returning();
  if (!row) { res.status(409).json({ error: "Only an unlocked draft can be edited" }); return; }
  res.json(row);
});

router.post("/collision-claims/:id/communications/:communicationId/send", async (req, res): Promise<void> => {
  const params = z.object({ id: z.coerce.number().int().positive(), communicationId: z.coerce.number().int().positive() }).safeParse(req.params);
  const body = z.object({ confirm: z.literal(true), idempotencyKey: z.string().trim().min(8).max(200) }).safeParse(req.body);
  if (!params.success) { res.status(404).json({ error: "Claim not found" }); return; }
  const claim = await findClaim(res, params.data.id);
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }
  if (!body.success) { res.status(422).json({ error: "confirm must be true and an idempotency key is required" }); return; }
  const outcome = await db.transaction(async tx => {
    const [draft] = await tx.select().from(collisionClaimCommunicationsTable).where(and(eq(collisionClaimCommunicationsTable.id, params.data.communicationId), eq(collisionClaimCommunicationsTable.claimId, claim.id), eq(collisionClaimCommunicationsTable.dealerId, claim.dealerId))).for("update");
    if (!draft) return null;
    if (draft.status !== "draft") return draft.sendIdempotencyKey === body.data.idempotencyKey ? draft : null;
    const queued = await enqueueEmail({ dealerId: claim.dealerId, customerId: claim.customerId, to: draft.recipient, template: "collision.claim.communication", data: { subject: draft.subject, body: draft.body }, dedupeKey: `collision-communication:${draft.id}:${body.data.idempotencyKey}` });
    const [saved] = await tx.update(collisionClaimCommunicationsTable).set({ status: "queued", outboxId: queued.id, sendIdempotencyKey: body.data.idempotencyKey, sentByUserId: actor(res).byUserId, sentByName: actor(res).byName, sentAt: new Date(), updatedAt: new Date() }).where(and(eq(collisionClaimCommunicationsTable.id, draft.id), eq(collisionClaimCommunicationsTable.status, "draft"))).returning();
    return saved ?? null;
  });
  if (!outcome) { res.status(409).json({ error: "Communication is not an editable draft or was sent with another request" }); return; }
  await db.update(collisionClaimsTable).set({
    history: [...claim.history, event(res, "communication", { note: `Email queued to ${outcome.audience}` })],
  }).where(and(eq(collisionClaimsTable.id, claim.id), eq(collisionClaimsTable.dealerId, claim.dealerId)));
  coordinateCollisionClaim({ id: claim.id, dealerId: claim.dealerId, vehicleInfo: claim.vehicleInfo, status: claim.status, event: "communication", eventKey: `communication:${outcome.id}:${outcome.sendIdempotencyKey}` });
  res.json(outcome);
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
