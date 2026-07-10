import { useListAppraisals } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Calculator, Car, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";

export default function Appraisals() {
  const { data: appraisals, isLoading } = useListAppraisals();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light tracking-tight mb-2">Trade <span className="font-semibold">Valuations</span></h1>
          <p className="text-muted-foreground text-lg">AI-powered acquisition estimates.</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          New Valuation
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {isLoading ? (
          [...Array(4)].map((_, i) => <div key={i} className="h-32 bg-black/5 rounded-3xl animate-pulse" />)
        ) : (
          appraisals?.map((appraisal, i) => (
            <motion.div
              key={appraisal.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group">
                <CardContent className="p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-8 relative z-10 bg-white/40">
                  <div className="flex items-center gap-6">
                    <div className="w-16 h-16 rounded-2xl bg-black/5 flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors duration-500">
                      <Car className="w-8 h-8 text-muted-foreground group-hover:text-primary transition-colors duration-500" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold tracking-widest text-primary mb-1 uppercase">{appraisal.year}</div>
                      <h3 className="font-bold text-2xl leading-tight mb-2">{appraisal.make} <span className="font-light">{appraisal.model}</span></h3>
                      <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-3">
                        <span>{appraisal.customerName || 'Walk-in'}</span>
                        <span className="w-1 h-1 rounded-full bg-border" />
                        <span>{appraisal.mileageKm.toLocaleString()} KM</span>
                        <span className="w-1 h-1 rounded-full bg-border" />
                        <span>{appraisal.condition}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex flex-col md:flex-row items-start md:items-center gap-8 w-full md:w-auto">
                    <div className="text-left md:text-right">
                      <div className="text-xs font-semibold tracking-widest uppercase text-muted-foreground flex items-center justify-start md:justify-end gap-1.5 mb-2">
                        <Sparkles className="w-3.5 h-3.5 text-primary" /> AI Estimate
                      </div>
                      <div className="font-light text-3xl tracking-tight">${appraisal.aiEstimate.toLocaleString()}</div>
                    </div>
                    
                    {appraisal.finalOffer && (
                      <div className="text-left md:text-right pl-0 md:pl-8 border-l-0 md:border-l border-border/50">
                        <div className="text-xs font-semibold tracking-widest uppercase text-primary mb-2">Final Offer</div>
                        <div className="font-bold text-3xl tracking-tight">${appraisal.finalOffer.toLocaleString()}</div>
                      </div>
                    )}
                    
                    <div className="pl-0 md:pl-8">
                      <Badge variant={appraisal.status === 'accepted' ? 'default' : 'secondary'} className="px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest">
                        {appraisal.status}
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}