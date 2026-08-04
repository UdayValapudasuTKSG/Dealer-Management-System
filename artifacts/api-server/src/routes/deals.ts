import { Router, type IRouter } from "express";
import { eq, desc, and, inArray, or, gt, sql } from "drizzle-orm";
import {
  db,
  dealsTable,
  vehiclesTable,
  bookingsTable,
  gatesTable,
  leadsTable,
  invoicesTable,
  paymentsTable,
  timelineEventsTable,
  VIN_LENGTH,
  REGISTRATION_PATTERN,
} from "@workspace/db";
import { recordAgentRun } from "../lib/agent-governance";
import { activeDealerId } from "../middlewares/rbac";
import { idempotent } from "../middlewares/idempotency";
import {
  findBlockedEditField,
  redactHiddenFields,
} from "../lib/field-permissions";
import {
  CreateDealBody,
  UpdateDealBody,
  GetDealParams,
  UpdateDealParams,
  ListDealsQueryParams,
  ListDealsResponse,
  GetDealResponse,
  UpdateDealResponse,
} from "@workspace/api-zod";
import { onDealStageChanged } from "../lib/email-triggers";
import { ensureDeliveryForDeal } from "../lib/delivery";
import {
  approvedFinanceAppForDeal,
  ensureFinalInvoiceForDeal,
} from "../lib/invoicing";
import { computeTaxes, ensureDealerTaxes } from "../lib/taxes";
import {
  refundBlockReason,
  capturedFundsForDeal,
  raiseRefundReleaseGate,
  cascadeDealCancellation,
  logCancellationEvent,
} from "../lib/cancellation";
import { resolveDealerUserIdByName } from "../lib/user-lookup";
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";

const router: IRouter = Router();

// Deals move forward one stage at a time (backwards moves allowed for
// corrections back to the immediately preceding stage only).
const DEAL_STAGE_ORDER = ["desking", "committed", "delivered"];

// Discounts beyond this share of the vehicle price raise a below-floor
// approval gate for a sales manager (the deal itself is not blocked).
const FLOOR_DISCOUNT_RATIO = 0.05;

const money = (n: number) =>
  `GY$${Math.round(n).toLocaleString("en-US")}`;

// A deal may only link to a lead in the same dealer. Returns the lead row or
// null when the id doesn't exist (or belongs to another dealer → treat as 404).
async function findDealerLead(
  leadId: number,
  dealerId: number,
): Promise<typeof leadsTable.$inferSelect | null> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
  return lead ?? null;
}

async function logDealLinkEvent(
  lead: typeof leadsTable.$inferSelect,
  deal: typeof dealsTable.$inferSelect,
  kind: "deal_created" | "deal_attached" | "deal_detached",
  actor: string,
): Promise<void> {
  const titles: Record<string, string> = {
    deal_created: "Deal desked",
    deal_attached: "Deal attached",
    deal_detached: "Deal detached",
  };
  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind,
    title: titles[kind]!,
    detail:
      kind === "deal_detached"
        ? `Deal #${deal.id} was unlinked from this lead.`
        : `Deal #${deal.id} (${money(deal.otdPrice)} OTD, ${deal.stage}) is now linked to this lead.`,
    actor,
    isAgent: false,
    refType: "lead",
    refId: lead.id,
  });
}

// How long the VIN hard-lock hold runs after deal commit (SLA timer).
const VIN_LOCK_HOLD_HOURS = 72;

type AllocationResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

