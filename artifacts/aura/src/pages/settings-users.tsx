import { useQueryClient } from "@tanstack/react-query";
import {
  useListAdminUsers,
  useListAdminRoles,
  useUpdateAdminUser,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, UserX, UserCheck } from "lucide-react";

export default function SettingsUsers() {
  const { me } = useAuthz();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: users, isLoading } = useListAdminUsers();
  const { data: roles } = useListAdminRoles();

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
    <div className="p-6 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" /> Team Members
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Assign roles and manage account access.
        </p>
      </div>

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
