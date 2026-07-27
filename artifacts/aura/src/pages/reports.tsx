import { useMemo, useState } from "react";
import { useGetReport, GetReportType } from "@workspace/api-client-react";
import type { Report, GetReportFormat } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  FileText,
  FileSpreadsheet,
  FileDown,
  BarChart3,
  Target,
  TrendingUp,
  Layers,
  Landmark,
  Truck,
  Wrench,
  Boxes,
  Receipt,
  Bot,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { PageHero } from "@/components/layout/page-hero";
import { PersonaOverview } from "@/components/reports/persona-overview";

type ReportType = (typeof GetReportType)[keyof typeof GetReportType];

/* R5.1 — the 10 canonical report types. `module` mirrors the server-side
   RBAC gate; `minTier` mirrors REPORT_MIN_TIER (manager-floor types are
   hidden from advisors — the server also 403s them). */
const REPORT_TYPES: {
  type: ReportType;
  label: string;
  module: string;
  minTier: "advisor" | "manager";
  icon: typeof Target;
}[] = [
  { type: "sales_pipeline", label: "Sales Pipeline", module: "leads", minTier: "advisor", icon: Target },
  { type: "sales_performance", label: "Sales Performance", module: "deals", minTier: "advisor", icon: BarChart3 },
  { type: "inventory_aging", label: "Inventory & Aging", module: "inventory", minTier: "advisor", icon: Layers },
  { type: "finance_applications", label: "Finance Applications", module: "finance", minTier: "manager", icon: Landmark },
  { type: "service_workshop", label: "Service & Workshop", module: "service", minTier: "manager", icon: Wrench },
  { type: "parts_inventory", label: "Parts Inventory", module: "parts", minTier: "manager", icon: Boxes },
  { type: "revenue_receivables", label: "Revenue & Receivables", module: "finance", minTier: "manager", icon: TrendingUp },
  { type: "tax_gra", label: "Tax & GRA", module: "gra", minTier: "manager", icon: Receipt },
  { type: "delivery_operations", label: "Delivery Operations", module: "deliveries", minTier: "advisor", icon: Truck },
  { type: "agent_activity", label: "Agent Activity", module: "settings", minTier: "manager", icon: Bot },
];

const PIE_COLORS = [
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
  borderRadius: "12px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
} as const;

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/* Server-side export: the API renders CSV/XLSX/PDF itself (and writes the
   audit + activity trail). Raw fetch — file downloads have no generated
   hooks. Headers mirror the shared custom-fetch (dealer + dev persona). */
