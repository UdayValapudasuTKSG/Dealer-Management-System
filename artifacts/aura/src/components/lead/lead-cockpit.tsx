import { useState } from "react";
import { Link } from "wouter";
import {
  useListGates,
  useListTasks,
  useCreateTask,
  useUpdateTask,
  getListTasksQueryKey,
} from "@workspace/api-client-react";
import type { Lead, Task } from "@workspace/api-client-react";
import type { StageNavStage } from "@/components/lead/stage-nav";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  ClipboardList,
  Loader2,
  Plus,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const GATE_TYPE_LABEL: Record<string, string> = {
  below_floor_price: "Below floor price",
  credit_decline: "Credit decline",
  capital_order: "Capital order",
  gra_filing: "GRA filing",
  refund_release: "Refund release",
};

function CockpitCard({
  icon,
  title,
  badge,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] p-5 flex flex-col min-h-[180px]">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
          {icon}
        </span>
        <span className="text-sm font-semibold tracking-tight">{title}</span>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      {children}
    </div>
  );
}

/** Next checkpoint: the current stage's requirement checklist + advance CTA. */
export function NextCheckpointCard({
  stage,
  nextStageLabel,
  onOpenWorkflow,
  canEdit,
}: {
  stage: StageNavStage | undefined;
  nextStageLabel: string | null;
  onOpenWorkflow: () => void;
  canEdit: boolean;
}) {
  const items = stage?.checklist ?? [];
  const unmet = items.filter((c) => !c.done);
  const ready = unmet.length === 0 && items.length > 0;
  return (
    <CockpitCard
      icon={<Workflow className="w-3.5 h-3.5" />}
      title="Next Checkpoint"
      badge={
        <span
          className={cn(
            "text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ring-1",
            ready
              ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
              : "bg-amber-500/15 text-amber-400 ring-amber-500/30",
          )}
        >
          {ready ? "Ready to advance" : `${unmet.length} to complete`}
        </span>
      }
    >
      {stage ? (
        <>
          <p className="text-xs text-muted-foreground leading-relaxed mb-3">
            {nextStageLabel
              ? `Complete these to move from ${stage.label} to ${nextStageLabel}.`
              : "Final stage — keep the record complete."}
          </p>
          <ul className="space-y-2 flex-1">
            {items.map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-sm">
                <span
                  className={cn(
                    "mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ring-1",
                    c.done
                      ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40"
                      : "bg-foreground/[0.05] text-muted-foreground/40 ring-white/10",
                  )}
                >
                  {c.done && <Check className="w-2.5 h-2.5" />}
                </span>
                <span
                  className={cn(
                    c.done
                      ? "text-foreground/55 line-through decoration-foreground/30"
                      : "text-foreground/90",
                  )}
                >
                  {c.label}
                </span>
              </li>
            ))}
          </ul>
          {canEdit && (
            <Button
              onClick={onOpenWorkflow}
              className={cn("mt-4 w-full gap-1.5", ready && "glow-red")}
              variant={ready ? "default" : "outline"}
            >
              <Workflow className="w-4 h-4" />
              {ready && nextStageLabel
                ? `Advance to ${nextStageLabel}`
                : "Open workflow"}
            </Button>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No active checkpoint for this lead.
        </p>
      )}
    </CockpitCard>
  );
}

