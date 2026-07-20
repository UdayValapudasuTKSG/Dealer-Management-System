import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListLeads,
  useListDeliveries,
  useListServiceOrders,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarClock, Car, PenTool, Truck } from "lucide-react";
import { format, isToday, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

export function TodaySchedule() {
  const { data: leads, isLoading: leadsLoading } = useListLeads();
  const { data: deliveries, isLoading: deliveriesLoading } = useListDeliveries();
  const { data: serviceOrders, isLoading: serviceLoading } = useListServiceOrders();

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
    }> = [];

    // Leads -> Test drives
    for (const l of leads ?? []) {
      if (l.testDriveAt && isToday(parseISO(l.testDriveAt))) {
        items.push({
          id: `td-${l.id}`,
          time: parseISO(l.testDriveAt),
          title: l.name,
          subtitle: "Test Drive",
          role: "sales",
          roleLabel: "Sales Advisor",
          icon: Car,
          href: `/lead/${l.id}`,
        });
      }
    }

    // Deliveries
    for (const d of deliveries ?? []) {
      const appointment = (d as any).appointmentAt;
      if (appointment && isToday(parseISO(appointment))) {
        items.push({
          id: `del-${d.id}`,
          time: parseISO(appointment),
          title: d.customerName || `Deal #${d.dealId}`,
          subtitle: d.vehicleLabel || "Vehicle Handover",
          role: "delivery",
          roleLabel: "Delivery Advisor",
          icon: Truck,
          href: `/deliveries`,
        });
      }
    }

    // Service Orders
    for (const s of serviceOrders ?? []) {
      if (s.scheduledDate && isToday(parseISO(s.scheduledDate))) {
        items.push({
          id: `so-${s.id}`,
          time: parseISO(s.scheduledDate),
          title: s.customerName || `RO #${s.id}`,
          subtitle: s.vehicleInfo || s.type,
          role: "service",
          roleLabel: "Service Advisor",
          icon: PenTool,
          href: `/service`,
        });
      }
    }

    return items.sort((a, b) => a.time.getTime() - b.time.getTime());
  }, [leads, deliveries, serviceOrders]);

  if (leadsLoading || deliveriesLoading || serviceLoading) {
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
        <p className="font-medium text-foreground">No appointments today</p>
        <p className="text-sm text-muted-foreground mt-1">Your schedule is clear.</p>
      </div>
    );
  }

  return (
    <div className="relative border-l-2 border-border/50 ml-4 space-y-6 py-2">
      {schedule.map((item) => (
        <div key={item.id} className="relative pl-6">
          <div className="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full bg-background border-2 border-primary" />
          <div className="text-xs font-semibold tracking-wider text-primary mb-2 uppercase">
            {format(item.time, "h:mm a")}
          </div>
          <Link href={item.href}>
            <Card className="glass-panel border-none shadow-sm hover:shadow-md transition-all group cursor-pointer overflow-hidden">
              <CardContent className="p-3.5 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-foreground/[0.04] text-muted-foreground group-hover:text-primary group-hover:bg-primary/10 transition-colors flex items-center justify-center shrink-0">
                  <item.icon className="w-4 h-4" />
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
  );
}
