import { Router, type IRouter } from "express";
import { and, avg, eq, gte } from "drizzle-orm";
import {
  db,
  leadsTable,
  dealsTable,
  vehiclesTable,
  serviceOrdersTable,
  agentsTable,
  agentRunsTable,
  invoicesTable,
  paymentsTable,
  tasksTable,
  testDrivesTable,
  divisionsTable,
  deliveriesTable,
} from "@workspace/db";
import { activeDealerId, type AuthedUser } from "../middlewares/rbac";
import type { Response } from "express";
import {
  GetDashboardSummaryResponse,
  GetPipelineResponse,
  GetSalesPerformanceResponse,
  GetInventoryBreakdownResponse,
  GetPredictiveAnalyticsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const PIPELINE_PHASES: { phase: string; label: string }[] = [
  { phase: "new", label: "New" },
  { phase: "contacted", label: "Contacted" },
  { phase: "qualified", label: "Qualified" },
  { phase: "proposal", label: "Proposal" },
  { phase: "negotiation", label: "Negotiation" },
  { phase: "won", label: "Won" },
];

const ACTIVE_DEAL_STAGES = ["desking", "committed"];
const CLOSED_SERVICE = ["resolved", "closed"];

/* Server-enforced persona scoping. Manager roles see dealership-wide
   aggregates; everyone else gets numbers computed ONLY over records assigned
   to them. Mirrors the client-side BROAD_VIEW_ROLES set, but enforced here so
   an advisor's dashboard payloads are curtailed regardless of the client. */
const BROAD_VIEW_ROLES = new Set([
  "General Manager",
  "Sales Manager",
  "Service Manager",
  "Finance Manager",
]);

type Scope = { broad: true } | { broad: false; userId: number; nameKey: string | null };

function requestScope(res: Response): Scope {
  const user = res.locals.user as AuthedUser | undefined;
  if (user && (user.isSuperAdmin || BROAD_VIEW_ROLES.has(user.roleName ?? "")))
    return { broad: true };
  // Deny-by-default: unknown/advisor users are scoped to their own records.
  return {
    broad: false,
    userId: user?.id ?? -1,
    nameKey: user?.name?.trim().toLowerCase() || null,
  };
}

/* Match by user ID first; fall back to display name only for records that
   predate assignee user IDs (same semantics as the client filter). */
function assignedToMe(
  scope: Scope,
  assigneeUserId: number | null | undefined,
  assigneeName: string | null | undefined,
): boolean {
  if (scope.broad) return true;
  if (assigneeUserId != null) return assigneeUserId === scope.userId;
  return (
    scope.nameKey != null &&
    (assigneeName ?? "").trim().toLowerCase() === scope.nameKey
  );
}

const scopeLeads = <T extends { ownerUserId: number | null; assignedTo: string | null }>(
  scope: Scope,
  rows: T[],
): T[] => (scope.broad ? rows : rows.filter((l) => assignedToMe(scope, l.ownerUserId, l.assignedTo)));

const scopeDeals = <T extends { salesAdvisorUserId: number | null; salesAdvisor: string | null }>(
  scope: Scope,
  rows: T[],
): T[] => (scope.broad ? rows : rows.filter((d) => assignedToMe(scope, d.salesAdvisorUserId, d.salesAdvisor)));

const scopeServiceOrders = <T extends { technicianUserId: number | null; technician: string | null }>(
  scope: Scope,
  rows: T[],
): T[] => (scope.broad ? rows : rows.filter((s) => assignedToMe(scope, s.technicianUserId, s.technician)));

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const scope = requestScope(res);
  const [
    allLeads,
    allDeals,
    vehicles,
    allServiceOrders,
    agents,
    invoices,
    payments,
    tasks,
    testDrives,
  ] = await Promise.all([
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId)),
    db
      .select()
      .from(serviceOrdersTable)
      .where(eq(serviceOrdersTable.dealerId, dealerId)),
    db.select().from(agentsTable).where(eq(agentsTable.dealerId, dealerId)),
    db.select().from(invoicesTable).where(eq(invoicesTable.dealerId, dealerId)),
    db.select().from(paymentsTable).where(eq(paymentsTable.dealerId, dealerId)),
    db.select().from(tasksTable).where(eq(tasksTable.dealerId, dealerId)),
    db
      .select()
      .from(testDrivesTable)
      .where(eq(testDrivesTable.dealerId, dealerId)),
  ]);

  // Real agent latency over the last 7 days of this dealer's runs.
  // No runs in the window → 0, never a placeholder.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [latency] = await db
    .select({ avgMs: avg(agentRunsTable.latencyMs) })
    .from(agentRunsTable)
    .where(
      and(
        eq(agentRunsTable.dealerId, dealerId),
        gte(agentRunsTable.createdAt, since),
      ),
    );
  const avgResponseSeconds = latency?.avgMs
    ? Math.round((Number(latency.avgMs) / 1000) * 10) / 10
    : 0;

  const leads = scopeLeads(scope, allLeads);
  const deals = scopeDeals(scope, allDeals);
  const serviceOrders = scopeServiceOrders(scope, allServiceOrders);

  const totalLeads = leads.length;
  const wonLeads = leads.filter((l) => l.phase === "won" || l.status === "converted").length;
  const activeDeals = deals.filter((d) => ACTIVE_DEAL_STAGES.includes(d.stage)).length;
  const inventoryCount = vehicles.filter((v) => v.status === "available").length;
  const now = new Date();
  const monthlyRevenue = deals
    .filter((d) => {
      if (d.stage !== "delivered") return false;
      const created = new Date(d.createdAt);
      return (
        created.getFullYear() === now.getFullYear() &&
        created.getMonth() === now.getMonth()
      );
    })
    .reduce((sum, d) => sum + (d.otdPrice || 0), 0);
  const serviceOrdersOpen = serviceOrders.filter(
    (s) => !CLOSED_SERVICE.includes(s.status),
  ).length;
  const agentTasksToday = agents.reduce((sum, a) => sum + a.tasksToday, 0);
  const conversionRate = totalLeads
    ? Math.round((wonLeads / totalLeads) * 1000) / 10
    : 0;

  /* --- R5 additions: MTD output, inventory value, AR, today's schedule --- */
  const GUYANA_OFFSET_MS = 4 * 3600 * 1000; // GMT-4, no DST
  const guyanaDayKey = (d: Date | string) =>
    new Date(new Date(d).getTime() - GUYANA_OFFSET_MS).toISOString().slice(0, 10);
  const guyanaMonth = (d: Date | string) => guyanaDayKey(d).slice(0, 7);
  const todayKey = guyanaDayKey(now);
  const thisMonth = guyanaMonth(now);
  const prevMonth = guyanaMonth(
    new Date(now.getFullYear(), now.getMonth() - 1, 15),
  );

  const deliveredMtd = deals.filter(
    (d) => d.stage === "delivered" && guyanaMonth(d.createdAt) === thisMonth,
  );
  const deliveredPrev = deals.filter(
    (d) => d.stage === "delivered" && guyanaMonth(d.createdAt) === prevMonth,
  );
  const mtdUnits = deliveredMtd.length;
  const mtdGross = deliveredMtd.reduce((s, d) => s + (d.otdPrice || 0), 0);
  const prevGross = deliveredPrev.reduce((s, d) => s + (d.otdPrice || 0), 0);
  const leadsMtd = leads.filter((l) => guyanaMonth(l.createdAt) === thisMonth).length;
  const leadsPrev = leads.filter((l) => guyanaMonth(l.createdAt) === prevMonth).length;

  const availableInventoryValue = vehicles
    .filter((v) => v.status === "available")
    .reduce((s, v) => s + (v.price || 0), 0);

  const paidByInvoice = new Map<number, number>();
  for (const p of payments)
    paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + p.amount);
  const outstandingAr = invoices
    .filter((i) => !["paid", "void"].includes(i.status))
    .reduce((s, i) => s + Math.max(0, i.amount - (paidByInvoice.get(i.id) ?? 0)), 0);

  /* Persona-scope the schedule: advisors count only their own tasks and
     appointments; managers count those tied to their division's leads. */
  const scopedLeadIds = new Set(leads.map((l) => l.id));
  const scopedTasks = tasks.filter((t) =>
    scope.broad ? true : t.assigneeUserId === scope.userId,
  );
  const scopedTestDrives = testDrives.filter((t) =>
    scope.broad ? true : t.leadId != null && scopedLeadIds.has(t.leadId),
  );
  const todayTasks = scopedTasks.filter(
    (t) => t.status !== "done" && t.dueDate === todayKey,
  ).length;
  const todayAppointments = scopedTestDrives.filter(
    (t) =>
      !["cancelled", "expired"].includes(t.status) &&
      guyanaDayKey(t.scheduledAt) === todayKey,
  ).length;

  const deltaPct = (cur: number, prev: number) =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0;

  const summary = {
    totalLeads,
    activeDeals,
    inventoryCount,
    monthlyRevenue,
    serviceOrdersOpen,
    agentTasksToday,
    conversionRate,
    avgResponseSeconds,
    mtdUnits,
    mtdGross,
    availableInventoryValue,
    outstandingAr,
    todayTasks,
    todayAppointments,
    deltas: {
      leads: deltaPct(leadsMtd, leadsPrev),
      units: deltaPct(mtdUnits, deliveredPrev.length),
      gross: deltaPct(mtdGross, prevGross),
    },
  };

  res.json(GetDashboardSummaryResponse.parse(summary));
});

