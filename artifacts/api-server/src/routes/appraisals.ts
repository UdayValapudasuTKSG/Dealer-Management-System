import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, appraisalsTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  CreateAppraisalBody,
  UpdateAppraisalBody,
  UpdateAppraisalParams,
  ListAppraisalsResponse,
  CreateAppraisalResponse,
  UpdateAppraisalResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/appraisals", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(appraisalsTable)
    .where(eq(appraisalsTable.dealerId, dealerId))
    .orderBy(desc(appraisalsTable.createdAt));
  res.json(ListAppraisalsResponse.parse(rows));
});

router.post("/appraisals", async (req, res): Promise<void> => {
  const parsed = CreateAppraisalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [appraisal] = await db
    .insert(appraisalsTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();

  res.status(201).json(CreateAppraisalResponse.parse(appraisal));
});

router.patch("/appraisals/:id", async (req, res): Promise<void> => {
  const params = UpdateAppraisalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAppraisalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [appraisal] = await db
    .update(appraisalsTable)
    .set(parsed.data)
    .where(
      and(
        eq(appraisalsTable.id, params.data.id),
        eq(appraisalsTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();

  if (!appraisal) {
    res.status(404).json({ error: "Appraisal not found" });
    return;
  }

  res.json(UpdateAppraisalResponse.parse(appraisal));
});

export default router;