/** Inline reviews: pending approval gates tied to this lead's journey. */
export function LeadApprovalsCard({
  lead,
  linkedDealId,
}: {
  lead: Lead;
  linkedDealId?: number;
}) {
  const gates = useListGates();
  const related = (gates.data ?? []).filter((g) => {
    if (g.status !== "pending") return false;
    if (g.refType === "lead" && g.refId === lead.id) return true;
    if (g.refType === "deal" && linkedDealId != null && g.refId === linkedDealId)
      return true;
    if (
      g.refType === "vehicle" &&
      lead.interestedVehicleId != null &&
      g.refId === lead.interestedVehicleId
    )
      return true;
    return false;
  });
  return (
    <CockpitCard
      icon={<ShieldCheck className="w-3.5 h-3.5" />}
      title="Reviews & Approvals"
      badge={
        related.length > 0 ? (
          <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ring-1 bg-primary/15 text-primary ring-primary/30">
            {related.length} pending
          </span>
        ) : undefined
      }
    >
      {gates.isLoading ? (
        <div className="flex items-center justify-center flex-1 py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : related.length === 0 ? (
        <div className="flex-1 flex flex-col justify-center py-2">
          <p className="text-sm text-muted-foreground">
            Nothing is waiting on a manager decision for this lead.
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Price exceptions, credit declines, refunds, and GRA filings will
            appear here when raised.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5 flex-1">
          {related.slice(0, 4).map((g) => (
            <li key={g.id}>
              <Link
                href="/approvals"
                className="block rounded-xl border border-white/10 bg-foreground/[0.03] hover:border-primary/40 transition-colors p-3 group"
              >
                <div className="flex items-center gap-2">
                  <CircleAlert
                    className={cn(
                      "w-3.5 h-3.5 shrink-0",
                      g.priority === "high" ? "text-primary" : "text-amber-400",
                    )}
                  />
                  <span className="text-sm font-medium truncate">{g.title}</span>
                  <ArrowUpRight className="w-3 h-3 ml-auto text-muted-foreground group-hover:text-primary shrink-0" />
                </div>
                <div className="text-[11px] text-muted-foreground mt-1 pl-5.5">
                  {GATE_TYPE_LABEL[g.type] ?? g.type} · awaiting review
                </div>
              </Link>
            </li>
          ))}
          {related.length > 4 && (
            <li className="text-xs text-muted-foreground pl-1">
              <Link href="/approvals" className="text-primary hover:underline">
                +{related.length - 4} more in the review queue
              </Link>
            </li>
          )}
        </ul>
      )}
    </CockpitCard>
  );
}

/** Tasks linked to this lead, with quick add + one-click complete. */
export function LeadTasksCard({
  lead,
  canEdit,
}: {
  lead: Lead;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const tasks = useListTasks({ leadId: lead.id });
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        setTitle("");
        invalidate();
        toast({ title: "Task added to this lead" });
      },
      onError: () =>
        toast({ title: "Could not add task", variant: "destructive" }),
    },
  });
  const updateTask = useUpdateTask({
    mutation: {
      onSuccess: () => invalidate(),
      onError: () =>
        toast({ title: "Could not update task", variant: "destructive" }),
    },
  });

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

  return (
    <CockpitCard
      icon={<ClipboardList className="w-3.5 h-3.5" />}
      title="Tasks for this Lead"
      badge={
        openCount > 0 ? (
          <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full ring-1 bg-amber-500/15 text-amber-400 ring-amber-500/30">
            {openCount} open
          </span>
        ) : undefined
      }
    >
      {tasks.isLoading ? (
        <div className="flex items-center justify-center flex-1 py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground flex-1 py-2">
          No tasks yet — add the next action so nothing slips.
        </p>
      ) : (
        <ul className="space-y-2 flex-1">
          {rows.slice(0, 5).map((t) => (
            <li key={t.id} className="flex items-start gap-2.5 text-sm">
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
                  "mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ring-1 transition-colors",
                  t.status === "done"
                    ? "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40"
                    : "bg-foreground/[0.05] text-transparent ring-white/15 hover:ring-primary/50",
                )}
              >
                <Check className="w-2.5 h-2.5" />
              </button>
              <div className="min-w-0">
                <div
                  className={cn(
                    "leading-tight truncate",
                    t.status === "done"
                      ? "text-foreground/50 line-through decoration-foreground/30"
                      : "text-foreground/90",
                  )}
                >
                  {t.title}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {t.assigneeName ?? "Unassigned"}
                  {t.dueDate ? ` · due ${t.dueDate}` : ""}
                </div>
              </div>
            </li>
          ))}
          {rows.length > 5 && (
            <li className="text-xs">
              <Link href="/tasks" className="text-primary hover:underline">
                +{rows.length - 5} more in Tasks
              </Link>
            </li>
          )}
        </ul>
      )}
      {canEdit && (
        <div className="flex items-center gap-2 mt-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTask()}
            placeholder="Add a task for this lead…"
            className="h-9 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={addTask}
            disabled={!title.trim() || createTask.isPending}
            className="h-9 px-3 shrink-0"
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
    </CockpitCard>
  );
}
