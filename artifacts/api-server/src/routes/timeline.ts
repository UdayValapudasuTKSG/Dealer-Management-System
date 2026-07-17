import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, timelineEventsTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  ListTimelineQueryParams,
  ListTimelineResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/timeline", async (req, res): Promise<void> => {
  const query = ListTimelineQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { customerId, limit } = query.data;
  const dealerId = activeDealerId(res);

  const rows = await db
    .select()
    .from(timelineEventsTable)
    .where(
      customerId !== undefined
        ? and(
            eq(timelineEventsTable.dealerId, dealerId),
            eq(timelineEventsTable.customerId, customerId),
          )
        : eq(timelineEventsTable.dealerId, dealerId),
    )
    .orderBy(desc(timelineEventsTable.createdAt))
    .limit(limit ?? 40);

  res.json(ListTimelineResponse.parse(rows));
});

export default router;
