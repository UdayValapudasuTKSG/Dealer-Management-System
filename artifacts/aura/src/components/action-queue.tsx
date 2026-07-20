import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useListLeads,
  useListDeals,
  useListGates,
} from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PhoneCall,
  CalendarClock,
  AlarmClock,
  MailQuestion,
  Landmark,
  ShieldCheck,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type QueueItem = {
  id: string;
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

type Group = {
  id: string;
  title: string;
  number: string;
  items: QueueItem[];
  href: string;
  tone: string;
  bgTone: string;
  icon: typeof PhoneCall;
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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function ActionQueue({ compact }: { compact?: boolean }) {
  const { data: leads } = useListLeads();
  const { data: deals } = useListDeals();
  const { data: gates } = useListGates({ status: "pending" });
  const [, navigate] = useLocation();

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const { groups, totalCount } = useMemo(() => {
    const approvals: QueueItem[] = [];
    const contacts: QueueItem[] = [];
    const testDrives: QueueItem[] = [];
    const followUps: QueueItem[] = [];
    const activeDeals: QueueItem[] = [];

    for (const g of gates ?? []) {
      approvals.push({
        id: g.id.toString(),
        key: `gate-${g.id}`,
        icon: ShieldCheck,
        tone: "text-blue-500",
        bgTone: "bg-blue-500/10",
        context: g.title,
        subContext: "Requires manager approval",
        action: "Review",
        href: "/approvals",
        rank: g.priority === "high" ? 0 : 2,
      });
    }

    for (const l of leads ?? []) {
      if (l.phase === "lost") continue;
      
      let handled = false;

      if (!l.contactedDate && (l.status === "new" || l.status === "assigned")) {
        contacts.push({
          id: l.id.toString(),
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
        handled = true;
      }
      
      if (isToday(l.testDriveAt)) {
        testDrives.push({
          id: l.id.toString(),
          key: `td-${l.id}`,
          icon: CalendarClock,
          tone: "text-sky-500",
          bgTone: "bg-sky-500/10",
          context: l.name,
          subContext: "Test drive scheduled today",
          action: "Prepare",
          href: `/lead/${l.id}`,
          rank: 0,
        });
        handled = true;
      }
      
      if (!handled) {
        const inStage = daysSince(l.stageEnteredAt ?? l.createdAt);
        if (l.phase !== "won" && inStage > SLA_DAYS) {
          followUps.push({
            id: l.id.toString(),
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
          followUps.push({
            id: l.id.toString(),
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
    }

    for (const d of deals ?? []) {
      if (
        !d.depositPaid &&
        (d.stage === "negotiation" || d.stage === "desking" || d.stage === "finance")
      ) {
        activeDeals.push({
          id: d.id.toString(),
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

    // Sort items inside groups
    approvals.sort((a, b) => a.rank - b.rank);
    contacts.sort((a, b) => a.rank - b.rank);
    testDrives.sort((a, b) => a.rank - b.rank);
    followUps.sort((a, b) => a.rank - b.rank);
    activeDeals.sort((a, b) => a.rank - b.rank);

    const outGroups: Group[] = [];
    let counter = 1;

    if (contacts.length > 0) {
      outGroups.push({
        id: "contacts",
        title: "Priority Calls",
        number: `0${counter++}`,
        items: contacts,
        href: "/leads",
        tone: "text-emerald-500",
        bgTone: "bg-emerald-500/10",
        icon: PhoneCall,
      });
    }

    if (approvals.length > 0) {
      outGroups.push({
        id: "approvals",
        title: "Approvals waiting on you",
        number: `0${counter++}`,
        items: approvals,
        href: "/approvals",
        tone: "text-blue-500",
        bgTone: "bg-blue-500/10",
        icon: ShieldCheck,
      });
    }

    if (testDrives.length > 0) {
      outGroups.push({
        id: "testDrives",
        title: "Test Drives Today",
        number: `0${counter++}`,
        items: testDrives,
        href: "/pipeline",
        tone: "text-sky-500",
        bgTone: "bg-sky-500/10",
        icon: CalendarClock,
      });
    }

    if (followUps.length > 0) {
      outGroups.push({
        id: "followUps",
        title: "Follow-ups",
        number: `0${counter++}`,
        items: followUps,
        href: "/pipeline",
        tone: "text-amber-500",
        bgTone: "bg-amber-500/10",
        icon: AlarmClock,
      });
    }

    if (activeDeals.length > 0) {
      outGroups.push({
        id: "deals",
        title: "Deals Awaiting Deposit",
        number: `0${counter++}`,
        items: activeDeals,
        href: "/deals",
        tone: "text-orange-500",
        bgTone: "bg-orange-500/10",
        icon: Landmark,
      });
    }

    const total =
      approvals.length +
      contacts.length +
      testDrives.length +
      followUps.length +
      activeDeals.length;

    return { groups: outGroups, totalCount: total };
  }, [leads, deals, gates]);

  if (totalCount === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="py-12 border border-border/50 rounded-2xl glass flex flex-col items-center justify-center text-center space-y-3"
      >
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-xl font-medium">You're all caught up.</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            No pending objectives. AURA is monitoring your pipeline.
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="space-y-8 md:space-y-10">
      {/* Day Brief Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <h2 className="text-3xl md:text-5xl font-medium tracking-tight text-foreground leading-tight">
          {greeting()} &mdash; you have <span className="font-semibold text-primary">{totalCount} objectives</span> today.
        </h2>
        
        {/* Breakdown Strip */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {groups.map((g, i) => (
            <motion.button
              key={g.id}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: i * 0.05 + 0.2 }}
              onClick={() => {
                const el = document.getElementById(`queue-group-${g.id}`);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  setExpandedGroups((prev) => ({ ...prev, [g.id]: true }));
                }
              }}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-foreground/[0.03] hover:bg-foreground/[0.06] border border-border/50 hover:border-border transition-all text-sm font-medium"
            >
              <g.icon className={cn("w-4 h-4", g.tone)} />
              <span>{g.items.length} {g.title.toLowerCase()}</span>
            </motion.button>
          ))}
        </div>
      </motion.div>

      {/* Objectives Groups */}
      <div className="space-y-8">
        {groups.map((g, idx) => {
          const isExpanded = expandedGroups[g.id] ?? g.items.length <= 4;
          const shownItems = isExpanded ? g.items : g.items.slice(0, 3);
          const hasMore = !isExpanded && g.items.length > 3;

          return (
            <motion.div
              key={g.id}
              id={`queue-group-${g.id}`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: idx * 0.1 + 0.1 }}
              className="scroll-m-24"
            >
              {/* Group Header */}
              <div className="flex items-center gap-4 mb-4">
                <div className="text-xl md:text-2xl font-bold text-muted-foreground/40 tabular-nums select-none tracking-tighter">
                  {g.number}
                </div>
                <h3 className="text-lg md:text-xl font-medium tracking-tight">
                  {g.title}
                </h3>
                <div className="h-px flex-1 bg-border/40 ml-2 hidden md:block" />
              </div>

              {/* Group Items */}
              <div className="grid grid-cols-1 gap-2.5">
                <AnimatePresence initial={false}>
                  {shownItems.map((item, itemIdx) => (
                    <motion.div
                      key={item.key}
                      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                      animate={{ opacity: 1, height: "auto", marginBottom: 0 }}
                      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                      transition={{ duration: 0.3 }}
                      className="group overflow-hidden"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl glass-panel border border-border/50 hover:border-border transition-colors gap-4 relative">
                        {/* Subtle accent strip */}
                        <div className={cn("absolute left-0 top-0 bottom-0 w-1 opacity-60", g.bgTone)} />
                        
                        <div className="flex items-center gap-4 min-w-0 pl-1">
                          <div className={cn("w-10 h-10 rounded-full flex items-center justify-center shrink-0", g.bgTone)}>
                            <g.icon className={cn("w-5 h-5", g.tone)} />
                          </div>
                          <div className="min-w-0">
                            <h4 className="font-semibold text-base truncate">{item.context}</h4>
                            <p className="text-sm text-muted-foreground mt-0.5 truncate">{item.subContext}</p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-6 sm:pl-4 pl-14">
                          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                            {item.rank === 0 ? "High Priority" : item.rank === 1 ? "Priority" : "Standard"}
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-8 px-4 rounded-full bg-foreground/[0.05] hover:bg-primary hover:text-primary-foreground transition-colors shadow-none shrink-0"
                            onClick={() => navigate(item.href)}
                          >
                            {item.action}
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              {/* Footer / Expand */}
              {g.items.length > 3 && (
                <div className="mt-3 flex items-center pl-14 md:pl-[4.5rem]">
                  <button
                    onClick={() => toggleGroup(g.id)}
                    className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
                  >
                    {hasMore ? (
                      <>Show {g.items.length - 3} more <ChevronDown className="w-4 h-4" /></>
                    ) : (
                      <>Show less <ChevronUp className="w-4 h-4" /></>
                    )}
                  </button>
                  {isExpanded && (
                    <>
                      <span className="mx-3 text-border">&bull;</span>
                      <button
                        onClick={() => navigate(g.href)}
                        className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
                      >
                        View in board <ArrowRight className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
