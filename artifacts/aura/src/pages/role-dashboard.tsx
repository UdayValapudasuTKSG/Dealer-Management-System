import type { ComponentType } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import {
  useListLeads,
  useListDeals,
  useListDeliveries,
  useListGates,
  useListFinanceApplications,
  useListServiceOrders,
  useListJobCards,
  useListParts,
  useGetPipeline,
  useGetReport,
  useListVehicles,
} from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  Target,
  GitBranch,
  Landmark,
  Wrench,
  Truck,
  Megaphone,
  Boxes,
  ShieldAlert,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LineChart,
  Line,
} from "recharts";
import Dashboard from "./dashboard";

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--popover-border))",
  borderRadius: "12px",
  backdropFilter: "blur(10px)",
} as const;

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const PHASE_LABEL: Record<string, string> = {
  aware: "New Lead",
  consider: "Qualified",
  engage: "Test Drive",
  negotiate: "Desking",
  won: "Sold",
  lost: "Lost",
};

export default function RoleDashboard() {
  const { me, isLoading } = useAuthz();
  if (isLoading || !me) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  const role = me.roleName ?? "";
  const byRole: Record<string, ComponentType> = {
    "Sales Manager": SalesManagerDashboard,
    "Finance Manager": FinanceManagerDashboard,
    "Marketing Advisor": MarketingDashboard,
    "Marketing Coordinator": MarketingDashboard,
    "Service Manager": ServiceDashboard,
    "Service Advisor": ServiceDashboard,
    Technician: TechnicianDashboard,
    "Sales Advisor": SalesAdvisorDashboard,
    "Delivery Advisor": DeliveryAdvisorDashboard,
    "Parts Advisor": PartsAdvisorDashboard,
  };
  const Focused = byRole[role];
  if (!Focused) return <Dashboard />;
  return <Focused />;
}

/* ---------- shared building blocks ---------- */

function FocusShell({
  icon: Icon,
  kicker,
  title,
  children,
}: {
  icon: typeof Target;
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-5 md:px-8 py-6 md:py-8 space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-1">
            <Icon className="w-3.5 h-3.5" />
            {kicker}
          </div>
          <h1 className="text-2xl md:text-[1.75rem] font-semibold tracking-tight">
            {title}
          </h1>
        </motion.div>
        {children}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  delay = 0,
}: {
  label: string;
  value: string | number;
  sub?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4 }}
    >
      <Card className="glass-panel border-none shadow-lg">
        <CardContent className="p-5">
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {label}
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">{value}</h2>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function Panel({
  title,
  href,
  linkLabel,
  children,
  className,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={`glass-panel border-none shadow-xl flex flex-col ${className ?? ""}`}>
      <div className="p-6 pb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold tracking-wide">{title}</h3>
        {href && (
          <Link
            href={href}
            className="text-sm text-primary font-medium flex items-center gap-1 hover:gap-2 transition-all"
          >
            {linkLabel ?? "Open"}
            <ArrowRight className="w-4 h-4" />
          </Link>
        )}
      </div>
      <CardContent className="px-6 pb-6 pt-0 flex-1">{children}</CardContent>
    </Card>
  );
}

