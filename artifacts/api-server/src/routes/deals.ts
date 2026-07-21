import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, dealsTable, vehiclesTable, gatesTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
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
import { resolveDealerUserIdByName } from "../lib/user-lookup";
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";

const router: IRouter = Router();

// Deals move forward one stage at a time (backwards moves allowed for
// corrections back to the immediately preceding stage only).
const DEAL_STAGE_ORDER = [
  "desking",
  "negotiation",
  "finance",
  "committed",
  "delivered",
];

// Discounts beyond this share of the vehicle price raise a below-floor
// approval gate for a sales manager (the deal itself is not blocked).
const FLOOR_DISCOUNT_RATIO = 0.05;

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

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

  res.json(ListDealsResponse.parse(rows));
});

router.post("/deals", async (req, res): Promise<void> => {
  const parsed = CreateDealBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
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

  res.json(GetDealResponse.parse(deal));
});

router.patch("/deals/:id", async (req, res): Promise<void> => {
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

  const dealerId = activeDealerId(res);
  const [before] = await db
    .select()
    .from(dealsTable)
    .where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.dealerId, dealerId)));

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

  await raiseBelowFloorGateIfNeeded(deal);

  // VIN lock: committing reserves the vehicle; delivering marks it sold.
  if (before && before.stage !== deal.stage) {
    if (deal.stage === "committed") {
      await db
        .update(vehiclesTable)
        .set({ status: "reserved" })
        .where(
          and(
            eq(vehiclesTable.id, deal.vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
            eq(vehiclesTable.status, "available"),
          ),
        );
    } else if (deal.stage === "delivered") {
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
    void ensureDeliveryForDeal(deal.id, {
      cause: `Deal #${deal.id} committed`,
    }).catch(() => undefined);
  }

  res.json(UpdateDealResponse.parse(deal));
});

export default router;
