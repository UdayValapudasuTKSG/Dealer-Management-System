import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Building2, Plus, Search, MapPin, BadgeDollarSign, ShieldAlert,
  ChevronRight, Bot
} from "lucide-react";
import { 
  useListDealers, getListDealersQueryKey, useCreateDealer,
  useListAgentPolicies, getListAgentPoliciesQueryKey, useUpdateAgentPolicy
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 ${className || ""}`}>
      {children}
    </div>
  );
}

function PageHeader({ eyebrow, title, subtitle, right }: { eyebrow?: string; title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 flex-wrap">
      <div>
        {eyebrow && <SectionLabel>{eyebrow}</SectionLabel>}
        <h1 className="mt-2 font-serif text-4xl tracking-tight text-zinc-900">{title}</h1>
        {subtitle && (
          <p className="mt-2 text-[13.5px] text-zinc-600 max-w-2xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

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
    <div className="mx-auto max-w-7xl px-4 md:px-8 py-8 space-y-6 font-sans">
      <PageHeader 
        eyebrow="NETWORK"
        title="Dealership Network"
        subtitle="Manage and provision operating workspaces across all regions."
        right={
          <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 rounded-md bg-zinc-900 text-white px-4 py-2 text-[12.5px] font-medium hover:bg-zinc-700 transition-colors disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed">
            <Plus className="w-3.5 h-3.5" />
            Provision Workspace
          </button>
        }
      />

      <div className="relative glass rounded-xl overflow-hidden p-1 hover-elevate">
        <Search className="w-3.5 h-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input 
          placeholder="Search network..." 
          className="pl-10 bg-transparent border-none shadow-none focus-visible:ring-0 h-10 text-[13px] placeholder:text-zinc-400"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid gap-3">
        {isLoading && (
          <div className="py-12 flex justify-center">
            <div className="h-24 w-full max-w-xl rounded-xl border border-black/10 bg-white shimmer" />
          </div>
        )}
        
        {filteredDealers.map((dealer) => (
          <Link key={dealer.id} href={`/network/${dealer.id}`}>
            <div className="glass p-5 hover-elevate transition-all cursor-pointer group rounded-xl">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-zinc-100 border border-black/5 flex items-center justify-center shrink-0">
                    <Building2 className="w-4 h-4 text-zinc-500" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-serif text-[14.5px] tracking-tight text-zinc-900 truncate">{dealer.name}</h3>
                      {dealer.status === "suspended" && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-zinc-50 px-2.5 py-0.5 text-[10.5px] font-medium text-zinc-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                          Suspended
                        </span>
                      )}
                      {dealer.status === "provisioning" && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10.5px] font-medium text-amber-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                          Provisioning
                        </span>
                      )}
                      {dealer.status === "offboarding" && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10.5px] font-medium text-amber-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                          Offboarding
                        </span>
                      )}
                      {dealer.status === "closed" && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-zinc-100 px-2.5 py-0.5 text-[10.5px] font-medium text-zinc-500">
                          <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
                          Closed
                        </span>
                      )}
                      {dealer.status === "active" && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-700">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          </span>
                          Active
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                      {(dealer.city || dealer.country) && (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="w-3 h-3" />
                          {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <BadgeDollarSign className="w-3 h-3" />
                        <span className="font-mono text-[10.5px] tabular-nums lowercase tracking-normal">1 usd = {dealer.usdExchangeRate} gyd</span>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="shrink-0 text-zinc-300 group-hover:text-zinc-600 transition-colors mr-2">
                  <ChevronRight className="w-4 h-4" />
                </div>
              </div>
            </div>
          </Link>
        ))}

        {!isLoading && filteredDealers.length === 0 && (
          <div className="py-12 text-center text-zinc-500 glass rounded-xl text-[13px]">
            No dealerships found matching your search.
          </div>
        )}
      </div>

      <AgentPoliciesPanel />

      <CreateDealerDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

const POLICY_AGENT_KEYS = [
  "concierge", "sales", "appraisal", "finance", "inventory", "customs",
  "scheduler", "service", "parts", "ledger", "retention", "analyst", "documents",
] as const;

function AgentPoliciesPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: policies } = useListAgentPolicies();
  const update = useUpdateAgentPolicy({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAgentPoliciesQueryKey() }),
      onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
    },
  });

  const enabledFor = (key: string) => {
    const row = (policies ?? []).find(p => p.agentKey === key);
    return row ? row.enabled : true; // missing rows fail open
  };
  const masterOn = enabledFor("__all__");
  const toggle = (key: string, on: boolean) =>
    update.mutate({ data: { agentKey: key, enabled: on } });

  return (
    <div className="glass rounded-2xl overflow-hidden hover-elevate">
      <div className="px-5 py-4 border-b border-black/5 flex items-center gap-2 font-serif text-[14.5px] tracking-tight">
        <Bot className="w-4 h-4 text-zinc-400" /> Platform Agent Policies
        <span className="ml-auto text-[10px] font-sans font-medium uppercase tracking-[0.18em] text-zinc-500">Overrides every dealer switch</span>
      </div>
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-black/5 bg-zinc-50/60 px-4 py-3">
          <div>
            <div className="text-[13px] font-medium text-zinc-900">Global Kill Switch</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">Turning this off halts every AI agent across all dealerships instantly.</div>
          </div>
          <Switch checked={masterOn} onCheckedChange={(v) => toggle("__all__", v)} disabled={update.isPending} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
          {POLICY_AGENT_KEYS.map(key => (
            <div key={key} className={`flex items-center justify-between rounded-lg border border-black/5 px-3 py-2 ${!masterOn ? "opacity-50" : ""}`}>
              <span className="text-[12px] font-medium text-zinc-800 capitalize">{key}</span>
              <Switch
                checked={enabledFor(key)}
                onCheckedChange={(v) => toggle(key, v)}
                disabled={update.isPending || !masterOn}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CreateDealerDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");

  const create = useCreateDealer({
    mutation: {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });
        const failed = res.saga?.steps?.find(s => s.status === "failed");
        toast({
          title: failed ? "Provisioning Halted" : "Workspace Provisioning",
          description: failed
            ? `Setup stopped at "${failed.stepKey}" — open the workspace to retry or abort.`
            : "Defaults seeded. Activate once the go-live checklist clears.",
          variant: failed ? "destructive" : undefined,
        });
        setName(""); setCity(""); setCountry(""); setOwnerEmail("");
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
        ownerEmail: ownerEmail.trim() || undefined,
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-md glass rounded-2xl shadow-xl font-sans">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="font-serif text-[20px] tracking-tight">Provision New Workspace</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-5 py-6">
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Dealership Name</label>
              <Input 
                value={name} 
                onChange={e => setName(e.target.value)} 
                placeholder="e.g. AURA Motors Georgetown"
                className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]"
                autoFocus
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">City</label>
                <Input 
                  value={city} 
                  onChange={e => setCity(e.target.value)} 
                  placeholder="e.g. Georgetown"
                  className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Country</label>
                <Input 
                  value={country} 
                  onChange={e => setCountry(e.target.value)} 
                  placeholder="e.g. Guyana"
                  className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Owner / General Manager Email</label>
              <Input 
                type="email"
                value={ownerEmail} 
                onChange={e => setOwnerEmail(e.target.value)} 
                placeholder="e.g. gm@dealership.com"
                className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]"
              />
              <p className="text-[11px] text-zinc-500 leading-relaxed">They receive an invite and are bound as General Manager on first sign-in. Required before the workspace can go live.</p>
            </div>

            <div className="rounded-md bg-zinc-50 border border-black/5 p-3 text-[11px] text-zinc-600 flex gap-2.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 text-zinc-400 mt-0.5" />
              <p className="leading-relaxed">Provisioning runs a step-by-step setup saga — divisions, roles, stage checklists, tax rules and the AI agent roster — and the workspace stays in "Provisioning" until you activate it.</p>
            </div>
          </div>
          
          <DialogFooter className="gap-2 sm:gap-0">
            <button type="button" onClick={onClose} className="inline-flex items-center justify-center rounded-md border border-black/10 bg-white px-4 py-2 text-[12.5px] font-medium text-zinc-700 hover:bg-zinc-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || create.isPending} className="inline-flex items-center justify-center rounded-md bg-zinc-900 text-white px-4 py-2 text-[12.5px] font-medium hover:bg-zinc-700 transition-colors disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed">
              {create.isPending ? "Provisioning..." : "Initialize Workspace"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
