import { useEffect, useMemo, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { buildTriage, isTodayDateOnly } from "@/lib/triage";
import {
  useListGates,
  getListGatesQueryKey,
  useListLeads,
  useListDeals,
  useListDeliveries,
  useListServiceOrders,
  getListServiceOrdersQueryKey,
  useListTasks,
  useGetCalendar,
} from "@workspace/api-client-react";
import type {
  CalendarEvent,
  CalendarEventKind,
  Task,
  Gate,
} from "@workspace/api-client-react";
import { QuoteDiscountDialog } from "@/components/quote-discount-dialog";
import {
  ArrowRight,
  Zap,
  Car,
  Truck,
  Wrench,
  BellRing,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  PhoneCall,
  CalendarClock,
  CalendarDays,
  MailQuestion,
  Landmark,
  ClipboardList,
  Building2,
} from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useAuthz } from "@/lib/auth";
import {
  activeDealerTimeZone,
  dealerDateParts,
  dealerDayKey,
  dealerDayKeyPlus,
} from "@/lib/format";
import { Pagination } from "@/components/pagination";
import type { TriageItem, TriageBucket } from "@/lib/triage";

function greeting() {
  const h = dealerDateParts().hour;
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const KIND_UI: Record<string, { icon: any; action: string; label: string }> = {
  gate: { icon: ShieldCheck, action: "Approve", label: "Approvals" },
  contact: { icon: PhoneCall, action: "Call", label: "Contacts" },
  testDrive: { icon: CalendarClock, action: "Prepare", label: "Test Drives" },
  delivery: { icon: Car, action: "Deliver", label: "Deliveries" },
  service: { icon: Zap, action: "Service", label: "Service" },
  stalled: { icon: AlertCircle, action: "Check in", label: "Follow-Ups" },
  quote: { icon: MailQuestion, action: "Follow up", label: "Follow-Ups" },
  deposit: { icon: Landmark, action: "Open", label: "Follow-Ups" },
  task: { icon: ClipboardList, action: "Open", label: "Tasks" },
};

/* Type filter chips: each maps to one or more triage kinds. */
const TYPE_FILTERS: { key: string; label: string; icon: any; kinds: string[] }[] = [
  { key: "contact", label: "Contacts", icon: PhoneCall, kinds: ["contact"] },
  { key: "gate", label: "Approvals", icon: ShieldCheck, kinds: ["gate"] },
  { key: "testDrive", label: "Test drives", icon: CalendarClock, kinds: ["testDrive"] },
  { key: "delivery", label: "Deliveries", icon: Car, kinds: ["delivery"] },
  { key: "service", label: "Service", icon: Zap, kinds: ["service"] },
  { key: "followUp", label: "Follow-ups", icon: AlertCircle, kinds: ["stalled", "quote", "deposit"] },
  { key: "task", label: "Tasks", icon: ClipboardList, kinds: ["task"] },
];

const SEVERITY_META: Record<
  TriageBucket,
  { label: string; dot: string; hint: string }
> = {
  urgent: { label: "Urgent", dot: "bg-red-500", hint: "Needs action now" },
  today: { label: "Today", dot: "bg-gold", hint: "Due before end of day" },
  later: { label: "Later", dot: "bg-foreground/30", hint: "Coming up" },
};

function getInitials(name: string) {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function TriageRow({
  item,
  onSelect,
}: {
  item: TriageItem;
  onSelect?: (item: TriageItem) => void;
}) {
  const [, navigate] = useLocation();
  const ui = KIND_UI[item.kind] || KIND_UI.stalled;
  const Icon = ui.icon;
  const isUrgent = item.bucket === "urgent";
  const isOverdue =
    item.kind === "contact" &&
    item.slaHoursLeft !== undefined &&
    item.slaHoursLeft <= 0;

  return (
    <button
      onClick={() => {
        if (onSelect) onSelect(item);
        else navigate(item.href);
      }}
      data-testid={`triage-row-${item.key}`}
      className="group w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl text-left transition-all bg-card border border-border/60 hover:border-foreground/20 hover:shadow-md hover:-translate-y-px"
    >
      <div
        className={cn(
          "w-9 h-9 rounded-full flex items-center justify-center shrink-0 font-bold text-[10px] tracking-wider",
          isOverdue
            ? "bg-red-500/15 text-red-500"
            : isUrgent
              ? "bg-gold/20 text-gold"
              : "bg-foreground/[0.06] text-foreground",
        )}
      >
        {getInitials(item.context)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm truncate text-foreground">
            {item.context}
          </span>
          {isOverdue && (
            <span className="inline-flex items-center bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider whitespace-nowrap">
              Past due
            </span>
          )}
        </div>
        <div className="text-[11px] truncate mt-0.5 text-muted-foreground">
          {item.subContext}
          {item.assignee ? ` · with ${item.assignee}` : ""}
        </div>
      </div>
      <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground shrink-0">
        <Icon className="w-3.5 h-3.5" />
        {ui.label}
      </span>
      <span
        className={cn(
          "flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest shrink-0 transition-colors",
          isOverdue ? "text-red-500" : "text-gold",
        )}
      >
        {ui.action}
        <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

/* ---------- Schedule (merged Calendar) ---------- */

const EVENT_META: Record<
  CalendarEventKind,
  { label: string; icon: typeof Car; chip: string }
> = {
  test_drive: {
    label: "Test drive",
    icon: Car,
    chip: "bg-gold/15 text-gold ring-gold/30",
  },
  delivery: {
    label: "Delivery",
    icon: Truck,
    chip: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
  },
  service: {
    label: "Service",
    icon: Wrench,
    chip: "bg-amber-500/15 text-amber-500 ring-amber-500/30",
  },
  follow_up: {
    label: "Follow-up",
    icon: BellRing,
    chip: "bg-primary/15 text-primary ring-primary/30",
  },
};

function eventDateKey(e: CalendarEvent) {
  if (e.allDay) return e.startsAt.slice(0, 10);
  return dealerDayKey(new Date(e.startsAt));
}

function eventTime(e: CalendarEvent) {
  if (e.allDay) return "All day";
  return new Date(e.startsAt).toLocaleTimeString([], {
    timeZone: activeDealerTimeZone(),
    hour: "numeric",
    minute: "2-digit",
  });
}

function ScheduleEvent({ e }: { e: CalendarEvent }) {
  const meta = EVENT_META[e.kind];
  const Icon = meta.icon;
  const body = (
    <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-card p-3 hover:border-foreground/20 transition-colors">
      <span
        className={cn(
          "mt-0.5 w-7 h-7 rounded-full ring-1 flex items-center justify-center shrink-0",
          meta.chip,
        )}
      >
        <Icon className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium leading-tight truncate text-foreground">
          {e.title}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {eventTime(e)} · {meta.label}
          {e.assigneeName ? ` · ${e.assigneeName}` : ""}
        </div>
        {e.detail && (
          <div className="text-xs text-muted-foreground/80 mt-0.5 truncate">
            {e.detail}
          </div>
        )}
      </div>
    </div>
  );
  return e.link ? <Link href={e.link}>{body}</Link> : body;
}

function Schedule() {
  const [range, setRange] = useState<"day" | "week">("day");
  const params = { from: dealerDayKey(), to: dealerDayKeyPlus(6) };
  const { data, isLoading } = useGetCalendar(params);

  const todayKey = dealerDayKey();
  const events = useMemo(() => {
    const all = [...(data?.events ?? [])].sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    );
    return range === "day"
      ? all.filter((e) => eventDateKey(e) === todayKey)
      : all;
  }, [data, range, todayKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const key = eventDateKey(e);
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  return (
    <div className="rounded-3xl border border-border/60 bg-card/60 p-4">
      <div className="flex items-center gap-2 mb-4">
        <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" />
        <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">
          Schedule
        </h2>
        <div className="ml-auto flex items-center rounded-full border border-border/60 bg-foreground/[0.03] p-0.5">
          {(["day", "week"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest transition-colors",
                range === r
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r === "day" ? "Today" : "Week"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-foreground/5 animate-pulse" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="py-10 flex flex-col items-center text-center text-muted-foreground">
          <CalendarClock className="w-7 h-7 mb-3 opacity-25" />
          <p className="text-sm font-medium">
            {range === "day" ? "Nothing scheduled today" : "Nothing scheduled this week"}
          </p>
          <p className="text-xs mt-1 opacity-70">
            Test drives, deliveries, service and follow-ups appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {byDay.map(([day, dayEvents]) => (
            <div key={day}>
              {range === "week" && (
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2">
                  {day === todayKey
                    ? "Today"
                    : new Date(`${day}T12:00:00`).toLocaleDateString([], {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                      })}
                </div>
              )}
              <ul className="space-y-2">
                {dayEvents.map((e) => (
                  <li key={e.id}>
                    <ScheduleEvent e={e} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Personal tasks -> triage items ---------- */

function taskToTriage(t: Task): TriageItem {
  const today = dealerDayKey();
  const overdue = !!t.dueDate && t.dueDate.slice(0, 10) < today;
  const dueToday = !!t.dueDate && isTodayDateOnly(t.dueDate);
  const urgent = overdue || t.priority === "urgent" || t.priority === "high";
  const bucket: TriageBucket = urgent ? "urgent" : dueToday ? "today" : "later";
  return {
    kind: "task",
    bucket,
    id: t.id.toString(),
    key: `task-${t.id}`,
    context: t.title,
    subContext: overdue
      ? "Task overdue"
      : dueToday
        ? "Task due today"
        : t.dueDate
          ? `Due ${t.dueDate.slice(0, 10)}`
          : "Open task",
    href: t.leadId
      ? `/lead/${t.leadId}`
      : t.title.startsWith("Approve rollover ·") || t.title.startsWith("Approve discount ·")
        ? "/service"
        : "/command-center",
    rank: overdue ? 1 : 4,
  };
}

/* Roles that see the dealership-wide queue. Everyone else (advisors,
   technicians, coordinators) gets a personal My Day scoped to their own
   assignments. */
const BROAD_VIEW_ROLES = new Set([
  "General Manager",
  "Sales Manager",
  "Service Manager",
  "Finance Manager",
]);

/* My Day: the single home — the merged daily briefing + calendar. An
   immediate-task list filterable by severity and type, next to the schedule. */
export default function Dashboard() {
  // Technicians live on the workshop floor — their day starts in
  // Service › My Jobs, not the sales briefing. Kept as a wrapper so the
  // inner component's hooks run unconditionally.
  const { me } = useAuthz();
  const isTechnician = (me?.roleName ?? "").toLowerCase().includes("tech");
  if (isTechnician) return <Redirect to="/service" />;
  return <DashboardInner />;
}

function DashboardInner() {
  const { me, can, activeDealer } = useAuthz();
  const isBroadView =
    !!me && (me.isSuperAdmin || BROAD_VIEW_ROLES.has(me.roleName ?? ""));
  const myName = me?.name ?? null;

  const [severityFilter, setSeverityFilter] = useState<TriageBucket | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selectedGate, setSelectedGate] = useState<Gate | null>(null);
  const [, navigate] = useLocation();

  const handleSelectTriage = (item: TriageItem) => {
    if (item.kind === "gate" && item.gateType === "quote_discount") {
      const gate = (gates ?? []).find(
        (candidate) => candidate.id === Number(item.id),
      );
      if (gate) {
        setSelectedGate(gate);
        return;
      }
      navigate("/deals");
    } else {
      navigate(item.href);
    }
  };

  // Permission-gated fetches: roles without approvals/service access skip
  // these queries entirely instead of hammering 403s.
  const { data: gates } = useListGates(
    { status: "pending" },
    {
      query: {
        queryKey: getListGatesQueryKey({ status: "pending" }),
        enabled: can("approvals", "view"),
      },
    },
  );
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();
  const { data: deliveries } = useListDeliveries();
  const { data: serviceOrders } = useListServiceOrders(undefined, {
    query: {
      queryKey: getListServiceOrdersQueryKey(),
      enabled: can("service", "view"),
    },
  });
  const { data: tasks } = useListTasks();

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
  /* Personal tasks are always own-only, for every role. */
  const myTasks = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) => t.status !== "done" && (myId == null || t.assigneeUserId === myId),
      ),
    [tasks, myId],
  );

  const { urgent, today, later } = useMemo(() => {
    const base = buildTriage(
      scopedLeads,
      scopedDeals,
      scopedGates,
      scopedDeliveries,
      scopedServiceOrders,
    );
    for (const t of myTasks) {
      const item = taskToTriage(t);
      base[item.bucket].push(item);
      base[item.bucket].sort((a, b) => a.rank - b.rank);
    }
    return base;
  }, [scopedLeads, scopedDeals, scopedGates, scopedDeliveries, scopedServiceOrders, myTasks]);

  const counts = { urgent: urgent.length, today: today.length, later: later.length };
  const allItems = useMemo(
    () => [...urgent, ...today, ...later],
    [urgent, today, later],
  );

  const activeKinds =
    TYPE_FILTERS.find((t) => t.key === typeFilter)?.kinds ?? null;
  const filtered = allItems.filter(
    (i) =>
      (!severityFilter || i.bucket === severityFilter) &&
      (!activeKinds || activeKinds.includes(i.kind)),
  );

  /* Which types actually have items — chips for empty types are hidden. */
  const presentTypes = TYPE_FILTERS.filter((t) =>
    allItems.some((i) => t.kinds.includes(i.kind)),
  );

  /* Paginate the triage queue: the flat filtered list is already ordered
     urgent → today → later, so we slice it and rebuild the visible
     sections from the current page only. */
  const TRIAGE_PAGE_SIZE = 15;
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [severityFilter, typeFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / TRIAGE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pagedItems = filtered.slice(
    (safePage - 1) * TRIAGE_PAGE_SIZE,
    safePage * TRIAGE_PAGE_SIZE,
  );

  const sections: {
    bucket: TriageBucket;
    items: TriageItem[];
    total: number;
  }[] = (["urgent", "today", "later"] as const)
    .map((b) => ({
      bucket: b,
      items: pagedItems.filter((i) => i.bucket === b),
      total: filtered.filter((i) => i.bucket === b).length,
    }))
    .filter((s) => s.items.length > 0);

  const firstName = (myName ?? "").trim().split(" ")[0] || null;
  const dateLabel = new Date().toLocaleDateString([], {
    timeZone: activeDealerTimeZone(),
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="min-h-[100dvh] pb-20">
      <QuoteDiscountDialog
        gate={selectedGate}
        open={!!selectedGate}
        onClose={() => setSelectedGate(null)}
      />
      <div className="px-5 md:px-8 pt-2 space-y-8">
        {/* Greeting header: personal, stateful, dealership identity */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary/70 mb-1.5">
              <Building2 className="w-3.5 h-3.5" />
              {activeDealer?.dealerName ?? "My Day"}
              <span className="text-muted-foreground/60 normal-case tracking-normal font-medium">
                · {dateLabel}
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-light tracking-tight text-foreground">
              {greeting()}
              {firstName ? (
                <span className="font-medium">, {firstName}.</span>
              ) : (
                "."
              )}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground font-light">
              {counts.urgent > 0
                ? `${counts.urgent} urgent ${counts.urgent === 1 ? "item" : "items"} and ${counts.today} due today.`
                : counts.today > 0
                  ? `Nothing urgent — ${counts.today} ${counts.today === 1 ? "item" : "items"} due today.`
                  : "You're all clear. Enjoy the calm."}
            </p>
          </div>

          {/* Today at a glance */}
          <div className="flex items-center gap-3">
            {(["urgent", "today", "later"] as const).map((b) => (
              <button
                key={b}
                onClick={() =>
                  setSeverityFilter((cur) => (cur === b ? null : b))
                }
                className={cn(
                  "flex flex-col items-start rounded-2xl border px-4 py-2.5 min-w-[92px] transition-colors text-left",
                  severityFilter === b
                    ? "border-foreground/40 bg-foreground/[0.05]"
                    : "border-border/60 bg-card hover:border-foreground/20",
                )}
              >
                <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                  <span className={cn("w-1.5 h-1.5 rounded-full", SEVERITY_META[b].dot)} />
                  {SEVERITY_META[b].label}
                </span>
                <span className="text-xl font-light tabular-nums text-foreground leading-tight mt-0.5">
                  {counts[b]}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          {/* Immediate tasks */}
          <div className="lg:col-span-2 space-y-4">
            {/* Type filter chips */}
            {presentTypes.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setTypeFilter(null)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-[11px] font-semibold ring-1 transition-colors",
                    typeFilter === null
                      ? "bg-foreground text-background ring-foreground"
                      : "bg-foreground/[0.03] text-muted-foreground ring-border hover:bg-foreground/[0.08]",
                  )}
                >
                  All
                </button>
                {presentTypes.map((t) => {
                  const Icon = t.icon;
                  const active = typeFilter === t.key;
                  const n = allItems.filter((i) => t.kinds.includes(i.kind)).length;
                  return (
                    <button
                      key={t.key}
                      onClick={() => setTypeFilter(active ? null : t.key)}
                      className={cn(
                        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold ring-1 transition-colors",
                        active
                          ? "bg-foreground text-background ring-foreground"
                          : "bg-foreground/[0.03] text-muted-foreground ring-border hover:bg-foreground/[0.08]",
                      )}
                    >
                      <Icon className="w-3 h-3" />
                      {t.label}
                      <span className="tabular-nums opacity-70">{n}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {sections.length === 0 ? (
              <div className="py-14 rounded-3xl border border-dashed border-border flex flex-col items-center justify-center text-muted-foreground">
                <CheckCircle2 className="w-8 h-8 mb-3 opacity-20" />
                <p className="text-sm font-medium">All caught up</p>
                <p className="text-xs mt-1 opacity-70">
                  Nothing matches these filters right now.
                </p>
              </div>
            ) : (
              sections.map((s, si) => (
                <motion.div
                  key={s.bucket}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: si * 0.06 }}
                >
                  <div className="flex items-center gap-2 mb-2 mt-1">
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        SEVERITY_META[s.bucket].dot,
                      )}
                    />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-foreground">
                      {SEVERITY_META[s.bucket].label}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {SEVERITY_META[s.bucket].hint}
                    </span>
                    <span className="ml-auto bg-foreground/10 text-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums">
                      {s.total}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {s.items.map((item) => (
                      <TriageRow
                        key={item.key}
                        item={item}
                        onSelect={handleSelectTriage}
                      />
                    ))}
                  </div>
                </motion.div>
              ))
            )}

            {filtered.length > TRIAGE_PAGE_SIZE && (
              <div className="space-y-1">
                <Pagination
                  page={safePage}
                  pageCount={pageCount}
                  onPageChange={setPage}
                />
                <p className="text-center text-xs text-muted-foreground tabular-nums">
                  {(safePage - 1) * TRIAGE_PAGE_SIZE + 1}–
                  {Math.min(safePage * TRIAGE_PAGE_SIZE, filtered.length)} of{" "}
                  {filtered.length} items
                </p>
              </div>
            )}
          </div>

          {/* Schedule column */}
          <div className="lg:col-span-1">
            <Schedule />
          </div>
        </div>
      </div>
    </div>
  );
}
