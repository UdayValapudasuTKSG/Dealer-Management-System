import { Router, type IRouter } from "express";
import { eq, desc, and, inArray } from "drizzle-orm";
import {
  db,
  dealsTable,
  vehiclesTable,
  bookingsTable,
  gatesTable,
  leadsTable,
  timelineEventsTable,
  VIN_LENGTH,
  REGISTRATION_PATTERN,
} from "@workspace/db";
import { isAgentEnabled, recordAgentRun } from "../lib/agent-governance";
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
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

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
  const unmet: string[] = [];
  if (!vehicle.vin || vehicle.vin.length !== VIN_LENGTH)
    unmet.push(`VIN must be exactly ${VIN_LENGTH} characters before allocation`);
  if (!vehicle.engineNumber || vehicle.engineNumber.length !== VIN_LENGTH)
    unmet.push(`Engine number must be exactly ${VIN_LENGTH} characters before allocation`);
  if (vehicle.registration && !REGISTRATION_PATTERN.test(vehicle.registration))
    unmet.push("Registration must be 3 uppercase letters followed by 1-4 digits");
  if (unmet.length) {
    return {
      ok: false,
      status: 422,
      body: { error: "vehicle_identity_invalid", unmet },
    };
  }

  // Recall/damage monitor: flagged units block commit behind an advisory
  // gate until inventory clears the flag.
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

  // Race-safe hard lock: the conditional UPDATE is the allocation — first
  // writer wins, a concurrent commit on the same VIN matches zero rows.
  const holdUntil = new Date(Date.now() + VIN_LOCK_HOLD_HOURS * 3600 * 1000);
  const locked = await db
    .update(vehiclesTable)
    .set({ status: "booked", holdUntil, holdReason: "vin_lock" })
    .where(
      and(
        eq(vehiclesTable.id, vehicle.id),
        eq(vehiclesTable.dealerId, dealerId),
        inArray(vehiclesTable.status, ["available", "reserved"]),
      ),
    )
    .returning({ id: vehiclesTable.id });

  if (!locked.length) {
    // Already booked is fine only when this deal's own paid pre-book locked
    // it (booking → deal auto-desk path); anything else is a real conflict.
    if (vehicle.status === "booked") {
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
    return {
      ok: false,
      status: 409,
      body: {
        error: "vehicle_unavailable",
        detail: `This unit is ${vehicle.status} and cannot be allocated to deal #${deal.id} — pick another VIN`,
      },
    };
  }

  // Audit: deterministic A11 run (advisory-off dealers still allocate — the
  // state machine is core; the kill switch only silences the agent audit).
  if (await isAgentEnabled(dealerId, "inventory")) {
    await recordAgentRun({
      dealerId,
      agentKey: "inventory",
      runType: "vin_allocation",
      inputSource: "deal_commit",
      inputSummary: `Deal #${deal.id} committed — allocating VIN ${vehicle.vin}`,
      outputSummary: `VIN ${vehicle.vin} hard-locked (${vehicle.status} → booked, hold ${VIN_LOCK_HOLD_HOURS}h)`,
      confidence: 100,
      mutation: true,
      refType: "vehicle",
      refId: vehicle.id,
      latencyMs: Date.now() - started,
      changeSummary: `vehicle.status ${vehicle.status} → booked`,
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
        detail: `Deal #${deal.id} commit locked VIN ${vehicle.vin} (${vehicle.year} ${vehicle.make} ${vehicle.model}) — status ${vehicle.status} → booked.`,
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
  const floor = deal.vehiclePrice * (1 - FLOOR_DISCOUNT_RATIO);
  const effective = deal.vehiclePrice - deal.discount;
  if (effective >= floor) return;

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
    priority: "high",
    customerId: deal.customerId ?? null,
    customerName: deal.customerName,
    refType: "deal",
    refId: deal.id,
    title: `Below-floor price — ${deal.customerName ?? `Deal #${deal.id}`}`,
    summary: `Discount of ${money(deal.discount)} takes the selling price to ${money(effective)}, below the ${money(floor)} floor (${FLOOR_DISCOUNT_RATIO * 100}% margin guard).`,
    recommendation:
      "Approve the discount, adjust it back above floor, or dismiss if the numbers were entered in error.",
    amount: effective,
    floorAmount: floor,
    evidence: [
      { label: "Vehicle price", value: money(deal.vehiclePrice) },
      { label: "Discount", value: money(deal.discount) },
      { label: "Effective price", value: money(effective) },
      { label: "Floor price", value: money(floor) },
    ],
  });
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

  if (before && parsed.data.stage && parsed.data.stage !== before.stage) {
    const fromIdx = DEAL_STAGE_ORDER.indexOf(before.stage);
    const toIdx = DEAL_STAGE_ORDER.indexOf(parsed.data.stage);
    if (fromIdx !== -1 && toIdx !== -1 && toIdx !== fromIdx + 1 && toIdx !== fromIdx - 1) {
      res.status(422).json({
        error: `Deals move one stage at a time (${before.stage} → ${parsed.data.stage} is not allowed)`,
      });
      return;
    }
    // Deposit gate: a deal can't be committed until the deposit is recorded.
    if (
      parsed.data.stage === "committed" &&
      !(parsed.data.depositPaid ?? before.depositPaid)
    ) {
      res.status(422).json({
        error: "Deposit must be recorded before committing the deal",
      });
      return;
    }
    // Below-floor gate (L6): a deal discounted past the 5% floor cannot
    // commit until a manager APPROVES the below_floor_price gate — and the
    // approval must cover the CURRENT numbers (editing the discount after
    // approval invalidates the stale approval and raises a fresh gate).
    if (parsed.data.stage === "committed") {
      const vehiclePrice = parsed.data.vehiclePrice ?? before.vehiclePrice;
      const discount = parsed.data.discount ?? before.discount;
      if (
        vehiclePrice > 0 &&
        discount / vehiclePrice > FLOOR_DISCOUNT_RATIO
      ) {
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
          res.status(422).json({
            gate: "below_floor_price",
            gateId,
            unmet: [
              `Discount ${pct}% exceeds the ${FLOOR_DISCOUNT_RATIO * 100}% floor — a sales manager must approve the below-floor price before commit`,
            ],
          });
          return;
        }
      }
    }
    // Financed settle gate (L6): a bank-financed deal can only commit once
    // its finance application is approved or disbursed by the LOS.
    const method =
      parsed.data.finalPaymentMethod ?? before.finalPaymentMethod;
    if (parsed.data.stage === "committed" && method === "bank_financing") {
      const app = await approvedFinanceAppForDeal(before);
      if (!app) {
        res.status(422).json({
          error: "financing_not_approved",
          unmet: [
            "A finance application linked to this deal must be approved or disbursed before a bank-financed deal can commit",
          ],
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
