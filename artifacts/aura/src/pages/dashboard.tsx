import { Link } from "wouter";
import {
  useGetDashboardSummary,
  useGetSalesPerformance,
  useGetPipeline,
  useGetInventoryBreakdown,
  useListTimeline,
  useListGates,
} from "@workspace/api-client-react";
import type {
  Gate,
  TimelineEvent,
  PipelineStage,
  InventoryBreakdownItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  TrendingUp,
  Users,
  Bot,
  Zap,
  ShieldAlert,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  CheckCircle2,
  Clock,
  Layers,
  BarChart3,
  GitBranch,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";

const GATE_LABEL: Record<string, string> = {
  below_floor_price: "Below Floor Price",
  credit_decline: "Credit Decline",
  capital_order: "Capital Order",
  gra_filing: "GRA Filing",
  refund_release: "Refund Release",
};

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

const POWERTRAIN_COLORS: Record<string, string> = {
  EV: "hsl(0 82% 50%)",
  Hybrid: "hsl(18 82% 52%)",
  Petrol: "hsl(0 0% 58%)",
  Diesel: "hsl(0 0% 38%)",
};
const POWERTRAIN_FALLBACK = "hsl(0 0% 45%)";

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--popover-border))",
  borderRadius: "12px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
} as const;

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function deltaPct(series: number[]): number | null {
  if (series.length < 2) return null;
  const prev = series[series.length - 2];
  const cur = series[series.length - 1];
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: performance, isLoading: isLoadingPerf } = useGetSalesPerformance();
  const { data: pipeline } = useGetPipeline();
  const { data: inventory } = useGetInventoryBreakdown();
  const { data: timeline } = useListTimeline({ limit: 12 });
  const { data: gates } = useListGates({ status: "pending" });

  const sortedGates = [...(gates ?? [])].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1),
  );
  const agentEvents = (timeline ?? []).filter((e) => e.isAgent);

  const revenueTrend = (performance ?? []).map((p) => p.revenue);
  const revDelta = deltaPct(revenueTrend);
  const unitsDelta = deltaPct((performance ?? []).map((p) => p.units));

  return (
    <div className="h-full overflow-y-auto">
      {/* Compact cinematic briefing band */}
      <div className="relative h-[220px] w-full overflow-hidden bg-black">
        <video
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 w-full h-full object-cover opacity-50"
        >
          <source
            src={`${import.meta.env.BASE_URL}videos/red_car_leaving_showroom.mp4`}
            type="video/mp4"
          />
        </video>
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-black/40 z-10" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/50 to-transparent z-10" />

        <div className="relative z-20 h-full max-w-7xl mx-auto px-6 md:px-10 lg:px-14 flex flex-col justify-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground mb-3">
              <Bot className="w-4 h-4" />
              AURA Concierge · Command Center
            </div>
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground max-w-3xl leading-tight">
              {greeting()}. {briefingLine(summary, sortedGates.length)}
            </h1>
          </motion.div>
        </div>
      </div>

      <div className="px-6 md:px-10 lg:px-14 pb-14 -mt-12 relative z-30 max-w-7xl mx-auto space-y-6">
        {/* KPI Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          <KPICard
            title="Monthly Revenue"
            value={summary ? `$${(summary.monthlyRevenue / 1000).toFixed(1)}k` : "$0"}
            sub="Delivered this month"
            icon={TrendingUp}
            isLoading={isLoadingSummary}
            delay={0.05}
            accent
            delta={revDelta}
            trend={revenueTrend}
          />
          <KPICard
            title="Active Deals"
            value={summary?.activeDeals ?? 0}
            sub={summary ? `${summary.totalLeads} live leads` : "in motion"}
            icon={GitBranch}
            isLoading={isLoadingSummary}
            delay={0.1}
          />
          <KPICard
            title="Conversion"
            value={summary ? `${summary.conversionRate}%` : "0%"}
            sub="Lead to delivery"
            icon={Users}
            isLoading={isLoadingSummary}
            delay={0.15}
          />
          <KPICard
            title="Handled Autonomously"
            value={summary?.agentTasksToday ?? 0}
            sub={summary ? `${summary.avgResponseSeconds}s avg response` : "today"}
            icon={Zap}
            isLoading={isLoadingSummary}
            delay={0.2}
          />
        </div>

        {/* Revenue trajectory + Inventory mix */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl overflow-hidden">
            <ChartHeader
              icon={TrendingUp}
              title="Revenue Trajectory"
              sub="Delivered revenue over recent months"
            />
            <CardContent className="p-0 h-[260px]">
              {isLoadingPerf ? (
                <ChartLoader />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={performance}
                    margin={{ top: 16, right: 24, left: 8, bottom: 16 }}
                  >
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(val) => `$${val / 1000}k`} width={44} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      itemStyle={{ color: "hsl(var(--foreground))" }}
                      labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                      formatter={(val: number) => [`$${val.toLocaleString()}`, "Revenue"]}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={Layers}
              title="Inventory Mix"
              sub="Showroom stock by powertrain"
            />
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              <InventoryDonut data={inventory ?? []} />
            </CardContent>
          </Card>
        </div>

        {/* Pipeline + Units delivered */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={GitBranch}
              title="Sales Pipeline"
              sub="Opportunity value by stage"
            />
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              <PipelineFunnel stages={pipeline ?? []} />
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={BarChart3}
              title="Units Delivered"
              sub="Closed deals per month"
              delta={unitsDelta}
            />
            <CardContent className="px-4 pb-4 pt-0 flex-1 min-h-[220px]">
              <UnitsBar data={performance ?? []} />
            </CardContent>
          </Card>
        </div>

        {/* Decisions + Autonomous activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col">
            <div className="p-6 pb-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-primary" />
                  <h3 className="text-lg font-semibold tracking-wide">
                    Decisions that need you
                  </h3>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Reserved for a human. AURA handled the rest.
                </p>
              </div>
              {sortedGates.length > 0 && (
                <Link
                  href="/approvals"
                  className="text-sm text-primary font-medium flex items-center gap-1 hover:gap-2 transition-all shrink-0"
                >
                  Review all
                  <ArrowRight className="w-4 h-4" />
                </Link>
              )}
            </div>
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              {sortedGates.length === 0 ? (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center">
                  <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-3">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <p className="font-medium">All clear</p>
                  <p className="text-sm text-muted-foreground max-w-xs mt-1">
                    No decisions waiting. AURA has it under control.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {sortedGates.slice(0, 3).map((gate, i) => (
                    <DecisionRow key={gate.id} gate={gate} delay={i * 0.05} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <div className="p-6 pb-4 border-b border-border/50">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-primary" />
                <h3 className="text-lg font-semibold tracking-wide">
                  Autonomous activity
                </h3>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                What AURA did on its own.
              </p>
            </div>
            <CardContent className="flex-1 p-6 overflow-y-auto max-h-[360px]">
              {agentEvents.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No activity yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {agentEvents.slice(0, 6).map((event, i) => (
                    <ActivityRow key={event.id} event={event} delay={i * 0.04} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function briefingLine(
  summary:
    | {
        agentTasksToday: number;
        activeDeals: number;
      }
    | undefined,
  pendingCount: number,
): string {
  if (!summary) return "Bringing the dealership online...";
  const decisions =
    pendingCount === 0
      ? "you're all clear"
      : `${pendingCount} need${pendingCount > 1 ? "" : "s"} your sign-off`;
  return `${summary.agentTasksToday} tasks handled autonomously — ${decisions}.`;
}

function ChartHeader({
  icon: Icon,
  title,
  sub,
  delta,
}: {
  icon: any;
  title: string;
  sub?: string;
  delta?: number | null;
}) {
  return (
    <div className="p-6 pb-3 flex items-start justify-between">
      <div>
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          <h3 className="text-lg font-semibold tracking-wide">{title}</h3>
        </div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </div>
      {delta != null && <TrendBadge delta={delta} />}
    </div>
  );
}

function ChartLoader() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="animate-spin text-primary w-8 h-8" />
    </div>
  );
}

function TrendBadge({ delta, accent }: { delta: number; accent?: boolean }) {
  const up = delta >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-semibold rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ${
        accent
          ? "bg-white/20 text-white"
          : up
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-red-500/15 text-red-400"
      }`}
    >
      {up ? (
        <ArrowUpRight className="w-3 h-3" />
      ) : (
        <ArrowDownRight className="w-3 h-3" />
      )}
      {Math.abs(delta).toFixed(0)}%
    </span>
  );
}

function Sparkline({ data, accent }: { data: number[]; accent?: boolean }) {
  const points = data.map((v, i) => ({ i, v }));
  const stroke = accent ? "rgba(255,255,255,0.9)" : "hsl(var(--primary))";
  const gradId = accent ? "sparkAccent" : "sparkPrimary";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={accent ? 0.4 : 0.3} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={stroke}
          strokeWidth={2}
          fill={`url(#${gradId})`}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function KPICard({
  title,
  value,
  sub,
  icon: Icon,
  isLoading,
  delay,
  accent,
  delta,
  trend,
}: any) {
  const hasTrend = Array.isArray(trend) && trend.length > 1;
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <Card
        className={`border-none shadow-lg overflow-hidden group hover:shadow-xl transition-all duration-300 ${
          accent ? "bg-primary text-white" : "glass-panel"
        }`}
      >
        <CardContent className="p-5 relative">
          <div className="flex items-start justify-between">
            <p
              className={`text-[11px] font-medium uppercase tracking-widest ${
                accent ? "text-white/80" : "text-muted-foreground"
              }`}
            >
              {title}
            </p>
            <Icon
              className={`w-4 h-4 ${accent ? "text-white/60" : "text-muted-foreground/50"}`}
            />
          </div>
          {isLoading ? (
            <div className="h-8 w-16 bg-white/[0.05] rounded animate-pulse mt-3" />
          ) : (
            <>
              <div className="flex items-end gap-2 mt-3">
                <h2 className="text-3xl font-bold tracking-tight leading-none">
                  {value}
                </h2>
                {delta != null && <TrendBadge delta={delta} accent={accent} />}
              </div>
              {hasTrend ? (
                <div className="h-8 mt-3 -mb-1">
                  <Sparkline data={trend} accent={accent} />
                </div>
              ) : (
                <p
                  className={`text-xs mt-2 ${accent ? "text-white/70" : "text-muted-foreground"}`}
                >
                  {sub}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function DecisionRow({ gate, delay }: { gate: Gate; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay }}
    >
      <Link href="/approvals">
        <div className="group flex items-center gap-4 rounded-2xl border border-border/60 bg-white/[0.05] hover:bg-primary/5 hover:border-primary/30 transition-colors p-4 cursor-pointer">
          <div
            className={`w-1.5 self-stretch rounded-full shrink-0 ${
              gate.priority === "high"
                ? "bg-primary"
                : gate.priority === "normal"
                  ? "bg-amber-400"
                  : "bg-border"
            }`}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                {GATE_LABEL[gate.type] ?? gate.type}
              </span>
              {gate.priority === "high" && (
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary bg-primary/10 rounded-full px-2 py-0.5">
                  Urgent
                </span>
              )}
            </div>
            <p className="font-semibold text-sm leading-snug truncate mt-0.5">
              {gate.title}
            </p>
            {gate.customerName && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {gate.customerName}
              </p>
            )}
          </div>
          {gate.amount != null && (
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold tabular-nums">
                ${gate.amount.toLocaleString()}
              </p>
            </div>
          )}
          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
        </div>
      </Link>
    </motion.div>
  );
}

function ActivityRow({ event, delay }: { event: TimelineEvent; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay }}
      className="flex gap-3"
    >
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
          event.isAgent ? "bg-primary/10 text-primary" : "bg-white/[0.05] text-foreground"
        }`}
      >
        {event.isAgent ? <Bot className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug">{event.title}</p>
        <div className="flex items-center gap-1.5 mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          <Clock className="w-3 h-3" />
          {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
        </div>
      </div>
    </motion.div>
  );
}

function InventoryDonut({ data }: { data: InventoryBreakdownItem[] }) {
  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No inventory data yet.
      </div>
    );
  }
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="flex flex-col">
      <div className="relative w-full h-[176px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="powertrain"
              innerRadius={58}
              outerRadius={82}
              paddingAngle={2}
              stroke="none"
            >
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={POWERTRAIN_COLORS[d.powertrain] ?? POWERTRAIN_FALLBACK}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              itemStyle={{ color: "hsl(var(--foreground))" }}
              labelStyle={{ display: "none" }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-3xl font-bold leading-none tabular-nums">
            {total}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
            In stock
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 mt-5">
        {data.map((d) => (
          <div
            key={d.powertrain}
            className="flex items-center justify-between text-sm"
          >
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{
                  background:
                    POWERTRAIN_COLORS[d.powertrain] ?? POWERTRAIN_FALLBACK,
                }}
              />
              <span className="text-muted-foreground truncate">
                {d.powertrain}
              </span>
            </span>
            <span className="font-semibold tabular-nums">{d.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UnitsBar({ data }: { data: { month: string; units: number }[] }) {
  if (data.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No sales data yet.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 8, left: -12, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} width={28} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted) / 0.18)" }}
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "hsl(var(--foreground))" }}
          labelStyle={{ color: "hsl(var(--muted-foreground))" }}
          formatter={(val: number) => [val, "Units"]}
        />
        <Bar dataKey="units" radius={[6, 6, 0, 0]} fill="hsl(var(--primary))" maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function PipelineFunnel({ stages }: { stages: PipelineStage[] }) {
  if (stages.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No pipeline data yet.
      </div>
    );
  }
  const max = Math.max(...stages.map((s) => s.value), 1);
  const totalValue = stages.reduce((s, x) => s + x.value, 0);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-baseline justify-between mb-4">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Total open value
        </span>
        <span className="text-2xl font-bold tabular-nums">
          ${(totalValue / 1000).toFixed(0)}k
        </span>
      </div>
      <div className="space-y-3.5 flex-1">
        {stages.map((stage, i) => (
          <motion.div
            key={stage.phase}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.06 }}
          >
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-sm font-medium">{stage.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {stage.count} · ${(stage.value / 1000).toFixed(0)}k
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-white/[0.05] overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary"
                initial={{ width: 0 }}
                animate={{ width: `${(stage.value / max) * 100}%` }}
                transition={{ delay: i * 0.06 + 0.1, duration: 0.6 }}
              />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
