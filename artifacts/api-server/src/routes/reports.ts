import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  dealsTable,
  vehiclesTable,
  serviceOrdersTable,
  invoicesTable,
  paymentsTable,
  deliveriesTable,
  financeApplicationsTable,
  losSubmissionsTable,
  banksTable,
  jobCardsTable,
  jobCardPartsTable,
  partsTable,
  partPurchasesTable,
  serviceInvoicesTable,
  quotesTable,
  gatesTable,
  graFilingsTable,
  agentsTable,
  agentRunsTable,
  dealersTable,
  divisionsTable,
  usersTable,
  auditLogsTable,
  activityTable,
  collisionClaimsTable,
  collisionSupplementsTable,
  collisionSettlementsTable,
} from "@workspace/db";
import { GetReportResponse } from "@workspace/api-zod";
import {
  activeDealerId,
  hasPermission,
  type AuthedUser,
} from "../middlewares/rbac";
import {
  resolvePersonaScope,
  scopeLeadRows,
  scopeDealRows,
  divisionMatch,
  parseDealerRange,
  dealerMonthKey,
  dealerDateLabel,
  makeGyd,
  type PersonaScope,
} from "../lib/report-scope";
import { dealerTimezone, zonedParts } from "../lib/timezone";
import { renderReportExport } from "../lib/report-export";
import { fieldAccessFor } from "../lib/field-permissions";

const router: IRouter = Router();

/* ------------------------------------------------------------------ */
/* R5.1 — the 10 canonical report types                                */
/* ------------------------------------------------------------------ */

/** RBAC module gate per report type (role_permissions module × view). */
const REPORT_MODULE: Record<string, string> = {
  sales_pipeline: "leads",
  sales_performance: "deals",
  inventory_aging: "inventory",
  finance_applications: "finance",
  service_workshop: "service",
  parts_inventory: "parts",
  revenue_receivables: "finance",
  tax_gra: "gra",
  delivery_operations: "deliveries",
  agent_activity: "settings",
  collision_claims: "service",
};

/** Minimum persona tier per type (spec R5.1 visibility column). */
const REPORT_MIN_TIER: Record<string, "advisor" | "manager"> = {
  sales_pipeline: "advisor",
  sales_performance: "advisor",
  inventory_aging: "advisor",
  finance_applications: "manager",
  service_workshop: "manager",
  parts_inventory: "manager",
  revenue_receivables: "manager",
  tax_gra: "manager",
  delivery_operations: "advisor",
  agent_activity: "manager",
  collision_claims: "manager",
};

const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

const titleCase = (s: string) =>
  s
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const inRange = (d: Date | string | null | undefined, from: Date, to: Date) => {
  if (!d) return false;
  const t = new Date(d).getTime();
  return t >= from.getTime() && t <= to.getTime();
};

function monthBuckets(from: Date, to: Date, tz: string) {
  const buckets: { key: string; label: string }[] = [];
  const fromParts = zonedParts(from, tz);
  const toParts = zonedParts(to, tz);
  const cur = new Date(Date.UTC(fromParts.year, fromParts.month - 1, 1));
  const end = new Date(Date.UTC(toParts.year, toParts.month - 1, 1));
  while (cur <= end && buckets.length < 24) {
    buckets.push({
      key: `${cur.getUTCFullYear()}-${cur.getUTCMonth()}`,
      label: cur.toLocaleString("en-US", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }),
    });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return buckets;
}

const daysBetween = (a: Date | string, b: Date | string) =>
  Math.max(
    0,
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000),
  );

export type ReportPayload = {
  type: string;
  label: string;
  from: string;
  to: string;
  kpis: { label: string; value: string; sub?: string | null }[];
  chart: {
    kind: "bar" | "area" | "pie";
    valueLabel: string;
    secondaryLabel?: string | null;
    currency?: boolean;
    points: { label: string; value: number; secondary?: number | null }[];
  };
  table: { columns: string[]; rows: string[][] };
};

type Ctx = {
  from: Date;
  to: Date;
  dealerId: number;
  scope: PersonaScope;
  divisionId: number | null;
  gyd: (usd: number) => string;
  gydNumber: (usd: number) => number;
  rate: number;
  tz: string;
};

type Builder = (
  ctx: Ctx,
) => Promise<Omit<ReportPayload, "type" | "from" | "to">>;

/* 1 — sales_pipeline: open leads/deals by phase & stage, aging, conversion */
const salesPipeline: Builder = async (ctx) => {
  const { from, to, dealerId, scope, divisionId, gyd, gydNumber } = ctx;
  const [allLeads, allDeals, vehicles] = await Promise.all([
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId)),
  ]);
  const leads = scopeLeadRows(scope, allLeads, divisionId).filter((l) =>
    inRange(l.createdAt, from, to),
  );
  const deals = scopeDealRows(scope, allDeals, divisionId);
  const vehiclePrice = new Map(vehicles.map((v) => [v.id, v.price]));

  const PHASES = ["new", "contacted", "qualified", "proposal", "negotiation", "won"];
  const WEIGHTS: Record<string, number> = {
    new: 0.05,
    contacted: 0.15,
    qualified: 0.3,
    proposal: 0.5,
    negotiation: 0.75,
    won: 1,
  };
  const now = new Date();
  const byPhase = PHASES.map((phase) => {
    const rows = leads.filter((l) => l.phase === phase);
    const value = rows.reduce(
      (s, l) =>
        s +
        (l.interestedVehicleId
          ? (vehiclePrice.get(l.interestedVehicleId) ?? 0)
          : 0),
      0,
    );
    const aging = rows
      .filter((l) => l.stageEnteredAt)
      .map((l) => daysBetween(l.stageEnteredAt!, now));
    return {
      phase,
      count: rows.length,
      value,
      weighted: value * (WEIGHTS[phase] ?? 0),
      avgDays: aging.length ? aging.reduce((a, b) => a + b, 0) / aging.length : 0,
    };
  });
  const total = leads.length;
  const won = byPhase.find((p) => p.phase === "won")?.count ?? 0;
  const lost = leads.filter((l) => l.phase === "lost").length;
  const openDeals = deals.filter((d) => ["desking", "committed"].includes(d.stage));
  const weightedTotal = byPhase.reduce((s, p) => s + p.weighted, 0);

  const rows = byPhase.map((p, i) => {
    const next = byPhase[i + 1];
    const conv = next && p.count ? pct((next.count / p.count) * 100) : "—";
    return [
      titleCase(p.phase),
      String(p.count),
      gyd(p.value),
      gyd(p.weighted),
      `${Math.round(p.avgDays)} d`,
      conv,
    ];
  });
  return {
    label: "Sales Pipeline",
    kpis: [
      {
        label: "Open leads",
        value: String(Math.max(0, total - won - lost)),
        sub: `${total} in range`,
      },
      { label: "Weighted pipeline", value: gyd(weightedTotal) },
      {
        label: "Open deals",
        value: String(openDeals.length),
        sub: gyd(openDeals.reduce((s, d) => s + d.otdPrice, 0)),
      },
      {
        label: "Win rate",
        value: pct(total ? (won / total) * 100 : 0),
        sub: `${lost} lost`,
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Leads",
      secondaryLabel: "Weighted value (GYD)",
      points: byPhase.map((p) => ({
        label: titleCase(p.phase),
        value: p.count,
        secondary: gydNumber(p.weighted),
      })),
    },
    table: {
      columns: [
        "Phase",
        "Leads",
        "Value",
        "Weighted",
        "Avg days in stage",
        "Conv → next",
      ],
      rows,
    },
  };
};

