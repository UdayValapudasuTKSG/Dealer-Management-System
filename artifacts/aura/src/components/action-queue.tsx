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
  context: string;
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
        tone: "text-primary",
        context: `Review needed: ${g.title}`,
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
          tone: "text-emerald-400",
          context: `${l.name} is awaiting first contact`,
          action: "Call",
          href: `/lead/${l.id}`,
          rank: 1,
        });
      }
      if (isToday(l.testDriveAt)) {
        out.push({
          key: `td-${l.id}`,
          icon: CalendarClock,
          tone: "text-sky-400",
          context: `Test drive today — ${l.name}`,
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
          tone: "text-amber-400",
          context: `${l.name} has sat ${inStage} days in stage`,
          action: "Follow up",
          href: `/lead/${l.id}`,
          rank: 3,
        });
      } else if (l.quotationSent && !l.testDriveAt && l.phase !== "won") {
        out.push({
          key: `quote-${l.id}`,
          icon: MailQuestion,
          tone: "text-violet-400",
          context: `Quote sent to ${l.name}, no reply yet`,
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
          tone: "text-orange-400",
          context: `${d.customerName ?? "Deal"} — awaiting deposit`,
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
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="glass-panel rounded-2xl border border-white/10 overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold tracking-tight">Your day</span>
          <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-bold tabular-nums">
            {items.length}
          </span>
        </div>
        {items.length > shown.length && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            onClick={() => navigate("/pipeline")}
          >
            View all <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className={compact ? "pb-2" : "pb-3"}>
        {shown.map((item) => (
          <div
            key={item.key}
            className="flex items-center gap-3 px-5 py-2.5 hover:bg-foreground/[0.03] transition-colors"
          >
            <item.icon className={`w-4 h-4 shrink-0 ${item.tone}`} />
            <span className="text-sm flex-1 truncate">{item.context}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs shrink-0"
              onClick={() => navigate(item.href)}
            >
              {item.action}
            </Button>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
