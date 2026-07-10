import { useState } from "react";
import { Link } from "wouter";
import {
  useListGates,
  useResolveGate,
  getListGatesQueryKey,
  getListTimelineQueryKey,
  getGetCustomerOverviewQueryKey,
  type Gate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2,
  ShieldAlert,
  Check,
  SlidersHorizontal,
  X,
  ChevronRight,
} from "lucide-react";

const GATE_LABEL: Record<string, string> = {
  below_floor_price: "Pricing Floor",
  credit_decline: "Credit Decision",
  capital_order: "Capital Order",
  gra_filing: "GRA Filing",
  refund_release: "Refund Release",
};

export default function Approvals() {
  const { data: gates, isLoading } = useListGates({ status: "pending" });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <div>
        <h1 className="text-4xl font-light tracking-tight mb-2">
          Decision <span className="font-semibold">Gates</span>
        </h1>
        <p className="text-muted-foreground text-lg">
          The concierge runs everything else. These are the moments that need a
          human.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : !gates || gates.length === 0 ? (
        <Card className="glass-panel border-none shadow-lg">
          <CardContent className="p-16 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
              <Check className="w-7 h-7" />
            </div>
            <p className="text-lg font-medium">All clear</p>
            <p className="text-muted-foreground">
              No decisions are waiting. The concierge has the rest handled.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <AnimatePresence mode="popLayout">
            {gates.map((gate) => (
              <GateCard key={gate.id} gate={gate} label={GATE_LABEL[gate.type]} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function GateCard({ gate, label }: { gate: Gate; label?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
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

  const priorityColor =
    gate.priority === "high"
      ? "bg-primary/10 text-primary"
      : gate.priority === "low"
        ? "bg-black/5 text-muted-foreground"
        : "bg-amber-500/10 text-amber-600";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
    >
      <Card className="glass-panel border-none shadow-lg overflow-hidden">
        <CardContent className="p-0">
          <div className="p-6 md:p-8 bg-white/40">
            <div className="flex items-start gap-4 mb-6">
              <div className="w-11 h-11 rounded-full bg-primary text-white flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  {label && (
                    <span className="text-xs font-bold uppercase tracking-widest text-primary">
                      {label}
                    </span>
                  )}
                  <Badge
                    className={`rounded-full text-[10px] uppercase tracking-widest ${priorityColor}`}
                    variant="secondary"
                  >
                    {gate.priority} priority
                  </Badge>
                </div>
                <h3 className="text-xl font-semibold leading-tight">
                  {gate.title}
                </h3>
                {gate.customerId && gate.customerName && (
                  <Link
                    href={`/customers/${gate.customerId}`}
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors mt-1"
                  >
                    {gate.customerName}
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>
            </div>

            <p className="text-muted-foreground leading-relaxed mb-6">
              {gate.summary}
            </p>

            {/* Evidence pack */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 mb-6">
              {gate.evidence.map((item, i) => (
                <div
                  key={i}
                  className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-2"
                >
                  <span className="text-xs uppercase tracking-widest text-muted-foreground shrink-0">
                    {item.label}
                  </span>
                  <span className="text-sm font-medium text-right">
                    {item.value}
                  </span>
                </div>
              ))}
            </div>

            {gate.recommendation && (
              <div className="rounded-2xl bg-primary/5 border border-primary/10 p-4 mb-6">
                <div className="text-xs font-bold uppercase tracking-widest text-primary mb-1">
                  Recommendation
                </div>
                <p className="text-sm leading-relaxed">{gate.recommendation}</p>
              </div>
            )}

            {adjusting && (
              <div className="mb-4 flex items-center gap-3">
                <span className="text-sm font-medium text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  value={adjustValue}
                  onChange={(e) => setAdjustValue(e.target.value)}
                  placeholder="Adjusted amount"
                  className="max-w-[220px]"
                />
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {adjusting ? (
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
                    className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
                  >
                    {resolve.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    Approve at ${Number(adjustValue || 0).toLocaleString()}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setAdjusting(false)}
                    className="rounded-full px-6"
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
                    className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 gap-2"
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
                      variant="outline"
                      disabled={resolve.isPending}
                      onClick={() => setAdjusting(true)}
                      className="rounded-full px-6 gap-2"
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
                    className="rounded-full px-6 gap-2 text-muted-foreground"
                  >
                    <X className="w-4 h-4" />
                    Dismiss
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
