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
  Tooltip,
} from "recharts";
import {
  Target,
  Users,
  Timer,
  FileClock,
  BookmarkCheck,
  Quote,
  ArrowRight,
} from "lucide-react";

/* Reports is the persona-aware analytics home, rebuilt (2026-07) as ONE
   compact dashboard: a KPI strip on top, then a tight grid of small-multiple
   widgets. Scoped to the viewer's role:
   - Advisors: their own funnel, conversion and response-time.
   - Sales Managers: team pipeline, SLA compliance, top performers.
   - Leadership (GM / super-admin): division-aware performance + sentiment.
   All figures come from existing list endpoints — no new data. Long tables
   are condensed; drill-down goes to Detailed Reports / module pages. */

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
  borderRadius: "10px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
  fontSize: "12px",
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

/* ---------- compact building blocks ---------- */

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
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
        <p className="mt-1 text-lg font-bold tracking-tight leading-none">
          {value}
        </p>
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

const AXIS_TICK = { fontSize: 10, fill: "hsl(var(--muted-foreground))" } as const;

/* Mini horizontal funnel: label + bar + count per stage, no axes. */
function MiniFunnel({ leads }: { leads: Lead[] }) {
  const rows = FUNNEL_STAGES.map((s) => ({
    label: s.label,
    value: leads.filter(s.match).length,
  }));
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-2 pb-1">
      {rows.map((r, i) => (
        <div key={r.label} className="flex items-center gap-2 text-[11px]">
          <span className="w-16 shrink-0 text-muted-foreground truncate">
            {r.label}
          </span>
          <div className="flex-1 h-3 rounded-full bg-foreground/[0.05] overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(r.value / max) * 100}%`,
                background: SERIES_COLORS[i % SERIES_COLORS.length],
                minWidth: r.value > 0 ? 6 : 0,
              }}
            />
          </div>
          <span className="w-6 shrink-0 text-right tabular-nums font-semibold">
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function SourceDonut({ leads }: { leads: Lead[] }) {
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

  if (bySource.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No leads yet.
      </div>
    );
  }
  const top = bySource.slice(0, 5);
  return (
    <div className="h-full flex items-center gap-1">
      <div className="h-full w-1/2 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={bySource}
              dataKey="value"
              nameKey="label"
              innerRadius="55%"
              outerRadius="88%"
              paddingAngle={3}
              stroke="none"
            >
              {bySource.map((_, i) => (
                <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="w-1/2 space-y-1 pr-2">
        {top.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <span className="truncate text-muted-foreground">{s.label}</span>
            <span className="ml-auto tabular-nums font-semibold">{s.value}</span>
          </div>
        ))}
        {bySource.length > 5 && (
          <p className="text-[10px] text-muted-foreground">
            +{bySource.length - 5} more
          </p>
        )}
      </div>
    </div>
  );
}

function AdvisorBars({ leads }: { leads: Lead[] }) {
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
      .map(([name, v]) => {
        const short = name.includes("@") ? name.split("@")[0] : name.split(" ")[0];
        return { name: short.length > 10 ? `${short.slice(0, 9)}…` : short, ...v };
      })
      .sort((a, b) => b.active + b.won - (a.active + a.won))
      .slice(0, 6);
  }, [leads]);

  if (byAdvisor.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No pipeline yet.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={byAdvisor} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={AXIS_TICK} interval={0} />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={AXIS_TICK} width={24} />
        <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
        <Bar dataKey="active" name="Active" stackId="p" fill={SERIES_COLORS[0]} maxBarSize={22} />
        <Bar dataKey="won" name="Won" stackId="p" fill={SERIES_COLORS[1]} radius={[4, 4, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChannelBars({ leads }: { leads: Lead[] }) {
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
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 6);
  }, [leads]);

  if (channelRows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No leads yet.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={channelRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={AXIS_TICK} interval={0} />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={AXIS_TICK} width={24} />
        <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
        <Bar dataKey="leads" name="Leads" fill={SERIES_COLORS[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
        <Bar dataKey="won" name="Won" fill={SERIES_COLORS[1]} radius={[4, 4, 0, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function TopPerformers({ deals }: { deals: Deal[] }) {
  const money = useMoney();
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
      .slice(0, 4);
  }, [deals]);

  if (topPerformers.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No deliveries yet.
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-2 pb-1">
      {topPerformers.map((p, i) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-foreground/5 text-foreground text-[10px] font-bold flex items-center justify-center tabular-nums shrink-0">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate leading-tight">{p.name}</p>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {p.units} delivered
            </p>
          </div>
          <span className="text-[11px] font-semibold tabular-nums shrink-0">
            {money.gyd(p.revenue)}
          </span>
        </div>
      ))}
    </div>
  );
}

function DivisionMini({ leads, deals }: { leads: Lead[]; deals: Deal[] }) {
  const money = useMoney();
  const { data: divisions } = useListDivisions();

  const divisionRows = useMemo(() => {
    const divs = [
      ...(divisions ?? []).map((d) => ({ id: d.id as number | null, name: d.name })),
      { id: null, name: "Unassigned" },
    ];
    return divs
      .map((div) => {
        const dLeads = leads.filter((l) => (l.divisionId ?? null) === div.id);
        const dDeals = deals.filter((d) => (d.divisionId ?? null) === div.id);
        const delivered = dDeals.filter((d) => d.stage === "delivered");
        return {
          name: div.name,
          leads: dLeads.length,
          delivered: delivered.length,
          revenue: delivered.reduce((s, d) => s + d.otdPrice, 0),
        };
      })
      .filter((r) => r.leads > 0 || r.delivered > 0)
      .slice(0, 4);
  }, [divisions, leads, deals]);

  if (divisionRows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No division activity yet.
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 px-2 pb-1">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Division</span>
        <span className="text-right">Leads</span>
        <span className="text-right">Deliv.</span>
        <span className="text-right">Revenue</span>
      </div>
      {divisionRows.map((r) => (
        <div
          key={r.name}
          className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11px] items-center"
        >
          <span className="font-medium truncate">{r.name}</span>
          <span className="text-right tabular-nums">{r.leads}</span>
          <span className="text-right tabular-nums">{r.delivered}</span>
          <span className="text-right tabular-nums font-semibold">
            {money.gyd(r.revenue)}
          </span>
        </div>
      ))}
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

  if (!sentiment) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        Sentiment analysis unavailable.
      </div>
    );
  }
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

  const scopedLeads = isAdvisor
    ? allLeads.filter((l) => matchesMe(l.ownerUserId, l.assignedTo))
    : allLeads;
  const scopedDeals = isAdvisor
    ? allDeals.filter((d) => matchesMe(d.salesAdvisorUserId, d.salesAdvisor))
    : allDeals;

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

  /* KPI strip figures (all from the scoped datasets). */
  const active = scopedLeads.filter((l) => l.phase !== "lost");
  const won = scopedLeads.filter((l) => l.phase === "won");
  const conversion =
    active.length > 0 ? Math.round((won.length / active.length) * 100) : 0;
  const delivered = scopedDeals.filter((d) => d.stage === "delivered");
  const revenue = delivered.reduce((s, d) => s + d.otdPrice, 0);
  const sla = slaCompliancePct(scopedLeads);
  const overdue = scopedLeads.filter(
    (l) =>
      !l.contactedDate &&
      l.phase !== "lost" &&
      Date.now() - new Date(l.createdAt).getTime() > 24 * 3_600_000,
  ).length;

  const quoteToOrder = useMemo(() => {
    const quoted = scopedLeads.filter((l) => l.quotationSent);
    if (quoted.length === 0) return null;
    const dealLeadIds = new Set(
      scopedDeals.filter((d) => d.leadId != null).map((d) => d.leadId),
    );
    const ordered = quoted.filter(
      (l) => l.phase === "won" || dealLeadIds.has(l.id),
    );
    return {
      pct: Math.round((ordered.length / quoted.length) * 100),
      quoted: quoted.length,
      ordered: ordered.length,
    };
  }, [scopedLeads, scopedDeals]);

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

  const WIDGET_H = "h-[168px]";

  return (
    <div className="space-y-3">
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Kpi
          label={isAdvisor ? "My Active Leads" : "Active Leads"}
          value={String(active.length - won.length)}
          icon={Users}
        />
        <Kpi
          label="Conversion"
          value={`${conversion}%`}
          sub={`${won.length} won of ${active.length}`}
          icon={Target}
        />
        <Kpi
          label="Avg Response"
          value={fmtHours(avgResponseHours(scopedLeads))}
          sub="Enquiry to first contact"
          icon={Timer}
        />
        <Kpi
          label={isAdvisor ? "My Revenue" : "Delivered Revenue"}
          value={money.gyd(revenue)}
          sub={`${delivered.length} delivered`}
        />
        {!isAdvisor && (
          <Kpi
            label="24h SLA"
            value={sla == null ? "—" : `${sla}%`}
            sub="Contacted within 24h"
            icon={Timer}
          />
        )}
        {!isAdvisor && (
          <Kpi label="Overdue Contacts" value={String(overdue)} sub="Past 24h SLA" />
        )}
        <Kpi
          label="Quote-to-Order"
          value={quoteToOrder ? `${quoteToOrder.pct}%` : "—"}
          sub={
            quoteToOrder
              ? `${quoteToOrder.ordered} of ${quoteToOrder.quoted} quotes`
              : "No quotations yet"
          }
          icon={Quote}
        />
        {canDeliveries && !isAdvisor ? (
          <Kpi
            label="Reservations"
            value={reservation ? `${reservation.pct}%` : "—"}
            sub={
              reservation
                ? `${reservation.converted} of ${reservation.total} converted`
                : "No active bookings"
            }
            icon={BookmarkCheck}
          />
        ) : canFinance && !isAdvisor ? (
          <Kpi
            label="Pending Invoices"
            value={String(pendingInvoices.count)}
            sub={`${money.gyd(pendingInvoices.amount)} outstanding`}
            icon={FileClock}
          />
        ) : (
          <Kpi
            label={isAdvisor ? "My Won" : "Team Won"}
            value={String(won.length)}
            sub="Converted leads"
            icon={Target}
          />
        )}
      </div>

      {/* Small-multiple widget grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
        <div className={`${WIDGET_H} min-w-0`}>
          <Widget
            title={isAdvisor ? "My Funnel" : "Pipeline Funnel"}
            action={{ label: "Pipeline", href: "/pipeline" }}
          >
            <MiniFunnel leads={scopedLeads} />
          </Widget>
        </div>
        <div className={`${WIDGET_H} min-w-0`}>
          <Widget title="Leads by Source">
            <SourceDonut leads={scopedLeads} />
          </Widget>
        </div>
        {isAdvisor ? (
          <div className={`${WIDGET_H} min-w-0`}>
            <Widget title="Channel Win Rate">
              <ChannelBars leads={scopedLeads} />
            </Widget>
          </div>
        ) : (
          <div className={`${WIDGET_H} min-w-0`}>
            <Widget title="Pipeline by Advisor">
              <AdvisorBars leads={scopedLeads} />
            </Widget>
          </div>
        )}
        {!isAdvisor && (
          <div className={`${WIDGET_H} min-w-0`}>
            <Widget title="Top Performers">
              <TopPerformers deals={scopedDeals} />
            </Widget>
          </div>
        )}
        {isLeadership && (
          <div className={`${WIDGET_H} min-w-0`}>
            <Widget
              title="Division Performance"
              action={{ label: "Detail", href: "/reports#detailed-reports" }}
            >
              <DivisionMini leads={allLeads} deals={allDeals} />
            </Widget>
          </div>
        )}
        {isLeadership && (
          <div className={`${WIDGET_H} min-w-0`}>
            <Widget title="Customer Sentiment">
              <SentimentMini />
            </Widget>
          </div>
        )}
        {isManager && (
          <div className={`${WIDGET_H} min-w-0`}>
            <Widget title="Channel Performance">
              <ChannelBars leads={scopedLeads} />
            </Widget>
          </div>
        )}
      </div>
    </div>
  );
}
