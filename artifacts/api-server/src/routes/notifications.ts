import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  ListNotificationsResponse,
  MarkNotificationsReadBody,
  MarkNotificationsReadResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/notifications", async (_req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, user.id),
        eq(notificationsTable.dealerId, dealerId),
      ),
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(100);
  res.json(ListNotificationsResponse.parse(rows));
});

router.post("/notifications/read", async (req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = MarkNotificationsReadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const { ids, all } = parsed.data;
  const where = all
    ? and(
        eq(notificationsTable.userId, user.id),
        eq(notificationsTable.dealerId, dealerId),
      )
    : and(
        eq(notificationsTable.userId, user.id),
        eq(notificationsTable.dealerId, dealerId),
        inArray(notificationsTable.id, ids ?? []),
      );
  if (!all && (!ids || ids.length === 0)) {
    res.json(MarkNotificationsReadResponse.parse({ updated: 0 }));
    return;
  }
  const updated = await db
    .update(notificationsTable)
    .set({ read: true })
    .where(where)
    .returning({ id: notificationsTable.id });
  res.json(MarkNotificationsReadResponse.parse({ updated: updated.length }));
});

export default router;
