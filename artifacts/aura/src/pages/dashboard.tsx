import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { TodaySchedule } from "@/components/today-schedule";
import { buildTriage } from "@/lib/triage";
import {
  useListGates,
  useListLeads,
  useListDeals,
  useListDeliveries,
  useListServiceOrders,
  useGetSentimentAnalysis,
  getGetSentimentAnalysisQueryKey,
} from "@workspace/api-client-react";
import type { SentimentHighlight } from "@workspace/api-client-react";
import {
  ArrowRight,
  HeartPulse,
  RefreshCw,
  Zap,
  Car,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  PhoneCall,
  CalendarClock,
  MailQuestion,
  Landmark,
  Bot,
  BarChart3,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useAuthz } from "@/lib/auth";
import type { TriageItem } from "@/lib/triage";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const KIND_UI: Record<string, { icon: any; action: string }> = {
  gate: { icon: ShieldCheck, action: "Review" },
  contact: { icon: PhoneCall, action: "Call" },
  testDrive: { icon: CalendarClock, action: "Prepare" },
  delivery: { icon: Car, action: "Deliver" },
  service: { icon: Zap, action: "Service" },
  stalled: { icon: AlertCircle, action: "Check in" },
  quote: { icon: MailQuestion, action: "Follow up" },
  deposit: { icon: Landmark, action: "Open" },
};

