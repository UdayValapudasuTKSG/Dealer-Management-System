import { useListLeads } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare, Phone, Mail, User, Sparkles } from "lucide-react";
import { motion } from "framer-motion";

export default function Leads() {
  const { data: leads, isLoading } = useListLeads();

  const phases = ["aware", "consider", "engage", "negotiate", "won"];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-4xl font-light tracking-tight mb-2">Pipeline <span className="font-semibold">Orchestration</span></h1>
          <p className="text-muted-foreground text-lg">Choreographing the client journey.</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Add Client
        </Button>
      </div>

      <div className="flex gap-6 overflow-x-auto pb-4 flex-1 hide-scrollbar">
        {phases.map((phase, phaseIndex) => (
          <div key={phase} className="min-w-[320px] flex-1 flex flex-col glass-panel rounded-3xl p-5">
            <div className="flex items-center justify-between mb-6 px-2">
              <h3 className="font-semibold text-sm uppercase tracking-widest text-muted-foreground">
                {phase}
              </h3>
              <span className="bg-primary/10 text-primary px-3 py-1 rounded-full text-xs font-bold">
                {leads?.filter(l => l.phase === phase).length || 0}
              </span>
            </div>
            
            <div className="space-y-4 flex-1 overflow-y-auto pr-2 pb-4">
              {isLoading ? (
                [1, 2].map((i) => <div key={i} className="h-32 bg-black/5 rounded-2xl animate-pulse" />)
              ) : leads?.filter((l) => l.phase === phase).map((lead, i) => (
                <motion.div
                  key={lead.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: phaseIndex * 0.1 + i * 0.05 }}
                >
                  <Card className="cursor-pointer border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-2xl bg-white/60 hover:bg-white overflow-hidden group">
                    <CardContent className="p-5">
                      <div className="flex justify-between items-start mb-4">
                        <div className="font-semibold text-lg leading-tight group-hover:text-primary transition-colors">
                          {lead.name}
                        </div>
                        {lead.aiScore && (
                          <div className={`text-xs font-bold px-2.5 py-1 rounded-full flex items-center gap-1 ${lead.aiScore > 80 ? 'bg-primary/10 text-primary' : 'bg-black/5 text-muted-foreground'}`}>
                            <Sparkles className="w-3 h-3" /> {lead.aiScore}
                          </div>
                        )}
                      </div>
                      
                      <div className="flex flex-wrap gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground mt-4 pt-4 border-t border-border/50">
                        {lead.email && <div className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> Email</div>}
                        {lead.phone && <div className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> Phone</div>}
                        <div className="flex items-center gap-1.5 ml-auto text-primary"><MessageSquare className="w-3.5 h-3.5" /> {lead.channel}</div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}