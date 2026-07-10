import { Router, type IRouter } from "express";
import { db, leadsTable, dealsTable, vehiclesTable, serviceOrdersTable, agentsTable } from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetPipelineResponse,
  GetSalesPerformanceResponse,
  GetInventoryBreakdownResponse,
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
