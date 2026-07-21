import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAdminLeadSources,
  useCreateAdminLeadSource,
  useUpdateAdminLeadSource,
  getListAdminLeadSourcesQueryKey,
  getListLeadSourcesQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Megaphone, Plus } from "lucide-react";

export default function SettingsSources() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: sources, isLoading } = useListAdminLeadSources();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIsSocial, setNewIsSocial] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListAdminLeadSourcesQueryKey() });
    qc.invalidateQueries({ queryKey: getListLeadSourcesQueryKey() });
  };

  const onError = (err: unknown) =>
    toast({
      title: "Request failed",
      description: err instanceof Error ? err.message : String(err),
      variant: "destructive",
    });

  const createSource = useCreateAdminLeadSource({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCreateOpen(false);
        setNewName("");
        setNewIsSocial(false);
        toast({ title: "Lead source added" });
      },
      onError,
    },
  });

  const updateSource = useUpdateAdminLeadSource({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Lead source updated" });
      },
      onError,
    },
  });

  return (
    <div className="w-full px-5 md:px-8 py-6 md:py-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-primary" /> Lead Sources
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure where leads come from. Active sources appear in the
            new-lead form; social sources ask for the specific platform.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Source
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sources…
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3">Source</th>
                <th className="px-5 py-3">Code</th>
                <th className="px-5 py-3">Social</th>
                <th className="px-5 py-3">Active</th>
              </tr>
            </thead>
            <tbody>
              {(sources ?? []).map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-white/[0.04] hover:bg-foreground/[0.02]"
                >
                  <td className="px-5 py-3 font-medium">{s.name}</td>
                  <td className="px-5 py-3">
                    <code className="text-xs text-muted-foreground">{s.code}</code>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={s.isSocial}
                        onCheckedChange={(v) =>
                          updateSource.mutate({ id: s.id, data: { isSocial: v } })
                        }
                        aria-label={`${s.name} social`}
                      />
                      {s.isSocial && (
                        <Badge
                          variant="outline"
                          className="border-primary/40 text-primary text-[10px]"
                        >
                          Asks platform
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <Switch
                      checked={s.active}
                      onCheckedChange={(v) =>
                        updateSource.mutate({ id: s.id, data: { active: v } })
                      }
                      aria-label={`${s.name} active`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New lead source</DialogTitle>
            <DialogDescription>
              It becomes available in the new-lead form immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="source-name">Name</Label>
              <Input
                id="source-name"
                placeholder="e.g. Radio Campaign"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
              <div>
                <div className="font-medium text-sm">Social media source</div>
                <div className="text-xs text-muted-foreground">
                  Requires picking the platform (Facebook, TikTok, …) on capture.
                </div>
              </div>
              <Switch checked={newIsSocial} onCheckedChange={setNewIsSocial} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || createSource.isPending}
              onClick={() =>
                createSource.mutate({
                  data: { name: newName.trim(), isSocial: newIsSocial },
                })
              }
            >
              {createSource.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Add Source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
