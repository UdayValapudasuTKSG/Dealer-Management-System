import { useState } from "react";
import {
  useListTasks,
  useCreateTask,
  useUpdateTask,
  getListTasksQueryKey,
  useGetLeadReview,
  useAdvanceLeadStage,
  getGetLeadReviewQueryKey,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import type {
  Lead,
  Task,
  LeadAdvanceInput,
  LeadReviewItem,
} from "@workspace/api-client-react";
import type { StageNavStage } from "@/components/lead/stage-nav";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ClipboardList,
  Clock,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  TriangleAlert,
  Workflow,
  CheckCircle2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { GateCard, GATE_LABEL } from "@/components/gate-card";

const OWNER_LABEL: Record<string, string> = {
  advisor: "Sales Advisor",
  sales_advisor: "Sales Advisor",
  customer: "Customer",
  finance: "Finance",
  inventory: "Inventory",
  manager: "Sales Manager",
  sales_manager: "Sales Manager",
  agent: "AI Agent",
};

const OWNER_STYLE: Record<string, string> = {
  customer: "bg-sky-500/15 text-sky-500 ring-sky-500/30",
  finance: "bg-violet-500/15 text-violet-500 ring-violet-500/30",
  inventory: "bg-amber-500/15 text-amber-500 ring-amber-500/30",
  manager: "bg-primary/15 text-primary ring-primary/30",
  sales_manager: "bg-primary/15 text-primary ring-primary/30",
};

function OwnerChip({ owner }: { owner: string }) {
  return (
    <span
      className={cn(
        "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 shrink-0",
        OWNER_STYLE[owner] ?? "bg-foreground/[0.06] text-foreground/70 ring-white/15",
      )}
    >
      {OWNER_LABEL[owner] ?? owner.replace(/_/g, " ")}
    </span>
  );
}

export function ActionChain({
  lead,
  stage,
  onOpenWorkflow,
  canEdit,
  pendingGates,
  onGateResolved,
}: {
  lead: Lead;
  stage: StageNavStage | undefined;
  onOpenWorkflow: () => void;
  canEdit: boolean;
  pendingGates: any[];
  onGateResolved?: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [advanceUnmet, setAdvanceUnmet] = useState<string[]>([]);
  const tasks = useListTasks({ leadId: lead.id });
  const review = useGetLeadReview(lead.id, {
    query: { queryKey: getGetLeadReviewQueryKey(lead.id) },
  });
  const sla = review.data?.sla ?? null;
  const reviewStage = review.data?.stages.find((s) => s.state === "current");
  const advanceStage = useAdvanceLeadStage({
    mutation: {
      onSuccess: () => {
        setAdvanceUnmet([]);
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(lead.id) });
        qc.invalidateQueries({ queryKey: getGetLeadReviewQueryKey(lead.id) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(lead.id) });
        qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        toast({
          title: `Advanced to ${reviewStage?.label ?? "next stage"}`,
          description: "All readiness requirements met.",
        });
      },
      onError: (err) => {
        const data = (err as { data?: { unmet?: string[] } })?.data;
        if (data?.unmet?.length) {
          setAdvanceUnmet(data.unmet);
        } else {
          toast({
            title: "Could not advance",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        }
      },
    },
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        setTitle("");
        invalidate();
        toast({ title: "Task added to this lead" });
      },
      onError: () => toast({ title: "Could not add task", variant: "destructive" }),
    },
  });
  const updateTask = useUpdateTask({
    mutation: {
      onSuccess: () => invalidate(),
      onError: () => toast({ title: "Could not update task", variant: "destructive" }),
    },
  });

  // Readiness comes from the stage-review endpoint (met/unmet + owner);
  // fall back to the journey-rail checklist when it hasn't loaded.
  const readinessItems: LeadReviewItem[] =
    reviewStage?.items ??
    (stage?.checklist ?? []).map((c) => ({
      key: c.label,
      label: c.label,
      met: c.done,
      owner: "advisor",
    }));
  const items = readinessItems;
  const unmet = items.filter((c) => !c.met);
  const ready = unmet.length === 0 && items.length > 0;
  const gatesPending = pendingGates.length > 0;
  const sortedGates = [...pendingGates].sort((a, b) => {
    const here = (g: any) => (g.chainStageKey === stage?.key ? 0 : 1);
    return here(a) - here(b);
  });
  const currentStageBlocked = pendingGates.some(
    (g) => g.chainStageKey === stage?.key || g.chainStageKey == null,
  );
  
  const rows = [...(tasks.data ?? [])].sort((a, b) => {
    const open = (t: Task) => (t.status === "done" ? 1 : 0);
    return open(a) - open(b);
  });
  const openCount = rows.filter((t) => t.status !== "done").length;

  const addTask = () => {
    const t = title.trim();
    if (!t) return;
    createTask.mutate({
      data: {
        title: t,
        leadId: lead.id,
        ...(lead.ownerUserId ? { assigneeUserId: lead.ownerUserId } : {}),
      },
    });
  };

  const MotionDiv = motion.div;

  function formatSlaRemaining(ms: number): string {
    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5 lg:p-7 overflow-hidden flex flex-col h-full shadow-[0_8px_32px_rgba(0,0,0,0.25)]">
      <div className="flex items-center gap-2 mb-8">
        <span className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
          <Workflow className="w-4 h-4" />
        </span>
        <span className="font-semibold tracking-tight text-lg">Action Chain</span>
      </div>

      {sla && (
        <div
          className={cn(
            "mb-6 rounded-xl border px-4 py-3 flex items-center gap-3",
            sla.breached
              ? "border-rose-500/40 bg-rose-500/10"
              : sla.remainingMs < 6 * 60 * 60 * 1000
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-white/10 bg-foreground/[0.02]",
          )}
        >
          <Clock
            className={cn(
              "w-4 h-4 shrink-0",
              sla.breached
                ? "text-rose-400"
                : sla.remainingMs < 6 * 60 * 60 * 1000
                  ? "text-amber-400"
                  : "text-muted-foreground",
            )}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              {sla.breached
                ? "Contact SLA breached"
                : `Contact SLA: ${formatSlaRemaining(sla.remainingMs)} left`}
            </div>
            <div className="text-xs text-muted-foreground">
              {sla.breached
                ? "The 24-hour first-contact window has passed — call the customer now or close the lead with a reason."
                : "Log a call before the 24-hour first-contact window closes."}
            </div>
          </div>
        </div>
      )}

      <div className="relative pl-7 flex-1">
        {/* The literal chain running through */}
        <div className="absolute top-2 bottom-6 left-[13px] w-[2px] bg-white/10" />

        {/* Step 1: Checklist */}
        <MotionDiv
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="relative mb-10"
        >
          <div className="absolute -left-[27px] top-0.5 w-6 h-6 rounded-full bg-card border-2 border-primary/30 flex items-center justify-center ring-4 ring-card text-primary shadow-[0_0_12px_rgba(169,113,66,0.3)]">
            <CheckCircle2 className="w-3.5 h-3.5" />
          </div>
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
            {(reviewStage?.items?.length ? reviewStage.label : stage?.label) ??
              stage?.label}{" "}
            Readiness
          </div>
          {items.length === 0 ? (
            <div className="text-sm text-muted-foreground bg-foreground/[0.02] border border-white/5 rounded-xl px-4 py-3">
              No readiness requirements for this stage.
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((c) => (
                <li key={c.key} className="flex items-center gap-3 text-sm bg-foreground/[0.02] border border-white/5 rounded-xl px-4 py-3 hover:bg-foreground/[0.04] transition-colors">
                  <span
                    className={cn(
                      "w-4 h-4 rounded-full flex items-center justify-center shrink-0 ring-1",
                      c.met
                        ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40"
                        : "bg-foreground/[0.05] text-muted-foreground/40 ring-white/10"
                    )}
                  >
                    {c.met && <Check className="w-3 h-3" />}
                  </span>
                  <span className={cn("flex-1 min-w-0", c.met ? "text-foreground/50 line-through decoration-foreground/30" : "text-foreground/90 font-medium")}>
                    {c.label}
                  </span>
                  <OwnerChip owner={c.owner} />
                </li>
              ))}
            </ul>
          )}
        </MotionDiv>

        {/* Step 2: Reviews (if any) */}
        {gatesPending && (
          <MotionDiv
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="relative mb-10"
          >
            <div className="absolute -left-[27px] top-0.5 w-6 h-6 rounded-full bg-card border-2 border-amber-500/50 flex items-center justify-center ring-4 ring-card text-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.3)]">
              <ShieldCheck className="w-3.5 h-3.5" />
            </div>
            <div className="text-xs font-bold uppercase tracking-widest text-amber-500 mb-3">
              Approvals Needed
            </div>
            <ul className="space-y-3">
              {sortedGates.map((g) => {
                const atCurrentStage =
                  g.chainStageKey == null || g.chainStageKey === stage?.key;
                return (
                  <li key={g.id} className="space-y-1.5">
                    {!atCurrentStage && g.chainStageLabel && (
                      <span className="inline-flex text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full ring-1 ring-amber-500/30 text-amber-500/80 whitespace-nowrap">
                        {g.chainStageLabel} stage
                      </span>
                    )}
                    <GateCard
                      gate={g}
                      label={GATE_LABEL[g.type]}
                      showCustomerLink={false}
                      onResolved={onGateResolved}
                    />
                  </li>
                );
              })}
            </ul>
          </MotionDiv>
        )}

        {/* Step 3: Tasks */}
        <MotionDiv
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: gatesPending ? 0.3 : 0.2 }}
          className="relative mb-10"
        >
          <div className="absolute -left-[27px] top-0.5 w-6 h-6 rounded-full bg-card border-2 border-primary/30 flex items-center justify-center ring-4 ring-card text-primary">
            <ClipboardList className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Open Tasks
            </div>
            {openCount > 0 && (
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ring-1 bg-amber-500/15 text-amber-400 ring-amber-500/30">
                {openCount} open
              </span>
            )}
          </div>
          
          <ul className="space-y-2 mb-3">
            {rows.length === 0 ? (
              <li className="text-sm text-muted-foreground bg-foreground/[0.02] border border-white/5 rounded-xl px-4 py-3">
                No tasks yet — add the next action so nothing slips.
              </li>
            ) : (
              rows.map((t) => (
                <li key={t.id} className="flex items-center gap-3 text-sm bg-foreground/[0.02] border border-white/5 rounded-xl px-4 py-2.5 hover:bg-foreground/[0.04] transition-colors">
                  <button
                    disabled={!canEdit || updateTask.isPending}
                    onClick={() =>
                      updateTask.mutate({
                        id: t.id,
                        data: { status: t.status === "done" ? "open" : "done" },
                      })
                    }
                    aria-label={
                      t.status === "done" ? "Reopen task" : "Mark task done"
                    }
                    className={cn(
                      "w-5 h-5 rounded-full flex items-center justify-center shrink-0 ring-1 transition-colors",
                      t.status === "done"
                        ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40"
                        : "bg-foreground/[0.05] text-transparent ring-white/15 hover:ring-primary/50"
                    )}
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={cn("truncate font-medium", t.status === "done" ? "text-foreground/50 line-through decoration-foreground/30" : "text-foreground/90")}>
                      {t.title}
                    </div>
                  </div>
                </li>
              ))
            )}
          </ul>
          {canEdit && (
            <div className="flex items-center gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTask()}
                placeholder="Add a task for this lead…"
                className="h-10 text-sm bg-foreground/[0.02] border-white/5 rounded-xl"
              />
              <Button
                variant="outline"
                onClick={addTask}
                disabled={!title.trim() || createTask.isPending}
                className="h-10 px-4 shrink-0 rounded-xl"
                aria-label="Add task"
              >
                {createTask.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
              </Button>
            </div>
          )}
        </MotionDiv>

        {/* Step 4: Advance */}
        <MotionDiv
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: gatesPending ? 0.4 : 0.3 }}
          className="relative"
        >
          <div className="absolute -left-[27px] top-2 w-6 h-6 rounded-full bg-card border-2 border-primary/30 flex items-center justify-center ring-4 ring-card text-primary">
            <ArrowUpRight className="w-3.5 h-3.5" />
          </div>
          <div className="pt-0.5 space-y-3">
            {advanceUnmet.length > 0 && (
              <ul className="space-y-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
                {advanceUnmet.map((m) => (
                  <li
                    key={m}
                    className="flex items-start gap-2 text-xs text-amber-500"
                  >
                    <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
                    {m}
                  </li>
                ))}
              </ul>
            )}
            {reviewStage?.stage === "delivery" ? (
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-foreground/[0.03] px-4 py-2.5 text-xs text-muted-foreground">
                <Lock className="w-3.5 h-3.5 shrink-0" />
                {reviewStage.items.some(
                  (i) => i.key === "payment_settled" && !i.met,
                )
                  ? "Next step: commit the linked deal on the Deals page — the GRA duty filing and handover unlock after commit."
                  : "Delivery completes through the deal workflow — GRA duty filing and handover are cleared there."}
              </div>
            ) : (
              canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  {reviewStage && (
                    <Button
                      disabled={advanceStage.isPending}
                      onClick={() =>
                        advanceStage.mutate({
                          id: lead.id,
                          data: {
                            toStage:
                              reviewStage.stage as LeadAdvanceInput["toStage"],
                          },
                        })
                      }
                      className={cn(
                        "w-full sm:w-auto gap-2 h-11 px-6 rounded-xl font-semibold shadow-md transition-all",
                        ready && !currentStageBlocked && "glow-red scale-[1.02]",
                      )}
                      variant={
                        ready && !currentStageBlocked ? "default" : "secondary"
                      }
                    >
                      {advanceStage.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ArrowRight className="w-4 h-4" />
                      )}
                      Advance to {reviewStage.label}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={onOpenWorkflow}
                    className="gap-2 h-11 px-4 rounded-xl"
                  >
                    <Workflow className="w-4 h-4" />
                    Open workflow
                  </Button>
                </div>
              )
            )}
          </div>
        </MotionDiv>
      </div>
    </div>
  );
}