/* 2 — sales_performance: advisor/division output */
const salesPerformance: Builder = async (ctx) => {
  const { from, to, dealerId, scope, divisionId, gyd, gydNumber } = ctx;
  const [allDeals, divisions, allDeliveries] = await Promise.all([
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db
      .select()
      .from(divisionsTable)
      .where(eq(divisionsTable.dealerId, dealerId)),
    db
      .select()
      .from(deliveriesTable)
      .where(eq(deliveriesTable.dealerId, dealerId)),
  ]);
  const deliveredAtByDeal = new Map<number, Date>();
  for (const dl of allDeliveries)
    if (dl.deliveredAt) deliveredAtByDeal.set(dl.dealId, dl.deliveredAt);
  const dealDeliveredAt = (d: { id: number }) => deliveredAtByDeal.get(d.id) ?? null;
  const deals = scopeDealRows(scope, allDeals, divisionId).filter((d) =>
    inRange(d.createdAt, from, to),
  );
  const delivered = deals.filter((d) => d.stage === "delivered");
  const committedPlus = deals.filter((d) =>
    ["committed", "delivered"].includes(d.stage),
  );

  const byAdvisor = new Map<
    string,
    { units: number; gross: number; discount: number; deals: number; won: number; cycle: number[] }
  >();
  for (const d of deals) {
    const key = d.salesAdvisor ?? "Unassigned";
    const e =
      byAdvisor.get(key) ??
      { units: 0, gross: 0, discount: 0, deals: 0, won: 0, cycle: [] };
    e.deals += 1;
    e.discount += d.discount;
    if (d.stage === "delivered") {
      e.units += 1;
      e.gross += d.otdPrice;
      e.won += 1;
      const dAt = dealDeliveredAt(d);
      if (dAt) e.cycle.push(daysBetween(d.createdAt, dAt));
    } else if (d.stage === "committed") e.won += 1;
    byAdvisor.set(key, e);
  }
  const divisionName = new Map(divisions.map((dv) => [dv.id, dv.name]));
  const byDivision = new Map<string, { units: number; gross: number }>();
  for (const d of delivered) {
    const key =
      d.divisionId != null
        ? (divisionName.get(d.divisionId) ?? `Division ${d.divisionId}`)
        : "Unassigned";
    const e = byDivision.get(key) ?? { units: 0, gross: 0 };
    e.units += 1;
    e.gross += d.otdPrice;
    byDivision.set(key, e);
  }
  const buckets = monthBuckets(from, to, ctx.tz);
  const series = buckets.map((b) => {
    const rows = delivered.filter((d) => {
      const dAt = dealDeliveredAt(d);
      return dAt != null && dealerMonthKey(dAt, ctx.tz) === b.key;
    });
    return {
      label: b.label,
      value: gydNumber(rows.reduce((s, d) => s + d.otdPrice, 0)),
      secondary: rows.length,
    };
  });
  const gross = delivered.reduce((s, d) => s + d.otdPrice, 0);
  const avgDiscount = deals.length
    ? deals.reduce((s, d) => s + d.discount, 0) / deals.length
    : 0;
  const cycles = delivered
    .map((d) => ({ d, dAt: dealDeliveredAt(d) }))
    .filter((x) => x.dAt != null)
    .map((x) => daysBetween(x.d.createdAt, x.dAt!));

  const advisorRows = [...byAdvisor.entries()]
    .sort((a, b) => b[1].gross - a[1].gross)
    .map(([name, e]) => [
      name,
      String(e.units),
      gyd(e.gross),
      gyd(e.deals ? e.discount / e.deals : 0),
      pct(e.deals ? (e.won / e.deals) * 100 : 0),
      e.cycle.length
        ? `${Math.round(e.cycle.reduce((a, b) => a + b, 0) / e.cycle.length)} d`
        : "—",
    ]);
  return {
    label: "Sales Performance",
    kpis: [
      {
        label: "Units delivered",
        value: String(delivered.length),
        sub: `${committedPlus.length} committed+`,
      },
      { label: "Gross (OTD)", value: gyd(gross) },
      { label: "Avg discount", value: gyd(avgDiscount) },
      {
        label: "Avg deal cycle",
        value: cycles.length
          ? `${Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length)} d`
          : "—",
        sub:
          [...byDivision.entries()]
            .map(([n, e]) => `${n}: ${e.units}u`)
            .join(" · ") || null,
      },
    ],
    chart: {
      kind: "area",
      valueLabel: "Gross (GYD)",
      secondaryLabel: "Units",
      currency: true,
      points: series,
    },
    table: {
      columns: ["Advisor", "Units", "Gross", "Avg discount", "Close rate", "Avg cycle"],
      rows: advisorRows,
    },
  };
};

