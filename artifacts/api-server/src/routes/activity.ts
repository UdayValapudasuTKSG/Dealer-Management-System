import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, activityTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  ListActivityQueryParams,
  ListActivityResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/activity", async (req, res): Promise<void> => {
  const query = ListActivityQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(activityTable)
    .where(eq(activityTable.dealerId, dealerId))
    .orderBy(desc(activityTable.createdAt))
    .limit(query.data.limit ?? 30);

  res.json(ListActivityResponse.parse(rows));
});

export default router;
