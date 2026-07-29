import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAdminRoles,
  useGetPermissionMeta,
  useCreateAdminRole,
  useUpdateAdminRole,
  useDeleteAdminRole,
  useSetRolePermissions,
  useSetRoleFieldPermissions,
  getListAdminRolesQueryKey,
  type RoleWithPermissions,
  type FieldAccessGrantAccess,
} from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Plus, Shield, Trash2, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export default function SettingsRoles() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: roles, isLoading } = useListAdminRoles();
  const { data: meta } = useGetPermissionMeta();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  // Local draft of the permission matrix keyed by "module:category"
  const [draft, setDraft] = useState<Set<string> | null>(null);
  // Local draft of field-group access keyed by fieldGroup key ("edit" default)
  const [fieldDraft, setFieldDraft] = useState<Record<
    string,
    FieldAccessGrantAccess
  > | null>(null);

  const selected: RoleWithPermissions | undefined = useMemo(
    () => (roles ?? []).find((r) => r.id === selectedId) ?? (roles ?? [])[0],
    [roles, selectedId],
  );

  const grants = useMemo(() => {
    if (draft) return draft;
    return new Set(
      (selected?.permissions ?? []).map((p) => `${p.module}:${p.category}`),
    );
  }, [draft, selected]);

  const fieldAccess = useMemo(() => {
    if (fieldDraft) return fieldDraft;
    const map: Record<string, FieldAccessGrantAccess> = {};
    for (const g of selected?.fieldPermissions ?? []) map[g.fieldGroup] = g.access;
    return map;
  }, [fieldDraft, selected]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListAdminRolesQueryKey() });

  const onError = (err: unknown) =>
    toast({
      title: "Request failed",
      description: err instanceof Error ? err.message : String(err),
      variant: "destructive",
    });

  const createRole = useCreateAdminRole({
    mutation: {
      onSuccess: (role) => {
        invalidate();
        setCreateOpen(false);
        setNewName("");
        setNewDesc("");
        setSelectedId(role.id);
        setDraft(null);
        toast({ title: "Role created" });
      },
      onError,
    },
  });
  const updateRole = useUpdateAdminRole({
    mutation: { onSuccess: () => invalidate(), onError },
  });
  const deleteRole = useDeleteAdminRole({
    mutation: {
      onSuccess: () => {
        invalidate();
        setSelectedId(null);
        setDraft(null);
        toast({ title: "Role deleted" });
      },
      onError,
    },
  });
  const savePerms = useSetRolePermissions({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDraft(null);
        toast({ title: "Permissions saved" });
      },
      onError,
    },
  });
  const saveFieldPerms = useSetRoleFieldPermissions({
    mutation: {
      onSuccess: () => {
        invalidate();
        setFieldDraft(null);
        toast({ title: "Field access saved" });
      },
      onError,
    },
  });

  const toggle = (module: string, category: string) => {
    const key = `${module}:${category}`;
    const next = new Set(grants);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft(next);
  };

  const save = () => {
    if (!selected) return;
    savePerms.mutate({
      id: selected.id,
      data: {
        grants: [...grants].map((k) => {
          const [module, category] = k.split(":");
          return { module, category } as never;
        }),
      },
    });
  };

  return (
    <>
    <PageHero
      eyebrow="Settings"
      icon={Shield}
      title="Roles &"
      accent="Permissions"
      subtitle="Control what each dealership role can see and do, module by module."
      action={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Role
        </Button>
      }
    />
    <SettingsTabs />
    <div className="w-full px-5 md:px-8 pb-8 space-y-6">

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading roles…
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Role list */}
          <div className="space-y-1.5">
            {(roles ?? []).map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelectedId(r.id);
                  setDraft(null);
                  setFieldDraft(null);
                }}
                className={cn(
                  "w-full text-left rounded-xl border px-4 py-3 transition-colors",
                  selected?.id === r.id
                    ? "border-primary/40 bg-primary/[0.08]"
                    : "border-white/10 bg-white/[0.02] hover:bg-foreground/[0.04]",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  {r.isSystem && (
                    <Badge variant="outline" className="border-white/20 text-muted-foreground text-[10px]">
                      System
                    </Badge>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3 w-3" /> {r.userCount ?? 0} member
                  {(r.userCount ?? 0) === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>

          {/* Permission matrix */}
          {selected && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  {selected.description && (
                    <p className="text-sm text-muted-foreground">{selected.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!selected.isSystem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300"
                      onClick={() => deleteRole.mutate({ id: selected.id })}
                      disabled={deleteRole.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1" /> Delete
                    </Button>
                  )}
                  <Button size="sm" onClick={save} disabled={!draft || savePerms.isPending}>
                    {savePerms.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                    Save changes
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-white/10">
                      <th className="py-2 pr-4">Module</th>
                      {(meta?.categories ?? []).map((c) => (
                        <th key={c} className="py-2 px-2 text-center capitalize">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(meta?.modules ?? []).map((m) => (
                      <tr key={m} className="border-b border-white/[0.04]">
                        <td className="py-2.5 pr-4 font-medium capitalize">{m}</td>
                        {(meta?.categories ?? []).map((c) => (
                          <td key={c} className="py-2.5 px-2 text-center">
                            <Checkbox
                              checked={grants.has(`${m}:${c}`)}
                              onCheckedChange={() => toggle(m, c)}
                              aria-label={`${m} ${c}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                The <span className="text-foreground">admin</span> category grants every
                action within its module.
              </p>

              {/* Field-level access: per field group, hidden / view / edit */}
              {(meta?.fieldGroups ?? []).length > 0 && (
                <div className="pt-4 border-t border-white/10 space-y-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <h3 className="font-semibold">Field-level access</h3>
                      <p className="text-xs text-muted-foreground">
                        Fine-grained control over sensitive field groups. Default
                        is full edit access.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!selected) return;
                        saveFieldPerms.mutate({
                          id: selected.id,
                          data: {
                            grants: Object.entries(fieldAccess)
                              .filter(([, access]) => access !== "edit")
                              .map(([fieldGroup, access]) => ({
                                fieldGroup,
                                access,
                              })),
                          },
                        });
                      }}
                      disabled={!fieldDraft || saveFieldPerms.isPending}
                    >
                      {saveFieldPerms.isPending && (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      )}
                      Save field access
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {(meta?.fieldGroups ?? []).map((g) => (
                      <div
                        key={g.key}
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-sm">{g.label}</div>
                          <div className="text-[11px] text-muted-foreground capitalize truncate">
                            {g.module} · {g.fields.join(", ")}
                          </div>
                        </div>
                        <Select
                          value={fieldAccess[g.key] ?? "edit"}
                          onValueChange={(v) =>
                            setFieldDraft({
                              ...fieldAccess,
                              [g.key]: v as FieldAccessGrantAccess,
                            })
                          }
                        >
                          <SelectTrigger className="w-28 shrink-0 bg-white/[0.03] border-white/10">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="edit">Edit</SelectItem>
                            <SelectItem value="view">View only</SelectItem>
                            <SelectItem value="hidden">Hidden</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create role</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Role name (e.g. Lot Attendant)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Input
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() =>
                createRole.mutate({
                  data: {
                    name: newName.trim(),
                    ...(newDesc.trim() ? { description: newDesc.trim() } : {}),
                  },
                })
              }
              disabled={!newName.trim() || createRole.isPending}
            >
              {createRole.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  );
}
