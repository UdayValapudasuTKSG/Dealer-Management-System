import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { ActionQueue } from "@/components/action-queue";
import { TodaySchedule } from "@/components/today-schedule";
import { buildTriage } from "@/lib/triage";
import {
  useGetDashboardSummary,
  useGetSalesPerformance,
  useGetPipeline,
  useGetInventoryBreakdown,
  useListTimeline,
  useListGates,
  useListLeads,
  useListDeals,
  useListVehicles,
  useGetPredictiveAnalytics,
  useGetSentimentAnalysis,
  getGetSentimentAnalysisQueryKey,
} from "@workspace/api-client-react";
import type {
  Gate,
  TimelineEvent,
  PipelineStage,
  InventoryBreakdownItem,
  ForecastPoint,
  MetricPrediction,
  SentimentHighlight,
  SentimentTheme,
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
  Brain,
  Sparkles,
  HeartPulse,
  RefreshCw,
  CheckCircle2,
  Clock,
  Layers,
  BarChart3,
  GitBranch,
  LineChart as LineChartIcon,
  Trophy,
  Car,
  Megaphone,
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
  LineChart,
  Line,
  Legend,
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
  EV: "hsl(218 72% 52%)",
  Hybrid: "hsl(43 74% 52%)",
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

const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(0 0% 62%)",
  "hsl(0 60% 62%)",
  "hsl(0 0% 42%)",
  "hsl(0 30% 50%)",
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
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();
  const { data: vehicles } = useListVehicles();

  const sortedGates = [...(gates ?? [])].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1),
  );
  const agentEvents = (timeline ?? []).filter((e) => e.isAgent);

  const objectivesCount = useMemo(
    () => buildTriage(leads, deals, gates).total,
    [gates, leads, deals],
  );

  const revenueTrend = (performance ?? []).map((p) => p.revenue);
  const revDelta = deltaPct(revenueTrend);
  const unitsDelta = deltaPct((performance ?? []).map((p) => p.units));

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

  const modelName = new Map(
    (vehicles ?? []).map((v) => [v.id, `${v.make} ${v.model}`]),
  );
  const salesByModel = Object.values(
    (deals ?? [])
      .filter((d) => d.stage !== "lost")
      .reduce<Record<string, { model: string; value: number; units: number }>>(
        (acc, d) => {
          const key = modelName.get(d.vehicleId) ?? `Vehicle #${d.vehicleId}`;
          acc[key] ??= { model: key, value: 0, units: 0 };
          acc[key].value += d.otdPrice || d.vehiclePrice || 0;
          acc[key].units += 1;
          return acc;
        },
        {},
      ),
  )
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const advisorPerf = Object.values(
    (deals ?? []).reduce<
      Record<string, { advisor: string; open: number; delivered: number }>
    >((acc, d) => {
      const key = d.salesAdvisor ?? "Unassigned";
      acc[key] ??= { advisor: key, open: 0, delivered: 0 };
      if (d.stage === "delivered") acc[key].delivered += 1;
      else if (d.stage !== "lost") acc[key].open += 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b.delivered + b.open - (a.delivered + a.open))
    .slice(0, 6);

  const sourceMix = topSources.map((s, i) => ({
    name: s.replace(/_/g, " "),
    value: sourceCounts[s],
    fill: SERIES_COLORS[i % SERIES_COLORS.length],
  }));

  return (
    <div className="h-full overflow-y-auto">
      {/* Compact cinematic briefing band */}
      <div className="relative h-[240px] md:h-[280px] w-full bg-black overflow-hidden group">
        <div className="absolute inset-0 z-0">
          <video
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-full object-cover opacity-60 mix-blend-screen"
          >
            <source
              src={`${import.meta.env.BASE_URL}videos/red_car_leaving_showroom.mp4`}
              type="video/mp4"
            />
          </video>
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/25" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
        </div>
        
        <div className="relative z-10 h-full px-5 md:px-8 flex flex-col justify-end pb-8">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-white/80 mb-3">
              <Bot className="w-4 h-4" />
              AURA Command Center
            </div>
            <h1 className="text-3xl md:text-5xl font-medium tracking-tight text-white max-w-4xl leading-tight drop-shadow-md">
              {greeting()}. <br/>
              <span className="text-white/80 font-light">{briefingLine(summary, objectivesCount, sortedGates.length)}</span>
            </h1>
          </motion.div>
        </div>
      </div>

      <div className="w-full px-5 md:px-8 pb-14 mt-8 relative z-30 space-y-10">
        
        {/* Day Brief: Triage + Schedule */}
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-8">
          <div className="xl:col-span-3">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-wide">Triage</h2>
                <p className="text-sm text-muted-foreground mt-1">Actions requiring your attention</p>
              </div>
            </div>
            <ActionQueue />
          </div>
          
          <div className="xl:col-span-1">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-wide">Today's Schedule</h2>
                <p className="text-sm text-muted-foreground mt-1">Upcoming appointments</p>
              </div>
            </div>
            <div className="rounded-2xl border border-border/50 bg-foreground/[0.02] p-5 h-[calc(100%-4rem)] overflow-y-auto">
              <TodaySchedule />
            </div>
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mt-6">
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
            href="/deals"
          />
          <KPICard
            title="Active Deals"
            value={summary?.activeDeals ?? 0}
            sub={summary ? `${summary.totalLeads} live leads` : "in motion"}
            icon={GitBranch}
            isLoading={isLoadingSummary}
            delay={0.1}
            href="/deals"
          />
          <KPICard
            title="Conversion"
            value={summary ? `${summary.conversionRate}%` : "0%"}
            sub="Lead to delivery"
            icon={Users}
            isLoading={isLoadingSummary}
            delay={0.15}
            href="/pipeline"
          />
          <KPICard
            title="Handled Autonomously"
            value={summary?.agentTasksToday ?? 0}
            sub={summary ? `${summary.avgResponseSeconds}s avg response` : "today"}
            icon={Zap}
            isLoading={isLoadingSummary}
            delay={0.2}
            href="/tasks"
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

        {/* Predictive intelligence */}
        <PredictiveSection />

        {/* Customer sentiment */}
        <SentimentSection />

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

        {/* Demand: lead flow over time + source mix */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl overflow-hidden">
            <ChartHeader
              icon={LineChartIcon}
              title="Leads Created Over Time"
              sub="Weekly lead flow by top sources"
            />
            <CardContent className="p-0 h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={leadsOverTime} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="week" axisLine={false} tickLine={false} tick={AXIS_TICK} dy={6} />
                  <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ color: "hsl(var(--muted-foreground))" }} cursor={{ stroke: "hsl(var(--foreground) / 0.15)" }} />
                  <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} formatter={(v: string) => v.replace(/_/g, " ")} />
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
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={Megaphone}
              title="Lead Source Mix"
              sub="Where demand comes from"
            />
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              {sourceMix.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No leads yet.
                </div>
              ) : (
                <div className="flex flex-col">
                  <div className="relative w-full h-[176px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={sourceMix} dataKey="value" nameKey="name" innerRadius={58} outerRadius={82} paddingAngle={2} stroke="none">
                          {sourceMix.map((d, i) => (
                            <Cell key={i} fill={d.fill} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ display: "none" }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-3xl font-bold leading-none tabular-nums">
                        {(leads ?? []).length}
                      </span>
                      <span className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
                        Leads
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 mt-5">
                    {sourceMix.map((d) => (
                      <div key={d.name} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.fill }} />
                          <span className="text-muted-foreground truncate capitalize">{d.name}</span>
                        </span>
                        <span className="font-semibold tabular-nums">{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Team & product performance */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={Trophy}
              title="Advisor Performance"
              sub="Delivered and open deals per advisor"
            />
            <CardContent className="px-4 pb-4 pt-0 flex-1 min-h-[260px]">
              {advisorPerf.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No deals recorded yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={advisorPerf} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} />
                    <YAxis type="category" dataKey="advisor" axisLine={false} tickLine={false} tick={AXIS_TICK} width={120} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ color: "hsl(var(--muted-foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                    <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
                    <Bar dataKey="delivered" name="Delivered" stackId="a" fill="hsl(var(--primary))" maxBarSize={18} />
                    <Bar dataKey="open" name="Open" stackId="a" fill="hsl(0 0% 55%)" radius={[0, 4, 4, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={Car}
              title="Sales by Model"
              sub="Deal value by vehicle"
            />
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              {salesByModel.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No deal value to chart yet.
                </div>
              ) : (
                <div className="space-y-3.5 pt-1">
                  {salesByModel.map((m) => {
                    const max = salesByModel[0]?.value || 1;
                    return (
                      <div key={m.model}>
                        <div className="flex items-center justify-between text-sm mb-1.5">
                          <span className="font-medium truncate pr-3">{m.model}</span>
                          <span className="text-muted-foreground tabular-nums shrink-0">
                            ${Math.round(m.value / 1000)}k · {m.units} {m.units === 1 ? "deal" : "deals"}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-foreground/[0.06] overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(m.value / max) * 100}%` }}
                            transition={{ duration: 0.6 }}
                            className="h-full rounded-full bg-primary"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Autonomous activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col">
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

function fmtMetric(unit: MetricPrediction["unit"], value: number): string {
  if (unit === "currency") {
    return value >= 1000
      ? `$${(value / 1000).toFixed(1)}k`
      : `$${Math.round(value).toLocaleString()}`;
  }
  if (unit === "percent") return `${value}%`;
  return `${value}`;
}

const TREND_META: Record<
  MetricPrediction["trend"],
  { icon: typeof ArrowRight; className: string }
> = {
  up: { icon: ArrowUpRight, className: "text-emerald-400" },
  down: { icon: ArrowDownRight, className: "text-red-400" },
  flat: { icon: ArrowRight, className: "text-muted-foreground" },
};

function PredictiveSection() {
  const { data, isLoading } = useGetPredictiveAnalytics();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2 glass-panel border-none shadow-xl overflow-hidden">
        <ChartHeader
          icon={Brain}
          title="Predictive Intelligence"
          sub="Delivered revenue, projected three months ahead"
        />
        <CardContent className="p-0 h-[280px]">
          {isLoading || !data ? (
            <ChartLoader />
          ) : (
            <ForecastChart data={data.forecast} />
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel border-none shadow-xl flex flex-col">
        <ChartHeader
          icon={Sparkles}
          title="Projected Metrics"
          sub="Next-month outlook with model confidence"
        />
        <CardContent className="px-6 pb-6 pt-0 flex-1">
          {isLoading || !data ? (
            <div className="space-y-3 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 rounded-xl bg-white/[0.04] animate-pulse"
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3 pt-1">
              {data.metrics.map((m) => (
                <PredictionTile key={m.key} m={m} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ForecastChart({ data }: { data: ForecastPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 16, right: 24, left: 8, bottom: 16 }}>
        <defs>
          <linearGradient id="forecastActual" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="forecastProjected" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.12} />
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
          formatter={(val: number, name: string) => [
            `$${Math.round(val).toLocaleString()}`,
            name === "projectedRevenue" ? "Forecast" : "Revenue",
          ]}
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="hsl(var(--primary))"
          strokeWidth={3}
          fillOpacity={1}
          fill="url(#forecastActual)"
          connectNulls={false}
        />
        <Area
          type="monotone"
          dataKey="projectedRevenue"
          stroke="hsl(var(--primary))"
          strokeWidth={2.5}
          strokeDasharray="7 5"
          strokeOpacity={0.75}
          fillOpacity={1}
          fill="url(#forecastProjected)"
          connectNulls={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function PredictionTile({ m }: { m: MetricPrediction }) {
  const meta = TREND_META[m.trend];
  const TrendIcon = meta.icon;
  return (
    <div className="rounded-xl border border-border/60 bg-white/[0.04] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground truncate">
          {m.label}
        </span>
        <TrendIcon className={`w-4 h-4 shrink-0 ${meta.className}`} />
      </div>
      <div className="flex items-baseline gap-2 mt-1.5">
        <span className="text-sm text-muted-foreground tabular-nums">
          {fmtMetric(m.unit, m.current)}
        </span>
        <ArrowRight className="w-3 h-3 text-muted-foreground/50" />
        <span className="text-lg font-bold tabular-nums">
          {fmtMetric(m.unit, m.predicted)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <div className="h-1 flex-1 rounded-full bg-foreground/[0.08] overflow-hidden">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${m.confidence}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {m.confidence}% confidence
        </span>
      </div>
    </div>
  );
}

const SENTIMENT_COLOR: Record<string, string> = {
  positive: "bg-emerald-400",
  neutral: "bg-slate-400",
  negative: "bg-red-400",
};
const SENTIMENT_TEXT: Record<string, string> = {
  positive: "text-emerald-400",
  neutral: "text-slate-300",
  negative: "text-red-400",
};

function SentimentSection() {
  const { data, isLoading, isError, refetch, isFetching } =
    useGetSentimentAnalysis(undefined, {
      query: {
        queryKey: getGetSentimentAnalysisQueryKey(),
        retry: 1,
        staleTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    });

  return (
    <Card className="glass-panel border-none shadow-xl">
      <ChartHeader
        icon={HeartPulse}
        title="Customer Sentiment"
        sub="AI-read mood across recent conversations and notes"
      />
      <CardContent className="px-6 pb-6 pt-0">
        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-40 rounded-xl bg-white/[0.04] animate-pulse"
              />
            ))}
          </div>
        ) : isError || !data ? (
          <div className="py-10 flex flex-col items-center text-center">
            <p className="text-sm text-muted-foreground max-w-sm">
              The sentiment engine could not analyse recent conversations.
            </p>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-white/[0.04] px-4 py-2 text-sm font-medium hover:border-primary/40 hover:text-primary transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
              />
              Try again
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div>
              <div className="flex items-end gap-3">
                <span className="text-5xl font-bold tabular-nums leading-none">
                  {Math.round(data.overallScore)}
                </span>
                <span
                  className={`text-[11px] font-bold uppercase tracking-widest rounded-full px-2.5 py-1 bg-foreground/[0.06] ${SENTIMENT_TEXT[data.overallLabel]}`}
                >
                  {data.overallLabel}
                </span>
              </div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-2">
                Sentiment score · {data.sampleSize} interactions analysed
              </p>
              <p className="text-sm text-muted-foreground mt-4 leading-relaxed">
                {data.summary}
              </p>
              <div className="space-y-2.5 mt-5">
                {(
                  [
                    ["positive", data.distribution.positive],
                    ["neutral", data.distribution.neutral],
                    ["negative", data.distribution.negative],
                  ] as const
                ).map(([label, pct]) => (
                  <div key={label} className="flex items-center gap-3">
                    <span className="w-16 text-xs text-muted-foreground capitalize shrink-0">
                      {label}
                    </span>
                    <div className="h-2 flex-1 rounded-full bg-foreground/[0.06] overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6 }}
                        className={`h-full rounded-full ${SENTIMENT_COLOR[label]}`}
                      />
                    </div>
                    <span className="w-10 text-right text-xs tabular-nums text-muted-foreground shrink-0">
                      {Math.round(pct)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                What customers talk about
              </p>
              {data.themes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No recurring themes yet.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {data.themes.map((t: SentimentTheme) => (
                    <div
                      key={t.theme}
                      className="flex items-center justify-between rounded-xl border border-border/60 bg-white/[0.04] px-4 py-2.5"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${SENTIMENT_COLOR[t.sentiment]}`}
                        />
                        <span className="text-sm font-medium truncate">
                          {t.theme}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                        {t.mentions} {t.mentions === 1 ? "mention" : "mentions"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Representative voices
              </p>
              {data.highlights.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No highlights yet.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {data.highlights.map((h: SentimentHighlight, i: number) => {
                    const body = (
                      <div className="rounded-xl border border-border/60 bg-white/[0.04] px-4 py-3 hover:border-primary/30 transition-colors">
                        <p className="text-sm leading-snug">
                          &ldquo;{h.snippet}&rdquo;
                        </p>
                        <p
                          className={`text-xs mt-1.5 flex items-center gap-1.5 ${SENTIMENT_TEXT[h.sentiment]}`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${SENTIMENT_COLOR[h.sentiment]}`}
                          />
                          {h.leadName}
                        </p>
                      </div>
                    );
                    return h.leadId != null ? (
                      <Link key={i} href={`/lead/${h.leadId}`}>
                        {body}
                      </Link>
                    ) : (
                      <div key={i}>{body}</div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function briefingLine(
  summary:
    | {
        agentTasksToday: number;
        activeDeals: number;
      }
    | undefined,
  objectivesCount: number,
  approvalsCount: number,
): string {
  if (!summary) return "Bringing the dealership online...";
  if (objectivesCount === 0)
    return `${summary.agentTasksToday} tasks handled autonomously — you're all clear.`;
  const approvals =
    approvalsCount > 0
      ? ` — ${approvalsCount} awaiting your sign-off`
      : "";
  return `${objectivesCount} objective${objectivesCount > 1 ? "s" : ""} on your desk today${approvals}.`;
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
  href,
}: any) {
  const hasTrend = Array.isArray(trend) && trend.length > 1;
  const [, navigate] = useLocation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <Card
        onClick={href ? () => navigate(href) : undefined}
        className={`border-none shadow-lg overflow-hidden group hover:shadow-xl transition-all duration-300 ${
          href ? "cursor-pointer" : ""
        } ${accent ? "bg-primary text-white" : "glass-panel"}`}
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

function PipelineFunnel({ stages }: { stages: PipelineStage[] }) {
  if (stages.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
        No pipeline data yet.
      </div>
    );
  }

  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div className="space-y-4 pt-2">
      {stages.map((s) => (
        <div key={s.phase}>
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="font-medium capitalize min-w-0 pr-4">
              {s.label}
            </span>
            <div className="text-right shrink-0">
              <span className="font-medium">${Math.round(s.value / 1000)}k</span>
              <span className="text-muted-foreground text-xs ml-2 tabular-nums">
                ({s.count})
              </span>
            </div>
          </div>
          <div className="h-2 rounded-full bg-foreground/[0.06] overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(s.value / max) * 100}%` }}
              transition={{ duration: 0.6 }}
              className="h-full rounded-full bg-primary"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function UnitsBar({ data }: { data: { month: string; units: number }[] }) {
  if (data.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        No sales data yet.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 16, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS_TICK} dy={10} />
        <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "hsl(var(--foreground))" }}
          labelStyle={{ color: "hsl(var(--muted-foreground))" }}
          cursor={{ fill: "hsl(var(--foreground) / 0.04)" }}
          formatter={(val: number) => [`${val}`, "Units"]}
        />
        <Bar dataKey="units" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function InventoryDonut({ data }: { data: InventoryBreakdownItem[] }) {
  if (data.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
        No inventory data yet.
      </div>
    );
  }

  const chartData = data.map((d) => ({
    name: d.powertrain === "EV" ? "Electric" : d.powertrain,
    value: d.count,
    fill: POWERTRAIN_COLORS[d.powertrain] ?? POWERTRAIN_FALLBACK,
  }));
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <div className="flex flex-col h-full pt-2">
      <div className="relative w-full h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              innerRadius={60}
              outerRadius={86}
              paddingAngle={2}
              stroke="none"
            >
              {chartData.map((d, i) => (
                <Cell key={i} fill={d.fill} />
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
            Units
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mt-6">
        {chartData.map((d) => (
          <div key={d.name} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: d.fill }}
              />
              <span className="text-muted-foreground truncate">{d.name}</span>
            </span>
            <span className="font-semibold tabular-nums">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ event, delay }: { event: TimelineEvent; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="flex gap-4 group"
    >
      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="font-medium text-sm text-foreground truncate">
            {event.title}
          </h4>
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {formatDistanceToNow(new Date(event.createdAt), {
              addSuffix: true,
            })}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5 leading-snug line-clamp-2">
          {event.detail ?? event.title}
        </p>
      </div>
    </motion.div>
  );
}
