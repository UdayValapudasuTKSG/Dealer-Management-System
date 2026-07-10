import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, financeApplicationsTable } from "@workspace/db";
import {
  CreateFinanceApplicationBody,
  UpdateFinanceApplicationBody,
  UpdateFinanceApplicationParams,
  ListFinanceApplicationsResponse,
  CreateFinanceApplicationResponse,
  UpdateFinanceApplicationResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/finance-applications", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(financeApplicationsTable)
    .orderBy(desc(financeApplicationsTable.createdAt));
  res.json(ListFinanceApplicationsResponse.parse(rows));
});

router.post("/finance-applications", async (req, res): Promise<void> => {
  const parsed = CreateFinanceApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [application] = await db
    .insert(financeApplicationsTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(CreateFinanceApplicationResponse.parse(application));
});

router.patch("/finance-applications/:id", async (req, res): Promise<void> => {
  const params = UpdateFinanceApplicationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateFinanceApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [application] = await db
    .update(financeApplicationsTable)
    .set(parsed.data)
    .where(eq(financeApplicationsTable.id, params.data.id))
    .returning();

  if (!application) {
    res.status(404).json({ error: "Finance application not found" });
    return;
  }

  res.json(UpdateFinanceApplicationResponse.parse(application));
});

export default router;