router.get("/dashboard/pipeline", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const scope = requestScope(res);
  const [allLeads, vehicles] = await Promise.all([
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
    db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId)),
  ]);
  const leads = scopeLeads(scope, allLeads);
  const priceById = new Map(vehicles.map((v) => [v.id, v.price]));

  const stages = PIPELINE_PHASES.map(({ phase, label }) => {
    const matching = leads.filter((l) => l.phase === phase);
    const value = matching.reduce(
      (sum, l) =>
        sum + (l.interestedVehicleId ? (priceById.get(l.interestedVehicleId) ?? 0) : 0),
      0,
    );
    return { phase, label, count: matching.length, value };
  });

  res.json(GetPipelineResponse.parse(stages));
});

router.get("/dashboard/sales-performance", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const scope = requestScope(res);
  const user = res.locals.user as AuthedUser | undefined;
  const [allDeals, allLeads, divisions, allDeliveries] = await Promise.all([
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
    db.select().from(divisionsTable).where(eq(divisionsTable.dealerId, dealerId)),
    db
      .select()
      .from(deliveriesTable)
      .where(eq(deliveriesTable.dealerId, dealerId)),
  ]);
  const deliveredAtByDeal = new Map<number, Date>();
  for (const dl of allDeliveries)
    if (dl.deliveredAt) deliveredAtByDeal.set(dl.dealId, dl.deliveredAt);
  const deals = scopeDeals(scope, allDeals);
  const leads = scopeLeads(scope, allLeads);
  const closed = deals.filter(
    (d) => d.stage === "delivered" || d.stage === "committed",
  );

  const now = new Date();
  const months: { key: string; month: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      month: d.toLocaleString("en-US", { month: "short" }),
    });
  }

  const series = months.map(({ key, month }) => {
    const inMonth = closed.filter((d) => {
      const created = new Date(d.createdAt);
      return `${created.getFullYear()}-${created.getMonth()}` === key;
    });
    return {
      month,
      revenue: inMonth.reduce((sum, d) => sum + (d.otdPrice || 0), 0),
      units: inMonth.length,
    };
  });

  /* Leaderboard over the persona-scoped deal set (advisors see only their
     own row; managers/leadership see everyone). */
  const dayDiff = (a: Date | string, b: Date | string) =>
    Math.max(
      0,
      Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000),
    );
  const meNameKey = user?.name?.trim().toLowerCase() || null;
  const byAdvisor = new Map<
    string,
    {
      units: number;
      gross: number;
      discount: number;
      deals: number;
      won: number;
      cycle: number[];
      isMe: boolean;
    }
  >();
  for (const d of deals) {
    const key = d.salesAdvisor?.trim() || "Unassigned";
    const e =
      byAdvisor.get(key) ??
      {
        units: 0,
        gross: 0,
        discount: 0,
        deals: 0,
        won: 0,
        cycle: [],
        isMe:
          (d.salesAdvisorUserId != null && d.salesAdvisorUserId === user?.id) ||
          (meNameKey != null && key.toLowerCase() === meNameKey),
      };
    e.deals += 1;
    e.discount += d.discount || 0;
    if (d.stage === "delivered") {
      e.units += 1;
      e.gross += d.otdPrice || 0;
      e.won += 1;
      const dAt = deliveredAtByDeal.get(d.id);
      if (dAt) e.cycle.push(dayDiff(d.createdAt, dAt));
    } else if (d.stage === "committed") e.won += 1;
    byAdvisor.set(key, e);
  }
  const leaderboard = [...byAdvisor.entries()]
    .sort((a, b) => b[1].gross - a[1].gross)
    .map(([name, e]) => ({
      name,
      units: e.units,
      gross: e.gross,
      avgDiscount: e.deals ? Math.round(e.discount / e.deals) : 0,
      closeRate: e.deals ? Math.round((e.won / e.deals) * 1000) / 10 : 0,
      avgCycleDays: e.cycle.length
        ? Math.round(e.cycle.reduce((a, b) => a + b, 0) / e.cycle.length)
        : 0,
      isMe: e.isMe,
    }));

  const OPEN_PHASES = ["new", "contacted", "qualified", "proposal", "negotiation"];
  const divisionRows = [
    ...divisions.map((dv) => ({ divisionId: dv.id as number | null, name: dv.name })),
    { divisionId: null as number | null, name: "Unassigned" },
  ].map((dv) => {
    const dvDeals = deals.filter(
      (d) => d.stage === "delivered" && (d.divisionId ?? null) === dv.divisionId,
    );
    return {
      divisionId: dv.divisionId,
      name: dv.name,
      units: dvDeals.length,
      gross: dvDeals.reduce((s, d) => s + (d.otdPrice || 0), 0),
      openLeads: leads.filter(
        (l) =>
          OPEN_PHASES.includes(l.phase) && (l.divisionId ?? null) === dv.divisionId,
      ).length,
    };
  });
  const divisionsOut = divisionRows.filter(
    (d) => d.divisionId != null || d.units > 0 || d.openLeads > 0,
  );

  res.json(
    GetSalesPerformanceResponse.parse({
      series,
      leaderboard,
      divisions: divisionsOut,
    }),
  );
});

