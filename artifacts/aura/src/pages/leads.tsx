import { useListLeads } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare, Phone, Mail, User } from "lucide-react";

export default function Leads() {
  const { data: leads, isLoading } = useListLeads();

  const phases = ["aware", "consider", "engage", "negotiate", "won"];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Leads & Pipeline</h1>
          <p className="text-muted-foreground">Track customer interest across the journey</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          New Lead
        </Button>
      </div>

      <div className="flex gap-6 overflow-x-auto pb-4 flex-1">
        {phases.map((phase) => (
          <div key={phase} className="min-w-[300px] flex-1 flex flex-col bg-secondary/30 rounded-xl p-4 border border-border/50">
            <h3 className="font-semibold text-sm uppercase tracking-wider mb-4 text-muted-foreground flex items-center justify-between">
              {phase}
              <span className="bg-white px-2 py-0.5 rounded-full text-xs text-foreground shadow-sm">
                {leads?.filter(l => l.phase === phase).length || 0}
              </span>
            </h3>
            
            <div className="space-y-3 flex-1 overflow-y-auto pr-2">
              {isLoading ? (
                [1, 2].map((i) => <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />)
              ) : leads?.filter((l) => l.phase === phase).map((lead) => (
                <Card key={lead.id} className="cursor-pointer hover-elevate border-border/50 shadow-sm transition-all hover:shadow-md">
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div className="font-semibold text-foreground flex items-center gap-2">
                        <User className="w-4 h-4 text-muted-foreground" />
                        {lead.name}
                      </div>
                      {lead.aiScore && (
                        <div className={`text-xs font-bold px-2 py-1 rounded ${lead.aiScore > 80 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                          {lead.aiScore} AI
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3">
                      {lead.email && <div className="flex items-center gap-1"><Mail className="w-3 h-3" /> Email</div>}
                      {lead.phone && <div className="flex items-center gap-1"><Phone className="w-3 h-3" /> Phone</div>}
                      <div className="flex items-center gap-1"><MessageSquare className="w-3 h-3" /> {lead.channel}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}