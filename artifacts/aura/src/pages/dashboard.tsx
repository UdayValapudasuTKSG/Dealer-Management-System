import { Link } from "wouter";
import {
  useGetDashboardSummary,
  useGetSalesPerformance,
  useGetPipeline,
  useListTimeline,
  useListGates,
} from "@workspace/api-client-react";
import type { Gate, TimelineEvent, PipelineStage } from "@workspace/api-client-react";
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
  ArrowRight,
  CheckCircle2,
  Clock,
} from "lucide-react";
import {
  AreaChart,
  Area,
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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: performance, isLoading: isLoadingPerf } = useGetSalesPerformance();
  const { data: pipeline } = useGetPipeline();
  const { data: timeline } = useListTimeline({ limit: 12 });
  const { data: gates } = useListGates({ status: "pending" });

  const sortedGates = [...(gates ?? [])].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1),
  );
  const agentEvents = (timeline ?? []).filter((e) => e.isAgent);

  return (
    <div className="h-full overflow-y-auto">
      {/* Compact cinematic briefing band */}
      <div className="relative h-[240px] w-full overflow-hidden bg-black">
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
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-white/70 mb-3">
              <Bot className="w-4 h-4" />
              AURA Concierge · Command Center
            </div>
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-white max-w-3xl leading-tight">
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
          />
          <KPICard
            title="Handled Autonomously"
            value={summary?.agentTasksToday ?? 0}
            sub={
              summary
                ? `${summary.avgResponseSeconds}s avg response`
                : "tasks today"
            }
            icon={Zap}
            isLoading={isLoadingSummary}
            delay={0.1}
          />
          <KPICard
            title="Active Deals"
            value={summary?.activeDeals ?? 0}
            sub={summary ? `${summary.totalLeads} live leads` : "in motion"}
            icon={Briefcase}
            isLoading={isLoadingSummary}
            delay={0.15}
          />
          <KPICard
            title="Conversion"
            value={summary ? `${summary.conversionRate}%` : "0%"}
            sub={
              summary
                ? `${summary.serviceOrdersOpen} service orders open`
                : "lead to deal"
            }
            icon={Users}
            isLoading={isLoadingSummary}
            delay={0.2}
          />
        </div>

        {/* Decisions + Autonomous activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Human-in-the-loop decision queue */}
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
                  AURA handled everything else. These are reserved for a human.
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
                    No decisions are waiting. AURA has the dealership under control.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {sortedGates.slice(0, 4).map((gate, i) => (
                    <DecisionRow key={gate.id} gate={gate} delay={i * 0.05} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Autonomous activity (was: Live Orchestration) */}
          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <div className="p-6 pb-4 border-b border-border/50">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-primary" />
                <h3 className="text-lg font-semibold tracking-wide">
                  Autonomous activity
                </h3>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Actions AURA took across the dealership on its own.
              </p>
            </div>
            <CardContent className="flex-1 p-6 overflow-y-auto max-h-[420px]">
              {agentEvents.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No activity yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {agentEvents.slice(0, 8).map((event, i) => (
                    <ActivityRow key={event.id} event={event} delay={i * 0.04} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Performance + Pipeline */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2 glass-panel border-none shadow-xl overflow-hidden">
            <div className="p-6 pb-2">
              <h3 className="text-lg font-semibold tracking-wide">
                Performance Trajectory
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Revenue delivered over recent months.
              </p>
            </div>
            <CardContent className="p-0 h-[280px]">
              {isLoadingPerf ? (
                <div className="h-full flex items-center justify-center">
                  <Loader2 className="animate-spin text-primary w-8 h-8" />
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={performance}
                    margin={{ top: 20, right: 20, left: 20, bottom: 20 }}
                  >
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(val) => `$${val / 1000}k`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "rgba(255,255,255,0.9)", backdropFilter: "blur(10px)", borderRadius: "12px", border: "1px solid rgba(0,0,0,0.1)" }}
                      itemStyle={{ color: "hsl(var(--foreground))" }}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="glass-panel border-none shadow-xl flex flex-col">
            <div className="p-6 pb-4">
              <h3 className="text-lg font-semibold tracking-wide">
                Pipeline snapshot
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Where opportunity value sits right now.
              </p>
            </div>
            <CardContent className="px-6 pb-6 pt-0 flex-1">
              <PipelineSnapshot stages={pipeline ?? []} />
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
      ? "nothing needs your sign-off"
      : `${pendingCount} decision${pendingCount > 1 ? "s" : ""} need${pendingCount > 1 ? "" : "s"} your sign-off`;
  return `AURA handled ${summary.agentTasksToday} tasks today across ${summary.activeDeals} active deals — ${decisions}.`;
}

function Briefcase(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}

function KPICard({ title, value, sub, icon: Icon, isLoading, delay, accent }: any) {
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
          <div className="absolute right-0 top-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity transform group-hover:scale-110 duration-500">
            <Icon className="w-16 h-16" />
          </div>
          <p
            className={`text-xs font-medium mb-3 uppercase tracking-widest ${
              accent ? "text-white/80" : "text-muted-foreground"
            }`}
          >
            {title}
          </p>
          {isLoading ? (
            <div className="h-8 w-16 bg-black/5 rounded animate-pulse" />
          ) : (
            <>
              <h2 className="text-3xl font-bold tracking-tight leading-none">
                {value}
              </h2>
              <p
                className={`text-xs mt-2 ${
                  accent ? "text-white/70" : "text-muted-foreground"
                }`}
              >
                {sub}
              </p>
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
        <div className="group flex items-center gap-4 rounded-2xl border border-border/60 bg-white/50 hover:bg-primary/5 hover:border-primary/30 transition-colors p-4 cursor-pointer">
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
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {gate.customerName ? `${gate.customerName} · ` : ""}
              {gate.summary}
            </p>
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
          event.isAgent ? "bg-primary/10 text-primary" : "bg-black/5 text-foreground"
        }`}
      >
        {event.isAgent ? <Bot className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug">{event.title}</p>
        {event.detail && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {event.detail}
          </p>
        )}
        <div className="flex items-center gap-1.5 mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          <Clock className="w-3 h-3" />
          {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
        </div>
      </div>
    </motion.div>
  );
}

function PipelineSnapshot({ stages }: { stages: PipelineStage[] }) {
  if (stages.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No pipeline data yet.
      </div>
    );
  }
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div className="space-y-4">
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
          <div className="h-2 rounded-full bg-black/5 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={{ width: 0 }}
              animate={{ width: `${(stage.value / max) * 100}%` }}
              transition={{ delay: i * 0.06 + 0.1, duration: 0.6 }}
            />
          </div>
        </motion.div>
      ))}
    </div>
  );
}
