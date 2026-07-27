import { Link } from "wouter";
import {
  useGetDashboardSummary,
  useGetSalesPerformance,
  useGetInventoryBreakdown,
  useGetSentimentAnalysis,
  getGetInventoryBreakdownQueryKey,
  getGetSentimentAnalysisQueryKey,
} from "@workspace/api-client-react";
import type {
  AdvisorPerformance,
  DivisionPerformance,
  InventoryBreakdown,
  SalesPoint,
} from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { useMoney } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import {
  Target,
  Users,
  Timer,
  Landmark,
  Layers,
  CalendarClock,
  TrendingUp,
  TrendingDown,
  ArrowRight,
} from "lucide-react";

/* Reports is the persona-aware analytics home. Rebuilt (2026-07, R5) on
   SERVER-COMPUTED dashboard endpoints — summary, sales-performance and
   inventory-breakdown — so every figure matches the detailed reports and
   respects server-side persona scoping (advisors get only their own rows;
   the leaderboard marks the viewer with `isMe`). No client-side list
   aggregation remains here. */

const SERIES_COLORS = [
  "hsl(27 44% 46%)",
  "hsl(35 55% 60%)",
  "hsl(0 0% 62%)",
  "hsl(20 35% 34%)",
  "hsl(40 30% 45%)",
  "hsl(0 0% 40%)",
];

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--popover-border))",
  borderRadius: "10px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
  fontSize: "12px",
} as const;

const AXIS_TICK = { fontSize: 10, fill: "hsl(var(--muted-foreground))" } as const;

