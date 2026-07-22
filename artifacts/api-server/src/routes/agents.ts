import { Router, type IRouter, type RequestHandler } from "express";
import { and, eq, asc, desc, sql } from "drizzle-orm";
import { db, agentsTable, agentRunsTable, auditLogsTable } from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  UpdateAgentBody,
  GetAgentParams,
  UpdateAgentParams,
  ListAgentsResponse,
  GetAgentResponse,
  UpdateAgentResponse,
  ListAgentRunsQueryParams,
  ListAgentRunsResponse,
  GetAgentMetricsResponse,
  ReviewAgentRunParams,
  ReviewAgentRunBody,
  ReviewAgentRunResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Governance console (runs, metrics, reviews, kill switches) is restricted
// to Admin / Leadership: super admins, dealer General Managers, and roles
// holding the settings:admin permission.
const requireGovernance: RequestHandler = (_req, res, next) => {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const dealerId = res.locals.dealerId;
  const isGm =
    user.dealers.find((d) => d.dealerId === dealerId)?.isGeneralManager ??
    false;
  const allowed =
    user.isSuperAdmin ||
    isGm ||
    user.roleName === "General Manager" ||
    hasPermission(user, "settings", "admin");
  if (!allowed) {
    res
      .status(403)
      .json({ error: "Agent governance is restricted to Admin/Leadership" });
    return;
  }
  next();
};

router.get("/agents/runs", requireGovernance, async (req, res): Promise<void> => {
  const query = ListAgentRunsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 200);
  const conditions = [eq(agentRunsTable.dealerId, dealerId)];
  if (query.data.agentKey)
    conditions.push(eq(agentRunsTable.agentKey, query.data.agentKey));
  if (query.data.status)
    conditions.push(eq(agentRunsTable.status, query.data.status));
  const rows = await db
    .select()
    .from(agentRunsTable)
    .where(and(...conditions))
    .orderBy(desc(agentRunsTable.createdAt))
    .limit(limit);
  res.json(ListAgentRunsResponse.parse(rows));
});

router.get(
  "/agents/metrics",
  requireGovernance,
  async (_req, res): Promise<void> => {
    const dealerId = activeDealerId(res);
    const rows = await db
      .select({
        agentKey: agentRunsTable.agentKey,
        runs: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'accepted')::int`,
        overridden: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'overridden')::int`,
        errors: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'error')::int`,
        blocked: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'blocked')::int`,
        avgConfidence: sql<number | null>`avg(${agentRunsTable.confidence})`,
        avgLatencyMs: sql<number | null>`avg(${agentRunsTable.latencyMs})::int`,
        lastRunAt: sql<string | null>`max(${agentRunsTable.createdAt})`,
      })
      .from(agentRunsTable)
      .where(eq(agentRunsTable.dealerId, dealerId))
      .groupBy(agentRunsTable.agentKey);
    const metrics = rows.map((r) => {
      const reviewed = r.accepted + r.overridden;
      return {
        ...r,
        acceptanceRate: reviewed > 0 ? (r.accepted / reviewed) * 100 : 0,
        avgConfidence: r.avgConfidence == null ? null : Number(r.avgConfidence),
        lastRunAt: r.lastRunAt == null ? null : new Date(r.lastRunAt).toISOString(),
      };
    });
    res.json(GetAgentMetricsResponse.parse(metrics));
  },
);

router.post(
  "/agents/runs/:id/review",
  requireGovernance,
  async (req, res): Promise<void> => {
    const params = ReviewAgentRunParams.safeParse(req.params);
    const body = ReviewAgentRunBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: (params.success ? body : params).error?.message ?? "Invalid input",
      });
      return;
    }
    const dealerId = activeDealerId(res);
    const [run] = await db
      .update(agentRunsTable)
      .set({ status: body.data.decision })
      .where(
        and(
          eq(agentRunsTable.id, params.data.id),
          eq(agentRunsTable.dealerId, dealerId),
        ),
      )
      .returning();
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const user = res.locals.user;
    await db.insert(auditLogsTable).values({
      dealerId,
      actorUserId: user?.id ?? null,
      actorClerkId: user?.clerkId ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      action: body.data.decision === "accepted" ? "approve" : "reject",
      module: "agents",
      entityType: "agent_run",
      entityId: String(run.id),
      summary: `${user?.name ?? "User"} marked ${run.agentKey} run #${run.id} ${body.data.decision}`,
    });
    res.json(ReviewAgentRunResponse.parse(run));
  },
);

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

  // NC-13: agent kill switches are a governance/platform control — dealer
  // staff (including GMs/admins) may not pause or resume agents. Platform
  // super admins operate them via PATCH /platform/dealers/:id/agents/:agentId.
  if ("status" in parsed.data && !res.locals.user?.isSuperAdmin) {
    res.status(403).json({
      error: "Agent kill switches are controlled at the platform level",
      code: "kill_switch_platform_reserved",
    });
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