// A11 deterministic VIN allocation (L5): runs inline on deal commit — NOT a
// separate approval gate. Validates the physical unit's identity, blocks
// flagged (recall/damage) units behind an advisory gate, and hard-locks the
// vehicle available/reserved → booked with a race-safe conditional write so
// two deals can never allocate the same VIN.
async function allocateVehicleOnCommit(
  deal: typeof dealsTable.$inferSelect,
  dealerId: number,
  actor: string,
): Promise<AllocationResult> {
  const started = Date.now();
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, deal.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );
  if (!vehicle) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "vehicle_not_found",
        unmet: ["The deal's vehicle no longer exists in this dealership's stock"],
      },
    };
  }

  // Identity validation before lock: VIN + engine number exactly 17 chars,
  // registration (when present) must match the Guyana plate format.
  const identityUnmet = (v: typeof vehicle): string[] => {
    const problems: string[] = [];
    if (!v.vin || v.vin.length !== VIN_LENGTH)
      problems.push(`VIN must be exactly ${VIN_LENGTH} characters before allocation`);
    if (!v.engineNumber || v.engineNumber.length !== VIN_LENGTH)
      problems.push(`Engine number must be exactly ${VIN_LENGTH} characters before allocation`);
    if (v.registration && !REGISTRATION_PATTERN.test(v.registration))
      problems.push("Registration must be 3 uppercase letters followed by 1-4 digits");
    return problems;
  };

  // Own-booking short circuit: a paid pre-book already locked this exact
  // unit for this deal (booking → deal auto-desk path). It only bypasses the
  // lock — identity and recall/damage gates still apply, so an invalid or
  // flagged unit falls through to the normal error reporting below.
  if (
    vehicle.status === "booked" &&
    identityUnmet(vehicle).length === 0 &&
    !vehicle.recallFlag &&
    !vehicle.damageFlag
  ) {
    const [own] = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.dealerId, dealerId),
          eq(bookingsTable.vehicleId, vehicle.id),
          eq(bookingsTable.dealId, deal.id),
        ),
      );
    if (own) return { ok: true };
  }

  // Auto-assign: leads/deals carry a MODEL of interest — the referenced row
  // is just a representative unit. At commit, allocate the deal's own unit
  // when it is eligible, otherwise fall back to any sibling unit of the
  // same model (same dealer/make/model/year/trim) with a valid identity,
  // no recall/damage flag, and an allocatable status.
  const siblings = (
    await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.dealerId, dealerId),
          eq(vehiclesTable.make, vehicle.make),
          eq(vehiclesTable.model, vehicle.model),
          eq(vehiclesTable.year, vehicle.year),
        ),
      )
  ).filter(
    (u) =>
      u.id !== vehicle.id &&
      (u.trim ?? "").toLowerCase() === (vehicle.trim ?? "").toLowerCase(),
  );
  const statusRank: Record<string, number> = { available: 0, reserved: 1 };
  siblings.sort(
    (a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || a.id - b.id,
  );

  const holdUntil = new Date(Date.now() + VIN_LOCK_HOLD_HOURS * 3600 * 1000);
  let chosen: typeof vehicle | null = null;
  for (const cand of [vehicle, ...siblings]) {
    if (identityUnmet(cand).length) continue;
    if (cand.recallFlag || cand.damageFlag) continue;
    if (!["available", "reserved"].includes(cand.status)) continue;
    // Race-safe hard lock: the conditional UPDATE is the allocation — first
    // writer wins, a concurrent commit on the same VIN matches zero rows.
    const locked = await db
      .update(vehiclesTable)
      .set({ status: "booked", holdUntil, holdReason: "vin_lock" })
      .where(
        and(
          eq(vehiclesTable.id, cand.id),
          eq(vehiclesTable.dealerId, dealerId),
          inArray(vehiclesTable.status, ["available", "reserved"]),
        ),
      )
      .returning({ id: vehiclesTable.id });
    if (locked.length) {
      chosen = cand;
      break;
    }
  }

  if (!chosen) {
    // No unit of this model could be allocated — report against the deal's
    // own referenced unit, preserving the original single-unit semantics.
    const unmet = identityUnmet(vehicle);
    if (unmet.length) {
      return {
        ok: false,
        status: 422,
        body: { error: "vehicle_identity_invalid", unmet },
      };
    }
    if (vehicle.recallFlag || vehicle.damageFlag) {
    const flag = vehicle.recallFlag ? "recall" : "damage";
    const [existing] = await db
      .select({ id: gatesTable.id })
      .from(gatesTable)
      .where(
        and(
          eq(gatesTable.dealerId, dealerId),
          eq(gatesTable.type, "recall_damage"),
          eq(gatesTable.refType, "vehicle"),
          eq(gatesTable.refId, vehicle.id),
          eq(gatesTable.status, "pending"),
        ),
      );
    if (!existing) {
      await db.insert(gatesTable).values({
        dealerId,
        type: "recall_damage",
        status: "pending",
        priority: "high",
        title: `${flag === "recall" ? "Recall" : "Damage"} hold — ${vehicle.year} ${vehicle.make} ${vehicle.model} (VIN ${vehicle.vin})`,
        summary: `Deal #${deal.id} commit blocked: the allocated unit carries a ${flag} flag. Clear the flag (or swap the unit) to release the commit.`,
        refType: "vehicle",
        refId: vehicle.id,
        evidence: [
          { label: "Deal", value: `#${deal.id}` },
          { label: "VIN", value: vehicle.vin ?? "—" },
          { label: "Flag", value: flag },
        ],
      });
    }
    return {
      ok: false,
      status: 422,
      body: {
        error: "recall_damage_open",
        unmet: [
          `This unit carries a ${flag} flag — commit is blocked until inventory clears it`,
        ],
      },
    };
    }
    return {
      ok: false,
      status: 409,
      body: {
        error: "vehicle_unavailable",
        detail: `No ${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""} unit can be allocated to deal #${deal.id} — every unit is unavailable, flagged, or missing VIN/engine identity`,
      },
    };
  }

  // Auto-assigned a sibling unit: repoint the deal at the unit that was
  // actually locked so downstream (invoices, delivery, handover) all key
  // off the real VIN.
  const autoAssigned = chosen.id !== vehicle.id;
  if (autoAssigned) {
    await db
      .update(dealsTable)
      .set({ vehicleId: chosen.id })
      .where(and(eq(dealsTable.id, deal.id), eq(dealsTable.dealerId, dealerId)));
  }

  // Audit: deterministic A11 system action — plain transactional code, not
  // an AI write, so it carries NO kill switch (R3.2) and always records.
  {
    await recordAgentRun({
      dealerId,
      agentKey: "vin_allocation",
      runType: "vin_allocation",
      autonomy: "system",
      inputSource: "deal_commit",
      inputSummary: `Deal #${deal.id} committed — allocating VIN ${chosen.vin}${autoAssigned ? " (auto-assigned from model stock)" : ""}`,
      outputSummary: `VIN ${chosen.vin} hard-locked (${chosen.status} → booked, hold ${VIN_LOCK_HOLD_HOURS}h)`,
      confidence: 100,
      mutation: true,
      refType: "vehicle",
      refId: chosen.id,
      latencyMs: Date.now() - started,
      changeSummary: `vehicle.status ${chosen.status} → booked${autoAssigned ? `; deal.vehicleId ${vehicle.id} → ${chosen.id}` : ""}`,
    });
  }

  if (deal.leadId != null) {
    const lead = await findDealerLead(deal.leadId, dealerId);
    if (lead) {
      await db.insert(timelineEventsTable).values({
        dealerId,
        customerId: lead.customerId,
        domain: "leads",
        kind: "vin_allocated",
        title: "VIN allocated",
        detail: `Deal #${deal.id} commit locked VIN ${chosen.vin} (${chosen.year} ${chosen.make} ${chosen.model})${autoAssigned ? " — unit auto-assigned from model stock" : ""} — status ${chosen.status} → booked.`,
        actor,
        isAgent: true,
        refType: "lead",
        refId: lead.id,
      });
    }
  }

  return { ok: true };
}