function Row({
  title,
  subtitle,
  badge,
}: {
  title: string;
  subtitle?: string | null;
  badge?: string | null;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/[0.05] last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        )}
      </div>
      {badge && (
        <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {badge.replace(/_/g, " ")}
        </span>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-10 flex flex-col items-center justify-center text-center">
      <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-2">
        <CheckCircle2 className="w-5 h-5" />
      </div>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(0 0% 62%)",
  "hsl(0 60% 62%)",
  "hsl(0 0% 42%)",
  "hsl(0 30% 50%)",
  "hsl(0 0% 75%)",
];

const AXIS_TICK = { fontSize: 12, fill: "hsl(var(--muted-foreground))" } as const;
const LEGEND_STYLE = { fontSize: 12, color: "hsl(var(--muted-foreground))" } as const;

function weekKey(dateStr: string) {
  const d = new Date(dateStr);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

const weekLabel = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

/* ---------- role dashboards ---------- */

function SalesManagerDashboard() {
  const { me } = useAuthz();
  const { data: pipeline } = useGetPipeline();
  const { data: deals } = useListDeals();
  const { data: leads } = useListLeads();
  const { data: vehicles } = useListVehicles();

  const open = (deals ?? []).filter((d) =>
    ["desking", "negotiation", "finance", "committed"].includes(d.stage),
  );
  const delivered = (deals ?? []).filter((d) => d.stage === "delivered");
  const openValue = open.reduce((s, d) => s + (d.otdPrice || 0), 0);
  const unassigned = (leads ?? []).filter(
    (l) => !l.assignedTo && l.phase !== "won" && l.phase !== "lost",
  );
  const chart = (pipeline ?? []).map((p) => ({
    label: PHASE_LABEL[p.phase] ?? p.label,
    value: p.count,
  }));

  const advisorPerf = Object.values(
    (deals ?? []).reduce<Record<string, { advisor: string; open: number; delivered: number }>>(
      (acc, d) => {
        const key = d.salesAdvisor ?? "Unassigned";
        acc[key] ??= { advisor: key, open: 0, delivered: 0 };
        if (d.stage === "delivered") acc[key].delivered += 1;
        else if (d.stage !== "lost") acc[key].open += 1;
        return acc;
      },
      {},
    ),
  )
    .sort((a, b) => b.delivered + b.open - (a.delivered + a.open))
    .slice(0, 6);

  const modelName = new Map(
    (vehicles ?? []).map((v) => [v.id, `${v.make} ${v.model}`]),
  );
  const salesByModel = Object.values(
    (deals ?? [])
      .filter((d) => d.stage !== "lost")
      .reduce<Record<string, { model: string; value: number; units: number }>>((acc, d) => {
        const key = modelName.get(d.vehicleId) ?? `Vehicle #${d.vehicleId}`;
        acc[key] ??= { model: key, value: 0, units: 0 };
        acc[key].value += d.otdPrice || d.vehiclePrice || 0;
        acc[key].units += 1;
        return acc;
      }, {}),
  )
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  return (
    <FocusShell
      icon={GitBranch}
      kicker="Sales Manager · Pipeline Command"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${open.length} deals in motion.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Open Deals" value={open.length} sub={money(openValue)} />
        <StatCard label="Delivered" value={delivered.length} sub="all time" delay={0.05} />
        <StatCard label="Live Leads" value={(leads ?? []).filter((l) => l.phase !== "won" && l.phase !== "lost").length} delay={0.1} />
        <StatCard label="Unassigned Leads" value={unassigned.length} sub="need an advisor" delay={0.15} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Panel title="Pipeline by Stage" href="/pipeline" linkLabel="Open pipeline" className="lg:col-span-2">
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} width={32} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Bar dataKey="value" name="Leads" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Active Deals" href="/deals" linkLabel="All deals">
          {open.length === 0 ? (
            <Empty text="No open deals right now." />
          ) : (
            open.slice(0, 7).map((d) => (
              <Row
                key={d.id}
                title={d.customerName ?? `Deal #${d.id}`}
                subtitle={`${money(d.otdPrice || 0)} · ${d.salesAdvisor ?? "Unassigned"}`}
                badge={d.stage}
              />
            ))
          )}
        </Panel>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Advisor Performance" href="/deals" linkLabel="All deals">
          {advisorPerf.length === 0 ? (
            <Empty text="No deals recorded yet." />
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={advisorPerf} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis type="number" axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} />
                  <YAxis type="category" dataKey="advisor" axisLine={false} tickLine={false} tick={AXIS_TICK} width={110} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                  <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
                  <Bar dataKey="delivered" name="Delivered" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} maxBarSize={18} />
                  <Bar dataKey="open" name="Open" stackId="a" fill="hsl(0 0% 55%)" radius={[0, 4, 4, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
        <Panel title="Sales by Model" href="/inventory" linkLabel="Inventory">
          {salesByModel.length === 0 ? (
            <Empty text="No deal value to chart yet." />
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={salesByModel} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis type="number" axisLine={false} tickLine={false} tick={AXIS_TICK} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
                  <YAxis type="category" dataKey="model" axisLine={false} tickLine={false} tick={AXIS_TICK} width={130} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} formatter={(v: number, name: string) => (name === "Deal Value" ? money(v) : v)} />
                  <Bar dataKey="value" name="Deal Value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>
    </FocusShell>
  );
}

function FinanceManagerDashboard() {
  const { me } = useAuthz();
  const { data: gates } = useListGates({ status: "pending" });
  const { data: apps } = useListFinanceApplications();

  const pending = (apps ?? []).filter((a) =>
    ["pending", "submitted", "under_review"].includes(a.status),
  );
  const approved = (apps ?? []).filter(
    (a) => a.status === "approved" || a.status === "disbursed",
  );
  const financed = approved.reduce((s, a) => s + a.amount, 0);

  const APP_STAGES = ["pending", "submitted", "under_review", "approved", "declined", "disbursed"] as const;
  const appFunnel = APP_STAGES.map((stage) => {
    const rows = (apps ?? []).filter((a) => a.status === stage);
    return {
      label: stage.replace(/_/g, " "),
      count: rows.length,
      amount: rows.reduce((s, a) => s + a.amount, 0),
    };
  });

  return (
    <FocusShell
      icon={Landmark}
      kicker="Finance Manager · F&I Desk"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${(gates ?? []).length} approvals waiting.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Pending Approvals" value={(gates ?? []).length} sub="decision gates" />
        <StatCard label="Applications In Flight" value={pending.length} delay={0.05} />
        <StatCard label="Approved" value={approved.length} delay={0.1} />
        <StatCard label="Financed Amount" value={money(financed)} delay={0.15} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Decisions that need you" href="/approvals" linkLabel="Review all">
          {(gates ?? []).length === 0 ? (
            <Empty text="No approvals waiting. All clear." />
          ) : (
            (gates ?? []).slice(0, 7).map((g) => (
              <Row key={g.id} title={g.title} subtitle={g.summary} badge={g.priority} />
            ))
          )}
        </Panel>
        <Panel title="Applications In Flight" href="/finance" linkLabel="Open F&I">
          {pending.length === 0 ? (
            <Empty text="No applications awaiting a decision." />
          ) : (
            pending.slice(0, 7).map((a) => (
              <Row
                key={a.id}
                title={a.customerName}
                subtitle={`${money(a.amount)} · ${a.lender ?? "No lender yet"}`}
                badge={a.status}
              />
            ))
          )}
        </Panel>
      </div>
      <Panel title="Application Pipeline" href="/finance" linkLabel="Open F&I">
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={appFunnel} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={AXIS_TICK} />
              <YAxis yAxisId="count" axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
              <YAxis yAxisId="amount" orientation="right" axisLine={false} tickLine={false} tick={AXIS_TICK} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} width={48} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} formatter={(v: number, name: string) => (name === "Amount" ? money(v) : v)} />
              <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
              <Bar yAxisId="count" dataKey="count" name="Applications" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={40} />
              <Bar yAxisId="amount" dataKey="amount" name="Amount" fill="hsl(0 0% 55%)" radius={[6, 6, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </FocusShell>
  );
}

function MarketingDashboard() {
  const { me } = useAuthz();
  const { data: report, isLoading } = useGetReport({ type: "marketing" });
  const { data: leads } = useListLeads();
  const recent = (leads ?? [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 7);

  const sourceCounts = (leads ?? []).reduce<Record<string, number>>((acc, l) => {
    acc[l.source] = (acc[l.source] ?? 0) + 1;
    return acc;
  }, {});
  const topSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s]) => s);
  const weeks: string[] = [];
  {
    const now = new Date();
    for (let i = 7; i >= 0; i--) {
      const w = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 7);
      weeks.push(weekKey(w.toISOString()));
    }
  }
  const leadsOverTime = weeks.map((w) => {
    const row: Record<string, string | number> = { week: weekLabel(w) };
    for (const s of topSources) row[s] = 0;
    for (const l of leads ?? []) {
      if (weekKey(l.createdAt) === w && topSources.includes(l.source)) {
        row[l.source] = (row[l.source] as number) + 1;
      }
    }
    return row;
  });

  return (
    <FocusShell
      icon={Megaphone}
      kicker="Marketing · Campaign Analytics"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. Here's how campaigns are landing.`}
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {(report?.kpis ?? []).map((k, i) => (
              <StatCard key={k.label} label={k.label} value={k.value} sub={k.sub ?? undefined} delay={i * 0.05} />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Panel title="Campaign Delivery" href="/reports" linkLabel="Full report" className="lg:col-span-2">
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(report?.chart.points ?? []).map((p) => ({ label: p.label, value: p.value, secondary: p.secondary ?? 0 }))} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval={0} angle={-15} dy={6} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                    <Bar dataKey="value" name="Queued" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={40} />
                    <Bar dataKey="secondary" name="Delivered" fill="hsl(0 0% 55%)" radius={[6, 6, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel title="Newest Leads" href="/pipeline" linkLabel="Pipeline">
              {recent.length === 0 ? (
                <Empty text="No leads yet." />
              ) : (
                recent.map((l) => (
                  <Row key={l.id} title={l.name} subtitle={l.source.replace(/_/g, " ")} badge={PHASE_LABEL[l.phase] ?? l.phase} />
                ))
              )}
            </Panel>
          </div>
          <Panel title="Leads Created Over Time" href="/pipeline" linkLabel="Pipeline">
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={leadsOverTime} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="week" axisLine={false} tickLine={false} tick={AXIS_TICK} />
                  <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ stroke: "hsl(var(--foreground) / 0.15)" }} />
                  <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
                  {topSources.map((s, i) => (
                    <Line
                      key={s}
                      type="monotone"
                      dataKey={s}
                      name={s.replace(/_/g, " ")}
                      stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3, strokeWidth: 0, fill: SERIES_COLORS[i % SERIES_COLORS.length] }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </>
      )}
    </FocusShell>
  );
}

function ServiceDashboard() {
  const { me } = useAuthz();
  const { data: orders } = useListServiceOrders();
  const { data: cards } = useListJobCards();

  const openOrders = (orders ?? []).filter(
    (o) => o.status !== "completed" && o.status !== "delivered",
  );
  const today = new Date().toISOString().slice(0, 10);
  const todays = (orders ?? []).filter((o) => o.scheduledDate === today);
  const activeCards = (cards ?? []).filter((c) => c.status !== "completed");

  const laneLoad = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    return {
      label: d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }),
      bookings: (orders ?? []).filter((o) => o.scheduledDate === key).length,
    };
  });

  const CARD_STAGES = ["open", "in_progress", "quality_check", "completed"] as const;
  const cardFlow = CARD_STAGES.map((s) => ({
    label: s.replace(/_/g, " "),
    count: (cards ?? []).filter((c) => c.status === s).length,
  }));

  return (
    <FocusShell
      icon={Wrench}
      kicker="Service · Lane Overview"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${openOrders.length} orders in the lane.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Open Orders" value={openOrders.length} />
        <StatCard label="Scheduled Today" value={todays.length} delay={0.05} />
        <StatCard label="Active Job Cards" value={activeCards.length} delay={0.1} />
        <StatCard
          label="Completed"
          value={(orders ?? []).length - openOrders.length}
          sub="all time"
          delay={0.15}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Today's Bookings" href="/service" linkLabel="Service desk">
          {todays.length === 0 ? (
            <Empty text="Nothing scheduled for today." />
          ) : (
            todays.slice(0, 7).map((o) => (
              <Row key={o.id} title={o.customerName ?? o.vehicleInfo} subtitle={o.vehicleInfo} badge={o.status} />
            ))
          )}
        </Panel>
        <Panel title="Workshop Floor" href="/service?tab=jobs" linkLabel="Job cards">
          {activeCards.length === 0 ? (
            <Empty text="No active job cards." />
          ) : (
            activeCards.slice(0, 7).map((c) => (
              <Row key={c.id} title={c.title} subtitle={c.technicianName ?? "Unassigned"} badge={c.status} />
            ))
          )}
        </Panel>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Lane Load — Next 7 Days" href="/service" linkLabel="Bookings">
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={laneLoad} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={AXIS_TICK} />
                <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Bar dataKey="bookings" name="Bookings" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Job Card Flow" href="/service?tab=jobs" linkLabel="Job cards">
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cardFlow} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={AXIS_TICK} />
                <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Bar dataKey="count" name="Job Cards" fill="hsl(0 0% 55%)" radius={[6, 6, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </FocusShell>
  );
}

