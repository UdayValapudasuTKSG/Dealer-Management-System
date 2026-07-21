import { useMemo } from "react";
import { Link } from "wouter";
import { useListVehicles } from "@workspace/api-client-react";
import type { Lead, Delivery, ServiceOrder } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarClock, Car, PenTool, Truck } from "lucide-react";
import { format, isToday, parseISO, startOfDay, addDays } from "date-fns";
import { cn } from "@/lib/utils";

/* The schedule does NOT fetch its own data: the parent (Daily Briefing) passes
   in datasets that are already persona-scoped (advisors only see their own
   assignments), so this component can never leak dealership-wide appointments
   to non-manager roles. */
export function TodaySchedule({
  leads,
  deliveries,
  serviceOrders,
  isLoading,
}: {
  leads: Lead[] | undefined;
  deliveries: Delivery[] | undefined;
  serviceOrders: ServiceOrder[] | undefined;
  isLoading: boolean;
}) {
  const { data: vehicles } = useListVehicles();

  const schedule = useMemo(() => {
    const items: Array<{
      id: string;
      time: Date;
      title: string;
      subtitle: string;
      role: string;
      roleLabel: string;
      icon: any;
      href: string;
      image: string | null;
    }> = [];

    const vehicleById = new Map(
      (vehicles ?? []).map((v) => [v.id, v] as const),
    );
    const imageFor = (vehicleId: number | null | undefined): string | null => {
      if (!vehicleId) return null;
      const v = vehicleById.get(vehicleId);
      return v?.imageUrl ?? v?.images?.[0] ?? null;
    };
    const imageByLabel = (label: string | null | undefined): string | null => {
      if (!label) return null;
      const lower = label.toLowerCase();
      const v = (vehicles ?? []).find(
        (veh) =>
          lower.includes(veh.model.toLowerCase()) ||
          (veh.make && lower.includes(veh.make.toLowerCase()) && lower.includes(veh.model.toLowerCase().slice(0, 4))),
      );
      return v?.imageUrl ?? v?.images?.[0] ?? null;
    };
    // Every schedule row shows a car image; fall back to a house asset when
    // the record has no resolvable vehicle.
    const FALLBACK_IMAGE = "/vehicles/aura_bmw_i4.png";
    const withFallback = (url: string | null) => url ?? FALLBACK_IMAGE;

    const windowStart = startOfDay(new Date());
    const windowEnd = addDays(windowStart, 7);
    const inWindow = (d: Date) => d >= windowStart && d < windowEnd;

    // Leads -> Test drives
    for (const l of leads ?? []) {
      if (l.testDriveAt && inWindow(parseISO(l.testDriveAt))) {
        items.push({
          id: `td-${l.id}`,
          time: parseISO(l.testDriveAt),
          title: l.name,
          subtitle: "Test Drive",
          role: "sales",
          roleLabel: "Sales Advisor",
          icon: Car,
          href: `/lead/${l.id}`,
          image: withFallback(imageFor(l.interestedVehicleId)),
        });
      }
    }

    // Deliveries
    for (const d of deliveries ?? []) {
      const appointment = (d as any).appointmentAt;
      if (appointment && inWindow(parseISO(appointment))) {
        items.push({
          id: `del-${d.id}`,
          time: parseISO(appointment),
          title: d.customerName || `Deal #${d.dealId}`,
          subtitle: d.vehicleLabel || "Vehicle Handover",
          role: "delivery",
          roleLabel: "Delivery Advisor",
          icon: Truck,
          href: `/deliveries`,
          image: withFallback(imageFor(d.vehicleId)),
        });
      }
    }

    // Service Orders
    for (const s of serviceOrders ?? []) {
      // scheduledDate is date-only; parse the date part as a LOCAL date so a
      // "today" service order isn't shifted to yesterday in UTC-4.
      const localDay = s.scheduledDate
        ? parseISO(s.scheduledDate.slice(0, 10))
        : null;
      if (localDay && inWindow(localDay)) {
        items.push({
          id: `so-${s.id}`,
          time: localDay,
          title: s.customerName || `RO #${s.id}`,
          subtitle: s.vehicleInfo || s.type,
          role: "service",
          roleLabel: "Service Advisor",
          icon: PenTool,
          href: `/service`,
          image: withFallback(imageByLabel(s.vehicleInfo)),
        });
      }
    }

    return items.sort((a, b) => a.time.getTime() - b.time.getTime());
  }, [leads, deliveries, serviceOrders, vehicles]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 rounded-xl bg-foreground/[0.03] animate-pulse" />
        ))}
      </div>
    );
  }

  if (schedule.length === 0) {
    return (
      <div className="rounded-2xl border border-border/50 bg-foreground/[0.02] p-8 text-center flex flex-col items-center">
        <CalendarClock className="w-8 h-8 text-muted-foreground/40 mb-3" />
        <p className="font-medium text-foreground">No upcoming appointments</p>
        <p className="text-sm text-muted-foreground mt-1">
          Nothing scheduled for the next 7 days.
        </p>
      </div>
    );
  }

  const todayItems = schedule.filter((i) => isToday(i.time));
  const shown = todayItems.length > 0 ? todayItems : schedule.slice(0, 8);
  const showingUpcoming = todayItems.length === 0;

  const imgSrc = (url: string | null) =>
    url
      ? url.startsWith("http")
        ? url
        : `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`
      : null;

  return (
    <div>
      {showingUpcoming && (
        <p className="text-xs text-muted-foreground mb-3">
          Nothing left today — here's what's coming up.
        </p>
      )}
      <div className="relative border-l-2 border-border/50 ml-4 space-y-6 py-2">
      {shown.map((item) => (
        <div key={item.id} className="relative pl-6">
          <div className="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-background border-2 border-primary" />
          <div className="text-xs font-semibold tracking-wider text-primary mb-2 uppercase">
            {item.time.getHours() === 0 && item.time.getMinutes() === 0
              ? showingUpcoming
                ? format(item.time, "EEE") + " · All day"
                : "All day"
              : showingUpcoming
                ? format(item.time, "EEE, h:mm a")
                : format(item.time, "h:mm a")}
          </div>
          <Link href={item.href}>
            <Card className="glass-panel border-none shadow-sm hover:shadow-md transition-all group cursor-pointer overflow-hidden">
              <CardContent className="p-3.5 flex items-center gap-3">
                <div className="w-12 h-9 rounded-lg overflow-hidden bg-foreground/[0.04] shrink-0">
                  <img
                    src={imgSrc(item.image)!}
                    alt={item.subtitle}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                    {item.title}
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {item.subtitle}
                  </div>
                </div>
                <div className="hidden sm:block shrink-0 pl-2 border-l border-border/50">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                    {item.roleLabel}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      ))}
      </div>
    </div>
  );
}