const dealActor = (res: {
  locals: { user?: { name: string | null; email: string | null } };
}): string => res.locals.user?.name ?? res.locals.user?.email ?? "Staff";

async function raiseBelowFloorGateIfNeeded(
  deal: typeof dealsTable.$inferSelect,
): Promise<void> {
  if (deal.vehiclePrice <= 0) return;
  // Any discount requires manager approval; below-floor ones are flagged
  // as high-priority margin breaches.
  if (deal.discount <= 0) return;
  const floor = deal.vehiclePrice * (1 - FLOOR_DISCOUNT_RATIO);
  const effective = deal.vehiclePrice - deal.discount;
  const belowFloor = effective < floor;
  const pct = Math.round((deal.discount / deal.vehiclePrice) * 1000) / 10;

  const [existing] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(
      and(
        eq(gatesTable.dealerId, deal.dealerId),
        eq(gatesTable.type, "below_floor_price"),
        eq(gatesTable.refType, "deal"),
        eq(gatesTable.refId, deal.id),
        eq(gatesTable.status, "pending"),
      ),
    );
  if (existing) return;

  await db.insert(gatesTable).values({
    dealerId: deal.dealerId,
    type: "below_floor_price",
    status: "pending",
    priority: belowFloor ? "high" : "normal",
    customerId: deal.customerId ?? null,
    customerName: deal.customerName,
    refType: "deal",
    refId: deal.id,
    title: belowFloor
      ? `Below-floor price — ${deal.customerName ?? `Deal #${deal.id}`}`
      : `Discount approval — ${deal.customerName ?? `Deal #${deal.id}`}`,
    summary: belowFloor
      ? `Discount of ${money(deal.discount)} (${pct}%) takes the selling price to ${money(effective)}, below the ${money(floor)} floor (${FLOOR_DISCOUNT_RATIO * 100}% margin guard).`
      : `Discount of ${money(deal.discount)} (${pct}%) takes the selling price to ${money(effective)}. All discounts require manager approval before commit.`,
    recommendation: belowFloor
      ? "Approve the discount, adjust it back above floor, or dismiss if the numbers were entered in error."
      : "Approve the discount, adjust it, or dismiss if the numbers were entered in error.",
    amount: effective,
    floorAmount: floor,
    evidence: [
      { label: "Vehicle price", value: money(deal.vehiclePrice) },
      { label: "Discount", value: money(deal.discount) },
      { label: "Discount %", value: `${pct}%` },
      { label: "Effective price", value: money(effective) },
      { label: "Floor price", value: money(floor) },
    ],
  });
}

