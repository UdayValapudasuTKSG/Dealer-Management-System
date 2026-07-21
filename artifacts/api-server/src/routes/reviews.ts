import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  customersTable,
  reviewsTable,
  timelineEventsTable,
} from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { ListReviewsQueryParams, CreateReviewBody } from "@workspace/api-zod";

// ---------------------------------------------------------------------------
// Customer reviews / CSAT — first-class records. Delivery completion writes
// delivery_csat rows automatically (see routes/deliveries.ts); staff can log
// manual reviews here.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

router.get("/reviews", async (req, res): Promise<void> => {
  const query = ListReviewsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const conditions = [eq(reviewsTable.dealerId, dealerId)];
  if (query.data.customerId != null)
    conditions.push(eq(reviewsTable.customerId, query.data.customerId));
  if (query.data.source)
    conditions.push(eq(reviewsTable.source, query.data.source));
  const rows = await db
    .select()
    .from(reviewsTable)
    .where(and(...conditions))
    .orderBy(desc(reviewsTable.createdAt))
    .limit(200);
  res.json(rows);
});

router.post("/reviews", async (req, res): Promise<void> => {
  const body = CreateReviewBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  let customerName = body.data.customerName ?? null;
  if (body.data.customerId != null) {
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, body.data.customerId),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    customerName = customerName ?? customer.name;
  }

  const [created] = await db
    .insert(reviewsTable)
    .values({
      dealerId,
      customerId: body.data.customerId ?? null,
      customerName,
      source: body.data.source ?? "manual",
      rating: body.data.rating,
      comment: body.data.comment ?? null,
      refType: body.data.refType ?? null,
      refId: body.data.refId ?? null,
      vehicleLabel: body.data.vehicleLabel ?? null,
      capturedBy: res.locals.user?.name ?? null,
    })
    .returning();

  if (body.data.customerId != null) {
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: body.data.customerId,
      domain: "customers",
      kind: "note",
      title: `Customer review logged (${body.data.rating}/5)`,
      detail: body.data.comment || `Review #${created!.id} captured.`,
      actor: res.locals.user?.name ?? "Staff",
      refType: "customer",
      refId: body.data.customerId,
    });
  }
  res.status(201).json(created);
});

export default router;
