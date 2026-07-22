import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Building2, Plus, Search, MapPin, BadgeDollarSign, ShieldAlert,
  ChevronRight
} from "lucide-react";
import { 
  useListDealers, getListDealersQueryKey, useCreateDealer 
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export default function Network() {
  const { data: dealers, isLoading } = useListDealers();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  
  const filteredDealers = (dealers ?? []).filter(d => 
    d.name.toLowerCase().includes(search.toLowerCase()) ||
    (d.city && d.city.toLowerCase().includes(search.toLowerCase())) ||
    (d.country && d.country.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-8 font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-serif tracking-wide">Dealership Network</h1>
          <p className="text-xs text-muted-foreground mt-2 uppercase tracking-[0.15em]">Manage and provision operating workspaces</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0 rounded-md uppercase tracking-widest text-[10px] bg-primary text-primary-foreground hover:bg-primary/90">
          <Plus className="w-3.5 h-3.5 mr-2" />
          Provision Workspace
        </Button>
      </div>

      <div className="relative glass-panel rounded-2xl overflow-hidden p-1">
        <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 opacity-50" />
        <Input 
          placeholder="Search network..." 
          className="pl-11 bg-transparent border-none shadow-none focus-visible:ring-0 h-12 text-sm placeholder:text-muted-foreground/50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid gap-4">
        {isLoading && (
          <div className="py-12 text-center text-muted-foreground font-serif italic">
            Loading network data...
          </div>
        )}
        
        {filteredDealers.map((dealer) => (
          <Link key={dealer.id} href={`/network/${dealer.id}`}>
            <div className="glass-panel p-5 hover:bg-white/[0.08] transition-all cursor-pointer group rounded-2xl">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-5 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                    <Building2 className="w-5 h-5 opacity-70" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 mb-1.5">
                      <h3 className="font-serif text-lg tracking-wide truncate">{dealer.name}</h3>
                      {dealer.status === "suspended" && (
                        <span className="bg-black/40 border border-white/10 rounded-md px-2 py-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">Suspended</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                      {(dealer.city || dealer.country) && (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="w-3 h-3 opacity-60" />
                          {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <BadgeDollarSign className="w-3 h-3 opacity-60" />
                        1 USD = {dealer.usdExchangeRate} GYD
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors mr-2">
                  <ChevronRight className="w-4 h-4 opacity-50" />
                </div>
              </div>
            </div>
          </Link>
        ))}

        {!isLoading && filteredDealers.length === 0 && (
          <div className="py-12 text-center text-muted-foreground glass-panel rounded-2xl font-serif italic">
            No dealerships found matching your search.
          </div>
        )}
      </div>

      <CreateDealerDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateDealerDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");

  const create = useCreateDealer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });
        toast({
          title: "Dealership Provisioned",
          description: "Workspace initialized with default modules and AI agents.",
        });
        setName(""); setCity(""); setCountry("");
        onClose();
      },
      onError: (e: any) => {
        toast({
          title: "Provisioning Failed",
          description: e.message || "An error occurred",
          variant: "destructive"
        });
      }
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({
      data: {
        name: name.trim(),
        city: city.trim() || undefined,
        country: country.trim() || undefined,
        status: "active"
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-md glass-panel rounded-2xl border-white/10 shadow-2xl font-sans">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="font-serif text-xl tracking-wide">Provision New Workspace</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6 py-6">
            <div className="space-y-2.5">
              <label className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground ml-1">Dealership Name</label>
              <Input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="e.g. AURA Motors Georgetown"
                className="bg-white/5 border-white/10 rounded-xl focus-visible:ring-1 focus-visible:ring-white/30 h-11"
                autoFocus
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2.5">
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground ml-1">City</label>
                <Input 
                  value={city} 
                  onChange={e => setCity(e.target.value)} 
                  placeholder="e.g. Georgetown"
                  className="bg-white/5 border-white/10 rounded-xl focus-visible:ring-1 focus-visible:ring-white/30 h-11"
                />
              </div>
              <div className="space-y-2.5">
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground ml-1">Country</label>
                <Input 
                  value={country} 
                  onChange={e => setCountry(e.target.value)} 
                  placeholder="e.g. Guyana"
                  className="bg-white/5 border-white/10 rounded-xl focus-visible:ring-1 focus-visible:ring-white/30 h-11"
                />
              </div>
            </div>

            <div className="rounded-xl bg-white/[0.03] border border-white/5 p-4 text-[11px] text-muted-foreground flex gap-3">
              <ShieldAlert className="w-4 h-4 shrink-0 opacity-70 mt-0.5" />
              <p className="leading-relaxed">Provisioning automatically generates default divisions, standard roles, stage checklists, and the complete AI agent roster.</p>
            </div>
          </div>
          
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} className="rounded-xl uppercase tracking-widest text-[10px] border-white/10 hover:bg-white/5 bg-transparent">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending} className="rounded-xl uppercase tracking-widest text-[10px] bg-primary text-primary-foreground hover:bg-primary/90">
              {create.isPending ? "Provisioning..." : "Initialize Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

