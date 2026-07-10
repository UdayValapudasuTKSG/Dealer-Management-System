import { useListDeals } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Briefcase } from "lucide-react";

export default function Deals() {
  const { data: deals, isLoading } = useListDeals();

  const stages = ["desking", "negotiation", "finance", "committed", "delivered"];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Active Deals</h1>
          <p className="text-muted-foreground">Desk deals and manage negotiations</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          Desk New Deal
        </Button>
      </div>

      <div className="flex gap-6 overflow-x-auto pb-4 flex-1">
        {stages.map((stage) => (
          <div key={stage} className="min-w-[320px] flex-1 flex flex-col bg-secondary/30 rounded-xl p-4 border border-border/50">
            <h3 className="font-semibold text-sm uppercase tracking-wider mb-4 text-muted-foreground flex items-center justify-between">
              {stage}
              <span className="bg-white px-2 py-0.5 rounded-full text-xs text-foreground shadow-sm">
                {deals?.filter(d => d.stage === stage).length || 0}
              </span>
            </h3>
            
            <div className="space-y-3 flex-1 overflow-y-auto pr-2">
              {isLoading ? (
                [1].map((i) => <div key={i} className="h-32 bg-muted rounded-lg animate-pulse" />)
              ) : deals?.filter((d) => d.stage === stage).map((deal) => (
                <Card key={deal.id} className="cursor-pointer hover-elevate border-border/50 shadow-sm transition-all hover:border-primary/30">
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-3">
                      <div className="font-semibold text-foreground truncate">
                        {deal.customerName || "Unknown Customer"}
                      </div>
                      <div className="font-bold text-primary">
                        ${deal.otdPrice.toLocaleString()}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground space-y-1">
                      <div className="flex justify-between">
                        <span>Price</span>
                        <span>${deal.vehiclePrice.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-destructive">
                        <span>Discount</span>
                        <span>-${deal.discount.toLocaleString()}</span>
                      </div>
                      {deal.monthlyPayment && (
                        <div className="flex justify-between font-medium text-foreground pt-2 mt-2 border-t border-border/50">
                          <span>Monthly</span>
                          <span>${deal.monthlyPayment}/mo</span>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {deals?.filter((d) => d.stage === stage).length === 0 && (
                <div className="flex flex-col items-center justify-center h-24 text-muted-foreground text-sm border-2 border-dashed border-border rounded-lg">
                  No deals
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}