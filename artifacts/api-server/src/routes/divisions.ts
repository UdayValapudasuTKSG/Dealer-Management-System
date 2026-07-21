import { Router } from "express";
import { db, divisionsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { ListDivisionsResponse } from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";

const router = Router();

router.get("/divisions", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(divisionsTable)
    .where(eq(divisionsTable.dealerId, activeDealerId(res)))
    .orderBy(asc(divisionsTable.id));
  res.json(ListDivisionsResponse.parse(rows));
});

export default router;
