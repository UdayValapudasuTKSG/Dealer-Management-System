import { useListGates } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { AnimatePresence } from "framer-motion";
import { Loader2, Check, ShieldCheck, Layers, Flame } from "lucide-react";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page } from "@/components/layout/page";

export default function Approvals() {
  const { data: gates, isLoading } = useListGates({ status: "pending" });

  const total = gates?.length ?? 0;
  const highCount = gates?.filter((g) => g.priority === "high").length ?? 0;

  return (
    <Page width="narrow">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between mb-10">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 text-primary px-3 py-1 text-[11px] font-bold uppercase tracking-widest mb-4">
            <ShieldCheck className="w-3.5 h-3.5" />
            The never-list
          </div>
          <h1 className="text-4xl md:text-5xl font-light tracking-tight leading-[1.05]">
            Decision <span className="font-semibold">Gates</span>
          </h1>
          <p className="text-muted-foreground text-lg mt-3 font-light max-w-xl">
            The concierge runs everything else. These are the moments that need a
            human.
          </p>
        </div>

        {total > 0 && (
          <div className="flex gap-3">
            <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/60 px-5 py-3 shadow-sm">
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
              No decisions are waiting. The concierge has the rest handled.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          <AnimatePresence mode="popLayout">
            {gates.map((gate) => (
              <GateCard key={gate.id} gate={gate} label={GATE_LABEL[gate.type]} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </Page>
  );
}