function TechnicianDashboard() {
  const { me } = useAuthz();
  const { data: cards, isLoading } = useListJobCards({ mine: "1" });
  const active = (cards ?? []).filter((c) => c.status !== "completed");
  const done = (cards ?? []).filter((c) => c.status === "completed");
  const hours = (cards ?? []).reduce((s, c) => s + c.laborHours, 0);

  return (
    <FocusShell
      icon={Wrench}
      kicker="Technician · Today's Jobs"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${active.length} job${active.length === 1 ? "" : "s"} on your bench.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="My Open Jobs" value={active.length} />
        <StatCard label="In Progress" value={active.filter((c) => c.status === "in_progress").length} delay={0.05} />
        <StatCard label="Completed" value={done.length} delay={0.1} />
        <StatCard label="Labour Hours" value={Math.round(hours * 10) / 10} delay={0.15} />
      </div>
      <Panel title="My Job Cards" href="/workshop" linkLabel="Open workshop">
        {isLoading ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : active.length === 0 ? (
          <Empty text="No jobs assigned to you. Enjoy the calm." />
        ) : (
          active.map((c) => (
            <Row key={c.id} title={c.title} subtitle={`Service order #${c.serviceOrderId}`} badge={c.status} />
          ))
        )}
      </Panel>
    </FocusShell>
  );
}