/**
 * Deposit gate (08-l6 §4b / 20-r2 §R2.2): the desking→committed hop is
 * satisfied by REAL reservation money or a manager-approved trusted bypass —
 * never by the ad-hoc deals.depositPaid boolean alone. Satisfiers:
 *  1. an active/converted booking for this deal with bookingAmount>0 whose
 *     reservation fee is fully paid, or
 *  2. a manager-approved (approved/adjusted) fee_waiver gate on a zero-fee
 *     waiver booking linked to the deal, or
 *  3. a PAID invoice linked to the deal (finance-pipeline path) — reservation
 *     (deposit) or final (full balance settled implies the deposit is covered).
 */
async function dealDepositStatus(
  deal: typeof dealsTable.$inferSelect,
  dealerId: number,
): Promise<{ satisfied: boolean; message: string }> {
  const bookings = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.dealerId, dealerId),
        inArray(bookingsTable.status, ["active", "converted"]),
        // STRICT deal linkage: only bookings explicitly attached to THIS deal
        // can satisfy the deposit gate — a paid booking on the same vehicle or
        // customer but a different (or no) deal must not unblock commit.
        eq(bookingsTable.dealId, deal.id),
      ),
    );
  if (
    bookings.some(
      (b) =>
        b.bookingAmount > 0 &&
        (b.paymentStatus === "paid" ||
          b.amountPaid >= b.bookingAmount - 0.005),
    )
  ) {
    return { satisfied: true, message: "" };
  }

  const waiverBookingIds = bookings
    .filter((b) => b.waiverReason && b.bookingAmount <= 0)
    .map((b) => b.id);
  if (waiverBookingIds.length > 0) {
    const waiverGates = await db
      .select({ id: gatesTable.id, status: gatesTable.status })
      .from(gatesTable)
      .where(
        and(
          eq(gatesTable.dealerId, dealerId),
          eq(gatesTable.type, "fee_waiver"),
          eq(gatesTable.refType, "booking"),
          inArray(gatesTable.refId, waiverBookingIds),
        ),
      );
    if (
      waiverGates.some(
        (g) => g.status === "approved" || g.status === "adjusted",
      )
    ) {
      return { satisfied: true, message: "" };
    }
    if (waiverGates.some((g) => g.status === "pending")) {
      return {
        satisfied: false,
        message:
          "Trusted-bypass waiver is waiting for manager approval — commit unlocks once the fee-waiver gate is approved",
      };
    }
  }

  const [paidInvoice] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.dealerId, dealerId),
        inArray(invoicesTable.kind, ["reservation", "final"]),
        eq(invoicesTable.dealId, deal.id),
        eq(invoicesTable.status, "paid"),
        gt(invoicesTable.amount, 0),
      ),
    );
  if (paidInvoice) return { satisfied: true, message: "" };

  return {
    satisfied: false,
    message:
      "Record a reservation deposit (paid booking) or apply a manager-approved trusted bypass before committing the deal",
  };
}

router.get("/deals", async (req, res): Promise<void> => {
  const query = ListDealsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(dealsTable)
    .where(
      query.data.stage
        ? and(
            eq(dealsTable.dealerId, dealerId),
            eq(dealsTable.stage, query.data.stage),
          )
        : eq(dealsTable.dealerId, dealerId),
    )
    .orderBy(desc(dealsTable.createdAt));

  const visible = await redactHiddenFields(res.locals.user, "deals", rows);
  res.json(ListDealsResponse.parse(visible));
});

