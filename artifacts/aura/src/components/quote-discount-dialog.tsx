import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import {
  getGetCustomerOverviewQueryKey,
  getListDealsQueryKey,
  getListGatesQueryKey,
  getListLeadsQueryKey,
  getListTimelineQueryKey,
  useResolveGate,
  type Gate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatGuyanaDateTime } from "@/lib/format";
import { useMoney } from "@/lib/format";
import { useAuthz } from "@/lib/auth";

type DecisionAction = "approve" | "dismiss";

type DecisionForm = {
  justification: string;
};

function parseMoney(value: string | undefined): number | null {
  if (!value) return null;
  const amount = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.status === "number" ? value.status : undefined;
}

function readErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.error === "string" ? value.error : undefined;
}

function getErrorDetails(error: unknown): {
  status: number | undefined;
  message: string;
} {
  if (!isRecord(error)) {
    return {
      status: undefined,
      message: typeof error === "string" ? error : "Please try again.",
    };
  }

  const response = isRecord(error.response) ? error.response : undefined;
  return {
    status: readStatus(response) ?? readStatus(error),
    message:
      readErrorMessage(response?.data) ??
      readErrorMessage(error.data) ??
      (typeof error.message === "string" ? error.message : undefined) ??
      "Please try again.",
  };
}

