import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, serviceOrdersTable } from "@workspace/db";
import {
  CreateServiceOrderBody,
  UpdateServiceOrderBody,
  UpdateServiceOrderParams,
  ListServiceOrdersQueryParams,
  ListServiceOrdersResponse,
  CreateServiceOrderResponse,
  UpdateServiceOrderResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function toDateString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return undefined;
}

router.get("/service-orders", async (req, res): Promise<void> => {
  const query = ListServiceOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      query.data.status
        ? eq(serviceOrdersTable.status, query.data.status)
        : undefined,
    )
    .orderBy(desc(serviceOrdersTable.scheduledDate));

  res.json(ListServiceOrdersResponse.parse(rows));
});

router.post("/service-orders", async (req, res): Promise<void> => {
  const parsed = CreateServiceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [order] = await db
    .insert(serviceOrdersTable)
    .values({ ...parsed.data, scheduledDate: toDateString(parsed.data.scheduledDate)! })
    .returning();

  res.status(201).json(CreateServiceOrderResponse.parse(order));
});

router.patch("/service-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateServiceOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateServiceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { scheduledDate, ...rest } = parsed.data;
  const dateStr = toDateString(scheduledDate);

  const [order] = await db
    .update(serviceOrdersTable)
    .set(dateStr ? { ...rest, scheduledDate: dateStr } : rest)
    .where(eq(serviceOrdersTable.id, params.data.id))
    .returning();

  if (!order) {
    res.status(404).json({ error: "Service order not found" });
    return;
  }

  res.json(UpdateServiceOrderResponse.parse(order));
});

export default router;
