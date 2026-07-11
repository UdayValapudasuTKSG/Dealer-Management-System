import { Link } from "wouter";
import {
  useListCustomers,
  useCreateCustomer,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, User, MapPin, Car, Award, Mail, Phone, Crown } from "lucide-react";
import { motion } from "framer-motion";
import { Page, PageHeader } from "@/components/layout/page";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";

export default function Customers() {
  const { data: customers, isLoading } = useListCustomers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createCustomer = useCreateCustomer();

  const getTierColor = (tier: string) => {
    switch(tier) {
      case 'platinum': return 'text-primary bg-primary/10';
      case 'gold': return 'text-amber-500 bg-amber-500/10';
      case 'silver': return 'text-slate-400 bg-slate-400/10';
      default: return 'text-muted-foreground bg-white/[0.05]';
    }
  };

  return (
    <Page className="space-y-10">
      <PageHeader
        title="Client"
        accent="Portfolio"
        subtitle="Lifetime relationships and loyalty."
        action={
          <CreateRecordDialog
            title="Add Client"
            description="Create a new relationship in the portfolio."
            pending={createCustomer.isPending}
            submitLabel="Add Client"
            trigger={
              <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                <Plus className="w-5 h-5" />
                Add Client
              </Button>
            }
            fields={[
              { name: "name", label: "Full name", type: "text", required: true, span: "full", placeholder: "Jane Mensah" },
              { name: "email", label: "Email", type: "text", span: "half", placeholder: "jane@email.com" },
              { name: "phone", label: "Phone", type: "text", span: "half", placeholder: "+233 …" },
              { name: "location", label: "Location", type: "text", span: "half", placeholder: "Accra" },
              {
                name: "loyaltyTier",
                label: "Loyalty tier",
                type: "select",
                span: "half",
                defaultValue: "new",
                options: [
                  { value: "new", label: "New" },
                  { value: "silver", label: "Silver" },
                  { value: "gold", label: "Gold" },
                  { value: "platinum", label: "Platinum" },
                ],
              },
            ]}
            onSubmit={async (values) => {
              await createCustomer.mutateAsync({ data: values as never });
              queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
              toast({ title: "Client added", description: "AURA is enriching the new profile." });
            }}
          />
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {isLoading ? (
          [...Array(8)].map((_, i) => <div key={i} className="h-64 bg-white/[0.05] rounded-3xl animate-pulse" />)
        ) : (
          customers?.map((customer, i) => (
            <motion.div
              key={customer.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Link href={`/customers/${customer.id}`} className="block h-full">
              <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer rounded-3xl group overflow-hidden h-full flex flex-col">
                <CardContent className="p-0 flex flex-col h-full">
                  <div className="p-6 bg-gradient-to-b from-black/5 to-transparent relative border-b border-border/40">
                    <div className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest backdrop-blur-md bg-white/[0.05]">
                      <Crown className={`w-3.5 h-3.5 ${getTierColor(customer.loyaltyTier).split(' ')[0]}`} />
                      <span className={getTierColor(customer.loyaltyTier).split(' ')[0]}>{customer.loyaltyTier}</span>
                    </div>
                    
                    <div className="w-20 h-20 rounded-full bg-white/[0.06] shadow-md flex items-center justify-center overflow-hidden mb-4 border-2 border-white/10 group-hover:border-primary transition-colors duration-300">
                      {customer.avatarUrl ? (
                        <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                      ) : (
                        <User className="w-10 h-10 text-muted-foreground/30" />
                      )}
                    </div>
                    
                    <h3 className="font-bold text-2xl leading-tight mb-1 group-hover:text-primary transition-colors">{customer.name}</h3>
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5" />
                      {customer.location || "Location Unknown"}
                    </div>
                  </div>

                  <div className="p-6 flex-1 flex flex-col justify-between">
                    <div className="space-y-3 mb-6 text-sm font-medium text-muted-foreground">
                      {customer.email && (
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-white/[0.05] flex items-center justify-center text-foreground shrink-0"><Mail className="w-4 h-4" /></div>
                          <span className="truncate">{customer.email}</span>
                        </div>
                      )}
                      {customer.phone && (
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-white/[0.05] flex items-center justify-center text-foreground shrink-0"><Phone className="w-4 h-4" /></div>
                          <span>{customer.phone}</span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border/50">
                      <div>
                        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">LTV</div>
                        <div className="font-light text-xl tracking-tight text-primary">${(customer.lifetimeValue / 1000).toFixed(1)}k</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1 flex items-center gap-1.5"><Car className="w-3.5 h-3.5" /> Owned</div>
                        <div className="font-light text-xl tracking-tight">{customer.vehiclesOwned} <span className="text-sm font-medium uppercase tracking-widest text-muted-foreground">Vehicles</span></div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
              </Link>
            </motion.div>
          ))
        )}
      </div>
    </Page>
  );
}