function linearRegression(ys: number[]): {
  slope: number;
  intercept: number;
  r2: number;
} {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0], r2: 0 };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - meanX) * (ys[i] - meanY);
    sxx += (i - meanX) ** 2;
    syy += (ys[i] - meanY) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, r2 };
}

function trendOf(slope: number, mean: number): "up" | "down" | "flat" {
  const threshold = Math.max(Math.abs(mean) * 0.03, 1e-9);
  if (slope > threshold) return "up";
  if (slope < -threshold) return "down";
  return "flat";
}

function confidenceOf(r2: number, samples: number): number {
  const base = 45 + r2 * 45 + Math.min(samples, 6) * 1.5;
  return Math.round(Math.min(95, Math.max(40, base)));
}

const HISTORY_MONTHS = 6;
const PROJECTION_MONTHS = 3;

router.get("/dashboard/predictions", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const scope = requestScope(res);
  const [allDeals, allLeads] = await Promise.all([
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
  ]);
  const deals = scopeDeals(scope, allDeals);
  const leads = scopeLeads(scope, allLeads);
  const closed = deals.filter(
    (d) => d.stage === "delivered" || d.stage === "committed",
  );

  const now = new Date();
  const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
  const monthLabel = (d: Date) =>
    d.toLocaleString("en-US", { month: "short" });

  const history: { month: string; revenue: number; units: number; leadCount: number; conversion: number }[] = [];
  for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    const inMonth = closed.filter((x) => monthKey(new Date(x.createdAt)) === key);
    const leadsInMonth = leads.filter(
      (l) => monthKey(new Date(l.createdAt)) === key,
    );
    const wonInMonth = leadsInMonth.filter(
      (l) => l.phase === "won" || l.status === "converted",
    ).length;
    history.push({
      month: monthLabel(d),
      revenue: inMonth.reduce((sum, x) => sum + (x.otdPrice || 0), 0),
      units: inMonth.length,
      leadCount: leadsInMonth.length,
      conversion: leadsInMonth.length
        ? Math.round((wonInMonth / leadsInMonth.length) * 1000) / 10
        : 0,
    });
  }

  const revenueReg = linearRegression(history.map((h) => h.revenue));
  const unitsReg = linearRegression(history.map((h) => h.units));
  const leadsReg = linearRegression(history.map((h) => h.leadCount));
  const convReg = linearRegression(history.map((h) => h.conversion));

  const project = (
    reg: { slope: number; intercept: number },
    x: number,
  ): number => Math.max(0, reg.slope * x + reg.intercept);

  const forecast = history.map((h, i) => ({
    month: h.month,
    revenue: h.revenue,
    units: h.units,
    projectedRevenue:
      i === history.length - 1 ? h.revenue : null,
    projectedUnits: i === history.length - 1 ? h.units : null,
    isProjection: false,
  })) as {
    month: string;
    revenue: number | null;
    units: number | null;
    projectedRevenue: number | null;
    projectedUnits: number | null;
    isProjection: boolean;
  }[];

  for (let j = 1; j <= PROJECTION_MONTHS; j++) {
    const d = new Date(now.getFullYear(), now.getMonth() + j, 1);
    forecast.push({
      month: monthLabel(d),
      revenue: null,
      units: null,
      projectedRevenue: Math.round(project(revenueReg, HISTORY_MONTHS - 1 + j)),
      projectedUnits: Math.round(project(unitsReg, HISTORY_MONTHS - 1 + j) * 10) / 10,
      isProjection: true,
    });
  }

  const last = history[history.length - 1];
  const nextX = HISTORY_MONTHS;
  const meanRevenue =
    history.reduce((s, h) => s + h.revenue, 0) / history.length;
  const meanUnits = history.reduce((s, h) => s + h.units, 0) / history.length;
  const meanLeads =
    history.reduce((s, h) => s + h.leadCount, 0) / history.length;
  const meanConv =
    history.reduce((s, h) => s + h.conversion, 0) / history.length;

  const metrics = [
    {
      key: "revenue",
      label: "Revenue Next Month",
      current: last.revenue,
      predicted: Math.round(project(revenueReg, nextX)),
      unit: "currency",
      trend: trendOf(revenueReg.slope, meanRevenue),
      confidence: confidenceOf(revenueReg.r2, HISTORY_MONTHS),
    },
    {
      key: "units",
      label: "Units Next Month",
      current: last.units,
      predicted: Math.round(project(unitsReg, nextX) * 10) / 10,
      unit: "count",
      trend: trendOf(unitsReg.slope, meanUnits),
      confidence: confidenceOf(unitsReg.r2, HISTORY_MONTHS),
    },
    {
      key: "leads",
      label: "Lead Volume Next Month",
      current: last.leadCount,
      predicted: Math.round(project(leadsReg, nextX) * 10) / 10,
      unit: "count",
      trend: trendOf(leadsReg.slope, meanLeads),
      confidence: confidenceOf(leadsReg.r2, HISTORY_MONTHS),
    },
    {
      key: "conversion",
      label: "Conversion Forecast",
      current: last.conversion,
      predicted: Math.min(100, Math.round(project(convReg, nextX) * 10) / 10),
      unit: "percent",
      trend: trendOf(convReg.slope, meanConv),
      confidence: confidenceOf(convReg.r2, HISTORY_MONTHS),
    },
  ];

  res.json(
    GetPredictiveAnalyticsResponse.parse({
      forecast,
      metrics,
      generatedAt: new Date().toISOString(),
    }),
  );
});

