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
    <div className="space-y-8 font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-3xl font-serif text-foreground">Dealership Network</h1>
          <p className="text-sm text-muted-foreground mt-2 uppercase tracking-widest">Manage and provision operating workspaces</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0 rounded-none uppercase tracking-widest text-xs bg-black text-white hover:bg-black/90">
          <Plus className="w-4 h-4 mr-2" />
          Provision Workspace
        </Button>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input 
          placeholder="Search network..." 
          className="pl-9 bg-white border-border rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-black"
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
            <Card className="p-4 bg-white hover:bg-gray-50 border-border rounded-none shadow-none transition-colors cursor-pointer group">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-5 min-w-0">
                  <div className="w-12 h-12 bg-muted/30 flex items-center justify-center text-black border border-border shrink-0">
                    <Building2 className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 mb-1.5">
                      <h3 className="font-serif text-lg text-black truncate">{dealer.name}</h3>
                      {dealer.status === "suspended" && (
                        <Badge variant="outline" className="text-muted-foreground border-border rounded-none px-2 py-0.5 text-[10px] uppercase tracking-widest">Suspended</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                      {(dealer.city || dealer.country) && (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="w-3 h-3" />
                          {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <BadgeDollarSign className="w-3 h-3" />
                        1 USD = {dealer.usdExchangeRate} GYD
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="shrink-0 text-muted-foreground group-hover:text-black transition-colors">
                  <ChevronRight className="w-5 h-5" />
                </div>
              </div>
            </Card>
          </Link>
        ))}

        {!isLoading && filteredDealers.length === 0 && (
          <div className="py-12 text-center text-muted-foreground border border-border bg-white font-serif italic">
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
      <DialogContent className="sm:max-w-md bg-white border-border rounded-none shadow-none font-sans">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="font-serif text-xl text-black">Provision New Workspace</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-5 py-6">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Dealership Name</label>
              <Input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="e.g. AURA Motors Georgetown"
                className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black"
                autoFocus
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground">City</label>
                <Input 
                  value={city} 
                  onChange={e => setCity(e.target.value)} 
                  placeholder="e.g. Georgetown"
                  className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Country</label>
                <Input 
                  value={country} 
                  onChange={e => setCountry(e.target.value)} 
                  placeholder="e.g. Guyana"
                  className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black"
                />
              </div>
            </div>

            <div className="border border-border bg-gray-50 p-4 text-[11px] text-muted-foreground flex gap-3">
              <ShieldAlert className="w-4 h-4 shrink-0 text-black" />
              <p className="leading-relaxed">Provisioning automatically generates default divisions, standard roles, stage checklists, and the complete AI agent roster.</p>
            </div>
          </div>
          
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} className="rounded-none uppercase tracking-widest text-xs border-border text-black hover:bg-gray-50">
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending} className="rounded-none uppercase tracking-widest text-xs bg-black text-white hover:bg-black/90">
              {create.isPending ? "Provisioning..." : "Initialize Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
