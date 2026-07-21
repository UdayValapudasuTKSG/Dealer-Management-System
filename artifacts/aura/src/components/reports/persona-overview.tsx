import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListLeads,
  useListDeals,
  useListDivisions,
  useListBookings,
  useListInvoices,
  useGetSentimentAnalysis,
  getListBookingsQueryKey,
  getListInvoicesQueryKey,
  getGetSentimentAnalysisQueryKey,
} from "@workspace/api-client-react";
import type { Lead, Deal } from "@workspace/api-client-react";
import { useAuthz } from "@/lib/auth";
import { useMoney } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
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
import {
  Target,
  Users,
  Building2,
  HeartPulse,
  Timer,
  FileClock,
  BookmarkCheck,
  Quote,
} from "lucide-react";

/* Reports is the persona-aware analytics home. The Daily Briefing is lean by
   design (triage + schedule + sentiment); every chart/KPI lives here, scoped
   to the viewer's role:
   - Advisors: their own funnel, conversion and response-time.
   - Sales Managers: team pipeline, SLA compliance, top performers.
   - Leadership (GM / super-admin): division-aware performance + sentiment.
   All figures are computed from existing list endpoints — no new data. */

const SERIES_COLORS = [
  "hsl(218 72% 52%)",
  "hsl(185 42% 44%)",
  "hsl(0 0% 62%)",
  "hsl(218 50% 34%)",
  "hsl(185 32% 30%)",
  "hsl(0 0% 40%)",
  "hsl(28 60% 52%)",
  "hsl(340 45% 50%)",
];

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--popover-border))",
  borderRadius: "12px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
} as const;

/* DMS stage labels are a label-only mapping over lead phase. */
const FUNNEL_STAGES: { key: string; label: string; match: (l: Lead) => boolean }[] = [
  { key: "new", label: "New", match: (l) => l.phase === "aware" },
  { key: "contacted", label: "Contacted", match: (l) => l.phase === "consider" },
  { key: "engaged", label: "Engaged", match: (l) => l.phase === "engage" },
  { key: "prebook", label: "Pre-Book", match: (l) => l.phase === "negotiate" },
  { key: "won", label: "Won", match: (l) => l.phase === "won" },
];

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  walk_in: "Walk-In",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  referral: "Referral",
  gmail: "Email",
};

