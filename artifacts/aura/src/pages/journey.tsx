import { useState } from "react";
import { useListLeads, useListActivity, useListVehicles } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, ArrowRight, User, Car, Zap, CheckCircle2, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatDistanceToNow } from "date-fns";

const PHASES = ["aware", "consider", "engage", "negotiate", "won", "lost"] as const;

export default function Journey() {
  const { data: leads, isLoading: isLoadingLeads } = useListLeads();
  const { data: activities } = useListActivity({ limit: 10 });
  const { data: vehicles } = useListVehicles();
  const [selectedPhase, setSelectedPhase] = useState<string>("engage");

  const leadsInPhase = leads?.filter(l => l.phase === selectedPhase) || [];

  const getNextStep = (lead: any) => {
    if (lead.phase === "aware") {
      return `Concierge is drafting a personalized welcome message referencing their interest via ${lead.channel}.`;
    }
    if (lead.phase === "consider") {
      const vehicle = vehicles?.find(v => v.id === lead.interestedVehicleId);
      return vehicle 
        ? `Preparing a bespoke digital brochure for the ${vehicle.make} ${vehicle.model}.` 
        : `Gathering preferences to match with available inventory.`;
    }
    if (lead.phase === "engage") {
      return lead.aiScore > 80 
        ? `High intent detected (${lead.aiScore}/100). Scheduling priority test drive.` 
        : `Nurturing with recent dealership events and luxury lifestyle content.`;
    }
    if (lead.phase === "negotiate") {
      return `Finance team structuring bespoke terms for ${lead.assignedTo || 'Specialist'} to present.`;
    }
    if (lead.phase === "won") {
      return `Choreographing delivery experience. Vehicle detailing initiated.`;
    }
    return `Reviewing lost reason for future re-engagement.`;
  };

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      <div className="absolute inset-0 z-0">
        <video 
          autoPlay 
          muted 
          loop 
          playsInline 
          className="w-full h-full object-cover opacity-[0.15] mix-blend-multiply"
        >
          <source src={`${import.meta.env.BASE_URL}videos/white_luxury_car_showroom_turntable.mp4`} type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />
      </div>

      <div className="relative z-10 p-8 flex-1 flex flex-col">
        <div className="mb-12 text-center">
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl font-light tracking-tight mb-3"
          >
            The <span className="font-semibold text-primary">Journey</span>
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-muted-foreground max-w-2xl mx-auto"
          >
            Watch the invisible concierge choreograph every client interaction in real-time.
          </motion.p>
        </div>

        <div className="flex justify-center mb-12">
          <div className="flex items-center glass-panel rounded-full p-2 max-w-4xl w-full mx-auto overflow-x-auto">
            {PHASES.map((phase, i) => (
              <button
                key={phase}
                onClick={() => setSelectedPhase(phase)}
                className={`relative flex-1 py-3 px-6 text-sm font-medium uppercase tracking-widest transition-all duration-500 rounded-full ${
                  selectedPhase === phase ? "text-white" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {selectedPhase === phase && (
                  <motion.div 
                    layoutId="activePhase"
                    className="absolute inset-0 bg-primary rounded-full -z-10 shadow-lg shadow-primary/30"
                  />
                )}
                <span className="relative z-10">{phase}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto max-w-5xl mx-auto w-full px-4 pb-24 space-y-6">
          <AnimatePresence mode="popLayout">
            {isLoadingLeads ? (
              <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
            ) : leadsInPhase.length === 0 ? (
              <motion.div 
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center py-20 text-muted-foreground font-light"
              >
                No active journeys in this phase.
              </motion.div>
            ) : (
              leadsInPhase.map((lead, i) => (
                <motion.div
                  key={lead.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: i * 0.1 }}
                >
                  <Card className="glass-panel border-none shadow-lg overflow-hidden group">
                    <CardContent className="p-0">
                      <div className="flex flex-col md:flex-row">
                        <div className="p-6 md:w-1/3 border-b md:border-b-0 md:border-r border-border/40 bg-white/40">
                          <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                              <User className="w-5 h-5" />
                            </div>
                            <div>
                              <h3 className="font-semibold text-lg">{lead.name}</h3>
                              <p className="text-xs text-muted-foreground uppercase tracking-wider">{lead.channel} lead</p>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Intent Score</span>
                              <span className="font-medium text-primary">{lead.aiScore}/100</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Status</span>
                              <span className="font-medium capitalize">{lead.status}</span>
                            </div>
                          </div>
                        </div>
                        <div className="p-6 md:w-2/3 flex flex-col justify-center bg-gradient-to-r from-transparent to-white/20">
                          <div className="flex items-start gap-4">
                            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white shrink-0 mt-1 shadow-md shadow-primary/20">
                              <Zap className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-2">Choreographed Next Step</h4>
                              <p className="text-lg font-light leading-relaxed">
                                {getNextStep(lead)}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}