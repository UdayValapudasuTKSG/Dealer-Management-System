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
  useListAdminRoles, useListPlatformUsers, startImpersonation,
  useGetDealerProvisioning, getGetDealerProvisioningQueryKey,
  useRetryDealerProvisioning, useAbortDealerProvisioning, useActivateDealer
} from "@workspace/api-client-react";
import type { Dealer, DealerMember, ProvisioningStatus } from "@workspace/api-client-react";

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
                ) : dealer.status === "provisioning" ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                    Provisioning
                  </>
                ) : dealer.status === "closed" ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400/70" />
                    Closed
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
          {dealer.status === "provisioning" && <ProvisioningPanel dealer={dealer} />}
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

const STEP_LABELS: Record<string, string> = {
  seed_roles: "Standard Roles",
  seed_divisions: "Default Divisions",
  seed_taxes: "Tax Rules",
  seed_entitlements: "Module Entitlements",
  provision_storage: "Document Storage",
  seed_lead_sources: "Lead Sources",
  seed_checklists: "Stage Checklists",
  seed_agents: "AI Agent Roster",
  invite_owner_admin: "Owner / GM Invite",
  register_los: "LOS Registration",
};

const UNMET_LABELS: Record<string, string> = {
  owner_invite_accepted: "The invited owner / General Manager has not signed in yet",
};

function unmetLabel(key: string) {
  if (UNMET_LABELS[key]) return UNMET_LABELS[key];
  if (key.startsWith("step:")) {
    const step = key.slice(5);
    return `Setup step incomplete: ${STEP_LABELS[step] ?? step}`;
  }
  return key;
}

function ProvisioningPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [abortOpen, setAbortOpen] = useState(false);
  const [abortReason, setAbortReason] = useState("");

  const { data: saga, isLoading } = useGetDealerProvisioning(dealer.id, {
    query: {
      queryKey: getGetDealerProvisioningQueryKey(dealer.id),
      refetchInterval: 5000,
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetDealerProvisioningQueryKey(dealer.id) });
    queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });
  };

  const retry = useRetryDealerProvisioning({
    mutation: {
      onSuccess: (res: ProvisioningStatus) => {
        invalidate();
        const failed = res.steps?.find(s => s.status === "failed");
        toast(failed
          ? { title: "Retry Halted", description: `Stopped again at "${STEP_LABELS[failed.stepKey] ?? failed.stepKey}".`, variant: "destructive" }
          : { title: "Provisioning Resumed", description: "All setup steps completed." });
      },
      onError: (e: any) => toast({ title: "Retry Failed", description: e.message || "An error occurred", variant: "destructive" }),
    },
  });

  const abort = useAbortDealerProvisioning({
    mutation: {
      onSuccess: () => {
        invalidate();
        setAbortOpen(false);
        toast({ title: "Provisioning Aborted", description: "Completed steps were compensated in reverse and the workspace was closed." });
      },
      onError: (e: any) => toast({ title: "Abort Failed", description: e.message || "An error occurred", variant: "destructive" }),
    },
  });

  const activate = useActivateDealer({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Workspace Activated", description: `${dealer.name} is now live.` });
      },
      onError: (e: any) => {
        const unmet: string[] = e?.data?.unmet ?? [];
        toast({
          title: "Go-Live Blocked",
          description: unmet.length ? unmet.map(unmetLabel).join(". ") : (e.message || "Go-live checklist has unmet items."),
          variant: "destructive",
        });
      },
    },
  });

  const steps = saga?.steps ?? [];
  const unmet = saga?.unmet ?? [];
  const hasFailure = steps.some(s => s.status === "failed");
  const allDone = steps.length > 0 && steps.every(s => s.status === "done");
  const busy = retry.isPending || abort.isPending || activate.isPending;

  return (
    <div className="glass rounded-xl p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Onboarding Saga</div>
          <h2 className="mt-1 font-serif text-[18px] tracking-tight text-zinc-900">Provisioning Progress</h2>
          <p className="mt-1 text-[12.5px] text-zinc-500 max-w-lg leading-relaxed">
            Each step is durable — a failure halts the run and can be retried from where it stopped, or aborted to unwind completed steps.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasFailure && (
            <button
              onClick={() => retry.mutate({ id: dealer.id })}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 text-white px-3.5 py-2 text-[12px] font-medium hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              {retry.isPending ? "Retrying..." : "Retry Setup"}
            </button>
          )}
          <button
            onClick={() => setAbortOpen(true)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 text-rose-700 px-3.5 py-2 text-[12px] font-medium hover:bg-rose-100 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Abort
          </button>
          <button
            onClick={() => activate.mutate({ id: dealer.id })}
            disabled={busy || !allDone || unmet.length > 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 text-white px-3.5 py-2 text-[12px] font-medium hover:bg-emerald-500 transition-colors disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed"
          >
            <Power className="w-3.5 h-3.5" />
            {activate.isPending ? "Activating..." : "Activate"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-32 rounded-lg border border-black/5 bg-white shimmer" />
      ) : (
        <>
          <div className="divide-y divide-black/5 rounded-lg border border-black/5 bg-white/60 overflow-hidden">
            {steps.map((s) => (
              <div key={s.stepKey} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${
                    s.status === "done" ? "bg-emerald-500" :
                    s.status === "failed" ? "bg-rose-500" :
                    s.status === "in_progress" ? "bg-amber-400 animate-pulse" :
                    s.status === "compensated" ? "bg-zinc-300" : "bg-zinc-200"
                  }`} />
                  <span className="text-[12.5px] text-zinc-800 truncate">{STEP_LABELS[s.stepKey] ?? s.stepKey}</span>
                  {s.external && (
                    <span className="rounded-full border border-black/10 bg-zinc-50 px-2 py-px text-[9.5px] font-medium uppercase tracking-[0.14em] text-zinc-500 shrink-0">External</span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {s.lastError && s.status === "failed" && (
                    <span className="text-[11px] text-rose-600 max-w-[260px] truncate" title={s.lastError}>{s.lastError}</span>
                  )}
                  {(s.attempts ?? 0) > 1 && (
                    <span className="font-mono text-[10.5px] text-zinc-400 tabular-nums">×{s.attempts}</span>
                  )}
                  <span className={`text-[10px] font-medium uppercase tracking-[0.14em] ${
                    s.status === "done" ? "text-emerald-600" :
                    s.status === "failed" ? "text-rose-600" :
                    s.status === "compensated" ? "text-zinc-400" : "text-zinc-500"
                  }`}>{s.status.replace("_", " ")}</span>
                </div>
              </div>
            ))}
          </div>

          {unmet.length > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200/70 p-3.5 text-[12px] text-amber-800 space-y-1">
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-amber-700">Go-Live Checklist</div>
              {unmet.map(u => (
                <div key={u} className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-amber-500 shrink-0" />
                  {unmetLabel(u)}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={abortOpen} onOpenChange={(open) => { if (!abort.isPending) setAbortOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif">Abort Provisioning</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-[12.5px] text-zinc-500">
              Completed setup steps are compensated in reverse order and the workspace is closed. This cannot be undone.
            </p>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">Reason (audited)</label>
              <Input
                value={abortReason}
                onChange={(e) => setAbortReason(e.target.value)}
                placeholder="e.g. Duplicate onboarding request"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbortOpen(false)} disabled={abort.isPending}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => abort.mutate({ id: dealer.id, data: { reason: abortReason.trim() } })}
              disabled={abort.isPending || abortReason.trim().length < 5}
            >
              {abort.isPending ? "Unwinding..." : "Abort & Compensate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
