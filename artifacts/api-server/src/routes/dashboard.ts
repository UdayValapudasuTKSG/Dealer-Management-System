import { Router, type IRouter } from "express";
import { db, leadsTable, dealsTable, vehiclesTable, serviceOrdersTable, agentsTable } from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetPipelineResponse,
  GetSalesPerformanceResponse,
  GetInventoryBreakdownResponse,
  GetPredictiveAnalyticsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const PIPELINE_PHASES: { phase: string; label: string }[] = [
  { phase: "aware", label: "Aware" },
  { phase: "consider", label: "Consider" },
  { phase: "engage", label: "Engage" },
  { phase: "negotiate", label: "Negotiate" },
  { phase: "won", label: "Won" },
];

const ACTIVE_DEAL_STAGES = ["desking", "negotiation", "finance", "committed"];
const CLOSED_SERVICE = ["completed", "delivered"];

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const [leads, deals, vehicles, serviceOrders, agents] = await Promise.all([
    db.select().from(leadsTable),
    db.select().from(dealsTable),
    db.select().from(vehiclesTable),
    db.select().from(serviceOrdersTable),
    db.select().from(agentsTable),
  ]);

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

  const summary = {
    totalLeads,
    activeDeals,
    inventoryCount,
    monthlyRevenue,
    serviceOrdersOpen,
    agentTasksToday,
    conversionRate,
    avgResponseSeconds: 38,
  };

  res.json(GetDashboardSummaryResponse.parse(summary));
});

router.get("/dashboard/pipeline", async (_req, res): Promise<void> => {
  const [leads, vehicles] = await Promise.all([
    db.select().from(leadsTable),
    db.select().from(vehiclesTable),
  ]);
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
  const deals = await db.select().from(dealsTable);
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

  res.json(GetSalesPerformanceResponse.parse(series));
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
  const [deals, leads] = await Promise.all([
    db.select().from(dealsTable),
    db.select().from(leadsTable),
  ]);
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
  const vehicles = await db.select().from(vehiclesTable);
  const counts = new Map<string, number>();
  for (const v of vehicles) {
    counts.set(v.powertrain, (counts.get(v.powertrain) ?? 0) + 1);
  }
  const breakdown = Array.from(counts.entries()).map(([powertrain, count]) => ({
    powertrain,
    count,
  }));

  res.json(GetInventoryBreakdownResponse.parse(breakdown));
});

export default router;
