import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { 
  ArrowLeft, Building2, MapPin, Power, Activity, Settings, Users, Bot, Key, DollarSign,
  ShieldAlert, PlayCircle, PauseCircle, Crown, Trash2, Plus
} from "lucide-react";
import { 
  useListDealers, getListDealersQueryKey, useUpdateDealer,
  useListDealerAgents, getListDealerAgentsQueryKey, useUpdateDealerAgent,
  useListDealerMembers, getListDealerMembersQueryKey, useUpdateDealerMember, useRemoveDealerMember, useAddDealerMember,
  useListAdminRoles, useListPlatformUsers, startImpersonation
} from "@workspace/api-client-react";
import type { Dealer, DealerMember } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const ENTITLEMENT_MODULES = [
  { key: "service_module", label: "Service & Workshop", desc: "Service orders, job cards, workshop board" },
  { key: "parts_module", label: "Parts & Suppliers", desc: "Parts inventory, purchases, suppliers" },
  { key: "gra_module", label: "GRA Compliance", desc: "Duty filing and customs workflows" },
  { key: "ai_agents", label: "AI Agents", desc: "Agentic automations for this dealership" },
];

function entitlementOn(flags: Record<string, boolean> | undefined, key: string) {
  return flags?.[key] !== false;
}

export default function DealerDetail() {
  const params = useParams();
  const dealerId = Number(params.id);
  const { data: dealers, isLoading } = useListDealers();
  const dealer = dealers?.find(d => d.id === dealerId);
  const { toast } = useToast();
  const [entering, setEntering] = useState(false);

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  }

  if (!dealer) {
    return <div className="p-8 text-center text-muted-foreground">Dealership not found.</div>;
  }

  const handleEnterWorkspace = async () => {
    try {
      setEntering(true);
      await startImpersonation({ dealerId });
      localStorage.setItem("aura-dealer-id", String(dealerId));
      toast({
        title: "Workspace Authorized",
        description: "Opening 8-hour audited impersonation window.",
      });
      setTimeout(() => {
        window.location.href = "/";
      }, 500);
    } catch (e: any) {
      setEntering(false);
      toast({
        title: "Access Denied",
        description: e.message || "Failed to initialize impersonation grant.",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="space-y-6 pb-20">
      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-2">
        <Link href="/network" className="hover:text-white flex items-center gap-1 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Network
        </Link>
      </div>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 bg-card/30 p-6 rounded-2xl border border-white/5">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20 shrink-0 mt-1">
            <Building2 className="w-8 h-8" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white tracking-tight">{dealer.name}</h1>
              <Badge variant={dealer.status === "active" ? "default" : "secondary"} className={
                dealer.status === "active" ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20" : "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
              }>
                {dealer.status === "active" ? "Active" : "Suspended"}
              </Badge>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-x-6 gap-y-2 mt-2 text-sm text-muted-foreground">
              {(dealer.city || dealer.country) && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4" />
                  {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Activity className="w-4 h-4" />
                ID: {dealer.id}
              </span>
              <span className="flex items-center gap-1.5">
                <DollarSign className="w-4 h-4" />
                Rate: 1 USD = {dealer.usdExchangeRate || 208} GYD
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3 shrink-0">
          <Button 
            variant="outline" 
            className="border-primary/30 text-primary hover:bg-primary hover:text-white"
            onClick={handleEnterWorkspace}
            disabled={entering || dealer.status === "suspended"}
          >
            <Key className="w-4 h-4 mr-2" />
            {entering ? "Authorizing..." : "Enter Workspace"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <GeneralSettingsPanel dealer={dealer} />
          <EntitlementsPanel dealer={dealer} />
          <AgentsPanel dealer={dealer} />
        </div>
        <div className="space-y-6">
          <MembersPanel dealer={dealer} />
        </div>
      </div>
    </div>
  );
}

function GeneralSettingsPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(dealer.name);
  const [city, setCity] = useState(dealer.city || "");
  const [country, setCountry] = useState(dealer.country || "");
  const [rate, setRate] = useState(dealer.usdExchangeRate?.toString() || "");

  const update = useUpdateDealer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });
        toast({ title: "Settings saved" });
      },
      onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  });

  const toggleStatus = () => {
    const newStatus = dealer.status === "active" ? "suspended" : "active";
    update.mutate({
      id: dealer.id,
      data: {
        name: dealer.name,
        status: newStatus
      }
    });
  };

  const handleSave = () => {
    update.mutate({
      id: dealer.id,
      data: {
        name: name.trim(),
        city: city.trim() || null,
        country: country.trim() || null,
        status: dealer.status,
        usdExchangeRate: rate ? Number(rate) : undefined
      }
    });
  };

  return (
    <div className="bg-card/30 border border-white/5 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center gap-2 font-medium text-white">
        <Settings className="w-4 h-4 text-primary" /> General Configuration
      </div>
      <div className="p-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">Dealership Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} className="bg-background border-white/10" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">USD Exchange Rate (GYD)</label>
            <Input type="number" value={rate} onChange={e => setRate(e.target.value)} className="bg-background border-white/10" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">City</label>
            <Input value={city} onChange={e => setCity(e.target.value)} className="bg-background border-white/10" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">Country</label>
            <Input value={country} onChange={e => setCountry(e.target.value)} className="bg-background border-white/10" />
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-white/5">
          <div className="flex items-center gap-3">
            <Switch checked={dealer.status === "active"} onCheckedChange={toggleStatus} disabled={update.isPending} />
            <div>
              <div className="text-sm font-medium text-white">Workspace State</div>
              <div className="text-xs text-muted-foreground">Suspending pauses all AI agents and blocks access.</div>
            </div>
          </div>
          <Button onClick={handleSave} disabled={update.isPending} size="sm">Save Changes</Button>
        </div>
      </div>
    </div>
  );
}

function EntitlementsPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateDealer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });
      },
      onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  });

  const toggle = (key: string, on: boolean) => {
    update.mutate({
      id: dealer.id,
      data: {
        name: dealer.name,
        status: dealer.status,
        entitlements: { ...(dealer.entitlements || {}), [key]: on }
      }
    });
  };

  return (
    <div className="bg-card/30 border border-white/5 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center gap-2 font-medium text-white">
        <Power className="w-4 h-4 text-primary" /> Feature Entitlements
      </div>
      <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ENTITLEMENT_MODULES.map(m => {
          const on = entitlementOn(dealer.entitlements as any, m.key);
          return (
            <div key={m.key} className="flex items-start gap-3 p-3 rounded-xl bg-background/50 border border-white/5">
              <Switch checked={on} onCheckedChange={v => toggle(m.key, v)} disabled={update.isPending} className="mt-1" />
              <div>
                <div className="text-sm font-medium text-white">{m.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{m.desc}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentsPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: agents } = useListDealerAgents(dealer.id);

  const patch = useUpdateDealerAgent({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListDealerAgentsQueryKey(dealer.id) }),
      onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  });

  const aiEntitled = entitlementOn(dealer.entitlements as any, "ai_agents");

  return (
    <div className="bg-card/30 border border-white/5 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-white">
          <Bot className="w-4 h-4 text-primary" /> AI Agent Governance
        </div>
        {(!aiEntitled || dealer.status === "suspended") && (
          <Badge variant="outline" className="text-amber-400 border-amber-400/20 bg-amber-400/10">
            {dealer.status === "suspended" ? "Suspended (Halted)" : "Disabled via Entitlement"}
          </Badge>
        )}
      </div>
      <div className="p-0">
        <div className="divide-y divide-white/5">
          {(agents ?? []).map(a => {
            const running = a.status !== "paused";
            return (
              <div key={a.id} className="flex items-center gap-4 p-4 hover:bg-white/[0.02] transition-colors">
                {running ? (
                  <PlayCircle className="w-5 h-5 text-emerald-400 shrink-0" />
                ) : (
                  <PauseCircle className="w-5 h-5 text-amber-400 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{a.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{a.domain}</div>
                </div>
                <Switch 
                  checked={running} 
                  disabled={patch.isPending}
                  onCheckedChange={v => patch.mutate({
                    id: dealer.id,
                    agentId: a.id,
                    data: { status: v ? "active" : "paused" }
                  })}
                />
              </div>
            );
          })}
          {(agents ?? []).length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No agents provisioned for this workspace.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MembersPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: members } = useListDealerMembers(dealer.id);
  const { data: roles } = useListAdminRoles();
  const { data: users } = useListPlatformUsers();
  
  const [addOpen, setAddOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [isGM, setIsGM] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListDealerMembersQueryKey(dealer.id) });
  const onError = (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" });

  const add = useAddDealerMember({ mutation: { onSuccess: () => { invalidate(); setAddOpen(false); }, onError } });
  const patch = useUpdateDealerMember({ mutation: { onSuccess: invalidate, onError } });
  const remove = useRemoveDealerMember({ mutation: { onSuccess: invalidate, onError } });

  const memberIds = new Set((members ?? []).map(m => m.userId));
  const candidates = (users ?? []).filter(u => !memberIds.has(u.id));

  return (
    <div className="bg-card/30 border border-white/5 rounded-2xl overflow-hidden flex flex-col h-full">
      <div className="p-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-white">
          <Users className="w-4 h-4 text-primary" /> Roster
        </div>
        <Button size="sm" variant="outline" className="h-8 border-white/10" onClick={() => setAddOpen(true)}>
          <Plus className="w-4 h-4 mr-1" /> Add
        </Button>
      </div>
      <div className="divide-y divide-white/5 flex-1 overflow-y-auto max-h-[600px]">
        {(members ?? []).map(m => (
          <div key={m.id} className="p-4 flex flex-col gap-3 hover:bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                {(m.name || m.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate flex items-center gap-1.5">
                  {m.name || m.email}
                  {m.isGeneralManager && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                </div>
                <div className="text-xs text-muted-foreground truncate">{m.email}</div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 pl-11">
              <Select value={String(m.roleId)} onValueChange={v => patch.mutate({
                id: dealer.id, userId: m.userId, data: { roleId: Number(v), isGeneralManager: m.isGeneralManager }
              })}>
                <SelectTrigger className="h-8 text-xs bg-background border-white/10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map(r => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-amber-400 hover:bg-white/5" onClick={() => patch.mutate({
                id: dealer.id, userId: m.userId, data: { roleId: m.roleId, isGeneralManager: !m.isGeneralManager }
              })}>
                <Crown className={m.isGeneralManager ? "text-amber-400" : ""} />
              </Button>
              
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-white/5" onClick={() => remove.mutate({
                id: dealer.id, userId: m.userId
              })}>
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
        {(members ?? []).length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">No members assigned.</div>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md bg-background border-white/10">
          <DialogHeader>
            <DialogTitle>Add Roster Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Platform User</label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger className="bg-card/50 border-white/10">
                  <SelectValue placeholder="Select user..." />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map(u => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name || u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Assigned Role</label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="bg-card/50 border-white/10">
                  <SelectValue placeholder="Select role..." />
                </SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map(r => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm text-white pt-2">
              <Switch checked={isGM} onCheckedChange={setIsGM} />
              Designate as General Manager
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button 
              disabled={!userId || !roleId || add.isPending}
              onClick={() => add.mutate({
                id: dealer.id,
                data: { userId: Number(userId), roleId: Number(roleId), isGeneralManager: isGM }
              })}
            >
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
