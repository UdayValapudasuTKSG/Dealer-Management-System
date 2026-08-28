import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { Lead, Vehicle } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  CalendarDays,
  Car,
  Clock,
  Gauge,
  MapPin,
  UserRound,
} from "lucide-react";
import {
  activeDealerTimeZone,
  dealerDayKey,
  dealerDayKeyPlus,
} from "@/lib/format";

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  assigned: "Assigned",
  contacted: "Contacted",
  qualified: "Qualified",
  test_drive: "Test Drive",
  back_order: "Back Order",
  decision: "Decision",
  engaged: "Engaged",
  converted: "Converted",
  lost: "Lost",
};

const withBase = (url: string) =>
  `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

function dayLabel(day: string) {
  if (day === dealerDayKey()) return "Today";
  if (day === dealerDayKeyPlus(1)) return "Tomorrow";
  const [year, month, date] = day.split("-").map(Number);
  const d = new Date(year!, month! - 1, date);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function countdown(to: Date) {
  const ms = to.getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60 ? `${mins % 60}m` : ""}`.trim();
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    timeZone: activeDealerTimeZone(),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TestDriveBoard({
  drives,
  vehicles,
}: {
  drives: Lead[];
  vehicles: Vehicle[];
}) {
  const [, navigate] = useLocation();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  const { next, upcoming, upcomingByDay, past, todayCount, weekCount } =
    useMemo(() => {
      void tick;
      const now = Date.now();
      const weekEnd = now + 7 * 86400000;
      const upcoming = drives.filter(
        (l) => new Date(l.testDriveAt!).getTime() >= now,
      );
      const past = drives
        .filter((l) => new Date(l.testDriveAt!).getTime() < now)
        .reverse();
      const next = upcoming[0] ?? null;
      const rest = upcoming.slice(1);
      const map = new Map<string, Lead[]>();
      for (const l of rest) {
        const key = dealerDayKey(new Date(l.testDriveAt!));
        map.set(key, [...(map.get(key) ?? []), l]);
      }
      return {
        next,
        upcoming,
        upcomingByDay: [...map.entries()],
        past,
        todayCount: upcoming.filter(
          (l) => dealerDayKey(new Date(l.testDriveAt!)) === dealerDayKey(),
        ).length,
        weekCount: upcoming.filter(
          (l) => new Date(l.testDriveAt!).getTime() <= weekEnd,
        ).length,
      };
    }, [drives, tick]);

  const vehicleOf = (l: Lead) =>
    vehicles.find((v) => v.id === l.interestedVehicleId);

  if (drives.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center gap-4 py-24 rounded-3xl border border-white/10 bg-foreground/[0.02]"
      >
        <div className="w-16 h-16 rounded-2xl bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center">
          <Car className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center">
          <div className="font-semibold text-lg">No test drives on the books</div>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Every new lead is emailed a self-service booking link — confirmed
            drives land here automatically.
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-10"
    >
      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3 md:gap-4">
        {[
          { label: "Today", value: todayCount, icon: Gauge },
          { label: "Next 7 days", value: weekCount, icon: CalendarDays },
          { label: "Scheduled", value: upcoming.length, icon: Clock },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-white/10 bg-foreground/[0.03] px-4 py-3.5 md:px-5 flex items-center gap-3.5"
          >
            <div className="w-9 h-9 rounded-xl bg-primary/10 ring-1 ring-primary/15 hidden sm:flex items-center justify-center shrink-0">
              <s.icon className="w-4.5 h-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-2xl md:text-3xl font-light tabular-nums leading-none">
                {s.value}
              </div>
              <div className="text-[10px] md:text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mt-1.5 truncate">
                {s.label}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Next-up spotlight */}
      {next && (
        <button
          onClick={() => navigate(`/lead/${next.id}`)}
          className="group relative w-full text-left rounded-3xl border border-primary/25 bg-foreground/[0.03] hover:border-primary/50 overflow-hidden transition-all duration-300 shadow-[0_24px_64px_-32px_hsl(var(--primary)/0.35)]"
        >
          <div className="grid md:grid-cols-[1.15fr_1fr]">
            <div className="p-6 md:p-8 flex flex-col justify-between gap-6 relative z-10">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
                    Next up · {countdown(new Date(next.testDriveAt!))}
                  </span>
                </div>
                <div className="mt-4 flex items-baseline gap-3 flex-wrap">
                  <span className="text-4xl md:text-5xl font-light tracking-tight tabular-nums">
                    {timeOf(next.testDriveAt!)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {dayLabel(dealerDayKey(new Date(next.testDriveAt!)))}
                  </span>
                </div>
                <div className="mt-3 text-xl font-semibold group-hover:text-primary transition-colors">
                  {next.name}
                </div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  {(() => {
                    const v = vehicleOf(next);
                    return v
                      ? `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}`
                      : "Vehicle to be confirmed";
                  })()}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {next.testDriveBranch && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-foreground/[0.05] border border-white/10 px-3 py-1.5 rounded-full">
                    <MapPin className="w-3.5 h-3.5 text-primary" />
                    {next.testDriveBranch}
                  </span>
                )}
                {next.assignedTo && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-foreground/[0.05] border border-white/10 px-3 py-1.5 rounded-full">
                    <UserRound className="w-3.5 h-3.5 text-primary" />
                    {next.assignedTo}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary bg-primary/10 px-2.5 py-1 rounded-full">
                  {STATUS_LABEL[next.status] ?? next.status}
                </span>
              </div>
            </div>
            <div className="relative h-52 md:h-auto min-h-52 overflow-hidden">
              {(() => {
                const v = vehicleOf(next);
                return v?.imageUrl ? (
                  <img
                    src={withBase(v.imageUrl)}
                    alt={`${v.make} ${v.model}`}
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-foreground/[0.04]">
                    <Car className="w-12 h-12 text-muted-foreground/25" />
                  </div>
                );
              })()}
              <div className="absolute inset-0 bg-gradient-to-r from-background/70 via-background/10 to-transparent hidden md:block" />
              <div className="absolute inset-0 bg-gradient-to-t from-background/60 to-transparent md:hidden" />
              <div className="absolute bottom-4 right-4 w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300">
                <ArrowUpRight className="w-4.5 h-4.5" />
              </div>
            </div>
          </div>
        </button>
      )}

      {/* Upcoming timeline */}
      {upcomingByDay.length > 0 && (
        <div className="space-y-8">
          {upcomingByDay.map(([day, dayLeads]) => (
            <div key={day} className="relative md:pl-8">
              <div className="hidden md:block absolute left-[5px] top-2 bottom-0 w-px bg-gradient-to-b from-primary/40 via-foreground/10 to-transparent" />
              <div className="hidden md:block absolute left-0 top-[5px] w-[11px] h-[11px] rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.6)]" />
              <div className="flex items-baseline gap-3 mb-4">
                <h2 className="text-lg font-semibold tracking-tight">
                  {dayLabel(day)}
                </h2>
                <span className="text-[11px] font-semibold text-primary uppercase tracking-widest">
                  {dayLeads.length} drive{dayLeads.length === 1 ? "" : "s"}
                </span>
                <span className="flex-1 h-px bg-white/10 self-center" />
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {dayLeads.map((lead, i) => {
                  const v = vehicleOf(lead);
                  return (
                    <motion.button
                      key={lead.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                      onClick={() => navigate(`/lead/${lead.id}`)}
                      className="group flex items-stretch gap-4 text-left rounded-2xl border border-white/10 bg-foreground/[0.03] hover:bg-foreground/[0.06] hover:border-primary/30 hover:-translate-y-0.5 transition-all duration-300 p-3 pr-4"
                    >
                      <div className="w-32 h-[5.5rem] rounded-xl overflow-hidden shrink-0 bg-foreground/[0.05]">
                        {v?.imageUrl ? (
                          <img
                            src={withBase(v.imageUrl)}
                            alt={`${v.make} ${v.model}`}
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Car className="w-6 h-6 text-muted-foreground/30" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 py-0.5 flex flex-col justify-between">
                        <div>
                          <div className="font-semibold truncate group-hover:text-primary transition-colors">
                            {lead.name}
                          </div>
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            {v
                              ? `${v.year} ${v.make} ${v.model}`
                              : "Vehicle to be confirmed"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {lead.testDriveBranch && (
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                              <MapPin className="w-3 h-3 text-primary/70" />
                              {lead.testDriveBranch}
                            </span>
                          )}
                          {lead.assignedTo && (
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground truncate">
                              <UserRound className="w-3 h-3 text-primary/70" />
                              {lead.assignedTo}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end justify-between py-0.5 shrink-0">
                        <span className="text-lg font-light text-primary tabular-nums">
                          {timeOf(lead.testDriveAt!)}
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full">
                          {STATUS_LABEL[lead.status] ?? lead.status}
                        </span>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Past drives */}
      {past.length > 0 && (
        <div>
          <div className="flex items-baseline gap-3 mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Completed
            </h2>
            <span className="text-[11px] text-muted-foreground/70">
              {past.length} drive{past.length === 1 ? "" : "s"}
            </span>
            <span className="flex-1 h-px bg-white/10 self-center" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {past.map((lead) => {
              const v = vehicleOf(lead);
              const d = new Date(lead.testDriveAt!);
              return (
                <button
                  key={lead.id}
                  onClick={() => navigate(`/lead/${lead.id}`)}
                  className="group flex items-center gap-3 text-left rounded-xl border border-white/10 bg-foreground/[0.02] hover:bg-foreground/[0.05] hover:border-primary/25 transition-all duration-300 px-3.5 py-2.5 opacity-70 hover:opacity-100"
                >
                  <div className="w-9 h-9 rounded-lg bg-foreground/[0.05] flex items-center justify-center shrink-0 overflow-hidden">
                    {v?.imageUrl ? (
                      <img
                        src={withBase(v.imageUrl)}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Car className="w-4 h-4 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                      {lead.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {d.toLocaleDateString(undefined, {
                        timeZone: activeDealerTimeZone(),
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      · {timeOf(lead.testDriveAt!)}
                      {v ? ` · ${v.make} ${v.model}` : ""}
                    </div>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </motion.div>
  );
}
