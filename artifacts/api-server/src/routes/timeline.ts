import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, timelineEventsTable } from "@workspace/db";
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

  const rows = await db
    .select()
    .from(timelineEventsTable)
    .where(
      customerId !== undefined
        ? eq(timelineEventsTable.customerId, customerId)
        : undefined,
    )
    .orderBy(desc(timelineEventsTable.createdAt))
    .limit(limit ?? 40);

  res.json(ListTimelineResponse.parse(rows));
});

export default router;
