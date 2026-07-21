import { useEffect, useMemo, useState } from "react";
import {
  useGetLeadReview,
  useAdvanceLeadStage,
  getGetLeadReviewQueryKey,
  getGetLeadQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import type {
  LeadReviewStage,
  LeadReviewItem,
  LeadAdvanceInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Loader2,
  Lock,
  ShieldCheck,
  TriangleAlert,
  ArrowRight,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

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

function ownerLabel(owner: string) {
  return OWNER_LABEL[owner] ?? owner.replace(/_/g, " ");
}

function OwnerChip({ owner }: { owner: string }) {
  return (
    <span
      className={cn(
        "text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 shrink-0",
        OWNER_STYLE[owner] ?? "bg-foreground/[0.06] text-foreground/70 ring-white/15",
      )}
    >
      {ownerLabel(owner)}
    </span>
  );
}

function ItemRow({ item }: { item: LeadReviewItem }) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-white/5 bg-foreground/[0.02] px-4 py-2.5">
      <span
        className={cn(
          "mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ring-1",
          item.met
            ? "bg-emerald-500/20 text-emerald-500 ring-emerald-500/40"
            : "bg-amber-500/15 text-amber-500 ring-amber-500/40",
        )}
      >
        {item.met ? (
          <Check className="w-2.5 h-2.5" />
        ) : (
          <TriangleAlert className="w-2.5 h-2.5" />
        )}
      </span>
      <span
        className={cn(
          "text-sm flex-1 min-w-0",
          item.met ? "text-foreground/70" : "text-foreground/90 font-medium",
        )}
      >
        {item.label}
      </span>
      <OwnerChip owner={item.owner} />
    </li>
  );
}

export function RunReviewDialog({
  leadId,
  open,
  onOpenChange,
  canEdit,
}: {
  leadId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const review = useGetLeadReview(leadId, {
    query: { queryKey: getGetLeadReviewQueryKey(leadId), enabled: open },
  });
  const [step, setStep] = useState(0);
  const [unmet, setUnmet] = useState<string[]>([]);

  const stages = useMemo<LeadReviewStage[]>(
    () => review.data?.stages ?? [],
    [review.data],
  );

  const currentStageIndex = stages.findIndex((s) => s.state === "current");

  // Jump to the current stage when the review loads / re-opens.
  useEffect(() => {
    if (open && currentStageIndex >= 0) setStep(currentStageIndex);
  }, [open, currentStageIndex]);

  useEffect(() => {
    setUnmet([]);
  }, [step, open]);

  const advance = useAdvanceLeadStage({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getGetLeadReviewQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(leadId) });
        qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        setUnmet([]);
        toast({ title: "Stage advanced", description: "All requirements met." });
      },
      onError: (err) => {
        const data = (err as { data?: { unmet?: string[] } })?.data;
        if (data?.unmet?.length) {
          setUnmet(data.unmet);
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

  const active = stages[step];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </span>
            Run Review
          </DialogTitle>
          <DialogDescription>
            Phase-by-phase readiness check. Clear every requirement to advance
            the lead to the next stage.
          </DialogDescription>
        </DialogHeader>

        {review.isLoading ? (
          <div className="py-16 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : review.isError || stages.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            The review is unavailable right now.{" "}
            <button
              onClick={() => review.refetch()}
              className="text-primary hover:underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* Stepper nav */}
            <div className="flex items-center gap-1.5">
              {stages.map((s, i) => {
                const done = s.state === "passed";
                const isCurrent = s.state === "current";
                const activeStep = i === step;
                return (
                  <button
                    key={s.stage}
                    onClick={() => setStep(i)}
                    className={cn(
                      "flex-1 flex flex-col items-center gap-1.5 rounded-xl px-2 py-2 transition-colors",
                      activeStep
                        ? "bg-primary/[0.08] ring-1 ring-primary/30"
                        : "hover:bg-foreground/[0.04]",
                    )}
                  >
                    <span
                      className={cn(
                        "w-7 h-7 rounded-full flex items-center justify-center ring-1 text-xs font-semibold",
                        done
                          ? "bg-emerald-500/20 text-emerald-500 ring-emerald-500/40"
                          : isCurrent
                            ? "bg-primary text-primary-foreground ring-primary"
                            : "bg-foreground/[0.05] text-muted-foreground ring-white/10",
                      )}
                    >
                      {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
                    </span>
                    <span
                      className={cn(
                        "text-[11px] font-semibold text-center leading-tight",
                        activeStep ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {s.label}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Active step body */}
            {active && (
              <div className="space-y-4 pt-1">
                <StageBody
                  stage={active}
                  unmet={unmet}
                  canEdit={canEdit}
                  advancing={advance.isPending}
                  onAdvance={() =>
                    advance.mutate({
                      id: leadId,
                      data: {
                        toStage: active.stage as LeadAdvanceInput["toStage"],
                      },
                    })
                  }
                />
              </div>
            )}

            {/* Prev / Next */}
            <div className="flex items-center justify-between pt-2 border-t border-white/10">
              <Button
                variant="ghost"
                size="sm"
                disabled={step === 0}
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="gap-1.5"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={step === stages.length - 1}
                onClick={() =>
                  setStep((s) => Math.min(stages.length - 1, s + 1))
                }
                className="gap-1.5"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StageBody({
  stage,
  unmet,
  canEdit,
  advancing,
  onAdvance,
}: {
  stage: LeadReviewStage;
  unmet: string[];
  canEdit: boolean;
  advancing: boolean;
  onAdvance: () => void;
}) {
  const good = stage.items.filter((i) => i.met);
  const attention = stage.items.filter((i) => !i.met);

  return (
    <>
      {stage.state === "passed" && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-2.5 text-sm text-emerald-500 font-medium">
          <CircleCheck className="w-4 h-4" />
          Cleared — this phase's requirements are all met.
        </div>
      )}
      {stage.state === "upcoming" && (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-foreground/[0.03] px-4 py-2.5 text-sm text-muted-foreground">
          <Lock className="w-4 h-4" />
          Upcoming phase — requirements preview below.
        </div>
      )}

      {good.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-500">
            What&apos;s good
          </div>
          <ul className="space-y-2">
            {good.map((i) => (
              <ItemRow key={i.key} item={i} />
            ))}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-widest text-amber-500">
            What needs attention
          </div>
          <ul className="space-y-2">
            {attention.map((i) => (
              <ItemRow key={i.key} item={i} />
            ))}
          </ul>
        </div>
      )}

      {unmet.length > 0 && (
        <ul className="space-y-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
          {unmet.map((m) => (
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

      {stage.stage === "delivery" && stage.state !== "passed" && (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-foreground/[0.03] px-4 py-2.5 text-xs text-muted-foreground">
          <Lock className="w-3.5 h-3.5 shrink-0" />
          Delivery completes through the deal workflow — GRA duty filing and
          handover are cleared there.
        </div>
      )}

      {stage.state === "current" && stage.stage !== "delivery" && canEdit && (
        <Button
          className="w-full gap-2"
          disabled={advancing}
          onClick={onAdvance}
        >
          {advancing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ArrowRight className="w-4 h-4" />
          )}
          Advance to {stage.label}
        </Button>
      )}
    </>
  );
}
