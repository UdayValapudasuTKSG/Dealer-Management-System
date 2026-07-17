import { Link } from "wouter";
import {
  useListAppraisals,
  useCreateAppraisal,
  getListAppraisalsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Car, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { Page, PageHeader } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";

export default function Appraisals() {
  const { data: appraisals, isLoading } = useListAppraisals();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createAppraisal = useCreateAppraisal();

  return (
    <Page className="space-y-5">
      <PageHeader
        title="Trade"
        accent="Valuations"
        subtitle="Acquisition offers, ready to present."
        action={
          <CreateRecordDialog
            title="New Valuation"
            description="Appraise a trade-in — AURA estimates market value instantly."
            pending={createAppraisal.isPending}
            submitLabel="Value trade-in"
            trigger={
              <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                <Plus className="w-5 h-5" />
                New Valuation
              </Button>
            }
            fields={[
              { name: "customerName", label: "Customer", type: "text", span: "full", placeholder: "Yaw Boateng" },
              { name: "year", label: "Year", type: "number", required: true, span: "half", placeholder: "2021" },
              { name: "make", label: "Make", type: "text", required: true, span: "half", placeholder: "Toyota" },
              { name: "model", label: "Model", type: "text", required: true, span: "half", placeholder: "Camry" },
              { name: "mileageKm", label: "Mileage (km)", type: "number", required: true, span: "half", placeholder: "45000" },
              {
                name: "condition",
                label: "Condition",
                type: "select",
                required: true,
                span: "full",
                defaultValue: "good",
                options: [
                  { value: "excellent", label: "Excellent" },
                  { value: "good", label: "Good" },
                  { value: "fair", label: "Fair" },
                  { value: "poor", label: "Poor" },
                ],
              },
              { name: "notes", label: "Notes", type: "textarea", span: "full", placeholder: "Service history, extras…" },
            ]}
            onSubmit={async (values) => {
              await createAppraisal.mutateAsync({ data: values as never });
              queryClient.invalidateQueries({ queryKey: getListAppraisalsQueryKey() });
              toast({ title: "Valuation created", description: "AURA is estimating market value." });
            }}
          />
        }
      />

      <div className="grid grid-cols-1 gap-6">
        {isLoading ? (
          [...Array(4)].map((_, i) => <div key={i} className="h-32 bg-white/[0.05] rounded-3xl animate-pulse" />)
        ) : (
          appraisals?.map((appraisal, i) => (
            <motion.div
              key={appraisal.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group">
                <CardContent className="p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-8 relative z-10 bg-white/[0.03]">
                  <div className="flex items-center gap-6">
                    <div className="w-16 h-16 rounded-2xl bg-white/[0.05] flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors duration-500">
                      <Car className="w-8 h-8 text-muted-foreground group-hover:text-primary transition-colors duration-500" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold tracking-widest text-primary mb-1 uppercase">{appraisal.year}</div>
                      <h3 className="font-bold text-2xl leading-tight mb-2">{appraisal.make} <span className="font-light">{appraisal.model}</span></h3>
                      <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-3">
                        {appraisal.customerId ? (
                          <Link
                            href={`/customers/${appraisal.customerId}`}
                            className="flex items-center gap-1 text-primary hover:underline"
                          >
                            {appraisal.customerName || 'Account'}
                            <ChevronRight className="w-3.5 h-3.5" />
                          </Link>
                        ) : (
                          <span>{appraisal.customerName || 'Walk-in'}</span>
                        )}
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
                        Valuation
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
    </Page>
  );
}