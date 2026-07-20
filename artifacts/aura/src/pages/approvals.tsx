import { useListGates } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { AnimatePresence } from "framer-motion";
import { Loader2, Check, Layers, Flame, ShieldCheck, TriangleAlert } from "lucide-react";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page } from "@/components/layout/page";

const APPROVAL_TYPES = new Set([
  "below_floor_price",
  "capital_order",
  "refund_release",
]);

export default function Approvals() {
  const { data: gates, isLoading } = useListGates({ status: "pending" });

  const total = gates?.length ?? 0;
  const highCount = gates?.filter((g) => g.priority === "high").length ?? 0;
  const approvals = (gates ?? []).filter((g) => APPROVAL_TYPES.has(g.type));
  const exceptions = (gates ?? []).filter((g) => !APPROVAL_TYPES.has(g.type));

  return (
    <Page>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-5">
        <div>
          <h1 className="text-2xl md:text-[1.75rem] font-light tracking-tight leading-tight">
            <span className="font-semibold">Reviews</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-light max-w-xl">
            The moments that need a human — everything else runs itself.
          </p>
        </div>

        {total > 0 && (
          <div className="flex gap-3">
            <div className="rounded-2xl bg-white/[0.04] backdrop-blur-xl border border-white/10 px-5 py-3 shadow-sm">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                <Layers className="w-3.5 h-3.5" /> Awaiting
              </div>
              <div className="text-2xl font-semibold tracking-tight mt-0.5">
                {total}
              </div>
            </div>
            <div className="rounded-2xl bg-primary/5 border border-primary/10 px-5 py-3 shadow-sm">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-primary">
                <Flame className="w-3.5 h-3.5" /> High priority
              </div>
              <div className="text-2xl font-semibold tracking-tight mt-0.5 text-primary">
                {highCount}
              </div>
            </div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : !gates || gates.length === 0 ? (
        <Card className="glass-panel border-none shadow-lg rounded-3xl">
          <CardContent className="p-16 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
              <Check className="w-7 h-7" />
            </div>
            <p className="text-lg font-medium">All clear</p>
            <p className="text-muted-foreground">
              Nothing is waiting on you. AURA has the rest handled.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {approvals.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
                <ShieldCheck className="w-4 h-4 text-primary" />
                Needs your approval
                <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-bold tabular-nums">
                  {approvals.length}
                </span>
              </div>
              <div className="space-y-5">
                <AnimatePresence mode="popLayout">
                  {approvals.map((gate) => (
                    <GateCard
                      key={gate.id}
                      gate={gate}
                      label={GATE_LABEL[gate.type]}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}
          {exceptions.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
                <TriangleAlert className="w-4 h-4 text-amber-400" />
                Exceptions
                <span className="rounded-full bg-amber-400/10 text-amber-400 px-2 py-0.5 text-[10px] font-bold tabular-nums">
                  {exceptions.length}
                </span>
              </div>
              <div className="space-y-5">
                <AnimatePresence mode="popLayout">
                  {exceptions.map((gate) => (
                    <GateCard
                      key={gate.id}
                      gate={gate}
                      label={GATE_LABEL[gate.type]}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}