function fmtSeconds(s: number): string {
  if (s <= 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/* ---------- compact building blocks ---------- */

function Delta({ value }: { value: number | undefined }) {
  if (value == null || value === 0) return null;
  const up = value > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums ${
        up ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(value)}%
    </span>
  );
}

function Kpi({
  label,
  value,
  sub,
  delta,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: number;
  icon?: typeof Target;
}) {
  return (
    <Card className="glass-panel border-none shadow-md h-full">
      <CardContent className="px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          {Icon && <Icon className="h-3 w-3 text-muted-foreground shrink-0" />}
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground truncate">
            {label}
          </p>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <p className="text-lg font-bold tracking-tight leading-none">{value}</p>
          <Delta value={delta} />
        </div>
        {sub && (
          <p className="mt-1 text-[11px] text-muted-foreground truncate">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Widget({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <Card className="glass-panel border-none shadow-md h-full flex flex-col">
      <div className="px-4 pt-3 pb-1 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground truncate">
          {title}
        </h3>
        {action && (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gold hover:text-foreground shrink-0"
          >
            {action.label}
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="flex-1 min-h-0 px-2 pb-2">{children}</div>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}

/* ---------- widgets over server data ---------- */

function SalesTrend({ series }: { series: SalesPoint[] }) {
  const money = useMoney();
  if (series.every((p) => p.revenue === 0 && p.units === 0)) {
    return <Empty text="No sales in the last 6 months." />;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <XAxis dataKey="month" axisLine={false} tickLine={false} tick={AXIS_TICK} interval={0} />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={AXIS_TICK}
          width={40}
          tickFormatter={(v: number) => {
            const g = v * money.rate;
            return g >= 1_000_000
              ? `${Math.round(g / 1_000_000)}M`
              : g >= 1000
                ? `${Math.round(g / 1000)}k`
                : String(Math.round(g));
          }}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "hsl(var(--foreground))" }}
          cursor={{ fill: "hsl(var(--foreground) / 0.04)" }}
          formatter={(v: number, name: string) =>
            name === "Revenue" ? [money.gyd(v), name] : [v, name]
          }
        />
        <Bar dataKey="revenue" name="Revenue" fill={SERIES_COLORS[0]} radius={[4, 4, 0, 0]} maxBarSize={26} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function Leaderboard({ rows }: { rows: AdvisorPerformance[] }) {
  const money = useMoney();
  const top = rows.slice(0, 5);
  if (top.length === 0) return <Empty text="No deal activity yet." />;
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-2 pb-1">
      {top.map((p, i) => (
        <div
          key={p.name}
          className={`flex items-center gap-2 rounded-lg px-1.5 py-0.5 ${
            p.isMe ? "bg-primary/10 ring-1 ring-primary/30" : ""
          }`}
        >
          <span className="w-5 h-5 rounded-full bg-foreground/5 text-foreground text-[10px] font-bold flex items-center justify-center tabular-nums shrink-0">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate leading-tight">
              {p.name}
              {p.isMe && (
                <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-gold">
                  You
                </span>
              )}
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {p.units} delivered · {p.closeRate}% close
              {p.avgCycleDays > 0 ? ` · ${p.avgCycleDays}d cycle` : ""}
            </p>
          </div>
          <span className="text-[11px] font-semibold tabular-nums shrink-0">
            {money.gyd(p.gross)}
          </span>
        </div>
      ))}
    </div>
  );
}

function DivisionTable({ rows }: { rows: DivisionPerformance[] }) {
  const money = useMoney();
  if (rows.length === 0) return <Empty text="No division activity yet." />;
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-2 pb-1">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Division</span>
        <span className="text-right">Open</span>
        <span className="text-right">Units</span>
        <span className="text-right">Gross</span>
      </div>
      {rows.slice(0, 4).map((r) => (
        <div
          key={r.name}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11px] items-center"
        >
          <span className="font-medium truncate">{r.name}</span>
          <span className="text-right tabular-nums">{r.openLeads}</span>
          <span className="text-right tabular-nums">{r.units}</span>
          <span className="text-right tabular-nums font-semibold">
            {money.gyd(r.gross)}
          </span>
        </div>
      ))}
    </div>
  );
}

function InventoryAging({ data }: { data: InventoryBreakdown }) {
  const money = useMoney();
  if (data.totalCount === 0) return <Empty text="No vehicles in stock." />;
  const max = Math.max(1, ...data.aging.map((b) => b.count));
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-2 pb-1">
      {data.aging.map((b, i) => (
        <div key={b.bucket} className="flex items-center gap-2 text-[11px]">
          <span className="w-14 shrink-0 text-muted-foreground truncate">
            {b.bucket}
          </span>
          <div className="flex-1 h-3 rounded-full bg-foreground/[0.05] overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(b.count / max) * 100}%`,
                background: SERIES_COLORS[i % SERIES_COLORS.length],
                minWidth: b.count > 0 ? 6 : 0,
              }}
            />
          </div>
          <span className="w-6 shrink-0 text-right tabular-nums font-semibold">
            {b.count}
          </span>
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground pt-0.5">
        {data.totalCount} in stock · {money.gyd(data.totalValue)}
        {data.holds.count > 0 ? ` · ${data.holds.count} on hold` : ""}
      </p>
    </div>
  );
}

function SentimentMini() {
  const { data: sentiment } = useGetSentimentAnalysis(undefined, {
    query: {
      queryKey: getGetSentimentAnalysisQueryKey(),
      retry: 1,
      staleTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  if (!sentiment) return <Empty text="Sentiment analysis unavailable." />;
  return (
    <div className="h-full flex flex-col justify-center gap-2 px-2 pb-1">
      <div className="flex items-baseline gap-2">
        <p className="text-lg font-bold tracking-tight capitalize leading-none">
          {sentiment.overallLabel}
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(sentiment.overallScore)}/100 · {sentiment.sampleSize} interactions
        </span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-foreground/5">
        <div className="bg-foreground" style={{ width: `${sentiment.distribution.positive}%` }} />
        <div className="bg-foreground/40" style={{ width: `${sentiment.distribution.neutral}%` }} />
        <div className="bg-foreground/15" style={{ width: `${sentiment.distribution.negative}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{Math.round(sentiment.distribution.positive)}% positive</span>
        <span>{Math.round(sentiment.distribution.neutral)}% neutral</span>
        <span>{Math.round(sentiment.distribution.negative)}% negative</span>
      </div>
      {sentiment.themes.length > 0 && (
        <div className="space-y-0.5">
          {sentiment.themes.slice(0, 2).map((t) => (
            <div key={t.theme} className="flex items-center justify-between text-[11px]">
              <span className="truncate">{t.theme}</span>
              <span className="text-muted-foreground tabular-nums shrink-0 ml-3 capitalize">
                {t.sentiment} · {t.mentions}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Root: one KPI strip + one widget grid, tiles picked per persona     */
/* ------------------------------------------------------------------ */
const MANAGER_ROLES = new Set([
  "Sales Manager",
  "Service Manager",
  "Finance Manager",
]);

export function PersonaOverview() {
  const { me, can } = useAuthz();
  const money = useMoney();

  const isLeadership =
    !!me && (me.isSuperAdmin || me.roleName === "General Manager");
  const isManager = !!me && !isLeadership && MANAGER_ROLES.has(me.roleName ?? "");
  const isAdvisor = !!me && !isLeadership && !isManager;

  const { data: summary } = useGetDashboardSummary();
  const { data: sales } = useGetSalesPerformance();
  const canInventory = can("inventory", "view");
  const { data: inventory } = useGetInventoryBreakdown({
    query: {
      queryKey: getGetInventoryBreakdownQueryKey(),
      enabled: canInventory,
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  const WIDGET_H = "h-[168px]";
  const showFinanceKpis = !isAdvisor && summary?.outstandingAr != null;

  return (
    <div className="space-y-3">
      {/* KPI strip — all figures server-computed and persona-scoped */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Kpi
          label={isAdvisor ? "My MTD Deliveries" : "MTD Deliveries"}
          value={String(summary?.mtdUnits ?? 0)}
          delta={summary?.deltas?.units}
          sub={
            summary?.mtdGross != null
              ? `${money.gyd(summary.mtdGross)} gross`
              : undefined
          }
          icon={Target}
        />
        <Kpi
          label={isAdvisor ? "My Active Leads" : "Active Leads"}
          value={String(summary?.totalLeads ?? 0)}
          delta={summary?.deltas?.leads}
          sub={`${summary?.conversionRate ?? 0}% conversion`}
          icon={Users}
        />
        <Kpi
          label="Avg Response"
          value={fmtSeconds(summary?.avgResponseSeconds ?? 0)}
          sub="Enquiry to first contact"
          icon={Timer}
        />
        {showFinanceKpis ? (
          <Kpi
            label="Outstanding AR"
            value={money.gyd(summary?.outstandingAr ?? 0)}
            sub={
              summary?.availableInventoryValue != null
                ? `${money.gyd(summary.availableInventoryValue)} stock value`
                : undefined
            }
            icon={Landmark}
          />
        ) : (
          <Kpi
            label="Today"
            value={String(
              (summary?.todayTasks ?? 0) + (summary?.todayAppointments ?? 0),
            )}
            sub={`${summary?.todayTasks ?? 0} tasks · ${summary?.todayAppointments ?? 0} appointments`}
            icon={CalendarClock}
          />
        )}
      </div>

      {/* Widget grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
        <div className={WIDGET_H}>
          <Widget
            title={isAdvisor ? "My Sales Trend" : "Sales Trend"}
            action={{ label: "Reports", href: "/reports#detailed-reports" }}
          >
            <SalesTrend series={sales?.series ?? []} />
          </Widget>
        </div>
        <div className={WIDGET_H}>
          <Widget
            title={isAdvisor ? "My Performance" : "Top Performers"}
            action={{ label: "Deals", href: "/deals" }}
          >
            <Leaderboard rows={sales?.leaderboard ?? []} />
          </Widget>
        </div>
        {isLeadership ? (
          <div className={WIDGET_H}>
            <Widget title="Divisions" action={{ label: "Pipeline", href: "/pipeline" }}>
              <DivisionTable rows={sales?.divisions ?? []} />
            </Widget>
          </div>
        ) : canInventory && inventory ? (
          <div className={WIDGET_H}>
            <Widget title="Inventory Aging" action={{ label: "Inventory", href: "/inventory" }}>
              <InventoryAging data={inventory} />
            </Widget>
          </div>
        ) : null}
        {isLeadership && canInventory && inventory && (
          <div className={WIDGET_H}>
            <Widget title="Inventory Aging" action={{ label: "Inventory", href: "/inventory" }}>
              <InventoryAging data={inventory} />
            </Widget>
          </div>
        )}
        {isLeadership && (
          <div className={WIDGET_H}>
            <Widget title="Customer Sentiment">
              <SentimentMini />
            </Widget>
          </div>
        )}
      </div>
    </div>
  );
}