function SalesAdvisorDashboard() {
  const { me } = useAuthz();
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();

  const mine = (leads ?? []).filter(
    (l) => l.ownerUserId === me?.id || (!!me?.name && l.assignedTo === me.name),
  );
  const activeLeads = mine.filter((l) => l.phase !== "won" && l.phase !== "lost");
  const myDeals = (deals ?? []).filter(
    (d) => !!me?.name && d.salesAdvisor === me.name,
  );
  const openDeals = myDeals.filter((d) => d.stage !== "delivered" && d.stage !== "lost");
  const hot = activeLeads.filter((l) => l.aiScore >= 75);

  const FUNNEL_PHASES = ["aware", "consider", "engage", "negotiate", "won"] as const;
  const myFunnel = FUNNEL_PHASES.map((p) => ({
    label: PHASE_LABEL[p],
    count: mine.filter((l) => l.phase === p).length,
  }));

  return (
    <FocusShell
      icon={Target}
      kicker="Sales Advisor · My Book"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${activeLeads.length} lead${activeLeads.length === 1 ? "" : "s"} working.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="My Active Leads" value={activeLeads.length} />
        <StatCard label="Hot Leads" value={hot.length} sub="AI score 75+" delay={0.05} />
        <StatCard label="My Open Deals" value={openDeals.length} delay={0.1} />
        <StatCard label="My Delivered" value={myDeals.filter((d) => d.stage === "delivered").length} delay={0.15} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="My Leads" href="/pipeline" linkLabel="Pipeline">
          {activeLeads.length === 0 ? (
            <Empty text="No leads assigned to you yet." />
          ) : (
            activeLeads
              .slice()
              .sort((a, b) => b.aiScore - a.aiScore)
              .slice(0, 7)
              .map((l) => (
                <Row key={l.id} title={l.name} subtitle={`Score ${l.aiScore} · ${l.source.replace(/_/g, " ")}`} badge={PHASE_LABEL[l.phase] ?? l.phase} />
              ))
          )}
        </Panel>
        <Panel title="My Deals" href="/deals" linkLabel="Deals">
          {openDeals.length === 0 ? (
            <Empty text="No open deals on your desk." />
          ) : (
            openDeals.slice(0, 7).map((d) => (
              <Row key={d.id} title={d.customerName ?? `Deal #${d.id}`} subtitle={money(d.otdPrice || 0)} badge={d.stage} />
            ))
          )}
        </Panel>
      </div>
      <Panel title="My Conversion Funnel" href="/pipeline" linkLabel="Pipeline">
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={myFunnel} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={AXIS_TICK} />
              <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
              <Bar dataKey="count" name="My Leads" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </FocusShell>
  );
}