export function QuoteDiscountDialog({
  gate,
  open,
  onClose,
}: {
  gate: Gate | null;
  open: boolean;
  onClose: () => void;
}) {
  const { can } = useAuthz();
  const canApprove = can("approvals", "approve");
  const canReject = can("approvals", "reject");
  const canDecide = canApprove || canReject;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const money = useMoney();
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(
    null,
  );
  const submitLockRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const form = useForm<DecisionForm>({
    defaultValues: { justification: "" },
  });

  useEffect(() => {
    submitLockRef.current = false;
    form.reset({ justification: "" });
    setSubmitError(null);
    setStaleMessage(null);
  }, [form, gate?.id]);

  const evidence = useMemo(() => {
    const byLabel: Record<string, string> = {};
    for (const item of gate?.evidence ?? []) {
      byLabel[item.label] = item.value;
    }
    return byLabel;
  }, [gate]);

  const quoteTotal = parseMoney(evidence["Quote total"]);
  const requestedDiscount =
    gate?.amount ?? parseMoney(evidence["Requested discount"]);
  const resultingTotal =
    quoteTotal != null && requestedDiscount != null
      ? Math.max(quoteTotal - requestedDiscount, 0)
      : null;
  const quoteReference = evidence["Quote"]?.trim() || "Not recorded";
  const requester = evidence["Requested by"]?.trim() || "Not recorded";
  const requestReason =
    evidence["Reason"]?.trim() || "No reason was provided with this request.";
  const requestDate = gate?.createdAt ? new Date(gate.createdAt) : null;
  const requestDateLabel =
    requestDate && !Number.isNaN(requestDate.getTime())
      ? formatGuyanaDateTime(requestDate)
      : "Not recorded";

  const invalidateRelatedData = () => {
    void queryClient.invalidateQueries({ queryKey: getListGatesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListTimelineQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
    if (gate?.customerId != null) {
      void queryClient.invalidateQueries({
        queryKey: getGetCustomerOverviewQueryKey(gate.customerId),
      });
    }
  };

  const resolve = useResolveGate({
    mutation: {
      onSuccess: (_resolvedGate, variables) => {
        const approved = variables.data.action === "approve";
        invalidateRelatedData();
        toast({
          title: approved ? "Discount approved" : "Discount rejected",
          description: approved
            ? "The approved discount is now applied to the current quote."
            : "The quote remains unchanged and the request is closed.",
        });
        form.reset({ justification: "" });
        setSubmitError(null);
        setStaleMessage(null);
        onClose();
      },
      onError: (error: unknown) => {
        const { status, message } = getErrorDetails(error);
        const normalized = message.toLowerCase();
        const stale =
          status === 404 ||
          status === 409 ||
          normalized.includes("already resolved") ||
          normalized.includes("not found") ||
          normalized.includes("no longer pending");

        if (stale) {
          setSubmitError(null);
          setStaleMessage(
            "This approval was completed elsewhere or is no longer pending. Your justification has been kept for reference.",
          );
          invalidateRelatedData();
          toast({
            title: "Approval no longer pending",
            description:
              "My Day has been refreshed with the latest approval status.",
          });
          return;
        }

        setSubmitError(message);
        toast({
          title: "Could not record the decision",
          description: message,
          variant: "destructive",
        });
      },
      onSettled: () => {
        submitLockRef.current = false;
        setPendingAction(null);
      },
    },
  });

  const handleClose = () => {
    if (resolve.isPending || submitLockRef.current) return;
    form.reset({ justification: "" });
    setSubmitError(null);
    setStaleMessage(null);
    onClose();
  };

  const handleDecision = (action: DecisionAction) => {
    const permitted = action === "approve" ? canApprove : canReject;
    if (
      submitLockRef.current ||
      resolve.isPending ||
      !permitted ||
      staleMessage ||
      !gate
    ) {
      return;
    }

    submitLockRef.current = true;
    setSubmitError(null);
    void form.handleSubmit(
      ({ justification }) => {
        setPendingAction(action);
        resolve.mutate({
          id: gate.id,
          data: {
            action,
            note: justification.trim(),
          },
        });
      },
      () => {
        submitLockRef.current = false;
      },
    )();
  };

  if (!gate) return null;

  const actionInProgress =
    resolve.isPending || pendingAction !== null || !!staleMessage;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border-border/70 bg-card/95 shadow-2xl backdrop-blur-xl sm:max-w-xl"
        data-testid="dialog-quote-discount-approval"
        onEscapeKeyDown={(event) => {
          if (resolve.isPending || submitLockRef.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (resolve.isPending || submitLockRef.current) event.preventDefault();
        }}
      >
        <DialogHeader className="text-left">
          <div className="mb-1 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-600">
              <ShieldCheck className="h-3.5 w-3.5" />
              Pending decision
            </span>
          </div>
          <DialogTitle className="text-xl tracking-tight text-foreground">
            Quote discount approval
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
            Review the request and financial impact before recording your
            decision.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form className="space-y-5" onSubmit={(event) => event.preventDefault()}>
            <div
              className="rounded-xl border border-border/60 bg-foreground/[0.025] p-4"
              data-testid="text-approval-summary"
            >
              <p className="text-sm leading-relaxed text-foreground">
                {gate.summary}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Detail
                icon={FileText}
                label="Quote"
                value={quoteReference}
                testId="text-gate-quote"
              />
              <Detail
                icon={Clock3}
                label="Requested"
                value={requestDateLabel}
                testId="text-gate-date"
              />
              <Detail
                icon={UserRound}
                label="Requested by"
                value={requester}
                testId="text-gate-requester"
              />
              <Detail
                icon={UserRound}
                label="Customer"
                value={gate.customerName?.trim() || "Not recorded"}
                testId="text-gate-customer"
              />
            </div>

            <div className="rounded-xl border-l-2 border-primary/50 bg-primary/[0.04] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary">
                Why this was requested
              </p>
              <p
                className="mt-1 text-sm leading-relaxed text-foreground"
                data-testid="text-gate-reason"
              >
                {requestReason}
              </p>
            </div>

            <div className="space-y-2.5 rounded-xl border border-border/60 bg-foreground/[0.03] p-4">
              <MoneyLine
                label="Current quote total"
                value={quoteTotal}
                money={money.gyd}
                testId="text-original-total"
              />
              <MoneyLine
                label="Requested discount"
                value={requestedDiscount}
                money={money.gyd}
                testId="text-requested-discount"
                negative
              />
              <div className="h-px bg-border/80" />
              <MoneyLine
                label="Resulting quote total"
                value={resultingTotal}
                money={money.gyd}
                testId="text-resulting-total"
                emphasized
              />
            </div>

            <FormField
              control={form.control}
              name="justification"
              rules={{
                validate: (value) =>
                  value.trim().length > 0 ||
                  "Add a justification before recording this decision.",
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Decision justification</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={4}
                      placeholder="Explain why this request should be approved or rejected…"
                      className="resize-none bg-background/50"
                      disabled={
                        !canDecide || resolve.isPending || !!staleMessage
                      }
                      data-testid="input-justification"
                    />
                  </FormControl>
                  <FormDescription>
                    Required for the approval audit history.
                  </FormDescription>
                  <FormMessage data-testid="error-justification" />
                </FormItem>
              )}
            />

            {!canDecide && (
              <div
                className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-sm text-muted-foreground"
                data-testid="status-approval-read-only"
              >
                You can review this request, but your role cannot approve or
                reject it.
              </div>
            )}
            {staleMessage && (
              <div
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-700"
                data-testid="status-approval-stale"
                role="status"
              >
                {staleMessage}
              </div>
            )}
            {submitError && (
              <div
                className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-sm text-destructive"
                data-testid="error-approval-submit"
                role="alert"
              >
                {submitError}
              </div>
            )}

            <DialogFooter className="gap-2 border-t border-border/50 pt-4 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                disabled={resolve.isPending}
                data-testid="button-close-discount-dialog"
              >
                Close
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleDecision("dismiss")}
                disabled={actionInProgress || !canReject}
                data-testid="button-reject-discount"
                className="gap-2 rounded-full px-5"
              >
                {pendingAction === "dismiss" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                {pendingAction === "dismiss" ? "Rejecting…" : "Reject"}
              </Button>
              <Button
                type="button"
                onClick={() => handleDecision("approve")}
                disabled={actionInProgress || !canApprove}
                data-testid="button-approve-discount"
                className="gap-2 rounded-full px-5 shadow-lg shadow-primary/20"
              >
                {pendingAction === "approve" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {pendingAction === "approve" ? "Approving…" : "Approve"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: typeof FileText;
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="rounded-xl border border-border/50 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p
        className="mt-1.5 truncate text-sm font-semibold text-foreground"
        data-testid={testId}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function MoneyLine({
  label,
  value,
  money,
  testId,
  negative = false,
  emphasized = false,
}: {
  label: string;
  value: number | null;
  money: (value: number) => string;
  testId: string;
  negative?: boolean;
  emphasized?: boolean;
}) {
  const display =
    value == null ? "Not available" : `${negative ? "− " : ""}${money(value)}`;
  return (
    <div
      className={`flex items-center justify-between gap-4 ${
        emphasized ? "text-base font-bold" : "text-sm"
      }`}
    >
      <span
        className={
          negative
            ? "font-medium text-destructive"
            : emphasized
              ? "text-foreground"
              : "text-muted-foreground"
        }
      >
        {label}
      </span>
      <span
        className={
          negative && value != null
            ? "font-semibold text-destructive"
            : "font-semibold text-foreground"
        }
        data-testid={testId}
      >
        {display}
      </span>
    </div>
  );
}
