import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { TodaySchedule } from "@/components/today-schedule";
import { buildTriage, CONTACT_SLA_HOURS } from "@/lib/triage";
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
  useListDeliveries,
  useListServiceOrders,
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
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Brain,
  Sparkles,
  HeartPulse,
  RefreshCw,
  Clock,
  Layers,
  BarChart3,
  GitBranch,
  LineChart as LineChartIcon,
  Trophy,
  Car,
  Megaphone,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  PhoneCall,
  CalendarClock,
  MailQuestion,
  Landmark,
  Bot
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
  ScatterChart,
  Scatter,
  ZAxis
} from "recharts";
import { motion } from "framer-motion";
import { formatDistanceToNow, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

const POWERTRAIN_COLORS: Record<string, string> = {
  EV: "hsl(var(--primary))",
  Hybrid: "hsl(216 10% 40%)",
  Petrol: "hsl(216 10% 60%)",
  Diesel: "hsl(216 10% 80%)",
};
const POWERTRAIN_FALLBACK = "hsl(216 10% 80%)";

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--popover-border))",
  borderRadius: "12px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
} as const;

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(216 10% 30%)",
  "hsl(216 10% 50%)",
  "hsl(216 10% 70%)",
  "hsl(216 10% 85%)",
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

const KIND_UI: Record<string, { icon: any; tone: string; bgTone: string; action: string }> = {
  gate: { icon: ShieldCheck, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Review" },
  contact: { icon: PhoneCall, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Call" },
  testDrive: { icon: CalendarClock, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Prep" },
  delivery: { icon: Car, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Deliver" },
  service: { icon: Zap, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Service" },
  stalled: { icon: AlertCircle, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Nudge" },
  quote: { icon: MailQuestion, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Follow" },
  deposit: { icon: Landmark, tone: "text-foreground", bgTone: "bg-foreground/10", action: "Open" },
};

function getInitials(name: string) {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function TriageCard({ item }: { item: any }) {
  const [, navigate] = useLocation();
  const ui = KIND_UI[item.kind] || KIND_UI.stalled;
  const isOverdue = item.kind === "contact" && item.slaHoursLeft !== undefined && item.slaHoursLeft <= 0;
  
  return (
    <div className={cn(
      "group flex flex-col justify-between p-4 rounded-2xl border transition-all duration-300 relative overflow-hidden",
      item.bucket === "urgent" 
        ? "bg-foreground text-background border-transparent shadow-xl" 
        : "bg-card text-card-foreground border-border/60 hover:border-foreground/20 hover:shadow-md"
    )}>
      {/* Decorative glass reflection for urgent cards */}
      {item.bucket === "urgent" && (
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 blur-2xl rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      )}
      
      <div className="flex items-start justify-between gap-3 relative z-10">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center shrink-0 font-bold text-xs tracking-wider",
            item.bucket === "urgent" ? "bg-white/20 text-white" : "bg-foreground/5 text-foreground"
          )}>
            {getInitials(item.context)}
          </div>
          <div>
            <div className="font-semibold text-sm line-clamp-1">{item.context}</div>
            <div className={cn(
              "text-xs mt-0.5 line-clamp-1",
              item.bucket === "urgent" ? "text-white/70" : "text-muted-foreground"
            )}>
              {item.subContext}
            </div>
          </div>
        </div>
        {isOverdue && (
          <div className="flex items-center gap-1 bg-red-500/20 text-red-100 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider whitespace-nowrap">
            <AlertCircle className="w-3 h-3" />
            Overdue
          </div>
        )}
      </div>
      
      <div className="flex items-end justify-between mt-5 relative z-10">
        <div className={cn(
          "text-[10px] uppercase tracking-widest font-semibold",
          item.bucket === "urgent" ? "text-white/50" : "text-muted-foreground/60"
        )}>
          {item.assignee ? `w/ ${item.assignee}` : "Unassigned"}
        </div>
        <button 
          onClick={() => navigate(item.href)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all",
            item.bucket === "urgent" 
              ? "bg-white text-black hover:bg-white/90" 
              : "bg-foreground text-background hover:bg-foreground/90"
          )}
        >
          {ui.action}
          <ArrowRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
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
  const { data: deliveries } = useListDeliveries();
  const { data: serviceOrders } = useListServiceOrders();

  const agentEvents = (timeline ?? []).filter((e) => e.isAgent);

  const { urgent, today, later, total: objectivesCount } = useMemo(
    () => buildTriage(leads, deals, gates, deliveries, serviceOrders),
    [leads, deals, gates, deliveries, serviceOrders],
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
    <div className="min-h-[100dvh] pb-20">
      <div className="px-5 md:px-8 pt-8 space-y-10">
        
        {/* Compact Greeting & Triage (FIRST SIGHT IMPACT) */}
        <div className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-2">
                <Bot className="w-3.5 h-3.5" />
                Daily Briefing
              </div>
              <h1 className="text-3xl md:text-4xl font-light tracking-tight text-foreground">
                {greeting()}, <span className="font-medium">here is what needs your attention.</span>
              </h1>
            </div>
            <div className="flex items-center gap-2 bg-foreground/[0.03] border border-border/60 rounded-full px-4 py-1.5">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                Contact leads within 24h
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-6">
            <div className="md:col-span-2 xl:col-span-3">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">Triage Queue</h2>
                <span className="bg-foreground text-background text-[10px] font-bold px-2 py-0.5 rounded-full tabular-nums">
                  {objectivesCount}
                </span>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {urgent.length > 0 && urgent.map((item, i) => (
                  <motion.div key={item.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                    <TriageCard item={item} />
                  </motion.div>
                ))}
                {today.length > 0 && today.map((item, i) => (
                  <motion.div key={item.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: (urgent.length + i) * 0.05 }}>
                    <TriageCard item={item} />
                  </motion.div>
                ))}
                {urgent.length === 0 && today.length === 0 && later.length > 0 && later.map((item, i) => (
                  <motion.div key={item.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                    <TriageCard item={item} />
                  </motion.div>
                ))}
                {objectivesCount === 0 && (
                  <div className="col-span-full py-12 rounded-3xl border border-dashed border-border flex flex-col items-center justify-center text-muted-foreground">
                    <CheckCircle2 className="w-8 h-8 mb-3 opacity-20" />
                    <p className="text-sm font-medium">All caught up</p>
                    <p className="text-xs mt-1 opacity-70">You have no pending tasks right now.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="md:col-span-1 xl:col-span-1">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">Today's Schedule</h2>
              </div>
              <div className="relative min-h-[300px] h-[calc(100%-2rem)] rounded-2xl border border-border/60 bg-card overflow-hidden">
                <div className="absolute inset-0 overflow-y-auto p-4">
                  <TodaySchedule />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* KPI Grid (Refined Stat Cards) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 pt-4">
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
            icon={Bot}
            isLoading={isLoadingSummary}
            delay={0.2}
            href="/tasks"
          />
        </div>

        {/* Revenue trajectory + Pipeline (Horizontal Stage Value) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col overflow-hidden">
            <ChartHeader
              icon={TrendingUp}
              title="Revenue Trajectory"
              sub="Delivered revenue over recent months"
            />
            <CardContent className="p-0 flex-1 min-h-[260px]">
              {isLoadingPerf ? (
                <ChartLoader />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performance} margin={{ top: 16, right: 24, left: 8, bottom: 16 }}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--foreground))" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="hsl(var(--foreground))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS_TICK} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} tickFormatter={(val) => `$${val / 1000}k`} width={44} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ color: "hsl(var(--muted-foreground))" }} formatter={(val: number) => [`$${val.toLocaleString()}`, "Revenue"]} />
                    <Area type="monotone" dataKey="revenue" stroke="hsl(var(--foreground))" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={GitBranch}
              title="Sales Pipeline"
              sub="Opportunity value by stage"
            />
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              <PipelineFunnel stages={pipeline ?? []} />
            </CardContent>
          </Card>
        </div>

        {/* Predictive Intelligence */}
        <PredictiveSection />

        {/* Customer Sentiment (Advanced Visualization) */}
        <SentimentSection />

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
                    <Bar dataKey="delivered" name="Delivered" stackId="a" fill="hsl(var(--foreground))" maxBarSize={12} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="open" name="Open" stackId="a" fill="hsl(var(--foreground) / 0.2)" radius={[0, 4, 4, 0]} maxBarSize={12} />
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
                <div className="space-y-4 pt-1">
                  {salesByModel.map((m) => {
                    const max = salesByModel[0]?.value || 1;
                    return (
                      <div key={m.model}>
                        <div className="flex items-center justify-between text-sm mb-1.5">
                          <span className="font-medium truncate pr-3 text-foreground">{m.model}</span>
                          <span className="text-muted-foreground tabular-nums shrink-0 text-xs">
                            ${Math.round(m.value / 1000)}k <span className="opacity-50 mx-1">/</span> {m.units}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-foreground/[0.05] overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${(m.value / max) * 100}%` }}
                            transition={{ duration: 0.8, ease: "easeOut" }}
                            className="h-full rounded-full bg-foreground"
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

        {/* Lead flow + Units delivered */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col overflow-hidden">
            <ChartHeader
              icon={LineChartIcon}
              title="Lead Flow"
              sub="Weekly leads by top sources"
            />
            <CardContent className="p-0 flex-1 min-h-[260px]">
              {topSources.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-muted-foreground py-12">
                  No lead activity yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={leadsOverTime} margin={{ top: 16, right: 24, left: 8, bottom: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="week" axisLine={false} tickLine={false} tick={AXIS_TICK} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ color: "hsl(var(--muted-foreground))" }} />
                    <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
                    {topSources.map((s, i) => (
                      <Line
                        key={s}
                        type="monotone"
                        dataKey={s}
                        name={s.replace(/_/g, " ")}
                        stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={BarChart3}
              title="Units Delivered"
              sub="Monthly delivered volume"
            />
            <CardContent className="p-0 flex-1 min-h-[260px]">
              <UnitsBar
                data={(performance ?? []).map((p) => ({
                  month: p.month,
                  units: p.units,
                }))}
              />
            </CardContent>
          </Card>
        </div>

        {/* Inventory mix + Autonomous activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

          <Card className="lg:col-span-2 glass-panel border-none shadow-xl flex flex-col">
            <ChartHeader
              icon={Zap}
              title="Autonomous Activity"
              sub="Actions handled by AURA agents"
            />
            <CardContent className="px-4 pb-4 pt-0 flex-1">
              {agentEvents.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No autonomous activity yet.
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {agentEvents.slice(0, 8).map((e) => (
                    <div key={e.id} className="flex items-start gap-3 py-3">
                      <div className="w-7 h-7 rounded-full bg-foreground text-background flex items-center justify-center shrink-0 mt-0.5">
                        <Bot className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">{e.title}</div>
                        {e.detail && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5">{e.detail}</div>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                        {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
                      </div>
                    </div>
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
  up: { icon: ArrowUpRight, className: "text-foreground" },
  down: { icon: ArrowDownRight, className: "text-muted-foreground" },
  flat: { icon: ArrowRight, className: "text-muted-foreground" },
};

function PredictiveSection() {
  const { data, isLoading } = useGetPredictiveAnalytics();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2 glass-panel border-none shadow-xl overflow-hidden bg-gradient-to-br from-card to-card/50">
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

      <Card className="glass-panel border-none shadow-xl flex flex-col bg-foreground text-background">
        <div className="p-6 pb-3 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-background/60" />
              <h3 className="text-lg font-semibold tracking-wide">Projected Metrics</h3>
            </div>
            <p className="text-xs text-background/60 mt-1">Next-month outlook</p>
          </div>
        </div>
        <CardContent className="px-6 pb-6 pt-0 flex-1">
          {isLoading || !data ? (
            <div className="space-y-3 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 rounded-xl bg-background/10 animate-pulse"
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
            <stop offset="5%" stopColor="hsl(var(--foreground))" stopOpacity={0.15} />
            <stop offset="95%" stopColor="hsl(var(--foreground))" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="forecastProjected" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--foreground))" stopOpacity={0.05} />
            <stop offset="95%" stopColor="hsl(var(--foreground))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS_TICK} dy={10} />
        <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK} tickFormatter={(val) => `$${val / 1000}k`} width={44} />
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
          stroke="hsl(var(--foreground))"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#forecastActual)"
          connectNulls={false}
        />
        <Area
          type="monotone"
          dataKey="projectedRevenue"
          stroke="hsl(var(--foreground))"
          strokeWidth={2}
          strokeDasharray="4 4"
          strokeOpacity={0.6}
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
    <div className="rounded-xl border border-background/10 bg-background/5 px-4 py-3 relative overflow-hidden group">
      <div className="absolute inset-0 bg-background/5 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-center justify-between gap-2 relative z-10">
        <span className="text-[10px] font-bold uppercase tracking-widest text-background/60 truncate">
          {m.label}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-1 relative z-10">
        <span className="text-xl font-bold tabular-nums text-background">
          {fmtMetric(m.unit, m.predicted)}
        </span>
        <div className="flex items-center text-[10px] bg-background/20 px-1.5 py-0.5 rounded-full text-background font-medium">
          <TrendIcon className="w-3 h-3 mr-0.5" />
          vs {fmtMetric(m.unit, m.current)}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 relative z-10">
        <div className="h-[3px] flex-1 rounded-full bg-background/20 overflow-hidden">
          <div
            className="h-full rounded-full bg-background"
            style={{ width: `${m.confidence}%` }}
          />
        </div>
        <span className="text-[9px] text-background/50 uppercase tracking-widest tabular-nums shrink-0 font-medium">
          {m.confidence}% CONF
        </span>
      </div>
    </div>
  );
}

const SENTIMENT_COLOR: Record<string, string> = {
  positive: "hsl(var(--foreground))",
  neutral: "hsl(var(--foreground) / 0.4)",
  negative: "hsl(var(--foreground) / 0.15)",
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
        title="Customer Sentiment Analysis"
        sub="AI-read mood across recent conversations and notes"
      />
      <CardContent className="px-6 pb-6 pt-0">
        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-40 rounded-xl bg-foreground/5 animate-pulse"
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
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-foreground/5 px-4 py-2 text-sm font-medium hover:border-foreground/20 hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
              />
              Try again
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            <div className="flex flex-col">
              <div className="flex-1 flex flex-col justify-center items-center text-center p-6 rounded-2xl bg-foreground/[0.02] border border-border/40">
                <div className="relative">
                  <svg className="w-32 h-32 transform -rotate-90">
                    <circle cx="64" cy="64" r="60" stroke="currentColor" strokeWidth="2" fill="none" className="text-foreground/10" />
                    <motion.circle 
                      cx="64" cy="64" r="60" 
                      stroke="currentColor" 
                      strokeWidth="6" 
                      fill="none" 
                      className="text-foreground"
                      strokeDasharray={377}
                      initial={{ strokeDashoffset: 377 }}
                      animate={{ strokeDashoffset: 377 - (377 * data.overallScore) / 100 }}
                      transition={{ duration: 1.5, ease: "easeOut" }}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-4xl font-light tabular-nums leading-none tracking-tight">
                      {Math.round(data.overallScore)}
                    </span>
                  </div>
                </div>
                <div className="mt-4 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-foreground/5 border border-foreground/10 text-xs font-bold uppercase tracking-widest text-foreground">
                  {data.overallLabel}
                </div>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-3">
                  {data.sampleSize} interactions analyzed
                </p>
              </div>
            </div>

            <div className="flex flex-col justify-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-foreground mb-4">
                Sentiment Distribution
              </p>
              <div className="space-y-5">
                {(
                  [
                    ["positive", data.distribution.positive],
                    ["neutral", data.distribution.neutral],
                    ["negative", data.distribution.negative],
                  ] as const
                ).map(([label, pct]) => (
                  <div key={label} className="group">
                    <div className="flex items-end justify-between mb-1.5">
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
                        {label}
                      </span>
                      <span className="text-sm font-light tabular-nums text-foreground">
                        {Math.round(pct)}%
                      </span>
                    </div>
                    {/* Tick-mark progress strip style */}
                    <div className="flex h-2 gap-0.5 w-full">
                      {Array.from({ length: 20 }).map((_, i) => {
                        const active = i < Math.round((pct / 100) * 20);
                        return (
                          <motion.div
                            key={i}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: i * 0.02 }}
                            className={cn(
                              "flex-1 rounded-sm transition-colors duration-500",
                              active ? (label === "positive" ? "bg-foreground" : label === "neutral" ? "bg-foreground/40" : "bg-foreground/15") : "bg-foreground/5"
                            )}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col justify-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-foreground mb-4">
                Representative Voices
              </p>
              {data.highlights.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No highlights yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {data.highlights.slice(0, 3).map((h: SentimentHighlight, i: number) => {
                    const body = (
                      <div className="relative pl-4 py-1 group">
                        <div className={cn(
                          "absolute left-0 top-0 bottom-0 w-[3px] rounded-full transition-all duration-300 group-hover:w-1",
                          h.sentiment === "positive" ? "bg-foreground" : h.sentiment === "neutral" ? "bg-foreground/40" : "bg-foreground/15"
                        )} />
                        <p className="text-sm italic text-muted-foreground leading-snug">
                          "{h.snippet}"
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-foreground mt-2 flex items-center gap-1.5">
                          — {h.leadName}
                        </p>
                      </div>
                    );
                    return h.leadId != null ? (
                      <Link key={i} href={`/lead/${h.leadId}`} className="block">
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
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-bold uppercase tracking-widest text-foreground">{title}</h3>
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
      <Loader2 className="animate-spin text-foreground w-8 h-8" />
    </div>
  );
}

function TrendBadge({ delta, accent }: { delta: number; accent?: boolean }) {
  const up = delta >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-bold rounded-full px-2 py-0.5 tabular-nums shrink-0 uppercase tracking-widest",
        accent
          ? "bg-background/20 text-background"
          : "bg-foreground/5 border border-foreground/10 text-foreground"
      )}
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

function KPICard({
  title,
  value,
  sub,
  icon: Icon,
  isLoading,
  delay,
  accent,
  delta,
  href,
}: any) {
  const [, navigate] = useLocation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5 }}
    >
      <Card
        onClick={href ? () => navigate(href) : undefined}
        className={cn(
          "border-none shadow-md overflow-hidden group hover:shadow-lg transition-all duration-300 relative",
          href && "cursor-pointer",
          accent ? "bg-foreground text-background" : "bg-card text-card-foreground border border-border/50 hover:border-foreground/20"
        )}
      >
        {/* Soft glass reflection */}
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
        
        <CardContent className="p-5 relative z-10">
          <div className="flex items-start justify-between">
            <p className={cn(
              "text-[10px] font-bold uppercase tracking-widest",
              accent ? "text-background/60" : "text-muted-foreground"
            )}>
              {title}
            </p>
            <Icon className={cn("w-4 h-4", accent ? "text-background/50" : "text-muted-foreground/40")} />
          </div>
          {isLoading ? (
            <div className="h-8 w-16 bg-foreground/10 rounded animate-pulse mt-3" />
          ) : (
            <>
              <div className="flex items-end gap-3 mt-4">
                <h2 className="text-3xl font-light tracking-tight leading-none">
                  {value}
                </h2>
                {delta != null && <TrendBadge delta={delta} accent={accent} />}
              </div>
              <p className={cn(
                "text-xs mt-3",
                accent ? "text-background/60" : "text-muted-foreground"
              )}>
                {sub}
              </p>
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
    <div className="space-y-4 pt-4">
      {stages.map((s) => (
        <div key={s.phase} className="group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground group-hover:text-foreground transition-colors min-w-0 pr-4">
              {s.label}
            </span>
            <div className="text-right shrink-0">
              <span className="font-medium text-sm text-foreground">${Math.round(s.value / 1000)}k</span>
              <span className="text-muted-foreground/50 text-[10px] font-bold ml-2 tabular-nums bg-foreground/5 px-1.5 py-0.5 rounded-full">
                {s.count}
              </span>
            </div>
          </div>
          <div className="h-[3px] rounded-full bg-foreground/[0.05] overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(s.value / max) * 100}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="h-full rounded-full bg-foreground"
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
  
  // Stem chart style
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 16, right: 16, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS_TICK} dy={10} />
        <YAxis dataKey="units" axisLine={false} tickLine={false} tick={AXIS_TICK} allowDecimals={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "hsl(var(--foreground))" }}
          labelStyle={{ color: "hsl(var(--muted-foreground))" }}
          cursor={{ stroke: "hsl(var(--foreground) / 0.1)", strokeWidth: 1, strokeDasharray: "3 3" }}
          formatter={(val: number) => [`${val}`, "Units"]}
        />
        <Scatter data={data} fill="hsl(var(--foreground))" shape={(props: any) => {
          const { cx, cy, yAxis } = props;
          const y0 = yAxis.scale(0);
          return (
            <g>
              <line x1={cx} y1={y0} x2={cx} y2={cy} stroke="hsl(var(--foreground))" strokeWidth="2" opacity="0.2" />
              <circle cx={cx} cy={cy} r="5" fill="hsl(var(--foreground))" />
            </g>
          );
        }} />
      </ScatterChart>
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
              innerRadius={65}
              outerRadius={85}
              paddingAngle={2}
              stroke="none"
              cornerRadius={4}
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
          <span className="text-4xl font-light leading-none tabular-nums text-foreground">
            {total}
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
              <span className="text-muted-foreground truncate font-medium text-xs uppercase tracking-wider">{d.name}</span>
            </span>
            <span className="font-semibold tabular-nums text-foreground">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