function DeliveryAdvisorDashboard() {
  const { me } = useAuthz();
  const { data: deliveries } = useListDeliveries();

  const all = deliveries ?? [];
  const mine = all.filter((d) => d.advisorUserId === me?.id);
  const list = mine.length > 0 ? mine : all;
  const inProgress = list.filter((d) => d.status === "in_progress");
  const completed = list.filter((d) => d.status === "completed");

  return (
    <FocusShell
      icon={Truck}
      kicker="Delivery Advisor · Handover Board"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${inProgress.length} handover${inProgress.length === 1 ? "" : "s"} in motion.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="In Progress" value={inProgress.length} />
        <StatCard label="Completed" value={completed.length} delay={0.05} />
        <StatCard label="Assigned To Me" value={mine.length} delay={0.1} />
        <StatCard
          label="Avg Feedback"
          value={
            completed.filter((d) => d.feedbackRating != null).length
              ? `${(
                  completed.reduce((s, d) => s + (d.feedbackRating ?? 0), 0) /
                  completed.filter((d) => d.feedbackRating != null).length
                ).toFixed(1)}/5`
              : "—"
          }
          delay={0.15}
        />
      </div>
      <Panel title="Deliveries In Motion" href="/deliveries" linkLabel="All deliveries">
        {inProgress.length === 0 ? (
          <Empty text="No deliveries in progress." />
        ) : (
          inProgress.slice(0, 8).map((d) => (
            <Row
              key={d.id}
              title={d.customerName ?? `Deal #${d.dealId}`}
              subtitle={`Step: ${d.currentStep.replace(/_/g, " ")}`}
              badge={d.status}
            />
          ))
        )}
      </Panel>
    </FocusShell>
  );
}