router.get("/dashboard/inventory-breakdown", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.dealerId, dealerId));
  const now = new Date();
  const dayDiff = (a: Date | string) =>
    Math.max(
      0,
      Math.round((now.getTime() - new Date(a).getTime()) / 86400000),
    );
  const inStock = vehicles.filter(
    (v) => !["sold", "delivered"].includes(v.status),
  );

  const statusMap = new Map<string, { count: number; value: number }>();
  for (const v of vehicles) {
    const e = statusMap.get(v.status) ?? { count: 0, value: 0 };
    e.count += 1;
    e.value += v.price || 0;
    statusMap.set(v.status, e);
  }
  const byStatus = [...statusMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([status, e]) => ({ status, count: e.count, value: e.value }));

  const counts = new Map<string, number>();
  for (const v of vehicles) {
    counts.set(v.powertrain, (counts.get(v.powertrain) ?? 0) + 1);
  }
  const byPowertrain = Array.from(counts.entries()).map(
    ([powertrain, count]) => ({ powertrain, count }),
  );

  const BUCKETS = [
    { bucket: "0-30 d", min: 0, max: 30 },
    { bucket: "31-60 d", min: 31, max: 60 },
    { bucket: "61-90 d", min: 61, max: 90 },
    { bucket: "90+ d", min: 91, max: Infinity },
  ];
  const aging = BUCKETS.map((b) => {
    const rows = inStock.filter((v) => {
      const d = dayDiff(v.createdAt);
      return d >= b.min && d <= b.max;
    });
    return {
      bucket: b.bucket,
      count: rows.length,
      value: rows.reduce((s, v) => s + (v.price || 0), 0),
    };
  });

  const heldRows = inStock.filter(
    (v) => v.holdUntil && new Date(v.holdUntil) > now,
  );
  const holds = {
    count: heldRows.length,
    value: heldRows.reduce((s, v) => s + (v.price || 0), 0),
  };

  res.json(
    GetInventoryBreakdownResponse.parse({
      byStatus,
      byPowertrain,
      aging,
      holds,
      totalCount: inStock.length,
      totalValue: inStock.reduce((s, v) => s + (v.price || 0), 0),
    }),
  );
});

export default router;