function avgResponseHours(leads: Lead[]): number | null {
  const durations = leads
    .filter((l) => l.contactedDate)
    .map(
      (l) =>
        (new Date(l.contactedDate as string).getTime() -
          new Date(l.createdAt).getTime()) /
        3_600_000,
    )
    .filter((h) => h >= 0);
  if (durations.length === 0) return null;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

function slaCompliancePct(leads: Lead[]): number | null {
  const contacted = leads.filter((l) => l.contactedDate);
  if (contacted.length === 0) return null;
  const within = contacted.filter(
    (l) =>
      new Date(l.contactedDate as string).getTime() -
        new Date(l.createdAt).getTime() <=
      24 * 3_600_000,
  );
  return Math.round((within.length / contacted.length) * 100);
}

function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  delay = 0,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: typeof Target;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4 }}
    >
      <Card className="glass-panel border-none shadow-lg h-full">
        <CardContent className="p-5">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {label}
            </p>
          </div>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">{value}</h2>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  sub,
}: {
  icon: typeof Target;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div>
        <h2 className="text-sm font-bold uppercase tracking-widest text-foreground">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Advisor: my own performance                                         */
/* ------------------------------------------------------------------ */
function AdvisorOverview({
  myLeads,
  myDeals,
}: {
  myLeads: Lead[];
  myDeals: Deal[];
}) {
  const money = useMoney();
  const funnel = FUNNEL_STAGES.map((s) => ({
    label: s.label,
    value: myLeads.filter(s.match).length,
  }));
  const active = myLeads.filter((l) => l.phase !== "lost");
  const won = myLeads.filter((l) => l.phase === "won");
  const conversion =
    active.length > 0 ? Math.round((won.length / active.length) * 100) : 0;
  const delivered = myDeals.filter((d) => d.stage === "delivered");
  const revenue = delivered.reduce((sum, d) => sum + d.otdPrice, 0);

  return (
    <section className="space-y-4">
      <SectionHeading
        icon={Target}
        title="My Performance"
        sub="Your own funnel, conversion and responsiveness."
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Active Leads" value={String(active.length - won.length)} icon={Users} />
        <StatCard
          label="My Conversion"
          value={`${conversion}%`}
          sub={`${won.length} won of ${active.length}`}
          icon={Target}
          delay={0.05}
        />
        <StatCard
          label="Avg Response Time"
          value={fmtHours(avgResponseHours(myLeads))}
          sub="First contact after enquiry"
          icon={Timer}
          delay={0.1}
        />
        <StatCard
          label="My Delivered Revenue"
          value={money.gyd(revenue)}
          sub={`${delivered.length} vehicles delivered`}
          delay={0.15}
        />
      </div>
      <Card className="glass-panel border-none shadow-xl">
        <div className="p-6 pb-2">
          <h3 className="text-sm font-semibold tracking-wide">My Funnel</h3>
        </div>
        <CardContent className="p-2 h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={funnel} margin={{ top: 12, right: 24, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} width={36} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
              <Bar dataKey="value" name="Leads" fill={SERIES_COLORS[0]} radius={[6, 6, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Sales Manager: team view                                            */
/* ------------------------------------------------------------------ */
function ManagerOverview({ leads, deals }: { leads: Lead[]; deals: Deal[] }) {
  const money = useMoney();

  const byAdvisor = useMemo(() => {
    const map = new Map<string, { active: number; won: number }>();
    for (const l of leads) {
      if (l.phase === "lost") continue;
      const key = l.assignedTo?.trim() || "Unassigned";
      const row = map.get(key) ?? { active: 0, won: 0 };
      if (l.phase === "won") row.won += 1;
      else row.active += 1;
      map.set(key, row);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.active + b.won - (a.active + a.won))
      .slice(0, 8);
  }, [leads]);

  const topPerformers = useMemo(() => {
    const map = new Map<string, { units: number; revenue: number }>();
    for (const d of deals) {
      if (d.stage !== "delivered") continue;
      const key = d.salesAdvisor?.trim() || "Unassigned";
      const row = map.get(key) ?? { units: 0, revenue: 0 };
      row.units += 1;
      row.revenue += d.otdPrice;
      map.set(key, row);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }, [deals]);

  const sla = slaCompliancePct(leads);
  const uncontactedOverdue = leads.filter(
    (l) =>
      !l.contactedDate &&
      l.phase !== "lost" &&
      Date.now() - new Date(l.createdAt).getTime() > 24 * 3_600_000,
  ).length;

  return (
    <section className="space-y-4">
      <SectionHeading
        icon={Users}
        title="Team Performance"
        sub="Pipeline load, SLA compliance and top performers across the sales team."
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="24h SLA Compliance"
          value={sla == null ? "—" : `${sla}%`}
          sub="Contacted within 24 hours"
          icon={Timer}
        />
        <StatCard
          label="Overdue Contacts"
          value={String(uncontactedOverdue)}
          sub="Past the 24h contact SLA"
          delay={0.05}
        />
        <StatCard
          label="Avg Response Time"
          value={fmtHours(avgResponseHours(leads))}
          sub="Team-wide first contact"
          delay={0.1}
        />
        <StatCard
          label="Team Won"
          value={String(leads.filter((l) => l.phase === "won").length)}
          sub="Converted leads"
          delay={0.15}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="glass-panel border-none shadow-xl lg:col-span-2">
          <div className="p-6 pb-2">
            <h3 className="text-sm font-semibold tracking-wide">Pipeline by Advisor</h3>
          </div>
          <CardContent className="p-2 h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byAdvisor} margin={{ top: 12, right: 24, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval={0} angle={byAdvisor.length > 5 ? -18 : 0} dy={6} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} width={36} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Legend formatter={(v) => <span className="text-xs text-muted-foreground">{v}</span>} />
                <Bar dataKey="active" name="Active" stackId="p" fill={SERIES_COLORS[0]} maxBarSize={40} />
                <Bar dataKey="won" name="Won" stackId="p" fill={SERIES_COLORS[1]} radius={[6, 6, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card className="glass-panel border-none shadow-xl">
          <div className="p-6 pb-3">
            <h3 className="text-sm font-semibold tracking-wide">Top Performers</h3>
          </div>
          <CardContent className="px-6 pb-6 pt-0 space-y-3">
            {topPerformers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deliveries yet.</p>
            ) : (
              topPerformers.map((p, i) => (
                <div key={p.name} className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-foreground/5 text-foreground text-[11px] font-bold flex items-center justify-center tabular-nums">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {p.units} delivered
                    </p>
                  </div>
                  <span className="text-xs font-semibold tabular-nums">
                    {money.gyd(p.revenue)}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Leadership: division-aware performance + sentiment                  */
/* ------------------------------------------------------------------ */
function LeadershipOverview({ leads, deals }: { leads: Lead[]; deals: Deal[] }) {
  const money = useMoney();
  const { data: divisions } = useListDivisions();
  const { data: sentiment } = useGetSentimentAnalysis(undefined, {
    query: {
      queryKey: getGetSentimentAnalysisQueryKey(),
      retry: 1,
      staleTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  const divisionRows = useMemo(() => {
    const divs = [
      ...(divisions ?? []).map((d) => ({ id: d.id as number | null, name: d.name })),
      { id: null, name: "Unassigned" },
    ];
    return divs
      .map((div) => {
        const dLeads = leads.filter((l) => (l.divisionId ?? null) === div.id);
        const dDeals = deals.filter((d) => (d.divisionId ?? null) === div.id);
        const preBook = dLeads.filter(
          (l) => l.phase === "negotiate" || l.phase === "won",
        ).length;
        const delivered = dDeals.filter((d) => d.stage === "delivered");
        return {
          name: div.name,
          leads: dLeads.length,
          preBook,
          delivered: delivered.length,
          revenue: delivered.reduce((s, d) => s + d.otdPrice, 0),
          lost: dLeads.filter((l) => l.phase === "lost").length,
        };
      })
      .filter((r) => r.leads > 0 || r.delivered > 0);
  }, [divisions, leads, deals]);

  const channelRows = useMemo(() => {
    const map = new Map<string, { leads: number; won: number }>();
    for (const l of leads) {
      const key = SOURCE_LABEL[l.source] ?? l.source;
      const row = map.get(key) ?? { leads: 0, won: 0 };
      row.leads += 1;
      if (l.phase === "won") row.won += 1;
      map.set(key, row);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.leads - a.leads);
  }, [leads]);

  const lostLeads = leads.filter((l) => l.phase === "lost");

  return (
    <section className="space-y-4">
      <SectionHeading
        icon={Building2}
        title="Leadership View"
        sub="Division-aware performance, channels and customer sentiment."
      />

      {/* Divisions */}
      <Card className="glass-panel border-none shadow-xl overflow-hidden">
        <div className="p-6 pb-3">
          <h3 className="text-sm font-semibold tracking-wide">
            Division Performance · Lead → Pre-Book → Delivered
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {["Division", "Leads", "Pre-Book", "Delivered", "Conversion", "Revenue", "Lost"].map(
                  (c) => (
                    <th
                      key={c}
                      className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {c}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {divisionRows.map((r) => (
                <tr
                  key={r.name}
                  className="border-b border-white/[0.04] last:border-0 hover:bg-foreground/[0.03] transition-colors"
                >
                  <td className="px-5 py-3 font-medium">{r.name}</td>
                  <td className="px-5 py-3 tabular-nums">{r.leads}</td>
                  <td className="px-5 py-3 tabular-nums">{r.preBook}</td>
                  <td className="px-5 py-3 tabular-nums">{r.delivered}</td>
                  <td className="px-5 py-3 tabular-nums">
                    {r.leads > 0 ? `${Math.round((r.delivered / r.leads) * 100)}%` : "—"}
                  </td>
                  <td className="px-5 py-3 tabular-nums">{money.gyd(r.revenue)}</td>
                  <td className="px-5 py-3 tabular-nums text-muted-foreground">{r.lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Channel performance */}
        <Card className="glass-panel border-none shadow-xl lg:col-span-2">
          <div className="p-6 pb-2">
            <h3 className="text-sm font-semibold tracking-wide">Channel Performance</h3>
          </div>
          <CardContent className="p-2 h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={channelRows} margin={{ top: 12, right: 24, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval={0} angle={channelRows.length > 5 ? -18 : 0} dy={6} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} width={36} />
                <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Legend formatter={(v) => <span className="text-xs text-muted-foreground">{v}</span>} />
                <Bar dataKey="leads" name="Leads" fill={SERIES_COLORS[0]} radius={[6, 6, 0, 0]} maxBarSize={36} />
                <Bar dataKey="won" name="Won" fill={SERIES_COLORS[1]} radius={[6, 6, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Sentiment analytics */}
        <Card className="glass-panel border-none shadow-xl">
          <div className="p-6 pb-3 flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold tracking-wide">Customer Sentiment</h3>
          </div>
          <CardContent className="px-6 pb-6 pt-0 space-y-4">
            {!sentiment ? (
              <p className="text-sm text-muted-foreground">Sentiment analysis unavailable.</p>
            ) : (
              <>
                <div>
                  <p className="text-2xl font-bold tracking-tight capitalize">
                    {sentiment.overallLabel}
                    <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
                      {Math.round(sentiment.overallScore)}/100
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {sentiment.sampleSize} interactions analysed
                  </p>
                </div>
                <div className="flex h-2 rounded-full overflow-hidden bg-foreground/5">
                  <div className="bg-foreground" style={{ width: `${sentiment.distribution.positive}%` }} />
                  <div className="bg-foreground/40" style={{ width: `${sentiment.distribution.neutral}%` }} />
                  <div className="bg-foreground/15" style={{ width: `${sentiment.distribution.negative}%` }} />
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                  <span>{Math.round(sentiment.distribution.positive)}% positive</span>
                  <span>{Math.round(sentiment.distribution.neutral)}% neutral</span>
                  <span>{Math.round(sentiment.distribution.negative)}% negative</span>
                </div>
                {sentiment.themes.length > 0 && (
                  <div className="space-y-1.5">
                    {sentiment.themes.slice(0, 4).map((t) => (
                      <div key={t.theme} className="flex items-center justify-between text-xs">
                        <span className="truncate">{t.theme}</span>
                        <span className="text-muted-foreground tabular-nums shrink-0 ml-3 capitalize">
                          {t.sentiment} · {t.mentions}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <p className="text-xs text-muted-foreground pt-1 border-t border-white/[0.06]">
              {lostLeads.length} lost leads overall ·{" "}
              <Link href="/pipeline" className="underline hover:text-foreground">
                review pipeline
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* BRD reports: Leads by Source, Quote-to-Order, Avg Response Time,    */
/* Reservation Conversion, Pending Invoices                            */
/* ------------------------------------------------------------------ */
function BrdReports({ leads, deals }: { leads: Lead[]; deals: Deal[] }) {
  const { can } = useAuthz();
  const money = useMoney();
  const canDeliveries = can("deliveries", "view");
  const canFinance = can("finance", "view");

  const { data: bookings } = useListBookings(undefined, {
    query: {
      queryKey: getListBookingsQueryKey(),
      enabled: canDeliveries,
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  });
  const { data: invoices } = useListInvoices(undefined, {
    query: {
      queryKey: getListInvoicesQueryKey(),
      enabled: canFinance,
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  });

  const bySource = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of leads) {
      const key = SOURCE_LABEL[l.source] ?? l.source;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [leads]);

  const quoteToOrder = useMemo(() => {
    const quoted = leads.filter((l) => l.quotationSent);
    if (quoted.length === 0) return null;
    const dealLeadIds = new Set(
      deals.filter((d) => d.leadId != null).map((d) => d.leadId),
    );
    const ordered = quoted.filter(
      (l) => l.phase === "won" || dealLeadIds.has(l.id),
    );
    return {
      pct: Math.round((ordered.length / quoted.length) * 100),
      quoted: quoted.length,
      ordered: ordered.length,
    };
  }, [leads, deals]);

  const reservation = useMemo(() => {
    const considered = (bookings ?? []).filter((b) => b.status !== "cancelled");
    if (considered.length === 0) return null;
    const converted = considered.filter((b) => b.status === "converted");
    return {
      pct: Math.round((converted.length / considered.length) * 100),
      converted: converted.length,
      total: considered.length,
    };
  }, [bookings]);

  const pendingInvoices = useMemo(() => {
    const pending = (invoices ?? []).filter(
      (i) => i.status === "issued" || i.status === "partially_paid",
    );
    return {
      count: pending.length,
      amount: pending.reduce((s, i) => s + i.amount, 0),
    };
  }, [invoices]);

  return (
    <section className="space-y-4">
      <SectionHeading
        icon={FileClock}
        title="Operational Reports"
        sub="Leads by source, quote-to-order, response time, reservations and invoicing."
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Avg Response Time"
          value={fmtHours(avgResponseHours(leads))}
          sub="Enquiry to first contact"
          icon={Timer}
        />
        <StatCard
          label="Quote-to-Order"
          value={quoteToOrder ? `${quoteToOrder.pct}%` : "—"}
          sub={
            quoteToOrder
              ? `${quoteToOrder.ordered} of ${quoteToOrder.quoted} quotes converted`
              : "No quotations sent yet"
          }
          icon={Quote}
          delay={0.05}
        />
        {canDeliveries && (
          <StatCard
            label="Reservation Conversion"
            value={reservation ? `${reservation.pct}%` : "—"}
            sub={
              reservation
                ? `${reservation.converted} of ${reservation.total} bookings became deals`
                : "No active reservations"
            }
            icon={BookmarkCheck}
            delay={0.1}
          />
        )}
        {canFinance && (
          <StatCard
            label="Pending Invoices"
            value={String(pendingInvoices.count)}
            sub={`${money.gyd(pendingInvoices.amount)} outstanding`}
            icon={FileClock}
            delay={0.15}
          />
        )}
      </div>
      <Card className="glass-panel border-none shadow-xl">
        <div className="p-6 pb-2">
          <h3 className="text-sm font-semibold tracking-wide">Leads by Source</h3>
        </div>
        <CardContent className="p-2 h-[260px]">
          {bySource.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              No leads yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={bySource}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={3}
                  stroke="none"
                >
                  {bySource.map((_, i) => (
                    <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
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
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Root: pick the sections the viewer's persona should see             */
/* ------------------------------------------------------------------ */
const MANAGER_ROLES = new Set([
  "Sales Manager",
  "Service Manager",
  "Finance Manager",
]);

export function PersonaOverview() {
  const { me } = useAuthz();
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();

  const isLeadership =
    !!me && (me.isSuperAdmin || me.roleName === "General Manager");
  const isManager = !!me && !isLeadership && MANAGER_ROLES.has(me.roleName ?? "");
  const isAdvisor = !!me && !isLeadership && !isManager;

  const allLeads = leads ?? [];
  const allDeals = deals ?? [];

  /* Advisors see only their own records (same scoping as the briefing). */
  const nameKey = me?.name?.trim().toLowerCase() ?? null;
  const myId = me?.id ?? null;
  const matchesMe = (
    userId: number | null | undefined,
    name: string | null | undefined,
  ) =>
    (myId != null && userId === myId) ||
    (userId == null &&
      nameKey != null &&
      (name ?? "").trim().toLowerCase() === nameKey);

  const myLeads = allLeads.filter((l) => matchesMe(l.ownerUserId, l.assignedTo));
  const myDeals = allDeals.filter((d) =>
    matchesMe(d.salesAdvisorUserId, d.salesAdvisor),
  );

  return (
    <div className="space-y-10">
      {isAdvisor && <AdvisorOverview myLeads={myLeads} myDeals={myDeals} />}
      {(isManager || isLeadership) && (
        <ManagerOverview leads={allLeads} deals={allDeals} />
      )}
      {isLeadership && <LeadershipOverview leads={allLeads} deals={allDeals} />}
      <BrdReports
        leads={isAdvisor ? myLeads : allLeads}
        deals={isAdvisor ? myDeals : allDeals}
      />
    </div>
  );
}
