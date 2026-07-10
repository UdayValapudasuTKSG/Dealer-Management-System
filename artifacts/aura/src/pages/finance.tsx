import { useListFinanceApplications } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Building, FileText, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Finance() {
  const { data: apps, isLoading } = useListFinanceApplications();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Finance & Insurance</h1>
          <p className="text-muted-foreground">Manage credit applications and F&I products</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          New Application
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          [...Array(6)].map((_, i) => <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />)
        ) : (
          apps?.map((app) => (
            <Card key={app.id} className="hover-elevate transition-all border-border relative overflow-hidden">
              <div className={`absolute top-0 inset-x-0 h-1 ${app.status === 'approved' ? 'bg-emerald-500' : 'bg-primary'}`} />
              <CardContent className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-bold text-lg">{app.customerName}</h3>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
                      <Building className="w-3 h-3" />
                      {app.lender || 'Pending Lender'}
                    </div>
                  </div>
                  <Badge variant="secondary" className="capitalize">
                    {app.status.replace('_', ' ')}
                  </Badge>
                </div>
                
                <div className="grid grid-cols-3 gap-4 py-4 border-y border-border/50 mb-4">
                  <div>
                    <div className="text-xs text-muted-foreground">Amount</div>
                    <div className="font-bold">${app.amount.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Term</div>
                    <div className="font-bold">{app.termMonths} mo</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">APR</div>
                    <div className="font-bold text-primary">{app.apr}%</div>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground">
                  <div className="mb-2 font-semibold">Protection Products:</div>
                  <div className="flex flex-wrap gap-1">
                    {app.protectionProducts.length > 0 ? (
                      app.protectionProducts.map(p => (
                        <span key={p} className="bg-secondary px-2 py-1 rounded-md">{p}</span>
                      ))
                    ) : (
                      <span>None selected</span>
                    )}
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