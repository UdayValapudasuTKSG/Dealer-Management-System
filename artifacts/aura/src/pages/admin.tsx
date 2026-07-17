import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Plus,
  Pencil,
  Users,
  Trash2,
  ShieldCheck,
  Crown,
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
} from "@workspace/api-client-react";
import type { Dealer, DealerMember } from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [status, setStatus] = useState(dealer?.status ?? "active");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListDealersQueryKey() });

  const create = useCreateDealer({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Dealership created" });
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
      status: status as "active" | "inactive",
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
          <div>
            <label className="text-xs text-muted-foreground">Status</label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as "active" | "inactive")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
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

export default function AdminPage() {
  const { data: dealers } = useListDealers();
  const { data: platformUsers } = useListPlatformUsers();
  const [dialogDealer, setDialogDealer] = useState<Dealer | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const selected =
    (dealers ?? []).find((d) => d.id === selectedId) ?? (dealers ?? [])[0];

  return (
    <Page>
      <PageHeader
        title="Platform Admin"
        subtitle="Manage dealerships, memberships, and platform users"
      />
      <Tabs defaultValue="dealers" className="space-y-5">
        <TabsList>
          <TabsTrigger value="dealers">Dealerships</TabsTrigger>
          <TabsTrigger value="users">All Users</TabsTrigger>
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
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`text-left rounded-xl border p-4 transition-colors ${
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
                    >
                      {d.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {d.userCount ?? 0} users
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
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
              </button>
            ))}
          </div>
          {selected && <MembersPanel key={selected.id} dealer={selected} />}
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
        Platform administration is only visible to the super admin.
      </div>
    </Page>
  );
}
