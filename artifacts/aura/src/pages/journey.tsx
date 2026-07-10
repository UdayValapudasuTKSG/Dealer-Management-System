import { Card, CardContent } from "@/components/ui/card";
import { Route as RouteIcon, Cpu, Zap, CircleDot, ShieldCheck, Banknote } from "lucide-react";

export default function Journey() {
  const phases = [
    { name: "Aware", agent: "Analyst", icon: CircleDot, desc: "Market & ads optimization" },
    { name: "Consider", agent: "Concierge", icon: Zap, desc: "Answers questions instantly" },
    { name: "Engage", agent: "Concierge", icon: ShieldCheck, desc: "Captures lead details" },
    { name: "Evaluate", agent: "Inventory", icon: ShieldCheck, desc: "Matches stock to needs" },
    { name: "Negotiate", agent: "Sales", icon: Banknote, desc: "Desks the perfect deal" },
    { name: "Finance", agent: "F&I", icon: Banknote, desc: "Approves credit in seconds" },
    { name: "Commit", agent: "Ledger", icon: ShieldCheck, desc: "Processes deposit & docs" },
    { name: "Prepare", agent: "Parts", icon: ShieldCheck, desc: "Preps accessories" },
    { name: "Receive", agent: "Customs", icon: Zap, desc: "Handles delivery flow" },
    { name: "Own", agent: "Service", icon: ShieldCheck, desc: "Predicts maintenance" },
    { name: "Win-back", agent: "Retention", icon: CircleDot, desc: "Triggers upgrade offer" },
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-6xl mx-auto">
      <div className="text-center py-12 px-4 bg-gradient-to-b from-primary/5 to-transparent rounded-3xl border border-primary/10">
        <div className="inline-flex items-center justify-center p-3 bg-white rounded-2xl shadow-sm border border-border mb-6">
          <RouteIcon className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">The Intelligent Journey</h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          11 phases. 12 agents. 1 seamless experience. AURA manages the entire customer lifecycle autonomously.
        </p>
      </div>

      <div className="relative mt-16">
        {/* Connecting line */}
        <div className="absolute top-1/2 left-0 right-0 h-1 bg-gradient-to-r from-primary/20 via-primary/50 to-primary/20 -translate-y-1/2 rounded-full hidden md:block" />
        
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-6 relative">
          {phases.map((phase, idx) => (
            <Card key={idx} className="relative bg-white/80 backdrop-blur border-border/50 shadow-sm hover-elevate transition-all group overflow-hidden">
              <div className="absolute inset-x-0 top-0 h-1 bg-primary transform origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-300" />
              <CardContent className="p-5 flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4 group-hover:bg-primary/10 transition-colors">
                  <phase.icon className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <h3 className="font-bold text-lg mb-1">{phase.name}</h3>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-primary bg-primary/5 px-2.5 py-1 rounded-full mb-3">
                  <Cpu className="w-3 h-3" />
                  {phase.agent}
                </div>
                <p className="text-sm text-muted-foreground leading-snug">
                  {phase.desc}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}