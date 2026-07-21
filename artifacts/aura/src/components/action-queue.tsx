import { useMemo } from "react";
import { useLocation } from "wouter";
import {
  useListLeads,
  useListDeals,
  useListGates,
} from "@workspace/api-client-react";
import {
  PhoneCall,
  CalendarClock,
  MailQuestion,
  Landmark,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Clock,
  Inbox
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildTriage, type TriageItem, type TriageKind } from "@/lib/triage";

const KIND_UI: Record<
  TriageKind,
  { icon: any; tone: string; bgTone: string; action: string }
> = {
  gate: { icon: ShieldCheck, tone: "text-destructive", bgTone: "bg-destructive/10", action: "Review" },
  contact: { icon: PhoneCall, tone: "text-emerald-500", bgTone: "bg-emerald-500/10", action: "Call" },
  testDrive: { icon: CalendarClock, tone: "text-fuchsia-500", bgTone: "bg-fuchsia-500/10", action: "Prep" },
  stalled: { icon: AlertCircle, tone: "text-amber-500", bgTone: "bg-amber-500/10", action: "Nudge" },
  quote: { icon: MailQuestion, tone: "text-violet-500", bgTone: "bg-violet-500/10", action: "Follow" },
  deposit: { icon: Landmark, tone: "text-orange-500", bgTone: "bg-orange-500/10", action: "Open" },
  delivery: { icon: CheckCircle2, tone: "text-teal-500", bgTone: "bg-teal-500/10", action: "Open" },
  service: { icon: Clock, tone: "text-rose-500", bgTone: "bg-rose-500/10", action: "Open" },
};

function getInitials(name: string) {
  if (!name) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function ActionQueue() {
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();
  const { data: gates } = useListGates({ status: "pending" });
  const [, navigate] = useLocation();

  const { urgent, today, later } = useMemo(
    () => buildTriage(leads, deals, gates),
    [leads, deals, gates],
  );

  const ItemCard = ({ item }: { item: TriageItem }) => {
    const ui = KIND_UI[item.kind];
    return (

    <div className="group flex items-center justify-between p-3 rounded-xl border border-border/50 bg-foreground/[0.02] hover:bg-foreground/[0.04] hover:border-border transition-all">
      <div className="flex items-center gap-3 min-w-0 pr-3">
        <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-bold text-[10px] tracking-wider", ui.bgTone, ui.tone)}>
          {getInitials(item.context)}
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate">{item.context}</div>
          <div className="text-[11px] text-muted-foreground truncate">{item.subContext}</div>
        </div>
      </div>
      <Button 
        size="sm" 
        variant="ghost" 
        className="h-7 px-3 rounded-full text-[11px] font-medium bg-background border border-border/50 shadow-sm shrink-0 hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
        onClick={() => navigate(item.href)}
      >
        {ui.action}
      </Button>
    </div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* URGENT NOW */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-4">
          <AlertCircle className="w-4 h-4 text-destructive" />
          <h3 className="font-semibold tracking-wide text-sm uppercase text-foreground">Urgent Now</h3>
          <span className="ml-auto text-xs font-medium text-muted-foreground bg-foreground/[0.05] px-2 py-0.5 rounded-full">{urgent.length}</span>
        </div>
        <div className="space-y-2">
          {urgent.length > 0 ? (
            urgent.slice(0, 5).map(item => <ItemCard key={item.key} item={item} />)
          ) : (
            <div className="p-4 rounded-xl border border-dashed border-border/50 text-center text-muted-foreground/60 text-sm flex flex-col items-center gap-2">
              <CheckCircle2 className="w-5 h-5" />
              All clear
            </div>
          )}
        </div>
      </div>

      {/* TODAY */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-4 h-4 text-emerald-500" />
          <h3 className="font-semibold tracking-wide text-sm uppercase text-foreground">Today</h3>
          <span className="ml-auto text-xs font-medium text-muted-foreground bg-foreground/[0.05] px-2 py-0.5 rounded-full">{today.length}</span>
        </div>
        <div className="space-y-2">
          {today.length > 0 ? (
            today.slice(0, 5).map(item => <ItemCard key={item.key} item={item} />)
          ) : (
            <div className="p-4 rounded-xl border border-dashed border-border/50 text-center text-muted-foreground/60 text-sm flex flex-col items-center gap-2">
              <Inbox className="w-5 h-5" />
              Inbox zero
            </div>
          )}
        </div>
      </div>

      {/* CAN WAIT */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-4">
          <Inbox className="w-4 h-4 text-muted-foreground" />
          <h3 className="font-semibold tracking-wide text-sm uppercase text-foreground">Can Wait</h3>
          <span className="ml-auto text-xs font-medium text-muted-foreground bg-foreground/[0.05] px-2 py-0.5 rounded-full">{later.length}</span>
        </div>
        <div className="space-y-2">
          {later.length > 0 ? (
            later.slice(0, 5).map(item => <ItemCard key={item.key} item={item} />)
          ) : (
            <div className="p-4 rounded-xl border border-dashed border-border/50 text-center text-muted-foreground/60 text-sm flex flex-col items-center gap-2">
              <CheckCircle2 className="w-5 h-5" />
              Nothing pending
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
