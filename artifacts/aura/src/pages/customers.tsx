import { useListCustomers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, User, MapPin, Car, Award, Mail, Phone, Crown } from "lucide-react";
import { motion } from "framer-motion";

export default function Customers() {
  const { data: customers, isLoading } = useListCustomers();

  const getTierColor = (tier: string) => {
    switch(tier) {
      case 'platinum': return 'text-primary bg-primary/10';
      case 'gold': return 'text-amber-500 bg-amber-500/10';
      case 'silver': return 'text-slate-400 bg-slate-400/10';
      default: return 'text-muted-foreground bg-black/5';
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-light tracking-tight mb-2">Client <span className="font-semibold">Portfolio</span></h1>
          <p className="text-muted-foreground text-lg">Lifetime relationships and loyalty.</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
          <Plus className="w-5 h-5" />
          Add Client
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {isLoading ? (
          [...Array(8)].map((_, i) => <div key={i} className="h-64 bg-black/5 rounded-3xl animate-pulse" />)
        ) : (
          customers?.map((customer, i) => (
            <motion.div
              key={customer.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer rounded-3xl group overflow-hidden h-full flex flex-col">
                <CardContent className="p-0 flex flex-col h-full">
                  <div className="p-6 bg-gradient-to-b from-black/5 to-transparent relative border-b border-border/40">
                    <div className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest backdrop-blur-md bg-white/50">
                      <Crown className={`w-3.5 h-3.5 ${getTierColor(customer.loyaltyTier).split(' ')[0]}`} />
                      <span className={getTierColor(customer.loyaltyTier).split(' ')[0]}>{customer.loyaltyTier}</span>
                    </div>
                    
                    <div className="w-20 h-20 rounded-full bg-white shadow-md flex items-center justify-center overflow-hidden mb-4 border-2 border-white group-hover:border-primary transition-colors duration-300">
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
                          <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center text-foreground shrink-0"><Mail className="w-4 h-4" /></div>
                          <span className="truncate">{customer.email}</span>
                        </div>
                      )}
                      {customer.phone && (
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center text-foreground shrink-0"><Phone className="w-4 h-4" /></div>
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
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}