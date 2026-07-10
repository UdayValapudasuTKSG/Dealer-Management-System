import { useListDeals } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Briefcase, FileText } from "lucide-react";
import { motion } from "framer-motion";

export default function Deals() {
  const { data: deals, isLoading } = useListDeals();

  const stages = ["desking", "negotiation", "finance", "committed", "delivered"];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-4xl font-light tracking-tight mb-2">Deal <span className="font-semibold">Structuring</span></h1>
          <p className="text-muted-foreground text-lg">Bespoke negotiation and closing.</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Desk New Deal
        </Button>
      </div>

      <div className="flex gap-6 overflow-x-auto pb-4 flex-1 hide-scrollbar">
        {stages.map((stage, stageIndex) => (
          <div key={stage} className="min-w-[340px] flex-1 flex flex-col glass-panel rounded-3xl p-5">
            <div className="flex items-center justify-between mb-6 px-2">
              <h3 className="font-semibold text-sm uppercase tracking-widest text-muted-foreground">
                {stage}
              </h3>
              <span className="bg-primary/10 text-primary px-3 py-1 rounded-full text-xs font-bold">
                {deals?.filter(d => d.stage === stage).length || 0}
              </span>
            </div>
            
            <div className="space-y-4 flex-1 overflow-y-auto pr-2 pb-4">
              {isLoading ? (
                [1].map((i) => <div key={i} className="h-40 bg-black/5 rounded-2xl animate-pulse" />)
              ) : deals?.filter((d) => d.stage === stage).map((deal, i) => (
                <motion.div
                  key={deal.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: stageIndex * 0.1 + i * 0.05 }}
                >
                  <Card className="cursor-pointer border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-2xl bg-white/60 hover:bg-white overflow-hidden group">
                    <CardContent className="p-5">
                      <div className="flex justify-between items-start mb-4">
                        <div className="font-semibold text-lg leading-tight truncate pr-4">
                          {deal.customerName || "Unknown Customer"}
                        </div>
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <FileText className="w-4 h-4 text-primary" />
                        </div>
                      </div>

                      <div className="font-light text-3xl mb-4 tracking-tight text-primary">
                        ${deal.otdPrice.toLocaleString()}
                      </div>
                      
                      <div className="space-y-2 text-sm font-medium text-muted-foreground pt-4 border-t border-border/50">
                        <div className="flex justify-between items-center">
                          <span className="uppercase tracking-wider text-xs">MSRP</span>
                          <span className="text-foreground">${deal.vehiclePrice.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center text-primary">
                          <span className="uppercase tracking-wider text-xs">Discount</span>
                          <span>-${deal.discount.toLocaleString()}</span>
                        </div>
                        {deal.monthlyPayment && (
                          <div className="flex justify-between items-center pt-2">
                            <span className="uppercase tracking-wider text-xs">Monthly</span>
                            <span className="text-foreground font-bold">${deal.monthlyPayment}/mo</span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
              {deals?.filter((d) => d.stage === stage).length === 0 && (
                <div className="flex flex-col items-center justify-center h-32 text-muted-foreground/50 text-sm border-2 border-dashed border-border/50 rounded-2xl uppercase tracking-widest font-semibold">
                  Empty
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}