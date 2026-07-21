import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Plus,
  Pencil,
  Users,
  Trash2,
  ShieldCheck,
  Crown,
  Bot,
  ScrollText,
  LogIn,
  PauseCircle,
  PlayCircle,
  Sparkles,
} from "lucide-react";
import {
  useListDealers,
  getListDealersQueryKey,
  useCreateDealer,
  useUpdateDealer,
  useListDealerMembers,
  getListDealerMembersQueryKey,
  useAddDealerMember,
  useUpdateDealerMember,
  useRemoveDealerMember,
  useListPlatformUsers,
  useListAdminRoles,
  useListDealerAgents,
  getListDealerAgentsQueryKey,
  useUpdateDealerAgent,
  useListPlatformAudit,
} from "@workspace/api-client-react";
import type {
  Dealer,
  DealerMember,
  Entitlements,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { formatGuyanaDateTime } from "@/lib/format";

/** Feature modules a dealership can be entitled to. Missing key = enabled. */
const ENTITLEMENT_MODULES: { key: string; label: string; hint: string }[] = [
  { key: "service_module", label: "Service & Workshop", hint: "Service orders, job cards, workshop board" },
  { key: "parts_module", label: "Parts & Suppliers", hint: "Parts inventory, purchases, suppliers" },
  { key: "gra_module", label: "GRA Compliance", hint: "Duty filing and customs workflows" },
  { key: "ai_agents", label: "AI Agents", hint: "All agentic automations for this dealership" },
];

function entitlementOn(flags: Entitlements | undefined, key: string) {
  return flags?.[key] !== false;
}

function DealerDialog({
  dealer,
  open,
  onClose,
}: {
  dealer: Dealer | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(dealer?.name ?? "");
  const [city, setCity] = useState(dealer?.city ?? "");
  const [country, setCountry] = useState(dealer?.country ?? "");
  const [status, setStatus] = useState<"active" | "suspended">(
    dealer?.status ?? "active",
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });

  const create = useCreateDealer({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({
          title: "Dealership created",
          description:
            "Divisions, roles, stage checklists, and AI agents were provisioned automatically.",
        });
        onClose();
      },
      onError: (e: unknown) =>
        toast({
          title: "Could not create dealership",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });
  const update = useUpdateDealer({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Dealership updated" });
        onClose();
      },
      onError: (e: unknown) =>
        toast({
          title: "Could not update dealership",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const submit = () => {
    const data = {
      name: name.trim(),
      city: city.trim() || null,
      country: country.trim() || null,
      status,
    };
    if (!data.name) return;
    if (dealer) update.mutate({ id: dealer.id, data });
    else create.mutate({ data });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {dealer ? "Edit dealership" : "New dealership"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">City</label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Country</label>
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </div>
          </div>
          {dealer && (
            <div>
              <label className="text-xs text-muted-foreground">Status</label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as "active" | "suspended")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
              {status === "suspended" && dealer.status === "active" && (
                <p className="mt-1.5 text-xs text-amber-500">
                  Suspending freezes this dealership&apos;s workspace and
                  pauses all of its AI agents.
                </p>
              )}
            </div>
          )}
          {!dealer && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2.5 text-xs text-muted-foreground flex items-start gap-2">
              <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
              <span>
                New dealerships are provisioned automatically with default
                divisions, roles &amp; permissions, stage checklists, and the
                full AI agent roster.
              </span>
            </div>
          )}
          <Button
            className="w-full"
            onClick={submit}
            disabled={!name.trim() || create.isPending || update.isPending}
          >
            {dealer ? "Save changes" : "Create dealership"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EntitlementsPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateDealer({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListDealersQueryKey(),
        });
        toast({ title: "Entitlements updated" });
      },
      onError: (e: unknown) =>
        toast({
          title: "Could not update entitlements",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const toggle = (key: string, on: boolean) =>
    update.mutate({
      id: dealer.id,
      data: {
        name: dealer.name,
        city: dealer.city ?? null,
        country: dealer.country ?? null,
        status: dealer.status,
        entitlements: { ...(dealer.entitlements ?? {}), [key]: on },
      },
    });

  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.02] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold mb-3">
        <ShieldCheck className="h-4 w-4 text-primary" /> Feature entitlements
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {ENTITLEMENT_MODULES.map((m) => {
          const on = entitlementOn(dealer.entitlements, m.key);
          return (
            <div
              key={m.key}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 bg-foreground/[0.03] border border-white/[0.06]"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{m.label}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {m.hint}
                </div>
              </div>
              <Switch
                checked={on}
                disabled={update.isPending}
                onCheckedChange={(v) => toggle(m.key, v)}
              />
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
      onSuccess: () =>
        void queryClient.invalidateQueries({
          queryKey: getListDealerAgentsQueryKey(dealer.id),
        }),
      onError: (e: unknown) =>
        toast({
          title: "Could not update agent",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const aiEntitled = entitlementOn(dealer.entitlements, "ai_agents");

  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-primary" /> AI agent kill switches
        </div>
        {(!aiEntitled || dealer.status === "suspended") && (
          <Badge variant="secondary" className="text-amber-400">
            {dealer.status === "suspended"
              ? "Suspended — all agents halted"
              : "AI agents disabled by entitlement"}
          </Badge>
        )}
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {(agents ?? []).map((a) => {
          const running = a.status !== "paused";
          return (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2 bg-foreground/[0.03] border border-white/[0.06]"
            >
              {running ? (
                <PlayCircle className="h-4 w-4 text-emerald-400 shrink-0" />
              ) : (
                <PauseCircle className="h-4 w-4 text-amber-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{a.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {a.domain}
                </div>
              </div>
              <Switch
                checked={running}
                disabled={patch.isPending}
                onCheckedChange={(v) =>
                  patch.mutate({
                    id: dealer.id,
                    agentId: a.id,
                    data: { status: v ? "active" : "paused" },
                  })
                }
              />
            </div>
          );
        })}
        {(agents ?? []).length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center sm:col-span-2">
            No agents provisioned for this dealership.
          </div>
        )}
      </div>
    </div>
  );
}

function MembersPanel({ dealer }: { dealer: Dealer }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: members } = useListDealerMembers(dealer.id);
  const { data: roles } = useListAdminRoles();
  const { data: platformUsers } = useListPlatformUsers();

  const [addOpen, setAddOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [isGM, setIsGM] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListDealerMembersQueryKey(dealer.id),
    });

  const onError = (e: unknown) =>
    toast({
      title: "Action failed",
      description: e instanceof Error ? e.message : undefined,
      variant: "destructive",
    });

  const add = useAddDealerMember({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Member added" });
        setAddOpen(false);
        setUserId("");
        setRoleId("");
        setIsGM(false);
      },
      onError,
    },
  });
  const patch = useUpdateDealerMember({
    mutation: { onSuccess: () => invalidate(), onError },
  });
  const remove = useRemoveDealerMember({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Member removed" });
      },
      onError,
    },
  });

  const memberIds = new Set((members ?? []).map((m) => m.userId));
  const candidates = (platformUsers ?? []).filter((u) => !memberIds.has(u.id));

  const changeRole = (m: DealerMember, newRoleId: number) =>
    patch.mutate({
      id: dealer.id,
      userId: m.userId,
      data: { roleId: newRoleId, isGeneralManager: m.isGeneralManager },
    });

  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-primary" /> Members
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add member
        </Button>
      </div>
      <div className="space-y-1.5">
        {(members ?? []).map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-3 rounded-lg px-3 py-2 bg-foreground/[0.03] border border-white/[0.06]"
          >
            {m.imageUrl ? (
              <img
                src={m.imageUrl}
                alt=""
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <span className="h-7 w-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                {(m.name ?? m.email ?? "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate flex items-center gap-1.5">
                {m.name ?? m.email ?? `User #${m.userId}`}
                {m.isGeneralManager && (
                  <Crown className="h-3.5 w-3.5 text-amber-400" />
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {m.email}
              </div>
            </div>
            <Select
              value={String(m.roleId)}
              onValueChange={(v) => changeRole(m, Number(v))}
            >
              <SelectTrigger className="w-[170px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(roles ?? []).map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              title={m.isGeneralManager ? "GM" : "Make General Manager"}
              onClick={() =>
                patch.mutate({
                  id: dealer.id,
                  userId: m.userId,
                  data: { roleId: m.roleId, isGeneralManager: !m.isGeneralManager },
                })
              }
            >
              <Crown
                className={
                  m.isGeneralManager
                    ? "h-4 w-4 text-amber-400"
                    : "h-4 w-4 text-muted-foreground"
                }
              />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Remove from dealership"
              onClick={() => remove.mutate({ id: dealer.id, userId: m.userId })}
            >
              <Trash2 className="h-4 w-4 text-red-400" />
            </Button>
          </div>
        ))}
        {(members ?? []).length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No members yet.
          </div>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add member to {dealer.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">User</label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a user" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name ?? u.email ?? `User #${u.id}`}
                      {u.email ? ` — ${u.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Role</label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isGM}
                onChange={(e) => setIsGM(e.target.checked)}
              />
              General Manager of this dealership
            </label>
            <Button
              className="w-full"
              disabled={!userId || !roleId || add.isPending}
              onClick={() =>
                add.mutate({
                  id: dealer.id,
                  data: {
                    userId: Number(userId),
                    roleId: Number(roleId),
                    isGeneralManager: isGM,
                  },
                })
              }
            >
              Add member
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const AUDIT_ACTION_STYLES: Record<string, string> = {
  provision: "text-emerald-400",
  suspend: "text-amber-400",
  activate: "text-emerald-400",
  impersonate: "text-gold",
  access_denied: "text-red-400",
};

function AuditPanel() {
  const { data: entries } = useListPlatformAudit({ limit: 100 });

  return (
    <div className="rounded-xl border border-white/10 bg-foreground/[0.02] divide-y divide-white/[0.06]">
      {(entries ?? []).map((e) => (
        <div key={e.id} className="flex items-start gap-3 px-4 py-3">
          <ScrollText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm leading-snug">{e.summary}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {e.actorEmail ?? e.actorName ?? "System"} ·{" "}
              {formatGuyanaDateTime(e.createdAt)}
            </div>
          </div>
          <span
            className={`text-[10px] font-bold uppercase tracking-wider shrink-0 ${
              AUDIT_ACTION_STYLES[e.action] ?? "text-muted-foreground"
            }`}
          >
            {e.action.replace(/_/g, " ")}
          </span>
        </div>
      ))}
      {(entries ?? []).length === 0 && (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No platform activity yet.
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const { data: dealers } = useListDealers();
  const { data: platformUsers } = useListPlatformUsers();
  const { switchDealer, me } = useAuthz();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [dialogDealer, setDialogDealer] = useState<Dealer | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [entering, setEntering] = useState(false);

  const selected =
    (dealers ?? []).find((d) => d.id === selectedId) ?? (dealers ?? [])[0];

  const enterWorkspace = async (d: Dealer) => {
    setEntering(true);
    try {
      await switchDealer(d.id);
      if (me?.isSuperAdmin) {
        toast({
          title: `Entered ${d.name}`,
          description:
            "An audited 8-hour impersonation window was opened for this workspace.",
        });
      }
      navigate("/command-center");
    } finally {
      setEntering(false);
    }
  };

  return (
    <>
    <PageHero
      eyebrow="Platform Control"
      title="Platform"
      accent="Console"
      subtitle="Onboard dealerships, manage entitlements, agents, and access"
    />
    <Page>
      <Tabs defaultValue="dealers" className="space-y-5">
        <TabsList>
          <TabsTrigger value="dealers">Dealerships</TabsTrigger>
          <TabsTrigger value="users">All Users</TabsTrigger>
          <TabsTrigger value="audit">Platform Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="dealers" className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {(dealers ?? []).length} dealership(s)
            </div>
            <Button
              onClick={() => {
                setDialogDealer(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> New Dealership
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(dealers ?? []).map((d) => (
              <div
                key={d.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(d.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelectedId(d.id);
                }}
                className={`text-left cursor-pointer rounded-xl border p-4 transition-colors ${
                  selected?.id === d.id
                    ? "border-primary/50 bg-primary/[0.06]"
                    : "border-white/10 bg-foreground/[0.02] hover:bg-foreground/[0.04]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25">
                    <Building2 className="h-5 w-5 text-primary" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{d.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {[d.city, d.country].filter(Boolean).join(", ") || "—"}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge
                      variant={d.status === "active" ? "default" : "secondary"}
                      className={
                        d.status === "suspended" ? "text-amber-400" : undefined
                      }
                    >
                      {d.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {d.userCount ?? 0} users
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={d.status === "suspended" || entering}
                    title={
                      d.status === "suspended"
                        ? "Suspended dealerships cannot be entered"
                        : "Open this dealership's workspace (audited)"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      void enterWorkspace(d);
                    }}
                  >
                    <LogIn className="h-3.5 w-3.5 mr-1" /> Enter workspace
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDialogDealer(d);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {selected && (
            <div className="space-y-4">
              <EntitlementsPanel key={`ent-${selected.id}`} dealer={selected} />
              <AgentsPanel key={`agents-${selected.id}`} dealer={selected} />
              <MembersPanel key={`members-${selected.id}`} dealer={selected} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="users">
          <div className="rounded-xl border border-white/10 bg-foreground/[0.02] divide-y divide-white/[0.06]">
            {(platformUsers ?? []).map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                {u.imageUrl ? (
                  <img
                    src={u.imageUrl}
                    alt=""
                    className="h-8 w-8 rounded-full object-cover"
                  />
                ) : (
                  <span className="h-8 w-8 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
                    {(u.name ?? u.email ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {u.name ?? "—"}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {u.email ?? ""}
                  </div>
                </div>
                <Badge variant={u.status === "active" ? "default" : "secondary"}>
                  {u.status}
                </Badge>
                <span className="text-xs text-muted-foreground w-24 text-right">
                  {u.dealerCount} dealership(s)
                </span>
              </div>
            ))}
            {(platformUsers ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground py-8 text-center">
                No users yet.
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <AuditPanel />
        </TabsContent>
      </Tabs>

      {dialogOpen && (
        <DealerDialog
          key={dialogDealer?.id ?? "new"}
          dealer={dialogDealer}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
        />
      )}

      <div className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 text-primary" />
        Platform administration is only visible to the super admin. Workspace
        entries are audited impersonation windows.
      </div>
    </Page>
    </>
  );
}
