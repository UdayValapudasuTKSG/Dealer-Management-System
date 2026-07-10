import { useListAppraisals } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Calculator, Car, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Appraisals() {
  const { data: appraisals, isLoading } = useListAppraisals();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Appraisals</h1>
          <p className="text-muted-foreground">Trade-in valuations and AI estimates</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          New Appraisal
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {isLoading ? (
          [...Array(3)].map((_, i) => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)
        ) : (
          appraisals?.map((appraisal) => (
            <Card key={appraisal.id} className="hover-elevate transition-all border-border">
              <CardContent className="p-4 md:p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                    <Car className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">{appraisal.year} {appraisal.make} {appraisal.model}</h3>
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <span>{appraisal.customerName || 'Walk-in'}</span>
                      <span>•</span>
                      <span>{appraisal.mileageKm.toLocaleString()} km</span>
                      <span>•</span>
                      <span className="capitalize">{appraisal.condition} condition</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-6 w-full md:w-auto">
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground flex items-center justify-end gap-1 mb-1">
                      <Sparkles className="w-3 h-3 text-primary" /> AI Estimate
                    </div>
                    <div className="font-mono font-medium">${appraisal.aiEstimate.toLocaleString()}</div>
                  </div>
                  
                  {appraisal.finalOffer && (
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground mb-1">Final Offer</div>
                      <div className="font-bold text-lg">${appraisal.finalOffer.toLocaleString()}</div>
                    </div>
                  )}
                  
                  <Badge variant={appraisal.status === 'accepted' ? 'default' : 'secondary'} className="ml-2 w-24 justify-center">
                    {appraisal.status}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}