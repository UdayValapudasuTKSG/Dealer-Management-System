import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, dealsTable } from "@workspace/db";
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

const router: IRouter = Router();

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

  const [deal] = await db
    .insert(dealsTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();

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

  const [deal] = await db
    .update(dealsTable)
    .set(parsed.data)
    .where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.dealerId, dealerId)))
    .returning();

  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  if (before) onDealStageChanged(before, deal);

  // Cash decision / commitment → kick off the delivery workflow.
  if (before && before.stage !== "committed" && deal.stage === "committed") {
    void ensureDeliveryForDeal(deal.id, {
      cause: `Deal #${deal.id} committed`,
    }).catch(() => undefined);
  }

  res.json(UpdateDealResponse.parse(deal));
});

export default router;