function getInitials(name: string) {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/* Categorized brief: instead of one flat dump of cards, the queue is grouped
   into clear categories, each capped and forwarding to its owning page. */
const TRIAGE_CATEGORIES: {
  key: string;
  kinds: string[];
  label: string;
  icon: any;
  href: string;
}[] = [
  { key: "contacts", kinds: ["contact"], label: "Contacts Due", icon: PhoneCall, href: "/pipeline" },
  { key: "approvals", kinds: ["gate"], label: "Approvals", icon: ShieldCheck, href: "/approvals" },
  { key: "testDrives", kinds: ["testDrive"], label: "Test Drives", icon: CalendarClock, href: "/pipeline" },
  { key: "deliveries", kinds: ["delivery"], label: "Deliveries", icon: Car, href: "/deliveries" },
  { key: "service", kinds: ["service"], label: "Service", icon: Zap, href: "/service" },
  { key: "followUps", kinds: ["stalled", "quote", "deposit"], label: "Follow-Ups", icon: AlertCircle, href: "/pipeline" },
];

const TRIAGE_CAP = 3;

function TriageRow({ item }: { item: TriageItem }) {
  const [, navigate] = useLocation();
  const ui = KIND_UI[item.kind] || KIND_UI.stalled;
  const isUrgent = item.bucket === "urgent";
  const isOverdue =
    item.kind === "contact" &&
    item.slaHoursLeft !== undefined &&
    item.slaHoursLeft <= 0;

  return (
    <button
      onClick={() => navigate(item.href)}
      className="group w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl text-left transition-all bg-foreground text-background hover:shadow-lg hover:-translate-y-px"
    >
      <div
        className={cn(
          "w-9 h-9 rounded-full flex items-center justify-center shrink-0 font-bold text-[10px] tracking-wider",
          isOverdue
            ? "bg-red-400/20 text-red-300"
            : isUrgent
              ? "bg-gold/25 text-gold"
              : "bg-background/15 text-background",
        )}
      >
        {getInitials(item.context)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm truncate">{item.context}</span>
          {isOverdue && (
            <span className="inline-flex items-center bg-red-400/15 text-red-300 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider whitespace-nowrap">
              Past due
            </span>
          )}
        </div>
        <div className="text-[11px] truncate mt-0.5 text-background/60">
          {item.subContext}
          {item.assignee ? ` · with ${item.assignee}` : ""}
        </div>
      </div>
      <span
        className={cn(
          "flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest shrink-0 transition-colors",
          isOverdue ? "text-red-300" : "text-gold",
        )}
      >
        {ui.action}
        <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function TriageBrief({ items }: { items: TriageItem[] }) {
  const groups = TRIAGE_CATEGORIES.map((cat) => ({
    ...cat,
    items: items.filter((i) => cat.kinds.includes(i.kind)),
  })).filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    return (
      <div className="py-12 rounded-3xl border border-dashed border-border flex flex-col items-center justify-center text-muted-foreground">
        <CheckCircle2 className="w-8 h-8 mb-3 opacity-20" />
        <p className="text-sm font-medium">All caught up</p>
        <p className="text-xs mt-1 opacity-70">Nothing needs your attention right now.</p>
      </div>
    );
  }

  /* Balance the category panels into two columns by visible row count so the
     board always looks deliberate — no ragged empty space. */
  const columns: (typeof groups)[] = [[], []];
  const heights = [0, 0];
  for (const g of groups) {
    const h = Math.min(g.items.length, TRIAGE_CAP) + 1;
    const target = heights[0] <= heights[1] ? 0 : 1;
    columns[target].push(g);
    heights[target] += h;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
      {columns
        .filter((col) => col.length > 0)
        .map((col, ci) => (
          <div key={ci} className="space-y-5">
            {col.map((g, gi) => {
              const Icon = g.icon;
              const overflow = g.items.length - TRIAGE_CAP;
              return (
                <motion.div
                  key={g.key}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: (ci * 3 + gi) * 0.05 }}
                  className="rounded-3xl border border-border/60 bg-card/60 p-3.5"
                >
                  <div className="flex items-center gap-2.5 px-1 pb-3">
                    <span className="w-7 h-7 rounded-xl bg-gold/10 text-gold flex items-center justify-center shrink-0">
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-foreground">
                      {g.label}
                    </span>
                    <span className="bg-foreground/10 text-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums">
                      {g.items.length}
                    </span>
                    {overflow > 0 && (
                      <Link
                        href={g.href}
                        className="ml-auto text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-gold transition-colors"
                      >
                        +{overflow} more
                      </Link>
                    )}
                  </div>
                  <div className="space-y-2">
                    {g.items.slice(0, TRIAGE_CAP).map((item) => (
                      <TriageRow key={item.key} item={item} />
                    ))}
                  </div>
                </motion.div>
              );
            })}
          </div>
        ))}
    </div>
  );
}

/* Roles that see the dealership-wide triage queue. Everyone else (advisors,
   technicians, coordinators) gets a personal briefing scoped to their own
   assignments. */
const BROAD_VIEW_ROLES = new Set([
  "General Manager",
  "Sales Manager",
  "Service Manager",
  "Finance Manager",
]);

/* The Daily Briefing is deliberately LEAN: triage, today's scheduling and
   overall call sentiment only. ALL charts, KPIs and funnels live in Reports. */
export default function Dashboard() {
  const { me, can } = useAuthz();
  const isBroadView =
    !!me && (me.isSuperAdmin || BROAD_VIEW_ROLES.has(me.roleName ?? ""));
  const myName = me?.name ?? null;

  const { data: gates } = useListGates({ status: "pending" });
  const { data: leads, isLoading: leadsLoading } = useListLeads();
  const { data: deals } = useListDeals();
  const { data: deliveries, isLoading: deliveriesLoading } = useListDeliveries();
  const { data: serviceOrders, isLoading: serviceLoading } = useListServiceOrders();

  /* Persona scoping: advisors only triage records assigned to them.
     Deny-by-default: a non-manager with no display name sees NOTHING
     dealership-wide, never the unfiltered dataset. */
  const nameKey = myName?.trim().toLowerCase() ?? null;
  const myId = me?.id ?? null;
  /* Match by user ID first (robust to renames and duplicate names); fall
     back to the legacy display-name match for records that predate IDs. */
  const matchesMe = (
    assigneeUserId: number | null | undefined,
    assigneeName: string | null | undefined,
  ) =>
    (myId != null && assigneeUserId === myId) ||
    (assigneeUserId == null &&
      nameKey != null &&
      (assigneeName ?? "").trim().toLowerCase() === nameKey);
  const scopedLeads = useMemo(
    () =>
      isBroadView
        ? leads
        : (leads ?? []).filter((l) => matchesMe(l.ownerUserId, l.assignedTo)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leads, isBroadView, nameKey, myId],
  );
  const scopedDeals = useMemo(
    () =>
      isBroadView
        ? deals
        : (deals ?? []).filter((d) =>
            matchesMe(d.salesAdvisorUserId, d.salesAdvisor),
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deals, isBroadView, nameKey, myId],
  );
  const scopedDeliveries = useMemo(
    () =>
      isBroadView
        ? deliveries
        : (deliveries ?? []).filter((d) =>
            matchesMe(d.advisorUserId, d.advisorName),
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deliveries, isBroadView, nameKey, myId],
  );
  const scopedServiceOrders = useMemo(
    () =>
      isBroadView
        ? serviceOrders
        : (serviceOrders ?? []).filter((s) =>
            matchesMe(s.technicianUserId, s.technician),
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serviceOrders, isBroadView, nameKey, myId],
  );
  const scopedGates = can("approvals", "view") ? gates : [];

  const { urgent, today, later, total: objectivesCount } = useMemo(
    () =>
      buildTriage(
        scopedLeads,
        scopedDeals,
        scopedGates,
        scopedDeliveries,
        scopedServiceOrders,
      ),
    [scopedLeads, scopedDeals, scopedGates, scopedDeliveries, scopedServiceOrders],
  );
  const triageItems = useMemo(
    () => [...urgent, ...today, ...later],
    [urgent, today, later],
  );

  return (
    <div className="min-h-[100dvh] pb-20">
      <div className="px-5 md:px-8 pt-8 space-y-10">
        {/* Greeting */}
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
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-foreground/[0.03] border border-border/60 rounded-full px-4 py-1.5">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                  Contact leads within 24h
                </span>
              </div>
              <Link
                href="/reports"
                className="flex items-center gap-2 bg-foreground text-background rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity"
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Reports
              </Link>
            </div>
          </div>

          {/* Triage + Today's schedule */}
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-6">
            <div className="md:col-span-2 xl:col-span-3">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">Triage Queue</h2>
                <span className="bg-foreground text-background text-[10px] font-bold px-2 py-0.5 rounded-full tabular-nums">
                  {objectivesCount}
                </span>
              </div>

              <TriageBrief items={triageItems} />
            </div>

            <div className="md:col-span-1 xl:col-span-1">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">Today's Schedule</h2>
              </div>
              <div className="relative min-h-[300px] h-[calc(100%-2rem)] rounded-2xl border border-border/60 bg-card overflow-hidden">
                <div className="absolute inset-0 overflow-y-auto p-4">
                  {/* Same persona-scoped datasets as triage — advisors only
                      ever see their own appointments here. */}
                  <TodaySchedule
                    leads={scopedLeads}
                    deliveries={scopedDeliveries}
                    serviceOrders={scopedServiceOrders}
                    isLoading={leadsLoading || deliveriesLoading || serviceLoading}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Overall call sentiment — the ONLY signal beyond triage/scheduling */}
        <CallSentimentBrief />
      </div>
    </div>
  );
}