router.post("/deals", async (req, res): Promise<void> => {
  const parsed = CreateDealBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);

  // Linking to a lead requires a same-dealer lead (cross-dealer ids → 404).
  let linkedLead: typeof leadsTable.$inferSelect | null = null;
  if (parsed.data.leadId != null) {
    linkedLead = await findDealerLead(parsed.data.leadId, dealerId);
    if (!linkedLead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
  }

  // Stamp the advisor's user ID so briefing scoping matches by ID, not name.
  const salesAdvisorUserId =
    parsed.data.salesAdvisorUserId ??
    (await resolveDealerUserIdByName(dealerId, parsed.data.salesAdvisor));

  let divisionId = parsed.data.divisionId ?? null;
  if (
    divisionId != null &&
    !(await divisionBelongsToDealer(divisionId, dealerId))
  ) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  if (divisionId == null) {
    // Inherit the vehicle's division when desking a deal, else dealer default.
    const [veh] = await db
      .select({ divisionId: vehiclesTable.divisionId })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, parsed.data.vehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    divisionId = veh?.divisionId ?? (await defaultDivisionId(dealerId));
  }

  const [deal] = await db
    .insert(dealsTable)
    .values({ ...parsed.data, divisionId, salesAdvisorUserId, dealerId })
    .returning();

  await raiseBelowFloorGateIfNeeded(deal!);

  if (linkedLead) {
    await logDealLinkEvent(linkedLead, deal!, "deal_created", dealActor(res));
  }

  res.status(201).json(GetDealResponse.parse(deal));
});

router.get("/deals/:id", async (req, res): Promise<void> => {
  const params = GetDealParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deal] = await db
    .select()
    .from(dealsTable)
    .where(
      and(
        eq(dealsTable.id, params.data.id),
        eq(dealsTable.dealerId, activeDealerId(res)),
      ),
    );

  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  const [visible] = await redactHiddenFields(res.locals.user, "deals", [deal]);
  res.json(GetDealResponse.parse(visible));
});

