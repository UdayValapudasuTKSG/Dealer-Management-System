import { Link } from "wouter";
import { useListFinanceApplications, useListGates } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Building, FileText, CheckCircle2, DollarSign, Percent, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";
import { GateCard, GATE_LABEL } from "@/components/gate-card";
import { Page, PageHeader } from "@/components/layout/page";

export default function Finance() {
  const { data: apps, isLoading } = useListFinanceApplications();
  const { data: gates } = useListGates({ status: "pending" });

  const gatesForApp = (appId: number) =>
    (gates ?? []).filter((g) => g.refType === "finance" && g.refId === appId);

  return (
    <Page className="space-y-10">
      <PageHeader
        title="Finance &"
        accent="Insurance"
        subtitle="Credit applications and protection portfolios."
        action={
          <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
            <Plus className="w-5 h-5" />
            New Application
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {isLoading ? (
          [...Array(6)].map((_, i) => <div key={i} className="h-64 bg-black/5 rounded-3xl animate-pulse" />)
        ) : (
          apps?.map((app, i) => (
            <motion.div
              key={app.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 rounded-3xl overflow-hidden group">
                <div className={`h-1.5 w-full ${app.status === 'approved' ? 'bg-primary' : 'bg-black/10'}`} />
                <CardContent className="p-6 md:p-8">
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      {app.customerId ? (
                        <Link href={`/customers/${app.customerId}`} className="font-bold text-2xl leading-tight mb-1 hover:text-primary transition-colors block">{app.customerName}</Link>
                      ) : (
                        <h3 className="font-bold text-2xl leading-tight mb-1 group-hover:text-primary transition-colors">{app.customerName}</h3>
                      )}
                      <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                        <Building className="w-4 h-4" />
                        {app.lender || 'Pending Lender'}
                      </div>
                    </div>
                    <Badge variant={app.status === 'approved' ? 'default' : 'secondary'} className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border-none">
                      {app.status.replace('_', ' ')}
                    </Badge>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4 py-6 border-y border-border/50 mb-6">
                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">Amount</div>
                      <div className="font-light text-2xl tracking-tight">${app.amount.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">Term</div>
                      <div className="font-light text-2xl tracking-tight flex items-baseline gap-1">
                        {app.termMonths} <span className="text-sm font-medium text-muted-foreground mb-1 uppercase tracking-widest">MO</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">Rate</div>
                      <div className="font-light text-2xl tracking-tight text-primary flex items-baseline gap-1">
                        {app.apr} <span className="text-sm font-medium text-primary/60 mb-1 uppercase tracking-widest">APR</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-3 flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4" /> Protection Portfolio
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {app.protectionProducts.length > 0 ? (
                        app.protectionProducts.map(p => (
                          <span key={p} className="bg-black/5 px-3 py-1.5 rounded-full text-xs font-medium text-foreground tracking-wide">
                            {p}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm font-medium text-muted-foreground italic">Declined</span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
              <AnimatePresence mode="popLayout">
                {gatesForApp(app.id).map((gate) => (
                  <div key={gate.id} className="mt-4">
                    <GateCard
                      gate={gate}
                      label={GATE_LABEL[gate.type]}
                      showCustomerLink={false}
                    />
                  </div>
                ))}
              </AnimatePresence>
            </motion.div>
          ))
        )}
      </div>
    </Page>
  );
}