import { Router, type IRouter } from "express";
import { and, eq, asc } from "drizzle-orm";
import { db, agentsTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  UpdateAgentBody,
  GetAgentParams,
  UpdateAgentParams,
  ListAgentsResponse,
  GetAgentResponse,
  UpdateAgentResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/agents", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.dealerId, dealerId))
    .orderBy(asc(agentsTable.id));
  res.json(ListAgentsResponse.parse(rows));
});

router.get("/agents/:id", async (req, res): Promise<void> => {
  const params = GetAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(eq(agentsTable.id, params.data.id), eq(agentsTable.dealerId, dealerId)),
    );

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json(GetAgentResponse.parse(agent));
});

router.patch("/agents/:id", async (req, res): Promise<void> => {
  const params = UpdateAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [agent] = await db
    .update(agentsTable)
    .set(parsed.data)
    .where(
      and(eq(agentsTable.id, params.data.id), eq(agentsTable.dealerId, dealerId)),
    )
    .returning();

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json(UpdateAgentResponse.parse(agent));
});

export default router;
