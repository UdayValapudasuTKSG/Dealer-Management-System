import { useState } from "react";
import { Link } from "wouter";
import {
  useResolveGate,
  useCreatePayment,
  getListGatesQueryKey,
  getListTimelineQueryKey,
  getGetCustomerOverviewQueryKey,
  getListInvoicesQueryKey,
  getListDealsQueryKey,
  getListBookingsQueryKey,
  type Gate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useMoney } from "@/lib/format";
import { motion } from "framer-motion";
import {
  Loader2,
  ShieldAlert,
  Check,
  SlidersHorizontal,
  X,
  ArrowUpRight,
  Sparkles,
  Banknote,
} from "lucide-react";

export const GATE_LABEL: Record<string, string> = {
  below_floor_price: "Pricing Floor",
  credit_decline: "Credit Decision",
  capital_order: "Capital Order",
  gra_filing: "GRA Filing",
  refund_release: "Refund Release",
  stage_advance: "Stage Advance",
};

const PRIORITY_META: Record<
  string,
  { rail: string; dot: string; chip: string; label: string }
> = {
  high: {
    rail: "bg-primary",
    dot: "bg-primary",
    chip: "bg-primary/10 text-primary",
    label: "High priority",
  },
  normal: {
    rail: "bg-amber-400",
    dot: "bg-amber-500",
    chip: "bg-amber-500/10 text-amber-600",
    label: "Normal priority",
  },
  low: {
    rail: "bg-white/15",
    dot: "bg-muted-foreground/50",
    chip: "bg-white/[0.05] text-muted-foreground",
    label: "Low priority",
  },
};

