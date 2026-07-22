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
  const [impersonateOpen, setImpersonateOpen] = useState(false);
  const [impersonateReason, setImpersonateReason] = useState("");
  const [impersonateElevated, setImpersonateElevated] = useState(false);

  if (isLoading) {
    return <div className="p-12 text-center text-zinc-500 font-serif italic">Loading...</div>;
  }

  if (!dealer) {
    return <div className="p-12 text-center text-zinc-500 font-serif italic">Dealership not found.</div>;
  }

  const handleEnterWorkspace = async () => {
    if (impersonateReason.trim().length < 5) {
      toast({
        title: "Reason Required",
        description: "Enter a short reason (at least 5 characters) — it is written to the platform audit trail.",
        variant: "destructive",
      });
      return;
    }
    try {
      setEntering(true);
      const mode = impersonateElevated ? "elevated" : "read_only";
      await startImpersonation({ dealerId, reason: impersonateReason.trim(), mode });
      localStorage.setItem("aura-dealer-id", String(dealerId));
      toast({
        title: "Workspace Authorized",
        description: impersonateElevated
          ? "Opening a 60-minute audited window with write elevation (money, gates and customer sends stay blocked)."
          : "Opening a 60-minute audited read-only window.",
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
    <div className="mx-auto max-w-7xl px-4 md:px-8 py-8 space-y-6 font-sans">
      <div className="flex items-center gap-4 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 mb-2">
        <Link href="/network" className="hover:text-zinc-900 flex items-center gap-1.5 transition-colors">
          <ArrowLeft className="w-3 h-3" /> Back to Network
        </Link>
      </div>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-6 rounded-2xl bg-zinc-950 text-white p-7 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)] ring-1 ring-white/10">
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center border border-white/10 shrink-0 shadow-inner">
            <Building2 className="w-7 h-7 text-white opacity-80" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-serif tracking-tight text-white">{dealer.name}</h1>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium ${
                dealer.status === "active" ? "bg-white/10 border-white/20 text-white" : "bg-black/40 border-white/10 text-white/60"
              }`}>
                {dealer.status === "active" ? (
                  <>
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                    Active
                  </>
                ) : (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
                    Suspended
                  </>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-3 text-[10px] font-medium uppercase tracking-[0.18em] text-white/50">
              {(dealer.city || dealer.country) && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3 h-3" />
                  {[dealer.city, dealer.country].filter(Boolean).join(", ")}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Activity className="w-3 h-3" />
                <span className="font-mono tracking-normal">ID: {dealer.id}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <DollarSign className="w-3 h-3" />
                <span className="font-mono tracking-normal">1 USD = {dealer.usdExchangeRate || 208} GYD</span>
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3 shrink-0">
          <button 
            className="inline-flex items-center gap-2 rounded-md bg-white text-zinc-950 px-4 py-2 text-[12.5px] font-medium hover:bg-zinc-200 transition-colors disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed"
            onClick={() => setImpersonateOpen(true)}
            disabled={entering || dealer.status === "suspended"}
          >
            <Key className="w-3.5 h-3.5" />
            {entering ? "Authorizing..." : "Enter Workspace"}
          </button>
        </div>
      </div>

      <Dialog open={impersonateOpen} onOpenChange={(open) => { if (!entering) setImpersonateOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif">Enter Workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-[12.5px] text-zinc-500">
              Opens a 60-minute audited impersonation window for {dealer.name}. Read-only by default.
            </p>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Reason (audited)</label>
              <Input
                value={impersonateReason}
                onChange={(e) => setImpersonateReason(e.target.value)}
                placeholder="e.g. Investigating support ticket"
              />
            </div>
            <label className="flex items-start gap-2.5 text-[12.5px] text-zinc-700 cursor-pointer">
              <Switch checked={impersonateElevated} onCheckedChange={setImpersonateElevated} />
              <span>
                Request write elevation
                <span className="block text-[11px] text-zinc-500">Money-posting, gate approvals and customer sends remain blocked either way.</span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImpersonateOpen(false)} disabled={entering}>Cancel</Button>
            <Button onClick={handleEnterWorkspace} disabled={entering || impersonateReason.trim().length < 5}>
              {entering ? "Authorizing..." : "Start Window"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    <div className="glass rounded-2xl overflow-hidden hover-elevate">
      <div className="px-5 py-4 border-b border-black/5 flex items-center gap-2 font-serif text-[14.5px] tracking-tight">
        <Settings className="w-4 h-4 text-zinc-400" /> General Configuration
      </div>
      <div className="p-5 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Dealership Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">USD Exchange Rate (GYD)</label>
            <Input type="number" value={rate} onChange={e => setRate(e.target.value)} className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px] tabular-nums" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">City</label>
            <Input value={city} onChange={e => setCity(e.target.value)} className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Country</label>
            <Input value={country} onChange={e => setCountry(e.target.value)} className="bg-white/50 border-black/10 rounded-md focus-visible:ring-1 focus-visible:ring-black/20 h-10 text-[13px]" />
          </div>
        </div>

        <div className="flex items-center justify-between pt-5 border-t border-black/5">
          <div className="flex items-center gap-4">
            <Switch checked={dealer.status === "active"} onCheckedChange={toggleStatus} disabled={update.isPending} />
            <div>
              <div className="text-[13px] font-medium text-zinc-900">Workspace State</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">Suspending pauses all AI agents and blocks access.</div>
            </div>
          </div>
          <button onClick={handleSave} disabled={update.isPending} className="inline-flex items-center justify-center rounded-md bg-zinc-900 text-white px-4 py-2 text-[12.5px] font-medium hover:bg-zinc-700 transition-colors disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed">
            Save Changes
          </button>
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
    <div className="glass rounded-2xl overflow-hidden hover-elevate">
      <div className="px-5 py-4 border-b border-black/5 flex items-center gap-2 font-serif text-[14.5px] tracking-tight">
        <Power className="w-4 h-4 text-zinc-400" /> Feature Entitlements
      </div>
      <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ENTITLEMENT_MODULES.map(m => {
          const on = entitlementOn(dealer.entitlements as any, m.key);
          return (
            <div key={m.key} className="flex items-start gap-4 p-4 rounded-xl bg-zinc-50 border border-black/5 hover:bg-zinc-100 transition-colors">
              <Switch checked={on} onCheckedChange={v => toggle(m.key, v)} disabled={update.isPending} className="mt-0.5" />
              <div>
                <div className="text-[13px] font-medium text-zinc-900">{m.label}</div>
                <div className="text-[11px] text-zinc-500 mt-1 leading-relaxed">{m.desc}</div>
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
    <div className="glass rounded-2xl overflow-hidden hover-elevate">
      <div className="px-5 py-4 border-b border-black/5 flex items-center justify-between">
        <div className="flex items-center gap-2 font-serif text-[14.5px] tracking-tight">
          <Bot className="w-4 h-4 text-zinc-400" /> AI Agent Governance
        </div>
        {(!aiEntitled || dealer.status === "suspended") && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-zinc-50 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            {dealer.status === "suspended" ? "Suspended (Halted)" : "Disabled via Entitlement"}
          </span>
        )}
      </div>
      <div className="p-0">
        <div className="divide-y divide-black/5">
          {(agents ?? []).map(a => {
            const running = a.status !== "paused";
            return (
              <div key={a.id} className="flex items-center gap-4 p-5 hover:bg-zinc-50/50 transition-colors">
                {running ? (
                  <PlayCircle className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : (
                  <PauseCircle className="w-5 h-5 text-zinc-400 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-zinc-900 truncate">{a.name}</div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 mt-1 truncate">{a.domain}</div>
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
            <div className="p-10 text-center text-[13px] text-zinc-500 font-serif italic">
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
    <div className="glass rounded-2xl overflow-hidden flex flex-col h-full max-h-[800px] hover-elevate">
      <div className="px-5 py-4 border-b border-black/5 flex items-center justify-between">
        <div className="flex items-center gap-2 font-serif text-[14.5px] tracking-tight">
          <Users className="w-4 h-4 text-zinc-400" /> Roster
        </div>
        <button className="inline-flex items-center justify-center rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-900 hover:text-white hover:border-zinc-900 transition-colors" onClick={() => setAddOpen(true)}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </button>
      </div>
      <div className="divide-y divide-black/5 flex-1 overflow-y-auto no-scrollbar">
        {(members ?? []).map(m => (
          <div key={m.id} className="p-5 flex flex-col gap-3 hover:bg-zinc-50/50 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-zinc-100 text-zinc-500 flex items-center justify-center font-serif text-sm border border-black/5 shrink-0">
                {(m.name || m.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-zinc-900 truncate flex items-center gap-1.5">
                  {m.name || m.email}
                  {m.isGeneralManager && <Crown className="w-3 h-3 text-amber-500" />}
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5 truncate">{m.email}</div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 pl-11">
              <Select value={String(m.roleId)} onValueChange={v => patch.mutate({
                id: dealer.id, userId: m.userId, data: { roleId: Number(v), isGeneralManager: m.isGeneralManager }
              })}>
                <SelectTrigger className="h-8 text-[11px] bg-white/50 border-black/10 rounded-md focus:ring-1 focus:ring-black/20 w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-md border-black/10 bg-white">
                  {(roles ?? []).map(r => <SelectItem key={r.id} value={String(r.id)} className="text-[11px]">{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              
              <button className="h-8 w-8 inline-flex items-center justify-center border border-black/10 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 bg-transparent" onClick={() => patch.mutate({
                id: dealer.id, userId: m.userId, data: { roleId: m.roleId, isGeneralManager: !m.isGeneralManager }
              })}>
                <Crown className={`w-3.5 h-3.5 ${m.isGeneralManager ? "text-amber-500" : ""}`} />
              </button>
              
              <button className="h-8 w-8 inline-flex items-center justify-center border border-black/10 rounded-md text-zinc-500 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50 bg-transparent transition-colors" onClick={() => remove.mutate({
                id: dealer.id, userId: m.userId
              })}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
        {(members ?? []).length === 0 && (
          <div className="p-10 text-center text-[13px] text-zinc-500 font-serif italic">No members assigned.</div>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md glass rounded-2xl shadow-xl font-sans">
          <DialogHeader>
            <DialogTitle className="font-serif text-[20px] tracking-tight text-zinc-900">Add Roster Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-5">
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Platform User</label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger className="bg-white/50 border-black/10 rounded-md focus:ring-1 focus:ring-black/20 h-10 text-[13px]">
                  <SelectValue placeholder="Select user..." />
                </SelectTrigger>
                <SelectContent className="rounded-md border-black/10 bg-white">
                  {candidates.map(u => (
                    <SelectItem key={u.id} value={String(u.id)} className="text-[13px]">{u.name || u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Assigned Role</label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className="bg-white/50 border-black/10 rounded-md focus:ring-1 focus:ring-black/20 h-10 text-[13px]">
                  <SelectValue placeholder="Select role..." />
                </SelectTrigger>
                <SelectContent className="rounded-md border-black/10 bg-white">
                  {(roles ?? []).map(r => (
                    <SelectItem key={r.id} value={String(r.id)} className="text-[13px]">{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-3 text-[13px] text-zinc-900 pt-2 cursor-pointer">
              <Switch checked={isGM} onCheckedChange={setIsGM} />
              Designate as General Manager
            </label>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <button onClick={() => setAddOpen(false)} className="inline-flex items-center justify-center rounded-md border border-black/10 bg-white px-4 py-2 text-[12.5px] font-medium text-zinc-700 hover:bg-zinc-50 transition-colors">Cancel</button>
            <button 
              disabled={!userId || !roleId || add.isPending}
              onClick={() => add.mutate({
                id: dealer.id,
                data: { userId: Number(userId), roleId: Number(roleId), isGeneralManager: isGM }
              })}
              className="inline-flex items-center justify-center rounded-md bg-zinc-900 text-white px-4 py-2 text-[12.5px] font-medium hover:bg-zinc-700 transition-colors disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed"
            >
              Add Member
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
