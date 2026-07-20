import { useMemo, useState } from "react";
import { useGetReport } from "@workspace/api-client-react";
import type { Report } from "@workspace/api-client-react";
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
  Users,
  Megaphone,
  HeartHandshake,
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
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

type ReportType =
  | "lead-conversion"
  | "sales"
  | "revenue"
  | "inventory"
  | "finance"
  | "delivery"
  | "service"
  | "employee-performance"
  | "marketing"
  | "customer-retention";

const REPORT_TYPES: {
  type: ReportType;
  label: string;
  module: string;
  icon: typeof Target;
}[] = [
  { type: "lead-conversion", label: "Lead Conversion", module: "leads", icon: Target },
  { type: "sales", label: "Sales", module: "deals", icon: BarChart3 },
  { type: "revenue", label: "Revenue", module: "finance", icon: TrendingUp },
  { type: "inventory", label: "Inventory", module: "inventory", icon: Layers },
  { type: "finance", label: "Finance", module: "finance", icon: Landmark },
  { type: "delivery", label: "Delivery", module: "deliveries", icon: Truck },
  { type: "service", label: "Service", module: "service", icon: Wrench },
  { type: "employee-performance", label: "Employee Performance", module: "dashboard", icon: Users },
  { type: "marketing", label: "Marketing", module: "leads", icon: Megaphone },
  { type: "customer-retention", label: "Customer Retention", module: "customers", icon: HeartHandshake },
];

const PIE_COLORS = [
  "hsl(218 72% 52%)",
  "hsl(43 74% 52%)",
  "hsl(0 0% 62%)",
  "hsl(218 50% 34%)",
  "hsl(43 50% 38%)",
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

function exportCsv(report: Report) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    report.table.columns.map(esc).join(","),
    ...report.table.rows.map((r) => r.map(esc).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${report.type}-report-${report.from}-to-${report.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportExcel(report: Report) {
  const wb = XLSX.utils.book_new();
  const kpiSheet = XLSX.utils.aoa_to_sheet([
    ["Metric", "Value"],
    ...report.kpis.map((k) => [k.label, k.value]),
  ]);
  const tableSheet = XLSX.utils.aoa_to_sheet([
    report.table.columns,
    ...report.table.rows,
  ]);
  XLSX.utils.book_append_sheet(wb, kpiSheet, "Summary");
  XLSX.utils.book_append_sheet(wb, tableSheet, "Detail");
  XLSX.writeFile(wb, `${report.type}-report-${report.from}-to-${report.to}.xlsx`);
}

function exportPdf(report: Report) {
  const doc = new jsPDF();
  doc.setFontSize(18);
  doc.text(`${report.label} Report`, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`AURA Dealership OS · ${report.from} to ${report.to}`, 14, 25);
  autoTable(doc, {
    startY: 32,
    head: [["Metric", "Value"]],
    body: report.kpis.map((k) => [k.label, k.value + (k.sub ? ` (${k.sub})` : "")]),
    theme: "grid",
    headStyles: { fillColor: [180, 20, 20] },
  });
  autoTable(doc, {
    startY:
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
        ?.finalY != null
        ? (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
            .finalY + 8
        : 60,
    head: [report.table.columns],
    body: report.table.rows,
    theme: "striped",
    headStyles: { fillColor: [180, 20, 20] },
  });
  doc.save(`${report.type}-report-${report.from}-to-${report.to}.pdf`);
}

export default function Reports() {
  const { can } = useAuthz();
  const visible = REPORT_TYPES.filter((r) => can(r.module, "view"));
  const [selected, setSelected] = useState<ReportType | null>(null);
  const [from, setFrom] = useState(isoDaysAgo(180));
  const [to, setTo] = useState(isoDaysAgo(0));

  const active = selected ?? visible[0]?.type ?? null;
  const activeDef = REPORT_TYPES.find((r) => r.type === active);

  const { data: report, isLoading, isError } = useGetReport(
    { type: (active ?? "sales") as ReportType, from, to },
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
      <div className="w-full px-5 md:px-8 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-[1.75rem] font-semibold tracking-tight">
              Reports
            </h1>
          </div>
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
          <ReportBody report={report} />
        )}
      </div>
    </div>
  );
}

function ReportBody({ report }: { report: Report }) {
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
      ? `$${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`
      : String(v);

  return (
    <div className="space-y-6">
      {/* Export bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.label} · {report.from} → {report.to}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => exportPdf(report)}>
            <FileDown className="h-4 w-4 mr-1.5" /> PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportExcel(report)}>
            <FileSpreadsheet className="h-4 w-4 mr-1.5" /> Excel
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportCsv(report)}>
            <FileText className="h-4 w-4 mr-1.5" /> CSV
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {report.kpis.map((k, i) => (
          <motion.div
            key={k.label}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.4 }}
          >
            <Card className="glass-panel border-none shadow-lg">
              <CardContent className="p-5">
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {k.label}
                </p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight">
                  {k.value}
                </h2>
                {k.sub && (
                  <p className="mt-1 text-xs text-muted-foreground">{k.sub}</p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Chart */}
      <Card className="glass-panel border-none shadow-xl">
        <div className="p-6 pb-3">
          <h3 className="text-lg font-semibold tracking-wide">
            {report.chart.valueLabel}
          </h3>
        </div>
        <CardContent className="p-2 h-[300px]">
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
        <div className="overflow-x-auto">
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
