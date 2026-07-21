import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import {
  ListAuditLogsQueryParams,
  ListAuditLogsResponse,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();

router.get("/audit-logs", async (req, res): Promise<void> => {
  const query = ListAuditLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  // Tenancy: audit reads are always scoped to the active dealer. Cross-dealer
  // audit access exists only on super-admin platform routes.
  const conditions: SQL[] = [eq(auditLogsTable.dealerId, activeDealerId(res))];
  if (query.data.action) {
    conditions.push(eq(auditLogsTable.action, query.data.action));
  }
  if (query.data.module) {
    conditions.push(eq(auditLogsTable.module, query.data.module));
  }
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    const searchCond = or(
      ilike(auditLogsTable.summary, term),
      ilike(auditLogsTable.actorName, term),
      ilike(auditLogsTable.actorEmail, term),
    );
    if (searchCond) conditions.push(searchCond);
  }

  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(Math.min(query.data.limit ?? 200, 500));

  res.json(ListAuditLogsResponse.parse(rows));
});

export default router;
