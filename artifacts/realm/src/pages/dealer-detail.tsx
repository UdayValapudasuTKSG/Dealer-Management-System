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
    return <div className="p-8 text-center text-muted-foreground font-serif italic">Loading...</div>;
  }

  if (!dealer) {
    return <div className="p-8 text-center text-muted-foreground font-serif italic">Dealership not found.</div>;
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
    <div className="space-y-6 pb-20 font-sans">
      <div className="flex items-center gap-4 text-[10px] uppercase tracking-widest text-muted-foreground mb-4">
        <Link href="/network" className="hover:text-black flex items-center gap-1.5 transition-colors">
          <ArrowLeft className="w-3 h-3" /> Back to Network
        </Link>
      </div>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-6 bg-white p-6 border border-border">
        <div className="flex items-start gap-5">
          <div className="w-16 h-16 bg-muted/30 flex items-center justify-center text-black border border-border shrink-0 mt-1">
            <Building2 className="w-8 h-8" />
          </div>
          <div>
            <div className="flex items-center gap-4">
              <h1 className="text-3xl font-serif text-black tracking-tight">{dealer.name}</h1>
              <Badge variant="outline" className={`rounded-none px-2 py-0.5 text-[10px] uppercase tracking-widest ${
                dealer.status === "active" ? "border-black text-black" : "border-border text-muted-foreground"
              }`}>
                {dealer.status === "active" ? "Active" : "Suspended"}
              </Badge>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-x-8 gap-y-2 mt-3 text-[11px] uppercase tracking-wider text-muted-foreground">
              {(dealer.city || dealer.country) && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-black" />
                  {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-black" />
                ID: {dealer.id}
              </span>
              <span className="flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-black" />
                Rate: 1 USD = {dealer.usdExchangeRate || 208} GYD
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3 shrink-0">
          <Button 
            variant="outline" 
            className="border-black text-black hover:bg-black hover:text-white rounded-none uppercase tracking-widest text-xs"
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
    <div className="bg-white border border-border">
      <div className="p-4 border-b border-border flex items-center gap-2.5 font-serif text-lg text-black">
        <Settings className="w-5 h-5" /> General Configuration
      </div>
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Dealership Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground">USD Exchange Rate (GYD)</label>
            <Input type="number" value={rate} onChange={e => setRate(e.target.value)} className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground">City</label>
            <Input value={city} onChange={e => setCity(e.target.value)} className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Country</label>
            <Input value={country} onChange={e => setCountry(e.target.value)} className="bg-white border-border rounded-none focus-visible:ring-1 focus-visible:ring-black" />
          </div>
        </div>

        <div className="flex items-center justify-between pt-6 border-t border-border">
          <div className="flex items-center gap-4">
            <Switch checked={dealer.status === "active"} onCheckedChange={toggleStatus} disabled={update.isPending} />
            <div>
              <div className="text-sm font-medium text-black">Workspace State</div>
              <div className="text-[11px] text-muted-foreground mt-1">Suspending pauses all AI agents and blocks access.</div>
            </div>
          </div>
          <Button onClick={handleSave} disabled={update.isPending} size="sm" className="rounded-none uppercase tracking-widest text-[10px] bg-black text-white hover:bg-black/90 px-4 h-9">
            Save Changes
          </Button>
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
    <div className="bg-white border border-border">
      <div className="p-4 border-b border-border flex items-center gap-2.5 font-serif text-lg text-black">
        <Power className="w-5 h-5" /> Feature Entitlements
      </div>
      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ENTITLEMENT_MODULES.map(m => {
          const on = entitlementOn(dealer.entitlements as any, m.key);
          return (
            <div key={m.key} className="flex items-start gap-4 p-4 bg-gray-50 border border-border">
              <Switch checked={on} onCheckedChange={v => toggle(m.key, v)} disabled={update.isPending} className="mt-0.5" />
              <div>
                <div className="text-sm font-medium text-black">{m.label}</div>
                <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{m.desc}</div>
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
    <div className="bg-white border border-border">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2.5 font-serif text-lg text-black">
          <Bot className="w-5 h-5" /> AI Agent Governance
        </div>
        {(!aiEntitled || dealer.status === "suspended") && (
          <Badge variant="outline" className="rounded-none px-2 py-0.5 text-[10px] uppercase tracking-widest border-border text-muted-foreground">
            {dealer.status === "suspended" ? "Suspended (Halted)" : "Disabled via Entitlement"}
          </Badge>
        )}
      </div>
      <div className="p-0">
        <div className="divide-y divide-border">
          {(agents ?? []).map(a => {
            const running = a.status !== "paused";
            return (
              <div key={a.id} className="flex items-center gap-4 p-5 hover:bg-gray-50 transition-colors">
                {running ? (
                  <PlayCircle className="w-5 h-5 text-black shrink-0" />
                ) : (
                  <PauseCircle className="w-5 h-5 text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-black truncate">{a.name}</div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground mt-1 truncate">{a.domain}</div>
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
            <div className="p-8 text-center text-sm text-muted-foreground font-serif italic">
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
    <div className="bg-white border border-border flex flex-col h-full">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2.5 font-serif text-lg text-black">
          <Users className="w-5 h-5" /> Roster
        </div>
        <Button size="sm" variant="outline" className="h-8 rounded-none border-border text-[10px] uppercase tracking-widest px-3 hover:bg-gray-50 text-black" onClick={() => setAddOpen(true)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
        </Button>
      </div>
      <div className="divide-y divide-border flex-1 overflow-y-auto max-h-[600px]">
        {(members ?? []).map(m => (
          <div key={m.id} className="p-5 flex flex-col gap-4 hover:bg-gray-50 transition-colors">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-muted/30 text-black flex items-center justify-center font-serif text-lg border border-border shrink-0">
                {(m.name || m.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-black truncate flex items-center gap-2">
                  {m.name || m.email}
                  {m.isGeneralManager && <Crown className="w-3.5 h-3.5 text-black" />}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{m.email}</div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 pl-[56px]">
              <Select value={String(m.roleId)} onValueChange={v => patch.mutate({
                id: dealer.id, userId: m.userId, data: { roleId: Number(v), isGeneralManager: m.isGeneralManager }
              })}>
                <SelectTrigger className="h-8 text-[11px] bg-white border-border rounded-none focus:ring-1 focus:ring-black w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-none border-border">
                  {(roles ?? []).map(r => <SelectItem key={r.id} value={String(r.id)} className="text-[11px]">{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              
              <Button size="icon" variant="outline" className="h-8 w-8 border-border rounded-none text-muted-foreground hover:text-black hover:bg-gray-50" onClick={() => patch.mutate({
                id: dealer.id, userId: m.userId, data: { roleId: m.roleId, isGeneralManager: !m.isGeneralManager }
              })}>
                <Crown className={`w-4 h-4 ${m.isGeneralManager ? "text-black" : ""}`} />
              </Button>
              
              <Button size="icon" variant="outline" className="h-8 w-8 border-border rounded-none text-muted-foreground hover:text-black hover:bg-gray-50" onClick={() => remove.mutate({
                id: dealer.id, userId: m.userId
              })}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
        {(members ?? []).length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground font-serif italic">No members assigned.</div>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md bg-white border-border rounded-none shadow-none font-sans">
          <DialogHeader>
            <DialogTitle className="font-serif text-xl text-black">Add Roster Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-6">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Platform User</label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger className="bg-white border-border rounded-none focus:ring-1 focus:ring-black">
                  <SelectValue placeholder="Select user..." />
                </SelectTrigger>
                <SelectContent className="rounded-none border-border">
                  {candidates.map(u => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name || u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground">Assigned Role</label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="bg-white border-border rounded-none focus:ring-1 focus:ring-black">
                  <SelectValue placeholder="Select role..." />
                </SelectTrigger>
                <SelectContent className="rounded-none border-border">
                  {(roles ?? []).map(r => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-3 text-sm text-black pt-2 cursor-pointer">
              <Switch checked={isGM} onCheckedChange={setIsGM} />
              Designate as General Manager
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} className="rounded-none uppercase tracking-widest text-xs border-border text-black hover:bg-gray-50">Cancel</Button>
            <Button 
              disabled={!userId || !roleId || add.isPending}
              onClick={() => add.mutate({
                id: dealer.id,
                data: { userId: Number(userId), roleId: Number(roleId), isGeneralManager: isGM }
              })}
              className="rounded-none uppercase tracking-widest text-xs bg-black text-white hover:bg-black/90"
            >
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
