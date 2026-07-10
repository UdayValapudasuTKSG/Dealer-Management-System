import { useListAgents } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Cpu, Activity, CheckCircle, Clock } from "lucide-react";

export default function Agents() {
  const { data: agents, isLoading } = useListAgents();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI Agent Fleet</h1>
        <p className="text-muted-foreground">Manage and monitor the autonomous dealership agents</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          [...Array(6)].map((_, i) => <div key={i} className="h-[200px] bg-muted rounded-xl animate-pulse" />)
        ) : (
          agents?.map((agent) => (
            <Card key={agent.id} className="relative overflow-hidden group hover-elevate transition-all border-border">
              <div className={`absolute top-0 left-0 w-1 h-full ${agent.status === 'active' ? 'bg-primary' : 'bg-muted'}`} />
              <CardContent className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-xl ${agent.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                      <Cpu className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-lg leading-none">{agent.name}</h3>
                      <p className="text-sm text-muted-foreground mt-1">{agent.domain}</p>
                    </div>
                  </div>
                  <Switch checked={agent.status === 'active'} />
                </div>
                
                <p className="text-sm text-muted-foreground mb-6 line-clamp-2">
                  {agent.description}
                </p>

                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border/50">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      <Activity className="w-3 h-3" /> Tasks Today
                    </div>
                    <div className="font-bold text-xl">{agent.tasksToday.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Success Rate
                    </div>
                    <div className="font-bold text-xl text-emerald-600">{agent.successRate.toFixed(1)}%</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}