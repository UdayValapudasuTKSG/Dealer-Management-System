import { useMemo } from "react";
import { useLocation } from "wouter";
import {
  useListLeads,
  useListDeals,
  useListGates,
} from "@workspace/api-client-react";
import { motion } from "framer-motion";
import {
  PhoneCall,
  CalendarClock,
  AlarmClock,
  MailQuestion,
  Landmark,
  ShieldCheck,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type QueueItem = {
  key: string;
  icon: typeof PhoneCall;
  tone: string;
  bgTone: string;
  context: string;
  subContext: string;
  action: string;
  href: string;
  rank: number;
};

const SLA_DAYS = 5;

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000),
  );
}

function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function ActionQueue({ compact }: { compact?: boolean }) {
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();
  const { data: gates } = useListGates({ status: "pending" });
  const [, navigate] = useLocation();

  const items = useMemo(() => {
    const out: QueueItem[] = [];

    for (const g of gates ?? []) {
      out.push({
        key: `gate-${g.id}`,
        icon: ShieldCheck,
        tone: "text-blue-500",
        bgTone: "bg-blue-500/10",
        context: `Review: ${g.title}`,
        subContext: "Requires manager approval",
        action: "Review",
        href: "/approvals",
        rank: g.priority === "high" ? 0 : 2,
      });
    }

    for (const l of leads ?? []) {
      if (l.phase === "lost") continue;
      if (
        !l.contactedDate &&
        (l.status === "new" || l.status === "assigned")
      ) {
        out.push({
          key: `contact-${l.id}`,
          icon: PhoneCall,
          tone: "text-emerald-500",
          bgTone: "bg-emerald-500/10",
          context: l.name,
          subContext: "Awaiting first contact",
          action: "Call",
          href: `/lead/${l.id}`,
          rank: 1,
        });
      }
      if (isToday(l.testDriveAt)) {
        out.push({
          key: `td-${l.id}`,
          icon: CalendarClock,
          tone: "text-sky-500",
          bgTone: "bg-sky-500/10",
          context: l.name,
          subContext: "Test drive scheduled today",
          action: "Open",
          href: `/lead/${l.id}`,
          rank: 0,
        });
      }
      const inStage = daysSince(l.stageEnteredAt ?? l.createdAt);
      if (l.phase !== "won" && inStage > SLA_DAYS) {
        out.push({
          key: `sla-${l.id}`,
          icon: AlarmClock,
          tone: "text-amber-500",
          bgTone: "bg-amber-500/10",
          context: l.name,
          subContext: `Stalled for ${inStage} days`,
          action: "Follow up",
          href: `/lead/${l.id}`,
          rank: 3,
        });
      } else if (l.quotationSent && !l.testDriveAt && l.phase !== "won") {
        out.push({
          key: `quote-${l.id}`,
          icon: MailQuestion,
          tone: "text-violet-500",
          bgTone: "bg-violet-500/10",
          context: l.name,
          subContext: "Quote sent, awaiting reply",
          action: "Nudge",
          href: `/lead/${l.id}`,
          rank: 4,
        });
      }
    }

    for (const d of deals ?? []) {
      if (
        !d.depositPaid &&
        (d.stage === "negotiation" || d.stage === "desking" || d.stage === "finance")
      ) {
        out.push({
          key: `deal-${d.id}`,
          icon: Landmark,
          tone: "text-orange-500",
          bgTone: "bg-orange-500/10",
          context: d.customerName ?? "Deal",
          subContext: "Awaiting deposit",
          action: "Open",
          href: "/deals",
          rank: 2,
        });
      }
    }

    out.sort((a, b) => a.rank - b.rank);
    return out;
  }, [leads, deals, gates]);

  if (items.length === 0) return null;

  const shown = items.slice(0, 6);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-semibold tracking-tight">Your day</h2>
          <span className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-bold tabular-nums">
            {items.length} tasks
          </span>
        </div>
        {items.length > shown.length && (
          <button
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
            onClick={() => navigate("/pipeline")}
          >
            View all <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {shown.map((item, i) => (
          <motion.div
            key={item.key}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05 }}
            className="group relative flex flex-col justify-between p-5 rounded-2xl glass-panel border border-white/10 hover:border-primary/30 transition-all overflow-hidden"
          >
            {/* Accent border left */}
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${item.bgTone} opacity-50`} />
            
            <div className="flex items-start gap-3.5 mb-4">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${item.bgTone}`}>
                <item.icon className={`w-5 h-5 ${item.tone}`} />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <h3 className="font-semibold text-base truncate">{item.context}</h3>
                <p className="text-sm text-muted-foreground mt-0.5 truncate">{item.subContext}</p>
              </div>
            </div>
            
            <div className="flex items-center justify-between mt-auto pt-2">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {item.rank === 0 ? "High Priority" : item.rank === 1 ? "Priority" : "Standard"}
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 px-4 rounded-full bg-foreground/[0.05] hover:bg-primary hover:text-white transition-all shadow-none group-hover:shadow-lg group-hover:shadow-primary/20"
                onClick={() => navigate(item.href)}
              >
                {item.action}
              </Button>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
