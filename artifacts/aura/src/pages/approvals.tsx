import { useListGates } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { AnimatePresence } from "framer-motion";
import { Loader2, Check } from "lucide-react";
import { GateCard, GATE_LABEL } from "@/components/gate-card";

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
