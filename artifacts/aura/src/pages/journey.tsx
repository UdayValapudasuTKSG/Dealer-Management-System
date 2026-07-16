import { useState } from "react";
import { Link } from "wouter";
import { useListLeads, useListVehicles } from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, User, Zap, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Car } from "lucide-react";

const PHASES = ["aware", "consider", "engage", "negotiate", "won", "lost"] as const;

const PHASE_LABEL: Record<string, string> = {
  aware: "New Lead",
  consider: "Qualified",
  engage: "Test Drive",
  negotiate: "Desking",
  won: "Sold",
  lost: "Lost",
};

const withBase = (url: string) =>
  `${import.meta.env.BASE_URL}${url.replace(/^\//, "")}`;

export default function Journey() {
  const { data: leads, isLoading: isLoadingLeads } = useListLeads();
  const { data: vehicles } = useListVehicles();
  const [selectedPhase, setSelectedPhase] = useState<string>("engage");

  const leadsInPhase = leads?.filter(l => l.phase === selectedPhase) || [];

  const getNextStep = (lead: any) => {
    if (lead.phase === "aware") {
      return `A personalized welcome is on its way, referencing their interest from ${lead.channel}.`;
    }
    if (lead.phase === "consider") {
      const vehicle = vehicles?.find(v => v.id === lead.interestedVehicleId);
      return vehicle 
        ? `A bespoke brochure for the ${vehicle.make} ${vehicle.model} is being prepared.` 
        : `Preferences are being matched with available inventory.`;
    }
    if (lead.phase === "engage") {
      return `A priority test drive is being arranged around their schedule.`;
    }
    if (lead.phase === "negotiate") {
      return `Bespoke terms are being structured for ${lead.assignedTo || 'the specialist'} to present.`;
    }
    if (lead.phase === "won") {
      return `The delivery experience is underway. Detailing has begun.`;
    }
    return `The relationship is being reviewed for future re-engagement.`;
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

      <div className="relative z-10 px-5 md:px-8 py-10 md:py-14 flex-1 flex flex-col">
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
            Every client relationship, advancing in real time.
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
                <span className="relative z-10">{PHASE_LABEL[phase] ?? phase}</span>
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
              leadsInPhase.map((lead, i) => {
                const vehicle = vehicles?.find(
                  (v) => v.id === lead.interestedVehicleId,
                );
                return (
                <motion.div
                  key={lead.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: i * 0.08 }}
                >
                  <Card className="glass-panel border-none shadow-lg hover:shadow-2xl transition-shadow duration-500 overflow-hidden group">
                    <CardContent className="p-0">
                      <div className="flex flex-col md:flex-row">
                        <div className="p-6 md:w-1/3 border-b md:border-b-0 md:border-r border-white/10 bg-white/[0.03]">
                          <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                              <User className="w-5 h-5" />
                            </div>
                            <div>
                              <h3 className="font-semibold text-lg">{lead.name}</h3>
                              <p className="text-xs text-muted-foreground uppercase tracking-wider">{lead.channel} lead</p>
                            </div>
                          </div>
                          {vehicle && (
                            <div className="mb-4 rounded-2xl overflow-hidden bg-white/[0.03] aspect-[16/9] relative">
                              {vehicle.imageUrl ? (
                                <img
                                  src={withBase(vehicle.imageUrl)}
                                  alt={`${vehicle.make} ${vehicle.model}`}
                                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <Car className="w-8 h-8 text-muted-foreground/30" />
                                </div>
                              )}
                              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/50 to-transparent p-3">
                                <p className="text-xs font-semibold text-white tracking-wide">
                                  {vehicle.make} {vehicle.model}
                                </p>
                              </div>
                            </div>
                          )}
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Channel</span>
                              <span className="font-medium capitalize">{lead.channel}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Status</span>
                              <span className="font-medium capitalize">{lead.status}</span>
                            </div>
                            {lead.customerId && (
                              <Link
                                href={`/customers/${lead.customerId}`}
                                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline pt-1"
                              >
                                View client
                                <ChevronRight className="w-3.5 h-3.5" />
                              </Link>
                            )}
                          </div>
                        </div>
                        <div className="p-6 md:w-2/3 flex flex-col justify-center bg-gradient-to-r from-transparent to-white/[0.02]">
                          <div className="flex items-start gap-4">
                            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white shrink-0 mt-1 shadow-md shadow-primary/20">
                              <Zap className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-2">In Motion</h4>
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
                );
              })
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}