export function GateCard({
  gate,
  label,
  showCustomerLink = true,
  onResolved,
}: {
  gate: Gate;
  label?: string;
  showCustomerLink?: boolean;
  onResolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const money = useMoney();
  const [adjusting, setAdjusting] = useState(false);
  const [adjustValue, setAdjustValue] = useState(
    gate.amount ? String(gate.amount) : "",
  );

  const resolve = useResolveGate({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListGatesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTimelineQueryKey() });
        if (gate.customerId != null) {
          queryClient.invalidateQueries({
            queryKey: getGetCustomerOverviewQueryKey(gate.customerId),
          });
        }
        const verb =
          variables.data.action === "approve"
            ? "approved"
            : variables.data.action === "adjust"
              ? "adjusted and approved"
              : "dismissed";
        toast({
          title: `Decision ${verb}`,
          description: "The connected process has been advanced.",
        });
        onResolved?.();
      },
      onError: () => {
        toast({
          title: "Could not record the decision",
          description: "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const recordRefund = useCreatePayment({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListGatesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTimelineQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDealsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
        toast({
          title: "Refund recorded",
          description:
            "The refund has been posted to the ledger and the customer has been notified by email.",
        });
        onResolved?.();
      },
      onError: (err) => {
        const detail =
          (err as { response?: { data?: { error?: string; unmet?: string[] } } })
            ?.response?.data;
        toast({
          title: "Could not record the refund",
          description: detail?.unmet?.[0] ?? detail?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  // L9: an approved refund_release gate is executed by finance as a negative
  // payment against the reservation invoice, linked back to this gate.
  const isApprovedRefund =
    gate.type === "refund_release" &&
    (gate.status === "approved" || gate.status === "adjusted");
  const refundInvoiceId = Number(
    gate.evidence.find((e) => e.label === "Invoice ID")?.value ?? "",
  );
  const refundAmount = gate.amount ?? 0;

  const meta = PRIORITY_META[gate.priority] ?? PRIORITY_META.normal;
  const evidence = gate.evidence.slice(0, 4);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
    >
      <Card className="group relative overflow-hidden border-none bg-white/[0.04] backdrop-blur-2xl shadow-[0_4px_24px_rgba(0,0,0,0.04)] hover:shadow-[0_16px_48px_rgba(0,0,0,0.08)] transition-shadow duration-300 rounded-2xl">
        {/* Priority rail */}
        <div className={`absolute left-0 top-0 bottom-0 w-1 ${meta.rail}`} />

        <div className="p-5 md:p-6 pl-6 md:pl-7">
          {/* Header */}
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                {label && (
                  <span className="text-[11px] font-bold uppercase tracking-widest text-primary">
                    {label}
                  </span>
                )}
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${meta.chip}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                  {gate.priority}
                </span>
              </div>
              <h3 className="text-lg md:text-xl font-semibold leading-snug tracking-tight">
                {gate.title}
              </h3>
              {showCustomerLink && gate.customerId && gate.customerName && (
                <Link
                  href={`/customers/${gate.customerId}`}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors mt-1"
                >
                  {gate.customerName}
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>
          </div>

          {/* Decision question / summary */}
          <p className="text-sm text-muted-foreground leading-relaxed mt-4">
            {gate.summary}
          </p>

          {/* Evidence — compact stat tiles */}
          {evidence.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">
              {evidence.map((item, i) => (
                <div
                  key={i}
                  className="rounded-xl bg-white/[0.03] px-3 py-2.5 min-w-0"
                >
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">
                    {item.label}
                  </div>
                  <div className="text-sm font-semibold mt-0.5 tracking-tight truncate">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recommendation — slim inline callout */}
          {gate.recommendation && (
            <div className="mt-4 flex items-start gap-2.5 rounded-xl border-l-2 border-primary/40 bg-primary/[0.04] px-3.5 py-2.5">
              <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <div>
                <span className="text-[11px] font-bold uppercase tracking-widest text-primary mr-1.5">
                  Recommended
                </span>
                <span className="text-sm leading-relaxed">
                  {gate.recommendation}
                </span>
              </div>
            </div>
          )}

          {/* Adjust input */}
          {adjusting && (
            <div className="mt-4 flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">GYD</span>
              <Input
                type="number"
                value={adjustValue}
                onChange={(e) => setAdjustValue(e.target.value)}
                placeholder="Adjusted amount"
                className="max-w-[220px] h-10 rounded-xl"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 mt-5">
            {isApprovedRefund ? (
              <>
                <Button
                  disabled={
                    recordRefund.isPending ||
                    !Number.isFinite(refundInvoiceId) ||
                    refundInvoiceId <= 0 ||
                    refundAmount <= 0
                  }
                  onClick={() =>
                    recordRefund.mutate({
                      data: {
                        invoiceId: refundInvoiceId,
                        amount: -Math.abs(refundAmount),
                        method: "bank_transfer",
                        gateId: gate.id,
                      },
                    })
                  }
                  className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-10 gap-2 shadow-lg shadow-primary/20"
                >
                  {recordRefund.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Banknote className="w-4 h-4" />
                  )}
                  Record refund of {money.gyd(Math.abs(refundAmount))}
                </Button>
                {(!Number.isFinite(refundInvoiceId) || refundInvoiceId <= 0) && (
                  <span className="text-xs text-muted-foreground">
                    No invoice on file — record this refund from the Finance
                    ledger manually.
                  </span>
                )}
              </>
            ) : adjusting ? (
              <>
                <Button
                  disabled={resolve.isPending || adjustValue === ""}
                  onClick={() =>
                    resolve.mutate({
                      id: gate.id,
                      data: {
                        action: "adjust",
                        adjustedAmount: Number(adjustValue),
                      },
                    })
                  }
                  className="bg-primary hover:bg-primary/90 text-white rounded-full px-5 h-10 gap-2"
                >
                  {resolve.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  Approve at {money.gyd(Number(adjustValue || 0))}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setAdjusting(false)}
                  className="rounded-full px-4 h-10 text-muted-foreground"
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate({
                      id: gate.id,
                      data: { action: "approve" },
                    })
                  }
                  className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-10 gap-2 shadow-lg shadow-primary/20"
                >
                  {resolve.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  Approve
                </Button>
                {gate.amount != null && (
                  <Button
                    variant="ghost"
                    disabled={resolve.isPending}
                    onClick={() => setAdjusting(true)}
                    className="rounded-full px-4 h-10 gap-2 text-foreground hover:bg-white/[0.05]"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                    Adjust
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate({
                      id: gate.id,
                      data: { action: "dismiss" },
                    })
                  }
                  className="rounded-full px-4 h-10 gap-2 text-muted-foreground hover:text-foreground ml-auto"
                >
                  <X className="w-4 h-4" />
                  Dismiss
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