function PartsAdvisorDashboard() {
  const { me } = useAuthz();
  const { data: parts } = useListParts();

  const all = parts ?? [];
  const low = all.filter((p) => p.stock <= p.reorderLevel);
  const stockValue = all.reduce((s, p) => s + p.stock * p.unitCost, 0);

  const tightest = all
    .slice()
    .sort((a, b) => a.stock - a.reorderLevel - (b.stock - b.reorderLevel))
    .slice(0, 8)
    .map((p) => ({ name: p.name, stock: p.stock, reorder: p.reorderLevel }));

  return (
    <FocusShell
      icon={Boxes}
      kicker="Parts · Stockroom"
      title={`${greeting()}, ${me?.name?.split(" ")[0] ?? "there"}. ${low.length} part${low.length === 1 ? "" : "s"} below reorder level.`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Catalogue Lines" value={all.length} />
        <StatCard label="Low Stock" value={low.length} sub="at or below reorder" delay={0.05} />
        <StatCard label="Units On Hand" value={all.reduce((s, p) => s + p.stock, 0)} delay={0.1} />
        <StatCard label="Stock Value" value={money(stockValue)} sub="at cost" delay={0.15} />
      </div>
      <Panel title="Reorder Now" href="/parts" linkLabel="Parts desk">
        {low.length === 0 ? (
          <Empty text="Stock levels are healthy." />
        ) : (
          low.slice(0, 8).map((p) => (
            <Row
              key={p.id}
              title={p.name}
              subtitle={`${p.sku} · ${p.stock} in stock / reorder at ${p.reorderLevel}`}
              badge="low stock"
            />
          ))
        )}
      </Panel>
      <Panel title="Stock vs Reorder Level" href="/parts" linkLabel="Parts desk">
        {tightest.length === 0 ? (
          <Empty text="No parts in the catalogue yet." />
        ) : (
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tightest} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                <XAxis type="number" axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} />
                <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={AXIS_TICK} width={150} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
                <Bar dataKey="stock" name="In Stock" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} maxBarSize={12} />
                <Bar dataKey="reorder" name="Reorder Level" fill="hsl(0 0% 55%)" radius={[0, 4, 4, 0]} maxBarSize={12} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
    </FocusShell>
  );
}
