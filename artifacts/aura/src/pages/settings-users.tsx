import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAdminUsers,
  useListAdminRoles,
  useListDivisions,
  useUpdateAdminUser,
  useAddAdminUser,
  getListAdminUsersQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, UserX, UserCheck, UserPlus } from "lucide-react";

export default function SettingsUsers() {
  const { me } = useAuthz();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: users, isLoading } = useListAdminUsers();
  const { data: roles } = useListAdminRoles();
  const { data: divisions } = useListDivisions();
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRoleId, setAddRoleId] = useState<string | undefined>(undefined);

  const addMember = useAddAdminUser({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
        toast({ title: "Member added" });
        setAddOpen(false);
        setAddEmail("");
        setAddRoleId(undefined);
      },
      onError: (err) =>
        toast({
          title: "Could not add member",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const update = useUpdateAdminUser({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
        toast({ title: "User updated" });
      },
      onError: (err) =>
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  return (
    <div className="w-full px-5 md:px-8 py-6 md:py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" /> Team Members
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Assign roles and manage account access for this dealership.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <UserPlus className="h-4 w-4 mr-2" /> Add Member
        </Button>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a team member</DialogTitle>
            <DialogDescription>
              Add someone who already has an account to this dealership and give
              them a role. They must sign up first if they haven't yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-member-email">Email</Label>
              <Input
                id="add-member-email"
                type="email"
                placeholder="name@example.com"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={addRoleId} onValueChange={setAddRoleId}>
                <SelectTrigger className="bg-white/[0.03] border-white/10">
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
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !addEmail.trim() || !addRoleId || addMember.isPending
              }
              onClick={() =>
                addMember.mutate({
                  data: { email: addEmail.trim(), roleId: Number(addRoleId) },
                })
              }
            >
              {addMember.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3">Member</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Reports to</th>
                <th className="px-5 py-3">Division</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Last sign-in</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => {
                const isSelf = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-b border-white/[0.04] hover:bg-foreground/[0.02]">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        {u.imageUrl ? (
                          <img src={u.imageUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                        ) : (
                          <span className="h-8 w-8 rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold">
                            {(u.name ?? u.email ?? "?").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div>
                          <div className="font-medium text-foreground">
                            {u.name ?? "—"}
                            {isSelf && (
                              <span className="ml-2 text-[10px] uppercase tracking-wider text-primary">You</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{u.email ?? "—"}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <Select
                        value={u.roleId != null ? String(u.roleId) : undefined}
                        onValueChange={(v) =>
                          update.mutate({ id: u.id, data: { roleId: Number(v) } })
                        }
                        disabled={isSelf}
                      >
                        <SelectTrigger className="w-52 bg-white/[0.03] border-white/10">
                          <SelectValue placeholder="No role" />
                        </SelectTrigger>
                        <SelectContent>
                          {(roles ?? []).map((r) => (
                            <SelectItem key={r.id} value={String(r.id)}>
                              {r.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-5 py-3">
                      <Select
                        value={
                          u.reportingManagerUserId != null
                            ? String(u.reportingManagerUserId)
                            : "none"
                        }
                        onValueChange={(v) =>
                          update.mutate({
                            id: u.id,
                            data: {
                              reportingManagerUserId:
                                v === "none" ? null : Number(v),
                            },
                          })
                        }
                      >
                        <SelectTrigger className="w-44 bg-white/[0.03] border-white/10">
                          <SelectValue placeholder="No manager" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No manager</SelectItem>
                          {(users ?? [])
                            .filter((m) => m.id !== u.id)
                            .map((m) => (
                              <SelectItem key={m.id} value={String(m.id)}>
                                {m.name ?? m.email ?? `User #${m.id}`}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-5 py-3">
                      <Select
                        value={
                          u.divisionId != null ? String(u.divisionId) : "none"
                        }
                        onValueChange={(v) =>
                          update.mutate({
                            id: u.id,
                            data: { divisionId: v === "none" ? null : Number(v) },
                          })
                        }
                      >
                        <SelectTrigger className="w-40 bg-white/[0.03] border-white/10">
                          <SelectValue placeholder="No division" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No division</SelectItem>
                          {(divisions ?? []).map((d) => (
                            <SelectItem key={d.id} value={String(d.id)}>
                              {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-5 py-3">
                      <Badge
                        variant="outline"
                        className={
                          u.status === "active"
                            ? "border-emerald-500/40 text-emerald-400"
                            : "border-red-500/40 text-red-400"
                        }
                      >
                        {u.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!isSelf && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={
                            u.status === "active"
                              ? "text-red-400 hover:text-red-300"
                              : "text-emerald-400 hover:text-emerald-300"
                          }
                          onClick={() =>
                            update.mutate({
                              id: u.id,
                              data: {
                                status: u.status === "active" ? "suspended" : "active",
                              },
                            })
                          }
                        >
                          {u.status === "active" ? (
                            <>
                              <UserX className="h-4 w-4 mr-1" /> Suspend
                            </>
                          ) : (
                            <>
                              <UserCheck className="h-4 w-4 mr-1" /> Reactivate
                            </>
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