// Idempotent: stage changes allocate/release vehicles — a retried request
// with the same X-Idempotency-Key must not re-run the transition.
router.patch("/deals/:id", idempotent("deals.update"), async (req, res): Promise<void> => {
  const params = UpdateDealParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateDealBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Field-level permissions: reject edits to restricted field groups.
  const blocked = await findBlockedEditField(res.locals.user, "deals", parsed.data);
  if (blocked) {
    res.status(403).json({
      error: `Your role cannot edit ${blocked.groupLabel} (field: ${blocked.field})`,
    });
    return;
  }

  const dealerId = activeDealerId(res);
  const [before] = await db
    .select()
    .from(dealsTable)
    .where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.dealerId, dealerId)));

  // Attaching to a lead requires a same-dealer lead (cross-dealer ids → 404).
  let attachLead: typeof leadsTable.$inferSelect | null = null;
  if (parsed.data.leadId != null) {
    attachLead = await findDealerLead(parsed.data.leadId, dealerId);
    if (!attachLead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
  }

  // Negotiated-amount validation + deterministic OTD recompute (A3 tax
  // engine, L6): whenever a price component changes the server recomputes
  // otdPrice from dealer_taxes — the client-sent otdPrice is never trusted.
  const priceTouched =
    parsed.data.vehiclePrice !== undefined ||
    parsed.data.discount !== undefined ||
    parsed.data.tradeInValue !== undefined ||
    parsed.data.accessories !== undefined;
  if (before && priceTouched) {
    const vehiclePrice = parsed.data.vehiclePrice ?? before.vehiclePrice;
    const discount = parsed.data.discount ?? before.discount;
    const tradeInValue = parsed.data.tradeInValue ?? before.tradeInValue;
    const accessories = parsed.data.accessories ?? before.accessories;
    if (discount < 0 || tradeInValue < 0 || accessories < 0 || vehiclePrice < 0) {
      res.status(422).json({ error: "Price components cannot be negative" });
      return;
    }
    if (tradeInValue > vehiclePrice) {
      res.status(422).json({
        error: "trade_in_exceeds_price",
        unmet: [
          "Trade-in value cannot exceed the vehicle price — record the excess as a separate customer credit",
        ],
      });
      return;
    }
    if (discount > vehiclePrice) {
      res.status(422).json({ error: "Discount cannot exceed the vehicle price" });
      return;
    }
    const [vehicle] = await db
      .select({ powertrain: vehiclesTable.powertrain })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, before.vehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    const taxBase = Math.max(vehiclePrice - discount + accessories, 0);
    const taxRules = await ensureDealerTaxes(dealerId);
    const { totalWithTax } = computeTaxes(taxBase, taxRules, {
      powertrain: vehicle?.powertrain ?? null,
    });
    parsed.data.otdPrice = totalWithTax;
  }

  // L9: captured funds snapshot for a cancellation, computed during the
  // pre-checks and consumed by the post-update side effects.
  let cancellationFunds: Awaited<ReturnType<typeof capturedFundsForDeal>> | null =
    null;

  if (before && parsed.data.stage && parsed.data.stage !== before.stage) {
    // Terminal stages never reactivate — history is retained, not reused.
    if (before.stage === "cancelled" || before.stage === "lost") {
      res.status(422).json({
        error: `A ${before.stage} deal is terminal and cannot change stage`,
      });
      return;
    }
    const fromIdx = DEAL_STAGE_ORDER.indexOf(before.stage);
    const toIdx = DEAL_STAGE_ORDER.indexOf(parsed.data.stage);
    if (fromIdx !== -1 && toIdx !== -1 && toIdx !== fromIdx + 1 && toIdx !== fromIdx - 1) {
      res.status(422).json({
        error: `Deals move one stage at a time (${before.stage} → ${parsed.data.stage} is not allowed)`,
      });
      return;
    }
    // Cancel & Refund (L9): allowed from desking/committed only, requires a
    // reason code, and the refundable-until-registration window must still
    // be open whenever captured funds would need to be returned.
    if (parsed.data.stage === "cancelled") {
      if (before.stage === "delivered") {
        res.status(409).json({
          error:
            "A delivered deal cannot be cancelled — handle returns through the manual goodwill process",
        });
        return;
      }
      if (!parsed.data.cancellationReason) {
        res.status(422).json({
          error: "cancellation_reason_required",
          unmet: ["Select a cancellation reason before cancelling the deal"],
        });
        return;
      }
      cancellationFunds = await capturedFundsForDeal(before);
      if (cancellationFunds.amount > 0.005) {
        const blocked = await refundBlockReason({
          dealerId,
          dealId: before.id,
          vehicleId: before.vehicleId,
        });
        if (blocked) {
          res.status(422).json({ error: "refund_window_closed", unmet: [blocked] });
          return;
        }
      }
    }
    // Commit gates (08-l6 §4b / 20-r2 §R2.2): collect EVERY unmet condition
    // and report them together as machine-readable codes in one 422, instead
    // of failing one at a time.
    if (parsed.data.stage === "committed") {
      const unmet: string[] = [];
      const messages: Record<string, string> = {};
      let belowFloorGateId: number | undefined;

      // 1. Deposit: real reservation money or an approved trusted bypass.
      const deposit = await dealDepositStatus(before, dealerId);
      if (!deposit.satisfied) {
        unmet.push("deposit_required");
        messages.deposit_required = deposit.message;
      }

      // 2. Discount gate (L6): ANY discounted deal cannot commit until a
      // manager APPROVES the below_floor_price gate — and the approval must
      // cover the CURRENT numbers (editing the discount after approval
      // invalidates the stale approval and raises a fresh gate). Below-floor
      // discounts are additionally flagged as high-priority margin breaches.
      const vehiclePrice = parsed.data.vehiclePrice ?? before.vehiclePrice;
      const discount = parsed.data.discount ?? before.discount;
      if (vehiclePrice > 0 && discount > 0) {
        const effective = vehiclePrice - discount;
        const gates = await db
          .select()
          .from(gatesTable)
          .where(
            and(
              eq(gatesTable.dealerId, dealerId),
              eq(gatesTable.type, "below_floor_price"),
              eq(gatesTable.refType, "deal"),
              eq(gatesTable.refId, before.id),
            ),
          )
          .orderBy(desc(gatesTable.id));
        const pending = gates.find((g) => g.status === "pending");
        const approvedCurrent = gates.find(
          (g) =>
            (g.status === "approved" || g.status === "adjusted") &&
            g.amount != null &&
            Math.abs(g.amount - effective) <= 0.01 + 1e-9,
        );
        if (!approvedCurrent) {
          let gateId = pending?.id;
          if (!gateId) {
            // No pending gate covering the current numbers — raise one.
            await raiseBelowFloorGateIfNeeded({
              ...before,
              vehiclePrice,
              discount,
            });
            const [fresh] = await db
              .select({ id: gatesTable.id })
              .from(gatesTable)
              .where(
                and(
                  eq(gatesTable.dealerId, dealerId),
                  eq(gatesTable.type, "below_floor_price"),
                  eq(gatesTable.refType, "deal"),
                  eq(gatesTable.refId, before.id),
                  eq(gatesTable.status, "pending"),
                ),
              )
              .orderBy(desc(gatesTable.id));
            gateId = fresh?.id;
          }
          const pct = Math.round((discount / vehiclePrice) * 1000) / 10;
          belowFloorGateId = gateId;
          unmet.push("below_floor_price");
          messages.below_floor_price =
            discount / vehiclePrice > FLOOR_DISCOUNT_RATIO
              ? `Discount ${pct}% exceeds the ${FLOOR_DISCOUNT_RATIO * 100}% floor — a sales manager must approve the below-floor price before commit`
              : `Discount ${pct}% requires manager approval — a sales manager must approve the discount before commit`;
        }
      }

      // 3. Capital order (fleet/stock-order units): a pending capital_order
      // gate on the deal's vehicle blocks commit until a manager approves it.
      const [pendingCapital] = await db
        .select({ id: gatesTable.id })
        .from(gatesTable)
        .where(
          and(
            eq(gatesTable.dealerId, dealerId),
            eq(gatesTable.type, "capital_order"),
            eq(gatesTable.refType, "vehicle"),
            eq(gatesTable.refId, before.vehicleId),
            eq(gatesTable.status, "pending"),
          ),
        );
      if (pendingCapital) {
        unmet.push("capital_order");
        messages.capital_order =
          "This unit is on a capital stock order awaiting manager approval — the capital_order gate must be approved before the deal can commit";
      }

      // 4. Financed settle gate (L6): a bank-financed deal can only commit
      // once its finance application is approved or disbursed by the LOS.
      const method =
        parsed.data.finalPaymentMethod ?? before.finalPaymentMethod;
      if (method === "bank_financing") {
        const app = await approvedFinanceAppForDeal(before);
        if (!app) {
          unmet.push("financing_not_approved");
          messages.financing_not_approved =
            "A finance application linked to this deal must be approved or disbursed before a bank-financed deal can commit";
        }
      }

      // 5. Full settlement (dealer policy): a deal may only commit once the
      // customer's balance is fully paid. The settlement invoice is created
      // here (if it doesn't exist yet) so Finance can collect against it —
      // its amount already nets the reservation credit, trade-in value and
      // any approved financed facility.
      const settlementInvoice = await ensureFinalInvoiceForDeal({
        ...before,
        finalPaymentMethod: method,
      });
      if (settlementInvoice && settlementInvoice.status !== "void") {
        const [{ paid: settledPaid }] = await db
          .select({
            paid: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)::float`,
          })
          .from(paymentsTable)
          .where(
            and(
              eq(paymentsTable.invoiceId, settlementInvoice.id),
              eq(paymentsTable.dealerId, dealerId),
            ),
          );
        const outstanding =
          Math.round((settlementInvoice.amount - (settledPaid ?? 0)) * 100) /
          100;
        if (outstanding > 0.005) {
          unmet.push("full_payment_required");
          messages.full_payment_required = `GY$${outstanding.toLocaleString("en-US", { maximumFractionDigits: 0 })} is still outstanding on settlement invoice ${settlementInvoice.invoiceNumber} — the full amount must be received before the deal can commit`;
        }
      }

      if (unmet.length > 0) {
        res.status(422).json({
          error: "commit_blocked",
          unmet,
          messages,
          ...(belowFloorGateId != null
            ? { gate: "below_floor_price", gateId: belowFloorGateId }
            : {}),
        });
        return;
      }
    }
    // A11 VIN allocation (L5): committing hard-locks the physical unit.
    // Runs BEFORE the deal row is written so a deal can never sit in
    // "committed" without its VIN actually locked.
    if (parsed.data.stage === "committed") {
      const allocation = await allocateVehicleOnCommit(
        before,
        dealerId,
        dealActor(res),
      );
      if (!allocation.ok) {
        res.status(allocation.status).json(allocation.body);
        return;
      }
    }
  }

  // Keep the advisor user ID in sync when the advisor name changes without
  // an explicit ID (legacy callers send only the display name). Explicitly
  // clear the ID when the new name doesn't resolve, so a stale ID from the
  // previous advisor never survives a rename.
  const updateValues: Partial<typeof dealsTable.$inferInsert> = {
    ...parsed.data,
  };
  if (
    parsed.data.salesAdvisor !== undefined &&
    parsed.data.salesAdvisorUserId === undefined
  ) {
    updateValues.salesAdvisorUserId = await resolveDealerUserIdByName(
      dealerId,
      parsed.data.salesAdvisor,
    );
  }

  const [deal] = await db
    .update(dealsTable)
    .set(updateValues)
    .where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.dealerId, dealerId)))
    .returning();

  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  if (before) onDealStageChanged(before, deal);

  // Lead-link timeline events: attach, detach, or re-attach (both).
  if (before && parsed.data.leadId !== undefined && before.leadId !== deal.leadId) {
    const actor = dealActor(res);
    if (before.leadId != null) {
      const prevLead = await findDealerLead(before.leadId, dealerId);
      if (prevLead) await logDealLinkEvent(prevLead, deal, "deal_detached", actor);
    }
    if (attachLead) await logDealLinkEvent(attachLead, deal, "deal_attached", actor);
  }

  await raiseBelowFloorGateIfNeeded(deal);

  // Cancel & Refund side effects (L9). With captured funds the money and the
  // hold both wait on a manager-approved refund_release gate; with nothing
  // captured the unit releases immediately. History is retained either way.
  if (before && before.stage !== "cancelled" && deal.stage === "cancelled") {
    const actor = dealActor(res);
    const funds = cancellationFunds ?? (await capturedFundsForDeal(before));
    if (funds.amount > 0.005) {
      const gateId = await raiseRefundReleaseGate({
        dealerId,
        refType: "deal",
        refId: deal.id,
        customerId: deal.customerId,
        customerName: deal.customerName,
        amount: funds.amount,
        reasonCode: deal.cancellationReason ?? "other",
        reasonNote: deal.cancellationNote,
        evidence: [
          { label: "Deal", value: `#${deal.id}` },
          { label: "Invoices", value: funds.invoiceNumbers.join(", ") || "—" },
          { label: "Invoice ID", value: String(funds.invoiceIds[0] ?? "") },
          { label: "Vehicle hold", value: "Held until refund release is approved" },
        ],
      });
      await logCancellationEvent({
        dealerId,
        customerId: deal.customerId,
        refType: "deal",
        refId: deal.id,
        title: "Deal cancelled — refund release pending",
        detail: `Cancellation (${deal.cancellationReason ?? "other"}) recorded with ${money(funds.amount)} captured. Refund gate #${gateId} raised for manager approval; the vehicle hold stays in place until it is approved.`,
        actor,
      });
    } else {
      const { vehicleReleased } = await cascadeDealCancellation({
        deal,
        reasonCode: deal.cancellationReason ?? "other",
        reasonNote: deal.cancellationNote,
        releaseVehicle: true,
        actor,
      });
      await logCancellationEvent({
        dealerId,
        customerId: deal.customerId,
        refType: "deal",
        refId: deal.id,
        title: "Deal cancelled",
        detail: `Cancellation (${deal.cancellationReason ?? "other"}) recorded with no captured funds. ${vehicleReleased ? "The vehicle is back in available stock." : "The vehicle hold was left in place (another active booking or non-held status)."}`,
        actor,
      });
    }
  }

  // Delivering marks the unit sold (commit already VIN-locked it → booked).
  if (before && before.stage !== deal.stage) {
    if (deal.stage === "delivered") {
      await db
        .update(vehiclesTable)
        .set({ status: "sold" })
        .where(
          and(
            eq(vehiclesTable.id, deal.vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
    }
  }

  // Cash decision / commitment → kick off the delivery workflow.
  if (before && before.stage !== "committed" && deal.stage === "committed") {
    // Dual-invoice #2 (L6): the final settlement invoice is generated at
    // commit time (otd − reservation − trade-in − financed portion).
    try {
      await ensureFinalInvoiceForDeal(deal);
    } catch (err) {
      req.log.error({ err, dealId: deal.id }, "final invoice generation failed");
    }
    void ensureDeliveryForDeal(deal.id, {
      cause: `Deal #${deal.id} committed`,
    }).catch(() => undefined);
  }

  res.json(UpdateDealResponse.parse(deal));
});

export default router;
