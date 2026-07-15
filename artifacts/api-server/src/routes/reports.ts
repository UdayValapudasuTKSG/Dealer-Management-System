import { Router, type IRouter } from "express";
import {
  db,
  leadsTable,
  dealsTable,
  vehiclesTable,
  serviceOrdersTable,
  customersTable,
  invoicesTable,
  paymentsTable,
  deliveriesTable,
  financeApplicationsTable,
  emailLogsTable,
  jobCardsTable,
  usersTable,
  rolesTable,
} from "@workspace/db";
import { GetReportResponse } from "@workspace/api-zod";
import { hasPermission } from "../middlewares/rbac";

const router: IRouter = Router();

const REPORT_MODULE: Record<string, string> = {
  "lead-conversion": "leads",
  sales: "deals",
  revenue: "finance",
  inventory: "inventory",
  finance: "finance",
  delivery: "deliveries",
  service: "service",
  "employee-performance": "dashboard",
  marketing: "leads",
  "customer-retention": "customers",
};

const money = (n: number) =>
  `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

function parseRange(fromRaw?: string, toRaw?: string) {
  const to = toRaw ? new Date(`${toRaw}T23:59:59.999Z`) : new Date();
  const from = fromRaw
    ? new Date(`${fromRaw}T00:00:00.000Z`)
    : new Date(new Date(to).setMonth(to.getMonth() - 6));
  return { from, to };
}

const inRange = (d: Date | string | null | undefined, from: Date, to: Date) => {
  if (!d) return false;
  const t = new Date(d).getTime();
  return t >= from.getTime() && t <= to.getTime();
};

function monthBuckets(from: Date, to: Date) {
  const buckets: { key: string; label: string }[] = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cur <= end && buckets.length < 24) {
    buckets.push({
      key: `${cur.getFullYear()}-${cur.getMonth()}`,
      label: cur.toLocaleString("en-US", { month: "short", year: "2-digit" }),
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  return buckets;
}
const monthKey = (d: Date | string) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${dt.getMonth()}`;
};

const titleCase = (s: string) =>
  s
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

