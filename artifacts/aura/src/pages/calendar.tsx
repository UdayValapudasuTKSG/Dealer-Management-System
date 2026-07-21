import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useGetCalendar } from "@workspace/api-client-react";
import type { CalendarEvent, CalendarEventKind } from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { cn } from "@/lib/utils";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Car,
  Truck,
  Wrench,
  BellRing,
  Loader2,
} from "lucide-react";

const KIND_META: Record<
  CalendarEventKind,
  { label: string; icon: typeof Car; dot: string; chip: string }
> = {
  test_drive: {
    label: "Test drives",
    icon: Car,
    dot: "bg-sky-500",
    chip: "bg-sky-500/15 text-sky-500 ring-sky-500/30",
  },
  delivery: {
    label: "Deliveries",
    icon: Truck,
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
  },
  service: {
    label: "Service",
    icon: Wrench,
    dot: "bg-amber-500",
    chip: "bg-amber-500/15 text-amber-500 ring-amber-500/30",
  },
  follow_up: {
    label: "Follow-ups",
    icon: BellRing,
    dot: "bg-primary",
    chip: "bg-primary/15 text-primary ring-primary/30",
  },
};

const KIND_ORDER: CalendarEventKind[] = [
  "test_drive",
  "delivery",
  "service",
  "follow_up",
];

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local calendar-date key of an event (date-only events keep their UTC date). */
function eventDateKey(e: CalendarEvent) {
  if (e.allDay) return e.startsAt.slice(0, 10);
  return ymd(new Date(e.startsAt));
}

function eventTime(e: CalendarEvent) {
  if (e.allDay) return "All day";
  return new Date(e.startsAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CalendarPage() {
  const today = new Date();
  const [cursor, setCursor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const [kindFilter, setKindFilter] = useState<CalendarEventKind | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>(ymd(today));

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const params = { from: ymd(gridStart), to: ymd(gridEnd) };
  const { data, isLoading } = useGetCalendar(params);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of data?.events ?? []) {
      if (kindFilter && e.kind !== kindFilter) continue;
      const key = eventDateKey(e);
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }
    return map;
  }, [data, kindFilter]);

  const days = useMemo(() => {
    const out: Date[] = [];
    const d = new Date(gridStart);
    while (d <= gridEnd) {
      out.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [params.from, params.to]);

  const monthLabel = cursor.toLocaleDateString([], {
    month: "long",
    year: "numeric",
  });
  const todayKey = ymd(today);
  const selectedEvents = byDay.get(selectedDay) ?? [];

  return (
    <Page className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-primary" /> Calendar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Test drives, deliveries, service appointments and follow-ups
            {data?.scope === "own" ? " — showing your schedule" : ""}.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() =>
              setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))
            }
            className="w-8 h-8 rounded-full bg-foreground/[0.05] hover:bg-foreground/[0.1] flex items-center justify-center transition-colors"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold min-w-[130px] text-center">
            {monthLabel}
          </span>
          <button
            onClick={() =>
              setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))
            }
            className="w-8 h-8 rounded-full bg-foreground/[0.05] hover:bg-foreground/[0.1] flex items-center justify-center transition-colors"
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
              setSelectedDay(todayKey);
            }}
            className="text-xs font-semibold px-3 py-1.5 rounded-full bg-foreground/[0.05] hover:bg-foreground/[0.1] transition-colors"
          >
            Today
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {KIND_ORDER.map((k) => {
          const meta = KIND_META[k];
          const active = kindFilter === k;
          return (
            <button
              key={k}
              onClick={() => setKindFilter(active ? null : k)}
              className={cn(
                "inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-full ring-1 transition-colors",
                active
                  ? meta.chip
                  : "bg-foreground/[0.03] text-muted-foreground ring-white/10 hover:bg-foreground/[0.08]",
              )}
            >
              <span className={cn("w-2 h-2 rounded-full", meta.dot)} />
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5 items-start">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="grid grid-cols-7 border-b border-white/10 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="px-2 py-2 text-center">
                {d}
              </div>
            ))}
          </div>
          {isLoading ? (
            <div className="flex justify-center py-24">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const key = ymd(d);
                const inMonth = d.getMonth() === cursor.getMonth();
                const events = byDay.get(key) ?? [];
                const isToday = key === todayKey;
                const isSelected = key === selectedDay;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedDay(key)}
                    className={cn(
                      "min-h-[86px] p-1.5 border-b border-r border-white/[0.05] text-left align-top transition-colors hover:bg-foreground/[0.03]",
                      !inMonth && "opacity-40",
                      isSelected && "bg-primary/[0.06] ring-1 ring-inset ring-primary/40",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold",
                        isToday
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {d.getDate()}
                    </span>
                    <div className="mt-1 space-y-0.5">
                      {events.slice(0, 3).map((e) => (
                        <div
                          key={e.id}
                          className="flex items-center gap-1 text-[10px] leading-tight truncate"
                        >
                          <span
                            className={cn(
                              "w-1.5 h-1.5 rounded-full shrink-0",
                              KIND_META[e.kind].dot,
                            )}
                          />
                          <span className="truncate">{e.title}</span>
                        </div>
                      ))}
                      {events.length > 3 && (
                        <div className="text-[10px] text-muted-foreground">
                          +{events.length - 3} more
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {new Date(`${selectedDay}T12:00:00`).toLocaleDateString([], {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </div>
          {selectedEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nothing scheduled for this day.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {selectedEvents.map((e) => {
                const meta = KIND_META[e.kind];
                const Icon = meta.icon;
                const body = (
                  <div className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-foreground/[0.03] p-3 hover:bg-foreground/[0.06] transition-colors">
                    <span
                      className={cn(
                        "mt-0.5 w-7 h-7 rounded-full ring-1 flex items-center justify-center shrink-0",
                        meta.chip,
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium leading-tight truncate">
                        {e.title}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {eventTime(e)}
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
                return (
                  <li key={e.id}>
                    {e.link ? <Link href={e.link}>{body}</Link> : body}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Page>
  );
}