/* Compact call-sentiment digest: positive/neutral/negative counts + notable
   negative voices. Detailed sentiment analytics live in Reports. */
function CallSentimentBrief() {
  const { data, isLoading, isError, refetch, isFetching } =
    useGetSentimentAnalysis(undefined, {
      query: {
        queryKey: getGetSentimentAnalysisQueryKey(),
        retry: 1,
        staleTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    });

  const counts = useMemo(() => {
    if (!data) return null;
    const n = data.sampleSize;
    const pos = Math.round((data.distribution.positive / 100) * n);
    const neg = Math.round((data.distribution.negative / 100) * n);
    const neu = Math.max(0, n - pos - neg);
    return { positive: pos, neutral: neu, negative: neg };
  }, [data]);

  const negatives = (data?.highlights ?? []).filter(
    (h) => h.sentiment === "negative",
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <HeartPulse className="w-3.5 h-3.5 text-muted-foreground" />
        <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">
          Call Sentiment
        </h2>
        <Link
          href="/reports"
          className="ml-auto text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          Full analytics
        </Link>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-2xl bg-foreground/5 animate-pulse" />
          ))}
        </div>
      ) : isError || !data || !counts ? (
        <div className="rounded-2xl border border-dashed border-border p-8 flex flex-col items-center text-center">
          <p className="text-sm text-muted-foreground max-w-sm">
            The sentiment engine could not analyse recent conversations.
          </p>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="mt-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-foreground/5 px-4 py-2 text-sm font-medium hover:border-foreground/20 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            Try again
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Counts */}
          <div className="grid grid-cols-3 gap-3 lg:col-span-1">
            {(
              [
                ["Positive", counts.positive, "bg-foreground"],
                ["Neutral", counts.neutral, "bg-foreground/40"],
                ["Negative", counts.negative, "bg-foreground/15"],
              ] as const
            ).map(([label, value, dot]) => (
              <div
                key={label}
                className="rounded-2xl border border-border/60 bg-card px-4 py-4 flex flex-col items-start"
              >
                <span className={cn("w-2 h-2 rounded-full mb-2", dot)} />
                <span className="text-2xl font-light tabular-nums text-foreground leading-none">
                  {value}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mt-2">
                  {label}
                </span>
              </div>
            ))}
            <p className="col-span-3 text-[10px] uppercase tracking-widest text-muted-foreground">
              {data.sampleSize} interactions · overall {data.overallLabel}
            </p>
          </div>

          {/* Notable negatives */}
          <div className="lg:col-span-2 rounded-2xl border border-border/60 bg-card p-5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-foreground mb-3">
              Notable Negatives
            </p>
            {negatives.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No negative conversations flagged. Keep it up.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {negatives.slice(0, 4).map((h: SentimentHighlight, i: number) => {
                  const body = (
                    <div className="relative pl-4 py-1 group">
                      <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-full bg-foreground/15 transition-all duration-300 group-hover:w-1" />
                      <p className="text-sm italic text-muted-foreground leading-snug">
                        "{h.snippet}"
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-foreground mt-2">
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
    </div>
  );
}
