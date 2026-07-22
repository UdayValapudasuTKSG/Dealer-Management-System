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
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Dealership Network</h1>
          <p className="text-muted-foreground mt-1">Manage and provision operating workspaces.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0 shadow-lg shadow-primary/20">
          <Plus className="w-4 h-4 mr-2" />
          Provision Workspace
        </Button>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input 
          placeholder="Search network..." 
          className="pl-9 bg-card/50 border-white/10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid gap-4">
        {isLoading && (
          <div className="py-12 text-center text-muted-foreground animate-pulse">
            Loading network data...
          </div>
        )}
        
        {filteredDealers.map((dealer) => (
          <Link key={dealer.id} href={`/network/${dealer.id}`}>
            <Card className="p-4 bg-card/40 hover:bg-card/80 border-white/5 hover:border-primary/20 transition-all cursor-pointer group">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-primary shrink-0 border border-primary/20">
                    <Building2 className="w-6 h-6" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-white truncate text-base">{dealer.name}</h3>
                      {dealer.status === "suspended" && (
                        <Badge variant="outline" className="text-amber-400 border-amber-400/20 bg-amber-400/10">Suspended</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {(dealer.city || dealer.country) && (
                        <div className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                        </div>
                      )}
                      <div className="flex items-center gap-1">
                        <BadgeDollarSign className="w-3 h-3" />
                        1 USD = {dealer.usdExchangeRate} GYD
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="shrink-0 text-muted-foreground group-hover:text-primary transition-colors">
                  <ChevronRight className="w-5 h-5" />
                </div>
              </div>
            </Card>
          </Link>
        ))}

        {!isLoading && filteredDealers.length === 0 && (
          <div className="py-12 text-center text-muted-foreground border border-dashed border-white/10 rounded-xl bg-card/20">
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
      <DialogContent className="sm:max-w-md bg-background border-white/10 shadow-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-white">Provision New Workspace</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Dealership Name</label>
              <Input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="e.g. AURA Motors Georgetown"
                className="bg-card/50 border-white/10"
                autoFocus
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">City</label>
                <Input 
                  value={city} 
                  onChange={e => setCity(e.target.value)} 
                  placeholder="e.g. Georgetown"
                  className="bg-card/50 border-white/10"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Country</label>
                <Input 
                  value={country} 
                  onChange={e => setCountry(e.target.value)} 
                  placeholder="e.g. Guyana"
                  className="bg-card/50 border-white/10"
                />
              </div>
            </div>

            <div className="rounded-lg bg-primary/10 border border-primary/20 p-3 text-xs text-primary/90 flex gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <p>Provisioning automatically generates default divisions, standard roles, stage checklists, and the complete AI agent roster.</p>
            </div>
          </div>
          
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} className="hover:bg-white/5 hover:text-white">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "Provisioning..." : "Initialize Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