type ReportPayload = {
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

type Builder = (from: Date, to: Date) => Promise<Omit<ReportPayload, "type" | "from" | "to">>;

const builders: Record<string, Builder> = {
  "lead-conversion": async (from, to) => {
    const leads = (await db.select().from(leadsTable)).filter((l) =>
      inRange(l.createdAt, from, to),
    );
    const converted = leads.filter(
      (l) => l.phase === "won" || l.status === "converted",
    );
    const bySource = new Map<string, { total: number; won: number }>();
    for (const l of leads) {
      const e = bySource.get(l.source) ?? { total: 0, won: 0 };
      e.total += 1;
      if (l.phase === "won" || l.status === "converted") e.won += 1;
      bySource.set(l.source, e);
    }
    const rate = leads.length ? (converted.length / leads.length) * 100 : 0;
    const avgScore = leads.length
      ? leads.reduce((s, l) => s + l.aiScore, 0) / leads.length
      : 0;
    return {
      label: "Lead Conversion",
      kpis: [
        { label: "Total Leads", value: String(leads.length) },
        { label: "Converted", value: String(converted.length) },
        { label: "Conversion Rate", value: pct(rate) },
        { label: "Avg AI Score", value: String(Math.round(avgScore)) },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Leads",
        secondaryLabel: "Converted",
        points: Array.from(bySource.entries()).map(([source, e]) => ({
          label: titleCase(source),
          value: e.total,
          secondary: e.won,
        })),
      },
      table: {
        columns: ["Source", "Leads", "Converted", "Conversion Rate"],
        rows: Array.from(bySource.entries()).map(([source, e]) => [
          titleCase(source),
          String(e.total),
          String(e.won),
          pct(e.total ? (e.won / e.total) * 100 : 0),
        ]),
      },
    };
  },

  sales: async (from, to) => {
    const deals = (await db.select().from(dealsTable)).filter((d) =>
      inRange(d.createdAt, from, to),
    );
    const delivered = deals.filter((d) => d.stage === "delivered");
    const buckets = monthBuckets(from, to);
    const byAdvisor = new Map<string, { deals: number; delivered: number; revenue: number }>();
    for (const d of deals) {
      const name = d.salesAdvisor || "Unassigned";
      const e = byAdvisor.get(name) ?? { deals: 0, delivered: 0, revenue: 0 };
      e.deals += 1;
      if (d.stage === "delivered") {
        e.delivered += 1;
        e.revenue += d.otdPrice || 0;
      }
      byAdvisor.set(name, e);
    }
    return {
      label: "Sales",
      kpis: [
        { label: "Total Deals", value: String(deals.length) },
        { label: "Units Delivered", value: String(delivered.length) },
        {
          label: "Delivered Revenue",
          value: money(delivered.reduce((s, d) => s + (d.otdPrice || 0), 0)),
        },
        {
          label: "Avg Deal Size",
          value: money(
            delivered.length
              ? delivered.reduce((s, d) => s + (d.otdPrice || 0), 0) /
                  delivered.length
              : 0,
          ),
        },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Units delivered",
        points: buckets.map((b) => ({
          label: b.label,
          value: delivered.filter((d) => monthKey(d.createdAt) === b.key).length,
        })),
      },
      table: {
        columns: ["Sales Advisor", "Deals", "Delivered", "Revenue"],
        rows: Array.from(byAdvisor.entries())
          .sort((a, b) => b[1].revenue - a[1].revenue)
          .map(([name, e]) => [
            name,
            String(e.deals),
            String(e.delivered),
            money(e.revenue),
          ]),
      },
    };
  },

  revenue: async (from, to) => {
    const [deals, payments, invoices] = await Promise.all([
      db.select().from(dealsTable),
      db.select().from(paymentsTable),
      db.select().from(invoicesTable),
    ]);
    const delivered = deals.filter(
      (d) => d.stage === "delivered" && inRange(d.createdAt, from, to),
    );
    const paymentsIn = payments.filter((p) => inRange(p.createdAt, from, to));
    const openInvoices = invoices.filter((i) => i.status !== "paid" && i.status !== "void");
    const buckets = monthBuckets(from, to);
    return {
      label: "Revenue",
      kpis: [
        {
          label: "Delivered Revenue",
          value: money(delivered.reduce((s, d) => s + (d.otdPrice || 0), 0)),
        },
        {
          label: "Payments Received",
          value: money(paymentsIn.reduce((s, p) => s + p.amount, 0)),
        },
        {
          label: "Outstanding Invoices",
          value: money(openInvoices.reduce((s, i) => s + i.amount, 0)),
          sub: `${openInvoices.length} open`,
        },
        { label: "Units Delivered", value: String(delivered.length) },
      ],
      chart: {
        kind: "area",
        valueLabel: "Delivered revenue",
        secondaryLabel: "Payments received",
        currency: true,
        points: buckets.map((b) => ({
          label: b.label,
          value: delivered
            .filter((d) => monthKey(d.createdAt) === b.key)
            .reduce((s, d) => s + (d.otdPrice || 0), 0),
          secondary: paymentsIn
            .filter((p) => monthKey(p.createdAt) === b.key)
            .reduce((s, p) => s + p.amount, 0),
        })),
      },
      table: {
        columns: ["Month", "Delivered Revenue", "Payments Received", "Units"],
        rows: buckets.map((b) => {
          const del = delivered.filter((d) => monthKey(d.createdAt) === b.key);
          return [
            b.label,
            money(del.reduce((s, d) => s + (d.otdPrice || 0), 0)),
            money(
              paymentsIn
                .filter((p) => monthKey(p.createdAt) === b.key)
                .reduce((s, p) => s + p.amount, 0),
            ),
            String(del.length),
          ];
        }),
      },
    };
  },

  inventory: async () => {
    const vehicles = await db.select().from(vehiclesTable);
    const available = vehicles.filter((v) => v.status === "available");
    const byPowertrain = new Map<string, number>();
    const byMake = new Map<string, { count: number; value: number }>();
    for (const v of vehicles) {
      byPowertrain.set(v.powertrain, (byPowertrain.get(v.powertrain) ?? 0) + 1);
      const e = byMake.get(v.make) ?? { count: 0, value: 0 };
      e.count += 1;
      e.value += v.price;
      byMake.set(v.make, e);
    }
    return {
      label: "Inventory",
      kpis: [
        { label: "Total Vehicles", value: String(vehicles.length) },
        { label: "Available", value: String(available.length) },
        {
          label: "Stock Value",
          value: money(available.reduce((s, v) => s + v.price, 0)),
        },
        {
          label: "Avg Price",
          value: money(
            vehicles.length
              ? vehicles.reduce((s, v) => s + v.price, 0) / vehicles.length
              : 0,
          ),
        },
      ],
      chart: {
        kind: "pie",
        valueLabel: "Vehicles",
        points: Array.from(byPowertrain.entries()).map(([p, count]) => ({
          label: p,
          value: count,
        })),
      },
      table: {
        columns: ["Make", "Vehicles", "Total Value", "Avg Price"],
        rows: Array.from(byMake.entries())
          .sort((a, b) => b[1].count - a[1].count)
          .map(([make, e]) => [
            make,
            String(e.count),
            money(e.value),
            money(e.value / e.count),
          ]),
      },
    };
  },

  finance: async (from, to) => {
    const apps = (await db.select().from(financeApplicationsTable)).filter((a) =>
      inRange(a.createdAt, from, to),
    );
    const approved = apps.filter(
      (a) => a.status === "approved" || a.status === "disbursed",
    );
    const declined = apps.filter((a) => a.status === "declined");
    const disbursed = apps.filter((a) => a.status === "disbursed");
    const byStatus = new Map<string, number>();
    for (const a of apps) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    const decided = approved.length + declined.length;
    return {
      label: "Finance",
      kpis: [
        { label: "Applications", value: String(apps.length) },
        {
          label: "Approval Rate",
          value: pct(decided ? (approved.length / decided) * 100 : 0),
          sub: `${approved.length} approved / ${declined.length} declined`,
        },
        {
          label: "Financed Amount",
          value: money(approved.reduce((s, a) => s + a.amount, 0)),
        },
        {
          label: "Disbursed",
          value: money(disbursed.reduce((s, a) => s + a.amount, 0)),
        },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Applications",
        points: Array.from(byStatus.entries()).map(([status, count]) => ({
          label: titleCase(status),
          value: count,
        })),
      },
      table: {
        columns: ["Customer", "Amount", "Lender", "Status", "Term"],
        rows: apps
          .slice()
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 25)
          .map((a) => [
            a.customerName,
            money(a.amount),
            a.lender ?? "—",
            titleCase(a.status),
            `${a.termMonths} mo`,
          ]),
      },
    };
  },

  delivery: async (from, to) => {
    const deliveries = (await db.select().from(deliveriesTable)).filter((d) =>
      inRange(d.createdAt, from, to),
    );
    const completed = deliveries.filter((d) => d.status === "completed");
    const byStep = new Map<string, number>();
    for (const d of deliveries)
      byStep.set(d.currentStep, (byStep.get(d.currentStep) ?? 0) + 1);
    const rated = completed.filter((d) => d.feedbackRating != null);
    return {
      label: "Delivery",
      kpis: [
        { label: "Deliveries", value: String(deliveries.length) },
        { label: "Completed", value: String(completed.length) },
        {
          label: "In Progress",
          value: String(deliveries.filter((d) => d.status === "in_progress").length),
        },
        {
          label: "Avg Feedback",
          value: rated.length
            ? `${(
                rated.reduce((s, d) => s + (d.feedbackRating ?? 0), 0) /
                rated.length
              ).toFixed(1)} / 5`
            : "—",
        },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Deliveries",
        points: Array.from(byStep.entries()).map(([step, count]) => ({
          label: titleCase(step),
          value: count,
        })),
      },
      table: {
        columns: ["Customer", "Status", "Current Step", "Feedback"],
        rows: deliveries
          .slice(0, 25)
          .map((d) => [
            d.customerName ?? `Deal #${d.dealId}`,
            titleCase(d.status),
            titleCase(d.currentStep),
            d.feedbackRating != null ? `${d.feedbackRating}/5` : "—",
          ]),
      },
    };
  },

  service: async (from, to) => {
    const orders = (await db.select().from(serviceOrdersTable)).filter((o) =>
      inRange(o.createdAt, from, to),
    );
    const completed = orders.filter(
      (o) => o.status === "completed" || o.status === "delivered",
    );
    const byType = new Map<string, number>();
    const byStatus = new Map<string, number>();
    for (const o of orders) {
      byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
      byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    }
    return {
      label: "Service",
      kpis: [
        { label: "Service Orders", value: String(orders.length) },
        { label: "Completed", value: String(completed.length) },
        { label: "Open", value: String(orders.length - completed.length) },
        {
          label: "Estimated Value",
          value: money(orders.reduce((s, o) => s + o.estimatedCost, 0)),
        },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Orders",
        points: Array.from(byType.entries()).map(([t, count]) => ({
          label: titleCase(t),
          value: count,
        })),
      },
      table: {
        columns: ["Status", "Orders", "Share"],
        rows: Array.from(byStatus.entries()).map(([status, count]) => [
          titleCase(status),
          String(count),
          pct(orders.length ? (count / orders.length) * 100 : 0),
        ]),
      },
    };
  },

  "employee-performance": async (from, to) => {
    const [users, roles, deals, jobCards, leads] = await Promise.all([
      db.select().from(usersTable),
      db.select().from(rolesTable),
      db.select().from(dealsTable),
      db.select().from(jobCardsTable),
      db.select().from(leadsTable),
    ]);
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const dealsIn = deals.filter((d) => inRange(d.createdAt, from, to));
    const cardsIn = jobCards.filter((c) => inRange(c.createdAt, from, to));
    const leadsIn = leads.filter((l) => inRange(l.createdAt, from, to));

    const rows = users.map((u) => {
      const name = u.name ?? u.email ?? `User #${u.id}`;
      const myDeals = dealsIn.filter((d) => d.salesAdvisor === name);
      const myDelivered = myDeals.filter((d) => d.stage === "delivered");
      const myCards = cardsIn.filter((c) => c.technicianUserId === u.id);
      const myLeads = leadsIn.filter(
        (l) => l.assignedTo === name || l.ownerUserId === u.id,
      );
      return {
        name,
        role: (u.roleId != null && roleName.get(u.roleId)) || "—",
        leads: myLeads.length,
        deals: myDeals.length,
        revenue: myDelivered.reduce((s, d) => s + (d.otdPrice || 0), 0),
        jobs: myCards.filter((c) => c.status === "completed").length,
        hours: myCards.reduce((s, c) => s + c.laborHours, 0),
      };
    });
    const active = rows.filter(
      (r) => r.leads || r.deals || r.jobs || r.hours,
    );
    const list = active.length ? active : rows;
    return {
      label: "Employee Performance",
      kpis: [
        { label: "Team Members", value: String(users.length) },
        {
          label: "Deals Worked",
          value: String(dealsIn.length),
        },
        {
          label: "Jobs Completed",
          value: String(cardsIn.filter((c) => c.status === "completed").length),
        },
        {
          label: "Labour Hours",
          value: String(Math.round(cardsIn.reduce((s, c) => s + c.laborHours, 0))),
        },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Revenue",
        currency: true,
        points: list
          .slice()
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 8)
          .map((r) => ({ label: r.name, value: r.revenue })),
      },
      table: {
        columns: ["Employee", "Role", "Leads", "Deals", "Revenue", "Jobs Done", "Hours"],
        rows: list.map((r) => [
          r.name,
          r.role,
          String(r.leads),
          String(r.deals),
          money(r.revenue),
          String(r.jobs),
          String(Math.round(r.hours * 10) / 10),
        ]),
      },
    };
  },

  marketing: async (from, to) => {
    const [emails, leads] = await Promise.all([
      db.select().from(emailLogsTable),
      db.select().from(leadsTable),
    ]);
    const emailsIn = emails.filter((e) => inRange(e.createdAt, from, to));
    const leadsIn = leads.filter((l) => inRange(l.createdAt, from, to));
    const sent = emailsIn.filter((e) => e.status === "sent");
    const byTemplate = new Map<string, { total: number; sent: number }>();
    for (const e of emailsIn) {
      const t = byTemplate.get(e.template) ?? { total: 0, sent: 0 };
      t.total += 1;
      if (e.status === "sent") t.sent += 1;
      byTemplate.set(e.template, t);
    }
    const digital = leadsIn.filter((l) =>
      ["website", "facebook", "instagram", "whatsapp"].includes(l.source),
    );
    return {
      label: "Marketing",
      kpis: [
        { label: "Emails Queued", value: String(emailsIn.length) },
        {
          label: "Delivery Rate",
          value: pct(emailsIn.length ? (sent.length / emailsIn.length) * 100 : 0),
          sub: `${sent.length} sent`,
        },
        { label: "New Leads", value: String(leadsIn.length) },
        {
          label: "Digital Share",
          value: pct(leadsIn.length ? (digital.length / leadsIn.length) * 100 : 0),
        },
      ],
      chart: {
        kind: "bar",
        valueLabel: "Emails",
        secondaryLabel: "Delivered",
        points: Array.from(byTemplate.entries())
          .sort((a, b) => b[1].total - a[1].total)
          .slice(0, 10)
          .map(([template, t]) => ({
            label: titleCase(template),
            value: t.total,
            secondary: t.sent,
          })),
      },
      table: {
        columns: ["Campaign / Template", "Queued", "Delivered", "Delivery Rate"],
        rows: Array.from(byTemplate.entries()).map(([template, t]) => [
          titleCase(template),
          String(t.total),
          String(t.sent),
          pct(t.total ? (t.sent / t.total) * 100 : 0),
        ]),
      },
    };
  },

  "customer-retention": async (from, to) => {
    const customers = await db.select().from(customersTable);
    const newCustomers = customers.filter((c) => inRange(c.createdAt, from, to));
    const repeat = customers.filter((c) => c.vehiclesOwned > 1);
    const byTier = new Map<string, number>();
    for (const c of customers)
      byTier.set(c.loyaltyTier, (byTier.get(c.loyaltyTier) ?? 0) + 1);
    return {
      label: "Customer Retention",
      kpis: [
        { label: "Total Customers", value: String(customers.length) },
        { label: "New In Period", value: String(newCustomers.length) },
        {
          label: "Repeat Owners",
          value: pct(
            customers.length ? (repeat.length / customers.length) * 100 : 0,
          ),
          sub: `${repeat.length} customers`,
        },
        {
          label: "Avg Lifetime Value",
          value: money(
            customers.length
              ? customers.reduce((s, c) => s + c.lifetimeValue, 0) /
                  customers.length
              : 0,
          ),
        },
      ],
      chart: {
        kind: "pie",
        valueLabel: "Customers",
        points: Array.from(byTier.entries()).map(([tier, count]) => ({
          label: titleCase(tier),
          value: count,
        })),
      },
      table: {
        columns: ["Customer", "Loyalty Tier", "Vehicles Owned", "Lifetime Value"],
        rows: customers
          .slice()
          .sort((a, b) => b.lifetimeValue - a.lifetimeValue)
          .slice(0, 25)
          .map((c) => [
            c.name,
            titleCase(c.loyaltyTier),
            String(c.vehiclesOwned),
            money(c.lifetimeValue),
          ]),
      },
    };
  },
};

router.get("/reports", async (req, res): Promise<void> => {
  const type = String(req.query.type ?? "");
  const builder = builders[type];
  if (!builder) {
    res.status(400).json({ error: `Unknown report type: ${type}` });
    return;
  }
  const user = res.locals.user;
  const module = REPORT_MODULE[type]!;
  if (!user || !hasPermission(user, module, "view")) {
    res.status(403).json({ error: `Missing permission: view on ${module}` });
    return;
  }
  const { from, to } = parseRange(
    typeof req.query.from === "string" ? req.query.from : undefined,
    typeof req.query.to === "string" ? req.query.to : undefined,
  );
  const body = await builder(from, to);
  res.json(
    GetReportResponse.parse({
      type,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      ...body,
    }),
  );
});

export default router;