/* 3 — inventory_aging: stock, days-on-lot, hold exposure */
const inventoryAging: Builder = async (ctx) => {
  const { dealerId, scope, divisionId, gyd, gydNumber } = ctx;
  const vehicles = (
    await db.select().from(vehiclesTable).where(eq(vehiclesTable.dealerId, dealerId))
  ).filter((v) => divisionMatch(scope, divisionId, v.divisionId));
  const now = new Date();
  const inStock = vehicles.filter((v) => !["sold", "delivered"].includes(v.status));
  const BUCKETS = [
    { label: "0-30 d", min: 0, max: 30 },
    { label: "31-60 d", min: 31, max: 60 },
    { label: "61-90 d", min: 61, max: 90 },
    { label: "90+ d", min: 91, max: Infinity },
  ];
  const aging = BUCKETS.map((b) => {
    const rows = inStock.filter((v) => {
      const d = daysBetween(v.createdAt, now);
      return d >= b.min && d <= b.max;
    });
    return {
      ...b,
      count: rows.length,
      value: rows.reduce((s, v) => s + v.price, 0),
    };
  });
  const byStatus = new Map<string, { count: number; value: number }>();
  for (const v of vehicles) {
    const e = byStatus.get(v.status) ?? { count: 0, value: 0 };
    e.count += 1;
    e.value += v.price;
    byStatus.set(v.status, e);
  }
  const held = inStock.filter((v) => v.holdUntil && new Date(v.holdUntil) > now);
  const over90 = aging[3]!;
  const stockValue = inStock.reduce((s, v) => s + v.price, 0);
  return {
    label: "Inventory Aging",
    kpis: [
      { label: "Units in stock", value: String(inStock.length), sub: gyd(stockValue) },
      { label: "Aged 90+ days", value: String(over90.count), sub: gyd(over90.value) },
      {
        label: "On hold",
        value: String(held.length),
        sub: held.length ? gyd(held.reduce((s, v) => s + v.price, 0)) : null,
      },
      {
        label: "Avg days on lot",
        value: inStock.length
          ? `${Math.round(inStock.reduce((s, v) => s + daysBetween(v.createdAt, now), 0) / inStock.length)} d`
          : "—",
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Units",
      secondaryLabel: "Value (GYD)",
      points: aging.map((b) => ({
        label: b.label,
        value: b.count,
        secondary: gydNumber(b.value),
      })),
    },
    table: {
      columns: ["Status", "Units", "Value"],
      rows: [...byStatus.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([status, e]) => [titleCase(status), String(e.count), gyd(e.value)]),
    },
  };
};

/* 4 — finance_applications: funding funnel & approval throughput */
const financeApplications: Builder = async (ctx) => {
  const { from, to, dealerId, scope, divisionId, gyd } = ctx;
  const [allApps, banks, los, allDeals, allLeads] = await Promise.all([
    db
      .select()
      .from(financeApplicationsTable)
      .where(eq(financeApplicationsTable.dealerId, dealerId)),
    db.select().from(banksTable).where(eq(banksTable.dealerId, dealerId)),
    db
      .select()
      .from(losSubmissionsTable)
      .where(eq(losSubmissionsTable.dealerId, dealerId)),
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
  ]);
  /* Manager division pre-scope + explicit division filter: resolve the app's
     division from its parent deal when linked, else its parent lead. */
  const dealDivision = new Map(allDeals.map((d) => [d.id, d.divisionId]));
  const leadDivision = new Map(allLeads.map((l) => [l.id, l.divisionId]));
  const apps = allApps.filter((a) => {
    const division =
      a.dealId != null
        ? (dealDivision.get(a.dealId) ?? null)
        : a.leadId != null
          ? (leadDivision.get(a.leadId) ?? null)
          : null;
    return divisionMatch(scope, divisionId, division);
  });
  const inWindow = apps.filter((a) => inRange(a.createdAt, from, to));
  const STATUSES = ["pending", "submitted", "under_review", "approved", "declined", "disbursed"];
  const byStatus = STATUSES.map((s) => {
    const rows = inWindow.filter((a) => a.status === s);
    return {
      status: s,
      count: rows.length,
      amount: rows.reduce((x, a) => x + (a.amount ?? 0), 0),
    };
  });
  const decided = inWindow.filter((a) =>
    ["approved", "declined", "disbursed"].includes(a.status),
  );
  const approved = inWindow.filter((a) =>
    ["approved", "disbursed"].includes(a.status),
  );
  const bankName = new Map(banks.map((b) => [b.id, b.name]));
  const withApr = inWindow.filter((a) => a.apr != null);
  const avgApr = withApr.length
    ? withApr.reduce((s, a) => s + a.apr!, 0) / withApr.length
    : 0;
  const withTerm = inWindow.filter((a) => a.termMonths != null);
  const byBank = new Map<string, { count: number; amount: number; approved: number }>();
  for (const a of inWindow) {
    const key =
      a.bankId != null ? (bankName.get(a.bankId) ?? `Bank ${a.bankId}`) : "No bank";
    const e = byBank.get(key) ?? { count: 0, amount: 0, approved: 0 };
    e.count += 1;
    e.amount += a.amount ?? 0;
    if (["approved", "disbursed"].includes(a.status)) e.approved += 1;
    byBank.set(key, e);
  }
  const losRecent = los.filter((l) => inRange(l.createdAt, from, to));
  const activeBanks = banks.filter((b) => b.baseApr != null);
  return {
    label: "Finance Applications",
    kpis: [
      {
        label: "Applications",
        value: String(inWindow.length),
        sub: gyd(inWindow.reduce((s, a) => s + (a.amount ?? 0), 0)),
      },
      {
        label: "Approval rate",
        value: pct(decided.length ? (approved.length / decided.length) * 100 : 0),
        sub: `${approved.length}/${decided.length} decided`,
      },
      {
        label: "Avg APR",
        value: withApr.length ? pct(avgApr) : "—",
        sub: activeBanks.length
          ? `bank base ${pct(activeBanks.reduce((s, b) => s + (b.baseApr ?? 0), 0) / activeBanks.length)}`
          : null,
      },
      {
        label: "Avg term",
        value: withTerm.length
          ? `${Math.round(withTerm.reduce((s, a) => s + a.termMonths!, 0) / withTerm.length)} mo`
          : "—",
        sub: `${losRecent.length} LOS events`,
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Applications",
      points: byStatus.map((s) => ({ label: titleCase(s.status), value: s.count })),
    },
    table: {
      columns: ["Bank", "Apps", "Amount", "Approved", "Approval %"],
      rows: [...byBank.entries()].map(([name, e]) => [
        name,
        String(e.count),
        gyd(e.amount),
        String(e.approved),
        pct(e.count ? (e.approved / e.count) * 100 : 0),
      ]),
    },
  };
};

/* 5 — service_workshop: throughput, tech load, WIP */
const serviceWorkshop: Builder = async (ctx) => {
  const { from, to, dealerId, gyd } = ctx;
  const [orders, jobCards, svcInvoices] = await Promise.all([
    db
      .select()
      .from(serviceOrdersTable)
      .where(eq(serviceOrdersTable.dealerId, dealerId)),
    db.select().from(jobCardsTable).where(eq(jobCardsTable.dealerId, dealerId)),
    db
      .select()
      .from(serviceInvoicesTable)
      .where(eq(serviceInvoicesTable.dealerId, dealerId)),
  ]);
  const inWindow = orders.filter((o) => inRange(o.createdAt, from, to));
  const open = orders.filter(
    (o) => !["resolved", "closed", "cancelled"].includes(o.status),
  );
  const byStatus = new Map<string, number>();
  for (const o of inWindow) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
  const cards = jobCards.filter((c) => inRange(c.createdAt, from, to));
  const laborValue = cards.reduce((s, c) => s + c.laborHours * c.laborRate, 0);
  const byTech = new Map<string, { cards: number; hours: number; value: number }>();
  for (const c of cards) {
    const key = c.technicianName ?? "Unassigned";
    const e = byTech.get(key) ?? { cards: 0, hours: 0, value: 0 };
    e.cards += 1;
    e.hours += c.laborHours;
    e.value += c.laborHours * c.laborRate;
    byTech.set(key, e);
  }
  const billed = svcInvoices.filter((i) => inRange(i.createdAt, from, to));
  return {
    label: "Service & Workshop",
    kpis: [
      {
        label: "Orders in window",
        value: String(inWindow.length),
        sub: `${open.length} open WIP`,
      },
      {
        label: "Job cards",
        value: String(cards.length),
        sub: `${cards.filter((c) => c.status === "completed").length} completed`,
      },
      {
        label: "Labor value",
        value: gyd(laborValue),
        sub: `${Math.round(cards.reduce((s, c) => s + c.laborHours, 0))} hrs`,
      },
      {
        label: "Service billed",
        value: gyd(billed.reduce((s, i) => s + i.total, 0)),
        sub: `${billed.length} invoices`,
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Orders",
      points: [...byStatus.entries()].map(([s, c]) => ({
        label: titleCase(s),
        value: c,
      })),
    },
    table: {
      columns: ["Technician", "Job cards", "Labor hours", "Labor value"],
      rows: [...byTech.entries()]
        .sort((a, b) => b[1].hours - a[1].hours)
        .map(([name, e]) => [
          name,
          String(e.cards),
          String(Math.round(e.hours * 10) / 10),
          gyd(e.value),
        ]),
    },
  };
};

/* 6 — parts_inventory: stock, reorder exposure, consumption */
const partsInventory: Builder = async (ctx) => {
  const { from, to, dealerId, gyd, gydNumber } = ctx;
  const [parts, usage, purchases] = await Promise.all([
    db.select().from(partsTable).where(eq(partsTable.dealerId, dealerId)),
    db
      .select()
      .from(jobCardPartsTable)
      .where(eq(jobCardPartsTable.dealerId, dealerId)),
    db
      .select()
      .from(partPurchasesTable)
      .where(eq(partPurchasesTable.dealerId, dealerId)),
  ]);
  const active = parts.filter((p) => p.status === "active");
  const belowReorder = active.filter((p) => p.stock <= p.reorderLevel);
  const stockValue = active.reduce((s, p) => s + p.stock * p.unitCost, 0);
  const partName = new Map(parts.map((p) => [p.id, p.name]));
  const consumed = new Map<number, number>();
  for (const u of usage.filter((u) => inRange(u.createdAt, from, to)))
    consumed.set(u.partId, (consumed.get(u.partId) ?? 0) + u.quantity);
  const recentPurchases = purchases.filter((p) => inRange(p.createdAt, from, to));
  const byCategory = new Map<string, { count: number; value: number }>();
  for (const p of active) {
    const e = byCategory.get(p.category) ?? { count: 0, value: 0 };
    e.count += 1;
    e.value += p.stock * p.unitCost;
    byCategory.set(p.category, e);
  }
  return {
    label: "Parts Inventory",
    kpis: [
      { label: "Active SKUs", value: String(active.length), sub: gyd(stockValue) },
      {
        label: "Below reorder",
        value: String(belowReorder.length),
        sub: belowReorder.length
          ? belowReorder.slice(0, 3).map((p) => p.sku).join(", ")
          : null,
      },
      {
        label: "Parts consumed",
        value: String([...consumed.values()].reduce((a, b) => a + b, 0)),
        sub: `${consumed.size} SKUs`,
      },
      {
        label: "Purchases",
        value: String(recentPurchases.length),
        sub: gyd(recentPurchases.reduce((s, p) => s + p.quantity * p.unitCost, 0)),
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Stock value (GYD)",
      currency: true,
      points: [...byCategory.entries()].map(([c, e]) => ({
        label: titleCase(c),
        value: gydNumber(e.value),
        secondary: e.count,
      })),
    },
    table: {
      columns: ["Top consumed part", "Qty used", "In stock", "Reorder level"],
      rows: [...consumed.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([partId, qty]) => {
          const p = parts.find((x) => x.id === partId);
          return [
            partName.get(partId) ?? `Part ${partId}`,
            String(qty),
            String(p?.stock ?? 0),
            String(p?.reorderLevel ?? 0),
          ];
        }),
    },
  };
};

/* 7 — revenue_receivables: billed vs collected, outstanding AR */
const revenueReceivables: Builder = async (ctx) => {
  const { from, to, dealerId, scope, divisionId, gyd, gydNumber } = ctx;
  const [allInvoices, allPayments, svcInvoices, allDeals] = await Promise.all([
    db.select().from(invoicesTable).where(eq(invoicesTable.dealerId, dealerId)),
    db.select().from(paymentsTable).where(eq(paymentsTable.dealerId, dealerId)),
    db
      .select()
      .from(serviceInvoicesTable)
      .where(eq(serviceInvoicesTable.dealerId, dealerId)),
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
  ]);
  /* Manager division pre-scope + explicit division filter via parent deal.
     Payments follow their invoice's visibility. */
  const dealDivision = new Map(allDeals.map((d) => [d.id, d.divisionId]));
  const invoices = allInvoices.filter((i) =>
    divisionMatch(
      scope,
      divisionId,
      i.dealId != null ? (dealDivision.get(i.dealId) ?? null) : null,
    ),
  );
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const payments = allPayments.filter((p) => invoiceIds.has(p.invoiceId));
  const inWindow = invoices.filter((i) => inRange(i.createdAt, from, to));
  const paid = new Map<number, number>();
  for (const p of payments)
    paid.set(p.invoiceId, (paid.get(p.invoiceId) ?? 0) + p.amount);
  const openInvoices = invoices.filter(
    (i) => !["paid", "void"].includes(i.status),
  );
  const outstanding = openInvoices.reduce(
    (s, i) => s + Math.max(0, i.amount - (paid.get(i.id) ?? 0)),
    0,
  );
  const collected = payments.filter((p) => inRange(p.createdAt, from, to));
  const byMethod = new Map<string, number>();
  for (const p of collected)
    byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount);
  const now = new Date();
  const AR_BUCKETS = [
    { label: "Current (≤30 d)", min: 0, max: 30 },
    { label: "31-60 d", min: 31, max: 60 },
    { label: "61-90 d", min: 61, max: 90 },
    { label: "90+ d", min: 91, max: Infinity },
  ];
  const arAging = AR_BUCKETS.map((b) => {
    const rows = openInvoices.filter((i) => {
      const d = daysBetween(i.createdAt, now);
      return d >= b.min && d <= b.max;
    });
    return {
      label: b.label,
      value: rows.reduce(
        (s, i) => s + Math.max(0, i.amount - (paid.get(i.id) ?? 0)),
        0,
      ),
    };
  });
  const svcBilled = svcInvoices
    .filter((i) => inRange(i.createdAt, from, to))
    .reduce((s, i) => s + i.total, 0);
  const methodTotal = [...byMethod.values()].reduce((a, b) => a + b, 0);
  return {
    label: "Revenue & Receivables",
    kpis: [
      {
        label: "Billed in window",
        value: gyd(inWindow.reduce((s, i) => s + i.amount, 0)),
        sub: `${inWindow.length} invoices`,
      },
      {
        label: "Collected",
        value: gyd(collected.reduce((s, p) => s + p.amount, 0)),
        sub: `${collected.length} payments`,
      },
      {
        label: "Outstanding AR",
        value: gyd(outstanding),
        sub: `${openInvoices.length} open invoices`,
      },
      { label: "Service billed", value: gyd(svcBilled) },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Outstanding (GYD)",
      currency: true,
      points: arAging.map((b) => ({ label: b.label, value: gydNumber(b.value) })),
    },
    table: {
      columns: ["Collection method", "Amount", "Share"],
      rows: [...byMethod.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([m, v]) => [
          titleCase(m),
          gyd(v),
          pct(methodTotal ? (v / methodTotal) * 100 : 0),
        ]),
    },
  };
};

/* 8 — tax_gra: tax basis & filing register */
const taxGra: Builder = async (ctx) => {
  const { from, to, dealerId, scope, divisionId, gyd, gydNumber, tz } = ctx;
  const [allQuotes, filings, gates, allLeads] = await Promise.all([
    db.select().from(quotesTable).where(eq(quotesTable.dealerId, dealerId)),
    db.select().from(graFilingsTable).where(eq(graFilingsTable.dealerId, dealerId)),
    db.select().from(gatesTable).where(eq(gatesTable.dealerId, dealerId)),
    db.select().from(leadsTable).where(eq(leadsTable.dealerId, dealerId)),
  ]);
  /* Manager division pre-scope on the quote's parent lead. GRA filings and
     gates are dealer-level registers (no division linkage in schema). */
  const leadDivision = new Map(allLeads.map((l) => [l.id, l.divisionId]));
  const quotes = allQuotes.filter((q) =>
    divisionMatch(scope, divisionId, leadDivision.get(q.leadId) ?? null),
  );
  const inWindow = quotes.filter((q) => inRange(q.createdAt, from, to));
  const taxCollected = inWindow.reduce((s, q) => s + q.totalTax, 0);
  const taxableBase = inWindow.reduce((s, q) => s + (q.total - q.totalTax), 0);
  const byCode = new Map<string, number>();
  for (const q of inWindow)
    for (const line of q.taxLines ?? [])
      byCode.set(line.code, (byCode.get(line.code) ?? 0) + line.amount);
  const windowFilings = filings.filter((f) => inRange(f.createdAt, from, to));
  const graGates = gates.filter((g) => g.type === "gra_filing");
  const pendingGates = graGates.filter((g) => g.status === "pending");
  return {
    label: "Tax & GRA",
    kpis: [
      {
        label: "Taxable base",
        value: gyd(taxableBase),
        sub: `${inWindow.length} quotes`,
      },
      { label: "Tax computed", value: gyd(taxCollected) },
      {
        label: "GRA filings",
        value: String(windowFilings.length),
        sub: `${filings.filter((f) => f.status === "filed").length} filed all-time`,
      },
      {
        label: "Filing gates pending",
        value: String(pendingGates.length),
        sub: `${graGates.length} total gra_filing gates`,
      },
    ],
    chart: {
      kind: "pie",
      valueLabel: "Tax by code (GYD)",
      currency: true,
      points: [...byCode.entries()].map(([code, amt]) => ({
        label: code,
        value: gydNumber(amt),
      })),
    },
    table: {
      columns: ["Filing", "Status", "Fuel type", "Created"],
      rows: windowFilings
        .slice(0, 15)
        .map((f) => [
          `#${f.id}`,
          titleCase(f.status),
          titleCase(f.fuelType),
          dealerDateLabel(f.createdAt, tz),
        ]),
    },
  };
};

/* 9 — delivery_operations: handover throughput & PDI/CSAT */
const deliveryOperations: Builder = async (ctx) => {
  const { from, to, dealerId, scope, divisionId, tz } = ctx;
  const [allDeliveries, allDeals] = await Promise.all([
    db
      .select()
      .from(deliveriesTable)
      .where(eq(deliveriesTable.dealerId, dealerId)),
    db.select().from(dealsTable).where(eq(dealsTable.dealerId, dealerId)),
  ]);
  /* Persona scope via the parent deal: advisors see their own deals'
     deliveries; managers are pre-scoped to their division. */
  const visibleDealIds = new Set(
    scopeDealRows(scope, allDeals, divisionId).map((d) => d.id),
  );
  const deliveries = allDeliveries.filter(
    (d) => inRange(d.createdAt, from, to) && visibleDealIds.has(d.dealId),
  );
  const STEPS = [
    "sales_order",
    "pdi_checklist",
    "registration",
    "insurance",
    "invoice",
    "appointment",
    "delivery",
    "signature",
    "feedback",
  ];
  const byStep = new Map<string, number>();
  for (const d of deliveries)
    byStep.set(d.currentStep, (byStep.get(d.currentStep) ?? 0) + 1);
  const completed = deliveries.filter((d) => d.deliveredAt);
  const cycles = completed.map((d) => daysBetween(d.createdAt, d.deliveredAt!));
  const withPdi = deliveries.filter((d) => (d.pdiItems ?? []).length > 0);
  const pdiPassRates = withPdi.map((d) => {
    const items = d.pdiItems ?? [];
    return items.length
      ? items.filter((i) => i.status === "pass" || i.status === "waived").length /
          items.length
      : 0;
  });
  const rated = deliveries.filter((d) => d.feedbackRating != null);
  return {
    label: "Delivery Operations",
    kpis: [
      {
        label: "Deliveries in window",
        value: String(deliveries.length),
        sub: `${completed.length} handed over`,
      },
      {
        label: "Avg cycle",
        value: cycles.length
          ? `${Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length)} d`
          : "—",
      },
      {
        label: "PDI pass rate",
        value: pdiPassRates.length
          ? pct(
              (pdiPassRates.reduce((a, b) => a + b, 0) / pdiPassRates.length) *
                100,
            )
          : "—",
        sub: `${withPdi.length} with PDI`,
      },
      {
        label: "CSAT",
        value: rated.length
          ? `${Math.round((rated.reduce((s, d) => s + d.feedbackRating!, 0) / rated.length) * 10) / 10} / 5`
          : "—",
        sub: `${rated.length} rated`,
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Deliveries at step",
      points: STEPS.map((s) => ({
        label: titleCase(s),
        value: byStep.get(s) ?? 0,
      })),
    },
    table: {
      columns: ["Delivery", "Step", "Delivered", "Rating"],
      rows: deliveries
        .slice(0, 15)
        .map((d) => [
          `#${d.id}`,
          `${Math.max(1, STEPS.indexOf(d.currentStep) + 1)}/9 ${titleCase(d.currentStep)}`,
          d.deliveredAt ? dealerDateLabel(d.deliveredAt, tz) : "—",
          d.feedbackRating != null ? `${d.feedbackRating}/5` : "—",
        ]),
    },
  };
};

/* 10 — agent_activity: AI throughput, confidence, HITL */
const agentActivity: Builder = async (ctx) => {
  const { from, to, dealerId } = ctx;
  const [agents, runs, gates] = await Promise.all([
    db.select().from(agentsTable).where(eq(agentsTable.dealerId, dealerId)),
    db.select().from(agentRunsTable).where(eq(agentRunsTable.dealerId, dealerId)),
    db.select().from(gatesTable).where(eq(gatesTable.dealerId, dealerId)),
  ]);
  const inWindow = runs.filter((r) => inRange(r.createdAt, from, to));
  const succeeded = inWindow.filter((r) => r.status === "succeeded");
  const withConfidence = inWindow.filter((r) => r.confidence != null);
  const avgConfidence = withConfidence.length
    ? withConfidence.reduce((s, r) => s + r.confidence!, 0) /
      withConfidence.length
    : 0;
  const belowThreshold = withConfidence.filter((r) => r.confidence! < 0.7);
  const autonomous = inWindow.filter((r) => r.autonomy === "autonomous");
  const latencies = inWindow
    .filter((r) => r.latencyMs != null)
    .map((r) => r.latencyMs!);
  const byAgent = new Map<
    string,
    { runs: number; ok: number; conf: number[]; latency: number[] }
  >();
  for (const r of inWindow) {
    const e = byAgent.get(r.agentKey) ?? { runs: 0, ok: 0, conf: [], latency: [] };
    e.runs += 1;
    if (r.status === "succeeded") e.ok += 1;
    if (r.confidence != null) e.conf.push(r.confidence);
    if (r.latencyMs != null) e.latency.push(r.latencyMs);
    byAgent.set(r.agentKey, e);
  }
  const pendingApprovals = gates.filter((g) => g.status === "pending").length;
  const paused = agents.filter((a) => a.status !== "active").length;
  return {
    label: "Agent Activity",
    kpis: [
      {
        label: "Runs in window",
        value: String(inWindow.length),
        sub: `${autonomous.length} autonomous writes`,
      },
      {
        label: "Success rate",
        value: pct(inWindow.length ? (succeeded.length / inWindow.length) * 100 : 0),
      },
      {
        label: "Avg confidence",
        value: withConfidence.length ? pct(avgConfidence * 100) : "—",
        sub: `${belowThreshold.length} below threshold → HITL`,
      },
      {
        label: "Avg latency",
        value: latencies.length
          ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length / 100) / 10}s`
          : "—",
        sub: `${pendingApprovals} gates pending · ${paused} agents paused`,
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Runs",
      secondaryLabel: "Succeeded",
      points: [...byAgent.entries()].map(([key, e]) => ({
        label: key,
        value: e.runs,
        secondary: e.ok,
      })),
    },
    table: {
      columns: ["Agent", "Runs", "Success", "Avg confidence", "Avg latency"],
      rows: [...byAgent.entries()]
        .sort((a, b) => b[1].runs - a[1].runs)
        .map(([key, e]) => [
          key,
          String(e.runs),
          pct(e.runs ? (e.ok / e.runs) * 100 : 0),
          e.conf.length
            ? pct((e.conf.reduce((a, b) => a + b, 0) / e.conf.length) * 100)
            : "—",
          e.latency.length
            ? `${Math.round(e.latency.reduce((a, b) => a + b, 0) / e.latency.length / 100) / 10}s`
            : "—",
        ]),
    },
  };
};

/* ------------------------------------------------------------------ */
/* Field-level permission redaction (role_field_permissions, R5)       */
/* ------------------------------------------------------------------ */

/** Which field group governs each report's money figures. */
const REPORT_FIELD_GROUP: Record<string, { module: "leads" | "deals"; group: string }> = {
  sales_pipeline: { module: "deals", group: "deal_financials" },
  sales_performance: { module: "deals", group: "deal_financials" },
};

const MONEY_RE = /GYD\s[\d,.]+/g;

/**
 * Elides money figures from a report payload when the caller's role has the
 * governing field group set to `hidden`. Applied before Zod serialization
 * AND before export rendering, so hidden fields never leave the server.
 */
async function redactReportPayload(
  user: AuthedUser,
  type: string,
  payload: ReportPayload,
): Promise<ReportPayload> {
  const rule = REPORT_FIELD_GROUP[type];
  if (!rule) return payload;
  const grants = await fieldAccessFor(user, rule.module);
  const hidden = grants.some(
    (g) => g.group.key === rule.group && g.access === "hidden",
  );
  if (!hidden) return payload;
  const mask = (s: string) => s.replace(MONEY_RE, "—");
  return {
    ...payload,
    kpis: payload.kpis.map((k) => ({
      ...k,
      value: mask(k.value),
      sub: k.sub != null ? mask(k.sub) : k.sub,
    })),
    chart: {
      ...payload.chart,
      /* Money can appear in the primary series (currency charts) or in the
         secondary series (e.g. weighted pipeline value) — strip both. */
      points: payload.chart.points.map((p) => ({
        ...p,
        value: payload.chart.currency ? 0 : p.value,
        secondary: undefined,
      })),
      secondaryLabel: undefined,
    },
    table: {
      ...payload.table,
      rows: payload.table.rows.map((r) => r.map(mask)),
    },
  };
}

/* 11 — collision_claims: cycle time by insurer, supplements, split balances */
const collisionClaims: Builder = async (ctx) => {
  const { from, to, dealerId, gyd } = ctx;
  const [claims, supplements, settlements] = await Promise.all([
    db
      .select()
      .from(collisionClaimsTable)
      .where(eq(collisionClaimsTable.dealerId, dealerId)),
    db
      .select()
      .from(collisionSupplementsTable)
      .where(eq(collisionSupplementsTable.dealerId, dealerId)),
    db
      .select()
      .from(collisionSettlementsTable)
      .where(eq(collisionSettlementsTable.dealerId, dealerId)),
  ]);
  const inWindow = claims.filter((c) => inRange(c.createdAt, from, to));
  const claimIds = new Set(inWindow.map((c) => c.id));
  const supps = supplements.filter((s) => claimIds.has(s.claimId));
  const paidByClaim = new Map<number, { insurer: number; customer: number }>();
  for (const s of settlements) {
    const e = paidByClaim.get(s.claimId) ?? { insurer: 0, customer: 0 };
    if (s.payer === "insurer") e.insurer += s.amount;
    else e.customer += s.amount;
    paidByClaim.set(s.claimId, e);
  }
  /** Cycle days excluding backorder pauses (open pause segments included). */
  const cycleDays = (c: (typeof claims)[number]) => {
    const end = c.closedAt ? new Date(c.closedAt) : new Date();
    let paused = c.pausedSeconds;
    if (c.pausedAt) {
      paused += Math.max(
        0,
        Math.floor((end.getTime() - new Date(c.pausedAt).getTime()) / 1000),
      );
    }
    return Math.max(
      0,
      (end.getTime() - new Date(c.createdAt).getTime()) / 86400000 -
        paused / 86400,
    );
  };
  const closed = inWindow.filter((c) => c.status === "closed");
  const totalLoss = inWindow.filter((c) => c.status === "total_loss");
  const denied = inWindow.filter((c) => c.status === "denied");
  const decidedOutcomes = closed.length + totalLoss.length + denied.length;
  const decidedSupps = supps.filter((s) => s.status !== "pending");
  const approvedSupps = supps.filter((s) => s.status === "approved");
  const suppTurnaroundDays =
    decidedSupps.length > 0
      ? decidedSupps.reduce(
          (s, x) =>
            s +
            (x.decidedAt
              ? (new Date(x.decidedAt).getTime() -
                  new Date(x.createdAt).getTime()) /
                86400000
              : 0),
          0,
        ) / decidedSupps.length
      : 0;
  const openBalances = inWindow.map((c) => {
    const paid = paidByClaim.get(c.id) ?? { insurer: 0, customer: 0 };
    return {
      claim: c,
      insurerOpen: Math.max(0, (c.insurerDue ?? 0) - paid.insurer),
      deductibleOpen: Math.max(0, (c.deductibleDue ?? 0) - paid.customer),
    };
  });
  const insurerOpenTotal = openBalances.reduce((s, b) => s + b.insurerOpen, 0);
  const deductibleOpenTotal = openBalances.reduce(
    (s, b) => s + b.deductibleOpen,
    0,
  );
  const pausedDays = inWindow.reduce((s, c) => {
    let p = c.pausedSeconds;
    if (c.pausedAt) {
      p += Math.max(
        0,
        Math.floor((Date.now() - new Date(c.pausedAt).getTime()) / 1000),
      );
    }
    return s + p / 86400;
  }, 0);

  type InsurerAgg = {
    claims: number;
    closed: number;
    closedDays: number;
    totalLoss: number;
    suppTotal: number;
    suppApproved: number;
    insurerOpen: number;
    deductibleOpen: number;
  };
  const byInsurer = new Map<string, InsurerAgg>();
  for (const b of openBalances) {
    const c = b.claim;
    const key = c.insurerName;
    const e =
      byInsurer.get(key) ??
      ({
        claims: 0,
        closed: 0,
        closedDays: 0,
        totalLoss: 0,
        suppTotal: 0,
        suppApproved: 0,
        insurerOpen: 0,
        deductibleOpen: 0,
      } satisfies InsurerAgg);
    e.claims += 1;
    if (c.status === "closed") {
      e.closed += 1;
      e.closedDays += cycleDays(c);
    }
    if (c.status === "total_loss") e.totalLoss += 1;
    const cs = supps.filter((s) => s.claimId === c.id && s.status !== "pending");
    e.suppTotal += cs.length;
    e.suppApproved += cs.filter((s) => s.status === "approved").length;
    e.insurerOpen += b.insurerOpen;
    e.deductibleOpen += b.deductibleOpen;
    byInsurer.set(key, e);
  }

  return {
    label: "Collision Claims",
    kpis: [
      {
        label: "Claims in window",
        value: String(inWindow.length),
        sub: `${inWindow.length - decidedOutcomes} still in progress`,
      },
      {
        label: "Avg claim duration",
        value:
          closed.length > 0
            ? `${(closed.reduce((s, c) => s + cycleDays(c), 0) / closed.length).toFixed(1)} days`
            : "—",
        sub: `${pausedDays.toFixed(1)} days paused on backorders`,
      },
      {
        label: "Supplement approvals",
        value:
          decidedSupps.length > 0
            ? pct((approvedSupps.length / decidedSupps.length) * 100)
            : "—",
        sub:
          decidedSupps.length > 0
            ? `${suppTurnaroundDays.toFixed(1)} day turnaround`
            : `${supps.length} submitted`,
      },
      {
        label: "Total-loss rate",
        value:
          decidedOutcomes > 0
            ? pct((totalLoss.length / decidedOutcomes) * 100)
            : "—",
        sub: `${closed.length} repaired · ${denied.length} denied`,
      },
      {
        label: "Open insurer balance",
        value: gyd(insurerOpenTotal),
        sub: `${gyd(deductibleOpenTotal)} deductibles outstanding`,
      },
    ],
    chart: {
      kind: "bar",
      valueLabel: "Avg days to close",
      points: [...byInsurer.entries()].map(([name, e]) => ({
        label: name,
        value: e.closed > 0 ? Math.round((e.closedDays / e.closed) * 10) / 10 : 0,
      })),
    },
    table: {
      columns: [
        "Insurer",
        "Claims",
        "Avg days",
        "Supplement approval",
        "Total-loss rate",
        "Open insurer balance",
        "Open deductibles",
      ],
      rows: [...byInsurer.entries()]
        .sort((a, b) => b[1].claims - a[1].claims)
        .map(([name, e]) => [
          name,
          String(e.claims),
          e.closed > 0 ? (e.closedDays / e.closed).toFixed(1) : "—",
          e.suppTotal > 0 ? pct((e.suppApproved / e.suppTotal) * 100) : "—",
          pct((e.totalLoss / Math.max(1, e.claims)) * 100),
          gyd(e.insurerOpen),
          gyd(e.deductibleOpen),
        ]),
    },
  };
};

const builders: Record<string, Builder> = {
  sales_pipeline: salesPipeline,
  sales_performance: salesPerformance,
  inventory_aging: inventoryAging,
  finance_applications: financeApplications,
  service_workshop: serviceWorkshop,
  parts_inventory: partsInventory,
  revenue_receivables: revenueReceivables,
  tax_gra: taxGra,
  delivery_operations: deliveryOperations,
  agent_activity: agentActivity,
  collision_claims: collisionClaims,
};

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

router.get("/reports", async (req, res): Promise<void> => {
  const type = String(req.query.type ?? "");
  const builder = builders[type];
  if (!builder) {
    res.status(400).json({ error: "unknown_report_type" });
    return;
  }
  const user = res.locals.user as AuthedUser;
  const module = REPORT_MODULE[type]!;
  if (!hasPermission(user, module, "view")) {
    res.status(403).json({ error: "forbidden", module });
    return;
  }
  const dealerId = activeDealerId(res);
  const tz = await dealerTimezone(dealerId);
  const scope = await resolvePersonaScope(user, dealerId);
  if (REPORT_MIN_TIER[type] === "manager" && scope.tier === "advisor") {
    res.status(403).json({ error: "forbidden_tier", required: "manager" });
    return;
  }
  const { from, to } = parseDealerRange(
    tz,
    typeof req.query.from === "string" ? req.query.from : undefined,
    typeof req.query.to === "string" ? req.query.to : undefined,
  );
  const requestedDivision =
    typeof req.query.divisionId === "string" && req.query.divisionId !== ""
      ? Number(req.query.divisionId)
      : null;

  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const { gyd, gydNumber, rate } = makeGyd(dealer?.usdExchangeRate);

  const rawPayload: ReportPayload = {
    type,
    from: from.toISOString(),
    to: to.toISOString(),
    ...(await builder({
      from,
      to,
      dealerId,
      scope,
      divisionId: requestedDivision,
      gyd,
      gydNumber,
      rate,
      tz,
    })),
  };
  const payload = await redactReportPayload(user, type, rawPayload);

  const format = typeof req.query.format === "string" ? req.query.format : null;
  if (format && ["csv", "xlsx", "pdf"].includes(format)) {
    const [actorRow] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    const actorLabel = actorRow?.name ?? actorRow?.email ?? `user ${user.id}`;
    await Promise.all([
      db.insert(auditLogsTable).values({
        dealerId,
        actorUserId: user.id,
        actorName: actorRow?.name ?? null,
        actorEmail: actorRow?.email ?? null,
        action: "export",
        module,
        entityType: "report",
        entityId: type,
        summary: `${actorLabel} exported the ${payload.label} report as ${format.toUpperCase()}`,
        details: {
          type,
          format,
          from: payload.from,
          to: payload.to,
          divisionId: requestedDivision,
          usdExchangeRate: rate,
        },
      }),
      db.insert(activityTable).values({
        dealerId,
        actor: actorLabel,
        isAi: false,
        action: `Exported ${payload.label} report (${format.toUpperCase()})`,
        entity: "report",
        detail: `${type} · ${dealerDateLabel(from, tz)} – ${dealerDateLabel(to, tz)}`,
      }),
    ]);
    await renderReportExport(res, payload, format as "csv" | "xlsx" | "pdf", {
      dealerName: dealer?.name ?? `Dealer ${dealerId}`,
      usdExchangeRate: rate,
      timezone: tz,
    });
    return;
  }

  res.json(GetReportResponse.parse(payload));
});

export default router;