async function downloadExport(
  type: ReportType,
  from: string,
  to: string,
  format: GetReportFormat,
): Promise<void> {
  const headers: Record<string, string> = {};
  try {
    const dealerId = localStorage.getItem("aura-dealer-id");
    if (dealerId) headers["x-dealer-id"] = dealerId;
    const testEmail = localStorage.getItem("aura-test-user-email");
    if (testEmail) headers["x-test-user-email"] = testEmail;
  } catch {
    /* localStorage unavailable — skip */
  }
  const qs = new URLSearchParams({ type, from, to, format });
  const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
  const res = await fetch(`${apiBase}/reports?${qs.toString()}`, {
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    throw new Error(`Export failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const filename = match?.[1] ?? `${type}-report-${from}-to-${to}.${format}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const MANAGER_ROLES = new Set([
  "Sales Manager",
  "Service Manager",
  "Finance Manager",
]);

export default function Reports() {
  const { me, can } = useAuthz();

  const isLeadership =
    !!me && (me.isSuperAdmin || me.roleName === "General Manager");
  const isManager = !!me && !isLeadership && MANAGER_ROLES.has(me.roleName ?? "");
  const isAdvisor = !!me && !isLeadership && !isManager;

  const visible = REPORT_TYPES.filter(
    (r) => can(r.module, "view") && (r.minTier === "advisor" || !isAdvisor),
  );
  const [selected, setSelected] = useState<ReportType | null>(null);
  const [from, setFrom] = useState(isoDaysAgo(180));
  const [to, setTo] = useState(isoDaysAgo(0));

  const active =
    selected && visible.some((r) => r.type === selected)
      ? selected
      : visible[0]?.type ?? null;
  const activeDef = REPORT_TYPES.find((r) => r.type === active);

  const { data: report, isLoading, isError } = useGetReport(
    { type: active ?? "sales_pipeline", from, to },
  );

  if (visible.length === 0) {
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[50vh] text-center">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-8 py-10 max-w-md">
          <h2 className="text-xl font-bold tracking-tight">No reports available</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your role does not include access to any reporting modules.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageHero
        eyebrow="Intelligence"
        title="Reports"
        subtitle="Performance, revenue and pipeline analytics — scoped to your role."
      />
      <div className="w-full px-5 md:px-8 py-5 space-y-5">
        {/* Persona-aware analytics home: advisors see their own numbers,
            managers see the team, leadership sees divisions. */}
        <PersonaOverview />

        <div id="detailed-reports" className="space-y-4 scroll-mt-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-sm font-bold uppercase tracking-widest text-foreground">
            Detailed Reports
          </h2>
          <div className="flex items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              From
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-lg border border-white/10 bg-foreground/[0.04] px-3 text-sm text-foreground outline-none focus:border-primary/50"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              To
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-lg border border-white/10 bg-foreground/[0.04] px-3 text-sm text-foreground outline-none focus:border-primary/50"
              />
            </label>
          </div>
        </div>

        {/* Report type rail */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          {visible.map((r) => {
            const isActive = r.type === active;
            const Icon = r.icon;
            return (
              <button
                key={r.type}
                onClick={() => setSelected(r.type)}
                className={`relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shrink-0 transition-colors ${
                  isActive
                    ? "text-white"
                    : "text-muted-foreground hover:text-foreground bg-foreground/[0.04]"
                }`}
              >
                {isActive && (
                  <motion.span
                    layoutId="report-type-active"
                    transition={{ type: "spring", stiffness: 400, damping: 34 }}
                    className="absolute inset-0 rounded-full bg-primary shadow-lg shadow-primary/30"
                  />
                )}
                <Icon className="relative z-10 h-4 w-4" />
                <span className="relative z-10">{r.label}</span>
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : isError || !report ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center text-sm text-muted-foreground">
            Could not load the {activeDef?.label ?? "selected"} report. Try a
            different date range.
          </div>
        ) : (
          <ReportBody report={report} from={from} to={to} />
        )}
        </div>
      </div>
    </div>
  );
}

function ReportBody({
  report,
  from,
  to,
}: {
  report: Report;
  from: string;
  to: string;
}) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState<GetReportFormat | null>(null);

  const doExport = async (format: GetReportFormat) => {
    setExporting(format);
    try {
      await downloadExport(report.type as ReportType, from, to, format);
    } catch {
      toast({
        title: "Export failed",
        description: "The report could not be exported. Try again.",
        variant: "destructive",
      });
    } finally {
      setExporting(null);
    }
  };

  const chartData = useMemo(
    () =>
      report.chart.points.map((p) => ({
        label: p.label,
        value: p.value,
        secondary: p.secondary ?? undefined,
      })),
    [report],
  );
  const fmt = (v: number) =>
    report.chart.currency
      ? `${
          v >= 1_000_000_000
            ? `${(v / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`
            : v >= 1_000_000
              ? `${Math.round(v / 1_000_000)}M`
              : v >= 1000
                ? `${Math.round(v / 1000)}k`
                : v
        }`
      : String(v);

  return (
    <div className="space-y-4">
      {/* Export bar — server-rendered files with audit trail */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.label} · {report.from} → {report.to}
        </p>
        <div className="flex gap-2">
          {(
            [
              { format: "pdf" as const, label: "PDF", icon: FileDown },
              { format: "xlsx" as const, label: "Excel", icon: FileSpreadsheet },
              { format: "csv" as const, label: "CSV", icon: FileText },
            ]
          ).map(({ format, label, icon: Icon }) => (
            <Button
              key={format}
              variant="outline"
              size="sm"
              disabled={exporting !== null}
              onClick={() => void doExport(format)}
            >
              {exporting === format ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Icon className="h-4 w-4 mr-1.5" />
              )}
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {report.kpis.map((k, i) => (
          <motion.div
            key={k.label}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.4 }}
          >
            <Card className="glass-panel border-none shadow-md h-full">
              <CardContent className="px-3.5 py-3">
                <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground truncate">
                  {k.label}
                </p>
                <h2 className="mt-1 text-lg font-bold tracking-tight leading-none">
                  {k.value}
                </h2>
                {k.sub && (
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">{k.sub}</p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Chart */}
      <Card className="glass-panel border-none shadow-xl">
        <div className="px-4 pt-3 pb-1">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            {report.chart.valueLabel}
          </h3>
        </div>
        <CardContent className="p-2 h-[210px]">
          {chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              No data in this range.
            </div>
          ) : report.chart.kind === "pie" ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={3}
                  stroke="none"
                >
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} />
                <Legend
                  formatter={(v) => (
                    <span className="text-xs text-muted-foreground">{v}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : report.chart.kind === "area" ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                <defs>
                  <linearGradient id="reportArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={fmt} width={52} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ color: "hsl(var(--muted-foreground))" }} />
                <Area type="monotone" dataKey="value" name={report.chart.valueLabel} stroke="hsl(var(--primary))" strokeWidth={3} fill="url(#reportArea)" />
                {report.chart.secondaryLabel && (
                  <Area type="monotone" dataKey="secondary" name={report.chart.secondaryLabel} stroke="hsl(0 0% 60%)" strokeWidth={2} fill="none" />
                )}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval={0} angle={chartData.length > 7 ? -20 : 0} dy={6} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={fmt} width={52} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} labelStyle={{ color: "hsl(var(--muted-foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Bar dataKey="value" name={report.chart.valueLabel} fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={44} />
                {report.chart.secondaryLabel && (
                  <Bar dataKey="secondary" name={report.chart.secondaryLabel} fill="hsl(0 0% 55%)" radius={[6, 6, 0, 0]} maxBarSize={44} />
                )}
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="glass-panel border-none shadow-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[240px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {report.table.columns.map((c) => (
                  <th
                    key={c}
                    className="px-5 py-3.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.table.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={report.table.columns.length}
                    className="px-5 py-10 text-center text-muted-foreground"
                  >
                    No rows in this range.
                  </td>
                </tr>
              ) : (
                report.table.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-white/[0.04] last:border-0 hover:bg-foreground/[0.03] transition-colors"
                  >
                    {row.map((cell, j) => (
                      <td key={j} className="px-5 py-3 text-foreground/90">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
